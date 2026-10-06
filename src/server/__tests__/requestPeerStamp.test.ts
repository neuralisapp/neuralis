/**
 * The ingress peer stamp, driven through a REAL `http.Server` and a real
 * `fetch`: the property that matters is what lands on the request object a
 * handler reads — a caller-written `x-neuralis-peer` must be gone and the socket
 * peer must be there — and that the hook CHAINS with the upgrade watchdog's
 * rather than replacing it or adding a listener.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, Server as HttpServer, type IncomingMessage } from 'node:http';
import { Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';

import { installUpgradeWatchdog } from '../upgradeWatchdog';
import { installRequestPeerStamp, PEER_HEADER, stampRequestPeer } from '../requestPeerStamp';

const WATCHDOG_INSTALLED = Symbol.for('neuralis.upgradeWatchdog.v1');
const STAMP_INSTALLED = Symbol.for('neuralis.requestPeerStamp.v1');

describe('stampRequestPeer', () => {
  it('replaces a caller-written peer header (and its raw copy) with the socket address', () => {
    const req = {
      headers: { [PEER_HEADER]: '6.6.6.6', 'x-forwarded-for': '6.6.6.6' } as Record<string, string | undefined>,
      rawHeaders: ['X-Neuralis-Peer', '6.6.6.6', 'Host', 'x'],
      socket: { remoteAddress: '172.18.0.1' },
    };
    stampRequestPeer(req);
    expect(req.headers[PEER_HEADER]).toBe('172.18.0.1');
    expect(req.rawHeaders).toEqual(['Host', 'x']);
    // Forwarding headers are untouched — they are the resolver's business.
    expect(req.headers['x-forwarded-for']).toBe('6.6.6.6');
  });

  it('no socket address ⇒ no stamp, and still no caller-written one', () => {
    const req = { headers: { [PEER_HEADER]: '6.6.6.6' } as Record<string, string | undefined>, socket: null };
    stampRequestPeer(req);
    expect(req.headers[PEER_HEADER]).toBeUndefined();
  });
});

describe('installRequestPeerStamp (prototype hook, chained on the watchdog)', () => {
  const hadOwn = {
    http: Object.getOwnPropertyNames(HttpServer.prototype).includes('emit'),
    https: Object.getOwnPropertyNames(HttpsServer.prototype).includes('emit'),
  };
  const originalHttpEmit = HttpServer.prototype.emit;
  let seen: IncomingMessage | null = null;
  let server: ReturnType<typeof createServer>;
  let port = 0;

  beforeAll(async () => {
    installUpgradeWatchdog();
    installRequestPeerStamp();
    server = createServer((req, res) => {
      seen = req;
      res.end('ok');
    });
    server.on('upgrade', (_req, socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!hadOwn.http) Reflect.deleteProperty(HttpServer.prototype, 'emit');
    else HttpServer.prototype.emit = originalHttpEmit;
    if (!hadOwn.https) Reflect.deleteProperty(HttpsServer.prototype, 'emit');
    for (const proto of [HttpServer.prototype, HttpsServer.prototype]) {
      Reflect.deleteProperty(proto, WATCHDOG_INSTALLED);
      Reflect.deleteProperty(proto, STAMP_INSTALLED);
    }
  });

  it('a real request carries the socket peer, never the one the client sent', async () => {
    await fetch(`http://127.0.0.1:${port}/`, { headers: { [PEER_HEADER]: '6.6.6.6' } });
    expect(seen?.headers[PEER_HEADER]).toBe('127.0.0.1');
    expect(seen?.rawHeaders.map((h) => h.toLowerCase())).not.toContain(PEER_HEADER);
  });

  it('is idempotent, patches http AND https, and chains on the watchdog instead of replacing it', () => {
    const httpEmit = HttpServer.prototype.emit;
    installRequestPeerStamp();
    expect(HttpServer.prototype.emit).toBe(httpEmit);
    expect(Object.getOwnPropertyDescriptor(HttpServer.prototype, STAMP_INSTALLED)?.value).toBe(true);
    expect(Object.getOwnPropertyDescriptor(HttpsServer.prototype, STAMP_INSTALLED)?.value).toBe(true);
    // Both markers stand: the stamp wrapped the watchdog's emit, it did not reset it.
    expect(Object.getOwnPropertyDescriptor(HttpServer.prototype, WATCHDOG_INSTALLED)?.value).toBe(true);
  });

  it('adds no `upgrade` (or `request`) listener — the three-mount count is unchanged', () => {
    expect(server.listenerCount('upgrade')).toBe(1);
    expect(server.listenerCount('request')).toBe(1);
  });
});
