'use client';

import { useShallow } from 'zustand/react/shallow';
import { useWorkspaceStore, agentRuntimeKey, type WorkspaceStore } from './workspaceStore';
import type { DockPrefs } from './types';
import type { DockId } from '../shell/dockPlacement';

const EMPTY_ARRAY: string[] = [];
const EMPTY_OBJECT: Record<string, never> = {};

/** Composite runtime key of the ACTIVE (project, agent) pair, or null. */
function activeRuntimeKey(s: WorkspaceStore): string | null {
  return s.session.projectId && s.session.agentId
    ? agentRuntimeKey(s.session.projectId, s.session.agentId)
    : null;
}

/**
 * PURE derivation: does this agent (in the ACTIVE project) hold a store?
 * Returns a primitive so subscribing components re-render only when the
 * answer flips — a geometry write replaces the runtime OBJECT every frame,
 * but key EXISTENCE stays stable (the drifting-moler dock floor).
 */
export function agentHasStore(s: WorkspaceStore, agentId: string): boolean {
  return Boolean(
    agentId && s.session.projectId && s.runtimeByAgentId[agentRuntimeKey(s.session.projectId, agentId)],
  );
}

/**
 * PURE derivation: the SORTED, '|'-joined set of project ids that hold at
 * least one runtime store. Sorted so the string is identical for the same
 * SET regardless of insertion order (Object.keys order shifts across
 * delete/re-add); a primitive return keeps the dock re-render-safe.
 */
export function projectsWithStoreKey(s: WorkspaceStore): string {
  const out = new Set<string>();
  for (const key of Object.keys(s.runtimeByAgentId)) {
    const i = key.indexOf(':');
    if (i > 0) out.add(key.slice(0, i));
  }
  return [...out].sort().join('|');
}

export function useWorkspaceSession() {
  return useWorkspaceStore((s) => s.session);
}

export function useProjectsState() {
  return useWorkspaceStore(
    useShallow((s) => ({
      byId: s.projects.byId,
      ids: s.projects.ids,
      status: s.projects.status,
      error: s.projects.error,
    })),
  );
}

export function useAgentsState() {
  return useWorkspaceStore(
    useShallow((s) => ({
      byId: s.agents.byId,
      ids: s.agents.ids,
      status: s.agents.status,
      error: s.agents.error,
    })),
  );
}

export function useActiveAgentRuntime() {
  return useWorkspaceStore(
    useShallow((s) => {
      const key = activeRuntimeKey(s);
      return { agentId: s.session.agentId, runtime: key ? s.runtimeByAgentId[key] : undefined };
    }),
  );
}

/** The "has a store" broom predicate for one agent tile (see `agentHasStore`). */
export function useAgentHasStore(agentId: string): boolean {
  return useWorkspaceStore((s) => agentHasStore(s, agentId));
}

/**
 * One dock's stored arrangement in the ACTIVE project, or `undefined` (the
 * default order). Reference-stable: every `projectStateById` writer spreads the
 * entry, so the `dock` object keeps its identity until `setDockPrefs` replaces it.
 */
export function useDockPrefs(dockId: DockId): DockPrefs | undefined {
  return useWorkspaceStore((s) => (s.session.projectId ? s.projectStateById[s.session.projectId]?.dock?.[dockId] : undefined));
}

/** Is this dock in edit mode (Layout → Edit docks)? */
export function useDockEditing(dockId: DockId): boolean {
  return useWorkspaceStore((s) => s.dockEditing[dockId]);
}

/** The "has a store" broom predicate per PROJECT row (see `projectsWithStoreKey`). */
export function useProjectsWithStore(): string {
  return useWorkspaceStore(projectsWithStoreKey);
}

