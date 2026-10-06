/**
 * `resolveClientAddress` — WHICH network client sent a request, for the two
 * host limiters keyed on an address (the login lockout's spray brake and the
 * webhook per-address cap). Transport only, like `requestProject.ts`: it
 * decides nothing about access, and no `SessionContext` carries its answer.
 *
 * The answer starts at the socket peer the ingress stamp wrote
 * (`server/requestPeerStamp.ts`). Only when that peer is a DECLARED trusted
 * proxy (`NEURALIS_TRUSTED_PROXIES`) is `X-Forwarded-For` read, right to left,
 * skipping hops that are themselves trusted — so the address a client typed
 * into its own header can never win, and a proxy that APPENDS keeps working.
 * `X-Real-IP` and `Forwarded` are never read. No stamp (a request emitted
 * before the stamp was installed) is the shared `unstamped` key, which
 * limits rather than trusts.
 */

import { BlockList, isIP } from 'node:net';
import { getEnv, type TrustedProxy } from '../config/env';
import { PEER_HEADER } from '../requestPeerStamp';

export type ClientAddress = {
  address: string;
  source: 'peer' | 'forwarded' | 'unstamped';
};

type HeaderSource = Headers | Record<string, string | string[] | undefined>;

function readHeader(headers: HeaderSource, name: string): string | undefined {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  const value = (headers as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(value) ? value.join(',') : value;
}

/** An IP in canonical form, IPv4-mapped IPv6 read as IPv4; `null` when not an IP. */
export function normalizeAddress(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  if (value.startsWith('::ffff:') && isIP(value.slice(7)) === 4) value = value.slice(7);
  return isIP(value) === 0 ? null : value;
}

const cache: { source: TrustedProxy[] | null; list: BlockList | null } = { source: null, list: null };

function trustedList(): BlockList | null {
  const proxies = getEnv().trustedProxies ?? [];
  if (proxies.length === 0) return null;
  if (cache.source !== proxies) {
    const list = new BlockList();
    for (const proxy of proxies) list.addSubnet(proxy.network, proxy.prefix, proxy.family);
    cache.source = proxies;
    cache.list = list;
  }
  return cache.list;
}

function isTrusted(list: BlockList, address: string): boolean {
  return list.check(address, isIP(address) === 6 ? 'ipv6' : 'ipv4');
}

export function resolveClientAddress(headers: HeaderSource): ClientAddress {
  const stamped = readHeader(headers, PEER_HEADER);
  const peer = stamped ? normalizeAddress(stamped) : null;
  if (!peer) return { address: 'unstamped', source: 'unstamped' };

  const list = trustedList();
  if (!list || !isTrusted(list, peer)) return { address: peer, source: 'peer' };

  const hops = (readHeader(headers, 'x-forwarded-for') ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  let client = peer;
  for (let i = hops.length - 1; i >= 0; i -= 1) {
    if (!isTrusted(list, client)) break;
    const hop = normalizeAddress(hops[i]!);
    // A malformed hop ends the walk: everything left of it is client-written.
    if (!hop) break;
    client = hop;
  }
  return client === peer ? { address: peer, source: 'peer' } : { address: client, source: 'forwarded' };
}
