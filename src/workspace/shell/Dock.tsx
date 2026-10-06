'use client';

import type { ReactNode, CSSProperties, ComponentType, DragEvent, KeyboardEvent } from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BrushCleaning, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Plus, Trash2, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useDockEditing } from '../store/selectors';
import type { DockPrefs } from '../store/types';
import { applyDockPrefs, draftFromItems, dropPlacement, extendDraft, moveDockKey, setDockKeyHidden, stepDockKey } from './dockOrder';
import { DockBadge } from './DockBadge';
import type { DockMode } from './dockMode';
import { dockModeHasLabels, dockModeIsPinned } from './dockMode';
import { DockModeSwitch } from './DockModeSwitch';
import { useDockHover } from './useDockHover';
import type { DockEdge, DockPlacement } from './dockPlacement';
import { dockTrackSize, isDockHorizontal } from './dockPlacement';
import { DockScrollContainer } from './DockScrollContainer';
import type { TransparencyLevel } from '../store/types';
import { DockTransparencyProvider, dockSurface, useDockTransparency, type DockSurfaceState } from './dockSurface';

// ─── Types ─────────────────────────────────────────────────────────────────

export type DockItem = {
  id: string;
  position: number;
  title: string;
  icon: ComponentType<{ className?: string; style?: CSSProperties }>;
  onClick: () => void;
  onDoubleClick?: () => void;
  disabled?: boolean;
  /** When true the item renders with the active highlight (e.g. its widget is open). */
  active?: boolean;
  /**
   * When true (and not `active`), the item renders the "minimized" affordance
   * — a coloured inset ring instead of the filled open highlight — signalling
   * its widget is closed-into-the-dock but preserved (restorable on click).
   */
  minimized?: boolean;
  /**
   * The always-visible clean action (a broom glyph, right-middle — the top-right
   * corner belongs to the unread badge). Present when the item owns at least
   * one widget instance whose CLIENT store can be cleaned (the instances are
   * destroyed and their local state dropped — server data is untouched).
   * Distinct from the primary click, which opens/restores.
   */
  onClean?: () => void;
  color?: string;
  /** 'header' items render before the mode switch, 'main' items after. Default: 'main'. */
  section?: 'header' | 'main';
  /**
   * Item kind. 'separator' items render as a thin dividing line / gap
   * between groups (e.g. between first-party and trusted package docks).
   * Default: 'item'.
   */
  kind?: 'item' | 'separator';
  /** Where the icon sits relative to the label. Default: 'left'. */
  iconAlign?: 'left' | 'right';
  renderCustom?: () => ReactNode;
  /**
   * The arrangement key (`dockOrder.ts`). Present ⇒ the item can be moved and
   * hidden in edit mode; absent ⇒ FIXED (headers, Layout, Create agent).
   */
  prefKey?: string;
  /** Reordering stays inside one group (trust tier / own vs other agents). */
  group?: string;
  /** Hidden by the user's arrangement — rendered only in the edit-mode tray. */
  hidden?: boolean;
  /**
   * `<packageId>:<dockId>` from the MANIFEST package id the dock surface
   * carries (never the wire event type's prefix) — the counts' `byDock` key
   * the unread badge reads. Package items only.
   */
  badgeKey?: string;
};

type DockProps = {
  dockId: 'primary' | 'secondary';
  placement: DockPlacement;
  mode: DockMode;
  onChangeMode: (mode: DockMode) => void;
  items: DockItem[];
  disabled?: boolean;
  /** External open signal (e.g. from shared hover on same-edge docks). */
  forceOpen?: boolean;
  /** When true, Dock won't render its own fixed trigger zone (parent handles it). */
  skipTriggerZone?: boolean;
  /** Dock chrome transparency (Layout settings → "Dock:"). Default 'opaque'. */
  transparency?: TransparencyLevel;
};

// ─── Helpers ───────────────────────────────────────────────────────────────

