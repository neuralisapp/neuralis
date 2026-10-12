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
import { click, findByText, installFakeDom, FakeNode } from './fakeDom';

const dom = installFakeDom();

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: { user: { id: 'u1', name: 'Ada' } }, status: 'authenticated' }) }));
const dockFixture = vi.hoisted(() => ({
  items: (dockId: string) => [1, 2, 3].map((n) => ({ id: `${dockId}-${n}`, position: n, title: `${dockId} ${n}`, icon: () => null, onClick: () => undefined })),
}));
vi.mock('../useDockItems', () => ({
  usePackageDockItems: () => [],
  usePrimaryDockItems: () => dockFixture.items('primary'),
  useSecondaryDockItems: () => dockFixture.items('secondary'),
}));
vi.mock('../AnimatedUniverseBackground', () => ({ AnimatedUniverseBackground: () => null }));
vi.mock('../../theme/useTheme', async () => {
  const { DEFAULT_THEME } = await import('../../theme/themes');
  return { useTheme: () => ({ theme: DEFAULT_THEME, backgroundTheme: DEFAULT_THEME, dockTheme: DEFAULT_THEME }) };
});
Object.assign(window, { innerWidth: 1280, innerHeight: 800, screen: { width: 1280, height: 800 } });
vi.mock('../UserAvatar', () => ({ UserAvatar: () => null }));
vi.mock('../UserProfilePopup', () => ({ UserProfilePopup: () => null }));
vi.mock('../../realtime/eventHub', () => ({ subscribeHub: () => () => undefined, getHubConnected: () => true }));

const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useWorkspaceStore } = await import('../../store/workspaceStore');
const { Dock } = await import('../Dock');
const { WorkspaceShell } = await import('../WorkspaceShell');
const { DockScrollContainer } = await import('../DockScrollContainer');
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
      placement: { dockId, anchor: dockId === 'primary' ? 'top-left' : 'top-right', orientation: 'vertical' },
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


describe('bounded native dock scrolling', () => {
  it('coalesces wheel bursts, preserves native pinch/boundaries, and shares one observer root', async () => {
    const frames = new Map<number, FrameRequestCallback>(); let next = 0;
    const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(fn => { frames.set(++next, fn); return next; });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => { frames.delete(id); });
    let wheel: ((event: unknown) => void) | undefined; let scroll: (() => void) | undefined;
    const attach = vi.spyOn(FakeNode.prototype, 'addEventListener').mockImplementation(function (name, fn) {
      if (name === 'wheel') wheel = fn;
      if (name === 'scroll') scroll = () => fn({});
    });
    const detach = vi.spyOn(FakeNode.prototype, 'removeEventListener');
    const disconnect = vi.fn(); const observe = vi.fn();
    vi.stubGlobal('ResizeObserver', class { observe = observe; disconnect = disconnect; });
    let at = 0; const move = vi.fn((options: { left: number }) => { at += options.left; });
    Object.defineProperties(FakeNode.prototype, {
      clientWidth: { configurable: true, get: () => 100 }, scrollWidth: { configurable: true, get: () => 500 },
      scrollLeft: { configurable: true, get: () => at }, scrollBy: { configurable: true, value: move },
    });
    try {
      await render(createElement(DockScrollContainer, { children: createElement('span', null, 'First / Last') }));
      expect(observe).toHaveBeenCalledTimes(1);
      const preventDefault = vi.fn();
      const event = { deltaX: 0, deltaY: 400, deltaMode: 0, ctrlKey: false, preventDefault };
      await act(async () => { wheel?.(event); wheel?.(event); });
      expect(frames.size).toBe(1); expect(move).not.toHaveBeenCalled();
      await act(async () => { const [id, fn] = [...frames][0]; frames.delete(id); fn(0); });
      expect(move).toHaveBeenCalledExactlyOnceWith({ left: 100 });
      // The arrows overlay the scroller's ends; they never take a place in the item flow.
      expect(byAttr('aria-label', 'Scroll dock backward')[0]?.getAttribute('class')).toContain('absolute left-0');
      preventDefault.mockClear(); wheel?.({ ...event, ctrlKey: true }); expect(preventDefault).not.toHaveBeenCalled();
      at = 400;
      await act(async () => { scroll?.(); const [id, fn] = [...frames][0]; frames.delete(id); fn(0); });
      expect(byAttr('aria-label', 'Scroll dock forward')).toHaveLength(0);
      wheel?.(event); expect(preventDefault).not.toHaveBeenCalled();
      await act(async () => root!.unmount()); root = null;
      expect(disconnect).toHaveBeenCalledTimes(1); expect(frames.size).toBe(0);
      expect(detach.mock.calls.some(([name]) => name === 'wheel')).toBe(true);
    } finally {
      request.mockRestore(); cancel.mockRestore(); attach.mockRestore(); detach.mockRestore(); vi.unstubAllGlobals();
      for (const name of ['clientWidth', 'scrollWidth', 'scrollLeft', 'scrollBy']) Reflect.deleteProperty(FakeNode.prototype, name);
    }
  });
});

