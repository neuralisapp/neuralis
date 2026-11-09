/**
 * The request proxy (`src/proxy.ts`): the MCP Apps sandbox-origin fence, then
 * the setup-state fence.
 *
 * Cookies ignore ports, so a request on the sandbox port still carries the
 * session cookie. The fence is what keeps untrusted MCP-app HTML on that origin
 * from reaching any authenticated route: on the sandbox port ONLY the relay
 * shell is served, every other path answers a 404 JSON — pages, `/api` and
 * `_next` assets alike (there is deliberately no `matcher`). With the port
 * unset the fence is a no-op, and the main origin is never touched.
 *
 * An unconfigured instance answers every request 503 — JSON on `/api/**`, the
 * one static page elsewhere, `/api/health` passed to its route — and a
 * configured one pays no I/O per request once the state has latched.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { APP_ORIGIN_FORWARD_HEADER, publishAppOriginForward } from '@neuralis/package-system/contracts';

const fsMocks = vi.hoisted(() => ({ readdir: vi.fn<(dir: string) => Promise<string[]>>() }));
// A throwaway data home: the session secret is a REAL file in it (`sessionSecretFile.ts`).
const HOME = vi.hoisted(() => `${process.env.TMPDIR ?? '/tmp'}/nr-proxy-test-home-${process.pid}`);
vi.mock('fs/promises', () => ({ readdir: fsMocks.readdir }));
vi.mock('@neuralis/package-system/paths', () => ({
  resolveNeuralisHome: () => ({ home: HOME, appRoot: `${HOME}/app`, projectsRoot: `${HOME}/projects` }),
}));

import { proxy } from '../../proxy';
import { getSetupState } from '../init';

const SANDBOX_PORT = '3102';
const SETUP_STATE_SLOT = Symbol.for('@neuralis/host:setupState');
const secretFile = join(HOME, 'app', 'config', 'session-secret.key');
const setSecret = (): void => { mkdirSync(join(HOME, 'app', 'config'), { recursive: true }); writeFileSync(secretFile, 'test-secret\n'); };
const dropSecret = (): void => rmSync(secretFile, { force: true });
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

function resetSetupLatch(): void {
  delete (globalThis as { [SETUP_STATE_SLOT]?: unknown })[SETUP_STATE_SLOT];
}

/** A configured instance: the secret is set, one user record exists, and the state has latched. */
async function latchConfigured(): Promise<void> {
  setSecret();
  fsMocks.readdir.mockResolvedValue(['owner.json']);
  expect(await getSetupState()).toEqual({ configured: true });
}

beforeEach(() => {
  resetSetupLatch();
  fsMocks.readdir.mockResolvedValue([]);
});

afterEach(() => {
  resetSetupLatch();
  dropSecret();
});

function request(host: string, pathname: string): NextRequest {
  return new NextRequest(`http://${host}${pathname}`, { headers: { host } });
}

/** `NextResponse.next()` carries this header; a terminal response does not. */
function passedThrough(res: Response): boolean {
  return res.headers.get('x-middleware-next') === '1';
}

afterEach(() => {
  delete process.env.NEURALIS_MCP_SANDBOX_PORT;
  delete process.env.NEURALIS_MCP_SANDBOX_ORIGIN;
});

describe('proxy — the MCP sandbox-origin fence', () => {
  beforeEach(latchConfigured);

  it('serves the relay shell on the sandbox port', async () => {
    process.env.NEURALIS_MCP_SANDBOX_PORT = SANDBOX_PORT;
    const res = await proxy(request(`localhost:${SANDBOX_PORT}`, '/mcp-sandbox'));
    expect(passedThrough(res)).toBe(true);
  });

  it.each(['/', '/api/packages/agent-core/stream', '/api/auth/session', '/_next/static/chunks/app.js', '/mcp-sandbox/extra', '/workspace'])(
    'answers 404 JSON for %s on the sandbox port',
    async (pathname) => {
      process.env.NEURALIS_MCP_SANDBOX_PORT = SANDBOX_PORT;
      const res = await proxy(request(`localhost:${SANDBOX_PORT}`, pathname));
      expect(passedThrough(res)).toBe(false);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(await res.json()).toEqual({ error: 'not_found' });
    },
  );

  it('leaves the main origin untouched while the sandbox port is set', async () => {
    process.env.NEURALIS_MCP_SANDBOX_PORT = SANDBOX_PORT;
    const res = await proxy(request('localhost:3100', '/api/packages/agent-core/stream'));
    expect(passedThrough(res)).toBe(true);
  });

  it('a host with no port is not the sandbox origin', async () => {
    process.env.NEURALIS_MCP_SANDBOX_PORT = SANDBOX_PORT;
    const res = await proxy(request('neuralis.example', '/api/auth/session'));
    expect(passedThrough(res)).toBe(true);
  });

  it('a DECLARED sandbox origin is fenced by its host (a tunnel hostname has no port to compare)', async () => {
    process.env.NEURALIS_MCP_SANDBOX_ORIGIN = 'https://sandbox.example.com';
    for (const host of ['sandbox.example.com', 'SANDBOX.example.com']) {
      const denied = await proxy(request(host, '/api/auth/session'));
      expect(denied.status).toBe(404);
      expect(passedThrough(await proxy(request(host, '/mcp-sandbox')))).toBe(true);
    }
    // Paired control: the app's own hostname behind the same edge passes.
    expect(passedThrough(await proxy(request('app.example.com', '/api/auth/session')))).toBe(true);
  });

  it('is a no-op when the sandbox port is unset — the request on that port passes', async () => {
    const res = await proxy(request(`localhost:${SANDBOX_PORT}`, '/api/auth/session'));
    expect(passedThrough(res)).toBe(true);
  });
});