export function triggerZoneClass(edge: DockEdge): string {
  switch (edge) {
    case 'left': return 'fixed top-0 bottom-0 left-0 z-20 w-3 bg-transparent hover:bg-white/[0.03]';
    case 'right': return 'fixed top-0 bottom-0 right-0 z-20 w-3 bg-transparent hover:bg-white/[0.03]';
    case 'top': return 'fixed top-0 left-0 right-0 z-20 h-3 bg-transparent hover:bg-white/[0.03]';
    case 'bottom': return 'fixed bottom-0 left-0 right-0 z-20 h-3 bg-transparent hover:bg-white/[0.03]';
  }
}

function dockContainerPositionClass(edge: DockEdge): string {
  switch (edge) {
    case 'left': return 'absolute left-0 top-0 bottom-0 z-30';
    case 'right': return 'absolute right-0 top-0 bottom-0 z-30';
    case 'top': return 'absolute top-0 left-0 right-0 z-30';
    case 'bottom': return 'absolute bottom-0 left-0 right-0 z-30';
  }
}

function hideTransformClass(edge: DockEdge): string {
  switch (edge) {
    case 'left': return '-translate-x-full';
    case 'right': return 'translate-x-full';
    case 'top': return '-translate-y-full';
    case 'bottom': return 'translate-y-full';
  }
}

// ─── Item Button ───────────────────────────────────────────────────────────

function DockSeparator({ horizontal }: { horizontal: boolean }) {
  if (horizontal) {
    return (
      <div className="shrink-0 flex items-center px-1" aria-hidden="true">
        <div className="w-px h-6 bg-white/10" />
      </div>
    );
  }
  return (
    <div className="shrink-0 w-full flex justify-center py-1" aria-hidden="true">
      <div className="h-px w-8 bg-white/10" />
    </div>
  );
}

