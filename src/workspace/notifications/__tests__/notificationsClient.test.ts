/**
 * The workspace notification client:
 *  - ONE `notifications` hub subscription per project however many docks hold
 *    it; the counts are read once on the first hold and once per RECONNECT
 *    (never on the first connect), never polled;
 *  - a frame raises a dock's arrival (the badge pop) only when its number
 *    ROSE; another project's frame feeds the switcher number only;
 *  - the last release unsubscribes one macrotask later, so a REMOUNTING holder
 *    re-holds without a second counts read or subscription;
 *  - a number costs no row read (the badge is one colour);
 *  - a dock's popover asks the server for ITS rows only (`group=`) and marks
 *    exactly those read;
 *  - Clear answers counts that are applied at once; "Open in Inbox" carries
 *    the tab it asks for;
 *  - the client dock key is the server's `<packageId>:<dock>`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type HubSub = { projectId: string | null; channel: string; onEvent: (name: string, payload: unknown) => void; onConnChange?: () => void };
const hub = vi.hoisted(() => ({ subs: [] as HubSub[], connected: true, unsubscribed: 0 }));

vi.mock('../../realtime/eventHub', () => ({
  subscribeHub: (sub: HubSub) => {
    hub.subs.push(sub);
    return () => {
      hub.unsubscribed += 1;
      hub.subs = hub.subs.filter((s) => s !== sub);
    };
  },
  getHubConnected: () => hub.connected,
}));

import {
  _peekNotificationsClient,
  _resetNotificationsClient,
  applyUnreadCounts,
  clearNotifications,
  ensureProjectCounts,
  inboxRequestView,
  loadDockNotifications,
  navInitialState,
  requestInboxOpen,
  retainNotifications,
  rowDockKey,
  type NotificationRow,
} from '../notificationsClient';
import { packageDockKey } from '../../shell/dockOrder';
import { dockKey as serverDockKey } from '@/server/notifications/notificationStore';

type Call = { url: string; method: string; projectId: string | null; body: unknown };
let calls: Call[] = [];
let responder: (call: Call) => unknown = () => ({});

function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      projectId: headers.get('X-Project-Id'),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return { ok: true, status: 200, json: async () => responder(call) } as Response;
  }));
}

/** One macrotask — the deferred release's window. */
const tick = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

const counts = (total: number, byDock: Record<string, number>) => ({ total, byDock });
const CAL = '@neuralis/agent-core:agent-core.calendar';
const SRC = '@neuralis/brain-core:files';

function row(id: string, overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    seq: 1,
    id,
    type: '@neuralis/agent-core.workflow.run.failed',
    packageId: '@neuralis/agent-core',
    dock: 'agent-core.calendar',
    subjectId: 'wf-1',
    tone: 'error',
    title: 'Daily report — Workflow run failed',
    at: '2026-10-02T10:00:00.000Z',
    count: 1,
    read: false,
    ...overrides,
  };
}

beforeEach(() => {
  hub.subs = [];
  hub.connected = true;
  hub.unsubscribed = 0;
  calls = [];
  responder = (call) => (call.url.startsWith('/api/notifications/counts') ? { projectId: call.projectId, unread: counts(0, {}) } : { rows: [], nextBefore: null });
  stubFetch();
  _resetNotificationsClient();
});

afterEach(() => {
  _resetNotificationsClient();
  vi.unstubAllGlobals();
});

