import { describe, expect, it } from 'vitest';
import { DOCK_MODES, type DockMode } from '../dockMode';
import {
  DEFAULT_DOCK_LAYOUT,
  DOCK_TRACK,
  dockEdgeTrack,
  dockTrackSize,
  type DockEdge,
  type DockId,
  type DockLayoutConfig,
} from '../dockPlacement';

function layoutWith(primary: DockEdge, secondary: DockEdge): DockLayoutConfig {
  return {
    ...DEFAULT_DOCK_LAYOUT,
    primary: { dockId: 'primary', edge: primary, align: 'start' },
    secondary: { dockId: 'secondary', edge: secondary, align: 'start' },
  };
}

function modes(primary: DockMode, secondary: DockMode): Record<DockId, DockMode> {
  return { primary, secondary };
}

describe('dockTrackSize — every mode reads the ONE table', () => {
  const expectedVertical: Record<DockMode, string> = {
    iconPinned: DOCK_TRACK.iconVertical,
    iconHover: DOCK_TRACK.iconVertical,
    labelPinned: DOCK_TRACK.label,
    labelHoverHidden: DOCK_TRACK.label,
  };

  it.each(DOCK_MODES)('vertical %s', (mode) => {
    expect(dockTrackSize(mode, false)).toBe(expectedVertical[mode]);
  });

  it.each(DOCK_MODES)('horizontal %s carries its labels inline in one height', (mode) => {
    expect(dockTrackSize(mode, true)).toBe(DOCK_TRACK.horizontal);
  });

  it('keeps the label track a fixed length, never a content-sized one', () => {
    expect(DOCK_TRACK).toEqual({ iconVertical: '3.5rem', horizontal: '3rem', label: '11rem' });
  });
});

describe('dockEdgeTrack — the shell grid track per edge', () => {
  it('reserves nothing on an edge with no dock', () => {
    expect(dockEdgeTrack(layoutWith('left', 'right'), modes('labelPinned', 'labelPinned'), 'top')).toBe('0fr');
  });

  it('reserves nothing on an edge whose docks only hover', () => {
    const layout = layoutWith('left', 'left');
    expect(dockEdgeTrack(layout, modes('iconHover', 'labelHoverHidden'), 'left')).toBe('0fr');
  });

  it('gives a pinned icon dock the icon track', () => {
    expect(dockEdgeTrack(layoutWith('left', 'right'), modes('iconPinned', 'iconHover'), 'left')).toBe('3.5rem');
  });

  it('gives a pinned label dock the fixed label track', () => {
    expect(dockEdgeTrack(layoutWith('left', 'right'), modes('iconPinned', 'labelPinned'), 'right')).toBe('11rem');
  });

  it('lets the strongest pinned mode win on a shared edge, in either order', () => {
    const layout = layoutWith('right', 'right');
    expect(dockEdgeTrack(layout, modes('labelPinned', 'iconPinned'), 'right')).toBe('11rem');
    expect(dockEdgeTrack(layout, modes('iconPinned', 'labelPinned'), 'right')).toBe('11rem');
    expect(dockEdgeTrack(layout, modes('iconPinned', 'iconPinned'), 'right')).toBe('3.5rem');
  });

  it('ignores a hover dock next to a pinned one on the same edge', () => {
    const layout = layoutWith('left', 'left');
    expect(dockEdgeTrack(layout, modes('labelHoverHidden', 'iconPinned'), 'left')).toBe('3.5rem');
  });

  it('gives a horizontal edge the horizontal track in label mode too', () => {
    const layout = layoutWith('top', 'bottom');
    expect(dockEdgeTrack(layout, modes('labelPinned', 'iconPinned'), 'top')).toBe('3rem');
    expect(dockEdgeTrack(layout, modes('labelPinned', 'iconPinned'), 'bottom')).toBe('3rem');
  });
});