export function DockItemButton({
  item, hasLabels, pinned, horizontal, edge = 'left', chromeless = false,
}: {
  item: DockItem; hasLabels: boolean; pinned: boolean; horizontal: boolean;
  /** The dock's edge — the badge's popover opens away from it. */
  edge?: DockEdge;
  /** Edit mode: the item alone, without its broom or badge. */
  chromeless?: boolean;
}) {
  // Hook must run before any early return (rules of hooks). Custom/separator
  // items ignore it — their renderers (UserInfo/DockModeSwitch/AgentDockButton)
  // read the same context themselves.
  const level = useDockTransparency();
  const singleClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (singleClickTimer.current) clearTimeout(singleClickTimer.current);
  }, []);
  if (item.kind === 'separator') return <DockSeparator horizontal={horizontal} />;
  if (item.renderCustom) return <>{item.renderCustom()}</>;

  const handleClick = () => {
    if (!item.onDoubleClick) { item.onClick(); return; }
    // Browsers emit click, click, dblclick for a double-click. Defer the single
    // action just long enough for dblclick to cancel it; otherwise a
    // multi-instance widget opens twice before its exclusive action runs.
    if (singleClickTimer.current) clearTimeout(singleClickTimer.current);
    singleClickTimer.current = setTimeout(() => {
      singleClickTimer.current = null;
      item.onClick();
    }, 220);
  };
  const handleDoubleClick = () => {
    if (singleClickTimer.current) {
      clearTimeout(singleClickTimer.current);
      singleClickTimer.current = null;
    }
    item.onDoubleClick?.();
  };

  const iconRight = item.iconAlign === 'right';
  const minimized = Boolean(item.minimized) && !item.active;
  // "More colourful" minimized frame: an inset ring in the item's own dock
  // colour (falls back to indigo) — visually distinct from the filled "open"
  // highlight. Kept at every transparency level.
  const ringColor = item.color || 'rgb(129 140 248)';

  // Transparency-aware surface. `opaque` keeps the exact existing backgrounds.
  const state: DockSurfaceState = item.active ? 'active' : minimized ? 'minimized' : 'default';
  const surf = dockSurface(level, state);
  const opaqueBg = item.active
    ? (pinned ? 'bg-white/20 hover:bg-white/25' : 'bg-neutral-700 hover:bg-neutral-600')
    : minimized
      ? 'bg-white/5 hover:bg-white/10'
      : (pinned ? 'bg-white/12 hover:bg-white/20' : 'bg-neutral-800 hover:bg-neutral-700');

  const button = (
    <button
      type="button"
      onClick={handleClick}
      onDoubleClick={item.onDoubleClick ? handleDoubleClick : undefined}
      disabled={item.disabled}
      className={cn(
        'rounded-xl flex items-center transition shrink-0',
        iconRight ? 'flex-row-reverse' : '',
        horizontal ? 'h-10 px-1' : 'w-full h-10',
        surf ? surf.bg : opaqueBg,
        !horizontal && hasLabels ? 'px-0' : (!horizontal ? 'justify-center' : ''),
        pinned
          ? 'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-white/12'
          : 'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-neutral-800',
      )}
      style={minimized ? { boxShadow: `inset 0 0 0 2px ${ringColor}` } : undefined}
      title={minimized ? `${item.title} (minimized — click to restore)` : item.title}
    >
      <div className={cn(
        'flex items-center justify-center shrink-0',
        horizontal ? 'w-10 h-full' : 'w-12 h-full',
      )}>
        <item.icon className={cn('w-5 h-5', surf?.icon)} style={item.color ? { color: item.color } : undefined} />
      </div>
      {hasLabels ? (
        <div className={cn(
          'min-w-0 line-clamp-2 leading-tight break-words text-[13px] font-semibold tracking-tight',
          item.active ? 'text-white' : 'text-white/70',
          horizontal
            ? (iconRight ? 'pl-2' : 'pr-2')
            : (iconRight ? 'flex-1 text-center pl-3' : 'flex-1 text-center pr-3'),
        )}>
          {item.title}
        </div>
      ) : null}
    </button>
  );

  const showBroom = Boolean(item.onClean) && !chromeless;
  const badgeKey = chromeless ? undefined : item.badgeKey;
  if (!showBroom && !badgeKey) return button;

  // ALWAYS-VISIBLE free broom glyph (no pill background, no hover gating):
  // its presence IS the "this item holds a client store" indicator — it only
  // renders when `onClean` exists, i.e. at least one instance is open. It
  // cleans the widget's CLIENT store (destroys the instances; server data
  // untouched) vs. the primary click which opens/restores. Sibling button
  // (never nested inside the item button); stopPropagation guards bubbling;
  // the 16px button box keeps the hit target sane around the 12px glyph. It
  // sits right-middle; the top-right corner is the unread badge's.
  return (
    <div data-dock-item="" className={cn('relative', !horizontal && 'w-full')}>
      {button}
      {showBroom ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); item.onClean?.(); }}
          className="absolute right-0.5 top-1/2 -translate-y-1/2 z-10 w-4 h-4 flex items-center justify-center text-white/60 hover:text-white transition-colors [filter:drop-shadow(0_0_2px_rgba(0,0,0,0.85))]"
          title={`Clean ${item.title}`}
          aria-label={`Clean ${item.title}`}
        >
          <BrushCleaning className="w-3 h-3" />
        </button>
      ) : null}
      {badgeKey ? (
        <DockBadge target={{ badgeKey, title: item.title, icon: item.icon, color: item.color }} edge={edge} />
      ) : null}
    </div>
  );
}

// ─── Separator with DockModeSwitch ─────────────────────────────────────────

