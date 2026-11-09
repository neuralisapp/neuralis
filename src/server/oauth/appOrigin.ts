/**
 * The ONE trusted app origin every outbound-OAuth route derives its redirect
 * from — and, handed to native packages as `hostPorts.appOrigin`, the one
 * every package-built redirect and its `assertNeuralisOrigin` check use too.
 * Before that single source the host resolved `APP_URL || NEXTAUTH_URL` while
 * the package resolved `NEXTAUTH_URL ?? APP_URL`, so a deployment that declared
 * BOTH with different origins had the redirect built from one and validated
 * against the other.
 *
 * Precedence, in one place:
 *   1. `APP_URL` — the operator's declared public origin;
 *   2. `NEXTAUTH_URL` — a working login already requires it;
 *   3. the REQUEST's origin, but ONLY when it is loopback;
 *   4. the loopback default on the port this app listens on
 *      (`http://localhost:<NEURALIS_APP_PORT>`, 3100 when unset).
 *
 * A declared value that is not a valid absolute http(s) URL is IGNORED rather
 * than thrown on: an unparseable `APP_URL` used to make every callback answer
 * 500, and the arms below it are loopback-only, so ignoring it cannot widen the
 * origin — it degrades to the dev default.
 *
 * **NEVER a request header.** `request.url` in Next is built from the `Host`
 * header, so arm 3 is fenced to loopback hostnames: a spoofed `Host`/`Origin`
 * (or a container's own `0.0.0.0:3100` bind address) must not become an OAuth
 * redirect target or a banner destination.
 */

/**
 * The undeclared default — loopback on the port this app LISTENS on, so a host
 * started on another port (a second home, the desktop app's own port) never
 * names somebody else's `:3100`. The only non-declared, non-loopback answer.
 */
export function defaultAppOrigin(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const port = Number(env.NEURALIS_APP_PORT);
  return `http://localhost:${Number.isInteger(port) && port > 0 && port < 65536 ? port : 3100}`;
}

function parseOrigin(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** `URL.hostname` keeps the brackets on an IPv6 literal — match both spellings. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Is this a loopback hostname (`URL.hostname` spelling, brackets for IPv6 included)? */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname);
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * The operator-DECLARED origin, if there is a usable one. Request-independent —
 * this is what the package port publishes, because a package builds redirect
 * URIs with no request in hand.
 */
export function declaredAppOrigin(): string | null {
  return parseOrigin(process.env.APP_URL) ?? parseOrigin(process.env.NEXTAUTH_URL);
}

/**
 * The trusted origin for a request. `requestUrl` is optional: with it, a
 * loopback dev request may answer its own origin when nothing is declared.
 */
export function resolveTrustedAppOrigin(requestUrl?: string): string {
  const declared = declaredAppOrigin();
  if (declared) return declared;
  if (requestUrl) {
    const origin = parseOrigin(requestUrl);
    if (origin && isLoopbackOrigin(origin)) return origin;
  }
  return defaultAppOrigin();
}

/**
 * Is this a loopback origin — NECESSARY for a loopback OAuth callback, never
 * sufficient: the listener must also be reachable (the Codex start route pairs
 * it with `isLoopbackListenerReachable`, false in Docker without the opt-in).
 */
export function isLoopbackAppOrigin(origin: string): boolean {
  return isLoopbackOrigin(origin);
}
