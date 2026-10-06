/**
 * `applyGrantsPatch` / `revokeGrantsPatch` — the two grant computations, pinned
 * as PURE functions of the project record.
 *
 * Why they are pure exports of the grant usecase: their callers are the
 * `#private` writers of the `globalThis` `PackageRuntimeManager` singleton and the
 * boot's builtin grant-change usecase, so the only way to pin the merge-once
 * guard, the floors and — the point of this file — the SEQUENCING is to lift
 * the computations out. They run inside
 * `updateProject`'s producer, which is exactly the "fed the record as it is on
 * disk" shape the sequential rows below model.
 *
 * The pin: three revocations applied IN SEQUENCE, each fed the record the
 * previous one produced, drain every marker. The paired control applies the same
 * three from ONE stale base and leaves 2 of 3 standing — the live-measured
 * residue (`appliedPackageGrants` 6→6 instead of 6→3).
 */

import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLE_PRIORITY } from '@neuralis/package-system/access';
import { canReceivePackageGrant } from '../../projects/access';
import { applyGrantsPatch, revokeGrantsPatch } from '../reconcileBuiltinGrantChanges';
import type { ProjectRecord, RoleDefinition } from '../../store/projectTypes';

function role(over: Partial<RoleDefinition> = {}): RoleDefinition {
  return { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 20, ...over };
}

function project(over: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'p1',
    name: 'P1',
    ownerId: 'u-owner',
    members: {
      'u-owner': {
        userId: 'u-owner', name: 'O', email: 'o@x.co', role: 'owner',
        position: 'Owner', tier: 1, addedAt: 't',
      },
    },
    roles: {
      owner: role({ agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 }),
      admin: role({ agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: [], priority: BUILTIN_ROLE_PRIORITY.admin }),
      member: role(),
    },
    agentOwnership: {},
    limits: { spend: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} } },
    createdAt: 't',
    updatedAt: 't',
    ...over,
  } as ProjectRecord;
}

/** Apply a `ProjectRecordPatch` the way `updateProject` merges it. */
function merge(p: ProjectRecord, patch: ReturnType<typeof revokeGrantsPatch>): ProjectRecord {
  if (patch === null) return p;
  return {
    ...p,
    roles: patch.roles ?? p.roles,
    appliedPackageGrants: patch.appliedPackageGrants ?? p.appliedPackageGrants,
  };
}

const THREE = { 'pkg-a': '1.0.0', 'pkg-b': '1.0.0', 'pkg-c': '1.0.0' };

describe('revokeGrantsPatch — the sequencing pin', () => {
  it('three revocations applied IN SEQUENCE drain every marker', async () => {
    let p = project({ appliedPackageGrants: { ...THREE } });
    for (const pkg of ['pkg-a', 'pkg-b', 'pkg-c']) {
      p = merge(p, revokeGrantsPatch(p, pkg, new Set<string>()));
    }
    expect(p.appliedPackageGrants).toEqual({});
  });

  it('PAIRED CONTROL: three revocations from ONE stale base leave 2 of 3', async () => {
    const base = project({ appliedPackageGrants: { ...THREE } });
    let p = base;
    for (const pkg of ['pkg-a', 'pkg-b', 'pkg-c']) {
      // Every one computed from `base` — the get→modify→put shape.
      p = merge(p, revokeGrantsPatch(base, pkg, new Set<string>()));
    }
    expect(Object.keys(p.appliedPackageGrants ?? {})).toHaveLength(2);
  });

  it('answers null when there is nothing to write (no marker, no role change)', () => {
    expect(revokeGrantsPatch(project(), 'pkg-a', new Set(['x.feature']))).toBeNull();
  });

  it('strips a revoked feature from a weak role and keeps the rest', () => {
    const p = project({
      roles: {
        owner: role({ agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 }),
        member: role({ grantedFeatures: ['pkg.read', 'other.keep'] }),
      },
      appliedPackageGrants: { 'pkg-a': '1.0.0' },
    });
    const patch = revokeGrantsPatch(p, 'pkg-a', new Set(['pkg.read']));
    expect(patch?.roles?.member.grantedFeatures).toEqual(['other.keep']);
    expect(patch?.appliedPackageGrants).toEqual({});
  });

  it('CONTROL: the APEX floor is unchanged — a priority-1 role is never stripped', () => {
    const p = project({
      roles: {
        // A custom apex role carrying an ENUMERATED list: the shape the skip exists for.
        chief: role({ grantedFeatures: ['pkg.read'], priority: 1 }),
        member: role({ grantedFeatures: ['pkg.read'] }),
      },
      appliedPackageGrants: { 'pkg-a': '1.0.0' },
    });
    const patch = revokeGrantsPatch(p, 'pkg-a', new Set(['pkg.read']));
    expect(patch?.roles?.chief.grantedFeatures).toEqual(['pkg.read']);
    expect(patch?.roles?.member.grantedFeatures).toEqual([]);
  });

  it('CONTROL: a wildcard role is never touched', () => {
    const p = project({ appliedPackageGrants: { 'pkg-a': '1.0.0' } });
    const patch = revokeGrantsPatch(p, 'pkg-a', new Set(['*', 'pkg.read']));
    expect(patch?.roles).toBeUndefined(); // no role changed at all
    expect(patch?.appliedPackageGrants).toEqual({});
  });
});

