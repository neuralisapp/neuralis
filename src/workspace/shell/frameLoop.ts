/**
 * The scheduling half of a `requestAnimationFrame` loop, extracted out of
 * `AnimatedUniverseBackground` so the invariant below is unit-testable without
 * a DOM (`__tests__/frameLoop.test.ts`).
 *
 * AT MOST ONE scheduled frame exists at any time, and cleanup can always reach
 * it.
 *
 * That invariant is exactly what the universe background used to get wrong:
 * `visibilitychange` set a `paused` flag WITHOUT cancelling the outstanding
 * frame, and the resume path then overwrote the handle — so the pending
 * callback (which Chrome holds, un-run, for a hidden page) became permanently
 * uncancellable and re-armed itself forever. Loops = `1 + N` after N hide/show
 * cycles, and only a page reload cleared them. The effect cleanup could reach
 * only the LAST handle, so unmounting (the Layout-settings universe toggle)
 * left every orphan running against a detached canvas.
 */

/** The two `window` methods a loop needs — injected so tests can drive them. */
export type FrameHost = {
  readonly requestAnimationFrame: (callback: (time: number) => void) => number;
  readonly cancelAnimationFrame: (handle: number) => void;
};

export type FrameLoop = {
  /**
   * Arm exactly one frame, cancelling any outstanding one first. The wrapper
   * clears the handle BEFORE invoking `callback`, so a callback that re-arms
   * (the continuous loop) never sees a stale handle and `pending === 0` stays a
   * truthful "nothing is scheduled" — including inside an early return.
   */
  schedule(callback: (time: number) => void): void;
  /** Cancel the outstanding frame. Idempotent. */
  cancel(): void;
  /** Pause AND cancel — no frame survives a pause. */
  pause(): void;
  /**
   * Leave the paused state. Returns `false` when the loop was NOT paused: the
   * anti-leak guard. Without it, every spurious `visibilitychange` would arm
   * another concurrent loop — the original bug in a new form. Do not "simplify"
   * this away as redundant.
   */
  resume(): boolean;
  readonly paused: boolean;
  /**
   * `0` means nothing is scheduled. `requestAnimationFrame` never returns 0 per
   * spec, so 0 is a valid sentinel — but only because `schedule` clears it
   * before the callback body can early-return.
   */
  readonly pending: number;
};

export function createFrameLoop(host: FrameHost): FrameLoop {
  let pending = 0;
  let paused = false;

  const cancel = (): void => {
    if (pending !== 0) {
      host.cancelAnimationFrame(pending);
      pending = 0;
    }
  };

  return {
    schedule(callback: (time: number) => void): void {
      cancel();
      pending = host.requestAnimationFrame((time: number) => {
        pending = 0; // FIRST — before `callback` can take any early return.
        callback(time);
      });
    },
    cancel,
    pause(): void {
      paused = true;
      cancel();
    },
    resume(): boolean {
      if (!paused) return false;
      paused = false;
      cancel();
      return true;
    },
    get paused(): boolean {
      return paused;
    },
    get pending(): number {
      return pending;
    },
  };
}
