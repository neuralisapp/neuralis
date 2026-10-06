'use client';

import { useCallback, useLayoutEffect, useReducer, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useStageShell } from '../store/selectors';
import { renderWidget } from '../widgets/registry';
import type { WidgetInstance } from '../store/types';
import { StageOutletProvider, type RegisterPlaceholder } from './stageOutlet';
import { TiledStage } from './TiledStage';
import { CanvasStage } from './CanvasStage';

/**
 * The always-mounted stage owner. It holds the keep-alive machinery — one
 * detached "outlet" DOM node per widget instance, each rendered into EXACTLY
 * ONCE via a portal — and moves those outlets between the active stage's
 * placeholders and an off-screen stash with `appendChild`. Moving a raw DOM
 * node does NOT remount its React subtree, so:
 *   - minimizing / restoring a widget never restarts its React subtree, and
 *   - switching stage mode (tiled ↔ canvas ↔ grid) never restarts it either,
 *     because the outlet nodes live HERE, not inside the stage that unmounts.
 *
 * What survives is React-OWNED state: component state, timers, sockets, fetch
 * caches — the Terminal's PTY session included. An `<iframe>` inside the outlet
 * does NOT: the stage unmounts its placeholder before this host re-homes the
 * outlet, and `appendChild` is itself a remove-then-insert, so the frame leaves
 * the document and the HTML Standard discards its browsing context — it reloads
 * from the same `src` with a fresh document (machine-core's VNC view, every
 * `renderer: "iframe"` package widget), on minimize/restore AND on stage-mode
 * switch. A state-preserving relocate needs `Element.moveBefore()` plus a
 * pre-relocate boundary (no Safari support), a named follow-up — see
 * `widgets/README.md`.
 *
 * Each stage (TiledStage / CanvasStage) is a pure layout component: it renders
 * frames and calls `registerPlaceholder(id, el)` (via `StageOutletProvider`)
 * for the div that should receive each widget's outlet. This host does the
 * rest.
 */
export function StageHost() {
  const { agentId, runtimeKey, openOrder, byId, stageMode } = useStageShell();

  const stashRef = useRef<HTMLDivElement | null>(null);
  const outletsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const placeholdersRef = useRef<Record<string, HTMLDivElement | null>>({});
  // Bumped when a new outlet node is created (in the layout effect) so the
  // follow-up render renders the portal into it. Node creation stays OUT of
  // the render phase to preserve render purity.
  const [, bumpOutlets] = useReducer((n: number) => n + 1, 0);

  const registerPlaceholder = useCallback<RegisterPlaceholder>((widgetId, el) => {
    const prev = placeholdersRef.current[widgetId] ?? null;
    if (el === prev) return;
    // Ignore the `null` a stage's INLINE ref callback fires on every re-render
    // (React detaches an inline ref each commit): a genuine placeholder removal
    // (minimize / stage unmount) is reconciled by the placement layout effect,
    // which re-stashes the outlet, and its `!w.hidden` guard means a stale ref
    // is never consumed.
    if (!el) return;
    placeholdersRef.current[widgetId] = el;
    // The stage mounted this placeholder AFTER StageHost's last commit — e.g.
    // the FIRST entry into canvas/grid, where CanvasStage seeds geometry into
    // `freeformById`/`gridById` (maps StageHost deliberately does NOT subscribe
    // to, so it neither re-renders nor re-runs the placement effect). Home the
    // outlet immediately so the widget shows at once instead of staying blank
    // until a later, unrelated re-render.
    const node = outletsRef.current.get(widgetId);
    if (node && node.parentElement !== el) el.appendChild(node);
  }, []);

  const allWidgets = openOrder.map((id) => byId[id]).filter(Boolean) as WidgetInstance[];

  // Ensure an outlet exists per live instance, GC dead ones, then place each
  // outlet into the active stage's placeholder (or the off-screen stash when
  // minimized / the placeholder is not mounted). Runs every commit — after the
  // stage's ref callbacks have set/cleared placeholders — so a mode switch
  // re-homes each outlet into the newly-mounted stage without a remount.
  useLayoutEffect(() => {
    const alive = new Set(allWidgets.map((w) => w.id));
    let created = false;
    for (const w of allWidgets) {
      if (!outletsRef.current.has(w.id)) {
        const node = document.createElement('div');
        node.className = 'h-full w-full';
        outletsRef.current.set(w.id, node);
        created = true;
      }
    }
    for (const [id, node] of outletsRef.current) {
      if (!alive.has(id)) {
        node.remove();
        outletsRef.current.delete(id);
      }
    }
    for (const w of allWidgets) {
      const node = outletsRef.current.get(w.id);
      if (!node) continue;
      const dest = (!w.hidden ? placeholdersRef.current[w.id] : null) ?? stashRef.current;
      if (dest && node.parentElement !== dest) dest.appendChild(node);
    }
    if (created) bumpOutlets();
  });

  if (!agentId) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <div className="text-sm text-white/50">Select an agent to start</div>
      </div>
    );
  }

  const portals = (
    <>
      {/* Off-screen stash keeps minimized widgets mounted. */}
      <div ref={stashRef} className="hidden" aria-hidden="true" />
      {allWidgets.map((w) => {
        const node = outletsRef.current.get(w.id);
        return node ? createPortal(renderWidget({ agentId, instance: w }), node, w.id) : null;
      })}
    </>
  );

  return (
    <StageOutletProvider value={registerPlaceholder}>
      <div className="h-full w-full relative">
        {stageMode === 'tiled' ? (
          <TiledStage />
        ) : (
          // Keyed on the COMPOSITE runtime key (project:agent), never the bare
          // agentId: same-slug agents exist in different projects, and a bare
          // key would keep the old project's CanvasStage mounted across the
          // switch — its debounced setCanvasView would then write the old
          // project's pan/zoom into the NEW project's runtime.
          <CanvasStage key={`${runtimeKey}:${stageMode}`} grid={stageMode === 'grid'} />
        )}
        {portals}
      </div>
    </StageOutletProvider>
  );
}
