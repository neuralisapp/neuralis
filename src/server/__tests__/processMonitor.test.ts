import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The host process monitor: over a threshold ⇒ exactly ONE `perf.slow` line
 * per kind per window, under ⇒ none; start is idempotent; stop clears the
 * timer AND disables the histogram. Every probe is faked (histogram, CPU,
 * clock) so a window's numbers are exact rather than whatever this machine
 * happens to be doing.
 */

const histogram = {
  enable: vi.fn(),
  disable: vi.fn(),
  reset: vi.fn(),
  percentile: vi.fn<(p: number) => number>(() => 0),
  max: 0,
  count: 0,
};
const monitorEventLoopDelay = vi.fn(() => histogram);
vi.mock('node:perf_hooks', () => ({
  monitorEventLoopDelay: (...args: unknown[]) => monitorEventLoopDelay(...(args as [])),
}));

let settings: Record<string, unknown> = {};
vi.mock('../store/PlatformConfigStore', () => ({
  getPlatformConfigStore: () => ({
    get: (key: string) => {
      if (!(key in settings)) throw new Error(`Config key not registered: "${key}"`);
      return settings[key];
    },
  }),
}));
vi.mock('../config/env', () => ({ getEnv: () => ({}) }));

const warn = vi.fn();
vi.mock('../logging/setup', () => ({
  getLogger: () => ({
    child: () => ({ info: () => {}, warn, error: () => {}, debug: () => {} }),
  }),
}));

const STATE_KEY = Symbol.for('@neuralis/host:processMonitor');

let clockNs = BigInt(0);
let cpu = { user: 0, system: 0 };

async function freshModule() {
  vi.resetModules();
  return import('../logging/processMonitor');
}

/** Advance one window: `ms` of wall clock during which the process burned `cpuMs`. */
function window(ms: number, cpuMs: number): void {
  clockNs += BigInt(ms) * BigInt(1_000_000);
  cpu = { user: cpu.user + cpuMs * 1000, system: cpu.system };
  vi.advanceTimersByTime(ms);
}

const perfLines = () => warn.mock.calls.filter(([msg]) => msg === 'perf.slow');

beforeEach(() => {
  delete (globalThis as unknown as Record<symbol, unknown>)[STATE_KEY];
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  clockNs = BigInt(1_000_000_000);
  cpu = { user: 0, system: 0 };
  vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => clockNs);
  vi.spyOn(process, 'cpuUsage').mockImplementation(() => ({ ...cpu }));
  histogram.percentile.mockImplementation(() => 25_000_000);
  histogram.max = 30_000_000;
  histogram.count = 100;
  settings = {
    perfSampleIntervalMs: 30_000,
    perfProcessCpuWarnPercent: 80,
    perfEventLoopLagWarnMs: 200,
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('thresholds', () => {
  it('under both thresholds ⇒ no line', async () => {
    const m = await freshModule();
    m.startProcessMonitor();
    window(30_000, 3_000); // 10 % of one core
    expect(perfLines()).toHaveLength(0);
    m.stopProcessMonitor();
  });

  it('CPU over the threshold ⇒ exactly one process line with the measured percent', async () => {
    const m = await freshModule();
    m.startProcessMonitor();
    window(30_000, 45_000); // 1.5 cores
    const lines = perfLines();
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toMatchObject({ kind: 'process', cpuPercent: 150, threshold: 80, windowMs: 30_000 });
    m.stopProcessMonitor();
  });

  it('one 350 ms sample among 100 idle ones ⇒ exactly one eventloop line, in ms', async () => {
    // An isolated stall: p99 of the window stays at the idle ~25 ms, the max is the stall.
    histogram.count = 101;
    histogram.percentile.mockImplementation(() => 25_000_000);
    histogram.max = 350_000_000;
    const m = await freshModule();
    m.startProcessMonitor();
    window(30_000, 0);
    const lines = perfLines();
    expect(lines).toHaveLength(1);
    expect(lines[0][1]).toEqual({ kind: 'eventloop', maxMs: 350, p99Ms: 25, threshold: 200 });
    m.stopProcessMonitor();
  });

  it('each window is measured on its own: the histogram resets and CPU is a delta', async () => {
    const m = await freshModule();
    m.startProcessMonitor();
    window(30_000, 45_000);
    window(30_000, 3_000);
    expect(perfLines()).toHaveLength(1);
    expect(histogram.reset).toHaveBeenCalledTimes(2);
    m.stopProcessMonitor();
  });

  it('thresholds apply LIVE — read per sample, never captured at start', async () => {
    const m = await freshModule();
    m.startProcessMonitor();
    window(30_000, 15_000); // 50 %
    expect(perfLines()).toHaveLength(0);
    settings.perfProcessCpuWarnPercent = 10;
    window(30_000, 15_000);
    expect(perfLines()).toHaveLength(1);
    m.stopProcessMonitor();
  });

  it('an empty histogram window writes no eventloop line', async () => {
    histogram.count = 0;
    histogram.percentile.mockImplementation(() => 999_000_000);
    histogram.max = 999_000_000;
    const m = await freshModule();
    m.startProcessMonitor();
    window(30_000, 0);
    expect(perfLines()).toHaveLength(0);
    m.stopProcessMonitor();
  });
});

describe('lifecycle', () => {
  it('start is idempotent — one histogram, one timer, one line per window', async () => {
    const m = await freshModule();
    m.startProcessMonitor();
    m.startProcessMonitor();
    // A re-evaluated module (dev HMR, a second bundle graph) sees the same anchor.
    const again = await freshModule();
    again.startProcessMonitor();
    expect(monitorEventLoopDelay).toHaveBeenCalledTimes(1);
    expect(monitorEventLoopDelay).toHaveBeenCalledWith({ resolution: 20 });
    expect(histogram.enable).toHaveBeenCalledTimes(1);
    window(30_000, 45_000);
    expect(perfLines()).toHaveLength(1);
    m.stopProcessMonitor();
  });

  it('stop disables the histogram and clears the timer — no line afterwards', async () => {
    const m = await freshModule();
    m.startProcessMonitor();
    m.stopProcessMonitor();
    expect(histogram.disable).toHaveBeenCalledTimes(1);
    window(30_000, 45_000);
    expect(perfLines()).toHaveLength(0);
    m.stopProcessMonitor();
    expect(histogram.disable).toHaveBeenCalledTimes(1);
  });

  it('an unreadable interval key does not start a sampler, and says so', async () => {
    delete settings.perfSampleIntervalMs;
    const m = await freshModule();
    m.startProcessMonitor();
    expect(monitorEventLoopDelay).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('perf.monitor.not_started', expect.any(Object));
  });
});
