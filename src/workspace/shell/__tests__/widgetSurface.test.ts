import { describe, expect, it } from 'vitest';
import { DIM_BLUR_CLASS, DIM_GLASS, surfaceBlurClass, surfaceStyle } from '../widgetSurface';
import { dockCapsuleStyle, dockSurface } from '../dockSurface';
import type { TransparencyLevel } from '../../store/types';

const LEVELS: readonly TransparencyLevel[] = ['opaque', 'dim', 'transparent'];

describe('surfaceBlurClass — the filter is kept wherever there is a surface', () => {
  it('KEEPS `backdrop-blur-xl` at `opaque`', () => {
    // Do not "optimize" this to null. The blur itself is indeed invisible
    // behind an alpha-1 background, but the `backdrop-filter` PROPERTY also
    // buys free layer promotion and a fixed-position containing block. Removing
    // it moved 11 non-portalled `position: fixed` package surfaces and changed
    // 13.45 % of panel pixels in a live diff on real hardware; the benchmark
    // that justified removing it ran on a GPU-less SwiftShader harness, whose
    // ranking does not transfer.
    expect(surfaceBlurClass('opaque')).toBe('backdrop-blur-xl');
  });

  it('KEEPS the backdrop blur at `dim`, where it is also genuinely visible', () => {
    expect(surfaceBlurClass('dim')).toBe('backdrop-blur-[6px]');
  });

  it('Dim is ONE record: 72 % over a 6 px blur for surfaces, a lighter tile alpha for classic icon tiles', () => {
    expect(DIM_GLASS).toEqual({ alpha: 0.72, tileAlpha: 0.42, blurPx: 6 });
    // A classic tile must read as glass: visibly lighter than the surface alpha.
    expect(DIM_GLASS.tileAlpha).toBeLessThan(DIM_GLASS.alpha - 0.2);
    // The utility class is the constant's literal twin (Tailwind reads source literals).
    expect(DIM_BLUR_CLASS).toBe(`backdrop-blur-[${DIM_GLASS.blurPx}px]`);
    expect(surfaceStyle('dim').backgroundColor).toBe(`rgba(var(--w-bg-rgb), ${DIM_GLASS.alpha})`);
    // Classic: the tiles are the surface — the capsule hands them the tile alpha.
    expect(dockCapsuleStyle('dim', 'classic', false)).toEqual({ backdropFilter: `blur(${DIM_GLASS.blurPx}px)`, '--dock-dim-alpha': String(DIM_GLASS.tileAlpha) });
    for (const state of ['default', 'minimized'] as const) expect(dockSurface('dim', state).bg.split(' ')[0]).toBe('bg-[rgba(var(--w-bg-rgb),var(--dock-dim-alpha))]');
    expect(dockSurface('dim', 'active').bg).toContain('var(--dock-dim-alpha)');
    expect(dockCapsuleStyle('dim', 'toolbar', true)).toMatchObject({ backgroundColor: `rgba(var(--w-bg-rgb), ${DIM_GLASS.alpha})`, backdropFilter: `blur(${DIM_GLASS.blurPx}px)` });
    expect(dockCapsuleStyle('opaque', 'classic', true)).toEqual({});
  });

  it('a joined pair is ONE contour in toolbar (shared corners square, no shared border) and flush tiles in classic — both orientations', () => {
    for (const horizontal of [true, false]) {
      const start = dockCapsuleStyle('opaque', 'toolbar', horizontal, 'start');
      const end = dockCapsuleStyle('opaque', 'toolbar', horizontal, 'end');
      const [sharedStart, sharedEnd] = horizontal
        ? [['borderTopRightRadius', 'borderBottomRightRadius', 'borderRightWidth'], ['borderTopLeftRadius', 'borderBottomLeftRadius', 'borderLeftWidth']]
        : [['borderBottomLeftRadius', 'borderBottomRightRadius', 'borderBottomWidth'], ['borderTopLeftRadius', 'borderTopRightRadius', 'borderTopWidth']];
      for (const key of sharedStart) expect(start[key as keyof typeof start]).toBe(0);
      for (const key of sharedEnd) expect(end[key as keyof typeof end]).toBe(0);
      // The outer corners stay round, so the pair reads as one capsule.
      for (const key of sharedEnd) if (key.endsWith('Radius')) expect(start[key as keyof typeof start]).toBe('24px');
      expect(dockCapsuleStyle('opaque', 'classic', horizontal, 'start')).toEqual({});
    }
  });

  it('emits no backdrop blur at `transparent` — there is no surface to blur behind', () => {
    // The one level with no filter, and therefore the one that depends
    // entirely on `PanelChrome`'s unconditional `isolate` for its stacking
    // context.
    expect(surfaceBlurClass('transparent')).toBeNull();
  });
});

describe('surfaceStyle — stable identity per level', () => {
  it('returns the SAME object on every call for a level', () => {
    for (const level of LEVELS) {
      // React's `diffProperties` skips a prop entirely when
      // `nextProp === lastProp`; a fresh object per render walks every key.
      expect(surfaceStyle(level)).toBe(surfaceStyle(level));
    }
  });

  it('returns a frozen object, so a caller cannot poison the shared constant', () => {
    for (const level of LEVELS) {
      expect(Object.isFrozen(surfaceStyle(level))).toBe(true);
    }
  });

  it('gives each level its own object', () => {
    expect(surfaceStyle('opaque')).not.toBe(surfaceStyle('dim'));
    expect(surfaceStyle('dim')).not.toBe(surfaceStyle('transparent'));
  });

  it('projects scoped borders while preserving alpha, material and fade values', () => {
    expect(surfaceStyle('transparent')).toEqual({
      backgroundColor: 'transparent',
      backgroundImage: 'none',
      border: '1px solid var(--w-clear-border)',
      boxShadow: 'none',
      color: 'var(--w-text)',
      '--w-fade-rgba': 'rgba(var(--w-bg-rgb), 0)',
    });
    expect(surfaceStyle('dim')).toEqual({
      backgroundColor: 'rgba(var(--w-bg-rgb), 0.72)',
      backgroundImage: 'var(--w-surface-image)',
      border: '1px solid var(--w-dim-border)',
      boxShadow: 'var(--w-shadow)',
      color: 'var(--w-text)',
      '--w-fade-rgba': 'rgba(var(--w-bg-rgb), 0)',
    });
    expect(surfaceStyle('opaque')).toEqual({
      backgroundColor: 'rgb(var(--w-bg-rgb))',
      backgroundImage: 'var(--w-surface-image)',
      border: '1px solid var(--w-opaque-border)',
      boxShadow: 'var(--w-shadow)',
      color: 'var(--w-text)',
      '--w-fade-rgba': 'rgb(var(--w-bg-rgb))',
    });
  });

  it('keeps `opaque` fully opaque', () => {
    // The style and the blur class are read off the SAME per-level row, so a
    // level's alpha and its filter can never drift apart. If this ever gains an
    // alpha, revisit `surfaceBlurClass('opaque')` in the same edit — in the
    // direction of MORE blur, never less.
    expect(surfaceStyle('opaque').backgroundColor).toBe('rgb(var(--w-bg-rgb))');
  });
});