const FROZEN_DOCKER_RUN_LINE = 'docker run -it --rm --user "$(id -u):$(id -g)" \\';
const HOST_VERSION = (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

function expectGlobalSecurityHeaders(res: Response): void {
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
  expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
  expect(res.headers.get('content-security-policy')).toContain("object-src 'none'");
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('retry-after')).toBe('30');
}

describe('proxy — the setup-state fence', () => {
  it.each(['/api/packages/agent-core/agents', '/api/auth/session', '/api'])('answers %s with 503 JSON setup_required', async (pathname) => {
    dropSecret();
    const res = await proxy(request('localhost:3100', pathname));
    expect(passedThrough(res)).toBe(false);
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ error: 'setup_required' });
    expectGlobalSecurityHeaders(res);
  });

  it.each(['/', '/workspace', '/auth', '/_next/static/chunks/app.js'])('answers %s with the static setup page — no path, version or env value', async (pathname) => {
    dropSecret();
    const homeValue = '/srv/nr-home-value-7c41';
    const savedHome = process.env.NEURALIS_HOME;
    process.env.NEURALIS_HOME = homeValue;
    try {
      const res = await proxy(request('localhost:3100', pathname));
      expect(res.status).toBe(503);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expectGlobalSecurityHeaders(res);
      const body = await res.text();
      expect(Buffer.byteLength(body, 'utf8')).toBeLessThanOrEqual(8 * 1024);
      expect(body).toContain('data-neuralis-state="setup-required"');
      expect(body).toContain(FROZEN_DOCKER_RUN_LINE);
      expect(body).toContain('neuralisapp/neuralis:"$NEURALIS_TAG" node bin/neuralis.mjs setup --output "$PWD"');
      expect(body).toContain('<pre>NEURALIS_TAG=latest   # or a release tag');
      expect(body).toContain('npx neuralis setup');
      expect(body).toContain('https://docs.neuralisapp.com/getting-started/installation#if-something-fails');
      expect(body).toContain('session secret');
      expect(body).not.toContain(homeValue);
      expect(body).not.toContain(HOME);
      expect(body).not.toContain(HOST_VERSION);
      expect(body).not.toMatch(/\b\d+\.\d+\.\d+\b/);
      expect(body).not.toMatch(/<script|<link|src=/i);
      // The data home is named only inside the documented command block, never as this instance's path.
      const outsideCommand = body.replace(/<pre>NEURALIS_TAG=latest[\s\S]*?<\/pre>/, '');
      expect(outsideCommand).not.toBe(body);
      expect(outsideCommand).not.toContain('/.neuralis');
    } finally {
      if (savedHome === undefined) delete process.env.NEURALIS_HOME;
      else process.env.NEURALIS_HOME = savedHome;
    }
  });

  it('names the missing owner account when the secret is set but no user record exists', async () => {
    setSecret();
    const res = await proxy(request('localhost:3100', '/workspace'));
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain('no owner account yet');
    expect(body).toContain(FROZEN_DOCKER_RUN_LINE);
  });

  it('a home an earlier release set up (owner, no secret file) names upgrade --apply and no setup command', async () => {
    dropSecret();
    fsMocks.readdir.mockResolvedValue(['owner.json']);
    const res = await proxy(request('localhost:3100', '/workspace'));
    expect(res.status).toBe(503);
    expectGlobalSecurityHeaders(res);
    const body = await res.text();
    expect(body).toContain('data-neuralis-state="upgrade-required"');
    expect(body).toContain('<pre>neuralis upgrade --apply</pre>');
    expect(body).not.toMatch(/setup/i);
    expect(body).not.toContain(HOME);
    expect(body).not.toMatch(/<script|<link|src=/i);
  });

  it('passes /api/health to its route, which reports the state itself', async () => {
    dropSecret();
    expect(passedThrough(await proxy(request('localhost:3100', '/api/health')))).toBe(true);
  });

  it('the sandbox fence still answers first on the sandbox port', async () => {
    dropSecret();
    process.env.NEURALIS_MCP_SANDBOX_PORT = SANDBOX_PORT;
    const res = await proxy(request(`localhost:${SANDBOX_PORT}`, '/workspace'));
    expect(res.status).toBe(404);
  });

  it('a configured instance passes every request synchronously with zero fs calls after the latch', async () => {
    await latchConfigured();
    fsMocks.readdir.mockClear();
    for (const pathname of ['/', '/workspace', '/api/packages/agent-core/agents', '/api/health', '/auth']) {
      for (let i = 0; i < 10; i += 1) {
        const res = proxy(request('localhost:3100', pathname));
        expect(res).not.toBeInstanceOf(Promise);
        expect(passedThrough(res as Response)).toBe(true);
      }
    }
    expect(fsMocks.readdir).not.toHaveBeenCalled();
  });
});

