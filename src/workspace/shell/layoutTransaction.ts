/**
 * Randomize / Undo — ONE coordinated commit over the layout's existing storage
 * keys, and ONE Undo of it.
 *
 * Why a module and not a store action: the commit spans four existing owners
 * (the workspace store's persisted runtime, the dock layout, the two dock
 * modes, the theme provider's appearance), each of which keeps its own format
 * and key. This file only COORDINATES them — it prepares every candidate,
 * writes the owners' own serialized bytes strictly, rolls back on a storage
 * failure, and only then publishes ONE store update, ONE appearance update and
 * ONE `neuralis:layout-changed` invalidation. It is coordinated UI/persistence
 * rollback, not a crash-atomic multi-key transaction.
 *
 * What it never touches: identities, conversations, Group membership or names,
 * window bindings/state/content, server state, the uploaded background image.
 */

import type { GroupScopeState, TiledLayoutState, WidgetInstance } from '../store/types';
import {
  activeRuntimeKeyOf, authorizedWindowOrder, composeLayoutCommit, groupScopeKey, serializeWorkspace,
  useWorkspaceStore, writeWorkspaceBytes, SAVED_STAGE_MODES, WORKSPACE_PERSIST_KEY, type WorkspaceStore,
} from '../store/workspaceStore';
import {
  CHAT_POSITIONS, DOCK_ANCHORS, DOCK_BACKGROUNDS, DOCK_LAYOUT_KEY, naturalOrientations, parseDockLayoutConfig, readDockLayoutConfig,
  serializeDockLayoutConfig, type DockId, type DockLayoutConfig, type DockPlacement,
} from './dockPlacement';
import { DOCK_MODE_KEYS, PINNED_DOCK_MODES, type DockMode } from './dockMode';
import { TRANSPARENCY_LEVELS } from './widgetSurface';
import { THEMES } from '../theme/themes';
import { APPEARANCE_KEYS, type AppearanceIds } from '../theme/ThemeContext';

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type LayoutTransactionDeps = {
  storage: KeyValueStorage;
  random: () => number;
  viewport: { width: number; height: number };
  appearance: AppearanceIds;
  applyAppearance: (next: AppearanceIds) => void;
};

export type LayoutTransactionResult =
  | { ok: true }
  | { ok: false; reason: 'editing' | 'scope' | 'storage' | 'rollback' | 'stale'; message: string };

/** The seven non-runtime keys, in write order (the runtime is written last). */
const SIMPLE_KEYS = [
  DOCK_LAYOUT_KEY, DOCK_MODE_KEYS.primary, DOCK_MODE_KEYS.secondary,
  APPEARANCE_KEYS.theme, APPEARANCE_KEYS.dock, APPEARANCE_KEYS.background, APPEARANCE_KEYS.universe,
] as const;

type Bytes = Record<string, string | null>;

/** Everything one side of a commit restores. */
type LayoutImage = {
  bytes: Bytes;
  appearance: AppearanceIds;
  dockLayout: DockLayoutConfig;
  groupStateByScope: Record<string, GroupScopeState>;
  layoutByKey: Record<string, TiledLayoutState>;
  /** Runtimes the commit created (an Undo removes them while still empty). */
  created: string[];
};

type Pending = { userId: string | null; projectId: string; keys: string[]; before: LayoutImage; after: string };

/** The ONE undoable commit of this tab (cleared by any later layout change or scope switch). */
let pending: Pending | null = null;

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.min(values.length - 1, Math.floor(random() * values.length))];
}

function readBytes(storage: KeyValueStorage, keys: readonly string[]): Bytes {
  const out: Bytes = {};
  for (const key of keys) out[key] = storage.getItem(key);
  return out;
}

/**
 * What a later manual change would alter: the stored bytes of the seven keys,
 * the uploaded image key (an upload/clear invalidates Undo; its bytes are never
 * written here), the layout-relevant projection of the store (presentation,
 * the affected runtimes' layout + windows, the dock arrangement) and the
 * layout epoch (a pending canvas gesture).
 */
