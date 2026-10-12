'use client';

import { useContext, useEffect, useRef } from 'react';
import { DockLayoutContext } from './dockPlacement';
import { resolveWidgetLevel } from './widgetSurface';
import { useStageShell } from '../store/selectors';
import { useWorkspaceStore } from '../store/workspaceStore';
import { getWidgetDefinition } from '../widgets/registry';
import { PanelChrome } from './PanelChrome';
import { TRANSPARENCY_CYCLE } from './WidgetControls';
import { useStageEmptyText, useStageOutlet } from './stageOutlet';

/** A swipe this long, and at least twice as wide as it is tall, changes the window. */
export const PHONE_SWIPE_MIN_PX = 64;

/**
 * The window a horizontal swipe brings to the front, in the sheet's tile order
 * (left = next, right = previous); `null` for a short or steep swipe and at
 * either end — there is no wrap-around.
 */
export function phoneSwipeTarget(order: readonly string[], current: string, dx: number, dy: number): string | null {
  if (Math.abs(dx) < PHONE_SWIPE_MIN_PX || Math.abs(dx) < 2 * Math.abs(dy)) return null;
  const index = order.indexOf(current);
  if (index < 0) return null;
  return order[dx < 0 ? index + 1 : index - 1] ?? null;
}

type SwipeNode = { tagName?: string; parentNode: unknown; getAttribute?: (name: string) => string | null; scrollWidth?: number; clientWidth?: number };
const OWN_GESTURE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'IFRAME', 'CANVAS']);

/**
 * A touch that starts in an editor, a frame, a canvas, the terminal, or
 * anything that scrolls sideways belongs to that content, never to the stage.
 */
export function swipeBelongsToContent(target: unknown, root: unknown): boolean {
  for (let node = target as SwipeNode | null; node && node !== root; node = node.parentNode as SwipeNode | null) {
    if (node.tagName && OWN_GESTURE_TAGS.has(node.tagName.toUpperCase())) return true;
    const editable = node.getAttribute?.('contenteditable');
    if (editable === '' || editable === 'true' || editable === 'plaintext-only') return true;
    if (/(^|\s)xterm(\s|$)/.test(node.getAttribute?.('class') ?? '')) return true;
    if ((node.scrollWidth ?? 0) > (node.clientWidth ?? 0) && typeof window.getComputedStyle === 'function') {
      const overflowX = window.getComputedStyle(node as unknown as Element).overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll') return true;
    }
  }
  return false;
}

/**
 * Layout only: one foreground widget at a time, every other open one kept
 * mounted and hidden. Each window wears the SAME chrome as on the desktop;
 * outlets and their transport lifecycle still belong to StageHost. A
 * horizontal swipe on the foreground window steps through the open windows.
 */
export function PhoneStage() {
  const { agentId, openOrder, byId, phoneForegroundId } = useStageShell();
  const registerPlaceholder = useStageOutlet();
  const emptyText = useStageEmptyText('Open or restore an app from the dock or Apps');
  const layout = useContext(DockLayoutContext);
  const stage = useRef<HTMLDivElement>(null);
  const windows = useRef<{ order: string[]; current: string | null }>({ order: [], current: null });
  windows.current = { order: openOrder.filter((id) => byId[id] && !byId[id].hidden && getWidgetDefinition(byId[id].type)), current: phoneForegroundId };

  // Two passive touch listeners on the stage root, mounted only while Phone
  // renders a window: they never block a scroll, and they read the layout of
  // the touched element's ancestors once per touch start.
  const mounted = Boolean(phoneForegroundId);
  useEffect(() => {
    const root = stage.current;
    if (!root || !agentId) return;
    let start: { x: number; y: number } | null = null;
    const selecting = (): boolean => { const selection = window.getSelection?.(); return Boolean(selection && !selection.isCollapsed); };
    const onStart = (event: TouchEvent): void => {
      const touch = event.touches.length === 1 ? event.touches[0] : undefined;
      start = touch && !selecting() && !swipeBelongsToContent(event.target, root) ? { x: touch.clientX, y: touch.clientY } : null;
    };
    const onEnd = (event: TouchEvent): void => {
      const from = start; start = null;
      const touch = event.changedTouches[0];
      if (!from || !touch || selecting()) return;
      const { order, current } = windows.current;
      const next = current ? phoneSwipeTarget(order, current, touch.clientX - from.x, touch.clientY - from.y) : null;
      if (next) useWorkspaceStore.getState().focusWidget({ agentId, widgetInstanceId: next });
    };
    const onCancel = (): void => { start = null; };
    root.addEventListener('touchstart', onStart, { passive: true });
    root.addEventListener('touchend', onEnd, { passive: true });
    root.addEventListener('touchcancel', onCancel, { passive: true });
    return () => {
      root.removeEventListener('touchstart', onStart);
      root.removeEventListener('touchend', onEnd);
      root.removeEventListener('touchcancel', onCancel);
    };
  }, [agentId, mounted]);

  if (!phoneForegroundId) return <div className="flex h-full items-center justify-center text-sm" style={{ color: 'var(--w-text)' }}>{emptyText}</div>;
  return <div ref={stage} data-phone-stage className="relative h-full w-full min-w-0 min-h-0">
    {openOrder.map(id => {
      const widget = byId[id];
      if (!widget || widget.hidden) return null;
      const active = id === phoneForegroundId;
      const definition = getWidgetDefinition(widget.type);
      if (!definition) return null;
      const mode = definition.chrome?.mode ?? 'toolbar';
      const { level, showCycle } = resolveWidgetLevel({ instance: widget, definition, defaultTransparency: layout.defaultWidgetTransparency });
      return <div key={id} data-phone-window={id} inert={!active || undefined} aria-hidden={!active || undefined} className="h-full w-full" style={{ display: active ? 'block' : 'none' }}>
        <PanelChrome
          windowId={id}
          title={widget.title}
          subtitle={mode === 'toolbar' ? widget.type : undefined}
          mode={mode}
          level={level}
          contentClassName={definition.chrome?.contentClassName}
          onClose={agentId ? () => useWorkspaceStore.getState().minimizeWidget({ agentId, widgetInstanceId: id }) : undefined}
          onCycleTransparency={showCycle && agentId ? () => useWorkspaceStore.getState().setWidgetTransparency({ agentId, widgetInstanceId: id, level: TRANSPARENCY_CYCLE[level] }) : undefined}
        >
          <div ref={element => registerPlaceholder(id, element)} className="h-full w-full" />
        </PanelChrome>
      </div>;
    })}
  </div>;
}
