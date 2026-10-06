/**
 * Unit tests for the cross-tenant scope-hidden resolver (tenant-fencing-otter).
 *
 * The stream/overview path consumes the GLOBAL, scope-blind runtime snapshot and
 * is gated ONLY by subtracting this hide-list, so the resolver is the single
 * cross-tenant isolation boundary. Covers all three axes + the registry-read
 * fail-soft (an unguarded registry read here would be a stream-breaking DoS).
 */

import { describe, expect, it, vi } from 'vitest';
import type { PackageDefinition, SourceScope } from '@neuralis/package-system/contracts';
import { resolveScopeHiddenIds, BUILTIN_PACKAGE_IDS } from '../bootstrap';

const BUILTIN_ID = [...BUILTIN_PACKAGE_IDS][0]!;

type RegistryEntry = { id: string; requires?: { accessFeature?: string } };

function makeManager(opts: {
  projectPkgIds: Record<string, string[]>;
  ownerScopes?: Record<string, SourceScope>;
  manifestIds?: Record<string, string>;
  registry?: RegistryEntry[];
  registryThrows?: boolean;
}) {
  return {
    getProjectPackageIds: (projectId: string) => new Set(opts.projectPkgIds[projectId] ?? []),
    getPackageOwnerScope: (_projectId: string, id: string) => opts.ownerScopes?.[id],
    // namespaced loader id → manifest id (undefined ⇒ the id IS its own manifest id).
    getPackageManifestId: (_projectId: string, id: string) => opts.manifestIds?.[id],
    getRegistry: () => {
      if (opts.registryThrows) throw new Error('runtime state not ready');
      return { listPackages: () => (opts.registry ?? []) as PackageDefinition[] };
    },
  } as never;
}

function makeDeps(
  mgr: ReturnType<typeof makeManager>,
  overrides: Record<string, string> = {},
) {
  const logger = { warn: vi.fn() };
  return {
    deps: {
      runtimeManager: mgr,
      getProjectById: vi.fn(async () => ({ packageAccessFeature: overrides })) as never,
      logger,
    },
    logger,
  };
}

const memberCaller = (projectId: string) => ({
  projectId,
  userId: 'u1',
  role: 'member',
  grantedFeatures: [] as string[],
});

describe('resolveScopeHiddenIds — Axis 3 cross-project isolation', () => {
  it('hides a FOREIGN project package, keeps the caller-project package and builtins', async () => {
    const mgr = makeManager({
      projectPkgIds: { 'proj-a': ['pkg-a'], 'proj-b': ['pkg-b'] },
      registry: [{ id: BUILTIN_ID }, { id: 'pkg-a' }, { id: 'pkg-b' }],
    });
    const { deps } = makeDeps(mgr);

    const hidden = await resolveScopeHiddenIds(deps, memberCaller('proj-a'));

    expect(hidden.has('pkg-b')).toBe(true); // foreign project → hidden
    expect(hidden.has('pkg-a')).toBe(false); // own project → visible
    expect(hidden.has(BUILTIN_ID)).toBe(false); // builtin → always visible
  });

  it('is symmetric — proj-b hides pkg-a, not pkg-b', async () => {
    const mgr = makeManager({
      projectPkgIds: { 'proj-a': ['pkg-a'], 'proj-b': ['pkg-b'] },
      registry: [{ id: BUILTIN_ID }, { id: 'pkg-a' }, { id: 'pkg-b' }],
    });
    const { deps } = makeDeps(mgr);

    const hidden = await resolveScopeHiddenIds(deps, memberCaller('proj-b'));

    expect(hidden.has('pkg-a')).toBe(true);
    expect(hidden.has('pkg-b')).toBe(false);
    expect(hidden.has(BUILTIN_ID)).toBe(false);
  });
});

describe('resolveScopeHiddenIds — Axis 2 base-access feature', () => {
  it('hides an OWN-project package gated by a manifest feature the caller lacks', async () => {
    const mgr = makeManager({
      projectPkgIds: { 'proj-a': ['pkg-gated'] },
      registry: [{ id: 'pkg-gated', requires: { accessFeature: 'pkg.access' } }],
    });
    const { deps } = makeDeps(mgr);

    const hidden = await resolveScopeHiddenIds(deps, memberCaller('proj-a'));
    expect(hidden.has('pkg-gated')).toBe(true); // own project but feature-gated
  });

  it('hides a BUILTIN gated by a host packageAccessFeature override', async () => {
    const mgr = makeManager({
      projectPkgIds: { 'proj-a': [] },
      registry: [{ id: BUILTIN_ID }],
    });
    const { deps } = makeDeps(mgr, { [BUILTIN_ID]: 'first-party.access' });

    const hidden = await resolveScopeHiddenIds(deps, memberCaller('proj-a'));
    expect(hidden.has(BUILTIN_ID)).toBe(true); // base-access override applies to builtins
  });

  it('translates a namespaced project-package id to its MANIFEST id for the override lookup', async () => {
    const NS_ID = 'p.proj-a.project.securepkg';
    const mgr = makeManager({
      projectPkgIds: { 'proj-a': [NS_ID] },   // loaded under the scope-namespaced id
      manifestIds: { [NS_ID]: 'securepkg' },  // namespaced → manifest
      registry: [{ id: NS_ID }],              // no manifest accessFeature; override only
    });
    // Admin override keyed by the MANIFEST id (what the Packages tab writes).
    const { deps } = makeDeps(mgr, { securepkg: 'secure.access' });

    const hidden = await resolveScopeHiddenIds(deps, memberCaller('proj-a'));
    expect(hidden.has(NS_ID)).toBe(true); // manifest-keyed override still hides the namespaced id
  });
});

describe('resolveScopeHiddenIds — fail-soft', () => {
  it('does NOT throw when the registry read throws; logs and returns Axis-1 result', async () => {
    const mgr = makeManager({
      projectPkgIds: { 'proj-a': ['pkg-a'] },
      registryThrows: true,
    });
    const { deps, logger } = makeDeps(mgr);

    const hidden = await resolveScopeHiddenIds(deps, memberCaller('proj-a'));

    // Registry-dependent axes (2 + 3) skipped → no foreign hiding this call,
    // but the stream is NOT broken. Axis 1 (manager maps) still ran.
    expect(hidden.size).toBe(0);
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});
