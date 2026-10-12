/**
 * Randomize / Undo: ONE coordinated commit over the eight layout keys, ONE
 * Undo of it, a storage failure at ANY write publishes nothing, and an Undo
 * never overwrites a later change.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeDom } from './fakeDom';

vi.mock('@/api/agents', () => ({ listAgents: vi.fn(async () => []) }));
vi.mock('@/api/projects', () => ({ listProjects: vi.fn(async () => []) }));

installFakeDom();
const { createElement } = await import('react');
const { useWorkspaceStore, agentRuntimeKey, groupScopeKey, runtimeKeyOf, WORKSPACE_PERSIST_KEY } = await import('../../store/workspaceStore');
const { registerWidget, syncPackageWidgets } = await import('../../widgets/registry');
const { randomizeLayout, undoLayout, hasLayoutUndo, clearLayoutUndo } = await import('../layoutTransaction');
const { DOCK_LAYOUT_KEY, DOCK_ANCHORS, naturalOrientations, saveDockLayoutConfig, readDockLayoutConfig } = await import('../dockPlacement');
const { DOCK_MODE_KEYS, dockModeIsPinned } = await import('../dockMode');
const { TRANSPARENCY_LEVELS } = await import('../widgetSurface');
const { APPEARANCE_KEYS } = await import('../../theme/ThemeContext');
const { THEMES } = await import('../../theme/themes');

type Appearance = { themeId: string; dockThemeId: string; backgroundThemeId: string; universe: boolean | null };
const s = () => useWorkspaceStore.getState();
const ls = () => (globalThis as unknown as { localStorage: Storage }).localStorage;
const LAYOUT_KEYS = [DOCK_LAYOUT_KEY, DOCK_MODE_KEYS.primary, DOCK_MODE_KEYS.secondary, APPEARANCE_KEYS.theme, APPEARANCE_KEYS.dock, APPEARANCE_KEYS.background, APPEARANCE_KEYS.universe, WORKSPACE_PERSIST_KEY];
const IMAGE = 'data:image/png;base64,AAAA';

/** A seeded generator (mulberry32) — 100 seeds are 100 reproducible layouts. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let appearance: Appearance;
let published: Appearance[];
let events: number;
const onLayout = () => { events += 1; };
const deps = (random: () => number, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = ls()) => ({
  storage, random, viewport: { width: 1280, height: 800 }, appearance,
  applyAppearance: (next: Appearance) => { appearance = next; published.push(next); },
});
const snapshotBytes = () => Object.fromEntries([...LAYOUT_KEYS, APPEARANCE_KEYS.image].map((k) => [k, ls().getItem(k)]));
let win1 = ''; let win2 = '';

beforeEach(() => {
  ls().clear();
  clearLayoutUndo();
  published = []; events = 0;
  appearance = { themeId: 'dark', dockThemeId: 'dark', backgroundThemeId: 'dark', universe: null };
  window.addEventListener('neuralis:layout-changed', onLayout);
  syncPackageWidgets([]);
  registerWidget({ type: 'chat', title: 'Chat', defaultOpen: true, openBehavior: { singleton: true }, render: () => createElement('div') });
  registerWidget({ type: 'files', title: 'Files', render: () => createElement('div') });
  s().reset();
  useWorkspaceStore.setState({
    dockEditing: { primary: false, secondary: false },
    liveUserId: 'u1',
    session: { projectId: 'p1', agentId: 'a1', workspaceView: 'default' },
    projectStateById: {},
    groupStateByScope: { [groupScopeKey('u1', 'p1')]: { presentation: 'agent', selectedGroupId: 'g1', groups: [{ id: 'g1', name: 'Team', memberIds: ['a1', 'a2'] }] } },
    runtimeByAgentId: {},
    agents: { byId: { a1: { id: 'a1', name: 'A1', userId: 'u1' }, a2: { id: 'a2', name: 'A2', userId: 'u1' } }, ids: ['a1', 'a2'], status: 'success', error: null },
  });
  win1 = s().openWidget({ agentId: 'a1', type: 'files', title: 'Files' })!;
  win2 = s().openWidget({ agentId: 'a1', type: 'files', title: 'Files 2', target: 'new' })!;
  // A layout the user already has: dock modes, a background image (never touched).
  ls().setItem(DOCK_MODE_KEYS.primary, 'labelPinned');
  ls().setItem(APPEARANCE_KEYS.image, IMAGE);
});
afterEach(() => { window.removeEventListener('neuralis:layout-changed', onLayout); });

describe('Randomize', () => {
  it('100 seeds: every field from its owner’s option set, one publish each, no identity touched, and ONE Undo restores the exact bytes', () => {
    const ids = new Set(THEMES.map((t) => t.id));
    // What the 100 layouts covered: a midpoint and both orientations at a corner (a non-vacuous rule check).
    const seen = { midpoint: 0, cornerH: 0, cornerV: 0 };
    for (let seed = 1; seed <= 100; seed++) {
      const before = snapshotBytes();
      const windowsBefore = JSON.stringify(s().runtimeByAgentId[agentRuntimeKey('p1', 'a1')].widgets);
      const groupsBefore = JSON.stringify(s().groupStateByScope[groupScopeKey('u1', 'p1')].groups);
      published = []; events = 0;
      expect(randomizeLayout(deps(seeded(seed)))).toEqual({ ok: true });
      expect([published.length, events]).toEqual([1, 1]);
      const layout = readDockLayoutConfig();
      for (const placement of [layout.primary, layout.secondary]) {
        expect(DOCK_ANCHORS).toContain(placement.anchor);
        // The anchor's natural orientation only — never a cross placement on a midpoint.
        expect(naturalOrientations(placement.anchor)).toContain(placement.orientation);
        if (naturalOrientations(placement.anchor).length === 1) seen.midpoint++;
        else if (placement.orientation === 'horizontal') seen.cornerH++; else seen.cornerV++;
      }
      // A pinned mode only — Randomize never hides a dock the user would have to hunt for.
      for (const key of [DOCK_MODE_KEYS.primary, DOCK_MODE_KEYS.secondary]) expect(dockModeIsPinned(ls().getItem(key) as never)).toBe(true);
      expect(TRANSPARENCY_LEVELS).toContain(layout.backgroundTransparency);
      for (const key of [APPEARANCE_KEYS.theme, APPEARANCE_KEYS.dock, APPEARANCE_KEYS.background]) expect(ids.has(ls().getItem(key)!)).toBe(true);
      expect(ls().getItem(APPEARANCE_KEYS.image)).toBe(IMAGE);
      expect(JSON.stringify(s().runtimeByAgentId[agentRuntimeKey('p1', 'a1')].widgets)).toBe(windowsBefore);
      expect(JSON.stringify(s().groupStateByScope[groupScopeKey('u1', 'p1')].groups)).toBe(groupsBefore);
      // The persisted runtime bytes ARE the published state's (no second writer).
      expect(ls().getItem(WORKSPACE_PERSIST_KEY)).toBe(JSON.stringify({ state: JSON.parse(ls().getItem(WORKSPACE_PERSIST_KEY)!).state, version: 2 }));
      expect(hasLayoutUndo(s())).toBe(true);
      expect(undoLayout(deps(seeded(seed)))).toEqual({ ok: true });
      const after = snapshotBytes();
      for (const key of LAYOUT_KEYS.filter((k) => k !== WORKSPACE_PERSIST_KEY)) expect([key, after[key]]).toEqual([key, before[key]]);
      expect(after[WORKSPACE_PERSIST_KEY]).toBe(before[WORKSPACE_PERSIST_KEY]);
      expect(hasLayoutUndo(s())).toBe(false);
    }
    expect(Math.min(seen.midpoint, seen.cornerH, seen.cornerV)).toBeGreaterThan(10);
  });

  it('switches to an EXISTING Group or back, never creating one; the departing layout stays mounted', () => {
    let sawGroup = false;
    for (let seed = 1; seed <= 40 && !sawGroup; seed++) {
      randomizeLayout(deps(seeded(seed)));
      sawGroup = s().groupStateByScope[groupScopeKey('u1', 'p1')].presentation === 'group';
      if (sawGroup) {
        expect(s().groupStateByScope[groupScopeKey('u1', 'p1')].groups).toHaveLength(1);
        expect(s().runtimeByAgentId[runtimeKeyOf({ kind: 'group', userId: 'u1', projectId: 'p1', groupId: 'g1' })]).toBeDefined();
        expect(s().retainedRuntimeKeys).toContain(agentRuntimeKey('p1', 'a1'));
      } else undoLayout(deps(seeded(seed)));
    }
    expect(sawGroup).toBe(true);
  });

  it('commit writes each key exactly once: persist elides the published state (no duplicate automatic write)', () => {
    const spy = vi.spyOn(ls(), 'setItem');
    randomizeLayout(deps(seeded(7)));
    const writes = spy.mock.calls.map(([key]) => key);
    spy.mockRestore();
    for (const key of LAYOUT_KEYS) expect(writes.filter((k) => k === key)).toHaveLength(1);
    expect(writes).not.toContain(APPEARANCE_KEYS.image);
  });

  it('a storage failure at EACH of the eight writes restores the previous bytes and publishes nothing', () => {
    for (let failAt = 1; failAt <= 8; failAt++) {
      const before = snapshotBytes();
      const stateBefore = JSON.stringify({ r: s().runtimeByAgentId, g: s().groupStateByScope });
      let n = 0;
      const realSet = ls().setItem.bind(ls());
      const failing = vi.spyOn(ls(), 'setItem').mockImplementation((k: string, v: string) => {
        n += 1;
        if (n === failAt) throw new Error('quota');
        realSet(k, v);
      });
      published = []; events = 0;
      const result = randomizeLayout(deps(seeded(failAt)));
      failing.mockRestore();
      expect([failAt, result.ok, (result as { reason?: string }).reason]).toEqual([failAt, false, 'storage']);
      expect(snapshotBytes()).toEqual(before);
      expect(JSON.stringify({ r: s().runtimeByAgentId, g: s().groupStateByScope })).toBe(stateBefore);
      expect([published.length, events]).toEqual([0, 0]);
      expect(hasLayoutUndo(s())).toBe(false);
    }
  });

  it('a failed rollback is reported, keeps the previous screen and drops the Undo', () => {
    randomizeLayout(deps(seeded(3)));
    expect(hasLayoutUndo(s())).toBe(true);
    let n = 0;
    const failing = vi.spyOn(ls(), 'setItem').mockImplementation(() => { n += 1; if (n >= 3) throw new Error('quota'); });
    published = [];
    const result = randomizeLayout(deps(seeded(4)));
    failing.mockRestore();
    expect((result as { reason?: string }).reason).toBe('rollback');
    expect(published).toHaveLength(0);
    expect(hasLayoutUndo(s())).toBe(false);
  });

  it('an open dock draft is never discarded: Randomize waits for Save/Cancel', () => {
    useWorkspaceStore.setState({ dockEditing: { primary: false, secondary: true } });
    const before = snapshotBytes();
    expect(randomizeLayout(deps(seeded(1)))).toMatchObject({ ok: false, reason: 'editing' });
    expect(snapshotBytes()).toEqual(before);
  });
});

describe('Undo', () => {
  it('a later manual change, a canvas gesture, a background image change or another user makes it unavailable', () => {
    expect(randomizeLayout(deps(seeded(5)))).toEqual({ ok: true });
    saveDockLayoutConfig({ ...readDockLayoutConfig(), chatPosition: readDockLayoutConfig().chatPosition === 'end' ? 'start' : 'end' });
    expect(undoLayout(deps(seeded(5)))).toMatchObject({ ok: false, reason: 'stale' });

    randomizeLayout(deps(seeded(6)));
    s().noteLayoutIntent(); // a pan began: its delayed write belongs to the new layout
    expect(undoLayout(deps(seeded(6)))).toMatchObject({ ok: false, reason: 'stale' });

    randomizeLayout(deps(seeded(8)));
    ls().removeItem(APPEARANCE_KEYS.image);
    expect(undoLayout(deps(seeded(8)))).toMatchObject({ ok: false, reason: 'stale' });

    randomizeLayout(deps(seeded(9)));
    s().setLiveUserId('u2');
    expect(undoLayout(deps(seeded(9)))).toMatchObject({ ok: false, reason: 'scope' });
  });

  it('restores geometry for the live windows only — a closed window is never recreated', () => {
    randomizeLayout(deps(seeded(11)));
    const key = agentRuntimeKey('p1', 'a1');
    s().closeWidget({ agentId: 'a1', widgetInstanceId: win2 }); // a manual change: Undo refuses
    expect(undoLayout(deps(seeded(11)))).toMatchObject({ ok: false, reason: 'stale' });
    expect(s().runtimeByAgentId[key].widgets.byId[win2]).toBeUndefined();
    expect(s().runtimeByAgentId[key].widgets.byId[win1]).toBeDefined();
  });

  it('a storage failure at each Undo write restores the randomized bytes and publishes nothing', () => {
    for (let failAt = 1; failAt <= 8; failAt++) {
      clearLayoutUndo();
      randomizeLayout(deps(seeded(20 + failAt)));
      const randomized = snapshotBytes();
      let n = 0;
      const realSet = ls().setItem.bind(ls());
      const realRemove = ls().removeItem.bind(ls());
      const failSet = vi.spyOn(ls(), 'setItem').mockImplementation((k: string, v: string) => { n += 1; if (n === failAt) throw new Error('quota'); realSet(k, v); });
      const failRemove = vi.spyOn(ls(), 'removeItem').mockImplementation((k: string) => { n += 1; if (n === failAt) throw new Error('quota'); realRemove(k); });
      published = [];
      const result = undoLayout(deps(seeded(20 + failAt)));
      failSet.mockRestore(); failRemove.mockRestore();
      expect([failAt, result.ok]).toEqual([failAt, false]);
      expect(snapshotBytes()).toEqual(randomized);
      expect(published).toHaveLength(0);
    }
  });
});