function ModeSwitchSeparator({ mode, pinned, horizontal, disabled, edge, onChangeMode }: {
  mode: DockMode; pinned: boolean; horizontal: boolean; disabled: boolean;
  edge: DockEdge; onChangeMode: (m: DockMode) => void;
}) {
  const switchEl = (
    <DockModeSwitch
      mode={mode}
      pinned={pinned}
      orientation={horizontal ? 'horizontal' : 'vertical'}
      onChangeMode={(m) => { if (!disabled) onChangeMode(m); }}
    />
  );

  if (horizontal) {
    return (
      <div className="flex flex-row items-center shrink-0 px-1 gap-1">
        <div className="flex-1 h-px bg-white/8" />
        <div className="h-8 w-8 flex items-center justify-center shrink-0">{switchEl}</div>
        <div className="flex-1 h-px bg-white/8" />
      </div>
    );
  }

  // Vertical: switch at icon column — left for left-edge, right for right-edge
  return (
    <div className={cn('shrink-0 w-full px-1', edge === 'right' && 'flex justify-end')}>
      <div className="w-12 h-8 flex items-center justify-center">{switchEl}</div>
    </div>
  );
}

// ─── Main Dock Component ───────────────────────────────────────────────────

export function Dock({
  dockId, placement, mode, onChangeMode, items, disabled = false,
  forceOpen = false, skipTriggerZone = false, transparency = 'opaque',
}: DockProps) {
  const pinned = dockModeIsPinned(mode);
  const hasLabels = dockModeHasLabels(mode);
  const horizontal = isDockHorizontal(placement.edge);
  const { open, handlers } = useDockHover(pinned);
  const editing = useDockEditing(dockId);
  // An edited dock stays open even in a hover mode — the pointer leaves it to
  // reach the Layout panel and comes back.
  const isOpen = open || forceOpen || editing;
  const trackSize = dockTrackSize(mode, horizontal);
  const cornerReverse = placement.align === 'end';

  const { headerItems, mainItems } = useMemo(() => {
    const sorted = items.filter((i) => !i.hidden).sort((a, b) => a.position - b.position);
    return {
      headerItems: sorted.filter((i) => i.section === 'header'),
      mainItems: sorted.filter((i) => i.section !== 'header'),
    };
  }, [items]);

  const firstItems = cornerReverse ? mainItems : headerItems;
  const lastItems = cornerReverse ? headerItems : mainItems;

  const modeSwitch = (
    <ModeSwitchSeparator
      mode={mode} pinned={pinned} horizontal={horizontal}
      disabled={disabled} edge={placement.edge} onChangeMode={onChangeMode}
    />
  );

  return (
    <DockTransparencyProvider value={transparency}>
    <div className="relative h-full w-full">
      {!pinned && !skipTriggerZone ? (
        <div
          className={triggerZoneClass(placement.edge)}
          onMouseEnter={handlers.onMouseEnter}
          onMouseLeave={handlers.onMouseLeave}
          aria-hidden="true"
        />
      ) : null}

      <div
        className={cn(
          pinned ? 'relative' : dockContainerPositionClass(placement.edge),
          (pinned || !horizontal) ? 'h-full' : '',
          'flex transition-[transform,opacity] duration-300 ease-out',
          horizontal ? 'flex-row items-center px-1 gap-0' : 'flex-col py-1 gap-0',
          !isOpen && !pinned
            ? `${hideTransformClass(placement.edge)} opacity-0 pointer-events-none`
            : 'translate-x-0 translate-y-0 opacity-100 pointer-events-auto',
        )}
        style={horizontal ? { height: trackSize } : { width: trackSize }}
        onMouseEnter={handlers.onMouseEnter}
        onMouseLeave={handlers.onMouseLeave}
      >
        {editing ? (
          <DockEditor
            dockId={dockId}
            items={items}
            horizontal={horizontal}
            hasLabels={hasLabels}
            pinned={pinned}
            cornerReverse={cornerReverse}
            align={placement.align}
            modeSwitch={modeSwitch}
          />
        ) : horizontal ? (
          <DockScrollContainer align={placement.align}>
            <div className="flex flex-row gap-2 items-center">
              {firstItems.map((item) => (
                <DockItemButton key={item.id} item={item} hasLabels={hasLabels} pinned={pinned} horizontal edge={placement.edge} />
              ))}
              {modeSwitch}
              {lastItems.map((item) => (
                <DockItemButton key={item.id} item={item} hasLabels={hasLabels} pinned={pinned} horizontal edge={placement.edge} />
              ))}
            </div>
          </DockScrollContainer>
        ) : (
          <DockScrollContainer orientation="vertical">
            {firstItems.length > 0 && (
              <div className="w-full flex flex-col gap-2 px-1">
                {firstItems.map((item) => (
                  <DockItemButton key={item.id} item={item} hasLabels={hasLabels} pinned={pinned} horizontal={false} edge={placement.edge} />
                ))}
              </div>
            )}
            {modeSwitch}
            {lastItems.length > 0 && (
              <div className="w-full flex flex-col gap-2 px-1">
                {lastItems.map((item) => (
                  <DockItemButton key={item.id} item={item} hasLabels={hasLabels} pinned={pinned} horizontal={false} edge={placement.edge} />
                ))}
              </div>
            )}
          </DockScrollContainer>
        )}
      </div>
    </div>
    </DockTransparencyProvider>
  );
}

