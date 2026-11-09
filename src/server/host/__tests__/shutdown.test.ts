import { EventEmitter } from 'node:events';
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

// Windows has no SIGTERM to deliver: `neuralis up` stops its host with a
// `shutdown` message on the ipc channel. It must reach THIS owner — the drain —
// not a second stop path. The SIGTERM listener the owner installs is captured,
// and a stand-in process carries the channel events to it.
describe('the supervisor\'s ipc stop reaches the shutdown owner', () => {
  async function wired() {
    const { installShutdownHandlers } = await freshModule();
    const { followSupervisor } = await import('../homeLock');
    const on = vi.spyOn(process, 'on').mockReturnValue(process);
    let onSigterm: (() => void) | undefined;
    try {
      installShutdownHandlers();
      onSigterm = on.mock.calls.find(([event]) => event === 'SIGTERM')?.[1] as () => void;
    } finally {
      on.mockRestore();
    }
    const proc = Object.assign(new EventEmitter(), { connected: true, send: () => true, channel: { unref: vi.fn() } });
    proc.on('SIGTERM', onSigterm!);
    peekRuntime.mockReturnValue({ shutdown: async () => {}, drainAll });
    expect(followSupervisor({ NEURALIS_SUPERVISOR: 'ipc' }, proc as never)).toBe('following');
    expect(proc.channel.unref).toHaveBeenCalled();
    return proc;
  }
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it('`shutdown` drains through the owner, once; another message does nothing (paired control)', async () => {
    const proc = await wired();
    proc.emit('message', 'stop-please');
    await settle();
    expect(drainAll).not.toHaveBeenCalled();
    proc.emit('message', 'shutdown');
    proc.emit('message', 'shutdown');
    await settle();
    expect(drainAll).toHaveBeenCalledTimes(1);
  });

  it('the channel\'s loss (the supervisor died) drains through the owner too', async () => {
    const proc = await wired();
    proc.emit('disconnect');
    await settle();
    expect(drainAll).toHaveBeenCalledTimes(1);
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

describe('open client connections (a browser tab, an SSE tap, an MCP client)', () => {
  it('are closed after the teardown, so a production server.close() finishes in seconds, not at the kill', async () => {
    const { createServer, request, Server } = await import('node:http');
    const hadOwnEmit = Object.getOwnPropertyNames(Server.prototype).includes('emit');
    const { installUpgradeWatchdog } = await import('../../upgradeWatchdog');
    installUpgradeWatchdog();
    const server = createServer((_req, res) => {
      // An SSE-shaped response that never ends on its own.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': open\n\n');
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      await new Promise<void>((resolve) => {
        const req = request({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
          res.once('data', () => resolve());
          res.on('error', () => {});
        });
        req.on('error', () => {});
        req.end();
      });
      // Next's own SIGTERM cleanup: stop accepting and wait for every connection.
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      const { runShutdown } = await freshModule();
      await runShutdown('SIGTERM');
      const outcome = await Promise.race([
        closed.then(() => 'closed' as const),
        new Promise<'held'>((resolve) => setTimeout(() => resolve('held'), 2_000)),
      ]);
      expect(outcome).toBe('closed');
    } finally {
      server.closeAllConnections();
      server.close();
      if (!hadOwnEmit) Reflect.deleteProperty(Server.prototype, 'emit');
      Reflect.deleteProperty(Server.prototype, Symbol.for('neuralis.upgradeWatchdog.v1'));
      const https = await import('node:https');
      Reflect.deleteProperty(https.Server.prototype, 'emit');
      Reflect.deleteProperty(https.Server.prototype, Symbol.for('neuralis.upgradeWatchdog.v1'));
      delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('neuralis.upgradeWatchdog.servers.v1')];
    }
  });
});