describe('applyGrantsPatch — merge-once and the reinstall path', () => {
  const grants = { member: ['pkg.read'] };
  const provided = new Set(['pkg.read']);

  it('records the provenance marker even when no feature was added', () => {
    const p = project({ roles: { ...project().roles, member: role({ grantedFeatures: ['pkg.read'] }) } });
    const patch = applyGrantsPatch(p, 'pkg-a', '1.0.0', grants, provided, canReceivePackageGrant);
    expect(patch?.roles).toBeUndefined();
    expect(patch?.appliedPackageGrants).toEqual({ 'pkg-a': '1.0.0' });
  });

  it('merge-once: the SAME version answers null (an admin revoke is preserved)', () => {
    const p = project({ appliedPackageGrants: { 'pkg-a': '1.0.0' } });
    expect(applyGrantsPatch(p, 'pkg-a', '1.0.0', grants, provided, canReceivePackageGrant)).toBeNull();
  });

  it('a REINSTALL after a revoke re-applies the grants — the marker skip no longer bites', () => {
    // The residue this increment removes: the revoke used to lose its marker
    // deletion to a concurrent writer, and the merge-once guard then skipped the
    // grants on reinstall. Drive it end to end on the record the producer sees.
    let p = project({
      roles: { ...project().roles, member: role({ grantedFeatures: ['pkg.read'] }) },
      appliedPackageGrants: { 'pkg-a': '1.0.0', 'pkg-b': '1.0.0' },
    });
    p = merge(p, revokeGrantsPatch(p, 'pkg-a', new Set(['pkg.read'])));
    expect(p.roles.member.grantedFeatures).toEqual([]);
    expect(p.appliedPackageGrants).toEqual({ 'pkg-b': '1.0.0' });

    const reinstall = applyGrantsPatch(p, 'pkg-a', '1.0.0', grants, provided, canReceivePackageGrant);
    expect(reinstall).not.toBeNull();
    expect(reinstall?.roles?.member.grantedFeatures).toEqual(['pkg.read']);
    expect(reinstall?.appliedPackageGrants).toEqual({ 'pkg-a': '1.0.0', 'pkg-b': '1.0.0' });
  });

  it('CONTROL: the canReceivePackageGrant floor is unchanged — admin and apex get nothing', () => {
    const p = project();
    const patch = applyGrantsPatch(
      p,
      'pkg-a',
      '1.0.0',
      { admin: ['pkg.read'], owner: ['pkg.read'], member: ['pkg.read'] },
      provided,
      canReceivePackageGrant,
    );
    expect(patch?.roles?.admin.grantedFeatures).toEqual([]);
    expect(patch?.roles?.owner.grantedFeatures).toEqual(['*']);
    expect(patch?.roles?.member.grantedFeatures).toEqual(['pkg.read']);
  });

  it('CONTROL: a feature the package does not PROVIDE, and a bare `*`, are never granted', () => {
    const patch = applyGrantsPatch(
      project(),
      'pkg-a',
      '1.0.0',
      { member: ['*', 'not.provided', 'pkg.read'] },
      provided,
      canReceivePackageGrant,
    );
    expect(patch?.roles?.member.grantedFeatures).toEqual(['pkg.read']);
  });
});