// ─── Edit mode (Layout → Edit docks) ───────────────────────────────────────

/**
 * The dock in edit mode. The DRAFT lives here, in component state: dragging,
 * the arrow keys, hiding and the tray re-render this dock alone and write
 * nothing to the workspace store or `localStorage` — Save is the one write
 * (`setDockPrefs` → one persist write), Cancel drops the draft.
 */
export function DockEditor({
  dockId, items, horizontal, hasLabels, pinned, cornerReverse, align, modeSwitch,
}: {
  dockId: 'primary' | 'secondary';
  items: DockItem[];
  horizontal: boolean;
  hasLabels: boolean;
  pinned: boolean;
  cornerReverse: boolean;
  align: DockPlacement['align'];
  modeSwitch: ReactNode;
}) {
  const [draft, setDraft] = useState<DockPrefs>(() => draftFromItems(items));
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [trayOpen, setTrayOpen] = useState(false);
  const dragKeyRef = useRef<string | null>(null);
  const dragStartDraftRef = useRef<DockPrefs | null>(null);
  const live = useMemo(() => extendDraft(draft, items), [draft, items]);
  const arranged = useMemo(() => applyDockPrefs(items, live), [items, live]);
  const groupByKey = useMemo(() => new Map(items.map((item) => [item.prefKey, item.group])), [items]);

  const listRef = useRef<HTMLDivElement | null>(null);
  const offsetsRef = useRef(new Map<string, { x: number; y: number }>());
  const focusKeyRef = useRef<string | null>(null);

  // FLIP: an item that changed place slides from where it was ("the rest close
  // up"). Edit mode only; one rect read per keyed item per arrangement change;
  // offsets are relative to the list, so scrolling the dock is not a move.
  useLayoutEffect(() => {
    const root = listRef.current;
    if (!root) return;
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const origin = root.getBoundingClientRect();
    const next = new Map<string, { x: number; y: number }>();
    for (const el of root.querySelectorAll<HTMLElement>('[data-dock-key]')) {
      const key = el.dataset.dockKey;
      if (!key) continue;
      const rect = el.getBoundingClientRect();
      const at = { x: rect.left - origin.left, y: rect.top - origin.top };
      next.set(key, at);
      const prev = offsetsRef.current.get(key);
      if (reduce || !prev || (prev.x === at.x && prev.y === at.y)) continue;
      el.style.transition = 'none';
      el.style.transform = `translate(${prev.x - at.x}px, ${prev.y - at.y}px)`;
      void el.offsetWidth;
      el.style.transition = 'transform 260ms cubic-bezier(0.2, 0.9, 0.3, 1.2)';
      el.style.transform = '';
    }
    offsetsRef.current = next;
    const focusKey = focusKeyRef.current;
    if (focusKey) {
      focusKeyRef.current = null;
      for (const el of root.querySelectorAll<HTMLElement>('[data-dock-handle]')) {
        if (el.dataset.dockHandle === focusKey) { el.focus(); break; }
      }
    }
  }, [arranged]);

  const endEditing = (): void => {
    useWorkspaceStore.getState().setDockEditing(dockId, false);
  };
  const save = (): void => {
    useWorkspaceStore.getState().setDockPrefs({ dockId, prefs: live });
    endEditing();
  };

  const startDrag = (event: DragEvent<HTMLDivElement>, key: string): void => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', key);
    dragKeyRef.current = key;
    dragStartDraftRef.current = live;
    // After the browser has taken the drag image — the slot turns into a gap.
    window.setTimeout(() => { if (dragKeyRef.current === key) setDragKey(key); }, 0);
  };
  const dragOver = (event: DragEvent<HTMLDivElement>, target: DockItem): void => {
    const key = dragKeyRef.current;
    if (!key || !target.prefKey || groupByKey.get(key) !== target.group) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const place = dropPlacement(event.currentTarget.getBoundingClientRect(), { x: event.clientX, y: event.clientY }, horizontal);
    const targetKey = target.prefKey;
    setDraft((d) => moveDockKey(extendDraft(d, items), items, key, targetKey, place));
  };
  const endDrag = (event: DragEvent<HTMLDivElement>): void => {
    // Dropped outside the dock (or Escape): the item goes back where it was.
    if (event.dataTransfer.dropEffect === 'none' && dragStartDraftRef.current) setDraft(dragStartDraftRef.current);
    dragKeyRef.current = null;
    dragStartDraftRef.current = null;
    setDragKey(null);
  };
  const drop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    dragKeyRef.current = null;
    dragStartDraftRef.current = null;
    setDragKey(null);
  };
  const step = (key: string, delta: -1 | 1): void => {
    focusKeyRef.current = key;
    setDraft((d) => stepDockKey(extendDraft(d, items), items, key, delta));
  };
  const hide = (key: string): void => setDraft((d) => setDockKeyHidden(extendDraft(d, items), key, true));
  const restore = (key: string): void => setDraft((d) => setDockKeyHidden(extendDraft(d, items), key, false));

  const shown = arranged.filter((item) => !item.hidden);
  const headerItems = shown.filter((item) => item.section === 'header');
  const mainItems = shown.filter((item) => item.section !== 'header');
  const firstItems = cornerReverse ? mainItems : headerItems;
  const lastItems = cornerReverse ? headerItems : mainItems;
  const hiddenItems = arranged.filter((item) => item.hidden && item.prefKey);

  const renderItem = (item: DockItem): ReactNode => (item.prefKey ? (
    <EditableDockItem
      key={item.id}
      item={item}
      hasLabels={hasLabels}
      pinned={pinned}
      horizontal={horizontal}
      dragging={dragKey === item.prefKey}
      onDragStart={startDrag}
      onDragOver={dragOver}
      onDragEnd={endDrag}
      onDrop={drop}
      onStep={step}
      onHide={hide}
    />
  ) : (
    <DockItemButton key={item.id} item={item} hasLabels={hasLabels} pinned={pinned} horizontal={horizontal} />
  ));

  const tray = (
    <HiddenTray
      items={hiddenItems}
      open={trayOpen && hiddenItems.length > 0}
      onToggle={() => setTrayOpen((v) => !v)}
      onRestore={restore}
      hasLabels={hasLabels}
      horizontal={horizontal}
    />
  );
  const bar = <DockEditBar onSave={save} onCancel={endEditing} hasLabels={hasLabels} horizontal={horizontal} />;

  if (horizontal) {
    return (
      <>
        <DockScrollContainer align={align}>
          <div ref={listRef} className="flex flex-row gap-2 items-center">
            {firstItems.map(renderItem)}
            {modeSwitch}
            {lastItems.map(renderItem)}
            {tray}
          </div>
        </DockScrollContainer>
        {bar}
      </>
    );
  }
  return (
    <>
      <DockScrollContainer orientation="vertical">
        <div ref={listRef} className="w-full flex flex-col gap-2">
          {firstItems.length > 0 ? (
            <div className="w-full flex flex-col gap-2 px-1">{firstItems.map(renderItem)}</div>
          ) : null}
          {modeSwitch}
          <div className="w-full flex flex-col gap-2 px-1">
            {lastItems.map(renderItem)}
            {tray}
          </div>
        </div>
      </DockScrollContainer>
      {bar}
    </>
  );
}

