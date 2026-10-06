import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  assertSetupComplete: vi.fn(async () => undefined),
  listAllProjects: vi.fn(),
  listProjectsForUser: vi.fn(),
  createProject: vi.fn(),
  getMaxProjects: vi.fn(() => 0),
  writeAuditLog: vi.fn(async () => undefined),
  getUserById: vi.fn(),
  requireReadyRuntime: vi.fn(),
}));

vi.mock('@/server/auth/session', () => ({
  requireSession: mocks.requireSession,
}));

vi.mock('@/server/init', () => ({
  assertSetupComplete: mocks.assertSetupComplete,
  // The route imports SetupRequiredError for an `instanceof` check.
  SetupRequiredError: class SetupRequiredError extends Error {},
}));

vi.mock('@/server/store/ProjectStore', () => ({
  listAllProjects: mocks.listAllProjects,
  listProjectsForUser: mocks.listProjectsForUser,
  createProject: mocks.createProject,
  // access.ts imports this at module scope; the create gate never calls it.
  getProjectById: vi.fn(),
}));

vi.mock('@/server/store/PlatformConfigStore', () => ({
  getPlatformConfigStore: () => ({ get: mocks.getMaxProjects }),
}));

vi.mock('@/server/store/AuditStore', () => ({
  writeAuditLog: mocks.writeAuditLog,
}));

// The extracted service (createProjectForUser) re-derives the caller's
// name/email for the seed + audit — the cookie session no longer supplies them.
vi.mock('@/server/store/UserStore', () => ({
  getUserById: mocks.getUserById,
}));

// Readiness is the create's last gate; the real one would boot the runtime.
vi.mock('@/server/projects/projectInit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/projects/projectInit')>()),
  requireReadyRuntime: mocks.requireReadyRuntime,
}));

import { GET, POST } from '../route';

const USER = { id: 'u1', name: 'User One', email: 'u1@example.com' };

