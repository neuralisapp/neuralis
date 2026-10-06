'use client';

import type { DockMode } from './dockMode';
import { dockModeLabel, nextDockMode } from './dockMode';
import { cn } from '@/lib/cn';
import { dockSurface, useDockTransparency } from './dockSurface';

type Props = {
  mode: DockMode;
  onChangeMode: (mode: DockMode) => void;
  pinned?: boolean;
  orientation?: 'vertical' | 'horizontal';
  className?: string;
  itemsCenter?: boolean;
};

function rotationForMode(mode: DockMode): number {
  switch (mode) {
    case 'iconPinned':
      return 0;
    case 'labelPinned':
      return 90;
    case 'iconHover':
      return 180;
    case 'labelHoverHidden':
      return 270;
    default:
      return 0;
  }
}

export function DockModeSwitch({ mode, onChangeMode, pinned = true, orientation = 'vertical', className, itemsCenter }: Props) {
  const rot = rotationForMode(mode);
  const level = useDockTransparency();
  const surf = dockSurface(level, 'default');
  const opaqueBg = pinned ? 'bg-white/12 hover:bg-white/20' : 'bg-neutral-700 hover:bg-neutral-600';

  return (
    <button
      type="button"
      onClick={() => onChangeMode(nextDockMode(mode))}
      className={cn(
        'relative h-8 w-8 rounded-full shrink-0 transition-all duration-300',
        surf ? surf.bg : opaqueBg,
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/15',
        itemsCenter ? 'absolute left-6 top-1/2 -translate-x-1/2 -translate-y-1/2' : '',
        className,
      )}
      aria-label={`Dock mode: ${dockModeLabel(mode)} (click to cycle)`}
      title={`Dock mode: ${dockModeLabel(mode)}`}
    >
      <div className="absolute inset-0 transition-transform duration-300 ease-out" style={{ transform: `rotate(${rot}deg)` }} aria-hidden="true">
        <div className="absolute left-1/2 -translate-x-1/2 top-[3px] h-2 w-2 rounded-full bg-white/70 shadow-[0_0_4px_rgba(255,255,255,0.4)]" />
      </div>
    </button>
  );
}
