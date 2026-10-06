/**
 * Cross-process file mutex via `mkdir` atomicity.
 *
 * POSIX `mkdir` is atomic — only one process can create a given directory.
 * We exploit that to serialize access to (credId, scope) refresh windows
 * across multiple Node processes on the same host. Self-hosted Neuralis
 * does not add a database dependency for this; the on-disk filesystem
 * provides exactly the primitive we need.
 *
 * Stale lock recovery: each lock directory holds an `mtime.txt` file with
 * a `Date.now()` timestamp and the holder pid. If we see a lock whose
 * recorded mtime is older than `staleAfterMs`, we assume the holder
 * crashed and reclaim the lock. For the Codex refresh path the network
 * round-trip is well under the stale window so no periodic touch is
 * required; longer-running operations should pass a custom `staleAfterMs`
 * or implement their own heartbeat.
 *
 * This mutex is independent of the in-process `refreshInFlight` Map used
 * by agent-core — that map covers single-process dedup as a fast path,
 * and this mutex covers correctness across processes.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type FileMutexOptions = {
  /** Treat a lock older than this many ms as stale and reclaim it. */
  staleAfterMs?: number;
  /** Poll interval when waiting for a held lock. */
  pollIntervalMs?: number;
  /** Total wait budget before giving up. */
  timeoutMs?: number;
};

const DEFAULTS = {
  staleAfterMs: 15_000,
  pollIntervalMs: 100,
  timeoutMs: 10_000,
};

export type FileMutexRelease = () => Promise<void>;

/**
 * Acquire a mutex on `lockPath`. Returns a release function — call it
 * exactly once in a finally block. Throws if the timeout elapses while
 * another holder is alive.
 */
export async function acquireFileMutex(
  lockPath: string,
  opts: FileMutexOptions = {},
): Promise<FileMutexRelease> {
  const staleAfterMs = opts.staleAfterMs ?? DEFAULTS.staleAfterMs;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;

  const parent = dirname(lockPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });

  const deadline = Date.now() + timeoutMs;
  let reclaimedOnce = false;

  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      writeOwnerStamp(lockPath);
      return makeRelease(lockPath);
    } catch (err) {
      if (!isEexist(err)) throw err;

      const heldMtime = readOwnerStamp(lockPath);
      const now = Date.now();
      if (heldMtime !== null && now - heldMtime > staleAfterMs && !reclaimedOnce) {
        // Holder is presumed dead. Reclaim once — if we lose a tie with a
        // live holder that just refreshed the stamp, the next mkdirSync will
        // see EEXIST again and we fall through to normal polling.
        reclaimedOnce = true;
        try {
          rmSync(lockPath, { recursive: true, force: true });
        } catch {
          // Lost the race; keep polling.
        }
        continue;
      }

      if (now >= deadline) {
        throw new Error(
          `acquireFileMutex: timed out after ${timeoutMs}ms waiting for ${lockPath}`,
        );
      }

      await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now)));
    }
  }
}

function makeRelease(lockPath: string): FileMutexRelease {
  return async () => {
    try {
      rmSync(lockPath, { recursive: true, force: true });
    } catch {
      // Best-effort. A dangling lock will be reclaimed by the stale-after
      // window on the next acquire.
    }
  };
}

function writeOwnerStamp(lockPath: string): void {
  try {
    writeFileSync(
      `${lockPath}/mtime.txt`,
      `${Date.now()}\n${process.pid}\n`,
      { encoding: 'utf-8', mode: 0o600 },
    );
  } catch {
    // Non-fatal. Stale recovery falls back to a 0 timestamp which makes
    // the lock look immediately stale; acceptable for the Codex use case.
  }
}

function readOwnerStamp(lockPath: string): number | null {
  try {
    const raw = readFileSync(`${lockPath}/mtime.txt`, 'utf-8');
    const firstLine = raw.split('\n', 1)[0];
    const n = Number.parseInt(firstLine, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function isEexist(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'EEXIST'
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
