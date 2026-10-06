/**
 * The per-user notification store, one per project:
 *
 *   <projectsRoot>/<projectId>/notifications/<userId>/log.jsonl   — the rows, oldest first
 *   <projectsRoot>/<projectId>/notifications/<userId>/state.json  — seq, unread set, merge counts
 *   <projectsRoot>/<projectId>/notifications/<userId>/prefs.json  — `notificationPrefs.ts`
 *
 * Under the project tree on purpose: the project purge takes it with it, and
 * nothing here can address another project.
 *
 * A ROW is a signal, never content: `{ seq, id, type, packageId, dock?,
 * subjectId, tone, title, at, count, nav? }` — no error text, no transcript, no
 * path. `packageId` is the publishing package's MANIFEST id (the event's
 * `source`), so `<packageId>:<dock>` names the dock item the badge sits on.
 * `title` is at most {@link MAX_NOTIFICATION_TITLE_CHARS} characters and is
 * only ever rendered as text.
 *
 * MERGING: an event whose `(type, subjectId)` already has an UNREAD row adds to
 * that row's count (kept in `state.json`) instead of appending — a failing
 * schedule is one row with a count, never a flood. A read row is never merged
 * into.
 *
 * RETENTION runs at write time, no timer: past `notificationsMaxRowsPerUser`
 * rows, or once the oldest row is older than `notificationsRetentionDays`, the
 * log is compacted (to 80 % of the cap, so a full log compacts once per fifth
 * of the cap, not on every write). A member can also CLEAR their own rows —
 * one app's or all (`clearNotifications`) — through the same rewrite.
 *
 * CONCURRENCY: every read-modify-write of one user's files runs in ONE chain
 * per `(projectId, userId)` — the materializer (instrumentation graph) and the
 * read/mark routes (route graph) both write `state.json`, so the chain, the
 * appender and the live listener map sit in ONE `globalThis` slot; a
 * module-level copy per graph would order nothing. `state.json` is never
 * get→put outside the chain.
 */

import { readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { JsonlAppender, durableReplaceFile } from '@neuralis/package-system/data';
import {
  isSafePathSegment,
  resolveContainedLexical,
  resolveProjectRoot,
  type ContainedPath,
} from '@neuralis/package-system/paths';
import type { PackageEventTone } from '@neuralis/package-system/contracts';
import { getEnv } from '../config/env';
import { getPlatformConfigStore } from '../store/PlatformConfigStore';
import { listAllProjects } from '../store/ProjectStore';

export const MAX_NOTIFICATION_TITLE_CHARS = 120;

/** Where a row opens: a widget of the package's own, with an initial state the host never interprets. */
export type NotificationNav = { widgetType: string; initialState?: Record<string, unknown> };

export type NotificationRow = {
  seq: number;
  id: string;
  /** The wire event type (`agent-core.workflow.run.failed`). */
  type: string;
  /** The publishing package's MANIFEST id. */
  packageId: string;
  /** The package's own dock surface id the event belongs to. */
  dock?: string;
  subjectId: string;
  tone: PackageEventTone;
  title: string;
  at: string;
  /** Always 1 on disk; the merge count lives in `state.json` and is overlaid on read. */
  count: number;
  nav?: NotificationNav;
};

/** A row as the list route serves it. */
export type NotificationView = NotificationRow & { read: boolean };

/** Unread counts — the badge numbers. `byDock` keys are `<packageId>:<dockId>`. */
export type UnreadCounts = { total: number; byDock: Record<string, number> };

type UnreadEntry = { key: string; dock: string | null };

type NotificationState = {
  v: 1;
  /** The last seq issued. */
  seq: number;
  /** Rows in `log.jsonl`. */
  rows: number;
  /** `at` of the oldest row in `log.jsonl`. */
  oldestAt: string | null;
  unread: Record<string, UnreadEntry>;
  /** Merge counts above 1 and the latest merge time, by row id. */
  merged: Record<string, { count: number; at: string }>;
};

export type NotificationInput = {
  type: string;
  packageId: string;
  dock?: string;
  subjectId: string;
  tone: PackageEventTone;
  title: string;
  nav?: NotificationNav;
};

export type ReadSelection = { ids: string[] } | { dock: string } | { all: true };

/** What a clear deletes: one app's rows (a {@link notificationGroupKey}) or every row. */
export type ClearSelection = { group: string } | { all: true };

/** One app's rows in the inbox: its entry count, its unread count and its newest rows. */
export type NotificationGroup = {
  key: string;
  packageId: string;
  dock?: string;
  total: number;
  unread: number;
  rows: NotificationView[];
};


export type NotificationCountsEvent = { projectId: string; userId: string; unread: UnreadCounts };
type CountsListener = (event: NotificationCountsEvent) => void;

type NotificationSlot = {
  chains: Map<string, Promise<unknown>>;
  appender: JsonlAppender<NotificationRow>;
  listeners: Map<string, Set<CountsListener>>;
  /** projectId → event type → follower user ids (`notificationPrefs.ts`). */
  followers: Map<string, Map<string, Set<string>>>;
};

const SLOT = Symbol.for('@neuralis/host:notificationStore');

function slot(): NotificationSlot {
  const g = globalThis as { [SLOT]?: NotificationSlot };
  return (g[SLOT] ??= {
    chains: new Map(),
    appender: new JsonlAppender<NotificationRow>(),
    listeners: new Map(),
    followers: new Map(),
  });
}

/** The follower-index cache `notificationPrefs.ts` builds and reads. */
export function followerIndexCache(): Map<string, Map<string, Set<string>>> {
  return slot().followers;
}

export function invalidateFollowerIndex(projectId: string): void {
  slot().followers.delete(projectId);
}

/** Serialize `fn` behind every earlier operation on the same key. */
function serialize<R>(key: string, fn: () => Promise<R>): Promise<R> {
  const chains = slot().chains;
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(key, next);
  next.then(
    () => { if (chains.get(key) === next) chains.delete(key); },
    () => { if (chains.get(key) === next) chains.delete(key); },
  );
  return next;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** The `notifications/` directory of a project, or `null` for an id that cannot name one. */
export function notificationsRoot(projectId: string): ContainedPath | null {
  let projectRoot: string;
  try {
    projectRoot = resolveProjectRoot(getEnv().projectsRoot, projectId);
  } catch {
    return null;
  }
  const resolved = resolveContainedLexical(projectRoot, 'notifications');
  return resolved.ok ? resolved.path : null;
}

/** One file of one user's notification directory, or `null`. */
export function userFile(projectId: string, userId: string, file: 'log.jsonl' | 'state.json' | 'prefs.json'): ContainedPath | null {
  if (!isSafePathSegment(userId)) return null;
  const root = notificationsRoot(projectId);
  if (!root) return null;
  const resolved = resolveContainedLexical(root.realPath, `${userId}/${file}`);
  return resolved.ok ? resolved.path : null;
}

function chainKey(projectId: string, userId: string): string {
  return `${projectId}\u0000${userId}`;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function emptyState(seq: number): NotificationState {
  return { v: 1, seq, rows: 0, oldestAt: null, unread: {}, merged: {} };
}

/** The state on disk; a missing or unreadable one restarts from the log's head seq (never re-issuing a seq). */
async function readState(state: ContainedPath, log: ContainedPath): Promise<NotificationState> {
  try {
    const parsed = JSON.parse(await readFile(state.realPath, 'utf-8')) as Partial<NotificationState>;
    if (parsed && parsed.v === 1 && typeof parsed.seq === 'number') {
      return {
        v: 1,
        seq: parsed.seq,
        rows: typeof parsed.rows === 'number' ? parsed.rows : 0,
        oldestAt: typeof parsed.oldestAt === 'string' ? parsed.oldestAt : null,
        unread: parsed.unread && typeof parsed.unread === 'object' ? parsed.unread : {},
        merged: parsed.merged && typeof parsed.merged === 'object' ? parsed.merged : {},
      };
    }
  } catch {
    // missing or torn — rebuilt below
  }
  const rows = await slot().appender.readAll(log);
  const fresh = emptyState(rows.reduce((max, row) => Math.max(max, row.seq ?? 0), 0));
  fresh.rows = rows.length;
  fresh.oldestAt = rows[0]?.at ?? null;
  return fresh;
}

async function writeState(path: ContainedPath, state: NotificationState): Promise<void> {
  await durableReplaceFile(path.realPath, JSON.stringify(state), { mode: 0o600 });
}

function countsOf(state: NotificationState): UnreadCounts {
  const byDock: Record<string, number> = {};
  let total = 0;
  for (const entry of Object.values(state.unread)) {
    total += 1;
    if (entry.dock) byDock[entry.dock] = (byDock[entry.dock] ?? 0) + 1;
  }
  return { total, byDock };
}

/** Same numbers? A frame that would repeat the badge the user already has is not sent. */
function sameCounts(a: UnreadCounts, b: UnreadCounts): boolean {
  if (a.total !== b.total) return false;
  const keys = Object.keys(a.byDock);
  if (keys.length !== Object.keys(b.byDock).length) return false;
  return keys.every((key) => a.byDock[key] === b.byDock[key]);
}

function mergeKey(type: string, subjectId: string): string {
  return `${type}\u0000${subjectId}`;
}

export function dockKey(packageId: string, dock: string | undefined): string | null {
  return dock ? `${packageId}:${dock}` : null;
}

/** The app a row belongs to in the inbox: its dock key, or the bare package id for a row without a dock. */
export function notificationGroupKey(row: Pick<NotificationRow, 'packageId' | 'dock'>): string {
  return dockKey(row.packageId, row.dock) ?? row.packageId;
}

// ---------------------------------------------------------------------------
// Limits (host config, read per write — they apply live)
// ---------------------------------------------------------------------------

function limits(): { maxRows: number; retentionMs: number } {
  const store = getPlatformConfigStore();
  const maxRows = Number(store.get('notificationsMaxRowsPerUser'));
  const days = Number(store.get('notificationsRetentionDays'));
  return {
    maxRows: Number.isFinite(maxRows) && maxRows >= 1 ? Math.floor(maxRows) : 500,
    retentionMs: (Number.isFinite(days) && days >= 1 ? days : 30) * 86_400_000,
  };
}

/** Rewrite the log to `kept` (oldest first) and prune the state entries of every row it no longer holds. */
async function keepOnly(log: ContainedPath, state: NotificationState, kept: NotificationRow[]): Promise<void> {
  await slot().appender.compact(log, kept);
  const keptIds = new Set(kept.map((row) => row.id));
  for (const id of Object.keys(state.unread)) if (!keptIds.has(id)) delete state.unread[id];
  for (const id of Object.keys(state.merged)) if (!keptIds.has(id)) delete state.merged[id];
  state.rows = kept.length;
  state.oldestAt = kept[0]?.at ?? null;
}

/** Drop rows past the cap or the age; prune the state entries of every dropped row. */
async function compactIfDue(log: ContainedPath, state: NotificationState, now: number): Promise<void> {
  const { maxRows, retentionMs } = limits();
  const cutoff = now - retentionMs;
  const tooMany = state.rows > maxRows;
  const tooOld = state.oldestAt !== null && Date.parse(state.oldestAt) < cutoff;
  if (!tooMany && !tooOld) return;
  const rows = await slot().appender.readAll(log);
  const keepCount = tooMany ? Math.max(1, Math.floor(maxRows * 0.8)) : rows.length;
  await keepOnly(log, state, rows.filter((row) => Date.parse(row.at) >= cutoff).slice(-keepCount));
}

// ---------------------------------------------------------------------------
// Live counts signal
// ---------------------------------------------------------------------------

/**
 * The counts of a user's notifications changed in `projectId`. Delivered to
 * that user's listeners ONLY (the `/api/events` `notifications` arm registers
 * one per connection) — a map keyed on the user, so an event costs O(that
 * user's connections), never a scan of every open hub.
 */
export function onNotificationCounts(userId: string, listener: CountsListener): () => void {
  const listeners = slot().listeners;
  let set = listeners.get(userId);
  if (!set) {
    set = new Set();
    listeners.set(userId, set);
  }
  set.add(listener);
  return () => {
    const current = listeners.get(userId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listeners.delete(userId);
  };
}

function emitCounts(event: NotificationCountsEvent): void {
  for (const listener of slot().listeners.get(event.userId) ?? []) {
    try {
      listener(event);
    } catch (err) {
      console.error('[notifications] counts listener threw', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

function clampTitle(title: string): string {
  const flat = title.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  return flat.length > MAX_NOTIFICATION_TITLE_CHARS ? `${flat.slice(0, MAX_NOTIFICATION_TITLE_CHARS - 1)}…` : flat;
}

/**
 * Record one notification for one recipient: merge into its unread twin, or
 * append a new row; then retention; then the live counts signal — only when
 * the unread numbers moved (a merge into an unread twin changes no number, so
 * it sends no frame). Returns `false` when the coordinates name no directory
 * (nothing written).
 */
export async function deliverNotification(
  projectId: string,
  userId: string,
  input: NotificationInput,
): Promise<boolean> {
  const log = userFile(projectId, userId, 'log.jsonl');
  const statePath = userFile(projectId, userId, 'state.json');
  if (!log || !statePath) return false;
  const result = await serialize(chainKey(projectId, userId), async () => {
    const state = await readState(statePath, log);
    const before = countsOf(state);
    const now = new Date();
    const at = now.toISOString();
    const key = mergeKey(input.type, input.subjectId);
    const twin = Object.entries(state.unread).find(([, entry]) => entry.key === key)?.[0];
    if (twin) {
      state.merged[twin] = { count: (state.merged[twin]?.count ?? 1) + 1, at };
    } else {
      state.seq += 1;
      const row: NotificationRow = {
        seq: state.seq,
        id: randomUUID(),
        type: input.type,
        packageId: input.packageId,
        ...(input.dock ? { dock: input.dock } : {}),
        subjectId: input.subjectId,
        tone: input.tone,
        title: clampTitle(input.title),
        at,
        count: 1,
        ...(input.nav ? { nav: input.nav } : {}),
      };
      await slot().appender.append(log, row);
      state.unread[row.id] = { key, dock: dockKey(input.packageId, input.dock) };
      state.rows += 1;
      state.oldestAt ??= at;
      await compactIfDue(log, state, now.getTime());
    }
    await writeState(statePath, state);
    const counts = countsOf(state);
    return { counts, moved: !sameCounts(before, counts) };
  });
  if (result.moved) emitCounts({ projectId, userId, unread: result.counts });
  return true;
}

/** The user's unread counts in one project — one small file read. */
export async function readUnreadCounts(projectId: string, userId: string): Promise<UnreadCounts> {
  const log = userFile(projectId, userId, 'log.jsonl');
  const statePath = userFile(projectId, userId, 'state.json');
  if (!log || !statePath) return { total: 0, byDock: {} };
  try {
    const parsed = JSON.parse(await readFile(statePath.realPath, 'utf-8')) as NotificationState;
    return countsOf({ ...emptyState(0), unread: parsed.unread ?? {} });
  } catch {
    return { total: 0, byDock: {} };
  }
}

/**
 * The newest rows, newest first, with the read flag and the merge count
 * overlaid. `before` pages backwards by seq; `unreadOnly` keeps unread rows;
 * `group` keeps one app's rows ({@link notificationGroupKey}); no `limit`
 * answers the whole window. Reads through the appender's tail reader
 * (`readNewest`) — never the whole file when an unfiltered page is enough.
 */
export async function listNotifications(
  projectId: string,
  userId: string,
  options: { limit?: number; before?: number; unreadOnly?: boolean; group?: string },
): Promise<NotificationView[]> {
  const log = userFile(projectId, userId, 'log.jsonl');
  const statePath = userFile(projectId, userId, 'state.json');
  if (!log || !statePath) return [];
  let state: NotificationState;
  try {
    state = JSON.parse(await readFile(statePath.realPath, 'utf-8')) as NotificationState;
  } catch {
    return [];
  }
  const { limit } = options;
  const filtered =
    limit === undefined || options.before !== undefined || options.unreadOnly === true || options.group !== undefined;
  const window = filtered ? Math.max(limit ?? 0, state.rows || limits().maxRows) : limit;
  const rows = await slot().appender.readNewest(log, window);
  const out: NotificationView[] = [];
  for (const row of rows) {
    if (options.before !== undefined && row.seq >= options.before) continue;
    if (options.group !== undefined && notificationGroupKey(row) !== options.group) continue;
    const read = !state.unread?.[row.id];
    if (options.unreadOnly && read) continue;
    const merged = state.merged?.[row.id];
    out.push({ ...row, count: merged?.count ?? row.count, at: merged?.at ?? row.at, read });
    if (limit !== undefined && out.length >= limit) break;
  }
  return out;
}

/**
 * Rows (newest first, already judged by the caller) grouped by app: groups in
 * the order of their newest row, each with its ENTRY count (`total` — a merged
 * row counts once, read or not: what a clear of the group deletes), its unread
 * count and its newest `perGroup` rows. `unreadOnly` keeps only unread rows in
 * `rows` and leaves out a group with nothing unread — `total` still counts
 * every entry.
 */
export function groupNotificationViews(
  views: readonly NotificationView[],
  perGroup: number,
  options: { unreadOnly?: boolean } = {},
): NotificationGroup[] {
  const groups = new Map<string, NotificationGroup>();
  for (const view of views) {
    const key = notificationGroupKey(view);
    let group = groups.get(key);
    if (!group) {
      group = { key, packageId: view.packageId, ...(view.dock ? { dock: view.dock } : {}), total: 0, unread: 0, rows: [] };
      groups.set(key, group);
    }
    group.total += 1;
    if (!view.read) group.unread += 1;
    if (group.rows.length < perGroup && (!options.unreadOnly || !view.read)) group.rows.push(view);
  }
  const out = [...groups.values()];
  return options.unreadOnly ? out.filter((group) => group.unread > 0) : out;
}

/** Mark rows read — by id, by dock key, or all. Returns the counts after. */
export async function markNotificationsRead(
  projectId: string,
  userId: string,
  selection: ReadSelection,
): Promise<UnreadCounts> {
  const log = userFile(projectId, userId, 'log.jsonl');
  const statePath = userFile(projectId, userId, 'state.json');
  if (!log || !statePath) return { total: 0, byDock: {} };
  const result = await serialize(chainKey(projectId, userId), async () => {
    const state = await readState(statePath, log);
    let changed = false;
    for (const [id, entry] of Object.entries(state.unread)) {
      const hit =
        'all' in selection ||
        ('ids' in selection && selection.ids.includes(id)) ||
        ('dock' in selection && entry.dock === selection.dock);
      if (hit) {
        delete state.unread[id];
        changed = true;
      }
    }
    if (changed) await writeState(statePath, state);
    return { counts: countsOf(state), changed };
  });
  if (result.changed) emitCounts({ projectId, userId, unread: result.counts });
  return result.counts;
}

/**
 * Delete the caller's own rows — one app's ({@link notificationGroupKey}) or
 * all — unread ones included: the log is rewritten without them and their
 * unread and merge entries go with them. Returns the counts after; the live
 * signal fires only when the unread numbers moved. Nothing is undone.
 */
export async function clearNotifications(
  projectId: string,
  userId: string,
  selection: ClearSelection,
): Promise<UnreadCounts> {
  const log = userFile(projectId, userId, 'log.jsonl');
  const statePath = userFile(projectId, userId, 'state.json');
  if (!log || !statePath) return { total: 0, byDock: {} };
  const result = await serialize(chainKey(projectId, userId), async () => {
    const state = await readState(statePath, log);
    const before = countsOf(state);
    const rows = await slot().appender.readAll(log);
    const kept = 'all' in selection ? [] : rows.filter((row) => notificationGroupKey(row) !== selection.group);
    if (kept.length === rows.length) return { counts: before, moved: false };
    await keepOnly(log, state, kept);
    await writeState(statePath, state);
    const counts = countsOf(state);
    return { counts, moved: !sameCounts(before, counts) };
  });
  if (result.moved) emitCounts({ projectId, userId, unread: result.counts });
  return result.counts;
}

/** Run `fn` in the user's chain — `notificationPrefs.ts` writes `prefs.json` through it. */
export function inUserChain<R>(projectId: string, userId: string, fn: () => Promise<R>): Promise<R> {
  return serialize(chainKey(projectId, userId), fn);
}

/** Remove one user's notification directory in one project (a deleted user). */
export async function removeUserNotifications(projectId: string, userId: string): Promise<void> {
  if (!isSafePathSegment(userId)) return;
  const root = notificationsRoot(projectId);
  if (!root) return;
  const dir = resolveContainedLexical(root.realPath, userId);
  if (!dir.ok) return;
  await serialize(chainKey(projectId, userId), () => rm(dir.path.realPath, { recursive: true, force: true }));
  invalidateFollowerIndex(projectId);
}

/**
 * A DELETED user's notifications go with the account, in every project —
 * archived ones included (a restore must not bring a tombstone's inbox back).
 * Called on the principal-revocation `deleted` reason.
 */
export async function removeDeletedUserNotifications(userId: string): Promise<number> {
  const projects = await listAllProjects({ includeArchived: true });
  await Promise.all(projects.map((project) => removeUserNotifications(project.id, userId)));
  return projects.length;
}

/** Test-only: drop the slot (chains, appender, listeners). */
export function resetNotificationStoreForTests(): void {
  const g = globalThis as { [SLOT]?: NotificationSlot };
  delete g[SLOT];
}
