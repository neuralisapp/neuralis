import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  features: ['channels.connect'] as string[],
  resolution: 'ok' as 'ok' | 'typed' | 'unexpected',
  /** The projects this cookie user is actually a member of. */
  memberOf: ['project-1'] as string[],
  /** The project the PENDING FLOW captured — the only source the callback has. */
  flowProjectId: 'project-1' as string | undefined,
  user: { id: 'user-1' } as { id: string } | null,
  exchanges: 0,
  callbackProvider: 'provider',
  logError: vi.fn(),
  completeOAuthCallback: vi.fn(),
}));

vi.mock('@/server/auth/session', () => ({
  getSessionUser: vi.fn(async () => mocks.user),
}));

vi.mock('@/server/auth/resolveSessionContext', () => {
  class SessionResolutionError extends Error {
    constructor(public readonly status: number, message: string) { super(message); }
  }
  return {
    SessionResolutionError,
    resolveSessionContext: vi.fn(async (_request: unknown, projectId: string) => {
      if (mocks.resolution === 'typed') throw new SessionResolutionError(401, 'Authentication required');
      if (mocks.resolution === 'unexpected') throw new Error('token=SECRET_SENTINEL path=/private/session.json');
      if (!projectId) throw new SessionResolutionError(400, 'Missing projectId');
      if (!mocks.memberOf.includes(projectId)) {
        throw new SessionResolutionError(403, 'Forbidden: no access to project');
      }
      return {
        userId: 'user-1',
        projectId,
        role: 'member',
        grantedFeatures: mocks.features,
      };
    }),
  };
});

vi.mock('../../../../../server/logging/setup', () => ({
  getLogger: () => ({
    child: () => ({ error: mocks.logError, info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  }),
}));

vi.mock('../../../../../server/host/bootstrap', () => ({
  getRuntime: async () => ({
    whenReady: async () => {},
    services: {
      get: () => ({
        listChannelDescriptors: () => [{ kind: 'whatsapp', auth: { mode: 'oauth2' } }],
      }),
      oauthCallbackFor: (state: string) => state.startsWith('channel_oauth_') ? { completeOAuthCallback: mocks.completeOAuthCallback } : undefined,
      providerOf: (id: string) => id === 'channel-gateway' ? 'provider' : mocks.callbackProvider,
    },
    getLoader: () => ({ listLoaded: () => [{ provides: ['oauth-callback:channel_oauth_'] }] }),
  }),
}));

vi.mock('../../../../../server/oauth/appOrigin', () => ({
  resolveTrustedAppOrigin: () => 'https://neuralis.example',
}));

import { GET } from '../route';

const request = (query: string) => new NextRequest(`https://neuralis.example/api/oauth/whatsapp?${query}`);
const params = { params: Promise.resolve({ channel: 'whatsapp' }) };

beforeEach(() => {
  mocks.features = ['channels.connect'];
  mocks.resolution = 'ok';
  mocks.memberOf = ['project-1'];
  mocks.flowProjectId = 'project-1';
  mocks.user = { id: 'user-1' };
  mocks.exchanges = 0;
  mocks.callbackProvider = 'provider';
  vi.clearAllMocks();
  // Models the real completion owner: the flow is consumed, `verifySession` is
  // called with the CAPTURED project, and only a non-null answer reaches the
  // client-secret read and the token POST.
  mocks.completeOAuthCallback.mockImplementation(async (input: {
    verifySession?: (projectId: string | undefined) => Promise<unknown>;
  }) => {
    const verified = input.verifySession ? await input.verifySession(mocks.flowProjectId) : null;
    if (!verified) throw new Error('callback_session_required');
    mocks.exchanges += 1;
    return { family: 'channel', subject: 'whatsapp', tokens: { accessToken: 'secret-token' } };
  });
});

describe('GET /api/oauth/[channel]', () => {
  it('the START leg is not a host route any more — no start, with or without a session', async () => {
    // The flow starts in the owning package (`POST channels/oauth/<kind>/start`
    // through the catch-all); only the provider's registered return leg is here.
    for (const query of ['action=start&projectId=project-1', 'projectId=project-1', '']) {
      const response = await GET(request(query), params);
      expect(response.status).toBe(404);
    }
    mocks.user = null;
    expect((await GET(request('action=start&projectId=project-1'), params)).status).toBe(404);
    expect(mocks.completeOAuthCallback).not.toHaveBeenCalled();
  });

  it('logs an unexpected session failure but returns no secret or path', async () => {
    mocks.resolution = 'unexpected';
    const response = await GET(request('action=callback&state=channel_oauth_s&code=c'), params);
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).not.toContain('SECRET_SENTINEL');
    expect(body).not.toContain('/private/session.json');
    expect(mocks.logError).toHaveBeenCalledWith(
      'unexpected session resolution failure',
      expect.objectContaining({ error: expect.stringContaining('SECRET_SENTINEL') }),
    );
    expect(mocks.exchanges).toBe(0);
  });

  it('completes a callback that carries NO projectId query, using the flow project', async () => {
    const response = await GET(request('action=callback&state=channel_oauth_s&code=c'), params);
    expect(response.status).toBe(200);
    const { resolveSessionContext } = await import('@/server/auth/resolveSessionContext');
    expect(resolveSessionContext).toHaveBeenCalledWith(expect.anything(), 'project-1');
    expect(mocks.exchanges).toBe(1);
  });

  it('refuses a flow from a project the caller can no longer reach, with zero exchanges', async () => {
    mocks.flowProjectId = 'project-a';
    mocks.memberOf = ['project-b'];
    const response = await GET(request('action=callback&state=channel_oauth_s&code=c'), params);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid or expired OAuth state' });
    expect(mocks.exchanges).toBe(0);
  });

  it('denies a viewer before callback token exchange', async () => {
    mocks.features = ['core.observe'];
    const response = await GET(request('action=callback&state=channel_oauth_s&code=c'), params);
    expect(response.status).toBe(400);
    expect(mocks.exchanges).toBe(0);
  });

  it('refuses a callback owned by another service provider before exchanging', async () => {
    mocks.callbackProvider = 'foreign-provider';
    const response = await GET(request('action=callback&state=channel_oauth_s&code=c'), params);
    expect(response.status).toBe(400);
    expect(mocks.completeOAuthCallback).not.toHaveBeenCalled();
    expect(mocks.exchanges).toBe(0);
  });

  it.each([
    { family: 'git', subject: 'whatsapp', tokens: { accessToken: 'secret-token' } },
    { family: 'channel', subject: 'foreign-channel', tokens: { accessToken: 'secret-token' } },
    { family: 'channel', subject: 'whatsapp' },
    { family: 'channel', subject: 'whatsapp', tokens: { accessToken: '' } },
  ])('does not disclose a malformed completion result %j', async (result) => {
    mocks.completeOAuthCallback.mockResolvedValue(result);
    const response = await GET(request('action=callback&state=channel_oauth_s&code=c'), params);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain('secret-token');
  });

  it('returns the token only to the trusted declared opener origin', async () => {
    const response = await GET(new NextRequest('https://hostile.example/api/oauth/whatsapp?action=callback&state=channel_oauth_s&code=c'), params);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('https://neuralis.example');
    expect(html).not.toContain('hostile.example');
    expect(html).toContain('secret-token');
  });

  it('refuses an unauthenticated callback before the flow is touched', async () => {
    mocks.user = null;
    const response = await GET(request('action=callback&state=channel_oauth_s&code=c'), params);
    expect(response.status).toBe(401);
    expect(mocks.completeOAuthCallback).not.toHaveBeenCalled();
  });
});
