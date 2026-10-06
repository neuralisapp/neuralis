/**
 * Upgrade watchdog — the host-owned deadline that reaps an HTTP `Upgrade`
 * socket nobody claimed (orphaned-osprey / A5, the fifth ECO-001 door).
 *
 * ## The leak
 *
 * When a `Server` has **one or more** `'upgrade'` listeners, Node hands the raw
 * socket to them and steps out of the way: it removes its own
 * `data`/`end`/`close` handlers and `unconsume()`s the parser. If no listener
 * adopts the socket, nothing ever reads from it — the readable side stays
 * paused, so the client's FIN is never consumed, `'end'` never fires and the
 * `allowHalfOpen: false` auto-close never triggers. The socket is also past
 * `keepAliveTimeout`/`headersTimeout`, which only govern the request path. The
 * result is a permanently retained fd, measured as `CLOSE_WAIT`.
 *
 * This is an **unauthenticated fd-exhaustion primitive**: a well-formed upgrade
 * to a path none of the mounts owns needs no credential and no malformed input.
 * The process cannot die out from under it either — Next installs process-level
 * `uncaughtException`/`unhandledRejection` handlers whose entire body is
 * `console.error` — so the container never restarts and the leak is permanent.
 * Measured on a live post-W12 container: 20 unowned upgrades moved PID 1's fd
 * count 49 → 69 (+20 exactly), and the 40 fds already present were the ones an
 * earlier probe had leaked **11 hours before** and were still held.
 *
 * Both published ports leak identically:
 *   - `:3101` (the companion HTTP server) has three `'upgrade'` listeners — the
 *     terminal PTY (`agent-core/src/terminal/backend/WsServer.ts`), machine-core's
 *     KasmVNC bridge (`machine-core/src/backend/MachineWsServer.ts`) and the
 *     host-terminal proxy (`agent-core/src/hostBroker/mountHostTerminalCompanion.ts`).
 *     Each `return`s on paths the others own, so an unowned path is ignored by
 *     all three.
 *   - `:3100` (the app) — `next@16.3.6`'s `start-server.js:251` registers an
 *     `'upgrade'` listener **unconditionally**, and its body destroys only on
 *     *throw*; an unclaimed path resolves and retains the socket.
 *
 * ## The predicate: ADOPTION, never bytes
 *
 * An unclaimed upgrade socket **has no reader — that is what the leak IS**. Node
 * hands the socket over and removes its own `data`/`end`/`close` handlers; if no
 * listener adopts it, nothing is ever registered in their place. A real claimant
 * does the opposite as its very first act: `ws`'s `setSocket`
 * (`ws@8.21.0/lib/websocket.js`) attaches a `'data'` listener to the socket it
 * has taken over. Measured against real `ws@8.21.0` `handleUpgrade`:
 *
 * ```
 * /ws/terminal/real-claim   claimed = true    dataListeners = 1   readableListeners = 0
 * /nomatch-unclaimed        claimed = false   dataListeners = 0   readableListeners = 0
 * ```
 *
 * So the watchdog asks the only question that separates the two:
 *
 * ```
 * claimed  ⇔  destroyed || listenerCount('data') > 0 || listenerCount('readable') > 0
 * ```
 *
 * `'data'` is the arm every real claimant trips — `ws` and any other flowing-mode
 * reader. `'readable'` is belt-and-braces for a claimant that reads in PAUSED
 * mode; no first-party mount does that today, and the arm exists so a future
 * non-`ws` claimant is not reaped for choosing the other read style.
 *
 * The `destroyed` arm answers a *different* question and is not redundant: a
 * claimant may REJECT a handshake instead of adopting it. `ws`'s `abortHandshake`
 * (`ws@8.21.0/lib/websocket-server.js:505`) writes an HTTP error response via
 * `socket.end(...)` and never attaches a reader, and `completeUpgrade`'s first
 * statement is `if (!socket.readable || !socket.writable) return socket.destroy();`
 * (`:372`). Neither shape leaks and neither needs reaping — `destroyed` covers
 * both, and it is also why a claim racing our destroy is safe.
 *
 * ### Why `bytesWritten` is the WRONG QUESTION — both halves of the trap
 *
 * Two bytes-based predicates were tried; both are defeated, and they are mirror
 * images. A future reader who "fixes" one re-introduces the other, so both are
 * recorded here on purpose.
 *
 * **(a) An ABSOLUTE `bytesWritten > 0` is defeated by bytes written BEFORE the
 * upgrade.** `socket.bytesWritten` is cumulative over the whole **TCP
 * connection**, not over the upgrade. HTTP/1.1 keep-alive lets an upgrade arrive
 * as request N>1 on a connection that already carried a response — and the
 * companion server sets `keepAliveTimeout = 120_000`, so that window is two
 * minutes wide. Measured on a real `http.Server` with one non-claiming listener
 * shaped exactly like our three mounts:
 *
 * ```
 * /fresh-nomatch      bytesWritten = 0     destroyed = false   <- unclaimed, detected
 * /keepalive-nomatch  bytesWritten = 158   destroyed = false   <- unclaimed, read as CLAIMED
 * ```
 *
 * **(b) A DELTA against a baseline captured at `emit('upgrade')` is defeated by
 * bytes written AFTER it — and the attacker controls those too.** Pipeline one
 * ordinary `GET /` in front of the unowned upgrade in a SINGLE write and never
 * read the response. Node's parser emits `'request'`, an async handler returns at
 * its first `await` without writing, the parser continues through the same buffer
 * and emits `'upgrade'` (baseline captured at 0), and only then is the response
 * written — inside the grace window. **Both published ports write responses
 * asynchronously by construction**: `:3100` is next's `start-server.js`
 * `await requestHandler(req, res)`, `:3101` is Express with async auth. Measured
 * with the delta predicate verbatim:
 *
 * ```
 * fresh unowned             baseline = 0    bytes at deadline = 0     -> reaped   OK
 * pipelined + ASYNC handler baseline = 0    bytes at deadline = 155   -> SPARED   LEAK
 * pipelined + SYNC handler  baseline = 154  bytes at deadline = 154   -> reaped   (safe ordering)
 * ```
 *
 * The third row is the trap inside the trap: with a SYNCHRONOUS request handler
 * the response lands BEFORE the emit and the delta predicate looks correct. That
 * is the one ordering neither published server produces, so a harness that writes
 * its response synchronously pins the safe case while reading as coverage of the
 * dangerous one. Unit-test case (6) is deliberately ASYNC for exactly this reason.
 *
 * **(c) Therefore `bytesWritten` is not a claim signal in either form, and no
 * third framing of the counter rescues it** — it measures what the SERVER WROTE,
 * while the leak is about whether anything READS. Do not re-add it as an extra
 * `||` arm "for safety": an OR with a defeated predicate is the defeated
 * predicate. It is deliberately absent from `UpgradeSocket` so the trap is
 * unreachable rather than merely unused.
 *
 * ## Why this is a HOOK on `Server.prototype.emit`, and NOT an `'upgrade'` listener
 *
 * The adoption predicate captures nothing at arm time, so — unlike the delta
 * predicate it replaced, which a last-registered listener could not express at
 * all — it would also be *correct* from a last-registered `'upgrade'` listener.
 * The hook is kept regardless: property 2 below is a hard blocker on the listener
 * shape, and the other three are why the hook is preferable rather than merely
 * tolerable.
 *
 * 1. **Order-independence.** Registration order stops being an invariant at all;
 *    a future mount added after this one cannot silently break the mechanism.
 * 2. **`listeners('upgrade').length` stays 3.** The floor written in tracked
 *    prose — "three listeners share this server, each returns on a non-match,
 *    never destroy a foreign path" — stays literally true with **no carve-out**.
 *    A carve-out is exactly the sentence a future agent would misread as licence
 *    to destroy on a non-match.
 * 3. **`mountPackageCompanions` stays untouched**, so its "the loop injects PORTS
 *    ONLY" contract is not muddied by a destroy policy. That file — and
 *    `startMcpServer` — are the wrong home for this.
 * 4. **It cannot regress a zero-listener server.** With ZERO `'upgrade'`
 *    listeners Node does not emit at all: it serves the request as an ordinary
 *    request (measured on Node 22: `upgradeListeners: 0` → the client receives
 *    `HTTP/1.1 200 OK`, `serverSocketDestroyed: false`). Since `emit('upgrade')`
 *    is never called there, this hook is never invoked there.
 *    (The widely repeated claim that Node "auto-destroys an unclaimed upgrade
 *    socket when there are zero listeners" is FALSE on Node 22. The conclusion
 *    it was used to support — that ≥1 listener retains an unclaimed socket — is
 *    the real, separately measured finding.)
 *
 * `http.Server.prototype` has no own `emit` (it inherits `EventEmitter`'s), so
 * assigning one shadows it for `http.Server` instances only.
 * `https.Server.prototype` does **not** inherit from `http.Server.prototype`
 * (its prototype is `tls.Server.prototype`), and Next takes an
 * `https.createServer` branch under `selfSignedCertificate` — hence both
 * prototypes are patched.
 *
 * ## Anti-fixes — stated so a reviewer can reject a "simplification"
 *
 * - **Do NOT `socket.destroy()` on a non-match inside a package mount.** That is
 *   an unchanged floor; three listeners share one server and each returns on the
 *   paths the others own. This file exists precisely so that shape stays
 *   forbidden.
 * - **Do NOT replace the timer with a synchronous or `setImmediate` check.** One
 *   mount claims **asynchronously**: `mountHostTerminalCompanion.ts:116` opens
 *   `void (async () => { … })()` and only reaches `wss.handleUpgrade(...)` after
 *   `resolveSessionUser`, `getProjectById`, `probeHostBroker`, `hostTerminalList`
 *   and `resolveRoots` have awaited. A prompt check destroys it mid-auth.
 * - **Do NOT re-add `bytesWritten` as an extra `||` arm.** See (a)/(b)/(c) above:
 *   an OR with a defeated predicate is the defeated predicate, and arm (b) is
 *   reachable by an unauthenticated attacker on both published ports. The field is
 *   absent from `UpgradeSocket` on purpose.
 * - **Do NOT `socket.resume()` or attach a `'data'` listener to detect the client
 *   FIN.** The `head` buffer and every subsequent byte belong to whichever mount
 *   claims the socket; consuming them corrupts a legitimate handshake. Since the
 *   predicate now READS `listenerCount('data')`, a watchdog-owned `'data'`
 *   listener would additionally make the watchdog read its own probe as a claim —
 *   self-defeating as well as destructive.
 * - **Do NOT add a shared `handled` flag / claim port to `CompanionMountPorts`.**
 *   Considered and rejected: it requires editing all three package mounts, adds a
 *   contract surface every future mount must remember to call, and **fails open
 *   when forgotten** — whereas this watchdog covers a forgetful future mount by
 *   construction.
 * - **Do NOT log `req.url`, `req.headers.host` or any header value.**
 *   Attacker-controlled bytes in an unbounded log are the other half of the same
 *   DoS. The COUNT only, sampled.
 * - **Do NOT add a `process.on('uncaughtException'|'unhandledRejection')`
 *   backstop.** Next's are already installed and Node fires every listener — a
 *   second one only double-logs.
 * - **Do NOT use `socket.setTimeout()` instead.** Its safety would depend on the
 *   claimant calling `setTimeout(0)`; a future non-`ws` claimant would have a
 *   healthy but idle WebSocket reaped.
 *
 * ## Residuals — named, not hidden
 *
 * 1. **HTTPS is covered only because `https.Server.prototype` is patched here.**
 *    A future server class that is neither (a bare `net.Server` speaking HTTP, a
 *    third-party HTTP implementation) is NOT covered; it would need its own
 *    prototype added to `installUpgradeWatchdog`.
 * 2. **The blast radius is every `http.Server`/`https.Server` in the process, and
 *    that is INTENDED, not an accident.** Both published ports leak, and any
 *    future in-process HTTP server would leak the same way. The hook is inert on
 *    servers that never receive an upgrade, and on servers with zero `'upgrade'`
 *    listeners (see property 4 above).
 * 3. **A boot-window of TIME is uncovered — not a set of servers.** Because
 *    `emit` resolves through the prototype at CALL time, this patch covers
 *    servers that already exist and are already listening; that is precisely how
 *    it reaches `:3100`, which Next binds in `start-server.js` *before* running
 *    `initialize()` → `instrumentation.register()`. What is uncovered is any
 *    upgrade **emitted** before `installUpgradeWatchdog()` executes — a boot
 *    window on an already-bound app port, never measured and deliberately not
 *    quantified here. Keep the install line first in `register()`; do not "fix"
 *    this by moving the servers.
 * 4. **`CONNECT` is a sibling event with the same retained-socket shape and is
 *    deliberately not hooked.** Its ZERO-listener behaviour is NOT the same as
 *    `'upgrade'`'s, so do not transplant that mental model: measured on Node 22,
 *    a CONNECT with zero `'connect'` listeners IS destroyed by Node, whereas a
 *    zero-listener `'upgrade'` is served as an ordinary `200 OK` (property 4
 *    above). What IS identical is the dangerous case — with ONE non-claiming
 *    `'connect'` listener the socket is retained exactly like an unclaimed
 *    upgrade. The conclusion therefore stands unchanged: it is unreachable today
 *    because this repo registers zero server-side `'connect'` listeners.
 *    Registering one reopens the class; hook `'connect'` here in the same commit
 *    if that ever happens.
 */

