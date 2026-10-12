/** Dock placement — eight screen anchors × two orientations, the layout configuration, dock track sizes. */
import { createContext, type CSSProperties } from 'react';
import type { TransparencyLevel } from '../store/types';
import { type DockMode, dockModeHasLabels, dockModeIsPinned } from './dockMode';
import { TRANSPARENCY_LEVELS } from './widgetSurface';

export type DockEdge = 'left' | 'right' | 'top' | 'bottom';
export type DockAlign = 'start' | 'center' | 'end';
export type DockId = 'primary' | 'secondary';
export type DockOrientation = 'horizontal' | 'vertical';

/** The four corners and the four edge midpoints. The screen centre is never an anchor. */
export const DOCK_ANCHORS = ['top-left', 'top', 'top-right', 'left', 'right', 'bottom-left', 'bottom', 'bottom-right'] as const;
export type DockAnchor = (typeof DOCK_ANCHORS)[number];

/**
 * Where a dock sits: an anchor and an orientation, chosen independently, so
 * every anchor holds a horizontal bar OR a vertical column (16 placements).
 */
export type DockPlacement = {
  dockId: DockId;
  anchor: DockAnchor;
  orientation: DockOrientation;
};

export const CHAT_POSITIONS = ['start', 'end'] as const;
export type ChatPosition = (typeof CHAT_POSITIONS)[number];

/** ONE background mode for both docks: separate item tiles, or one toolbar surface. */
export const DOCK_BACKGROUNDS = ['classic', 'toolbar'] as const;
export type DockBackground = (typeof DOCK_BACKGROUNDS)[number];

export type DockLayoutConfig = {
  primary: DockPlacement;
  secondary: DockPlacement;
  chatPosition: ChatPosition;
  /**
   * Default transparency for newly-opened widgets. Applied as the render-time
   * baseline when a widget has no per-instance override and its manifest does
   * not pin `chrome.transparent`.
   */
  defaultWidgetTransparency: TransparencyLevel;
  /**
   * Dock chrome transparency. `opaque` = filled item backgrounds; `dim` =
   * faint backgrounds; `transparent` = no backgrounds at all (icons only) —
   * active/open items glow via the icon, the minimized colour ring stays.
   * Applies to EVERY dock element (package items, the user avatar, the
   * dock-mode switch, agent tiles).
   */
  defaultDockTransparency: TransparencyLevel;
  /**
   * The background image's material: how strongly an uploaded image shows
   * (`backgroundImageOpacity`). Independent of the Universe toggle, which
   * draws over the image and never dims it.
   */
  backgroundTransparency: TransparencyLevel;
  dockBackground: DockBackground;
  /** Switch to the Phone stage automatically on a phone-sized viewport. */
  autoPhone: boolean;
};

/**
 * The first-run layout (and what an unreadable field falls back to): the apps
 * dock as a toolbar along the bottom centre, the agents dock down the middle of
 * the left edge, the chat on the right, widgets in Dim glass. The Dark theme
 * on every surface is the theme owner's default (`DEFAULT_THEME`).
 */
export const DEFAULT_DOCK_LAYOUT: DockLayoutConfig = {
  primary: { dockId: 'primary', anchor: 'bottom', orientation: 'horizontal' },
  secondary: { dockId: 'secondary', anchor: 'left', orientation: 'vertical' },
  chatPosition: 'end',
  defaultWidgetTransparency: 'dim',
  defaultDockTransparency: 'opaque',
  backgroundTransparency: 'dim',
  dockBackground: 'toolbar',
  autoPhone: true,
};

export const DockLayoutContext = createContext<DockLayoutConfig>(DEFAULT_DOCK_LAYOUT);

export const DOCK_LAYOUT_KEY = 'neuralis:workspace:dockLayout';

// ─── Anchor geometry ────────────────────────────────────────────────────────

type AnchorRow = 'top' | 'middle' | 'bottom';
type AnchorCol = 'left' | 'center' | 'right';

