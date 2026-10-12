'use client';

import type { ReactNode } from 'react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LayoutGrid } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Dock, DockCluster, PHONE_LAUNCHER_ROW, PHONE_SAFE_BOTTOM, PhoneDockSheet, type PhoneWindow } from './Dock';
import { resolveDockIcon } from './dockIcons';
import { CONTROL_SURFACE, CONTROL_SURFACE_THEME_ID, backgroundImageOpacity } from './widgetSurface';
import { useAgentsState, useStageShell } from '../store/selectors';
import { getWidgetDefinition } from '../widgets/registry';
import type { DockMode } from './dockMode';
import { DOCK_MODE_KEYS, parseDockMode, dockModeIsPinned, dockModeHasLabels } from './dockMode';
import type { DockAlign, DockId, DockLane, DockLayoutConfig, DockLine, DockPlacement, DockTracks } from './dockPlacement';
import {
  DEFAULT_DOCK_LAYOUT, DOCK_ANCHORS, DOCK_TRACK, DockLayoutContext, anchorCell, dockAlign, dockEdge, dockEdgeTrack, dockLanes, dockLine,
  dockTrackSize, placementRect, readDockLayoutConfig, saveDockLayoutConfig,
} from './dockPlacement';
import { AnimatedUniverseBackground } from './AnimatedUniverseBackground';
import { AppMenu, phoneOverlayHistory } from './AppMenu';
import { useWorkspaceStore, phoneDeviceEligible } from '../store/workspaceStore';
import { useTheme } from '../theme/useTheme';
import { usePrimaryDockItems, useSecondaryDockItems } from './useDockItems';

type Props = { children: ReactNode; snapshotReady?: boolean };

const PRIMARY_MODE_KEY = DOCK_MODE_KEYS.primary;
const SECONDARY_MODE_KEY = DOCK_MODE_KEYS.secondary;
/** How long a dropped dock keeps its rotate control beside the grip (presentation, not a tunable). */
const ROTATE_AFTER_DROP_MS = 4000;

function readFromStorage(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage.getItem(key); } catch { return null; }
}

/** A mode change persists once: a value the storage already holds (a coordinated layout commit wrote it) is not written again. */
function writeToStorage(key: string, value: string) {
  if (typeof window === 'undefined' || readFromStorage(key) === value) return;
  try { window.localStorage.setItem(key, value); } catch { /* ignore */ }
}

/**
 * The dock placement / transparency / mode all live in localStorage, which is
 * absent during SSR. Reading them in a `useState` initializer desyncs
 * hydration: React renders the server DEFAULT, then keeps those default
 * classNames on the ALWAYS-present chrome items (user / project / layout /
 * create) — an attribute mismatch it never repairs — so a persisted dock
 * transparency was stuck on exactly those items after a refresh (the async
 * package + agent items render post-hydration and pick up the real value,
 * which is why only the chrome was wrong). We instead render the SSR DEFAULT
 * deterministically and adopt the persisted values in a layout effect BEFORE
 * paint (no flash), forcing a clean client commit that reaches every dock
 * element uniformly. `useLayoutEffect` on the client, `useEffect` on the
 * server — the standard isomorphic guard avoids the SSR warning.
 */
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/** Lane flex classes: along the line a cluster's own margin places it; across it, the line's side. */
function laneClass(lane: Pick<DockLane, 'orientation' | 'line'>): string {
  const cross: Record<DockLine, string> = { left: 'items-start', top: 'items-start', right: 'items-end', bottom: 'items-end', center: 'items-center', middle: 'items-center' };
  return cn('absolute z-30 flex pointer-events-none', lane.orientation === 'vertical' ? 'flex-col' : 'flex-row', cross[lane.line]);
}

/**
 * A cluster's place on its lane. Auto margins centre or end it in the space
 * the OTHER cluster leaves, so two clusters on one line never overlap (a
 * centred one centres in what is left beside its neighbour).
 */
function clusterMargin(align: DockAlign, vertical: boolean): string {
  if (align === 'start') return '';
  if (align === 'end') return vertical ? 'mt-auto' : 'ml-auto';
  return vertical ? 'my-auto' : 'mx-auto';
}

