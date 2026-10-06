/**
 * The user-record lifecycle against REAL stores in a temp appRoot: the order of
 * an offboarding is only observable on the store signals the revocation fan-out
 * subscribes to (disable first, memberships next, tombstone last), and a
 * producer re-check only means something inside the real per-path chain.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// A fresh appRoot per test: the stores hold a 2 s read cache on `globalThis`,
// so wiping files under a live store would serve the previous test's records.
let appRoot = await mkdtemp(join(tmpdir(), 'nrs-offboard-'));
const roots: string[] = [appRoot];

vi.mock('../../config/env', () => ({
  getEnv: () => ({ appRoot, projectsRoot: join(appRoot, 'projects-data'), auth: { secret: 'test-secret' } }),
}));

const audit = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));
vi.mock('../../store/AuditStore', () => ({
  writeAuditLog: vi.fn(async (row: Record<string, unknown>) => {
    audit.rows.push(row);
  }),
}));

const users = await import('../../store/UserStore');
const projects = await import('../../store/ProjectStore');
const { getCredentialStore, resetCredentialStore } = await import('../../store/credentialStoreInstance');
const lifecycle = await import('../offboardUser');

const ROLES = {
  owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
  member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 20 },
};

function member(userId: string, role: 'owner' | 'member') {
  return { userId, name: userId, email: `${userId}@x.co`, role, position: '', tier: ROLES[role].priority, addedAt: '2026-01-01T00:00:00.000Z' };
}

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

async function seedProject(
  id: string,
  ownerId: string,
  members: Record<string, 'owner' | 'member'>,
  over: Record<string, unknown> = {},
): Promise<void> {
  const record = {
    id,
    name: id.toUpperCase(),
    ownerId,
    members: Object.fromEntries(Object.entries(members).map(([u, r]) => [u, member(u, r)])),
    roles: ROLES,
    agentOwnership: {},
    limits: { spend: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} } },
    roleGrantVersion: 18,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
  await writeFile(join(appRoot, 'projects', `${id}.json`), JSON.stringify(record), 'utf-8');
}

const caller = { userId: 'c', email: 'c@x.co' };

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  audit.rows.length = 0;
  appRoot = await mkdtemp(join(tmpdir(), 'nrs-offboard-'));
  roots.push(appRoot);
  const slots = globalThis as Record<symbol, unknown>;
  delete slots[Symbol.for('@neuralis/host:userStore')];
  delete slots[Symbol.for('@neuralis/host:projectStore')];
  resetCredentialStore();
  for (const dir of ['projects', 'users', 'config']) await mkdir(join(appRoot, dir), { recursive: true });
  for (const id of ['c', 'o', 't', 'x']) await seedUser(id);
});

describe('disable / enable / reset — the epoch rule', () => {
  it('disable bumps the epoch and stamps who; enable restores without a bump', async () => {
    await seedUser('t', { sessionEpoch: 4 });
    expect(await lifecycle.disableUser('t', { kind: 'user', userId: 'c', email: 'c@x.co' })).toBe(true);
    const disabled = await users.getUserById('t');
    expect(disabled).toMatchObject({ status: 'disabled', sessionEpoch: 5, disabledBy: 'c' });
    expect(audit.rows.map((r) => r.action)).toEqual(['user.disable']);

    expect(await lifecycle.enableUser('t', { kind: 'cli', operator: 'root' })).toBe(true);
    const enabled = await users.getUserById('t');
    expect(enabled).toMatchObject({ status: 'active', sessionEpoch: 5 });
    expect(enabled?.disabledAt).toBeUndefined();
    expect(audit.rows[1]).toMatchObject({ action: 'user.enable', userId: null, details: { via: 'cli', operator: 'root' } });
  });

  it('disabling a disabled user changes nothing and audits nothing', async () => {
    await seedUser('t', { status: 'disabled', sessionEpoch: 2 });
    expect(await lifecycle.disableUser('t', { kind: 'user', userId: 'c', email: 'c@x.co' })).toBe(false);
    expect((await users.getUserById('t'))?.sessionEpoch).toBe(2);
    expect(audit.rows).toEqual([]);
  });

  it('a password reset bumps the epoch, forces a change, and audits the target email', async () => {
    const temp = await lifecycle.resetUserPassword('t', { kind: 'user', userId: 'c', email: 'c@x.co' });
    expect(typeof temp).toBe('string');
    const after = await users.getUserById('t');
    expect(after).toMatchObject({ sessionEpoch: 1, mustChangePassword: true, status: 'active' });
    expect(after?.passwordHash).not.toBe('h');
    expect(audit.rows[0]).toMatchObject({ action: 'user.password_reset', target: 't', details: { email: 't@x.co' } });
  });

  it('a tombstone cannot be reset', async () => {
    await users.tombstoneUser('t', 'c');
    expect(await lifecycle.resetUserPassword('t', { kind: 'user', userId: 'c', email: 'c@x.co' })).toBeNull();
  });
});

describe('checkDisableFloor', () => {
  it('refuses the last active owner, naming only the projects the caller is in', async () => {
    await seedUser('o', { status: 'disabled' });
    await seedProject('seen', 'o', { o: 'owner', t: 'owner', c: 'owner' });
    await seedProject('hidden', 'o', { o: 'owner', t: 'owner' });
    await seedProject('fine', 'o', { o: 'owner', t: 'owner', x: 'owner' });
    const all = await projects.listAllProjects({ includeArchived: true });
    const refusal = await lifecycle.checkDisableFloor('c', 't', all);
    expect(refusal).toEqual({
      blocking: [],
      hiddenBlockingCount: 1,
    });
  });

  it('names a visible blocking project', async () => {
    await seedProject('p1', 'o', { o: 'owner', t: 'owner', c: 'member' });
    await seedUser('o', { status: 'disabled' });
    const refusal = await lifecycle.checkDisableFloor('c', 't', await projects.listAllProjects({ includeArchived: true }));
    expect(refusal).toEqual({
      blocking: [{ projectId: 'p1', name: 'P1', reason: 'last_active_owner' }],
      hiddenBlockingCount: 0,
    });
  });

  it('passes while another active owner remains (paired control)', async () => {
    await seedProject('p1', 'o', { o: 'owner', t: 'owner', c: 'member' });
    expect(await lifecycle.checkDisableFloor('c', 't', await projects.listAllProjects({ includeArchived: true }))).toBeNull();
  });
});

describe('offboardUser', () => {
  it('disable → sweep every membership (archived too) → credential scope → tombstone, in that order', async () => {
    await seedProject('p1', 'o', { o: 'owner', c: 'owner', t: 'member' }, {
      agentOwnership: { bot: { createdBy: 'c', assignedTo: ['t', 'c'] } },
    });
    await seedProject('p2', 'o', { o: 'owner', c: 'owner', t: 'member' }, { archivedAt: '2026-02-01T00:00:00.000Z' });
    // A stale assignment in a project the user is no longer a member of.
    await seedProject('p3', 'o', { o: 'owner', c: 'owner' }, {
      agentOwnership: { helper: { createdBy: 'o', assignedTo: ['t'] } },
    });
    await getCredentialStore().writeUser('t', 'llm.openai', 'sk-test');

    const events: string[] = [];
    const offUser = users.onUserChange((e) => events.push(`user:${e.after?.status ?? 'gone'}`));
    const offMembers = projects.onMembershipChange((e) => {
      if (e.kind === 'members_removed') events.push(`removed:${e.projectId}`);
    });
    const deletes: string[] = [];
    const offCreds = getCredentialStore().subscribe((e) => {
      if (e.kind === 'delete') deletes.push(`${e.scope}/${e.credentialId}`);
    });

    const result = await lifecycle.offboardUser({
      caller,
      targetId: 't',
      projects: await projects.listAllProjects({ includeArchived: true }),
    });
    offUser();
    offMembers();
    offCreds();

    expect(result).toEqual({ ok: true, counts: { memberships: 2, assignments: 2, credentials: 1 } });
    expect(events[0]).toBe('user:disabled');
    expect(events.slice(1, 3).sort()).toEqual(['removed:p1', 'removed:p2']);
    expect(events[3]).toBe('user:deleted');
    expect(deletes).toEqual(['user:t/llm.openai']);

    const p1 = await projects.getProjectById('p1');
    const p2 = await projects.getProjectById('p2');
    const p3 = await projects.getProjectById('p3');
    expect(p1?.members.t).toBeUndefined();
    expect(p2?.members.t).toBeUndefined();
    expect(p1?.agentOwnership.bot).toEqual({ createdBy: 'c', assignedTo: ['c'] });
    expect(p3?.agentOwnership.helper).toEqual({ createdBy: 'o', assignedTo: [] });
    expect(getCredentialStore().listUser('t')).toEqual([]);

    const tomb = await users.getUserById('t');
    expect(tomb).toMatchObject({ status: 'deleted', deletedBy: 'c', deletedEmail: 't@x.co' });
    expect(audit.rows.map((r) => r.action)).toEqual(['user.disable', 'user.delete']);
    expect(audit.rows[1]).toMatchObject({
      target: 't',
      details: { email: 't@x.co', memberships: 2, assignments: 2, credentials: 1, projects: ['p1', 'p2', 'p3'] },
    });

    // The address is free for a NEW account.
    const reborn = await users.createUser('t@x.co', 'T again', 'h2');
    expect(reborn.id).not.toBe('t');
  });

  it('refuses the provenance owner of a project and writes nothing', async () => {
    await seedProject('p1', 't', { t: 'owner', c: 'owner' });
    const before = await readFile(join(appRoot, 'projects', 'p1.json'), 'utf-8');
    const result = await lifecycle.offboardUser({
      caller,
      targetId: 't',
      projects: await projects.listAllProjects({ includeArchived: true }),
    });
    expect(result).toEqual({
      ok: false,
      code: 'blocked',
      blocking: [{ projectId: 'p1', name: 'P1', reason: 'provenance_owner' }],
      hiddenBlockingCount: 0,
    });
    expect((await users.getUserById('t'))?.status).toBe('active');
    expect(await readFile(join(appRoot, 'projects', 'p1.json'), 'utf-8')).toBe(before);
    expect(audit.rows).toEqual([]);
  });

  it('refuses the last active owner; a project the caller cannot see is only counted', async () => {
    await seedUser('o', { status: 'disabled' });
    await seedProject('p1', 'o', { o: 'owner', t: 'owner' });
    const result = await lifecycle.offboardUser({
      caller,
      targetId: 't',
      projects: await projects.listAllProjects({ includeArchived: true }),
    });
    expect(result).toEqual({ ok: false, code: 'blocked', blocking: [], hiddenBlockingCount: 1 });
    expect((await users.getUserById('t'))?.status).toBe('active');
  });

  it('a project the caller does not govern stops the sweep: the user stays DISABLED, never tombstoned', async () => {
    await seedProject('p1', 'o', { o: 'owner', c: 'owner', t: 'member' });
    await seedProject('p2', 'o', { o: 'owner', t: 'member' });
    const result = await lifecycle.offboardUser({
      caller,
      targetId: 't',
      projects: await projects.listAllProjects({ includeArchived: true }),
    });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: 'changed' });
    const after = await users.getUserById('t');
    expect(after?.status).toBe('disabled');
    expect((await projects.getProjectById('p2'))?.members.t).toBeDefined();
    expect(audit.rows.map((r) => r.action)).not.toContain('user.delete');
  });

  it('preflight lists what leaves with the user', async () => {
    await seedProject('p1', 'o', { o: 'owner', c: 'owner', t: 'member' });
    await getCredentialStore().writeUser('t', 'git.github.com.pat', 'ghp');
    const pre = await lifecycle.preflightOffboard('c', 't', await projects.listAllProjects({ includeArchived: true }));
    expect(pre).toEqual({ blocking: [], hiddenBlockingCount: 0, memberships: 1, credentialIds: ['git.github.com.pat'] });
    getCredentialStore().deleteUserScope('t');
  });
});