/**
 * One movable item in edit mode: the item itself, lifted and inert (a click
 * never opens it while editing), a focusable drag handle over it that also
 * takes the arrow keys and Delete, the earlier/later buttons and the trash.
 */
function EditableDockItem({
  item, hasLabels, pinned, horizontal, dragging, onDragStart, onDragOver, onDragEnd, onDrop, onStep, onHide,
}: {
  item: DockItem;
  hasLabels: boolean;
  pinned: boolean;
  horizontal: boolean;
  dragging: boolean;
  onDragStart: (event: DragEvent<HTMLDivElement>, key: string) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>, item: DockItem) => void;
  onDragEnd: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onStep: (key: string, delta: -1 | 1) => void;
  onHide: (key: string) => void;
}) {
  const key = item.prefKey as string;
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); onStep(key, -1); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); onStep(key, 1); }
    else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); onHide(key); }
  };
  const Earlier = horizontal ? ChevronLeft : ChevronUp;
  const Later = horizontal ? ChevronRight : ChevronDown;
  return (
    <div
      data-dock-key={key}
      draggable
      onDragStart={(event) => onDragStart(event, key)}
      onDragOver={(event) => onDragOver(event, item)}
      onDragEnd={onDragEnd}
      onDrop={onDrop}
      className={cn('relative shrink-0 rounded-xl', !horizontal && 'w-full')}
    >
      <div
        inert
        className={cn(
          'rounded-xl motion-safe:transition-[transform,box-shadow,opacity] motion-safe:duration-200',
          dragging ? 'opacity-0' : 'scale-[1.04] shadow-lg shadow-black/50',
        )}
      >
        <DockItemButton item={item} hasLabels={hasLabels} pinned={pinned} horizontal={horizontal} chromeless />
      </div>
      {dragging ? (
        <div className="absolute inset-0 rounded-xl border border-dashed border-white/30 bg-white/[0.03]" aria-hidden="true" />
      ) : null}
      <div
        role="button"
        tabIndex={0}
        data-dock-handle={key}
        aria-label={`Move ${item.title}`}
        title={`${item.title} — drag to move, or use the arrow keys; Delete hides it`}
        onKeyDown={onKeyDown}
        className="absolute inset-0 z-10 rounded-xl cursor-grab active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      />
      {dragging ? null : (
        <>
          <div className={cn('absolute z-20 flex', horizontal ? 'left-0.5 bottom-0 flex-row' : 'left-0 top-1/2 -translate-y-1/2 flex-col')}>
            <button
              type="button"
              tabIndex={-1}
              onClick={() => onStep(key, -1)}
              className="w-3.5 h-3.5 flex items-center justify-center rounded text-white/45 hover:text-white hover:bg-white/10 transition-colors"
              aria-label={`Move ${item.title} earlier`}
              title="Move earlier"
            >
              <Earlier className="w-3 h-3" />
            </button>
            <button
              type="button"
              tabIndex={-1}
              onClick={() => onStep(key, 1)}
              className="w-3.5 h-3.5 flex items-center justify-center rounded text-white/45 hover:text-white hover:bg-white/10 transition-colors"
              aria-label={`Move ${item.title} later`}
              title="Move later"
            >
              <Later className="w-3 h-3" />
            </button>
          </div>
          <button
            type="button"
            tabIndex={-1}
            onClick={() => onHide(key)}
            className="absolute -top-1 -right-1 z-20 w-4 h-4 rounded-full flex items-center justify-center bg-rose-500/90 text-white shadow-md ring-1 ring-black/40 hover:bg-rose-400 transition-colors"
            aria-label={`Hide ${item.title}`}
            title={`Hide ${item.title}`}
          >
            <Trash2 className="w-2.5 h-2.5" />
          </button>
        </>
      )}
    </div>
  );
}

