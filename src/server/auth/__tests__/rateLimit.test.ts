/**
 * The login limiter's two axes, each with the defect it closes as a paired
 * control.
 *
 *  - `(email, address)` hard-locks at 5 failures; a success clears ONLY its own
 *    pair. Paired control: the old single `address` bucket, which one success
 *    of the attacker's OWN account wiped (4 guesses, 1 own login, repeat —
 *    unlimited targeted guessing).
 *  - `address` is a spray brake that DELAYS, never locks. Paired control: on the
 *    collapsed topology (every login from one gateway peer), 5 failures across
 *    5 accounts must not stop a sixth account from logging in — the old limiter
 *    locked the whole platform there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginLoginAttempt,
  recordLoginFailure,
  recordLoginSuccess,
  resetLoginRateLimitForTests,
} from '../rateLimit';

const GATEWAY = '172.18.0.1';

function fail(email: string, times: number, address = GATEWAY): void {
  for (let i = 0; i < times; i += 1) {
    expect(beginLoginAttempt(email, address).kind).toBe('proceed');
    recordLoginFailure(email, address);
  }
}

describe('login limiter — (email, address) hard lock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T12:00:00.000Z'));
    resetLoginRateLimitForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('5 failures lock that pair; another account on the SAME address is untouched and gets no delay', () => {
    fail('a@x.co', 5);
    expect(beginLoginAttempt('a@x.co', GATEWAY)).toMatchObject({ kind: 'locked' });
    expect(beginLoginAttempt('c@x.co', GATEWAY)).toEqual({ kind: 'proceed', waitMs: 0 });
  });

  it('a success clears only its OWN pair: 4 on A + a success on B + 1 more on A still locks A', () => {
    fail('a@x.co', 4);
    recordLoginSuccess('b@x.co', GATEWAY);
    fail('a@x.co', 1);
    expect(beginLoginAttempt('a@x.co', GATEWAY)).toMatchObject({ kind: 'locked' });
    expect(beginLoginAttempt('b@x.co', GATEWAY)).toEqual({ kind: 'proceed', waitMs: 0 });
  });

  it('OLD SHAPE: one address bucket reset by any success never locks under the same sequence', () => {
    const bucket = { attempts: 0 };
    const oldFail = () => { bucket.attempts += 1; };
    const oldReset = () => { bucket.attempts = 0; };
    for (let round = 0; round < 5; round += 1) {
      for (let i = 0; i < 4; i += 1) oldFail();
      oldReset();
    }
    expect(bucket.attempts).toBeLessThan(5);
  });

  it('the lock lifts after 15 minutes, and failures older than the window do not count', () => {
    fail('a@x.co', 5);
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    expect(beginLoginAttempt('a@x.co', GATEWAY).kind).toBe('proceed');
    fail('d@x.co', 4);
    vi.advanceTimersByTime(15 * 60 * 1000 + 1);
    fail('d@x.co', 1);
    expect(beginLoginAttempt('d@x.co', GATEWAY).kind).toBe('proceed');
  });

  it('the same account from ANOTHER address is its own pair (no per-account lockout DoS)', () => {
    fail('a@x.co', 5, '203.0.113.1');
    expect(beginLoginAttempt('a@x.co', '203.0.113.2')).toEqual({ kind: 'proceed', waitMs: 0 });
  });
});

describe('login limiter — address spray brake', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T12:00:00.000Z'));
    resetLoginRateLimitForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('COLLAPSED TOPOLOGY: 5 failures across 5 accounts from one gateway leave a sixth account free', () => {
    for (const email of ['1@x.co', '2@x.co', '3@x.co', '4@x.co', '5@x.co']) fail(email, 1);
    expect(beginLoginAttempt('6@x.co', GATEWAY)).toEqual({ kind: 'proceed', waitMs: 0 });
  });

  it('≥ 10 distinct emails from one address: its next attempts are DELAYED, never hard-locked', () => {
    for (let i = 0; i < 12; i += 1) fail(`spray${i}@x.co`, 1);
    const first = beginLoginAttempt('victim@x.co', GATEWAY);
    const second = beginLoginAttempt('victim2@x.co', GATEWAY);
    expect(first.kind).toBe('proceed');
    expect(second.kind).toBe('proceed');
    // Serialized: the second waits behind the first's slot.
    expect(second.kind === 'proceed' && second.waitMs).toBeGreaterThan(0);
    // A delay, not a lock: once the queue drains the same address proceeds again.
    vi.advanceTimersByTime(60_000);
    expect(beginLoginAttempt('victim3@x.co', GATEWAY).kind).toBe('proceed');
  });

  it('≥ 25 failures on ONE email also trip the brake, and the delay is capped at 30 s', () => {
    for (let i = 0; i < 30; i += 1) {
      vi.advanceTimersByTime(40_000);
      beginLoginAttempt('same@x.co', GATEWAY);
      recordLoginFailure('same@x.co', GATEWAY);
    }
    // The pair is hard-locked by now; another email on the address is delayed.
    const gate = beginLoginAttempt('other@x.co', GATEWAY);
    expect(gate.kind).toBe('proceed');
    const next = beginLoginAttempt('other2@x.co', GATEWAY);
    expect(next.kind === 'proceed' && next.waitMs).toBeLessThanOrEqual(30_000);
  });

  it('a queue deeper than the cap is refused (retry later), still not locked', () => {
    // Seed the history directly: 20 distinct failed emails (excess 11 ⇒ each slot 30 s).
    for (let i = 0; i < 20; i += 1) recordLoginFailure(`s${i}@x.co`, GATEWAY);
    const kinds = Array.from({ length: 12 }, (_, i) => beginLoginAttempt(`q${i}@x.co`, GATEWAY).kind);
    expect(kinds).toContain('spray_refused');
    expect(kinds).not.toContain('locked');
  });
});
