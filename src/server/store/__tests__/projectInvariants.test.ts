/**
 * B5 — the ONE structural-invariant body. Two copies existed and had already
 * drifted: only the `projects/access.ts` one validated `agentOwnership`. The
 * merged body is the SUPERSET, so `updateProject` now rejects exactly what the
 * HTTP patch path rejects.
 */

import { describe, expect, it } from 'vitest';
import { validateProjectInvariants } from '../projectInvariants';
import { validateProjectInvariants as reExportedFromAccess } from '../../projects/access';
import type { ProjectRecord } from '../projectTypes';

function record(over: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'p1',
    name: 'P1',
    ownerId: 'owner-1',
    members: {
      'owner-1': { userId: 'owner-1', name: 'O', email: 'o@x', role: 'owner', position: '', tier: 1, addedAt: 'x' },
    },
    roles: {
      owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
    },
    agentOwnership: {},
    limits: { daily: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} } },
    createdAt: 'x',
    updatedAt: 'x',
    ...over,
  } as ProjectRecord;
}

describe('validateProjectInvariants', () => {
  it('accepts a well-formed record', () => {
    expect(validateProjectInvariants(record())).toBeNull();
  });

  it('is literally the same function `projects/access` exports (no second copy)', () => {
    expect(reExportedFromAccess).toBe(validateProjectInvariants);
  });

  it('requires the provenance owner to remain a member holding the owner role', () => {
    expect(validateProjectInvariants(record({ members: {} }))).toContain('must remain a member');
    expect(
      validateProjectInvariants(
        record({
          members: {
            'owner-1': { userId: 'owner-1', name: 'O', email: 'o@x', role: 'member', position: '', tier: 20, addedAt: 'x' },
          },
          roles: {
            owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
            member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 20 },
          },
        }),
      ),
    ).toContain('must keep the owner role');
  });

  it('rejects a member key that disagrees with userId, and an unknown role reference', () => {
    expect(
      validateProjectInvariants(
        record({
          members: {
            'owner-1': { userId: 'owner-1', name: 'O', email: 'o@x', role: 'owner', position: '', tier: 1, addedAt: 'x' },
            'x': { userId: 'y', name: '', email: '', role: 'owner', position: '', tier: 1, addedAt: 'x' },
          },
        }),
      ),
    ).toContain('member key must match userId');

    expect(
      validateProjectInvariants(
        record({
          members: {
            'owner-1': { userId: 'owner-1', name: 'O', email: 'o@x', role: 'owner', position: '', tier: 1, addedAt: 'x' },
            'm1': { userId: 'm1', name: '', email: '', role: 'ghost', position: '', tier: 20, addedAt: 'x' },
          },
        }),
      ),
    ).toContain('unknown role');
  });

  // The deliberate TIGHTENING: `updateProject` did not validate this before.
  // Safe because every entry that ever reached disk went through
  // `validateAgentOwnership` (a superset check) on the PATCH route.
  it('validates agentOwnership — the arm the ProjectStore copy was missing', () => {
    expect(
      validateProjectInvariants(record({ agentOwnership: { a1: { createdBy: '', assignedTo: [] } } })),
    ).toContain('must include createdBy');
    expect(
      validateProjectInvariants(
        record({ agentOwnership: { a1: { createdBy: 'u1', assignedTo: 'nope' as unknown as string[] } } }),
      ),
    ).toContain('assignedTo must be an array');
    expect(
      validateProjectInvariants(record({ agentOwnership: { a1: { createdBy: 'u1', assignedTo: ['u2'] } } })),
    ).toBeNull();
  });

  // The shape the live probe used to erase a real project's role map through
  // the admin `PATCH config/roles` raw write (it now runs this same body via the
  // host-injected port). Both arms must fire: `owner` missing from `roles`, and
  // every member left pointing at a role that no longer exists.
  it('rejects an EMPTY role map and a map that drops owner', () => {
    expect(validateProjectInvariants(record({ roles: {} }))).toContain('must include owner');
    expect(
      validateProjectInvariants(
        record({
          roles: {
            admin: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: [], priority: 2 },
          },
        }),
      ),
    ).toContain('must include owner');
  });

  it('tolerates a record with no agentOwnership at all', () => {
    expect(validateProjectInvariants(record({ agentOwnership: undefined as never }))).toBeNull();
  });

  /**
   * THE ROLE-DELETION GUARANTEE, named as such.
   *
   * Owner ruling: **a role that has MEMBERS cannot be deleted; a member-less
   * role can.** Deliberate deletion stays possible — the caller reassigns the
   * members first. That is the whole rule, and this body already enforces it
   * through the `references unknown role` arm.
   *
   * The arm is otherwise only tested as "an unknown role reference", which
   * describes the SYMPTOM. Nothing named the guarantee, so a future cleanup
   * that folded it into a looser check would not know what it was breaking.
   * These seven shapes are the ruling; they belong here and NOT as a second
   * copy in `validateRolesPatchPriority` or the admin route's `patchProjectRoles`.
   *
   * The REASON changed with S1 (2026-08-22) even though the conclusion did not:
   * those two gates now walk the UNION of the stored and incoming maps, so they
   * do see deletion — they simply answer a different question (may THIS caller
   * remove that role?) from the one this body answers (would the RECORD still be
   * coherent?). A caller with every authority may still not strand a member. Two
   * questions, two bodies, one place each.
   */
  describe('role deletion — refuses a role a member holds, permits a member-less one', () => {
    const held = () => record({
      members: {
        'owner-1': { userId: 'owner-1', name: 'O', email: 'o@x', role: 'owner', position: '', tier: 1, addedAt: 'x' },
        'u-mgr': { userId: 'u-mgr', name: 'M', email: 'm@x', role: 'manager', position: '', tier: 10, addedAt: 'x' },
      },
      roles: {
        owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
        manager: { agents: '*', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 10 },
        member: { agents: '*', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 20 },
        viewer: { agents: '*', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 30 },
        custom: { agents: '*', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 25 },
      },
    });
    const without = (...names: string[]) => {
      const r = held();
      const roles = { ...r.roles } as Record<string, unknown>;
      for (const n of names) delete roles[n];
      return { ...r, roles } as ProjectRecord;
    };

    it('accepts the untouched baseline', () => {
      expect(validateProjectInvariants(held())).toBeNull();
    });

    it('REFUSES deleting `manager` — a member holds it', () => {
      expect(validateProjectInvariants(without('manager')))
        .toContain('references unknown role "manager"');
    });

    it('PERMITS deleting a member-less role — deliberate deletion is not blocked', () => {
      expect(validateProjectInvariants(without('viewer'))).toBeNull();
      expect(validateProjectInvariants(without('custom'))).toBeNull();
      expect(validateProjectInvariants(without('viewer', 'custom'))).toBeNull();
    });

    it('REFUSES a whole-map replacement that strands a member, however it is spelled', () => {
      // The live shape from the point-3 probe: everything but `owner`.
      expect(validateProjectInvariants(without('manager', 'member', 'viewer', 'custom')))
        .toContain('references unknown role "manager"');
      // And a partial one that happens to keep `member` but not `manager`.
      expect(validateProjectInvariants(without('manager', 'viewer', 'custom')))
        .toContain('references unknown role "manager"');
    });
  });
});
