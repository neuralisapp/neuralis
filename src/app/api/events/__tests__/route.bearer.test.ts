/**
 * `/api/events` as an external client's live feed: the route asks the session
 * resolver for its bearer arm (`acceptBearer`), forwards a refusal's challenge
 * header, binds the connection to the RESOLVED (token's) project, CLOSES the
 * stream when the access token expires, and `?channels=` narrows the
 * connection — an intersection, never an addition.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { RuntimeChannel } from '@neuralis/package-system/contracts';

const hub = vi.hoisted(() => ({
  channels: [] as RuntimeChannel[],
  expiresAt: undefined as number | undefined,
  options: [] as unknown[],
  refuse: null as null | { status: number; headers?: Record<string, string> },
  features: ['*'] as string[],
}));

vi.mock('@/server/auth/resolveSessionContext', () => {
  class SessionResolutionError extends Error {
    constructor(public readonly status: number, message: string, public readonly headers?: Record<string, string>) {
      super(message);
    }
  }
  return {
    SessionResolutionError,
    resolveSessionContext: vi.fn(async (_req: unknown, _projectId: string, options: { onBearer?: (g: unknown) => void }) => {
      hub.options.push(options);
      if (hub.refuse) throw new SessionResolutionError(hub.refuse.status, 'refused', hub.refuse.headers);
      if (hub.expiresAt !== undefined) options.onBearer?.({ clientId: 'neuralis-cli', scope: 'routes:call', expiresAt: hub.expiresAt });
      // The bearer arm's project is the TOKEN's, whatever the query said.
      return { userId: 'u1', projectId: 'p-token', role: 'member', priority: 20, grantedFeatures: hub.features };
    }),
  };
});
vi.mock('@/server/host/bootstrap', () => ({
  getRuntime: async () => ({ whenReady: async () => {}, channels: () => hub.channels }),
}));
vi.mock('@/server/packages/runtime', () => ({
  ensureCommunityRuntime: async () => {},
  getCommunityPackageRuntime: () => ({ getRevision: () => 1, onInvalidation: () => () => {} }),
}));
vi.mock('@/server/packages/projectPackages', () => ({ ensureProjectPackagesLoaded: async () => {} }));
vi.mock('@/server/store/PlatformConfigStore', () => ({ getPlatformConfigStore: () => ({ get: () => 25_000 }) }));

import { GET } from '../route';

type Frame = { channel: string; name: string; payload: unknown };

async function openHub(query: string): Promise<{ res: Response; frames: Frame[]; closed: () => boolean; cancel: () => void }> {
  const res = await GET(new NextRequest(`http://localhost/api/events${query}`, { headers: { authorization: 'Bearer eyJ.jwt' } }));
  const frames: Frame[] = [];
  let done = false;
  if (!res.body) return { res, frames, closed: () => true, cancel: () => {} };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    for (;;) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (chunk.done) { done = true; return; }
      buffer += decoder.decode(chunk.value as Uint8Array);
      let cut: number;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const data = block.split('\n').find((line) => line.startsWith('data: '));
        if (data) frames.push(JSON.parse(data.slice(6)) as Frame);
      }
    }
  })();
  await new Promise((r) => setTimeout(r, 10));
  return { res, frames, closed: () => done, cancel: () => void reader.cancel() };
}

const opened: Array<{ cancel: () => void }> = [];
afterEach(() => {
  for (const h of opened.splice(0)) h.cancel();
  hub.channels = [];
  hub.expiresAt = undefined;
  hub.options.length = 0;
  hub.refuse = null;
  hub.features = ['*'];
});

function feeds(...names: string[]) {
  const subs = names.map((channel) => ({ packageId: 'p', channel, feature: 'core.agents', subscribe: vi.fn(async () => vi.fn()) }));
  hub.channels = subs as unknown as RuntimeChannel[];
  return subs;
}

describe('/api/events — the bearer feed', () => {
  it('asks for the bearer arm, binds the channels to the token\'s project', async () => {
    const [devices] = feeds('devices');
    const h = await openHub('?projectId=p-query');
    opened.push(h);
    expect(hub.options[0]).toMatchObject({ acceptBearer: true });
    expect(devices!.subscribe).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p-token' }), { projectId: 'p-token', agentIds: [], types: [] }, expect.any(Function));
  });

  it('a refusal answers its status AND its challenge header, before any stream', async () => {
    hub.refuse = { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="neuralis", error="invalid_token"' } };
    const res = await GET(new NextRequest('http://localhost/api/events'));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('invalid_token');
  });

  it('the stream closes when the access token expires (and stays open while it is valid — paired)', async () => {
    hub.expiresAt = Date.now() + 80;
    const expiring = await openHub('');
    opened.push(expiring);
    hub.expiresAt = Date.now() + 60_000;
    const valid = await openHub('');
    opened.push(valid);
    await vi.waitFor(() => expect(expiring.closed()).toBe(true), { timeout: 2_000 });
    expect(valid.closed()).toBe(false);
  });

  it('?channels= narrows: only the named channel subscribes, no runtime/project/notifications feed', async () => {
    const [devices, presence] = feeds('devices', 'presence');
    const h = await openHub('?channels=devices');
    opened.push(h);
    expect(devices!.subscribe).toHaveBeenCalledOnce();
    expect(presence!.subscribe).not.toHaveBeenCalled();
    expect(h.frames.map((f) => f.channel)).toEqual(['meta']);
  });

  it('?channels= never ADDS a channel the caller\'s gates refuse — and absent, every channel rides (paired)', async () => {
    hub.features = ['core.agents'];
    const [devices] = feeds('devices');
    (devices as { feature: string }).feature = 'feature.nobody.holds';
    const h = await openHub('?channels=devices');
    opened.push(h);
    expect(devices!.subscribe).not.toHaveBeenCalled();
    hub.features = ['*'];
    const [a, b] = feeds('devices', 'presence');
    const all = await openHub('');
    opened.push(all);
    expect(a!.subscribe).toHaveBeenCalledOnce();
    expect(b!.subscribe).toHaveBeenCalledOnce();
    expect(all.frames.map((f) => f.channel)).toContain('runtime');
  });
});
