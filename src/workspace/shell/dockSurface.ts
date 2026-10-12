'use client';

import { createContext, useContext, type CSSProperties } from 'react';
import type { TransparencyLevel } from '../store/types';
import { DIM_GLASS } from './widgetSurface';

/**
 * Dock chrome transparency, provided by `Dock` and consumed by every dock
 * button (package items, the user avatar, the dock-mode switch, agent tiles).
 * Defaults to `opaque` so a dock rendered outside a provider is unchanged.
 */
const DockTransparencyContext = createContext<TransparencyLevel>('opaque');

export const DockTransparencyProvider = DockTransparencyContext.Provider;

export function useDockTransparency(): TransparencyLevel {
  return useContext(DockTransparencyContext);
}

/** Semantic state of a dock button, for transparency-aware styling. */
export type DockSurfaceState = 'active' | 'minimized' | 'default';

/**
 * Shared dock tile palette/material projection. Opaque and Dim consume the
 * scoped dock palette; Clear keeps the active icon glow and colour ring. A Dim
 * tile IS the classic dock's surface, so it wears the ONE Dim glass at its tile
 * alpha: the capsule publishes `DIM_GLASS.tileAlpha` as `--dock-dim-alpha`
 * (`dockCapsuleStyle`) — an idle or minimized tile is the widget's surface, an
 * active one the composer tone (minimized is told by its colour ring).
 */
export function dockSurface(
  level: TransparencyLevel,
  state: DockSurfaceState,
): { bg: string; icon: string } {
  if (level === 'opaque') return { bg: state === 'active' ? 'bg-[var(--control-surface-elevated)] hover:bg-[var(--control-surface)]' : 'bg-[rgba(var(--w-composer-bg-rgb),0.92)] hover:bg-[var(--control-surface-elevated)]', icon: '' };
  if (level === 'dim') {
    const bg = state === 'active'
      ? 'bg-[rgba(var(--w-composer-bg-rgb),var(--dock-dim-alpha))] hover:bg-[rgb(var(--w-composer-bg-rgb))]'
      : 'bg-[rgba(var(--w-bg-rgb),var(--dock-dim-alpha))] hover:bg-[rgba(var(--w-composer-bg-rgb),var(--dock-dim-alpha))]';
    return { bg, icon: '' };
  }
  // transparent
  return {
    bg: 'bg-transparent hover:bg-white/[0.06]',
    icon: state === 'active' ? 'drop-shadow-[0_0_6px_currentColor]' : '',
  };
}

/**
 * The ONE dock capsule material. `classic` draws no capsule surface (the item
 * tiles carry it) and only frosts the backdrop at Dim; `toolbar` draws one
 * surface around the items. Two docks joined on one anchor each draw their
 * half — `join` squares the corners they share and drops the border between
 * them, so the pair reads as one toolbar while either can still hide alone.
 */
export function dockCapsuleStyle(
  level: TransparencyLevel,
  background: 'classic' | 'toolbar',
  horizontal: boolean,
  join?: 'start' | 'end',
): CSSProperties {
  const blur = level === 'dim' ? `blur(${DIM_GLASS.blurPx}px)` : undefined;
  if (background === 'classic') return blur ? { backdropFilter: blur, '--dock-dim-alpha': String(DIM_GLASS.tileAlpha) } as CSSProperties : {};
  // Longhands only, so a join flip never mixes a shorthand with its longhand.
  const r = '24px';
  const style: CSSProperties = {
    backgroundColor: level === 'transparent' ? 'transparent' : `rgba(var(--w-bg-rgb), ${level === 'dim' ? DIM_GLASS.alpha : 1})`,
    borderStyle: 'solid',
    borderColor: 'var(--control-border)',
    borderTopWidth: 1, borderRightWidth: 1, borderBottomWidth: 1, borderLeftWidth: 1,
    borderTopLeftRadius: r, borderTopRightRadius: r, borderBottomRightRadius: r, borderBottomLeftRadius: r,
    backdropFilter: blur,
  };
  if (join === 'start') {
    if (horizontal) Object.assign(style, { borderTopRightRadius: 0, borderBottomRightRadius: 0, borderRightWidth: 0 });
    else Object.assign(style, { borderBottomLeftRadius: 0, borderBottomRightRadius: 0, borderBottomWidth: 0 });
  } else if (join === 'end') {
    if (horizontal) Object.assign(style, { borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeftWidth: 0 });
    else Object.assign(style, { borderTopLeftRadius: 0, borderTopRightRadius: 0, borderTopWidth: 0 });
  }
  return style;
}
