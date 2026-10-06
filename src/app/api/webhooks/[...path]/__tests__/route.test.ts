/**
 * The webhook ingress route — what the host hands the `channel-gateway`
 * provider, and what it keeps for itself.
 *
 * The host names no surface: every segment after `/api/webhooks/` goes to
 * `handleIngress` verbatim (a 4th segment included — the PROVIDER's grammar
 * decides it is a 404), with the lower-cased headers, the query, the RAW
 * bytes (never parsed here: a parse in front of the provider's verification
 * would be an unauthenticated cost on a public ingress) and the client's abort
 * signal. The answer goes back verbatim, a text answer as `text/plain`.
 *
 * What the host keeps: the per-IP rate limit in FRONT of everything (a 429 with
 * no provider call), the 503 until a provider mounts, and a 404 for an empty
 * path. The grammar rows (bearer, `?wait=`, exact segment counts) live with the
 * grammar, in agent-core's `channelIngress.test.ts`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { ChannelGatewayResponse, ChannelIngressRequest } from '@neuralis/package-system/contracts';

const mocks = vi.hoisted(() => ({
  handleIngress: vi.fn(
    async (_req: ChannelIngressRequest): Promise<ChannelGatewayResponse> => ({ status: 202, body: { ok: true, runId: 'run-1' } }),
  ),
  mounted: true,
  rateLimit: 60,
}));

vi.mock('@/server/store/PlatformConfigStore', () => ({
  getPlatformConfigStore: () => ({
    get: (key: string) => (key === 'webhookRateLimitPerMinute' ? mocks.rateLimit : undefined),
  }),
}));
// No trusted proxy is declared — the default topology.
vi.mock('@/server/config/env', () => ({ getEnv: () => ({ trustedProxies: [] }) }));
vi.mock('@/server/host/bootstrap', () => ({
  getRuntime: async () => ({
    whenReady: async () => {},
    services: {
      get: () => (mocks.mounted ? { listChannelDescriptors: () => [], handleIngress: mocks.handleIngress } : undefined),
    },
  }),
}));

import { GET, POST } from '../route';

function post(path: string, body: string, opts: { headers?: Record<string, string>; query?: string } = {}): NextRequest {
  return new NextRequest(`http://localhost/api/webhooks/${path}${opts.query ?? ''}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body,
  });
}

const params = (path: string[]) => Promise.resolve({ path });

beforeEach(() => {
  mocks.rateLimit = 60;
  mocks.mounted = true;
  mocks.handleIngress.mockClear();
});

describe('the ingress forwards, the provider decides', () => {
  it('hands over the path, the RAW bytes, lower-cased headers, the query and the abort signal — unparsed', async () => {
    // Deliberately NOT canonical JSON: whitespace and key order survive only if
    // the bytes are passed through, which is what a signature check needs.
    const raw = '{  "event" :  "deploy.finished",\n  "id": "evt-1" }';
    const res = await POST(
      post('workflow/wf-1/fire', raw, { headers: { Authorization: 'Bearer wfk1.wf-1.s', 'X-Event-Id': 'evt-9' }, query: '?wait=12' }),
      { params: params(['workflow', 'wf-1', 'fire']) },
    );
    expect(res.status).toBe(202);
    const req = mocks.handleIngress.mock.calls[0]![0];
    expect(req.method).toBe('POST');
    expect(req.path).toEqual(['workflow', 'wf-1', 'fire']);
    expect(req.rawBody).toBe(raw);
    expect(req).not.toHaveProperty('body');
    expect(req.headers.authorization).toBe('Bearer wfk1.wf-1.s');
    expect(req.headers['x-event-id']).toBe('evt-9');
    expect(req.query).toEqual({ wait: '12' });
    expect(req.signal).toBeInstanceOf(AbortSignal);
  });

  it('names no surface: an unknown surface and a 4th segment are forwarded verbatim, never answered here', async () => {
    mocks.handleIngress.mockResolvedValueOnce({ status: 404, body: { error: 'Not found' } });
    const res = await POST(post('workflow/wf-1/fire/extra', '{}'), { params: params(['workflow', 'wf-1', 'fire', 'extra']) });
    expect(res.status).toBe(404);
    await POST(post('github/x', 'not json'), { params: params(['github', 'x']) });
    expect(mocks.handleIngress.mock.calls.map(([r]) => r.path)).toEqual([
      ['workflow', 'wf-1', 'fire', 'extra'],
      ['github', 'x'],
    ]);
    expect(mocks.handleIngress.mock.calls[1]![0].rawBody).toBe('not json');
  });

  it("answers the provider's status and body verbatim, and a text answer as text/plain", async () => {
    mocks.handleIngress.mockResolvedValueOnce({ status: 413, body: { error: 'Request body is larger than this endpoint accepts.' } });
    const tooBig = await POST(post('workflow/wf-1/fire', '{}'), { params: params(['workflow', 'wf-1', 'fire']) });
    expect(tooBig.status).toBe(413);
    expect(await tooBig.json()).toEqual({ error: 'Request body is larger than this endpoint accepts.' });

    mocks.handleIngress.mockResolvedValueOnce({ status: 200, body: '4242', isText: true });
    const handshake = await GET(
      new NextRequest('http://localhost/api/webhooks/channels/conn-1?hub.mode=subscribe&hub.challenge=4242'),
      { params: params(['channels', 'conn-1']) },
    );
    expect(handshake.status).toBe(200);
    expect(handshake.headers.get('content-type')).toBe('text/plain');
    expect(await handshake.text()).toBe('4242');
    const getReq = mocks.handleIngress.mock.calls[1]![0];
    expect(getReq.method).toBe('GET');
    expect(getReq.rawBody).toBe('');
    expect(getReq.query).toEqual({ 'hub.mode': 'subscribe', 'hub.challenge': '4242' });
  });
});

describe('what the host keeps', () => {
  it('an empty path is 404 and the provider is never asked', async () => {
    const res = await POST(post('', '{}'), { params: params([]) });
    expect(res.status).toBe(404);
    expect(mocks.handleIngress).not.toHaveBeenCalled();
  });

  it('503 with a stable code until a provider mounts', async () => {
    mocks.mounted = false;
    const res = await POST(post('channels/conn-1', '{}'), { params: params(['channels', 'conn-1']) });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Channel gateway not mounted', code: 'channel_gateway_unmounted' });
  });
});

describe('the per-IP limiter stays in front of everything', () => {
  // `x-neuralis-peer` is what the ingress stamp writes from the socket (and
  // deletes on the way in); no trusted proxy is declared here, so the peer IS
  // the key and every forwarding header is the caller's own text.
  it('a flooded IP gets 429 and the gateway is never asked', async () => {
    mocks.rateLimit = 1;
    const headers = { 'x-neuralis-peer': '203.0.113.77' };
    await POST(post('workflow/wf-1/fire', '{}', { headers }), { params: params(['workflow', 'wf-1', 'fire']) });
    mocks.handleIngress.mockClear();
    const res = await POST(post('workflow/wf-1/fire', '{}', { headers }), {
      params: params(['workflow', 'wf-1', 'fire']),
    });
    expect(res.status).toBe(429);
    expect(mocks.handleIngress).not.toHaveBeenCalled();
  });

  it('a ROTATED X-Forwarded-For from the same peer is the same bucket (the old leftmost-XFF key minted a new one per request)', async () => {
    mocks.rateLimit = 1;
    const peer = { 'x-neuralis-peer': '203.0.113.88' };
    await POST(post('workflow/wf-1/fire', '{}', { headers: { ...peer, 'x-forwarded-for': '198.51.100.1' } }), { params: params(['workflow', 'wf-1', 'fire']) });
    mocks.handleIngress.mockClear();
    const res = await POST(post('workflow/wf-1/fire', '{}', { headers: { ...peer, 'x-forwarded-for': '198.51.100.2' } }), {
      params: params(['workflow', 'wf-1', 'fire']),
    });
    expect(res.status).toBe(429);
    expect(mocks.handleIngress).not.toHaveBeenCalled();
  });

  it('paired control: a DIFFERENT peer has its own bucket', async () => {
    mocks.rateLimit = 1;
    await POST(post('workflow/wf-1/fire', '{}', { headers: { 'x-neuralis-peer': '203.0.113.90' } }), { params: params(['workflow', 'wf-1', 'fire']) });
    const res = await POST(post('workflow/wf-1/fire', '{}', { headers: { 'x-neuralis-peer': '203.0.113.91' } }), {
      params: params(['workflow', 'wf-1', 'fire']),
    });
    expect(res.status).not.toBe(429);
  });
});
