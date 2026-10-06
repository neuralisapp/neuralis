/**
 * `GET /api/admin/users` — the roster is the caller's PROJECT, not the platform.
 * A project administrator sees their own project's members and finds anyone
 * else only by exact email; `platform.users` lists everyone. Each row's `can`
 * comes from the same record predicate the PATCH/DELETE routes enforce.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getUserById: vi.fn(),
  findUserByEmail: vi.fn(),
  listUsers: vi.fn(),
  listAllProjects: vi.fn(),
}));

vi.mock('@/server/auth/adminGuard', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('@/server/store/UserStore', () => ({
  getUserById: mocks.getUserById,
  findUserByEmail: mocks.findUserByEmail,
  listUsers: mocks.listUsers,
}));
vi.mock('@/server/store/ProjectStore', () => ({ listAllProjects: mocks.listAllProjects }));
vi.mock('@/server/admin/inviteUserToProject', () => ({ inviteUserToProject: vi.fn() }));

import { GET } from '../route';

const ROLES = {
  owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
  admin: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['project.members'], priority: 2 },
  member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 20 },
};

function project(id: string, members: Record<string, keyof typeof ROLES>) {
  return {
    id,
    name: id.toUpperCase(),
    ownerId: 'o',
    members: Object.fromEntries(Object.entries(members).map(([u, r]) => [u, { userId: u, role: r, position: '', tier: 1 }])),
    roles: ROLES,
  };
}

function user(id: string, status = 'active') {
  return { id, email: `${id}@x.co`, name: id, status, mustChangePassword: false, createdAt: '' };
}

const p1 = project('p1', { a: 'admin', m: 'member' });
const p2 = project('p2', { o: 'owner', m: 'member', z: 'member' });

function asCaller(role: keyof typeof ROLES) {
  mocks.requireAdmin.mockResolvedValue({
    user: { id: 'a', email: 'a@x.co' },
    project: p1,
    memberRole: ROLES[role],
    callerPriority: ROLES[role].priority,
  });
}

function req(query = '') {
  return new Request(`http://localhost/api/admin/users${query}`, { headers: { 'X-Project-Id': 'p1' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUserById.mockImplementation(async (id: string) => user(id));
  mocks.listUsers.mockResolvedValue([user('a'), user('m'), user('o'), user('z'), user('gone', 'deleted')]);
  mocks.listAllProjects.mockResolvedValue([p1, p2]);
});

describe('GET /api/admin/users', () => {
  it('a project admin sees ONLY their project\'s members', async () => {
    asCaller('admin');
    const body = (await (await GET(req())).json()) as { users: Array<{ id: string; projects: unknown[] }> };
    expect(body.users.map((u) => u.id).sort()).toEqual(['a', 'm']);
    expect(mocks.listUsers).not.toHaveBeenCalled();
    expect(body.users.every((u) => u.projects.length === 0)).toBe(true);
  });

  it('paired control: platform.users lists every live user, never a tombstone', async () => {
    asCaller('owner');
    const body = (await (await GET(req())).json()) as { users: Array<{ id: string }> };
    expect(body.users.map((u) => u.id).sort()).toEqual(['a', 'm', 'o', 'z']);
  });

  it('?email= is an exact lookup that reaches a user outside the project', async () => {
    asCaller('admin');
    mocks.findUserByEmail.mockResolvedValue(user('z'));
    const body = (await (await GET(req('?email=z%40x.co'))).json()) as { users: Array<{ id: string; isMember: boolean }> };
    expect(mocks.findUserByEmail).toHaveBeenCalledWith('z@x.co');
    expect(body.users).toEqual([expect.objectContaining({ id: 'z', isMember: false })]);
  });

  it('?email= outside the project names the user, never their account state', async () => {
    asCaller('admin');
    mocks.findUserByEmail.mockResolvedValue(user('z'));
    const body = (await (await GET(req('?email=z%40x.co'))).json()) as { users: Array<Record<string, unknown>> };
    expect(Object.keys(body.users[0]!).sort()).toEqual(['can', 'email', 'id', 'isMember', 'name']);
  });

  it('paired control: platform.users still sees the full row on a lookup', async () => {
    asCaller('owner');
    mocks.findUserByEmail.mockResolvedValue(user('z'));
    const body = (await (await GET(req('?email=z%40x.co'))).json()) as { users: Array<Record<string, unknown>> };
    expect(body.users[0]).toHaveProperty('status');
    expect(body.users[0]).toHaveProperty('lastLoginAt');
  });

  it('?email= never returns a tombstone', async () => {
    asCaller('admin');
    mocks.findUserByEmail.mockResolvedValue(user('gone', 'deleted'));
    const body = (await (await GET(req('?email=deleted%3Agone'))).json()) as { users: unknown[] };
    expect(body.users).toEqual([]);
  });

  it('`can` is the record predicate: a member also in a foreign project is not governable', async () => {
    asCaller('admin');
    const body = (await (await GET(req())).json()) as {
      users: Array<{ id: string; can: Record<string, boolean> }>;
    };
    const m = body.users.find((u) => u.id === 'm')!;
    const self = body.users.find((u) => u.id === 'a')!;
    expect(m.can).toEqual({ resetPassword: false, disable: false, enable: false, rename: false, delete: false });
    expect(self.can).toEqual({ resetPassword: false, disable: false, enable: false, rename: false, delete: false });
  });

  it('paired control: the same member living only in p1 is governable (delete still needs platform.users)', async () => {
    asCaller('admin');
    mocks.listAllProjects.mockResolvedValue([p1, project('p2', { o: 'owner', z: 'member' })]);
    const body = (await (await GET(req())).json()) as {
      users: Array<{ id: string; can: Record<string, boolean> }>;
    };
    expect(body.users.find((u) => u.id === 'm')!.can).toEqual({
      resetPassword: true, disable: true, enable: true, rename: true, delete: false,
    });
  });
});
