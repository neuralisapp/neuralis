/**
 * Drift-guard for skill-launcher `(packageId, skill)` literal references.
 *
 * A launcher names a skill by its ACTIVATION id AND the REGISTRY id of the
 * package that owns it. Both halves drift silently: a typo or a renamed skill
 * produces a `SKILL_NOT_FOUND` only at stream time, and a `packageId` written
 * in the WRONG NAMESPACE resolves to nothing at all — no error, no log, the
 * button simply never renders. This suite derives every declared skill id from
 * the first-party packages' `skills/<name>/SKILL.md` bundles, derives the
 * registry-id → package-directory map from the manifests themselves, and fails
 * loud on any literal pair that does not resolve.
 *
 * HONEST SCOPE (the runtime resolution is the real gate): this matches only
 * STRING-LITERAL `skill="…"` / `skill={'…'}` props — `skill={variable}`
 * expressions and the `scripts=[…]` bundle contents are out of reach here and
 * stay covered by the stream-side accessor (unknown skill ⇒ fail-closed).
 *
 * ⚠ THIS IS REFERENCE RESOLUTION, **NOT** A VISIBILITY GATE. Passing proves the
 * pair EXISTS, never that a given caller may see or run it. Visibility is S2 /
 * S3 / R2b / per-file enablement — all per-caller and runtime, which is exactly
 * why `<SkillLauncher>` DERIVES its rendering from the server-filtered catalog
 * instead of asserting a hand-typed feature list. Do not read a green run here
 * as evidence that a launcher is correctly gated.
 *
 * The TWO NAMESPACES (the 2026-07-26 outage): `@neuralis/admin` is the registry
 * id (manifest `neuralis.id`, what the snapshot/overview carry) and `admin` is
 * the `packages/<dir>` directory name. Both "look right". `<SkillLauncher>`
 * matches on the registry form, so this guard REQUIRES it there — and derives
 * the mapping from each `package.json` rather than assuming either form, which
 * is precisely the mistake that let the previous guard pass over a broken strip.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, join, sep } from 'node:path';
import { shippableHostDependencies } from '../../../testing/hostDepManifests';

const HOST_ROOT = join(__dirname, '..', '..', '..', '..');

type ProvidedFeature = { id?: string };
type DepManifest = {
  neuralis?: {
    id?: string;
    referenceOnly?: boolean;
    requires?: { providesFeatures?: Array<string | ProvidedFeature> };
  } & Record<string, unknown>;
};

// Machine-local (file:/link:) dev deps are excluded from every shippable
// derivation — a bare node_modules read would ENOENT on the docker lane, and
// an installed one would tie tracked asserts to operator dogfood state. See
// src/testing/hostDepManifests.ts (INC-W1C).
function readHostDependencies(): string[] {
  return shippableHostDependencies();
}

function readManifest(name: string): DepManifest {
  return JSON.parse(readFileSync(join(HOST_ROOT, 'node_modules', name, 'package.json'), 'utf-8')) as DepManifest;
}

/** First-party (loaded) builtin-class deps: a `neuralis` block, not reference-only. */
function firstPartyDeps(): string[] {
  return readHostDependencies().filter((name) => {
    const m = readManifest(name);
    return !!m.neuralis && m.neuralis.referenceOnly !== true;
  });
}

