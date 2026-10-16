/**
 * The catch-all's third identity arm — an external client's OAuth bearer for
 * the host API resource. Precedence cookie → ticket → OAuth; the OAuth arm
 * carries the COOKIE arm's account gates (active user, `mustChangePassword`,
 * membership, live role), is pinned to the token's project and agent, writes a
 * token-free `cli.session_call` row, and dispatches with `interactive: false`.
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const routePackage = vi.fn(async () => ({ status: 200, body: { ok: true } }));
  return {
    routePackage,
    getSessionUser: vi.fn(async (): Promise<{ id: string; email: string; name: string } | null> => null),
    tryResolveSessionTicket: vi.fn(async (): Promise<unknown> => null),
    tryResolvePackageOAuth: vi.fn(async (): Promise<unknown> => null),
    resolveProjectRoleContext: vi.fn(),
    getRuntime: vi.fn(async () => ({ whenReady: async () => undefined, routePackage })),
    listProjectsForUser: vi.fn(async () => [{ id: 'p1' }]),
    getProjectById: vi.fn(async () => ({ id: 'p1' })),
    getUserById: vi.fn(async (): Promise<Record<string, unknown> | null> => ({ id: 'u1', status: 'active' })),
    writeAuditLog: vi.fn(),
    ensureProjectPackagesLoaded: vi.fn(async () => undefined),
    resolveAgentAxis: vi.fn(async () => ({ agentId: 'a1', denied: false })),
  };
});

vi.mock('@/server/auth/session', () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock('@/server/auth/sessionTicketAuth', () => ({ tryResolveSessionTicket: mocks.tryResolveSessionTicket }));
vi.mock('@/server/auth/packageOAuthAuth', () => ({
  tryResolvePackageOAuth: mocks.tryResolvePackageOAuth,
  packageApiChallenge: (error?: string) => `Bearer realm="neuralis", resource_metadata="http://localhost:3101/.well-known/oauth-protected-resource/api"${error ? `, error="${error}"` : ''}`,
}));
vi.mock('@/server/auth/resolveSessionContext', () => ({ resolveProjectRoleContext: mocks.resolveProjectRoleContext }));
vi.mock('@/server/auth/resolveVerifiedAgentScope', () => ({ resolveAgentAxis: mocks.resolveAgentAxis }));
vi.mock('@/server/host/bootstrap', () => ({ getRuntime: mocks.getRuntime }));
vi.mock('@/server/logging/hostLogger', () => ({ logRuntimeWait: vi.fn() }));
vi.mock('@/server/store/ProjectStore', () => ({ listProjectsForUser: mocks.listProjectsForUser, getProjectById: mocks.getProjectById }));
vi.mock('@/server/store/UserStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/store/UserStore')>()),
  getUserById: mocks.getUserById,
}));
vi.mock('@/server/store/AuditStore', () => ({ writeAuditLog: mocks.writeAuditLog }));
vi.mock('@/server/packages/projectPackages', () => ({ ensureProjectPackagesLoaded: mocks.ensureProjectPackagesLoaded }));

import { GET, POST } from '../[...path]/route';

const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.payload.signature';
const oauthSession = { userId: 'u1', projectId: 'p1', agentId: 'a1', role: 'owner', grantedFeatures: ['*'] };
const LIVE_ROLE = { role: 'member', priority: 20, rolePriorities: { member: 20 }, grantedFeatures: ['core.observe'], agentAccess: 'own' };

function req(url: string, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }, init: { method?: string } = {}) {
  return new NextRequest(url, { headers: new Headers(headers), ...init });
}
const params = { params: Promise.resolve({ path: ['agent-core', 'cli', 'session'] }) };
const dispatched = () => (mocks.routePackage.mock.calls[0] as unknown[] | undefined)?.[1] as { session: Record<string, unknown>; interactive: boolean } | undefined;
const auditRow = (action: string) => mocks.writeAuditLog.mock.calls.map((c) => c[0] as Record<string, unknown>).find((r) => r.action === action);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUser.mockResolvedValue(null);
  mocks.tryResolveSessionTicket.mockResolvedValue(null);
  mocks.tryResolvePackageOAuth.mockResolvedValue({ kind: 'match', session: oauthSession, clientId: 'neuralis-cli', scope: 'routes:call' });
  mocks.getUserById.mockResolvedValue({ id: 'u1', status: 'active' });
  mocks.listProjectsForUser.mockResolvedValue([{ id: 'p1' }]);
  mocks.resolveProjectRoleContext.mockReturnValue(LIVE_ROLE);
});

describe('catch-all OAuth arm — dispatch', () => {
  it('dispatches as the token\'s user/project/agent with the LIVE role, interactive:false, and a token-free audit row', async () => {
    const res = await GET(req('http://localhost:3100/api/packages/agent-core/cli/session'), params);
    expect(res.status).toBe(200);
    const call = dispatched()!;
    expect(call.interactive).toBe(false);
    // The role comes from the live project record (the cookie arm's resolver), never the verifier's answer.
    expect(call.session).toMatchObject({ userId: 'u1', projectId: 'p1', agentId: 'a1', role: 'member', grantedFeatures: ['core.observe'] });
    const row = auditRow('cli.session_call')!;
    expect(row).toMatchObject({ userId: 'u1', details: { projectId: 'p1', agentId: 'a1', clientId: 'neuralis-cli', scope: 'routes:call' } });
    expect(JSON.stringify(mocks.writeAuditLog.mock.calls)).not.toContain(TOKEN);
  });

  it('a body cannot make the call interactive', async () => {
    const res = await POST(req('http://localhost:3100/api/packages/agent-core/x', { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, { method: 'POST' }), params);
    expect(res.status).toBe(200);
    expect(dispatched()!.interactive).toBe(false);
  });

  it('a header may only AGREE with the token\'s project and agent', async () => {
    expect((await GET(req('http://localhost:3100/api/packages/agent-core/x', { authorization: `Bearer ${TOKEN}`, 'x-project-id': 'p2' }), params)).status).toBe(403);
    expect((await GET(req('http://localhost:3100/api/packages/agent-core/x?agentId=a2'), params)).status).toBe(403);
    expect(mocks.routePackage).not.toHaveBeenCalled();
    // control: agreeing values dispatch
    expect((await GET(req('http://localhost:3100/api/packages/agent-core/x?agentId=a1', { authorization: `Bearer ${TOKEN}`, 'x-project-id': 'p1' }), params)).status).toBe(200);
  });
});

describe('catch-all OAuth arm — the cookie arm\'s account gates', () => {
  it('mustChangePassword: OAuth 403 · cookie 403 · ticket allowed (the existing contract)', async () => {
    mocks.getUserById.mockResolvedValue({ id: 'u1', status: 'active', mustChangePassword: true });
    expect((await GET(req('http://localhost:3100/api/packages/agent-core/x'), params)).status).toBe(403);
    mocks.getSessionUser.mockResolvedValueOnce({ id: 'u1', email: 'u1@x', name: 'U' });
    expect((await GET(req('http://localhost:3100/api/packages/agent-core/x', { 'x-project-id': 'p1' }), params)).status).toBe(403);
    mocks.tryResolveSessionTicket.mockResolvedValueOnce({ kind: 'match', session: { ...oauthSession, requestId: 'r' } });
    expect((await GET(req('http://localhost:3100/api/packages/agent-core/x', { authorization: 'Bearer nrs1.r.s' }), params)).status).toBe(200);
  });

  it('a disabled user and a removed membership are refused; nothing dispatches', async () => {
    mocks.getUserById.mockResolvedValueOnce({ id: 'u1', status: 'disabled' });
    expect((await GET(req('http://localhost:3100/api/packages/agent-core/x'), params)).status).toBe(403);
    mocks.listProjectsForUser.mockResolvedValueOnce([]);
    expect((await GET(req('http://localhost:3100/api/packages/agent-core/x'), params)).status).toBe(403);
    expect(mocks.routePackage).not.toHaveBeenCalled();
  });
});

describe('catch-all OAuth arm — precedence and refusals', () => {
  it('a cookie wins: the bearer is never asked', async () => {
    mocks.getSessionUser.mockResolvedValueOnce({ id: 'u1', email: 'u1@x', name: 'U' });
    await GET(req('http://localhost:3100/api/packages/agent-core/x', { authorization: `Bearer ${TOKEN}`, 'x-project-id': 'p1' }), params);
    expect(mocks.tryResolvePackageOAuth).not.toHaveBeenCalled();
    expect(dispatched()!.interactive).toBe(true);
  });

  it('a PRESENT invalid ticket is a hard 401 — the OAuth arm is never reached', async () => {
    mocks.tryResolveSessionTicket.mockResolvedValueOnce({ kind: 'reject', code: 'bad_secret', message: 'bad' });
    const res = await GET(req('http://localhost:3100/api/packages/agent-core/x', { authorization: 'Bearer nrs1.r.bad' }), params);
    expect(res.status).toBe(401);
    expect(mocks.tryResolvePackageOAuth).not.toHaveBeenCalled();
  });

  it('a refused bearer is 401 with the RFC 6750 challenge and its code; no credential is 401 with the discovery challenge', async () => {
    mocks.tryResolvePackageOAuth.mockResolvedValueOnce({ kind: 'reject', code: 'wrong_resource' });
    const refused = await GET(req('http://localhost:3100/api/packages/agent-core/x'), params);
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect(await refused.json()).toEqual({ error: 'Access token refused', code: 'wrong_resource' });
    mocks.tryResolvePackageOAuth.mockResolvedValueOnce(null);
    const bare = await GET(req('http://localhost:3100/api/packages/agent-core/x', {}), params);
    expect(bare.status).toBe(401);
    expect(bare.headers.get('www-authenticate')).toContain('resource_metadata="http://localhost:3101/.well-known/oauth-protected-resource/api"');
    expect(mocks.routePackage).not.toHaveBeenCalled();
  });
});
