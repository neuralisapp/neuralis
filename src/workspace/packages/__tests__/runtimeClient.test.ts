/**
 * runtimeClient — snapshot cache + listener fan-out (BUG-B α regression).
 *
 * `WorkspaceRoot`'s `onSnapshotChange` listener applies each snapshot through
 * `applySnapshot` → `seedSnapshotCache`, which notifies EVERY listener —
 * including the one being notified. The notify path must therefore be
 * NON-RE-ENTRANT, or every runtime event recurses synchronously to the stack
 * limit (swallowed by the per-listener try/catch — the live console
 * `RangeError` storm).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PackageRuntimeSnapshot } from '@neuralis/package-system/contracts';
import {
  onSnapshotChange,
  seedSnapshotCache,
  getCachedSnapshot,
  getScopedSnapshot,
  isScopedSnapshotPending,
  loadScopedSnapshot,
  onScopedSnapshotPendingChange,
  fetchPackageSnapshot,
} from '../runtimeClient';

function makeSnapshot(revision: string): PackageRuntimeSnapshot {
  return { revision, generatedAt: 0, packages: [], tools: [], surfaces: [] } as unknown as PackageRuntimeSnapshot;
}

describe('seedSnapshotCache notify (BUG-B α)', () => {
  it('a listener that re-seeds (the WorkspaceRoot applySnapshot shape) does not recurse', () => {
    const snapshot = makeSnapshot('r1');
    const reSeeding = vi.fn((s: PackageRuntimeSnapshot) => {
      // Exactly what WorkspaceRoot's listener does: applySnapshot → seed.
      seedSnapshotCache(s);
    });
    const sibling = vi.fn();
    const stopA = onSnapshotChange(reSeeding);
    const stopB = onSnapshotChange(sibling);
    try {
      seedSnapshotCache(snapshot); // pre-fix: synchronous RangeError depth
      // ONE delivery per listener per seed — no re-entrant fan-out.
      expect(reSeeding).toHaveBeenCalledTimes(1);
      expect(sibling).toHaveBeenCalledTimes(1);
      expect(sibling).toHaveBeenCalledWith(snapshot);
      expect(getCachedSnapshot()).toBe(snapshot);
    } finally {
      stopA();
      stopB();
    }
  });

  it('keeps real propagation: consecutive DIFFERENT seeds each notify', () => {
    const seen: string[] = [];
    const stop = onSnapshotChange((s) => { seen.push(s.revision); });
    try {
      seedSnapshotCache(makeSnapshot('r1'));
      seedSnapshotCache(makeSnapshot('r2'));
      expect(seen).toEqual(['r1', 'r2']);
      expect(getCachedSnapshot()?.revision).toBe('r2');
    } finally {
      stop();
    }
  });
});

/**
 * The SSR seed is built with NO projectId (`getSSRSnapshot` passes only
 * `grantedFeatures: []`), so `passesProjectAndOwnerScope` short-circuits and the
 * payload carries the UNGATED contributions of EVERY project's packages. Any
 * surface that treats snapshot membership as a VISIBILITY PROOF — the derived
 * skill launcher — must therefore read `getScopedSnapshot`, which answers only
 * for the exact scope the snapshot was built for.
 *
 * If this ever goes green with a non-null result, a foreign project's skills are
 * being advertised during the first-paint window.
 */
describe('getScopedSnapshot fail-closed scoping', () => {
  it('the unscoped SSR seed is NOT returned for a project scope', () => {
    const seed = makeSnapshot('ssr');
    seedSnapshotCache(seed); // no scope — exactly how WorkspaceRoot seeds SSR
    expect(getCachedSnapshot({ projectId: 'p1' })).toBe(seed); // scope-blind read
    expect(getScopedSnapshot({ projectId: 'p1' })).toBeNull();
    expect(getScopedSnapshot({ projectId: 'p1', agentId: 'a1' })).toBeNull();
    // The unscoped scope key still matches an unscoped ask.
    expect(getScopedSnapshot()).toBe(seed);
  });

  it('an ALL-NULL scope is not the unscoped scope — the pre-bootstrap window', () => {
    // THE case that actually occurs and that the first version of this suite
    // missed: `session.projectId`/`agentId` are both null on every page load
    // until `bootstrap()` resolves, and the port asks with exactly that shape.
    // While `getScopeKey` built `':'` for both, this matched the unscoped SSR
    // seed and handed back every project's ungated skills.
    const seed = makeSnapshot('ssr');
    seedSnapshotCache(seed);
    expect(getScopedSnapshot({ projectId: null, agentId: null })).toBeNull();
    expect(getScopedSnapshot({ projectId: null })).toBeNull();
    expect(getScopedSnapshot({})).toBeNull();
  });

  it('a snapshot seeded for an all-null scope answers only that same shape', () => {
    const scoped = makeSnapshot('nulls');
    seedSnapshotCache(scoped, { projectId: null, agentId: null });
    expect(getScopedSnapshot({ projectId: null, agentId: null })).toBe(scoped);
    expect(getScopedSnapshot()).toBeNull(); // …and never the unscoped ask
  });

  it('a scoped seed answers its OWN scope and no other', () => {
    const scoped = makeSnapshot('scoped');
    seedSnapshotCache(scoped, { projectId: 'p1', agentId: 'a1' });
    expect(getScopedSnapshot({ projectId: 'p1', agentId: 'a1' })).toBe(scoped);
    expect(getScopedSnapshot({ projectId: 'p1', agentId: 'a2' })).toBeNull();
    expect(getScopedSnapshot({ projectId: 'p2', agentId: 'a1' })).toBeNull();
    expect(getScopedSnapshot()).toBeNull();
  });
});

