/**
 * The MCP Apps sandbox-origin fence (`src/proxy.ts`).
 *
 * Cookies ignore ports, so a request on the sandbox port still carries the
 * session cookie. The fence is what keeps untrusted MCP-app HTML on that origin
 * from reaching any authenticated route: on the sandbox port ONLY the relay
 * shell is served, every other path answers a 404 JSON — pages, `/api` and
 * `_next` assets alike (there is deliberately no `matcher`). With the port
 * unset the fence is a no-op, and the main origin is never touched.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '../../proxy';

const SANDBOX_PORT = '3102';

function request(host: string, pathname: string): NextRequest {
  return new NextRequest(`http://${host}${pathname}`, { headers: { host } });
}

/** `NextResponse.next()` carries this header; a terminal response does not. */
function passedThrough(res: Response): boolean {
  return res.headers.get('x-middleware-next') === '1';
}

afterEach(() => {
  delete process.env.NEURALIS_MCP_SANDBOX_PORT;
});

describe('proxy — the MCP sandbox-origin fence', () => {
  it('serves the relay shell on the sandbox port', () => {
    process.env.NEURALIS_MCP_SANDBOX_PORT = SANDBOX_PORT;
    const res = proxy(request(`localhost:${SANDBOX_PORT}`, '/mcp-sandbox'));
    expect(passedThrough(res)).toBe(true);
  });

  it.each(['/', '/api/packages/agent-core/stream', '/api/auth/session', '/_next/static/chunks/app.js', '/mcp-sandbox/extra', '/workspace'])(
    'answers 404 JSON for %s on the sandbox port',
    async (pathname) => {
      process.env.NEURALIS_MCP_SANDBOX_PORT = SANDBOX_PORT;
      const res = proxy(request(`localhost:${SANDBOX_PORT}`, pathname));
      expect(passedThrough(res)).toBe(false);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(await res.json()).toEqual({ error: 'not_found' });
    },
  );

  it('leaves the main origin untouched while the sandbox port is set', () => {
    process.env.NEURALIS_MCP_SANDBOX_PORT = SANDBOX_PORT;
    const res = proxy(request('localhost:3100', '/api/packages/agent-core/stream'));
    expect(passedThrough(res)).toBe(true);
  });

  it('a host with no port is not the sandbox origin', () => {
    process.env.NEURALIS_MCP_SANDBOX_PORT = SANDBOX_PORT;
    const res = proxy(request('neuralis.example', '/api/auth/session'));
    expect(passedThrough(res)).toBe(true);
  });

  it('is a no-op when the sandbox port is unset — the request on that port passes', () => {
    const res = proxy(request(`localhost:${SANDBOX_PORT}`, '/api/auth/session'));
    expect(passedThrough(res)).toBe(true);
  });
});
