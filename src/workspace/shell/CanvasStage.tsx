'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Rnd } from 'react-rnd';
import { Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useWorkspaceStore, activeRuntimeKeyOf } from '../store/workspaceStore';
import { useOpenWidgets } from '../store/selectors';
import { getWidgetDefinition } from '../widgets/registry';
import { PanelChrome, type ChromeMode } from './PanelChrome';
import { TRANSPARENCY_CYCLE } from './WidgetControls';
import type { CanvasView, FreeformGeometry, TransparencyLevel, WidgetInstance } from '../store/types';
import { resolveWidgetLevel } from './widgetSurface';
import { useStageEmptyText, useStageOutlet } from './stageOutlet';
import { readDockLayoutConfig } from './dockPlacement';
import { createFrameLoop } from './frameLoop';

const GRID_STEP = 20;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2;
// Input normalization and bounded spawn-search design constraints, not settings.
const WHEEL_FRAME_PIXELS = 120;
const ZOOM_PIXEL_DISTANCE = 1000;
const SPAWN_CANDIDATES = 18;
const DEFAULT_VIEW: CanvasView = { x: 0, y: 0, zoom: 1 };

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}
// Floors, never rounds: a seeded SIZE sits on the grid, and the grid-mode
// POSITION is derived from that snapped size plus the gap, so the gap between
// neighbours is exact. Snapping positions as well (with a rounded size) put
// a cell's right edge past the next cell's left edge — neighbours touched.
function snap(v: number): number {
  return Math.floor(v / GRID_STEP) * GRID_STEP;
}

/**
 * The free-floating stage, in two flavours selected by `grid`:
 *
 *   - **canvas** — an infinite, pannable + zoomable board of overlapping
 *     windows (drag the empty background to pan; Ctrl/⌘+wheel or the zoom
 *     controls to scale). No snapping, no bounds. Geometry → `freeformById`.
 *   - **grid** — a bounded, packed tidy grid; drag/resize snap to `GRID_STEP`
 *     and stay inside the viewport. Geometry → `gridById`.
 *
 * Both render each widget through the SAME `PanelChrome` as `TiledStage`, so a
 * frameless widget stays frameless and a toolbar widget keeps its header — the
 * only addition is a hover-reveal drag grip. The widget content lives in a
 * keep-alive outlet owned by `StageHost`, received via `registerPlaceholder`.
 * The outlet preserves the widget's REACT subtree across a stage switch, but
 * NOT an `<iframe>` inside it — the frame is detached from the document and
 * reloads (see `widgets/README.md`).
 */