export function anchorCell(anchor: DockAnchor): { row: AnchorRow; col: AnchorCol } {
  switch (anchor) {
    case 'top-left': return { row: 'top', col: 'left' };
    case 'top': return { row: 'top', col: 'center' };
    case 'top-right': return { row: 'top', col: 'right' };
    case 'left': return { row: 'middle', col: 'left' };
    case 'right': return { row: 'middle', col: 'right' };
    case 'bottom-left': return { row: 'bottom', col: 'left' };
    case 'bottom': return { row: 'bottom', col: 'center' };
    case 'bottom-right': return { row: 'bottom', col: 'right' };
  }
}

export function dockHorizontal(placement: Pick<DockPlacement, 'orientation'>): boolean {
  return placement.orientation === 'horizontal';
}

/**
 * The screen edge the dock touches — its long side where it can (a vertical
 * dock in the left column → `left`), else its short side (a vertical dock at
 * the top midpoint → `top`). Popovers open away from it; a hidden dock slides
 * out over it; its hover trigger lies on it.
 */
export function dockEdge(placement: Pick<DockPlacement, 'anchor' | 'orientation'>): DockEdge {
  const { row, col } = anchorCell(placement.anchor);
  if (placement.orientation === 'vertical') return col === 'center' ? (row as 'top' | 'bottom') : col;
  return row === 'middle' ? (col as 'left' | 'right') : row;
}

/** Where the dock sits along its own long axis. */
export function dockAlign(placement: Pick<DockPlacement, 'anchor' | 'orientation'>): DockAlign {
  const { row, col } = anchorCell(placement.anchor);
  const along = placement.orientation === 'vertical' ? row : col;
  return along === 'top' || along === 'left' ? 'start' : along === 'bottom' || along === 'right' ? 'end' : 'center';
}

/** The line a dock runs along: a column for a vertical dock, a row for a horizontal one. */
export type DockLine = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';

export function dockLine(placement: Pick<DockPlacement, 'anchor' | 'orientation'>): DockLine {
  const { row, col } = anchorCell(placement.anchor);
  return placement.orientation === 'vertical' ? col : row;
}

const ALIGN_RANK: Record<DockAlign, number> = { start: 0, center: 1, end: 2 };

/**
 * Docks that join, one after the other: the same anchor, or NEIGHBOURING anchors
 * on one line (an end and the midpoint) — that pair meets, so it renders as one
 * contour hugging the end anchor. Docks at the two opposite ends stay apart.
 */
export type DockCluster = { align: DockAlign; docks: DockId[] };
/** Docks that share a line, ordered along it so they can never overlap. */
export type DockLane = { orientation: DockOrientation; line: DockLine; clusters: DockCluster[] };

export function dockLanes(config: Pick<DockLayoutConfig, 'primary' | 'secondary'>): DockLane[] {
  const lanes: DockLane[] = [];
  for (const placement of [config.primary, config.secondary]) {
    const line = dockLine(placement);
    const align = dockAlign(placement);
    let lane = lanes.find((l) => l.orientation === placement.orientation && l.line === line);
    if (!lane) { lane = { orientation: placement.orientation, line, clusters: [] }; lanes.push(lane); }
    const cluster = lane.clusters.find((c) => c.align === align);
    if (cluster) cluster.docks.push(placement.dockId);
    else lane.clusters.push({ align, docks: [placement.dockId] });
    lane.clusters.sort((a, b) => ALIGN_RANK[a.align] - ALIGN_RANK[b.align]);
  }
  for (const lane of lanes) {
    const [first, second] = lane.clusters;
    if (second && Math.abs(ALIGN_RANK[first.align] - ALIGN_RANK[second.align]) === 1) {
      lane.clusters = [{ align: first.align === 'center' ? second.align : first.align, docks: [...first.docks, ...second.docks] }];
    }
  }
  return lanes;
}