function walk(dir: string, match: (file: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, item.name);
    if (item.isDirectory()) {
      if (item.name === 'node_modules' || item.name === '.git') continue;
      out.push(...walk(full, match));
    } else if (match(item.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Skill activation ids a package declares (frontmatter `name`/`id`, else dir name). */
function declaredSkillIds(pkgRoot: string): Set<string> {
  const ids = new Set<string>();
  const skillsDir = join(pkgRoot, 'skills');
  if (existsSync(skillsDir)) {
    for (const item of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const md = join(skillsDir, item.name, 'SKILL.md');
      if (!existsSync(md)) continue;
      ids.add(frontmatterId(readFileSync(md, 'utf-8')) ?? item.name);
    }
  }
  // Bare root-SKILL.md layout (the id is the package dir name unless overridden).
  const rootMd = join(pkgRoot, 'SKILL.md');
  if (existsSync(rootMd)) ids.add(frontmatterId(readFileSync(rootMd, 'utf-8')) ?? basename(pkgRoot));
  return ids;
}

/**
 * `name:` first, then `id:` — the reference package (`examples/example-builtin`)
 * declares its skill as `id: skill.main`, so an `id:`-only frontmatter is a
 * legitimate shape, not a malformed one.
 */
function frontmatterId(content: string): string | undefined {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!fm) return undefined;
  const name = /^name:\s*(.+)$/m.exec(fm[1])?.[1] ?? /^id:\s*(.+)$/m.exec(fm[1])?.[1];
  return name?.trim().replace(/^["']|["']$/g, '') || undefined;
}

/** Every feature id any first-party manifest declares (mixed string|object form). */
function declaredFeatureIds(deps: string[]): Set<string> {
  const out = new Set<string>();
  for (const name of deps) {
    for (const f of readManifest(name).neuralis?.requires?.providesFeatures ?? []) {
      const id = typeof f === 'string' ? f : f?.id;
      if (id) out.add(id);
    }
  }
  return out;
}

// ── Reference collection ────────────────────────────────────────────────────

type LauncherRef = {
  component: 'SkillLauncher' | 'SkillButton';
  /** Literal skill id, or null when the site is data-driven (`skill={row.id}`). */
  skill: string | null;
  /** Literal packageId, or null when absent / data-driven. */
  packageId: string | null;
  alsoRequires: string[] | null;
  file: string;
};

const LITERAL = String.raw`(?:"([^"]*)"|'([^']*)')`;
const JSX_ELEMENT_RE = /<(SkillLauncher|SkillButton)\b([\s\S]*?)\/>/g;
const JSX_ATTR_SKILL_RE = new RegExp(String.raw`\bskill\s*=\s*(?:${LITERAL}|\{\s*${LITERAL}\s*\})`);
const JSX_ATTR_PACKAGE_RE = new RegExp(String.raw`\bpackageId\s*=\s*(?:${LITERAL}|\{\s*${LITERAL}\s*\})`);
const JSX_ATTR_ALSO_RE = /\balsoRequires\s*=\s*\{\s*\[([^\]]*)\]\s*\}/;

const OBJ_SKILL_RE = /\bskill\s*:\s*(?:"([^"]*)"|'([^']*)')/g;
const OBJ_PACKAGE_RE = new RegExp(String.raw`\bpackageId\s*:\s*${LITERAL}`);

function firstLiteral(m: RegExpMatchArray | null): string | null {
  if (!m) return null;
  for (let i = 1; i < m.length; i++) if (m[i] !== undefined) return m[i];
  return null;
}

function parseStringArray(body: string): string[] {
  return [...body.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
}

/**
 * Blank out block comments and whole-line `//` comments before scanning.
 * Docblocks in this repo DISCUSS launchers in prose (`skillRows.ts` explains the
 * `<SkillButton>` row form), which would otherwise read as unparsed elements —
 * and, worse, as references to skills that do not exist. Length is preserved so
 * every match index still points at the real source offset.
 */
function stripComments(src: string): string {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  out = out.replace(/^([ \t]*)\/\/[^\n]*$/gm, (m, indent: string) => indent + ' '.repeat(m.length - indent.length));
  return out;
}

/** The `{ … }` object literal that immediately encloses `at`, or null. */
function enclosingObject(src: string, at: number): string | null {
  let depth = 0;
  let start = -1;
  for (let i = at; i >= 0; i--) {
    const c = src[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  if (start < 0) return null;
  let d = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '{') d++;
    else if (c === '}') {
      d--;
      if (d === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

function collectRefs(appDir: string): { refs: LauncherRef[]; unmatchedElements: string[] } {
  const refs: LauncherRef[] = [];
  const unmatchedElements: string[] = [];
  // Test sources are not shipped UI, and their PROSE trips the literal regex:
  // a docstring writing `skill="…"` (a literal ellipsis) reads as a reference
  // to a skill named "…" and fails the guard. Scan shipped code only.
  // NOTE: `walk`'s predicate receives the BASENAME, so the directory filter
  // has to run on the returned full paths, not inside the predicate.
  const sources = walk(appDir, (f) => f.endsWith('.tsx') || f.endsWith('.ts')).filter(
    (full) => !full.split(sep).includes('__tests__'),
  );

  for (const file of sources) {
    const src = stripComments(readFileSync(file, 'utf-8'));

    // (1) JSX elements.
    let jsxCount = 0;
    for (const m of src.matchAll(JSX_ELEMENT_RE)) {
      jsxCount++;
      const component = m[1] as LauncherRef['component'];
      const attrs = m[2] ?? '';
      const alsoBody = JSX_ATTR_ALSO_RE.exec(attrs)?.[1];
      refs.push({
        component,
        skill: firstLiteral(JSX_ATTR_SKILL_RE.exec(attrs)),
        packageId: firstLiteral(JSX_ATTR_PACKAGE_RE.exec(attrs)),
        alsoRequires: alsoBody === undefined ? null : parseStringArray(alsoBody),
        file,
      });
    }
    // A launcher the scan cannot SEE is the worst outcome — it reads as "no
    // drift" while the reference is unchecked. Self-closing is the repo form;
    // anything else must fail loudly rather than be skipped.
    const openTags = (src.match(/<(?:SkillLauncher|SkillButton)\b/g) ?? []).length;
    if (openTags !== jsxCount) {
      unmatchedElements.push(`${file} (${openTags} tags, ${jsxCount} parsed)`);
    }

    // (2) Object-literal tables (`{ skill: "x", packageId: "@neuralis/y" }`) —
    // the shape the previous guard was blind to entirely.
    for (const m of src.matchAll(OBJ_SKILL_RE)) {
      const skill = m[1] ?? m[2];
      const obj = enclosingObject(src, m.index ?? 0);
      if (!obj) continue;
      const packageId = firstLiteral(OBJ_PACKAGE_RE.exec(obj));
      if (!packageId) continue; // no pair ⇒ not a launcher row; skip, don't fail
      refs.push({ component: 'SkillLauncher', skill, packageId, alsoRequires: null, file });
    }
  }

  return { refs, unmatchedElements };
}

// ── Suite ───────────────────────────────────────────────────────────────────

describe('skill-launcher (packageId, skill) drift-guard', () => {
  const deps = firstPartyDeps();
  const featureIds = declaredFeatureIds(deps);

  /** registry id (`@neuralis/admin`) → package root on disk. */
  const byRegistryId = new Map<string, string>();
  /** directory name (`admin`) → package root, for the tolerant `SkillButton` form. */
  const byDirName = new Map<string, string>();
  for (const name of deps) {
    const root = join(HOST_ROOT, 'node_modules', name);
    const id = readManifest(name).neuralis?.id;
    if (id) byRegistryId.set(id, root);
    byDirName.set(basename(name), root);
  }

  const skillIdCache = new Map<string, Set<string>>();
  const skillsOf = (root: string): Set<string> => {
    let s = skillIdCache.get(root);
    if (!s) {
      s = declaredSkillIds(root);
      skillIdCache.set(root, s);
    }
    return s;
  };

  it('finds first-party deps, registry ids and declared features to check', () => {
    expect(deps.length).toBeGreaterThan(0);
    expect(byRegistryId.size).toBeGreaterThan(0);
    expect(featureIds.size).toBeGreaterThan(0);
  });

  const allRefs: LauncherRef[] = [];
  for (const name of deps) {
    const pkgRoot = join(HOST_ROOT, 'node_modules', name);
    const { refs, unmatchedElements } = collectRefs(join(pkgRoot, 'app'));
    allRefs.push(...refs);

    it(`every launcher element in ${name}/app is parseable`, () => {
      expect(unmatchedElements, `unparsed launcher elements (non-self-closing?)`).toEqual([]);
    });

    const literalRefs = refs.filter((r) => r.skill !== null);
    if (literalRefs.length === 0) continue;

    it(`every launcher (packageId, skill) pair in ${name}/app resolves`, () => {
      for (const ref of literalRefs) {
        const skill = ref.skill as string;

        if (ref.packageId === null) {
          // No package named ⇒ only the OWNING package can serve it.
          expect(
            skillsOf(pkgRoot).has(skill),
            `${name}: launcher references skill "${skill}" (${ref.file.slice(pkgRoot.length)}) with no packageId, and the package declares no skills/${skill}/SKILL.md`,
          ).toBe(true);
          continue;
        }

        const viaRegistry = byRegistryId.get(ref.packageId);
        if (!viaRegistry) {
          const viaDir = byDirName.get(ref.packageId);
          expect(
            ref.component === 'SkillButton' && !!viaDir,
            `${name}: <${ref.component}> packageId="${ref.packageId}" (${ref.file.slice(pkgRoot.length)}) is not a REGISTRY id. The launcher matches the server catalog on the registry form (manifest neuralis.id, e.g. "${[...byRegistryId.keys()][0]}"), NOT the packages/<dir> name — the bare form resolves to nothing and the button silently never renders. Known registry ids: ${[...byRegistryId.keys()].join(', ')}`,
          ).toBe(true);
          if (viaDir) {
            expect(
              skillsOf(viaDir).has(skill),
              `${name}: launcher references skill "${skill}" under package "${ref.packageId}" (${ref.file.slice(pkgRoot.length)}) but that package declares no skills/${skill}/SKILL.md`,
            ).toBe(true);
          }
          continue;
        }

        expect(
          skillsOf(viaRegistry).has(skill),
          `${name}: launcher references skill "${skill}" under package "${ref.packageId}" (${ref.file.slice(pkgRoot.length)}) but that package declares no skills/${skill}/SKILL.md (declared: ${[...skillsOf(viaRegistry)].join(', ') || 'none'})`,
        ).toBe(true);
      }
    });

    const gated = refs.filter((r) => r.alsoRequires !== null && r.alsoRequires.length > 0);
    if (gated.length === 0) continue;

    it(`every alsoRequires feature in ${name}/app is a declared feature`, () => {
      // `alsoRequires` can only ever NARROW a launcher — a typo therefore fails
      // SILENTLY CLOSED (the button just never appears). This static check is
      // the only instrument that catches it.
      for (const ref of gated) {
        for (const feature of ref.alsoRequires as string[]) {
          expect(
            featureIds.has(feature),
            `${name}: alsoRequires={["${feature}"]} (${ref.file.slice(pkgRoot.length)}) is not declared by any first-party manifest's requires.providesFeatures — a typo here hides the launcher with no error`,
          ).toBe(true);
        }
      }
    });
  }

  it('the scan actually found launcher references (the flagship)', () => {
    // Re-derive so this assertion is independent of test registration order.
    const found = deps.reduce(
      (n, name) => n + collectRefs(join(HOST_ROOT, 'node_modules', name, 'app')).refs.length,
      0,
    );
    expect(found).toBeGreaterThan(0);
    expect(allRefs.some((r) => r.packageId?.startsWith('@neuralis/'))).toBe(true);
  });
});
