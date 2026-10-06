/**
 * `/api/oauth/callback` — the ONE shared OAuth redirect target.
 *
 * Three things are pinned here, and the last two are the reason this file exists:
 *
 *  - the `mcp_client_` and `git_connect_` prefixes reach the SAME api member
 *    (`completeOAuthCallback`) — the host does not branch per family any more,
 *    and must not start again;
 *  - those two prefixes answer with the STATIC completion PAGE: fixed public
 *    text, a `{family,outcome}` broadcast on the closed `connection-oauth`
 *    channel, success only AFTER the usecase resolved, and NOTHING of the
 *    provider payload, the caught exception, the state, the subject or a token
 *    anywhere in the body;
 *  - a provider that answers with `workspaceQuery` (the Codex flow) gets a
 *    redirect to the FIXED `/workspace` path on the trusted origin — its values
 *    can never move the origin or the path — and an IdP error is FORWARDED to
 *    the prefix's provider, which alone can read its pending record;
 *  - a state with NO known prefix answers **400 `unknown_oauth_state`**. It used
 *    to fall through to `POST /api/packages/agent-core/connectors/<state>/auth/
 *    complete`, an arm agent-core's connector route never had, so the caller got
 *    a forwarded 404 from a flow that had never existed. The absence of a
 *    catch-all is the fix; a future "just forward it somewhere" is the
 *    regression this row catches.
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  completeOAuthCallback: vi.fn(async (_input: { code: string; state: string; sessionUserId?: string }) => ({
    family: 'mcp',
    subject: 'srv1',
    userId: 'user-1',
    projectId: 'proj-1',
  })),
  completeWorkspaceFlow: vi.fn(async (_input: {
    code: string;
    state: string;
    sessionUserId?: string;
    error?: { code: string; description?: string };
  }): Promise<{ family: string; subject: string; workspaceQuery?: Record<string, string> }> => ({
    family: 'codex',
    subject: 'user',
    workspaceQuery: { oauth_success: 'codex' },
  })),
  completeChannelFlow: vi.fn(async () => ({ family: 'channel', subject: 'slack' })),
  getSessionUser: vi.fn(async () => ({ id: 'user-1' })),
  fetch: vi.fn(),
}));

vi.mock('../../../../../server/host/bootstrap', () => ({
  getRuntime: async () => ({
    whenReady: async () => {},
    services: {
      oauthCallbackFor: (state: string) =>
        /^(mcp_client_|git_connect_)/.test(state)
          ? { completeOAuthCallback: mocks.completeOAuthCallback }
          : state.startsWith('codex_')
            ? { completeOAuthCallback: mocks.completeWorkspaceFlow }
            : state.startsWith('channel_oauth_')
              ? { completeOAuthCallback: mocks.completeChannelFlow }
              : undefined,
    },
  }),
}));

vi.mock('../../../../../server/auth/session', () => ({
  getSessionUser: mocks.getSessionUser,
}));

vi.mock('../../../../../server/logging/setup', () => ({
  getLogger: () => ({
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

import { GET } from '../route';

const call = (state: string, code = 'the-code') =>
  GET(
    new NextRequest(
      `http://localhost:3100/api/oauth/callback?code=${code}&state=${encodeURIComponent(state)}`,
    ),
  );

const callRaw = (query: string) =>
  GET(new NextRequest(`http://localhost:3100/api/oauth/callback?${query}`));

/** Everything a completion page must NEVER carry. */
const FORBIDDEN_IN_PAGE = [
  'gho_', 'ghu_', 'sk-', 'eyJ',
  'mcp_client_', 'git_connect_',           // the state
  'srv1', 'github.com',                    // the subject
  'user-1', 'proj-1',                      // identity
  'no pending OAuth flow',                 // the caught message
  'oauth_success', 'oauth_error',          // the retired query contract
  // The channel callback's token-bearing `window.opener.postMessage` is the ONE
  // shape this page must never grow. Its OWN BroadcastChannel post is fine and
  // is asserted positively above.
  'window.opener', '.opener', 'accessToken', 'expiresIn',
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
});

