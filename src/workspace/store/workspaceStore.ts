'use client';

import { create } from 'zustand';
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware';
import type { ProjectRecord } from '@/api/projects';
import type { WorkspaceAgentRecord } from '@neuralis/package-system/contracts';
import { listProjects as apiListProjects } from '@/api/projects';
import { listAgents as apiListAgents } from '@/api/agents';
import { setProjectIdProvider } from '@/api/http';
import { emitClientStateReset } from './clientResetBus';
import type { WorkspaceOpenTarget } from '@neuralis/package-system/contracts';
import type { AgentRuntime, CanvasView, DockPrefs, EntityState, FreeformGeometry, GeometrySlot, GroupScopeState, TiledLayoutState, ProjectWorkspaceState, RuntimeLocator, StageMode, TransparencyLevel, WidgetInstance, WorkspaceGroup, WorkspacePresentation, WorkspaceSession } from './types';
import { getWidgetDefinition, isRepeatableWidget, listDefaultOpenWidgets } from '../widgets/registry';
import type { DockId } from '../shell/dockPlacement';
import { normalizeDockPrefs } from '../shell/dockOrder';

const MAX_WIDGETS = 6;
/** Runtimes kept mounted (hidden) after a presentation / Group switch. */
const MAX_RETAINED_RUNTIMES = 6;
const MAX_GROUPS = 24;
const MAX_GROUP_NAME = 40;
export const DEFAULT_GROUP_NAME = 'Main';

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

function initialState(): Pick<WorkspaceStore, 'session' | 'projects' | 'agents' | 'runtimeByAgentId' | 'phoneForegroundByRuntimeKey' | 'canvasReveal' | 'manualModeByRuntimeKey' | 'retainedRuntimeKeys' | 'focusOrderByRuntimeKey'> {
  return {
    session: { projectId: null, agentId: null, workspaceView: 'default' },
    projects: emptyEntity<ProjectRecord>(),
    agents: emptyEntity<WorkspaceAgentRecord>(),
    runtimeByAgentId: {},
    phoneForegroundByRuntimeKey: {},
    manualModeByRuntimeKey: {},
    canvasReveal: null,
    retainedRuntimeKeys: [],
    focusOrderByRuntimeKey: {},
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

/** The key of one user's Group records in one project (`groupStateByScope`). */
export function groupScopeKey(userId: string, projectId: string): string {
  return `${encodeURIComponent(userId)}@${projectId}`;
}

/**
 * The ONE runtime-key composer for both locator kinds. A per-agent key is
 * `agentRuntimeKey` unchanged; a Group key lives under the same `${projectId}:`
 * prefix (so a project clean and the per-project broom predicate cover it) and
 * carries a `/`, which no agent slug can contain.
 */
export function runtimeKeyOf(locator: RuntimeLocator): string {
  return locator.kind === 'agent'
    ? agentRuntimeKey(locator.projectId, locator.agentId)
    : `${locator.projectId}:group/${encodeURIComponent(locator.userId)}/${locator.groupId}`;
}

export function isGroupRuntimeKey(runtimeKey: string): boolean {
  return runtimeKey.includes(':group/');
}

/** The agent a window runs as: its own binding, else its per-agent runtime's agent. */
export function boundAgentOf(runtimeKey: string, instance: Pick<WidgetInstance, 'agentId'>): string | null {
  if (instance.agentId) return instance.agentId;
  if (isGroupRuntimeKey(runtimeKey)) return null;
  const i = runtimeKey.indexOf(':');
  return i > 0 ? runtimeKey.slice(i + 1) : null;
}

/** The signed-in user's Group state in the active project, or null. */
export function activeGroupScope(s: Pick<WorkspaceStore, 'liveUserId' | 'session' | 'groupStateByScope'>): GroupScopeState | null {
  const { projectId } = s.session;
  if (!s.liveUserId || !projectId) return null;
  return s.groupStateByScope[groupScopeKey(s.liveUserId, projectId)] ?? null;
}

/** The selected Group when the Group presentation is on and that Group exists. */
export function activeGroup(s: Pick<WorkspaceStore, 'liveUserId' | 'session' | 'groupStateByScope'>): WorkspaceGroup | null {
  const scope = activeGroupScope(s);
  if (!scope || scope.presentation !== 'group' || !scope.selectedGroupId) return null;
  return scope.groups.find((g) => g.id === scope.selectedGroupId) ?? null;
}

/** Where the stage's layout lives right now. */
export function activeLocator(s: Pick<WorkspaceStore, 'liveUserId' | 'session' | 'groupStateByScope'>): RuntimeLocator | null {
  const { projectId, agentId } = s.session;
  if (!projectId) return null;
  const group = activeGroup(s);
  if (group && s.liveUserId) return { kind: 'group', userId: s.liveUserId, projectId, groupId: group.id };
  return agentId ? { kind: 'agent', projectId, agentId } : null;
}

export function activeRuntimeKeyOf(s: Pick<WorkspaceStore, 'liveUserId' | 'session' | 'groupStateByScope'>): string | null {
  const locator = activeLocator(s);
  return locator ? runtimeKeyOf(locator) : null;
}

/**
 * The agent a NEW window binds to: the selected agent; in a Group, the selected
 * agent only while it is a member, else the first authorized member. Null ⇒
 * nothing can be opened (an empty Group never manufactures an identity).
 */
export function newWindowAgentOf(s: Pick<WorkspaceStore, 'liveUserId' | 'session' | 'groupStateByScope' | 'agents'>): string | null {
  const group = activeGroup(s);
  if (!group) return s.session.agentId;
  const members = group.memberIds.filter((id) => s.agents.byId[id]);
  if (s.session.agentId && members.includes(s.session.agentId)) return s.session.agentId;
  return members[0] ?? null;
}

/**
 * Fresh access before persisted window metadata: in a Group runtime a window is
 * shown only while its bound agent is in the project's freshly fetched,
 * authorized agent list. Returns the SAME array when nothing is withheld, so a
 * selector's identity stays stable; a filtered result is memoized per input.
 */
const authorizedOrderMemo = new WeakMap<string[], { byId: Record<string, unknown>; agents: Record<string, unknown>; status: string; out: string[] }>();
export function authorizedWindowOrder(
  runtimeKey: string | null,
  openOrder: string[],
  byId: Record<string, WidgetInstance>,
  agents: EntityState<WorkspaceAgentRecord>,
): string[] {
  if (!runtimeKey || !isGroupRuntimeKey(runtimeKey) || openOrder.length === 0) return openOrder;
  const cached = authorizedOrderMemo.get(openOrder);
  if (cached && cached.byId === byId && cached.agents === agents.byId && cached.status === agents.status) return cached.out;
  const ok = agents.status === 'success';
  const filtered = openOrder.filter((id) => {
    const bound = byId[id]?.agentId;
    return ok && Boolean(bound && agents.byId[bound]);
  });
  const out = filtered.length === openOrder.length ? openOrder : filtered;
  authorizedOrderMemo.set(openOrder, { byId, agents: agents.byId, status: agents.status, out });
  return out;
}

/** A fresh Group id (never derived from a name or an agent). */
export function newGroupId(): string {
  return generateId('g');
}

function sanitizeGroupName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_GROUP_NAME);
}

