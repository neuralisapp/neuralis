/**
 * The user-record routes wire the ONE record predicate (`canGovernUserRecord`,
 * real here) over EVERY project, archived included — and the lifecycle body
 * (`offboardUser.ts`, a double here; its own suite runs it on real stores).
 *
 * Every refusal row has a paired control that differs in exactly the fact the
 * rule turns on, so a route that stopped consulting the predicate — or read only
 * the named project again — turns a row red.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  requireAdmin: vi.fn(),
  requireProjectFeature: vi.fn(),
  getUserById: vi.fn(),
  updateUser: vi.fn(),
  listAllProjects: vi.fn(),
  updateProject: vi.fn(),
  writeAuditLog: vi.fn(),
  disableUser: vi.fn(),
  enableUser: vi.fn(),
  resetUserPassword: vi.fn(),
  checkDisableFloor: vi.fn(),
  offboardUser: vi.fn(),
  preflightOffboard: vi.fn(),
}));

vi.mock('@/server/auth/session', () => ({ requireSession: mocks.requireSession }));
vi.mock('@/server/auth/adminGuard', () => ({
  requireAdmin: mocks.requireAdmin,
  requireProjectFeature: mocks.requireProjectFeature,
}));
vi.mock('@/server/store/UserStore', () => ({
  getUserById: mocks.getUserById,
  updateUser: mocks.updateUser,
}));
vi.mock('@/server/store/ProjectStore', () => ({
  listAllProjects: mocks.listAllProjects,
  updateProject: mocks.updateProject,
}));
vi.mock('@/server/store/AuditStore', () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock('@/server/admin/offboardUser', () => ({
  disableUser: mocks.disableUser,
  enableUser: mocks.enableUser,
  resetUserPassword: mocks.resetUserPassword,
  checkDisableFloor: mocks.checkDisableFloor,
  offboardUser: mocks.offboardUser,
  preflightOffboard: mocks.preflightOffboard,
}));

import { DELETE, GET, PATCH } from '../[id]/route';

const ROLES = {
  owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
  admin: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['project.members'], priority: 2 },
  member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 20 },
};

type RoleName = keyof typeof ROLES;

function project(id: string, members: Record<string, RoleName>, over: Record<string, unknown> = {}) {
  return {
    id,
    name: id.toUpperCase(),
    ownerId: 'o',
    members: Object.fromEntries(
      Object.entries(members).map(([u, r]) => [u, { userId: u, name: u, email: `${u}@x.co`, role: r, position: '', tier: ROLES[r].priority, addedAt: '' }]),
    ),
    roles: ROLES,
    agentOwnership: {},
    ...over,
  };
}

/** The caller `c`, resolved by the guard in the named project `p1`. */
function guard(role: RoleName, named = project('p1', { c: role })) {
  const ctx = {
    user: { id: 'c', email: 'c@x.co', name: 'C' },
    project: named,
    member: named.members.c,
    memberRole: ROLES[role],
    callerPriority: ROLES[role].priority,
  };
  mocks.requireAdmin.mockResolvedValue(ctx);
  mocks.requireProjectFeature.mockResolvedValue(ctx);
  return ctx;
}