/** The nearest of the eight anchors to a viewport point (the centre is never a candidate). */
export function nearestDockAnchor(x: number, y: number, width: number, height: number): DockAnchor {
  let best: DockAnchor = DOCK_ANCHORS[0];
  let distance = Infinity;
  for (const anchor of DOCK_ANCHORS) {
    const { row, col } = anchorCell(anchor);
    const ax = col === 'left' ? 0 : col === 'center' ? width / 2 : width;
    const ay = row === 'top' ? 0 : row === 'middle' ? height / 2 : height;
    const d = (x - ax) ** 2 + (y - ay) ** 2;
    if (d < distance) { distance = d; best = anchor; }
  }
  return best;
}

/**
 * The ONE natural-orientation rule: an edge midpoint runs along its edge (top
 * and bottom → horizontal, left and right → vertical); a corner holds either.
 * The drag and Randomize both read it; the four cross placements exist only
 * as the user's own choice (R or the rotate control).
 */
export function naturalOrientations(anchor: DockAnchor): readonly DockOrientation[] {
  const { row, col } = anchorCell(anchor);
  if (col === 'center') return ['horizontal'];
  if (row === 'middle') return ['vertical'];
  return ['horizontal', 'vertical'];
}

/**
 * The placement a drag lands on: the anchor's natural orientation, and at a
 * corner the direction of the drag (its dominant axis); the dock's own anchor
 * keeps its orientation. `flip` (R during the drag) turns the result; the four
 * cross placements (vertical on a top/bottom midpoint, horizontal on a side
 * midpoint) are one flip away, and the dock's rotate control flips it in
 * place after the drop. The same placement returns the current object.
 */
export function dragPlacement(current: DockPlacement, anchor: DockAnchor, dx: number, dy: number, flip = false): DockPlacement {
  const options = naturalOrientations(anchor);
  const natural: DockOrientation = anchor === current.anchor ? current.orientation
    : options.length === 1 ? options[0]
      : Math.abs(dx) >= Math.abs(dy) ? 'horizontal' : 'vertical';
  const orientation = flip ? flipOrientation(natural) : natural;
  if (anchor === current.anchor && orientation === current.orientation) return current;
  return { dockId: current.dockId, anchor, orientation };
}

export function flipOrientation(orientation: DockOrientation): DockOrientation {
  return orientation === 'horizontal' ? 'vertical' : 'horizontal';
}

// ─── Stored configuration ───────────────────────────────────────────────────

function isAnchor(v: unknown): v is DockAnchor {
  return typeof v === 'string' && (DOCK_ANCHORS as readonly string[]).includes(v);
}

function isTransparency(v: unknown): v is TransparencyLevel {
  return (TRANSPARENCY_LEVELS as readonly unknown[]).includes(v);
}

function isOneOf<T extends string>(values: readonly T[], v: unknown): v is T {
  return (values as readonly unknown[]).includes(v);
}

function parsePlacement(v: unknown, dockId: DockId): DockPlacement {
  const p = v && typeof v === 'object' ? v as Record<string, unknown> : {};
  return isAnchor(p.anchor) && (p.orientation === 'horizontal' || p.orientation === 'vertical')
    ? { dockId, anchor: p.anchor, orientation: p.orientation }
    : DEFAULT_DOCK_LAYOUT[dockId];
}

/**
 * Field by field: an unreadable field falls back to ITS default alone, so a
 * record whose placement shape is older than this build keeps its chat side,
 * transparencies and background.
 */
