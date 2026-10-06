'use client';

import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import type { ProjectRecord } from '@/api/projects';
import type { WorkspaceAgentRecord } from '@neuralis/package-system/contracts';
import { listProjects as apiListProjects } from '@/api/projects';
import { listAgents as apiListAgents } from '@/api/agents';
import { setProjectIdProvider } from '@/api/http';
import { emitClientStateReset } from './clientResetBus';
import type { AgentRuntime, CanvasView, DockPrefs, EntityState, FreeformGeometry, GeometrySlot, ProjectWorkspaceState, StageMode, TransparencyLevel, WidgetInstance, WorkspaceSession } from './types';
import { getWidgetDefinition, listDefaultOpenWidgets } from '../widgets/registry';
import type { DockId } from '../shell/dockPlacement';
import { normalizeDockPrefs } from '../shell/dockOrder';

const MAX_WIDGETS = 6;

const NOOP_STORAGE: StateStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

function nowIso(): string {
  return new Date().toISOString();
}

function generateId(prefix = 'w'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function emptyEntity<T>(): EntityState<T> {
  return { byId: {}, ids: [], status: 'idle', error: null };
}

function initialState(): Pick<WorkspaceStore, 'session' | 'projects' | 'agents' | 'runtimeByAgentId'> {
  return {
    session: { projectId: null, agentId: null, workspaceView: 'default' },
    projects: emptyEntity<ProjectRecord>(),
    agents: emptyEntity<WorkspaceAgentRecord>(),
    runtimeByAgentId: {},
  };
}

/**
 * Composite runtime key. Agent ids are per-project slugs and REPEAT across
 * projects (`admin`, `coder` exist in several live projects), so the runtime
 * and file-mark maps key by (project, agent) — a bare agent id shares ONE
 * layout entry across projects, and a project-level clean then deletes ACROSS
 * projects (measured live 2026-08-14). Both ids are `slugify` output (`:` can
 * never appear in either), so the separator is unambiguous and a
 * `${projectId}:` prefix scan over the map keys is exact.
 *
 * Composition rule (architect 1a): compose from the projectId that OWNS the
 * runtime in that action's context — the param/local in `selectProject` /
 * `bootstrap` / `cleanProjectStore`, and `session.projectId`
 * only in the actions that are active-project-by-construction.
 */
export function agentRuntimeKey(projectId: string, agentId: string): string {
  return `${projectId}:${agentId}`;
}

export type WorkspaceStore = {
  session: WorkspaceSession;
  projects: EntityState<ProjectRecord>;
  agents: EntityState<WorkspaceAgentRecord>;
  /**
   * COMPOSITE-KEYED since v2: the key is `agentRuntimeKey(projectId, agentId)`
   * (`"<projectId>:<agentId>"`), NEVER a bare agent id — bare ids collide
   * across projects. The field name is historical; every read/write goes
   * through `agentRuntimeKey`.
   */
  runtimeByAgentId: Record<string, AgentRuntime>;

  /**
   * Per-project switch memory (see `ProjectWorkspaceState`). Initialized at
   * store creation — NOT in `initialState()` — so `reset()`/`reload()` (fired
   * on every agent create) cannot wipe it and persist the wipe.
   */
  projectStateById: Record<string, ProjectWorkspaceState>;

  /**
   * Layout → Edit docks: which dock is in edit mode. TRANSIENT — outside
   * `partialize`, so a reload never reopens the editor. While editing, the
   * draft lives in the `Dock` component; the store is written once, on Save.
   */
  dockEditing: Record<DockId, boolean>;
  setDockEditing: (dockId: DockId | 'both', editing: boolean) => void;
  /** Store one dock's arrangement in the ACTIVE project (`projectStateById[p].dock`). */
  setDockPrefs: (params: { dockId: DockId; prefs: DockPrefs }) => void;

  /** Composite-keyed like `runtimeByAgentId` (`agentRuntimeKey`). Transient. */
  fileMarksByAgentId: Record<string, Record<string, { kind: 'new' | 'modified'; ts: number }>>;
  markFile: (params: { agentId: string; path: string; kind: 'new' | 'modified' }) => void;
  clearFileMark: (params: { agentId: string; path: string }) => void;
  clearAllFileMarks: (params: { agentId: string }) => void;

  cleanAgentStore: (params: { agentId: string }) => void;
  cleanProjectStore: (params: { projectId: string }) => void;

  bootstrap: () => Promise<void>;
  reset: () => void;
  reload: () => Promise<void>;
  /**
   * Re-read the project LIST only (a `project` hub frame: a record changed).
   * Never `reload()` — that wipes every project's layout. Hands over to
   * `bootstrap()` only when no valid active project is left.
   */
  refreshProjects: () => Promise<void>;

  selectProject: (projectId: string) => Promise<void>;
  selectAgent: (agentId: string) => void;
  setWorkspaceView: (view: WorkspaceSession['workspaceView']) => void;

  openWidget: (params: { agentId: string; type: string; title: string; icon?: string; initialState?: Record<string, unknown> }) => string | null;
  closeWidget: (params: { agentId: string; widgetInstanceId: string }) => void;
  minimizeWidget: (params: { agentId: string; widgetInstanceId: string }) => void;
  restoreWidget: (params: { agentId: string; widgetInstanceId: string }) => void;
  updateWidgetState: (params: { agentId: string; widgetInstanceId: string; patch: Record<string, unknown> }) => void;
  setWidgetTransparency: (params: { agentId: string; widgetInstanceId: string; level: TransparencyLevel }) => void;

  setMainSplit: (params: { agentId: string; split: [number, number] }) => void;
  setWidgetSplits: (params: { agentId: string; widgetIds: string[]; sizes: number[] }) => void;
  setChatCollapsed: (params: { agentId: string; collapsed: boolean }) => void;
  exclusiveOpenWidget: (params: { agentId: string; type: string; title: string; icon?: string }) => string | null;

  setStageMode: (params: { agentId: string; mode: StageMode }) => void;
  setWidgetGeometry: (params: { agentId: string; widgetInstanceId: string; slot: GeometrySlot; geometry: Partial<FreeformGeometry> }) => void;
  bringWidgetToFront: (params: { agentId: string; widgetInstanceId: string; slot: GeometrySlot }) => void;
  setCanvasView: (params: { agentId: string; view: CanvasView }) => void;
};

/** The persisted slice of the store (partialize / storage / migrate share it). */
type PersistedWorkspaceState = Pick<WorkspaceStore, 'runtimeByAgentId' | 'session' | 'projectStateById'>;

function ensureRuntime(runtimeByAgentId: Record<string, AgentRuntime>, runtimeKey: string): Record<string, AgentRuntime> {
  if (runtimeByAgentId[runtimeKey]) return runtimeByAgentId;
  // Phase 5 v6 step 5 — manifest-driven default-open widgets. Each
  // first-party package declares `defaultOpen: true` on the widget surface
  // it wants auto-mounted per agent (e.g. agent-core's `chat`). The host
  // no longer has hardcoded knowledge of which type owns the slot.
  const defaults = listDefaultOpenWidgets();
  const openOrder: string[] = [];
  const byId: Record<string, WidgetInstance> = {};
  const widgetSplitsById: Record<string, number> = {};
  const equal = defaults.length > 0 ? 100 / defaults.length : 100;
  for (const def of defaults) {
    const id = generateId('widget');
    openOrder.push(id);
    byId[id] = {
      id,
      type: def.type,
      title: def.title,
      icon: def.icon,
      createdAt: nowIso(),
      state: def.createInitialState ? def.createInitialState() : {},
    };
    widgetSplitsById[id] = equal;
  }
  return {
    ...runtimeByAgentId,
    [runtimeKey]: {
      widgets: { openOrder, byId },
      layout: { widgetSplitsById },
      conversation: { activeConversationId: null, conversationById: {} },
    },
  };
}

/**
 * Returns the widget type registered as `defaultOpen` (the chat slot).
 * Used by `setChatCollapsed` to find the auto-injected chat widget. If
 * no manifest declares one, the slot is simply absent — collapse becomes
 * a no-op.
 */
/**
 * The widget-state `nav` handoff is a one-shot MESSAGE — its applier consumes
 * it (`consumeWidgetNav`, `@neuralis/package-system/client`), and an
 * undelivered one EXPIRES at reload by design. Strip it from the persisted
 * payload so a stale nav can never re-apply after rehydrate. Fast path: when no
 * widget carries a live nav, the SAME object refs are returned (no per-write
 * allocation). An `undefined`-valued `nav` (the post-consume residue) is left
 * alone — JSON serialization drops it natively.
 */
export function stripWidgetNavs(
  runtimeByAgentId: Record<string, AgentRuntime>,
): Record<string, AgentRuntime> {
  let out: Record<string, AgentRuntime> | null = null;
  for (const [rk, rt] of Object.entries(runtimeByAgentId)) {
    let nextById: Record<string, WidgetInstance> | null = null;
    for (const [wid, inst] of Object.entries(rt.widgets.byId)) {
      if (inst?.state && inst.state.nav != null) {
        const { nav: _nav, ...rest } = inst.state;
        if (!nextById) nextById = { ...rt.widgets.byId };
        nextById[wid] = { ...inst, state: rest };
      }
    }
    if (nextById) {
      if (!out) out = { ...runtimeByAgentId };
      out[rk] = { ...rt, widgets: { ...rt.widgets, byId: nextById } };
    }
  }
  return out ?? runtimeByAgentId;
}

/**
 * The fetched project list as the store's `projects` slice, plus the switch
 * store pruned to the projects that still exist (or the user still belongs
 * to) — the map never GCs otherwise. `bootstrap` and `refreshProjects` share it.
 */
function projectListState(
  projects: ProjectRecord[],
  prev: Record<string, ProjectWorkspaceState>,
): Pick<WorkspaceStore, 'projects' | 'projectStateById'> {
  const byId: Record<string, ProjectRecord> = {};
  const ids: string[] = [];
  for (const p of projects) { byId[p.id] = p; ids.push(p.id); }
  const projectStateById: Record<string, ProjectWorkspaceState> = {};
  for (const id of ids) {
    if (prev[id]) projectStateById[id] = prev[id];
  }
  return { projects: { byId, ids, status: 'success', error: null }, projectStateById };
}

export function getDefaultChatWidgetType(): string | null {
  const defaults = listDefaultOpenWidgets();
  return defaults[0]?.type ?? null;
}

export const useWorkspaceStore = create<WorkspaceStore>()(
  persist(
    (set, get) => {
  // Register projectId provider so all fetch calls include the x-project-id header
  setProjectIdProvider(() => get().session.projectId);

  // Active-project key composition for the actions that are
  // active-project-by-construction (widget ops, file marks, agent clean).
  const activeKey = (agentId: string): string | null => {
    const projectId = get().session.projectId;
    return projectId ? agentRuntimeKey(projectId, agentId) : null;
  };

  return ({
  ...initialState(),
  projectStateById: {},
  fileMarksByAgentId: {},
  dockEditing: { primary: false, secondary: false },

  setDockEditing(dockId, editing) {
    set((s) => ({
      dockEditing: dockId === 'both'
        ? { primary: editing, secondary: editing }
        : { ...s.dockEditing, [dockId]: editing },
    }));
  },

  setDockPrefs({ dockId, prefs }) {
    const projectId = get().session.projectId;
    if (!projectId) return;
    const clean = normalizeDockPrefs(prefs);
    set((s) => {
      const entry = s.projectStateById[projectId] ?? { lastAgentId: s.session.agentId };
      return {
        projectStateById: {
          ...s.projectStateById,
          [projectId]: { ...entry, dock: { ...entry.dock, [dockId]: clean } },
        },
      };
    });
  },

  markFile({ agentId, path, kind }) {
    if (!agentId || !path) return;
    const rk = activeKey(agentId);
    if (!rk) return;
    set((s) => ({
      fileMarksByAgentId: {
        ...s.fileMarksByAgentId,
        [rk]: { ...(s.fileMarksByAgentId[rk] || {}), [path]: { kind, ts: Date.now() } },
      },
    }));
  },

  clearFileMark({ agentId, path }) {
    if (!agentId || !path) return;
    const rk = activeKey(agentId);
    if (!rk) return;
    set((s) => {
      const prev = s.fileMarksByAgentId[rk];
      if (!prev?.[path]) return s;
      const next = { ...prev };
      delete next[path];
      return { fileMarksByAgentId: { ...s.fileMarksByAgentId, [rk]: next } };
    });
  },

  clearAllFileMarks({ agentId }) {
    if (!agentId) return;
    const rk = activeKey(agentId);
    if (!rk) return;
    set((s) => ({
      fileMarksByAgentId: { ...s.fileMarksByAgentId, [rk]: {} },
    }));
  },

  cleanAgentStore({ agentId }) {
    if (!agentId) return;
    const rk = activeKey(agentId);
    if (rk) {
      // ONE set(): drop the agent's whole runtime + file marks; when it is the
      // ACTIVE agent, reseed immediately via ensureRuntime so the stage never
      // renders an empty runtime — fresh default-open widgets get NEW instance
      // ids, so StageHost GCs the old outlets and mounts fresh subtrees.
      set((s) => {
        const runtimeByAgentId = { ...s.runtimeByAgentId };
        delete runtimeByAgentId[rk];
        const fileMarksByAgentId = { ...s.fileMarksByAgentId };
        delete fileMarksByAgentId[rk];
        const next = s.session.agentId === agentId
          ? ensureRuntime(runtimeByAgentId, rk)
          : runtimeByAgentId;
        return { runtimeByAgentId: next, fileMarksByAgentId };
      });
    }
    // Every package client store keyed on this pair (the chat caches and the
    // client stream reader included) resets through the kernel port bus — after
    // the set() above, so a handler observes the cleaned runtime. Client state
    // only: server data and server-side runs are never touched.
    const projectId = get().session.projectId;
    if (projectId) emitClientStateReset({ level: 'agent', projectId, agentId });
  },

  cleanProjectStore({ projectId }) {
    if (!projectId) return;
    // ANY project with a store cleans — active or not. The composite key
    // records the project, so a `${projectId}:` prefix scan finds exactly the
    // agents whose store belongs to this project, with no server call and no
    // cross-project collision by construction.
    const state = get();
    const prefix = `${projectId}:`;
    const bareIds = new Set<string>();
    for (const key of Object.keys(state.runtimeByAgentId)) {
      if (key.startsWith(prefix)) bareIds.add(key.slice(prefix.length));
    }
    for (const key of Object.keys(state.fileMarksByAgentId)) {
      if (key.startsWith(prefix)) bareIds.add(key.slice(prefix.length));
    }
    // Belt+braces for the active project: the listed agents too, even if some
    // never seeded a runtime (their chat caches may still hold state).
    const isActive = state.session.projectId === projectId;
    if (isActive) for (const id of state.agents.ids) bareIds.add(id);
    if (bareIds.size === 0) {
      // No host rows to drop — a package store keyed on this project may still
      // hold state, so the bus event goes out regardless.
      emitClientStateReset({ level: 'project', projectId });
      return;
    }
    set((s) => {
      const runtimeByAgentId = { ...s.runtimeByAgentId };
      const fileMarksByAgentId = { ...s.fileMarksByAgentId };
      for (const id of bareIds) {
        delete runtimeByAgentId[agentRuntimeKey(projectId, id)];
        delete fileMarksByAgentId[agentRuntimeKey(projectId, id)];
      }
      // Reseed only when cleaning the ACTIVE project (the stage renders it).
      // `projectStateById` is RETAINED — `lastAgentId` is switch memory, not
      // store; the broom predicate turns false via the deleted runtime keys.
      const active = isActive ? s.session.agentId : null;
      const next = active ? ensureRuntime(runtimeByAgentId, agentRuntimeKey(projectId, active)) : runtimeByAgentId;
      return { runtimeByAgentId: next, fileMarksByAgentId };
    });
    // ONE project-level event for every package client store (bus, after the
    // set() above) — a subscriber matches on the project alone and clears every
    // agent slot it keys under it.
    emitClientStateReset({ level: 'project', projectId });
  },

  async bootstrap() {
    set((s) => ({ projects: { ...s.projects, status: 'loading', error: null } }));

    try {
      const projects = await apiListProjects();
      // Honor the persisted (rehydrated) project selection so a full page
      // refresh keeps the user in their last-viewed project. Fall back to the
      // first project if the persisted one is gone (deleted / membership lost).
      const persistedProjectId = get().session.projectId;
      const currentProjectId =
        persistedProjectId && projects.some((p) => p.id === persistedProjectId)
          ? persistedProjectId
          : projects[0]?.id ?? null;

      set((s) => ({
        ...projectListState(projects, s.projectStateById),
        session: { ...s.session, projectId: currentProjectId },
      }));

      if (currentProjectId) {
        set((s) => ({ agents: { ...s.agents, status: 'loading', error: null } }));
        const agents = await apiListAgents(currentProjectId);
        set((s) => {
          const byId: Record<string, WorkspaceAgentRecord> = {};
          const ids: string[] = [];
          for (const a of agents) { byId[a.id] = a; ids.push(a.id); }
          const nextAgentId = s.session.agentId && byId[s.session.agentId] ? s.session.agentId : ids[0] || null;
          const nextRuntime = nextAgentId
            ? ensureRuntime(s.runtimeByAgentId, agentRuntimeKey(currentProjectId, nextAgentId))
            : s.runtimeByAgentId;
          return {
            agents: { byId, ids, status: 'success', error: null },
            session: { ...s.session, agentId: nextAgentId },
            runtimeByAgentId: nextRuntime,
            projectStateById: {
              ...s.projectStateById,
              [currentProjectId]: { ...s.projectStateById[currentProjectId], lastAgentId: nextAgentId },
            },
          };
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Bootstrap failed';
      set((s) => ({
        projects: s.projects.status === 'loading' ? { ...s.projects, status: 'error', error: message } : s.projects,
        agents: s.agents.status === 'loading' ? { ...s.agents, status: 'error', error: message } : s.agents,
      }));
    }
  },

  reset() { set(() => initialState()); },

  async reload() { get().reset(); await get().bootstrap(); },

  async refreshProjects() {
    let projects: ProjectRecord[];
    try {
      projects = await apiListProjects();
    } catch (error) {
      // A missed refresh keeps the last good list; the next frame retries.
      console.warn('[workspace] project list refresh failed', error);
      return;
    }
    const activeId = get().session.projectId;
    const activeGone = activeId ? !projects.some((p) => p.id === activeId) : projects.length > 0;
    if (activeGone) {
      // The active project vanished (archived, purged, membership lost), or the
      // first one appeared: the bootstrap path owns choosing a project.
      await get().bootstrap();
      return;
    }
    set((s) => projectListState(projects, s.projectStateById));
  },

  async selectProject(projectId) {
    if (!projectId) return;
    // A dock-edit draft belongs to the project it was seeded from; a switch
    // closes the editor instead of re-targeting that draft.
    if (get().dockEditing.primary || get().dockEditing.secondary) {
      set({ dockEditing: { primary: false, secondary: false } });
    }
    // FAST PATH (the project switch store): when we remember which agent the
    // user last used in this project, select it IMMEDIATELY — its persisted
    // runtime paints the real workspace at once (no `agentId: null` window,
    // no agent-create wizard flash). The agent fetch below runs in the
    // background and only CORRECTS if the remembered agent is gone.
    const remembered = get().projectStateById[projectId]?.lastAgentId ?? null;
    // ONE set() (not two): `agents` goes STRAIGHT to 'loading' so WorkspaceRoot
    // can gate its wizard branch on the status without betting on React
    // batching two consecutive set() calls into one render.
    //
    // Key composition MUST use the incoming `projectId` param, never
    // `session.projectId` — inside this set() the session still points at the
    // DEPARTING project, and a session-composed key would seed the remembered
    // agent under the wrong project (the shared-layout bug at the switch
    // boundary, architect 1a).
    set((s) => ({
      session: {
        ...s.session,
        projectId,
        agentId: remembered,
        workspaceView: 'default',
      },
      agents: { ...emptyEntity<WorkspaceAgentRecord>(), status: 'loading' },
      // Do NOT clear runtimeByAgentId here: other projects' entries live in
      // the same composite-keyed map, so clearing it would discard — and, via
      // persist, erase from localStorage — every other project's agent layouts.
      runtimeByAgentId: remembered
        ? ensureRuntime(s.runtimeByAgentId, agentRuntimeKey(projectId, remembered))
        : s.runtimeByAgentId,
    }));

    try {
      const agents = await apiListAgents(projectId);
      // Staleness guard: the user may have switched projects again while this
      // fetch was in flight — a stale response must never clobber the newer
      // selection.
      if (get().session.projectId !== projectId) return;
      set((s) => {
        const byId: Record<string, WorkspaceAgentRecord> = {};
        const ids: string[] = [];
        for (const a of agents) { byId[a.id] = a; ids.push(a.id); }
        // Keep the fast-path (or otherwise current) agent when it is confirmed
        // by the fetched list; fall back to the first agent when it is gone.
        const agentId = s.session.agentId && byId[s.session.agentId] ? s.session.agentId : ids[0] || null;
        const nextRuntime = agentId
          ? ensureRuntime(s.runtimeByAgentId, agentRuntimeKey(projectId, agentId))
          : s.runtimeByAgentId;
        return {
          agents: { byId, ids, status: 'success', error: null },
          session: { ...s.session, agentId, workspaceView: 'default' },
          runtimeByAgentId: nextRuntime,
          projectStateById: { ...s.projectStateById, [projectId]: { ...s.projectStateById[projectId], lastAgentId: agentId } },
        };
      });
    } catch (error) {
      if (get().session.projectId !== projectId) return;
      const message = error instanceof Error ? error.message : 'Failed to load agents';
      set((s) => ({ agents: { ...s.agents, status: 'error', error: message } }));
    }
  },

  selectAgent(agentId) {
    if (!agentId) return;
    const projectId = get().session.projectId;
    if (!projectId) return;
    set((s) => ({
      session: { ...s.session, agentId, workspaceView: 'default' },
      runtimeByAgentId: ensureRuntime(s.runtimeByAgentId, agentRuntimeKey(projectId, agentId)),
      projectStateById: { ...s.projectStateById, [projectId]: { ...s.projectStateById[projectId], lastAgentId: agentId } },
    }));
  },

  setWorkspaceView(view) {
    set((s) => ({ session: { ...s.session, workspaceView: view } }));
  },

  openWidget({ agentId, type, title, icon, initialState: init }) {
    if (!agentId) return null;
    const rk = activeKey(agentId);
    if (!rk) return null;
    // Ensure the runtime — and its manifest `defaultOpen` widgets (e.g. chat) —
    // BEFORE the singleton lookup. A never-visited agent's runtime is seeded
    // lazily; without ensuring first, opening a singleton that is ALSO a
    // default-open widget into a fresh runtime misses the about-to-be-seeded
    // default and creates a DUPLICATE (the cross-agent "Open in chat" → two
    // chat panels bug). ensureRuntime returns the SAME ref for an existing
    // runtime, so this is a no-op (no extra render) in the common case.
    const ensured = ensureRuntime(get().runtimeByAgentId, rk);
    if (ensured !== get().runtimeByAgentId) set({ runtimeByAgentId: ensured });
    const runtime = ensured[rk];
    const singleton = getWidgetDefinition(type)?.openBehavior?.singleton ?? false;
    const existingId = singleton
      ? runtime?.widgets.openOrder.find((id) => runtime.widgets.byId[id]?.type === type)
      : undefined;
    if (existingId) {
      // Re-opening a singleton from the dock restores it if it was minimized
      // (unhide) and merges any new init state. The mounted-hidden instance
      // becomes visible again with zero restart.
      set((s) => {
        const rt = s.runtimeByAgentId[rk];
        if (!rt) return s;
        const inst = rt.widgets.byId[existingId];
        if (!inst) return s;
        const needsUnhide = inst.hidden === true;
        const hasInit = Boolean(init && Object.keys(init).length > 0);
        if (!needsUnhide && !hasInit) return s;
        const nextInst: WidgetInstance = {
          ...inst,
          hidden: false,
          state: hasInit ? { ...inst.state, ...init } : inst.state,
        };
        const widgetSplitsById = { ...(rt.layout.widgetSplitsById || {}) };
        if (typeof widgetSplitsById[existingId] !== 'number') {
          const visibleIds = rt.widgets.openOrder.filter((id) => id === existingId || !rt.widgets.byId[id]?.hidden);
          widgetSplitsById[existingId] = 100 / Math.max(1, visibleIds.length);
        }
        return {
          runtimeByAgentId: {
            ...s.runtimeByAgentId,
            [rk]: { ...rt, widgets: { ...rt.widgets, byId: { ...rt.widgets.byId, [existingId]: nextInst } }, layout: { ...rt.layout, widgetSplitsById } },
          },
        };
      });
      return existingId;
    }

    const widgetId = generateId('widget');
    const instance: WidgetInstance = { id: widgetId, type, title, icon, createdAt: nowIso(), state: { ...(init || {}) } };

    set((s) => {
      const runtimeByAgentId = ensureRuntime(s.runtimeByAgentId, rk);
      const rt = runtimeByAgentId[rk];
      const nextOpen = [...rt.widgets.openOrder, widgetId];
      const nextById = { ...rt.widgets.byId, [widgetId]: instance };
      // The MAX_WIDGETS cap applies to VISIBLE (non-hidden) widgets only —
      // overflow MINIMIZES the oldest visible widget (preserving its content)
      // instead of destroying it.
      const visibleIds = nextOpen.filter((id) => !nextById[id]?.hidden);
      if (visibleIds.length > MAX_WIDGETS) {
        const toHide = visibleIds.slice(0, visibleIds.length - MAX_WIDGETS);
        for (const hid of toHide) {
          const inst = nextById[hid];
          if (inst) nextById[hid] = { ...inst, hidden: true };
        }
      }
      const widgetSplitsById = { ...(rt.layout.widgetSplitsById || {}) };
      const visibleNow = nextOpen.filter((id) => !nextById[id]?.hidden);
      const equal = 100 / Math.max(1, visibleNow.length);
      for (const id of visibleNow) {
        if (typeof widgetSplitsById[id] !== 'number') widgetSplitsById[id] = equal;
      }
      return {
        runtimeByAgentId: {
          ...runtimeByAgentId,
          [rk]: { ...rt, widgets: { openOrder: nextOpen, byId: nextById }, layout: { ...rt.layout, widgetSplitsById } },
        },
      };
    });
    return widgetId;
  },

  closeWidget({ agentId, widgetInstanceId }) {
    if (!agentId || !widgetInstanceId) return;
    const rk = activeKey(agentId);
    if (!rk) return;
    // The widget TYPE is read BEFORE the delete — it is what the reset scope
    // carries, and after the set() the instance is gone.
    const projectId = get().session.projectId;
    const widgetType = get().runtimeByAgentId[rk]?.widgets.byId[widgetInstanceId]?.type;
    if (!projectId || !widgetType) return;
    set((s) => {
      const rt = s.runtimeByAgentId[rk];
      if (!rt?.widgets.byId[widgetInstanceId]) return s;
      const openOrder = rt.widgets.openOrder.filter((id) => id !== widgetInstanceId);
      const byId = { ...rt.widgets.byId };
      delete byId[widgetInstanceId];
      const widgetSplitsById = { ...(rt.layout.widgetSplitsById || {}) };
      delete widgetSplitsById[widgetInstanceId];
      // Clean means clean: drop the instance's canvas/grid geometry too, so no
      // orphan entries survive in the persisted layout (they used to leak).
      const freeformById = { ...(rt.layout.freeformById || {}) };
      delete freeformById[widgetInstanceId];
      const gridById = { ...(rt.layout.gridById || {}) };
      delete gridById[widgetInstanceId];
      return {
        runtimeByAgentId: {
          ...s.runtimeByAgentId,
          [rk]: {
            ...rt,
            widgets: { openOrder, byId },
            layout: { ...rt.layout, widgetSplitsById, freeformById, gridById },
          },
        },
      };
    });
    // Widget-level broom: the package that owns this widget TYPE drops its client
    // store for the (project, agent) pair — emitted after the set() (port rule).
    emitClientStateReset({ level: 'widget', projectId, agentId, widgetType });
  },

  minimizeWidget({ agentId, widgetInstanceId }) {
    if (!agentId || !widgetInstanceId) return;
    const rk = activeKey(agentId);
    if (!rk) return;
    set((s) => {
      const rt = s.runtimeByAgentId[rk];
      const inst = rt?.widgets.byId[widgetInstanceId];
      if (!inst || inst.hidden) return s;
      // Keep the instance in byId + openOrder (and its split slot) so it is
      // preserved and re-renderable; just flag it hidden. StageHost's keep-alive
      // keeps it MOUNTED off-screen so restoring is instant with no React
      // remount (an `<iframe>` in the outlet still reloads — see
      // `widgets/README.md`).
      return {
        runtimeByAgentId: {
          ...s.runtimeByAgentId,
          [rk]: { ...rt, widgets: { ...rt.widgets, byId: { ...rt.widgets.byId, [widgetInstanceId]: { ...inst, hidden: true } } } },
        },
      };
    });
  },

  restoreWidget({ agentId, widgetInstanceId }) {
    if (!agentId || !widgetInstanceId) return;
    const rk = activeKey(agentId);
    if (!rk) return;
    set((s) => {
      const rt = s.runtimeByAgentId[rk];
      const inst = rt?.widgets.byId[widgetInstanceId];
      if (!inst || !inst.hidden) return s;
      const widgetSplitsById = { ...(rt.layout.widgetSplitsById || {}) };
      if (typeof widgetSplitsById[widgetInstanceId] !== 'number') {
        const visibleIds = rt.widgets.openOrder.filter((id) => id === widgetInstanceId || !rt.widgets.byId[id]?.hidden);
        widgetSplitsById[widgetInstanceId] = 100 / Math.max(1, visibleIds.length);
      }
      return {
        runtimeByAgentId: {
          ...s.runtimeByAgentId,
          [rk]: { ...rt, widgets: { ...rt.widgets, byId: { ...rt.widgets.byId, [widgetInstanceId]: { ...inst, hidden: false } } }, layout: { ...rt.layout, widgetSplitsById } },
        },
      };
    });
  },

  updateWidgetState({ agentId, widgetInstanceId, patch }) {
    if (!agentId || !widgetInstanceId) return;
    const rk = activeKey(agentId);
    if (!rk) return;
    set((s) => {
      const rt = s.runtimeByAgentId[rk];
      const inst = rt?.widgets.byId[widgetInstanceId];
      if (!inst) return s;
      return {
        runtimeByAgentId: {
          ...s.runtimeByAgentId,
          [rk]: { ...rt, widgets: { ...rt.widgets, byId: { ...rt.widgets.byId, [widgetInstanceId]: { ...inst, state: { ...inst.state, ...patch } } } } },
        },
      };
    });
  },

  setWidgetTransparency({ agentId, widgetInstanceId, level }) {
    if (!agentId || !widgetInstanceId) return;
    const rk = activeKey(agentId);
    if (!rk) return;
    set((s) => {
      const rt = s.runtimeByAgentId[rk];
      const inst = rt?.widgets.byId[widgetInstanceId];
      if (!inst || inst.transparency === level) return s;
      return {
        runtimeByAgentId: {
          ...s.runtimeByAgentId,
          [rk]: {
            ...rt,
            widgets: {
              ...rt.widgets,
              byId: { ...rt.widgets.byId, [widgetInstanceId]: { ...inst, transparency: level } },
            },
          },
        },
      };
    });
  },

  setMainSplit({ agentId, split }) {
    if (!agentId) return;
    const rk = activeKey(agentId);
    if (!rk) return;
    set((s) => {
      const rt = s.runtimeByAgentId[rk];
      if (!rt) return s;
      const prev = rt.layout.mainSplit;
      if (
        prev?.[0] === split[0]
        && prev?.[1] === split[1]
      ) {
        return s;
      }
      return { runtimeByAgentId: { ...s.runtimeByAgentId, [rk]: { ...rt, layout: { ...rt.layout, mainSplit: split } } } };
    });
  },

  setWidgetSplits({ agentId, widgetIds, sizes }) {
    if (!agentId || widgetIds.length !== sizes.length) return;
    const rk = activeKey(agentId);
    if (!rk) return;
    set((s) => {
      const rt = s.runtimeByAgentId[rk];
      if (!rt) return s;
      const next = { ...(rt.layout.widgetSplitsById || {}) };
      let changed = false;
      for (let i = 0; i < widgetIds.length; i++) {
        if (typeof widgetIds[i] !== 'string' || !Number.isFinite(sizes[i])) continue;
        if (next[widgetIds[i]] === sizes[i]) continue;
        next[widgetIds[i]] = sizes[i];
        changed = true;
      }
      if (!changed) return s;
      return { runtimeByAgentId: { ...s.runtimeByAgentId, [rk]: { ...rt, layout: { ...rt.layout, widgetSplitsById: next } } } };
    });
  },

  setChatCollapsed({ agentId, collapsed }) {
    if (!agentId) return;
    const rk = activeKey(agentId);
    if (!rk) return;
    const chatType = getDefaultChatWidgetType();
    if (!chatType) return;
    if (collapsed) {
      const rt = get().runtimeByAgentId[rk];
      if (!rt) return;
      const chatWidgetId = rt.widgets.openOrder.find((id) => rt.widgets.byId[id]?.type === chatType);
      if (chatWidgetId) get().closeWidget({ agentId, widgetInstanceId: chatWidgetId });
    } else {
      const def = getWidgetDefinition(chatType);
      get().openWidget({ agentId, type: chatType, title: def?.title ?? 'Chat' });
    }
  },

  exclusiveOpenWidget({ agentId, type, title, icon }) {
    if (!agentId) return null;
    const rk = activeKey(agentId);
    if (!rk) return null;
    const ensured = ensureRuntime(get().runtimeByAgentId, rk);
    if (ensured !== get().runtimeByAgentId) set({ runtimeByAgentId: ensured });
    const widgetId = generateId('widget');
    const rt0 = ensured[rk];
    const existingId = rt0?.widgets.openOrder.find((id) => rt0.widgets.byId[id]?.type === type);
    const useId = existingId ?? widgetId;

    set((s) => {
      const runtimeByAgentId = ensureRuntime(s.runtimeByAgentId, rk);
      const rt = runtimeByAgentId[rk];
      const chatType = getDefaultChatWidgetType();

      // Focus the target exclusively: every OTHER visible widget is MINIMIZED
      // (preserved, not destroyed). The target + the default-open chat stay
      // visible; the target is unhidden if it was minimized.
      const nextOpen = [...rt.widgets.openOrder];
      const nextById: Record<string, WidgetInstance> = {};
      for (const id of rt.widgets.openOrder) {
        const inst = rt.widgets.byId[id];
        if (!inst) continue;
        const keepVisible = id === useId || inst.type === chatType;
        nextById[id] = keepVisible
          ? (inst.hidden ? { ...inst, hidden: false } : inst)
          : (inst.hidden ? inst : { ...inst, hidden: true });
      }
      if (!existingId) {
        nextById[widgetId] = { id: widgetId, type, title, icon, createdAt: nowIso(), state: {} };
        nextOpen.push(widgetId);
      }

      const visibleIds = nextOpen.filter((id) => !nextById[id]?.hidden);
      const widgetSplitsById = { ...(rt.layout.widgetSplitsById || {}) };
      const equal = 100 / Math.max(1, visibleIds.length);
      for (const id of visibleIds) {
        // Exclusive widget dominant (60), chat companion narrow (40); fall
        // back to equal splits for any unexpected extra visible widget.
        widgetSplitsById[id] = id === useId ? Math.max(equal, 60) : (visibleIds.length === 2 ? 40 : equal);
      }

      return {
        runtimeByAgentId: {
          ...runtimeByAgentId,
          [rk]: { ...rt, widgets: { openOrder: nextOpen, byId: nextById }, layout: { ...rt.layout, widgetSplitsById } },
        },
      };
    });
    return useId;
  },

  setStageMode({ agentId, mode }) {
    if (!agentId) return;
    const rk = activeKey(agentId);
    if (!rk) return;
    set((s) => {
      const runtimeByAgentId = ensureRuntime(s.runtimeByAgentId, rk);
      const rt = runtimeByAgentId[rk];
      if (rt.layout.stageMode === mode && runtimeByAgentId === s.runtimeByAgentId) return s;
      return {
        runtimeByAgentId: {
          ...runtimeByAgentId,
          [rk]: { ...rt, layout: { ...rt.layout, stageMode: mode } },
        },
      };
    });
  },

  setWidgetGeometry({ agentId, widgetInstanceId, slot, geometry }) {
    if (!agentId || !widgetInstanceId) return;
    const rk = activeKey(agentId);
    if (!rk) return;
    const key = slot === 'grid' ? 'gridById' : 'freeformById';
    set((s) => {
      const rt = s.runtimeByAgentId[rk];
      if (!rt || !rt.widgets.byId[widgetInstanceId]) return s;
      const map = rt.layout[key] || {};
      const prev = map[widgetInstanceId];
      const base: FreeformGeometry = prev ?? { x: 40, y: 40, w: 480, h: 360, z: 1 };
      const next: FreeformGeometry = {
        x: Number.isFinite(geometry.x) ? (geometry.x as number) : base.x,
        y: Number.isFinite(geometry.y) ? (geometry.y as number) : base.y,
        w: Number.isFinite(geometry.w) ? (geometry.w as number) : base.w,
        h: Number.isFinite(geometry.h) ? (geometry.h as number) : base.h,
        z: Number.isFinite(geometry.z) ? (geometry.z as number) : base.z,
      };
      if (prev && prev.x === next.x && prev.y === next.y && prev.w === next.w && prev.h === next.h && prev.z === next.z) return s;
      return {
        runtimeByAgentId: {
          ...s.runtimeByAgentId,
          [rk]: { ...rt, layout: { ...rt.layout, [key]: { ...map, [widgetInstanceId]: next } } },
        },
      };
    });
  },

  bringWidgetToFront({ agentId, widgetInstanceId, slot }) {
    if (!agentId || !widgetInstanceId) return;
    const rk = activeKey(agentId);
    if (!rk) return;
    const key = slot === 'grid' ? 'gridById' : 'freeformById';
    set((s) => {
      const rt = s.runtimeByAgentId[rk];
      const map = rt?.layout[key];
      if (!rt || !map || !map[widgetInstanceId]) return s;
      let maxZ = 0;
      for (const g of Object.values(map)) if (g.z > maxZ) maxZ = g.z;
      const cur = map[widgetInstanceId];
      const countAtMax = Object.values(map).filter((g) => g.z === maxZ).length;
      // Already the sole top-most window — no write on repeated mousedown.
      if (cur.z === maxZ && countAtMax === 1) return s;
      return {
        runtimeByAgentId: {
          ...s.runtimeByAgentId,
          [rk]: { ...rt, layout: { ...rt.layout, [key]: { ...map, [widgetInstanceId]: { ...cur, z: maxZ + 1 } } } },
        },
      };
    });
  },

  setCanvasView({ agentId, view }) {
    if (!agentId) return;
    const rk = activeKey(agentId);
    if (!rk) return;
    set((s) => {
      const rt = s.runtimeByAgentId[rk];
      if (!rt) return s;
      const prev = rt.layout.canvasView;
      if (prev && prev.x === view.x && prev.y === view.y && prev.zoom === view.zoom) return s;
      return {
        runtimeByAgentId: { ...s.runtimeByAgentId, [rk]: { ...rt, layout: { ...rt.layout, canvasView: view } } },
      };
    });
  },
});
    },
    {
      // Persist the widget layout (open/minimized widgets, their state —
      // MINUS the one-shot `nav` handoff, stripped by `stripWidgetNavs` —
      // transparency overrides, and splits), the active project/agent
      // selection AND the per-project switch memory (projectStateById) so a
      // full page refresh keeps the user in their last-viewed project and
      // agent, and a project switch returns to that project's last-used
      // agent, with the project's dock arrangement. The projects/agents entity
      // caches, transient file marks and the dock edit mode are NOT persisted —
      // the caches are re-fetched from the API on bootstrap, which validates
      // the rehydrated session against them.
      // `ensureRuntime` returns the rehydrated runtime as-is (no default-open
      // re-seeding) because it short-circuits when a runtime already exists.
      name: 'neuralis:workspace:runtime',
      // Server-safe: a noop StateStorage during SSR (no `localStorage`),
      // real `localStorage` in the browser. persist becomes a no-op on the
      // server and hydrates from localStorage after client mount.
      storage: createJSONStorage<PersistedWorkspaceState>(
        () => (typeof window !== 'undefined' ? window.localStorage : NOOP_STORAGE),
      ),
      // v2 (2026-08-14): runtime/file-mark keys became composite
      // `<projectId>:<agentId>`. NEVER bump this version without a real
      // `migrate` — zustand drops the whole persisted payload on a version
      // mismatch with no migrate, erasing every user's layout and session.
      version: 2,
      migrate: (persistedState, version) => {
        if (version >= 2) return persistedState as PersistedWorkspaceState;
        // v1 → v2: runtime entries were keyed by BARE agent id. Re-attribute
        // each bare entry to the project that CLAIMS the agent via its
        // persisted `lastAgentId` (plus the active session's own agent). On a
        // tie (same slug claimed by several projects) the ACTIVE project wins
        // and gets the ONLY copy — never duplicate an entry under two keys
        // (duplicated instance ids would defeat StageHost's outlet GC across
        // a project switch). Unclaimed entries are DROPPED, not orphaned: no
        // post-v2 reader can ever match a bare key, so keeping them is a
        // permanent localStorage leak.
        const p = (persistedState ?? {}) as Partial<{
          runtimeByAgentId: Record<string, AgentRuntime>;
          session: WorkspaceSession;
          projectStateById: Record<string, ProjectWorkspaceState>;
        }>;
        const session: WorkspaceSession = p.session ?? { projectId: null, agentId: null, workspaceView: 'default' };
        const projectStateById = p.projectStateById ?? {};
        const runtimeByAgentId: Record<string, AgentRuntime> = {};
        const activeProjectId = session.projectId;
        if (p.runtimeByAgentId && activeProjectId) {
          const claims = new Map<string, string[]>();
          for (const [pid, st] of Object.entries(projectStateById)) {
            if (st?.lastAgentId) {
              const arr = claims.get(st.lastAgentId) ?? [];
              if (!arr.includes(pid)) arr.push(pid);
              claims.set(st.lastAgentId, arr);
            }
          }
          if (session.agentId) {
            const arr = claims.get(session.agentId) ?? [];
            if (!arr.includes(activeProjectId)) arr.push(activeProjectId);
            claims.set(session.agentId, arr);
          }
          for (const [bareId, runtime] of Object.entries(p.runtimeByAgentId)) {
            if (bareId.includes(':')) {
              // Already composite (defensive — should not occur in a v1 payload).
              runtimeByAgentId[bareId] = runtime;
              continue;
            }
            const claimants = claims.get(bareId) ?? [];
            const target = claimants.length === 0
              ? null
              : claimants.includes(activeProjectId)
                ? activeProjectId
                : claimants[0];
            if (target) runtimeByAgentId[agentRuntimeKey(target, bareId)] = runtime;
          }
        }
        return { runtimeByAgentId, session, projectStateById };
      },
      // workspaceView is transient (the 'agent_create' view must not survive a
      // refresh) — force it to 'default'; with no agent the workspace renders
      // the empty-state slot anyway.
      partialize: (state) => ({
        runtimeByAgentId: stripWidgetNavs(state.runtimeByAgentId),
        session: { ...state.session, workspaceView: 'default' as const },
        projectStateById: state.projectStateById,
      }),
    },
  ),
);