describe('one hub subscription per project', () => {
  it('two docks holding the same project share ONE subscription and ONE counts read', async () => {
    const releaseA = retainNotifications('p1');
    const releaseB = retainNotifications('p1');
    await flush();
    expect(hub.subs.filter((s) => s.channel === 'notifications')).toHaveLength(1);
    expect(calls.filter((c) => c.url === '/api/notifications/counts')).toHaveLength(1);
    expect(calls[0]?.projectId).toBe('p1');
    releaseA();
    expect(hub.subs).toHaveLength(1);
    releaseA(); // a double release is a no-op, never steals the other holder's ref
    expect(hub.subs).toHaveLength(1);
    releaseB();
    await tick();
    expect(hub.subs).toHaveLength(0);
    expect(hub.unsubscribed).toBe(1);
  });

  it('a holder that remounts (release → re-retain inside the window) costs ONE counts read and ONE subscription', async () => {
    const release1 = retainNotifications('p1');
    await flush();
    release1();
    const release2 = retainNotifications('p1');
    await tick();
    await flush();
    expect(calls.filter((c) => c.url === '/api/notifications/counts')).toHaveLength(1);
    expect(hub.subs).toHaveLength(1);
    expect(hub.unsubscribed).toBe(0);
    release2();
    await tick();
    expect(hub.subs).toHaveLength(0);
  });

  it('a true unmount (release, no re-retain) unsubscribes after the tick, not before it', async () => {
    const release = retainNotifications('p1');
    await flush();
    release();
    expect(hub.subs).toHaveLength(1);
    await tick();
    expect(hub.subs).toHaveLength(0);
    expect(hub.unsubscribed).toBe(1);
    // A later hold is a fresh feed: it subscribes and reads again.
    const again = retainNotifications('p1');
    await flush();
    expect(calls.filter((c) => c.url === '/api/notifications/counts')).toHaveLength(2);
    again();
  });

  it('a project switch moves the subscription', async () => {
    const release1 = retainNotifications('p1');
    release1();
    const release2 = retainNotifications('p2');
    await tick();
    expect(hub.subs.map((s) => s.projectId)).toEqual(['p2']);
    release2();
  });

  it('counts are re-read once when the hub comes BACK — not on the first connect, not on a drop', async () => {
    const release = retainNotifications('p1');
    await flush();
    const before = calls.length;
    const sub = hub.subs[0] as HubSub;
    hub.connected = false;
    sub.onConnChange?.();
    await flush();
    expect(calls.length).toBe(before);
    hub.connected = true;
    sub.onConnChange?.();
    await flush();
    expect(calls.filter((c) => c.url === '/api/notifications/counts')).toHaveLength(2);
    release();
  });
});

describe('frames', () => {
  it('a frame for the held project sets its counts; a RISE is an arrival, a fall or the first read is not', async () => {
    const release = retainNotifications('p1');
    await flush();
    const sub = hub.subs[0] as HubSub;
    const total = () => peek().counts.p1?.total;
    sub.onEvent('counts', { projectId: 'p1', unread: counts(2, { [CAL]: 2 }) });
    expect(total()).toBe(2);
    expect(peek().arrivals[`p1|${CAL}`]).toBe(1);
    sub.onEvent('counts', { projectId: 'p1', unread: counts(1, { [CAL]: 1 }) });
    expect(peek().arrivals[`p1|${CAL}`]).toBe(1);
    sub.onEvent('counts', { projectId: 'p1', unread: counts(3, { [CAL]: 3 }) });
    expect(peek().arrivals[`p1|${CAL}`]).toBe(2);
    release();
  });

  it("another project's frame feeds the switcher number only", async () => {
    const release = retainNotifications('p1');
    await flush();
    (hub.subs[0] as HubSub).onEvent('counts', { projectId: 'p2', unread: counts(4, { [CAL]: 4 }) });
    expect(peek().byProject.p2).toBe(4);
    expect(peek().counts.p1?.total ?? 0).toBe(0);
    release();
  });

  it('a malformed frame is ignored', async () => {
    const release = retainNotifications('p1');
    await flush();
    const sub = hub.subs[0] as HubSub;
    sub.onEvent('counts', { projectId: 'p1', unread: { total: 'x' } });
    sub.onEvent('other', { projectId: 'p1', unread: counts(9, {}) });
    expect(peek().counts.p1?.total ?? 0).toBe(0);
    release();
  });

  it('a counts read (mount) is never an arrival', () => {
    applyUnreadCounts('p1', counts(5, { [CAL]: 5 }), false);
    expect(peek().arrivals[`p1|${CAL}`]).toBeUndefined();
  });
});

describe('the other projects\' numbers (the switcher button\'s dot)', () => {
  it('a feed reads `scope=all` ONCE on load — a remounting holder does not read it again', async () => {
    responder = (call) => (call.url === '/api/notifications/counts?scope=all'
      ? { byProject: { p1: 0, p2: 3 } }
      : { projectId: 'p1', unread: counts(0, {}) });
    const release1 = retainNotifications('p1');
    await flush();
    release1();
    const release2 = retainNotifications('p1');
    await tick();
    await flush();
    expect(calls.filter((c) => c.url === '/api/notifications/counts?scope=all')).toHaveLength(1);
    expect(peek().byProject).toEqual({ p1: 0, p2: 3 });
    release2();
  });
});

describe('a number costs no row read', () => {
  it('frames that raise and lower the numbers read nothing but the counts', async () => {
    const release = retainNotifications('p1');
    await flush();
    const sub = hub.subs[0] as HubSub;
    sub.onEvent('counts', { projectId: 'p1', unread: counts(1, { [CAL]: 1 }) });
    sub.onEvent('counts', { projectId: 'p1', unread: counts(3, { [CAL]: 2, [SRC]: 1 }) });
    sub.onEvent('counts', { projectId: 'p1', unread: counts(0, {}) });
    await flush();
    expect(calls.map((c) => c.url).sort()).toEqual(['/api/notifications/counts', '/api/notifications/counts?scope=all']);
    release();
  });
});

