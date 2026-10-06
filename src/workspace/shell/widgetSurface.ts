/**
 * Shared widget-surface helpers. Both stages render widgets through
 * `PanelChrome`, and this is the surface math it uses — kept here so the
 * `resolveWidgetLevel` precedence is shared by `TiledStage` and `CanvasStage`
 * without duplication.
 */

import type { CSSProperties } from 'react';
import type { TransparencyLevel, WidgetInstance } from '../store/types';
import type { WidgetDefinition } from '../widgets/types';

/**
 * The actual chrome surface for a transparency level. Mirrors the widget
 * transparency semantics documented in `widgets/README.md`.
 *
 * `--w-fade-rgba` is published per-level so descendants (Timeline overlay
 * fade, ExploredBlock top fade) can fade to the *effective* surface color
 * instead of always falling back to opaque `rgb(var(--w-bg-rgb))`. Only
 * opaque mode gets a visible fade — in dim/transparent the gradient would
 * compound over an already-translucent chrome, so fade alpha is 0 there.
 *
 * The three style objects are frozen module constants, so `PanelChrome` gets a
 * STABLE object identity per level: React's `diffProperties` skips a prop when
 * `nextProp === lastProp`, which elides the whole style walk on every re-render
 * that did not change the level. Safe because the only caller
 * (`PanelChrome.tsx:25`) never mutates the result.
 */
const TRANSPARENT_SURFACE: CSSProperties = Object.freeze({
  backgroundColor: 'transparent',
  backgroundImage: 'none',
  border: '1px solid rgba(255,255,255,0.06)',
  boxShadow: 'none',
  color: 'var(--w-text)',
  ['--w-fade-rgba' as string]: 'rgba(var(--w-bg-rgb), 0)',
} as CSSProperties);

const DIM_SURFACE: CSSProperties = Object.freeze({
  // Legacy rgba() syntax — `--w-bg-rgb` is comma-separated ("14, 15, 18")
  // so it expands as `rgba(14, 15, 18, 0.55)`. The modern slash-alpha form
  // (`rgb(... / 0.55)`) would be invalid against the same var format.
  backgroundColor: 'rgba(var(--w-bg-rgb), 0.55)',
  backgroundImage: 'var(--w-surface-image)',
  border: '1px solid rgba(255,255,255,0.04)',
  boxShadow: 'var(--w-shadow)',
  color: 'var(--w-text)',
  ['--w-fade-rgba' as string]: 'rgba(var(--w-bg-rgb), 0)',
} as CSSProperties);

const OPAQUE_SURFACE: CSSProperties = Object.freeze({
  backgroundColor: 'rgb(var(--w-bg-rgb))',
  backgroundImage: 'var(--w-surface-image)',
  border: '1px solid transparent',
  boxShadow: 'var(--w-shadow)',
  color: 'var(--w-text)',
  ['--w-fade-rgba' as string]: 'rgb(var(--w-bg-rgb))',
} as CSSProperties);

/**
 * ONE per-level decision: the surface style and the backdrop-blur utility are
 * read off the same row so the background ALPHA and the blur can never drift
 * apart.
 *
 * **`opaque` KEEPS `backdrop-blur-xl`. Do not remove it as "invisible".** The
 * argument for removing it was that the opaque background is
 * `rgb(var(--w-bg-rgb))` at alpha 1 and every theme publishes `widgetBg` as an
 * alpha-less triplet (`workspace/theme/themes.ts`), so the filtered backdrop can
 * never show through. That reasoning is true about the BLUR and false about the
 * `backdrop-filter` PROPERTY, which is load-bearing for three other things:
 *
 *   (a) it promotes the panel to its own compositor layer — free, and paid for
 *       already, since the filter is what creates the render surface. Removing
 *       it moved 11 `position: fixed` package surfaces and, measured on real
 *       hardware, changed **13.45 % of panel pixels** purely from the lost layer
 *       promotion;
 *   (b) it is a containing block for `position: fixed` descendants — with the
 *       `overflow-hidden rounded-[22px]` on `PanelChrome`'s same div, that also
 *       rounded-box-clips them;
 *   (c) it is a STACKING CONTEXT.
 *
 * The removal was benchmarked on a GPU-LESS SwiftShader harness, where a
 * software rasterizer makes every extra render surface look like pure cost and
 * layer promotion buys nothing. That ranking does not transfer to a GPU. Any
 * future attempt to drop this needs a measurement on real hardware first.
 *
 * `dim` keeps `backdrop-blur-md`: at alpha 0.55 the blur is also genuinely
 * visible. `transparent` emits none — it has no surface to blur behind.
 *
 * (c) is ADDITIONALLY held by `PanelChrome`'s unconditional `isolate`
 * (`isolation: isolate`), which is correct on its own merits: it normalizes
 * `transparent`, the one level that never had a stacking context at all, and it
 * creates one per spec WITHOUT creating a fixed-position containing block.
 * Belt-and-braces at `opaque`/`dim`, the only guard at `transparent`.
 *
 * Reaching for `will-change` / `translateZ(0)` / `contain:` on `PanelChrome` to
 * get (a) or (b) some other way is FORBIDDEN — `will-change` measured p95 +25 %
 * for no gain, and `PanelChrome` is an ancestor of the virtualized chat
 * timeline, which must never carry containment/paint CSS.
 */
const SURFACE_LEVELS = {
  transparent: { style: TRANSPARENT_SURFACE, blurClass: null },
  dim: { style: DIM_SURFACE, blurClass: 'backdrop-blur-md' },
  opaque: { style: OPAQUE_SURFACE, blurClass: 'backdrop-blur-xl' },
} as const satisfies Record<
  TransparencyLevel,
  { readonly style: CSSProperties; readonly blurClass: string | null }
>;

export function surfaceStyle(level: TransparencyLevel): CSSProperties {
  return SURFACE_LEVELS[level].style;
}

/** Backdrop-blur utility class for a level (`null` only at `transparent`). */
export function surfaceBlurClass(level: TransparencyLevel): string | null {
  return SURFACE_LEVELS[level].blurClass;
}

/**
 * Resolve the effective transparency level for a widget instance and whether
 * the user may cycle it. Precedence: per-instance override → manifest
 * `chrome.transparent` (pins to 'transparent') → user default → 'opaque'.
 * Cycling is hidden for `untrusted`-tier packages and for manifests that opt
 * out via `chrome.userTransparency: false`.
 */
export function resolveWidgetLevel(params: {
  instance: WidgetInstance;
  definition: WidgetDefinition | undefined;
  defaultTransparency: TransparencyLevel;
}): { level: TransparencyLevel; showCycle: boolean } {
  const { instance, definition, defaultTransparency } = params;
  const chrome = definition?.chrome;
  const baseline: TransparencyLevel = chrome?.transparent ? 'transparent' : defaultTransparency;
  const level: TransparencyLevel = instance.transparency ?? baseline;
  const trustLocked = definition?.trust === 'untrusted';
  const manifestOptOut = chrome?.userTransparency === false;
  return { level, showCycle: !trustLocked && !manifestOptOut };
}
