import { describe, expect, it } from 'vitest';
import { DOCK_MODES, type DockMode } from '../dockMode';
import {
  DEFAULT_DOCK_LAYOUT,
  DOCK_ANCHORS,
  DOCK_TRACK,
  dockAlign,
  dockEdge,
  dockEdgeTrack,
  dockLanes,
  dockTrackSize,
  dragPlacement,
  naturalOrientations,
  flipOrientation,
  nearestDockAnchor,
  parseDockLayoutConfig,
  placementRect,
  type DockAnchor,
  type DockId,
  type DockLayoutConfig,
  type DockOrientation,
  type DockPlacement,
} from '../dockPlacement';

const at = (dockId: DockId, anchor: DockAnchor, orientation: DockOrientation): DockPlacement => ({ dockId, anchor, orientation });

function layoutWith(primary: [DockAnchor, DockOrientation], secondary: [DockAnchor, DockOrientation]): DockLayoutConfig {
  return { ...DEFAULT_DOCK_LAYOUT, primary: at('primary', ...primary), secondary: at('secondary', ...secondary) };
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
    expect(dockEdgeTrack(layoutWith(['top-left', 'vertical'], ['top-right', 'vertical']), modes('labelPinned', 'labelPinned'), 'top')).toBe('0px');
  });

  it('reserves nothing on an edge whose docks only hover', () => {
    const layout = layoutWith(['top-left', 'vertical'], ['bottom-left', 'vertical']);
    expect(dockEdgeTrack(layout, modes('iconHover', 'labelHoverHidden'), 'left')).toBe('0px');
  });

  it('gives a pinned icon dock the icon track, a pinned label dock the label track', () => {
    const layout = layoutWith(['left', 'vertical'], ['right', 'vertical']);
    expect(dockEdgeTrack(layout, modes('iconPinned', 'labelPinned'), 'left')).toBe('3.5rem');
    expect(dockEdgeTrack(layout, modes('iconPinned', 'labelPinned'), 'right')).toBe('11rem');
  });

  it('lets the strongest pinned mode win on a shared line, in either order, and ignores a hover neighbour', () => {
    const layout = layoutWith(['top-right', 'vertical'], ['bottom-right', 'vertical']);
    expect(dockEdgeTrack(layout, modes('labelPinned', 'iconPinned'), 'right')).toBe('11rem');
    expect(dockEdgeTrack(layout, modes('iconPinned', 'labelPinned'), 'right')).toBe('11rem');
    expect(dockEdgeTrack(layout, modes('labelHoverHidden', 'iconPinned'), 'right')).toBe('3.5rem');
  });

  it('a horizontal dock at a corner reserves the TOP/BOTTOM row, never the side column', () => {
    const layout = layoutWith(['top-left', 'horizontal'], ['bottom-right', 'horizontal']);
    expect(dockEdgeTrack(layout, modes('labelPinned', 'iconPinned'), 'top')).toBe('3rem');
    expect(dockEdgeTrack(layout, modes('labelPinned', 'iconPinned'), 'bottom')).toBe('3rem');
    expect(dockEdgeTrack(layout, modes('labelPinned', 'iconPinned'), 'left')).toBe('0px');
  });

  it('a dock on a centre line floats over the stage and reserves no edge', () => {
    const layout = layoutWith(['top', 'vertical'], ['left', 'horizontal']);
    for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
      expect(dockEdgeTrack(layout, modes('labelPinned', 'iconPinned'), edge)).toBe('0px');
    }
  });
});

