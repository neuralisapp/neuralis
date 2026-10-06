/**
 * The unread badge, the popover rows and the inbox:
 *  - the badge sits on the dock item whose `<packageId>:<dockId>` the counts
 *    name, 1–99 then "99+", in the dock's most severe unread tone, and never
 *    animates on mount;
 *  - the broom stays a SIBLING button (right-middle, `z-10`), never nested in
 *    the item button, and still renders beside the badge;
 *  - a row opens only a widget of its OWN package, through `openWidget`, with
 *    a fresh nav `_ts`;
 *  - the badge is always the ONE lavender unread style, never a tone colour,
 *    and its number costs no row read;
 *  - the inbox heads each app with its own dock icon; the settings choices
 *    are exclusive.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The workspace store, read through a REAL hook (`useSyncExternalStore`) —
// the server renderer would otherwise read the store's creation state, which
// has no project.
const ws = vi.hoisted(() => ({
  state: {
    session: { projectId: 'p1' as string | null, agentId: 'a1' as string | null, workspaceView: 'default' },
    agents: { ids: ['a1'], byId: {}, status: 'success', error: null },
    dockEditing: { primary: false, secondary: false },
    projects: { ids: [] as string[], byId: {} as Record<string, unknown>, status: 'success', error: null },
    runtimeByAgentId: {} as Record<string, unknown>,
    openWidget: (() => null) as (params: unknown) => string | null,
    selectAgent: (() => undefined) as (id: string) => void,
  },
}));
vi.mock('../../store/workspaceStore', async () => {
  const { useSyncExternalStore } = await import('react');
  const useWorkspaceStore = Object.assign(
    <T,>(select: (s: typeof ws.state) => T): T =>
      useSyncExternalStore(() => () => undefined, () => select(ws.state), () => select(ws.state)),
    { getState: () => ws.state },
  );
  return { useWorkspaceStore, agentRuntimeKey: (p: string, a: string) => `${p}:${a}` };
});

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: { user: { id: 'u1', name: 'Ada' } }, status: 'authenticated' }) }));

type HubSub = { channel: string; onEvent: (name: string, payload: unknown) => void };
const hub = vi.hoisted(() => ({ subs: [] as HubSub[] }));
vi.mock('../../realtime/eventHub', () => ({
  subscribeHub: (sub: HubSub) => {
    hub.subs.push(sub);
    return () => { hub.subs = hub.subs.filter((s) => s !== sub); };
  },
  getHubConnected: () => true,
}));

import { DockItemButton, type DockItem } from '../Dock';
import { NOTIFICATION_TONE, ProjectUnreadCount, badgeLabel } from '../DockBadge';
import { NotificationRowButton, openNotificationRow, popoverPosition, relativeTime } from '../NotificationPopover';
import { appIdentity } from '../InboxPanel';
import { prefChoice, withPrefChoice } from '../NotificationPrefs';
import { registerWidget } from '../../widgets/registry';
import { ProjectSwitcher } from '../ProjectSwitcher';
import {
  _resetNotificationsClient,
  applyUnreadCounts,
  retainNotifications,
  type NotificationRow,
} from '../../notifications/notificationsClient';
import type { PackageDockItem } from '../../packages/dockRuntime';

const Glyph: ComponentType<{ className?: string }> = () => null;
const CAL = '@neuralis/agent-core:agent-core.calendar';
const FILES = '@neuralis/brain-core:files';

function item(overrides: Partial<DockItem> = {}): DockItem {
  return {
    id: 'agent-core.calendar',
    position: 100,
    title: 'Calendar',
    icon: Glyph,
    onClick: () => undefined,
    prefKey: CAL,
    group: 'trust:first-party',
    badgeKey: CAL,
    ...overrides,
  };
}

const renderItem = (it: DockItem, chromeless = false): string =>
  renderToStaticMarkup(createElement(DockItemButton, { item: it, hasLabels: false, pinned: true, horizontal: false, edge: 'left', chromeless }));

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

let fetchRows: NotificationRow[] = [];

beforeEach(() => {
  _resetNotificationsClient();
  hub.subs = [];
  fetchRows = [];
  ws.state.session = { projectId: 'p1', agentId: 'a1', workspaceView: 'default' };
  ws.state.agents.ids = ['a1'];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (url.startsWith('/api/notifications/counts')
      ? { projectId: 'p1', unread: { total: 0, byDock: {} } }
      : { rows: fetchRows, nextBefore: null }),
  })));
});

afterEach(() => {
  _resetNotificationsClient();
  vi.unstubAllGlobals();
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe('the badge', () => {
  it('sits on the dock item the counts name — and on no other item', () => {
    applyUnreadCounts('p1', { total: 3, byDock: { [CAL]: 3 } }, false);
    expect(renderItem(item())).toContain('aria-label="3 new in Calendar — show"');
    const files = renderItem(item({ id: 'files', title: 'Files', prefKey: FILES, badgeKey: FILES }));
    expect(files).not.toContain('new in');
  });

  it('keys on the MANIFEST package id — a wire-type-prefix key reaches no badge', () => {
    applyUnreadCounts('p1', { total: 1, byDock: { 'agent-core:agent-core.calendar': 1 } }, false);
    expect(renderItem(item())).not.toContain('new in');
  });

  it('1–99, then "99+"', () => {
    expect(badgeLabel(1)).toBe('1');
    expect(badgeLabel(99)).toBe('99');
    expect(badgeLabel(100)).toBe('99+');
    applyUnreadCounts('p1', { total: 140, byDock: { [CAL]: 140 } }, false);
    expect(renderItem(item())).toContain('>99+<');
  });

  it('is ALWAYS lavender, whatever the tone: the 14 px pill with 9 px semibold dark digits, the cut-out ring — and the number costs no row read', async () => {
    const release = retainNotifications('p1');
    await flush();
    (hub.subs[0] as HubSub).onEvent('counts', { projectId: 'p1', unread: { total: 2, byDock: { [CAL]: 2 } } });
    await flush();
    const html = renderItem(item());
    expect(html).toMatch(/class="[^"]*h-\[14px\] min-w-\[14px\][^"]*text-\[9px\] font-semibold[^"]*tabular-nums/);
    expect(html).toContain('background-color:#cba6f7;color:#0a0a0a;box-shadow:0 0 0 2px rgb(var(--w-bg-rgb, 14, 15, 18))');
    for (const tone of Object.values(NOTIFICATION_TONE)) expect(html).not.toContain(tone.rail);
    const calls = (fetch as unknown as { mock: { calls: Array<[string]> } }).mock.calls.map(([url]) => url);
    expect(calls.filter((url) => url.startsWith('/api/notifications?'))).toEqual([]);
    release();
  });

  it('every unread number shares ONE style: the badge, the switcher number and the Inbox count (source: one lavender literal)', () => {
    applyUnreadCounts('p2', { total: 5, byDock: { [CAL]: 5 } }, false);
    expect(renderToStaticMarkup(createElement(ProjectUnreadCount, { projectId: 'p2' }))).toContain('background-color:#cba6f7;color:#0a0a0a');
    const source = (file: string): string => readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf-8');
    expect(source('DockBadge.tsx').match(/cba6f7/gi)).toHaveLength(1);
    expect(source('UserInfo.tsx').match(/cba6f7/gi)).toBeNull();
    expect(source('UserInfo.tsx')).toMatch(/style=\{UNREAD_PILL_STYLE\}/);
    expect(source('UserInfo.tsx')).toMatch(/<UnreadDot /);
    expect(source('ProjectSwitcher.tsx')).toMatch(/<UnreadDot /);
  });

  it('does not animate on mount, even after earlier arrivals', () => {
    applyUnreadCounts('p1', { total: 0, byDock: {} }, false);
    applyUnreadCounts('p1', { total: 2, byDock: { [CAL]: 2 } }, true);
    const html = renderItem(item());
    expect(html).toContain('new in Calendar');
    // (the keyframes' own <style> names the classes; no ELEMENT carries them)
    expect(html).not.toMatch(/class="[^"]*nrs-dock-badge-(pop|ring)/);
  });

  it('nothing unread ⇒ no pill', () => {
    expect(renderItem(item({ onClean: undefined }))).not.toContain('new in');
  });
});

describe('the broom stays reachable beside the badge', () => {
  it('a SIBLING button, right-middle, z-10 — never inside the item button', () => {
    applyUnreadCounts('p1', { total: 1, byDock: { [CAL]: 1 } }, false);
    const html = renderItem(item({ onClean: () => undefined }));
    expect(html).toContain('aria-label="Clean Calendar"');
    expect(html).toContain('aria-label="1 new in Calendar — show"');
    // The item button closes before the broom opens — siblings, not nested.
    expect(html).toMatch(/<\/button><button type="button" class="absolute right-0\.5 top-1\/2 -translate-y-1\/2 z-10[^"]*" title="Clean Calendar"/);
  });

  it('edit mode (chromeless) shows the item alone', () => {
    applyUnreadCounts('p1', { total: 1, byDock: { [CAL]: 1 } }, false);
    const html = renderItem(item({ onClean: () => undefined }), true);
    expect(html).not.toContain('Clean Calendar');
    expect(html).not.toContain('new in');
  });
});

describe('opening a row', () => {
  const calendar = { type: 'calendar', title: 'Calendar', packageId: '@neuralis/agent-core', render: () => createElement('div') };

  it("opens its OWN package's widget through openWidget, with a fresh nav _ts", () => {
    registerWidget(calendar);
    const openWidget = vi.fn((_params: unknown) => 'w1');
    ws.state.openWidget = openWidget;
    const nav = { widgetType: 'calendar', initialState: { nav: { kind: 'calendar', action: 'open-workflow', workflowId: 'wf-1' } } };
    expect(openNotificationRow(row('1', { nav }))).toBe(true);
    expect(openWidget).toHaveBeenCalledTimes(1);
    const params = openWidget.mock.calls[0]?.[0] as unknown as { agentId: string; type: string; title: string; initialState: { nav: Record<string, unknown> } };
    expect(params.agentId).toBe('a1');
    expect(params.type).toBe('calendar');
    expect(params.title).toBe('Calendar');
    expect(params.initialState.nav).toMatchObject({ kind: 'calendar', action: 'open-workflow', workflowId: 'wf-1' });
    expect(typeof params.initialState.nav._ts).toBe('number');
  });

  it("a nav naming ANOTHER package's widget opens nothing", () => {
    registerWidget(calendar);
    const openWidget = vi.fn((_params: unknown) => 'w1');
    ws.state.openWidget = openWidget;
    expect(openNotificationRow(row('1', { packageId: '@neuralis/brain-core', nav: { widgetType: 'calendar' } }))).toBe(false);
    expect(openNotificationRow(row('1', { nav: undefined }))).toBe(false);
    expect(openNotificationRow(row('1', { nav: { widgetType: 'unknown-widget' } }))).toBe(false);
    expect(openWidget).not.toHaveBeenCalled();
  });

  it('with no agent selected it opens beside the first one', () => {
    registerWidget(calendar);
    const openWidget = vi.fn((_params: unknown) => 'w1');
    const selectAgent = vi.fn();
    ws.state.openWidget = openWidget;
    ws.state.selectAgent = selectAgent;
    ws.state.session = { projectId: 'p1', agentId: null, workspaceView: 'default' };
    expect(openNotificationRow(row('1', { nav: { widgetType: 'calendar' } }))).toBe(true);
    expect(selectAgent).toHaveBeenCalledWith('a1');
  });
});

describe('the popover', () => {
  it('opens away from the dock edge', () => {
    const anchor = { top: 100, left: 10, right: 58, bottom: 140 };
    const viewport = { width: 1200, height: 800 };
    expect(popoverPosition(anchor, 'left', viewport)).toMatchObject({ top: 100, left: 66 });
    expect(popoverPosition({ top: 100, left: 1142, right: 1190, bottom: 140 }, 'right', viewport)).toMatchObject({ top: 100, right: 66 });
    expect(popoverPosition({ top: 752, left: 300, right: 348, bottom: 800 }, 'bottom', viewport)).toMatchObject({ bottom: 56, left: 300 });
    expect(popoverPosition({ top: 0, left: 1180, right: 1228, bottom: 48 }, 'top', viewport)).toMatchObject({ top: 56, left: 888 });
  });

  it('a row: tone rail, title, time and ×N when merged', () => {
    const html = renderToStaticMarkup(createElement(NotificationRowButton, { row: row('1', { count: 3 }), faded: false, onOpen: () => undefined }));
    expect(html).toContain('Daily report — Workflow run failed');
    expect(html).toContain('×3');
    expect(html).toContain(`background-color:${NOTIFICATION_TONE.error.rail};opacity:1`);
    const seen = renderToStaticMarkup(createElement(NotificationRowButton, { row: row('1'), faded: true, onOpen: () => undefined }));
    expect(seen).toContain('opacity:0.28');
    expect(seen).not.toContain('×1');
  });

  it('relative time', () => {
    const now = Date.parse('2026-10-02T12:00:00.000Z');
    expect(relativeTime('2026-10-02T11:59:50.000Z', now)).toBe('now');
    expect(relativeTime('2026-10-02T11:55:00.000Z', now)).toBe('5m');
    expect(relativeTime('2026-10-02T09:00:00.000Z', now)).toBe('3h');
    expect(relativeTime('2026-09-30T12:00:00.000Z', now)).toBe('2d');
  });
});

describe('the inbox', () => {
  it("an app is headed by its own dock icon, colour and label; a dockless one by a bell and its name", () => {
    const dockItems: PackageDockItem[] = [
      { id: 'agent-core.calendar', label: 'Calendar', icon: 'CalendarDays', color: '#cba6f7', position: 30, dock: 'primary', packageId: '@neuralis/agent-core', onClick: { kind: 'openWidget', widgetType: 'calendar' } },
    ];
    const found = appIdentity(CAL, '@neuralis/agent-core', dockItems);
    expect(found).toMatchObject({ label: 'Calendar', color: '#cba6f7' });
    expect(appIdentity(null, '@neuralis/brain-core', dockItems)).toMatchObject({ label: 'brain-core' });
  });
});

describe('notification settings', () => {
  it('one choice per kind — never muted and followed at once', () => {
    let prefs = { mute: [], follow: [] } as { mute: string[]; follow: string[] };
    prefs = withPrefChoice(prefs, 't1', 'follow');
    expect(prefChoice(prefs, 't1')).toBe('follow');
    prefs = withPrefChoice(prefs, 't1', 'mute');
    expect(prefs).toEqual({ mute: ['t1'], follow: [] });
    prefs = withPrefChoice(prefs, 't1', 'default');
    expect(prefs).toEqual({ mute: [], follow: [] });
    expect(prefChoice({ mute: ['x'], follow: ['x'] }, 'x')).toBe('mute');
  });
});

describe('the switcher row number and the avatar number agree', () => {
  it('a counts read sets both from the same total', () => {
    applyUnreadCounts('p2', { total: 5, byDock: { [CAL]: 5 } }, false);
    expect(renderToStaticMarkup(createElement(ProjectUnreadCount, { projectId: 'p2' }))).toContain('>5<');
    expect(renderToStaticMarkup(createElement(ProjectUnreadCount, { projectId: 'p3' }))).toBe('');
  });
});

describe('the project switcher button: a number-less dot for unread in ANOTHER project', () => {
  const project = (id: string) => ({ id, name: id, ownerId: 'u1', members: { u1: { role: 'member' } }, roles: { member: { priority: 20 } } });
  const button = (): string => renderToStaticMarkup(createElement(ProjectSwitcher, { expanded: false }));
  const DOT = 'background-color:#cba6f7;box-shadow:0 0 0 2px rgb(var(--w-bg-rgb, 14, 15, 18))';

  beforeEach(() => {
    ws.state.projects.ids = ['p1', 'p2'];
    ws.state.projects.byId = { p1: project('p1'), p2: project('p2') };
    ws.state.session = { projectId: 'p1', agentId: 'a1', workspaceView: 'default' };
  });

  it('on when another project\'s frame raises it above 0; off once that project is read (frame → 0)', async () => {
    expect(button()).not.toContain(DOT);
    const release = retainNotifications('p1');
    await flush();
    (hub.subs[0] as HubSub).onEvent('counts', { projectId: 'p2', unread: { total: 2, byDock: { [CAL]: 2 } } });
    expect(button()).toContain(DOT);
    expect(button()).toContain('unread in another project');
    (hub.subs[0] as HubSub).onEvent('counts', { projectId: 'p2', unread: { total: 0, byDock: {} } });
    expect(button()).not.toContain(DOT);
    release();
  });

  it('off when only the CURRENT project has unread (its own badges say so)', () => {
    applyUnreadCounts('p1', { total: 4, byDock: { [CAL]: 4 } }, false);
    expect(button()).not.toContain(DOT);
  });

  it('the dot is the avatar\'s dot — ONE component, both places', () => {
    const source = (file: string): string => readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf-8');
    expect(source('UserInfo.tsx').match(/<UnreadDot className="absolute top-2 right-2\.5" \/>/g)).toHaveLength(1);
    expect(source('ProjectSwitcher.tsx').match(/<UnreadDot className="absolute top-2 right-2\.5" \/>/g)).toHaveLength(1);
  });
});

describe('the project switcher button shows the CURRENT project', () => {
  const project = (id: string, appearance?: Record<string, unknown>) => ({
    id,
    name: id === 'p1' ? 'Atlas' : 'Borealis',
    ownerId: 'u1',
    members: { u1: { role: 'member' } },
    roles: { member: { priority: 20 } },
    ...(appearance ? { appearance } : {}),
  });
  const renderButton = (): string => renderToStaticMarkup(createElement(ProjectSwitcher, { expanded: false }));

  it("renders the current project's appearance; switching projects switches it; no appearance ⇒ the folder", () => {
    ws.state.projects.ids = ['p1', 'p2', 'p3'];
    ws.state.projects.byId = {
      p1: project('p1', { iconName: 'Rocket', color: '#224466' }),
      p2: project('p2', { iconName: 'Store', color: '#aa3355', background: 'transparent' }),
      p3: project('p3'),
    };
    ws.state.session = { projectId: 'p1', agentId: 'a1', workspaceView: 'default' };
    const atlas = renderButton();
    expect(atlas).toContain('aria-label="Atlas"');
    expect(atlas).toContain('background-color:#224466');
    expect(atlas).not.toContain('lucide-folder-open');

    ws.state.session = { projectId: 'p2', agentId: 'a1', workspaceView: 'default' };
    const borealis = renderButton();
    expect(borealis).toContain('aria-label="Borealis"');
    // Transparent background: the icon in the colour, no tile.
    expect(borealis).toContain('color:#aa3355');
    expect(borealis).not.toContain('background-color:#aa3355');

    ws.state.session = { projectId: 'p3', agentId: 'a1', workspaceView: 'default' };
    expect(renderButton()).toContain('lucide-folder-open');
  });
});
