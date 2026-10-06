/**
 * The ONE member resolver and the producers that now ride it.
 *
 * Invariant 2's second half: every path that turns a request, a credential or
 * a stored principal into a session calls ONE chain — user present AND active →
 * project present AND not archived → member → role — and a refused principal
 * gets NO session. The matrix below drives that chain against REAL stores in a
 * temp appRoot; the producer rows then prove each producer delegates to it
 * (the cookie `jwt` callback, the `:3101` cookie decode, the admin guard, the
 * package-route access view, the unattended port, the MCP scope).
 *
 * Every deny row has a paired allow on the SAME fixture with one field flipped,
 * and the rows marked "OLD SHAPE" replay the code this replaced on the same
 * input, where it ADMITS the principal.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { encode } from 'next-auth/jwt';

const appRoot = await mkdtemp(join(tmpdir(), 'nrs-member-session-'));
const SECRET = 'member-session-test-secret-0123456789';

vi.mock('../../config/env', () => ({
  getEnv: () => ({ appRoot, projectsRoot: join(appRoot, 'projects-data'), auth: { secret: SECRET } }),
}));

const sessionMock = vi.hoisted(() => ({ user: { id: 'u-active', email: '', name: '' } as { id: string; email: string; name: string } | null }));
vi.mock('../session', () => ({
  requireSession: async () => {
    if (!sessionMock.user) throw new Error('Unauthorized');
    return sessionMock.user;
  },
  getSessionUser: async () => sessionMock.user,
}));

const { resolveMember, resolveMemberSession, resolveActiveUser, isPrincipalActive } = await import('../memberSession');
const { requireAdmin } = await import('../adminGuard');
const { resolveProjectAccess } = await import('../../projects/access');
const { resolveCodexProjectSession } = await import('../../host/codexCredentialWriter');
const { authOptions } = await import('../authOptions');
const { resolveSessionUser } = await import('../../mcp/resolveSessionUser');

async function seedUser(id: string, over: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    join(appRoot, 'users', `${id}.json`),
    JSON.stringify({
      id, email: `${id}@x.co`, name: id, passwordHash: 'h', status: 'active', mustChangePassword: false,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over,
    }),
    'utf-8',
  );
}

function member(userId: string, role: string) {
  return { userId, name: userId, email: `${userId}@x.co`, role, position: role, tier: role === 'owner' ? 1 : 20, addedAt: '2026-01-01T00:00:00.000Z' };
}

async function seedProject(id: string, over: Record<string, unknown> = {}): Promise<void> {
  const members: Record<string, unknown> = { 'u-owner': member('u-owner', 'owner') };
  for (const u of ['u-active', 'u-disabled', 'u-deleted', 'u-missing', 'u-epoch']) members[u] = member(u, 'admin');
  members['u-norole'] = member('u-norole', 'ghost');
  await writeFile(
    join(appRoot, 'projects', `${id}.json`),
    JSON.stringify({
      id,
      name: id,
      ownerId: 'u-owner',
      members,
      roles: {
        owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
        admin: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['core.execute'], priority: 2 },
      },
      agentOwnership: {},
      limits: { spend: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} }, rateLimitRpm: 30 },
      roleGrantVersion: 18,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...over,
    }),
    'utf-8',
  );
}

beforeAll(async () => {
  await mkdir(join(appRoot, 'projects'), { recursive: true });
  await mkdir(join(appRoot, 'users'), { recursive: true });
  await seedUser('u-owner');
  await seedUser('u-active');
  await seedUser('u-norole');
  await seedUser('u-disabled', { status: 'disabled' });
  await seedUser('u-deleted', { status: 'deleted', email: 'deleted:u-deleted' });
  await seedUser('u-epoch', { sessionEpoch: 3 });
  await seedUser('u-outsider');
  await seedProject('p-live');
  await seedProject('p-archived', { archivedAt: '2026-09-01T00:00:00.000Z' });
});

afterAll(async () => {
  await rm(appRoot, { recursive: true, force: true });
});

describe('resolveMember — the ONE chain', () => {
  it('an active member of a live project resolves, with the full session the port used to build', async () => {
    const resolved = await resolveMember('u-active', 'p-live');
    expect(resolved?.roleDef.canInvite).toBe(true);
    expect(resolved?.member.role).toBe('admin');
    expect(resolved?.session).toEqual({
      userId: 'u-active',
      projectId: 'p-live',
      role: 'admin',
      priority: 2,
      rolePriorities: expect.objectContaining({ owner: 1, admin: 2 }),
      // The migrate-on-read grant repairs may add ids; the member's own grant is there.
      grantedFeatures: expect.arrayContaining(['core.execute']),
      agentAccess: '*',
      agentOwnership: {},
      spendLimits: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} },
      llmRateLimitRpm: 30,
    });
  });

  it.each([
    ['disabled user', 'u-disabled', 'p-live'],
    ['deleted (tombstoned) user', 'u-deleted', 'p-live'],
    ['user with no record', 'u-missing', 'p-live'],
    ['non-member', 'u-outsider', 'p-live'],
    ['member whose role is undefined', 'u-norole', 'p-live'],
    ['active member of an ARCHIVED project', 'u-active', 'p-archived'],
    ['member of a missing project', 'u-active', 'p-none'],
  ])('refuses a %s — no session at all', async (_label, userId, projectId) => {
    expect(await resolveMember(userId, projectId)).toBeNull();
    expect(await resolveMemberSession(userId, projectId)).toBeNull();
  });

  it('OLD SHAPE: the inline port literal this replaced resolved the disabled and the deleted user', async () => {
    // `bootstrap.ts`'s former `resolveProjectMember`, replayed verbatim on the
    // same records — it never read the user.
    const project = JSON.parse(await readFile(join(appRoot, 'projects', 'p-live.json'), 'utf-8')) as {
      archivedAt?: string; members: Record<string, { role: string }>; roles: Record<string, unknown>;
    };
    const oldPort = (userId: string) => {
      if (project.archivedAt != null) return null;
      const m = project.members[userId];
      return m && project.roles[m.role] ? { userId } : null;
    };
    expect(oldPort('u-disabled')).not.toBeNull();
    expect(oldPort('u-deleted')).not.toBeNull();
  });
});

describe('resolveActiveUser — the session epoch', () => {
  it('a token issued under the current epoch passes; a stale one is refused', async () => {
    expect(await resolveActiveUser('u-epoch', { sessionEpoch: 3 })).not.toBeNull();
    expect(await resolveActiveUser('u-epoch', { sessionEpoch: 2 })).toBeNull();
  });

  it('a pre-epoch token (no field) matches an un-bumped record and dies at the first bump', async () => {
    expect(await resolveActiveUser('u-active', {})).not.toBeNull();
    expect(await resolveActiveUser('u-epoch', {})).toBeNull();
  });

  it('no token ⇒ no epoch question (the unattended and MCP paths)', async () => {
    expect(await resolveActiveUser('u-epoch')).not.toBeNull();
    expect(await isPrincipalActive('u-epoch')).toBe(true);
    expect(await isPrincipalActive('u-deleted')).toBe(false);
    expect(await isPrincipalActive('u-disabled')).toBe(false);
  });

  it('with a project the port asks the whole member chain: a non-member or an archived project is inactive THERE while the user stays active', async () => {
    expect(await isPrincipalActive('u-active', 'p-live')).toBe(true);
    expect(await isPrincipalActive('u-outsider')).toBe(true);
    expect(await isPrincipalActive('u-outsider', 'p-live')).toBe(false);
    expect(await isPrincipalActive('u-active', 'p-archived')).toBe(false);
    expect(await isPrincipalActive('u-disabled', 'p-live')).toBe(false);
  });

  it('with a session epoch the port is the OAuth grant check: the issued epoch passes, a reset one (a DIRECT store write, no event) is refused', async () => {
    await seedUser('u-cli', { sessionEpoch: 1 });
    expect(await isPrincipalActive('u-cli', 'p-live', 1)).toBe(false); // not a member of p-live
    expect(await isPrincipalActive('u-cli', undefined, 1)).toBe(true);
    expect(await isPrincipalActive('u-epoch', 'p-live', 3)).toBe(true);
    expect(await isPrincipalActive('u-epoch', 'p-live', 2)).toBe(false);
    expect(await isPrincipalActive('u-active', 'p-live', 0)).toBe(true); // a pre-epoch grant on an un-reset user

    // What `pnpm neuralis:user reset-password` does from another process: the
    // record changes on disk and nothing in this process hears it. Past the
    // store's 2 s read cache the port reads the new epoch.
    await seedUser('u-cli', { sessionEpoch: 2 });
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 5_000);
    try {
      expect(await isPrincipalActive('u-cli', undefined, 1)).toBe(false);
      expect(await isPrincipalActive('u-cli', undefined, 2)).toBe(true);
    } finally {
      clock.mockRestore();
    }
  });
});

describe('producers delegate to the ONE chain', () => {
  it('requireAdmin: an archived project refuses the owner-strength admin; the live one resolves (paired)', async () => {
    sessionMock.user = { id: 'u-active', email: '', name: '' };
    const ctx = await requireAdmin('p-live');
    expect(ctx.memberRole.canInvite).toBe(true);
    expect(ctx.callerPriority).toBe(2);
    await expect(requireAdmin('p-archived')).rejects.toThrow('Not a project member');
  });

  it('requireAdmin: a disabled caller is refused even while the cookie layer is mocked open', async () => {
    sessionMock.user = { id: 'u-disabled', email: '', name: '' };
    await expect(requireAdmin('p-live')).rejects.toThrow('Not a project member');
    sessionMock.user = { id: 'u-active', email: '', name: '' };
  });

  it('resolveProjectAccess and the Codex session refuse the disabled and the deleted user; the active one resolves', async () => {
    for (const u of ['u-disabled', 'u-deleted']) {
      expect(await resolveProjectAccess(u, 'p-live')).toBeNull();
      expect(await resolveCodexProjectSession('p-live', u)).toBeNull();
    }
    expect((await resolveProjectAccess('u-active', 'p-live'))?.role.grantedFeatures).toContain('core.execute');
    expect((await resolveCodexProjectSession('p-live', 'u-active'))?.role).toBe('admin');
    // The Codex session used to skip the archive gate.
    expect(await resolveCodexProjectSession('p-archived', 'u-active')).toBeNull();
  });
});

describe('the cookie `jwt` callback — the producer every getServerSession rides', () => {
  const jwt = authOptions.callbacks!.jwt! as (args: { token: Record<string, unknown>; user?: unknown }) => Promise<Record<string, unknown>>;

  it('an active principal keeps its session, and mustChangePassword is refreshed from the record', async () => {
    const token = await jwt({ token: { userId: 'u-active', email: 'u-active@x.co', mustChangePassword: true } });
    expect(token.mustChangePassword).toBe(false);
  });

  it.each([
    ['disabled', { userId: 'u-disabled' }],
    ['deleted', { userId: 'u-deleted' }],
    ['missing', { userId: 'u-missing' }],
    ['stale epoch', { userId: 'u-epoch', sessionEpoch: 2 }],
    ['pre-epoch token after a bump', { userId: 'u-epoch' }],
  ])('a %s principal gets NO session (the callback throws)', async (_label, token) => {
    await expect(jwt({ token: { ...token } })).rejects.toThrow('Session refused');
  });

  it('never BACKFILLS a missing token epoch from the record', async () => {
    const token = await jwt({ token: { userId: 'u-active' } });
    expect(token.sessionEpoch).toBeUndefined();
  });

  it('a login stamps the issued epoch into the token', async () => {
    const token = await jwt({ token: {}, user: { id: 'u-epoch', email: 'e', name: 'n', mustChangePassword: false, sessionEpoch: 3 } });
    expect(token.sessionEpoch).toBe(3);
  });

  it('OLD SHAPE: the callback this replaced kept the disabled user\'s token', async () => {
    // Replayed verbatim: a record lookup that only copied `mustChangePassword`.
    const record = JSON.parse(await readFile(join(appRoot, 'users', 'u-disabled.json'), 'utf-8')) as { mustChangePassword: boolean };
    const old = (token: Record<string, unknown>) => ({ ...token, mustChangePassword: record.mustChangePassword });
    expect(old({ userId: 'u-disabled' })).toMatchObject({ userId: 'u-disabled' });
  });

  it('a refused session is logged at INFO, never as a server error; other codes still reach console.error', async () => {
    const refused = await jwt({ token: { userId: 'u-disabled' } }).catch((e: unknown) => e);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      authOptions.logger!.error!('JWT_SESSION_ERROR', refused as Error);
      expect(errorSpy).not.toHaveBeenCalled();
      authOptions.logger!.error!('JWT_SESSION_ERROR', new Error('JWT invalid'));
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('resolveSessionUser — the `:3101` raw cookie decode', () => {
  async function cookieFor(token: Record<string, unknown>): Promise<Record<string, string>> {
    const raw = await encode({ token, secret: SECRET });
    return { cookie: `next-auth.session-token=${raw}` };
  }

  it('an active principal resolves; a disabled, deleted or epoch-stale one does not', async () => {
    expect(await resolveSessionUser({ headers: await cookieFor({ userId: 'u-active' }) })).toMatchObject({ userId: 'u-active' });
    expect(await resolveSessionUser({ headers: await cookieFor({ userId: 'u-disabled' }) })).toBeNull();
    expect(await resolveSessionUser({ headers: await cookieFor({ userId: 'u-deleted' }) })).toBeNull();
    expect(await resolveSessionUser({ headers: await cookieFor({ userId: 'u-epoch', sessionEpoch: 2 }) })).toBeNull();
    expect(await resolveSessionUser({ headers: await cookieFor({ userId: 'u-epoch', sessionEpoch: 3 }) })).toMatchObject({ userId: 'u-epoch' });
  });

  it('hands the OAuth consent the epoch the cookie was issued under (a pre-epoch cookie ⇒ 0)', async () => {
    expect(await resolveSessionUser({ headers: await cookieFor({ userId: 'u-epoch', sessionEpoch: 3 }) }))
      .toMatchObject({ sessionEpoch: 3 });
    expect(await resolveSessionUser({ headers: await cookieFor({ userId: 'u-active' }) })).toMatchObject({ sessionEpoch: 0 });
  });
});

describe('no host producer re-inlines the member→role projection (source guard)', () => {
  // The decision lives in `resolveMember`, pinned behaviourally above; these
  // pins only prove each producer DELEGATES. `roles[member.role]` is the
  // signature of the hand-copied projection.
  const root = join(__dirname, '..', '..');
  it.each([
    ['host/bootstrap.ts', 'sessionResolver: { resolveProjectMember: resolveMemberSession }'],
    ['auth/adminGuard.ts', 'await resolveMember(user.id, projectId)'],
    ['host/codexCredentialWriter.ts', 'return resolveMemberSession(userId, projectId);'],
  ])('%s delegates and carries no projection copy', async (file, delegation) => {
    const source = await readFile(join(root, file), 'utf-8');
    expect(source).toContain(delegation);
    expect(source).not.toMatch(/roles\[member\.role\]/);
  });

  it('projects/access.ts: `resolveProjectAccess` delegates (its governance predicates read resolved records, not producers)', async () => {
    const source = await readFile(join(root, 'projects/access.ts'), 'utf-8');
    const start = source.indexOf('export async function resolveProjectAccess(');
    const body = source.slice(start, source.indexOf('\n}\n', start));
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain('await resolveMember(userId, projectId)');
    expect(body).not.toMatch(/roles\[member\.role\]/);
  });

  it('the companion port hides an archived project', async () => {
    const source = await readFile(join(root, 'mcp/startMcpServer.ts'), 'utf-8');
    expect(source).toContain('return project && project.archivedAt == null ? project : null;');
  });
});
