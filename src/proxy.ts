/**
 * Host proxy — the MCP Apps sandbox-origin fence (MCP1-C), then the
 * setup-state fence (see `setupFence` below).
 *
 * Next.js runs the `proxy.ts` file convention in front of every request, on the
 * Node.js runtime; the export must be named `proxy`.
 *
 * The MCP Apps isolated-origin sandbox is the SAME Next server published on a
 * SECOND host port (`NEURALIS_MCP_SANDBOX_PORT`) — a distinct browser origin.
 * Cookies ignore ports, so requests arriving on the sandbox origin still carry
 * the session cookie: without this fence, untrusted MCP-app HTML running
 * same-origin with the sandbox port could fetch authenticated API routes.
 *
 * The fence is structural: when the request `Host` port equals the sandbox
 * port — or the `Host` is a declared `NEURALIS_MCP_SANDBOX_ORIGIN`'s own —
 * ONLY the static sandbox shell (`/mcp-sandbox`) is served — every other
 * path 404s. Template HTML never transits this origin (it travels main-origin
 * route → host page → postMessage → shell).
 *
 * When neither is set (dev without compose), this fence is
 * a no-op — and there is NO fallback origin: an MCP App card fails closed with a
 * "sandbox unavailable" View. The srcdoc/null-origin fallback was removed in
 * CARD1 3B, so an MCP App never renders without the isolated sandbox origin.
 *
 * On a configured instance a request on the app origin then meets the
 * app-origin forward: a path a package companion declared (the OAuth consent,
 * the terminal sockets) is rewritten to the companion server on loopback, so
 * the browser keeps its cookie on the ONE address it was set on. The issuer's
 * own paths (`/mcp`, the token and discovery endpoints, the device link) join
 * the set only when `MCP_BASE_URL` IS the app origin; nothing else is
 * forwarded. ⛔ Never forward a loopback-trusting path while a forwarded
 * request can still read as loopback: the companion meets it from a loopback
 * peer, so the device link counts the marker and `x-forwarded-host` as remote.
 *
 * First of all, a document navigation on another loopback spelling of a
 * loopback `APP_URL` is redirected to `APP_URL` (`loopbackSpellingRedirect`).
 * Before the forward, a STATE-CHANGING request that carries the session cookie
 * must come from the trusted app origin (`cookieWriteGate`): cookies ignore
 * ports and a sibling name is the same site, so the MCP-Apps sandbox, the
 * companion's container-served documents and a tunnel's other names would
 * otherwise ride the user's cookie into every mutating route.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { APP_ORIGIN_FORWARD_HEADER, isOriginOf, matchesAppOriginPath, readAppOriginForward } from '@neuralis/package-system/contracts';
import { isLoopbackHostname, resolveTrustedAppOrigin } from './server/oauth/appOrigin';
import { SESSION_COOKIE_NAMES } from './server/auth/sessionCookieNames';
import { getSetupState, isSetupLatched } from './server/init';
import { renderSetupRequiredPage } from './server/setupRequiredPage';
import { GLOBAL_SECURITY_HEADERS } from './server/config/securityHeaders';

const SANDBOX_ALLOWED_PATHS = new Set(['/mcp-sandbox']);

export function proxy(request: NextRequest): NextResponse | Promise<NextResponse> {
  const fenced = sandboxFence(request);
  if (fenced) return fenced;
  // A configured instance pays one latched boolean read here — no I/O, no await.
  if (isSetupLatched()) return configured(request);
  return setupFence(request);
}

/** A configured instance: the loopback-spelling redirect, the cookie-write gate, then the app-origin forward. */
function configured(request: NextRequest): NextResponse {
  return loopbackSpellingRedirect(request) ?? cookieWriteGate(request) ?? appOriginForward(request);
}

/**
 * A browser that opened a loopback install on ANOTHER loopback spelling
 * (`127.0.0.1` for a `localhost` `APP_URL`, `[::1]`, or the reverse) — same
 * port and protocol — is sent to `APP_URL` itself: its cookie, the terminal
 * and the MCP-Apps sandbox all live on that one spelling. Document
 * navigations only (`Sec-Fetch-Mode: navigate` or `Sec-Fetch-Dest: document`,
 * headers a page cannot set), GET/HEAD only, to a fixed target — never for a
 * non-loopback `APP_URL`, another port, a fetch, a socket or a write.
 */
function loopbackSpellingRedirect(request: NextRequest): NextResponse | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  if (request.headers.get('sec-fetch-mode') !== 'navigate' && request.headers.get('sec-fetch-dest') !== 'document') return null;
  let app: URL;
  let here: URL;
  try {
    app = new URL(resolveTrustedAppOrigin());
    here = new URL(`http://${request.headers.get('host') ?? ''}`);
  } catch {
    return null;
  }
  if (!isLoopbackHostname(app.hostname) || !isLoopbackHostname(here.hostname) || here.hostname === app.hostname) return null;
  const defaultPort = app.protocol === 'https:' ? '443' : '80';
  if (request.nextUrl.protocol !== app.protocol || (here.port || defaultPort) !== (app.port || defaultPort)) return null;
  const { pathname, search } = request.nextUrl;
  const res = NextResponse.redirect(new URL(`${pathname}${search}`, app), 308);
  res.headers.set('cache-control', 'no-store');
  return res;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The boundary gate for cookie-authenticated writes (GR1: a stronger gate, no
 * capability removed). A non-GET/HEAD/OPTIONS request that CARRIES the session
 * cookie passes only when its `Origin` is the trusted app origin or the browser
 * says `Sec-Fetch-Site: same-origin` (the app on another spelling of its own
 * address); anything else — another port, a sibling name, `null`, an absent
 * header — is refused here, before any route parses the body. A request
 * without the cookie (a CLI or OAuth bearer, a channel webhook, a provider's
 * OAuth callback) is untouched: it carries no ambient credential to abuse.
 */
