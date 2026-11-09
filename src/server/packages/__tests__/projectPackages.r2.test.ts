/**
 * R2b — project/user/agent-aware package consumption (scope-guarding-magpie).
 *
 * Pins the C2/R2b selection (`selectFlaggedPackageRoots`): every package
 * folder of an enabled source this host opens is scanned AND its OWNING scope
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
    plane: 'local',
    packageFolders: [''],
    enabled: true,
    kind: 'folder',
    ...overrides,
  };
}

describe('selectFlaggedPackageRoots — the C2/R2b selection', () => {
  it('selects a project-scope, enabled folder whose whole source is a package folder, with its scope', () => {
    expect(selectFlaggedPackageRoots([root({})])).toEqual([
      { dir: '/projects/p1/acme', ownerScope: { kind: 'project' }, plane: 'local', uriRoot: 'acme://' },
    ]);
  });

  it('R2b — a user-scoped flagged source is INCLUDED, carrying its user scope', () => {
    const userScoped = root({ slug: 'pkg-alice', scope: { kind: 'user', userId: 'alice' } });
    expect(selectFlaggedPackageRoots([userScoped])).toEqual([
      { dir: '/projects/p1/acme', ownerScope: { kind: 'user', userId: 'alice' }, plane: 'local', uriRoot: 'acme://' },
    ]);
  });

  it('R2b — an agent-scoped flagged source is INCLUDED, carrying its agent scope', () => {
    const agentScoped = root({ slug: 'pkg-a1', scope: { kind: 'agent', userId: 'alice', agentId: 'a1' } });
    expect(selectFlaggedPackageRoots([agentScoped])).toEqual([
      { dir: '/projects/p1/acme', ownerScope: { kind: 'agent', userId: 'alice', agentId: 'a1' }, plane: 'local', uriRoot: 'acme://' },
    ]);
  });

  it('skips a source with no package folders (deny-by-default)', () => {
    expect(selectFlaggedPackageRoots([root({ packageFolders: [] })])).toEqual([]);
  });

  it('scans each listed package folder under the source root, its uri root following', () => {
    expect(selectFlaggedPackageRoots([root({ packageFolders: ['tools/pkgs', 'skills'] })])).toEqual([
      { dir: '/projects/p1/acme/tools/pkgs', ownerScope: { kind: 'project' }, plane: 'local', uriRoot: 'acme://tools/pkgs' },
      { dir: '/projects/p1/acme/skills', ownerScope: { kind: 'project' }, plane: 'local', uriRoot: 'acme://skills' },
    ]);
  });

  // A device folder arrives with the root THIS process opens: brain-core asks
  // agent-core (loopback device, ceiling-checked directory) and passes '' for
  // every other device — the host never opens a remote device's folder.
  it('a device folder this host may open is scanned in place; another device\'s (an empty root) never is', () => {
    expect(selectFlaggedPackageRoots([root({ slug: 'laptop', plane: 'device', containerRoot: '/home/me/work', uriRoot: 'laptop://' })])).toEqual([
      { dir: '/home/me/work', ownerScope: { kind: 'project' }, plane: 'device', uriRoot: 'laptop://' },
    ]);
    expect(selectFlaggedPackageRoots([root({ slug: 'remote', containerRoot: '', uriRoot: 'remote://' })])).toEqual([]);
  });

  it('skips a disabled source', () => {
    expect(selectFlaggedPackageRoots([root({ enabled: false })])).toEqual([]);
  });

  it('skips a kind with no folder root (brain-core hands it an empty root)', () => {
    expect(selectFlaggedPackageRoots([root({ kind: 'brain', containerRoot: '' })])).toEqual([]);
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
      { dir: '/p/a', ownerScope: { kind: 'project' }, plane: 'local', uriRoot: 'acme://' },
      { dir: '/p/alice', ownerScope: { kind: 'user', userId: 'alice' }, plane: 'local', uriRoot: 'acme://' },
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
