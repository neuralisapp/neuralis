import { describe, expect, it } from 'vitest';
import { surfaceBlurClass, surfaceStyle } from '../widgetSurface';
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
    expect(surfaceBlurClass('dim')).toBe('backdrop-blur-md');
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

  it('keeps the surface values byte-identical across the hoist', () => {
    expect(surfaceStyle('transparent')).toEqual({
      backgroundColor: 'transparent',
      backgroundImage: 'none',
      border: '1px solid rgba(255,255,255,0.06)',
      boxShadow: 'none',
      color: 'var(--w-text)',
      '--w-fade-rgba': 'rgba(var(--w-bg-rgb), 0)',
    });
    expect(surfaceStyle('dim')).toEqual({
      backgroundColor: 'rgba(var(--w-bg-rgb), 0.55)',
      backgroundImage: 'var(--w-surface-image)',
      border: '1px solid rgba(255,255,255,0.04)',
      boxShadow: 'var(--w-shadow)',
      color: 'var(--w-text)',
      '--w-fade-rgba': 'rgba(var(--w-bg-rgb), 0)',
    });
    expect(surfaceStyle('opaque')).toEqual({
      backgroundColor: 'rgb(var(--w-bg-rgb))',
      backgroundImage: 'var(--w-surface-image)',
      border: '1px solid transparent',
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