function parseGroupScope(raw: unknown): GroupScopeState | null {
  if (!isRecord(raw)) return null;
  const groups: WorkspaceGroup[] = [];
  for (const g of Array.isArray(raw.groups) ? raw.groups : []) {
    if (!isRecord(g) || typeof g.id !== 'string' || !g.id || typeof g.name !== 'string') continue;
    if (groups.some((x) => x.id === g.id)) continue;
    const memberIds = Array.isArray(g.memberIds) ? [...new Set(g.memberIds.filter((m): m is string => typeof m === 'string' && m.length > 0))] : [];
    groups.push({ id: g.id, name: sanitizeGroupName(g.name) || DEFAULT_GROUP_NAME, memberIds });
    if (groups.length >= MAX_GROUPS) break;
  }
  const selected = typeof raw.selectedGroupId === 'string' && groups.some((g) => g.id === raw.selectedGroupId) ? raw.selectedGroupId : groups[0]?.id ?? null;
  return { presentation: raw.presentation === 'group' && selected ? 'group' : 'agent', selectedGroupId: selected, groups };
}

/** The stage modes a layout saves (Phone is a presentation, never saved). */
export const SAVED_STAGE_MODES = ['tiled', 'canvas', 'grid'] as const satisfies readonly Exclude<StageMode, 'phone'>[];

/** One action-time and render-time stage resolver; responsiveness never rewrites saved geometry. */
export function effectiveStageMode(s: WorkspaceStore, runtimeKey: string | null): StageMode {
  if (!runtimeKey) return 'tiled';
  return s.manualModeByRuntimeKey[runtimeKey]
    ?? (s.autoPhoneEnabled && s.phoneAutoEligible ? 'phone' : s.runtimeByAgentId[runtimeKey]?.layout.stageMode ?? 'tiled');
}

