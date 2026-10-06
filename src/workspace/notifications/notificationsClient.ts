'use client';

/**
 * The workspace's notification client — unread COUNTS for the badges, the
 * avatar dot and the project switcher, plus the calls the popover, the inbox
 * and the settings make.
 *
 * ONE `notifications` hub subscription per project, refcounted: `WorkspaceRoot`
 * holds its project's feed ABOVE the package provider wrap (everything below
 * it — the shell, the docks — remounts when a provider attaches or the layout
 * regroups the docks) and the first retain subscribes, fetches the counts once
 * and the other projects' totals (`ensureProjectCounts`, for the switcher
 * button's dot) and arms a reconnect detector (the hub has no replay, so the
 * counts are re-read once when the connection comes BACK); the last release unsubscribes
 * one macrotask later, so a remounting holder re-holds without a re-read. No
 * poll. A frame carries numbers only
 * (`{ projectId, unread: { total, byDock } }`), and it can name another of the
 * user's projects — that one updates the switcher's per-row number.
 *
 * Every read is a PRIMITIVE selector (`useSyncExternalStore`), so a frame
 * re-renders exactly the badge whose number moved. The badge is one colour,
 * so a number costs no row read.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { createReconnectDetector } from '@neuralis/package-system/client';
import { getHubConnected, subscribeHub } from '../realtime/eventHub';
import type { PackageEventTone } from '@neuralis/package-system/contracts';
import { packageDockKey } from '../shell/dockOrder';

export type UnreadCounts = { total: number; byDock: Record<string, number> };

/** Where a row opens — a widget of the publishing package, with a state the host never interprets. */
export type NotificationNav = { widgetType: string; initialState?: Record<string, unknown> };

/** A row as `GET /api/notifications` serves it. */
export type NotificationRow = {
  seq: number;
  id: string;
  type: string;
  packageId: string;
  dock?: string;
  subjectId: string;
  tone: PackageEventTone;
  title: string;
  at: string;
  count: number;
  nav?: NotificationNav;
  read: boolean;
};

export type NotificationPage = { rows: NotificationRow[]; nextBefore: number | null };

export type ReadSelection = { ids: string[] } | { dock: string } | { all: true };

/** What a clear deletes: one app's rows (a {@link NotificationGroup} `key`) or every row. */
export type ClearSelection = { group: string } | { all: true };

/** One app's rows as `GET /api/notifications?groups=` serves them. */
export type NotificationGroup = {
  /** `<packageId>:<dock>`, or the bare package id for rows without a dock. */
  key: string;
  packageId: string;
  dock?: string;
  /** Entries (a merged row counts once), read or not — what a clear deletes. */
  total: number;
  unread: number;
  /** The newest rows of the group. */
  rows: NotificationRow[];
};

export type InboxView = 'unread' | 'all';

export type NotificationCatalogEntry = {
  type: string;
  packageId: string;
  title: string;
  description?: string;
  tone: PackageEventTone;
  defaultOn: boolean;
  dock?: string;
};

export type NotificationPrefs = { mute: string[]; follow: string[] };

type State = {
  counts: Record<string, UnreadCounts>;
  /** projectId → unread total, for the switcher (frames + `scope=all`). */
  byProject: Record<string, number>;
  /** `<projectId>|<dockKey>` → how many times a FRAME raised that number (the badge "pop"). */
  arrivals: Record<string, number>;
  /** Bumped by "Open in Inbox"; the account popup opens on its inbox view. */
  inboxRequest: number;
  /** The tab the latest inbox request asked for. */
  inboxRequestView: InboxView;
};

const EMPTY_COUNTS: UnreadCounts = { total: 0, byDock: {} };

let state: State = { counts: {}, byProject: {}, arrivals: {}, inboxRequest: 0, inboxRequestView: 'all' };
const listeners = new Set<() => void>();

function setState(patch: (s: State) => State): void {
  const next = patch(state);
  if (next === state) return;
  state = next;
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function useSelect<T extends string | number | boolean | null>(select: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => select(state), () => select(state));
}

// ─── HTTP (host routes, explicit project) ──────────────────────────────────

async function call<T>(path: string, projectId: string | null, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (projectId) headers.set('X-Project-Id', projectId);
  if (init?.body !== undefined) headers.set('Content-Type', 'application/json');
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json() as Promise<T>;
}

