/**
 * Host-owned file loggers — the ones that belong to the HOST rather than to any
 * package.
 *
 * `app/logs/routes.jsonl` sits next to the audit log the host already writes
 * (`store/AuditStore.ts`, `join(getEnv().appRoot, 'logs', 'audit.jsonl')`), so
 * this adds no new directory and inherits the exposure `audit.jsonl` already
 * carries. It is deliberately `getEnv().appRoot` and NOT admin's exported
 * `getAppRoot()`: that helper belongs to `@neuralis/admin`, and a host module
 * importing a package's internals inverts Architectural Principle 1.
 */

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { asLogLevel, LOG_LEVELS, PackageLogger, type LogLevel } from '@neuralis/package-system/data';
import type { RouteLogger } from '@neuralis/package-system';
import { getEnv } from '../config/env';
import { getPlatformConfigStore } from '../store/PlatformConfigStore';
import { getLogger } from './setup';

/** Read one host key without letting an early-boot/unregistered read throw. */
function hostSetting(key: string): unknown {
  try {
    return getPlatformConfigStore().get(key);
  } catch {
    return undefined;
  }
}

let routeLogger: RouteLogger | null = null;

/** Status classes a terminal colours at a glance: 2xx green, 3xx cyan, 4xx yellow, 5xx red. */
function statusDot(status: number): string {
  const color = status >= 500 ? 31 : status >= 400 ? 33 : status >= 300 ? 36 : 32;
  return `\x1b[${color}m●\x1b[0m`;
}

/**
 * Console-only: a coloured dot before the status, so a `slow` warn on a 200
 * reads apart from a real 4xx/5xx in `docker logs`. The file line and the admin
 * Logs tab keep the plain message — ANSI there would be noise, not colour.
 */
export function withStatusDot(msg: string, meta?: Record<string, unknown>): string {
  const status = meta?.status;
  if (typeof status !== 'number') return msg;
  const marker = `-> ${status}`;
  const at = msg.lastIndexOf(marker);
  return at < 0 ? msg : `${msg.slice(0, at)}-> ${statusDot(status)} ${msg.slice(at + 3)}`;
}

/**
 * The route dispatch log — the FILE `app/logs/routes.jsonl` AND the Docker
 * console (`getLogger().child('routes')` ⇒ `docker logs`, which additionally
 * applies its own `logLevel`). Two gates, decided independently per line:
 *
 *   file     `routeLogLevel`
 *   console  `routeConsoleLogLevel`, or — when it is empty or not a level —
 *            the file's resolved level
 *
 * With `routeConsoleLogLevel` empty (the default) both sinks carry the same
 * set — at the `warn` default denials, faults and slow requests — so a refusal
 * a broken client repeats every minute stays visible where an operator
 * actually looks. The console is never gated by its OWN level alone: a plain
 * composite would print every fast 200 (console default `info`) while the file
 * drops it. Setting `routeConsoleLogLevel` splits them: file `info` + console
 * `warn` keeps the full request log on disk and `docker logs` quiet, and a
 * console level BELOW the file's prints lines the file drops.
 *
 * Its OWN `route*` keys, not `packageLogLevel`. That key's description says it
 * governs `data://<package>/logs/*.jsonl`, which this file is not — and an
 * operator setting it to `warn` (the likely production choice, given the
 * volume) would then silently delete the entire successful-request log, the
 * exact artifact this exists to produce.
 *
 * Volume is the reason `routeLogLevel` defaults to `warn` rather than `info`.
 * Several client surfaces poll on a second-scale cadence through
 * `getPackageApi()` → `/api/packages/[...path]` → this dispatcher: one open
 * shell tab alone is roughly 34k lines and 8.5 MB per DAY. At `info` a handful
 * of users collapses the forensic window to hours; at `warn` the file records
 * denials, faults and slow dispatches (`routeSlowMs`, escalated by the kernel
 * dispatcher whatever the status) — every question this log exists to answer —
 * and retention is months. An operator raises it to `info`
 * for a debugging window and it applies LIVE, with no restart, because
 * `PackageLogger` resolves its level per call.
 *
 * Retention the shipped defaults buy, stated rather than implied:
 * 25 MB x 5 files = 125 MB of denials, faults and slow dispatches.
 */
