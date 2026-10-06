/**
 * Upgrade-watchdog unit tests (orphaned-osprey / A5).
 *
 * These drive a **real `http.Server` over real TCP**, deliberately. Fake timers
 * plus stub sockets cannot express the two shapes that motivate the whole file,
 * because both are properties of Node's HTTP parser rather than of the watchdog:
 * an upgrade arriving as request N>1 on a keep-alive connection (case 2), and an
 * upgrade pipelined in front of a response the server writes ASYNCHRONOUSLY
 * (case 6, the regression test for the bytes-based predicate this file replaced).
 * Both are only reachable by speaking HTTP/1.1 on a socket.
 *
 * The grace is injected per call (`armUpgradeWatchdog(socket, ms)`); the
 * production constant is never configurable.
 *
 * ## Declaration order is load-bearing, twice
 *
 * 1. The behaviour block runs BEFORE the prototype-hook block. Once the hook is
 *    installed it arms every upgrade with the 120 s production grace *before any
 *    listener runs*, and the per-socket marker then refuses the harness's short
 *    grace — every behaviour test would hang out the full two minutes. A
 *    `beforeAll` assertion fails loud if that order is ever swapped.
 * 2. Inside the behaviour block, the sampling test is FIRST. The orphan counter
 *    is module-global and monotonic and the log samples on
 *    `count === 1 || count % 100 === 0`, so only a counter still at zero makes
 *    "exactly one line for ten reaped sockets" deterministic rather than
 *    accidentally vacuous.
 */
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { Server as HttpServer } from 'node:http';
import { Server as HttpsServer } from 'node:https';
import { connect, Socket as NetSocket } from 'node:net';
import { join } from 'node:path';

import {
  armUpgradeWatchdog,
  installUpgradeWatchdog,
  UPGRADE_HANDSHAKE_GRACE_MS,
  type UpgradeSocket,
} from '../upgradeWatchdog';

/** Long enough to stay stable on a loaded box, short enough to keep the suite quick. */
const GRACE_MS = 400;
/** Slack added after the grace before asserting the outcome. */
const SETTLE_MS = 350;
/** How long the ASYNC harness handler defers its response. Well inside `GRACE_MS`. */
const ASYNC_RESPONSE_MS = 20;

const HOST_HEADER = 'watchdog.test.invalid';
const WATCHDOG_INSTALLED = Symbol.for('neuralis.upgradeWatchdog.v1');

const UPGRADE_HEADERS = [
  'Upgrade: websocket',
  'Connection: Upgrade',
  'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
  'Sec-WebSocket-Version: 13',
].join('\r\n');

function upgradeRequest(path: string): string {
  return `GET ${path} HTTP/1.1\r\nHost: ${HOST_HEADER}\r\n${UPGRADE_HEADERS}\r\n\r\n`;
}

