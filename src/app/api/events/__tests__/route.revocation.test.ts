/**
 * `/api/events` closes a hub connection when the host revokes ITS principal.
 *
 * The hub authenticates once at open, so without this close a disabled,
 * deleted or removed user's connection would keep receiving signals for as long
 * as the browser holds it. The rows: the connection's own user (in its own
 * project, or user-wide) closes it; another user's revocation and the same
 * user's revocation in ANOTHER project leave it open (paired controls).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { RuntimeChannel } from '@neuralis/package-system/contracts';

const packageFeeds = vi.hoisted(() => ({ features: [] as string[], channels: [] as RuntimeChannel[], heartbeatMs: 25_000 }));

vi.mock('@/server/auth/resolveSessionContext', () => ({
  SessionResolutionError: class extends Error {
    status = 401;
  },
  resolveSessionContext: vi.fn(async () => ({
    userId: 'u1', projectId: 'p1', role: 'member', priority: 20, grantedFeatures: packageFeeds.features,
  })),
}));
vi.mock('@/server/host/bootstrap', () => ({
  getRuntime: async () => ({ whenReady: async () => {}, channels: () => packageFeeds.channels }),
}));
vi.mock('@/server/packages/runtime', () => ({
  ensureCommunityRuntime: async () => {},
  getCommunityPackageRuntime: () => ({ getRevision: () => 1, onInvalidation: () => () => {} }),
}));
vi.mock('@/server/packages/projectPackages', () => ({ ensureProjectPackagesLoaded: async () => {} }));
vi.mock('@/server/store/PlatformConfigStore', () => ({ getPlatformConfigStore: () => ({ get: () => packageFeeds.heartbeatMs }) }));


import { GET } from '../route';
import { revokePrincipal, resetPrincipalRevocationForTests } from '@/server/host/principalRevocation';
import { listPresence, resetPresenceRegistryForTests } from '@/server/presence/clientRegistry';

afterEach(() => {
  resetPresenceRegistryForTests();
  resetPrincipalRevocationForTests();
  packageFeeds.features = [];
  packageFeeds.channels = [];
  packageFeeds.heartbeatMs = 25_000;
});

async function openHub(): Promise<{ closed: () => boolean }> {
  const res = await GET(new NextRequest('http://localhost/api/events?projectId=p1'));
  const reader = res.body!.getReader();
  let done = false;
  void (async () => {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
        return;
      }
    }
  })();
  // Let `start()` register its subscriptions.
  await new Promise((r) => setTimeout(r, 10));
  return { closed: () => done };
}

const noFanOut = async (): Promise<void> => {};

describe('/api/events — principal revocation closes the connection', () => {
  it("another user's revocation and the same user's revocation in ANOTHER project leave it open", async () => {
    const hub = await openHub();
    await revokePrincipal({ userId: 'u2', reason: 'disabled' }, noFanOut);
    await revokePrincipal({ userId: 'u1', projectId: 'p-other', reason: 'membership_removed' }, noFanOut);
    await new Promise((r) => setTimeout(r, 10));
    expect(hub.closed()).toBe(false);
  });

  it('its own project-scoped revocation closes it', async () => {
    const hub = await openHub();
    await revokePrincipal({ userId: 'u1', projectId: 'p1', reason: 'membership_removed' }, noFanOut);
    await vi.waitFor(() => expect(hub.closed()).toBe(true));
  });

  it('a user-wide revocation closes it', async () => {
    const hub = await openHub();
    await revokePrincipal({ userId: 'u1', reason: 'sessions_reset' }, noFanOut);
    await vi.waitFor(() => expect(hub.closed()).toBe(true));
  });
});


describe('/api/events — the connection is a presence client until the same close', () => {
  const self = { userId: 'u1', projectId: 'p1', agentId: 'a1', grantedFeatures: [] as string[] };
  const online = (): boolean | undefined => listPresence(self, { scope: 'project', memberIds: new Set(['u1']) })[0]?.online;

  it('online while open; the revocation that closes the hub drops the entry with it', async () => {
    const hub = await openHub();
    expect(online()).toBe(true);
    await revokePrincipal({ userId: 'u1', projectId: 'p1', reason: 'membership_removed' }, noFanOut);
    await vi.waitFor(() => expect(hub.closed()).toBe(true));
    expect(online()).toBe(false);
  });
});

describe('/api/events — declared package channel entry gates', () => {
  it('gates all four feeds before subscription, passes verified coordinates, and disposes on archive', async () => {
    const names = ['presence', 'workflow', 'conversation', 'filesystem'];
    const subscriptions = names.map(() => vi.fn(async () => vi.fn()));
    packageFeeds.channels = names.map((channel, index) => ({
      packageId: 'test-provider', channel, feature: `feed.${channel}`, subscribe: subscriptions[index],
    }));
    packageFeeds.features = ['feed.workflow'];
    const hub = await openHub();
    expect(subscriptions.map((subscribe) => subscribe.mock.calls.length)).toEqual([0, 1, 0, 0]);
    expect(subscriptions[1]).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', projectId: 'p1' }),
      { projectId: 'p1', agentIds: [], types: [] }, expect.any(Function),
    );
    await revokePrincipal({ userId: 'u1', projectId: 'p1', reason: 'project_archived' }, noFanOut);
    await vi.waitFor(() => expect(hub.closed()).toBe(true));
    expect(await subscriptions[1].mock.results[0].value).toHaveBeenCalledOnce();
  });

  it('wildcard features retain all four package subscriptions', async () => {
    const subscriptions = ['presence', 'workflow', 'conversation', 'filesystem'].map((channel) => ({
      packageId: 'test-provider', channel, feature: `feed.${channel}`, subscribe: vi.fn(async () => vi.fn()),
    }));
    packageFeeds.features = ['*'];
    packageFeeds.channels = subscriptions;
    await openHub();
    for (const channel of subscriptions) expect(channel.subscribe).toHaveBeenCalledOnce();
    await revokePrincipal({ userId: 'u1', reason: 'sessions_reset' }, noFanOut);
    for (const channel of subscriptions) expect(await channel.subscribe.mock.results[0].value).toHaveBeenCalledOnce();
  });
});

describe('/api/events — the keepalive is a frame an EventSource DISPATCHES', () => {
  // An SSE comment line (`: …`) dispatches no event in a browser, so the
  // client watchdog (60 s without a frame ⇒ dead) reopened every idle hub and
  // each reopen re-read every held transcript. The keepalive is a `meta` frame.
  it('an idle hub sends `{channel:"meta", name:"keepalive"}` data frames on the heartbeat, and no comment line', async () => {
    packageFeeds.heartbeatMs = 20;
    const res = await GET(new NextRequest('http://localhost/api/events?projectId=p1'));
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const pump = (async () => {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        text += decoder.decode(chunk.value, { stream: true });
      }
    })();
    await vi.waitFor(() => expect(text.split('"keepalive"').length - 1).toBeGreaterThanOrEqual(2));
    await revokePrincipal({ userId: 'u1', reason: 'sessions_reset' }, noFanOut);
    await pump;
    const blocks = text.split('\n\n').filter(Boolean);
    const frames = blocks.map((block) => {
      const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
      return data ? (JSON.parse(data) as { channel: string; name: string }) : null;
    });
    expect(frames.every((frame) => frame !== null)).toBe(true);
    expect(frames.filter((f) => f?.channel === 'meta' && f.name === 'keepalive').length).toBeGreaterThanOrEqual(2);
    expect(blocks.every((block) => block.startsWith('event: message\n'))).toBe(true);
  });
});