function req(method: string, body?: unknown, header = 'p1') {
  const headers = new Headers({ 'X-Project-Id': header });
  return new Request('http://localhost/api/admin/users/t', {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const params = { params: Promise.resolve({ id: 't' }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue({ id: 'c', email: 'c@x.co', name: 'C' });
  mocks.getUserById.mockResolvedValue({ id: 't', email: 't@x.co', name: 'T', status: 'active' });
  mocks.checkDisableFloor.mockResolvedValue(null);
  mocks.resetUserPassword.mockResolvedValue('temp-pass');
  mocks.disableUser.mockResolvedValue(true);
  mocks.enableUser.mockResolvedValue(true);
});

describe('PATCH record verbs — the caller must govern the target in EVERY project', () => {
  const verbs: Array<[string, Record<string, unknown>]> = [
    ['reset', { resetPassword: true }],
    ['disable', { status: 'disabled' }],
    ['enable', { status: 'active' }],
    ['rename', { name: 'New Name' }],
  ];

  it.each(verbs)('%s: target in p1 AND p2, caller only in p1 ⇒ 403, nothing written', async (_verb, body) => {
    const p1 = project('p1', { c: 'owner', t: 'member' });
    guard('owner', p1);
    mocks.listAllProjects.mockResolvedValue([p1, project('p2', { o: 'owner', t: 'member' })]);
    const res = await PATCH(req('PATCH', body), params);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden: insufficient permissions' });
    expect(mocks.resetUserPassword).not.toHaveBeenCalled();
    expect(mocks.disableUser).not.toHaveBeenCalled();
    expect(mocks.enableUser).not.toHaveBeenCalled();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it.each(verbs)('%s: paired control — the target lives only in p1 ⇒ 200', async (_verb, body) => {
    const p1 = project('p1', { c: 'owner', t: 'member' });
    guard('owner', p1);
    mocks.listAllProjects.mockResolvedValue([p1, project('p2', { o: 'owner' })]);
    const res = await PATCH(req('PATCH', body), params);
    expect(res.status).toBe(200);
  });

  it('reset returns the temporary password through the lifecycle body', async () => {
    const p1 = project('p1', { c: 'admin', t: 'member' });
    guard('admin', p1);
    mocks.listAllProjects.mockResolvedValue([p1]);
    const res = await PATCH(req('PATCH', { resetPassword: true }), params);
    expect(await res.json()).toEqual({ ok: true, tempPassword: 'temp-pass' });
    expect(mocks.resetUserPassword).toHaveBeenCalledWith('t', { kind: 'user', userId: 'c', email: 'c@x.co' });
  });

  it.each(verbs)('%s: a caller WEAKER than the target ⇒ 403', async (_verb, body) => {
    const p1 = project('p1', { c: 'admin', t: 'owner' });
    guard('admin', p1);
    mocks.listAllProjects.mockResolvedValue([p1]);
    expect((await PATCH(req('PATCH', body), params)).status).toBe(403);
  });

  it.each(verbs)('%s: a target in NO project, caller without platform.users ⇒ 403', async (_verb, body) => {
    guard('admin');
    mocks.listAllProjects.mockResolvedValue([project('p1', { c: 'admin' })]);
    expect((await PATCH(req('PATCH', body), params)).status).toBe(403);
  });

  it.each(verbs)('%s: paired control — the same target, caller WITH platform.users (`*`) ⇒ 200', async (_verb, body) => {
    guard('owner');
    mocks.listAllProjects.mockResolvedValue([project('p1', { c: 'owner' })]);
    expect((await PATCH(req('PATCH', body), params)).status).toBe(200);
  });

  it('an ARCHIVED project the caller is not in still refuses', async () => {
    const p1 = project('p1', { c: 'owner', t: 'member' });
    guard('owner', p1);
    mocks.listAllProjects.mockResolvedValue([p1, project('p9', { o: 'owner', t: 'member' }, { archivedAt: '2026-01-01' })]);
    expect((await PATCH(req('PATCH', { resetPassword: true }), params)).status).toBe(403);
    expect(mocks.listAllProjects).toHaveBeenCalledWith({ includeArchived: true });
  });

  it('enable-SELF is refused (a disabled account cannot restore itself)', async () => {
    mocks.getUserById.mockResolvedValue({ id: 'c', email: 'c@x.co', name: 'C', status: 'disabled' });
    guard('owner');
    mocks.listAllProjects.mockResolvedValue([project('p1', { c: 'owner' })]);
    const self = { params: Promise.resolve({ id: 'c' }) };
    expect((await PATCH(req('PATCH', { status: 'active' }), self)).status).toBe(403);
    expect(mocks.enableUser).not.toHaveBeenCalled();
  });

  it('disable of the last active owner ⇒ 409 carrying the refusal', async () => {
    const p1 = project('p1', { c: 'owner', t: 'owner' });
    guard('owner', p1);
    mocks.listAllProjects.mockResolvedValue([p1]);
    const refusal = { blocking: [{ projectId: 'p1', name: 'P1', reason: 'last_active_owner' }], hiddenBlockingCount: 2 };
    mocks.checkDisableFloor.mockResolvedValue(refusal);
    const res = await PATCH(req('PATCH', { status: 'disabled' }), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject(refusal);
    expect(mocks.disableUser).not.toHaveBeenCalled();
  });

  it('a deleted (tombstoned) target is 404', async () => {
    mocks.getUserById.mockResolvedValue({ id: 't', email: 'deleted:t', status: 'deleted' });
    guard('owner');
    expect((await PATCH(req('PATCH', { resetPassword: true }), params)).status).toBe(404);
  });

  it('a guard refusal is the same 403 whether the project exists or not (no 400 oracle)', async () => {
    mocks.requireAdmin.mockRejectedValue(new Error('Not a project member'));
    const res = await PATCH(req('PATCH', { resetPassword: true }), params);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden: insufficient permissions' });
  });
});

describe('PATCH role — project-scoped, audited', () => {
  it('re-roles the member in the named project and audits the membership change', async () => {
    const p1 = project('p1', { c: 'owner', t: 'member' });
    guard('owner', p1);
    mocks.updateProject.mockImplementation(async (_id: string, producer: (p: unknown) => unknown) => {
      const patch = producer(p1) as { members: unknown } | null;
      return patch ? { ...p1, ...patch } : p1;
    });
    const res = await PATCH(req('PATCH', { role: 'admin' }), params);
    expect(res.status).toBe(200);
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'project.update',
      target: 'p1',
      details: { members: { added: [], removed: [], roleChanged: [{ userId: 't', from: 'member', to: 'admin' }] } },
    }));
  });
});

describe('DELETE / GET preflight', () => {
  it('delete runs the offboarding when the caller governs every project', async () => {
    const p1 = project('p1', { c: 'owner', t: 'member' });
    guard('owner', p1);
    mocks.listAllProjects.mockResolvedValue([p1]);
    mocks.offboardUser.mockResolvedValue({ ok: true, counts: { memberships: 1, assignments: 0, credentials: 2 } });
    const res = await DELETE(req('DELETE'), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, counts: { memberships: 1, assignments: 0, credentials: 2 } });
    expect(mocks.offboardUser).toHaveBeenCalledWith({ caller: { userId: 'c', email: 'c@x.co' }, targetId: 't', projects: [p1] });
  });

  it('delete across a project the caller is not in ⇒ 403, the offboarding never runs', async () => {
    const p1 = project('p1', { c: 'owner', t: 'member' });
    guard('owner', p1);
    mocks.listAllProjects.mockResolvedValue([p1, project('p2', { o: 'owner', t: 'member' })]);
    expect((await DELETE(req('DELETE'), params)).status).toBe(403);
    expect(mocks.offboardUser).not.toHaveBeenCalled();
  });

  it('a blocked delete ⇒ 409 with the visible projects and the hidden count', async () => {
    const p1 = project('p1', { c: 'owner', t: 'owner' });
    guard('owner', p1);
    mocks.listAllProjects.mockResolvedValue([p1]);
    mocks.offboardUser.mockResolvedValue({
      ok: false,
      code: 'blocked',
      blocking: [{ projectId: 'p1', name: 'P1', reason: 'provenance_owner' }],
      hiddenBlockingCount: 0,
    });
    const res = await DELETE(req('DELETE'), params);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ blocking: [{ projectId: 'p1', reason: 'provenance_owner' }], hiddenBlockingCount: 0 });
  });

  it('self-delete stays 400 before any listing', async () => {
    guard('owner');
    const self = { params: Promise.resolve({ id: 'c' }) };
    expect((await DELETE(req('DELETE'), self)).status).toBe(400);
    expect(mocks.listAllProjects).not.toHaveBeenCalled();
  });

  it('GET is the preflight, behind the same gate', async () => {
    const p1 = project('p1', { c: 'owner', t: 'member' });
    guard('owner', p1);
    mocks.listAllProjects.mockResolvedValue([p1]);
    const preflight = { blocking: [], hiddenBlockingCount: 0, memberships: 1, credentialIds: ['llm.openai'] };
    mocks.preflightOffboard.mockResolvedValue(preflight);
    const res = await GET(req('GET'), params);
    expect(await res.json()).toEqual({ preflight });
    expect(mocks.requireProjectFeature).toHaveBeenCalledWith('p1', 'platform.users');
  });

  it('GET preflight across a foreign project ⇒ 403 (paired with the row above)', async () => {
    const p1 = project('p1', { c: 'owner', t: 'member' });
    guard('owner', p1);
    mocks.listAllProjects.mockResolvedValue([p1, project('p2', { o: 'owner', t: 'member' })]);
    expect((await GET(req('GET'), params)).status).toBe(403);
    expect(mocks.preflightOffboard).not.toHaveBeenCalled();
  });
});
