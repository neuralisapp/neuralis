/**
 * The platform USER record is shared by every project its user belongs to, so
 * the five record verbs (reset password · disable · enable · rename · delete)
 * are decided over ALL of those projects — never by the one project a request
 * names.
 *
 * Every deny row is paired with `namedProjectOnly`, the rule the route applied
 * before: `canInvite` in the named project, and a strength check only on
 * `disable` and `delete` and only when the target was a member THERE. Each deny
 * row asserts that shape ALLOWED the same call, so the matrix proves the
 * narrowing rather than restating it.
 */

import { describe, expect, it } from 'vitest';
import { canAssignRole, rolePriority } from '@neuralis/package-system/access';
import {
  canGovernUserRecord,
  diffMemberMaps,
  leavesProjectWithoutActiveOwner,
  type UserRecordVerb,
} from '../access';
import type { ProjectRecord } from '../../store/projectTypes';

const ROLES = {
  owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
  admin: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['project.members'], priority: 2 },
  member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 20 },
} as const;

function project(
  id: string,
  members: Record<string, keyof typeof ROLES>,
  over: Partial<ProjectRecord> = {},
): ProjectRecord {
  return {
    id,
    name: id.toUpperCase(),
    ownerId: 'o',
    members: Object.fromEntries(
      Object.entries(members).map(([userId, role]) => [
        userId,
        { userId, name: userId, email: `${userId}@x.co`, role, position: '', tier: ROLES[role].priority, addedAt: '' },
      ]),
    ),
    roles: ROLES as unknown as ProjectRecord['roles'],
    agentOwnership: {},
    ...over,
  } as ProjectRecord;
}

/** The pre-change rule, evaluated in the named project only. */
function namedProjectOnly(verb: UserRecordVerb, named: ProjectRecord, callerId: string, targetId: string, platformUsers: boolean): boolean {
  const caller = named.members[callerId];
  const callerRole = caller ? named.roles[caller.role] : undefined;
  if (!caller || !callerRole) return false;
  if (verb === 'delete') {
    if (!platformUsers || callerId === targetId) return false;
  } else if (!callerRole.canInvite) {
    return false;
  }
  if (verb === 'enable' || verb === 'rename' || verb === 'reset_password') return true;
  if (verb === 'disable' && callerId === targetId) return false;
  const target = named.members[targetId];
  if (!target) return true;
  return canAssignRole({
    callerPriority: rolePriority(caller.role, callerRole.priority),
    targetPriority: rolePriority(target.role, named.roles[target.role]?.priority),
  }).allowed;
}

const VERBS: UserRecordVerb[] = ['reset_password', 'disable', 'enable', 'rename', 'delete'];

function govern(verb: UserRecordVerb, projects: ProjectRecord[], callerId: string, targetId: string, platformUsers: boolean): boolean {
  return canGovernUserRecord({ callerId, targetId, projects, verb, callerHoldsPlatformUsers: platformUsers });
}

