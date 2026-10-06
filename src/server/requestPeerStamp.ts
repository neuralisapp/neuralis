/**
 * Ingress stamp: the socket peer, written onto every request before any
 * handler runs.
 *
 * A Next route handler never sees the socket, and Next back-fills
 * `x-forwarded-for` only when it is ABSENT (`??=`), so downstream a client's
 * own forwarding header and a back-filled one look identical. This hook runs at
 * `emit('request')`, deletes any inbound copy of {@link PEER_HEADER} (a caller
 * must never be able to name its own peer) and writes
 * `req.socket.remoteAddress` into it. `server/auth/requestClient.ts` is the ONE
 * reader.
 *
 * It is a hook on `http`/`https` `Server.prototype.emit`, CHAINED on top of the
 * upgrade watchdog's (`upgradeWatchdog.ts`) and installed right after it — never
 * a listener: `listeners('upgrade').length` must stay 3, and a `'request'`
 * listener would run after Next's. Because `emit` resolves through the
 * prototype at call time, it covers servers that are already listening. A
 * request emitted before the install line carries no stamp and resolves to the
 * shared "unstamped" key, which limits rather than trusts.
 */

import { Server as HttpServer } from 'node:http';
import { Server as HttpsServer } from 'node:https';
import type { EventEmitter } from 'node:events';

export const PEER_HEADER = 'x-neuralis-peer';

/** `Symbol.for`: Next may evaluate this module more than once per process. */
const STAMP_INSTALLED = Symbol.for('neuralis.requestPeerStamp.v1');

type StampableRequest = {
  headers: Record<string, string | string[] | undefined>;
  rawHeaders?: string[];
  socket?: { remoteAddress?: string } | null;
};

function isStampable(value: unknown): value is StampableRequest {
  return typeof value === 'object' && value !== null && typeof (value as { headers?: unknown }).headers === 'object';
}

/** Exported for the unit rows; the hook below is the only production caller. */
export function stampRequestPeer(req: StampableRequest): void {
  delete req.headers[PEER_HEADER];
  if (Array.isArray(req.rawHeaders)) {
    const raw = req.rawHeaders;
    for (let i = raw.length - 2; i >= 0; i -= 2) {
      if (raw[i]?.toLowerCase() === PEER_HEADER) raw.splice(i, 2);
    }
  }
  const peer = req.socket?.remoteAddress;
  if (typeof peer === 'string' && peer.length > 0) req.headers[PEER_HEADER] = peer;
}

function patchServerPrototype(proto: EventEmitter): void {
  if (Object.getOwnPropertyDescriptor(proto, STAMP_INSTALLED)?.value === true) return;
  const chainedEmit = proto.emit;
  proto.emit = function stampedEmit(this: EventEmitter, event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'request') {
      try {
        if (isStampable(args[0])) stampRequestPeer(args[0]);
      } catch {
        // A stamp that could throw would take every request down with it; an
        // unstamped request already resolves to the limiting shared key.
      }
    }
    return chainedEmit.call(this, event, ...args);
  };
  Object.defineProperty(proto, STAMP_INSTALLED, { value: true, enumerable: false, configurable: true });
}

/** Idempotent. Called in `instrumentation.ts` right after `installUpgradeWatchdog()`. */
export function installRequestPeerStamp(): void {
  patchServerPrototype(HttpServer.prototype);
  // Not redundant: `https.Server.prototype` does not inherit from `http.Server.prototype`.
  patchServerPrototype(HttpsServer.prototype);
}
