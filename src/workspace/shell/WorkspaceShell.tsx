'use client';

import type { ReactNode } from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Dock, triggerZoneClass } from './Dock';
import type { DockMode } from './dockMode';
import { parseDockMode, dockModeIsPinned, dockModeHasLabels } from './dockMode';
import type { DockLayoutConfig, DockEdge, DockId } from './dockPlacement';
import { DEFAULT_DOCK_LAYOUT, readDockLayoutConfig, isDockHorizontal, dockEdgeTrack } from './dockPlacement';
import { AnimatedUniverseBackground } from './AnimatedUniverseBackground';
import { useTheme } from '../theme/useTheme';
import { usePrimaryDockItems, useSecondaryDockItems } from './useDockItems';

type Props = { children: ReactNode; snapshotReady?: boolean };

const PRIMARY_MODE_KEY = 'neuralis:workspace:dockMode:primary';
const SECONDARY_MODE_KEY = 'neuralis:workspace:dockMode:secondary';
const HOVER_CLOSE_DELAY = 120;

function readFromStorage(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function writeToStorage(key: string, value: string) {
  if (typeof window === 'undefined') return;
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

export function WorkspaceShell({ children, snapshotReady = false }: Props) {
  const { theme } = useTheme();
  const showUniverse = theme.useUniverseBackground !== false;

  const [layout, setLayout] = useState<DockLayoutConfig>(DEFAULT_DOCK_LAYOUT);
  const [primaryMode, setPrimaryMode] = useState<DockMode>('iconPinned');
  const [secondaryMode, setSecondaryMode] = useState<DockMode>('iconPinned');

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
    };
    window.addEventListener('neuralis:layout-changed', handler);
    return () => window.removeEventListener('neuralis:layout-changed', handler);
  }, []);

  useEffect(() => { writeToStorage(PRIMARY_MODE_KEY, primaryMode); }, [primaryMode]);
  useEffect(() => { writeToStorage(SECONDARY_MODE_KEY, secondaryMode); }, [secondaryMode]);

  const modes: Record<DockId, DockMode> = { primary: primaryMode, secondary: secondaryMode };
  const disabled = !snapshotReady;

  const primaryHasLabels = dockModeHasLabels(primaryMode);
  const primaryPinned = dockModeIsPinned(primaryMode);
  const secondaryHasLabels = dockModeHasLabels(secondaryMode);
  const secondaryPinned = dockModeIsPinned(secondaryMode);

  const primaryItems = usePrimaryDockItems(layout.primary.edge, primaryHasLabels, primaryPinned, disabled);
  const secondaryItems = useSecondaryDockItems(layout.secondary.edge, secondaryHasLabels, secondaryPinned, disabled);

  // ── Shared hover for same-edge docks ──────────────────────────────────
  const sameEdgeTimerRef = useRef<number | null>(null);
  const [sameEdgeHover, setSameEdgeHover] = useState(false);

  const sharedHoverEnter = useCallback(() => {
    if (sameEdgeTimerRef.current !== null) {
      window.clearTimeout(sameEdgeTimerRef.current);
      sameEdgeTimerRef.current = null;
    }
    setSameEdgeHover(true);
  }, []);

  const sharedHoverLeave = useCallback(() => {
    if (sameEdgeTimerRef.current !== null) window.clearTimeout(sameEdgeTimerRef.current);
    sameEdgeTimerRef.current = window.setTimeout(() => {
      // Null the handle FIRST: a fired timeout no longer exists, so leaving the
      // id behind makes `sameEdgeTimerRef.current !== null` lie and the unmount
      // cleanup below clear a dead handle.
      sameEdgeTimerRef.current = null;
      setSameEdgeHover(false);
    }, HOVER_CLOSE_DELAY);
  }, []);

  useEffect(() => () => {
    if (sameEdgeTimerRef.current !== null) window.clearTimeout(sameEdgeTimerRef.current);
  }, []);

  // ── Grid ──────────────────────────────────────────────────────────────

  const gridStyle = useMemo(() => ({
    gridTemplateColumns: `${dockEdgeTrack(layout, modes, 'left')} 1fr ${dockEdgeTrack(layout, modes, 'right')}`,
    gridTemplateRows: `${dockEdgeTrack(layout, modes, 'top')} 1fr ${dockEdgeTrack(layout, modes, 'bottom')}`,
    gridTemplateAreas: `"dock-top dock-top dock-top" "dock-left main dock-right" "dock-bottom dock-bottom dock-bottom"`,
    columnGap: '0rem',
    rowGap: '0rem',
  }), [layout, primaryMode, secondaryMode]);

  // ── Dock rendering ────────────────────────────────────────────────────

  const renderDockContent = (dockId: 'primary' | 'secondary', skipTrigger: boolean, forceOpen: boolean) => {
    const placement = layout[dockId];
    const dockMode = dockId === 'primary' ? primaryMode : secondaryMode;
    const setMode = dockId === 'primary' ? setPrimaryMode : setSecondaryMode;
    const dockItems = dockId === 'primary' ? primaryItems : secondaryItems;

    return (
      <>
        <Dock
          dockId={dockId}
          placement={placement}
          mode={dockMode}
          onChangeMode={setMode}
          items={dockItems}
          disabled={disabled}
          forceOpen={forceOpen}
          skipTriggerZone={skipTrigger}
          transparency={layout.defaultDockTransparency}
        />
        {!snapshotReady && dockId === 'primary' && (
          <div className="absolute inset-0 z-20 rounded-2xl bg-black/40 backdrop-blur-sm flex items-center justify-center transition-opacity duration-500">
            <div className="w-5 h-5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
          </div>
        )}
      </>
    );
  };

  const edgeToArea: Record<DockEdge, string> = { left: 'dock-left', right: 'dock-right', top: 'dock-top', bottom: 'dock-bottom' };
  const sameEdge = layout.primary.edge === layout.secondary.edge;

  const renderDocks = () => {
    if (sameEdge) {
      const area = edgeToArea[layout.primary.edge];
      const isHoriz = isDockHorizontal(layout.primary.edge);
      const anyHover = !primaryPinned || !secondaryPinned;

      return (
        <div className={`relative h-full flex ${isHoriz ? 'flex-row' : 'flex-col'}`} style={{ gridArea: area }}>
          {/* Single shared trigger zone — prevents overlap of two individual zones */}
          {anyHover ? (
            <div
              className={triggerZoneClass(layout.primary.edge)}
              onMouseEnter={sharedHoverEnter}
              onMouseLeave={sharedHoverLeave}
              aria-hidden="true"
            />
          ) : null}
          <div
            className="flex-1 relative min-w-0 min-h-0 h-full"
            onMouseEnter={anyHover ? sharedHoverEnter : undefined}
            onMouseLeave={anyHover ? sharedHoverLeave : undefined}
          >
            {renderDockContent('primary', true, sameEdgeHover)}
          </div>
          <div
            className="flex-1 relative min-w-0 min-h-0 h-full"
            onMouseEnter={anyHover ? sharedHoverEnter : undefined}
            onMouseLeave={anyHover ? sharedHoverLeave : undefined}
          >
            {renderDockContent('secondary', true, sameEdgeHover)}
          </div>
        </div>
      );
    }
    return (
      <>
        <div className="relative h-full" style={{ gridArea: edgeToArea[layout.primary.edge] }}>
          {renderDockContent('primary', false, false)}
        </div>
        <div className="relative h-full" style={{ gridArea: edgeToArea[layout.secondary.edge] }}>
          {renderDockContent('secondary', false, false)}
        </div>
      </>
    );
  };

  return (
    <div className="h-screen w-screen overflow-hidden relative bg-black">
      <div className="absolute inset-0" style={{ background: 'var(--bg-gradient)' }} />
      <div className="absolute inset-0 bg-center bg-cover bg-no-repeat" style={{ backgroundImage: 'var(--bg-image)', opacity: 'var(--bg-image-opacity)' }} />
      {showUniverse ? <AnimatedUniverseBackground /> : null}
      <div className="absolute inset-0" style={{ backgroundImage: 'var(--bg-pattern)', backgroundSize: '48px 48px' }} />
      <div className="relative z-10 h-full w-full p-1">
        <div className="h-full w-full grid" style={gridStyle}>
          {renderDocks()}
          <main className="relative min-w-0 min-h-0 h-full overflow-hidden p-1" style={{ gridArea: 'main' }}>
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
        </div>
      </div>
    </div>
  );
}
