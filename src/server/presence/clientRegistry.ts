/**
 * Who is online, and on which clients — the host's in-memory client registry.
 *
 * Auth and sessions are the host's domain, so the registry is host-owned and
 * names no product package. Two writers, both AFTER a request authenticated:
 *   - the `/api/events` hub: one entry per open connection (cookie: a browser
 *     or the desktop window, the kind read off the user agent as a LABEL;
 *     bearer: keyed on the token's grant, so it merges with the writer below);
 *   - `touchClient`, handed to packages as `hostPorts.clientActivity`: the
 *     package that verifies OAuth access tokens calls it for every bearer
 *     request on `:3100` and `:3101`. Throttled per entry, so a burst of
 *     requests costs one Map lookup and a compare each.
 *
 * Nothing persists: a restart starts empty ("last seen" is not kept). An entry
 * is dropped on the SAME revocation signal that closes the principal's hub
 * connections (`principalRevocation.ts`) — user-wide, or in the revoked
 * project. The registry is never an authority source: no route decides access
 * from it, and it never holds an IP address, a raw user agent or a token.
 *
 * Reads go through {@link listPresence}, which projects every user through the
 * kernel's ONE predicate (`presenceTierFor` + `projectPresence`).
 *
 * `members` signal: when a user's FIRST client in a project comes online or
 * the LAST one closes, the project's listeners get one content-free
 * `{ projectId }` frame — at most one per project per cooldown (leading edge
 * plus one trailing frame when more changed inside it). A timer exists only
 * while a cooldown runs. A bearer client that only ages out of the activity
 * window sends no frame; readers re-read on open.
 */

import type { PrincipalRevokedEvent, SessionContext } from '@neuralis/package-system/contracts';
import {
  PRESENCE_PLATFORM_FEATURE,
  hasFeature,
  isPresenceRecordOnline,
  presenceTierFor,
  projectPresence,
  type PresenceClientKind,
  type PresenceClientRecord,
  type PresenceUserView,
} from '@neuralis/package-system/access';
import { onHostPrincipalRevoked } from '../host/principalRevocation';
import { getPlatformConfigStore } from '../store/PlatformConfigStore';

type Entry = PresenceClientRecord & { key: string; liveCount: number; lastTouchAt: number };

type MembersListener = () => void;

type RegistrySlot = {
  entries: Map<string, Entry>;
  listeners: Map<string, Set<MembersListener>>;
  cooldowns: Map<string, { timer: ReturnType<typeof setTimeout>; dirty: boolean }>;
  nextConnection: number;
  offRevocation?: () => void;
};

/** `globalThis`-anchored: the hub route and the token verifier run in different module graphs. */
const SLOT = Symbol.for('@neuralis/host:presenceRegistry');

function slot(): RegistrySlot {
  const g = globalThis as { [SLOT]?: RegistrySlot };
  const s: RegistrySlot = (g[SLOT] ??= { entries: new Map(), listeners: new Map(), cooldowns: new Map(), nextConnection: 0 });
  s.offRevocation ??= onHostPrincipalRevoked((event) => dropPrincipal(event));
  return s;
}

const DEFAULT_ACTIVE_WINDOW_MS = 300_000;
const DEFAULT_SIGNAL_COOLDOWN_MS = 5_000;