function cookieWriteGate(request: NextRequest): NextResponse | null {
  if (SAFE_METHODS.has(request.method)) return null;
  const names = request.cookies.getAll().map((c) => c.name);
  if (!names.some((name) => SESSION_COOKIE_NAMES.some((cookie) => name === cookie || name.startsWith(`${cookie}.`)))) return null;
  if (request.headers.get('sec-fetch-site') === 'same-origin') return null;
  if (isOriginOf(request.headers.get('origin'), resolveTrustedAppOrigin())) return null;
  return new NextResponse(JSON.stringify({ error: 'cross_origin_refused' }), {
    status: 403,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  }) as NextResponse;
}

/**
 * A declared companion path → the companion server on loopback, with the
 * per-boot marker SET (a client's own copy is overwritten). Every other path
 * passes untouched. Before the companion server listens nothing is published,
 * and a declared path answers Next's own 404.
 */
function appOriginForward(request: NextRequest): NextResponse {
  const forward = readAppOriginForward();
  const { pathname, search } = request.nextUrl;
  if (!forward || !matchesAppOriginPath(forward.paths, pathname)) return NextResponse.next();
  const headers = new Headers(request.headers);
  headers.set(APP_ORIGIN_FORWARD_HEADER, forward.marker);
  return NextResponse.rewrite(new URL(`${pathname}${search}`, forward.target), { request: { headers } });
}

/**
 * Did this request arrive on the sandbox origin? Its port equals
 * `NEURALIS_MCP_SANDBOX_PORT` (the port split), or its `Host` equals the host
 * of a DECLARED `NEURALIS_MCP_SANDBOX_ORIGIN` (a hostname of its own behind a
 * tunnel or a proxy, where the edge serves 443 and no port tells them apart).
 */
function isSandboxHost(host: string): boolean {
  const sandboxPort = process.env.NEURALIS_MCP_SANDBOX_PORT;
  if (sandboxPort) {
    const portIdx = host.lastIndexOf(':');
    if (portIdx > -1 && host.slice(portIdx + 1) === sandboxPort) return true;
  }
  const declared = process.env.NEURALIS_MCP_SANDBOX_ORIGIN?.trim();
  if (!declared) return false;
  try {
    return new URL(declared).host === host.toLowerCase();
  } catch {
    return false;
  }
}

/** The sandbox origin's answer, or null when the request is not fenced. */
function sandboxFence(request: NextRequest): NextResponse | null {
  if (!isSandboxHost(request.headers.get('host') ?? '')) return null;

  // Sandbox origin: serve NOTHING but the shell (deny-by-default).
  if (SANDBOX_ALLOWED_PATHS.has(request.nextUrl.pathname)) return null;
  return new NextResponse(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  }) as NextResponse;
}

/**
 * The setup-state fence. Until the instance is configured (`server/init.ts`
 * `getSetupState`), every request is answered here with a 503 — no route that
 * needs the session secret or a user record is reached: `/api/health` passes
 * (it reports `setup_required` itself), any other `/api/**` gets JSON, and every
 * other path the one static page. It authenticates nothing.
 */
async function setupFence(request: NextRequest): Promise<NextResponse> {
  const state = await getSetupState();
  if (state.configured) return configured(request);
  const { pathname } = request.nextUrl;
  if (pathname === '/api/health') return NextResponse.next();
  const headers = new Headers({ 'cache-control': 'no-store', 'retry-after': '30' });
  for (const { key, value } of GLOBAL_SECURITY_HEADERS) headers.set(key, value);
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    headers.set('content-type', 'application/json');
    return new NextResponse(JSON.stringify({ error: 'setup_required' }), { status: 503, headers }) as NextResponse;
  }
  headers.set('content-type', 'text/html; charset=utf-8');
  return new NextResponse(renderSetupRequiredPage(state.reason), { status: 503, headers }) as NextResponse;
}

// NO matcher config: both fences must cover EVERYTHING — /api, pages, and
// _next assets alike (the sandbox shell is a self-contained route handler and
// the setup page references no assets). Per-request cost on a configured
// instance: one header read (the port check), one latched boolean read, on a
// GET two Sec-Fetch header reads (plus one origin parse for a navigation), on a
// non-GET request one cookie-name scan and one Origin compare, and one prefix
// check over the published paths (4 today, 13 on a one-address install); a forwarded
// request adds Next's proxy hop (one `ProxyServer` per request). An
// unconfigured instance reads its users directory at most once per ~2 s window.
