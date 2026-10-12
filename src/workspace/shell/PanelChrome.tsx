'use client';

import { useContext, useMemo, type ReactNode } from 'react';
import { ThemeContext, themeScopeStyle } from '../theme/ThemeContext';
import { DEFAULT_THEME } from '../theme/themes';
import { cn } from '@/lib/cn';
import type { TransparencyLevel } from '../store/types';
import { WidgetControls } from './WidgetControls';
import { surfaceStyle, surfaceBlurClass } from './widgetSurface';
import { useWindowBinding } from '../store/selectors';

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
  /** The window id: in a Group the chrome names the agent the window is bound to. */
  windowId?: string;
}) {
  const { title, subtitle, onClose, children, contentClassName, onCycleTransparency } = props;
  const binding = useWindowBinding(props.windowId ?? '');
  const bindingLabel = binding.name ? `${binding.name}${binding.outside ? ' · outside group' : ''}` : '';
  const agentTag = bindingLabel ? (
    <span
      data-window-agent=""
      className={cn('max-w-[10rem] truncate rounded-full px-1.5 py-0.5 text-[10px] font-medium', binding.outside ? 'bg-amber-400/15 text-amber-200' : 'bg-white/10 text-white/70')}
      title={`Runs as ${bindingLabel}`}
    >
      {bindingLabel}
    </span>
  ) : null;
  const mode: ChromeMode = props.mode ?? 'toolbar';
  const level: TransparencyLevel = props.level ?? 'opaque';

  const theme = useContext(ThemeContext)?.theme ?? DEFAULT_THEME;
  const surface = useMemo(() => ({ ...themeScopeStyle(theme), ...surfaceStyle(level) }), [theme, level]);

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
      data-theme-id={theme.id}
      aria-label={[title, subtitle, bindingLabel].filter(Boolean).join(' ')}
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
          {agentTag}
          <WidgetControls
            level={level}
            onCycleTransparency={onCycleTransparency}
            onClose={onClose}
            variant="toolbar-inline"
            title={title}
          />
        </div>
      )}

      {/* ── Frameless: hover-reveal overlay controls — always shown where there
          is no hover to reveal them (a touch screen) and on the Phone stage. ── */}
      {mode === 'frameless' && (
        <div
          data-widget-controls=""
          className="absolute top-1.5 right-1.5 z-50 flex items-center gap-1 opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 in-data-phone-window:opacity-100 transition-opacity"
        >
          {agentTag}
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
        <div className="absolute top-1.5 right-1.5 z-50 flex items-center gap-1">
          {agentTag}
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
