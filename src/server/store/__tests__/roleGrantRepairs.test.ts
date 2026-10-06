/**
 * partitioned-plover (role-grant version 18) — the `core.connectors` repair row.
 *
 * `core.connectors` now gates every MUTATING arm of `/connectors/*`; those arms
 * previously sat behind the module's `core.observe`, which is a VIEWER default.
 * Manifest `defaultRoleGrants` reach PROJECT CREATION (and a builtin's late
 * `pkg add`), never a changed grant of a package already there, and since v13 an
 * existing project's `admin` carries an ENUMERATED list — so without a repair
 * row naming `admin`, every existing project's admin would be locked out of a
 * plane it holds today.
 *
 * The claim under test is a DIFFERENCE: at v17 the row has not run and no role
 * holds the id; after the migration exactly one role does, and every other byte
 * of the record is where it was.
 */

import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLE_PRIORITY } from '@neuralis/package-system/access';
import { migrateProjectRecord } from '../ProjectStore';

/**
 * A record in the CURRENT shape (post-v13 enumerated `admin`, `limits.spend`),
 * stamped one version short of the row under test.
 *
 * Current shape matters: the structural normalizers above the version gate run
 * unconditionally, so a legacy-shaped fixture would rewrite members/limits and
 * the "nothing else changed" assertions would be measuring those instead.
 */
function projectAtV17(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p1',
    name: 'P1',
    ownerId: 'owner-1',
    members: {
      'owner-1': {
        userId: 'owner-1', name: 'O', email: 'o@x', role: 'owner',
        position: 'Owner', tier: BUILTIN_ROLE_PRIORITY.owner, addedAt: '2026-01-01',
      },
      'adm-1': {
        userId: 'adm-1', name: 'A', email: 'a@x', role: 'admin',
        position: '', tier: BUILTIN_ROLE_PRIORITY.admin, addedAt: '2026-01-01',
      },
    },
    roles: {
      owner: {
        agents: '*', canInvite: true, canManageRoles: true,
        grantedFeatures: ['*'], priority: BUILTIN_ROLE_PRIORITY.owner,
      },
      admin: {
        agents: '*', canInvite: true, canManageRoles: true,
        grantedFeatures: ['core.agents', 'core.observe', 'project.limits'],
        priority: BUILTIN_ROLE_PRIORITY.admin,
      },
      manager: {
        agents: '*', canInvite: false, canManageRoles: false,
        grantedFeatures: ['core.agents', 'core.observe'],
        priority: BUILTIN_ROLE_PRIORITY.manager,
      },
      member: {
        agents: 'own', canInvite: false, canManageRoles: false,
        grantedFeatures: ['core.agents', 'core.observe'],
        priority: BUILTIN_ROLE_PRIORITY.member,
      },
      viewer: {
        agents: 'view', canInvite: false, canManageRoles: false,
        grantedFeatures: ['core.agents', 'core.observe'],
        priority: BUILTIN_ROLE_PRIORITY.viewer,
      },
    },
    agentOwnership: {},
    limits: { spend: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} } },
    roleGrantVersion: 17,
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...over,
  };
}

describe('v18 — core.connectors reaches the enumerated admin', () => {
  it('grants the id to admin and leaves every other role byte-identical', () => {
    const before = projectAtV17();
    const snapshot = structuredClone(before) as unknown as ReturnType<typeof migrateProjectRecord>;

    // The control half of the difference: at v17 nobody holds it.
    for (const role of Object.keys(snapshot.roles)) {
      expect(snapshot.roles[role]!.grantedFeatures).not.toContain('core.connectors');
    }

    const r = migrateProjectRecord(before);
    expect(r.roleGrantVersion).toBe(19);
    expect(r.roles.admin!.grantedFeatures).toContain('core.connectors');

    // The admin row differs by that ONE id and nothing else — order preserved,
    // no other grant added or dropped, no flag or priority touched.
    expect(r.roles.admin!.grantedFeatures.filter((f) => f !== 'core.connectors'))
      .toEqual(snapshot.roles.admin!.grantedFeatures);
    expect({ ...r.roles.admin!, grantedFeatures: [] })
      .toEqual({ ...snapshot.roles.admin!, grantedFeatures: [] });

    // Every other role is untouched — above all `viewer`, whose `core.observe`
    // used to be the whole gate on the mutating arms.
    for (const role of ['owner', 'manager', 'member', 'viewer'] as const) {
      expect(r.roles[role]).toEqual(snapshot.roles[role]);
      expect(r.roles[role]!.grantedFeatures).not.toContain('core.connectors');
    }

    // And nothing outside the role map moved.
    expect(r.members).toEqual(snapshot.members);
    expect(r.limits).toEqual(snapshot.limits);
    expect(r.agentOwnership).toEqual(snapshot.agentOwnership);
  });

  it('skips a `*` holder — a wildcard already covers the id, so no literal row is added', () => {
    // A legacy-shaped `admin` that still carries the wildcard (v13 de-wildcards
    // it, but a hand-edited record can hold it at any version). The applier's
    // guard is the WILDCARD, not the role name: writing `core.connectors` next
    // to `'*'` would turn an apex grant into a list that later reads as
    // enumerated.
    const before = projectAtV17({
      roles: {
        ...(projectAtV17().roles as Record<string, unknown>),
        admin: {
          agents: '*', canInvite: true, canManageRoles: true,
          grantedFeatures: ['*'], priority: BUILTIN_ROLE_PRIORITY.admin,
        },
      },
    });
    const r = migrateProjectRecord(before);

    expect(r.roleGrantVersion).toBe(19);
    expect(r.roles.admin!.grantedFeatures).toEqual(['*']);
    expect(r.roles.owner!.grantedFeatures).toEqual(['*']);
  });

  it('is idempotent — a second run is byte-identical and adds no duplicate', () => {
    const once = migrateProjectRecord(projectAtV17());
    const snapshot = JSON.stringify(once);

    const twice = migrateProjectRecord(JSON.parse(snapshot) as Record<string, unknown>);

    expect(JSON.stringify(twice)).toBe(snapshot);
    expect(twice.roleGrantVersion).toBe(19);
    expect(twice.roles.admin!.grantedFeatures.filter((f) => f === 'core.connectors'))
      .toHaveLength(1);
  });

  it('an already-v18 record gains nothing — the version gate, not the value, is what stops it', () => {
    // Proves the repair is version-keyed: an admin that legitimately had the id
    // REVOKED at v18 must not have it handed back on the next boot.
    const revoked = projectAtV17({ roleGrantVersion: 18 });
    const r = migrateProjectRecord(revoked);

    expect(r.roleGrantVersion).toBe(19);
    expect(r.roles.admin!.grantedFeatures).not.toContain('core.connectors');
  });
});
