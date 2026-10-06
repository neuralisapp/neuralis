/**
 * `DELETE /api/projects/[id]/permanent` — the outcome contract of an
 * irreversible act. A package that cannot remove the project's resources
 * answers 503 NAMING the package and leaves a failed `project.delete` audit row;
 * a purge that completes leaves exactly one success row. Owner-strength first.
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectDeprovisionError } from '@neuralis/package-system/contracts';

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  getProjectById: vi.fn(),
  purgeProject: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock('@/server/auth/session', () => ({ requireSession: mocks.requireSession }));
vi.mock('@/server/store/ProjectStore', () => ({ getProjectById: mocks.getProjectById }));
vi.mock('@/server/store/AuditStore', () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock('@/server/projects/projectDeletion', () => ({
  purgeProject: mocks.purgeProject,
  ProjectLifecycleError: class ProjectLifecycleError extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));

import { DELETE } from '../route';

function project(role: string, priority: number) {
  return {
    id: 'proj-1',
    name: 'Project',
    ownerId: 'u-owner',
    archivedAt: '2026-09-28T00:00:00.000Z',
    members: {
      'u-caller': { userId: 'u-caller', name: 'C', email: 'c@x.co', role, position: '', tier: priority, addedAt: 't' },
    },
    roles: { [role]: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority } },
    agentOwnership: {},
    limits: { spend: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} } },
    createdAt: 't',
    updatedAt: 't',
  };
}

const call = () =>
  DELETE(new NextRequest('http://localhost:3100/api/projects/proj-1/permanent', { method: 'DELETE' }), {
    params: Promise.resolve({ id: 'proj-1' }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireSession.mockResolvedValue({ id: 'u-caller', email: 'c@x.co' });
  mocks.getProjectById.mockResolvedValue(project('owner', 1));
  mocks.purgeProject.mockImplementation(async () => undefined);
});

describe('DELETE /api/projects/[id]/permanent', () => {
  it('a completed purge answers 200 with ONE success audit row', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(mocks.writeAuditLog).toHaveBeenCalledTimes(1);
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'project.delete', target: 'proj-1' }),
    );
    expect(mocks.writeAuditLog.mock.calls[0]![0]).not.toHaveProperty('details');
  });

  it.each([
    ['fails', 'failed' as const],
    ['times out', 'timeout' as const],
  ])('a package that %s answers 503 naming it, and the attempt is audited as failed', async (_l, failure) => {
    mocks.purgeProject.mockRejectedValue(new ProjectDeprovisionError('@neuralis/machine-core', failure, 'x'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call();
    spy.mockRestore();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ code: 'deprovision_failed', packageId: '@neuralis/machine-core' });
    expect(mocks.writeAuditLog).toHaveBeenCalledTimes(1);
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'project.delete',
      target: 'proj-1',
      details: { outcome: 'failed', step: 'deprovision', packageId: '@neuralis/machine-core', failure },
    }));
  });

  it('any other purge failure is a 500 with a failed audit row — never a silent partial', async () => {
    mocks.purgeProject.mockRejectedValue(new Error('EACCES /home/secret'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call();
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('/home/secret');
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      details: { outcome: 'failed', step: 'purge' },
    }));
  });

  it('an admin below owner strength is refused before anything runs', async () => {
    mocks.getProjectById.mockResolvedValue(project('admin', 2));
    const res = await call();
    expect(res.status).toBe(403);
    expect(mocks.purgeProject).not.toHaveBeenCalled();
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });
});