function isCounts(value: unknown): value is UnreadCounts {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.total === 'number' && !!v.byDock && typeof v.byDock === 'object';
}

/** Apply a project's counts. From a FRAME, every dock whose number ROSE gets an arrival (the badge pops). */
export function applyUnreadCounts(projectId: string, unread: UnreadCounts, fromFrame: boolean): void {
  setState((s) => {
    const prev = s.counts[projectId] ?? EMPTY_COUNTS;
    let arrivals = s.arrivals;
    if (fromFrame) {
      for (const [key, n] of Object.entries(unread.byDock)) {
        if (n > (prev.byDock[key] ?? 0)) {
          if (arrivals === s.arrivals) arrivals = { ...arrivals };
          const slot = `${projectId}|${key}`;
          arrivals[slot] = (arrivals[slot] ?? 0) + 1;
        }
      }
    }
    return {
      ...s,
      counts: { ...s.counts, [projectId]: { total: unread.total, byDock: { ...unread.byDock } } },
      byProject: { ...s.byProject, [projectId]: unread.total },
      arrivals,
    };
  });
}

async function refreshCounts(projectId: string): Promise<void> {
  try {
    const body = await call<{ projectId: string; unread: unknown }>('/api/notifications/counts', projectId);
    if (isCounts(body.unread)) applyUnreadCounts(projectId, body.unread, false);
  } catch {
    // A missed read keeps the last numbers; the next frame or reconnect corrects them.
  }
}

// ─── The refcounted feed ───────────────────────────────────────────────────

type Feed = { refs: number; stop: () => void; pendingStop: ReturnType<typeof setTimeout> | null };
const feeds = new Map<string, Feed>();

/**
 * Hold the project's counts feed; returns the release. The first hold
 * subscribes and reads the counts; the last release unsubscribes ONE macrotask
 * later, and a hold inside that window cancels it without a re-read — a holder
 * that React REMOUNTS (a wrapper above it changed) releases and re-holds in the
 * same commit, and must not cost a counts read per remount. A true unmount
 * still unsubscribes after the tick.
 */
export function retainNotifications(projectId: string): () => void {
  const existing = feeds.get(projectId);
  if (existing) {
    existing.refs += 1;
    if (existing.pendingStop !== null) {
      clearTimeout(existing.pendingStop);
      existing.pendingStop = null;
    }
  } else {
    const reconnect = createReconnectDetector(getHubConnected, () => { void refreshCounts(projectId); });
    const unsubscribe = subscribeHub({
      projectId,
      channel: 'notifications',
      onEvent: (name, payload) => {
        if (name !== 'counts' || !payload || typeof payload !== 'object') return;
        const frame = payload as { projectId?: unknown; unread?: unknown };
        if (typeof frame.projectId !== 'string' || !isCounts(frame.unread)) return;
        // A frame may name another of the user's projects: its number feeds
        // the switcher (no dock of it is mounted).
        applyUnreadCounts(frame.projectId, frame.unread, true);
      },
      onConnChange: reconnect.onConnChange,
    });
    reconnect.arm();
    feeds.set(projectId, { refs: 1, stop: unsubscribe, pendingStop: null });
    void refreshCounts(projectId);
    // The switcher button's dot needs the OTHER projects' numbers from the
    // start, not only once the switcher opens; live frames keep them current.
    void ensureProjectCounts();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const feed = feeds.get(projectId);
    if (!feed) return;
    feed.refs -= 1;
    if (feed.refs > 0 || feed.pendingStop !== null) return;
    feed.pendingStop = setTimeout(() => {
      feed.pendingStop = null;
      if (feed.refs > 0 || feeds.get(projectId) !== feed) return;
      feeds.delete(projectId);
      feed.stop();
    }, 0);
  };
}

/**
 * Keep the project's feed alive while the calling component is mounted — ONE
 * holder, `WorkspaceRoot`, ABOVE the package provider wrap: a provider that
 * attaches at runtime re-parents everything below it (the shell included).
 */
export function useNotificationsFeed(projectId: string | null): void {
  useEffect(() => (projectId ? retainNotifications(projectId) : undefined), [projectId]);
}

// ─── Primitive selectors ───────────────────────────────────────────────────

export function useDockUnread(projectId: string | null, dockKey: string | undefined): number {
  return useSelect((s) => (projectId && dockKey ? s.counts[projectId]?.byDock[dockKey] ?? 0 : 0));
}

