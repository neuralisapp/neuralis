'use client';

import type { ReactNode, CSSProperties, ComponentType, DragEvent, KeyboardEvent, PointerEvent } from 'react';
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BrushCleaning, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, GripVertical, Plus, RectangleHorizontal, RectangleVertical, RotateCw, Trash2, X } from 'lucide-react';
import { createFrameLoop, type FrameLoop } from './frameLoop';
import { cn } from '@/lib/cn';
import { newGroupId, useWorkspaceStore } from '../store/workspaceStore';
import { useAgentsState, useDockEditing, usePresentation, useProjectGroups } from '../store/selectors';
import type { DockPrefs, WorkspaceGroup } from '../store/types';
import { applyDockPrefs, draftFromItems, dropPlacement, extendDraft, moveDockKey, setDockKeyHidden, stepDockKey } from './dockOrder';
import { DockBadge } from './DockBadge';
import { popoverPosition } from './NotificationPopover';
import { AppGlyph } from '../packages/PackageAppIcon';
import type { PackageAppImage } from '../packages/dockRuntime';
import { createPortal } from 'react-dom';
import type { DockMode } from './dockMode';
import { dockModeHasLabels, dockModeIsPinned } from './dockMode';
import { DockModeSwitch } from './DockModeSwitch';
import { useDockHover } from './useDockHover';
import {
  DOCK_ANCHORS, anchorCell, dockAlign, dockEdge, dockHorizontal, dockTrackSize, dragPlacement, flipOrientation, nearestDockAnchor,
  type DockAnchor, type DockEdge, type DockOrientation, type DockPlacement,
} from './dockPlacement';
import { ThemeContext, themeScopeStyle } from '../theme/ThemeContext';
import { DEFAULT_THEME } from '../theme/themes';
import { DockScrollContainer } from './DockScrollContainer';
import type { TransparencyLevel } from '../store/types';
import { DockTransparencyProvider, dockCapsuleStyle, dockSurface, useDockTransparency, type DockSurfaceState } from './dockSurface';
import { CONTROL_SURFACE, CONTROL_SURFACE_THEME_ID } from './widgetSurface';

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
  /**
   * 'header' items render before the mode switch, 'main' items after. A
   * 'footer' item rides OUTSIDE the scroller, right after its end arrow, so it
   * is reachable without scrolling in every dock mode (the live dock only —
   * the edit draft and the Phone grid keep plain position order). Default: 'main'.
   */
  section?: 'header' | 'main' | 'footer';
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
  /**
   * The open windows of this app (several ⇒ a click opens the window chooser
   * instead of acting). Each row restores/focuses its window; its broom cleans
   * that ONE window's view state.
   */
  windows?: DockWindowChoice[];
  /** The package's declared picture (the glyph `icon` stays its fallback). */
  image?: PackageAppImage;
  /** "New window": present when the app allows repeated windows and one can be opened. */
  onNewWindow?: () => void;
  /**
   * The agent tile: the chooser opens ONLY on a click of the ACTIVE item (even
   * with one window) — a click on any other agent selects it, however many
   * chat windows it has; a click on the selected agent asks which of its chat
   * windows (or a new one).
   */
  chooserWhenActive?: boolean;
};

/** Does a click on this item open its window chooser (rather than act)? The ONE rule the dock and the Phone sheet read. */
export function opensWindowChooser(item: Pick<DockItem, 'windows' | 'onNewWindow' | 'active' | 'chooserWhenActive'>): boolean {
  const count = item.windows?.length ?? 0;
  if (item.chooserWhenActive) return Boolean(item.active && (count > 0 || item.onNewWindow));
  return count > 1;
}

/** One row of a dock item's window chooser. */
export type DockWindowChoice = {
  id: string;
  /** `Title · Agent` — the window's bound agent always named. */
  label: string;
  minimized: boolean;
  onSelect: () => void;
  onClean: () => void;
};

type DockProps = {
  dockId: 'primary' | 'secondary';
  placement: DockPlacement;
  mode: DockMode;
  onChangeMode: (mode: DockMode) => void;
  items: DockItem[];
  disabled?: boolean;
  /** The shared hover state of the dock's `DockCluster`; a pinned dock ignores it. */
  open?: boolean;
  /** Dock chrome transparency (Layout → Appearance "Docks" material). Default 'opaque'. */
  transparency?: TransparencyLevel;
  background?: 'classic' | 'toolbar';
  /** This dock's side of a joined toolbar pair. */
  join?: 'start' | 'end';
  /** A scrim over the dock while the package snapshot loads. */
  loading?: boolean;
  /** `source` is `'drag'` for a drop, so the shell can show the rotate control after it. */
  onPlacement?: (placement: DockPlacement, source?: 'drag') => void;
  /** The rotate control stays visible beside the grip (set by the shell right after a drop). */
  rotateHint?: boolean;
  /** Where a drag in progress would land; `null` when it ends. */
  onPreview?: (placement: DockPlacement | null) => void;
};


// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * A cluster's hover trigger: a strip on the edge the dock touches, exactly as
 * long as the dock itself (never the whole screen edge), reaching past the
 * shell padding to the screen edge.
 */