import { Server as HttpServer } from 'node:http';
import { Server as HttpsServer } from 'node:https';
import { setTimeout as setNodeTimeout, clearTimeout as clearNodeTimeout } from 'node:timers';
import type { EventEmitter } from 'node:events';

/**
 * How long an upgrade may sit unclaimed before the host reaps it.
 *
 * **This is a SECURITY FLOOR and stays a code constant. It is never a
 * `configSettings[]` key** — CLAUDE.md principle 9 exempts anti-brute-force and
 * untrusted-input caps from the declare-don't-hardcode rule, because this
 * deadline governs an *unauthenticated* request on a *published* port: an
 * operator who could raise it to an hour would restore the exact primitive it
 * closes.
 *
 * **Derivation — 2 × the declared maximum of one broker probe, plus margin.**
 * The slowest legitimate claimant is `mountHostTerminalCompanion`, which makes
 * **two serial** broker calls on its claim path (`probeHostBroker()` at `:148`,
 * `hostTerminalList()` at `:175`) on top of `resolveSessionUser`,
 * `getProjectById` and `resolveRoots`. Each broker call is bounded by
 * agent-core's `hostBrokerProbeTimeoutMs`, declared with `max: 30000`, so the
 * legitimate claim path can legally exceed 60 s. A 30 s grace would silently
 * reap an admin's host-terminal authentication — contradicting that mount's own
 * stated principle ("fail closed WITH a reason; a host tab that silently does
 * nothing is the fail-INVISIBLE outcome"). 120 s also matches the companion
 * server's own `keepAliveTimeout`, so this is not a new outlier on the socket.
 *
 * **Host code must never READ `hostBrokerProbeTimeoutMs` at runtime.** That
 * would be a new host → product-package coupling, by string key, on a hot
 * security path. The number is derived from the declared ceiling *here, once, in
 * prose*; if that ceiling ever moves, this comment and this constant move with
 * it.
 */
