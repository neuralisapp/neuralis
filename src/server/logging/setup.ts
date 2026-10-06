/**
 * Logging setup for neuralis (community edition).
 *
 * The host keeps only a console logger. Package-scoped file logging happens
 * inside PackageLoader via PackageLogger -> data/<slug>/logs/*.jsonl.
 */
import {
  ConsoleLogger,
  type Logger,
  type LogLevel,
} from '@neuralis/package-system/data';

const VALID_LEVELS = new Set<string>(['debug', 'info', 'warn', 'error', 'silent']);

function resolveLevel(envVar: string | undefined, fallback: LogLevel): LogLevel {
  const raw = (envVar ?? '').trim().toLowerCase();
  return VALID_LEVELS.has(raw) ? (raw as LogLevel) : fallback;
}

let rootLogger: Logger | null = null;

export function getLogger(): Logger {
  if (rootLogger) return rootLogger;

  const consoleLevel = resolveLevel(process.env.LOG_LEVEL, 'info');
  rootLogger = new ConsoleLogger({ level: consoleLevel, scope: 'neuralis' });
  return rootLogger;
}

/**
 * Re-level the ROOT logger from the `logLevel` platform-config value
 * (tunable-tanager Inc 2). Called at the END of `getEnv()` — the root logger
 * is built by `instrumentation.ts` BEFORE any config store exists (and is
 * cached forever), so a store-read inside `getLogger` would never fire on the
 * live boot path. `ConsoleLogger.level` is a public mutable field read
 * per-call by `shouldLog`, so this applies to every subsequent root-logger
 * line; CHILD loggers copy the level at `child()` time — the pre-`getEnv`
 * children (the bootstrap prewarm scope) keep the env level, documented.
 * Invalid values are ignored (env/'info' stays).
 */
export function applyConfiguredLogLevel(value: unknown): void {
  if (typeof value !== 'string') return;
  const raw = value.trim().toLowerCase();
  if (!VALID_LEVELS.has(raw)) return;
  const logger = getLogger();
  if (logger instanceof ConsoleLogger) {
    logger.level = raw as LogLevel;
  }
}

export function resetLogger(): void {
  rootLogger = null;
}
