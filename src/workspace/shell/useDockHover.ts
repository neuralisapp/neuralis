/** Shared dock hover/auto-close behaviour. */

import { useCallback, useEffect, useRef, useState } from 'react';

const CLOSE_DELAY_MS = 120;

type UseDockHoverResult = {
  hoverOpen: boolean;
  open: boolean;
  handlers: {
    onMouseEnter: () => void;
    onMouseLeave: () => void;
  };
};

export function useDockHover(pinned: boolean): UseDockHoverResult {
  const [hoverOpen, setHoverOpen] = useState(false);
  const closeTimerRef = useRef<number | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const onMouseEnter = useCallback(() => {
    cancelClose();
    setHoverOpen(true);
  }, [cancelClose]);

  const onMouseLeave = useCallback(() => {
    if (pinned) return;
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      // Null the handle FIRST: a fired timeout no longer exists, so leaving the
      // id behind makes `closeTimerRef.current !== null` lie and `cancelClose`
      // clear a dead handle.
      closeTimerRef.current = null;
      setHoverOpen(false);
    }, CLOSE_DELAY_MS);
  }, [pinned, cancelClose]);

  useEffect(() => () => cancelClose(), [cancelClose]);

  return {
    hoverOpen,
    open: pinned || hoverOpen,
    handlers: { onMouseEnter, onMouseLeave },
  };
}
