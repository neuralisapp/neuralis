# Workspace Widgets

This directory defines host-level widget contracts and the local widget registry used by the workspace shell.

Most product widgets are contributed by packages and rendered through `src/workspace/packages`. This directory exists for host-level types, compatibility wrappers, and registry plumbing that cannot live in a package.

## Responsibilities

- Define `WidgetDefinition` and render context types.
- Keep the host widget registry small and explicit.
- Provide compatibility for first-party widgets that need host bridges.
- Avoid placing package business logic in the host.

## Rule

If a feature belongs to a product area, implement it in its package. Use this directory only for host rendering infrastructure and unavoidable shell integration.

## Widget lifecycle (shell-owned, uniform for every package)

The open/minimize/close/transparency lifecycle is host-level — it works for ALL
package widgets with no per-package code. It lives in `../store/workspaceStore.ts`
and `../shell/{StageHost,TiledStage,CanvasStage,Dock,useDockItems}.tsx`:

- **Stage modes (tiled / canvas / grid)** — `StageHost` picks the renderer from the
  per-agent `layout.stageMode` (default `tiled`). `TiledStage` = a resizable
  `PanelGroup`. `CanvasStage` renders `react-rnd` windows in two flavours: **canvas** =
  an infinite pan/zoom board of free, overlapping windows (drag the empty background
  to pan, Ctrl/⌘+wheel or the on-screen zoom control to scale — `layout.canvasView` =
  x/y/zoom); **grid** = a bounded, packed grid that snaps drag/resize to a coarse step.
  The two keep SEPARATE geometry (`layout.freeformById` for canvas, `layout.gridById`
  for grid — each x/y/w/h/z), seeded lazily on first entry. Both render each widget
  through the SAME `PanelChrome` as tiled (frameless stays frameless, toolbar keeps
  its header) plus a hover-reveal drag grip — so a widget looks identical in every
  mode. The Layout "Mode:" row toggles it (`setStageMode`); all of it persists per
  agent.
- **Keep-alive across BOTH minimize AND mode-switch** — the reverse-portal machinery
  (one detached "outlet" DOM node per instance, each rendered ONCE via a portal and
  moved with `appendChild`) lives in **`StageHost`**, NOT in a stage. Because the
  outlet nodes outlive whichever stage is mounted, switching tiled↔canvas↔grid — and
  minimizing/restoring — never remounts a widget's REACT subtree (component state,
  timers, the Terminal's PTY socket and fetch caches all survive; no re-fetch).
  **Iframe content is the documented exception:** the stage unmounts its placeholder
  before `StageHost` re-homes the outlet, and `appendChild` is remove-then-insert, so
  an `<iframe>` inside the outlet is detached from the document and the HTML Standard
  discards its browsing context — every `renderer: "iframe"` package widget, and any
  `direct` widget that renders a frame of its own, reloads from the same URL with a
  fresh document and loses all in-frame state, on minimize/restore AND on stage-mode
  switch. A state-preserving relocate needs `Element.moveBefore()` plus a pre-relocate
  boundary (no Safari support), so it is a named follow-up, not a v1 property.
  **The `hidden` flag is what a `direct` widget can do about it:** the host passes
  `WidgetInstance.hidden` to every direct renderer, so a widget can drop the part
  of itself that minimizing would waste. Only machine-core's desktop stream drops
  it for the reason above — its frame's context is discarded by the re-home, so a
  stashed one reloads at 0×0 and is thrown away unused. agent-core's terminal
  unmounts its `XTermView`s while hidden for its OWN reason: those are plain DOM
  and survive the move perfectly well, they are simply not worth rendering into
  nothing. A `renderer: "iframe"` surface has no such lever either way — the host
  owns its frame.
  Each stage is pure layout: it renders frames and
  registers a placeholder div per widget via `stageOutlet`'s `registerPlaceholder`;
  `StageHost` moves the outlet into the active placeholder (or an off-screen stash
  when minimized).
- **Visibility signal for active transports** — direct package renderers receive
  `hidden` beside `agentId`, `widgetId`, and `state`. A widget may disconnect a
  view transport while hidden without destroying its server-side resource; the
  Terminal uses this to detach WebSockets while its managed PTY keeps running.
