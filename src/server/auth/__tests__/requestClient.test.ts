/**
 * `resolveClientAddress` — the ONE answer to "which client sent this", keyed
 * by the two host limiters. The peer comes from the ingress stamp; a
 * forwarding header is believed only from a DECLARED trusted proxy, walked
 * right to left. Every row that trusts a forwarded hop is paired with the same
 * request from an UNtrusted peer, where the header must be ignored.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ trustedProxies: [] as Array<{ network: string; prefix: number; family: 'ipv4' | 'ipv6' }> }));
vi.mock('../../config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config/env')>()),
  getEnv: () => ({ trustedProxies: env.trustedProxies }),
}));

const { resolveClientAddress, normalizeAddress } = await import('../requestClient');
const { parseTrustedProxies } = await import('../../config/env');

const PEER = 'x-neuralis-peer';

describe('resolveClientAddress', () => {
  beforeEach(() => {
    env.trustedProxies = [];
  });

  it('no stamp ⇒ the shared `unstamped` key (limits, never trusts a header)', () => {
    expect(resolveClientAddress({ 'x-forwarded-for': '198.51.100.7' })).toEqual({ address: 'unstamped', source: 'unstamped' });
  });

  it('default topology (nothing trusted): the peer is the client and X-Forwarded-For is ignored — rotating it changes nothing', () => {
    for (const forged of ['198.51.100.1', '198.51.100.2', '1.2.3.4, 5.6.7.8']) {
      expect(resolveClientAddress({ [PEER]: '172.18.0.1', 'x-forwarded-for': forged })).toEqual({ address: '172.18.0.1', source: 'peer' });
    }
    // The key this replaces, on the same requests: one fresh bucket per forged value.
    const oldKey = (xff: string) => xff.split(',')[0]!.trim();
    expect(new Set(['198.51.100.1', '198.51.100.2'].map(oldKey)).size).toBe(2);
  });

  it('a TRUSTED peer: the rightmost untrusted hop is the client; a client-written prefix never wins', () => {
    env.trustedProxies = parseTrustedProxies('172.18.0.0/16');
    const headers = { [PEER]: '172.18.0.1', 'x-forwarded-for': '6.6.6.6, 203.0.113.9' };
    expect(resolveClientAddress(headers)).toEqual({ address: '203.0.113.9', source: 'forwarded' });
    // Paired: the same header from an untrusted peer is the caller's own text.
    expect(resolveClientAddress({ ...headers, [PEER]: '203.0.113.50' })).toEqual({ address: '203.0.113.50', source: 'peer' });
  });

  it('walks past a chain of trusted hops; a malformed hop ends the walk at the last trusted one', () => {
    env.trustedProxies = parseTrustedProxies('10.0.0.0/8, 172.18.0.1');
    expect(resolveClientAddress({ [PEER]: '172.18.0.1', 'x-forwarded-for': '203.0.113.9, 10.1.2.3' }))
      .toEqual({ address: '203.0.113.9', source: 'forwarded' });
    expect(resolveClientAddress({ [PEER]: '172.18.0.1', 'x-forwarded-for': 'garbage, 10.1.2.3' }))
      .toEqual({ address: '10.1.2.3', source: 'forwarded' });
  });

  it('an IPv4-mapped IPv6 peer matches an IPv4 block', () => {
    env.trustedProxies = parseTrustedProxies('172.18.0.0/16');
    expect(resolveClientAddress({ [PEER]: '::ffff:172.18.0.1', 'x-forwarded-for': '203.0.113.9' }))
      .toEqual({ address: '203.0.113.9', source: 'forwarded' });
    expect(normalizeAddress('::FFFF:10.0.0.1')).toBe('10.0.0.1');
    expect(normalizeAddress('not-an-ip')).toBeNull();
  });

  it('reads a Headers object the same way as a plain record', () => {
    expect(resolveClientAddress(new Headers({ [PEER]: '192.0.2.1' }))).toEqual({ address: '192.0.2.1', source: 'peer' });
  });
});

describe('parseTrustedProxies — topology, deny-by-default', () => {
  it('empty is the default: trust no proxy', () => {
    expect(parseTrustedProxies(undefined)).toEqual([]);
    expect(parseTrustedProxies('')).toEqual([]);
  });

  it('ONE invalid entry voids the whole list, warned — a typo never widens trust', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(parseTrustedProxies('10.0.0.0/8, proxy.example.com')).toEqual([]);
      expect(parseTrustedProxies('10.0.0.0/33')).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
    expect(parseTrustedProxies('10.0.0.0/8 fd00::/8')).toEqual([
      { network: '10.0.0.0', prefix: 8, family: 'ipv4' },
      { network: 'fd00::', prefix: 8, family: 'ipv6' },
    ]);
  });
});
