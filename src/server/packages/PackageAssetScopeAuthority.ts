/**
 * PackageAssetScopeAuthority — bounded, identity-free package asset scopes
 * (CARD1 3A).
 *
 * Follows the `SessionTicketAuthority` opaque-token pattern (high-entropy
 * random handle, in-memory live map, restart invalidation) with three
 * additions: idle expiry, a per-user hard cap and a periodic sweep. One
 * crucial DIFFERENCE: the handle is **NOT an authorizing capability** — every
 * asset GET / heartbeat re-runs the FULL canonical session + shared
 * package/surface visibility gate (`resolveVisiblePackageSurface`) and only
 * uses the record to resolve the real coordinates and to compare
 * trust / generation / fingerprint. A stolen handle without the owning
 * user's session resolves nothing.
 *
 * The record binds user + project + effective verified agent scope + package
 * + surfaceKind/surfaceId + renderer/trust/fingerprint + package generation +
 * the EXACT surface root (+ optional shared root) + idle expiry. The handle
 * itself is 192 bits of meaning-free randomness; no package/project/user id
 * is derivable from it.
 *
 * ONE RECORD, TWO KEYS. Beside the `handle` index, the record carries a second,
 * INDEPENDENTLY drawn `pubToken` indexed separately (`getByPubToken`) — the key
 * of the session-free subresource lane. Both indexes hold the SAME object, and
 * EVERY removal path (lazy expiry on either lane, owner close, server revoke,
 * principal revocation, sweep, per-user-cap eviction) goes through the single
 * private `#forget`, so a
 * revoked scope can never keep a live public lane.
 *
 * Bounded-ness:
 *   - idle expiry: {@link DEFAULT_IDLE_TTL_MS} (5 min) since the last mint /
 *     heartbeat / served asset;
 *   - per-user hard cap {@link DEFAULT_MAX_PER_USER} (128): at the cap the
 *     LEAST-RECENTLY-active record of that user is revoked to admit the new
 *     one (its client re-mints on the resulting 410 — bounded, never a mint
 *     denial-of-service);
 *   - periodic sweep (module getter arms an unref'd interval) + lazy sweep on
 *     every access;
 *   - process restart drops the map — every persisted handle answers 410.
 */

import { randomBytes } from 'node:crypto';
import type { PackageTrust, SurfaceAssetMode } from '@neuralis/package-system/contracts';
import type { SurfaceAssetKind } from '@neuralis/package-system';

export const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_MAX_PER_USER = 128;
const SWEEP_INTERVAL_MS = 60 * 1000;

export type PackageAssetScopeRecord = {
  handle: string;
  userId: string;
  projectId: string;
  /** VERIFIED agent scope bound at mint (K7) — never a raw header value. */
  agentId?: string;
  packageId: string;
  surfaceKind: SurfaceAssetKind;
  surfaceId: string;
  renderer: string;
  trust: PackageTrust;
  /** Server-computed surface fingerprint at mint (GET recheck → 410 on drift). */
  fingerprint: string;
  /** Package load generation at mint (update/reload → 410 on recheck). */
  generation: string;
  /** Absolute path of the EXACT dedicated surface root. */
  surfaceRoot: string;
  /** Absolute path of the package-public `app/shared/` root (optional). */
  sharedRoot?: string;
  /** Entry path relative to `surfaceRoot`. */
  entryRelPath: string;
  /**
   * How the surface's entry document expects its subresources to be served, set
   * at mint from the surface's NORMALIZED declaration
   * (`VisiblePackageSurface.assetMode`, produced by the one shared
   * `normalizeSurfaceAssetMode`). The mint route is the ONLY producer.
   *
   * ABSENT means self-contained — the import-unchanged floor, and the
   * fail-closed default for any mint that does not supply it. A surface that
   * declares nothing keeps the original behaviour exactly: one document, inline
   * CSS/JS and `data:` URIs, no `<base>` injected, nothing served on the
   * session-free lane. Only a normalized `'bundle'` opts a surface in.
   *
   * It stays OPTIONAL here on purpose. Requiring it would only relocate the
   * decision to every test factory; the decision that matters is forced where it
   * belongs — `VisiblePackageSurface.assetMode` is REQUIRED, so tsc catches a
   * resolution path that forgets to make it, and absence here degrades to the
   * safe mode rather than to an unchecked one.
   */
  assetMode?: SurfaceAssetMode;
  /**
   * Second, INDEPENDENT 192-bit token: the key of the SESSION-FREE subresource
   * lane. Drawn separately from `handle` — never derived from it, never
   * interchangeable with it — and born and destroyed with the same record.
   * It is deliberately a NARROW capability (the package's own non-document
   * static files, in this generation, inside this record's roots AS RESOLVED
   * THROUGH SYMLINKS by `openContainedAssetFile`, for the record's idle window)
   * whereas `handle` is NOT a capability at all. The real-path qualifier is not
   * decoration: the roots below are stored lexically, and a link under one of
   * them used to serve its target from anywhere on the host.
   * It never appears on a mint/heartbeat response.
   */
  pubToken: string;
  /**
   * Distinct files already served on the session-free lane under this scope:
   * resolved absolute path → byte size. A repeat request for an already-served
   * path consumes no budget. Bounded by `PACKAGE_APP_PUB_MAX_FILES` /
   * `PACKAGE_APP_PUB_MAX_TOTAL_BYTES`, enforced check-then-insert.
   */
  servedPublic: Map<string, number>;
  createdAt: number;
  lastSeenAt: number;
};