// ─── Dock lanes in the mounted shell ────────────────────────────────────────

describe('dock lanes in the mounted shell', () => {
  const layout = (anchor: string, orientation: string, dockBackground: 'classic' | 'toolbar', secondaryAnchor = anchor) => JSON.stringify({
    primary: { dockId: 'primary', anchor, orientation },
    secondary: { dockId: 'secondary', anchor: secondaryAnchor, orientation },
    dockBackground,
  });
  const props = (node: FakeNode): Record<string, (event?: unknown) => void> =>
    node[Object.keys(node).find((k) => k.startsWith('__reactProps$'))!] as Record<string, (event?: unknown) => void>;
  const shell = () => createElement(WorkspaceShell, { snapshotReady: true, children: null });

  afterEach(() => { window.localStorage.clear(); });

  it.each([
    ['classic', 'bottom', 'bottom', 'horizontal', ['primary', 'secondary']],
    ['toolbar', 'bottom', 'bottom', 'horizontal', ['primary', 'secondary']],
    ['classic', 'right', 'top-right', 'vertical', ['secondary', 'primary']],
    ['toolbar', 'right', 'top-right', 'vertical', ['secondary', 'primary']],
  ] as const)('two docks on one anchor or neighbouring anchors share ONE cluster, one after the other (%s, %s + %s, %s)', async (background, primary, secondary, orientation, order) => {
    window.localStorage.setItem('neuralis:workspace:dockLayout', layout(primary, orientation, background, secondary));
    await render(shell());
    const clusters = byAttr('data-dock-cluster');
    expect(clusters).toHaveLength(1);
    const capsules = clusters[0].querySelectorAll('[data-dock-capsule]');
    expect(capsules.map((c) => c.getAttribute('data-dock-capsule'))).toEqual([...order]);
    // Siblings in one flex line: they can only sit one after the other, never on top of each other — and flush.
    expect(capsules[0].parentNode).toBe(capsules[1].parentNode);
    expect(clusters[0].getAttribute('class')).not.toMatch(/\bgap-/);
    const [first, second] = orientation === 'horizontal' ? ['Right', 'Left'] : ['Bottom', 'Top'];
    if (background === 'classic') {
      expect(capsules[0].style.borderTopWidth || undefined).toBeUndefined();
    } else {
      // ONE contour: the shared side has no border and square corners; the outer side keeps both.
      expect(capsules[0].style[`border${first}Width`]).toBe('0');
      expect(capsules[1].style[`border${second}Width`]).toBe('0');
      expect(capsules[0].style[`border${second}Width`]).toBe('1px');
    }
  });

  it('the join writes nothing: the stored background and transparencies are the ones the user chose', async () => {
    window.localStorage.setItem('neuralis:workspace:dockLayout', layout('left', 'vertical', 'classic'));
    const before = window.localStorage.getItem('neuralis:workspace:dockLayout');
    await render(shell());
    expect(window.localStorage.getItem('neuralis:workspace:dockLayout')).toBe(before);
  });

  it('a hover dock\'s trigger lies INSIDE its own cluster; hovering it opens the dock, pinned docks get no trigger', async () => {
    window.localStorage.setItem('neuralis:workspace:dockLayout', JSON.stringify({
      primary: { dockId: 'primary', anchor: 'bottom', orientation: 'horizontal' },
      secondary: { dockId: 'secondary', anchor: 'right', orientation: 'vertical' },
    }));
    window.localStorage.setItem('neuralis:workspace:dockMode:primary', 'iconHover');
    await render(shell());
    const [hoverCluster, pinnedCluster] = byAttr('data-dock-cluster');
    const trigger = hoverCluster.childNodes[0];
    expect(trigger.getAttribute('aria-hidden')).toBe('true');
    expect(trigger.getAttribute('class')).toContain('-bottom-1');
    expect(trigger.getAttribute('class')).toContain('pointer-events-auto');
    const capsule = hoverCluster.querySelectorAll('[data-dock-capsule]')[0];
    expect(capsule.getAttribute('class')).toContain('opacity-0');
    expect(capsule.getAttribute('class')).toContain('pointer-events-none');
    await act(async () => { props(hoverCluster).onMouseEnter(); });
    expect(capsule.getAttribute('class')).toContain('opacity-100');
    expect(capsule.getAttribute('class')).toContain('pointer-events-auto');
    expect(pinnedCluster.querySelectorAll('[aria-hidden="true"]').filter((n) => String(n.getAttribute('class')).includes('pointer-events-auto'))).toHaveLength(0);
    // The cluster itself never takes a click — only its trigger and an open dock do.
    expect(hoverCluster.getAttribute('class')).toContain('pointer-events-none');
  });

  it('two docks on the right column: one lane at the label width, the icon dock flush with the screen edge', async () => {
    window.localStorage.setItem('neuralis:workspace:dockLayout', JSON.stringify({
      primary: { dockId: 'primary', anchor: 'top-right', orientation: 'vertical' },
      secondary: { dockId: 'secondary', anchor: 'bottom-right', orientation: 'vertical' },
    }));
    window.localStorage.setItem('neuralis:workspace:dockMode:primary', 'labelPinned');
    await render(shell());
    const lanes = byAttr('data-dock-lane');
    expect(lanes.map((l) => l.getAttribute('data-dock-lane'))).toEqual(['vertical:right']);
    expect(lanes[0].getAttribute('class')).toContain('items-end');
    expect(lanes[0].style.width).toBe('11rem');
    expect(lanes[0].style.right).toBe('0');
    expect(byAttr('data-dock-capsule', 'secondary')[0].style.width).toBe('3.5rem');
    expect(byAttr('data-dock-cluster').map((c) => c.getAttribute('class'))).toEqual([
      expect.not.stringContaining('mt-auto'), expect.stringContaining('mt-auto'),
    ]);
  });

  it('a hidden dock shows a 3 px edge indicator inside its trigger, gone while the dock is revealed; a pinned dock has none', async () => {
    window.localStorage.setItem('neuralis:workspace:dockLayout', JSON.stringify({
      primary: { dockId: 'primary', anchor: 'bottom', orientation: 'horizontal' },
      secondary: { dockId: 'secondary', anchor: 'right', orientation: 'vertical' },
    }));
    window.localStorage.setItem('neuralis:workspace:dockMode:primary', 'labelHoverHidden');
    await render(shell());
    const [hoverCluster, pinnedCluster] = byAttr('data-dock-cluster');
    const indicator = hoverCluster.childNodes[0].querySelectorAll('[data-dock-edge-indicator]')[0];
    expect(indicator).toBeDefined();
    expect(indicator.getAttribute('class')).toContain('h-[3px]');
    expect(indicator.getAttribute('class')).toContain('pointer-events-none');
    expect(indicator.getAttribute('class')).toContain('opacity-100');
    expect(indicator.style.backgroundColor).toBe('rgba(var(--surface-tone-rgb), 0.35)');
    await act(async () => { props(hoverCluster).onMouseEnter(); });
    expect(indicator.getAttribute('class')).toContain('opacity-0');
    expect(pinnedCluster.querySelectorAll('[data-dock-edge-indicator]')).toHaveLength(0);
  });

  it('the rotate control sits IN the grip\'s hover group and in flow: reached without leaving it, hidden it is not hit-testable and covers only the dock', async () => {
    window.localStorage.setItem('neuralis:workspace:dockLayout', layout('top-right', 'vertical', 'classic'));
    await render(shell());
    const capsule = byAttr('data-dock-capsule', 'primary')[0];
    const gripWrap = capsule.childNodes[0];
    expect(gripWrap.getAttribute('class')).toContain('group/grip');
    const rotate = byAttr('data-dock-rotate')[0];
    // A flow sibling of the grip inside the same group — no margin gap, no absolute overlay over the stage.
    expect(rotate.parentNode).toBe(gripWrap);
    expect(rotate.getAttribute('class')).not.toMatch(/\babsolute\b|\b(ml|mr|mt|mb)-\d/);
    expect(rotate.getAttribute('class')).toContain('opacity-0');
    expect(rotate.getAttribute('class')).toContain('pointer-events-none');
    expect(rotate.getAttribute('class')).toContain('group-hover/grip:pointer-events-auto');
  });

  it('the background image follows the Background material, never the Universe toggle', async () => {
    for (const [level, opacity] of [['opaque', '1'], ['dim', '0.6'], ['transparent', '0.34']] as const) {
      window.localStorage.setItem('neuralis:workspace:dockLayout', JSON.stringify({ backgroundTransparency: level }));
      await render(shell());
      const image = dom.container.querySelectorAll('DIV').find((n) => n.style.backgroundImage === 'var(--bg-image)')!;
      expect([level, String(image.style.opacity)]).toEqual([level, opacity]);
      await act(async () => root!.unmount()); root = null;
    }
  });

  it('the grip is in the item flow, and its picker offers the eight anchors (no centre) and both orientations', async () => {
    window.localStorage.setItem('neuralis:workspace:dockLayout', layout('left', 'vertical', 'classic'));
    await render(shell());
    const capsule = byAttr('data-dock-capsule', 'primary')[0];
    const gripWrap = capsule.childNodes[0];
    expect(gripWrap.getAttribute('class')).not.toContain('absolute');
    const grip = byAttr('aria-label', 'Move primary dock')[0];
    await act(async () => { props(grip).onClick({ detail: 0 }); });
    const picker = byAttr('aria-label', 'primary dock position')[0];
    const anchors = picker.querySelectorAll('[aria-label]').filter((n) => String(n.getAttribute('aria-label')).startsWith('Anchor '));
    expect(anchors.map((n) => n.getAttribute('aria-label')).sort()).toEqual([
      'Anchor bottom', 'Anchor bottom-left', 'Anchor bottom-right', 'Anchor left', 'Anchor right', 'Anchor top', 'Anchor top-left', 'Anchor top-right',
    ]);
    await press(byAttr('aria-label', 'Horizontal')[0]);
    expect(JSON.parse(window.localStorage.getItem('neuralis:workspace:dockLayout')!).primary).toEqual({ dockId: 'primary', anchor: 'left', orientation: 'horizontal' });
    await act(async () => { props(byAttr('aria-label', 'Move primary dock')[0]).onClick({ detail: 0 }); });
    await press(byAttr('aria-label', 'Anchor top-right')[0]);
    expect(JSON.parse(window.localStorage.getItem('neuralis:workspace:dockLayout')!).primary).toEqual({ dockId: 'primary', anchor: 'top-right', orientation: 'horizontal' });
    expect(byAttr('aria-label', 'primary dock position')).toHaveLength(0);
  });
});