/** The dashed "+ hidden" tile at the end of the dock and, opened, the hidden items to bring back. */
function HiddenTray({
  items, open, onToggle, onRestore, hasLabels, horizontal,
}: {
  items: DockItem[];
  open: boolean;
  onToggle: () => void;
  onRestore: (key: string) => void;
  hasLabels: boolean;
  horizontal: boolean;
}) {
  const count = items.length;
  const wide = hasLabels || horizontal;
  return (
    <>
      <button
        type="button"
        onClick={onToggle}
        disabled={count === 0}
        aria-expanded={open}
        className={cn(
          'shrink-0 rounded-xl border border-dashed border-white/25 text-white/55 flex items-center justify-center gap-1.5 transition-colors',
          'hover:text-white hover:border-white/50 disabled:opacity-35 disabled:cursor-default disabled:hover:text-white/55 disabled:hover:border-white/25',
          horizontal ? 'h-10 px-3' : 'w-full h-10',
        )}
        title={count > 0 ? `${count} hidden — show them` : 'Nothing hidden'}
      >
        <Plus className="w-4 h-4 shrink-0" />
        {wide ? (
          <span className="text-[12px] font-medium">{count > 0 ? `${count} hidden` : 'Hidden'}</span>
        ) : (
          <span className="text-[11px] tabular-nums">{count}</span>
        )}
      </button>
      {open ? items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => { if (item.prefKey) onRestore(item.prefKey); }}
          className={cn(
            'shrink-0 rounded-xl border border-dashed border-white/20 bg-white/[0.03] flex items-center opacity-70 hover:opacity-100 hover:border-white/45 transition',
            horizontal ? 'h-10 px-1' : 'w-full h-10',
            !hasLabels && 'justify-center',
          )}
          aria-label={`Show ${item.title}`}
          title={`Show ${item.title}`}
        >
          <span className={cn('flex items-center justify-center shrink-0', horizontal ? 'w-10' : 'w-12')}>
            <item.icon className="w-5 h-5" style={item.color ? { color: item.color } : undefined} />
          </span>
          {hasLabels ? <span className="min-w-0 truncate pr-3 text-[12px] text-white/70">{item.title}</span> : null}
        </button>
      )) : null}
    </>
  );
}

