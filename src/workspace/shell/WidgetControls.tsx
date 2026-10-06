'use client';

import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { TransparencyLevel } from '../store/types';

type Variant = 'toolbar-inline' | 'overlay';

export const TRANSPARENCY_CYCLE: Record<TransparencyLevel, TransparencyLevel> = {
  opaque: 'dim',
  dim: 'transparent',
  transparent: 'opaque',
};

const LEVEL_LABEL: Record<TransparencyLevel, string> = {
  opaque: 'Opaque',
  dim: 'Dim',
  transparent: 'Transparent',
};

/**
 * Compact corner-strip with optional transparency cycle + close. Same DOM
 * shape in all chrome modes; only `variant` changes spacing/background so
 * the strip sits flush in a toolbar header or floats over a frameless
 * widget.
 *
 * Both buttons are intentionally tiny (`w-5 h-5` with `w-3 h-3` glyphs)
 * to minimise overlap with widget-content controls.
 */
export function WidgetControls(props: {
  level: TransparencyLevel;
  onCycleTransparency?: () => void;
  onClose?: () => void;
  variant: Variant;
  title: string;
}) {
  const { level, onCycleTransparency, onClose, variant, title } = props;
  const hasCycle = typeof onCycleTransparency === 'function';
  const hasClose = typeof onClose === 'function';
  if (!hasCycle && !hasClose) return null;

  const isOverlay = variant === 'overlay';
  const nextLevel = TRANSPARENCY_CYCLE[level];

  return (
    <div
      className={cn(
        'flex items-center gap-0.5 shrink-0',
        isOverlay
          ? 'rounded-md bg-black/40 backdrop-blur-sm p-px'
          : null,
      )}
    >
      {hasCycle && (
        <button
          type="button"
          onClick={onCycleTransparency}
          className={cn(
            'w-5 h-5 rounded-md flex items-center justify-center transition shrink-0',
            isOverlay
              ? 'text-white/70 hover:text-white hover:bg-white/10'
              : 'text-white/50 hover:text-white hover:bg-white/10',
          )}
          title={`${LEVEL_LABEL[level]} — click for ${LEVEL_LABEL[nextLevel].toLowerCase()}`}
          aria-label={`Transparency: ${LEVEL_LABEL[level]}`}
        >
          <TransparencySwatch level={level} />
        </button>
      )}
      {hasClose && (
        <button
          type="button"
          onClick={onClose}
          className={cn(
            'w-5 h-5 rounded-md flex items-center justify-center transition shrink-0',
            isOverlay
              ? 'text-white/70 hover:text-white hover:bg-white/10'
              : 'text-white/50 hover:text-white hover:bg-white/10',
          )}
          title={`Close ${title}`}
          aria-label={`Close ${title}`}
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

/**
 * 10x10 swatch whose fill matches the current `level` — directly mirrors
 * the panel background so the glyph reads as "this is how opaque the
 * widget is right now".
 */
function TransparencySwatch({ level }: { level: TransparencyLevel }) {
  return (
    <span
      aria-hidden
      className={cn(
        'w-2.5 h-2.5 rounded-[3px] border',
        level === 'opaque' && 'bg-white/85 border-white/40',
        level === 'dim' && 'bg-white/35 border-white/40',
        level === 'transparent' && 'bg-transparent border-white/50',
      )}
    />
  );
}