describe('the popover marks exactly its own rows read', () => {
  it('asks for the dock\'s rows only; ONE read call names only their ids', async () => {
    responder = (call) => {
      if (call.url.startsWith('/api/notifications/read')) return { projectId: 'p1', unread: counts(1, { [SRC]: 1 }) };
      return { rows: [row('a'), row('b', { tone: 'success' })], nextBefore: null };
    };
    const rows = await loadDockNotifications('p1', CAL);
    expect(calls[0]?.url).toBe(`/api/notifications?limit=100&unread=1&group=${encodeURIComponent(CAL)}`);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    const reads = calls.filter((c) => c.url === '/api/notifications/read');
    expect(reads).toEqual([{ url: '/api/notifications/read', method: 'POST', projectId: 'p1', body: { ids: ['a', 'b'] } }]);
    // The answer's counts are applied at once.
    expect(peek().counts.p1).toEqual(counts(1, { [SRC]: 1 }));
  });

  it('nothing unread ⇒ no read call', async () => {
    responder = () => ({ rows: [], nextBefore: null });
    expect(await loadDockNotifications('p1', CAL)).toEqual([]);
    expect(calls.some((c) => c.url === '/api/notifications/read')).toBe(false);
  });
});

describe('clear and the inbox entry', () => {
  it('Clear posts the group and applies the answered counts at once', async () => {
    applyUnreadCounts('p1', counts(3, { [CAL]: 2, [SRC]: 1 }), false);
    responder = () => ({ projectId: 'p1', unread: counts(1, { [SRC]: 1 }) });
    await clearNotifications('p1', { group: CAL });
    expect(calls.filter((c) => c.method === 'POST')).toEqual([{ url: '/api/notifications/clear', method: 'POST', projectId: 'p1', body: { group: CAL } }]);
    expect(peek().counts.p1).toEqual(counts(1, { [SRC]: 1 }));
  });

  it('"Open in Inbox" bumps the request and carries the tab', () => {
    const before = peek().inboxRequest;
    requestInboxOpen('all');
    expect(peek().inboxRequest).toBe(before + 1);
    expect(inboxRequestView()).toBe('all');
  });
});

describe('the switcher numbers', () => {
  it('an opening switcher burst shares ONE scope=all read', async () => {
    responder = () => ({ byProject: { p1: 2, p2: 7 } });
    await Promise.all([ensureProjectCounts(1_000), ensureProjectCounts(1_001), ensureProjectCounts(1_002)]);
    await ensureProjectCounts(1_500);
    expect(calls.filter((c) => c.url === '/api/notifications/counts?scope=all')).toHaveLength(1);
    expect(peek().byProject).toEqual({ p1: 2, p2: 7 });
    await ensureProjectCounts(10_000);
    expect(calls.filter((c) => c.url === '/api/notifications/counts?scope=all')).toHaveLength(2);
  });
  it('a project missing from the next scope=all answer is forgotten (a left project)', async () => {
    responder = () => ({ byProject: { p1: 2, p2: 7 } });
    await ensureProjectCounts(1_000);
    responder = () => ({ byProject: { p1: 2 } });
    await ensureProjectCounts(10_000);
    expect(peek().byProject).toEqual({ p1: 2 });
  });
});

describe('keys and nav', () => {
  it("the client dock key is the server's", () => {
    expect(packageDockKey('@neuralis/agent-core', 'agent-core.calendar')).toBe(serverDockKey('@neuralis/agent-core', 'agent-core.calendar'));
    expect(rowDockKey(row('x'))).toBe(CAL);
    expect(rowDockKey(row('x', { dock: undefined }))).toBeNull();
  });

  it('a nav one-shot gets a fresh _ts; the rest passes through untouched', () => {
    const nav = { widgetType: 'calendar', initialState: { nav: { kind: 'calendar', action: 'open-workflow', workflowId: 'w' }, other: 1 } };
    expect(navInitialState(nav, 42)).toEqual({ nav: { kind: 'calendar', action: 'open-workflow', workflowId: 'w', _ts: 42 }, other: 1 });
    expect(navInitialState({ widgetType: 'calendar' }, 42)).toBeUndefined();
    expect(navInitialState({ widgetType: 'x', initialState: { a: 1 } }, 42)).toEqual({ a: 1 });
  });
});

function peek() {
  return _peekNotificationsClient();
}
