#!/usr/bin/env node
/**
 * `pnpm release:version` — ONE version for every artifact a release ships.
 *
 * Commands:
 *   <semver>                  rewrite every version site to <semver>, then
 *                             `pnpm install --lockfile-only`
 *   --check                   exit 0 when every site agrees, 1 on drift (one
 *                             line per mismatching site on stdout)
 *   --manifest <out.json>     assert coherence, then write the release manifest
 *                             `pnpm neuralis:update --manifest` consumes
 *   --root <dir>              the repository root (default: this checkout)
 *
 * Exit codes: 0 coherent / written · 1 drift (or a failed install) · 2 usage.
 *
 * THE SITES: the `version` field of the eight workspace manifests, the five
 * exact `@neuralis/*` pins in the host manifest, the companion-image defaults
 * (`neuralisapp/mcp-sidecar` and `neuralisapp/webtop-ubuntu-xfce` tagged with
 * the release's own version, so a pinned host never pulls a companion that
 * moved under it — the shipped `.env.example` included), and the docs site's
 * `docker pull neuralisapp/neuralis:<version>` install command. `scripts/rebuild.mts` DERIVES the sidecar tag
 * from the host manifest and must carry no companion tag literal — a site that
 * expects zero occurrences pins that. Every site also states how many
 * occurrences it expects, so a site that vanished is drift, never silence.
 *
 * WHAT IT DOES NOT DO: parse the lockfile (`pnpm install --frozen-lockfile`
 * proves lock ↔ manifest), touch any dependency line other than the five pins
 * (a `file:` dev dependency is machine-local state — and a bump REFUSES while a
 * machine-absolute one is present, since the lockfile-only install would record
 * its path), or write prose. The README,
 * Docker Hub overview and maturity texts carry the version in sentences a human
 * edits; both modes LIST those lines.
 *
 * The edits are TEXT edits, never a JSON round-trip: re-serialising a manifest
 * reflows every literal and escapes non-ASCII prose.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// TYPE-only: this script runs in every release workflow BEFORE any package is
// built, so it may not load the kernel's compiled module at runtime. The schema
// literal and the version pattern below are the kernel's
// (`RELEASE_MANIFEST_SCHEMA`, `MANIFEST_VERSION`), pinned equal by the suite.
import type { ReleaseManifest } from '@neuralis/package-system/contracts';

const here = dirname(fileURLToPath(import.meta.url));

/** A release version: semver without build metadata (`+` is not a legal Docker tag character). */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

type SiteKind = 'version' | 'pin' | 'image' | 'companion';

type Site = {
  /** Repository-relative path. */
  file: string;
  kind: SiteKind;
  label: string;
  /** Global, multiline; capture group 1 is the version. */
  pattern: RegExp;
  /** Occurrences the file must carry — 0 for a site whose value is derived, not written. */
  expected: number;
};

const WORKSPACE_MANIFESTS = [
  'package.json',
  'neuralis/package.json',
  'create-neuralis/package.json',
  'packages/package-system/package.json',
  'packages/agent-core/package.json',
  'packages/brain-core/package.json',
  'packages/admin/package.json',
  'packages/machine-core/package.json',
  'packages/cli/package.json',
] as const;

const HOST_PINS = ['admin', 'agent-core', 'brain-core', 'machine-core', 'package-system'] as const;

const HOST_IMAGE = 'neuralisapp/neuralis';
const SIDECAR = 'neuralisapp/mcp-sidecar';
const WEBTOP = 'neuralisapp/webtop-ubuntu-xfce';

const tagPattern = (image: string): RegExp => new RegExp(`${image.replace('/', '\\/')}:([0-9A-Za-z][0-9A-Za-z._-]*)`, 'g');