/** Bumped each time a frame RAISES this dock's number — the badge animates on a change of this value, never on mount. */
export function useDockArrival(projectId: string | null, dockKey: string | undefined): number {
  return useSelect((s) => (projectId && dockKey ? s.arrivals[`${projectId}|${dockKey}`] ?? 0 : 0));
}

export function useUnreadTotal(projectId: string | null): number {
  return useSelect((s) => (projectId ? s.counts[projectId]?.total ?? 0 : 0));
}

/** Does any project OTHER than `currentProjectId` have unread notifications? (the switcher button's dot) */
export function useOtherProjectsUnread(currentProjectId: string | null): boolean {
  return useSelect((s) => Object.entries(s.byProject).some(([id, n]) => id !== currentProjectId && n > 0));
}

/** The switcher's per-row number, `null` until known. */
export function useProjectUnread(projectId: string): number | null {
  return useSelect((s) => s.byProject[projectId] ?? null);
}

export function useInboxRequest(): number {
  return useSelect((s) => s.inboxRequest);
}

/** The tab the latest "Open in Inbox" asked for (read when {@link useInboxRequest} moves). */
export function inboxRequestView(): InboxView {
  return state.inboxRequestView;
}

/** "Open in Inbox" — the account popup opens on its inbox view, on `view`. */
export function requestInboxOpen(view: InboxView): void {
  setState((s) => ({ ...s, inboxRequest: s.inboxRequest + 1, inboxRequestView: view }));
}

// ─── The switcher's numbers: one `scope=all` read per popup opening ────────

const PROJECT_COUNTS_FRESH_MS = 2_000;
let projectCountsAt = Number.NEGATIVE_INFINITY;
let projectCountsInFlight: Promise<void> | null = null;

/**
 * Every row of an opening switcher asks; the first asks the server
 * (`?scope=all`, one small state read per membership) and the rest of the
 * burst shares it. Live frames keep the numbers current afterwards.
 */
export function ensureProjectCounts(now: number = Date.now()): Promise<void> {
  if (projectCountsInFlight) return projectCountsInFlight;
  if (now - projectCountsAt < PROJECT_COUNTS_FRESH_MS) return Promise.resolve();
  projectCountsAt = now;
  projectCountsInFlight = call<{ byProject?: unknown }>('/api/notifications/counts?scope=all', null)
    .then((body) => {
      const byProject = body.byProject;
      if (!byProject || typeof byProject !== 'object') return;
      const clean: Record<string, number> = {};
      for (const [id, n] of Object.entries(byProject as Record<string, unknown>)) {
        if (typeof n === 'number') clean[id] = n;
      }
      // The answer IS the membership set: a project the user left drops out (its dot goes off).
      setState((s) => ({ ...s, byProject: clean }));
    })
    .catch(() => undefined)
    .finally(() => { projectCountsInFlight = null; });
  return projectCountsInFlight;
}

// ─── Rows, read marks, settings ────────────────────────────────────────────

/**
 * A page of rows, newest first. With `group`, one app's rows — a page may come
 * back short (the server re-judges after the cut); `nextBefore` says whether
 * there is more.
 */
export async function fetchNotifications(
  projectId: string,
  params: { limit?: number; before?: number | null; unreadOnly?: boolean; group?: string },
): Promise<NotificationPage> {
  const query = new URLSearchParams();
  if (params.limit) query.set('limit', String(params.limit));
  if (params.before !== undefined && params.before !== null) query.set('before', String(params.before));
  if (params.unreadOnly) query.set('unread', '1');
  if (params.group) query.set('group', params.group);
  const qs = query.toString();
  const body = await call<NotificationPage>(`/api/notifications${qs ? `?${qs}` : ''}`, projectId);
  return { rows: Array.isArray(body.rows) ? body.rows : [], nextBefore: body.nextBefore ?? null };
}

/** The inbox: every app's entry count, unread count and newest `perGroup` rows — one read. */
export async function fetchNotificationGroups(
  projectId: string,
  params: { perGroup: number; unreadOnly: boolean },
): Promise<NotificationGroup[]> {
  const query = new URLSearchParams({ groups: String(params.perGroup) });
  if (params.unreadOnly) query.set('unread', '1');
  const body = await call<{ groups?: unknown }>(`/api/notifications?${query.toString()}`, projectId);
  return Array.isArray(body.groups) ? (body.groups as NotificationGroup[]) : [];
}