export function triggerZoneClass(edge: DockEdge): string {
  const base = 'absolute pointer-events-auto bg-transparent hover:bg-white/[0.03]';
  switch (edge) {
    case 'left': return `${base} -left-1 top-0 bottom-0 w-4`;
    case 'right': return `${base} -right-1 top-0 bottom-0 w-4`;
    case 'top': return `${base} -top-1 left-0 right-0 h-4`;
    case 'bottom': return `${base} -bottom-1 left-0 right-0 h-4`;
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

/**
 * A hidden dock's edge indicator: a 3 px bar inside its trigger strip, as long
 * as the dock's own section, centred in the strip — CSS only, no listener.
 */
function edgeIndicatorClass(edge: DockEdge): string {
  const base = 'absolute rounded-full pointer-events-none motion-safe:transition-opacity motion-safe:duration-200';
  return edge === 'left' || edge === 'right'
    ? `${base} top-2 bottom-2 left-1/2 w-[3px] -translate-x-1/2`
    : `${base} left-2 right-2 top-1/2 h-[3px] -translate-y-1/2`;
}

/** The position popover opens away from the dock's edge, beside its grip. */
function pickerPositionClass(edge: DockEdge): string {
  switch (edge) {
    case 'left': return 'left-full top-0 ml-2';
    case 'right': return 'right-full top-0 mr-2';
    case 'top': return 'top-full left-0 mt-2';
    case 'bottom': return 'bottom-full left-0 mb-2';
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
  const [chooser, setChooser] = useState<DOMRect | null>(null);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => () => {
    if (singleClickTimer.current) clearTimeout(singleClickTimer.current);
  }, []);
  if (item.kind === 'separator') return <DockSeparator horizontal={horizontal} />;
  if (item.renderCustom) return <>{item.renderCustom()}</>;

  // Several windows of this app: the click asks which one (zero → open the
  // first, one → bring it forward, both through `onClick`).
  const act = (): void => {
    if (opensWindowChooser(item) && anchorRef.current) { setChooser(anchorRef.current.getBoundingClientRect()); return; }
    item.onClick();
  };
  const handleClick = () => {
    if (!item.onDoubleClick) { act(); return; }
    // Browsers emit click, click, dblclick for a double-click. Defer the single
    // action just long enough for dblclick to cancel it; otherwise a
    // multi-instance widget opens twice before its exclusive action runs.
    if (singleClickTimer.current) clearTimeout(singleClickTimer.current);
    singleClickTimer.current = setTimeout(() => {
      singleClickTimer.current = null;
      act();
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

  // Transparency-aware surface consumes the scoped dock palette at every level.
  const state: DockSurfaceState = item.active ? 'active' : minimized ? 'minimized' : 'default';
  const surf = dockSurface(level, state);

  const button = (
    <button
      ref={anchorRef}
      type="button"
      onClick={handleClick}
      aria-haspopup={opensWindowChooser(item) ? 'dialog' : undefined}
      onDoubleClick={item.onDoubleClick ? handleDoubleClick : undefined}
      disabled={item.disabled}
      className={cn(
        'rounded-xl flex items-center transition shrink-0',
        iconRight ? 'flex-row-reverse' : '',
        horizontal ? 'h-10 px-1' : 'w-full h-10',
        surf.bg,
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
        <AppGlyph image={item.image} icon={item.icon} size={item.section === 'footer' ? 24 : 20} className={cn(item.section === 'footer' ? 'w-6 h-6' : 'w-5 h-5', surf.icon)} style={item.color ? { color: item.color } : undefined} />
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
  const chooserPanel = chooser ? (
    <DockWindowChooser item={item} anchor={chooser} edge={edge} onClose={() => setChooser(null)} />
  ) : null;
  if (!showBroom && !badgeKey) return <>{button}{chooserPanel}</>;

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
        <DockBadge target={{ badgeKey, title: item.title, icon: item.icon, image: item.image, color: item.color }} edge={edge} />
      ) : null}
      {chooserPanel}
    </div>
  );
}

/**
 * The window chooser of an app with several open windows: beside the dock
 * item, on the fixed control material (never the widget theme — it sits over
 * open windows). A row brings its window forward; its broom cleans that ONE
 * window's view state (the window stays); "New window" opens another.
 */
export function DockWindowChooser({ item, anchor, edge, onClose }: {
  item: Pick<DockItem, 'title' | 'windows' | 'onNewWindow'>;
  anchor: DOMRect;
  edge: DockEdge;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { panelRef.current?.querySelector<HTMLElement>('[data-window-choice]')?.focus(); }, []);
  // Escape closes it wherever focus is (a mouse open may leave focus on the dock):
  // one window listener, only while the chooser is mounted.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const position = popoverPosition(anchor, edge, { width: window.innerWidth, height: window.innerHeight });
  return createPortal(
    <>
      <div className="fixed inset-0" style={{ zIndex: 9998 }} onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-label={`${item.title} windows`}
        data-theme-id={CONTROL_SURFACE_THEME_ID}
        className="fixed w-64 overflow-y-auto rounded-xl border p-1 shadow-2xl shadow-black/60"
        style={{ ...CONTROL_SURFACE, ...position, zIndex: 9999 }}
      >
        <div className="px-2 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-white/40">{item.title} windows</div>
        {(item.windows ?? []).map((w) => (
          <div key={w.id} className="relative">
            <button
              type="button"
              data-window-choice=""
              onClick={() => { w.onSelect(); onClose(); }}
              className="flex w-full items-center gap-2 rounded-lg py-1.5 pl-2 pr-8 text-left text-sm text-white/80 transition hover:bg-white/8 hover:text-white"
              title={w.minimized ? `${w.label} (minimized)` : w.label}
            >
              <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', w.minimized ? 'ring-1 ring-white/50' : 'bg-white/70')} aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{w.label}</span>
            </button>
            <button
              type="button"
              onClick={(event) => { event.stopPropagation(); w.onClean(); }}
              className="absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-white/45 transition hover:bg-white/8 hover:text-white"
              title={`Clean this window — ${w.label}`}
              aria-label={`Clean this window — ${w.label}`}
            >
              <BrushCleaning className="h-3 w-3" />
            </button>
          </div>
        ))}
        {item.onNewWindow ? (
          <button
            type="button"
            onClick={() => { item.onNewWindow?.(); onClose(); }}
            className="mt-1 flex w-full items-center gap-2 rounded-lg border-t border-white/10 px-2 py-1.5 text-left text-sm text-white/70 transition hover:bg-white/8 hover:text-white"
          >
            <Plus className="h-3.5 w-3.5 shrink-0" />
            New window
          </button>
        ) : null}
      </div>
    </>,
    document.body,
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

// ─── Position picker ───────────────────────────────────────────────────────

const MAP_X = { left: '14%', center: '50%', right: '86%' } as const;
const MAP_Y = { top: '18%', middle: '50%', bottom: '82%' } as const;

/**
 * A small screen map: the eight anchors (no centre) and the two orientations.
 * The dock grip opens it beside the dock; the Layout panel shows one per dock.
 */
export function DockPositionPicker({ value, onChange, label }: {
  value: { anchor: DockAnchor; orientation: DockOrientation };
  onChange: (next: { anchor: DockAnchor; orientation: DockOrientation }) => void;
  label: string;
}) {
  const orientationButton = (orientation: DockOrientation) => {
    const Icon = orientation === 'horizontal' ? RectangleHorizontal : RectangleVertical;
    const active = value.orientation === orientation;
    return (
      <button
        type="button"
        aria-label={orientation === 'horizontal' ? 'Horizontal' : 'Vertical'}
        aria-pressed={active}
        title={orientation === 'horizontal' ? 'Horizontal' : 'Vertical'}
        onClick={() => onChange({ anchor: value.anchor, orientation })}
        className={cn('w-7 h-7 rounded-md flex items-center justify-center transition-colors', active ? 'bg-white/15' : 'opacity-60 hover:opacity-100 hover:bg-white/10')}
      >
        <Icon className="w-4 h-4" />
      </button>
    );
  };
  return (
    <div role="group" aria-label={label} className="flex items-center gap-2" style={{ color: 'var(--w-text)' }}>
      <div className="relative w-24 h-16 shrink-0 rounded-md border" style={{ borderColor: 'var(--control-border)' }}>
        {DOCK_ANCHORS.map((anchor) => {
          const { row, col } = anchorCell(anchor);
          const active = anchor === value.anchor;
          return (
            <button
              key={anchor}
              type="button"
              aria-label={`Anchor ${anchor}`}
              aria-pressed={active}
              title={anchor}
              onClick={() => onChange({ anchor, orientation: value.orientation })}
              className="absolute w-5 h-5 -translate-x-1/2 -translate-y-1/2 rounded-full flex items-center justify-center hover:bg-white/10"
              style={{ left: MAP_X[col], top: MAP_Y[row] }}
            >
              <span className={cn('block rounded-full', active ? 'w-3 h-3 bg-[#cba6f7]' : 'w-2 h-2 bg-current opacity-40')} />
            </button>
          );
        })}
      </div>
      <div className="flex flex-col gap-1">
        {orientationButton('horizontal')}
        {orientationButton('vertical')}
      </div>
    </div>
  );
}

// ─── Cluster: one anchor, its docks, their ONE hover trigger ───────────────

/**
 * One or two docks on the same anchor and orientation, one after the other —
 * never on top of each other. It owns the hover state they share and their
 * ONE trigger strip, and is pointer-transparent itself, so only a trigger or
 * an open dock takes a click.
 */
export function DockCluster({ edge, horizontal, hover, className, children }: {
  edge: DockEdge;
  horizontal: boolean;
  /** At least one dock here hides until hovered. */
  hover: boolean;
  className?: string;
  children: (open: boolean) => ReactNode;
}) {
  const { open, handlers } = useDockHover(!hover);
  const dockTheme = useContext(ThemeContext)?.dockTheme ?? DEFAULT_THEME;
  return (
    <div
      data-dock-cluster=""
      className={cn('relative flex min-h-0 min-w-0 pointer-events-none', horizontal ? 'flex-row' : 'flex-col', className)}
      onMouseEnter={handlers.onMouseEnter}
      onMouseLeave={handlers.onMouseLeave}
      onFocus={handlers.onMouseEnter}
      onBlur={handlers.onMouseLeave}
    >
      {hover ? (
        <div aria-hidden="true" className={triggerZoneClass(edge)}>
          {/* Where the hidden dock lives; gone while it is revealed. Wears the dock theme's tone. */}
          <span
            data-dock-edge-indicator=""
            className={cn(edgeIndicatorClass(edge), open ? 'opacity-0' : 'opacity-100')}
            style={{ ...themeScopeStyle(dockTheme), backgroundColor: 'rgba(var(--surface-tone-rgb), 0.35)' }}
          />
        </div>
      ) : null}
      {children(open)}
    </div>
  );
}

// ─── Phone: the dock sheet ─────────────────────────────────────────────────

/** A drag down the sheet's handle further than this closes it. */
export const SHEET_DISMISS_DRAG_PX = 80;
/**
 * The Phone launcher band under the stage: its row and the bottom safe area.
 * The open sheet ends ABOVE it, so the launcher stays tappable to close it.
 */
export const PHONE_LAUNCHER_ROW = '2.5rem';
export const PHONE_SAFE_BOTTOM = 'max(4px, env(safe-area-inset-bottom))';

/**
 * One dock as an icon grid inside the Phone sheet: the desktop item visuals
 * (icon tile, avatar, badge) with a one-line label under each. The broom sits
 * in the tile's corner on a 32 px hit area that does not enlarge the glyph.
 * An app or agent tap acts and closes the sheet; the header items (account,
 * project) open their own popups and keep it.
 */
function PhoneDockGrid({ dockId, label, items, onAct }: { dockId: 'primary' | 'secondary'; label: string; items: DockItem[]; onAct: () => void }) {
  const editing = useDockEditing(dockId);
  const tiles = useMemo(() => items.filter((i) => !i.hidden && i.kind !== 'separator').sort((a, b) => a.position - b.position), [items]);
  // An app with several windows (or the selected agent) asks which one, as a row of tiles in the sheet.
  const [choosing, setChoosing] = useState<string | null>(null);
  const chosen = choosing ? tiles.find((i) => i.id === choosing && opensWindowChooser(i)) ?? null : null;
  return (
    <section aria-label={label} className="flex flex-col gap-2">
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-white/40">{label}</h4>
      {editing ? (
        <DockEditor dockId={dockId} items={items} horizontal={false} hasLabels pinned cornerReverse={false} modeSwitch={null} groupPanel="inline" />
      ) : (
        <div className="grid grid-cols-4 gap-x-2 gap-y-3">
          {tiles.map((item) => {
            const several = opensWindowChooser(item);
            const tile = item.renderCustom
              ? item.renderCustom()
              : <DockItemButton item={{ ...item, onDoubleClick: undefined, windows: undefined, chooserWhenActive: undefined, ...(several ? { onClick: () => setChoosing(item.id) } : {}) }} hasLabels={false} pinned horizontal={false} chromeless />;
            return (
              <div
                key={item.id}
                data-phone-dock-item={item.id}
                className="flex min-w-0 flex-col items-center gap-1"
                // A custom tile (the agent) that asks which window: the sheet's chooser row, never the tile's own act.
                onClickCapture={several && item.renderCustom ? (event) => {
                  if (!(event.target as HTMLElement).closest('[data-dock-tile-act]')) return;
                  event.stopPropagation(); event.preventDefault(); setChoosing(item.id);
                } : undefined}
                onClick={item.section === 'header' || several ? undefined : onAct}
              >
                <div className="relative w-14">
                  {tile}
                  {!item.renderCustom && item.badgeKey ? <DockBadge target={{ badgeKey: item.badgeKey, title: item.title, icon: item.icon, image: item.image, color: item.color }} edge="bottom" /> : null}
                  {!item.renderCustom && item.onClean ? (
                    <button
                      type="button"
                      onClick={(event) => { event.stopPropagation(); item.onClean?.(); }}
                      className="absolute -left-3 -top-3 z-10 flex h-8 w-8 items-center justify-center"
                      title={`Clean ${item.title}`}
                      aria-label={`Clean ${item.title}`}
                    >
                      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-white/70"><BrushCleaning className="h-2.5 w-2.5" /></span>
                    </button>
                  ) : null}
                </div>
                <span className="w-full truncate text-center text-[11px] leading-tight text-white/70">{item.title}</span>
              </div>
            );
          })}
        </div>
      )}
      {chosen && !editing ? (
        <PhoneTileRow label={`${chosen.title} windows`}>
          {(chosen.windows ?? []).map((w) => (
            <PhoneTile key={w.id} label={w.label} icon={chosen.icon} dim={w.minimized} onTap={() => { w.onSelect(); setChoosing(null); onAct(); }} onClean={w.onClean} />
          ))}
          {chosen.onNewWindow ? <PhoneTile label="New window" icon={Plus} onTap={() => { chosen.onNewWindow?.(); setChoosing(null); onAct(); }} /> : null}
        </PhoneTileRow>
      ) : null}
    </section>
  );
}

/** A horizontal, touch-scrollable row of sheet tiles (the Open windows idiom). */
function PhoneTileRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="-mx-1 flex gap-2 overflow-x-auto px-1 pt-1">{children}</div>
  );
}

/** One 72 px sheet tile: icon over a one-line label; an optional corner broom (32 px hit area). */
function PhoneTile({ label, icon: Icon, onTap, selected = false, dim = false, onClean }: {
  label: string;
  icon: ComponentType<{ className?: string; style?: CSSProperties }>;
  onTap: () => void;
  selected?: boolean;
  dim?: boolean;
  onClean?: () => void;
}) {
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-pressed={selected}
        onClick={onTap}
        title={label}
        className={cn('flex w-[72px] flex-col items-center gap-1 rounded-xl px-1 py-2 transition-colors', selected ? 'bg-white/15 ring-1 ring-[#cba6f7]/60' : 'bg-white/5 hover:bg-white/10', dim && 'opacity-60')}
      >
        <Icon className="h-6 w-6" />
        <span className="w-full truncate text-center text-[11px] leading-tight">{label}</span>
      </button>
      {onClean ? (
        <button type="button" aria-label={`Clean this window — ${label}`} onClick={onClean} className="absolute -left-2 -top-2 flex h-8 w-8 items-center justify-center">
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-white/70"><BrushCleaning className="h-2.5 w-2.5" /></span>
        </button>
      ) : null}
    </div>
  );
}

/** The sheet's view choice: per-agent layouts or one of the project's Groups, as tiles. */
function PhoneViewChoices({ onAct }: { onAct: () => void }) {
  const { presentation, groupId, available } = usePresentation();
  const groups = useProjectGroups();
  if (!available) return null;
  const store = useWorkspaceStore.getState;
  return (
    <section aria-label="View" className="flex flex-col gap-2">
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-white/40">View</h4>
      <PhoneTileRow label="Workspace view">
        <PhoneTile label="Per agent" icon={RectangleVertical} selected={presentation === 'agent'} onTap={() => { store().setPresentation('agent'); onAct(); }} />
        {groups.length === 0 ? (
          <PhoneTile label="Group" icon={RectangleHorizontal} selected={false} onTap={() => { store().setPresentation('group'); onAct(); }} />
        ) : groups.map((g) => (
          <PhoneTile key={g.id} label={g.name} icon={RectangleHorizontal} selected={presentation === 'group' && g.id === groupId} onTap={() => { store().selectGroup(g.id); onAct(); }} />
        ))}
      </PhoneTileRow>
    </section>
  );
}

export type PhoneWindow = { id: string; title: string; icon: ComponentType<{ className?: string; style?: CSSProperties }>; foreground: boolean; minimized: boolean };

/**
 * The Phone dock surface: ONE sheet the launcher opens, on the fixed control
 * material. Top: the open windows as a row of tiles (tap = bring to front,
 * × = minimize). Below: each dock as an icon grid. It closes on a tap outside,
 * a drag down, Escape, or the launcher again — there is no Close button.
 */
export function PhoneDockSheet({ windows, onWindow, onMinimize, primaryItems, secondaryItems, onClose }: {
  windows: PhoneWindow[];
  onWindow: (id: string) => void;
  onMinimize: (id: string) => void;
  primaryItems: DockItem[];
  secondaryItems: DockItem[];
  onClose: () => void;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ pointerId: number; y: number } | null>(null);
  useEffect(() => { sheet.current?.focus(); }, []);
  const dragTo = (dy: number): void => { if (sheet.current) sheet.current.style.transform = dy > 0 ? `translateY(${dy}px)` : ''; };
  return (
    <div
      data-phone-sheet-scrim=""
      className="fixed inset-x-0 top-0 z-[90] flex items-end bg-black/40"
      style={{ bottom: `calc(${PHONE_LAUNCHER_ROW} + ${PHONE_SAFE_BOTTOM})` }}
      onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        ref={sheet}
        role="dialog"
        aria-modal="true"
        aria-label="Docks"
        tabIndex={-1}
        data-theme-id={CONTROL_SURFACE_THEME_ID}
        className="flex max-h-[85dvh] w-full flex-col rounded-t-[24px] border-t outline-none"
        style={CONTROL_SURFACE}
        onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}
      >
        <div
          aria-hidden="true"
          className="flex h-6 shrink-0 cursor-grab touch-none items-center justify-center"
          onPointerDown={(event) => { dragStart.current = { pointerId: event.pointerId, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={(event) => { const s = dragStart.current; if (s && s.pointerId === event.pointerId) dragTo(event.clientY - s.y); }}
          onPointerUp={(event) => { const s = dragStart.current; dragStart.current = null; dragTo(0); if (s && event.clientY - s.y > SHEET_DISMISS_DRAG_PX) onClose(); }}
          onPointerCancel={() => { dragStart.current = null; dragTo(0); }}
        >
          <span className="h-1 w-10 rounded-full bg-white/25" />
        </div>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-4 pb-4">
          <section aria-label="Open windows" className="flex flex-col gap-2">
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-white/40">Open windows</h4>
            {windows.length ? (
              <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pt-1">
                {windows.map((w) => (
                  <div key={w.id} className="relative shrink-0">
                    <button
                      type="button"
                      aria-pressed={w.foreground}
                      onClick={() => { onWindow(w.id); onClose(); }}
                      className={cn('flex w-[72px] flex-col items-center gap-1 rounded-xl px-1 py-2 transition-colors', w.foreground ? 'bg-white/15 ring-1 ring-[#cba6f7]/60' : 'bg-white/5 hover:bg-white/10', w.minimized && 'opacity-60')}
                    >
                      <w.icon className="h-6 w-6" />
                      <span className="w-full truncate text-center text-[11px] leading-tight">{w.title}</span>
                    </button>
                    {w.minimized ? null : (
                      <button type="button" aria-label={`Minimize ${w.title}`} onClick={() => onMinimize(w.id)} className="absolute -right-2 -top-2 flex h-7 w-7 items-center justify-center">
                        <span className="flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-white/70"><X className="h-2.5 w-2.5" /></span>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ) : <p className="text-xs text-white/45">No open windows</p>}
          </section>
          <PhoneDockGrid dockId="primary" label="Apps" items={primaryItems} onAct={onClose} />
          <PhoneViewChoices onAct={onClose} />
          <PhoneDockGrid dockId="secondary" label="Agents" items={secondaryItems} onAct={onClose} />
        </div>
      </div>
    </div>
  );
}

// ─── Main Dock Component ───────────────────────────────────────────────────

type DragState = {
  pointerId: number; x: number; y: number; lastX: number; lastY: number; moved: boolean; grip: boolean;
  width: number; height: number; flip: boolean;
};

export function Dock({
  dockId, placement, mode, onChangeMode, items, disabled = false, open = false,
  transparency = 'opaque', background = 'classic', join, loading = false, onPlacement, rotateHint = false, onPreview,
}: DockProps) {
  const pinned = dockModeIsPinned(mode);
  const hasLabels = dockModeHasLabels(mode);
  const horizontal = dockHorizontal(placement);
  const edge = dockEdge(placement);
  const dockTheme = useContext(ThemeContext)?.dockTheme ?? DEFAULT_THEME;
  const editing = useDockEditing(dockId);
  // An edited dock stays open even in a hover mode — the pointer leaves it to
  // reach the Layout panel and comes back.
  const visible = pinned || open || editing;
  const trackSize = dockTrackSize(mode, horizontal);
  const cornerReverse = dockAlign(placement) === 'end';
  const [picker, setPicker] = useState(false);
  const capsule = useRef<HTMLDivElement>(null);
  const gripWrap = useRef<HTMLDivElement>(null);

  // ── Drag to an anchor: ONE frame per pointer burst writes the live offset
  // and the preview; the placement is saved once, on release. ──
  const drag = useRef<DragState | null>(null);
  const frame = useRef<FrameLoop | null>(null);
  const stopResizeWatch = useRef<(() => void) | null>(null);
  const endPreview = (): void => {
    stopResizeWatch.current?.();
    stopResizeWatch.current = null;
    frame.current?.cancel();
    if (capsule.current) { capsule.current.style.transform = ''; capsule.current.style.transition = ''; }
    onPreview?.(null);
  };
  const endPreviewRef = useRef(endPreview);
  endPreviewRef.current = endPreview;
  const rotateRef = useRef<() => void>(() => undefined);
  useEffect(() => () => { drag.current = null; endPreviewRef.current(); }, []);

  const landing = (start: DragState, x: number, y: number): DockPlacement =>
    dragPlacement(placement, nearestDockAnchor(x, y, start.width, start.height), x - start.x, y - start.y, start.flip);

  // ONE frame per burst writes the ghost offset and the preview.
  const showDrag = (start: DragState): void => {
    const loop = (frame.current ??= createFrameLoop(window));
    loop.schedule(() => {
      if (drag.current !== start) return;
      const node = capsule.current;
      if (node) { node.style.transition = 'none'; node.style.transform = `translate(${start.lastX - start.x}px, ${start.lastY - start.y}px)`; }
      onPreview?.(landing(start, start.lastX, start.lastY));
    });
  };
  // R during a drag flips the landing orientation (a keyboard extra; the
  // rotate control beside the grip flips a placed dock).
  const rotate = (): void => {
    const start = drag.current;
    if (!start?.moved) return;
    start.flip = !start.flip;
    showDrag(start);
  };
  rotateRef.current = rotate;

  const pointerStart = (event: PointerEvent<HTMLElement>, grip = false): void => {
    if (!onPlacement || event.button !== 0 || editing) return;
    // On touch only the grip moves a dock: a swipe on the capsule scrolls it.
    if (!grip && event.pointerType === 'touch') return;
    if (!grip && (event.target as HTMLElement).closest('button,a,input,select,textarea,[role="button"],[draggable="true"]')) return;
    drag.current = {
      pointerId: event.pointerId, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY,
      moved: false, grip, width: window.innerWidth, height: window.innerHeight, flip: false,
    };
    const cancelOnResize = (): void => { drag.current = null; endPreviewRef.current(); };
    const rotateOnKey = (key: globalThis.KeyboardEvent): void => { if (key.key === 'r' || key.key === 'R') rotateRef.current(); };
    window.addEventListener('resize', cancelOnResize);
    window.addEventListener('keydown', rotateOnKey);
    stopResizeWatch.current = () => { window.removeEventListener('resize', cancelOnResize); window.removeEventListener('keydown', rotateOnKey); };
    if (grip) event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: PointerEvent<HTMLElement>): void => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const x = event.clientX;
    const y = event.clientY;
    if (!start.moved && Math.hypot(x - start.x, y - start.y) <= 5) return;
    start.moved = true;
    start.lastX = x;
    start.lastY = y;
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.setPointerCapture(event.pointerId);
    showDrag(start);
  };
  const pointerEnd = (event: PointerEvent<HTMLElement>): void => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId) return;
    drag.current = null;
    endPreview();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (start.moved || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) {
      const next = landing(start, event.clientX, event.clientY);
      if (next !== placement) onPlacement?.(next, 'drag');
    } else if (start.grip) setPicker((value) => !value);
  };
  const pointerCancel = (): void => { drag.current = null; endPreview(); };

  // The picker closes on a pointer anywhere outside it — one listener, only
  // while it is open.
  useEffect(() => {
    if (!picker) return;
    const close = (event: Event): void => {
      if (!gripWrap.current?.contains(event.target as Node)) setPicker(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [picker]);

  const { headerItems, mainItems, footerItems } = useMemo(() => {
    const sorted = items.filter((i) => !i.hidden).sort((a, b) => a.position - b.position);
    return {
      headerItems: sorted.filter((i) => i.section === 'header'),
      mainItems: sorted.filter((i) => i.section !== 'header' && i.section !== 'footer'),
      footerItems: sorted.filter((i) => i.section === 'footer'),
    };
  }, [items]);

  const firstItems = cornerReverse ? mainItems : headerItems;
  const lastItems = cornerReverse ? headerItems : mainItems;

  // The footer sits on the main items' outer end: after the scroller, or before
  // it when the dock runs reversed from its corner. `shrink-0`: the scroller is
  // the part that shrinks.
  const footer = footerItems.length > 0 ? (
    <div
      data-dock-footer=""
      className={cn(
        'shrink-0 flex items-center',
        horizontal ? 'flex-row gap-2 px-1' : 'flex-col gap-2 px-1 py-1 w-full',
        horizontal
          ? (cornerReverse ? 'border-r border-white/10 mr-1' : 'border-l border-white/10 ml-1')
          : (cornerReverse ? 'border-b border-white/10 mb-1' : 'border-t border-white/10 mt-1'),
      )}
    >
      {footerItems.map((item) => (
        <DockItemButton key={item.id} item={item} hasLabels={hasLabels} pinned={pinned} horizontal={horizontal} edge={edge} />
      ))}
    </div>
  ) : null;

  const modeSwitch = (
    <ModeSwitchSeparator
      mode={mode} pinned={pinned} horizontal={horizontal}
      disabled={disabled} edge={edge} onChangeMode={onChangeMode}
    />
  );

  // The grip sits IN FLOW at the start of the dock, so it can never cover an item.
  // Its rotate control sits beside it INSIDE the same hover group and in flow
  // (stacked across the dock's thickness, so the dock is no longer), shown on
  // grip hover/focus and for a moment after a drop: the pointer reaches it
  // without leaving the group, and hidden it is not hit-testable while what
  // lies under it is the dock itself — never a widget control.
  const nextOrientation = flipOrientation(placement.orientation);
  const grip = onPlacement ? (
    <div ref={gripWrap} className={cn('group/grip relative shrink-0 flex items-center justify-center', horizontal ? 'flex-col pr-1' : 'flex-row pb-1')}>
      <button
        type="button"
        aria-label={`Move ${dockId} dock`}
        aria-expanded={picker}
        title="Drag to move the dock, or click to choose a position"
        className="w-5 h-5 rounded-md flex items-center justify-center touch-none cursor-grab hover:bg-white/10"
        style={{ color: 'var(--w-text)' }}
        onPointerDown={(event) => { event.stopPropagation(); pointerStart(event, true); }}
        onPointerMove={(event) => { event.stopPropagation(); pointerMove(event); }}
        onPointerUp={(event) => { event.stopPropagation(); pointerEnd(event); }}
        onPointerCancel={pointerCancel}
        onLostPointerCapture={pointerCancel}
        onKeyDown={(event) => { if (event.key === 'Escape') { pointerCancel(); setPicker(false); } }}
        onClick={(event) => { if (event.detail === 0) setPicker((value) => !value); }}
      >
        <GripVertical className={cn('w-3 h-3', !horizontal && 'rotate-90')} />
      </button>
      <button
        type="button"
        aria-label={`Rotate ${dockId} dock to ${nextOrientation}`}
        title={`Rotate to ${nextOrientation}`}
        data-dock-rotate=""
        className={cn(
          'w-5 h-5 shrink-0 rounded-full flex items-center justify-center transition-opacity',
          rotateHint && !picker ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none group-hover/grip:opacity-100 group-hover/grip:pointer-events-auto group-focus-within/grip:opacity-100 group-focus-within/grip:pointer-events-auto',
        )}
        style={{ background: 'rgb(var(--w-composer-bg-rgb))', border: '1px solid var(--control-border)', color: 'var(--w-text)' }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => onPlacement({ ...placement, orientation: nextOrientation })}
      >
        <RotateCw className="w-3 h-3" />
      </button>
      {picker ? (
        <div
          role="dialog"
          aria-label={`${dockId} dock position`}
          className={cn('absolute z-50 p-2 rounded-xl shadow-lg pointer-events-auto', pickerPositionClass(edge))}
          style={{ background: 'rgb(var(--w-composer-bg-rgb))', border: '1px solid var(--control-border)' }}
          onKeyDown={(event) => { if (event.key === 'Escape') setPicker(false); }}
        >
          <DockPositionPicker
            label="Dock position"
            value={placement}
            onChange={(next) => { setPicker(false); onPlacement({ dockId, ...next }); }}
          />
        </div>
      ) : null}
    </div>
  ) : null;

  return (
    <DockTransparencyProvider value={background === 'toolbar' ? 'transparent' : transparency}>
      <div
        ref={capsule}
        data-dock-capsule={dockId}
        data-theme-id={dockTheme.id}
        className={cn(
          'relative flex min-h-0 min-w-0 motion-safe:transition-[transform,opacity] motion-safe:duration-200 ease-out',
          horizontal ? 'flex-row items-center px-1' : 'flex-col py-1',
          visible ? 'opacity-100 pointer-events-auto' : `${hideTransformClass(edge)} opacity-0 pointer-events-none`,
        )}
        style={{
          ...themeScopeStyle(dockTheme),
          ...dockCapsuleStyle(transparency, background, horizontal, join),
          ...(horizontal ? { height: trackSize } : { width: trackSize }),
        }}
        onPointerDown={(event) => pointerStart(event)}
        onPointerMove={pointerMove}
        onPointerUp={pointerEnd}
        onPointerCancel={pointerCancel}
        onLostPointerCapture={pointerCancel}
        onKeyDown={(event) => { if (event.key === 'Escape') pointerCancel(); }}
      >
        {grip}
        {editing ? (
          <DockEditor
            dockId={dockId}
            items={items}
            horizontal={horizontal}
            hasLabels={hasLabels}
            pinned={pinned}
            cornerReverse={cornerReverse}
            modeSwitch={modeSwitch}
          />
        ) : (
          <>
            {cornerReverse ? footer : null}
            {horizontal ? (
              <DockScrollContainer>
                <div className="flex flex-row gap-2 items-center">
                  {firstItems.map((item) => (
                    <DockItemButton key={item.id} item={item} hasLabels={hasLabels} pinned={pinned} horizontal edge={edge} />
                  ))}
                  {modeSwitch}
                  {lastItems.map((item) => (
                    <DockItemButton key={item.id} item={item} hasLabels={hasLabels} pinned={pinned} horizontal edge={edge} />
                  ))}
                </div>
              </DockScrollContainer>
            ) : (
              <DockScrollContainer orientation="vertical">
                {firstItems.length > 0 && (
                  <div className="w-full flex flex-col gap-2 px-1">
                    {firstItems.map((item) => (
                      <DockItemButton key={item.id} item={item} hasLabels={hasLabels} pinned={pinned} horizontal={false} edge={edge} />
                    ))}
                  </div>
                )}
                {modeSwitch}
                {lastItems.length > 0 && (
                  <div className="w-full flex flex-col gap-2 px-1">
                    {lastItems.map((item) => (
                      <DockItemButton key={item.id} item={item} hasLabels={hasLabels} pinned={pinned} horizontal={false} edge={edge} />
                    ))}
                  </div>
                )}
              </DockScrollContainer>
            )}
            {cornerReverse ? null : footer}
          </>
        )}
        {loading ? (
          <div className="absolute inset-0 z-20 rounded-2xl bg-black/40 backdrop-blur-sm flex items-center justify-center transition-opacity duration-500">
            <div className="w-5 h-5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
          </div>
        ) : null}
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
  dockId, items, horizontal, hasLabels, pinned, cornerReverse, modeSwitch, groupPanel = 'portal',
}: {
  dockId: 'primary' | 'secondary';
  items: DockItem[];
  horizontal: boolean;
  hasLabels: boolean;
  pinned: boolean;
  cornerReverse: boolean;
  modeSwitch: ReactNode;
  /** Where the Group draft shows (Group view, agent dock): beside the dock, or in flow (the Phone sheet). */
  groupPanel?: 'portal' | 'inline';
}) {
  const [draft, setDraft] = useState<DockPrefs>(() => draftFromItems(items));
  // Group view: the agent dock's draft also holds the Groups (names and
  // members) — the same Save/Cancel commits or drops both.
  const { presentation, groupId } = usePresentation();
  const savedGroups = useProjectGroups();
  const editsGroups = dockId === 'secondary' && presentation === 'group';
  const [groupDraft, setGroupDraft] = useState<GroupDraft>(() => ({
    groups: savedGroups.map((g) => ({ ...g, memberIds: [...g.memberIds] })),
    selectedGroupId: groupId,
  }));
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
    if (editsGroups) {
      useWorkspaceStore.getState().saveGroups({ ...groupDraft, dock: { dockId, prefs: live } });
      return;
    }
    useWorkspaceStore.getState().setDockPrefs({ dockId, prefs: live });
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
  const groups = editsGroups ? (
    <GroupDraftPanel draft={groupDraft} onChange={setGroupDraft} placement={groupPanel} anchorRef={listRef} horizontal={horizontal} />
  ) : null;

  if (horizontal) {
    return (
      <>
        <DockScrollContainer>
          <div ref={listRef} className="flex flex-row gap-2 items-center">
            {firstItems.map(renderItem)}
            {modeSwitch}
            {lastItems.map(renderItem)}
            {tray}
          </div>
        </DockScrollContainer>
        {bar}
        {groups}
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
      {groups}
    </>
  );
}

type GroupDraft = { groups: WorkspaceGroup[]; selectedGroupId: string | null };

/**
 * The Groups part of the agent dock's edit draft: pick a Group, rename it, set
 * its members, add one, delete one (after an inline confirm that names the
 * consequence). Nothing is written until the dock's Save. Membership organizes
 * the view only — it grants nothing; removing an agent leaves its open windows.
 */
function GroupDraftPanel({ draft, onChange, placement, anchorRef, horizontal }: {
  draft: GroupDraft;
  onChange: (next: GroupDraft) => void;
  placement: 'portal' | 'inline';
  anchorRef: { current: HTMLDivElement | null };
  horizontal: boolean;
}) {
  const { byId, ids } = useAgentsState();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (placement === 'portal' && anchorRef.current) setAnchor(anchorRef.current.getBoundingClientRect());
  }, [placement, anchorRef]);
  const selected = draft.groups.find((g) => g.id === draft.selectedGroupId) ?? draft.groups[0] ?? null;
  const update = (patch: Partial<WorkspaceGroup>): void => {
    if (!selected) return;
    onChange({ ...draft, groups: draft.groups.map((g) => (g.id === selected.id ? { ...g, ...patch } : g)) });
  };
  const add = (): void => {
    const id = newGroupId();
    onChange({ groups: [...draft.groups, { id, name: `Group ${draft.groups.length + 1}`, memberIds: [] }], selectedGroupId: id });
    setConfirmDelete(false);
  };
  const remove = (): void => {
    if (!selected) return;
    if (!confirmDelete) { setConfirmDelete(true); return; }
    const groups = draft.groups.filter((g) => g.id !== selected.id);
    onChange({ groups, selectedGroupId: groups[0]?.id ?? null });
    setConfirmDelete(false);
  };
  const panel = (
    <div
      role="group"
      aria-label="Group"
      data-theme-id={CONTROL_SURFACE_THEME_ID}
      className={cn('w-64 rounded-xl border p-2 text-sm shadow-2xl shadow-black/60', placement === 'inline' && 'w-full shadow-none')}
      style={{ ...CONTROL_SURFACE, ...(placement === 'portal' && anchor ? groupPanelPosition(anchor, horizontal) : {}) }}
    >
      <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Groups">
        {draft.groups.map((g) => (
          <button
            key={g.id}
            type="button"
            role="radio"
            aria-checked={g.id === selected?.id}
            onClick={() => { onChange({ ...draft, selectedGroupId: g.id }); setConfirmDelete(false); }}
            className={cn('max-w-full truncate rounded-lg px-2 py-1 text-xs font-medium transition', g.id === selected?.id ? 'bg-white/15 text-white' : 'text-white/60 hover:bg-white/5 hover:text-white')}
          >
            {g.name || 'Untitled'}
          </button>
        ))}
        <button type="button" onClick={add} className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-white/60 transition hover:bg-white/5 hover:text-white" aria-label="New group">
          <Plus className="h-3 w-3" /> New
        </button>
      </div>
      {selected ? (
        <>
          <input
            value={selected.name}
            onChange={(event) => update({ name: event.target.value })}
            maxLength={40}
            aria-label="Group name"
            className="mt-2 w-full rounded-lg border px-2 py-1 text-sm text-white outline-none"
            style={{ backgroundColor: 'rgb(var(--w-composer-bg-rgb))', borderColor: 'var(--control-border)' }}
          />
          <div className="mt-2 max-h-48 overflow-y-auto" role="group" aria-label="Members">
            {ids.map((id) => (
              <label key={id} className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-white/80 hover:bg-white/5">
                <input
                  type="checkbox"
                  checked={selected.memberIds.includes(id)}
                  onChange={(event) => update({ memberIds: event.target.checked ? [...selected.memberIds, id] : selected.memberIds.filter((m) => m !== id) })}
                />
                <span className="min-w-0 truncate">{byId[id]?.name || id}</span>
              </label>
            ))}
          </div>
          <p className="mt-1 text-[11px] leading-snug text-white/45">Membership arranges this view only. Removing an agent keeps its open windows.</p>
          <button
            type="button"
            onClick={remove}
            className={cn('mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg px-2 py-1 text-xs transition', confirmDelete ? 'bg-red-500/20 text-red-200' : 'text-white/55 hover:bg-white/5 hover:text-white')}
          >
            <Trash2 className="h-3 w-3" />
            {confirmDelete ? `Delete “${selected.name || 'Untitled'}” and its layout? Agents and their own layouts stay.` : 'Delete group'}
          </button>
        </>
      ) : (
        <p className="mt-2 text-xs text-white/50">No Groups — Save returns to the per-agent view.</p>
      )}
    </div>
  );
  if (placement === 'inline') return panel;
  return anchor ? createPortal(<div className="fixed" style={{ zIndex: 60 }}>{panel}</div>, document.body) : null;
}

/**
 * The Group panel sits on the stage side of the agent dock, inside the viewport,
 * and never over the dock's own edit bar (Save/Cancel trail the item list along
 * the dock's axis): beside a vertical dock, below/above a horizontal one.
 */
export function groupPanelPosition(anchor: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>, horizontal: boolean): CSSProperties {
  const width = 256;
  const gap = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (horizontal) {
    const left = Math.max(gap, Math.min(anchor.left, vw - gap - width));
    // A top-row dock opens it downward; a bottom-row dock upward (grown from the dock's edge).
    return anchor.top < vh / 2
      ? { position: 'fixed', left, top: anchor.bottom + gap, width }
      : { position: 'fixed', left, bottom: vh - anchor.top + gap, width };
  }
  const left = anchor.right + gap + width <= vw ? anchor.right + gap : Math.max(gap, anchor.left - gap - width);
  const top = Math.max(gap, Math.min(anchor.top, vh - 360));
  return { position: 'fixed', left, top, width };
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
            <AppGlyph image={item.image} icon={item.icon} size={20} className="w-5 h-5" style={item.color ? { color: item.color } : undefined} />
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