function plainRequest(path: string): string {
  return `GET ${path} HTTP/1.1\r\nHost: ${HOST_HEADER}\r\n\r\n`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function hookInstalled(): boolean {
  return Object.getOwnPropertyDescriptor(HttpServer.prototype, WATCHDOG_INSTALLED) !== undefined;
}

/**
 * Claim a socket the way `ws` does — the fixture the whole predicate rests on.
 *
 * **`ws` is NOT a dependency of the host and is not resolvable from `neuralis/`
 * (verified), so it is reproduced rather than imported.** A real claim has two
 * observable acts:
 *
 * 1. `completeUpgrade` writes the 101 headers
 *    (`ws@8.21.0/lib/websocket-server.js:428`);
 * 2. `setSocket` (`ws@8.21.0/lib/websocket.js`) attaches a `'data'` listener to
 *    the socket it has taken over.
 *
 * Act 2 is the one the watchdog reads, and its fidelity is measured, not assumed:
 * against a real `ws@8.21.0` `handleUpgrade`, a claimed socket carried
 * `dataListeners = 1` while every unclaimed shape carried `0` — including the
 * pipelined+async attack of case (6).
 */
function claimLikeWs(socket: NetSocket): void {
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n');
  socket.on('data', () => {});
}

type UpgradeRecord = {
  /** The raw server-side socket, kept so assertions can read `destroyed`. */
  socket: NetSocket;
  /**
   * `bytesWritten` observed at the instant `armUpgradeWatchdog` was called.
   *
   * The watchdog no longer captures this — the predicate is adoption, not bytes.
   * The tests still record it because it is what makes the two bytes-based traps
   * VISIBLE: case (2) pins a non-zero value on an unclaimed socket (bytes before
   * the arm) and case (6) pins a zero value that grows before the deadline (bytes
   * after the arm).
   */
  baselineAtArm: number;
  path: string;
};

type Harness = {
  port: number;
  upgrades: UpgradeRecord[];
  server: HttpServer;
  close: () => Promise<void>;
};

/**
 * A real HTTP server shaped like the `:3101` companion server: an ordinary
 * request handler plus ONE `'upgrade'` listener that returns on paths it does
 * not own — exactly the three first-party mounts' shape.
 *
 * `onUpgrade` lets a test play the claimant, synchronously or asynchronously.
 */
async function startHarness(opts?: {
  /** Called after the watchdog is armed; adopt the socket to "claim" it. */
  onUpgrade?: (record: UpgradeRecord) => void;
  /** Omit the `'upgrade'` listener entirely (pins the zero-listener case). */
  noUpgradeListener?: boolean;
  /**
   * Write the ordinary response AFTER an `await` instead of synchronously.
   *
   * This is the ordering BOTH published ports actually produce — `:3100` is
   * next's `start-server.js` `await requestHandler(req, res)`, `:3101` is Express
   * with async auth — and it is the ordering that defeats a delta predicate. A
   * synchronous handler writes its response BEFORE `emit('upgrade')` and is the
   * SAFE ordering neither server produces; see case (6).
   */
  asyncResponse?: boolean;
  graceMs?: number;
}): Promise<Harness> {
  const upgrades: UpgradeRecord[] = [];
  const server = new HttpServer();

  server.on('request', (_req, res) => {
    const send = (): void => {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': '2' });
      res.end('ok');
    };
    if (opts?.asyncResponse) {
      void sleep(ASYNC_RESPONSE_MS).then(send);
    } else {
      send();
    }
  });

  if (!opts?.noUpgradeListener) {
    server.on('upgrade', (req, socket) => {
      // Node types the payload as a `Duplex`; on an `http.Server` it is always a
      // `net.Socket`. Narrow with `instanceof` rather than asserting.
      if (!(socket instanceof NetSocket)) return;
      const record: UpgradeRecord = {
        socket,
        baselineAtArm: socket.bytesWritten,
        path: req.url ?? '',
      };
      upgrades.push(record);
      // A destroyed socket the client is still writing to emits ECONNRESET —
      // the expected outcome in the orphan cases. `'error'` is not `'data'` or
      // `'readable'`, so it is not a claim.
      socket.on('error', () => {});
      armUpgradeWatchdog(socket, opts?.graceMs ?? GRACE_MS);
      opts?.onUpgrade?.(record);
    });
  }

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('harness server did not bind a TCP port');
  }

  return {
    port: address.port,
    upgrades,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        // Upgraded sockets are detached from the server's request machinery:
        // `closeAllConnections()` does not reap them, and `server.close()`'s
        // callback never fires while one is alive — which is the leak this whole
        // file is about, reproduced in the teardown. Destroy them by hand.
        for (const record of upgrades) record.socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

type Client = {
  socket: NetSocket;
  closed: () => boolean;
  waitForData: (predicate: (all: string) => boolean, timeoutMs: number) => Promise<boolean>;
};

/** Open a client socket and collect everything the server sends back. */
async function openClient(port: number): Promise<Client> {
  const socket = connect({ port, host: '127.0.0.1' });
  let buffer = '';
  let isClosed = false;
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    isClosed = true;
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  return {
    socket,
    closed: () => isClosed,
    waitForData: async (predicate, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(buffer)) return true;
        await sleep(10);
      }
      return predicate(buffer);
    },
  };
}

/** Wait until the harness has seen `count` upgrades (or time out). */
async function waitForUpgrades(harness: Harness, count: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (harness.upgrades.length < count && Date.now() < deadline) {
    await sleep(10);
  }
  expect(harness.upgrades.length).toBe(count);
}

