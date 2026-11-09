/**
 * Invite LINKS end to end on real invite + user stores (a temp home): the link
 * is hashed at rest, single use, expiring, revocable, bound to project + role +
 * email; the membership binds only to the account whose email IS the link's;
 * the inviter's floor is re-read at redemption; every unusable link is the same
 * refusal; and the link's origin is the trusted app origin.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectRecord } from '../../store/projectTypes';

const root = await mkdtemp(join(tmpdir(), 'nrs-invite-links-'));
const appRoot = join(root, 'app');

vi.mock('../../config/env', () => ({ getEnv: () => ({ appRoot, projectsRoot: join(root, 'projects') }) }));

const projects = new Map<string, ProjectRecord>();
vi.mock('../../store/ProjectStore', () => ({
  getProjectById: async (id: string) => structuredClone(projects.get(id) ?? null),
  updateProject: async (id: string, patch: (p: ProjectRecord) => Partial<ProjectRecord> | null) => {
    const current = projects.get(id);
    if (!current) return null;
    const produced = patch(structuredClone(current));
    if (produced === null) return structuredClone(current);
    const next = { ...current, ...produced };
    projects.set(id, next);
    return structuredClone(next);
  },
}));

const audit = vi.fn();
vi.mock('../../store/AuditStore', () => ({ writeAuditLog: (...a: unknown[]) => audit(...a) }));

const config: Record<string, unknown> = { inviteLinkTtlHours: 168 };
vi.mock('../../store/PlatformConfigStore', () => ({ getPlatformConfigStore: () => ({ get: (k: string) => config[k] }) }));

const { createUser, findUserByEmail, getUserById } = await import('../../store/UserStore');
const { inviteTokenHash } = await import('../../store/InviteStore');
const links = await import('../inviteLinks');

const ROLES: ProjectRecord['roles'] = {
  owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
  admin: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: [], priority: 2 },
  member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 20 },
};

function seedProject(): void {
  projects.set('p1', {
    id: 'p1',
    name: 'Acme',
    ownerId: 'u-owner',
    members: {
      'u-owner': { userId: 'u-owner', name: 'O', email: 'o@x.co', role: 'owner', position: '', tier: 1, addedAt: 't' },
      'u-admin': { userId: 'u-admin', name: 'A', email: 'a@x.co', role: 'admin', position: '', tier: 2, addedAt: 't' },
      'u-member': { userId: 'u-member', name: 'M', email: 'm@x.co', role: 'member', position: '', tier: 20, addedAt: 't' },
    },
    roles: structuredClone(ROLES),
    agentOwnership: {},
    limits: { spend: {} },
  } as unknown as ProjectRecord);
}

const PERSON = { interactive: true };
const STRONG_PASSWORD = 'Correct-Horse-9-Battery';

function tokenOf(url: string): string {
  const fragment = new URL(url).hash.slice(1);
  return new URLSearchParams(fragment).get('t') ?? '';
}

async function issue(email = 'new@x.co', role = 'member', caller = 'u-admin'): Promise<{ token: string; url: string; id: string }> {
  const res = await links.issueInviteLink(caller, 'p1', { email, role }, PERSON);
  if (!res.ok) throw new Error(`issue failed: ${res.error.code}`);
  return { token: tokenOf(res.url), url: res.url, id: res.invite.id };
}

beforeEach(async () => {
  await rm(appRoot, { recursive: true, force: true });
  // The user store keeps a 2 s read cache on its globalThis slot: a fresh home needs a fresh store.
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('@neuralis/host:userStore')];
  seedProject();
  audit.mockReset();
  config.inviteLinkTtlHours = 168;
  delete process.env.APP_URL;
  delete process.env.NEXTAUTH_URL;
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('issue', () => {
  it('builds the link from the declared app origin, the token in the FRAGMENT', async () => {
    process.env.APP_URL = 'https://neuralis.acme.example/some/path';
    const { url, token } = await issue();
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://neuralis.acme.example');
    expect(parsed.pathname).toBe('/invite');
    expect(parsed.search).toBe('');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('with nothing declared, the link uses the dev default — never anything a request supplied', async () => {
    const { url } = await issue();
    expect(new URL(url).origin).toBe('http://localhost:3100');
    // The issuing service has no request to read: the origin's ONE source is the trusted resolver.
    const src = readFileSync(join(__dirname, '../inviteLinks.ts'), 'utf-8');
    expect(src).toMatch(/\$\{resolveTrustedAppOrigin\(\)\}\/invite#t=/);
    expect(src).not.toMatch(/headers\.get\(|request\.url|nextUrl/);
  });

  it('stores only the SHA-256 of the token — the file name and its bytes carry no token', async () => {
    const { token } = await issue();
    const files = await readdir(join(appRoot, 'invites'));
    expect(files).toEqual([`${inviteTokenHash(token)}.json`]);
    const bytes = await readFile(join(appRoot, 'invites', files[0]!), 'utf-8');
    expect(bytes).not.toContain(token);
    expect(JSON.parse(bytes)).toMatchObject({ projectId: 'p1', role: 'member', email: 'new@x.co', inviterUserId: 'u-admin' });
  });

  it('expires after the inviteLinkTtlHours key', async () => {
    config.inviteLinkTtlHours = 2;
    const res = await links.issueInviteLink('u-admin', 'p1', { email: 'new@x.co' }, PERSON);
    if (!res.ok) throw new Error('issue failed');
    expect(Date.parse(res.invite.expiresAt) - Date.parse(res.invite.createdAt)).toBe(2 * 60 * 60 * 1000);
  });

  it('needs canInvite, and a role no stronger than the caller (live record)', async () => {
    expect(await links.issueInviteLink('u-member', 'p1', { email: 'x@x.co' }, PERSON)).toEqual({ ok: false, error: { code: 'not_invite_capable' } });
    expect(await links.issueInviteLink('u-admin', 'p1', { email: 'x@x.co', role: 'owner' }, PERSON)).toEqual({ ok: false, error: { code: 'role_too_strong' } });
    expect(await links.issueInviteLink('u-admin', 'p1', { email: 'not-an-email' }, PERSON)).toEqual({ ok: false, error: { code: 'invalid_email' } });
    expect(await links.issueInviteLink('u-stranger', 'p1', { email: 'x@x.co' }, PERSON)).toEqual({ ok: false, error: { code: 'caller_not_member' } });
  });

  it('an EXISTING user can be invited; a current member cannot', async () => {
    const other = await createUser('multi@x.co', 'Multi', 'h');
    await expect(issue('Multi@X.co')).resolves.toMatchObject({ token: expect.any(String) });
    projects.get('p1')!.members[other.id] = { userId: other.id, name: 'Multi', email: 'multi@x.co', role: 'member', position: '', tier: 20, addedAt: 't' };
    expect(await links.issueInviteLink('u-admin', 'p1', { email: 'multi@x.co' }, PERSON)).toEqual({ ok: false, error: { code: 'already_member' } });
  });

  it('audits the issue, naming the agent when an agent made it', async () => {
    await links.issueInviteLink('u-admin', 'p1', { email: 'new@x.co' }, { interactive: false, agentId: 'scout' });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.invite.issue',
        userId: 'u-admin',
        details: expect.objectContaining({ projectId: 'p1', email: 'new@x.co', role: 'member', interactive: false, agentId: 'scout' }),
      }),
    );
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/#t=/);
  });
});

describe('list and revoke', () => {
  it('lists pending links without the token, and a revoked link is gone and dead', async () => {
    const { token, id } = await issue();
    const listed = await links.listInviteLinks('u-admin', 'p1');
    expect(listed).toMatchObject({ ok: true, invites: [{ id, email: 'new@x.co', role: 'member', invitedBy: 'u-admin' }] });
    expect(JSON.stringify(listed)).not.toContain(token);
    expect(await links.revokeInviteLink('u-admin', 'p1', id, PERSON)).toEqual({ ok: true });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.invite.revoke', target: id }));
    expect(await links.listInviteLinks('u-admin', 'p1')).toEqual({ ok: true, invites: [] });
    expect(await links.inspectInvite(token, null)).toEqual({ ok: false, code: links.INVITE_INVALID });
  });

  it('an unknown link and one the caller may not touch are the same not_found', async () => {
    const ownerLink = await issue('o2@x.co', 'owner', 'u-owner');
    expect(await links.revokeInviteLink('u-admin', 'p1', 'nope', PERSON)).toEqual({ ok: false, error: { code: 'not_found' } });
    // An admin cannot issue an owner link, so it cannot withdraw one either — and learns nothing.
    expect(await links.revokeInviteLink('u-admin', 'p1', ownerLink.id, PERSON)).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(await links.revokeInviteLink('u-member', 'p1', ownerLink.id, PERSON)).toEqual({ ok: false, error: { code: 'not_invite_capable' } });
    expect(await links.revokeInviteLink('u-owner', 'p1', ownerLink.id, { interactive: false, agentId: 'scout' })).toEqual({ ok: true });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.invite.revoke', details: expect.objectContaining({ agentId: 'scout' }) }));
  });
});

describe('redeem — a new account', () => {
  it('creates the account with the invitee\'s own password, adds the membership, and the link is spent', async () => {
    const { token } = await issue();
    const inspected = await links.inspectInvite(token, null);
    expect(inspected).toEqual({
      ok: true,
      invite: expect.objectContaining({ projectName: 'Acme', role: 'member', email: 'new@x.co', account: 'new', session: 'none', appOrigin: 'http://localhost:3100' }),
    });
    const res = await links.redeemInviteNewAccount(token, { name: 'Nia', password: STRONG_PASSWORD });
    expect(res).toEqual({ ok: true, email: 'new@x.co' });
    const user = await findUserByEmail('new@x.co');
    expect(user).toMatchObject({ name: 'Nia', status: 'active', mustChangePassword: false, invitedBy: 'u-admin' });
    expect(user!.passwordHash).not.toContain(STRONG_PASSWORD);
    expect(projects.get('p1')!.members[user!.id]).toMatchObject({ role: 'member', tier: 20, email: 'new@x.co' });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'user.invite.redeem', userId: user!.id, details: expect.objectContaining({ account: 'new', joined: true }) }));
    // Single use: the second redemption is refused like an unknown token.
    expect(await links.redeemInviteNewAccount(token, { name: 'Nia', password: STRONG_PASSWORD })).toEqual({ ok: false, code: links.INVITE_INVALID });
    expect(await readdir(join(appRoot, 'invites'))).toEqual([]);
  });

  it('a weak password or an existing account refuses WITHOUT spending the link', async () => {
    const { token } = await issue();
    expect(await links.redeemInviteNewAccount(token, { name: 'Nia', password: 'short' })).toMatchObject({ ok: false, code: 'password_policy' });
    await createUser('new@x.co', 'Already', 'h');
    expect(await links.redeemInviteNewAccount(token, { name: 'Nia', password: STRONG_PASSWORD })).toEqual({ ok: false, code: 'account_exists' });
    expect(await links.inspectInvite(token, null)).toMatchObject({ ok: true, invite: { account: 'existing' } });
  });

  it('two concurrent redemptions: exactly one wins', async () => {
    const { token } = await issue();
    const results = await Promise.all([
      links.redeemInviteNewAccount(token, { name: 'One', password: STRONG_PASSWORD }),
      links.redeemInviteNewAccount(token, { name: 'Two', password: STRONG_PASSWORD }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([expect.objectContaining({ ok: false })]);
  });
});

describe('redeem — an existing account (the membership binds to the INVITED email only)', () => {
  it('a signed-in session of ANOTHER email is refused and does not spend the link; the invited account joins', async () => {
    const invitee = await createUser('anna@x.co', 'Anna', 'h');
    const stranger = await createUser('eve@x.co', 'Eve', 'h');
    const { token } = await issue('anna@x.co');

    expect(await links.inspectInvite(token, stranger.id)).toMatchObject({ ok: true, invite: { account: 'existing', session: 'other' } });
    expect(await links.redeemInviteExistingAccount(token, stranger.id)).toEqual({ ok: false, code: 'wrong_account' });
    expect(projects.get('p1')!.members[stranger.id]).toBeUndefined();
    expect(await links.redeemInviteExistingAccount(token, null)).toEqual({ ok: false, code: 'sign_in_required' });

    expect(await links.inspectInvite(token, invitee.id)).toMatchObject({ ok: true, invite: { session: 'invitee' } });
    expect(await links.redeemInviteExistingAccount(token, invitee.id)).toEqual({ ok: true, projectId: 'p1', alreadyMember: false });
    expect(projects.get('p1')!.members[invitee.id]).toMatchObject({ role: 'member' });
    expect(projects.get('p1')!.members[stranger.id]).toBeUndefined();
    expect(await links.redeemInviteExistingAccount(token, invitee.id)).toEqual({ ok: false, code: links.INVITE_INVALID });
  });

  it('a link never re-roles someone who is already a member', async () => {
    const invitee = await createUser('anna@x.co', 'Anna', 'h');
    const { token } = await issue('anna@x.co', 'admin', 'u-owner');
    projects.get('p1')!.members[invitee.id] = { userId: invitee.id, name: 'Anna', email: 'anna@x.co', role: 'member', position: '', tier: 20, addedAt: 't' };
    expect(await links.redeemInviteExistingAccount(token, invitee.id)).toEqual({ ok: true, projectId: 'p1', alreadyMember: true });
    expect(projects.get('p1')!.members[invitee.id]!.role).toBe('member');
    expect(await getUserById(invitee.id)).toMatchObject({ email: 'anna@x.co' });
  });
});

describe('every unusable link is the SAME refusal', () => {
  it('unknown, malformed, expired, revoked, used, demoted inviter, archived project', async () => {
    const invalid = { ok: false, code: links.INVITE_INVALID };
    expect(await links.inspectInvite('A'.repeat(43), null)).toEqual(invalid);
    expect(await links.inspectInvite('not a token', null)).toEqual(invalid);
    expect(await links.inspectInvite(undefined, null)).toEqual(invalid);

    vi.useFakeTimers({ toFake: ['Date'] });
    const expired = await issue('e@x.co');
    vi.setSystemTime(Date.now() + 169 * 60 * 60 * 1000);
    expect(await links.inspectInvite(expired.token, null)).toEqual(invalid);
    vi.useRealTimers();

    const revoked = await issue('r@x.co');
    await links.revokeInviteLink('u-admin', 'p1', revoked.id, PERSON);
    expect(await links.inspectInvite(revoked.token, null)).toEqual(invalid);

    const used = await issue('u@x.co');
    await links.redeemInviteNewAccount(used.token, { name: 'U', password: STRONG_PASSWORD });
    expect(await links.inspectInvite(used.token, null)).toEqual(invalid);

    const demoted = await issue('d@x.co');
    projects.get('p1')!.roles.admin = { ...ROLES.admin!, canInvite: false };
    expect(await links.inspectInvite(demoted.token, null)).toEqual(invalid);
    expect(await links.redeemInviteNewAccount(demoted.token, { name: 'D', password: STRONG_PASSWORD })).toEqual(invalid);
    projects.get('p1')!.roles.admin = structuredClone(ROLES.admin!);

    const archived = await issue('a2@x.co');
    projects.get('p1')!.archivedAt = '2026-10-24T00:00:00.000Z';
    expect(await links.inspectInvite(archived.token, null)).toEqual(invalid);
  });

  it('an inviter demoted BETWEEN the check and the write: nothing joins, the fresh account is removed', async () => {
    const { token } = await issue('late@x.co');
    const realGet = projects.get.bind(projects);
    let reads = 0;
    // Read 1 is the live check, read 2 the project's write chain: demote the inviter in between.
    vi.spyOn(projects, 'get').mockImplementation((id: string) => {
      reads += 1;
      const record = realGet(id);
      if (record && reads === 2) record.members['u-admin'] = { ...record.members['u-admin']!, role: 'member' };
      return record;
    });
    expect(await links.redeemInviteNewAccount(token, { name: 'Late', password: STRONG_PASSWORD })).toEqual({ ok: false, code: links.INVITE_INVALID });
    expect(await findUserByEmail('late@x.co')).toBeNull();
  });
});
