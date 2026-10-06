/**
 * PackageAssetScopeAuthority (CARD1 3A) — binding, fake-clock idle expiry,
 * per-user hard cap, own-close vs foreign-close, revoke, sweep and
 * restart-invalidation semantics, plus the TWO-INDEX symmetry (one record, two
 * keys) the session-free subresource lane depends on.
 *
 * Every case constructs the class DIRECTLY with an injected clock — never the
 * `getPackageAssetScopeAuthority()` globalThis singleton, which arms a live
 * interval and would leak state across test files.
 */

import { describe, it, expect } from 'vitest';
import {
  PackageAssetScopeAuthority,
  DEFAULT_IDLE_TTL_MS,
  type PackageAssetScopeInit,
} from '../PackageAssetScopeAuthority';

function makeInit(overrides: Partial<PackageAssetScopeInit> = {}): PackageAssetScopeInit {
  return {
    userId: 'user-1',
    projectId: 'proj-1',
    agentId: undefined,
    packageId: 'example-package',
    surfaceKind: 'widget',
    surfaceId: 'example_workspace',
    renderer: 'iframe',
    trust: 'untrusted',
    fingerprint: 'fp-1',
    generation: 'gen_1',
    surfaceRoot: '/data/projects/proj-1/_packages/example-package/app/surfaces/widget/example_workspace',
    sharedRoot: '/data/projects/proj-1/_packages/example-package/app/shared',
    entryRelPath: 'index.html',
    ...overrides,
  };
}