export const UPGRADE_HANDSHAKE_GRACE_MS = 120_000;

/**
 * The structural slice of `net.Socket` the watchdog needs.
 *
 * Node types the `'upgrade'` payload as a `stream.Duplex`. Rather than assert the
 * concrete class, the watchdog states what it actually uses and narrows to it
 * with a real type guard — so a non-socket payload from some future emitter is
 * skipped instead of crashing the hook.
 *
 * **`bytesWritten` is deliberately NOT a member.** It is defeated as a claim
 * signal in both the absolute and the delta framing (module docstring, (a)/(b)),
 * and leaving it off the type makes that trap *unreachable* rather than merely
 * unused: a "for safety" `|| socket.bytesWritten > …` arm does not compile.
 */
export type UpgradeSocket = {
  readonly destroyed: boolean;
  listenerCount(event: 'data' | 'readable'): number;
  destroy(): void;
  once(event: 'close', listener: () => void): unknown;
};

/**
 * Prototype marker. `Symbol.for` (not a module-local boolean) because Next
 * chunking can evaluate this module more than once per process — the
 * `globalThis` + `Symbol.for` anchoring rule.
 */
const WATCHDOG_INSTALLED = Symbol.for('neuralis.upgradeWatchdog.v1');

/** Per-socket marker so a socket can never be armed twice (two timers, two destroys). */
const SOCKET_ARMED = Symbol.for('neuralis.upgradeWatchdog.armed.v1');

