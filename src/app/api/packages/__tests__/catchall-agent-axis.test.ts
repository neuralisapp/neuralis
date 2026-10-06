/**
 * The catch-all's COOKIE plane asks whether the caller may use the agent it
 * names, before the agent becomes `session.agentId`.
 *
 * On this route the agent is a POLICY input for the package routes behind it
 * (uri-policy `byAgent`, `$self`, the shells kill gate), so a named agent the
 * caller may not use is refused with one generic 404 — the same bytes for a
 * foreign agent and a missing one. Collapsing it to "no agent" (the snapshot
 * routes' answer) would serve the request against a different object set than
 * the one asked for. The store is read only when an agent is named; the TICKET
 * plane keeps its own order (`session-call-audit.test.ts` pins that).
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  tryResolveSessionTicket: vi.fn(),
  resolveProjectRoleContext: vi.fn(),
  routePackage: vi.fn(),
  storeGet: vi.fn(),
  listProjectsForUser: vi.fn(),
  getProjectById: vi.fn(),
  getUserById: vi.fn(),
  writeAuditLog: vi.fn(),
  ensureProjectPackagesLoaded: vi.fn(async () => undefined),
}));

vi.mock('@/server/auth/session', () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock('@/server/auth/sessionTicketAuth', () => ({ tryResolveSessionTicket: mocks.tryResolveSessionTicket }));
vi.mock('@/server/auth/resolveSessionContext', () => ({ resolveProjectRoleContext: mocks.resolveProjectRoleContext }));
vi.mock('@/server/host/bootstrap', async () => {
  const { stubRuntime, ownAgentDirectory } = await import('@/testing/stubRuntime');
  return {
    getRuntime: async () =>
      stubRuntime({ routePackage: mocks.routePackage }, { 'agent-directory': ownAgentDirectory(mocks.storeGet) }),
  };
});
vi.mock('@/server/logging/hostLogger', () => ({ logRuntimeWait: vi.fn() }));
vi.mock('@/server/store/ProjectStore', () => ({
  listProjectsForUser: mocks.listProjectsForUser,
  getProjectById: mocks.getProjectById,
}));
vi.mock('@/server/store/UserStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/store/UserStore')>()),
  getUserById: mocks.getUserById,
}));
vi.mock('@/server/store/AuditStore', () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock('@/server/packages/projectPackages', () => ({ ensureProjectPackagesLoaded: mocks.ensureProjectPackagesLoaded }));

import { GET } from '../[...path]/route';

const AGENTS: Record<string, { id: string; userId: string }> = {
  mine: { id: 'mine', userId: 'u1' },
  theirs: { id: 'theirs', userId: 'u2' },
};

function call(url: string, headers: Record<string, string> = {}) {
  return GET(new NextRequest(url, { headers: new Headers({ 'x-project-id': 'p1', ...headers }) }), {
    params: Promise.resolve({ path: ['agent-core', 'conversations'] }),
  });
}

function dispatchedSession(): Record<string, unknown> {
  return (mocks.routePackage.mock.calls[0]![1] as { session: Record<string, unknown> }).session;
}

describe('catch-all COOKIE plane — the named agent is verified before it becomes session.agentId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 'u1', email: '', name: '' });
    mocks.tryResolveSessionTicket.mockResolvedValue(null);
    mocks.getUserById.mockResolvedValue({ id: 'u1', status: 'active', mustChangePassword: false });
    mocks.listProjectsForUser.mockResolvedValue([{ id: 'p1' }]);
    mocks.getProjectById.mockResolvedValue({ id: 'p1' });
    mocks.resolveProjectRoleContext.mockReturnValue({
      role: 'member', priority: 20, rolePriorities: { member: 20 }, grantedFeatures: ['core.execute'],
      agentAccess: 'own', agentOwnership: {}, spendLimits: undefined, llmRateLimitRpm: undefined,
    });
    mocks.routePackage.mockResolvedValue({ status: 200, body: { ok: true } });
    mocks.storeGet.mockImplementation(async (id: string) => AGENTS[id] ?? null);
  });

  it('no agent named: dispatched with no agent and the agent store is never read', async () => {
    const res = await call('http://localhost:3100/api/packages/agent-core/conversations');
    expect(res.status).toBe(200);
    expect(mocks.storeGet).not.toHaveBeenCalled();
    expect(dispatchedSession().agentId).toBeUndefined();
  });

  it('the caller\'s OWN agent, by header or by query, is dispatched as the session agent', async () => {
    expect((await call('http://localhost:3100/api/packages/agent-core/conversations', { 'x-agent-id': 'mine' })).status).toBe(200);
    expect(dispatchedSession().agentId).toBe('mine');
    mocks.routePackage.mockClear();
    expect((await call('http://localhost:3100/api/packages/agent-core/conversations?agentId=mine')).status).toBe(200);
    expect(dispatchedSession().agentId).toBe('mine');
  });

  // Paired with the row above: only the named agent changes. The old catch-all
  // dispatched `theirs` as the session agent without asking.
  it('a FOREIGN agent and a MISSING agent get the same generic 404, and nothing is dispatched', async () => {
    const foreign = await call('http://localhost:3100/api/packages/agent-core/conversations', { 'x-agent-id': 'theirs' });
    const missing = await call('http://localhost:3100/api/packages/agent-core/conversations?agentId=nobody');
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await foreign.text()).toBe(await missing.text());
    expect(mocks.routePackage).not.toHaveBeenCalled();
  });

  it('a sentinel agent id is still the 403 sentinel refusal, decided before any store read', async () => {
    const res = await call('http://localhost:3100/api/packages/agent-core/conversations', { 'x-agent-id': '__system__' });
    expect(res.status).toBe(403);
    expect(mocks.storeGet).not.toHaveBeenCalled();
  });

  it('the TICKET plane is unchanged: a named target is not looked up here', async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    mocks.tryResolveSessionTicket.mockResolvedValue({
      kind: 'match',
      session: { userId: 'u1', projectId: 'p1', agentId: 'mine', requestId: 'r1', role: 'member', grantedFeatures: ['core.execute'] },
      skillId: 'sk',
    });
    const res = await GET(
      new NextRequest('http://localhost:3100/api/packages/agent-core/conversations?agentId=theirs', {
        headers: new Headers({ authorization: 'Bearer nrs1.r1.secret' }),
      }),
      { params: Promise.resolve({ path: ['agent-core', 'conversations'] }) },
    );
    expect(res.status).toBe(200);
    expect(mocks.storeGet).not.toHaveBeenCalled();
    expect(dispatchedSession().agentId).toBe('theirs');
  });
});

describe('catch-all — a user who must change their password reaches no package route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserById.mockResolvedValue({ id: 'u1', status: 'active', mustChangePassword: true });
    mocks.listProjectsForUser.mockResolvedValue([{ id: 'p1' }]);
    mocks.getProjectById.mockResolvedValue({ id: 'p1' });
    mocks.resolveProjectRoleContext.mockReturnValue({
      role: 'member', priority: 20, rolePriorities: { member: 20 }, grantedFeatures: ['project.members'],
      agentAccess: 'own', agentOwnership: {}, spendLimits: undefined, llmRateLimitRpm: undefined,
    });
    mocks.routePackage.mockResolvedValue({ status: 200, body: { ok: true } });
  });

  it('cookie plane: even the admin package `users` path is refused — the change rides the host route', async () => {
    mocks.getSessionUser.mockResolvedValue({ id: 'u1', email: '', name: '' });
    mocks.tryResolveSessionTicket.mockResolvedValue(null);
    const res = await GET(
      new NextRequest('http://localhost:3100/api/packages/admin/users', { headers: new Headers({ 'x-project-id': 'p1' }) }),
      { params: Promise.resolve({ path: ['admin', 'users'] }) },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
    expect(mocks.routePackage).not.toHaveBeenCalled();
  });

  it('control: a session-ticket call for the same user is dispatched', async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    mocks.tryResolveSessionTicket.mockResolvedValue({
      kind: 'match',
      session: { userId: 'u1', projectId: 'p1', requestId: 'r1', role: 'member', grantedFeatures: ['project.members'] },
      skillId: 'sk',
    });
    const res = await GET(
      new NextRequest('http://localhost:3100/api/packages/admin/users', {
        headers: new Headers({ authorization: 'Bearer nrs1.r1.secret' }),
      }),
      { params: Promise.resolve({ path: ['admin', 'users'] }) },
    );
    expect(res.status).toBe(200);
    expect(mocks.routePackage).toHaveBeenCalled();
  });
});