/**
 * Lean selector for `StageHost` — only the fields it needs to render the
 * keep-alive portals and branch on stage mode. Deliberately EXCLUDES the
 * geometry maps (`freeformById`/`gridById`) and `canvasView` so a drag/resize/
 * pan does NOT re-render StageHost (which would reconcile every widget portal);
 * `byId`/`openOrder` are stable across geometry changes (geometry lives on
 * `layout`, not the instance).
 *
 * `runtimeKey` is the COMPOSITE key — StageHost keys `CanvasStage` on it, so
 * switching projects between same-slug agents remounts the canvas (a bare
 * agentId key kept the old project's pan/zoom alive and its debounced
 * `setCanvasView` then wrote the old viewport into the NEW project's runtime).
 */
export function useStageShell() {
  return useWorkspaceStore(
    useShallow((s) => {
      const key = activeRuntimeKey(s);
      const runtime = key ? s.runtimeByAgentId[key] : undefined;
      return {
        agentId: s.session.agentId,
        runtimeKey: key,
        openOrder: runtime?.widgets.openOrder ?? EMPTY_ARRAY,
        byId: runtime?.widgets.byId ?? EMPTY_OBJECT,
        stageMode: runtime?.layout.stageMode ?? 'tiled',
      };
    }),
  );
}

/**
 * Lean selector for the DOCK (`usePrimaryDockItems`) — the widget INSTANCE map
 * alone, which is all the dock reads (`type` / `hidden` / `id` per instance to
 * derive the three dock-item states).
 *
 * Deliberately EXCLUDES every geometry field (`mainSplit`, `widgetSplitsById`,
 * `freeformById`, `gridById`, `canvasView`) and `stageMode`/`chatCollapsed`.
 * That exclusion is the whole point: `usePrimaryDockItems` runs inside
 * `WorkspaceShell`, so subscribing it to `useOpenWidgets` made every
 * panel-divider drag frame and every canvas pan/drag write re-render the SHELL
 * and BOTH dock trees once per frame. The dock tracks are fixed sizes
 * (`DOCK_TRACK` in `../shell/dockPlacement.ts`), so that re-render cannot
 * re-derive the stage width and feed `onLayout` back into the store — the
 * shell-wide re-render per geometry frame is the cost this selector avoids.
 *
 * Safe because geometry lives on `runtime.layout`, never on the instance: every
 * geometry setter in `workspaceStore.ts` spreads `{ ...rt, layout: { ... } }`,
 * so `rt.widgets.byId` keeps its identity and `useShallow` short-circuits.
 */
export function useDockWidgetItems() {
  return useWorkspaceStore(
    useShallow((s) => {
      const key = activeRuntimeKey(s);
      const runtime = key ? s.runtimeByAgentId[key] : undefined;
      return { byId: runtime?.widgets.byId ?? EMPTY_OBJECT };
    }),
  );
}

/**
 * The FULL widget + layout view. Only the two stages consume it
 * (`TiledStage` reads `widgetSplitsById`, `CanvasStage` reads
 * `freeformById`/`gridById`) — they are the components that MUST re-render on a
 * geometry write. Anything that does not paint geometry should take
 * `useDockWidgetItems` or `useStageShell` instead.
 */
export function useOpenWidgets() {
  return useWorkspaceStore(
    useShallow((s) => {
      const key = activeRuntimeKey(s);
      const runtime = key ? s.runtimeByAgentId[key] : undefined;
      return {
        agentId: s.session.agentId,
        openOrder: runtime?.widgets.openOrder ?? EMPTY_ARRAY,
        byId: runtime?.widgets.byId ?? EMPTY_OBJECT,
        mainSplit: runtime?.layout.mainSplit,
        chatCollapsed: runtime?.layout.chatCollapsed,
        widgetSplitsById: runtime?.layout.widgetSplitsById ?? EMPTY_OBJECT,
        stageMode: runtime?.layout.stageMode ?? 'tiled',
        freeformById: runtime?.layout.freeformById ?? EMPTY_OBJECT,
        gridById: runtime?.layout.gridById ?? EMPTY_OBJECT,
      };
    }),
  );
}
