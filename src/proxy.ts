/**
 * Host proxy — MCP Apps sandbox-origin fence (MCP1-C).
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

const SANDBOX_ALLOWED_PATHS = new Set(['/mcp-sandbox']);

export function proxy(request: NextRequest): NextResponse {
  const sandboxPort = process.env.NEURALIS_MCP_SANDBOX_PORT;
  if (!sandboxPort) return NextResponse.next();

  const host = request.headers.get('host') ?? '';
  const portIdx = host.lastIndexOf(':');
  const requestPort = portIdx > -1 ? host.slice(portIdx + 1) : '';
  if (requestPort !== sandboxPort) return NextResponse.next();

  // Sandbox origin: serve NOTHING but the shell (deny-by-default).
  if (SANDBOX_ALLOWED_PATHS.has(request.nextUrl.pathname)) return NextResponse.next();
  return new NextResponse(JSON.stringify({ error: 'not_found' }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  }) as NextResponse;
}

// NO matcher config: the fence must cover EVERYTHING on the sandbox port —
// /api, pages, and _next assets alike (the shell is a self-contained route
// handler and references no assets). Main-origin traffic exits on the first
// port check, so the cost is one header read per request.
