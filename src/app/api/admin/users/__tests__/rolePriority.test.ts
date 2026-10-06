import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  createUser: vi.fn(),
  updateProject: vi.fn(),
  writeAuditLog: vi.fn(),
  getProjectById: vi.fn(),
}));

vi.mock('@/server/auth/adminGuard', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('@/server/store/UserStore', () => ({
  createUser: mocks.createUser,
  listUsers: vi.fn(),
  getUserById: vi.fn(),
}));
vi.mock('@/server/store/ProjectStore', () => ({
  listAllProjects: vi.fn(),
  updateProject: mocks.updateProject,
  getProjectById: mocks.getProjectById,
}));
vi.mock('@/server/store/AuditStore', () => ({ writeAuditLog: mocks.writeAuditLog }));

import { POST } from '../route';

/**
 * The RECORDED WRITES. `updateProject` takes a PRODUCER now, so `mock.calls[0][1]`
 * is a function and a CALL is not a write — a producer that answers `null`
 * writes nothing. The mock implements that contract against the same record the
 * service read (`getProjectById`), and the assertions moved onto `writes`.
 */
const writes: Array<{ id: string; patch: Record<string, unknown> }> = [];

function installUpdateProjectContract(): void {
  writes.length = 0;
  mocks.updateProject.mockImplementation(async (id: unknown, patch: unknown) => {
    const current = await mocks.getProjectById(id);
    const produced =
      typeof patch === 'function'
        ? (patch as (p: unknown) => Record<string, unknown> | null)(current)
        : (patch as Record<string, unknown>);
    if (produced === null) return current;
    writes.push({ id: id as string, patch: produced });
    return { ...(current as object), ...produced };
  });
}

/**
 * The route is a thin cookie wrapper now: `requireAdmin` (mocked) resolves the
 * session, then the extracted `inviteUserToProject` service RE-DERIVES the
 * caller's floor from the LIVE record — so the fixture must carry the caller
 * as a member of the project and `getProjectById` must serve that record.
 */
function adminCtx(callerPriority: number, projectId = 'proj-1') {
  const callerRole = callerPriority <= 1 ? 'owner' : 'admin';
  const ctx = {
    user: { id: 'admin-user', email: 'a@example.com' },
    callerPriority,
    member: { userId: 'admin-user', role: callerRole },
    memberRole: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: callerPriority },
    project: {
      id: projectId,
      ownerId: 'owner-user',
      members: {
        'existing-user': { userId: 'existing-user', role: 'member', tier: 20 },
        'admin-user': { userId: 'admin-user', role: callerRole, tier: callerPriority },
      },
      roles: {
        owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
        admin: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 2 },
        member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 20 },
      },
    },
  };
  mocks.getProjectById.mockResolvedValue(ctx.project);
  return ctx;
}

function request(body: unknown, projectIdHeader: string | null = 'proj-1') {
  const headers = new Headers();
  if (projectIdHeader) headers.set('X-Project-Id', projectIdHeader);
  return new Request('http://localhost/api/admin/users', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

describe('POST /api/admin/users — invite role-priority gate (B1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createUser.mockResolvedValue({ id: 'new-user', name: 'New', email: 'n@example.com' });
    installUpdateProjectContract();
  });

  it('blocks an admin from inviting an owner (stronger role)', async () => {
    mocks.requireAdmin.mockResolvedValue(adminCtx(2));
    const res = await POST(request({ email: 'n@example.com', name: 'New', role: 'owner' }));
    expect(res.status).toBe(403);
    expect(mocks.createUser).not.toHaveBeenCalled();
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it('allows an admin to invite a member (weaker role) and mirrors tier from priority', async () => {
    mocks.requireAdmin.mockResolvedValue(adminCtx(2));
    const res = await POST(request({ email: 'n@example.com', name: 'New', role: 'member' }));
    expect(res.status).toBe(201);
    expect(writes).toHaveLength(1);
    const patch = writes[0].patch as { members: Record<string, { tier: number; position: string }> };
    expect(patch.members['new-user'].tier).toBe(20);
    // D-A — `position` is no longer synthesized from the role name.
    expect(patch.members['new-user'].position).toBe('');
  });

  it('allows an owner to invite an admin', async () => {
    mocks.requireAdmin.mockResolvedValue(adminCtx(1));
    const res = await POST(request({ email: 'n@example.com', name: 'New', role: 'admin' }));
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// §1.8 — the pre-existing cross-project invite defect.
//
// Before: `requireAdmin()` authorized against the caller's FIRST project (A)
// while the write landed on `body.projectId` (B) — and it wrote A's member MAP
// into B, replacing B's membership. The record invariant caught it only when B's
// owner was absent from A's members, i.e. it SUCCEEDED whenever one person owned
// both projects — the default shape of a fresh instance.
// ---------------------------------------------------------------------------

describe('POST /api/admin/users — the guard evaluates the TARGET project (§1.8)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createUser.mockResolvedValue({ id: 'new-user', name: 'New', email: 'n@example.com' });
    installUpdateProjectContract();
  });

  it('authorizes against body.projectId, and writes THAT project\'s member map', async () => {
    mocks.requireAdmin.mockResolvedValue(adminCtx(2, 'proj-B'));
    const res = await POST(
      request({ email: 'n@example.com', name: 'New', role: 'member', projectId: 'proj-B' }, 'proj-B'),
    );
    expect(res.status).toBe(201);
    // The guard was called with the TARGET, not with "the caller's first project".
    expect(mocks.requireAdmin).toHaveBeenCalledWith('proj-B');
    expect(writes).toHaveLength(1);
    expect(writes[0].id).toBe('proj-B');
    // …and the map extended is the TARGET's, so B's membership is not replaced.
    const patch = writes[0].patch as { members: Record<string, unknown> };
    expect(Object.keys(patch.members).sort()).toEqual(['admin-user', 'existing-user', 'new-user']);
  });

  it('rejects a body projectId that disagrees with the header — never authorize A, write B', async () => {
    mocks.requireAdmin.mockResolvedValue(adminCtx(2));
    const res = await POST(
      request({ email: 'n@example.com', name: 'New', role: 'member', projectId: 'proj-B' }, 'proj-A'),
    );
    expect(res.status).toBe(403);
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.createUser).not.toHaveBeenCalled();
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it('400s when no project is named at all (O-2: no "my first project" fallback)', async () => {
    mocks.requireAdmin.mockResolvedValue(adminCtx(2));
    const res = await POST(request({ email: 'n@example.com', name: 'New', role: 'member' }, null));
    expect(res.status).toBe(400);
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.createUser).not.toHaveBeenCalled();
  });
});