describe('armUpgradeWatchdog (real http.Server over real TCP)', () => {
  beforeAll(() => {
    // See the file docstring, point 1: these tests are only meaningful while the
    // process-wide hook is NOT installed.
    expect(hookInstalled()).toBe(false);
  });

  it('(9) samples the log, and no log line carries the URL, Host or any header value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const harness = await startHarness();
    const orphanCount = 10;
    const secretPath = '/nomatch-osprey-secret-path';

    try {
      const clients = await Promise.all(
        Array.from({ length: orphanCount }, () => openClient(harness.port)),
      );
      for (const client of clients) client.socket.write(upgradeRequest(secretPath));
      await waitForUpgrades(harness, orphanCount);
      await sleep(GRACE_MS + SETTLE_MS);

      expect(harness.upgrades.every((u) => u.socket.destroyed)).toBe(true);

      const lines = warn.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('[upgrade-watchdog]'),
      );
      // Sampled: exactly one line for ten reaped sockets.
      expect(lines.length).toBe(1);
      expect(lines.length).toBeLessThan(orphanCount);
      // The COUNT, and nothing else.
      expect(lines[0][1]).toEqual({ orphaned: 1 });
      const serialized = JSON.stringify(lines);
      expect(serialized).not.toContain(secretPath);
      expect(serialized).not.toContain(HOST_HEADER);
      expect(serialized).not.toContain('Sec-WebSocket-Key');
      expect(serialized).not.toContain('dGhlIHNhbXBsZSBub25jZQ==');

      for (const client of clients) client.socket.destroy();
    } finally {
      warn.mockRestore();
      await harness.close();
    }
  });

  it('(1) destroys a fresh, unowned upgrade after the grace — nothing ever read it', async () => {
    const harness = await startHarness();
    try {
      const client = await openClient(harness.port);
      client.socket.write(upgradeRequest('/nomatch-osprey'));
      await waitForUpgrades(harness, 1);

      const record = harness.upgrades[0];
      expect(record.socket.destroyed).toBe(false);
      // The leak, stated as the predicate sees it: no reader, on either arm.
      expect(record.socket.listenerCount('data')).toBe(0);
      expect(record.socket.listenerCount('readable')).toBe(0);

      await sleep(GRACE_MS + SETTLE_MS);
      expect(record.socket.destroyed).toBe(true);
      // The client observes the reap.
      expect(client.closed()).toBe(true);
      client.socket.destroy();
    } finally {
      await harness.close();
    }
  });

  it('(2) destroys an unowned upgrade with bytes written BEFORE the arm (keep-alive)', async () => {
    // Trap half (a): an ABSOLUTE `bytesWritten > 0` predicate reads this socket
    // as claimed. One ordinary request first, then upgrade on the SAME socket.
    const harness = await startHarness();
    try {
      const client = await openClient(harness.port);
      client.socket.write(plainRequest('/'));
      expect(await client.waitForData((all) => all.includes('200 OK'), 3000)).toBe(true);

      client.socket.write(upgradeRequest('/nomatch-osprey'));
      await waitForUpgrades(harness, 1);

      const record = harness.upgrades[0];
      // Non-vacuity guard: were this 0 the test would degenerate into case (1).
      expect(record.baselineAtArm).toBeGreaterThan(0);
      expect(record.socket.destroyed).toBe(false);
      // Bytes on the wire, but still nobody reading — which is the whole point.
      expect(record.socket.listenerCount('data')).toBe(0);

      await sleep(GRACE_MS + SETTLE_MS);
      expect(record.socket.destroyed).toBe(true);
      client.socket.destroy();
    } finally {
      await harness.close();
    }
  });

  it('(3) spares a fresh upgrade claimed synchronously (ws-shaped: 101 + adoption)', async () => {
    const harness = await startHarness({
      onUpgrade: (record) => claimLikeWs(record.socket),
    });
    try {
      const client = await openClient(harness.port);
      client.socket.write(upgradeRequest('/owned'));
      await waitForUpgrades(harness, 1);

      const record = harness.upgrades[0];
      expect(record.baselineAtArm).toBe(0);
      expect(record.socket.listenerCount('data')).toBe(1);

      await sleep(GRACE_MS + SETTLE_MS);
      expect(record.socket.destroyed).toBe(false);
      expect(client.closed()).toBe(false);
      client.socket.destroy();
    } finally {
      await harness.close();
    }
  });

  it('(4) spares a keep-alive upgrade claimed synchronously — a non-zero baseline is irrelevant either way', async () => {
    const harness = await startHarness({
      onUpgrade: (record) => claimLikeWs(record.socket),
    });
    try {
      const client = await openClient(harness.port);
      client.socket.write(plainRequest('/'));
      expect(await client.waitForData((all) => all.includes('200 OK'), 3000)).toBe(true);

      client.socket.write(upgradeRequest('/owned'));
      await waitForUpgrades(harness, 1);

      const record = harness.upgrades[0];
      expect(record.baselineAtArm).toBeGreaterThan(0);

      await sleep(GRACE_MS + SETTLE_MS);
      expect(record.socket.destroyed).toBe(false);
      expect(client.closed()).toBe(false);
      client.socket.destroy();
    } finally {
      await harness.close();
    }
  });

  it('(5) spares an upgrade claimed ASYNCHRONOUSLY just inside the window (mountHostTerminalCompanion)', async () => {
    // `mountHostTerminalCompanion` claims only after `resolveSessionUser`,
    // `getProjectById`, `probeHostBroker`, `hostTerminalList` and `resolveRoots`
    // have awaited. A synchronous or `setImmediate` check would destroy it
    // mid-authentication; this is that mount's regression test.
    const harness = await startHarness({
      onUpgrade: (record) => {
        setTimeout(() => claimLikeWs(record.socket), GRACE_MS - 120);
      },
    });
    try {
      const client = await openClient(harness.port);
      client.socket.write(upgradeRequest('/ws/host-terminal/abc'));
      await waitForUpgrades(harness, 1);

      const record = harness.upgrades[0];
      // Not yet claimed at arm time — the claim lands later, inside the window.
      expect(record.socket.listenerCount('data')).toBe(0);

      await sleep(GRACE_MS + SETTLE_MS);
      expect(record.socket.listenerCount('data')).toBe(1);
      expect(record.socket.destroyed).toBe(false);
      expect(client.closed()).toBe(false);
      client.socket.destroy();
    } finally {
      await harness.close();
    }
  });

  it('(5b) spares a socket claimed by ADOPTION ALONE — zero bytes written', async () => {
    // Non-vacuity for the sparing direction: this socket is spared with
    // `bytesWritten` still at 0, so nothing about the sparing decision can be
    // attributed to a write. Adoption is the signal.
    const harness = await startHarness({
      onUpgrade: (record) => {
        record.socket.on('data', () => {});
      },
    });
    try {
      const client = await openClient(harness.port);
      client.socket.write(upgradeRequest('/owned-silent'));
      await waitForUpgrades(harness, 1);

      const record = harness.upgrades[0];
      expect(record.baselineAtArm).toBe(0);

      await sleep(GRACE_MS + SETTLE_MS);
      expect(record.socket.bytesWritten).toBe(0);
      expect(record.socket.destroyed).toBe(false);
      expect(client.closed()).toBe(false);
      client.socket.destroy();
    } finally {
      await harness.close();
    }
  });

  it('(5c) spares a PAUSED-mode adopter that attaches only `readable` — the belt-and-braces arm', async () => {
    // No first-party mount reads in paused mode today; the arm exists so a future
    // non-`ws` claimant is not reaped for choosing the other read style. Without
    // a test the arm would be prose.
    const harness = await startHarness({
      onUpgrade: (record) => {
        record.socket.on('readable', () => {
          record.socket.read();
        });
      },
    });
    try {
      const client = await openClient(harness.port);
      client.socket.write(upgradeRequest('/owned-paused'));
      await waitForUpgrades(harness, 1);

      const record = harness.upgrades[0];
      // Exactly the arm under test: no `'data'` listener at all.
      expect(record.socket.listenerCount('data')).toBe(0);
      expect(record.socket.listenerCount('readable')).toBe(1);

      await sleep(GRACE_MS + SETTLE_MS);
      expect(record.socket.destroyed).toBe(false);
      expect(client.closed()).toBe(false);
      client.socket.destroy();
    } finally {
      await harness.close();
    }
  });

  it('(6) REGRESSION (the delta-predicate blocker): destroys an unowned upgrade pipelined in front of an ASYNCHRONOUS response', async () => {
    // Trap half (b). The attacker pipelines one ordinary `GET /` in front of the
    // unowned upgrade in a SINGLE write and never reads the response. Node emits
    // `'upgrade'` BEFORE an async handler writes anything, so a baseline captured
    // at the event is 0 and the response bytes then land INSIDE the window — a
    // `bytesWritten > baseline` predicate spares the socket and the leak survives.
    // Measured: baseline 0, 155 bytes at the deadline, socket SPARED.
    //
    // The `asyncResponse` flag is load-bearing. With a SYNCHRONOUS handler the
    // response is written before the emit (baseline 154 → delta 0 → reaped), and
    // that safe ordering is the one NEITHER published port produces: `:3100` is
    // next's `await requestHandler(req, res)` and `:3101` is Express with async
    // auth. A synchronous harness pins the safe case while reading as coverage of
    // the dangerous one — which is exactly how this blocker shipped.
    const harness = await startHarness({ asyncResponse: true });
    try {
      const client = await openClient(harness.port);
      client.socket.write(plainRequest('/') + upgradeRequest('/nomatch-osprey'));
      await waitForUpgrades(harness, 1);

      const record = harness.upgrades[0];
      // The emit beat the response: a delta baseline would have been captured at 0.
      expect(record.baselineAtArm).toBe(0);
      expect(record.socket.destroyed).toBe(false);

      // The response lands AFTER the arm — this is what proves the test exercised
      // the DANGEROUS ordering rather than the safe one.
      expect(await client.waitForData((all) => all.includes('200 OK'), 3000)).toBe(true);
      expect(record.socket.bytesWritten).toBeGreaterThan(record.baselineAtArm);

      // ...and yet nothing ever adopted it. Bytes are not a claim.
      expect(record.socket.listenerCount('data')).toBe(0);
      expect(record.socket.listenerCount('readable')).toBe(0);

      await sleep(GRACE_MS + SETTLE_MS);
      expect(record.socket.listenerCount('data')).toBe(0);
      expect(record.socket.destroyed).toBe(true);
      client.socket.destroy();
    } finally {
      await harness.close();
    }
  });

  it('(7) after the window we destroy, and a late claim neither throws nor writes', async () => {
    const harness = await startHarness();
    try {
      const client = await openClient(harness.port);
      client.socket.write(upgradeRequest('/nomatch-osprey'));
      await waitForUpgrades(harness, 1);

      const record = harness.upgrades[0];
      await sleep(GRACE_MS + SETTLE_MS);
      expect(record.socket.destroyed).toBe(true);

      // A claimant arriving late. Real `ws` never reaches the write:
      // `completeUpgrade`'s FIRST statement is
      // `if (!socket.readable || !socket.writable) return socket.destroy();`
      // (ws@8.21.0/lib/websocket-server.js:372). We assert the weaker, provable
      // property — the socket is inert — rather than asserting ws internals.
      const before = record.socket.bytesWritten;
      expect(() => {
        record.socket.write('HTTP/1.1 101 Switching Protocols\r\n\r\n', () => {});
      }).not.toThrow();
      await sleep(50);
      expect(record.socket.bytesWritten).toBe(before);
      expect(record.socket.destroyed).toBe(true);

      client.socket.destroy();
    } finally {
      await harness.close();
    }
  });

  it('(8) never double-destroys: an already-dead socket is not armed, and a socket destroyed inside the window is left alone', async () => {
    // (a) already destroyed at arm time — no timer, no destroy call.
    let destroyCalls = 0;
    const deadSocket: UpgradeSocket = {
      destroyed: true,
      listenerCount: () => 0,
      destroy: () => {
        destroyCalls += 1;
      },
      once: () => undefined,
    };
    armUpgradeWatchdog(deadSocket, 1);
    await sleep(60);
    expect(destroyCalls).toBe(0);

    // (b) destroyed by the peer inside the window — the deadline must observe
    // `destroyed` and return rather than call `destroy()` a second time.
    const harness = await startHarness();
    try {
      const client = await openClient(harness.port);
      client.socket.write(upgradeRequest('/nomatch-osprey'));
      await waitForUpgrades(harness, 1);

      const record = harness.upgrades[0];
      const spy = vi.spyOn(record.socket, 'destroy');
      record.socket.destroy();
      expect(spy).toHaveBeenCalledTimes(1);

      await sleep(GRACE_MS + SETTLE_MS);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
      client.socket.destroy();
    } finally {
      await harness.close();
    }
  });
});