export function getRouteLogger(): RouteLogger {
  if (routeLogger) return routeLogger;
  const logsDir = join(getEnv().appRoot, 'logs');
  mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  const file = new PackageLogger({
    logsDir,
    packageSlug: 'host',
    // The FILE comes from `fileName`; `packageSlug` is the `pkg` field of every
    // line, not a path segment.
    fileName: 'routes.jsonl',
    // Lazy on purpose — this may be built before the config store has its
    // package-declared rows, and the level must track admin edits anyway.
    levelSource: () => {
      const value = hostSetting('routeLogLevel');
      return typeof value === 'string' ? value : undefined;
    },
    // The rotation knobs are HOST keys. `kernelTunable` only knows the
    // `packageLog*` names, so this file supplies its own thunks rather than
    // borrowing the package budget.
    maxBytesSource: () => {
      const value = hostSetting('routeLogMaxBytes');
      return typeof value === 'number' ? value : undefined;
    },
    maxFilesSource: () => {
      const value = hostSetting('routeLogMaxFiles');
      return typeof value === 'number' ? value : undefined;
    },
    maxAgeDaysSource: () => {
      const value = hostSetting('routeLogMaxAgeDays');
      return typeof value === 'number' ? value : undefined;
    },
  });
  // Built AFTER `getEnv()` above, so the child copies the configured
  // `logLevel` rather than the pre-store env level.
  const consoleArm = getLogger().child('routes');
  const sink = (lvl: Exclude<LogLevel, 'debug' | 'silent'>) =>
    (msg: string, meta?: Record<string, unknown>): void => {
      const fileLevel = file.level;
      const consoleSetting = hostSetting('routeConsoleLogLevel');
      const consoleLevel =
        asLogLevel(typeof consoleSetting === 'string' ? consoleSetting : undefined) ?? fileLevel;
      if (LOG_LEVELS[lvl] >= LOG_LEVELS[fileLevel]) file[lvl](msg, meta);
      if (LOG_LEVELS[lvl] >= LOG_LEVELS[consoleLevel]) consoleArm[lvl](withStatusDot(msg, meta), meta);
    };
  routeLogger = { info: sink('info'), warn: sink('warn'), error: sink('error') };
  return routeLogger;
}

/**
 * The slow-request threshold every `RouteDispatcher` reads per dispatch
 * (`routeSlowMs`). A thunk for the same reason as `levelSource`: the
 * dispatchers are built at package load, and the key must track admin edits.
 */
export function routeSlowMsSource(): number | undefined {
  const value = hostSetting('routeSlowMs');
  return typeof value === 'number' ? value : undefined;
}

/**
 * The catch-all's PRE-dispatch wait — how long a request sat on the runtime's
 * readiness before its route ran. A line only when it actually waited
 * (`waitMs > 0`, i.e. the boot window), so a warm process writes nothing:
 * `warn` from `routeSlowMs` up (the default `warn` file level keeps it), `info`
 * below. `meta.waitMs` is the number a boot-readiness measurement reads.
 */
export function logRuntimeWait(method: string, path: readonly string[], waitMs: number): void {
  if (!(waitMs > 0)) return;
  const slowMs = routeSlowMsSource();
  const line = `${method} /${path.join('/')} waited ${waitMs}ms for runtime readiness`;
  const meta = { waitMs, phase: 'pre-dispatch' };
  if (slowMs !== undefined && waitMs >= slowMs) getRouteLogger().warn(line, meta);
  else getRouteLogger().info(line, meta);
}

/** Tests / shutdown. */
export function resetRouteLogger(): void {
  routeLogger = null;
}