describe('the 16 placements — eight anchors × two orientations, never the centre', () => {
  it('has exactly the four corners and four edge midpoints', () => {
    expect([...DOCK_ANCHORS].sort()).toEqual(['bottom', 'bottom-left', 'bottom-right', 'left', 'right', 'top', 'top-left', 'top-right']);
  });

  it('derives ONE edge and ONE alignment for every placement', () => {
    const table: Record<string, [string, string]> = {};
    for (const anchor of DOCK_ANCHORS) for (const orientation of ['horizontal', 'vertical'] as const) {
      table[`${anchor}/${orientation}`] = [dockEdge({ anchor, orientation }), dockAlign({ anchor, orientation })];
    }
    expect(Object.keys(table)).toHaveLength(16);
    expect(table).toEqual({
      'top-left/horizontal': ['top', 'start'], 'top-left/vertical': ['left', 'start'],
      'top/horizontal': ['top', 'center'], 'top/vertical': ['top', 'start'],
      'top-right/horizontal': ['top', 'end'], 'top-right/vertical': ['right', 'start'],
      'left/horizontal': ['left', 'start'], 'left/vertical': ['left', 'center'],
      'right/horizontal': ['right', 'end'], 'right/vertical': ['right', 'center'],
      'bottom-left/horizontal': ['bottom', 'start'], 'bottom-left/vertical': ['left', 'end'],
      'bottom/horizontal': ['bottom', 'center'], 'bottom/vertical': ['bottom', 'end'],
      'bottom-right/horizontal': ['bottom', 'end'], 'bottom-right/vertical': ['right', 'end'],
    });
  });

  it('snaps to the nearest of the eight anchors; the screen centre snaps to an edge midpoint, never to itself', () => {
    const w = 1000; const h = 800;
    expect(nearestDockAnchor(0, 0, w, h)).toBe('top-left');
    expect(nearestDockAnchor(w, h, w, h)).toBe('bottom-right');
    expect(nearestDockAnchor(w / 2, h, w, h)).toBe('bottom');
    expect(nearestDockAnchor(0, h / 2, w, h)).toBe('left');
    expect(DOCK_ANCHORS).toContain(nearestDockAnchor(w / 2, h / 2, w, h));
  });

  it('a drag takes an edge midpoint\'s own direction and a corner\'s from the drag; its own anchor keeps the orientation', () => {
    const left = at('primary', 'left', 'vertical');
    expect(dragPlacement(left, 'bottom', 300, 400)).toEqual(at('primary', 'bottom', 'horizontal'));
    expect(dragPlacement(at('primary', 'bottom', 'horizontal'), 'right', 500, -300)).toEqual(at('primary', 'right', 'vertical'));
    expect(dragPlacement(left, 'top-right', 600, -100)).toEqual(at('primary', 'top-right', 'horizontal'));
    expect(dragPlacement(left, 'top-right', 100, -600)).toEqual(at('primary', 'top-right', 'vertical'));
    expect(dragPlacement(left, 'left', 2, 3)).toBe(left);
    // R during the drag flips the landing, the cross placements included.
    expect(dragPlacement(left, 'bottom', 300, 400, true)).toEqual(at('primary', 'bottom', 'vertical'));
    expect(dragPlacement(left, 'left', 2, 3, true)).toEqual(at('primary', 'left', 'horizontal'));
  });

  it('all 16 placements are reachable from any start: a drag reaches 11–12 natural ones, the rotate control (a flip in place) the rest', () => {
    for (const start of DOCK_ANCHORS.flatMap((anchor) => (['horizontal', 'vertical'] as const).map((o) => at('primary', anchor, o)))) {
      const dragged = new Set<string>();
      const reached = new Set<string>();
      for (const anchor of DOCK_ANCHORS) for (const [dx, dy] of [[400, 10], [10, 400]]) {
        const p = dragPlacement(start, anchor, dx, dy);
        dragged.add(`${p.anchor}:${p.orientation}`);
        reached.add(`${p.anchor}:${p.orientation}`).add(`${p.anchor}:${flipOrientation(p.orientation)}`);
      }
      // 12 from a midpoint start, 11 from a corner start (a corner offers both orientations, its own anchor only the current one).
      expect(dragged.size).toBeGreaterThanOrEqual(11);
      expect(reached.size).toBe(16);
    }
  });
});

describe('the first-run layout', () => {
  it('apps toolbar along the bottom centre, agents down the left middle, chat right, Dim widgets — in ONE owner', () => {
    expect(DEFAULT_DOCK_LAYOUT).toEqual({
      primary: { dockId: 'primary', anchor: 'bottom', orientation: 'horizontal' },
      secondary: { dockId: 'secondary', anchor: 'left', orientation: 'vertical' },
      chatPosition: 'end',
      defaultWidgetTransparency: 'dim',
      defaultDockTransparency: 'opaque',
      backgroundTransparency: 'dim',
      dockBackground: 'toolbar',
      autoPhone: true,
    });
  });
});

describe('naturalOrientations — the ONE rule the drag and Randomize share', () => {
  it('a midpoint runs along its edge; a corner holds either', () => {
    expect(naturalOrientations('top')).toEqual(['horizontal']);
    expect(naturalOrientations('bottom')).toEqual(['horizontal']);
    expect(naturalOrientations('left')).toEqual(['vertical']);
    expect(naturalOrientations('right')).toEqual(['vertical']);
    for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) expect(naturalOrientations(corner)).toEqual(['horizontal', 'vertical']);
    // The drag lands on exactly this set (a corner picks one by the drag's direction).
    for (const anchor of DOCK_ANCHORS) for (const [dx, dy] of [[400, 10], [10, 400]]) {
      expect(naturalOrientations(anchor)).toContain(dragPlacement(at('primary', anchor === 'top' ? 'left' : 'top', anchor === 'top' ? 'vertical' : 'horizontal'), anchor, dx, dy).orientation);
    }
  });
  it('a stored background material reads back; an absent or unknown one falls to its own default alone', () => {
    expect(parseDockLayoutConfig({ backgroundTransparency: 'opaque', chatPosition: 'start' })).toMatchObject({ backgroundTransparency: 'opaque', chatPosition: 'start' });
    expect(parseDockLayoutConfig({ backgroundTransparency: 'frosted', chatPosition: 'start' })).toMatchObject({ backgroundTransparency: DEFAULT_DOCK_LAYOUT.backgroundTransparency, chatPosition: 'start' });
  });
});