describe('installUpgradeWatchdog (prototype hook)', () => {
  let hadOwnHttpEmit = false;
  let hadOwnHttpsEmit = false;

  beforeAll(() => {
    hadOwnHttpEmit = Object.getOwnPropertyNames(HttpServer.prototype).includes('emit');
    hadOwnHttpsEmit = Object.getOwnPropertyNames(HttpsServer.prototype).includes('emit');
    installUpgradeWatchdog();
  });

  afterAll(() => {
    // Leave the process as we found it: drop the own `emit` we installed and the
    // prototype markers.
    if (!hadOwnHttpEmit) Reflect.deleteProperty(HttpServer.prototype, 'emit');
    if (!hadOwnHttpsEmit) Reflect.deleteProperty(HttpsServer.prototype, 'emit');
    Reflect.deleteProperty(HttpServer.prototype, WATCHDOG_INSTALLED);
    Reflect.deleteProperty(HttpsServer.prototype, WATCHDOG_INSTALLED);
  });

  it('(10) is idempotent: a second install leaves `emit` identity unchanged, and a socket is armed once', async () => {
    const httpEmit = HttpServer.prototype.emit;
    const httpsEmit = HttpsServer.prototype.emit;
    installUpgradeWatchdog();
    expect(HttpServer.prototype.emit).toBe(httpEmit);
    expect(HttpsServer.prototype.emit).toBe(httpsEmit);
    // Both prototypes are patched separately — `https.Server.prototype` does NOT
    // inherit from `http.Server.prototype`, so one patch cannot cover the other.
    expect(httpEmit).not.toBe(httpsEmit);

    // Armed at most once: the hook arms with the PRODUCTION grace before any
    // listener runs, so a second arm with a 1 ms grace must be refused by the
    // per-socket marker (otherwise the socket would die almost immediately).
    const harness = await startHarness({ graceMs: UPGRADE_HANDSHAKE_GRACE_MS });
    try {
      const client = await openClient(harness.port);
      client.socket.write(upgradeRequest('/nomatch-osprey'));
      await waitForUpgrades(harness, 1);

      const record = harness.upgrades[0];
      armUpgradeWatchdog(record.socket, 1);
      await sleep(150);
      expect(record.socket.destroyed).toBe(false);
      client.socket.destroy();
    } finally {
      await harness.close();
    }
  });

  it('(11) does not touch a server with ZERO upgrade listeners — Node serves it as an ordinary request', async () => {
    const harness = await startHarness({ noUpgradeListener: true });
    try {
      expect(harness.server.listenerCount('upgrade')).toBe(0);
      const emitSpy = vi.spyOn(harness.server, 'emit');

      const client = await openClient(harness.port);
      client.socket.write(upgradeRequest('/nomatch-osprey'));
      const gotResponse = await client.waitForData((all) => all.includes('200 OK'), 3000);

      // Pins B4: with zero listeners Node never calls `emit('upgrade')` — it
      // serves the request normally — so this hook cannot regress that case.
      expect(gotResponse).toBe(true);
      expect(emitSpy.mock.calls.filter((call) => call[0] === 'upgrade')).toHaveLength(0);
      expect(client.closed()).toBe(false);

      emitSpy.mockRestore();
      client.socket.destroy();
    } finally {
      await harness.close();
    }
  });

  it('(12) adds no `upgrade` listener — the three-mount listener count is unchanged', async () => {
    const harness = await startHarness();
    try {
      // The harness registers exactly one; installation added none.
      const before = harness.server.listenerCount('upgrade');
      expect(before).toBe(1);
      installUpgradeWatchdog();
      expect(harness.server.listenerCount('upgrade')).toBe(before);
    } finally {
      await harness.close();
    }
  });

  it('exposes the production grace as a 120 s code constant', () => {
    expect(UPGRADE_HANDSHAKE_GRACE_MS).toBe(120_000);
  });
});