- **Open / restore** — `openWidget` (dock click / chat-starter / package code). A
  singleton that is minimized is restored (unhidden) instead of duplicated.
- **Minimize (close-to-dock)** — the widget header **X** (and double-clicking
  another dock item, `exclusiveOpenWidget`) sets `WidgetInstance.hidden` and
  PRESERVES the instance (kept mounted off-screen by the keep-alive above — with
  the iframe browsing-context exception noted there).
- **Clean (destroy)** — only the dock item's **always-visible free broom
  glyph** (`BrushCleaning`, rendered only when the item holds instances — its
  presence IS the "open store" indicator) truly destroys the store
  (`closeWidget`, which also drops the instance's canvas/grid geometry). It is
  the widget level of the 3-level client-store clean — agent tiles (shown iff
  the agent's composite `projectId:agentId` runtime key exists) and EVERY
  store-holding ProjectSwitcher row (active or not) carry the same broom
  (`cleanAgentStore` / `cleanProjectStore`); none of the three touches server
  data. Every level ALSO emits its scope on `store/clientResetBus.ts` after its
  own `set()` (widget level carries the widget TYPE, read before the delete),
  which the host port exposes as `WorkspaceHostPort.onClientStateReset` — the
  generic way a PACKAGE's own client store learns about the broom (brain-core's
  Files store resets its tree, tabs and caches through it) without any host →
  package import. The `MAX_WIDGETS` cap counts VISIBLE widgets; overflow
  minimizes the oldest visible rather than deleting it.
- **Dock states** — per widget type: filled highlight (a visible instance),
  coloured inset ring (only minimized instances), idle. The broom sits
  right-middle; the top-right corner belongs to the unread badge
  (`../shell/DockBadge.tsx`): the item's `<packageId>:<dockId>` number from the
  host notification counts (ONE refcounted hub subscription per project, held
  by `../WorkspaceRoot.tsx` above the package provider wrap — never by the
  shell or a dock, which remount when a provider attaches or the layout
  regroups them — `../notifications/notificationsClient.ts`), a small pill in
  the ONE lavender unread style (`UNREAD_PILL_STYLE`, shared with the Inbox
  count and the switcher numbers — never a tone colour, so a number costs no
  row read), popping only when a live
  frame raises it. Clicking it lists the item's notifications (marked read as
  shown); the inbox (per-app groups with a two-click Clear) and the settings
  live in the account popup, a row opens only its own package's widget through
  `openWidget`.
- **Edit docks** (Layout panel) — the docks enter edit mode (a dock already
  editing keeps its draft; with both editing the toggle asks before it
  discards both): drag or the arrow
  keys reorder INSIDE a group (a trust tier, own vs other agents — separators
  stay), the trash hides, the dashed tile brings hidden items back; the account,
  project, Layout and Create-agent items are fixed. The draft lives in `Dock`
  until Save writes `projectStateById[projectId].dock` once (per project, per
  browser; `../shell/dockOrder.ts`).
