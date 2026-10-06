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

import { describe, expect, it, vi } from 'vitest';
import type { PackageRuntimeSnapshot } from '@neuralis/package-system/contracts';
import {
  onSnapshotChange,
  seedSnapshotCache,
  getCachedSnapshot,
  getScopedSnapshot,
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
