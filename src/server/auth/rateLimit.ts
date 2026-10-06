/**
 * Login attempt limiter — two axes with DIFFERENT answers.
 *
 * - `(email, address)` — the HARD lock: 5 failures inside 15 minutes lock that
 *   pair for 15 minutes. Targeted guessing against one account from one place
 *   stops here, and a success clears ONLY this pair — a valid login of your own
 *   account can never reset the counter of someone else's.
 * - `address` — a SPRAY brake, never a lock: once one address has failed
 *   against ≥ 10 distinct emails, or ≥ 25 times, inside 15 minutes, its next
 *   attempts are spaced by a progressive delay (1 s, 2 s, 4 s … capped at
 *   30 s). A hard lock here would be a platform lockout wherever the address
 *   collapses — every login behind a reverse proxy or a Docker gateway arrives
 *   from ONE peer until trusted proxies are declared.
 *
 * An unknown email counts exactly like a known one. The thresholds are code
 * floors, never platform config. Process-local by design (a multi-node deploy
 * gets N× the attempts — note for HA), and `globalThis`-anchored so every
 * module graph that loads this file counts into the same maps.
 */

const HARD_LOCK_ATTEMPTS = 5;
const HARD_LOCK_MS = 15 * 60 * 1000;
const SPRAY_WINDOW_MS = 15 * 60 * 1000;
const SPRAY_DISTINCT_EMAILS = 10;
const SPRAY_FAILURES = 25;
const SPRAY_MAX_DELAY_MS = 30_000;
/** Per-address history kept for the spray test — the thresholds need no more. */
const SPRAY_HISTORY_CAP = 64;
const EVICTION_MS = 60 * 60 * 1000;

type PairEntry = { attempts: number; firstAttempt: number; lockedUntil: number; lastAttempt: number };
type AddressEntry = {
  /** Recent failures, oldest first: `[timestamp, email]`, capped. */
  failures: Array<[number, string]>;
  /** The earliest moment the next attempt from this address may run. */
  nextSlot: number;
  lastAttempt: number;
};
type LimiterState = { pairs: Map<string, PairEntry>; addresses: Map<string, AddressEntry> };

const STATE_SLOT = Symbol.for('@neuralis/host:loginRateLimit');

function state(): LimiterState {
  const g = globalThis as { [STATE_SLOT]?: LimiterState };
  return (g[STATE_SLOT] ??= { pairs: new Map(), addresses: new Map() });
}

/** Clears the process-wide maps. Tests only. */
export function resetLoginRateLimitForTests(): void {
  const s = state();
  s.pairs.clear();
  s.addresses.clear();
}

function pairKey(email: string, address: string): string {
  return `${address}\u0000${email.toLowerCase().trim()}`;
}

function evictStale(now: number): void {
  const cutoff = now - EVICTION_MS;
  const s = state();
  for (const [key, entry] of s.pairs) if (entry.lastAttempt < cutoff) s.pairs.delete(key);
  for (const [key, entry] of s.addresses) if (entry.lastAttempt < cutoff) s.addresses.delete(key);
}

function sprayExcess(entry: AddressEntry | undefined, now: number): number {
  if (!entry) return 0;
  const recent = entry.failures.filter(([at]) => at > now - SPRAY_WINDOW_MS);
  const distinct = new Set(recent.map(([, email]) => email)).size;
  return Math.max(recent.length - SPRAY_FAILURES + 1, distinct - SPRAY_DISTINCT_EMAILS + 1, 0);
}

export type LoginGate =
  /** The `(email, address)` pair is hard-locked. */
  | { kind: 'locked'; retryAfter: number }
  /** The address is spraying and its queue is already `SPRAY_MAX_DELAY_MS` deep. */
  | { kind: 'spray_refused'; retryAfter: number }
  /** Run the attempt after `waitMs` (0 unless the address is spraying). */
  | { kind: 'proceed'; waitMs: number };

/**
 * Admit one login attempt. A spraying address reserves the next SLOT, so
 * parallel attempts are serialized one per delay instead of all waiting the
 * same delay and then running together; an attempt that would wait longer than
 * the cap is refused outright, never locked.
 */
export function beginLoginAttempt(email: string, address: string): LoginGate {
  const now = Date.now();
  evictStale(now);
  const s = state();

  const pair = s.pairs.get(pairKey(email, address));
  if (pair && pair.lockedUntil > now) {
    return { kind: 'locked', retryAfter: Math.ceil((pair.lockedUntil - now) / 1000) };
  }

  const entry = s.addresses.get(address);
  const excess = sprayExcess(entry, now);
  if (!entry || excess === 0) return { kind: 'proceed', waitMs: 0 };

  const delay = Math.min(1000 * 2 ** (excess - 1), SPRAY_MAX_DELAY_MS);
  const start = Math.max(now, entry.nextSlot);
  const waitMs = start - now;
  if (waitMs >= SPRAY_MAX_DELAY_MS) {
    return { kind: 'spray_refused', retryAfter: Math.ceil(waitMs / 1000) };
  }
  entry.nextSlot = start + delay;
  entry.lastAttempt = now;
  return { kind: 'proceed', waitMs };
}

/** A failed attempt — wrong password, unknown email or an inactive account alike. */
export function recordLoginFailure(email: string, address: string): void {
  const now = Date.now();
  const s = state();
  const key = pairKey(email, address);
  let pair = s.pairs.get(key);
  if (!pair || pair.firstAttempt <= now - HARD_LOCK_MS || (pair.lockedUntil > 0 && pair.lockedUntil <= now)) {
    pair = { attempts: 0, firstAttempt: now, lockedUntil: 0, lastAttempt: now };
  }
  pair.attempts += 1;
  pair.lastAttempt = now;
  if (pair.attempts >= HARD_LOCK_ATTEMPTS) pair.lockedUntil = now + HARD_LOCK_MS;
  s.pairs.set(key, pair);

  const entry = s.addresses.get(address) ?? { failures: [], nextSlot: 0, lastAttempt: now };
  entry.failures.push([now, email.toLowerCase().trim()]);
  if (entry.failures.length > SPRAY_HISTORY_CAP) entry.failures.splice(0, entry.failures.length - SPRAY_HISTORY_CAP);
  entry.lastAttempt = now;
  s.addresses.set(address, entry);
}

/** A successful login clears its OWN pair — never the address, never another email. */
export function recordLoginSuccess(email: string, address: string): void {
  state().pairs.delete(pairKey(email, address));
}