function numberSetting(key: string, fallback: number): number {
  try {
    const value = Number(getPlatformConfigStore().get(key));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}

/** `presenceActiveWindowMs` — how long a bearer client counts as online after its last request. */
export function presenceActiveWindowMs(): number {
  return numberSetting('presenceActiveWindowMs', DEFAULT_ACTIVE_WINDOW_MS);
}

function signalCooldownMs(): number {
  return numberSetting('presenceSignalCooldownMs', DEFAULT_SIGNAL_COOLDOWN_MS);
}

/** Bearer touches inside this span of the last one write nothing (a tenth of the window, ≤ 30 s). */
function touchThrottleMs(windowMs: number): number {
  return Math.min(30_000, Math.floor(windowMs / 10));
}

function onlineIn(entries: Iterable<Entry>, userId: string, projectId: string, now: number, windowMs: number): boolean {
  for (const e of entries) {
    if (e.userId === userId && e.projectId === projectId && isPresenceRecordOnline(e, now, windowMs)) return true;
  }
  return false;
}

/** Run a mutation and send the `members` signal when the user's online state in the project flipped. */
function mutate(userId: string, projectId: string, change: (s: RegistrySlot) => void): void {
  const s = slot();
  const now = Date.now();
  const windowMs = presenceActiveWindowMs();
  const before = onlineIn(s.entries.values(), userId, projectId, now, windowMs);
  change(s);
  const after = onlineIn(s.entries.values(), userId, projectId, now, windowMs);
  if (before !== after) signal(projectId);
}

function emit(projectId: string): void {
  for (const listener of slot().listeners.get(projectId) ?? []) {
    try { listener(); } catch { /* a listener owns its errors */ }
  }
}

function signal(projectId: string): void {
  const s = slot();
  const pending = s.cooldowns.get(projectId);
  if (pending) { pending.dirty = true; return; }
  emit(projectId);
  const arm = (): void => {
    const timer = setTimeout(() => {
      const state = s.cooldowns.get(projectId);
      s.cooldowns.delete(projectId);
      if (state?.dirty) { emit(projectId); arm(); }
    }, signalCooldownMs());
    timer.unref?.();
    s.cooldowns.set(projectId, { timer, dirty: false });
  };
  arm();
}

/** The `user-agent` header as a client kind — a label, never stored raw. */
export function cookieClientKind(userAgent: string | null): { kind: PresenceClientKind; label: string } {
  return userAgent && /\bElectron\//.test(userAgent) ? { kind: 'desktop', label: 'Desktop app' } : { kind: 'web', label: 'Browser' };
}

/**
 * Record one open `/api/events` connection. `grantId` keys a bearer
 * connection on its grant (the token verifier's touch already labelled it).
 * Returns the close, which the hub's teardown runs.
 */
export function openHubClient(input: {
  userId: string;
  projectId: string;
  kind: PresenceClientKind;
  label: string;
  grantId?: string;
  clientId?: string;
}): () => void {
  const s = slot();
  const key = input.grantId ? `grant:${input.grantId}` : `hub:${++s.nextConnection}`;
  mutate(input.userId, input.projectId, (state) => {
    const now = Date.now();
    const existing = state.entries.get(key);
    if (existing) {
      existing.liveCount += 1;
      existing.live = true;
      existing.lastActiveAt = now;
      return;
    }
    state.entries.set(key, {
      key,
      userId: input.userId,
      projectId: input.projectId,
      kind: input.kind,
      label: input.label,
      ...(input.clientId ? { clientId: input.clientId } : {}),
      since: now,
      lastActiveAt: now,
      lastTouchAt: now,
      live: true,
      liveCount: 1,
    });
  });
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    mutate(input.userId, input.projectId, (state) => {
      const entry = state.entries.get(key);
      if (!entry) return;
      entry.liveCount -= 1;
      entry.lastActiveAt = Date.now();
      if (entry.liveCount > 0) return;
      // A cookie connection ends with its socket; a bearer grant stays as
      // recently active until the window passes.
      if (key.startsWith('hub:')) state.entries.delete(key);
      else entry.live = false;
    });
  };
}