export const SITES: readonly Site[] = [
  // Top-level `version` only: a nested key is indented deeper than two spaces.
  ...WORKSPACE_MANIFESTS.map((file): Site => ({
    file,
    kind: 'version',
    label: 'version',
    pattern: /^ {2}"version": "([^"]+)"/gm,
    expected: 1,
  })),
  ...HOST_PINS.map((name): Site => ({
    file: 'neuralis/package.json',
    kind: 'pin',
    label: `pin @neuralis/${name}`,
    pattern: new RegExp(`^\\s*"@neuralis/${name}": "([^"]+)"`, 'gm'),
    expected: 1,
  })),
  { file: 'packages/agent-core/package.json', kind: 'companion', label: `default ${SIDECAR}`, pattern: tagPattern(SIDECAR), expected: 1 },
  { file: 'packages/machine-core/package.json', kind: 'companion', label: `default ${WEBTOP}`, pattern: tagPattern(WEBTOP), expected: 1 },
  { file: 'packages/machine-core/src/config.ts', kind: 'companion', label: `default ${WEBTOP}`, pattern: tagPattern(WEBTOP), expected: 1 },
  { file: 'neuralis/scripts/setup.mts', kind: 'companion', label: `default ${WEBTOP}`, pattern: tagPattern(WEBTOP), expected: 2 },
  { file: 'neuralis/.env.example', kind: 'companion', label: `template ${WEBTOP}`, pattern: tagPattern(WEBTOP), expected: 1 },
  { file: 'web/docs/app/(home)/widgets.tsx', kind: 'image', label: `install command ${HOST_IMAGE}`, pattern: tagPattern(HOST_IMAGE), expected: 1 },
  { file: 'neuralis/scripts/rebuild.mts', kind: 'companion', label: `derived ${SIDECAR}`, pattern: tagPattern(SIDECAR), expected: 0 },
  // The plugin marketplaces the host tree publishes install `@neuralis/cli` at the release's version.
  ...['neuralis/.claude-plugin/marketplace.json', 'neuralis/.agents/plugins/marketplace.json'].map((file): Site => ({
    file,
    kind: 'pin',
    label: 'marketplace @neuralis/cli',
    pattern: /"package": "@neuralis\/cli", "version": "([^"]+)"/g,
    expected: 1,
  })),
];

/** The manifests whose version a release publishes (the private workspace root is not one). */
const PUBLISHED_MANIFESTS = WORKSPACE_MANIFESTS.filter((file) => file !== 'package.json');

/** Hand-edited prose that carries the version in a sentence — listed, never written. */
const PROSE_FILES = [
  'neuralis/README.md',
  'neuralis/DOCKERHUB.md',
  'neuralis/maturity.json',
  'web/docs/content/docs/index.mdx',
  'web/docs/content/docs/getting-started/maturity.mdx',
  'web/docs/app/(home)/widgets.tsx',
  '.claude/skills/neuralis-readme-and-docs/scripts/maturity-inventory.json',
] as const;

/** The reference every other site is measured against: the host is what the image ships. */
const REFERENCE_FILE = 'neuralis/package.json';

export type SiteReading = { file: string; line: number; kind: SiteKind; label: string; value: string };

export type Coherence = {
  /** The host manifest's version, or null when it could not be read. */
  version: string | null;
  readings: SiteReading[];
  /** One line per mismatching or missing site. Empty means coherent. */
  drift: string[];
};

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function readText(root: string, file: string): string | null {
  try {
    return readFileSync(join(root, file), 'utf-8');
  } catch {
    return null;
  }
}

function matchesOf(text: string, pattern: RegExp): RegExpExecArray[] {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags))];
}

