/**
 * `canGovernUserLive` — the kernel `HostMembersPort.canGovernUser` read — is
 * the host's ONE `canGovernUserRecord` with both inputs derived LIVE: every
 * project (archived included) and `platform.users` read from the caller's
 * membership in the NAMED project. Parity is asserted against the pure
 * predicate over a fixture matrix; a caller the member chain refuses in that
 * project answers `false` without the record set being read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectRecord } from '../../store/projectTypes';

const store = vi.hoisted(() => ({ projects: [] as unknown[], listCalls: [] as unknown[] }));
vi.mock('../../store/ProjectStore', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listAllProjects: vi.fn(async (opts: unknown) => { store.listCalls.push(opts); return store.projects; }),
}));
vi.mock('../../auth/memberSession', () => ({
  resolveMember: vi.fn(async (userId: string, projectId: string) => {
    const project = (store.projects as ProjectRecord[]).find((p) => p.id === projectId && !p.archivedAt);
    const member = project?.members[userId];
    if (!project || !member) return null;
    return { session: { userId, projectId, grantedFeatures: [...project.roles[member.role]!.grantedFeatures] } };
  }),
}));

import { canGovernUserLive, canGovernUserRecord } from '../access';
import { hasFeature } from '@neuralis/package-system/access';

const ROLES = {
  owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
  admin: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['project.members'], priority: 2 },
  platformAdmin: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['platform.users'], priority: 2 },
  member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 20 },
} as const;

function project(id: string, members: Record<string, keyof typeof ROLES>, archived = false): ProjectRecord {
  return {
    id, name: id, ownerId: 'o',
    members: Object.fromEntries(Object.entries(members).map(([userId, role]) => [userId, { userId, name: userId, email: '', role, position: '', tier: 0, addedAt: '' }])),
    roles: ROLES as unknown as ProjectRecord['roles'],
    agentOwnership: {},
    ...(archived ? { archivedAt: 't' } : {}),
  } as ProjectRecord;
}

beforeEach(() => {
  store.listCalls.length = 0;
  store.projects = [
    project('p1', { boss: 'owner', adm: 'admin', padm: 'platformAdmin', m1: 'member', m2: 'member' }),
    project('p2', { boss: 'owner', m2: 'member', peer: 'admin' }),
    project('p-arch', { adm: 'member', m1: 'admin' }, true),
  ];
});

describe('canGovernUserLive = canGovernUserRecord over the live inputs', () => {
  it('parity on the matrix (callers × targets, in the named project)', async () => {
    const users = ['boss', 'adm', 'padm', 'm1', 'm2', 'peer', 'loner'];
    for (const caller of users) {
      for (const target of users) {
        const callerRow = (store.projects as ProjectRecord[]).find((p) => p.id === 'p1')!.members[caller];
        const live = await canGovernUserLive(caller, 'p1', target, 'disable');
        const expected = callerRow
          ? canGovernUserRecord({
              callerId: caller, targetId: target, projects: store.projects as ProjectRecord[], verb: 'disable',
              callerHoldsPlatformUsers: hasFeature({ grantedFeatures: [...ROLES[callerRow.role as keyof typeof ROLES].grantedFeatures] }, 'platform.users'),
            })
          : false;
        expect([caller, target, live]).toEqual([caller, target, expected]);
      }
    }
    // The record set is EVERY project, archived included.
    expect(store.listCalls.every((o) => JSON.stringify(o) === JSON.stringify({ includeArchived: true }))).toBe(true);
  });

  it('the decisive rows: an archived membership counts; a target in no project needs platform.users; a non-member caller is refused unread', async () => {
    // m1 is an ADMIN in the archived project, so `adm` (a member there) cannot disable m1.
    expect(await canGovernUserLive('adm', 'p1', 'm1', 'disable')).toBe(false);
    expect(await canGovernUserLive('boss', 'p1', 'm1', 'disable')).toBe(false); // boss is not in p-arch
    expect(await canGovernUserLive('adm', 'p1', 'loner', 'disable')).toBe(false);
    expect(await canGovernUserLive('padm', 'p1', 'loner', 'disable')).toBe(true);
    store.listCalls.length = 0;
    expect(await canGovernUserLive('loner', 'p1', 'm2', 'disable')).toBe(false);
    expect(store.listCalls).toEqual([]);
  });
});
