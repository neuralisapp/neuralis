/**
 * Process-level graceful shutdown for the community host.
 *
 * ONE owner for SIGTERM/SIGINT. Before this module the handler lived inside
 * `startMcpServer()`, which left two holes a restart could fall through:
 *
 *   1. `MCP_HTTP_PORT=0|false` returns from `instrumentation.register()`
 *      BEFORE `startMcpServer()` runs, so that deployment had NO handler at
 *      all — every `docker compose up -d --build` killed the in-flight turn.
 *   2. `startMcpServer()` awaited the runtime near its top and only called
 *      `process.on(...)` at its END, so a bootstrap REJECTION (or any throw in
 *      between) skipped registration entirely — precisely the boot window
 *      where a restart is most likely.
 *
 * The handlers are therefore installed by `instrumentation.register()` as its
 * FIRST action: unconditional, and before anything that can await or throw.
 * Components that own teardown register a step; the MCP server is one such
 * registrant rather than the shutdown owner.
 *
 * Order is fixed and load-bearing:
 *   1. `runtime.drainAll()` — every package's `drain` hook (the stream owner
 *      aborts + awaits finalize/persist for every in-flight turn, bounded by
 *      its own live `shutdownDrainTimeoutMs`). FIRST, because the SSE route
 *      generators must still be pumping for the aborted provider await to
 *      unwind into their cleanup `finally`. Closing the HTTP server first would
 *      strand exactly the turn we are trying to save.
 *   2. Registered steps, LIFO — unwind in reverse registration order, the
 *      conventional teardown direction (a later registrant may depend on an
 *      earlier one still being up).
 *   3. `runtime.shutdown()` — connector lifecycle + every package's `stop`.
 *
 * Steps 1 and 3 run on the PEEKED runtime, never one awaited into existence:
 * booting the runtime *during* shutdown would be absurd, so a process dying
 * mid-bootstrap (or whose bootstrap failed) drains nothing and tears nothing
 * down — nothing it owns is running yet.
 *
 * Every step is individually try/caught: one failing teardown must not strand
 * the ones after it. Next's own signal handling closes the HTTP server; we do
 * not take that over. A watchdog does force an exit, but only past a deadline
 * ABOVE the drain window — see `runShutdown`.
 */
import { getPlatformConfigStore } from '../store/PlatformConfigStore';
import { peekRuntime } from './bootstrap';
import { getLogger } from '../logging/setup';

export type ShutdownStep = {
  /** Human-readable label used in shutdown logs. */
  label: string;
  run: () => void | Promise<void>;
};

type ShutdownState = {
  steps: ShutdownStep[];
  installed: boolean;
  shuttingDown: boolean;
};

/**
 * globalThis-anchored (agent-core's module-state rule): `addShutdownStep` is
 * called from `startMcpServer`'s module-eval context while the handler runs in
 * `instrumentation`'s. A plain module-level array can silently split across
 * bundler chunk boundaries — the reader would see an EMPTY step list and skip
 * every teardown with no error anywhere.
 */
const STATE_KEY = Symbol.for('@neuralis/host:shutdown');

function getState(): ShutdownState {
  const g = globalThis as unknown as Record<symbol, ShutdownState | undefined>;
  let state = g[STATE_KEY];
  if (!state) {
    state = { steps: [], installed: false, shuttingDown: false };
    g[STATE_KEY] = state;
  }
  return state;
}

/**
 * Register a teardown step. Steps run in REVERSE registration order after the
 * package drain and before the runtime's own shutdown. Registering after a
 * shutdown has begun is a no-op (the step would never run anyway).
 */
export function addShutdownStep(label: string, run: ShutdownStep['run']): void {
  const state = getState();
  if (state.shuttingDown) return;
  state.steps.push({ label, run });
}

/**
 * Install the SIGTERM/SIGINT handlers. Idempotent — a second call is a no-op,
 * so a re-entered `register()` (dev HMR, a re-imported instrumentation chunk)
 * cannot stack duplicate handlers.
 */
export function installShutdownHandlers(): void {
  const state = getState();
  if (state.installed) return;
  state.installed = true;
  process.on('SIGTERM', () => {
    void runShutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void runShutdown('SIGINT');
  });
}