describe('GET /api/oauth/callback', () => {
  it('routes an mcp_client_ state to the ONE usecase and answers the completion PAGE', async () => {
    const res = await call('mcp_client_abc');
    expect(mocks.completeOAuthCallback).toHaveBeenCalledWith({
      code: 'the-code',
      state: 'mcp_client_abc',
      sessionUserId: 'user-1',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('MCP server connected');
    expect(body).toContain("new BroadcastChannel(\"connection-oauth\")");
    expect(body).toContain('{family:"mcp",outcome:"success"}');
    for (const needle of FORBIDDEN_IN_PAGE) expect(body, needle).not.toContain(needle);
  });

  it('routes a git_connect_ state to the SAME member — one arm, not two', async () => {
    mocks.completeOAuthCallback.mockResolvedValueOnce({
      family: 'git',
      subject: 'github.com',
      userId: 'user-1',
      projectId: 'proj-1',
    });
    const res = await call('git_connect_xyz');
    expect(mocks.completeOAuthCallback).toHaveBeenCalledTimes(1);
    const body = await res.text();
    expect(body).toContain('Git host connected');
    expect(body).toContain('{family:"git",outcome:"success"}');
    for (const needle of FORBIDDEN_IN_PAGE) expect(body, needle).not.toContain(needle);
  });

  it('success is emitted ONLY after the completion resolved — a throw never reaches it', async () => {
    mocks.completeOAuthCallback.mockRejectedValueOnce(new Error('sink_unavailable for mcp_client_abc'));
    const body = await (await call('mcp_client_abc')).text();
    expect(body).not.toContain('outcome:"success"');
    expect(body).toContain('{family:"mcp",outcome:"error"}');
  });

  it('the family comes from the state PREFIX, so a FAILED git flow still names git', async () => {
    mocks.completeOAuthCallback.mockRejectedValueOnce(new Error('boom'));
    const body = await (await call('git_connect_xyz')).text();
    expect(body).toContain('{family:"git",outcome:"error"}');
    expect(body).toContain('The git authorization did not complete');
  });

  it('a provider-side error and a missing code answer the same safe page — never success', async () => {
    mocks.completeOAuthCallback.mockRejectedValueOnce(new Error('refused'));
    const idpError = await callRaw('error=access_denied&error_description=user+said+no&state=mcp_client_abc');
    const idpBody = await idpError.text();
    expect(idpError.status).toBe(200);
    expect(idpBody).toContain('{family:"mcp",outcome:"error"}');
    expect(idpBody).not.toContain('access_denied');
    expect(idpBody).not.toContain('user said no');
    // Forwarded to the prefix's provider as `error`, never as a code to exchange.
    expect(mocks.completeOAuthCallback).toHaveBeenCalledWith({
      code: '',
      state: 'mcp_client_abc',
      sessionUserId: 'user-1',
      error: { code: 'access_denied', description: 'user said no' },
    });

    // Even a provider that ignored the error and resolved cannot turn it into success.
    const ignored = await (await callRaw('error=access_denied&state=mcp_client_abc')).text();
    expect(ignored).toContain('{family:"mcp",outcome:"error"}');
    expect(ignored).not.toContain('outcome:"success"');

    const noCode = await callRaw('state=git_connect_xyz');
    expect(noCode.status).toBe(200);
    expect(await noCode.text()).toContain('{family:"git",outcome:"error"}');
  });

  it('the page is the ONLY thing served — no redirect, no workspace query reader', async () => {
    const res = await call('mcp_client_abc');
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('a non-prefixed state is a NAMED 400 — never forwarded to the connectors route', async () => {
    const res = await call('totally-unknown-state');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'unknown_oauth_state' });
    // The dead legacy arm is gone: nothing is re-issued over HTTP, so there is
    // no 404 from a package route to mistake for a real flow failure.
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.completeOAuthCallback).not.toHaveBeenCalled();
  });

  it('a failing completion answers the fixed failure page, never the exception', async () => {
    mocks.completeOAuthCallback.mockRejectedValueOnce(new Error('no pending OAuth flow for this state'));
    const res = await call('mcp_client_expired');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('The MCP authorization did not complete');
    for (const needle of FORBIDDEN_IN_PAGE) expect(body, needle).not.toContain(needle);
    expect(body).not.toMatch(/gho_|ghu_|sk-|eyJ/);
  });

  it('an UNKNOWN oauth_success-shaped state is still a 400 — the page is prefix-bound', async () => {
    const res = await callRaw('code=c&state=channel_oauth_abc');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'unknown_oauth_state' });
  });
});

