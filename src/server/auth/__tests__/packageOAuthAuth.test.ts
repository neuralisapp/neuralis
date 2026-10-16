/**
 * The OAuth-bearer resolver: it hands every non-ticket bearer to the kernel
 * `route-token-verifier` for the host API resource and never falls through.
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyRouteToken: vi.fn(),
  services: { get: vi.fn() },
}));
vi.mock('@/server/host/bootstrap', () => ({
  getRuntime: async () => ({ whenReady: async () => undefined, services: mocks.services }),
}));

import { packageApiChallenge, packageApiResource, tryResolvePackageOAuth } from '../packageOAuthAuth';

const req = (authorization?: string) => new NextRequest('http://localhost:3100/api/packages/x', { headers: new Headers(authorization ? { authorization } : {}) });

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.APP_URL;
  delete process.env.NEXTAUTH_URL;
  delete process.env.MCP_BASE_URL;
  mocks.services.get.mockImplementation((key: string) => (key === 'route-token-verifier' ? { verifyRouteToken: mocks.verifyRouteToken } : undefined));
});

describe('tryResolvePackageOAuth', () => {
  it('no header, a non-Bearer header and an nrs1. ticket are not this arm (null)', async () => {
    expect(await tryResolvePackageOAuth(req())).toBeNull();
    expect(await tryResolvePackageOAuth(req('Basic abc'))).toBeNull();
    expect(await tryResolvePackageOAuth(req('Bearer nrs1.a.b'))).toBeNull();
    expect(mocks.verifyRouteToken).not.toHaveBeenCalled();
  });

  it('asks the verifier for the host API resource (<trusted app origin>/api) and returns its live session', async () => {
    process.env.APP_URL = 'https://neuralis.example.com/';
    mocks.verifyRouteToken.mockResolvedValue({ ok: true, session: { userId: 'u1', projectId: 'p1', agentId: 'a1' }, clientId: 'c', scope: 'routes:call' });
    expect(await tryResolvePackageOAuth(req('Bearer jwt'))).toEqual({ kind: 'match', session: { userId: 'u1', projectId: 'p1', agentId: 'a1' }, clientId: 'c', scope: 'routes:call' });
    expect(mocks.verifyRouteToken).toHaveBeenCalledWith('jwt', 'https://neuralis.example.com/api');
    expect(packageApiResource()).toBe('https://neuralis.example.com/api');
  });

  it('a refused, throwing or absent verifier REJECTS a present bearer — never null', async () => {
    mocks.verifyRouteToken.mockResolvedValueOnce({ ok: false, code: 'wrong_resource' });
    expect(await tryResolvePackageOAuth(req('Bearer jwt'))).toEqual({ kind: 'reject', code: 'wrong_resource' });
    mocks.verifyRouteToken.mockRejectedValueOnce(new Error('boom'));
    expect(await tryResolvePackageOAuth(req('Bearer jwt'))).toEqual({ kind: 'reject', code: 'not_ready' });
    mocks.services.get.mockReturnValue(undefined);
    expect(await tryResolvePackageOAuth(req('Bearer jwt'))).toEqual({ kind: 'reject', code: 'not_ready' });
  });

  it('the challenge names the issuer\'s metadata document for /api, secret-free', () => {
    process.env.MCP_BASE_URL = 'https://mcp.example.com/';
    expect(packageApiChallenge()).toBe('Bearer realm="neuralis", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/api", scope="routes:call"');
    expect(packageApiChallenge('invalid_token')).toContain('error="invalid_token"');
  });
});