/**
 * The grace is the ONE place this increment SUBTRACTS a capability: a legitimate
 * handshake now has a hard ceiling where it previously had none. That subtraction
 * is derived rather than guessed — 2 x the declared `max` of agent-core's
 * `hostBrokerProbeTimeoutMs`, for the TWO serial broker calls on
 * `mountHostTerminalCompanion`'s claim path (`probeHostBroker()` then
 * `hostTerminalList()`) — but until this block existed the derivation was
 * enforced by a comment, and **prose does not fail a build**. If a later
 * increment raises that declared `max`, or adds a third serial broker call, an
 * admin's host-terminal authentication is silently reaped: precisely the
 * fail-INVISIBLE outcome that mount's own principle forbids.
 *
 * This is the **derive-and-verify** shape the repo already uses — the same as
 * `workspace/packages/__tests__/hostPortProviderMount.test.ts`, which derives
 * its expected set from the package manifests and fails loud on drift.
 *
 * **Boundary, stated so nobody "consolidates" it:** host RUNTIME code must NEVER
 * read this package key. Doing so would be a new host -> product-package
 * coupling, by string key, on a hot security path (see the
 * `UPGRADE_HANDSHAKE_GRACE_MS` docstring). A TEST may read it, and that is the
 * sanctioned form of the check.
 */
