/**
 * `POST /api/invite/redeem` on the real invite service and stores (a temp
 * home): every unusable link answers the SAME bytes, guessing is rate-limited
 * on the login limiter's axes, and only a JSON body is accepted.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'nrs-invite-route-'));
const appRoot = join(root, 'app');

vi.mock('@/server/config/env', () => ({ getEnv: () => ({ appRoot, projectsRoot: join(root, 'projects') }) }));
vi.mock('@/server/store/AuditStore', () => ({ writeAuditLog: vi.fn() }));
vi.mock('@/server/store/PlatformConfigStore', () => ({
  getPlatformConfigStore: () => ({ get: (key: string) => (key === 'inviteLinkTtlHours' ? 168 : undefined) }),
}));
const session = vi.hoisted(() => ({ user: null as null | { id: string; email: string; name: string } }));
vi.mock('@/server/auth/session', () => ({ getSessionUser: async () => session.user }));

const project = {
  id: 'p1',
  name: 'Acme',
  ownerId: 'u-admin',
  members: { 'u-admin': { userId: 'u-admin', name: 'A', email: 'a@x.co', role: 'admin', position: '', tier: 2, addedAt: 't' } },
  roles: {
    admin: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: [], priority: 2 },
    member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 20 },
  },
};
vi.mock('@/server/store/ProjectStore', () => ({
  getProjectById: async () => structuredClone(project),
  updateProject: async (_id: string, patch: (p: typeof project) => object | null) => {
    const produced = patch(structuredClone(project));
    if (produced) Object.assign(project, produced);
    return structuredClone(project);
  },
}));

const { POST } = await import('../route');
const links = await import('@/server/admin/inviteLinks');
const { resetLoginRateLimitForTests } = await import('@/server/auth/rateLimit');

function post(body: unknown, contentType = 'application/json'): Request {
  return new Request('http://localhost:3100/api/invite/redeem', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function wire(res: Response): Promise<string> {
  const headers = [...res.headers.entries()].sort().map(([k, v]) => `${k}: ${v}`).join('\n');
  return `${res.status}\n${headers}\n\n${await res.text()}`;
}

async function issue(email: string): Promise<{ token: string; id: string }> {
  const res = await links.issueInviteLink('u-admin', 'p1', { email }, { interactive: true });
  if (!res.ok) throw new Error(res.error.code);
  return { token: new URLSearchParams(new URL(res.url).hash.slice(1)).get('t')!, id: res.invite.id };
}

beforeEach(async () => {
  await rm(appRoot, { recursive: true, force: true });
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('@neuralis/host:userStore')];
  resetLoginRateLimitForTests();
  session.user = null;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('POST /api/invite/redeem', () => {
  it('unknown, expired, revoked and used links answer byte-identical refusals', async () => {
    const unknown = await wire(await POST(post({ token: 'B'.repeat(43), action: 'inspect' })));

    vi.useFakeTimers({ toFake: ['Date'] });
    const expired = await issue('e@x.co');
    vi.setSystemTime(Date.now() + 169 * 3_600_000);
    const expiredWire = await wire(await POST(post({ token: expired.token, action: 'inspect' })));
    vi.useRealTimers();

    const revoked = await issue('r@x.co');
    await links.revokeInviteLink('u-admin', 'p1', revoked.id, { interactive: true });
    const revokedWire = await wire(await POST(post({ token: revoked.token, action: 'join' })));

    const used = await issue('u@x.co');
    const created = await POST(post({ token: used.token, action: 'create', name: 'U', password: 'Correct-Horse-9-Battery' }));
    expect(created.status).toBe(201);
    const usedWire = await wire(await POST(post({ token: used.token, action: 'create', name: 'U', password: 'Correct-Horse-9-Battery' })));

    expect(unknown).toContain('404');
    expect(unknown).toContain('{"error":"invite_invalid"}');
    expect(expiredWire).toBe(unknown);
    expect(revokedWire).toBe(unknown);
    expect(usedWire).toBe(unknown);
  });

  it('a valid link inspects, and the answer carries no token', async () => {
    const { token } = await issue('n@x.co');
    const res = await POST(post({ token, action: 'inspect' }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ projectName: 'Acme', role: 'member', email: 'n@x.co', account: 'new', session: 'none' });
    expect(text).not.toContain(token);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('join binds to the signed-in account only when its email IS the link\'s', async () => {
    const { token } = await issue('anna@x.co');
    const { createUser } = await import('@/server/store/UserStore');
    const eve = await createUser('eve@x.co', 'Eve', 'h');
    session.user = { id: eve.id, email: 'eve@x.co', name: 'Eve' };
    const res = await POST(post({ token, action: 'join' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'wrong_account' });
    expect((project.members as Record<string, unknown>)[eve.id]).toBeUndefined();
  });

  it('guessing one token is rate-limited after 5 failures from one address', async () => {
    const guess = 'C'.repeat(43);
    for (let i = 0; i < 5; i += 1) expect((await POST(post({ token: guess, action: 'inspect' }))).status).toBe(404);
    const limited = await POST(post({ token: guess, action: 'inspect' }));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('refuses a non-JSON body, an oversized body and an unknown action', async () => {
    expect((await POST(post('token=x&action=join', 'application/x-www-form-urlencoded'))).status).toBe(415);
    expect((await POST(post({ token: 'x'.repeat(5000), action: 'inspect' }))).status).toBe(413);
    expect((await POST(post({ token: 'x', action: 'delete' }))).status).toBe(400);
  });
});