function signature(storage: KeyValueStorage, s: WorkspaceStore, keys: string[]): string {
  const projectId = s.session.projectId ?? '';
  const scope = s.liveUserId ? s.groupStateByScope[groupScopeKey(s.liveUserId, projectId)] : undefined;
  return JSON.stringify({
    bytes: readBytes(storage, [...SIMPLE_KEYS, APPEARANCE_KEYS.image]),
    presentation: scope ? [scope.presentation, scope.selectedGroupId] : null,
    runtimes: keys.map((key) => {
      const rt = s.runtimeByAgentId[key];
      return rt ? [key, rt.layout, rt.widgets.openOrder] : [key, null];
    }),
    dock: s.projectStateById[projectId]?.dock ?? null,
    epoch: s.layoutEpoch,
  });
}

/**
 * Commit `next` (bytes + in-memory values) over `prev`: write every key
 * strictly; on a failure restore the previous bytes (absent ⇒ removed) and
 * publish NOTHING. Returns null on success.
 */
function writeAll(storage: KeyValueStorage, next: { bytes: Bytes; runtime: string }, prev: { bytes: Bytes; runtime: string | null }): LayoutTransactionResult | null {
  const done: string[] = [];
  try {
    for (const key of SIMPLE_KEYS) {
      const value = next.bytes[key];
      if (value === null) storage.removeItem(key); else storage.setItem(key, value);
      done.push(key);
    }
    writeWorkspaceBytes(next.runtime);
    return null;
  } catch {
    try {
      for (const key of done) {
        const value = prev.bytes[key];
        if (value === null) storage.removeItem(key); else storage.setItem(key, value);
      }
      // The runtime write is the last one: if it threw, persist's own bytes are unchanged.
      return { ok: false, reason: 'storage', message: 'The browser could not store the new layout — nothing changed.' };
    } catch {
      pending = null;
      return { ok: false, reason: 'rollback', message: 'The browser could not store the layout and could not fully restore the previous one. The screen shows the previous layout; reload to see what was stored.' };
    }
  }
}

function publish(deps: LayoutTransactionDeps, image: Pick<LayoutImage, 'appearance' | 'dockLayout'>, patch: Partial<WorkspaceStore>): void {
  // One store update, one appearance update, one invalidation — React batches
  // the two state updates of this (click) handler into one commit.
  useWorkspaceStore.setState(patch);
  deps.applyAppearance(image.appearance);
  window.dispatchEvent(new CustomEvent('neuralis:layout-changed', { detail: image.dockLayout }));
}

/** Random geometry for the live windows of one runtime, inside the viewport. */
function randomLayout(random: () => number, current: TiledLayoutState, windows: string[], byId: Record<string, WidgetInstance>, viewport: { width: number; height: number }): TiledLayoutState {
  const visible = windows.filter((id) => !byId[id]?.hidden);
  const weights = visible.map(() => 1 + random() * 2);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const widgetSplitsById: Record<string, number> = {};
  visible.forEach((id, i) => { widgetSplitsById[id] = Math.round((weights[i] / total) * 1000) / 10; });
  const box = (z: number) => {
    const w = Math.round(Math.min(viewport.width * 0.9, 320 + random() * 400));
    const h = Math.round(Math.min(viewport.height * 0.85, 240 + random() * 320));
    return { x: Math.round(random() * Math.max(0, viewport.width - w)), y: Math.round(random() * Math.max(0, viewport.height - h)), w, h, z };
  };
  const freeformById: Record<string, { x: number; y: number; w: number; h: number; z: number }> = {};
  const gridById: Record<string, { x: number; y: number; w: number; h: number; z: number }> = {};
  windows.forEach((id, i) => { freeformById[id] = box(i + 1); gridById[id] = box(i + 1); });
  return {
    ...current,
    stageMode: pick(random, SAVED_STAGE_MODES),
    widgetSplitsById,
    freeformById,
    gridById,
    canvasView: { x: 0, y: 0, zoom: pick(random, [0.85, 1, 1.15]) },
  };
}

