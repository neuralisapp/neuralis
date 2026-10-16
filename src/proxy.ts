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
 * port, ONLY the static sandbox shell (`/mcp-sandbox`) is served — every other
 * path 404s. Template HTML never transits this origin (it travels main-origin
 * route → host page → postMessage → shell).
 *
 * When `NEURALIS_MCP_SANDBOX_PORT` is unset (dev without compose), this fence is
 * a no-op — and there is NO fallback origin: an MCP App card fails closed with a
 * "sandbox unavailable" View. The srcdoc/null-origin fallback was removed in
 * CARD1 3B, so an MCP App never renders without the isolated sandbox origin.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getSetupState, isSetupLatched } from './server/init';
import { renderSetupRequiredPage } from './server/setupRequiredPage';
import { GLOBAL_SECURITY_HEADERS } from './server/config/securityHeaders';

const SANDBOX_ALLOWED_PATHS = new Set(['/mcp-sandbox']);

export function proxy(request: NextRequest): NextResponse | Promise<NextResponse> {
  const fenced = sandboxFence(request);
  if (fenced) return fenced;
  // A configured instance pays one latched boolean read here — no I/O, no await.
  if (isSetupLatched()) return NextResponse.next();
  return setupFence(request);
}

/** The sandbox origin's answer, or null when the request is not fenced. */
function sandboxFence(request: NextRequest): NextResponse | null {
  const sandboxPort = process.env.NEURALIS_MCP_SANDBOX_PORT;
  if (!sandboxPort) return null;

  const host = request.headers.get('host') ?? '';
  const portIdx = host.lastIndexOf(':');
  const requestPort = portIdx > -1 ? host.slice(portIdx + 1) : '';
  if (requestPort !== sandboxPort) return null;

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
  if (state.configured) return NextResponse.next();
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
// instance: one header read (the port check) and one latched boolean read. An
// unconfigured instance reads its users directory at most once per ~2 s window.