/**
 * Delete the caller's own rows (one app's, or all) for good; the answer's
 * counts are applied at once. Resolves whether the project's unread TOTAL
 * moved — a view keyed on it re-reads by itself.
 */
export async function clearNotifications(projectId: string, selection: ClearSelection): Promise<boolean> {
  const before = state.counts[projectId]?.total ?? 0;
  const body = await call<{ projectId: string; unread: unknown }>('/api/notifications/clear', projectId, {
    method: 'POST',
    body: JSON.stringify(selection),
  });
  if (!isCounts(body.unread)) return false;
  applyUnreadCounts(projectId, body.unread, false);
  return body.unread.total !== before;
}

/** Mark rows read; the answer's counts are applied at once (the hub tells the user's other tabs). */
export async function markNotificationsRead(projectId: string, selection: ReadSelection): Promise<void> {
  const body = await call<{ projectId: string; unread: unknown }>('/api/notifications/read', projectId, {
    method: 'POST',
    body: JSON.stringify(selection),
  });
  if (isCounts(body.unread)) applyUnreadCounts(projectId, body.unread, false);
}

/** The most rows a dock's popover lists (and marks read) at once. */
const POPOVER_PAGE_SIZE = 100;

/**
 * A dock item's unread rows, for its popover — and they are marked read as
 * they are handed over: what the popover shows is what it read. The server
 * filters to the dock (`group=`), so rows of other docks are neither returned
 * nor touched, however many there are.
 */
export async function loadDockNotifications(projectId: string, dockKey: string): Promise<NotificationRow[]> {
  const page = await fetchNotifications(projectId, { limit: POPOVER_PAGE_SIZE, unreadOnly: true, group: dockKey });
  const rows = page.rows;
  const ids = rows.filter((row) => !row.read).map((row) => row.id);
  if (ids.length > 0) await markNotificationsRead(projectId, { ids }).catch(() => undefined);
  return rows;
}

export async function fetchNotificationPrefs(
  projectId: string,
): Promise<{ catalog: NotificationCatalogEntry[]; prefs: NotificationPrefs }> {
  const body = await call<{ catalog?: NotificationCatalogEntry[]; prefs?: NotificationPrefs }>(
    '/api/notifications/preferences',
    projectId,
  );
  return {
    catalog: Array.isArray(body.catalog) ? body.catalog : [],
    prefs: { mute: body.prefs?.mute ?? [], follow: body.prefs?.follow ?? [] },
  };
}

export async function saveNotificationPrefs(projectId: string, prefs: NotificationPrefs): Promise<NotificationPrefs> {
  const body = await call<{ prefs?: NotificationPrefs }>('/api/notifications/preferences', projectId, {
    method: 'PUT',
    body: JSON.stringify(prefs),
  });
  return { mute: body.prefs?.mute ?? [], follow: body.prefs?.follow ?? [] };
}

/** The dock key a row belongs to (`<packageId>:<dock>`), or `null` for a row without a dock. */
export function rowDockKey(row: Pick<NotificationRow, 'packageId' | 'dock'>): string | null {
  return row.dock ? packageDockKey(row.packageId, row.dock) : null;
}

/**
 * The `openWidget` initial state for a row's nav: a `nav` one-shot inside it
 * gets a fresh `_ts`, so opening the same row twice is two deliveries, not one
 * deduplicated message (the workspace nav convention).
 */
export function navInitialState(nav: NotificationNav, now: number = Date.now()): Record<string, unknown> | undefined {
  const initial = nav.initialState;
  if (!initial) return undefined;
  const inner = initial.nav;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
    return { ...initial, nav: { ...(inner as Record<string, unknown>), _ts: now } };
  }
  return initial;
}

/** Test-only read of the state. */
export function _peekNotificationsClient(): Readonly<State> {
  return state;
}

/** Test-only reset. */
export function _resetNotificationsClient(): void {
  for (const feed of feeds.values()) {
    if (feed.pendingStop !== null) clearTimeout(feed.pendingStop);
    feed.stop();
  }
  feeds.clear();
  state = { counts: {}, byProject: {}, arrivals: {}, inboxRequest: 0, inboxRequestView: 'all' };
  projectCountsAt = Number.NEGATIVE_INFINITY;
  projectCountsInFlight = null;
}
