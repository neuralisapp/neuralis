/**
 * R2b — project/user/agent-aware package consumption (scope-guarding-magpie).
 *
 * Pins the C2/R2b selection (`selectFlaggedPackageRoots`): every
 * `recognizesPackages`, enabled, local source is scanned AND its OWNING scope
 * (project/user/agent) is carried on each returned root. User/agent-scoped
 * sources now LOAD (R2 skipped them) — the per-caller advertise isolation that
 * keeps a user/agent source private is enforced downstream at the snapshot +
 * stream boundary via the carried `ownerScope`, NOT by refusing to load. Also
 * pins the A2 scanner re-key (one scanner per resolved dir, not per project root).
 */
import { describe, it, expect } from 'vitest';
import type { PackageSourceRoot } from '@neuralis/package-system/contracts';
import { selectFlaggedPackageRoots } from '../projectPackages';
import { getProjectPackageScanner, getScannerForDir } from '../ProjectPackageScanner';

function root(overrides: Partial<PackageSourceRoot>): PackageSourceRoot {
  return {
    slug: 'acme',
    uriRoot: 'acme://',
    containerRoot: '/projects/p1/acme',
    scope: { kind: 'project' },
    recognizesPackages: true,
    enabled: true,
    kind: 'local',
    ...overrides,
  };
}

describe('selectFlaggedPackageRoots — the C2/R2b selection', () => {
  it('selects a project-scope, flagged, enabled, local source with its scope', () => {
    expect(selectFlaggedPackageRoots([root({})])).toEqual([
      { dir: '/projects/p1/acme', ownerScope: { kind: 'project' } },
    ]);
  });

  it('R2b — a user-scoped flagged source is INCLUDED, carrying its user scope', () => {
    const userScoped = root({ slug: 'pkg-alice', scope: { kind: 'user', userId: 'alice' } });
    expect(selectFlaggedPackageRoots([userScoped])).toEqual([
      { dir: '/projects/p1/acme', ownerScope: { kind: 'user', userId: 'alice' } },
    ]);
  });

  it('R2b — an agent-scoped flagged source is INCLUDED, carrying its agent scope', () => {
    const agentScoped = root({ slug: 'pkg-a1', scope: { kind: 'agent', userId: 'alice', agentId: 'a1' } });
    expect(selectFlaggedPackageRoots([agentScoped])).toEqual([
      { dir: '/projects/p1/acme', ownerScope: { kind: 'agent', userId: 'alice', agentId: 'a1' } },
    ]);
  });

  it('skips an unflagged source (deny-by-default)', () => {
    expect(selectFlaggedPackageRoots([root({ recognizesPackages: false })])).toEqual([]);
  });

  it('skips a disabled source', () => {
    expect(selectFlaggedPackageRoots([root({ enabled: false })])).toEqual([]);
  });

  it('skips a non-local source', () => {
    expect(selectFlaggedPackageRoots([root({ kind: 'brain' })])).toEqual([]);
  });

  it('skips the default `packages` drop-zone (C3 handles it unconditionally)', () => {
    expect(selectFlaggedPackageRoots([root({ slug: 'packages' })])).toEqual([]);
  });

  it('skips a flagged source with an unresolved container root', () => {
    expect(selectFlaggedPackageRoots([root({ containerRoot: '' })])).toEqual([]);
  });

  it('selects multiple flagged sources of mixed scope, dropping only the skips', () => {
    const dirs = selectFlaggedPackageRoots([
      root({ slug: 'a', containerRoot: '/p/a' }),
      root({ slug: 'pkg-alice', scope: { kind: 'user', userId: 'alice' }, containerRoot: '/p/alice' }),
      root({ slug: 'b', containerRoot: '/p/b', enabled: false }),
    ]);
    expect(dirs).toEqual([
      { dir: '/p/a', ownerScope: { kind: 'project' } },
      { dir: '/p/alice', ownerScope: { kind: 'user', userId: 'alice' } },
    ]);
  });
});

describe('A2 — scanner registry re-keyed by resolved package dir', () => {
  it('getScannerForDir returns the SAME instance for the same dir, distinct for different dirs', () => {
    const a = getScannerForDir('/projects/p1/acme');
    const b = getScannerForDir('/projects/p1/acme');
    const c = getScannerForDir('/projects/p1/other');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('getProjectPackageScanner keys by `<root>/_packages`, distinct from a flagged sibling dir', () => {
    const def = getProjectPackageScanner('/projects/p2');
    const viaDir = getScannerForDir('/projects/p2/_packages');
    const flagged = getScannerForDir('/projects/p2/custom-src');
    expect(def).toBe(viaDir); // same resolved dir ⇒ same scanner (no overwrite)
    expect(def).not.toBe(flagged);
    expect(def.packagesDir).toBe('/projects/p2/_packages');
  });
});
