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

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const fsMocks = vi.hoisted(() => ({ readdir: vi.fn<(dir: string) => Promise<string[]>>() }));
vi.mock('fs/promises', () => ({ readdir: fsMocks.readdir }));
vi.mock('@neuralis/package-system/paths', () => ({
  resolveNeuralisHome: () => ({ home: '/nr-proxy-test-home', appRoot: '/nr-proxy-test-home/app', projectsRoot: '/nr-proxy-test-home/projects' }),
}));

import { proxy } from '../../proxy';
import { getSetupState } from '../init';

const SANDBOX_PORT = '3102';
const SETUP_STATE_SLOT = Symbol.for('@neuralis/host:setupState');
const savedSecret = process.env.NEXTAUTH_SECRET;

function resetSetupLatch(): void {
  delete (globalThis as { [SETUP_STATE_SLOT]?: unknown })[SETUP_STATE_SLOT];
}

/** A configured instance: the secret is set, one user record exists, and the state has latched. */
async function latchConfigured(): Promise<void> {
  process.env.NEXTAUTH_SECRET = 'test-secret';
  fsMocks.readdir.mockResolvedValue(['owner.json']);
  expect(await getSetupState()).toEqual({ configured: true });
}

beforeEach(() => {
  resetSetupLatch();
  fsMocks.readdir.mockResolvedValue([]);
});

afterEach(() => {
  resetSetupLatch();
  if (savedSecret === undefined) delete process.env.NEXTAUTH_SECRET;
  else process.env.NEXTAUTH_SECRET = savedSecret;
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
    delete process.env.NEXTAUTH_SECRET;
    const res = await proxy(request('localhost:3100', pathname));
    expect(passedThrough(res)).toBe(false);
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ error: 'setup_required' });
    expectGlobalSecurityHeaders(res);
  });

  it.each(['/', '/workspace', '/auth', '/_next/static/chunks/app.js'])('answers %s with the static setup page — no path, version or env value', async (pathname) => {
    delete process.env.NEXTAUTH_SECRET;
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
      expect(body).not.toContain('/nr-proxy-test-home');
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
    process.env.NEXTAUTH_SECRET = 'test-secret';
    const res = await proxy(request('localhost:3100', '/workspace'));
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain('no owner account yet');
    expect(body).toContain(FROZEN_DOCKER_RUN_LINE);
  });

  it('passes /api/health to its route, which reports the state itself', async () => {
    delete process.env.NEXTAUTH_SECRET;
    expect(passedThrough(await proxy(request('localhost:3100', '/api/health')))).toBe(true);
  });

  it('the sandbox fence still answers first on the sandbox port', async () => {
    delete process.env.NEXTAUTH_SECRET;
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
