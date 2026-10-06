import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(async () => ({ id: 'user-1' })),
  resolveProjectAccess: vi.fn(),
  ensureCommunityRuntime: vi.fn(async () => undefined),
  ensureProjectPackagesLoaded: vi.fn(async () => undefined),
  getPackageSnapshot: vi.fn(() => ({ revision: 'rev-1' })),
  isSnapshotUpToDate: vi.fn(() => false),
  getCommunityPackageRegistry: vi.fn(() => ({})),
  getCommunityPackageRuntime: vi.fn(() => ({})),
  getRuntime: vi.fn(),
}));

vi.mock('@/server/auth/session', () => ({
  requireSession: mocks.requireSession,
}));

vi.mock('@/server/projects/access', () => ({
  resolveProjectAccess: mocks.resolveProjectAccess,
}));

vi.mock('@/server/packages/runtime', () => ({
  ensureCommunityRuntime: mocks.ensureCommunityRuntime,
  getCommunityPackageRegistry: mocks.getCommunityPackageRegistry,
  getCommunityPackageRuntime: mocks.getCommunityPackageRuntime,
}));

vi.mock('@/server/packages/projectPackages', () => ({
  ensureProjectPackagesLoaded: mocks.ensureProjectPackagesLoaded,
}));

vi.mock('@/server/packages/snapshot', () => ({
  getPackageSnapshot: mocks.getPackageSnapshot,
  isSnapshotUpToDate: mocks.isSnapshotUpToDate,
}));

vi.mock('@/server/host/bootstrap', () => ({
  getRuntime: mocks.getRuntime,
}));

import { GET } from '../runtime/route';
import { ownAgentDirectory, stubRuntime } from '@/testing/stubRuntime';

function req(projectId?: string, agentId?: string) {
  const headers = new Headers();
  if (projectId) headers.set('x-project-id', projectId);
  if (agentId) headers.set('x-agent-id', agentId);
  return new NextRequest('http://localhost:3100/api/packages/runtime', { headers });
}

const session = { userId: 'user-1', projectId: 'proj-1', role: 'member', grantedFeatures: ['core.agents'], agentAccess: 'own', agentOwnership: {} };
const access = {
  project: { id: 'proj-1', agentOwnership: {} },
  member: { role: 'member' },
  role: { agents: 'own', grantedFeatures: ['core.agents'] },
  session,
};

const agents = new Map<string, { id: string; userId?: string; projectId?: string; config?: unknown }>([
  ['mine', { id: 'mine', userId: 'user-1' }],
  ['mcp', {
    id: 'mcp',
    userId: 'user-1',
    projectId: 'proj-1',
    config: { mcp: { servers: [{ name: 'github', url: 'https://api.githubcopilot.com/mcp/' }] } },
  }],
  ['theirs', { id: 'theirs', userId: 'user-2' }],
]);
const routePackage = vi.fn(async () => ({ status: 404, body: {} }));
function wireAgentCore(): void {
  mocks.getRuntime.mockResolvedValue(
    stubRuntime(
      { routePackage },
      { 'agent-directory': ownAgentDirectory(async (id) => agents.get(id) ?? null) },
      { 'agent-directory': '@neuralis/agent-directory-provider' },
    ),
  );
}

describe('GET /api/packages/runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSession.mockResolvedValue({ id: 'user-1' });
    mocks.resolveProjectAccess.mockResolvedValue(access);
    mocks.getPackageSnapshot.mockReturnValue({ revision: 'rev-1' });
  });

  it('rejects non-member runtime snapshot requests', async () => {
    mocks.resolveProjectAccess.mockResolvedValue(null);

    const response = await GET(req('proj-1'));

    expect(response.status).toBe(403);
    expect(mocks.getPackageSnapshot).not.toHaveBeenCalled();
  });

  it('passes granted features into runtime snapshot filtering', async () => {
    const response = await GET(req('proj-1'));

    expect(response.status).toBe(200);
    // R2b — the scope (userId/role/grantedFeatures) is threaded for scope-isolated
    // advertise; project carries no packageAccessFeature override in this fixture.
    expect(mocks.getPackageSnapshot).toHaveBeenCalledWith(
      {
        host: 'neuralis-workspace',
        projectId: 'proj-1',
        userId: 'user-1',
        role: 'member',
        grantedFeatures: ['core.agents'],
      },
      ['core.agents'],
    );
  });

  it('an OWN x-agent-id reaches the snapshot filter', async () => {
    wireAgentCore();
    const response = await GET(req('proj-1', 'mine'));
    expect(response.status).toBe(200);
    expect((mocks.getPackageSnapshot.mock.calls[0] as unknown[])[0]).toMatchObject({ agentId: 'mine' });
  });

  // The route used to read the agent's MCP servers and register each one as a
  // synthetic package in the SHARED registry for the length of the request.
  // The scoped snapshot filtered them out of this very response, while a
  // snapshot built meanwhile kept them for every other project. Now: no agent
  // read, no registry write, and the body is the snapshot as the registry has it.
  it('an agent WITH MCP servers: no agent read, no registry write, packages[] is the snapshot unchanged', async () => {
    wireAgentCore();
    const packages = [{ id: '@neuralis/agent-core', name: 'agent-core', version: '0.1.0', status: 'active' }];
    mocks.getPackageSnapshot.mockReturnValue({ revision: 'rev-1', packages } as { revision: string });
    const register = vi.fn();
    const unregister = vi.fn();
    mocks.getCommunityPackageRegistry.mockReturnValue({ registerInstalled: register, registerBuiltin: register, unregister });

    const response = await GET(req('proj-1', 'mcp'));

    expect(response.status).toBe(200);
    expect(((await response.json()) as { packages: unknown }).packages).toEqual(packages);
    expect(routePackage).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(unregister).not.toHaveBeenCalled();
    expect((mocks.getPackageSnapshot.mock.calls[0] as unknown[])[0]).toMatchObject({ agentId: 'mcp' });
  });

  // Paired with the row above: only the named agent changes. The old route read
  // the header raw, so `theirs` reached both the agent read and the filter.
  it('a FOREIGN or unknown x-agent-id resolves to no agent — 200, no agent read, unfiltered by agent', async () => {
    wireAgentCore();
    for (const named of ['theirs', 'nobody']) {
      routePackage.mockClear();
      mocks.getPackageSnapshot.mockClear();
      const response = await GET(req('proj-1', named));
      expect(response.status).toBe(200);
      expect(routePackage).not.toHaveBeenCalled();
      expect((mocks.getPackageSnapshot.mock.calls[0] as unknown[])[0]).not.toHaveProperty('agentId');
    }
  });
});
