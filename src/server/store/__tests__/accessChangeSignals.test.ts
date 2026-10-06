/**
 * The two store signals that say "who may hold a session changed" — the input
 * of the revocation fan-out — and the project store's `record_changed`, the
 * input of the workspace's `project` hub channel. Driven against a REAL
 * `FileStore` in a temp appRoot: the emission is only correct if it fires AFTER
 * the per-path chain resolved and only on a REAL transition, and an in-memory
 * double has no chain.
 *
 * Every access-LOSS row is paired with a write that must not emit one (a
 * `lastLoginAt` stamp, a role change, a restore), because a signal that fires
 * on every write would turn each login into a revocation of that user's live
 * sockets. Those writes emit `record_changed` instead, which revokes nobody
 * (`principalRevocation.test.ts` pins that mapping).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ProjectRecord } from '../projectTypes';

const appRoot = await mkdtemp(join(tmpdir(), 'nrs-access-signals-'));

vi.mock('../../config/env', () => ({
  getEnv: () => ({ appRoot, projectsRoot: join(appRoot, 'projects-data') }),
}));

// A real create provisions dirs and runs every package's hook — fixtures here.
vi.mock('../../projects/projectInit', () => ({ initProjectDirectory: vi.fn() }));

const users = await import('../UserStore');
const projects = await import('../ProjectStore');

beforeAll(async () => {
  await mkdir(join(appRoot, 'projects'), { recursive: true });
  await mkdir(join(appRoot, 'users'), { recursive: true });
});

afterAll(async () => {
  await rm(appRoot, { recursive: true, force: true });
});

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

async function seedProject(id: string): Promise<void> {
  const record = {
    id,
    name: id,
    ownerId: 'u-owner',
    members: { 'u-owner': member('u-owner', 'owner'), 'u-a': member('u-a', 'member'), 'u-b': member('u-b', 'member') },
    roles: {
      owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
      member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 20 },
      viewer: { agents: 'view', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 30 },
    },
    agentOwnership: {},
    limits: { spend: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} } },
    roleGrantVersion: 18,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as ProjectRecord;
  await writeFile(join(appRoot, 'projects', `${id}.json`), JSON.stringify(record), 'utf-8');
}

describe('UserStore — onUserChange', () => {
  const seen: unknown[] = [];
  let off: () => void = () => {};
  beforeEach(() => {
    seen.length = 0;
    off();
    off = users.onUserChange((e) => seen.push(e));
  });

  it('a status change emits once, with both states; a lastLoginAt stamp emits nothing (paired)', async () => {
    await seedUser('u-status');
    await users.updateUser('u-status', { lastLoginAt: '2026-09-25T00:00:00.000Z' });
    await users.updateUser('u-status', { name: 'Renamed' });
    expect(seen).toEqual([]);

    await users.updateUser('u-status', { status: 'disabled', disabledAt: 't', disabledBy: 'u-admin' });
    expect(seen).toEqual([
      { userId: 'u-status', before: { status: 'active', sessionEpoch: 0 }, after: { status: 'disabled', sessionEpoch: 0 } },
    ]);
    // The same status again is not a transition.
    await users.updateUser('u-status', { status: 'disabled' });
    expect(seen).toHaveLength(1);
  });

  it('an epoch bump computed by a PRODUCER emits and lands', async () => {
    await seedUser('u-epoch', { sessionEpoch: 2 });
    await users.updateUser('u-epoch', (current) => ({ sessionEpoch: users.sessionEpochOf(current) + 1 }));
    expect(seen).toEqual([
      { userId: 'u-epoch', before: { status: 'active', sessionEpoch: 2 }, after: { status: 'active', sessionEpoch: 3 } },
    ]);
  });

  it('a tombstone emits `deleted`, frees the address, and is terminal — no later write revives it', async () => {
    await seedUser('u-tomb');
    const tomb = await users.tombstoneUser('u-tomb', 'u-admin');
    expect(tomb).toMatchObject({ status: 'deleted', deletedEmail: 'u-tomb@x.co', deletedBy: 'u-admin', passwordHash: '' });
    expect(await users.findUserByEmail('u-tomb@x.co')).toBeNull();
    expect(seen).toEqual([
      { userId: 'u-tomb', before: { status: 'active', sessionEpoch: 0 }, after: { status: 'deleted', sessionEpoch: 0 } },
    ]);

    // A re-enable of a tombstone would revive every cookie it still holds.
    await users.updateUser('u-tomb', { status: 'active' });
    const onDisk = JSON.parse(await readFile(join(appRoot, 'users', 'u-tomb.json'), 'utf-8')) as { status: string };
    expect(onDisk.status).toBe('deleted');
    expect(users.isActiveUser(await users.getUserById('u-tomb'))).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it('a hard delete emits `after: null`; deleting nothing emits nothing', async () => {
    await seedUser('u-gone');
    expect(await users.deleteUser('u-gone')).toBe(true);
    expect(seen).toEqual([{ userId: 'u-gone', before: { status: 'active', sessionEpoch: 0 }, after: null }]);
    expect(await users.deleteUser('u-gone')).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it('a throwing listener does not stop the write or the next listener', async () => {
    await seedUser('u-throw');
    const offBad = users.onUserChange(() => { throw new Error('boom'); });
    const late: unknown[] = [];
    const offLate = users.onUserChange((e) => late.push(e));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await users.updateUser('u-throw', { status: 'disabled' });
    } finally {
      offBad();
      offLate();
      spy.mockRestore();
    }
    expect(late).toHaveLength(1);
    expect((await users.getUserById('u-throw'))?.status).toBe('disabled');
  });
});

describe('isActiveUser — only `active` may hold a session', () => {
  it('refuses disabled AND deleted; a `!== "disabled"` test would admit the tombstone', () => {
    expect(users.isActiveUser({ status: 'active' })).toBe(true);
    expect(users.isActiveUser({ status: 'disabled' })).toBe(false);
    expect(users.isActiveUser({ status: 'deleted' })).toBe(false);
    expect(users.isActiveUser(null)).toBe(false);
    // The shape this replaces, on the same input: it lets the tombstone through.
    const old = (r: { status: string }) => r.status !== 'disabled';
    expect(old({ status: 'deleted' })).toBe(true);
  });
});

describe('ProjectStore — onMembershipChange', () => {
  const seen: unknown[] = [];
  let off: () => void = () => {};
  beforeEach(() => {
    seen.length = 0;
    off();
    off = projects.onMembershipChange((e) => seen.push(e));
  });

  const all = ['u-owner', 'u-a', 'u-b'];

  it('removing members emits their ids; a role change and a field write only CHANGE the record (paired)', async () => {
    await seedProject('p-members');
    await projects.updateProject('p-members', (p) => ({ members: { ...p.members, 'u-a': { ...p.members['u-a']!, role: 'viewer' } } }));
    await projects.updateProject('p-members', { name: 'Renamed', description: 'x' });
    expect(seen).toEqual([
      { kind: 'record_changed', projectId: 'p-members', userIds: all },
      { kind: 'record_changed', projectId: 'p-members', userIds: all },
    ]);
    seen.length = 0;

    await projects.updateProject('p-members', (p) => {
      const next = { ...p.members };
      delete next['u-a'];
      delete next['u-b'];
      return { members: next };
    });
    // BEFORE ∪ AFTER: the removed members' project lists drop the project too.
    expect(seen).toEqual([
      { kind: 'members_removed', projectId: 'p-members', userIds: ['u-a', 'u-b'] },
      { kind: 'record_changed', projectId: 'p-members', userIds: all },
    ]);
  });

  it('the migrate-on-read persist emits nothing — a boot migration must not storm every hub', async () => {
    await seedProject('p-migrate'); // stored at an older role-grant version
    await projects.getProjectById('p-migrate');
    const onDisk = JSON.parse(await readFile(join(appRoot, 'projects', 'p-migrate.json'), 'utf-8')) as {
      roleGrantVersion: number;
    };
    expect(onDisk.roleGrantVersion).toBeGreaterThan(18); // the read DID write
    expect(seen).toEqual([]);
  });

  it('a create emits record_changed for its owner', async () => {
    const created = await projects.createProject('Fresh Record', 'u-owner');
    expect(seen).toEqual([{ kind: 'record_changed', projectId: created.id, userIds: ['u-owner'] }]);
  });

  it('a producer that writes nothing emits nothing', async () => {
    await seedProject('p-noop');
    await projects.updateProject('p-noop', () => null);
    expect(seen).toEqual([]);
  });

  it('archiving closes once; archiving again emits nothing; restoring only CHANGES the record', async () => {
    await seedProject('p-arch');
    await projects.setProjectArchived('p-arch', '2026-09-25T00:00:00.000Z');
    await projects.setProjectArchived('p-arch', '2026-09-25T00:00:01.000Z');
    await projects.setProjectArchived('p-arch', null);
    await projects.setProjectArchived('p-arch', null); // restoring a live project is no transition
    expect(seen).toEqual([
      { kind: 'project_closed', projectId: 'p-arch', cause: 'archived', userIds: all },
      { kind: 'record_changed', projectId: 'p-arch', userIds: all },
    ]);
  });

  it('a permanent delete emits too — every producer of the class, or a purged tenant keeps its live state', async () => {
    await seedProject('p-del');
    expect(await projects.deleteProject('p-del')).toBe(true);
    expect(await projects.deleteProject('p-del')).toBe(false);
    // The members ride the event: a deleted project cannot be read afterwards.
    expect(seen).toEqual([
      { kind: 'project_closed', projectId: 'p-del', cause: 'deleted', userIds: ['u-owner', 'u-a', 'u-b'] },
    ]);
  });
});

describe('ProjectStore — onProjectRecordChange (the `project` hub channel source)', () => {
  it('reaches a member with the project id ALONE, a removed member for the removal, and never a non-member', async () => {
    await seedProject('p-gate');
    const byUser = new Map<string, unknown[]>();
    const offs = ['u-owner', 'u-a', 'u-stranger'].map((userId) => {
      byUser.set(userId, []);
      return projects.onProjectRecordChange(userId, (e) => byUser.get(userId)!.push(e));
    });
    try {
      await projects.updateProject('p-gate', { name: 'Gate Renamed' });
      await projects.updateProject('p-gate', (p) => {
        const next = { ...p.members };
        delete next['u-a'];
        return { members: next };
      });
      await projects.updateProject('p-gate', { name: 'Gate Again' });
    } finally {
      for (const off of offs) off();
    }
    expect(byUser.get('u-owner')).toEqual([{ projectId: 'p-gate' }, { projectId: 'p-gate' }, { projectId: 'p-gate' }]);
    // Two frames: the rename, and the write that removed them — not the one after.
    expect(byUser.get('u-a')).toEqual([{ projectId: 'p-gate' }, { projectId: 'p-gate' }]);
    expect(byUser.get('u-stranger')).toEqual([]);
    // The payload is exactly the id: no name, no member ids.
    expect(Object.keys(byUser.get('u-owner')![0] as object)).toEqual(['projectId']);
  });
});