export function WorkspaceShell({ children, snapshotReady = false }: Props) {
  const { backgroundTheme: theme } = useTheme();
  const showUniverse = theme.useUniverseBackground !== false;
  const { agentId, stageMode, openOrder, byId, phoneForegroundId } = useStageShell();
  const phone = stageMode === 'phone';
  const [sheetOpen, setSheetOpen] = useState(false);
  const closeSheet = useCallback(() => setSheetOpen(false), []);
  useEffect(() => { if (!phone) setSheetOpen(false); }, [phone]);
  // Editing a dock on Phone happens in the sheet, so entering edit mode opens it.
  const editingDocks = useWorkspaceStore((s) => s.dockEditing.primary || s.dockEditing.secondary);
  useEffect(() => { if (phone && editingDocks) setSheetOpen(true); }, [phone, editingDocks]);

  const [appsOpen, setAppsOpen] = useState(false);
  const [appsOpening, setAppsOpening] = useState(0);
  const closeApps = useCallback(() => setAppsOpen(false), []);
  useEffect(() => {
    const open = () => { setAppsOpening((value) => value + 1); setAppsOpen(true); };
    window.addEventListener('neuralis:apps-open', open);
    return () => window.removeEventListener('neuralis:apps-open', open);
  }, []);
  const historyToken = useId();
  const historyOwner = useRef<ReturnType<typeof phoneOverlayHistory> | null>(null);
  useEffect(() => {
    if (!phone) return;
    const owner = phoneOverlayHistory(window, () => { setAppsOpen(false); setSheetOpen(false); }, `${window.performance.timeOrigin}:${historyToken}`);
    historyOwner.current = owner;
    return () => { owner.dispose(); historyOwner.current = null; };
  }, [phone, historyToken]);
  useEffect(() => { historyOwner.current?.sync(phone && (appsOpen || sheetOpen)); }, [phone, appsOpen, sheetOpen]);

  const [layout, setLayout] = useState<DockLayoutConfig>(DEFAULT_DOCK_LAYOUT);
  const [primaryMode, setPrimaryMode] = useState<DockMode>('iconPinned');
  const [secondaryMode, setSecondaryMode] = useState<DockMode>('iconPinned');
  const [preview, setPreview] = useState<DockPlacement | null>(null);
  // The dock just dropped keeps its rotate control beside the grip for a moment (one timer per drop).
  const [dropped, setDropped] = useState<DockId | null>(null);
  useEffect(() => {
    if (!dropped) return;
    const timer = window.setTimeout(() => setDropped(null), ROTATE_AFTER_DROP_MS);
    return () => window.clearTimeout(timer);
  }, [dropped]);

  // Adopt the persisted layout + dock modes after hydration, before paint.
  // See `useIsomorphicLayoutEffect` above for why this cannot be a render-time
  // (useState-initializer) read.
  useIsomorphicLayoutEffect(() => {
    setLayout(readDockLayoutConfig());
    setPrimaryMode(parseDockMode(readFromStorage(PRIMARY_MODE_KEY), 'iconPinned'));
    setSecondaryMode(parseDockMode(readFromStorage(SECONDARY_MODE_KEY), 'iconPinned'));
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<DockLayoutConfig>).detail;
      if (detail) setLayout(detail);
      // The dock modes ride the same invalidation (a coordinated layout commit
      // stored them already); re-reading them writes nothing back.
      setPrimaryMode(parseDockMode(readFromStorage(PRIMARY_MODE_KEY), 'iconPinned'));
      setSecondaryMode(parseDockMode(readFromStorage(SECONDARY_MODE_KEY), 'iconPinned'));
    };
    window.addEventListener('neuralis:layout-changed', handler);
    return () => window.removeEventListener('neuralis:layout-changed', handler);
  }, []);

  useEffect(() => { writeToStorage(PRIMARY_MODE_KEY, primaryMode); }, [primaryMode]);
  useEffect(() => { writeToStorage(SECONDARY_MODE_KEY, secondaryMode); }, [secondaryMode]);

  // Phone is a STAGE: the device decides it (unless the user chose a mode);
  // every widget keeps its desktop chrome, and the docks live in ONE sheet
  // behind the launcher instead of on the screen edges.
  // The pointer query is read here, in an effect, never through a kernel hook
  // in render: the kernel is a server-external package, so a hook it calls in
  // the server render does not reach the renderer's React.
  useEffect(() => {
    const coarse = typeof window.matchMedia === 'function' ? window.matchMedia('(pointer: coarse)') : null;
    const updateDevice = () => useWorkspaceStore.getState().setResponsivePhone(
      phoneDeviceEligible(window.innerWidth, coarse?.matches ?? false, window.screen.width, window.screen.height), layout.autoPhone);
    updateDevice();
    window.addEventListener('resize', updateDevice);
    coarse?.addEventListener('change', updateDevice);
    return () => { window.removeEventListener('resize', updateDevice); coarse?.removeEventListener('change', updateDevice); };
  }, [layout.autoPhone]);

  const modes: Record<DockId, DockMode> = { primary: primaryMode, secondary: secondaryMode };
  const disabled = !snapshotReady;

  // On Phone the items render as icon tiles in the sheet: no labels, never hidden, popovers open upward.
  const primaryItems = usePrimaryDockItems(phone ? 'bottom' : dockEdge(layout.primary), !phone && dockModeHasLabels(primaryMode), phone || dockModeIsPinned(primaryMode), disabled);
  const secondaryItems = useSecondaryDockItems(phone ? 'bottom' : dockEdge(layout.secondary), !phone && dockModeHasLabels(secondaryMode), phone || dockModeIsPinned(secondaryMode), disabled);

  const { byId: agentsById } = useAgentsState();
  const phoneWindows = useMemo<PhoneWindow[]>(() => (phone ? openOrder.flatMap((id) => {
    const instance = byId[id];
    const definition = instance ? getWidgetDefinition(instance.type) : undefined;
    if (!instance || !definition) return [];
    // A Group window names its bound agent (a per-agent window carries none).
    const title = instance.agentId ? `${instance.title} · ${agentsById[instance.agentId]?.name || instance.agentId}` : instance.title;
    return [{ id, title, icon: resolveDockIcon(definition.icon ?? instance.icon), foreground: id === phoneForegroundId, minimized: instance.hidden === true }];
  }) : []), [phone, openOrder, byId, phoneForegroundId, agentsById]);
  const showWindow = useCallback((id: string) => {
    if (!agentId) return;
    const store = useWorkspaceStore.getState();
    if (byId[id]?.hidden) store.restoreWidget({ agentId, widgetInstanceId: id });
    else store.focusWidget({ agentId, widgetInstanceId: id });
  }, [agentId, byId]);
  const minimizeWindow = useCallback((id: string) => {
    if (agentId) useWorkspaceStore.getState().minimizeWidget({ agentId, widgetInstanceId: id });
  }, [agentId]);

  // ── Grid: pinned docks on an edge line reserve its track ──────────────

  const tracks = useMemo<DockTracks>(() => ({
    left: dockEdgeTrack(layout, modes, 'left'),
    right: dockEdgeTrack(layout, modes, 'right'),
    top: dockEdgeTrack(layout, modes, 'top'),
    bottom: dockEdgeTrack(layout, modes, 'bottom'),
  }), [layout, primaryMode, secondaryMode]);

  const gridStyle = useMemo(() => (phone ? {
    // Phone: the launcher has its own row under the stage, so it never covers the composer.
    gridTemplateColumns: '0px 1fr 0px',
    gridTemplateRows: `0px 1fr ${PHONE_LAUNCHER_ROW}`,
  } : {
    gridTemplateColumns: `${tracks.left} 1fr ${tracks.right}`,
    gridTemplateRows: `${tracks.top} 1fr ${tracks.bottom}`,
  }), [tracks, phone]);

  const lanes = useMemo(() => dockLanes(layout), [layout]);

  const savePlacement = useCallback((placement: DockPlacement, source?: 'drag') => {
    const next = { ...layout, [placement.dockId]: placement };
    saveDockLayoutConfig(next);
    setLayout(next);
    setDropped(source === 'drag' ? placement.dockId : null);
    window.dispatchEvent(new CustomEvent('neuralis:layout-changed', { detail: next }));
  }, [layout]);

  // ── Dock rendering ────────────────────────────────────────────────────

  const renderDock = (dockId: DockId, open: boolean, join?: 'start' | 'end') => (
    <Dock
      key={dockId}
      dockId={dockId}
      placement={layout[dockId]}
      mode={modes[dockId]}
      onChangeMode={dockId === 'primary' ? setPrimaryMode : setSecondaryMode}
      items={dockId === 'primary' ? primaryItems : secondaryItems}
      disabled={disabled}
      open={open}
      transparency={layout.defaultDockTransparency}
      background={layout.dockBackground}
      join={join}
      loading={!snapshotReady && dockId === 'primary'}
      onPlacement={savePlacement}
      rotateHint={dropped === dockId}
      onPreview={setPreview}
    />
  );

  const laneSize = (lane: DockLane): string => {
    const horizontal = lane.orientation === 'horizontal';
    const sizes = lane.clusters.flatMap((cluster) => cluster.docks).map((id) => dockTrackSize(modes[id], horizontal));
    return sizes.includes(DOCK_TRACK.label) ? DOCK_TRACK.label : sizes[0];
  };

  const renderLanes = () => lanes.map((lane) => {
    const vertical = lane.orientation === 'vertical';
    return (
      <div key={`${lane.orientation}:${lane.line}`} data-dock-lane={`${lane.orientation}:${lane.line}`} className={laneClass(lane)} style={placementRect(lane, laneSize(lane), tracks)}>
        {lane.clusters.map((cluster) => {
          const first = layout[cluster.docks[0]];
          // A joined pair: ONE contour in toolbar (shared corners squared, no gap), flush tiles in classic.
          const joinedToolbar = cluster.docks.length > 1 && layout.dockBackground === 'toolbar';
          return (
            <DockCluster
              key={cluster.align}
              edge={dockEdge(first)}
              horizontal={!vertical}
              hover={cluster.docks.some((id) => !dockModeIsPinned(modes[id]))}
              className={clusterMargin(cluster.align, vertical)}
            >
              {(open) => cluster.docks.map((id, index) => renderDock(id, open, joinedToolbar ? (index === 0 ? 'start' : 'end') : undefined))}
            </DockCluster>
          );
        })}
      </div>
    );
  });

  // The landing spot of a dock drag: the eight anchors, and the dock's ghost on
  // its lane (R during the drag flips its orientation).
  const renderPreview = (placement: DockPlacement) => {
    const lane = { orientation: placement.orientation, line: dockLine(placement) };
    const vertical = placement.orientation === 'vertical';
    const size = dockTrackSize(modes[placement.dockId], !vertical);
    return (
      <>
        <div aria-hidden="true" className="absolute inset-3 z-[60] pointer-events-none">
          {DOCK_ANCHORS.map((anchor) => {
            const { row, col } = anchorCell(anchor);
            return (
              <span
                key={anchor}
                className="absolute w-4 h-4 -translate-x-1/2 -translate-y-1/2 rounded-full border"
                style={{
                  left: col === 'left' ? 0 : col === 'center' ? '50%' : '100%',
                  top: row === 'top' ? 0 : row === 'middle' ? '50%' : '100%',
                  borderColor: '#cba6f7',
                  background: anchor === placement.anchor ? '#cba6f7' : 'transparent',
                }}
              />
            );
          })}
        </div>
        <div data-dock-preview="" className={cn(laneClass(lane), 'z-[60]')} style={placementRect(lane, size, tracks)}>
          <div
            className={cn('rounded-2xl border-2 border-dashed', clusterMargin(dockAlign(placement), vertical))}
            style={{ borderColor: '#cba6f7', background: 'rgba(203,166,247,0.12)', ...(vertical ? { width: size, height: '8rem' } : { height: size, width: '12rem' }) }}
          />
        </div>
      </>
    );
  };

  return (
    <DockLayoutContext.Provider value={layout}>
      <div className="w-screen overflow-hidden relative bg-black" style={{ height: '100dvh' }}>
        <div className="absolute inset-0" style={{ background: 'var(--bg-gradient)' }} />
        {/* The Background material decides how strongly an image shows; the Universe draws OVER it and never dims it. */}
        <div className="absolute inset-0 bg-center bg-cover bg-no-repeat" style={{ backgroundImage: 'var(--bg-image)', opacity: backgroundImageOpacity(layout.backgroundTransparency) }} />
        {showUniverse ? <AnimatedUniverseBackground starColor={theme.colors.canvasStar} /> : null}
        <div className="absolute inset-0" style={{ backgroundImage: 'var(--bg-pattern)', backgroundSize: '48px 48px' }} />
        {appsOpen ? <AppMenu key={appsOpening} onClose={closeApps} /> : null}
        {phone && sheetOpen && typeof document !== 'undefined' ? createPortal(
          <PhoneDockSheet windows={phoneWindows} onWindow={showWindow} onMinimize={minimizeWindow} primaryItems={primaryItems} secondaryItems={secondaryItems} onClose={closeSheet} />,
          document.body,
        ) : null}
        <div className="relative z-10 h-full w-full p-1" style={phone ? { paddingBottom: PHONE_SAFE_BOTTOM } : undefined}>
          <div className="relative h-full w-full grid" style={gridStyle}>
            <main className="relative min-w-0 min-h-0 h-full overflow-hidden p-1" style={{ gridRow: 2, gridColumn: 2 }}>
              <div className="h-full w-full pt-0">{children}</div>
              {!snapshotReady && (
                <div className="absolute inset-0 z-20 rounded-2xl bg-black/30 backdrop-blur-[2px] flex items-center justify-center transition-opacity duration-500">
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-6 h-6 border-2 border-white/20 border-t-purple-400/70 rounded-full animate-spin" />
                    <span className="text-xs text-white/40">Loading packages...</span>
                  </div>
                </div>
              )}
            </main>
            {phone ? (
              <div data-phone-launcher-row="" className="flex items-end justify-center" style={{ gridRow: 3, gridColumn: '1 / 4' }}>
                <button
                  type="button"
                  aria-label="Open docks"
                  aria-expanded={sheetOpen}
                  data-theme-id={CONTROL_SURFACE_THEME_ID}
                  className="flex h-9 items-center gap-2 rounded-full border px-4 text-xs font-medium shadow-lg"
                  style={CONTROL_SURFACE}
                  onClick={() => setSheetOpen((open) => !open)}
                >
                  <LayoutGrid className="h-4 w-4" />
                  Docks
                </button>
              </div>
            ) : renderLanes()}
            {!phone && preview ? renderPreview(preview) : null}
          </div>
        </div>
      </div>
    </DockLayoutContext.Provider>
  );
}