/** Save / Cancel at the end of a dock in edit mode. */
function DockEditBar({
  onSave, onCancel, hasLabels, horizontal,
}: { onSave: () => void; onCancel: () => void; hasLabels: boolean; horizontal: boolean }) {
  const wide = hasLabels || horizontal;
  return (
    <div className={cn('shrink-0 flex gap-1', horizontal ? 'flex-row items-center pl-2' : 'flex-col px-1 pt-2 mt-1 border-t border-white/10')}>
      <button
        type="button"
        onClick={onSave}
        className={cn(
          'rounded-lg flex items-center justify-center gap-1.5 bg-[#cba6f7] text-neutral-950 hover:brightness-110 text-[12px] font-semibold transition',
          horizontal ? 'h-8 px-3' : 'w-full h-8',
        )}
        title="Save this dock's order"
        aria-label="Save dock order"
      >
        <Check className="w-3.5 h-3.5" />
        {wide ? 'Save' : null}
      </button>
      <button
        type="button"
        onClick={onCancel}
        className={cn(
          'rounded-lg flex items-center justify-center gap-1.5 bg-white/10 text-white/70 hover:bg-white/15 hover:text-white text-[12px] font-medium transition',
          horizontal ? 'h-8 px-3' : 'w-full h-8',
        )}
        title="Discard the changes"
        aria-label="Cancel dock editing"
      >
        <X className="w-3.5 h-3.5" />
        {wide ? 'Cancel' : null}
      </button>
    </div>
  );
}
