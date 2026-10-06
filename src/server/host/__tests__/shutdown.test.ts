import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The graceful-shutdown owner. These tests pin the two properties a restart
 * depends on and that nothing else can observe:
 *
 *  - the DRAIN runs FIRST, ahead of every component teardown (closing the HTTP
 *    server first would strand the very turn the drain exists to persist), and
 *  - `drainAll` calls package drain hooks, so each package reads its own
 *    live shutdown timeout. A literal at
 *    the call site silently pinned that admin control for the whole life of
 *    the feature.
 */
const drainAll = vi.fn(async () => ({ drained: 0 }));
const peekRuntime = vi.fn<() => { shutdown: () => Promise<void>; drainAll: typeof drainAll } | null>(() => null);
const configStore = vi.fn<() => { get: (key: string) => unknown }>(() => ({
  get: () => { throw new Error('Config key not registered: "shutdownDrainTimeoutMs"'); },
}));

vi.mock('../bootstrap', () => ({
  peekRuntime: () => peekRuntime(),
}));
vi.mock('../../store/PlatformConfigStore', () => ({
  getPlatformConfigStore: () => configStore(),
}));
vi.mock('../../logging/setup', () => ({
  getLogger: () => ({
    child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
  }),
}));

// The module anchors its state on globalThis (it is written from the MCP
// server's eval context and read from instrumentation's), so a fresh import
// is not a fresh state — clear the anchor between tests.
const STATE_KEY = Symbol.for('@neuralis/host:shutdown');

async function freshModule() {
  delete (globalThis as unknown as Record<symbol, unknown>)[STATE_KEY];
  vi.resetModules();
  return import('../shutdown');
}

beforeEach(() => {
  drainAll.mockClear();
  drainAll.mockResolvedValue({ drained: 0 });
  peekRuntime.mockReset();
  peekRuntime.mockReturnValue(null);
});

describe('runShutdown', () => {
  it('drains BEFORE any component teardown, and passes no timeout literal', async () => {
    const { addShutdownStep, runShutdown } = await freshModule();
    const order: string[] = [];
    drainAll.mockImplementation(async () => {
      order.push('drain');
      return { drained: 1 };
    });
    peekRuntime.mockReturnValue({ shutdown: async () => {}, drainAll });
    addShutdownStep('mcp-http', () => { order.push('mcp-http'); });

    await runShutdown('SIGTERM');

    expect(order).toEqual(['drain', 'mcp-http']);
    // No argument — the default reads shutdownDrainTimeoutMs at call time.
    expect(drainAll).toHaveBeenCalledWith();
  });

  it('unwinds registered steps in reverse registration order', async () => {
    const { addShutdownStep, runShutdown } = await freshModule();
    const order: string[] = [];
    addShutdownStep('first', () => { order.push('first'); });
    addShutdownStep('second', () => { order.push('second'); });

    await runShutdown('SIGTERM');

    expect(order).toEqual(['second', 'first']);
  });

  it('shuts agent-core down last, and only when it actually booted', async () => {
    const { addShutdownStep, runShutdown } = await freshModule();
    const order: string[] = [];
    const shutdown = vi.fn(async () => { order.push('agent-core'); });
    peekRuntime.mockReturnValue({ shutdown, drainAll });
    drainAll.mockImplementation(async () => {
      order.push('drain');
      return { drained: 0 };
    });
    addShutdownStep('mcp-http', () => { order.push('mcp-http'); });

    await runShutdown('SIGTERM');

    expect(order).toEqual(['drain', 'mcp-http', 'agent-core']);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('skips agent-core teardown when the process dies mid-bootstrap', async () => {
    const { runShutdown } = await freshModule();
    peekRuntime.mockReturnValue(null);
    await expect(runShutdown('SIGTERM')).resolves.toBeUndefined();
    // peek must never trigger a bootstrap — it is the null-returning accessor.
    expect(peekRuntime).toHaveBeenCalled();
  });

  it('runs the later steps even when the drain and an earlier step throw', async () => {
    const { addShutdownStep, runShutdown } = await freshModule();
    const order: string[] = [];
    drainAll.mockRejectedValue(new Error('drain exploded'));
    addShutdownStep('outer', () => { order.push('outer'); });
    addShutdownStep('inner', () => { throw new Error('inner exploded'); });
    const shutdown = vi.fn(async () => { order.push('agent-core'); });
    peekRuntime.mockReturnValue({ shutdown, drainAll });

    await expect(runShutdown('SIGTERM')).resolves.toBeUndefined();

    expect(order).toEqual(['outer', 'agent-core']);
  });

  it('drains ONCE — compose recreate can deliver SIGTERM more than once', async () => {
    const { runShutdown } = await freshModule();
    peekRuntime.mockReturnValue({ shutdown: async () => {}, drainAll });
    await runShutdown('SIGTERM');
    await runShutdown('SIGTERM');
    expect(drainAll).toHaveBeenCalledTimes(1);
  });
});

describe('installShutdownHandlers', () => {
  it('registers both signals and is idempotent', async () => {
    const { installShutdownHandlers } = await freshModule();
    const on = vi.spyOn(process, 'on').mockReturnValue(process);
    try {
      installShutdownHandlers();
      installShutdownHandlers();
      const signals = on.mock.calls.map(([sig]) => sig);
      expect(signals).toEqual(['SIGTERM', 'SIGINT']);
    } finally {
      on.mockRestore();
    }
  });
});

describe('the hard exit deadline', () => {
  it('forces an exit when a teardown step never settles', async () => {
    const { addShutdownStep, runShutdown } = await freshModule();
    vi.useFakeTimers();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      // Each step is individually bounded, but "bounded" is a property of each
      // step and not of their sum — one that never settles hangs the process
      // past the orchestrator grace period, and the only symptom is a SIGKILL
      // that looks exactly like having no drain at all.
      addShutdownStep('wedged', () => new Promise<void>(() => {}));
      void runShutdown('SIGTERM');
      await vi.advanceTimersByTimeAsync(31_000);
      expect(exit).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      exit.mockRestore();
      vi.useRealTimers();
    }
  });

  it('sits ABOVE the drain window — it must never truncate the drain', async () => {
    const { runShutdown } = await freshModule();
    vi.useFakeTimers();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    let releaseDrain: () => void = () => {};
    drainAll.mockImplementation(
      () => new Promise((resolve) => { releaseDrain = () => resolve({ drained: 1 }); }),
    );
    try {
      peekRuntime.mockReturnValue({ shutdown: async () => {}, drainAll });
      void runShutdown('SIGTERM');
      // A drain running for its full 25s default must still be allowed to finish.
      await vi.advanceTimersByTimeAsync(25_000);
      expect(exit).not.toHaveBeenCalled();
      releaseDrain();
      await vi.advanceTimersByTimeAsync(0);
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      vi.useRealTimers();
    }
  });

  it('falls back to the declared default when config is unreadable', async () => {
    // A process shutting down BECAUSE its bootstrap failed is exactly the caller
    // that hits an unregistered key — in the path that must not throw.
    const { runShutdown } = await freshModule();
    configStore.mockReturnValue({
      get: () => { throw new Error('Config key not registered'); },
    });
    await expect(runShutdown('SIGTERM')).resolves.toBeUndefined();
  });
});