function scopeOf(s: WorkspaceStore): { userId: string | null; projectId: string | null } {
  return { userId: s.liveUserId, projectId: s.session.projectId };
}

/** Is there an Undo for THIS user and project (still to be checked against later changes on click)? */
export function hasLayoutUndo(s: WorkspaceStore): boolean {
  return Boolean(pending && pending.userId === s.liveUserId && pending.projectId === s.session.projectId);
}

/** Forget the Undo (tests; a user/project switch is caught by the scope check). */
export function clearLayoutUndo(): void {
  pending = null;
}

export function randomizeLayout(deps: LayoutTransactionDeps): LayoutTransactionResult {
  const s = useWorkspaceStore.getState();
  if (s.dockEditing.primary || s.dockEditing.secondary) {
    return { ok: false, reason: 'editing', message: 'Save or cancel dock editing first — Randomize never discards a draft.' };
  }
  const { userId, projectId } = scopeOf(s);
  if (!projectId) return { ok: false, reason: 'scope', message: 'Open a project first.' };
  const { random, storage } = deps;

  // 1. The presentation FIRST: per-agent, or one of the user's EXISTING Groups.
  const scopeKey = userId ? groupScopeKey(userId, projectId) : null;
  const scope = scopeKey ? s.groupStateByScope[scopeKey] : undefined;
  const choices: Array<string | null> = [null, ...(scope?.groups.map((g) => g.id) ?? [])];
  const choice = pick(random, choices);
  const groupStateByScope = scopeKey && scope
    ? { ...s.groupStateByScope, [scopeKey]: choice ? { ...scope, presentation: 'group' as const, selectedGroupId: choice } : { ...scope, presentation: 'agent' as const } }
    : s.groupStateByScope;
  const sourceKey = activeRuntimeKeyOf(s);
  const targetKey = activeRuntimeKeyOf({ ...s, groupStateByScope });

  // 2. Geometry only for the target's live (and visible-to-this-user) windows.
  const layoutByKey: Record<string, TiledLayoutState> = {};
  const target = targetKey ? s.runtimeByAgentId[targetKey] : undefined;
  if (targetKey && target) {
    const windows = authorizedWindowOrder(targetKey, target.widgets.openOrder, target.widgets.byId, s.agents);
    layoutByKey[targetKey] = randomLayout(random, target.layout, windows, target.widgets.byId, deps.viewport);
  }

  // 3. Every appearance value from its owner's own option set. A dock takes
  // its anchor's NATURAL orientation (the drag's rule) and a PINNED mode only,
  // so Randomize never hides a dock or lays it across its edge.
  const current = readDockLayoutConfig();
  const placement = (dockId: DockId): DockPlacement => {
    const anchor = pick(random, DOCK_ANCHORS);
    return { dockId, anchor, orientation: pick(random, naturalOrientations(anchor)) };
  };
  const dockLayout: DockLayoutConfig = {
    ...current,
    primary: placement('primary'),
    secondary: placement('secondary'),
    chatPosition: pick(random, CHAT_POSITIONS),
    defaultWidgetTransparency: pick(random, TRANSPARENCY_LEVELS),
    defaultDockTransparency: pick(random, TRANSPARENCY_LEVELS),
    backgroundTransparency: pick(random, TRANSPARENCY_LEVELS),
    dockBackground: pick(random, DOCK_BACKGROUNDS),
  };
  // Bounded validation: the candidate must read back as itself through the owner's parser.
  if (JSON.stringify(parseDockLayoutConfig(JSON.parse(serializeDockLayoutConfig(dockLayout)))) !== JSON.stringify(dockLayout)) {
    return { ok: false, reason: 'scope', message: 'No valid layout could be prepared.' };
  }
  const modes: Record<DockId, DockMode> = { primary: pick(random, PINNED_DOCK_MODES), secondary: pick(random, PINNED_DOCK_MODES) };
  const ids = THEMES.map((t) => t.id);
  const appearance: AppearanceIds = { themeId: pick(random, ids), dockThemeId: pick(random, ids), backgroundThemeId: pick(random, ids), universe: random() < 0.5 };

  // 4. Prepare: previous bytes (absent kept as null) and the exact new bytes.
  const affected = [sourceKey, targetKey].filter((k): k is string => Boolean(k));
  const before: LayoutImage = {
    bytes: readBytes(storage, SIMPLE_KEYS),
    appearance: deps.appearance,
    dockLayout: current,
    groupStateByScope: s.groupStateByScope,
    layoutByKey: Object.fromEntries(affected.filter((k) => s.runtimeByAgentId[k]).map((k) => [k, s.runtimeByAgentId[k].layout])),
    created: affected.filter((k) => !s.runtimeByAgentId[k]),
  };
  const nextBytes: Bytes = {
    [DOCK_LAYOUT_KEY]: serializeDockLayoutConfig(dockLayout),
    [DOCK_MODE_KEYS.primary]: modes.primary,
    [DOCK_MODE_KEYS.secondary]: modes.secondary,
    [APPEARANCE_KEYS.theme]: appearance.themeId,
    [APPEARANCE_KEYS.dock]: appearance.dockThemeId,
    [APPEARANCE_KEYS.background]: appearance.backgroundThemeId,
    [APPEARANCE_KEYS.universe]: String(appearance.universe),
  };
  const patch = composeLayoutCommit(s, { groupStateByScope, layoutByKey, clearManual: targetKey ? [targetKey] : [] });
  const runtime = serializeWorkspace({ ...s, ...patch });

  // 5. Write strictly (rollback on failure), then publish once.
  const failed = writeAll(storage, { bytes: nextBytes, runtime }, { bytes: before.bytes, runtime: storage.getItem(WORKSPACE_PERSIST_KEY) });
  if (failed) return failed;
  publish(deps, { appearance, dockLayout }, patch);
  pending = { userId, projectId, keys: affected, before, after: signature(storage, useWorkspaceStore.getState(), affected) };
  return { ok: true };
}