- **Agent identity** — the right-side agent tiles resolve
  `config.appearance.{icon,color}` through the package-system client
  `resolveAgentIcon` / `resolveAgentColor` authority. Users and projects
  render through ONE `AppearanceAvatar` (`../shell/UserAvatar.tsx`): the
  picture `contain`-ed on the chosen colour (a transparent PNG shows the colour),
  else the library icon, else the monogram. Their appearance lives in the user /
  project record — the picture as a hash reference served by `/api/appearance/*`
  — and both editors (`UserProfilePopup`, the owner-strength `ProjectEditPopup`
  under the switcher's Project settings) are the kernel `IconPicker`.
- **Default widget transparency** — `DockLayoutConfig.defaultWidgetTransparency`
  (Layout settings "Widgets:" row, localStorage) is the render baseline; precedence
  is per-instance override → manifest `chrome.transparent` → user default → opaque.
  The manifest `chrome.userTransparency:false` opt-out and `untrusted` trust-lock on
  the cycle button are unchanged. The surface math (`surfaceStyle`) + the precedence
  helper (`resolveWidgetLevel`) live in `../shell/widgetSurface.ts`, shared by
  `PanelChrome`, which both `TiledStage` and `CanvasStage` render every widget through.
- **The backdrop blur stays wherever there is a surface** — `surfaceBlurClass` returns
  `backdrop-blur-xl` at `opaque`, `backdrop-blur-md` at `dim`, and `null` only at
  `transparent`. The style and the blur are read off ONE per-level record in
  `widgetSurface.ts`, so a level's alpha and its filter can never drift apart.
  **Do not remove the `opaque` blur as "invisible".** The blur itself really is
  invisible there — the background is `rgb(var(--w-bg-rgb))` at alpha 1 and every theme
  publishes `widgetBg` as an alpha-less triplet — but the `backdrop-filter` PROPERTY
  also creates **(a)** free compositor-layer promotion, **(b)** a containing block for
  `position: fixed` descendants (and, with the `overflow-hidden rounded-[22px]` on the
  same div, a rounded-box clip of them) and **(c)** a stacking context. Dropping it
  moved 11 non-portalled `position: fixed` package surfaces, and a live pixel diff
  showed **13.45 % of panel pixels changed** from the lost layer promotion alone. The
  benchmark that justified the removal ran on a GPU-less SwiftShader harness, whose
  ranking does not transfer to real hardware; any future attempt needs a measurement on
  a GPU first.
  **(c) is additionally held by `PanelChrome`'s unconditional `isolate`**
  (`isolation: isolate`) at all three levels — correct on its own merits: `transparent`
  emits no filter and so never had a stacking context at all, and applying `isolate`
  everywhere keeps the z-order identical whether or not a filter is present, so the
  transparency cycle can never reshuffle paint order. Without a stacking context the
  panel's own `z-50` control strip and package popovers (`z-40`, `z-[10000]`) join the
  shell's `z-10` context and paint over the auto-hide dock (`z-30`) and the
  package-loading scrim (`z-20`). `isolation` is not on the spec's fixed-position
  containing-block list, so it does this without re-containing viewport modals.
  Reaching for `will-change` / `translateZ(0)` / `contain:` on `PanelChrome` stays
  forbidden: it is an ancestor of the virtualized chat timeline, which must never carry
  containment or paint CSS.
- **Animated universe background** — `../shell/AnimatedUniverseBackground.tsx` paints a
  100-node starfield behind the whole shell. It is per-theme (`useUniverseBackground`
  plus a per-theme `universeOpacity`) and user-toggleable in Layout settings, which is
  the only path that unmounts it. The loop holds ONE invariant, encoded in
  `../shell/frameLoop.ts` and unit-pinned: **at most one scheduled frame exists at any
  time, and cleanup can always reach it** — pausing cancels, resuming early-returns
  unless actually paused, and a resize sets a flag consumed by the next frame rather
  than scheduling its own. Under `prefers-reduced-motion: reduce` the component paints
  exactly one static frame (warmed to the animation's steady-state density) and starts
  no loop at all; flipping the OS preference rebuilds the effect in the other mode.
- **Dock transparency** — `DockLayoutConfig.defaultDockTransparency` (Layout settings
  "Dock:" row) styles EVERY dock element (package items, user avatar, project switcher,
  dock-mode switch, agent tiles) via a `Dock`-provided context (`../shell/dockSurface.ts`):
  `opaque` = the filled backgrounds; `dim` = faint; `transparent` = no backgrounds
  (icons only), an active/open item's icon glows, the minimized colour ring stays.
- **The dock render path is deliberately decoupled from geometry.** `WorkspaceShell`
  calls `usePrimaryDockItems`/`useSecondaryDockItems` in its own body, so anything those
  hooks subscribe to re-renders the SHELL. Three rules keep that cheap, and each was a
  measured stall before it was a rule:
  - **Selector.** The dock takes `useDockWidgetItems` (`../store/selectors.ts`) — the
    widget instance map ALONE. It must never take `useOpenWidgets`, which also carries
    `mainSplit`/`widgetSplitsById`/`freeformById`/`gridById`: that subscription made a
    divider drag or canvas pan re-render the shell and both dock trees every frame.
    The dock tracks are FIXED per mode from ONE table (`DOCK_TRACK` in
    `../shell/dockPlacement.ts`, read by both `Dock` and `dockEdgeTrack`), so the
    re-render cannot re-derive the stage width and loop back through `onLayout` — no
    `auto` track, no `w-fit` dock. `useOpenWidgets` is for the two
    STAGES, which must repaint on geometry. Geometry lives on `runtime.layout`, never on
    the instance, so `widgets.byId` keeps its identity through every geometry write.
  - **The streaming ring is compositor-driven** (`.streaming-ring*` in
    `src/app/globals.css`). It must not go back to animating a registered custom
    property inside a `conic-gradient` — that is paint-driven by definition, so it
    re-rasterized the gradient and re-composited the mask every frame, per streaming
    agent, inside the masked dock scroller. The shape is now a static masked frame
    element wrapping a square pseudo-element that carries a STATIC gradient and spins
    with `transform: rotate(…)`. The frame is a real element because a pseudo-element
    cannot clip another one, and the ring box is a wide rectangle that cannot itself be
    rotated. **Verified pixel-identical, not assumed:** rendered against the old
    implementation across 6 animation phases × both dock widths, the largest
    single-channel difference is 8/255 with no pixel above that (mean < 0.1/255) — and
    the frame's `overflow: hidden` is what buys it, so it is not redundant with the mask
    (removing it drifts the rounded corners by up to 58/255).
  - **`DockScrollContainer` never measures on an event.** `scrollHeight`/`clientHeight`/
    `scrollTop` are a forced synchronous layout, and four sources (mount, `ResizeObserver`,
    `MutationObserver`, `scroll`) feed the same read. They all go through ONE rAF
    (`../shell/frameLoop.ts`, `pending`-guarded so a burst collapses into a single
    layout read on the next frame). The `MutationObserver` keeps `subtree: true` on
    purpose — `Dock.tsx` appends items inside wrapper divs, never to the scroller
    itself, so a childList-only observer would miss every item add/remove. Its fade
    `maskImage` is the intended look and stays; the style object's identity is memoized
    so it does not re-run style recalc on the masked scroller each render. The listeners
    bind to the LIVE element via a callback ref — the vertical and horizontal branches
    render different scroll `<div>`s.
- **Refresh-survival** — the workspace store is `persist`-wrapped, partialized to
  `runtimeByAgentId` (open/minimized instances, splits, transparency, stage mode +
  canvas geometry; the widget-state `nav` handoff is STRIPPED by `stripWidgetNavs`
  — a nav is a ONE-SHOT message its applier consumes via `consumeWidgetNav`, never
  durable state, so an undelivered one expires at reload) **plus the `session`
  project/agent selection** (`workspaceView` forced back to `'default'`).
  After a reload `bootstrap()` validates the rehydrated `session.projectId`/`agentId`
  against the freshly-fetched lists and keeps the user in their last-viewed project
  and agent (falling back to the first project/agent only if the persisted one is
  gone); the layout is then restored and each widget re-loads its content from its
  own server/module store (the same way chat already does). The project/agent entity
  caches themselves are NOT persisted — only the selection ids are. (Persisting only
  `runtimeByAgentId` was the bug that always re-landed the user on `projects[0]`.)
  Between loads the project LIST stays live: a `project` frame on the `/api/events`
  hub (a record the user belongs to changed — renamed, re-described, members or
  roles edited, restored) makes `WorkspaceRoot` call `refreshProjects()` after a
  250 ms debounce (`subscribeProjectRecordChanges` in `realtime/eventHub.ts`; it
  also re-reads once when the hub comes back after a drop — the hub has no
  replay — never on the first connect), which replaces the list and prunes the switch store WITHOUT
  touching layouts or the session — never `reload()`, which wipes every project's
  layout — and hands over to `bootstrap()` only when the active project is gone.
  The switcher rows show the project id beside the name (names may repeat).