function makeAuthority(opts: { idleTtlMs?: number; maxPerUser?: number } = {}) {
  let now = 1_000_000;
  const authority = new PackageAssetScopeAuthority({
    ...opts,
    now: () => now,
  });
  return {
    authority,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('PackageAssetScopeAuthority', () => {
  it('mints a 192-bit meaning-free handle bound to the full coordinate', () => {
    const { authority } = makeAuthority();
    const record = authority.mint(makeInit());
    // 24 random bytes → 32 base64url chars, no padding.
    expect(record.handle).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // The handle must not embed any coordinate (meaning-free opacity).
    for (const needle of ['user-1', 'proj-1', 'example', 'widget']) {
      expect(record.handle).not.toContain(needle);
    }
    expect(authority.get(record.handle)).toMatchObject({
      userId: 'user-1',
      projectId: 'proj-1',
      packageId: 'example-package',
      surfaceKind: 'widget',
      surfaceId: 'example_workspace',
      fingerprint: 'fp-1',
      generation: 'gen_1',
      entryRelPath: 'index.html',
    });
  });

  it('two mints for the same coordinate yield distinct handles', () => {
    const { authority } = makeAuthority();
    const a = authority.mint(makeInit());
    const b = authority.mint(makeInit());
    expect(a.handle).not.toBe(b.handle);
  });

  it('expires idle records after the TTL (fake clock) and sweeps them', () => {
    const { authority, advance } = makeAuthority();
    const record = authority.mint(makeInit());
    advance(DEFAULT_IDLE_TTL_MS - 1);
    expect(authority.get(record.handle)).not.toBeNull();
    advance(2);
    expect(authority.get(record.handle)).toBeNull();
    // Already lazily deleted; sweep finds nothing further.
    expect(authority.sweep()).toBe(0);
    expect(authority.size()).toBe(0);
  });

  it('touch (heartbeat / served asset) refreshes the idle window', () => {
    const { authority, advance } = makeAuthority();
    const record = authority.mint(makeInit());
    advance(DEFAULT_IDLE_TTL_MS - 1000);
    expect(authority.touch(record.handle)).toBe(true);
    advance(DEFAULT_IDLE_TTL_MS - 1000);
    expect(authority.get(record.handle)).not.toBeNull();
    advance(DEFAULT_IDLE_TTL_MS + 1);
    expect(authority.touch(record.handle)).toBe(false);
  });

  it('sweep drops every expired record (mint sweeps lazily too)', () => {
    const { authority, advance } = makeAuthority();
    authority.mint(makeInit());
    authority.mint(makeInit({ userId: 'user-2' }));
    advance(DEFAULT_IDLE_TTL_MS + 1);
    expect(authority.sweep()).toBe(2);
    expect(authority.size()).toBe(0);
    // A mint also sweeps lazily on entry.
    authority.mint(makeInit({ userId: 'user-4' }));
    advance(DEFAULT_IDLE_TTL_MS + 1);
    const fresh = authority.mint(makeInit({ userId: 'user-3' }));
    expect(authority.size()).toBe(1);
    expect(authority.get(fresh.handle)).not.toBeNull();
  });

  it('enforces the per-user hard cap by revoking the least-recently-active record', () => {
    const { authority, advance } = makeAuthority({ maxPerUser: 3 });
    const first = authority.mint(makeInit({ surfaceId: 's1' }));
    advance(10);
    const second = authority.mint(makeInit({ surfaceId: 's2' }));
    advance(10);
    const third = authority.mint(makeInit({ surfaceId: 's3' }));
    advance(10);
    // Touch the oldest so the SECOND becomes least-recently-active.
    authority.touch(first.handle);
    const fourth = authority.mint(makeInit({ surfaceId: 's4' }));
    expect(authority.get(second.handle)).toBeNull(); // revoked to admit
    expect(authority.get(first.handle)).not.toBeNull();
    expect(authority.get(third.handle)).not.toBeNull();
    expect(authority.get(fourth.handle)).not.toBeNull();
  });

  it("the cap is PER USER — another user's records are untouched", () => {
    const { authority, advance } = makeAuthority({ maxPerUser: 2 });
    const foreign = authority.mint(makeInit({ userId: 'user-2' }));
    const a = authority.mint(makeInit({ surfaceId: 's1' }));
    advance(10);
    authority.mint(makeInit({ surfaceId: 's2' }));
    advance(10);
    authority.mint(makeInit({ surfaceId: 's3' }));
    expect(authority.get(foreign.handle)).not.toBeNull();
    expect(authority.get(a.handle)).toBeNull();
  });

  it('close is owner-only (capability-reducing) — a foreign user cannot close', () => {
    const { authority } = makeAuthority();
    const record = authority.mint(makeInit());
    expect(authority.close(record.handle, 'user-2')).toBe(false);
    expect(authority.get(record.handle)).not.toBeNull();
    expect(authority.close(record.handle, 'user-1')).toBe(true);
    expect(authority.get(record.handle)).toBeNull();
    // Idempotent second close.
    expect(authority.close(record.handle, 'user-1')).toBe(false);
  });

  it('revoke drops a record unconditionally (server-side visibility loss)', () => {
    const { authority } = makeAuthority();
    const record = authority.mint(makeInit());
    authority.revoke(record.handle);
    expect(authority.get(record.handle)).toBeNull();
  });

  it('restart invalidation — a NEW authority instance knows no old handle', () => {
    const { authority } = makeAuthority();
    const record = authority.mint(makeInit());
    const fresh = new PackageAssetScopeAuthority();
    expect(fresh.get(record.handle)).toBeNull();
  });

  it('unknown handle → null (uniform non-enumerating)', () => {
    const { authority } = makeAuthority();
    expect(authority.get('does-not-exist')).toBeNull();
    expect(authority.touch('does-not-exist')).toBe(false);
    expect(authority.close('does-not-exist', 'user-1')).toBe(false);
  });
});

describe('PackageAssetScopeAuthority — the pub-token index (one record, two keys)', () => {
  it('mints a SECOND, independent 192-bit meaning-free token', () => {
    const { authority } = makeAuthority();
    const record = authority.mint(makeInit());
    // 24 random bytes → 32 base64url chars, no padding — same shape, own draw.
    expect(record.pubToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(record.pubToken).not.toBe(record.handle);
    for (const needle of ['user-1', 'proj-1', 'example', 'widget']) {
      expect(record.pubToken).not.toContain(needle);
    }
    // Two mints for the same coordinate draw distinct pub tokens too.
    const other = authority.mint(makeInit());
    expect(other.pubToken).not.toBe(record.pubToken);
  });

  it('starts with an EMPTY served-public budget map', () => {
    const { authority } = makeAuthority();
    const record = authority.mint(makeInit());
    expect(record.servedPublic).toBeInstanceOf(Map);
    expect(record.servedPublic.size).toBe(0);
  });

  it('getByPubToken returns the SAME object the handle index holds', () => {
    const { authority } = makeAuthority();
    const record = authority.mint(makeInit());
    const viaHandle = authority.get(record.handle);
    const viaPub = authority.getByPubToken(record.pubToken);
    expect(viaPub).not.toBeNull();
    // Object IDENTITY, not shape: a copy would make `servedPublic` mutations
    // and `touch` diverge between the two lanes.
    expect(viaPub).toBe(viaHandle);
    viaPub!.servedPublic.set('/abs/a.css', 10);
    expect(viaHandle!.servedPublic.get('/abs/a.css')).toBe(10);
  });

  it('an unknown pub token → null (uniform non-enumerating)', () => {
    const { authority } = makeAuthority();
    const record = authority.mint(makeInit());
    expect(authority.getByPubToken('does-not-exist')).toBeNull();
    // The handle is NOT a pub token and vice versa — the two key spaces are
    // separate indexes over the same record.
    expect(authority.getByPubToken(record.handle)).toBeNull();
    expect(authority.get(record.pubToken)).toBeNull();
  });

  it('touch through the handle refreshes the record the pub index sees', () => {
    const { authority, advance } = makeAuthority();
    const record = authority.mint(makeInit());
    advance(DEFAULT_IDLE_TTL_MS - 1000);
    expect(authority.touch(record.handle)).toBe(true);
    advance(DEFAULT_IDLE_TTL_MS - 1000);
    expect(authority.getByPubToken(record.pubToken)).not.toBeNull();
  });

  // ---------------------------------------------------------------------
  // SYMMETRY: all SIX removal paths must drop BOTH keys. A half-delete would
  // not be a delayed revoke but a PERMANENT one — sweep() and the module
  // interval iterate the handle map only, and the public lane touches the
  // record on every served file, so an orphan is never reclaimed.
  // ---------------------------------------------------------------------

  it('idle expiry OBSERVED VIA get() drops the pub index too', () => {
    const { authority, advance } = makeAuthority();
    const record = authority.mint(makeInit());
    advance(DEFAULT_IDLE_TTL_MS + 1);
    expect(authority.get(record.handle)).toBeNull();
    expect(authority.getByPubToken(record.pubToken)).toBeNull();
  });

  it('idle expiry OBSERVED VIA getByPubToken() drops the handle index too', () => {
    const { authority, advance } = makeAuthority();
    const record = authority.mint(makeInit());
    advance(DEFAULT_IDLE_TTL_MS + 1);
    expect(authority.getByPubToken(record.pubToken)).toBeNull();
    expect(authority.get(record.handle)).toBeNull();
    expect(authority.size()).toBe(0);
  });

  it('close drops the pub index', () => {
    const { authority } = makeAuthority();
    const record = authority.mint(makeInit());
    // A FAILED foreign close must not drop either key.
    expect(authority.close(record.handle, 'user-2')).toBe(false);
    expect(authority.getByPubToken(record.pubToken)).not.toBeNull();
    expect(authority.close(record.handle, 'user-1')).toBe(true);
    expect(authority.getByPubToken(record.pubToken)).toBeNull();
  });

  it('revoke drops the pub index (and stays a silent no-op when absent)', () => {
    const { authority } = makeAuthority();
    const record = authority.mint(makeInit());
    authority.revoke(record.handle);
    expect(authority.getByPubToken(record.pubToken)).toBeNull();
    expect(() => authority.revoke(record.handle)).not.toThrow();
    expect(() => authority.revoke('does-not-exist')).not.toThrow();
  });

  it('sweep drops the pub index', () => {
    const { authority, advance } = makeAuthority();
    const first = authority.mint(makeInit({ surfaceId: 's1' }));
    const second = authority.mint(makeInit({ userId: 'user-2', surfaceId: 's2' }));
    advance(DEFAULT_IDLE_TTL_MS + 1);
    expect(authority.sweep()).toBe(2);
    expect(authority.getByPubToken(first.pubToken)).toBeNull();
    expect(authority.getByPubToken(second.pubToken)).toBeNull();
  });

  it('the PER-USER CAP eviction drops the pub index (the half-delete catcher)', () => {
    const { authority, advance } = makeAuthority({ maxPerUser: 3 });
    const first = authority.mint(makeInit({ surfaceId: 's1' }));
    advance(10);
    const second = authority.mint(makeInit({ surfaceId: 's2' }));
    advance(10);
    authority.mint(makeInit({ surfaceId: 's3' }));
    advance(10);
    // Touch the oldest so the SECOND becomes least-recently-active.
    authority.touch(first.handle);
    authority.mint(makeInit({ surfaceId: 's4' }));
    expect(authority.get(second.handle)).toBeNull();
    // This is the case a `#records.delete` at the cap site would leave alive
    // FOREVER: the sweep never visits it and the public lane keeps touching it.
    expect(authority.getByPubToken(second.pubToken)).toBeNull();
    expect(authority.getByPubToken(first.pubToken)).not.toBeNull();
  });

  it('restart invalidation — a NEW authority instance knows no old pub token', () => {
    const { authority } = makeAuthority();
    const record = authority.mint(makeInit());
    const fresh = new PackageAssetScopeAuthority();
    expect(fresh.getByPubToken(record.pubToken)).toBeNull();
  });
});

/**
 * The ABSOLUTE ceiling on the PUBLIC lane's ability to extend a scope's life.
 *
 * The bound is on LIFE-EXTENSION, not on serving. Hard-expiring the LOOKUP on
 * `createdAt` would 404 a legitimately open widget's late-loaded chunks; declining
 * to refresh `lastSeenAt` instead means a leaked token can ride an already-live
 * scope but can never outlive the client that owns it.
 */
describe('PackageAssetScopeAuthority — the bounded touch', () => {
  const MAX_AGE = 60_000;

  it('inside the window, a bounded touch refreshes lastSeenAt', () => {
    const { authority, advance } = makeAuthority();
    const record = authority.mint(makeInit());
    advance(MAX_AGE - 1);
    expect(authority.touch(record.handle, { maxAgeSinceCreationMs: MAX_AGE })).toBe(true);
    expect(record.lastSeenAt).toBe(record.createdAt + MAX_AGE - 1);
  });

  it('past the window it returns TRUE (the record is live) but does NOT refresh', () => {
    const { authority, advance } = makeAuthority();
    const record = authority.mint(makeInit());
    const mintedAt = record.lastSeenAt;
    advance(MAX_AGE + 1);
    // `true` is the honest answer: the lookup succeeded, the scope IS alive.
    expect(authority.touch(record.handle, { maxAgeSinceCreationMs: MAX_AGE })).toBe(true);
    expect(record.lastSeenAt).toBe(mintedAt);
  });

  it('the age is measured from createdAt, NOT from the last activity', () => {
    const { authority, advance } = makeAuthority();
    const record = authority.mint(makeInit());
    // Unbounded activity keeps the record alive but must not reset the ceiling.
    advance(MAX_AGE - 10);
    authority.touch(record.handle);
    advance(20);
    const before = record.lastSeenAt;
    expect(authority.touch(record.handle, { maxAgeSinceCreationMs: MAX_AGE })).toBe(true);
    expect(record.lastSeenAt).toBe(before);
  });

  it('WITHOUT the option (the entry lane / heartbeat) a touch always refreshes', () => {
    const { authority, advance } = makeAuthority();
    const record = authority.mint(makeInit());
    advance(MAX_AGE * 3);
    expect(authority.touch(record.handle)).toBe(true);
    expect(record.lastSeenAt).toBe(record.createdAt + MAX_AGE * 3);
  });

  it('a scope kept busy ONLY by bounded traffic expires at the idle TTL', () => {
    const { authority, advance } = makeAuthority();
    const record = authority.mint(makeInit());
    // The client is gone (no heartbeat); the public lane keeps being hit.
    for (let i = 0; i < 8; i += 1) {
      advance(DEFAULT_IDLE_TTL_MS / 2);
      authority.touch(record.handle, { maxAgeSinceCreationMs: MAX_AGE });
    }
    expect(authority.get(record.handle)).toBeNull();
    expect(authority.getByPubToken(record.pubToken)).toBeNull();
  });

  it('an UNKNOWN handle is still false, option or not', () => {
    const { authority } = makeAuthority();
    expect(authority.touch('nope', { maxAgeSinceCreationMs: MAX_AGE })).toBe(false);
  });
});
