/**
 * `GET /api/agents` — the workspace's agent list over the kernel
 * `agent-directory` contract.
 *
 * The REAL `resolveSessionContext` runs (only its stores are doubles), so every
 * deny gate the catch-all applies to a cookie caller is exercised here: no
 * cookie, no project, a disabled account, a non-member, a sentinel agent id.
 * The provider's own refusal (its feature gate) is answered with its status, a
 * missing provider is 503, and a granted list is answered verbatim — the host
 * shapes nothing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SessionContext, WorkspaceAgentRecord } from '@neuralis/package-system/contracts';

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getUserById: vi.fn(),
  listProjectsForUser: vi.fn(),
  getProjectById: vi.fn(),
  listAgents: vi.fn(),
  mounted: true,
}));

vi.mock('@/server/auth/session', () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock('@/server/store/UserStore', () => ({
  getUserById: mocks.getUserById,
  isActiveUser: (u: { status?: string } | null) => !!u && (u.status ?? 'active') === 'active',
}));
vi.mock('@/server/store/ProjectStore', () => ({
  listProjectsForUser: mocks.listProjectsForUser,
  getProjectById: mocks.getProjectById,
}));
vi.mock('@/server/auth/projectRoleContext', () => ({
  resolveProjectRoleContext: () => ({
    role: 'member',
    priority: 20,
    rolePriorities: { member: 20 },
    grantedFeatures: ['core.agents'],
    agentAccess: 'own',
  }),
}));
vi.mock('@/server/auth/resolveVerifiedAgentScope', () => ({ resolveVerifiedAgentScope: async () => undefined }));
vi.mock('@/server/host/bootstrap', () => ({
  getRuntime: async () => ({
    whenReady: async () => {},
    services: {
      get: (id: string) => (id === 'agent-directory' && mocks.mounted ? { listAgents: mocks.listAgents } : undefined),
    },
  }),
}));

import { GET } from '../route';

const AGENTS: WorkspaceAgentRecord[] = [{ id: 'a1', name: 'Scout', userId: 'u1', config: { appearance: { icon: 'Bot' } } }];

function req(headers: Record<string, string> = { 'x-project-id': 'p1' }, query = ''): NextRequest {
  return new NextRequest(`http://localhost:3100/api/agents${query}`, { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mounted = true;
  mocks.getSessionUser.mockResolvedValue({ id: 'u1' });
  mocks.getUserById.mockResolvedValue({ id: 'u1', status: 'active' });
  mocks.listProjectsForUser.mockResolvedValue([{ id: 'p1' }]);
  mocks.getProjectById.mockResolvedValue({ id: 'p1' });
  mocks.listAgents.mockResolvedValue(AGENTS);
});

describe('GET /api/agents', () => {
  it("answers the provider's list verbatim, for the resolved cookie session", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(AGENTS);
    const session: SessionContext = mocks.listAgents.mock.calls[0]![0];
    expect(session).toMatchObject({ userId: 'u1', projectId: 'p1', role: 'member', grantedFeatures: ['core.agents'] });
  });

  it('the ?projectId the client sends must agree with the header (403), and either one alone is enough', async () => {
    expect((await GET(req({ 'x-project-id': 'p1' }, '?projectId=p2'))).status).toBe(403);
    expect((await GET(req({}, '?projectId=p1'))).status).toBe(200);
  });

  it('401 without a cookie session — the provider is never asked', async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
    expect(mocks.listAgents).not.toHaveBeenCalled();
  });

  it('401 comes BEFORE any request-shape answer: no cookie and no project is still 401', async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    expect((await GET(req({}))).status).toBe(401);
    expect((await GET(req({ 'x-project-id': 'p1' }, '?projectId=p2'))).status).toBe(401);
  });

  it('a user who must change their password is refused (403), like on the package catch-all', async () => {
    mocks.getUserById.mockResolvedValue({ id: 'u1', status: 'active', mustChangePassword: true });
    expect((await GET(req())).status).toBe(403);
    expect(mocks.listAgents).not.toHaveBeenCalled();
  });

  it('400 without a project', async () => {
    expect((await GET(req({}))).status).toBe(400);
    expect(mocks.listAgents).not.toHaveBeenCalled();
  });

  it('403 for a non-member and for a disabled account', async () => {
    mocks.listProjectsForUser.mockResolvedValue([{ id: 'other' }]);
    expect((await GET(req())).status).toBe(403);
    mocks.listProjectsForUser.mockResolvedValue([{ id: 'p1' }]);
    mocks.getUserById.mockResolvedValue({ id: 'u1', status: 'disabled' });
    expect((await GET(req())).status).toBe(403);
    expect(mocks.listAgents).not.toHaveBeenCalled();
  });

  it('a sentinel agent id is refused before the provider is asked', async () => {
    expect((await GET(req({ 'x-project-id': 'p1', 'x-agent-id': '__system__' }))).status).toBe(403);
    expect(mocks.listAgents).not.toHaveBeenCalled();
  });

  it("the provider's refusal (its feature gate) is answered with its status", async () => {
    mocks.listAgents.mockRejectedValue(Object.assign(new Error("Forbidden: missing feature 'core.agents'"), { status: 403 }));
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden: missing feature 'core.agents'" });
  });

  it('an unexpected provider failure is a 500 that carries no detail', async () => {
    mocks.listAgents.mockRejectedValue(new Error('ENOENT /home/secret/agents.json'));
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('/home/secret');
  });

  it('503 with a stable code while no provider is mounted', async () => {
    mocks.mounted = false;
    const res = await GET(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Agent directory not mounted', code: 'agent_directory_unmounted' });
  });
});