export function parseDockLayoutConfig(raw: unknown): DockLayoutConfig {
  const obj = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const d = DEFAULT_DOCK_LAYOUT;
  return {
    primary: parsePlacement(obj.primary, 'primary'),
    secondary: parsePlacement(obj.secondary, 'secondary'),
    chatPosition: isOneOf(CHAT_POSITIONS, obj.chatPosition) ? obj.chatPosition : d.chatPosition,
    defaultWidgetTransparency: isTransparency(obj.defaultWidgetTransparency) ? obj.defaultWidgetTransparency : d.defaultWidgetTransparency,
    defaultDockTransparency: isTransparency(obj.defaultDockTransparency) ? obj.defaultDockTransparency : d.defaultDockTransparency,
    backgroundTransparency: isTransparency(obj.backgroundTransparency) ? obj.backgroundTransparency : d.backgroundTransparency,
    dockBackground: isOneOf(DOCK_BACKGROUNDS, obj.dockBackground) ? obj.dockBackground : d.dockBackground,
    autoPhone: typeof obj.autoPhone === 'boolean' ? obj.autoPhone : d.autoPhone,
  };
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

/** The stored bytes of a dock layout (the coordinated layout commit writes them strictly). */
export function serializeDockLayoutConfig(config: DockLayoutConfig): string {
  return JSON.stringify(config);
}

export function saveDockLayoutConfig(config: DockLayoutConfig): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(DOCK_LAYOUT_KEY, serializeDockLayoutConfig(config));
  } catch {
    // A manual change that cannot be stored stays on screen for this session.
  }
}

// ─── Tracks and lanes ───────────────────────────────────────────────────────

/**
 * The ONE dock track table: the grid track `dockEdgeTrack` reserves for an
 * edge and the width (vertical) or height (horizontal) of the dock both come
 * from it. The label track is FIXED on purpose — a content-sized (`auto`)
 * track makes every dock re-render re-measure both dock subtrees and
 * re-derive the stage width, which turns a geometry write into a render
 * loop. Horizontal docks carry their labels inline, so one height serves
 * every mode.
 */
export const DOCK_TRACK = { iconVertical: '3.5rem', horizontal: '3rem', label: '11rem' } as const;

/** The dock's size across its own axis. Hover modes get a size too — their overlay reads it. */
export function dockTrackSize(mode: DockMode, horizontal: boolean): string {
  if (horizontal) return DOCK_TRACK.horizontal;
  return dockModeHasLabels(mode) ? DOCK_TRACK.label : DOCK_TRACK.iconVertical;
}

/**
 * The shell grid track for one edge: `0px` unless a PINNED dock runs along
 * that edge (hover docks overlay the stage and reserve nothing; so does a
 * dock on a centre line — a vertical dock at the top/bottom midpoint or a
 * horizontal one at the left/right midpoint, which floats over the stage);
 * otherwise the track of the strongest pinned mode on it (labels beat icons).
 */
export function dockEdgeTrack(config: Pick<DockLayoutConfig, 'primary' | 'secondary'>, modes: Record<DockId, DockMode>, edge: DockEdge): string {
  let strongest: DockMode | null = null;
  for (const placement of [config.primary, config.secondary]) {
    const mode = modes[placement.dockId];
    if (!dockModeIsPinned(mode) || dockLine(placement) !== edge) continue;
    if (strongest === null || dockModeHasLabels(mode)) strongest = mode;
  }
  return strongest === null ? '0px' : dockTrackSize(strongest, edge === 'top' || edge === 'bottom');
}

export type DockTracks = Record<DockEdge, string>;

/**
 * The ONE dock rectangle — the box a lane occupies inside the shell grid,
 * read by the docks, their hover triggers and the drag preview alike, so a
 * trigger and the dock it opens can never disagree. A side column runs
 * between the top and bottom tracks; a top/bottom row spans the full width;
 * a centre line is centred on the stage.
 */
export function placementRect(lane: Pick<DockLane, 'orientation' | 'line'>, size: string, tracks: DockTracks): CSSProperties {
  if (lane.orientation === 'vertical') {
    const span = { top: tracks.top, bottom: tracks.bottom, width: size };
    if (lane.line === 'left') return { ...span, left: 0 };
    if (lane.line === 'right') return { ...span, right: 0 };
    return { ...span, left: `calc(${tracks.left} + (100% - ${tracks.left} - ${tracks.right} - ${size}) / 2)` };
  }
  if (lane.line === 'top') return { top: 0, left: 0, right: 0, height: size };
  if (lane.line === 'bottom') return { bottom: 0, left: 0, right: 0, height: size };
  return { left: tracks.left, right: tracks.right, height: size, top: `calc(${tracks.top} + (100% - ${tracks.top} - ${tracks.bottom} - ${size}) / 2)` };
}
