/**
 * N4 — the self-service branches of `PATCH /api/admin/users/[id]` must stay
 * ABOVE the project guard.
 *
 * `neuralis/src/api/admin.ts changeOwnPassword` (the workspace
 * PasswordChangeModal) posts `{ currentPassword, newPassword }` with NO project
 * anywhere — no `X-Project-Id` header, no body `projectId`. Making the project
 * required for the ADMIN operations must never reach these two branches, or
 * every member is locked out of changing their own password.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  requireAdmin: vi.fn(),
  getUserById: vi.fn(),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
  updateProject: vi.fn(),
  writeAuditLog: vi.fn(),
  compare: vi.fn(),
  hash: vi.fn(),
  listAllProjects: vi.fn(),
  disableUser: vi.fn(),
  checkDisableFloor: vi.fn(),
}));

vi.mock('@/server/auth/adminGuard', () => ({
  requireAdmin: mocks.requireAdmin,
}));
vi.mock('@/server/auth/session', () => ({ requireSession: mocks.requireSession }));
vi.mock('@/server/store/UserStore', () => ({
  getUserById: mocks.getUserById,
  updateUser: mocks.updateUser,
  deleteUser: mocks.deleteUser,
}));
vi.mock('@/server/store/ProjectStore', () => ({
  updateProject: mocks.updateProject,
  listAllProjects: mocks.listAllProjects,
}));
vi.mock('@/server/admin/offboardUser', () => ({
  disableUser: mocks.disableUser,
  checkDisableFloor: mocks.checkDisableFloor,
}));
vi.mock('@/server/store/AuditStore', () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock('bcryptjs', () => ({
  default: { compare: mocks.compare, hash: mocks.hash },
}));

import { PATCH } from '../[id]/route';

function patchRequest(body: unknown, projectIdHeader?: string) {
  const headers = new Headers();
  if (projectIdHeader) headers.set('X-Project-Id', projectIdHeader);
  return new Request('http://localhost/api/admin/users/u1', {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: 'u1' }) };

describe('PATCH /api/admin/users/[id] — self-service stays above the project guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSession.mockResolvedValue({ id: 'u1', email: 'u@x.com' });
    mocks.getUserById.mockResolvedValue({ id: 'u1', email: 'u@x.com', passwordHash: 'stored' });
    mocks.compare.mockResolvedValue(true);
    mocks.hash.mockResolvedValue('new-hash');
    mocks.listAllProjects.mockResolvedValue([]);
    mocks.checkDisableFloor.mockResolvedValue(null);
  });

  it('changes your OWN password with no project named anywhere', async () => {
    const res = await PATCH(patchRequest({ currentPassword: 'Old-passw0rd!', newPassword: 'New-passw0rd!' }), params);
    expect(res.status).toBe(200);
    expect(mocks.updateUser).toHaveBeenCalledWith('u1', { passwordHash: 'new-hash', mustChangePassword: false });
    // The project guard was never consulted. `requireAdmin` is the ONE guard this
    // handler carries (`[id]/route.ts:68`) — asserting a symbol the handler does
    // not import would be decoration, which is what D-G removed.
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
  });

  // The one shape where the guard COULD be reached: the header is present, so
  // `resolveRequestProjectId` would succeed. The self-service branch must still
  // answer first. Without this case the three `not.toHaveBeenCalled()` assertions
  // above are unfalsifiable — the 400 from `resolveRequestProjectId` fires before
  // any guard, so no mutation can make them red.
  it('self-service ignores a project header that happens to be present — no guard consulted', async () => {
    mocks.requireAdmin.mockResolvedValue({
      user: { id: 'u1', email: 'u@x.com' },
      callerPriority: 2,
      member: { userId: 'u1', role: 'admin' },
      memberRole: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 2 },
      project: { id: 'proj-1', ownerId: 'owner-1', members: {}, roles: {} },
    });
    const res = await PATCH(
      patchRequest({ currentPassword: 'Old-passw0rd!', newPassword: 'New-passw0rd!' }, 'proj-1'),
      params,
    );
    expect(res.status).toBe(200);
    expect(mocks.updateUser).toHaveBeenCalledWith('u1', { passwordHash: 'new-hash', mustChangePassword: false });
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it('changes your OWN name with no project named anywhere', async () => {
    const res = await PATCH(patchRequest({ name: '  Renamed  ' }), params);
    expect(res.status).toBe(200);
    expect(mocks.updateUser).toHaveBeenCalledWith('u1', { name: 'Renamed' });
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
  });

  it('an ADMIN operation with no project ⇒ 400, and the guard is never reached (O-2)', async () => {
    mocks.requireSession.mockResolvedValue({ id: 'admin-1', email: 'a@x.com' });
    const res = await PATCH(patchRequest({ status: 'disabled' }), params);
    expect(res.status).toBe(400);
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  // The target belongs to no project and the caller's `'*'` carries
  // `platform.users` — the one shape where a record verb on a non-member passes.
  it('an ADMIN operation WITH the header reaches the guard (the control for the 400 above)', async () => {
    mocks.requireSession.mockResolvedValue({ id: 'admin-1', email: 'a@x.com' });
    mocks.requireAdmin.mockResolvedValue({
      user: { id: 'admin-1', email: 'a@x.com' },
      callerPriority: 2,
      member: { userId: 'admin-1', role: 'admin' },
      memberRole: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 2 },
      project: { id: 'proj-1', ownerId: 'owner-1', members: {}, roles: {} },
    });
    const res = await PATCH(patchRequest({ status: 'disabled' }, 'proj-1'), params);
    expect(res.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledWith('proj-1');
    expect(mocks.disableUser).toHaveBeenCalledWith('u1', { kind: 'user', userId: 'admin-1', email: 'a@x.com' });
  });

  // D-B — the "cannot disable the project owner unless you ARE the owner" rule
  // is now the ONE role-priority predicate against the target's role.
  it('blocks disabling a member STRONGER than the caller, whoever created the project', async () => {
    mocks.requireSession.mockResolvedValue({ id: 'admin-1', email: 'a@x.com' });
    mocks.requireAdmin.mockResolvedValue({
      user: { id: 'admin-1', email: 'a@x.com' },
      callerPriority: 2,
      member: { userId: 'admin-1', role: 'admin' },
      memberRole: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 2 },
      project: {
        id: 'proj-1',
        // Deliberately NOT the target: the old rule keyed on this field.
        ownerId: 'someone-else',
        members: { u1: { userId: 'u1', role: 'cheffe', tier: 1 } },
        roles: { cheffe: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 } },
      },
    });
    // The record predicate reads EVERY project the target belongs to.
    mocks.listAllProjects.mockResolvedValue([
      {
        id: 'proj-1',
        ownerId: 'someone-else',
        members: {
          u1: { userId: 'u1', role: 'cheffe', tier: 1 },
          'admin-1': { userId: 'admin-1', role: 'admin', tier: 2 },
        },
        roles: {
          cheffe: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
          admin: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: [], priority: 2 },
        },
      },
    ]);
    const res = await PATCH(patchRequest({ status: 'disabled' }, 'proj-1'), params);
    expect(res.status).toBe(403);
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });
});
