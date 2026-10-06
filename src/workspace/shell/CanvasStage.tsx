'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Rnd } from 'react-rnd';
import { Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useWorkspaceStore, agentRuntimeKey } from '../store/workspaceStore';
import { useOpenWidgets } from '../store/selectors';
import { getWidgetDefinition } from '../widgets/registry';
import { PanelChrome, type ChromeMode } from './PanelChrome';
import { TRANSPARENCY_CYCLE } from './WidgetControls';
import type { CanvasView, TransparencyLevel, WidgetInstance } from '../store/types';
import { resolveWidgetLevel } from './widgetSurface';
import { useStageOutlet } from './stageOutlet';
import { readDockLayoutConfig } from './dockPlacement';

const GRID_STEP = 20;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2;
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
  const registerPlaceholder = useStageOutlet();
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
    const rk = s.session.projectId ? agentRuntimeKey(s.session.projectId, agentId) : null;
    return (rk ? s.runtimeByAgentId[rk]?.layout.canvasView : undefined) ?? DEFAULT_VIEW;
  });
  const [panning, setPanning] = useState(false);
  const panRef = useRef<{ active: boolean; sx: number; sy: number; ox: number; oy: number } | null>(null);

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

  useEffect(() => {
    if (!agentId || grid) return;
    const t = window.setTimeout(() => setCanvasView({ agentId, view }), 400);
    return () => window.clearTimeout(t);
  }, [agentId, grid, view, setCanvasView]);

  // Ctrl/⌘+wheel zoom-to-cursor. Native non-passive listener so preventDefault
  // suppresses the browser page zoom; plain wheel is left alone so a widget's
  // own scroll still works.
  useEffect(() => {
    if (grid) return;
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setView((v) => {
        const nz = clamp(v.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), MIN_ZOOM, MAX_ZOOM);
        if (nz === v.zoom) return v;
        const wx = (cx - v.x) / v.zoom;
        const wy = (cy - v.y) / v.zoom;
        return { x: cx - wx * nz, y: cy - wy * nz, zoom: nz };
      });
      pokeGrid();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [grid, pokeGrid]);

  const zoomBy = (factor: number) => {
    const el = viewportRef.current;
    const cx = (el?.clientWidth ?? 0) / 2;
    const cy = (el?.clientHeight ?? 0) / 2;
    setView((v) => {
      const nz = clamp(v.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      if (nz === v.zoom) return v;
      const wx = (cx - v.x) / v.zoom;
      const wy = (cy - v.y) / v.zoom;
      return { x: cx - wx * nz, y: cy - wy * nz, zoom: nz };
    });
    pokeGrid();
  };

  const onPanPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (grid || e.button !== 0) return;
    const t = e.target as HTMLElement;
    // Skip any pointerdown that starts inside a window — INCLUDING react-rnd's
    // resize handles, which sit on the Rnd ROOT wrapper (`.nrs-canvas-window`),
    // a sibling of our inner `[data-canvas-window]` div. Keying the guard off
    // the inner div alone let a corner-resize also pan the board.
    if (t.closest('.nrs-canvas-window') || t.closest('[data-canvas-ui]')) return;
    panRef.current = { active: true, sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y };
    setPanning(true);
    pokeGrid();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  const onPanPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = panRef.current;
    if (!p?.active) return;
    setView((v) => ({ ...v, x: p.ox + (e.clientX - p.sx), y: p.oy + (e.clientY - p.sy) }));
    pokeGrid();
  };
  const onPanPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!panRef.current?.active) return;
    panRef.current.active = false;
    setPanning(false);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };

  const allWidgets = openOrder.map((id) => byId[id]).filter(Boolean) as WidgetInstance[];
  const visible = allWidgets.filter((w) => !w.hidden);
  const visibleKey = visible.map((w) => w.id).join(',');

  // Seed geometry for widgets entering this mode for the first time: a clamped
  // cascade for canvas, a packed grid for grid. Only missing widgets are
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
      const W = clamp(Math.floor(cw * 0.48), 340, 640);
      const H = clamp(Math.floor(ch * 0.6), 260, 520);
      const step = 40;
      visible.forEach((w, i) => {
        if (geomById[w.id]) return;
        setWidgetGeometry({
          agentId, widgetInstanceId: w.id, slot: 'canvas',
          geometry: { x: clamp(40 + i * step, 0, Math.max(0, cw - W)), y: clamp(40 + i * step, 0, Math.max(0, ch - H)), w: W, h: H, z: i + 1 },
        });
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
        <div className="text-sm text-white/50">Open a widget from the dock</div>
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
      onPointerUp={onPanPointerUp}
      onPointerCancel={onPanPointerUp}
    >
      {/* Transient dot-grid — fades in only while panning/zooming. */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none transition-opacity duration-300"
        style={{
          opacity: gridVisible ? 1 : 0,
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
        <button type="button" onClick={() => setView(DEFAULT_VIEW)} title="Reset view"
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