/** Drain default, mirrored from the `shutdownDrainTimeoutMs` manifest declaration. */
const FALLBACK_DRAIN_MS = 25_000;
/** Headroom for teardown + runtime shutdown, on top of the drain window. */
const EXIT_HEADROOM_MS = 7_000;
/**
 * Below the compose `stop_grace_period` (40s). Past that Docker SIGKILLs us, so
 * a deadline above it could never fire and the watchdog would be decorative.
 */
const MAX_EXIT_DEADLINE_MS = 32_000;

/**
 * How long the whole shutdown may take before we force an exit.
 *
 * Derived from the live drain window so the two can never cross: a deadline at
 * or below the drain would truncate the very thing it protects.
 *
 * Reads DEFENSIVELY. `PlatformConfigStore.get()` throws for an unregistered key,
 * and the registry is populated from package manifests at bootstrap — so a
 * process shutting down BECAUSE its bootstrap failed is exactly the caller that
 * would take that throw, in the exact path that must not throw. Falling back to
 * the declared default keeps the watchdog armed when it is needed most.
 */
function resolveExitDeadlineMs(): number {
  let drainWindowMs = FALLBACK_DRAIN_MS;
  try {
    const configured = getPlatformConfigStore().get('shutdownDrainTimeoutMs');
    if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
      drainWindowMs = configured;
    }
  } catch {
    // Unregistered (bootstrap never completed) — the default is the right answer.
  }
  return Math.min(drainWindowMs + EXIT_HEADROOM_MS, MAX_EXIT_DEADLINE_MS);
}

/**
 * Run the shutdown sequence once. Exported for tests; production entry is the
 * signal handler. A second signal during an in-flight shutdown is ignored —
 * compose recreate can deliver SIGTERM more than once, and re-entering would
 * drain a second time against an already-empty set.
 */
export async function runShutdown(signal: string): Promise<void> {
  const state = getState();
  if (state.shuttingDown) return;
  state.shuttingDown = true;

  const log = getLogger().child('shutdown');
  log.info(`${signal} received — draining before exit`);

  // Hard exit deadline.
  //
  // Everything below is individually bounded, but "bounded" is a property of
  // each step, not of their sum: a teardown that never settles (a socket that
  // will not close, a connector awaiting a dead backend) hangs the process past
  // the orchestrator's grace period, and the only visible symptom is Docker
  // SIGKILLing us — which looks exactly like having no drain at all.
  //
  // The deadline is derived from the drain window rather than configured
  // separately: it must sit ABOVE it (or it would truncate the drain it exists
  // to protect) and BELOW the compose `stop_grace_period` (40s), or it never
  // fires because SIGKILL beats it. Drain default 25s → 32s.
  //
  // This is the bounded-exit half of what `NEXT_MANUAL_SIG_HANDLE=1` was
  // considered for. The flag itself is deliberately NOT set: it suppresses
  // Next's own SIGTERM cleanup, and that cleanup is module-internal
  // (`next/dist/server/lib/start-server.js`), so taking it over would mean
  // abruptly killing in-flight NON-stream requests that Next currently closes
  // gracefully — trading a working graceful close for determinism on a path
  // that already works. A watchdog buys the determinism without the trade.
  const deadlineMs = resolveExitDeadlineMs();
  const watchdog = setTimeout(() => {
    log.warn(`Shutdown exceeded ${deadlineMs}ms — forcing exit`);
    process.exit(0);
  }, deadlineMs);
  // Never hold the event loop open on our own account: if everything else has
  // finished, the process should exit because it is idle, not wait out a timer.
  watchdog.unref?.();

  // 1. Every package's in-flight work — only if the runtime actually booted.
  const runtime = peekRuntime();
  if (runtime) {
    try {
      await runtime.drainAll();
    } catch (err) {
      log.warn(`Package drain failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2. Registered component teardown, LIFO.
  for (const step of [...state.steps].reverse()) {
    try {
      await step.run();
    } catch (err) {
      log.warn(
        `Shutdown step "${step.label}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 3. The runtime — only if it actually booted.
  if (runtime) {
    try {
      await runtime.shutdown();
    } catch (err) {
      log.warn(`Runtime shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  clearTimeout(watchdog);
  log.info('Shutdown complete');
}