export function undoLayout(deps: LayoutTransactionDeps): LayoutTransactionResult {
  const s = useWorkspaceStore.getState();
  const tx = pending;
  if (!tx || tx.userId !== s.liveUserId || tx.projectId !== s.session.projectId) {
    pending = null;
    return { ok: false, reason: 'scope', message: 'Nothing to undo here.' };
  }
  // Any later layout change (a setting, a dock, a window, a pending canvas
  // gesture, the background image) wins: Undo never overwrites newer work.
  if (signature(deps.storage, s, tx.keys) !== tx.after) {
    pending = null;
    return { ok: false, reason: 'stale', message: 'The layout changed since — Undo is no longer available.' };
  }
  if (s.dockEditing.primary || s.dockEditing.secondary) {
    return { ok: false, reason: 'editing', message: 'Save or cancel dock editing first.' };
  }
  const patch = composeLayoutCommit(s, { groupStateByScope: tx.before.groupStateByScope, layoutByKey: tx.before.layoutByKey, clearManual: [], dropEmpty: tx.before.created });
  const runtime = serializeWorkspace({ ...s, ...patch });
  const failed = writeAll(deps.storage, { bytes: tx.before.bytes, runtime }, { bytes: readBytes(deps.storage, SIMPLE_KEYS), runtime: deps.storage.getItem(WORKSPACE_PERSIST_KEY) });
  if (failed) return failed;
  // The dock modes are re-read from storage by the invalidation; the
  // appearance and the dock layout publish their restored values.
  publish(deps, tx.before, patch);
  pending = null;
  return { ok: true };
}