/**
 * Monotonic count of sockets this watchdog has reaped. The log is sampled off it.
 *
 * Deliberately the ONLY module-level state. An earlier draft also kept a `Set` of
 * pending timers for a `close()` that the hook design does not need — every timer
 * is `unref`ed and cleared on the socket's `'close'`, so nothing can hold the
 * process open and nothing needs an inventory. State nobody reads is not
 * defence in depth; it is a question a reviewer has to ask.
 */
let orphanedUpgrades = 0;

function isMarked(target: object, marker: symbol): boolean {
  return Object.getOwnPropertyDescriptor(target, marker)?.value === true;
}

function mark(target: object, marker: symbol): void {
  Object.defineProperty(target, marker, {
    value: true,
    enumerable: false,
    configurable: true,
    writable: false,
  });
}

/**
 * Real type guard — no assertion. `in`-narrowing on an `object`-narrowed
 * `unknown` is enough for every field the watchdog touches.
 */
function isUpgradeSocket(value: unknown): value is UpgradeSocket {
  return (
    typeof value === 'object' &&
    value !== null &&
    'destroyed' in value &&
    typeof value.destroyed === 'boolean' &&
    'listenerCount' in value &&
    typeof value.listenerCount === 'function' &&
    'destroy' in value &&
    typeof value.destroy === 'function' &&
    'once' in value &&
    typeof value.once === 'function'
  );
}

