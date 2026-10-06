'use client';

import { createContext, useContext } from 'react';

/**
 * Callback a stage uses to register (or clear, with `null`) the placeholder
 * `<div>` into which `StageHost` moves a widget's keep-alive outlet node.
 * Keyed by widget instance id. Both the tiled and the canvas stage call this;
 * `StageHost` owns the outlet nodes so switching stage modes never remounts a
 * widget's REACT subtree. An `<iframe>` inside the outlet is the documented
 * exception — it is detached from the document while the outlet is re-homed and
 * loses its browsing context, so it reloads (see `widgets/README.md`).
 */
export type RegisterPlaceholder = (widgetId: string, el: HTMLDivElement | null) => void;

const StageOutletContext = createContext<RegisterPlaceholder | null>(null);

export const StageOutletProvider = StageOutletContext.Provider;

export function useStageOutlet(): RegisterPlaceholder {
  const register = useContext(StageOutletContext);
  if (!register) {
    throw new Error('useStageOutlet must be used within a StageHost');
  }
  return register;
}