describe('the Apps footer', () => {
  const Glyph = () => null;
  const items = [
    ...[1, 2, 3].map((n) => ({ id: `app-${n}`, position: n, title: `App ${n}`, icon: Glyph, onClick: () => undefined })),
    { id: 'apps', position: 9999, title: 'Apps', icon: Glyph, onClick: () => undefined, section: 'footer' as const },
  ];
  const buttonOf = (title: string): FakeNode => byAttr('title', title)[0];

  it.each(['iconPinned', 'labelPinned', 'iconHover', 'labelHoverHidden'] as const)('rides OUTSIDE the scroller, after it, in every dock mode and orientation (%s)', async (mode) => {
    for (const orientation of ['vertical', 'horizontal'] as const) {
      await render(createElement(Dock, { dockId: 'primary', placement: { dockId: 'primary', anchor: 'top-left', orientation }, mode, onChangeMode: () => undefined, items }));
      const capsule = byAttr('data-dock-capsule', 'primary')[0];
      const footer = byAttr('data-dock-footer')[0];
      expect(footer.parentNode).toBe(capsule);
      expect(capsule.childNodes.at(-1)).toBe(footer);
      expect(footer.contains(buttonOf('Apps'))).toBe(true);
      // Paired control: a main item stays inside the scroller, never in the footer.
      expect(footer.contains(buttonOf('App 3'))).toBe(false);
      expect(capsule.contains(buttonOf('App 3'))).toBe(true);
      await act(async () => root!.unmount()); root = null;
    }
  });

  it('a dock running reversed from its corner keeps the footer on the main items\' outer end: before the scroller', async () => {
    await render(createElement(Dock, { dockId: 'primary', placement: { dockId: 'primary', anchor: 'bottom-left', orientation: 'vertical' }, mode: 'iconPinned', onChangeMode: () => undefined, items }));
    const capsule = byAttr('data-dock-capsule', 'primary')[0];
    const footer = byAttr('data-dock-footer')[0];
    expect(footer.parentNode).toBe(capsule);
    expect(capsule.childNodes.at(-1)).not.toBe(footer);
  });
});
