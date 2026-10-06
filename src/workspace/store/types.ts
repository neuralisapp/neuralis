export type LoadStatus = 'idle' | 'loading' | 'success' | 'error';

export type EntityState<T> = {
  byId: Record<string, T>;
  ids: string[];
  status: LoadStatus;
  error: string | null;
};

export type WorkspaceSession = {
  projectId: string | null;
  agentId: string | null;
  workspaceView: 'default' | 'agent_create';
};

/**
 * Per-project workspace memory (the "switch store"). `lastAgentId` is the agent
 * the user last had selected in that project: `selectProject` reads it to paint
 * the remembered agent's persisted layout IMMEDIATELY (no `agentId: null`
 * window, no agent-create wizard flash) while the agent list re-fetches in the
 * background and only corrects. Persisted via the store's `partialize`;
 * initialized at store CREATION (deliberately not in `initialState()`) so
 * `reset()`/`reload()` — which fire on every agent create — cannot wipe it.
 *
 * `dock` is the user's dock arrangement in this project (Layout → Edit docks):
 * per dock, the item ORDER and the HIDDEN set, by dock-item key
 * (`<packageId>:<dockId>` for a package item, `agent:<id>` for an agent). A
 * field added without a persist version bump — absent means the default order.
 * Every writer of an entry SPREADS it, so `lastAgentId` writes keep `dock`.
 */
export type ProjectWorkspaceState = { lastAgentId: string | null; dock?: DockPrefsById };

/** One dock's arrangement: keys in display order, and the keys it hides. */
export type DockPrefs = { order: string[]; hidden: string[] };

export type DockPrefsById = { primary?: DockPrefs; secondary?: DockPrefs };

/**
 * Which stage renders the widgets. `tiled` (default) = the resizable
 * `PanelGroup`; `canvas` = free-floating windows (drag + resize + z-order);
 * `grid` = the same free-floating windows but drag/resize snap to a coarse
 * grid. Per-agent (lives on `AgentRuntime.layout`), persisted via the store's
 * `partialize`.
 */
export type StageMode = 'tiled' | 'canvas' | 'grid';

/**
 * Free-floating geometry for a widget in `canvas` / `grid` stage modes.
 * `x`/`y`/`w`/`h` in px (in canvas WORLD space for `canvas`, container space
 * for `grid`); `z` is the paint order (higher = on top). Absent in `tiled`
 * mode (splits are used instead).
 */
export type FreeformGeometry = { x: number; y: number; w: number; h: number; z: number };

/** Canvas pan/zoom viewport. `x`/`y` = world-origin offset (px), `zoom` = scale. */
export type CanvasView = { x: number; y: number; zoom: number };

/** Which free-floating geometry map a stage owns. */
export type GeometrySlot = 'canvas' | 'grid';

export type TiledLayoutState = {
  /** Split ratio between the main pane and the chat dock. Actively read by
   *  `workspaceStore.ts` + `selectors.ts` (not deprecated). */
  mainSplit?: [number, number];
  /** Whether the chat dock is collapsed. Actively read by `DockRight.tsx`,
   *  `useDockItems.tsx`, `selectors.ts` (not deprecated). */
  chatCollapsed?: boolean;
  widgetSplitsById?: Record<string, number>;
  /** Active stage renderer. Defaults to `'tiled'` when absent. */
  stageMode?: StageMode;
  /** Per-widget geometry for `canvas` mode (free-floating, world space). */
  freeformById?: Record<string, FreeformGeometry>;
  /** Per-widget geometry for `grid` mode (packed, snapped, container space).
   *  Kept SEPARATE from canvas so each mode remembers its own arrangement. */
  gridById?: Record<string, FreeformGeometry>;
  /** Canvas pan/zoom. Defaults to `{ x:0, y:0, zoom:1 }`. */
  canvasView?: CanvasView;
};

export type TransparencyLevel = 'opaque' | 'dim' | 'transparent';

export type WidgetInstance = {
  id: string;
  type: string;
  title: string;
  icon?: string;
  createdAt: string;
  state: Record<string, unknown>;
  /**
   * User-controlled transparency override for this widget instance. When
   * undefined, the manifest baseline (`chrome.transparent`) wins. Lives
   * for the lifetime of the instance only — closing the tab resets it.
   */
  transparency?: TransparencyLevel;
  /**
   * Minimized state. When `true`, the instance is preserved in `byId` +
   * `openOrder` but NOT rendered in the active stage — it is kept
   * MOUNTED off-screen (`display:none`) by `StageHost`'s keep-alive, so
   * restoring it does not restart the widget's REACT subtree (component state,
   * timers, sockets, the Terminal's PTY survive). An `<iframe>` inside the
   * outlet is the documented exception: it is detached from the document during
   * the move and loses its browsing context, so it reloads with all in-frame
   * state gone — see `widgets/README.md`. The dock item for its type shows the
   * "minimized" affordance (a coloured ring) instead of the open highlight.
   * The dock item's always-visible BROOM (clean) destroys the instance
   * entirely — client state only, server data untouched.
   */
  hidden?: boolean;
};

export type AgentRuntime = {
  widgets: {
    openOrder: string[];
    byId: Record<string, WidgetInstance>;
  };
  layout: TiledLayoutState;
  conversation?: {
    activeConversationId?: string | null;
    conversationById?: Record<string, unknown>;
  };
};
