/**
 * The project record as the store reads it: an UNSEEDED record (the one setup
 * writes) is seeded once through the ONE `seedRolesForNewProject`, and nothing
 * else is converted on read — no version-keyed replay, no legacy shape. A
 * role-grant change after version 19 ships as an offline upgrade module.
 *
 * The fresh-install record is pinned through the REAL setup builder in
 * `scripts/__tests__/setupIdempotence.test.mts` ("ACTUALLY heals"); this file
 * pins the literal record 0.1.0's setup wrote, so a later setup change can
 * never silently strand an installed 0.1.0 first project.
 */

import { describe, expect, it, vi } from 'vitest';
import { migrateProjectRecord, DEFAULT_ROLES } from '../ProjectStore';
import { DEFAULT_SPEND_LIMITS } from '../projectTypes';

/** The first project exactly as 0.1.0's `buildProjectRecord` wrote it. */
const RELEASE_0_1_0_FIRST_PROJECT = {
  id: 'acme',
  name: 'Acme',
  ownerId: 'user-1',
  members: {
    'user-1': { userId: 'user-1', name: 'Owner', email: 'o@example.com', role: 'owner', position: 'Owner', tier: 1, addedAt: '2026-10-06T00:00:00.000Z' },
  },
  roles: {},
  createdAt: '2026-10-06T00:00:00.000Z',
  updatedAt: '2026-10-06T00:00:00.000Z',
};

const sortGrants = (role: { grantedFeatures: string[] }) => ({ ...role, grantedFeatures: [...role.grantedFeatures].sort() });

/** Run `fn` with the module-load admin union replaced in place, then restore it. */
function withAdminUnion(next: string[], fn: () => void): void {
  const real = [...DEFAULT_ROLES.admin.grantedFeatures];
  DEFAULT_ROLES.admin.grantedFeatures.length = 0;
  DEFAULT_ROLES.admin.grantedFeatures.push(...next);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    fn();
  } finally {
    warn.mockRestore();
    DEFAULT_ROLES.admin.grantedFeatures.length = 0;
    DEFAULT_ROLES.admin.grantedFeatures.push(...real);
  }
}

describe('migrateProjectRecord — the first read seeds an unseeded record, and converts nothing', () => {
  for (const [label, record] of [
    ['a 0.1.0 install (its setup-written first project, `roles: {}`)', () => structuredClone(RELEASE_0_1_0_FIRST_PROJECT) as Record<string, unknown>],
    ['a record with NO `roles` key at all', () => { const { roles: _absent, ...rest } = structuredClone(RELEASE_0_1_0_FIRST_PROJECT); return rest as Record<string, unknown>; }],
  ] as const) {
    it(`${label} is seeded with the canonical roles at the current role-grant version`, () => {
      const seeded = migrateProjectRecord(JSON.parse(JSON.stringify(record())));
      expect(seeded.roleGrantVersion).toBe(19);
      expect(Object.keys(seeded.roles).sort()).toEqual(Object.keys(DEFAULT_ROLES).sort());
      for (const [name, definition] of Object.entries(DEFAULT_ROLES)) {
        expect(sortGrants(seeded.roles[name]!), `${name} is the canonical definition`).toEqual(sortGrants(definition));
      }
      expect(seeded.agentOwnership).toEqual({});
      expect(seeded.limits).toEqual({ spend: DEFAULT_SPEND_LIMITS });
      expect(seeded.members['user-1']).toMatchObject({ role: 'owner', tier: 1 });
      // Idempotent: the seeded record is current, a second read changes nothing.
      const snapshot = JSON.stringify(seeded);
      expect(JSON.stringify(migrateProjectRecord(JSON.parse(snapshot)))).toBe(snapshot);
    });
  }

  it('RED-FIRST: a degenerate admin union seeds NOTHING — the empty map grants nothing and the version stays absent', () => {
    withAdminUnion([], () => {
      const r = migrateProjectRecord(JSON.parse(JSON.stringify(RELEASE_0_1_0_FIRST_PROJECT)));
      expect(r.roles).toEqual({});
      expect(r.roleGrantVersion).toBeUndefined();
    });
    // PAIRED CONTROL — the same record with the healthy union seeds.
    expect(migrateProjectRecord(JSON.parse(JSON.stringify(RELEASE_0_1_0_FIRST_PROJECT))).roleGrantVersion).toBe(19);
  });

  it('never mutates the module-level DEFAULT_ROLES seed', () => {
    const before = JSON.stringify(DEFAULT_ROLES);
    const seeded = migrateProjectRecord(JSON.parse(JSON.stringify(RELEASE_0_1_0_FIRST_PROJECT)));
    migrateProjectRecord(seeded as unknown as Record<string, unknown>);
    expect(JSON.stringify(DEFAULT_ROLES)).toBe(before);
  });

  it('NO replay: a record stamped below 19 keeps exactly what it holds — no rename, repair or revoke runs on read', () => {
    const below = {
      ...structuredClone(RELEASE_0_1_0_FIRST_PROJECT),
      roles: { owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
        member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: ['core.execute', 'core.shell.container'], priority: 20 } },
      roleGrantVersion: 18,
      agentOwnership: {},
      limits: { spend: structuredClone(DEFAULT_SPEND_LIMITS) },
    };
    const snapshot = JSON.stringify(below);
    expect(JSON.stringify(migrateProjectRecord(structuredClone(below)))).toBe(snapshot);
  });

  it('a record stamped by a NEWER build is served as read, its version untouched', () => {
    const newer = { ...structuredClone(RELEASE_0_1_0_FIRST_PROJECT), roleGrantVersion: 99, roles: { owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 } } };
    expect(migrateProjectRecord(structuredClone(newer)).roleGrantVersion).toBe(99);
  });
});
