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

const packageFeeds = vi.hoisted(() => ({ features: [] as string[], channels: [] as RuntimeChannel[] }));

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
vi.mock('@/server/store/PlatformConfigStore', () => ({ getPlatformConfigStore: () => ({ get: () => 25_000 }) }));


import { GET } from '../route';
import { revokePrincipal, resetPrincipalRevocationForTests } from '@/server/host/principalRevocation';

afterEach(() => {
  resetPrincipalRevocationForTests();
  packageFeeds.features = [];
  packageFeeds.channels = [];
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
