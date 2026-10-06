export type DockMode = 'iconPinned' | 'iconHover' | 'labelPinned' | 'labelHoverHidden';

export const DOCK_MODES: DockMode[] = ['iconPinned', 'labelPinned', 'iconHover', 'labelHoverHidden'];

export function isDockMode(v: unknown): v is DockMode {
  return typeof v === 'string' && (DOCK_MODES as readonly string[]).includes(v);
}

export function parseDockMode(raw: unknown, fallback: DockMode): DockMode {
  return isDockMode(raw) ? raw : fallback;
}

export function nextDockMode(mode: DockMode): DockMode {
  const idx = DOCK_MODES.indexOf(mode);
  return DOCK_MODES[(idx + 1) % DOCK_MODES.length] ?? 'iconPinned';
}

export function dockModeLabel(mode: DockMode): string {
  switch (mode) {
    case 'iconPinned':
      return 'Pinned (icons)';
    case 'iconHover':
      return 'Hover (icons)';
    case 'labelPinned':
      return 'Pinned (labels)';
    case 'labelHoverHidden':
      return 'Hidden (hover labels)';
    default:
      return 'Dock mode';
  }
}

export function dockModeHasLabels(mode: DockMode): boolean {
  return mode === 'labelPinned' || mode === 'labelHoverHidden';
}

export function dockModeIsPinned(mode: DockMode): boolean {
  return mode === 'iconPinned' || mode === 'labelPinned';
}