export function CanvasStage({ grid }: { grid: boolean }) {
  const { agentId, openOrder, byId, freeformById, gridById } = useOpenWidgets();
  const setWidgetGeometry = useWorkspaceStore((s) => s.setWidgetGeometry);
  const bringWidgetToFront = useWorkspaceStore((s) => s.bringWidgetToFront);
  const minimizeWidget = useWorkspaceStore((s) => s.minimizeWidget);
  const setWidgetTransparency = useWorkspaceStore((s) => s.setWidgetTransparency);
  const setCanvasView = useWorkspaceStore((s) => s.setCanvasView);
  const reveal = useWorkspaceStore((s) => s.canvasReveal);
  // The layout this canvas paints: the agent's own, or the selected Group's.
  const runtimeKey = useWorkspaceStore(activeRuntimeKeyOf);
  const wheelFrame = useRef<ReturnType<typeof createFrameLoop> | null>(null);
  const registerPlaceholder = useStageOutlet();
  const emptyText = useStageEmptyText('Open a widget from the dock');
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const geomById = grid ? gridById : freeformById;
  const slot = grid ? 'grid' : 'canvas';

  const [defaultTransparency, setDefaultTransparency] = useState<TransparencyLevel>(() =>
    typeof window === 'undefined' ? 'opaque' : (readDockLayoutConfig().defaultWidgetTransparency ?? 'opaque'),
  );
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.defaultWidgetTransparency) setDefaultTransparency(detail.defaultWidgetTransparency);
    };
    window.addEventListener('neuralis:layout-changed', handler);
    return () => window.removeEventListener('neuralis:layout-changed', handler);
  }, []);

  // ── Canvas pan/zoom (local during the gesture, persisted debounced) ───────
  const [view, setView] = useState<CanvasView>(() => {
    if (typeof window === 'undefined' || !agentId) return DEFAULT_VIEW;
    const s = useWorkspaceStore.getState();
    const rk = activeRuntimeKeyOf(s);
    return (rk ? s.runtimeByAgentId[rk]?.layout.canvasView : undefined) ?? DEFAULT_VIEW;
  });
  const [panning, setPanning] = useState(false);
  const panRef = useRef<{ id: number; sx: number; sy: number; view: CanvasView; target: HTMLDivElement } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ distance: number; cx: number; cy: number; view: CanvasView } | null>(null);

  // The dot-grid is a transient affordance: shown only WHILE panning/zooming,
  // then it fades out. `pokeGrid` reveals it and (re)arms the hide timer.
  const [gridVisible, setGridVisible] = useState(false);
  const gridHideTimer = useRef<number | null>(null);
  const pokeGrid = useCallback(() => {
    setGridVisible(true);
    if (gridHideTimer.current) window.clearTimeout(gridHideTimer.current);
    gridHideTimer.current = window.setTimeout(() => setGridVisible(false), 650);
  }, []);
  useEffect(() => () => { if (gridHideTimer.current) window.clearTimeout(gridHideTimer.current); }, []);

  // A pan/zoom is a layout change from its FIRST frame: the intent is noted
  // once per gesture (one store set), so an Undo taken before it is refused and
  // the debounced write below knows which layout epoch it belongs to.
  const intentOpen = useRef(false);
  const noteIntent = useCallback(() => {
    if (intentOpen.current) return;
    intentOpen.current = true;
    useWorkspaceStore.getState().noteLayoutIntent();
  }, []);

  useEffect(() => {
    if (!agentId || !runtimeKey || grid || panning) return;
    const state = useWorkspaceStore.getState();
    const saved = state.runtimeByAgentId[runtimeKey]?.layout.canvasView ?? DEFAULT_VIEW;
    if (saved.x === view.x && saved.y === view.y && saved.zoom === view.zoom) return;
    // Written only into the layout this canvas was painting, and only under
    // the epoch it was scheduled in: a project/agent/Group switch, or a
    // Randomize/Undo commit, in the 400 ms window drops it.
    const epoch = state.layoutEpoch;
    const t = window.setTimeout(() => {
      intentOpen.current = false;
      const now = useWorkspaceStore.getState();
      if (activeRuntimeKeyOf(now) === runtimeKey && now.layoutEpoch === epoch) setCanvasView({ agentId, view });
    }, 400);
    return () => window.clearTimeout(t);
  }, [agentId, runtimeKey, grid, panning, view, setCanvasView]);

  // A committed view from outside this canvas (Randomize / Undo) is adopted by
  // the mounted canvas — no remount, no write back (the values are equal).
  const storedView = useWorkspaceStore((s) => (runtimeKey ? s.runtimeByAgentId[runtimeKey]?.layout.canvasView : undefined));
  useEffect(() => {
    if (!storedView || panRef.current) return;
    intentOpen.current = false;
    setView((v) => (v.x === storedView.x && v.y === storedView.y && v.zoom === storedView.zoom ? v : storedView));
  }, [storedView]);

  // Ctrl/⌘+wheel zoom-to-cursor. Native non-passive listener so preventDefault
  // owns zoom on the empty board; inside windows, browser page zoom and app
  // scrolling remain native.
  useEffect(() => {
    if (grid) return;
    const el = viewportRef.current;
    if (!el) return;
    const frame = createFrameLoop(window);
    wheelFrame.current = frame;
    let delta = 0, cx = 0, cy = 0;
    const onWheel = (e: WheelEvent) => {
      // Content scroll and browser page zoom remain native inside app windows.
      if (!(e.ctrlKey || e.metaKey) || (e.target as HTMLElement).closest('.nrs-canvas-window')) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      cx = e.clientX - rect.left; cy = e.clientY - rect.top;
      const line = parseFloat(getComputedStyle(el).lineHeight) || parseFloat(getComputedStyle(el).fontSize);
      delta += e.deltaY * (e.deltaMode === 1 ? line : e.deltaMode === 2 ? el.clientHeight : 1);
      noteIntent();
      frame.schedule(() => {
        const factor = Math.exp(-clamp(delta, -WHEEL_FRAME_PIXELS, WHEEL_FRAME_PIXELS) / ZOOM_PIXEL_DISTANCE);
        delta = 0;
        setView((v) => canvasZoomAt(v, factor, cx, cy));
        pokeGrid();
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => { el.removeEventListener('wheel', onWheel); frame.cancel(); wheelFrame.current = null; };
  }, [grid, pokeGrid, noteIntent]);

  const zoomBy = (factor: number) => {
    noteIntent();
    const el = viewportRef.current;
    const cx = (el?.clientWidth ?? 0) / 2;
    const cy = (el?.clientHeight ?? 0) / 2;
    setView((v) => canvasZoomAt(v, factor, cx, cy));
    pokeGrid();
  };

  const finishPan = useCallback((cancel: boolean) => {
    const pan = panRef.current;
    if (!pan) return;
    if (cancel) setView(pan.view);
    panRef.current = null;
    for (const id of pointers.current.keys()) {
      if (pan.target.hasPointerCapture(id)) pan.target.releasePointerCapture(id);
    }
    pointers.current.clear(); pinchRef.current = null;
    setPanning(false);
  }, []);
  useEffect(() => {
    if (grid) return;
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') finishPan(true); };
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('keydown', escape);
      const target = panRef.current?.target; panRef.current = null;
      for (const id of pointers.current.keys()) if (target?.hasPointerCapture(id)) target.releasePointerCapture(id);
      pointers.current.clear(); pinchRef.current = null;
    };
  }, [finishPan, grid]);
  // Consume only the active runtime's focus request; geometry stays authored.
  useLayoutEffect(() => {
    if (grid || !reveal || reveal.runtimeKey !== runtimeKey) return;
    const widget = byId[reveal.widgetInstanceId];
    const geometry = freeformById[reveal.widgetInstanceId];
    const viewport = viewportRef.current;
    if (widget && !widget.hidden && geometry && viewport) {
      wheelFrame.current?.cancel();
      const base = panRef.current?.view ?? view;
      finishPan(true);
      setView(canvasRevealView(base, geometry, viewport.clientWidth, viewport.clientHeight));
    }
    useWorkspaceStore.getState().clearCanvasReveal(reveal);
  }, [reveal, runtimeKey, grid, byId, freeformById, finishPan, view]);
  useEffect(() => () => {
    const pending = useWorkspaceStore.getState().canvasReveal;
    if (pending?.runtimeKey === runtimeKey) useWorkspaceStore.getState().clearCanvasReveal(pending);
  }, [runtimeKey]);

  const onPanPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Guard react-rnd's ROOT: its resize handles are siblings of the inner
    // window, so guarding only that inner content also pans during resize.
    if (grid || e.button !== 0 || (e.target as HTMLElement).closest('.nrs-canvas-window,[data-canvas-ui]')) return;
    if (pointers.current.size >= 2) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!panRef.current) panRef.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, view, target: e.currentTarget };
    const pair = [...pointers.current.values()];
    if (pair.length === 2) {
      const rect = e.currentTarget.getBoundingClientRect();
      pinchRef.current = { distance: Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y), cx: (pair[0].x + pair[1].x) / 2 - rect.left, cy: (pair[0].y + pair[1].y) / 2 - rect.top, view };
    }
    e.currentTarget.setPointerCapture(e.pointerId); setPanning(true); pokeGrid(); noteIntent();
  };
  const onPanPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || !pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pinch = pinchRef.current, pair = [...pointers.current.values()];
    if (pinch && pair.length === 2 && pinch.distance > 0) {
      const rect = e.currentTarget.getBoundingClientRect();
      const next = canvasZoomAt(pinch.view, Math.hypot(pair[1].x - pair[0].x, pair[1].y - pair[0].y) / pinch.distance, pinch.cx, pinch.cy);
      setView({ ...next, x: next.x + (pair[0].x + pair[1].x) / 2 - rect.left - pinch.cx, y: next.y + (pair[0].y + pair[1].y) / 2 - rect.top - pinch.cy });
    } else if (!pinch && e.pointerId === pan.id) {
      setView({ ...pan.view, x: pan.view.x + e.clientX - pan.sx, y: pan.view.y + e.clientY - pan.sy });
    }
    pokeGrid();
  };

  const allWidgets = openOrder.map((id) => byId[id]).filter(Boolean) as WidgetInstance[];
  const visible = allWidgets.filter((w) => !w.hidden);
  const visibleKey = visible.map((w) => w.id).join(',');

  // Seed geometry for widgets entering this mode for the first time: a visible
  // world-space search for canvas, a packed grid for grid. Only missing widgets are
  // seeded, so user-arranged windows are preserved.
  useLayoutEffect(() => {
    if (!agentId) return;
    const vp = viewportRef.current;
    const cw = vp?.clientWidth ?? 1200;
    const ch = vp?.clientHeight ?? 800;
    if (visible.every((w) => geomById[w.id])) return;
    if (grid) {
      const n = Math.max(1, visible.length);
      const cols = clamp(Math.round(cw / 420), 1, 4);
      const rows = Math.ceil(n / cols);
      const gap = 8;
      const cellW = Math.max(240, snap((cw - gap * (cols + 1)) / cols));
      const cellH = Math.max(180, snap((ch - gap * (rows + 1)) / rows));
      visible.forEach((w, i) => {
        if (geomById[w.id]) return;
        const col = i % cols;
        const row = Math.floor(i / cols);
        setWidgetGeometry({
          agentId, widgetInstanceId: w.id, slot: 'grid',
          geometry: { x: gap + col * (cellW + gap), y: gap + row * (cellH + gap), w: cellW, h: cellH, z: i + 1 },
        });
      });
    } else {
      const occupied = visible.flatMap((w) => geomById[w.id] ? [geomById[w.id]] : []);
      visible.forEach((w, i) => {
        if (geomById[w.id]) return;
        const geometry = canvasSpawn(view, cw, ch, occupied, i + 1);
        occupied.push(geometry);
        setWidgetGeometry({ agentId, widgetInstanceId: w.id, slot: 'canvas', geometry });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, visibleKey, geomById, grid]);

  const windows = visible.map((w) => {
    const g = geomById[w.id];
    // Not yet seeded (first frame in this mode) — its outlet stays stashed by
    // StageHost until geometry lands on the next commit.
    if (!g) return null;
    const definition = getWidgetDefinition(w.type);
    const mode: ChromeMode = definition?.chrome?.mode ?? 'toolbar';
    const { level, showCycle } = resolveWidgetLevel({ instance: w, definition, defaultTransparency });
    const onCycle = showCycle && agentId
      ? () => setWidgetTransparency({ agentId, widgetInstanceId: w.id, level: TRANSPARENCY_CYCLE[level] })
      : undefined;

    return (
      <Rnd
        key={w.id}
        className="nrs-canvas-window"
        size={{ width: g.w, height: g.h }}
        position={{ x: g.x, y: g.y }}
        bounds={grid ? 'parent' : undefined}
        scale={grid ? 1 : view.zoom}
        minWidth={280}
        minHeight={160}
        dragHandleClassName="nrs-canvas-drag"
        dragGrid={grid ? [GRID_STEP, GRID_STEP] : undefined}
        resizeGrid={grid ? [GRID_STEP, GRID_STEP] : undefined}
        style={{ zIndex: g.z }}
        onMouseDownCapture={() => { if (agentId) bringWidgetToFront({ agentId, widgetInstanceId: w.id, slot }); }}
        onDragStop={(_e: unknown, d: { x: number; y: number }) => { if (agentId) setWidgetGeometry({ agentId, widgetInstanceId: w.id, slot, geometry: { x: d.x, y: d.y } }); }}
        onResizeStop={(_e: unknown, _dir: unknown, ref: HTMLElement, _delta: unknown, pos: { x: number; y: number }) => {
          if (agentId) setWidgetGeometry({ agentId, widgetInstanceId: w.id, slot, geometry: { w: ref.offsetWidth, h: ref.offsetHeight, x: pos.x, y: pos.y } });
        }}
      >
        <div data-canvas-window className="group/cvw relative h-full w-full">
          {/* Hover-reveal drag grip — the only react-rnd drag handle, so it
              works for frameless AND toolbar widgets without forcing a header. */}
          <div
            className="nrs-canvas-drag absolute top-1 left-1/2 -translate-x-1/2 z-[55] h-1.5 w-12 rounded-full bg-white/30 hover:bg-white/50 opacity-0 group-hover/cvw:opacity-100 transition cursor-grab active:cursor-grabbing"
            title={`Drag to move — ${w.title}`}
          />
          <PanelChrome
            windowId={w.id}
            title={w.title}
            subtitle={mode === 'toolbar' ? w.type : undefined}
            mode={mode}
            contentClassName={definition?.chrome?.contentClassName}
            level={level}
            onClose={() => { if (agentId) minimizeWidget({ agentId, widgetInstanceId: w.id }); }}
            onCycleTransparency={onCycle}
          >
            <div ref={(el) => { registerPlaceholder(w.id, el); }} className="h-full w-full" />
          </PanelChrome>
        </div>
      </Rnd>
    );
  });

  if (visible.length === 0) {
    return (
      <div ref={viewportRef} className="relative h-full w-full flex items-center justify-center">
        <div className="text-sm text-white/50">{emptyText}</div>
      </div>
    );
  }

  if (grid) {
    return (
      <div ref={viewportRef} className="relative h-full w-full overflow-hidden">
        {windows}
      </div>
    );
  }

  // Canvas: pannable + zoomable viewport with a transformed world.
  return (
    <div
      ref={viewportRef}
      className="relative h-full w-full overflow-hidden"
      style={{ cursor: panning ? 'grabbing' : 'grab' }}
      onPointerDown={onPanPointerDown}
      onPointerMove={onPanPointerMove}
      onPointerUp={() => finishPan(false)}
      onPointerCancel={() => finishPan(true)}
      onLostPointerCapture={() => finishPan(true)}
    >
      {/* Transient dot-grid — fades in only while panning/zooming. */}
      <div
        aria-hidden
        className="absolute inset-0 transition-opacity duration-300"
        style={{
          opacity: gridVisible ? 1 : 0,
          touchAction: 'none',
          backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.12) 1px, transparent 1px)',
          backgroundSize: `${24 * view.zoom}px ${24 * view.zoom}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
      />
      <div
        className="absolute top-0 left-0"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, transformOrigin: '0 0' }}
      >
        {windows}
      </div>

      {/* Zoom controls */}
      <div
        data-canvas-ui
        className="absolute bottom-3 right-3 z-[60] flex items-center gap-0.5 rounded-lg bg-black/45 backdrop-blur-sm p-1 text-white/70 select-none"
      >
        <button type="button" onClick={() => zoomBy(1 / 1.2)} title="Zoom out"
          className="w-6 h-6 rounded-md flex items-center justify-center hover:bg-white/10 hover:text-white transition">
          <Minus className="w-3.5 h-3.5" />
        </button>
        <button type="button" onClick={() => { noteIntent(); setView(DEFAULT_VIEW); }} title="Reset view"
          className="min-w-[3rem] h-6 px-1.5 rounded-md text-[11px] tabular-nums hover:bg-white/10 hover:text-white transition">
          {Math.round(view.zoom * 100)}%
        </button>
        <button type="button" onClick={() => zoomBy(1.2)} title="Zoom in"
          className="w-6 h-6 rounded-md flex items-center justify-center hover:bg-white/10 hover:text-white transition">
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

/** Keep the world point under the cursor fixed; limits are the existing stage bounds. */
export function canvasZoomAt(view: CanvasView, factor: number, cx: number, cy: number): CanvasView {
  const zoom = clamp(view.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  return zoom === view.zoom ? view : { x: cx - (cx - view.x) / view.zoom * zoom, y: cy - (cy - view.y) / view.zoom * zoom, zoom };
}

/** Eighteen visible candidates checked against occupied windows; prefer least overlap. */
export function canvasSpawn(view: CanvasView, cw: number, ch: number, occupied: FreeformGeometry[], z: number): FreeformGeometry {
  const w = Math.max(280, clamp(Math.floor(cw * 0.48), 340, 640) / view.zoom);
  const h = Math.max(160, clamp(Math.floor(ch * 0.6), 260, 520) / view.zoom);
  let best: FreeformGeometry = { x: (cw / 2 - view.x) / view.zoom - w / 2, y: -view.y / view.zoom, w, h, z }, score = Infinity;
  for (let i = 0; i < SPAWN_CANDIDATES; i++) {
    const screenW = w * view.zoom;
    const sx = screenW > cw ? Math.min(24, cw / 2) + (i % 3) * Math.max(0, cw - 48) / 2 - screenW / 2 : Math.min(24 + (i % 3) * 40, Math.max(0, cw - screenW));
    const sy = Math.min(24 + Math.floor(i / 3) * 32, Math.max(0, ch - Math.min(h * view.zoom, 44)));
    const candidate = { x: (sx - view.x) / view.zoom, y: (sy - view.y) / view.zoom, w, h, z };
    if (occupied.some((g) => g.x === candidate.x && g.y === candidate.y)) continue;
    const overlap = occupied.reduce((sum, g) => sum + Math.max(0, Math.min(g.x + g.w, candidate.x + w) - Math.max(g.x, candidate.x)) * Math.max(0, Math.min(g.y + g.h, candidate.y + h) - Math.max(g.y, candidate.y)), 0);
    if (overlap < score) { best = candidate; score = overlap; }
    if (overlap === 0) break;
  }
  return best;
}

/** Reveal the full window when it fits, otherwise its top-centre drag grip. */
export function canvasRevealView(view: CanvasView, geometry: FreeformGeometry, cw: number, ch: number): CanvasView {
  const left = geometry.x * view.zoom + view.x, top = geometry.y * view.zoom + view.y;
  const width = geometry.w * view.zoom, height = geometry.h * view.zoom;
  const x = width <= cw ? clamp(left, 0, cw - width) - left : clamp(left + width / 2, 24, Math.max(24, cw - 24)) - (left + width / 2);
  const y = height <= ch ? clamp(top, 0, ch - height) - top : clamp(top, 0, Math.max(0, ch - 44)) - top;
  return x === 0 && y === 0 ? view : { ...view, x: view.x + x, y: view.y + y };
}