describe('proxy — the app-origin forward', () => {
  const MARKER = 'a'.repeat(64);
  const TARGET = 'http://127.0.0.1:3101';
  beforeEach(async () => {
    await latchConfigured();
    publishAppOriginForward({ paths: ['/oauth/authorize', '/oauth/agents', '/ws/terminal/', '/ws/host-terminal/'], marker: MARKER, target: TARGET });
  });
  afterEach(() => publishAppOriginForward(null));

  function rewrittenTo(res: Response): string | null {
    return res.headers.get('x-middleware-rewrite');
  }

  it('P1 — a declared path is rewritten to the companion server on loopback with the marker SET over a client copy', async () => {
    const req = new NextRequest('http://localhost:3100/oauth/authorize?client_id=c&state=a%2Fb', {
      headers: { host: 'localhost:3100', [APP_ORIGIN_FORWARD_HEADER]: 'forged', cookie: 'next-auth.session-token=x' },
    });
    const res = (await proxy(req)) as Response;
    expect(rewrittenTo(res)).toBe(`${TARGET}/oauth/authorize?client_id=c&state=a%2Fb`);
    expect(res.headers.get('x-middleware-override-headers')?.split(',')).toContain(APP_ORIGIN_FORWARD_HEADER);
    expect(res.headers.get(`x-middleware-request-${APP_ORIGIN_FORWARD_HEADER}`)).toBe(MARKER);
    // The cookie travels on: the companion authenticates the browser with it.
    expect(res.headers.get('x-middleware-request-cookie')).toBe('next-auth.session-token=x');
  });

  it('P1 — a declared PREFIX forwards what is under it, never the bare prefix or a sibling name', async () => {
    expect(rewrittenTo((await proxy(request('localhost:3100', '/ws/terminal/s1?projectId=p'))) as Response)).toBe(`${TARGET}/ws/terminal/s1?projectId=p`);
    expect(rewrittenTo((await proxy(request('localhost:3100', '/ws/host-terminal/s2'))) as Response)).toBe(`${TARGET}/ws/host-terminal/s2`);
    for (const pathname of ['/ws/terminal/', '/ws/terminalx/s1', '/oauth/authorize/extra', '/oauth/authorizeX', '/oauth']) {
      const res = (await proxy(request('localhost:3100', pathname))) as Response;
      expect(rewrittenTo(res), pathname).toBeNull();
      expect(passedThrough(res), pathname).toBe(true);
    }
  });

  it('P2 — the sandbox origin forwards nothing: a declared path answers its 404', async () => {
    process.env.NEURALIS_MCP_SANDBOX_PORT = SANDBOX_PORT;
    const res = (await proxy(request(`localhost:${SANDBOX_PORT}`, '/oauth/authorize'))) as Response;
    expect(res.status).toBe(404);
    expect(rewrittenTo(res)).toBeNull();
  });

  it('P3 — while the MCP origin differs from the app origin (the published set carries no issuer path), bearer endpoints, discovery, /mcp and the device link are not forwarded', async () => {
    for (const pathname of ['/oauth/token', '/oauth/register', '/oauth/revoke', '/oauth/jwks.json', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp', '/mcp', '/ws/device-link']) {
      const res = (await proxy(request('localhost:3100', pathname))) as Response;
      expect(rewrittenTo(res), pathname).toBeNull();
      expect(passedThrough(res), pathname).toBe(true);
    }
  });

  it('one address: with the issuer paths published, /mcp, the token and discovery endpoints and the device link forward with the marker; /mcp-sandbox and the sandbox origin still do not', async () => {
    publishAppOriginForward({
      paths: ['/oauth/authorize', '/mcp', '/oauth/token', '/oauth/register', '/oauth/revoke', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/', '/.well-known/jwks.json', '/ws/device-link'],
      marker: MARKER,
      target: TARGET,
    });
    for (const pathname of ['/mcp', '/oauth/token', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource', '/.well-known/jwks.json', '/ws/device-link']) {
      const res = (await proxy(request('localhost:3100', pathname))) as Response;
      expect(rewrittenTo(res), pathname).toBe(`${TARGET}${pathname}`);
      expect(res.headers.get(`x-middleware-request-${APP_ORIGIN_FORWARD_HEADER}`), pathname).toBe(MARKER);
    }
    for (const pathname of ['/mcp-sandbox', '/mcp/x', '/mcpx']) {
      expect(rewrittenTo((await proxy(request('localhost:3100', pathname))) as Response), pathname).toBeNull();
    }
    process.env.NEURALIS_MCP_SANDBOX_PORT = SANDBOX_PORT;
    expect(((await proxy(request(`localhost:${SANDBOX_PORT}`, '/mcp'))) as Response).status).toBe(404);
  });

  it('P4 — /mcp-sandbox is not captured by the forward', async () => {
    const res = (await proxy(request('localhost:3100', '/mcp-sandbox'))) as Response;
    expect(rewrittenTo(res)).toBeNull();
    expect(passedThrough(res)).toBe(true);
  });

  it('before the companion server publishes, a declared path passes to Next untouched (its 404)', async () => {
    publishAppOriginForward(null);
    const res = (await proxy(request('localhost:3100', '/oauth/authorize'))) as Response;
    expect(rewrittenTo(res)).toBeNull();
    expect(passedThrough(res)).toBe(true);
  });

  it('an unconfigured instance forwards nothing — the setup fence answers first', async () => {
    resetSetupLatch();
    dropSecret();
    fsMocks.readdir.mockResolvedValue([]);
    const res = (await proxy(request('localhost:3100', '/oauth/authorize'))) as Response;
    expect(res.status).toBe(503);
    expect(rewrittenTo(res)).toBeNull();
  });
});

describe('proxy — another loopback spelling of a loopback APP_URL is redirected to it (document navigations only)', () => {
  beforeEach(latchConfigured);
  afterEach(() => { delete process.env.APP_URL; delete process.env.NEXTAUTH_URL; });
  const NAV = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  function nav(host: string, path: string, headers: Record<string, string> = NAV, method = 'GET'): NextRequest {
    return new NextRequest(`http://${host}${path}`, { method, headers: { host, ...headers } });
  }

  it('127.0.0.1 → the configured localhost spelling, path and query kept, 308, no-store', async () => {
    process.env.APP_URL = 'http://localhost:3100';
    const res = (await proxy(nav('127.0.0.1:3100', '/workspace?p=1'))) as Response;
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('http://localhost:3100/workspace?p=1');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(((await proxy(nav('[::1]:3100', '/'))) as Response).headers.get('location')).toBe('http://localhost:3100/');
    expect(((await proxy(nav('127.0.0.1:3100', '/', NAV, 'HEAD'))) as Response).status).toBe(308);
  });

  it('the reverse: a native APP_URL on 127.0.0.1 takes localhost to it; sec-fetch-dest alone is enough', async () => {
    process.env.APP_URL = 'http://127.0.0.1:3104';
    const res = (await proxy(nav('localhost:3104', '/auth', { 'sec-fetch-dest': 'document' }))) as Response;
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('http://127.0.0.1:3104/auth');
  });

  it('untouched: fetches, sockets, no Sec-Fetch headers, the configured spelling, another port, a non-loopback APP_URL, a write', async () => {
    process.env.APP_URL = 'http://localhost:3100';
    for (const req of [
      nav('127.0.0.1:3100', '/api/packages/x', { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }),
      nav('127.0.0.1:3100', '/ws/terminal/s1', { 'sec-fetch-mode': 'websocket', 'sec-fetch-dest': 'websocket' }),
      nav('127.0.0.1:3100', '/workspace', {}),
      nav('localhost:3100', '/workspace'),
      nav('127.0.0.1:3101', '/workspace'),
      nav('127.0.0.1:3102', '/mcp-sandbox'),
    ]) {
      const res = (await proxy(req)) as Response;
      expect(res.status, req.url).not.toBe(308);
    }
    process.env.APP_URL = 'http://192.168.1.20:3100';
    expect(((await proxy(nav('localhost:3100', '/workspace'))) as Response).status).not.toBe(308);
  });
});

describe('proxy — the cookie-request boundary gate (non-GET needs the app origin)', () => {
  beforeEach(latchConfigured);
  afterEach(() => { delete process.env.APP_URL; });

  function write(method: string, pathname: string, headers: Record<string, string>): NextRequest {
    return new NextRequest(`http://localhost:3100${pathname}`, {
      method,
      headers: { host: 'localhost:3100', 'content-type': 'text/plain', ...headers },
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{"name":"x"}' }),
    });
  }
  const COOKIE = { cookie: 'next-auth.session-token=abc' };

  it.each([
    ['the MCP-Apps sandbox port', 'http://localhost:3102'],
    ['the companion address (the desktop stream document)', 'http://localhost:3101'],
    ['a tunnel sibling name', 'https://sandbox.example.com'],
    ['a foreign page', 'https://evil.example'],
    ['`null`', 'null'],
  ])('PoC — a text/plain JSON POST with the session cookie from %s is refused before any route', async (_label, origin) => {
    for (const pathname of ['/api/packages/agent-core/agents', '/api/admin/users', '/api/projects', '/api/oauth/callback', '/api/invite/accept']) {
      const res = (await proxy(write('POST', pathname, { ...COOKIE, origin }))) as Response;
      expect(res.status, `${origin} ${pathname}`).toBe(403);
      expect(await res.json()).toEqual({ error: 'cross_origin_refused' });
    }
  });

  it('every mutating verb is covered; a cookie request with NO Origin and no Sec-Fetch-Site is refused too', async () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect(((await proxy(write(method, '/api/packages/agent-core/agents/a1', { ...COOKIE, origin: 'http://localhost:3102' }))) as Response).status).toBe(403);
    }
    expect(((await proxy(write('POST', '/api/packages/agent-core/agents', COOKIE))) as Response).status).toBe(403);
    expect(((await proxy(write('POST', '/api/packages/agent-core/agents', { cookie: '__Secure-next-auth.session-token=abc', origin: 'https://evil.example' }))) as Response).status).toBe(403);
  });

  it('paired controls: the app origin, a same-origin fetch on another spelling, a bearer call without the cookie, a webhook, GET and OPTIONS pass', async () => {
    const passes = async (req: NextRequest) => passedThrough((await proxy(req)) as Response);
    expect(await passes(write('POST', '/api/packages/agent-core/agents', { ...COOKIE, origin: 'http://localhost:3100' }))).toBe(true);
    expect(await passes(write('POST', '/api/packages/agent-core/agents', { ...COOKIE, origin: 'http://127.0.0.1:3100', 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(await passes(write('POST', '/api/packages/agent-core/agents', { authorization: 'Bearer nrs1.r.s', origin: 'https://evil.example' }))).toBe(true);
    expect(await passes(write('POST', '/api/packages/agent-core/channels/webhook/telegram/x', { origin: 'https://api.telegram.org' }))).toBe(true);
    expect(await passes(write('GET', '/api/packages/agent-core/agents', { ...COOKIE, origin: 'https://evil.example' }))).toBe(true);
    expect(await passes(write('OPTIONS', '/api/packages/agent-core/agents', { ...COOKIE, origin: 'https://evil.example' }))).toBe(true);
  });

  it('the trusted app origin is APP_URL when declared — a request on the declared address passes, the loopback default no longer does', async () => {
    process.env.APP_URL = 'https://app.example.com';
    const passes = async (origin: string) => passedThrough((await proxy(write('POST', '/api/projects', { ...COOKIE, origin }))) as Response);
    expect(await passes('https://app.example.com')).toBe(true);
    expect(await passes('http://localhost:3100')).toBe(false);
  });

  it('the forwarded consent POST from the app origin still reaches the companion', async () => {
    publishAppOriginForward({ paths: ['/oauth/authorize'], marker: 'b'.repeat(64), target: 'http://127.0.0.1:3101' });
    try {
      const res = (await proxy(write('POST', '/oauth/authorize', { ...COOKIE, origin: 'http://localhost:3100' }))) as Response;
      expect(res.headers.get('x-middleware-rewrite')).toBe('http://127.0.0.1:3101/oauth/authorize');
      expect(((await proxy(write('POST', '/oauth/authorize', { ...COOKIE, origin: 'http://localhost:3101' }))) as Response).status).toBe(403);
    } finally {
      publishAppOriginForward(null);
    }
  });
});
