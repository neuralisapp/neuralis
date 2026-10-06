/**
 * The notification store: rows are signals (fixed fields, no content), an
 * unread twin MERGES instead of appending, retention runs at write time, the
 * live counts reach ONLY the recipient's listeners, and the store is ONE per
 * process — the materializer (instrumentation graph) and the routes (route
 * graph) share its chain, its appender and its listener map.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'nrs-notifications-'));
const projectsRoot = join(root, 'projects');
const config: Record<string, number> = { notificationsMaxRowsPerUser: 500, notificationsRetentionDays: 30 };
const listAllProjects = vi.fn();

vi.mock('../../config/env', () => ({ getEnv: () => ({ appRoot: join(root, 'app'), projectsRoot }) }));
vi.mock('../../store/PlatformConfigStore', () => ({ getPlatformConfigStore: () => ({ get: (key: string) => config[key] }) }));
vi.mock('../../store/ProjectStore', () => ({ listAllProjects }));

const store = await import('../notificationStore');

const input = (subjectId: string, extra: Partial<Parameters<typeof store.deliverNotification>[2]> = {}) => ({
  type: 'agent-core.workflow.run.failed',
  packageId: '@neuralis/agent-core',
  dock: 'agent-core-calendar-dock',
  subjectId,
  tone: 'error' as const,
  title: 'Daily report — Workflow run failed',
  ...extra,
});

function logPath(projectId: string, userId: string): string {
  return join(projectsRoot, projectId, 'notifications', userId, 'log.jsonl');
}

async function logLines(projectId: string, userId: string): Promise<Record<string, unknown>[]> {
  if (!existsSync(logPath(projectId, userId))) return [];
  return (await readFile(logPath(projectId, userId), 'utf-8')).trim().split('\n').map((line) => JSON.parse(line));
}

beforeEach(async () => {
  await rm(projectsRoot, { recursive: true, force: true });
  config.notificationsMaxRowsPerUser = 500;
  config.notificationsRetentionDays = 30;
  store.resetNotificationStoreForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('rows', () => {
  it('a row carries exactly the signal fields, under the project tree (so the purge takes it)', async () => {
    await store.deliverNotification('p1', 'u1', input('wf-1', { nav: { widgetType: 'calendar', initialState: { runId: 'r1' } } }));
    const [row] = await logLines('p1', 'u1');
    expect(Object.keys(row!).sort()).toEqual(
      ['at', 'count', 'dock', 'id', 'nav', 'packageId', 'seq', 'subjectId', 'title', 'tone', 'type'].sort(),
    );
    expect(logPath('p1', 'u1').startsWith(join(projectsRoot, 'p1'))).toBe(true);
  });

  it('a title is flattened and capped at 120 characters', async () => {
    await store.deliverNotification('p1', 'u1', input('wf-1', { title: `a\u2028b\n${'x'.repeat(200)}` }));
    const [row] = await logLines('p1', 'u1');
    expect((row!.title as string).length).toBeLessThanOrEqual(store.MAX_NOTIFICATION_TITLE_CHARS);
    expect(row!.title).not.toMatch(/[\n\u2028]/);
  });

  it('an unread (type, subject) twin MERGES — a count, never a second row; a read one does not', async () => {
    await store.deliverNotification('p1', 'u1', input('wf-1'));
    await store.deliverNotification('p1', 'u1', input('wf-1'));
    await store.deliverNotification('p1', 'u1', input('wf-1'));
    expect(await logLines('p1', 'u1')).toHaveLength(1);
    let [view] = await store.listNotifications('p1', 'u1', { limit: 10 });
    expect(view).toMatchObject({ count: 3, read: false });
    await store.markNotificationsRead('p1', 'u1', { all: true });
    await store.deliverNotification('p1', 'u1', input('wf-1'));
    expect(await logLines('p1', 'u1')).toHaveLength(2);
    [view] = await store.listNotifications('p1', 'u1', { limit: 10 });
    expect(view).toMatchObject({ count: 1, read: false });
  });

  it('counts are per dock key `<manifest packageId>:<dockId>`, and read-by-dock clears only that dock', async () => {
    await store.deliverNotification('p1', 'u1', input('wf-1'));
    await store.deliverNotification('p1', 'u1', input('src-1', { packageId: '@neuralis/brain-core', dock: 'files-dock', type: 'brain-core.source.sync.failed' }));
    expect(await store.readUnreadCounts('p1', 'u1')).toEqual({
      total: 2,
      byDock: { '@neuralis/agent-core:agent-core-calendar-dock': 1, '@neuralis/brain-core:files-dock': 1 },
    });
    const after = await store.markNotificationsRead('p1', 'u1', { dock: '@neuralis/brain-core:files-dock' });
    expect(after).toEqual({ total: 1, byDock: { '@neuralis/agent-core:agent-core-calendar-dock': 1 } });
  });

  it('pages backwards by seq and filters unread', async () => {
    for (const id of ['a', 'b', 'c', 'd']) await store.deliverNotification('p1', 'u1', input(id));
    const first = await store.listNotifications('p1', 'u1', { limit: 2 });
    expect(first.map((row) => row.subjectId)).toEqual(['d', 'c']);
    const next = await store.listNotifications('p1', 'u1', { limit: 2, before: first[1]!.seq });
    expect(next.map((row) => row.subjectId)).toEqual(['b', 'a']);
    await store.markNotificationsRead('p1', 'u1', { ids: [first[0]!.id] });
    expect((await store.listNotifications('p1', 'u1', { limit: 10, unreadOnly: true })).map((row) => row.subjectId)).toEqual(['c', 'b', 'a']);
  });
});

describe('retention at write time', () => {
  it('past the row cap the log compacts to 80 % of it, and dropped rows leave the unread set', async () => {
    config.notificationsMaxRowsPerUser = 5;
    for (let i = 0; i < 6; i += 1) await store.deliverNotification('p1', 'u1', input(`wf-${i}`));
    const lines = await logLines('p1', 'u1');
    expect(lines).toHaveLength(4);
    expect(lines.map((row) => row.subjectId)).toEqual(['wf-2', 'wf-3', 'wf-4', 'wf-5']);
    expect((await store.readUnreadCounts('p1', 'u1')).total).toBe(4);
  });

  it('a row older than the retention window is dropped on the next write', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
    await store.deliverNotification('p1', 'u1', input('old'));
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'));
    await store.deliverNotification('p1', 'u1', input('new'));
    expect((await logLines('p1', 'u1')).map((row) => row.subjectId)).toEqual(['new']);
  });
});

describe('the live counts signal', () => {
  it('reaches only the recipient\'s listeners, and carries numbers only', async () => {
    const mine = vi.fn();
    const theirs = vi.fn();
    const offMine = store.onNotificationCounts('u1', mine);
    const offTheirs = store.onNotificationCounts('u2', theirs);
    await store.deliverNotification('p1', 'u1', input('wf-1'));
    expect(theirs).not.toHaveBeenCalled();
    expect(mine).toHaveBeenCalledTimes(1);
    expect(mine.mock.calls[0]![0]).toEqual({
      projectId: 'p1',
      userId: 'u1',
      unread: { total: 1, byDock: { '@neuralis/agent-core:agent-core-calendar-dock': 1 } },
    });
    offMine();
    offTheirs();
  });
});

describe('one store per process', () => {
  it('a second module copy shares the chain and the listeners — no lost state.json update', async () => {
    vi.resetModules();
    const copy = await import('../notificationStore');
    expect(copy).not.toBe(store);
    const heard = vi.fn();
    const off = copy.onNotificationCounts('u1', heard);
    await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        (i % 2 === 0 ? store : copy).deliverNotification('p1', 'u1', input(`wf-${i}`)),
      ),
    );
    off();
    expect(heard).toHaveBeenCalledTimes(24);
    const state = JSON.parse(await readFile(join(projectsRoot, 'p1', 'notifications', 'u1', 'state.json'), 'utf-8'));
    expect(state.rows).toBe(24);
    expect(Object.keys(state.unread)).toHaveLength(24);
    const seqs = (await logLines('p1', 'u1')).map((row) => row.seq);
    expect(new Set(seqs).size).toBe(24);
  });
});

describe('a deleted user', () => {
  it('loses the notification directory in EVERY project, archived ones included', async () => {
    listAllProjects.mockResolvedValue([{ id: 'p1' }, { id: 'p-archived' }]);
    await store.deliverNotification('p1', 'gone', input('wf-1'));
    await store.deliverNotification('p-archived', 'gone', input('wf-1'));
    await store.deliverNotification('p1', 'stays', input('wf-1'));
    await store.removeDeletedUserNotifications('gone');
    expect(listAllProjects).toHaveBeenCalledWith({ includeArchived: true });
    expect(existsSync(join(projectsRoot, 'p1', 'notifications', 'gone'))).toBe(false);
    expect(existsSync(join(projectsRoot, 'p-archived', 'notifications', 'gone'))).toBe(false);
    expect(existsSync(join(projectsRoot, 'p1', 'notifications', 'stays'))).toBe(true);
  });

  it('refuses ids that are not one segment', async () => {
    expect(await store.deliverNotification('p1', '../x', input('wf-1'))).toBe(false);
    expect(await store.deliverNotification('..', 'u1', input('wf-1'))).toBe(false);
  });
});

describe('a counts frame only when the numbers move', () => {
  it('a merge into an unread twin sends NO frame; a new unread row sends one', async () => {
    const heard = vi.fn();
    const off = store.onNotificationCounts('u1', heard);
    await store.deliverNotification('p1', 'u1', input('wf-1'));
    expect(heard).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i += 1) await store.deliverNotification('p1', 'u1', input('wf-1'));
    expect(heard).toHaveBeenCalledTimes(1);
    // The merge still counted — on disk, not on the wire.
    const [row] = await store.listNotifications('p1', 'u1', { limit: 10 });
    expect(row?.count).toBe(4);
    await store.deliverNotification('p1', 'u1', input('wf-2'));
    expect(heard).toHaveBeenCalledTimes(2);
    expect(heard.mock.calls[1]![0].unread.total).toBe(2);
    off();
  });

  it('once the twin is read, the same event is a new unread row — and a frame', async () => {
    const heard = vi.fn();
    const off = store.onNotificationCounts('u1', heard);
    await store.deliverNotification('p1', 'u1', input('wf-1'));
    await store.markNotificationsRead('p1', 'u1', { all: true });
    expect(heard).toHaveBeenCalledTimes(2);
    await store.deliverNotification('p1', 'u1', input('wf-1'));
    expect(heard).toHaveBeenCalledTimes(3);
    expect(heard.mock.calls[2]![0].unread.total).toBe(1);
    off();
  });
});

describe('groups and clear', () => {
  const CAL = '@neuralis/agent-core:agent-core-calendar-dock';
  const FILES = '@neuralis/brain-core:files-dock';
  const files = (subjectId: string) =>
    input(subjectId, { packageId: '@neuralis/brain-core', dock: 'files-dock', type: 'brain-core.source.sync.failed' });
  const dockless = (subjectId: string) => input(subjectId, { dock: undefined, type: 'agent-core.thing' });
  const statePath = (userId: string) => join(projectsRoot, 'p1', 'notifications', userId, 'state.json');

  it('the group key is the dock key, or the bare package id for a dockless row', () => {
    expect(store.notificationGroupKey({ packageId: '@neuralis/agent-core', dock: 'agent-core-calendar-dock' })).toBe(CAL);
    expect(store.notificationGroupKey({ packageId: '@neuralis/agent-core' })).toBe('@neuralis/agent-core');
  });

  it('`group` lists one app\'s rows, newest first, and pages like any list', async () => {
    for (const id of ['a', 'b', 'c']) await store.deliverNotification('p1', 'u1', input(id));
    await store.deliverNotification('p1', 'u1', files('s1'));
    await store.deliverNotification('p1', 'u1', dockless('x1'));
    const cal = await store.listNotifications('p1', 'u1', { limit: 2, group: CAL });
    expect(cal.map((r) => r.subjectId)).toEqual(['c', 'b']);
    expect((await store.listNotifications('p1', 'u1', { limit: 2, group: CAL, before: cal[1]!.seq })).map((r) => r.subjectId)).toEqual(['a']);
    expect((await store.listNotifications('p1', 'u1', { group: '@neuralis/agent-core' })).map((r) => r.subjectId)).toEqual(['x1']);
    expect(await store.listNotifications('p1', 'u1', { limit: 10, group: FILES, unreadOnly: true })).toHaveLength(1);
  });

  it('grouping unread-only: rows are unread ones, a group with nothing unread is left out, `total` still counts EVERY entry', async () => {
    for (const id of ['a', 'b', 'c']) await store.deliverNotification('p1', 'u1', input(id));
    await store.deliverNotification('p1', 'u1', files('s1'));
    const views = await store.listNotifications('p1', 'u1', {});
    await store.markNotificationsRead('p1', 'u1', { dock: FILES });
    await store.markNotificationsRead('p1', 'u1', { ids: [views.find((v) => v.subjectId === 'c')!.id] });
    const groups = store.groupNotificationViews(await store.listNotifications('p1', 'u1', {}), 4, { unreadOnly: true });
    expect(groups.map((g) => g.key)).toEqual([CAL]);
    expect(groups[0]).toMatchObject({ total: 3, unread: 2 });
    expect(groups[0]!.rows.map((r) => r.subjectId)).toEqual(['b', 'a']);
    // The All view still lists the fully read group.
    const all = store.groupNotificationViews(await store.listNotifications('p1', 'u1', {}), 4);
    expect(all.find((g) => g.key === FILES)).toMatchObject({ total: 1, unread: 0 });
  });

  it('grouping: ordered by the newest row, `total` counts entries (a merge counts once), `rows` ≤ n while total > n', async () => {
    for (const id of ['a', 'b', 'c', 'd', 'e']) await store.deliverNotification('p1', 'u1', input(id));
    await store.deliverNotification('p1', 'u1', input('e'));
    await store.deliverNotification('p1', 'u1', files('s1'));
    await store.markNotificationsRead('p1', 'u1', { ids: [(await store.listNotifications('p1', 'u1', { limit: 10, group: CAL }))[4]!.id] });
    const groups = store.groupNotificationViews(await store.listNotifications('p1', 'u1', {}), 4);
    expect(groups.map((g) => g.key)).toEqual([FILES, CAL]);
    expect(groups[1]).toMatchObject({ packageId: '@neuralis/agent-core', dock: 'agent-core-calendar-dock', total: 5, unread: 4 });
    expect(groups[1]!.rows.map((r) => r.subjectId)).toEqual(['e', 'd', 'c', 'b']);
    expect(groups[1]!.rows[0]!.count).toBe(2);
  });

  it('clear deletes one app\'s rows, unread included; the state is pruned exactly as a rebuild from the log would count it', async () => {
    for (const id of ['a', 'b']) await store.deliverNotification('p1', 'u1', input(id));
    await store.deliverNotification('p1', 'u1', input('b'));
    await store.deliverNotification('p1', 'u1', files('s1'));
    await store.deliverNotification('p1', 'u1', files('s2'));
    const after = await store.clearNotifications('p1', 'u1', { group: CAL });
    expect(after).toEqual({ total: 2, byDock: { [FILES]: 2 } });
    const lines = await logLines('p1', 'u1');
    expect(lines.map((row) => row.subjectId)).toEqual(['s1', 's2']);
    const state = JSON.parse(await readFile(statePath('u1'), 'utf-8'));
    expect(state.rows).toBe(lines.length);
    expect(state.oldestAt).toBe(lines[0]!.at);
    expect(Object.keys(state.merged)).toEqual([]);
    expect(Object.keys(state.unread).sort()).toEqual(lines.map((row) => row.id as string).sort());
    // The seq is never re-issued after a clear (a, b, s1, s2 took 1–4; the merge took none).
    await store.deliverNotification('p1', 'u1', input('c'));
    expect((await logLines('p1', 'u1')).at(-1)!.seq).toBe(5);
  });

  it('clear all empties the inbox; another user\'s directory is byte-identical', async () => {
    await store.deliverNotification('p1', 'u1', input('a'));
    await store.deliverNotification('p1', 'u2', input('a'));
    const before = {
      log: await readFile(logPath('p1', 'u2'), 'utf-8'),
      state: await readFile(statePath('u2'), 'utf-8'),
    };
    expect(await store.clearNotifications('p1', 'u1', { all: true })).toEqual({ total: 0, byDock: {} });
    expect((await readFile(logPath('p1', 'u1'), 'utf-8')).trim()).toBe('');
    expect(await store.listNotifications('p1', 'u1', { limit: 10 })).toEqual([]);
    expect(await readFile(logPath('p1', 'u2'), 'utf-8')).toBe(before.log);
    expect(await readFile(statePath('u2'), 'utf-8')).toBe(before.state);
  });

  it('a counts frame only when the unread numbers moved; nothing to clear writes nothing', async () => {
    await store.deliverNotification('p1', 'u1', input('a'));
    await store.deliverNotification('p1', 'u1', files('s1'));
    await store.markNotificationsRead('p1', 'u1', { dock: FILES });
    const heard = vi.fn();
    const off = store.onNotificationCounts('u1', heard);
    await store.clearNotifications('p1', 'u1', { group: FILES });
    expect(heard).not.toHaveBeenCalled();
    expect((await logLines('p1', 'u1')).map((row) => row.subjectId)).toEqual(['a']);
    const stateBefore = await readFile(statePath('u1'), 'utf-8');
    await store.clearNotifications('p1', 'u1', { group: 'nothing:here' });
    expect(await readFile(statePath('u1'), 'utf-8')).toBe(stateBefore);
    expect(heard).not.toHaveBeenCalled();
    await store.clearNotifications('p1', 'u1', { group: CAL });
    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard.mock.calls[0]![0].unread).toEqual({ total: 0, byDock: {} });
    off();
  });
});
