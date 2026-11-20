/**
 * Community Package Runtime Client.
 *
 * Manages the backend package runtime snapshot for the workspace.
 * Direct API calls (no proxy layer, unlike front_v1).
 */

import type { PackageRuntimeSnapshot } from '@neuralis/package-system/contracts';
import { subscribeHub } from '../realtime/eventHub';

let _cachedSnapshot: PackageRuntimeSnapshot | null = null;
let _cachedRevision: string | null = null;
let _cachedScopeKey = '';

type SnapshotListener = (snapshot: PackageRuntimeSnapshot) => void;
const _listeners: SnapshotListener[] = [];

export type PackageRuntimeScope = {
  projectId?: string | null;
  agentId?: string | null;
};

/**
 * The UNSCOPED cache key. A distinct sentinel, NOT the empty `':'` that a
 * `{projectId: null, agentId: null}` scope produces — those two must never
 * compare equal.
 *
 * They did until 2026-07-28, and it made `getScopedSnapshot` fail OPEN in the
 * one window that matters: `session.projectId`/`agentId` are both `null` on
 * every page load until `bootstrap()` resolves, so a pre-bootstrap ask matched
 * the unscoped SSR seed exactly — a seed scoped to no project, which proves
 * nothing about the active one. Only the loading overlay happened to keep launchers unmounted
 * during it, which is a rendering coincidence, not a guarantee.
 */
const UNSCOPED_KEY = '\0unscoped';

function getScopeKey(scope?: PackageRuntimeScope): string {
  if (!scope) return UNSCOPED_KEY;
  return `${scope.projectId ?? ''}:${scope.agentId ?? ''}`;
}

function buildScopeHeaders(scope?: PackageRuntimeScope): HeadersInit {
  const headers = new Headers();

  if (scope?.projectId) {
    headers.set('X-Project-Id', scope.projectId);
  }
  if (scope?.agentId) {
    headers.set('X-Agent-Id', scope.agentId);
  }

  return headers;
}

/**
 * Fetches the package runtime snapshot.
 * ETag-based cache — returns the cached snapshot on 304.
 */
export async function fetchPackageSnapshot(
  scope?: PackageRuntimeScope,
): Promise<PackageRuntimeSnapshot> {
  const scopeKey = getScopeKey(scope);
  const headers = new Headers(buildScopeHeaders(scope));

  if (_cachedRevision && _cachedScopeKey === scopeKey) {
    headers.set('If-None-Match', `"${_cachedRevision}"`);
  }

  try {
    const res = await fetch('/api/packages/runtime', { headers });

    if (res.status === 304 && _cachedSnapshot) {
      return _cachedSnapshot;
    }

    if (!res.ok) {
      throw new Error(`Package snapshot fetch failed: ${res.status}`);
    }

    const snapshot = (await res.json()) as PackageRuntimeSnapshot;
    _cachedSnapshot = snapshot;
    _cachedRevision = snapshot.revision;
    _cachedScopeKey = scopeKey;
    return snapshot;
  } catch (err) {
    if (_cachedSnapshot && _cachedScopeKey === scopeKey) {
      console.warn('[packages] Snapshot fetch failed, using cache', err);
      return _cachedSnapshot;
    }
    throw err;
  }
}

export function onSnapshotChange(listener: SnapshotListener): () => void {
  _listeners.push(listener);
  return () => {
    const idx = _listeners.indexOf(listener);
    if (idx >= 0) _listeners.splice(idx, 1);
  };
}

/**
 * BUG-B α — the ONE notify path, NON-RE-ENTRANT. `WorkspaceRoot`'s listener
 * applies each snapshot via `applySnapshot`, which calls `seedSnapshotCache`,
 * which notifies every listener — including the very listener being notified.
 * Without this guard that is a SYNCHRONOUS infinite recursion to the stack
 * limit on every runtime event, silently swallowed by the per-listener
 * try/catch. A nested notify can only ever re-deliver the snapshot the outer
 * loop is already delivering (the cache is written before any notify), so
 * dropping it loses nothing.
 */
let _notifying = false;
function notifyListeners(snapshot: PackageRuntimeSnapshot): void {
  if (_notifying) return;
  _notifying = true;
  try {
    for (const listener of [..._listeners]) {
      try { listener(snapshot); } catch { /* ignore */ }
    }
  } finally {
    _notifying = false;
  }
}

async function refetchAndNotify(scope?: PackageRuntimeScope): Promise<void> {
  try {
    const snapshot = await fetchPackageSnapshot(scope);
    notifyListeners(snapshot);
  } catch { /* ignore */ }
}

/**
 * Runtime invalidations now arrive on the shared `/api/events` hub (the
 * `runtime` channel) instead of a dedicated EventSource — one fewer same-origin
 * HTTP/1.1 connection. Both the on-connect `runtime:snapshot` and every
 * `runtime:invalidated` trigger an ETag-cheap refetch, identical to before.
 * The hub owns reconnect/watchdog/backoff.
 */
export function subscribeToRuntimeEvents(scope?: PackageRuntimeScope): () => void {
  return subscribeHub({
    projectId: scope?.projectId ?? null,
    channel: 'runtime',
    onEvent: () => { void refetchAndNotify(scope); },
  });
}

/**
 * Seed the module cache from an already-resolved snapshot.
 *
 * `scope` records WHICH caller scope the snapshot was built for. Omit it for
 * the SSR seed — `getSSRSnapshot()` builds with NO `projectId` (only
 * `grantedFeatures: []`), so `passesProjectAndOwnerScope` admits builtins and
 * installs only — no project's own packages.
 * That seed is deliberately unscoped and must never be mistaken for a
 * project-scoped answer; `getScopedSnapshot` is how a consumer says "only give
 * me the snapshot if it was actually built for THIS project/agent".
 */
