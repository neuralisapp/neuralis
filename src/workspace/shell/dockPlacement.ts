/** Dock placement type system — edge, alignment, layout configuration, dock track sizes. */
import type { TransparencyLevel } from '../store/types';
import { type DockMode, dockModeHasLabels, dockModeIsPinned } from './dockMode';

export type DockEdge = 'left' | 'right' | 'top' | 'bottom';
export type DockAlign = 'start' | 'center' | 'end';
export type DockId = 'primary' | 'secondary';

export type DockPlacement = {
  dockId: DockId;
  edge: DockEdge;
  align: DockAlign;
};

export type ChatPosition = 'start' | 'end';

export type DockLayoutConfig = {
  primary: DockPlacement;
  secondary: DockPlacement;
  chatPosition: ChatPosition;
  /**
   * Default transparency for newly-opened widgets. Applied as the render-time
   * baseline when a widget has no per-instance override and its manifest does
   * not pin `chrome.transparent`. Defaults to 'opaque'.
   */
  defaultWidgetTransparency: TransparencyLevel;
  /**
   * Dock chrome transparency. `opaque` (default) = the current filled item
   * backgrounds; `dim` = faint backgrounds; `transparent` = no backgrounds at
   * all (icons only) — active/open items glow via the icon, the minimized
   * colour ring stays. Applies to EVERY dock element (package items, the user
   * avatar, the dock-mode switch, agent tiles).
   */
  defaultDockTransparency: TransparencyLevel;
};

export const DEFAULT_DOCK_LAYOUT: DockLayoutConfig = {
  primary: { dockId: 'primary', edge: 'left', align: 'start' },
  secondary: { dockId: 'secondary', edge: 'right', align: 'start' },
  chatPosition: 'start',
  defaultWidgetTransparency: 'opaque',
  defaultDockTransparency: 'opaque',
};

const DOCK_LAYOUT_KEY = 'neuralis:workspace:dockLayout';

export function isDockHorizontal(edge: DockEdge): boolean {
  return edge === 'top' || edge === 'bottom';
}

export function getDocksOnEdge(config: DockLayoutConfig, edge: DockEdge): DockPlacement[] {
  const result: DockPlacement[] = [];
  if (config.primary.edge === edge) result.push(config.primary);
  if (config.secondary.edge === edge) result.push(config.secondary);
  return result;
}

function isValidEdge(v: unknown): v is DockEdge {
  return v === 'left' || v === 'right' || v === 'top' || v === 'bottom';
}

function isValidAlign(v: unknown): v is DockAlign {
  return v === 'start' || v === 'center' || v === 'end';
}

function isValidPlacement(v: unknown): v is DockPlacement {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (p.dockId === 'primary' || p.dockId === 'secondary')
    && isValidEdge(p.edge)
    && isValidAlign(p.align);
}

function isValidTransparency(v: unknown): v is TransparencyLevel {
  return v === 'opaque' || v === 'dim' || v === 'transparent';
}

export function parseDockLayoutConfig(raw: unknown): DockLayoutConfig {
  if (!raw || typeof raw !== 'object') return DEFAULT_DOCK_LAYOUT;
  const obj = raw as Record<string, unknown>;
  if (!isValidPlacement(obj.primary) || !isValidPlacement(obj.secondary)) return DEFAULT_DOCK_LAYOUT;
  const chatPos = obj.chatPosition === 'start' || obj.chatPosition === 'end' ? obj.chatPosition : 'start';
  const transparency = isValidTransparency(obj.defaultWidgetTransparency) ? obj.defaultWidgetTransparency : 'opaque';
  const dockTransparency = isValidTransparency(obj.defaultDockTransparency) ? obj.defaultDockTransparency : 'opaque';
  return { primary: obj.primary, secondary: obj.secondary, chatPosition: chatPos, defaultWidgetTransparency: transparency, defaultDockTransparency: dockTransparency };
}

export function readDockLayoutConfig(): DockLayoutConfig {
  if (typeof window === 'undefined') return DEFAULT_DOCK_LAYOUT;
  try {
    const raw = window.localStorage.getItem(DOCK_LAYOUT_KEY);
    return raw ? parseDockLayoutConfig(JSON.parse(raw)) : DEFAULT_DOCK_LAYOUT;
  } catch {
    return DEFAULT_DOCK_LAYOUT;
  }
}

export function saveDockLayoutConfig(config: DockLayoutConfig): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DOCK_LAYOUT_KEY, JSON.stringify(config));
  } catch {
    // ignore
  }
}

/**
 * The ONE dock track table: the grid track `dockEdgeTrack` reserves for an
 * edge and the width (vertical) or height (horizontal) of the `Dock` container
 * both come from it. The label track is FIXED on purpose — a content-sized
 * (`auto`) track makes every dock re-render re-measure both dock subtrees and
 * re-derive the stage width, which turns a geometry write into a render
 * loop. Horizontal docks carry their labels inline, so one height
 * serves every mode.
 */
export const DOCK_TRACK = { iconVertical: '3.5rem', horizontal: '3rem', label: '11rem' } as const;

/** The dock's size across its edge. Hover modes get a size too — their overlay reads it. */
export function dockTrackSize(mode: DockMode, horizontal: boolean): string {
  if (horizontal) return DOCK_TRACK.horizontal;
  return dockModeHasLabels(mode) ? DOCK_TRACK.label : DOCK_TRACK.iconVertical;
}

/**
 * The shell grid track for one edge: `0fr` unless a dock on it is pinned
 * (hover docks overlay the stage and reserve nothing); otherwise the track of
 * the strongest pinned mode on that edge (labels beat icons).
 */
export function dockEdgeTrack(config: DockLayoutConfig, modes: Record<DockId, DockMode>, edge: DockEdge): string {
  let strongest: DockMode | null = null;
  for (const d of getDocksOnEdge(config, edge)) {
    const mode = modes[d.dockId];
    if (!dockModeIsPinned(mode)) continue;
    if (strongest === null || dockModeHasLabels(mode)) strongest = mode;
  }
  return strongest === null ? '0fr' : dockTrackSize(strongest, isDockHorizontal(edge));
}
