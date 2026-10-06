/**
 * The `skill.session_call` audit row names the ACTOR, not the target.
 *
 * A skill script running as agent A may address agent B with `?agentId=B` (or
 * the header) — that value used to be logged as the row's `agentId`, masking
 * who actually acted. The row's `agentId` is the ticket's own agent; the
 * addressed agent lands in `targetAgentId`, and only when it differs.
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(async () => null),
  tryResolveSessionTicket: vi.fn(),
  resolveProjectRoleContext: vi.fn(),
  getRuntime: vi.fn(async () => ({
    whenReady: async () => undefined,
    routePackage: vi.fn(async () => ({ status: 200, body: { ok: true } })),
  })),
  listProjectsForUser: vi.fn(async () => [{ id: 'p1' }]),
  getProjectById: vi.fn(async () => ({ id: 'p1' })),
  getUserById: vi.fn(async () => ({ id: 'u1', status: 'active' })),
  writeAuditLog: vi.fn(),
  ensureProjectPackagesLoaded: vi.fn(async () => undefined),
}));

vi.mock('@/server/auth/session', () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock('@/server/auth/sessionTicketAuth', () => ({ tryResolveSessionTicket: mocks.tryResolveSessionTicket }));
vi.mock('@/server/auth/resolveSessionContext', () => ({ resolveProjectRoleContext: mocks.resolveProjectRoleContext }));
vi.mock('@/server/host/bootstrap', () => ({ getRuntime: mocks.getRuntime }));
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
import { FileStoreReadError } from '@neuralis/package-system/data';

const ticketSession = {
  userId: 'u1', projectId: 'p1', agentId: 'agent-a', requestId: 'req-1',
  conversationId: 'c1', role: 'member', priority: 20,
  rolePriorities: { member: 20 }, grantedFeatures: ['core.chat'], agentAccess: 'own' as const,
};

function req(url: string) {
  return new NextRequest(url, { headers: new Headers({ authorization: 'Bearer nrs1.req-1.secret' }) });
}

function sessionCallRow(): Record<string, unknown> | undefined {
  const call = mocks.writeAuditLog.mock.calls.find(
    (c) => (c[0] as { action?: string }).action === 'skill.session_call',
  );
  return call?.[0] as Record<string, unknown> | undefined;
}

describe('skill.session_call — actor vs target agent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue(null);
    mocks.tryResolveSessionTicket.mockResolvedValue({ kind: 'match', session: ticketSession, skillId: 'sk-1' });
    mocks.getUserById.mockResolvedValue({ id: 'u1', status: 'active' });
    mocks.listProjectsForUser.mockResolvedValue([{ id: 'p1' }]);
    mocks.getProjectById.mockResolvedValue({ id: 'p1' });
  });

  it('logs the ticket agent as actor and the addressed agent as targetAgentId when they differ', async () => {
    const res = await GET(req('http://localhost:3100/api/packages/agent-core/conversations?agentId=agent-b'), {
      params: Promise.resolve({ path: ['agent-core', 'conversations'] }),
    });
    expect(res.status).toBe(200);
    const row = sessionCallRow();
    expect(row).toBeDefined();
    const details = row!.details as Record<string, unknown>;
    expect(details.agentId).toBe('agent-a');
    expect(details.targetAgentId).toBe('agent-b');
  });

  it('an AGENT-LESS ticket with a ?agentId target logs NO actor agent and the target separately — never the target as actor', async () => {
    const { agentId: _drop, ...agentlessSession } = ticketSession;
    mocks.tryResolveSessionTicket.mockResolvedValue({ kind: 'match', session: agentlessSession, skillId: 'sk-1' });
    const res = await GET(req('http://localhost:3100/api/packages/agent-core/conversations?agentId=agent-b'), {
      params: Promise.resolve({ path: ['agent-core', 'conversations'] }),
    });
    expect(res.status).toBe(200);
    const details = sessionCallRow()!.details as Record<string, unknown>;
    expect('agentId' in details).toBe(false);
    expect(details.targetAgentId).toBe('agent-b');
  });

  it('logs only the actor when no target is addressed — no targetAgentId key at all', async () => {
    const res = await GET(req('http://localhost:3100/api/packages/agent-core/conversations'), {
      params: Promise.resolve({ path: ['agent-core', 'conversations'] }),
    });
    expect(res.status).toBe(200);
    const details = sessionCallRow()!.details as Record<string, unknown>;
    expect(details.agentId).toBe('agent-a');
    expect('targetAgentId' in details).toBe(false);
  });
});

describe('catch-all — a user record that cannot be read is DENIED, never absent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue(null);
    mocks.tryResolveSessionTicket.mockResolvedValue({ kind: 'match', session: ticketSession, skillId: 'sk-1' });
    mocks.listProjectsForUser.mockResolvedValue([{ id: 'p1' }]);
    mocks.getProjectById.mockResolvedValue({ id: 'p1' });
  });

  for (const kind of ['unreadable', 'unparseable'] as const) {
    it(`${kind} → 403 with a fixed body that carries no path, and nothing is dispatched`, async () => {
      const filePath = '/home/secret/.neuralis/app/users/u1.json';
      mocks.getUserById.mockRejectedValueOnce(new FileStoreReadError(kind, 'u1', filePath));
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const res = await GET(req('http://localhost:3100/api/packages/agent-core/conversations'), {
        params: Promise.resolve({ path: ['agent-core', 'conversations'] }),
      });
      expect(res.status).toBe(403);
      const text = await res.text();
      expect(text).not.toContain('/home');
      expect(text).not.toContain('u1.json');
      expect(mocks.ensureProjectPackagesLoaded).not.toHaveBeenCalled();
      expect(sessionCallRow()).toBeUndefined();
      errors.mockRestore();
    });
  }
});
