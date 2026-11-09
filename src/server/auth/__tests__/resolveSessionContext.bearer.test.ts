/**
 * The realtime hub's bearer arm (`acceptBearer`, `/api/events` ONLY): an
 * external client's OAuth token, verified by the SAME resolver as the
 * catch-all's third arm, then every cookie account gate. The other callers
 * stay cookie-only; a session ticket is refused; a present-but-refused bearer
 * is a 401 with the API challenge, never a fall-through; the token binds the
 * project and the agent.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getUserById: vi.fn(),
  listProjectsForUser: vi.fn(),
  getProjectById: vi.fn(),
  resolveVerifiedAgentScope: vi.fn(),
  tryResolvePackageOAuth: vi.fn(),
}));

vi.mock('../session', () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock('@/server/store/UserStore', () => ({
  getUserById: mocks.getUserById,
  isActiveUser: (u: { status?: string } | null) => !!u && (u.status ?? 'active') === 'active',
}));
vi.mock('@/server/store/ProjectStore', () => ({
  listProjectsForUser: mocks.listProjectsForUser,
  getProjectById: mocks.getProjectById,
}));
vi.mock('../projectRoleContext', () => ({
  resolveProjectRoleContext: () => ({ role: 'member', priority: 20, rolePriorities: { member: 20 }, grantedFeatures: ['core.agents'], agentAccess: 'own' }),
}));
vi.mock('../resolveVerifiedAgentScope', () => ({ resolveVerifiedAgentScope: mocks.resolveVerifiedAgentScope }));
vi.mock('../packageOAuthAuth', () => ({
  tryResolvePackageOAuth: mocks.tryResolvePackageOAuth,
  packageApiChallenge: (error?: string) => `Bearer realm="neuralis"${error ? `, error="${error}"` : ''}`,
}));

import { resolveSessionContext, SessionResolutionError } from '../resolveSessionContext';

const req = (authorization?: string, query = '') =>
  new NextRequest(`http://localhost:3100/api/events${query}`, { headers: authorization ? { authorization } : {} });

const MATCH = {
  kind: 'match',
  session: { userId: 'u1', projectId: 'p1', agentId: 'a1', role: 'member', grantedFeatures: ['core.agents'] },
  clientId: 'neuralis-cli',
  scope: 'routes:call',
  expiresAt: 1_900_000_000_000,
};

async function refusal(p: Promise<unknown>): Promise<SessionResolutionError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof SessionResolutionError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUser.mockResolvedValue(null);
  mocks.getUserById.mockResolvedValue({ id: 'u1', status: 'active' });
  mocks.listProjectsForUser.mockResolvedValue([{ id: 'p1' }]);
  mocks.getProjectById.mockResolvedValue({ id: 'p1' });
  mocks.tryResolvePackageOAuth.mockResolvedValue(MATCH);
});

describe('resolveSessionContext — the bearer arm is the hub\'s alone', () => {
  it('without acceptBearer a bearer is never looked at: 401, the verifier not asked (the five cookie routes)', async () => {
    const err = await refusal(resolveSessionContext(req('Bearer eyJ.jwt.sig'), 'p1'));
    expect(err.status).toBe(401);
    expect(mocks.tryResolvePackageOAuth).not.toHaveBeenCalled();
  });

  it('a valid bearer: the token\'s project and agent, the LIVE role, every account gate, the grant\'s expiry handed back', async () => {
    const grants: unknown[] = [];
    const session = await resolveSessionContext(req('Bearer eyJ.jwt.sig'), '', { acceptBearer: true, onBearer: (g) => grants.push(g) });
    expect(session).toMatchObject({ userId: 'u1', projectId: 'p1', agentId: 'a1', role: 'member', priority: 20, grantedFeatures: ['core.agents'] });
    expect(grants).toEqual([{ clientId: 'neuralis-cli', scope: 'routes:call', expiresAt: 1_900_000_000_000 }]);
    expect(mocks.getUserById).toHaveBeenCalledWith('u1');
    expect(mocks.listProjectsForUser).toHaveBeenCalledWith('u1');
    // The token's agent is already access-checked; no raw header resolution runs.
    expect(mocks.resolveVerifiedAgentScope).not.toHaveBeenCalled();
  });

  it('an nrs1. ticket is refused (a skill never subscribes) — the OAuth resolver is not asked', async () => {
    const err = await refusal(resolveSessionContext(req('Bearer nrs1.req.secret'), 'p1', { acceptBearer: true }));
    expect(err.status).toBe(401);
    expect(mocks.tryResolvePackageOAuth).not.toHaveBeenCalled();
  });

  it('a refused bearer is a 401 with the challenge — never a fall-through; no credential at all is a 401 with the bare challenge', async () => {
    mocks.tryResolvePackageOAuth.mockResolvedValueOnce({ kind: 'reject', code: 'invalid_token' });
    const refused = await refusal(resolveSessionContext(req('Bearer garbage'), 'p1', { acceptBearer: true }));
    expect(refused.status).toBe(401);
    expect(refused.headers?.['WWW-Authenticate']).toContain('error="invalid_token"');
    mocks.tryResolvePackageOAuth.mockResolvedValueOnce(null);
    const none = await refusal(resolveSessionContext(req(), 'p1', { acceptBearer: true }));
    expect(none.status).toBe(401);
    expect(none.headers?.['WWW-Authenticate']).toBe('Bearer realm="neuralis"');
  });

  it('the token binds the project and the agent: a different ?projectId= or agentId is a 403', async () => {
    expect((await refusal(resolveSessionContext(req('Bearer eyJ'), 'p2', { acceptBearer: true }))).status).toBe(403);
    expect((await refusal(resolveSessionContext(req('Bearer eyJ', '?agentId=a2'), 'p1', { acceptBearer: true }))).status).toBe(403);
    // Control: the SAME project and agent pass.
    await expect(resolveSessionContext(req('Bearer eyJ', '?agentId=a1'), 'p1', { acceptBearer: true })).resolves.toMatchObject({ projectId: 'p1' });
  });

  it('the bearer\'s user meets the cookie gates: disabled ⇒ 403, a pending password change ⇒ 403, no membership ⇒ 403', async () => {
    mocks.getUserById.mockResolvedValueOnce({ id: 'u1', status: 'disabled' });
    expect((await refusal(resolveSessionContext(req('Bearer eyJ'), '', { acceptBearer: true }))).status).toBe(403);
    mocks.getUserById.mockResolvedValueOnce({ id: 'u1', status: 'active', mustChangePassword: true });
    expect((await refusal(resolveSessionContext(req('Bearer eyJ'), '', { acceptBearer: true }))).status).toBe(403);
    mocks.listProjectsForUser.mockResolvedValueOnce([{ id: 'p-other' }]);
    expect((await refusal(resolveSessionContext(req('Bearer eyJ'), '', { acceptBearer: true }))).status).toBe(403);
  });

  it('displayName: the COOKIE session carries the record\'s name; a bearer session carries none (the client is not the person)', async () => {
    mocks.getUserById.mockResolvedValue({ id: 'u1', status: 'active', name: 'Ada Lovelace' });
    mocks.getSessionUser.mockResolvedValueOnce({ id: 'u1' });
    expect((await resolveSessionContext(req(), 'p1')).displayName).toBe('Ada Lovelace');
    const viaBearer = await resolveSessionContext(req('Bearer eyJ.jwt.sig'), '', { acceptBearer: true });
    expect(viaBearer).not.toHaveProperty('displayName');
  });

  it('a cookie session wins: the bearer is not consulted', async () => {
    mocks.getSessionUser.mockResolvedValueOnce({ id: 'u-cookie' });
    mocks.listProjectsForUser.mockResolvedValueOnce([{ id: 'p1' }]);
    const session = await resolveSessionContext(req('Bearer eyJ'), 'p1', { acceptBearer: true });
    expect(session.userId).toBe('u-cookie');
    expect(mocks.tryResolvePackageOAuth).not.toHaveBeenCalled();
  });
});
