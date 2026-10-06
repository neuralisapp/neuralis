/**
 * The shell controls that only exist in a MOUNTED tree (fake DOM, real
 * workspace store, real components):
 *  - "Edit docks" reads honestly: it says "Edit docks" while any dock is not
 *    editing, a click puts only that dock into edit mode and the editing
 *    dock's editor stays MOUNTED (its draft intact); with both editing a click
 *    asks before it discards — never a silent discard;
 *  - the inbox groups per app: 4 rows, a chevron past them that pages the
 *    group's own rows, the entry count beside the app, a two-click Clear keyed
 *    on the group that disarms on a reload and after 4 s;
 *  - "Open in Inbox" lands on All; an empty Unread entry with a non-zero badge
 *    falls back to All.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, findByText, installFakeDom, type FakeNode } from './fakeDom';

const dom = installFakeDom();

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: { user: { id: 'u1', name: 'Ada' } }, status: 'authenticated' }) }));
vi.mock('../useDockItems', () => ({ usePackageDockItems: () => [] }));
vi.mock('../UserAvatar', () => ({ UserAvatar: () => null }));
vi.mock('../UserProfilePopup', () => ({ UserProfilePopup: () => null }));
vi.mock('../../realtime/eventHub', () => ({ subscribeHub: () => () => undefined, getHubConnected: () => true }));

const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useWorkspaceStore } = await import('../../store/workspaceStore');
const { Dock } = await import('../Dock');
const { EditDocksToggle, DISCARD_CONFIRM_MS } = await import('../LayoutSettingsPanel');
const { InboxPanel, CLEAR_CONFIRM_MS } = await import('../InboxPanel');
const { UserInfo } = await import('../UserInfo');
const client = await import('../../notifications/notificationsClient');

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let responder: (call: Call) => unknown = () => ({});

let root: ReturnType<typeof createRoot> | null = null;

async function render(element: ReturnType<typeof createElement>): Promise<void> {
  root = createRoot(dom.container as unknown as Element);
  await act(async () => { root!.render(element); });
  await settle();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await act(async () => { await Promise.resolve(); });
}

async function press(node: FakeNode | undefined): Promise<void> {
  await act(async () => { click(node); });
  await settle();
}

const byAttr = (name: string, value?: string): FakeNode[] =>
  dom.document.querySelectorAll(value === undefined ? `[${name}]` : `[${name}="${value}"]`);

beforeEach(() => {
  calls = [];
  responder = () => ({});
  client._resetNotificationsClient();
  useWorkspaceStore.setState({
    session: { ...useWorkspaceStore.getState().session, projectId: 'p1', agentId: null },
    dockEditing: { primary: false, secondary: false },
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return { ok: true, status: 200, json: async () => responder(call) } as Response;
  }));
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  client._resetNotificationsClient();
});

// ─── Edit docks ─────────────────────────────────────────────────────────────

describe('Edit docks', () => {
  const Glyph = () => null;
  const items = (dockId: string) => [1, 2].map((n) => ({
    id: `${dockId}-${n}`,
    position: n,
    title: `${dockId} ${n}`,
    icon: Glyph,
    onClick: () => undefined,
    prefKey: `pkg:${dockId}-${n}`,
    group: 'trust:first-party',
  }));
  const dock = (dockId: 'primary' | 'secondary') => createElement(
    'div',
    { 'data-test-dock': dockId },
    createElement(Dock, {
      dockId,
      placement: { dockId, edge: dockId === 'primary' ? 'left' : 'right', align: 'start' },
      mode: 'iconPinned',
      onChangeMode: () => undefined,
      items: items(dockId),
    }),
  );
  const saveButton = (dockId: string): FakeNode | undefined =>
    byAttr('data-test-dock', dockId)[0]?.querySelectorAll('[aria-label="Save dock order"]')[0];
  const toggle = (): FakeNode | undefined => [...findByText(dom.container, 'Edit docks'), ...findByText(dom.container, 'Editing docks…')][0];

  beforeEach(async () => {
    await render(createElement('div', null, dock('primary'), dock('secondary'), createElement(EditDocksToggle)));
  });

  it('one dock saved, the other still editing: the toggle says "Edit docks" and a click keeps the editing dock MOUNTED', async () => {
    await act(async () => { useWorkspaceStore.getState().setDockEditing('primary', true); });
    const editor = saveButton('primary');
    expect(editor).toBeDefined();
    expect(saveButton('secondary')).toBeUndefined();
    expect(toggle()?.textContent.trim()).toBe('Edit docks');
    expect(toggle()?.getAttribute('aria-pressed')).toBe('false');

    await press(toggle());
    expect(useWorkspaceStore.getState().dockEditing).toEqual({ primary: true, secondary: true });
    // The same element — the primary dock's editor (and its draft) was never remounted.
    expect(saveButton('primary')).toBe(editor);
    expect(saveButton('secondary')).toBeDefined();
    expect(toggle()?.textContent.trim()).toBe('Editing docks…');
    expect(toggle()?.getAttribute('aria-pressed')).toBe('true');
  });

  it('both editing: a click ASKS; "Keep editing" keeps both drafts, "Discard" ends both', async () => {
    await press(toggle());
    expect(useWorkspaceStore.getState().dockEditing).toEqual({ primary: true, secondary: true });
    const editor = saveButton('primary');

    await press(toggle());
    expect(findByText(dom.container, 'Discard both drafts?', 'SPAN')).toHaveLength(1);
    expect(useWorkspaceStore.getState().dockEditing).toEqual({ primary: true, secondary: true });
    await press(findByText(dom.container, 'Keep editing')[0]);
    expect(useWorkspaceStore.getState().dockEditing).toEqual({ primary: true, secondary: true });
    expect(saveButton('primary')).toBe(editor);

    await press(toggle());
    await press(findByText(dom.container, 'Discard')[0]);
    expect(useWorkspaceStore.getState().dockEditing).toEqual({ primary: false, secondary: false });
    expect(saveButton('primary')).toBeUndefined();
  });

  it('the discard question disarms itself, and when a dock leaves edit', async () => {
    vi.useFakeTimers();
    await press(toggle());
    await press(toggle());
    expect(findByText(dom.container, 'Discard')).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(DISCARD_CONFIRM_MS); });
    expect(findByText(dom.container, 'Discard')).toHaveLength(0);
    expect(useWorkspaceStore.getState().dockEditing).toEqual({ primary: true, secondary: true });

    await press(toggle());
    expect(findByText(dom.container, 'Discard')).toHaveLength(1);
    await act(async () => { useWorkspaceStore.getState().setDockEditing('secondary', false); });
    expect(findByText(dom.container, 'Discard')).toHaveLength(0);
    expect(toggle()?.textContent.trim()).toBe('Edit docks');
  });
});

// ─── The inbox ──────────────────────────────────────────────────────────────

const CAL = '@neuralis/agent-core:agent-core.calendar';
const FILES = '@neuralis/brain-core:files';

function row(id: string, seq: number, extra: Record<string, unknown> = {}) {
  return {
    seq, id, type: 't', packageId: '@neuralis/agent-core', dock: 'agent-core.calendar', subjectId: id,
    tone: 'error', title: `Row ${id}`, at: '2026-10-03T10:00:00.000Z', count: 1, read: false, ...extra,
  };
}

const calendarGroup = {
  key: CAL, packageId: '@neuralis/agent-core', dock: 'agent-core.calendar', total: 7, unread: 7,
  rows: [row('a', 7), row('b', 6), row('c', 5), row('d', 4)],
};
const filesGroup = {
  key: FILES, packageId: '@neuralis/brain-core', dock: 'files', total: 2, unread: 0,
  rows: [row('f1', 2, { packageId: '@neuralis/brain-core', dock: 'files', read: true }), row('f2', 1, { packageId: '@neuralis/brain-core', dock: 'files', read: true })],
};

const rowButtons = (): FakeNode[] => byAttr('data-notification-row');
const section = (label: string): FakeNode | undefined => byAttr('aria-label', label).find((n) => n.tagName === 'SECTION');
const listCalls = (): Call[] => calls.filter((c) => c.url.startsWith('/api/notifications?'));

function inboxResponder(groups: unknown[], page?: (call: Call) => unknown): (call: Call) => unknown {
  return (call) => {
    if (call.url.startsWith('/api/notifications?groups=')) return { groups };
    if (call.url.startsWith('/api/notifications?') && page) return page(call);
    if (call.url === '/api/notifications/clear') return { projectId: 'p1', unread: { total: 0, byDock: {} } };
    return { projectId: 'p1', unread: { total: 0, byDock: {} } };
  };
}

const inbox = (initialView?: 'unread' | 'all') =>
  createElement(InboxPanel, { projectId: 'p1', onBack: () => undefined, onClose: () => undefined, ...(initialView ? { initialView } : {}) });

describe('the inbox', () => {
  it('one read for every app: 4 rows each, the entry count beside the app, a chevron only past 4', async () => {
    responder = inboxResponder([calendarGroup, filesGroup]);
    await render(inbox('all'));
    expect(listCalls().map((c) => c.url)).toEqual(['/api/notifications?groups=4']);
    expect(rowButtons()).toHaveLength(6);
    // No dock item for them in this fixture: each app is headed by its bare name.
    expect(section('agent-core')?.querySelectorAll('[data-notification-row]')).toHaveLength(4);
    expect(section('brain-core')?.querySelectorAll('[data-notification-row]')).toHaveLength(2);
    expect(byAttr('aria-label', '7 notifications')).toHaveLength(1);
    expect(byAttr('aria-label', '2 notifications')).toHaveLength(1);
    expect(byAttr('aria-expanded')).toHaveLength(1);
  });

  it('the chevron pages the group\'s OWN rows, 30 at a time, and "Show more" follows nextBefore', async () => {
    const more = Array.from({ length: 30 }, (_, i) => row(`p${i}`, 100 - i));
    responder = inboxResponder([calendarGroup], (call) => (call.url.includes('before=')
      ? { rows: [row('last', 1)], nextBefore: null }
      : { rows: more, nextBefore: 71 }));
    await render(inbox('unread'));
    await press(byAttr('aria-expanded', 'false')[0]);
    expect(listCalls()[1]?.url).toBe(`/api/notifications?limit=30&unread=1&group=${encodeURIComponent(CAL)}`);
    expect(rowButtons()).toHaveLength(30);
    await press(findByText(dom.container, 'Show more')[0]);
    expect(listCalls()[2]?.url).toBe(`/api/notifications?limit=30&before=71&unread=1&group=${encodeURIComponent(CAL)}`);
    expect(rowButtons()).toHaveLength(31);
    expect(findByText(dom.container, 'Show more')).toHaveLength(0);
  });

  it('Clear is two clicks: the first arms "Clear 7?", the second deletes THAT group', async () => {
    responder = inboxResponder([calendarGroup, filesGroup]);
    await render(inbox('all'));
    const clears = findByText(dom.container, 'Clear');
    expect(clears).toHaveLength(2);
    await press(clears[0]);
    expect(calls.some((c) => c.url === '/api/notifications/clear')).toBe(false);
    expect(findByText(dom.container, 'Clear 7?')).toHaveLength(1);
    // Only the calendar group is armed.
    expect(findByText(dom.container, 'Clear')).toHaveLength(1);
    responder = inboxResponder([filesGroup]);
    await press(findByText(dom.container, 'Clear 7?')[0]);
    expect(calls.filter((c) => c.url === '/api/notifications/clear')).toEqual([
      { url: '/api/notifications/clear', method: 'POST', body: { group: CAL } },
    ]);
    // The inbox re-reads after a clear even when no unread number moved.
    expect(listCalls()).toHaveLength(2);
    expect(rowButtons()).toHaveLength(2);
  });

  it('on the Unread tab the armed label names EVERY entry the clear deletes (total), and the chevron follows the unread rows', async () => {
    const mixed = { ...calendarGroup, total: 12, unread: 4 };
    responder = inboxResponder([mixed]);
    await render(inbox('unread'));
    expect(byAttr('aria-expanded')).toHaveLength(0);
    await press(findByText(dom.container, 'Clear')[0]);
    expect(findByText(dom.container, 'Clear 12?')).toHaveLength(1);
    expect(findByText(dom.container, 'Clear 4?')).toHaveLength(0);
  });

  it('a clear that MOVES the unread total re-reads the inbox once (through the total), not twice', async () => {
    await act(async () => { client.applyUnreadCounts('p1', { total: 7, byDock: { [CAL]: 7 } }, false); });
    responder = inboxResponder([calendarGroup]);
    await render(inbox('all'));
    expect(listCalls().filter((c) => c.url.startsWith('/api/notifications?groups='))).toHaveLength(1);
    await press(findByText(dom.container, 'Clear')[0]);
    await press(findByText(dom.container, 'Clear 7?')[0]);
    expect(listCalls().filter((c) => c.url.startsWith('/api/notifications?groups='))).toHaveLength(2);
  });

  it('an expanded group keeps its rows on screen while a reload re-reads its page (no 30 → 4 → 30 flicker)', async () => {
    const more = Array.from({ length: 30 }, (_, i) => row(`p${i}`, 100 - i));
    let hold: ((v: unknown) => void) | null = null;
    let pageReads = 0;
    responder = inboxResponder([calendarGroup], () => {
      pageReads += 1;
      if (pageReads === 1) return { rows: more, nextBefore: 71 };
      return new Promise((resolve) => { hold = resolve; });
    });
    await render(inbox('all'));
    await press(byAttr('aria-expanded', 'false')[0]);
    expect(rowButtons()).toHaveLength(30);
    await act(async () => { client.applyUnreadCounts('p1', { total: 3, byDock: { [CAL]: 3 } }, true); });
    await settle();
    expect(pageReads).toBe(2);
    expect(rowButtons()).toHaveLength(30);
    await act(async () => { hold?.({ rows: more.slice(0, 29), nextBefore: null }); });
    await settle();
    expect(rowButtons()).toHaveLength(29);
  });

  it('clearing an app with only READ rows still re-reads the inbox (no unread number moves)', async () => {
    responder = inboxResponder([filesGroup]);
    await render(inbox('all'));
    await press(findByText(dom.container, 'Clear')[0]);
    responder = inboxResponder([]);
    await press(findByText(dom.container, 'Clear 2?')[0]);
    expect(listCalls()).toHaveLength(2);
    expect(rowButtons()).toHaveLength(0);
  });

  it('an armed Clear disarms on a reload (the unread number moved) and after 4 s', async () => {
    responder = inboxResponder([calendarGroup]);
    await render(inbox('all'));
    await press(findByText(dom.container, 'Clear')[0]);
    expect(findByText(dom.container, 'Clear 7?')).toHaveLength(1);
    await act(async () => { client.applyUnreadCounts('p1', { total: 3, byDock: { [CAL]: 3 } }, true); });
    await settle();
    expect(listCalls()).toHaveLength(2);
    expect(findByText(dom.container, 'Clear 7?')).toHaveLength(0);

    vi.useFakeTimers();
    await press(findByText(dom.container, 'Clear')[0]);
    expect(findByText(dom.container, 'Clear 7?')).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(CLEAR_CONFIRM_MS); });
    expect(findByText(dom.container, 'Clear 7?')).toHaveLength(0);
    expect(calls.some((c) => c.url === '/api/notifications/clear')).toBe(false);
  });

  it('entering on Unread with nothing to show while the badge counts something falls back to All', async () => {
    client.applyUnreadCounts('p1', { total: 2, byDock: { [CAL]: 2 } }, false);
    responder = (call) => (call.url.includes('unread=1') ? { groups: [] } : { groups: [filesGroup] });
    await render(inbox('unread'));
    expect(listCalls().map((c) => c.url)).toEqual(['/api/notifications?groups=4&unread=1', '/api/notifications?groups=4']);
    expect(byAttr('aria-selected', 'true')[0]?.textContent).toBe('All');
    expect(rowButtons()).toHaveLength(2);
  });

  it('paired control: an empty Unread with a zero badge stays on Unread ("all caught up")', async () => {
    responder = () => ({ groups: [] });
    await render(inbox('unread'));
    expect(listCalls()).toHaveLength(1);
    expect(findByText(dom.container, 'You’re all caught up.', 'DIV')).toHaveLength(1);
  });
});

describe('"Open in Inbox"', () => {
  it('opens the account popup on its inbox, on the All tab', async () => {
    responder = inboxResponder([filesGroup]);
    await render(createElement(UserInfo));
    await act(async () => { client.requestInboxOpen('all'); });
    await settle();
    expect(byAttr('aria-selected', 'true')[0]?.textContent).toBe('All');
    expect(listCalls().map((c) => c.url)).toEqual(['/api/notifications?groups=4']);
  });
});
