'use client';

import { useShallow } from 'zustand/react/shallow';
import { useWorkspaceStore, agentRuntimeKey, type WorkspaceStore, effectiveStageMode, activeRuntimeKeyOf, activeGroup, activeGroupScope, authorizedWindowOrder, boundAgentOf, getDefaultChatWidgetType, newWindowAgentOf } from './workspaceStore';
import type { DockPrefs, WidgetInstance, WorkspaceGroup, WorkspacePresentation } from './types';
import { getWidgetDefinition } from '../widgets/registry';
import type { DockId } from '../shell/dockPlacement';

const EMPTY_ARRAY: string[] = [];
const EMPTY_OBJECT: Record<string, never> = {};

/** Key of the layout the stage shows: the agent's own, or the selected Group's. */
function activeRuntimeKey(s: WorkspaceStore): string | null {
  return activeRuntimeKeyOf(s);
}

/**
 * The active runtime's windows the caller may see: in a Group runtime only the
 * windows whose bound agent is in the freshly fetched agent list (identity- and
 * memo-stable — see `authorizedWindowOrder`).
 */
function visibleWindows(s: WorkspaceStore, key: string | null): { openOrder: string[]; byId: Record<string, WidgetInstance> } {
  const runtime = key ? s.runtimeByAgentId[key] : undefined;
  if (!runtime) return { openOrder: EMPTY_ARRAY, byId: EMPTY_OBJECT };
  const openOrder = authorizedWindowOrder(key, runtime.widgets.openOrder, runtime.widgets.byId, s.agents);
  return { openOrder, byId: runtime.widgets.byId };
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
      const { openOrder, byId } = visibleWindows(s, key);
      return {
        agentId: s.session.agentId,
        runtimeKey: key,
        openOrder,
        byId,
        stageMode: effectiveStageMode(s, key),
        phoneForegroundId: effectiveStageMode(s, key) === 'phone' && key ? phoneForegroundId(openOrder, byId, s.phoneForegroundByRuntimeKey[key]) : null,
      };
    }),
  );
}

/** The Phone foreground window id alone (null off Phone) — a primitive, so the dock re-renders only when it changes. */
export function usePhoneForegroundId(): string | null {
  return useWorkspaceStore((s) => {
    const key = activeRuntimeKey(s);
    if (!key || effectiveStageMode(s, key) !== 'phone') return null;
    const { openOrder, byId } = visibleWindows(s, key);
    return phoneForegroundId(openOrder, byId, s.phoneForegroundByRuntimeKey[key]);
  });
}

/**
 * The Phone foreground: the requested window; with none (a first open) or a
 * stale/minimized one, the chat slot's window — the chat is what an agent opens
 * to, even beside another package's default-open widget — else the last
 * visible window.
 */
export function phoneForegroundId(order: string[], byId: Record<string, import('./types').WidgetInstance>, requested?: string): string | null {
  const shown = (id: string): boolean => Boolean(byId[id] && !byId[id].hidden && getWidgetDefinition(byId[id].type));
  if (requested && shown(requested)) return requested;
  const chatType = getDefaultChatWidgetType();
  const chat = chatType ? order.find((id) => byId[id]?.type === chatType && shown(id)) : undefined;
  if (chat) return chat;
  for (let index = order.length - 1; index >= 0; index--) {
    if (shown(order[index])) return order[index];
  }
  return null;
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
      const { openOrder, byId } = visibleWindows(s, key);
      // `openOrder` keeps the dock blind to withheld Group windows.
      return { byId, openOrder, runtimeKey: key };
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
      const visible = visibleWindows(s, key);
      return {
        agentId: s.session.agentId,
        openOrder: visible.openOrder,
        byId: visible.byId,
        mainSplit: runtime?.layout.mainSplit,
        chatCollapsed: runtime?.layout.chatCollapsed,
        widgetSplitsById: runtime?.layout.widgetSplitsById ?? EMPTY_OBJECT,
        stageMode: effectiveStageMode(s, key),
        freeformById: runtime?.layout.freeformById ?? EMPTY_OBJECT,
        gridById: runtime?.layout.gridById ?? EMPTY_OBJECT,
      };
    }),
  );
}

/**
 * The presentation of the active project for the signed-in user, as stable
 * primitives (the ProjectSwitcher / Layout / Phone sheet read it).
 */
export function usePresentation(): { presentation: WorkspacePresentation; groupId: string | null; groupName: string | null; available: boolean } {
  return useWorkspaceStore(
    useShallow((s) => {
      const group = activeGroup(s);
      return {
        presentation: group ? 'group' as const : 'agent' as const,
        groupId: group?.id ?? null,
        groupName: group?.name ?? null,
        // Groups exist only for a signed-in user in a project.
        available: Boolean(s.liveUserId && s.session.projectId),
      };
    }),
  );
}

/** The signed-in user's Groups in the active project (reference-stable per write). */
export function useProjectGroups(): WorkspaceGroup[] {
  return useWorkspaceStore((s) => activeGroupScope(s)?.groups ?? NO_GROUPS);
}
const NO_GROUPS: WorkspaceGroup[] = [];

/** The agent a new window binds to (see `newWindowAgentOf`). */
export function useNewWindowAgent(): string | null {
  return useWorkspaceStore(newWindowAgentOf);
}

/**
 * A window's bound agent for its chrome: empty `name` in a per-agent layout
 * (the agent dock already names it); in a Group the agent's name, and
 * `outside` when it is no longer a member (the window stays, labelled).
 */
export function useWindowBinding(widgetInstanceId: string): { name: string; outside: boolean } {
  return useWorkspaceStore(
    useShallow((s) => {
      const key = activeRuntimeKey(s);
      const group = activeGroup(s);
      const inst = key && group ? s.runtimeByAgentId[key]?.widgets.byId[widgetInstanceId] : undefined;
      const bound = key && inst ? boundAgentOf(key, inst) : null;
      if (!group || !bound) return NO_BINDING;
      return { name: s.agents.byId[bound]?.name || bound, outside: !group.memberIds.includes(bound) };
    }),
  );
}
const NO_BINDING = { name: '', outside: false };

/** Retained (hidden, still mounted) runtimes' windows: `[key, byId, key, byId…]`. */
export function useRetainedWindows(): Array<string | Record<string, WidgetInstance>> {
  return useWorkspaceStore(
    useShallow((s) => {
      const out: Array<string | Record<string, WidgetInstance>> = [];
      for (const key of s.retainedRuntimeKeys) {
        const rt = s.runtimeByAgentId[key];
        if (rt) out.push(key, rt.widgets.byId);
      }
      return out;
    }),
  );
}