describe('canGovernUserRecord — verbs × caller shapes', () => {
  it.each(VERBS)('%s: a caller who governs the target in EVERY project may act', (verb) => {
    const projects = [project('p1', { c: 'owner', t: 'member' }), project('p2', { c: 'admin', t: 'member' })];
    expect(govern(verb, projects, 'c', 't', true)).toBe(true);
  });

  it.each(VERBS)('%s: a member of ONE of the target\'s two projects is refused (old shape allowed)', (verb) => {
    const p1 = project('p1', { c: 'owner', t: 'member' });
    const p2 = project('p2', { o: 'owner', t: 'member' });
    expect(govern(verb, [p1, p2], 'c', 't', true)).toBe(false);
    expect(namedProjectOnly(verb, p1, 'c', 't', true)).toBe(true);
  });

  it.each(['reset_password', 'enable', 'rename'] as const)(
    '%s: a caller WEAKER than the target is refused (old shape allowed)',
    (verb) => {
      const p1 = project('p1', { c: 'admin', t: 'owner' });
      expect(govern(verb, [p1], 'c', 't', false)).toBe(false);
      expect(namedProjectOnly(verb, p1, 'c', 't', false)).toBe(true);
    },
  );

  it.each(['disable', 'delete'] as const)('%s: a caller WEAKER than the target is refused', (verb) => {
    const p1 = project('p1', { c: 'admin', t: 'owner' });
    expect(govern(verb, [p1], 'c', 't', true)).toBe(false);
  });

  it.each(['reset_password', 'disable', 'enable', 'rename'] as const)(
    '%s: a target in NO project needs platform.users (old shape allowed any canInvite holder)',
    (verb) => {
      const p1 = project('p1', { c: 'admin' });
      expect(govern(verb, [p1], 'c', 't', false)).toBe(false);
      expect(namedProjectOnly(verb, p1, 'c', 't', false)).toBe(true);
      expect(govern(verb, [p1], 'c', 't', true)).toBe(true);
    },
  );

  it('delete always needs platform.users, even over a target the caller governs everywhere', () => {
    const projects = [project('p1', { c: 'owner', t: 'member' })];
    expect(govern('delete', projects, 'c', 't', false)).toBe(false);
    expect(govern('delete', projects, 'c', 't', true)).toBe(true);
  });

  it.each(VERBS)('%s: never on your own record (enable-self included)', (verb) => {
    const projects = [project('p1', { c: 'owner' })];
    expect(govern(verb, projects, 'c', 'c', true)).toBe(false);
  });

  it('enable-self was ALLOWED by the old shape — the self-restore row', () => {
    const p1 = project('p1', { c: 'admin' });
    expect(namedProjectOnly('enable', p1, 'c', 'c', false)).toBe(true);
    expect(govern('enable', [p1], 'c', 'c', false)).toBe(false);
  });

  it('an ARCHIVED project still counts — its membership revives on restore', () => {
    const p1 = project('p1', { c: 'owner', t: 'member' });
    const archived = project('p9', { o: 'owner', t: 'member' }, { archivedAt: '2026-01-01T00:00:00.000Z' });
    expect(govern('reset_password', [p1, archived], 'c', 't', true)).toBe(false);
    expect(govern('reset_password', [p1], 'c', 't', true)).toBe(true);
  });

  it('a caller without canInvite in a target project is refused there', () => {
    const projects = [project('p1', { c: 'owner', t: 'member' }), project('p2', { c: 'member', t: 'member' })];
    expect(govern('disable', projects, 'c', 't', true)).toBe(false);
  });

  it('a caller whose role definition is missing is refused — never read as a system session', () => {
    const p1 = project('p1', { c: 'owner', t: 'member' });
    p1.members.c = { ...p1.members.c!, role: 'ghost' };
    expect(govern('reset_password', [p1], 'c', 't', true)).toBe(false);
  });

  it('peers govern each other (canAssignRole allows an equal priority)', () => {
    const projects = [project('p1', { c: 'admin', t: 'admin' })];
    expect(govern('reset_password', projects, 'c', 't', false)).toBe(true);
  });
});

describe('leavesProjectWithoutActiveOwner', () => {
  const p1 = project('p1', { t: 'owner', c: 'owner', m: 'member' });
  const p2 = project('p2', { t: 'owner', m: 'member' });
  const p3 = project('p3', { t: 'member', c: 'owner' });

  it('names the projects where the target is the last ACTIVE owner-strength member', () => {
    expect(leavesProjectWithoutActiveOwner('t', [p1, p2, p3], new Set(['c', 'm', 't'])).map((p) => p.id)).toEqual(['p2']);
  });

  it('a co-owner who is not active does not count', () => {
    expect(leavesProjectWithoutActiveOwner('t', [p1], new Set(['m', 't'])).map((p) => p.id)).toEqual(['p1']);
  });

  it('a target that is not owner-strength blocks nothing', () => {
    expect(leavesProjectWithoutActiveOwner('m', [p1, p2], new Set())).toEqual([]);
  });
});

describe('diffMemberMaps', () => {
  it('reports added, removed and re-roled members', () => {
    const before = project('p', { a: 'member', b: 'member' }).members;
    const after = project('p', { a: 'admin', c: 'member' }).members;
    expect(diffMemberMaps(before, after)).toEqual({
      added: ['c'],
      removed: ['b'],
      roleChanged: [{ userId: 'a', from: 'member', to: 'admin' }],
    });
  });

  it('is null when nothing about membership changed', () => {
    const members = project('p', { a: 'member' }).members;
    expect(diffMemberMaps(members, { ...members, a: { ...members.a!, name: 'renamed' } })).toBeNull();
  });
});