/** Read every site and compare it with the host manifest's version. */
export function checkCoherence(root: string): Coherence {
  const readings: SiteReading[] = [];
  const drift: string[] = [];
  const cache = new Map<string, string | null>();
  const text = (file: string): string | null => {
    if (!cache.has(file)) cache.set(file, readText(root, file));
    return cache.get(file) ?? null;
  };

  const referenceText = text(REFERENCE_FILE);
  const referenceSite = SITES.find((site) => site.file === REFERENCE_FILE && site.kind === 'version')!;
  const referenceMatch = referenceText === null ? [] : matchesOf(referenceText, referenceSite.pattern);
  const version = referenceMatch.length === 1 ? referenceMatch[0]![1]! : null;
  if (version === null) drift.push(`${REFERENCE_FILE}: no single top-level "version" — nothing to measure against`);

  for (const site of SITES) {
    const content = text(site.file);
    if (content === null) {
      drift.push(`${site.file}: missing (${site.label})`);
      continue;
    }
    const found = matchesOf(content, site.pattern);
    if (found.length !== site.expected) {
      const where = found.map((m) => `${site.file}:${lineOf(content, m.index)}`).join(', ');
      drift.push(`${site.file}: ${site.label} expected ${site.expected} occurrence(s), found ${found.length}${where ? ` (${where})` : ''}`);
      continue;
    }
    for (const m of found) {
      const reading: SiteReading = { file: site.file, line: lineOf(content, m.index), kind: site.kind, label: site.label, value: m[1]! };
      readings.push(reading);
      if (version !== null && reading.value !== version) {
        drift.push(`${reading.file}:${reading.line} ${reading.label} = ${reading.value} (expected ${version})`);
      }
    }
  }
  return { version, readings, drift };
}

/** Lines of the hand-edited prose that mention `version`. */
export function proseRows(root: string, version: string): string[] {
  const rows: string[] = [];
  for (const file of PROSE_FILES) {
    const content = readText(root, file);
    if (content === null) continue;
    // A line that is itself a written SITE (the landing's docker pull) is not hand-edit prose.
    const sitePatterns = SITES.filter((site) => site.file === file).map((site) => new RegExp(site.pattern.source));
    content.split('\n').forEach((line, i) => {
      if (line.includes(version) && !sitePatterns.some((pattern) => pattern.test(line))) rows.push(`${file}:${i + 1}`);
    });
  }
  return rows;
}

/**
 * Rewrite every site to `version`. Nothing is written unless EVERY site is
 * found with its expected count first — a half-bumped tree is worse than none.
 */
export function bumpVersion(root: string, version: string): { written: string[]; problems: string[] } {
  const problems: string[] = [];
  const next = new Map<string, string>();
  for (const site of SITES) {
    const current = next.get(site.file) ?? readText(root, site.file);
    if (current === null) {
      problems.push(`${site.file}: missing (${site.label})`);
      continue;
    }
    const found = matchesOf(current, site.pattern);
    if (found.length !== site.expected) {
      problems.push(`${site.file}: ${site.label} expected ${site.expected} occurrence(s), found ${found.length}`);
      continue;
    }
    const pattern = new RegExp(site.pattern.source, site.pattern.flags);
    const rewritten = current.replace(pattern, (whole: string, value: string) => {
      const at = whole.lastIndexOf(value);
      return whole.slice(0, at) + version + whole.slice(at + value.length);
    });
    next.set(site.file, rewritten);
  }
  if (problems.length > 0) return { written: [], problems };

  const written: string[] = [];
  for (const [file, content] of next) {
    const before = readText(root, file);
    if (before === content) continue;
    if (content.length === 0) throw new Error(`refusing to write an empty ${file}`);
    writeFileSync(join(root, file), content);
    written.push(file);
  }
  return { written, problems };
}

/** The manifest of a coherent tree; throws on drift so a partial line is never published. */
export function buildReleaseManifest(root: string): ReleaseManifest {
  const coherence = checkCoherence(root);
  if (coherence.version === null || coherence.drift.length > 0) {
    throw new Error(`the tree is not coherent:\n${coherence.drift.join('\n')}`);
  }
  const version = coherence.version;
  const packages: Record<string, string> = {};
  for (const file of PUBLISHED_MANIFESTS) {
    const name = (JSON.parse(readText(root, file) ?? '{}') as { name?: unknown }).name;
    if (typeof name !== 'string' || !name) throw new Error(`${file} has no package name`);
    packages[name] = version;
  }
  return {
    schema: 1,
    version,
    packages,
    images: { [HOST_IMAGE]: version, [SIDECAR]: version, [WEBTOP]: version },
  };
}