/** Layout viewport and device capability only: keyboard and pinch are not mode changes. */
export function phoneDeviceEligible(width: number, coarse: boolean, screenWidth: number, screenHeight: number): boolean {
  return width <= 600 || (coarse && Math.min(screenWidth, screenHeight) <= 600);
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
  /** Phone focus is transient; authored desktop geometry is never rewritten. */
  phoneForegroundByRuntimeKey: Record<string, string>;
  manualModeByRuntimeKey: Record<string, StageMode>;
  phoneAutoEligible: boolean;
  autoPhoneEnabled: boolean;
  setResponsivePhone: (eligible: boolean, enabled: boolean) => void;
  clearManualStageMode: () => void;
  /** One-shot Canvas focus, scoped and excluded from persisted layout. */
  canvasReveal: { runtimeKey: string; widgetInstanceId: string } | null;
  clearCanvasReveal: (intent: NonNullable<WorkspaceStore['canvasReveal']>) => void;
  focusWidget: (params: { agentId: string; widgetInstanceId: string }) => void;

  /**
   * The signed-in user (next-auth), set by `WorkspaceRoot`. TRANSIENT: Group
   * records are read only under this LIVE id, so another user signing in on the
   * same browser never paints the previous user's Groups.
   */
  liveUserId: string | null;
  setLiveUserId: (userId: string | null) => void;
  /** Per user+project Group records (`groupScopeKey`). Persisted. */
  groupStateByScope: Record<string, GroupScopeState>;
  /** Per-agent layouts or the selected Group's shared layout (active project). */
  setPresentation: (presentation: WorkspacePresentation) => void;
  selectGroup: (groupId: string) => void;
  /** Layout → Edit docks Save: the whole Group list of the active project, once. */
  saveGroups: (params: { groups: WorkspaceGroup[]; selectedGroupId: string | null; dock?: { dockId: DockId; prefs: DockPrefs } }) => void;
  /**
   * Runtimes kept MOUNTED (hidden) after a presentation/Group switch, so going
   * back re-shows the same live windows. Transient; cleared on a project or
   * user change and by the brooms.
   */
  retainedRuntimeKeys: string[];
  /** Most-recently-focused window ids per runtime (transient). */
  focusOrderByRuntimeKey: Record<string, string[]>;
  /** "Clean window": reset ONE window's package view state; the window stays. */
  cleanWindow: (params: { widgetInstanceId: string }) => void;
  /**
   * Bumped by every coordinated layout commit (Randomize / Undo) and by a
   * manual gesture that will write layout LATER (a canvas pan/zoom): a delayed
   * writer captured under an older epoch drops its write, and an Undo taken
   * before a newer intent is refused. Transient.
   */
  layoutEpoch: number;
  noteLayoutIntent: () => void;

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

  openWidget: (params: { agentId: string; type: string; title: string; icon?: string; initialState?: Record<string, unknown>; target?: WorkspaceOpenTarget }) => string | null;
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
type PersistedWorkspaceState = Pick<WorkspaceStore, 'runtimeByAgentId' | 'session' | 'projectStateById' | 'groupStateByScope'>;

const isRecord = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/**
 * The persisted-state reader, field by field: an unreadable runtime, widget or
 * project entry is dropped ALONE (a dropped runtime re-seeds the next time its
 * agent is active) and the rest of the user's layout survives. It never
 * translates an old shape — a record it cannot read is simply not kept.
 */
export function parsePersistedWorkspace(raw: unknown): PersistedWorkspaceState {
  const p = isRecord(raw) ? raw : {};
  const s = isRecord(p.session) ? p.session : {};
  const session: WorkspaceSession = {
    projectId: typeof s.projectId === 'string' ? s.projectId : null,
    agentId: typeof s.agentId === 'string' ? s.agentId : null,
    workspaceView: 'default',
  };
  const runtimeByAgentId: Record<string, AgentRuntime> = {};
  for (const [key, value] of Object.entries(isRecord(p.runtimeByAgentId) ? p.runtimeByAgentId : {})) {
    if (!isRecord(value) || !isRecord(value.widgets) || !isRecord(value.layout) || !Array.isArray(value.widgets.openOrder) || !isRecord(value.widgets.byId)) continue;
    const byId: Record<string, WidgetInstance> = {};
    for (const [id, inst] of Object.entries(value.widgets.byId)) {
      if (isRecord(inst) && inst.id === id && typeof inst.type === 'string') byId[id] = { ...inst, state: isRecord(inst.state) ? inst.state : {} } as WidgetInstance;
    }
    const openOrder = value.widgets.openOrder.filter((id): id is string => typeof id === 'string' && id in byId);
    runtimeByAgentId[key] = { ...(value as AgentRuntime), widgets: { openOrder, byId } };
  }
  const projectStateById: Record<string, ProjectWorkspaceState> = {};
  for (const [id, value] of Object.entries(isRecord(p.projectStateById) ? p.projectStateById : {})) {
    if (!isRecord(value)) continue;
    projectStateById[id] = { ...value, lastAgentId: typeof value.lastAgentId === 'string' ? value.lastAgentId : null } as ProjectWorkspaceState;
  }
  const groupStateByScope: Record<string, GroupScopeState> = {};
  for (const [key, value] of Object.entries(isRecord(p.groupStateByScope) ? p.groupStateByScope : {})) {
    const scope = parseGroupScope(value);
    if (scope) groupStateByScope[key] = scope;
  }
  return { runtimeByAgentId, session, projectStateById, groupStateByScope };
}

function ensureGroupRuntime(runtimeByAgentId: Record<string, AgentRuntime>, runtimeKey: string): Record<string, AgentRuntime> {
  if (runtimeByAgentId[runtimeKey]) return runtimeByAgentId;
  return {
    ...runtimeByAgentId,
    [runtimeKey]: { widgets: { openOrder: [], byId: {} }, layout: { widgetSplitsById: {} } },
  };
}

/** Seed a runtime by kind: an agent runtime opens its defaults, a Group runtime starts empty. */
function ensureRuntimeFor(runtimeByAgentId: Record<string, AgentRuntime>, runtimeKey: string): Record<string, AgentRuntime> {
  return isGroupRuntimeKey(runtimeKey) ? ensureGroupRuntime(runtimeByAgentId, runtimeKey) : ensureRuntime(runtimeByAgentId, runtimeKey);
}

/**
 * The runtime map with the layout the stage will show for (project, agent)
 * seeded: the selected Group's runtime while the Group presentation is on for
 * that project, else the agent's own runtime (with its default-open windows).
 */
function seedActiveRuntime(s: WorkspaceStore, projectId: string, agentId: string | null): Record<string, AgentRuntime> {
  const key = activeRuntimeKeyOf({ ...s, session: { ...s.session, projectId, agentId } });
  return key ? ensureRuntimeFor(s.runtimeByAgentId, key) : s.runtimeByAgentId;
}

/** Move `id` to the front of a most-recently-focused list (bounded by the live ids). */
function touchFocus(order: string[] | undefined, id: string): string[] {
  const rest = (order ?? []).filter((x) => x !== id);
  return [id, ...rest].slice(0, 32);
}

function retainKey(retained: string[], key: string | null, activeKey: string | null): string[] {
  const rest = retained.filter((k) => k !== key && k !== activeKey);
  return key && key !== activeKey ? [key, ...rest].slice(0, MAX_RETAINED_RUNTIMES) : rest;
}

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

/**
 * The default-open widgets in the order an agent tap opens them: the chat slot
 * LAST, so the agent's chat is the focused window (the Phone foreground) even
 * when another package declares a default-open widget too.
 */
export function agentTapOpenOrder(): ReturnType<typeof listDefaultOpenWidgets> {
  const chatType = getDefaultChatWidgetType();
  const defaults = listDefaultOpenWidgets();
  return [...defaults.filter((d) => d.type !== chatType), ...defaults.filter((d) => d.type === chatType)];
}

/**
 * The store patch of a coordinated layout commit (Randomize / Undo) — pure, so
 * the caller can serialize the EXACT bytes persist will produce before it
 * publishes. The presentation is chosen first (the arriving runtime is ensured
 * and the departing one retained mounted, as a manual switch does); layouts are
 * replaced only on runtimes that exist, and geometry only for their live
 * windows; no window, binding, state or Group membership is touched.
 */
export function composeLayoutCommit(
  s: WorkspaceStore,
  next: { groupStateByScope: Record<string, GroupScopeState>; layoutByKey: Record<string, TiledLayoutState>; clearManual: string[]; dropEmpty?: string[] },
): Pick<WorkspaceStore, 'groupStateByScope' | 'runtimeByAgentId' | 'manualModeByRuntimeKey' | 'canvasReveal' | 'retainedRuntimeKeys' | 'layoutEpoch'> {
  const before = activeRuntimeKeyOf(s);
  const after = activeRuntimeKeyOf({ ...s, groupStateByScope: next.groupStateByScope });
  let runtimeByAgentId = after ? ensureRuntimeFor(s.runtimeByAgentId, after) : s.runtimeByAgentId;
  for (const [key, layout] of Object.entries(next.layoutByKey)) {
    const rt = runtimeByAgentId[key];
    if (!rt) continue;
    const live = new Set(rt.widgets.openOrder);
    const keep = <V,>(map: Record<string, V> | undefined): Record<string, V> | undefined =>
      map ? Object.fromEntries(Object.entries(map).filter(([id]) => live.has(id))) : undefined;
    if (runtimeByAgentId === s.runtimeByAgentId) runtimeByAgentId = { ...runtimeByAgentId };
    runtimeByAgentId[key] = {
      ...rt,
      layout: { ...layout, widgetSplitsById: keep(layout.widgetSplitsById), freeformById: keep(layout.freeformById), gridById: keep(layout.gridById) },
    };
  }
  // An Undo removes a runtime the commit itself created, while it is still empty.
  for (const key of next.dropEmpty ?? []) {
    if (key === after || runtimeByAgentId[key]?.widgets.openOrder.length !== 0) continue;
    if (runtimeByAgentId === s.runtimeByAgentId) runtimeByAgentId = { ...runtimeByAgentId };
    delete runtimeByAgentId[key];
  }
  const manualModeByRuntimeKey = { ...s.manualModeByRuntimeKey };
  for (const key of next.clearManual) delete manualModeByRuntimeKey[key];
  return {
    groupStateByScope: next.groupStateByScope,
    runtimeByAgentId,
    manualModeByRuntimeKey,
    canvasReveal: null,
    retainedRuntimeKeys: retainKey(s.retainedRuntimeKeys, before, after).filter((k) => runtimeByAgentId[k]),
    layoutEpoch: s.layoutEpoch + 1,
  };
}

/** What persists of the store (the `partialize` of `neuralis:workspace:runtime`). */
function partializeWorkspace(state: WorkspaceStore): PersistedWorkspaceState {
  return {
    runtimeByAgentId: stripWidgetNavs(state.runtimeByAgentId),
    session: { ...state.session, workspaceView: 'default' as const },
    projectStateById: state.projectStateById,
    groupStateByScope: state.groupStateByScope,
  };
}

export const WORKSPACE_PERSIST_KEY = 'neuralis:workspace:runtime';
const WORKSPACE_PERSIST_VERSION = 2;

/**
 * The persist storage adapter. persist re-serializes the partialized state on
 * EVERY `set()`, also when only a non-persisted field changed (dock editing,
 * the Phone foreground, a canvas reveal); the adapter skips a write whose
 * bytes equal the last ones read or written. A write-elision only: what
 * persists is decided by `partialize` alone. Server-safe: a noop on SSR.
 */
const persistAdapter: StateStorage & { last: string | null } = {
  last: null,
  getItem(key) {
    if (typeof window === 'undefined') return NOOP_STORAGE.getItem(key);
    persistAdapter.last = window.localStorage.getItem(key);
    return persistAdapter.last;
  },
  setItem(key, value) {
    if (typeof window === 'undefined' || value === persistAdapter.last) return;
    window.localStorage.setItem(key, value);
    persistAdapter.last = value;
  },
  removeItem(key) { persistAdapter.last = null; if (typeof window !== 'undefined') window.localStorage.removeItem(key); },
};

/** The exact bytes persist writes for `state` (the coordinated layout commit pre-computes them). */
export function serializeWorkspace(state: WorkspaceStore): string {
  return JSON.stringify({ state: partializeWorkspace(state), version: WORKSPACE_PERSIST_VERSION });
}

/**
 * A STRICT write of the persisted workspace through the adapter: it throws on a
 * storage failure (the caller rolls back) and records the bytes, so the next
 * persist `set()` of the same state is elided — never a duplicate write.
 * `null` removes the key (restoring a previously absent value).
 */
export function writeWorkspaceBytes(bytes: string | null): void {
  if (typeof window === 'undefined') return;
  if (bytes === null) window.localStorage.removeItem(WORKSPACE_PERSIST_KEY);
  else window.localStorage.setItem(WORKSPACE_PERSIST_KEY, bytes);
  persistAdapter.last = bytes;
}

export const useWorkspaceStore = create<WorkspaceStore>()(
  persist(
    (set, get) => {
  // Register projectId provider so all fetch calls include the x-project-id header
  setProjectIdProvider(() => get().session.projectId);

  // The (project, agent) key of the per-agent runtime — file marks and the
  // agent broom are per-agent whatever the presentation.
  const agentKey = (agentId: string): string | null => {
    const projectId = get().session.projectId;
    return projectId ? agentRuntimeKey(projectId, agentId) : null;
  };

  // The runtime a stage action targets: the selected Group's shared runtime
  // while the Group presentation is on, else the agent's own runtime.
  const activeKey = (agentId: string): string | null => {
    const s = get();
    if (activeGroup(s)) return activeRuntimeKeyOf(s);
    return agentKey(agentId);
  };

  // A window-addressed action finds the runtime that HOLDS the window — the
  // active one, else a retained (hidden) one; window ids are unique.
  const keyOfWindow = (agentId: string, widgetInstanceId: string): string | null => {
    const s = get();
    const active = activeKey(agentId);
    if (active && s.runtimeByAgentId[active]?.widgets.byId[widgetInstanceId]) return active;
    for (const key of s.retainedRuntimeKeys) {
      if (s.runtimeByAgentId[key]?.widgets.byId[widgetInstanceId]) return key;
    }
    return active;
  };

  // The departing runtime stays mounted (hidden) across a presentation/Group
  // switch; the arriving one is ensured in the SAME set().
  const switchRuntime = (patch: (s: WorkspaceStore) => Partial<WorkspaceStore>): void => {
    set((s) => {
      const before = activeRuntimeKeyOf(s);
      const p = patch(s);
      const next = { ...s, ...p } as WorkspaceStore;
      const after = activeRuntimeKeyOf(next);
      const runtimeByAgentId = after ? ensureRuntimeFor(next.runtimeByAgentId, after) : next.runtimeByAgentId;
      const retainedRuntimeKeys = retainKey(s.retainedRuntimeKeys, before, after).filter((k) => runtimeByAgentId[k]);
      return { ...p, runtimeByAgentId, canvasReveal: null, retainedRuntimeKeys };
    });
  };

  return ({
  ...initialState(),
  phoneAutoEligible: false,
  autoPhoneEnabled: true,
  projectStateById: {},
  groupStateByScope: {},
  liveUserId: null,
  layoutEpoch: 0,
  fileMarksByAgentId: {},

  noteLayoutIntent() {
    set((s) => ({ layoutEpoch: s.layoutEpoch + 1 }));
  },
  dockEditing: { primary: false, secondary: false },

  setLiveUserId(userId) {
    if (get().liveUserId === userId) return;
    // Another user's Group outlets must never stay mounted: the retained set
    // is dropped, so StageHost unmounts them before the new user paints.
    set({ liveUserId: userId, retainedRuntimeKeys: [], canvasReveal: null });
    const key = activeRuntimeKeyOf(get());
    if (key && !get().runtimeByAgentId[key]) set((s) => ({ runtimeByAgentId: ensureRuntimeFor(s.runtimeByAgentId, key) }));
  },

  setPresentation(presentation) {
    const s = get();
    const { projectId } = s.session;
    if (!s.liveUserId || !projectId) return;
    const scopeKey = groupScopeKey(s.liveUserId, projectId);
    const scope = s.groupStateByScope[scopeKey];
    if (presentation === 'agent') {
      if (!scope || scope.presentation === 'agent') return;
      switchRuntime((st) => ({ groupStateByScope: { ...st.groupStateByScope, [scopeKey]: { ...scope, presentation: 'agent' } } }));
      return;
    }
    if (scope?.presentation === 'group' && scope.selectedGroupId) return;
    // The first Group is created only from the fetched, authorized agent list
    // under the LIVE user — never from a synthetic identity.
    if (!scope?.groups.length && s.agents.status !== 'success') return;
    const groups = scope?.groups.length ? scope.groups : [{ id: generateId('g'), name: DEFAULT_GROUP_NAME, memberIds: [...s.agents.ids] }];
    const selectedGroupId = scope?.selectedGroupId && groups.some((g) => g.id === scope.selectedGroupId) ? scope.selectedGroupId : groups[0].id;
    switchRuntime((st) => ({ groupStateByScope: { ...st.groupStateByScope, [scopeKey]: { presentation: 'group', selectedGroupId, groups } } }));
  },

  selectGroup(groupId) {
    const s = get();
    const { projectId } = s.session;
    if (!s.liveUserId || !projectId) return;
    const scopeKey = groupScopeKey(s.liveUserId, projectId);
    const scope = s.groupStateByScope[scopeKey];
    if (!scope?.groups.some((g) => g.id === groupId)) return;
    if (scope.presentation === 'group' && scope.selectedGroupId === groupId) return;
    switchRuntime((st) => ({ groupStateByScope: { ...st.groupStateByScope, [scopeKey]: { ...scope, presentation: 'group', selectedGroupId: groupId } } }));
  },

  saveGroups({ groups, selectedGroupId, dock }) {
    const s = get();
    const { projectId } = s.session;
    if (!s.liveUserId || !projectId) return;
    const scopeKey = groupScopeKey(s.liveUserId, projectId);
    const prev = s.groupStateByScope[scopeKey];
    const clean = parseGroupScope({ presentation: prev?.presentation ?? 'agent', selectedGroupId, groups: groups.map((g) => ({ ...g, name: sanitizeGroupName(g.name) })) });
    if (!clean) return;
    // A removed Group's OWN layout goes with it (the user confirmed); every
    // other Group and every per-agent layout stays untouched.
    const removed = (prev?.groups ?? []).filter((g) => !clean.groups.some((x) => x.id === g.id));
    switchRuntime((st) => {
      const runtimeByAgentId = { ...st.runtimeByAgentId };
      for (const g of removed) delete runtimeByAgentId[runtimeKeyOf({ kind: 'group', userId: st.liveUserId as string, projectId, groupId: g.id })];
      // The agent dock's arrangement saved by the same Save lands in the same set().
      const entry = st.projectStateById[projectId] ?? { lastAgentId: st.session.agentId };
      const projectStateById = dock
        ? { ...st.projectStateById, [projectId]: { ...entry, dock: { ...entry.dock, [dock.dockId]: normalizeDockPrefs(dock.prefs) } } }
        : st.projectStateById;
      return {
        runtimeByAgentId,
        projectStateById,
        groupStateByScope: { ...st.groupStateByScope, [scopeKey]: { ...clean, presentation: clean.groups.length ? clean.presentation : 'agent' } },
        dockEditing: { ...st.dockEditing, [dock?.dockId ?? 'secondary']: false },
      };
    });
  },

  cleanWindow({ widgetInstanceId }) {
    const s = get();
    const projectId = s.session.projectId;
    if (!projectId) return;
    for (const key of [activeRuntimeKeyOf(s), ...s.retainedRuntimeKeys]) {
      const inst = key ? s.runtimeByAgentId[key]?.widgets.byId[widgetInstanceId] : undefined;
      if (!key || !inst) continue;
      const agentId = boundAgentOf(key, inst);
      if (agentId) emitClientStateReset({ level: 'instance', projectId, agentId, widgetType: inst.type, instanceId: widgetInstanceId });
      return;
    }
  },

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
        dockEditing: { ...s.dockEditing, [dockId]: false },
      };
    });
  },

  markFile({ agentId, path, kind }) {
    if (!agentId || !path) return;
    const rk = agentKey(agentId);
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
    const rk = agentKey(agentId);
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
    const rk = agentKey(agentId);
    if (!rk) return;
    set((s) => ({
      fileMarksByAgentId: { ...s.fileMarksByAgentId, [rk]: {} },
    }));
  },

  cleanAgentStore({ agentId }) {
    if (!agentId) return;
    const rk = agentKey(agentId);
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
        const phoneForegroundByRuntimeKey = { ...s.phoneForegroundByRuntimeKey }; delete phoneForegroundByRuntimeKey[rk];
        const manualModeByRuntimeKey = { ...s.manualModeByRuntimeKey }; delete manualModeByRuntimeKey[rk];
        const next = s.session.agentId === agentId && !activeGroup(s)
          ? ensureRuntime(runtimeByAgentId, rk)
          : runtimeByAgentId;
        return { runtimeByAgentId: next, fileMarksByAgentId, phoneForegroundByRuntimeKey, manualModeByRuntimeKey, retainedRuntimeKeys: s.retainedRuntimeKeys.filter((k) => k !== rk) };
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
      const phoneForegroundByRuntimeKey = { ...s.phoneForegroundByRuntimeKey };
      const manualModeByRuntimeKey = { ...s.manualModeByRuntimeKey };
      for (const id of bareIds) {
        delete runtimeByAgentId[agentRuntimeKey(projectId, id)];
        delete fileMarksByAgentId[agentRuntimeKey(projectId, id)];
        delete phoneForegroundByRuntimeKey[agentRuntimeKey(projectId, id)];
        delete manualModeByRuntimeKey[agentRuntimeKey(projectId, id)];
      }
      // Reseed only when cleaning the ACTIVE project (the stage renders it).
      // `projectStateById` is RETAINED — `lastAgentId` is switch memory, not
      // store; the broom predicate turns false via the deleted runtime keys.
      // A Group runtime lives under the same prefix, so it went with the
      // agents' runtimes; the ACTIVE layout (agent or Group) reseeds.
      const activeRuntime = isActive ? activeRuntimeKeyOf(s) : null;
      const next = activeRuntime ? ensureRuntimeFor(runtimeByAgentId, activeRuntime) : runtimeByAgentId;
      const retainedRuntimeKeys = s.retainedRuntimeKeys.filter((k) => !k.startsWith(prefix));
      return { runtimeByAgentId: next, fileMarksByAgentId, phoneForegroundByRuntimeKey, manualModeByRuntimeKey, retainedRuntimeKeys };
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
          const nextRuntime = seedActiveRuntime(s, currentProjectId, nextAgentId);
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
      canvasReveal: null,
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
      runtimeByAgentId: seedActiveRuntime(s, projectId, remembered),
      // A project switch is the existing destructive boundary: nothing of the
      // departing project stays mounted.
      retainedRuntimeKeys: [],
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
        const nextRuntime = seedActiveRuntime(s, projectId, agentId);
        return {
          agents: { byId, ids, status: 'success', error: null },
          canvasReveal: null,
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
    // In a Group the agent dock picks the agent for NEW windows only: the
    // shared layout stays, and no per-agent runtime is seeded behind it.
    set((s) => ({
      canvasReveal: activeGroup(s) ? s.canvasReveal : null,
      session: { ...s.session, agentId, workspaceView: 'default' },
      runtimeByAgentId: seedActiveRuntime(s, projectId, agentId),
      projectStateById: { ...s.projectStateById, [projectId]: { ...s.projectStateById[projectId], lastAgentId: agentId } },
    }));
  },

  setWorkspaceView(view) {
    set((s) => ({ session: { ...s.session, workspaceView: view } }));
  },

  focusWidget({ agentId, widgetInstanceId }) {
    const rk = keyOfWindow(agentId, widgetInstanceId);
    const rt = rk ? get().runtimeByAgentId[rk] : undefined;
    if (!rk || !rt?.widgets.byId[widgetInstanceId] || rt.widgets.byId[widgetInstanceId].hidden || !getWidgetDefinition(rt.widgets.byId[widgetInstanceId].type)) return;
    if (get().focusOrderByRuntimeKey[rk]?.[0] !== widgetInstanceId) {
      set((s) => ({ focusOrderByRuntimeKey: { ...s.focusOrderByRuntimeKey, [rk]: touchFocus(s.focusOrderByRuntimeKey[rk], widgetInstanceId) } }));
    }
    if (effectiveStageMode(get(), rk) === 'canvas') {
      set({ canvasReveal: { runtimeKey: rk, widgetInstanceId } });
      return;
    }
    if (effectiveStageMode(get(), rk) !== 'phone' || get().phoneForegroundByRuntimeKey[rk] === widgetInstanceId) return;
    set(s => ({ phoneForegroundByRuntimeKey: { ...s.phoneForegroundByRuntimeKey, [rk]: widgetInstanceId } }));
  },

  clearCanvasReveal(intent) {
    if (get().canvasReveal !== intent) return;
    set({ canvasReveal: null });
  },

  openWidget({ agentId, type, title, icon, initialState: init, target }) {
    if (!agentId) return null;
    const rk = activeKey(agentId);
    if (!rk) return null;
    // Ensure the runtime — and, for an agent runtime, its manifest `defaultOpen`
    // widgets (e.g. chat) — BEFORE the lookup. A never-visited agent's runtime
    // is seeded lazily; without ensuring first, opening a type that is ALSO a
    // default-open widget into a fresh runtime misses the about-to-be-seeded
    // default and creates a DUPLICATE (the cross-agent "Open in chat" → two
    // chat panels bug). ensureRuntimeFor returns the SAME ref for an existing
    // runtime, so this is a no-op (no extra render) in the common case.
    const ensured = ensureRuntimeFor(get().runtimeByAgentId, rk);
    if (ensured !== get().runtimeByAgentId) set({ runtimeByAgentId: ensured });
    const runtime = ensured[rk];
    const group = isGroupRuntimeKey(rk);
    // The windows of this type bound to this agent, most recently focused first.
    const focus = get().focusOrderByRuntimeKey[rk] ?? [];
    const matching = runtime.widgets.openOrder
      .filter((id) => runtime.widgets.byId[id]?.type === type && boundAgentOf(rk, runtime.widgets.byId[id]) === agentId)
      .sort((a, b) => {
        const fa = focus.indexOf(a); const fb = focus.indexOf(b);
        return (fa < 0 ? Infinity : fa) - (fb < 0 ? Infinity : fb);
      });
    const repeatable = isRepeatableWidget(type);
    const named = typeof target === 'object' && matching.includes(target.instanceId) ? target.instanceId : undefined;
    // A singleton type always reuses its window; a repeatable one reuses the
    // most recent window unless a NEW one is asked for explicitly.
    const existingId = named ?? (target === 'new' && repeatable ? undefined : matching[0]);
    if (existingId) {
      // Re-opening restores a minimized window (unhide) and merges any new init
      // state. The mounted-hidden instance becomes visible again with zero
      // restart.
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
      get().focusWidget({ agentId, widgetInstanceId: existingId });
      return existingId;
    }

    const widgetId = generateId('widget');
    // A Group window carries its bound agent; a per-agent window is bound by
    // its runtime (no field, records stay as they were).
    const instance: WidgetInstance = { id: widgetId, type, title, icon, createdAt: nowIso(), state: { ...(init || {}) }, ...(group ? { agentId } : {}) };

    set((s) => {
      const runtimeByAgentId = ensureRuntimeFor(s.runtimeByAgentId, rk);
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
    get().focusWidget({ agentId, widgetInstanceId: widgetId });
    return widgetId;
  },

  closeWidget({ agentId, widgetInstanceId }) {
    if (!agentId || !widgetInstanceId) return;
    const rk = keyOfWindow(agentId, widgetInstanceId);
    if (!rk) return;
    // The widget TYPE and bound agent are read BEFORE the delete — they are
    // what the reset scope carries, and after the set() the instance is gone.
    const projectId = get().session.projectId;
    const closing = get().runtimeByAgentId[rk]?.widgets.byId[widgetInstanceId];
    const widgetType = closing?.type;
    const boundAgent = closing ? boundAgentOf(rk, closing) : null;
    if (!projectId || !widgetType || !boundAgent) return;
    set((s) => {
      const rt = s.runtimeByAgentId[rk];
      if (!rt?.widgets.byId[widgetInstanceId]) return s;
      const openOrder = rt.widgets.openOrder.filter((id) => id !== widgetInstanceId);
      const byId = { ...rt.widgets.byId };
      delete byId[widgetInstanceId];
      const phoneForegroundByRuntimeKey = { ...s.phoneForegroundByRuntimeKey };
      if (phoneForegroundByRuntimeKey[rk] === widgetInstanceId) delete phoneForegroundByRuntimeKey[rk];
      const widgetSplitsById = { ...(rt.layout.widgetSplitsById || {}) };
      delete widgetSplitsById[widgetInstanceId];
      // Clean means clean: drop the instance's canvas/grid geometry too, so no
      // orphan entries survive in the persisted layout (they used to leak).
      const freeformById = { ...(rt.layout.freeformById || {}) };
      delete freeformById[widgetInstanceId];
      const gridById = { ...(rt.layout.gridById || {}) };
      delete gridById[widgetInstanceId];
      const focusOrderByRuntimeKey = s.focusOrderByRuntimeKey[rk]?.includes(widgetInstanceId)
        ? { ...s.focusOrderByRuntimeKey, [rk]: s.focusOrderByRuntimeKey[rk].filter((id) => id !== widgetInstanceId) }
        : s.focusOrderByRuntimeKey;
      return {
        phoneForegroundByRuntimeKey,
        focusOrderByRuntimeKey,
        canvasReveal: s.canvasReveal?.runtimeKey === rk && s.canvasReveal.widgetInstanceId === widgetInstanceId ? null : s.canvasReveal,
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
    // store for the (project, BOUND agent) pair and this window's view state —
    // emitted after the set() (port rule).
    emitClientStateReset({ level: 'widget', projectId, agentId: boundAgent, widgetType, instanceId: widgetInstanceId });
  },

  minimizeWidget({ agentId, widgetInstanceId }) {
    if (!agentId || !widgetInstanceId) return;
    const rk = keyOfWindow(agentId, widgetInstanceId);
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
        canvasReveal: s.canvasReveal?.runtimeKey === rk && s.canvasReveal.widgetInstanceId === widgetInstanceId ? null : s.canvasReveal,
        runtimeByAgentId: {
          ...s.runtimeByAgentId,
          [rk]: { ...rt, widgets: { ...rt.widgets, byId: { ...rt.widgets.byId, [widgetInstanceId]: { ...inst, hidden: true } } } },
        },
      };
    });
  },

  restoreWidget({ agentId, widgetInstanceId }) {
    if (!agentId || !widgetInstanceId) return;
    const rk = keyOfWindow(agentId, widgetInstanceId);
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
    get().focusWidget({ agentId, widgetInstanceId });
  },

  updateWidgetState({ agentId, widgetInstanceId, patch }) {
    if (!agentId || !widgetInstanceId) return;
    const rk = keyOfWindow(agentId, widgetInstanceId);
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
    const rk = keyOfWindow(agentId, widgetInstanceId);
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
      const chatWidgetId = rt.widgets.openOrder.find((id) => rt.widgets.byId[id]?.type === chatType && boundAgentOf(rk, rt.widgets.byId[id]) === agentId);
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
    const ensured = ensureRuntimeFor(get().runtimeByAgentId, rk);
    if (ensured !== get().runtimeByAgentId) set({ runtimeByAgentId: ensured });
    const widgetId = generateId('widget');
    const rt0 = ensured[rk];
    const existingId = rt0?.widgets.openOrder.find((id) => rt0.widgets.byId[id]?.type === type && boundAgentOf(rk, rt0.widgets.byId[id]) === agentId);
    const useId = existingId ?? widgetId;

    set((s) => {
      const runtimeByAgentId = ensureRuntimeFor(s.runtimeByAgentId, rk);
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
        const keepVisible = id === useId || (inst.type === chatType && boundAgentOf(rk, inst) === agentId);
        nextById[id] = keepVisible
          ? (inst.hidden ? { ...inst, hidden: false } : inst)
          : (inst.hidden ? inst : { ...inst, hidden: true });
      }
      if (!existingId) {
        nextById[widgetId] = { id: widgetId, type, title, icon, createdAt: nowIso(), state: {}, ...(isGroupRuntimeKey(rk) ? { agentId } : {}) };
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
    get().focusWidget({ agentId, widgetInstanceId: useId });
    return useId;
  },

  setResponsivePhone(eligible, enabled) {
    if (get().phoneAutoEligible === eligible && get().autoPhoneEnabled === enabled) return;
    set({ phoneAutoEligible: eligible, autoPhoneEnabled: enabled, canvasReveal: null });
  },

  clearManualStageMode() {
    const key = activeRuntimeKeyOf(get());
    if (!key || !get().manualModeByRuntimeKey[key]) return;
    set(s => { const next = { ...s.manualModeByRuntimeKey }; delete next[key]; return { manualModeByRuntimeKey: next, canvasReveal: null }; });
  },

  setStageMode({ agentId, mode }) {
    if (!agentId) return;
    const rk = activeKey(agentId);
    if (!rk) return;
    set((s) => {
      const runtimeByAgentId = ensureRuntimeFor(s.runtimeByAgentId, rk);
      const rt = runtimeByAgentId[rk];
      // Phone presents the saved layout and is never saved as its mode: a
      // manual Phone pick lives in the transient manual choice alone, so
      // "Auto" returns to the saved desktop mode.
      const layout = mode === 'phone' || rt.layout.stageMode === mode ? rt.layout : { ...rt.layout, stageMode: mode };
      if (layout === rt.layout && s.manualModeByRuntimeKey[rk] === mode && runtimeByAgentId === s.runtimeByAgentId) return s;
      return {
        canvasReveal: null,
        manualModeByRuntimeKey: { ...s.manualModeByRuntimeKey, [rk]: mode },
        runtimeByAgentId: layout === rt.layout ? runtimeByAgentId : { ...runtimeByAgentId, [rk]: { ...rt, layout } },
      };
    });
  },

  setWidgetGeometry({ agentId, widgetInstanceId, slot, geometry }) {
    if (!agentId || !widgetInstanceId) return;
    const rk = keyOfWindow(agentId, widgetInstanceId);
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
    const rk = keyOfWindow(agentId, widgetInstanceId);
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
      name: WORKSPACE_PERSIST_KEY,
      // The adapter (`persistAdapter` above) is server-safe and elides
      // identical writes; persist hydrates from localStorage after mount.
      storage: createJSONStorage<PersistedWorkspaceState>(() => persistAdapter),
      // v2 (2026-08-14): runtime/file-mark keys became composite
      // `<projectId>:<agentId>`. NEVER bump this version without a real
      // `migrate` — zustand drops the whole persisted payload on a version
      // mismatch with no migrate, erasing every user's layout and session.
      version: WORKSPACE_PERSIST_VERSION,
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
        return { runtimeByAgentId, session, projectStateById, groupStateByScope: {} };
      },
      // workspaceView is transient (the 'agent_create' view must not survive a
      // refresh) — force it to 'default'; with no agent the workspace renders
      // the empty-state slot anyway.
      merge: (persisted, current) => ({ ...current, ...parsePersistedWorkspace(persisted) }),
      partialize: partializeWorkspace,
    },
  ),
);
