'use client';

import type { ReactNode, CSSProperties } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import { createFrameLoop, type FrameLoop } from './frameLoop';
import type { DockAlign } from './dockPlacement';

type Props = {
  children: ReactNode;
  align?: DockAlign;
  orientation?: 'horizontal' | 'vertical';
};

function horizontalAlignClass(align: DockAlign): string {
  switch (align) {
    case 'start': return 'justify-start';
    case 'center': return 'justify-center';
    case 'end': return 'justify-end';
  }
}

export function DockScrollContainer({ children, align = 'start', orientation = 'horizontal' }: Props) {
  // Callback ref, NOT a stable ref object: the vertical and horizontal branches
  // below render DIFFERENT scroll `<div>`s, so the element identity changes with
  // `orientation`. Effects keyed on a ref object would not re-run and would keep
  // observing a detached node (the chat-timeline pin-release bug, same shape).
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [showStart, setShowStart] = useState(false);
  const [showEnd, setShowEnd] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);
  const isVertical = orientation === 'vertical';

  /**
   * Reads `scrollHeight`/`clientHeight`/`scrollTop` — a FORCED SYNCHRONOUS
   * LAYOUT. It must never run straight off an event; every caller goes through
   * `scheduleUpdate` below.
   */
  const measure = useCallback((el: HTMLDivElement) => {
    if (isVertical) {
      setHasOverflow(el.scrollHeight > el.clientHeight + 1);
      setShowStart(el.scrollTop > 2);
      setShowEnd(el.scrollTop < el.scrollHeight - el.clientHeight - 2);
    } else {
      setHasOverflow(el.scrollWidth > el.clientWidth + 1);
      setShowStart(el.scrollLeft > 2);
      setShowEnd(el.scrollLeft < el.scrollWidth - el.clientWidth - 2);
    }
  }, [isVertical]);

  /**
   * ONE scheduled frame at a time, and cleanup can always reach it — the
   * `frameLoop` invariant. Four sources feed this (mount, `ResizeObserver`,
   * `MutationObserver`, `scroll`) and a single interaction fires bursts from
   * several of them at once; coalescing collapses the whole burst into one
   * layout read on the next frame, which reads the SETTLED DOM anyway.
   *
   * The `pending` early-return is what makes it coalescing rather than
   * re-arming: an already-armed frame has not run yet, so it will observe the
   * newest DOM regardless of how many more events arrive first.
   */
  const loopRef = useRef<FrameLoop | null>(null);
  const scheduleUpdate = useCallback((el: HTMLDivElement) => {
    if (typeof window === 'undefined') return;
    const loop = (loopRef.current ??= createFrameLoop(window));
    if (loop.pending !== 0) return;
    loop.schedule(() => measure(el));
  }, [measure]);

  useEffect(() => {
    if (!scrollEl) return;
    // First read is immediate: the arrows must be correct on the first paint
    // after a dock opens, and there is no burst to coalesce yet.
    measure(scrollEl);

    const onChange = () => scheduleUpdate(scrollEl);
    const ro = new ResizeObserver(onChange);
    ro.observe(scrollEl);

    // `subtree: true` is REQUIRED, not sloppy: `Dock.tsx` never appends items to
    // the scroller directly — horizontally they live inside one wrapper div, and
    // vertically inside up to three (header group / mode switch / main group).
    // Without `subtree` this would only fire when a whole group appears or
    // disappears, so a dock that grows past the fold would keep stale arrows.
    // The burst it produces is absorbed by the rAF coalescing above.
    const mo = new MutationObserver(onChange);
    mo.observe(scrollEl, { childList: true, subtree: true });

    // Passive: `scroll` is not cancelable, and the handler must stay free of
    // layout reads so the scroll path never forces a synchronous layout.
    scrollEl.addEventListener('scroll', onChange, { passive: true });

    return () => {
      ro.disconnect();
      mo.disconnect();
      scrollEl.removeEventListener('scroll', onChange);
      loopRef.current?.cancel();
    };
  }, [scrollEl, measure, scheduleUpdate]);

  const scroll = useCallback((direction: -1 | 1) => {
    if (!scrollEl) return;
    if (isVertical) scrollEl.scrollBy({ top: direction * 200, behavior: 'smooth' });
    else scrollEl.scrollBy({ left: direction * 200, behavior: 'smooth' });
  }, [scrollEl, isVertical]);

  /**
   * The fade mask is the intended look. It is also what wraps the whole item
   * list in ONE render surface, so keep the style object's identity stable —
   * a fresh object every render re-runs style recalc on the masked scroller.
   */
  const scrollStyle: CSSProperties = useMemo(() => ({
    scrollbarWidth: 'none' as const,
    ...(hasOverflow
      ? {
          maskImage: isVertical
            ? 'linear-gradient(to bottom, transparent, black 24px, black calc(100% - 24px), transparent)'
            : 'linear-gradient(to right, transparent, black 32px, black calc(100% - 32px), transparent)',
        }
      : undefined),
  }), [hasOverflow, isVertical]);

  if (isVertical) {
    return (
      <div className="relative flex-1 min-h-0 flex flex-col">
        {/* Up arrow */}
        {showStart ? (
          <button
            type="button"
            onClick={() => scroll(-1)}
            className="absolute left-0 right-0 top-0 z-10 h-6 flex items-center justify-center bg-gradient-to-b from-black/50 to-transparent rounded-t-xl"
          >
            <ChevronUp className="w-4 h-4 text-white/60" />
          </button>
        ) : null}

        {/* Scrollable content */}
        <div
          ref={setScrollEl}
          className="flex-1 min-h-0 flex flex-col gap-2 overflow-y-auto overflow-x-hidden"
          style={scrollStyle}
        >
          {children}
        </div>

        {/* Down arrow */}
        {showEnd ? (
          <button
            type="button"
            onClick={() => scroll(1)}
            className="absolute left-0 right-0 bottom-0 z-10 h-6 flex items-center justify-center bg-gradient-to-t from-black/50 to-transparent rounded-b-xl"
          >
            <ChevronDown className="w-4 h-4 text-white/60" />
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="relative flex-1 min-w-0 flex items-center">
      {/* Left arrow */}
      {showStart ? (
        <button
          type="button"
          onClick={() => scroll(-1)}
          className="absolute left-0 top-0 bottom-0 z-10 w-7 flex items-center justify-center bg-gradient-to-r from-black/50 to-transparent rounded-l-xl"
        >
          <ChevronLeft className="w-4 h-4 text-white/60" />
        </button>
      ) : null}

      {/* Scrollable content */}
      <div
        ref={setScrollEl}
        className={cn('flex-1 flex flex-row gap-2 items-center overflow-x-auto', horizontalAlignClass(align))}
        style={scrollStyle}
      >
        {children}
      </div>

      {/* Right arrow */}
      {showEnd ? (
        <button
          type="button"
          onClick={() => scroll(1)}
          className="absolute right-0 top-0 bottom-0 z-10 w-7 flex items-center justify-center bg-gradient-to-l from-black/50 to-transparent rounded-r-xl"
        >
          <ChevronRight className="w-4 h-4 text-white/60" />
        </button>
      ) : null}
    </div>
  );
}
