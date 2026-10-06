import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(async () => ({ id: 'user-1' })),
  resolveProjectAccess: vi.fn(),
  ensureProjectPackagesLoaded: vi.fn(async () => undefined),
  getDockSnapshot: vi.fn(() => []),
  getCommandSnapshot: vi.fn(() => []),
  getWidgetSnapshot: vi.fn(() => []),
  agents: new Map<string, { id: string; userId?: string }>(),
}));

// The REAL agent-axis adapter runs over this directory double — the route must
// hand it the caller's session and take only its verdict.
vi.mock('@/server/host/bootstrap', async () => {
  const { stubRuntime, ownAgentDirectory } = await import('@/testing/stubRuntime');
  return {
    getRuntime: async () =>
      stubRuntime({}, { 'agent-directory': ownAgentDirectory(async (id) => mocks.agents.get(id) ?? null) }),
  };
});

vi.mock('@/server/auth/session', () => ({
  requireSession: mocks.requireSession,
}));

vi.mock('@/server/projects/access', () => ({
  resolveProjectAccess: mocks.resolveProjectAccess,
}));

vi.mock('@/server/packages/projectPackages', () => ({
  ensureProjectPackagesLoaded: mocks.ensureProjectPackagesLoaded,
}));

vi.mock('@/server/packages/snapshot', () => ({
  getDockSnapshot: mocks.getDockSnapshot,
  getCommandSnapshot: mocks.getCommandSnapshot,
  getWidgetSnapshot: mocks.getWidgetSnapshot,
}));

import { GET as getDock } from '../dock/route';
import { GET as getCommands } from '../commands/route';
import { GET as getWidgets } from '../widgets/route';

function req(projectId?: string, agentId?: string) {
  const headers = new Headers();
  if (projectId) headers.set('x-project-id', projectId);
  if (agentId) headers.set('x-agent-id', agentId);
  return new NextRequest('http://localhost:3100/api/packages/dock', { headers });
}

const access = {
  project: { id: 'proj-1', agentOwnership: {} },
  member: { role: 'member' },
  role: { agents: 'own', grantedFeatures: ['drive.read'] },
  session: { userId: 'user-1', projectId: 'proj-1', role: 'member', grantedFeatures: ['drive.read'], agentAccess: 'own', agentOwnership: {} },
};

describe('package metadata routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSession.mockResolvedValue({ id: 'user-1' });
    mocks.resolveProjectAccess.mockResolvedValue(access);
  });

  it('requires projectId for dock snapshot', async () => {
    const response = await getDock(req());

    expect(response.status).toBe(400);
    expect(mocks.getDockSnapshot).not.toHaveBeenCalled();
  });

  it('rejects non-member dock requests', async () => {
    mocks.resolveProjectAccess.mockResolvedValue(null);

    const response = await getDock(req('proj-1'));

    expect(response.status).toBe(403);
    expect(mocks.getDockSnapshot).not.toHaveBeenCalled();
  });

  it('passes granted features into dock filtering', async () => {
    const response = await getDock(req('proj-1'));

    expect(response.status).toBe(200);
    // R2b — scope (userId/role/grantedFeatures) threaded for scope-isolated advertise.
    expect(mocks.getDockSnapshot).toHaveBeenCalledWith(
      { host: 'neuralis-workspace', projectId: 'proj-1', userId: 'user-1', role: 'member', grantedFeatures: ['drive.read'] },
      ['drive.read'],
    );
  });

  it('loads project packages before returning commands', async () => {
    const response = await getCommands(req('proj-1'));

    expect(response.status).toBe(200);
    expect(mocks.ensureProjectPackagesLoaded).toHaveBeenCalledWith('proj-1');
    expect(mocks.getCommandSnapshot).toHaveBeenCalledWith(
      { host: 'neuralis-workspace', projectId: 'proj-1', userId: 'user-1', role: 'member', grantedFeatures: ['drive.read'] },
      ['drive.read'],
    );
  });

  it('passes granted features into widget filtering', async () => {
    const response = await getWidgets(req('proj-1'));

    expect(response.status).toBe(200);
    expect(mocks.getWidgetSnapshot).toHaveBeenCalledWith(
      { host: 'neuralis-workspace', projectId: 'proj-1', userId: 'user-1', role: 'member', grantedFeatures: ['drive.read'] },
      ['drive.read'],
    );
  });

  describe('the agent axis — a raw x-agent-id is not an agent identity', () => {
    const routes = [
      ['dock', getDock, mocks.getDockSnapshot],
      ['commands', getCommands, mocks.getCommandSnapshot],
      ['widgets', getWidgets, mocks.getWidgetSnapshot],
    ] as const;

    beforeEach(() => {
      mocks.agents.clear();
      mocks.agents.set('mine', { id: 'mine', userId: 'user-1' });
      mocks.agents.set('theirs', { id: 'theirs', userId: 'user-2' });
    });

    it.each(routes)('%s: the caller\'s OWN agent filters the snapshot', async (_name, get, snapshot) => {
      const response = await get(req('proj-1', 'mine'));
      expect(response.status).toBe(200);
      expect((snapshot.mock.calls[0] as unknown[])[0]).toMatchObject({ agentId: 'mine' });
    });

    // Paired with the row above: only the named agent changes. The old routes
    // copied the header verbatim, so `theirs` reached the snapshot filter.
    it.each(routes)('%s: a FOREIGN or unknown agent resolves to no agent — 200, never 403', async (_name, get, snapshot) => {
      for (const named of ['theirs', 'nobody']) {
        snapshot.mockClear();
        const response = await get(req('proj-1', named));
        expect(response.status).toBe(200);
        expect((snapshot.mock.calls[0] as unknown[])[0]).not.toHaveProperty('agentId');
      }
    });
  });
});