/**
 * Arm the deadline for ONE upgrade socket. Pure and unit-testable — it takes a
 * socket, not a server, and holds no reference to the request.
 *
 * `graceMs` exists so the unit tests can drive a real `http.Server` over real
 * TCP without waiting two minutes. **The production value is not configurable:**
 * the hook below always calls this with the default, and nothing reads an env
 * var or a config key. See `UPGRADE_HANDSHAKE_GRACE_MS` for why.
 */
export function armUpgradeWatchdog(
  socket: UpgradeSocket,
  graceMs: number = UPGRADE_HANDSHAKE_GRACE_MS,
): void {
  // Nothing to watch: already gone, or already armed by another evaluation of
  // this module (the `Symbol.for` marker is shared across copies).
  if (socket.destroyed) return;
  if (isMarked(socket, SOCKET_ARMED)) return;
  mark(socket, SOCKET_ARMED);

  // NOTHING is captured at arm time. The predicate is evaluated once, at the
  // deadline, against the socket's live state — see the module docstring for why
  // a `bytesWritten` baseline captured here is defeated by bytes the attacker
  // causes to be written AFTER it (a pipelined plain request + an async handler,
  // which is how both published ports are built).
  const timer = setNodeTimeout(() => {
    // "Did anybody CLAIM this socket?" — asked as "does anything READ it?", the
    // only question an unclaimed socket answers differently from a live one.
    if (socket.destroyed) return;
    // `'data'` is the arm every real claimant trips: `ws.setSocket` attaches one
    // to the socket it takes over (measured: 1 on a real `handleUpgrade`, 0 on
    // every unclaimed shape incl. the pipelined attack).
    if (socket.listenerCount('data') > 0) return;
    // Belt-and-braces for a claimant that reads in PAUSED mode instead. No
    // first-party mount does today; this keeps a future non-`ws` claimant safe.
    if (socket.listenerCount('readable') > 0) return;

    orphanedUpgrades += 1;
    // SAMPLED, and the COUNT only. Never `req.url`, never `req.headers.host`,
    // never a header value — attacker-controlled bytes in an unbounded log are
    // the other half of this same DoS. The watchdog deliberately never receives
    // the request object, so there is nothing here to leak by accident.
    if (orphanedUpgrades === 1 || orphanedUpgrades % 100 === 0) {
      console.warn('[upgrade-watchdog] destroyed unclaimed upgrade socket', {
        orphaned: orphanedUpgrades,
      });
    }
    // No handshake and no close code: a destroyed socket cannot reveal whether
    // the path it asked for exists. A claim racing this destroy is safe —
    // `ws.completeUpgrade`'s first statement is
    // `if (!socket.readable || !socket.writable) return socket.destroy();`.
    socket.destroy();
  }, graceMs);

  timer.unref();

  socket.once('close', () => {
    clearNodeTimeout(timer);
  });
}