describe('UPGRADE_HANDSHAKE_GRACE_MS derivation (derive-and-verify)', () => {
  /** Path is resolved from THIS FILE, never from `process.cwd()`. */
  const AGENT_CORE_MANIFEST = join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'packages',
    'agent-core',
    'package.json',
  );
  const PROBE_KEY = 'hostBrokerProbeTimeoutMs';
  /** `probeHostBroker()` then `hostTerminalList()` — two serial broker calls. */
  const SERIAL_BROKER_CALLS = 2;

  type ConfigSettingShape = { readonly key?: unknown; readonly max?: unknown };
  type ManifestShape = { readonly neuralis?: { readonly configSettings?: ConfigSettingShape[] } };

  it('leaves room for the two serial broker calls a legitimate host-terminal claim makes', () => {
    const manifest: ManifestShape = JSON.parse(
      readFileSync(AGENT_CORE_MANIFEST, 'utf-8'),
    ) as ManifestShape;
    const settings = manifest.neuralis?.configSettings ?? [];
    const entry = settings.find((setting) => setting.key === PROBE_KEY);

    // Found-ness is asserted BEFORE the comparison. An `undefined`-driven pass is
    // the classic way a derive-and-verify guard silently stops guarding.
    if (entry === undefined) {
      throw new Error(
        `derive-and-verify FAILED: packages/agent-core/package.json declares no ` +
          `neuralis.configSettings[] entry with key "${PROBE_KEY}". ` +
          `UPGRADE_HANDSHAKE_GRACE_MS (${UPGRADE_HANDSHAKE_GRACE_MS} ms) is derived from that ` +
          `key's declared max. If the key was renamed or removed, re-derive the grace from the ` +
          `new ceiling and update this guard — do NOT delete the guard.`,
      );
    }
    const declaredMax = entry.max;
    if (typeof declaredMax !== 'number') {
      throw new Error(
        `derive-and-verify FAILED: neuralis.configSettings[] entry "${PROBE_KEY}" has no numeric ` +
          `\`max\` (got ${typeof declaredMax}). The bound below cannot be computed, so the ` +
          `${UPGRADE_HANDSHAKE_GRACE_MS} ms grace is unverified. Restore the declared max.`,
      );
    }

    expect(
      SERIAL_BROKER_CALLS * declaredMax,
      `UPGRADE_HANDSHAKE_GRACE_MS (${UPGRADE_HANDSHAKE_GRACE_MS} ms) must exceed ` +
        `${SERIAL_BROKER_CALLS} x the declared max of "${PROBE_KEY}" (${declaredMax} ms = ` +
        `${SERIAL_BROKER_CALLS * declaredMax} ms), because mountHostTerminalCompanion makes ` +
        `${SERIAL_BROKER_CALLS} SERIAL broker calls (probeHostBroker, hostTerminalList) on its ` +
        `claim path before it can adopt the socket. It no longer does. An admin's host-terminal ` +
        `authentication would now be SILENTLY reaped mid-handshake. Fix by raising ` +
        `UPGRADE_HANDSHAKE_GRACE_MS in neuralis/src/server/upgradeWatchdog.ts and updating its ` +
        `derivation comment — NOT by relaxing this bound. Host RUNTIME code must never read this ` +
        `key; only this test may.`,
    ).toBeLessThan(UPGRADE_HANDSHAKE_GRACE_MS);
  });
});
