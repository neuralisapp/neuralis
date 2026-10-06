'use client';

import { createContext, useContext } from 'react';
import type { TransparencyLevel } from '../store/types';

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
 * Transparency-aware dock button surface. Returns `null` for `opaque` — the
 * caller keeps its EXISTING (per-component) background classes, so the default
 * dock is visually identical. For `dim`/`transparent` it returns replacement
 * background classes plus an optional icon class:
 *
 *   - `dim`         → faint translucent backgrounds; icons unchanged.
 *   - `transparent` → NO background at rest (a whisper of hover feedback only);
 *                     an ACTIVE/open item's icon glows in its own colour
 *                     (`drop-shadow` off `currentColor`). The minimized colour
 *                     ring is applied separately by the caller and survives at
 *                     every level.
 */
export function dockSurface(
  level: TransparencyLevel,
  state: DockSurfaceState,
): { bg: string; icon: string } | null {
  if (level === 'opaque') return null;
  if (level === 'dim') {
    const bg = state === 'active'
      ? 'bg-white/10 hover:bg-white/15'
      : state === 'minimized'
        ? 'bg-white/[0.03] hover:bg-white/[0.06]'
        : 'bg-white/[0.05] hover:bg-white/10';
    return { bg, icon: '' };
  }
  // transparent
  return {
    bg: 'bg-transparent hover:bg-white/[0.06]',
    icon: state === 'active' ? 'drop-shadow-[0_0_6px_currentColor]' : '',
  };
}
