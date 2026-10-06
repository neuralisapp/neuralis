import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __testing, clearUserAppearanceCache } from '../useUserAppearance';

const { fetchAppearance, shouldFetch, ERROR_TTL_MS } = __testing;

function mockFetchOnce(impl: () => Promise<Response> | Response): void {
  vi.stubGlobal('fetch', vi.fn(impl));
}

describe('useUserAppearance fetch core', () => {
  beforeEach(() => {
    clearUserAppearanceCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('caches a successful appearance and does not refetch', async () => {
    mockFetchOnce(() =>
      new Response(JSON.stringify({ appearance: { kind: 'emoji' }, name: 'Alex' }), { status: 200 }),
    );

    await fetchAppearance('u1');

    expect(shouldFetch('u1')).toBe(false);
  });

  it('marks a failed (non-ok) fetch as retryable only after the TTL', async () => {
    mockFetchOnce(() => new Response('nope', { status: 500 }));

    await fetchAppearance('u1');

    // Immediately after failure: errored entry, not yet retryable.
    expect(shouldFetch('u1')).toBe(false);

    // Before TTL elapses: still blocked.
    vi.advanceTimersByTime(ERROR_TTL_MS - 1);
    expect(shouldFetch('u1')).toBe(false);

    // After TTL: retryable — the key fix vs. the old permanent-null cache.
    vi.advanceTimersByTime(2);
    expect(shouldFetch('u1')).toBe(true);
  });

  it('treats a thrown (network) error the same as a failed response', async () => {
    mockFetchOnce(() => Promise.reject(new Error('offline')));

    await fetchAppearance('u1');
    expect(shouldFetch('u1')).toBe(false);

    vi.advanceTimersByTime(ERROR_TTL_MS + 1);
    expect(shouldFetch('u1')).toBe(true);
  });

  it('recovers to a settled entry once the backend comes back', async () => {
    mockFetchOnce(() => Promise.reject(new Error('offline')));
    await fetchAppearance('u1');
    vi.advanceTimersByTime(ERROR_TTL_MS + 1);
    expect(shouldFetch('u1')).toBe(true);

    mockFetchOnce(() => new Response(JSON.stringify({ appearance: null, name: 'Alex' }), { status: 200 }));
    await fetchAppearance('u1');

    // Settled OK entry — no further refetch even though appearance is null.
    expect(shouldFetch('u1')).toBe(false);
  });
});
