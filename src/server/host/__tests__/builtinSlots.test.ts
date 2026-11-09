/**
 * Discovery + trust unit tests for the scope-agnostic builtin-class loading
 * (crystalline-lagoon). Covers verification items #1 (discovery), #2 (trust)
 * and #8 (R2 ordering: exclusion BEFORE trust-overwrite).
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { selectBuiltinPackageIds, assignBuiltinProvenance, builtinDependencyLines, discoverBuiltinRoots, resolveHostRoot, HOST_ROOT, type DepManifest } from '../builtinSlots';
import type { PackageDefinition } from '@neuralis/package-system/contracts';

const FIXTURE_DEPS: Record<string, string> = {
  '@acme/demo': 'file:/somewhere/acme-demo',
  '@acme/refonly': '^1.0.0',
  '@acme/contract-example': '^1.0.0',
  '@neuralis/agent-core': 'workspace:*',
  '@neuralis/package-system': 'workspace:*',
  '@neuralis/example-builtin': 'workspace:*',
  zod: '^3.0.0',
  react: '^19.0.0',
  'not-installed': '^1.0.0',
};

const FIXTURE_MANIFESTS: Record<string, DepManifest | undefined> = {
  '@acme/demo': { neuralis: { id: '@acme/demo' } },
  '@acme/refonly': { neuralis: { id: '@acme/refonly', referenceOnly: true } },
  // The example-builtin shape from a foreign scope: carries a block with
  // a deliberate trusted+embedded combination — must be excludable via
  // referenceOnly, never silently promoted.
  '@acme/contract-example': {
    neuralis: { id: '@acme/contract-example', referenceOnly: true, access: { trust: 'trusted' } },
  },
  '@neuralis/agent-core': { neuralis: { id: '@neuralis/agent-core' } },
  // package-system has NO neuralis block in reality — signal #2 excludes it
  // even without the explicit reference-only set.
  '@neuralis/package-system': {},
  '@neuralis/example-builtin': { neuralis: { id: '@neuralis/example-builtin' } },
  zod: {},
  react: {},
  'not-installed': undefined, // resolution failure
};

const readFixtureManifest = (name: string): DepManifest | undefined => FIXTURE_MANIFESTS[name];

describe('selectBuiltinPackageIds (discovery signal)', () => {
  it('includes any-scope deps that carry a neuralis block', () => {
    const ids = selectBuiltinPackageIds(FIXTURE_DEPS, readFixtureManifest);
    expect(ids).toContain('@acme/demo');
    expect(ids).toContain('@neuralis/agent-core');
  });

  it('excludes plain npm deps without a neuralis block', () => {
    const ids = selectBuiltinPackageIds(FIXTURE_DEPS, readFixtureManifest);
    expect(ids).not.toContain('zod');
    expect(ids).not.toContain('react');
  });

  it('excludes unresolvable deps without throwing', () => {
    const ids = selectBuiltinPackageIds(FIXTURE_DEPS, readFixtureManifest);
    expect(ids).not.toContain('not-installed');
  });

  it('honors the scope-agnostic neuralis.referenceOnly opt-out', () => {
    const ids = selectBuiltinPackageIds(FIXTURE_DEPS, readFixtureManifest);
    expect(ids).not.toContain('@acme/refonly');
  });

  it('R2: a reference-only trusted+embedded package is excluded BEFORE any trust assignment', () => {
    // Discovery must never surface it — bootstrap's native overwrite only
    // runs on discovery output, so exclusion here IS the ordering guarantee.
    const ids = selectBuiltinPackageIds(FIXTURE_DEPS, readFixtureManifest);
    expect(ids).not.toContain('@acme/contract-example');
  });

  it('R2: the explicit REFERENCE_ONLY set excludes the platform reference packages even when they carry a block', () => {
    const ids = selectBuiltinPackageIds(FIXTURE_DEPS, readFixtureManifest);
    // example-builtin carries a block in this fixture (as in reality) —
    // the belt-and-suspenders set must still exclude it.
    expect(ids).not.toContain('@neuralis/example-builtin');
    expect(ids).not.toContain('@neuralis/package-system');
  });

  it('returns a sorted, deterministic list', () => {
    const ids = selectBuiltinPackageIds(FIXTURE_DEPS, readFixtureManifest);
    expect(ids).toEqual([...ids].sort());
  });

  it('the load-bearing comment on REFERENCE_ONLY_PACKAGE_IDS is present (R2 guard)', () => {
    const source = readFileSync(new URL('../builtinSlots.ts', import.meta.url), 'utf-8');
    expect(source).toMatch(/LOAD-BEARING \(R2\)/);
  });
});

describe('the host root — the code that runs, whatever the working directory', () => {
  it('the host package that holds this module, from any folder the command was typed in', () => {
    const moduleFile = join('/opt', 'host', 'src', 'server', 'host', 'builtinSlots.ts');
    expect(resolveHostRoot(join('/home', 'op', 'elsewhere'), moduleFile)).toBe(resolve('/opt', 'host'));
    expect(resolveHostRoot(join('/opt', 'host', 'scripts'), moduleFile)).toBe(resolve('/opt', 'host'));
    expect(HOST_ROOT).toBe(resolve(__dirname, '..', '..', '..', '..'));
  });

  it('the built server in `_runtime/` anchors one level up; a `_runtime` with no host package above is no exception', () => {
    const root = mkdtempSync(join(tmpdir(), 'nrs-host-root-'));
    try {
      mkdirSync(join(root, 'host', '_runtime'), { recursive: true });
      writeFileSync(join(root, 'host', 'package.json'), '{"name":"neuralis"}');
      // The flattened chunks' `import.meta.url`: a path no file is at.
      const moved = join(root, 'host', 'neuralis', 'src', 'server', 'host', 'builtinSlots.ts');
      expect(resolveHostRoot(join(root, 'host', '_runtime'), moved)).toBe(join(root, 'host'));
      mkdirSync(join(root, 'bare', '_runtime'), { recursive: true });
      expect(resolveHostRoot(join(root, 'bare', '_runtime'), join(root, 'src', 'server', 'host', 'builtinSlots.ts'))).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('builtinDependencyLines (which manifest lines discovery reads)', () => {
  const hostPackage = { dependencies: { '@neuralis/agent-core': '0.2.0', '@neuralis/brain-core': '0.2.0', zod: '^3.0.0' } };
  const unreachable = (): never => { throw new Error('the host package must not be read for the host manifest itself'); };

  it('the host manifest itself is read as it is (the image, the clone, the monorepo)', () => {
    const own = { dependencies: { '@neuralis/agent-core': 'workspace:*', '@acme/demo': 'file:/x' } };
    expect(builtinDependencyLines(own, unreachable)).toEqual(own.dependencies);
    expect(builtinDependencyLines({}, unreachable)).toEqual({});
  });

  it('an npm install folder reads the host package lines plus its own, never the host line — the derived image manifest', () => {
    const folder = { dependencies: { neuralis: '0.2.0', '@acme/demo': '1.0.0' } };
    const lines = builtinDependencyLines(folder, () => hostPackage);
    expect(lines).toEqual({ ...hostPackage.dependencies, '@acme/demo': '1.0.0' });
    expect(selectBuiltinPackageIds(lines, readFixtureManifest)).toEqual(['@acme/demo', '@neuralis/agent-core']);
  });
});

describe('assignBuiltinProvenance (host-assigned native)', () => {
  it('overwrites a missing self-declaration to native', () => {
    const def = { id: '@acme/demo', name: 'Acme Demo' } as PackageDefinition;
    expect(assignBuiltinProvenance(def).access?.trust).toBe('native');
  });

  it('overwrites a weaker self-declaration (source-based authorization)', () => {
    const def = {
      id: '@acme/demo',
      name: 'Acme Demo',
      access: { trust: 'untrusted', externalPolicy: 'oauth-only' },
    } as PackageDefinition;
    const assigned = assignBuiltinProvenance(def);
    expect(assigned.access?.trust).toBe('native');
    // Other access fields survive the overwrite.
    expect(assigned.access?.externalPolicy).toBe('oauth-only');
  });

  it('stamps source.kind neuralis on a manifest that declares none — the record lane needs no field', () => {
    const def = { id: '@acme/demo', name: 'Acme Demo' } as PackageDefinition;
    const assigned = assignBuiltinProvenance(def);
    expect(assigned.source).toEqual({ kind: 'neuralis' });
    expect(assigned.access?.trust).toBe('native');
  });

  it('overwrites a manifest\'s own source, as it overwrites its trust', () => {
    for (const kind of ['npm', 'local-dir'] as const) {
      const assigned = assignBuiltinProvenance({ id: '@acme/demo', name: 'Acme Demo', source: { kind, location: { npm: '@acme/demo' } }, access: { trust: 'untrusted' } } as PackageDefinition);
      expect(assigned.source, kind).toEqual({ kind: 'neuralis' });
      expect(assigned.access?.trust, kind).toBe('native');
    }
  });

  it('does not mutate the input definition', () => {
    const def = { id: '@acme/demo', name: 'Acme Demo', access: { trust: 'untrusted' } } as PackageDefinition;
    assignBuiltinProvenance(def);
    expect(def.access?.trust).toBe('untrusted');
  });
});

describe('discoverBuiltinRoots (host deps ∪ the runtime install record)', () => {
  const manifests: Record<string, DepManifest> = {
    '/host/nm/@neuralis/agent-core/package.json': { neuralis: { id: '@neuralis/agent-core' } },
    '/host/nm/zod/package.json': {},
    '/rec/nm/@acme/late/package.json': { neuralis: { id: '@acme/late' } },
    '/rec/nm/@acme/refonly/package.json': { neuralis: { referenceOnly: true } },
    '/rec/nm/plain/package.json': {},
    '/rec/nm/@neuralis/agent-core/package.json': { neuralis: { id: '@neuralis/agent-core' } },
  };
  const resolver = (prefix: string) => (name: string): string => {
    const path = `${prefix}/${name}/package.json`;
    if (!(path in manifests)) throw new Error(`cannot resolve ${name}`);
    return path;
  };
  const discover = (recordLines: Record<string, string>) => discoverBuiltinRoots({
    hostLines: { '@neuralis/agent-core': 'workspace:*', zod: '^3' },
    recordLines,
    resolveHost: resolver('/host/nm'),
    resolveRecord: resolver('/rec/nm'),
    readManifest: (path) => manifests[path],
  });

  it('a record entry is a builtin with ITS OWN root, by the same exclusion order as a host dep', () => {
    const found = discover({ '@acme/late': '1.0.0', '@acme/refonly': '1.0.0', plain: '1.0.0', 'not-installed': '1.0.0' });
    expect([...found.roots]).toEqual([
      ['@neuralis/agent-core', '/host/nm/@neuralis/agent-core'],
      ['@acme/late', '/rec/nm/@acme/late'],
    ]);
    expect([...found.runtimeInstalled]).toEqual(['@acme/late']);
    expect(found.shadowed).toEqual([]);
  });

  it('a record entry the host itself ships is never read — the image copy wins, by name', () => {
    const found = discover({ '@neuralis/agent-core': '9.9.9', zod: '9.9.9' });
    expect(found.roots.get('@neuralis/agent-core')).toBe('/host/nm/@neuralis/agent-core');
    expect(found.runtimeInstalled.size).toBe(0);
    expect(found.shadowed).toEqual(['@neuralis/agent-core', 'zod']);
  });

  it('no record: exactly the host discovery', () => {
    const found = discover({});
    expect([...found.roots.keys()]).toEqual(['@neuralis/agent-core']);
  });
});
