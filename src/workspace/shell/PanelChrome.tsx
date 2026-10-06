'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import type { TransparencyLevel } from '../store/types';
import { WidgetControls } from './WidgetControls';
import { surfaceStyle, surfaceBlurClass } from './widgetSurface';

export type ChromeMode = 'toolbar' | 'frameless' | 'floating';

export function PanelChrome(props: {
  title: string;
  subtitle?: string;
  onClose?: () => void;
  children: ReactNode;
  mode?: ChromeMode;
  contentClassName?: string;
  level?: TransparencyLevel;
  onCycleTransparency?: () => void;
}) {
  const { title, subtitle, onClose, children, contentClassName, onCycleTransparency } = props;
  const mode: ChromeMode = props.mode ?? 'toolbar';
  const level: TransparencyLevel = props.level ?? 'opaque';

  const surface = surfaceStyle(level);

  return (
    <div
      // `isolate` (isolation: isolate) is LOAD-BEARING, unconditionally at all three
      // levels. `backdrop-filter` — emitted at `opaque` and `dim`, see
      // `widgetSurface.ts` — creates a stacking context, a containing block for `fixed`
      // descendants, and free layer promotion. `transparent` emits none of it, and
      // `position: relative` at `z-index: auto` creates NO stacking context, so without
      // `isolate` the panel's own `z-50` control strip and package popovers at
      // `z-40`/`z-[10000]` would join the shell's `z-10` context and paint over the
      // auto-hide dock (`Dock.tsx` z-30) and the package-loading scrim
      // (`WorkspaceShell.tsx` z-20). Applying it at every level keeps the z-order
      // identical whether or not a filter is present, so the transparency cycle can
      // never reshuffle paint order. `isolation` is deliberately NOT in the spec's
      // fixed-position containing-block list, so it does this WITHOUT re-containing
      // viewport modals — and it is not layer promotion, not `translateZ(0)`, and not
      // containment, so the virtualized-timeline fence below this element is untouched.
      // Do NOT add `will-change` / `translateZ(0)` / `contain:` here (measured p95 +25 %
      // for no gain, on an ancestor of the virtualized chat timeline).
      className={cn(
        'relative isolate h-full w-full flex flex-col overflow-hidden rounded-[22px]',
        surfaceBlurClass(level),
        mode === 'frameless' && 'group',
      )}
      aria-label={subtitle ? `${title} ${subtitle}` : title}
      style={surface}
    >
      {/* ── Toolbar: header row with title + inline controls ── */}
      {mode === 'toolbar' && (
        <div
          className="flex h-9 items-center px-3 shrink-0 gap-2"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
        >
          <span
            className="text-xs font-medium truncate flex-1"
            style={{ color: 'var(--w-text)', opacity: 0.5 }}
          >
            {title}
          </span>
          <WidgetControls
            level={level}
            onCycleTransparency={onCycleTransparency}
            onClose={onClose}
            variant="toolbar-inline"
            title={title}
          />
        </div>
      )}

      {/* ── Frameless: hover-reveal overlay controls ── */}
      {mode === 'frameless' && (
        <div className="absolute top-1.5 right-1.5 z-50 opacity-0 group-hover:opacity-100 transition-opacity">
          <WidgetControls
            level={level}
            onCycleTransparency={onCycleTransparency}
            onClose={onClose}
            variant="overlay"
            title={title}
          />
        </div>
      )}

      {/* ── Floating: always-visible overlay controls ── */}
      {mode === 'floating' && (
        <div className="absolute top-1.5 right-1.5 z-50">
          <WidgetControls
            level={level}
            onCycleTransparency={onCycleTransparency}
            onClose={onClose}
            variant="overlay"
            title={title}
          />
        </div>
      )}

      {/* ── Content ── */}
      <div
        className={cn(
          'flex-1 min-h-0',
          mode === 'frameless' ? 'overflow-hidden' : 'overflow-auto p-2',
          contentClassName,
        )}
      >
        {children}
      </div>
    </div>
  );
}