export function seedSnapshotCache(
  snapshot: PackageRuntimeSnapshot,
  scope?: PackageRuntimeScope,
): void {
  _cachedSnapshot = snapshot;
  _cachedRevision = snapshot.revision;
  _cachedScopeKey = getScopeKey(scope);
  // Notify all listeners so DockLeft and other consumers get the snapshot.
  // Non-re-entrant (BUG-B α): a seed performed BY a notified listener is a
  // re-delivery of the in-flight snapshot, never a new one.
  notifyListeners(snapshot);
}

/**
 * Scope-BLIND read — returns whatever snapshot is cached, including the
 * unscoped SSR seed. Correct for consumers that only need "what surfaces
 * exist so I can render a shell synchronously on first paint" (the dock,
 * `WidgetRendererStrategy`): they resolve declarations, and the authoritative
 * per-caller filtering already happened server-side for everything gated.
 *
 * Do NOT use it to prove a caller may SEE something — see `getScopedSnapshot`.
 */
export function getCachedSnapshot(
  _scope?: PackageRuntimeScope,
): PackageRuntimeSnapshot | null {
  return _cachedSnapshot;
}

/**
 * Scope-CHECKED read — the cached snapshot only when it was actually built for
 * this exact `(projectId, agentId)` pair; `null` otherwise.
 *
 * This is the accessor any surface must use when MEMBERSHIP IN THE SNAPSHOT IS
 * THE VISIBILITY PROOF (the derived skill launcher). The unscoped SSR seed
 * satisfies `getCachedSnapshot` but proves nothing about the active project, so
 * reading it as proof would advertise another project's ungated skills during
 * the first-paint window. Fail-closed: unknown scope ⇒ null ⇒ nothing renders.
 */
export function getScopedSnapshot(
  scope?: PackageRuntimeScope,
): PackageRuntimeSnapshot | null {
  return _cachedScopeKey === getScopeKey(scope) ? _cachedSnapshot : null;
}

/**
 * The scope the workspace's scoped load is still waiting on, or `null`. The
 * SSR seed is unscoped, so the dock's package tiles (`getScopedSnapshot`) stay
 * empty until that load lands — this is what lets the dock say "loading"
 * instead of looking empty. Written only by `loadScopedSnapshot`.
 */
let _awaitedScopeKey: string | null = null;
const _awaitListeners = new Set<() => void>();

function setAwaitedScopeKey(key: string | null): void {
  if (_awaitedScopeKey === key) return;
  _awaitedScopeKey = key;
  for (const listener of [..._awaitListeners]) listener();
}

/** True while the load for exactly this scope waits and nothing scoped to it is cached. */
export function isScopedSnapshotPending(scope: PackageRuntimeScope): boolean {
  return _awaitedScopeKey === getScopeKey(scope) && getScopedSnapshot(scope) === null;
}

/** Fires whenever `isScopedSnapshotPending` may have changed: a seed, or a wait starting or ending. */
export function onScopedSnapshotPendingChange(listener: () => void): () => void {
  const stopSnapshot = onSnapshotChange(() => listener());
  _awaitListeners.add(listener);
  return () => {
    stopSnapshot();
    _awaitListeners.delete(listener);
  };
}

/**
 * The workspace's scoped snapshot load, bounded: an attempt that has not
 * delivered after `retryAfterMs` (rejected, or still in flight) is retried
 * ONCE, and no further attempt or timer follows. The WAIT ends only when a
 * snapshot for this scope is delivered — by either attempt's late answer, or by
 * the hub: every hub connect sends `runtime:snapshot`, whose refetch
 * (`subscribeToRuntimeEvents`) writes this scope's cache — or when cancelled.
 * Until then `isScopedSnapshotPending` stays true, so the dock shows its loading
 * state, never an empty dock as if it were final. At most one timer is pending;
 * the returned cancel clears it and drops every later answer.
 */
export function loadScopedSnapshot(
  scope: PackageRuntimeScope,
  retryAfterMs: number,
  onSnapshot: (snapshot: PackageRuntimeSnapshot) => void,
): () => void {
  const key = getScopeKey(scope);
  let cancelled = false;
  let waiting = true;
  let attemptsOver = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const endWait = (): void => {
    if (!waiting) return;
    waiting = false;
    clearTimeout(timer);
    if (_awaitedScopeKey === key) setAwaitedScopeKey(null);
  };

  // Both attempts are spent: the scope stays awaited for the hub's delivery.
  const giveUpAttempts = (failure: unknown): void => {
    if (attemptsOver || !waiting) return;
    attemptsOver = true;
    clearTimeout(timer);
    console.warn('[packages] The project snapshot did not load after one retry — waiting for the host to answer', failure);
  };

  const attempt = (isRetry: boolean): void => {
    timer = setTimeout(() => {
      if (!waiting) return;
      if (isRetry) {
        giveUpAttempts(new Error(`no answer within ${retryAfterMs} ms`));
      } else {
        attempt(true);
      }
    }, retryAfterMs);
    fetchPackageSnapshot(scope)
      .then(
        (snapshot) => {
          if (cancelled) return;
          try { onSnapshot(snapshot); } finally { endWait(); }
        },
        (error: unknown) => { if (!cancelled && isRetry) giveUpAttempts(error); },
      )
      .catch((error: unknown) => { console.warn('[packages] Applying the project snapshot failed', error); });
  };

  setAwaitedScopeKey(key);
  attempt(false);
  return () => {
    cancelled = true;
    endWait();
  };
}