/**
 * Coordinate binding for a new scope. NOT a parallel identity type — the
 * caller's identity stays the ONE canonical `SessionContext` at the route;
 * the record merely BINDS the verified user/project/agent coordinates the
 * way a `PendingInteraction` record does.
 */
export type PackageAssetScopeInit = Omit<
  PackageAssetScopeRecord,
  'handle' | 'pubToken' | 'servedPublic' | 'createdAt' | 'lastSeenAt'
>;

type AuthorityOptions = {
  idleTtlMs?: number;
  maxPerUser?: number;
  now?: () => number;
};

export class PackageAssetScopeAuthority {
  readonly #records = new Map<string, PackageAssetScopeRecord>();
  /**
   * SECOND INDEX over the SAME record objects (one record, two keys) — never a
   * copy, or a `servedPublic` mutation / `touch` on one lane would be invisible
   * to the other. Every removal path goes through `#forget`.
   */
  readonly #pubIndex = new Map<string, PackageAssetScopeRecord>();
  readonly #idleTtlMs: number;
  readonly #maxPerUser: number;
  readonly #now: () => number;

  constructor(options: AuthorityOptions = {}) {
    this.#idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.#maxPerUser = options.maxPerUser ?? DEFAULT_MAX_PER_USER;
    this.#now = options.now ?? Date.now;
  }

  /** Mint a fresh opaque handle for a fully-verified surface resolution. */
  mint(input: PackageAssetScopeInit): PackageAssetScopeRecord {
    this.sweep();
    this.#enforceUserCap(input.userId);
    const now = this.#now();
    const record: PackageAssetScopeRecord = {
      ...input,
      handle: randomBytes(24).toString('base64url'), // 192-bit, meaning-free
      // Second, INDEPENDENT draw — never derived from the handle.
      pubToken: randomBytes(24).toString('base64url'),
      servedPublic: new Map<string, number>(),
      createdAt: now,
      lastSeenAt: now,
    };
    this.#records.set(record.handle, record);
    this.#pubIndex.set(record.pubToken, record);
    return record;
  }

  /**
   * Look up a live record. Expired → deleted + `null` (the caller answers a
   * uniform 410 with no further detail).
   */
  get(handle: string): PackageAssetScopeRecord | null {
    const record = this.#records.get(handle);
    if (!record) return null;
    if (this.#isExpired(record)) {
      this.#forget(record);
      return null;
    }
    return record;
  }

  /**
   * Look up a live record by its SESSION-FREE lane token. Same lazy expiry as
   * {@link get}; returns the SAME record object the handle index holds, so a
   * `servedPublic` mutation or a `touch` is observable from both lanes.
   * Unknown / expired → `null` (the public lane answers a uniform 404).
   */
  getByPubToken(token: string): PackageAssetScopeRecord | null {
    const record = this.#pubIndex.get(token);
    if (!record) return null;
    if (this.#isExpired(record)) {
      this.#forget(record);
      return null;
    }
    return record;
  }

