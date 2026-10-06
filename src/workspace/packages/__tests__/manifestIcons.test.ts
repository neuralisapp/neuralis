/**
 * Drift-guard for icon names → the platform icon library.
 *
 * `resolveIconWithFallback` never throws: a name outside the library silently
 * renders the generic `Package` box glyph. So a manifest that names an icon the
 * library does not carry — or one lucide does not have AT ALL — looks "fine" in
 * every build, every test and every boot log; it just quietly renders the wrong
 * picture. (Both shapes were live in the tree on 2026-07-28: an `icon: "shield"`
 * lowercase spelling, and an ecom card declaring `ListAlert`, which does not
 * exist in lucide-react at all.) The kernel now WARNS at load and the
 * authoring preflight ERRORS; this guard holds the shipped manifests to it.
 *
 * Scope: every `icon` value in a first-party manifest's `neuralis` block, plus
 * every literal `icon="…"` on a skill launcher. Data-driven icons
 * (`icon={row.icon}`) are out of reach and stay a runtime fallback.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { shippableHostDependencies } from '../../../testing/hostDepManifests';

const HOST_ROOT = join(__dirname, '..', '..', '..', '..');

// The library's SOURCE, deliberately NOT `@neuralis/package-system/icons`: that
// specifier resolves through the exports map to `dist/`, so an unbuilt library
// edit would leave this guard passing against the previous build. The module
// has zero imports, so the source loads as-is. Loaded by a runtime path, never
// a static specifier: the image installs the kernel from its tarball (no
// `src/`) and `next build` typechecks `__tests__` too.
const LIBRARY_SOURCE = join(HOST_ROOT, 'node_modules', '@neuralis', 'package-system', 'src', 'icons', 'iconLibrary.ts');
type IconLibraryModule = typeof import('@neuralis/package-system/icons');
let ICON_LIBRARY: IconLibraryModule['ICON_LIBRARY'];
let normalizeIconName: IconLibraryModule['normalizeIconName'];

beforeAll(async () => {
  ({ ICON_LIBRARY, normalizeIconName } = (await import(/* @vite-ignore */ LIBRARY_SOURCE)) as IconLibraryModule);
});

/** A manifest spelling resolves when the library's ONE normalizer maps it to a library name. */
function resolves(icon: string): boolean {
  return normalizeIconName(icon) !== null;
}

// Machine-local (file:/link:) dev deps are excluded from every shippable
// derivation — a bare node_modules read would ENOENT on the docker lane, and
// an installed one would tie tracked asserts to operator dogfood state. See
// src/testing/hostDepManifests.ts (INC-W1C).
function readHostDependencies(): string[] {
  return shippableHostDependencies();
}

function readNeuralisBlock(name: string): Record<string, unknown> | null {
  const raw = readFileSync(join(HOST_ROOT, 'node_modules', name, 'package.json'), 'utf-8');
  const m = JSON.parse(raw) as { neuralis?: Record<string, unknown> };
  return m.neuralis ?? null;
}

/** Every `icon: "…"` value anywhere inside a `neuralis` manifest block. */
function manifestIcons(block: unknown, out: Set<string> = new Set()): Set<string> {
  if (!block || typeof block !== 'object') return out;
  if (Array.isArray(block)) {
    for (const v of block) manifestIcons(v, out);
    return out;
  }
  for (const [k, v] of Object.entries(block)) {
    if (k === 'icon' && typeof v === 'string') out.add(v);
    else manifestIcons(v, out);
  }
  return out;
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

const LAUNCHER_RE = /<(?:SkillLauncher|SkillButton)\b([\s\S]*?)\/>/g;
const ICON_ATTR_RE = /\bicon\s*=\s*"([^"]*)"/;

function launcherIcons(appDir: string): Array<{ icon: string; file: string }> {
  const out: Array<{ icon: string; file: string }> = [];
  const sources = walk(appDir, (f) => f.endsWith('.tsx') || f.endsWith('.ts')).filter(
    (full) => !full.split(sep).includes('__tests__'),
  );
  for (const file of sources) {
    // Blank block comments so prose examples are not read as real references.
    const src = readFileSync(file, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
    for (const m of src.matchAll(LAUNCHER_RE)) {
      const icon = ICON_ATTR_RE.exec(m[1] ?? '')?.[1];
      if (icon) out.push({ icon, file });
    }
  }
  return out;
}

describe('icon-name drift-guard', () => {
  const deps = readHostDependencies().filter((n) => !!readNeuralisBlock(n));

  it('finds first-party manifests and the icon library', () => {
    expect(deps.length).toBeGreaterThan(0);
    expect(ICON_LIBRARY.length).toBeGreaterThan(200);
  });

  it('paired control: a name outside the library does not resolve', () => {
    expect(resolves('ListAlert')).toBe(false);
    expect(resolves('chart-line')).toBe(true);
    expect(resolves('shield')).toBe(true);
  });

  it('every manifest icon resolves through the icon library', () => {
    const unresolved: string[] = [];
    for (const name of deps) {
      for (const icon of manifestIcons(readNeuralisBlock(name))) {
        if (!resolves(icon)) unresolved.push(`${name}: icon "${icon}"`);
      }
    }
    expect(
      unresolved,
      'icon names outside the library render the generic box glyph — pick a library name (package-system/src/icons/iconLibrary.ts), or add ONE library row in the same change',
    ).toEqual([]);
  });

  it('every literal launcher icon="…" resolves through the icon library', () => {
    const unresolved: string[] = [];
    let seen = 0;
    for (const name of deps) {
      for (const { icon, file } of launcherIcons(join(HOST_ROOT, 'node_modules', name, 'app'))) {
        seen++;
        if (!resolves(icon)) unresolved.push(`${name}: icon "${icon}" (${file})`);
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(unresolved).toEqual([]);
  });
});