/**
 * The dock shows its loading state while the workspace waits for the scoped
 * snapshot (the SSR seed is unscoped, so the package tiles are empty until it
 * lands). That wait is BOUNDED: one retry after the fallback, then it stops
 * and logs — never a poll, never a timer left behind.
 */
describe('loadScopedSnapshot — the bounded scoped wait', () => {
  const RETRY_MS = 6000;
  const answer = (snapshot: PackageRuntimeSnapshot) => ({ ok: true, status: 200, json: async () => snapshot }) as unknown as Response;
  const start = (scope: { projectId: string; agentId: string }) => {
    const delivered: string[] = [];
    const cancel = loadScopedSnapshot(scope, RETRY_MS, (snapshot) => {
      delivered.push(snapshot.revision);
      seedSnapshotCache(snapshot, scope); // what WorkspaceRoot's applySnapshot does
    });
    return { delivered, cancel };
  };

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is pending until the scoped snapshot is delivered, then clears with no timer left', async () => {
    vi.useFakeTimers();
    let resolve!: (res: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((r) => { resolve = r; }));
    vi.stubGlobal('fetch', fetchMock);
    const scope = { projectId: 'load-ok', agentId: 'a1' };
    const flips = vi.fn();
    const stop = onScopedSnapshotPendingChange(flips);
    const { delivered } = start(scope);
    expect(isScopedSnapshotPending(scope)).toBe(true);
    expect(isScopedSnapshotPending({ projectId: 'other', agentId: 'a1' })).toBe(false);
    resolve(answer(makeSnapshot('scoped')));
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toEqual(['scoped']);
    expect(isScopedSnapshotPending(scope)).toBe(false);
    expect(flips).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    stop();
  });

  it('a rejected fetch is retried ONCE after the fallback; then no attempt, no timer — and the dock still waits', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => { throw new Error('offline'); });
    vi.stubGlobal('fetch', fetchMock);
    const scope = { projectId: 'load-reject', agentId: 'a1' };
    const { delivered } = start(scope);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isScopedSnapshotPending(scope)).toBe(true); // the first failure waits for the fallback
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Never an empty dock presented as final: the scope stays awaited.
    expect(isScopedSnapshotPending(scope)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(RETRY_MS * 10);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(delivered).toEqual([]);
  });

  it('after both attempts failed, the hub\'s connect refetch (the runtime:snapshot path) ends the wait — no call of its own', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let hostUp = false;
    const fetchMock = vi.fn(async () => {
      if (!hostUp) throw new TypeError('Failed to fetch');
      return answer(makeSnapshot('after-restart'));
    });
    vi.stubGlobal('fetch', fetchMock);
    const scope = { projectId: 'load-recover', agentId: 'a1' };
    start(scope);
    await vi.advanceTimersByTimeAsync(RETRY_MS * 3);
    expect(isScopedSnapshotPending(scope)).toBe(true);
    hostUp = true;
    // `subscribeToRuntimeEvents` runs exactly this on the hub's on-connect frame.
    await fetchPackageSnapshot(scope);
    expect(isScopedSnapshotPending(scope)).toBe(false);
    expect(getScopedSnapshot(scope)?.revision).toBe('after-restart');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a fetch that never answers is retried once; after the second fallback no timer is left and the dock still waits', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    const scope = { projectId: 'load-hang', agentId: 'a1' };
    start(scope);
    await vi.advanceTimersByTimeAsync(RETRY_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(isScopedSnapshotPending(scope)).toBe(true);
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(isScopedSnapshotPending(scope)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cancel (unmount or a scope change) clears the timer and drops a later answer', async () => {
    vi.useFakeTimers();
    let resolve!: (res: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { resolve = r; })));
    const scope = { projectId: 'load-cancel', agentId: 'a1' };
    const { delivered, cancel } = start(scope);
    cancel();
    expect(isScopedSnapshotPending(scope)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    resolve(answer(makeSnapshot('late')));
    await vi.advanceTimersByTimeAsync(RETRY_MS * 3);
    expect(delivered).toEqual([]);
  });
});