/**
 * Dependency lines with a machine-ABSOLUTE `file:` specifier. The lockfile-only
 * install would record that path in the tracked lock, which the image build
 * then refuses — so a bump never runs while one is present.
 */
export function machineLocalDependencies(root: string): string[] {
  const found: string[] = [];
  for (const file of WORKSPACE_MANIFESTS) {
    const content = readText(root, file);
    if (content === null) continue;
    for (const m of content.matchAll(/^\s*"([^"]+)": "file:\/[^"]*"/gm)) found.push(`${file}:${lineOf(content, m.index)} ${m[1]}`);
  }
  return found;
}

function isSourceCheckout(root: string): boolean {
  return existsSync(join(root, 'pnpm-workspace.yaml')) && existsSync(join(root, 'packages', 'package-system', 'package.json'));
}

const USAGE = 'usage: pnpm release:version <semver> | --check | --manifest <out.json>  [--root <dir>]';

function printProse(root: string, version: string): void {
  const rows = proseRows(root, version);
  if (rows.length === 0) return;
  console.log(`prose that names ${version} (edit by hand, then run the maturity and docs-introduction checks):`);
  for (const row of rows) console.log(`  ${row}`);
}

export function main(argv: string[]): number {
  let root = resolve(here, '..', '..');
  let check = false;
  let manifestOut: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--check') check = true;
    else if (arg === '--manifest' || arg === '--root') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        console.error(`${arg} needs a value\n${USAGE}`);
        return 2;
      }
      if (arg === '--manifest') manifestOut = resolve(value);
      else root = resolve(value);
      i++;
    } else if (arg.startsWith('--')) {
      console.error(`unknown flag ${arg}\n${USAGE}`);
      return 2;
    } else positional.push(arg);
  }

  const bump = positional.length > 0;
  if (positional.length > 1 || (bump && (check || manifestOut !== null)) || (!bump && !check && manifestOut === null)) {
    console.error(USAGE);
    return 2;
  }
  if (!isSourceCheckout(root)) {
    console.error(`${root} is not the source checkout (no pnpm-workspace.yaml + packages/) — a release is cut there\n${USAGE}`);
    return 2;
  }

  if (bump) {
    const version = positional[0]!;
    if (!SEMVER.test(version)) {
      console.error(`"${version}" is not a release version (MAJOR.MINOR.PATCH[-prerelease], no build metadata)\n${USAGE}`);
      return 2;
    }
    const local = machineLocalDependencies(root);
    if (local.length > 0) {
      for (const line of local) console.log(line);
      console.error('nothing written: a machine-local file: dependency would enter the lockfile — remove it for the bump, then restore it');
      return 1;
    }
    const before = checkCoherence(root).version;
    const { written, problems } = bumpVersion(root, version);
    if (problems.length > 0) {
      for (const line of problems) console.log(line);
      console.error('nothing written: the tree does not have the shape this command edits');
      return 1;
    }
    console.log(`release version ${before ?? '(unreadable)'} → ${version}: ${written.length} file(s) rewritten`);
    for (const file of written) console.log(`  ${file}`);
    const install = spawnSync('pnpm', ['install', '--lockfile-only'], { cwd: root, stdio: 'inherit' });
    if (install.status !== 0) {
      console.error(`pnpm install --lockfile-only failed (exit ${install.status ?? 'signal'}) — the manifests are rewritten, the lockfile is not`);
      return 1;
    }
    if (before) printProse(root, before);
    return 0;
  }

  const coherence = checkCoherence(root);
  if (coherence.drift.length > 0) {
    for (const line of coherence.drift) console.log(line);
    return 1;
  }
  const version = coherence.version!;
  if (manifestOut !== null) {
    const manifest = buildReleaseManifest(root);
    writeFileSync(manifestOut, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`release manifest ${version} → ${manifestOut}`);
  } else {
    console.log(`release version ${version}: ${coherence.readings.length} site(s) coherent`);
  }
  printProse(root, version);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
