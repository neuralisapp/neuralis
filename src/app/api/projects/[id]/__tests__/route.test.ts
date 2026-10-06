import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(async () => ({ id: 'member-user', email: 'm@example.com', name: 'Member' })),
  getProjectById: vi.fn(),
  updateProject: vi.fn(),
  archiveProject: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock('@/server/auth/session', () => ({
  requireSession: mocks.requireSession,
}));

vi.mock('@/server/store/ProjectStore', () => ({
  getProjectById: mocks.getProjectById,
  updateProject: mocks.updateProject,
  ProjectUpdateError: class ProjectUpdateError extends Error {},
}));

vi.mock('@/server/projects/projectDeletion', () => ({
  archiveProject: mocks.archiveProject,
}));

vi.mock('@/server/store/AuditStore', () => ({
  writeAuditLog: mocks.writeAuditLog,
}));

import { GET, PATCH, DELETE } from '../route';

function request(body: unknown) {
  return new NextRequest('http://localhost:3100/api/projects/proj-1', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

function deleteRequest() {
  return new NextRequest('http://localhost:3100/api/projects/proj-1', { method: 'DELETE' });
}

function params() {
  return { params: Promise.resolve({ id: 'proj-1' }) };
}

function projectFor(
  roleName: string,
  roleOverrides: Record<string, unknown> = {},
  memberId = 'member-user',
) {
  return {
    id: 'proj-1',
    name: 'Project',
    ownerId: 'owner-user',
    members: {
      [memberId]: {
        userId: memberId,
        name: 'Member',
        email: 'm@example.com',
        role: roleName,
        position: 'Member',
        tier: 3,
        addedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    roles: {
      [roleName]: {
        agents: 'own',
        canInvite: false,
        canManageRoles: false,
        grantedFeatures: [],
        ...roleOverrides,
      },
    },
    agentOwnership: {},
    limits: { spend: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} } },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

// Escalating patch — defines the `owner` role (priority 1, stronger than a manager).
const validRolesPatch = {
  owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'] },
  member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: ['core.agents'] },
};

// Non-escalating patch — S1: a caller may only edit roles STRICTLY WEAKER than
// itself, so the caller's own `manager` entry travels back UNCHANGED (whole-map
// semantics: omitting it would be a delete) and only `member` is edited. The
// granted id is one the caller holds, because you may only hand out what you
// hold.
const CALLER_MANAGER_ROLE = {
  agents: 'own',
  canInvite: false,
  canManageRoles: true,
  grantedFeatures: ['core.agents'],
};
const nonEscalatingRolesPatch = {
  manager: { ...CALLER_MANAGER_ROLE },
  member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: ['core.agents'], priority: 20 },
};

describe('PATCH /api/projects/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSession.mockResolvedValue({ id: 'member-user', email: 'm@example.com', name: 'Member' });
    // The PATCH echo now runs through `toProjectView`, which reads the record's
    // members/roles/limits — the double must be record-shaped, like production.
    mocks.updateProject.mockResolvedValue({ ...projectFor('member'), name: 'Updated' });
  });

  it('blocks a description change by a member who is not owner-strength', async () => {
    mocks.getProjectById.mockResolvedValue(projectFor('member'));

    const response = await PATCH(request({ description: 'Updated' }), params());

    expect(response.status).toBe(403);
    expect(mocks.updateProject).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it('blocks a description change by a role manager below owner strength', async () => {
    mocks.getProjectById.mockResolvedValue(projectFor('manager', { canManageRoles: true, priority: 10 }));

    const response = await PATCH(request({ description: 'Updated' }), params());

    expect(response.status).toBe(403);
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it('the owner changes the description — audited as CHANGED, never with its text', async () => {
    const project = projectFor('owner');
    mocks.getProjectById.mockResolvedValue(project);
    mocks.updateProject.mockResolvedValue({ ...project, description: 'SECRET-PLAN text' });

    const response = await PATCH(request({ description: 'SECRET-PLAN text' }), params());

    expect(response.status).toBe(200);
    expect(mocks.updateProject).toHaveBeenCalledWith('proj-1', { description: 'SECRET-PLAN text' });
    expect(mocks.writeAuditLog).toHaveBeenCalledTimes(1);
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'project.update',
      target: 'proj-1',
      details: { description: { changed: true } },
    }));
    expect(JSON.stringify(mocks.writeAuditLog.mock.calls)).not.toContain('SECRET-PLAN');
  });

  it('a name + description change by the owner is ONE audited row carrying both', async () => {
    const project = projectFor('owner');
    mocks.getProjectById.mockResolvedValue(project);
    mocks.updateProject.mockResolvedValue({ ...project, name: 'Renamed', description: 'd' });

    const response = await PATCH(request({ name: 'Renamed', description: 'd' }), params());

    expect(response.status).toBe(200);
    expect(mocks.writeAuditLog).toHaveBeenCalledTimes(1);
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      details: { name: { from: 'Project', to: 'Renamed' }, description: { changed: true } },
    }));
  });

  it('a trailing-space resend of the stored name is not a rename (the name is stored trimmed)', async () => {
    mocks.getProjectById.mockResolvedValue(projectFor('member'));
    mocks.updateProject.mockResolvedValue(projectFor('member'));

    const response = await PATCH(request({ name: 'Project  ' }), params());

    expect(response.status).toBe(200);
    expect(mocks.updateProject).toHaveBeenCalledWith('proj-1', { name: 'Project' });
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it('blocks a rename by a member who is not owner-strength', async () => {
    mocks.getProjectById.mockResolvedValue(projectFor('member'));

    const response = await PATCH(request({ name: 'Updated' }), params());

    expect(response.status).toBe(403);
    expect(mocks.updateProject).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it('blocks a rename by a role manager below owner strength', async () => {
    mocks.getProjectById.mockResolvedValue(projectFor('manager', { canManageRoles: true }));

    const response = await PATCH(request({ name: 'Updated' }), params());

    expect(response.status).toBe(403);
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it('resending the unchanged name is not a rename', async () => {
    mocks.getProjectById.mockResolvedValue(projectFor('member'));
    mocks.updateProject.mockResolvedValue(projectFor('member'));

    // An absent stored description and an empty one are the same value.
    const response = await PATCH(request({ name: 'Project', description: '' }), params());

    expect(response.status).toBe(200);
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it.each([
    ['the owner role', 'owner', {}],
    ['a custom role declared at owner priority', 'founder', { priority: 1 }],
  ])('%s renames — same id, one audited project.update row', async (_label, roleName, over) => {
    const project = projectFor(roleName, over);
    mocks.getProjectById.mockResolvedValue(project);
    mocks.updateProject.mockResolvedValue({ ...project, name: 'Ügyfél projekt' });

    const response = await PATCH(request({ name: 'Ügyfél projekt' }), params());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.id).toBe('proj-1');
    expect(mocks.updateProject).toHaveBeenCalledWith('proj-1', { name: 'Ügyfél projekt' });
    expect(mocks.writeAuditLog).toHaveBeenCalledTimes(1);
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'project.update',
      target: 'proj-1',
      details: { name: { from: 'Project', to: 'Ügyfél projekt' } },
    }));
  });

  it('blocks role patches for a normal member', async () => {
    mocks.getProjectById.mockResolvedValue(projectFor('member'));

    const response = await PATCH(request({ roles: validRolesPatch }), params());

    expect(response.status).toBe(403);
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it('allows non-escalating role patches for a role manager', async () => {
    mocks.getProjectById.mockResolvedValue(projectFor('manager', { ...CALLER_MANAGER_ROLE }));

    const response = await PATCH(request({ roles: nonEscalatingRolesPatch }), params());

    expect(response.status).toBe(200);
    expect(mocks.updateProject).toHaveBeenCalledWith('proj-1', { roles: nonEscalatingRolesPatch });
  });

  it('blocks redefining a built-in role priority (C2 immutable)', async () => {
    // Even the owner cannot relabel a built-in role's anchored priority.
    mocks.getProjectById.mockResolvedValue(projectFor('owner', { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 }));

    const response = await PATCH(
      request({ roles: { owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 99 } } }),
      params(),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toContain('immutable');
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it('blocks a role manager from defining a custom role stronger than itself (C2)', async () => {
    const project = projectFor('manager', { ...CALLER_MANAGER_ROLE });
    mocks.getProjectById.mockResolvedValue(project);

    const response = await PATCH(
      request({
        roles: {
          // The caller's own role rides back unchanged — S1 reads an omission as
          // a delete, and this test is about the CREATE arm.
          ...project.roles,
          superadmin: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
        },
      }),
      params(),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toContain('stronger than your own priority');
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it('blocks a role manager from promoting a member above its own priority (C1)', async () => {
    const project = projectFor('manager', { canManageRoles: true });
    // Add an `admin` role (priority 2) and a target member to promote.
    project.roles.admin = { agents: '*', canInvite: true, canManageRoles: false, grantedFeatures: ['*'], priority: 2 } as any;
    (project.members as any)['target-user'] = {
      userId: 'target-user', name: 'T', email: 't@example.com', role: 'member', position: 'Member', tier: 4, addedAt: '2026-01-01T00:00:00.000Z',
    };
    // Weaker than the caller (10), so the refusal comes from the ASSIGNMENT arm
    // under test and not from "this member is already stronger than you".
    project.roles.member = { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 20 } as any;
    mocks.getProjectById.mockResolvedValue(project);

    const response = await PATCH(
      request({ members: { ...project.members, 'target-user': { ...(project.members as any)['target-user'], role: 'admin' } } }),
      params(),
    );
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body.error).toContain('stronger than your own priority');
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it('blocks metadata patches for view-only roles', async () => {
    mocks.getProjectById.mockResolvedValue(projectFor('viewer', { agents: 'view' }));

    const response = await PATCH(request({ description: 'Nope' }), params());

    expect(response.status).toBe(403);
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it('rejects unsupported patch fields', async () => {
    mocks.getProjectById.mockResolvedValue(projectFor('manager', { canManageRoles: true }));

    const response = await PATCH(request({ packageTrust: {} }), params());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('Unsupported project patch field');
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it('rejects invalid project names before store update', async () => {
    mocks.getProjectById.mockResolvedValue(projectFor('manager', { canManageRoles: true }));

    const response = await PATCH(request({ name: '' }), params());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('Project name must not be empty');
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });
});

// happy-wondering-yeti — DELETE now ARCHIVES (owner-only, reversible).
describe('DELETE /api/projects/:id (archive)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSession.mockResolvedValue({ id: 'owner-user', email: 'o@example.com', name: 'Owner' });
  });

  // D-B — the gate is owner STRENGTH (`isOwnerStrengthOf`, priority <= 1), so
  // the caller must hold an owner-strength ROLE in the project. Being named in
  // `ownerId` is provenance and decides nothing; the record invariant
  // ("the owner must remain a member holding the owner role") is what keeps the
  // seeded owner passing.
  it('archives the project for an owner-strength member (not a record delete)', async () => {
    mocks.getProjectById.mockResolvedValue(projectFor('owner', {}, 'owner-user'));

    const response = await DELETE(deleteRequest(), params());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, archived: true });
    expect(mocks.archiveProject).toHaveBeenCalledWith('proj-1');
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'project.archive', target: 'proj-1', userId: 'owner-user' }),
    );
  });

  it('blocks a non-owner from archiving', async () => {
    mocks.requireSession.mockResolvedValue({ id: 'member-user', email: 'm@example.com', name: 'Member' });
    mocks.getProjectById.mockResolvedValue(projectFor('member'));

    const response = await DELETE(deleteRequest(), params());

    expect(response.status).toBe(403);
    expect(mocks.archiveProject).not.toHaveBeenCalled();
  });

  // D-A — the acceptance property of the whole role model: a role named
  // anything, declared at priority 1, behaves EXACTLY like the built-in `owner`.
  it('archives for a CUSTOM role declared at owner priority', async () => {
    mocks.requireSession.mockResolvedValue({ id: 'chef-user', email: 'c@example.com', name: 'Chef' });
    mocks.getProjectById.mockResolvedValue(projectFor('cheffe', { priority: 1 }, 'chef-user'));

    const response = await DELETE(deleteRequest(), params());

    expect(response.status).toBe(200);
    expect(mocks.archiveProject).toHaveBeenCalledWith('proj-1');
  });

  // D-B — `ownerId` is provenance. The creator who is no longer a member (or was
  // demoted) has no authority left; only the ROLE decides.
  it('blocks the provenance ownerId when they hold no owner-strength role', async () => {
    mocks.getProjectById.mockResolvedValue(projectFor('member', {}, 'owner-user'));

    const response = await DELETE(deleteRequest(), params());

    expect(response.status).toBe(403);
    expect(mocks.archiveProject).not.toHaveBeenCalled();
  });

  it('404s for a missing project', async () => {
    mocks.getProjectById.mockResolvedValue(null);

    const response = await DELETE(deleteRequest(), params());

    expect(response.status).toBe(404);
    expect(mocks.archiveProject).not.toHaveBeenCalled();
  });
});

// D2 — the GET response goes through the ONE feature-keyed projection.
describe('GET /api/projects/:id (projection)', () => {
  function getRequest() {
    return new NextRequest('http://localhost:3100/api/projects/proj-1');
  }

  function twoMemberProject(viewerGrants: string[] = ['project.dashboard']) {
    const project = projectFor('viewer', { agents: 'view', grantedFeatures: viewerGrants });
    (project.members as any)['other-user'] = {
      userId: 'other-user', name: 'Other', email: 'other@example.com', role: 'owner',
      position: 'Owner', tier: 1, addedAt: '2026-01-01T00:00:00.000Z',
    };
    (project.roles as any).owner = {
      agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1,
    };
    (project.limits as any).spend.byUser = {
      'other-user': { amountUsd: 9, period: 'day' },
      'member-user': { amountUsd: 2, period: 'week' },
    };
    return project;
  }

  it('a bare member sees no other emails, no other grant lists, no other byUser rows', async () => {
    mocks.requireSession.mockResolvedValue({ id: 'member-user', email: 'm@example.com', name: 'Member' });
    mocks.getProjectById.mockResolvedValue(twoMemberProject());

    const response = await GET(getRequest(), params());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.members['other-user'].email).toBeUndefined();
    expect(body.members['member-user'].email).toBe('m@example.com');
    expect(body.roles.owner.grantedFeatures).toBeUndefined();
    expect(body.roles.viewer.grantedFeatures).toEqual(['project.dashboard']);
    expect(body.limits.spend.byUser).toEqual({ 'member-user': { amountUsd: 2, period: 'week' } });
  });

  it('a canManageRoles holder receives the full record (write-implies-read)', async () => {
    mocks.requireSession.mockResolvedValue({ id: 'member-user', email: 'm@example.com', name: 'Member' });
    const project = twoMemberProject();
    (project.roles as any).viewer.canManageRoles = true;
    mocks.getProjectById.mockResolvedValue(project);

    const response = await GET(getRequest(), params());
    const body = await response.json();

    expect(body.members['other-user'].email).toBe('other@example.com');
    expect(body.roles.owner.grantedFeatures).toEqual(['*']);
    expect(Object.keys(body.limits.spend.byUser)).toHaveLength(2);
  });

  it('403s a non-member before any projection', async () => {
    mocks.requireSession.mockResolvedValue({ id: 'stranger', email: 's@example.com', name: 'S' });
    mocks.getProjectById.mockResolvedValue(twoMemberProject());

    const response = await GET(getRequest(), params());

    expect(response.status).toBe(403);
  });
});

describe('PATCH /api/projects/:id — membership writes are audited', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSession.mockResolvedValue({ id: 'member-user', email: 'm@example.com', name: 'Member' });
  });

  function managerProject() {
    const project = projectFor('manager', { canManageRoles: true, priority: 10 });
    project.roles.member = { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 20 } as any;
    (project.members as any)['leaving-user'] = {
      userId: 'leaving-user', name: 'L', email: 'l@example.com', role: 'member', position: '', tier: 20, addedAt: '2026-01-01T00:00:00.000Z',
    };
    return project;
  }

  it('a member removal + addition writes ONE project.update row naming both', async () => {
    const project = managerProject();
    mocks.getProjectById.mockResolvedValue(project);
    const next = { ...project.members } as Record<string, unknown>;
    delete next['leaving-user'];
    next['new-user'] = {
      userId: 'new-user', name: 'N', email: 'n@example.com', role: 'member', position: '', tier: 20, addedAt: '2026-01-02T00:00:00.000Z',
    };
    mocks.updateProject.mockResolvedValue({ ...project, members: next });

    const response = await PATCH(request({ members: next }), params());

    expect(response.status).toBe(200);
    expect(mocks.writeAuditLog).toHaveBeenCalledTimes(1);
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'project.update',
      target: 'proj-1',
      details: { members: { added: ['new-user'], removed: ['leaving-user'], roleChanged: [] } },
    }));
  });

  it('paired control: a metadata-only patch writes no membership row', async () => {
    const project = managerProject();
    mocks.getProjectById.mockResolvedValue(project);
    mocks.updateProject.mockResolvedValue(project);

    // The unchanged name: a metadata patch a manager may send (no owner gate fires).
    const response = await PATCH(request({ name: 'Project' }), params());

    expect(response.status).toBe(200);
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });
});
