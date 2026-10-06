import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(async () => ({ id: 'user-1' })),
  resolveProjectAccess: vi.fn(),
  canManagePackages: vi.fn(),
  ensureCommunityRuntime: vi.fn(async () => undefined),
  getCommunityPackageRegistry: vi.fn(() => ({})),
  ensureProjectPackagesLoaded: vi.fn(async () => undefined),
  commandDispatch: vi.fn(async () => ({ success: true, data: { ok: true } })),
  queryDispatch: vi.fn(async () => ({ success: true, data: { ok: true } })),
}));

vi.mock('@/server/auth/session', () => ({
  requireSession: mocks.requireSession,
}));

vi.mock('@/server/projects/access', () => ({
  resolveProjectAccess: mocks.resolveProjectAccess,
  canManagePackages: mocks.canManagePackages,
}));

vi.mock('@/server/packages/runtime', () => ({
  ensureCommunityRuntime: mocks.ensureCommunityRuntime,
  getCommunityPackageRegistry: mocks.getCommunityPackageRegistry,
}));

vi.mock('@/server/packages/projectPackages', () => ({
  ensureProjectPackagesLoaded: mocks.ensureProjectPackagesLoaded,
}));

vi.mock('@/server/packages/dispatch', () => ({
  handleDefaultCommunityPackageCommand: vi.fn(),
  handleDefaultCommunityPackageQuery: vi.fn(),
}));

vi.mock('@neuralis/package-system', () => ({
  PackageCommandRouter: class {
    registerFallbackHandler = vi.fn();
    dispatch = mocks.commandDispatch;
  },
  PackageQueryRouter: class {
    registerFallbackHandler = vi.fn();
    dispatch = mocks.queryDispatch;
  },
}));

import { POST as postCommand } from '../command/route';
import { POST as postQuery } from '../query/route';

function post(url: string, body: unknown) {
  return new NextRequest(url, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

const access = {
  project: { id: 'proj-1' },
  member: { role: 'member' },
  role: { grantedFeatures: ['packages.manage'] },
};

describe('package command/query routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSession.mockResolvedValue({ id: 'user-1' });
    mocks.resolveProjectAccess.mockResolvedValue(access);
    mocks.canManagePackages.mockReturnValue(true);
    mocks.commandDispatch.mockResolvedValue({ success: true, data: { ok: true } });
    mocks.queryDispatch.mockResolvedValue({ success: true, data: { ok: true } });
  });

  it('requires projectId for package commands', async () => {
    const response = await postCommand(post('http://localhost:3100/api/packages/command', {
      packageId: 'pkg',
      operation: 'package.reload',
    }));

    expect(response.status).toBe(400);
    expect(mocks.commandDispatch).not.toHaveBeenCalled();
  });

  it('requires package management permission for package commands', async () => {
    mocks.canManagePackages.mockReturnValue(false);

    const response = await postCommand(post('http://localhost:3100/api/packages/command', {
      projectId: 'proj-1',
      packageId: 'pkg',
      operation: 'package.reload',
    }));

    expect(response.status).toBe(403);
    expect(mocks.commandDispatch).not.toHaveBeenCalled();
  });

  it('dispatches commands with verified project context', async () => {
    const response = await postCommand(post('http://localhost:3100/api/packages/command', {
      projectId: 'proj-1',
      packageId: 'pkg',
      operation: 'package.reload',
      payload: { projectRoot: '/tmp/forged' },
    }));

    expect(response.status).toBe(200);
    expect(mocks.ensureProjectPackagesLoaded).toHaveBeenCalledWith('proj-1');
    expect(mocks.commandDispatch).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ userId: 'user-1', projectId: 'proj-1' }),
    }));
  });

  it('requires project membership for package queries', async () => {
    mocks.resolveProjectAccess.mockResolvedValue(null);

    const response = await postQuery(post('http://localhost:3100/api/packages/query', {
      projectId: 'proj-1',
      packageId: '@neuralis/package-system',
      operation: 'project.list',
    }));

    expect(response.status).toBe(403);
    expect(mocks.queryDispatch).not.toHaveBeenCalled();
  });

  it('requires package management permission for package queries', async () => {
    mocks.canManagePackages.mockReturnValue(false);

    const response = await postQuery(post('http://localhost:3100/api/packages/query', {
      projectId: 'proj-1',
      packageId: '@neuralis/package-system',
      operation: 'definition.get',
    }));

    expect(response.status).toBe(403);
    expect(mocks.queryDispatch).not.toHaveBeenCalled();
  });

  it('dispatches queries with verified project context', async () => {
    const response = await postQuery(post('http://localhost:3100/api/packages/query', {
      projectId: 'proj-1',
      packageId: '@neuralis/package-system',
      operation: 'project.list',
      params: { projectRoot: '/tmp/forged' },
    }));

    expect(response.status).toBe(200);
    expect(mocks.ensureProjectPackagesLoaded).toHaveBeenCalledWith('proj-1');
    expect(mocks.queryDispatch).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ userId: 'user-1', projectId: 'proj-1' }),
    }));
  });
});