describe('parseDockLayoutConfig — field by field, never the whole record', () => {
  it('a 0.2.0-shaped record resets ONLY the placements and keeps every other preference', () => {
    const released = {
      primary: { dockId: 'primary', edge: 'bottom', align: 'center' },
      secondary: { dockId: 'secondary', edge: 'right', align: 'start' },
      chatPosition: 'start',
      defaultWidgetTransparency: 'transparent',
      defaultDockTransparency: 'dim',
    };
    expect(parseDockLayoutConfig(released)).toEqual({
      ...DEFAULT_DOCK_LAYOUT,
      chatPosition: 'start',
      defaultWidgetTransparency: 'transparent',
      defaultDockTransparency: 'dim',
    });
  });

  it('an unreleased centre placement is unreadable; the other dock keeps its valid placement', () => {
    const parsed = parseDockLayoutConfig({
      primary: { dockId: 'primary', edge: 'center', align: 'center', orientation: 'vertical' },
      secondary: { dockId: 'secondary', anchor: 'bottom', orientation: 'horizontal' },
      dockBackground: 'toolbar',
      autoPhone: false,
    });
    expect(parsed.primary).toEqual(DEFAULT_DOCK_LAYOUT.primary);
    expect(parsed.secondary).toEqual(at('secondary', 'bottom', 'horizontal'));
    expect(parsed.dockBackground).toBe('toolbar');
    expect(parsed.autoPhone).toBe(false);
  });

  it('a placement stored under the other dock key takes the key it is stored under', () => {
    expect(parseDockLayoutConfig({ primary: { dockId: 'secondary', anchor: 'top', orientation: 'horizontal' } }).primary)
      .toEqual(at('primary', 'top', 'horizontal'));
  });

  it('round-trips every one of the 16 placements', () => {
    for (const anchor of DOCK_ANCHORS) for (const orientation of ['horizontal', 'vertical'] as const) {
      const config = { ...DEFAULT_DOCK_LAYOUT, primary: at('primary', anchor, orientation) };
      expect(parseDockLayoutConfig(JSON.parse(JSON.stringify(config)))).toEqual(config);
    }
  });

  it('anything that is not an object is the default', () => {
    for (const raw of [null, 7, 'x', []]) expect(parseDockLayoutConfig(raw)).toEqual(DEFAULT_DOCK_LAYOUT);
  });
});

describe('dockLanes — two docks can never overlap', () => {
  it('same anchor and orientation: ONE cluster, primary then secondary (they join)', () => {
    expect(dockLanes(layoutWith(['bottom', 'horizontal'], ['bottom', 'horizontal']))).toEqual([
      { orientation: 'horizontal', line: 'bottom', clusters: [{ align: 'center', docks: ['primary', 'secondary'] }] },
    ]);
  });

  it('one line, two anchors: one lane, two clusters ordered along it', () => {
    expect(dockLanes(layoutWith(['bottom-left', 'vertical'], ['top-left', 'vertical']))).toEqual([
      { orientation: 'vertical', line: 'left', clusters: [{ align: 'start', docks: ['secondary'] }, { align: 'end', docks: ['primary'] }] },
    ]);
  });

  it('neighbouring anchors on one line (an end and the midpoint) join into ONE cluster at the end anchor — vertical and horizontal', () => {
    expect(dockLanes(layoutWith(['right', 'vertical'], ['top-right', 'vertical']))).toEqual([
      { orientation: 'vertical', line: 'right', clusters: [{ align: 'start', docks: ['secondary', 'primary'] }] },
    ]);
    expect(dockLanes(layoutWith(['bottom', 'horizontal'], ['bottom-right', 'horizontal']))).toEqual([
      { orientation: 'horizontal', line: 'bottom', clusters: [{ align: 'end', docks: ['primary', 'secondary'] }] },
    ]);
  });

  it('one anchor, two orientations: two lanes', () => {
    const lanes = dockLanes(layoutWith(['top-left', 'vertical'], ['top-left', 'horizontal']));
    expect(lanes.map((l) => `${l.orientation}:${l.line}`)).toEqual(['vertical:left', 'horizontal:top']);
  });

  it('a side column runs between the reserved top and bottom rows; a centre line centres on the stage', () => {
    const tracks = { left: '3.5rem', right: '0px', top: '3rem', bottom: '0px' };
    expect(placementRect({ orientation: 'vertical', line: 'left' }, '3.5rem', tracks)).toEqual({ left: 0, top: '3rem', bottom: '0px', width: '3.5rem' });
    expect(placementRect({ orientation: 'horizontal', line: 'top' }, '3rem', tracks)).toEqual({ top: 0, left: 0, right: 0, height: '3rem' });
    expect(placementRect({ orientation: 'horizontal', line: 'middle' }, '3rem', tracks)).toEqual({
      left: '3.5rem', right: '0px', height: '3rem', top: 'calc(3rem + (100% - 3rem - 0px - 3rem) / 2)',
    });
  });
});