describe('GET /api/oauth/callback — a provider that answers with a workspace query', () => {
  it('success redirects to the FIXED /workspace path on the trusted origin', async () => {
    const res = await call('codex_abc');
    expect(mocks.completeWorkspaceFlow).toHaveBeenCalledWith({ code: 'the-code', state: 'codex_abc', sessionUserId: 'user-1' });
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin).toBe('http://localhost:3100');
    expect(location.pathname).toBe('/workspace');
    expect(location.searchParams.get('oauth_success')).toBe('codex');
  });

  it('the failure query rides the same redirect, values carried verbatim', async () => {
    mocks.completeWorkspaceFlow.mockResolvedValueOnce({
      family: 'codex',
      subject: '',
      workspaceQuery: {
        oauth_error_code: 'token_exchange_failed',
        oauth_error_description: 'the IdP said no',
        oauth_retry_with: 'reduced',
        oauth_target: 'project',
        oauth_project_id: 'p1',
      },
    });
    const location = new URL((await call('codex_abc')).headers.get('location')!);
    expect(location.pathname).toBe('/workspace');
    expect(Object.fromEntries(location.searchParams)).toEqual({
      oauth_error_code: 'token_exchange_failed',
      oauth_error_description: 'the IdP said no',
      oauth_retry_with: 'reduced',
      oauth_target: 'project',
      oauth_project_id: 'p1',
    });
  });

  it('a handler-supplied value can NEVER change the origin or the path', async () => {
    mocks.completeWorkspaceFlow.mockResolvedValueOnce({
      family: 'codex',
      subject: '',
      workspaceQuery: {
        next: 'https://evil.example.com/x',
        path: '//evil.example.com',
        '../admin': '/../../admin?x=1#frag',
        host: 'evil.example.com',
      },
    });
    const raw = (await call('codex_abc')).headers.get('location')!;
    const location = new URL(raw);
    expect(location.origin).toBe('http://localhost:3100');
    expect(location.pathname).toBe('/workspace');
    expect(location.hash).toBe('');
    expect(location.searchParams.get('next')).toBe('https://evil.example.com/x');
    expect(raw.startsWith('http://localhost:3100/workspace?')).toBe(true);
  });

  it('an IdP error is FORWARDED to the prefix\'s provider, which answers the banner query', async () => {
    mocks.completeWorkspaceFlow.mockResolvedValueOnce({
      family: 'codex',
      subject: '',
      workspaceQuery: { oauth_error_code: 'access_denied', oauth_retry_with: 'reduced' },
    });
    const res = await callRaw('error=access_denied&error_description=no&state=codex_abc');
    expect(mocks.completeWorkspaceFlow).toHaveBeenCalledWith({
      code: '',
      state: 'codex_abc',
      sessionUserId: 'user-1',
      error: { code: 'access_denied', description: 'no' },
    });
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/workspace');
    expect(location.searchParams.get('oauth_retry_with')).toBe('reduced');
  });

  it('a missing code on a declared prefix is forwarded as missing_params', async () => {
    await callRaw('state=codex_abc');
    expect(mocks.completeWorkspaceFlow).toHaveBeenCalledWith(
      expect.objectContaining({ code: '', state: 'codex_abc', error: expect.objectContaining({ code: 'missing_params' }) }),
    );
  });

  it('an undeclared prefix keeps the legacy workspace redirects for an IdP error / missing code', async () => {
    const idp = new URL((await callRaw('error=access_denied&state=nobody_abc')).headers.get('location')!);
    expect(idp.pathname).toBe('/workspace');
    expect(idp.searchParams.get('oauth_error')).toBe('access_denied');
    const missing = new URL((await callRaw('state=nobody_abc')).headers.get('location')!);
    expect(missing.searchParams.get('oauth_error')).toBe('missing_params');
    expect(mocks.completeWorkspaceFlow).not.toHaveBeenCalled();
    expect(mocks.completeOAuthCallback).not.toHaveBeenCalled();
  });

  it('a channel state is never dispatched here — its flow completes on its own route', async () => {
    const idp = await callRaw('error=access_denied&state=channel_oauth_abc');
    expect(idp.status).toBe(307);
    expect(new URL(idp.headers.get('location')!).searchParams.get('oauth_error')).toBe('access_denied');
    const withCode = await call('channel_oauth_abc');
    expect(withCode.status).toBe(400);
    expect(await withCode.json()).toMatchObject({ error: 'unknown_oauth_state' });
    expect(mocks.completeChannelFlow).not.toHaveBeenCalled();
  });
});
