/**
 * Host process monitor — the Node process's CPU and event-loop lag, sampled
 * once per window, and ONE `perf.slow` warning line per threshold crossed.
 *
 * Host plumbing beside the route log: the host owns the process, its logs and
 * their keys (`HOST_CONFIG_SETTINGS`). It writes to the console logger
 * (`getLogger().child('perf')` ⇒ `docker logs`), because a performance signal
 * in a file nobody tails is the failure this exists to prevent.
 *
 * What it measures, stated rather than implied:
 *   - `cpuPercent` — (user + system CPU µs) / (wall-clock window µs) × 100 for
 *     THIS Node process, all its threads included. 100 = one full core. It is
 *     not the container: Qdrant and every other container are `docker stats`.
 *   - `maxMs` / `p99Ms` — `monitorEventLoopDelay` at a 20 ms resolution. The
 *     recorded delay includes that resolution (an idle process reads ~20-30
 *     ms). The warning keys on `maxMs`, the longest single stall of the
 *     window: a stall is ONE sample, so a p99 trigger never sees an isolated
 *     one. `p99Ms` rides along as context (sustained vs one-off).
 *
 * Cost: the histogram's own 20 ms libuv timer, one `cpuUsage()` + one
 * `hrtime` read + three config-store reads (in-memory) per window (30 s by
 * default), and a console line only above a threshold. The timer is `unref()`d
 * — it never holds the process open.
 *
 * ONE instance per process, anchored on `globalThis` (`Symbol.for`): Next
 * evaluates a server module once per bundle graph and dev HMR re-evaluates it,
 * and a module-level `let` would start a second sampler each time.
 */

import { monitorEventLoopDelay, type ELDHistogram } from 'node:perf_hooks';
import { getEnv } from '../config/env';
import { getPlatformConfigStore } from '../store/PlatformConfigStore';
import { getLogger } from './setup';

type MonitorState = {
  timer: ReturnType<typeof setInterval>;
  histogram: ELDHistogram;
  lastCpu: NodeJS.CpuUsage;
  lastAtNs: bigint;
};

const STATE_KEY = Symbol.for('@neuralis/host:processMonitor');

function slot(): { current?: MonitorState } {
  const g = globalThis as unknown as Record<symbol, { current?: MonitorState } | undefined>;
  let s = g[STATE_KEY];
  if (!s) {
    s = {};
    g[STATE_KEY] = s;
  }
  return s;
}

/** A host number key, read per sample; `undefined` when the store cannot answer. */
function hostNumber(key: string): number | undefined {
  try {
    const value = getPlatformConfigStore().get(key);
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function sample(state: MonitorState): void {
  const log = getLogger().child('perf');
  const nowNs = process.hrtime.bigint();
  const cpu = process.cpuUsage();
  const windowMs = Number(nowNs - state.lastAtNs) / 1e6;

  if (windowMs > 0) {
    const cpuMs = (cpu.user - state.lastCpu.user + cpu.system - state.lastCpu.system) / 1000;
    const cpuPercent = round1((cpuMs / windowMs) * 100);
    const threshold = hostNumber('perfProcessCpuWarnPercent');
    if (threshold !== undefined && cpuPercent > threshold) {
      log.warn('perf.slow', { kind: 'process', cpuPercent, threshold, windowMs: Math.round(windowMs) });
    }
  }

  if (state.histogram.count > 0) {
    const maxMs = round1(state.histogram.max / 1e6);
    const threshold = hostNumber('perfEventLoopLagWarnMs');
    if (threshold !== undefined && maxMs >= threshold) {
      log.warn('perf.slow', {
        kind: 'eventloop',
        maxMs,
        p99Ms: round1(state.histogram.percentile(99) / 1e6),
        threshold,
      });
    }
  }

  state.histogram.reset();
  state.lastCpu = cpu;
  state.lastAtNs = nowNs;
}

/**
 * Start the sampler. Idempotent — a second call while one runs is a no-op.
 * The window length (`perfSampleIntervalMs`) is read ONCE here; the two
 * thresholds are read per sample, so they apply live.
 */
export function startProcessMonitor(): void {
  const s = slot();
  if (s.current) return;
  const log = getLogger().child('perf');

  let intervalMs: number | undefined;
  try {
    // Registers the host keys when this runs before bootstrap has.
    getEnv();
    intervalMs = hostNumber('perfSampleIntervalMs');
  } catch (err) {
    log.warn('perf.monitor.not_started', { reason: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (intervalMs === undefined) {
    log.warn('perf.monitor.not_started', { reason: 'perfSampleIntervalMs unreadable' });
    return;
  }

  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const state: MonitorState = {
    histogram,
    lastCpu: process.cpuUsage(),
    lastAtNs: process.hrtime.bigint(),
    timer: setInterval(() => {
      try {
        sample(state);
      } catch (err) {
        log.warn('perf.monitor.sample_failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }, intervalMs),
  };
  state.timer.unref();
  s.current = state;
}

/** Stop the sampler: clear the timer and disable the histogram. Idempotent. */
export function stopProcessMonitor(): void {
  const s = slot();
  const state = s.current;
  if (!state) return;
  clearInterval(state.timer);
  state.histogram.disable();
  s.current = undefined;
}
