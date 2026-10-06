/**
 * Drift-guards over the host dependencies' workspace UI.
 *
 * 1. Every `direct` surface reaches the workspace through its package's
 *    runtime module: a dependency that declares a `direct` surface declares
 *    `neuralis.app.module` (the host has no other lane — without it the surface
 *    renders "This widget cannot be rendered by this host." and nothing
 *    fails), every `component.import` it names is registered in its `app/`
 *    tree, and no UI source lives outside `app/` (the union stylesheet scans
 *    `<pkg>/app/**` only — a class outside it is silently missing).
 *
 * 2. Every first-party install entry mounts `<WorkspaceHostPortProvider>`.
 *
 * `<SkillLauncher>` (and `<SkillButton>`) resolve the workspace port from that
 * provider. When it is missing, the component returns `null` — SILENTLY. No
 * error, no console warning, no failing build, no failing test: the launcher
 * simply is not there, and the omission looks exactly like "this surface has no
 * launcher yet". Three of seven install entries had drifted into that state
 * (terminal, calendar, the agent studio) before 2026-07-28, which is why this
 * is a structural guard and not a review convention.
 *
 * It deliberately checks the ENTRY files rather than the widgets: mounting the
 * provider once per install entry is the contract, so a widget author never has
 * to think about it. An entry that legitimately cannot mount it must say so with
 * an inline `no-workspace-host-port` marker, which makes the exception explicit
 * and greppable.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { shippableHostDependencies } from '../../../testing/hostDepManifests';

type UiManifest = {
  neuralis?: {
    referenceOnly?: boolean;
    app?: { module?: unknown; surfaces?: Array<{ component?: { renderer?: string; import?: string } }> };
  };
};

const HOST_ROOT = join(__dirname, '..', '..', '..', '..');
const OPT_OUT_MARKER = 'no-workspace-host-port';

// Machine-local (file:/link:) dev deps are excluded from every shippable
// derivation — a bare node_modules read would ENOENT on the docker lane, and
// an installed one would tie tracked asserts to operator dogfood state. See
// src/testing/hostDepManifests.ts (INC-W1C).
function readHostDependencies(): string[] {
  return shippableHostDependencies();
}

function readManifest(name: string): UiManifest {
  return JSON.parse(readFileSync(join(HOST_ROOT, 'node_modules', name, 'package.json'), 'utf-8')) as UiManifest;
}

function hasNeuralisBlock(name: string): boolean {
  const m = readManifest(name);
  return !!m.neuralis && m.neuralis.referenceOnly !== true;
}

/** The `component.import` literals of a manifest's `direct`-renderer surfaces. */
function directImports(manifest: UiManifest): string[] {
  return (manifest.neuralis?.app?.surfaces ?? [])
    .map((s) => (s.component?.renderer === 'direct' ? s.component.import : undefined))
    .filter((v): v is string => typeof v === 'string');
}

/** A `direct` surface with no runtime module: no host lane renders it. */
function directSurfaceWithoutModule(manifest: UiManifest): boolean {
  const module = manifest.neuralis?.app?.module;
  return directImports(manifest).length > 0 && !(module && typeof module === 'object');
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

/** `app/**\/host/install*HostComponents.tsx` — the one binding convention. */
function installEntries(appDir: string): string[] {
  return walk(appDir, (f) => /^install.*HostComponents\.tsx$/.test(f)).filter((full) =>
    full.split(sep).includes('host'),
  );
}

describe('every direct surface reaches the workspace through its runtime module', () => {
  const deps = readHostDependencies().filter(hasNeuralisBlock);

  it('finds direct surfaces to check', () => {
    expect(deps.filter((name) => directImports(readManifest(name)).length > 0).length).toBeGreaterThanOrEqual(3);
  });

  it('every host dep with a direct surface declares neuralis.app.module', () => {
    const missing = deps.filter((name) => directSurfaceWithoutModule(readManifest(name)));
    expect(missing, 'a direct surface without app.module renders through no lane — declare it and build `neuralis-build ui`').toEqual([]);
  });

  it('flags a direct surface without a module, and only that shape (paired control)', () => {
    const surfaces = [{ component: { renderer: 'direct', import: '@acme/w/app/w' } }];
    expect(directSurfaceWithoutModule({ neuralis: { app: { surfaces } } })).toBe(true);
    expect(directSurfaceWithoutModule({ neuralis: { app: { surfaces, module: { entry: 'dist/app/host.js' } } } })).toBe(false);
    expect(directSurfaceWithoutModule({ neuralis: { app: { surfaces: [{ component: { renderer: 'iframe' } }] } } })).toBe(false);
  });

  it("registers every direct component.import in the package's app/ tree", () => {
    for (const name of deps) {
      const imports = directImports(readManifest(name));
      if (imports.length === 0) continue;
      const sources = walk(join(HOST_ROOT, 'node_modules', name, 'app'), (f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
        .filter((file) => !file.split(sep).includes('__tests__'))
        .map((file) => readFileSync(file, 'utf-8'));
      for (const componentImport of imports) {
        expect(
          sources.some((s) => s.includes(`componentImport: '${componentImport}'`)),
          `${name}: manifest surface component.import "${componentImport}" is not registered anywhere in its app/ tree`,
        ).toBe(true);
      }
    }
  });

  it('no .tsx or className-bearing .ts outside app/ (the union sheet scans app/** only; tests exempt)', () => {
    // `app` is skipped ONLY at the package root, so a nested src/app/Foo.tsx
    // still fails. Test files render into jsdom and never ship.
    const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '__tests__']);
    const scan = (dir: string, hits: string[], atPackageRoot = false): void => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, item.name);
        if (item.isDirectory()) {
          if (SKIP_DIRS.has(item.name) || (atPackageRoot && item.name === 'app')) continue;
          scan(full, hits);
        } else if (/\.test\.tsx?$/.test(item.name)) {
          continue;
        } else if (item.name.endsWith('.tsx') || (item.name.endsWith('.ts') && readFileSync(full, 'utf-8').includes('className'))) {
          hits.push(full);
        }
      }
    };
    for (const name of deps) {
      const hits: string[] = [];
      scan(join(HOST_ROOT, 'node_modules', name), hits, true);
      expect(hits, `${name}: UI sources outside app/ escape the union stylesheet's scan`).toEqual([]);
    }
  });
});

describe('install entries mount WorkspaceHostPortProvider', () => {
  const deps = readHostDependencies().filter(hasNeuralisBlock);

  const entries = deps.flatMap((name) =>
    installEntries(join(HOST_ROOT, 'node_modules', name, 'app')).map((file) => ({ name, file })),
  );

  it('finds the install entries to check', () => {
    // Chat, calendar, terminal, filesystem, admin, machine, ecom — a drop below
    // this means the scan pattern stopped matching, not that entries vanished.
    expect(entries.length).toBeGreaterThanOrEqual(6);
  });

  it('every install entry mounts the provider (or opts out explicitly)', () => {
    const missing: string[] = [];
    for (const { name, file } of entries) {
      const src = readFileSync(file, 'utf-8');
      if (src.includes(OPT_OUT_MARKER)) continue;
      if (!src.includes('<WorkspaceHostPortProvider')) {
        missing.push(`${name}: ${file.slice(file.indexOf(sep + 'app' + sep) + 1)}`);
      }
    }
    expect(
      missing,
      `install entries without <WorkspaceHostPortProvider> — every <SkillLauncher> under them renders null SILENTLY. Wrap the registered component, or add an inline "${OPT_OUT_MARKER}" comment explaining why it cannot.`,
    ).toEqual([]);
  });
});