/** `hostPorts.clientActivity.touch` — a verified bearer request. */
export function touchClient(activity: {
  userId: string;
  projectId: string;
  grantId: string;
  clientId: string;
  kind: PresenceClientKind;
  label: string;
}): void {
  const s = slot();
  const key = `grant:${activity.grantId}`;
  const now = Date.now();
  const existing = s.entries.get(key);
  const windowMs = presenceActiveWindowMs();
  if (existing && now - existing.lastTouchAt < touchThrottleMs(windowMs)) return;
  mutate(activity.userId, activity.projectId, (state) => {
    const entry = state.entries.get(key);
    if (entry) {
      entry.lastActiveAt = now;
      entry.lastTouchAt = now;
      entry.kind = activity.kind;
      entry.label = activity.label;
      entry.clientId = activity.clientId;
      return;
    }
    state.entries.set(key, {
      key,
      userId: activity.userId,
      projectId: activity.projectId,
      kind: activity.kind,
      label: activity.label,
      clientId: activity.clientId,
      since: now,
      lastActiveAt: now,
      lastTouchAt: now,
      live: false,
      liveCount: 0,
    });
  });
}

/** The revocation close: every entry of the user, or of the user in the revoked project. */
export function dropPrincipal(event: Pick<PrincipalRevokedEvent, 'userId' | 'projectId'>): void {
  const s = slot();
  const projects = new Set<string>();
  for (const [key, e] of s.entries) {
    if (e.userId !== event.userId) continue;
    if (event.projectId !== undefined && e.projectId !== event.projectId) continue;
    s.entries.delete(key);
    projects.add(e.projectId);
  }
  for (const projectId of projects) signal(projectId);
}

/** Prune bearer entries past the activity window (read time — no sweep timer). */
function prune(s: RegistrySlot, now: number, windowMs: number): void {
  for (const [key, e] of s.entries) {
    if (!e.live && now - e.lastActiveAt > windowMs) s.entries.delete(key);
  }
}

/** Subscribe to the `members` signal of one project. Returns the unsubscribe. */
export function onMembersPresenceChange(projectId: string, listener: MembersListener): () => void {
  const s = slot();
  let set = s.listeners.get(projectId);
  if (!set) { set = new Set(); s.listeners.set(projectId, set); }
  set.add(listener);
  return () => {
    const current = s.listeners.get(projectId);
    current?.delete(listener);
    if (current && current.size === 0) s.listeners.delete(projectId);
  };
}

/**
 * The presence read both surfaces use. `memberIds` are the members of the
 * viewer's project (the caller's fact). `project` lists those members;
 * `platform` lists every user with a record and needs `platform.users` —
 * without it the answer is `[]`. A `userId` filter narrows either; an unknown
 * or invisible id answers `[]`, the same as a user who is simply not there.
 */
export function listPresence(
  viewer: SessionContext,
  query: { scope: 'project' | 'platform'; userId?: string; memberIds: ReadonlySet<string> },
): PresenceUserView[] {
  const s = slot();
  const now = Date.now();
  const windowMs = presenceActiveWindowMs();
  prune(s, now, windowMs);
  const records = [...s.entries.values()];
  let subjects: string[];
  if (query.scope === 'platform') {
    if (!hasFeature(viewer, PRESENCE_PLATFORM_FEATURE)) return [];
    subjects = [...new Set(records.map((r) => r.userId))];
  } else {
    subjects = [...query.memberIds];
  }
  if (query.userId !== undefined) subjects = subjects.filter((id) => id === query.userId);
  const out: PresenceUserView[] = [];
  for (const userId of subjects.sort()) {
    const tier = presenceTierFor(viewer, { userId, coMember: query.memberIds.has(userId) });
    const view = projectPresence(tier, userId, records, { projectId: viewer.projectId, now, activeWindowMs: windowMs });
    if (view) out.push(view);
  }
  return out;
}

/** Test-only: drop every entry, listener and cooldown. */
export function resetPresenceRegistryForTests(): void {
  const s = slot();
  for (const { timer } of s.cooldowns.values()) clearTimeout(timer);
  s.cooldowns.clear();
  s.entries.clear();
  s.listeners.clear();
  s.nextConnection = 0;
  s.offRevocation?.();
  s.offRevocation = undefined;
}
