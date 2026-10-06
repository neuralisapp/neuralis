'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import type { UserAppearance } from '@/server/store/UserStore';

/**
 * Module-level cache for `UserAppearance` values keyed by userId.
 *
 * Multiple `<UserAvatar>` instances rendering the same user share one
 * fetch + one cache entry, so the dock-left, conversations-tab, and
 * turn-footer stacks do not each fire a `/api/user/profile` round-trip.
 *
 * Cache is intentionally process-scoped (not workspaceStore) — the
 * payload shape is local to this hook, never leaks into other slices,
 * and survives across project switches without invalidation noise. The
 * profile-editor `PATCH` calls `setUserAppearance` to keep the cache in
 * sync with the just-saved record.
 */

type CacheEntry = {
  appearance: UserAppearance | null;
  name: string | null;
  loadedAt: number;
  /**
   * `'error'` marks a *failed* fetch (network/HTTP). Unlike a successful
   * fetch that legitimately returned no appearance, an error entry is
   * retryable: `shouldFetch` re-attempts it once `ERROR_TTL_MS` has elapsed.
   * Absent / `'ok'` ⇒ a settled value that is never refetched.
   */
  status?: 'ok' | 'error';
};

/**
 * How long a failed fetch stays cached before it becomes retryable. Short
 * enough that the user icon recovers on its own within a couple of seconds of
 * the server warming up (Docker restart / WSL resume), long enough to avoid a
 * tight refetch loop while the backend is still down.
 */
const ERROR_TTL_MS = 10_000;

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<void>>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const subscribers = new Set<() => void>();

/**
 * Refcount of mounted consumers per userId. Used to bound retries: a failed
 * fetch is only re-attempted while at least one avatar for that user is still
 * mounted, so an unmounted component can never spin a background refetch loop.
 */
const wanted = new Map<string, number>();

function acquire(userId: string): void {
  wanted.set(userId, (wanted.get(userId) ?? 0) + 1);
}

function release(userId: string): void {
  const next = (wanted.get(userId) ?? 0) - 1;
  if (next <= 0) wanted.delete(userId);
  else wanted.set(userId, next);
}

function notify() {
  for (const fn of subscribers) fn();
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/**
 * Whether a fetch for `userId` should be started now. Blocks while a request
 * is in flight, skips settled (`ok`) entries, and re-arms an errored entry
 * only after its TTL — the key fix for the "blank icon until reload" bug,
 * where the old code cached a null entry permanently and never retried.
 */
function shouldFetch(userId: string): boolean {
  if (inflight.has(userId)) return false;
  const entry = cache.get(userId);
  if (!entry) return true;
  if (entry.status === 'error') return Date.now() - entry.loadedAt > ERROR_TTL_MS;
  return false;
}

function startFetch(userId: string): void {
  if (!shouldFetch(userId)) return;
  const p = fetchAppearance(userId);
  inflight.set(userId, p);
}

async function fetchAppearance(userId: string): Promise<void> {
  try {
    const res = await fetch(`/api/user/profile?userId=${encodeURIComponent(userId)}`, {
      credentials: 'same-origin',
    });
    if (!res.ok) {
      markError(userId);
      return;
    }
    const body = await res.json() as { appearance?: UserAppearance | null; name?: string | null };
    cache.set(userId, {
      appearance: body?.appearance ?? null,
      name: typeof body?.name === 'string' ? body.name : null,
      loadedAt: Date.now(),
      status: 'ok',
    });
  } catch {
    markError(userId);
  } finally {
    inflight.delete(userId);
    notify();
  }
}

/**
 * Record a failed fetch and schedule a single TTL-delayed retry so the avatar
 * recovers without any user interaction once the backend is back. The
 * per-userId guard prevents stacking timers across repeated failures; the
 * retry self-terminates when the last consumer unmounts (`wanted` hits 0).
 */
function markError(userId: string): void {
  cache.set(userId, { appearance: null, name: null, loadedAt: Date.now(), status: 'error' });
  if (!retryTimers.has(userId)) {
    const timer = setTimeout(() => {
      retryTimers.delete(userId);
      // Only re-attempt while something still wants this user; otherwise stop
      // (no reschedule) so an unmounted avatar can't loop forever.
      if ((wanted.get(userId) ?? 0) > 0) startFetch(userId);
      notify();
    }, ERROR_TTL_MS);
    // Don't keep the process alive for a retry tick (no-op in browsers).
    (timer as { unref?: () => void }).unref?.();
    retryTimers.set(userId, timer);
  }
}

/**
 * Read the cached `UserAppearance` for `userId`, fetching once on first
 * use. Returns `null` while loading, or when the fetch returned no data.
 *
 * Pass `null`/`undefined` to skip the fetch (the avatar then falls back
 * to its deterministic rendering).
 */
export function useUserAppearance(userId: string | null | undefined): UserAppearance | null {
  // Snapshot getter — same return identity for the same cache state so
  // useSyncExternalStore can bail out of unnecessary renders.
  const snapshot = useSyncExternalStore(
    subscribe,
    () => (userId ? cache.get(userId)?.appearance ?? null : null),
    () => null,
  );

  useEffect(() => {
    if (!userId) return;
    acquire(userId);
    startFetch(userId);
    return () => release(userId);
  }, [userId]);

  return snapshot;
}

/**
 * Read the cached display name for `userId`, fetching once on first use.
 * Returns `null` while loading, or when the fetch returned no data. Used
 * by avatar tooltips so hover shows the user's name instead of the raw id.
 */
export function useUserName(userId: string | null | undefined): string | null {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => (userId ? cache.get(userId)?.name ?? null : null),
    () => null,
  );
  useEffect(() => {
    if (!userId) return;
    acquire(userId);
    startFetch(userId);
    return () => release(userId);
  }, [userId]);
  return snapshot;
}

/** Imperative setter — used by the profile editor after a successful PATCH. */
export function setUserAppearance(
  userId: string,
  appearance: UserAppearance | null,
  name?: string | null,
): void {
  const prev = cache.get(userId);
  cache.set(userId, {
    appearance,
    name: name === undefined ? prev?.name ?? null : name,
    loadedAt: Date.now(),
    status: 'ok',
  });
  notify();
}

/** Clear the cache (test-only escape hatch). */
export function clearUserAppearanceCache(): void {
  cache.clear();
  inflight.clear();
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
  wanted.clear();
  notify();
}

/**
 * Test-only access to the fetch core + retry gate. The hooks themselves need a
 * React renderer (jsdom) to exercise; this lets the node-env test assert the
 * cache/TTL/retryability contract directly. Not part of the public surface.
 */
export const __testing = { fetchAppearance, shouldFetch, ERROR_TTL_MS };

/**
 * Minimal version of the hook for components that need explicit loading
 * state — not the common case, but useful for the profile editor's
 * "loading current settings" splash.
 */
export function useUserAppearanceWithStatus(userId: string | null | undefined): {
  appearance: UserAppearance | null;
  loading: boolean;
} {
  const appearance = useUserAppearance(userId);
  const [, force] = useState(0);
  useEffect(() => subscribe(() => force((n) => n + 1)), []);
  // An errored (retryable) entry still counts as loading — the value isn't
  // settled, a retry is pending — so the splash stays up instead of flashing
  // "no settings" during a transient backend hiccup.
  const entry = userId ? cache.get(userId) : undefined;
  const loading = Boolean(userId) && (!entry || entry.status === 'error');
  return { appearance, loading };
}