  /**
   * Refresh the idle window (heartbeat or a served asset).
   *
   * `maxAgeSinceCreationMs` bounds the CALLER's ability to extend life, not the
   * record's ability to be found: past that age since `createdAt` the lookup
   * still succeeds and this returns `true`, but `lastSeenAt` is left alone. The
   * session-free lane passes it (`PACKAGE_APP_PUB_TOUCH_MAX_AGE_MS`) so a leaked
   * `pubToken` cannot keep a scope alive on its own once the legitimate client's
   * heartbeat has taken over; the entry lane and the heartbeat omit it and always
   * refresh.
   *
   * ONE method, ONE clock (`#now`) — never a second touch variant, and never a
   * `Date.now()` read from a calling lane.
   */
  touch(handle: string, opts?: { maxAgeSinceCreationMs?: number }): boolean {
    const record = this.get(handle);
    if (!record) return false;
    const now = this.#now();
    if (
      opts?.maxAgeSinceCreationMs !== undefined &&
      now - record.createdAt > opts.maxAgeSinceCreationMs
    ) {
      // The record IS live (the lookup succeeded) — we simply decline to
      // extend it from this caller.
      return true;
    }
    record.lastSeenAt = now;
    return true;
  }

  /**
   * Owner close — capability-REDUCING, so it stays allowed after access loss:
   * only the record's own user is checked, never project visibility.
   */
  close(handle: string, userId: string): boolean {
    const record = this.#records.get(handle);
    if (!record || record.userId !== userId) return false;
    this.#forget(record);
    return true;
  }

  /** Server-side revocation (visibility loss, fingerprint/generation drift). */
  revoke(handle: string): void {
    const record = this.#records.get(handle);
    if (!record) return;
    this.#forget(record);
  }

  /**
   * Principal revocation — drop every record `userId` holds (in `projectId`
   * only, when given), BOTH lanes. Returns how many were revoked.
   */
  revokeForUser(userId: string, projectId?: string): number {
    let revoked = 0;
    for (const record of this.#records.values()) {
      if (record.userId !== userId) continue;
      if (projectId !== undefined && record.projectId !== projectId) continue;
      this.#forget(record);
      revoked += 1;
    }
    return revoked;
  }

  /** Drop expired records; returns how many were swept. */
  sweep(): number {
    let swept = 0;
    // Deleting from a Map while iterating it is safe (visited entries are not
    // revisited); `#forget` also drops the record's pub-index twin.
    for (const record of this.#records.values()) {
      if (this.#isExpired(record)) {
        this.#forget(record);
        swept += 1;
      }
    }
    return swept;
  }

  /** Live record count (diagnostics/tests). */
  size(): number {
    return this.#records.size;
  }

  /**
   * THE ONLY removal path — one record, two keys. Every site that drops a
   * record (lazy expiry on either lane, owner close, server revoke, principal
   * revocation, sweep, the per-user cap eviction) goes through here.
   *
   * A half-delete that left the pub index populated would NOT be a delayed
   * revoke but a permanent one: `sweep()` and the module-level interval iterate
   * `#records` ONLY, so an orphaned pub-index entry is never reclaimed, and the
   * session-free lane touches the record on every served file, so its
   * `lastSeenAt` never goes stale either. Do not delete from `#records`
   * directly.
   */
  #forget(record: PackageAssetScopeRecord): void {
    this.#records.delete(record.handle);
    this.#pubIndex.delete(record.pubToken);
  }

  #isExpired(record: PackageAssetScopeRecord): boolean {
    return this.#now() - record.lastSeenAt > this.#idleTtlMs;
  }

  #enforceUserCap(userId: string): void {
    const owned: PackageAssetScopeRecord[] = [];
    for (const record of this.#records.values()) {
      if (record.userId === userId) owned.push(record);
    }
    if (owned.length < this.#maxPerUser) return;
    owned.sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    // Revoke the least-recently-active surplus — its client re-mints on 410.
    for (let i = 0; i <= owned.length - this.#maxPerUser; i += 1) {
      this.#forget(owned[i]);
    }
  }
}

// ---------------------------------------------------------------------------
// globalThis-anchored singleton (split-brain rule: Next may evaluate the
// module graph more than once — mint and GET must share ONE map).
// ---------------------------------------------------------------------------

const AUTHORITY_KEY = Symbol.for('@neuralis/neuralis/package-asset-scope-authority/v1');

type AuthoritySlot = {
  authority?: PackageAssetScopeAuthority;
  sweepTimer?: ReturnType<typeof setInterval>;
};

export function getPackageAssetScopeAuthority(): PackageAssetScopeAuthority {
  const slot = ((globalThis as Record<symbol, unknown>)[AUTHORITY_KEY] ??= {}) as AuthoritySlot;
  if (!slot.authority) {
    slot.authority = new PackageAssetScopeAuthority();
    const timer = setInterval(() => slot.authority?.sweep(), SWEEP_INTERVAL_MS);
    timer.unref?.();
    slot.sweepTimer = timer;
  }
  return slot.authority;
}
