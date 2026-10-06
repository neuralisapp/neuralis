import { describe, expect, it } from 'vitest';
import { createFrameLoop, type FrameHost } from '../frameLoop';

/**
 * A `requestAnimationFrame` host that never runs a callback on its own —
 * `flush()` stands in for "the browser drew a frame", and `live` is the set of
 * callbacks that would fire on the NEXT frame. That is the only way to observe
 * the leak this module exists to prevent: a hidden page holds its pending
 * callback un-run, exactly like `scheduled` here.
 */
function createFakeHost() {
  const scheduled = new Map<number, (time: number) => void>();
  let nextHandle = 1;

  const host: FrameHost = {
    requestAnimationFrame(callback) {
      const handle = nextHandle++;
      scheduled.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame(handle) {
      scheduled.delete(handle);
    },
  };

  return {
    host,
    /** Run every currently-scheduled callback once. Re-arms land in the next batch. */
    flush(time = 0): number {
      const due = [...scheduled.values()];
      scheduled.clear();
      for (const callback of due) callback(time);
      return due.length;
    },
    get live(): number {
      return scheduled.size;
    },
  };
}

describe('createFrameLoop — at most one scheduled frame', () => {
  it('schedule() cancels the outstanding frame instead of orphaning it', () => {
    const fake = createFakeHost();
    const loop = createFrameLoop(fake.host);

    loop.schedule(() => {});
    const first = loop.pending;
    loop.schedule(() => {});

    expect(first).not.toBe(0);
    expect(loop.pending).not.toBe(first);
    expect(fake.live).toBe(1);
  });

  it('clears the handle BEFORE the callback body runs', () => {
    const fake = createFakeHost();
    const loop = createFrameLoop(fake.host);
    let seen = -1;

    loop.schedule(() => {
      seen = loop.pending;
    });
    fake.flush();

    // 0 must be a truthful "nothing is scheduled" even inside an early return —
    // otherwise the re-arm guard in `resize` can never fire again.
    expect(seen).toBe(0);
  });

  it('pause() cancels the outstanding frame (the leak fix)', () => {
    const fake = createFakeHost();
    const loop = createFrameLoop(fake.host);

    loop.schedule(() => {});
    expect(fake.live).toBe(1);

    loop.pause();

    expect(loop.paused).toBe(true);
    expect(loop.pending).toBe(0);
    expect(fake.live).toBe(0);
  });

  it('resume() refuses to resume a loop that was never paused (anti-leak guard)', () => {
    const fake = createFakeHost();
    const loop = createFrameLoop(fake.host);

    expect(loop.resume()).toBe(false);

    loop.pause();
    expect(loop.resume()).toBe(true);
    // Second consecutive "visible" event: must not re-arm anything.
    expect(loop.resume()).toBe(false);
  });

  it('holds exactly ONE live loop across repeated hide/show cycles', () => {
    const fake = createFakeHost();
    const loop = createFrameLoop(fake.host);

    const render = (): void => {
      if (loop.paused) return;
      loop.schedule(render);
    };

    loop.schedule(render);
    expect(fake.live).toBe(1);

    for (let cycle = 0; cycle < 5; cycle++) {
      // hide — the browser stops running rAF, so the pending callback would
      // survive forever if `pause()` did not cancel it.
      loop.pause();
      expect(fake.live).toBe(0);

      // show
      if (loop.resume()) loop.schedule(render);
      expect(fake.live).toBe(1);

      // a spurious second "visible" event
      if (loop.resume()) loop.schedule(render);
      expect(fake.live).toBe(1);
    }

    // The pre-fix code reached `1 + N` concurrent loops here; each drew a
    // full-viewport clearRect + 100 arc/fill per frame.
    expect(fake.flush()).toBe(1);
    expect(fake.live).toBe(1);
  });

  it('leaves nothing pending after cancel() — effect cleanup can always reach the frame', () => {
    const fake = createFakeHost();
    const loop = createFrameLoop(fake.host);

    const render = (): void => {
      loop.schedule(render);
    };
    loop.schedule(render);
    fake.flush();
    fake.flush();

    loop.cancel();

    expect(loop.pending).toBe(0);
    expect(fake.live).toBe(0);
    expect(fake.flush()).toBe(0);
  });
});