function request(body: unknown) {
  return new NextRequest('http://localhost:3100/api/projects', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/** A project where `userId` holds `roleName` (built-in priority resolves owner=1). */
function projectWithMember(id: string, userId: string, roleName: string) {
  return {
    id,
    name: id,
    ownerId: roleName === 'owner' ? userId : 'someone-else',
    members: {
      [userId]: {
        userId,
        name: 'M',
        email: 'm@example.com',
        role: roleName,
        position: 'P',
        tier: 1,
        addedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    roles: {
      [roleName]: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'] },
    },
    agentOwnership: {},
    limits: { spend: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} } },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('POST /api/projects', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSession.mockResolvedValue(USER);
    mocks.assertSetupComplete.mockResolvedValue(undefined);
    mocks.getMaxProjects.mockReturnValue(0); // unlimited by default
    // The create echo now runs through `toProjectView` — the double must be
    // record-shaped (members/roles/limits present), like production.
    mocks.createProject.mockResolvedValue(projectWithMember('new-proj', USER.id, 'owner'));
    mocks.getUserById.mockResolvedValue(USER);
    mocks.requireReadyRuntime.mockResolvedValue({});
  });

  it('runtime not ready ⇒ 503 runtime_not_ready, no project created, nothing audited', async () => {
    const { RuntimeNotReadyError } = await import('@/server/projects/projectInit');
    mocks.listAllProjects.mockResolvedValue([projectWithMember('p1', USER.id, 'owner')]);
    mocks.requireReadyRuntime.mockRejectedValue(new RuntimeNotReadyError());

    const response = await POST(request({ name: 'New' }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'runtime_not_ready' });
    expect(mocks.createProject).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it('a package provisioning failure ⇒ 503 provisioning_failed naming only the package, the failure audited', async () => {
    const { ProjectProvisionError } = await import('@neuralis/package-system/contracts');
    mocks.listAllProjects.mockResolvedValue([projectWithMember('p1', USER.id, 'owner')]);
    mocks.createProject.mockRejectedValueOnce(new ProjectProvisionError('@acme/broken', 'EACCES /home/secret'));

    const response = await POST(request({ name: 'New' }));

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ code: 'provisioning_failed' });
    expect(body.error).toContain('@acme/broken');
    expect(JSON.stringify(body)).not.toContain('/home/secret');
    expect(mocks.writeAuditLog).toHaveBeenCalledTimes(1);
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'project.create_failed',
      details: { packageId: '@acme/broken' },
    }));
  });

  it('lets an owner of an existing project create a new one (201) and audits it', async () => {
    mocks.listAllProjects.mockResolvedValue([projectWithMember('p1', USER.id, 'owner')]);
    mocks.getMaxProjects.mockReturnValue(10);

    const response = await POST(request({ name: 'New' }));

    expect(response.status).toBe(201);
    expect(mocks.createProject).toHaveBeenCalledWith('New', USER.id, undefined, {
      name: USER.name,
      email: USER.email,
    });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'project.create', userId: USER.id, target: 'new-proj' }),
    );
  });

  it('blocks a non-owner member (403) and does not create', async () => {
    mocks.listAllProjects.mockResolvedValue([projectWithMember('p1', USER.id, 'member')]);

    const response = await POST(request({ name: 'New' }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toBe('Only an owner can create projects');
    expect(mocks.createProject).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it('blocks a caller who owns no project (member of none) (403)', async () => {
    // Caller is not a member of any existing project.
    mocks.listAllProjects.mockResolvedValue([projectWithMember('p1', 'other-user', 'owner')]);

    const response = await POST(request({ name: 'New' }));

    expect(response.status).toBe(403);
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it('enforces the instance-wide cap for an owner (403)', async () => {
    mocks.listAllProjects.mockResolvedValue([
      projectWithMember('p1', USER.id, 'owner'),
      projectWithMember('p2', 'x', 'owner'),
      projectWithMember('p3', 'y', 'owner'),
    ]);
    mocks.getMaxProjects.mockReturnValue(3);

    const response = await POST(request({ name: 'New' }));
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toBe('Project limit reached (max 3)');
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it('treats maxProjects=0 as unlimited for an owner (201)', async () => {
    mocks.listAllProjects.mockResolvedValue([
      projectWithMember('p1', USER.id, 'owner'),
      projectWithMember('p2', 'x', 'owner'),
      projectWithMember('p3', 'y', 'owner'),
    ]);
    mocks.getMaxProjects.mockReturnValue(0);

    const response = await POST(request({ name: 'New' }));

    expect(response.status).toBe(201);
    expect(mocks.createProject).toHaveBeenCalled();
  });

  it('rejects a missing name before any gate (400)', async () => {
    const response = await POST(request({}));

    expect(response.status).toBe(400);
    expect(mocks.listAllProjects).not.toHaveBeenCalled();
  });
});

// D2 — the LIST response also goes through the projection, per record, with the
// caller's features resolved per project (they differ across memberships).
describe('GET /api/projects (projection)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSession.mockResolvedValue(USER);
    mocks.assertSetupComplete.mockResolvedValue(undefined);
  });

  it('projects each record by the caller membership of THAT project', async () => {
    // p1: caller is a bare viewer next to another member with a byUser rule.
    const p1 = projectWithMember('p1', USER.id, 'viewer');
    (p1.roles as any).viewer = {
      agents: 'view', canInvite: false, canManageRoles: false, grantedFeatures: ['project.dashboard'],
    };
    (p1.members as any)['other'] = {
      userId: 'other', name: 'O', email: 'o@example.com', role: 'viewer',
      position: 'V', tier: 5, addedAt: '2026-01-01T00:00:00.000Z',
    };
    (p1.limits as any).spend.byUser = { other: { amountUsd: 9, period: 'day' } };
    // p2: caller holds canManageRoles ⇒ full view.
    const p2 = projectWithMember('p2', USER.id, 'owner');
    (p2.members as any)['other'] = {
      userId: 'other', name: 'O', email: 'o@example.com', role: 'owner',
      position: 'O', tier: 1, addedAt: '2026-01-01T00:00:00.000Z',
    };
    mocks.listProjectsForUser.mockResolvedValue([p1, p2]);

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    const [v1, v2] = body;
    expect(v1.members['other'].email).toBeUndefined();
    expect(v1.limits.spend.byUser).toEqual({});
    expect(v1.roles.viewer.grantedFeatures).toEqual(['project.dashboard']);
    expect(v2.members['other'].email).toBe('o@example.com');
  });
});