function patchServerPrototype(proto: EventEmitter): void {
  if (isMarked(proto, WATCHDOG_INSTALLED)) return;

  const originalEmit = proto.emit;

  proto.emit = function patchedEmit(
    this: EventEmitter,
    event: string | symbol,
    ...args: unknown[]
  ): boolean {
    if (event === 'upgrade') {
      try {
        // `'upgrade'` is `(req, socket, head)`.
        const socket = args[1];
        if (isUpgradeSocket(socket)) armUpgradeWatchdog(socket);
      } catch {
        // DELIBERATE SWALLOW — the one silent catch in this file, and the reason
        // it exists at all. An exception escaping `Server.emit('upgrade')`
        // unwinds past every listener's `socket.destroy()` and retains the
        // socket for the life of the process: it IS the fd-exhaustion primitive
        // this whole increment closes. A watchdog that can throw would be a
        // second copy of the bug.
      }
    }
    // Always the original's return value, and `listenerCount` is never touched:
    // `emit`'s boolean means "did this event have listeners", and callers
    // (including Node's own internals) branch on it.
    return originalEmit.call(this, event, ...args);
  };

  mark(proto, WATCHDOG_INSTALLED);
}

/**
 * Install the watchdog process-wide. Idempotent: a second call is a no-op and
 * leaves `emit`'s identity unchanged.
 *
 * Called once, first thing in `instrumentation.ts#register()`. It adds NO
 * `'upgrade'` listener — `listeners('upgrade').length` is unchanged on every
 * server — which keeps the tracked "three listeners share this server, each
 * returns on a non-match" floor literally true with no carve-out, and makes the
 * mechanism independent of mount registration order (module docstring,
 * properties 1 and 2).
 */
export function installUpgradeWatchdog(): void {
  patchServerPrototype(HttpServer.prototype);
  // NOT redundant: `https.Server.prototype` does not inherit from
  // `http.Server.prototype`, and Next serves over `https` under
  // `selfSignedCertificate`.
  patchServerPrototype(HttpsServer.prototype);
}
