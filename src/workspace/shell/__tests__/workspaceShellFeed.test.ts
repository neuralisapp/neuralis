/**
 * The notification badges' feed costs ONE counts read per page load:
 *  - everything below the package provider wrap REMOUNTS when a provider
 *    attaches at runtime (`wrapInWorkspaceProviders` puts a new element on
 *    top), and a persisted same-edge dock layout remounts both docks again
 *    after the first paint — so the ONE holder sits in `WorkspaceRoot`, above
 *    the wrap;
 *  - the last release unsubscribes one macrotask later, so a holder that does
 *    remount re-holds without a second read (the belt to the braces above).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ReactNode } from 'react';
import { installFakeDom } from './fakeDom';

const dom = installFakeDom();

const probe = vi.hoisted(() => ({ log: [] as string[] }));

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }));
vi.mock('../Dock', async () => {
  const { useEffect } = await import('react');
  // A mount witness in place of the real dock.
  function Dock({ dockId }: { dockId: string }) {
    useEffect(() => {
      probe.log.push(`mount ${dockId}`);
      return () => { probe.log.push(`unmount ${dockId}`); };
    }, [dockId]);
    return null;
  }
  return { Dock, triggerZoneClass: () => 'trigger' };
});
vi.mock('../useDockItems', () => ({ usePrimaryDockItems: () => [], useSecondaryDockItems: () => [] }));
vi.mock('../AnimatedUniverseBackground', () => ({ AnimatedUniverseBackground: () => null }));
vi.mock('../../theme/useTheme', () => ({ useTheme: () => ({ theme: { useUniverseBackground: false } }) }));

type HubSub = { channel: string };
const hub = vi.hoisted(() => ({ subs: [] as HubSub[], subscribed: 0 }));
vi.mock('../../realtime/eventHub', () => ({
  subscribeHub: (sub: HubSub) => {
    hub.subs.push(sub);
    hub.subscribed += 1;
    return () => { hub.subs = hub.subs.filter((s) => s !== sub); };
  },
  getHubConnected: () => true,
}));

const { createElement, act, useEffect } = await import('react');
const { createRoot } = await import('react-dom/client');
const { WorkspaceShell } = await import('../WorkspaceShell');
const { wrapInWorkspaceProviders } = await import('../../NeuralisHostProvider');
const { _resetNotificationsClient, useNotificationsFeed } = await import('../../notifications/notificationsClient');

const SAME_EDGE = JSON.stringify({
  primary: { dockId: 'primary', edge: 'left', align: 'start' },
  secondary: { dockId: 'secondary', edge: 'left', align: 'start' },
});

let countReads = 0;
let scopeAllReads = 0;
let root: ReturnType<typeof createRoot> | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0); }); });
  }
}

async function renderTree(element: ReturnType<typeof createElement>): Promise<void> {
  root ??= createRoot(dom.container as unknown as Element);
  await act(async () => { root!.render(element); });
  await settle();
}

/** Two package providers, as `workspace.provider` slot fills that attach at runtime. */
const ProviderA = ({ children }: { children?: ReactNode }) => createElement('div', { 'data-provider': 'a' }, children);
const ProviderB = ({ children }: { children?: ReactNode }) => createElement('div', { 'data-provider': 'b' }, children);

/** The subtree the wrap re-parents: a mount witness that may itself hold the feed (the shape to avoid). */
function Below({ holdsFeed }: { holdsFeed: boolean }) {
  useNotificationsFeed(holdsFeed ? 'p1' : null);
  useEffect(() => {
    probe.log.push('mount below');
    return () => { probe.log.push('unmount below'); };
  }, []);
  return null;
}

/** `WorkspaceRoot`'s shape: the holder (optionally) above the provider wrap. */
function RootLike({ fills, holderAbove, holdsBelow }: { fills: unknown[]; holderAbove: boolean; holdsBelow: boolean }) {
  useNotificationsFeed(holderAbove ? 'p1' : null);
  return createElement('div', null, wrapInWorkspaceProviders(fills, null, createElement(Below, { holdsFeed: holdsBelow })));
}

async function attachProvidersOneByOne(holderAbove: boolean, holdsBelow: boolean): Promise<void> {
  for (const fills of [[], [ProviderA], [ProviderA, ProviderB]]) {
    await renderTree(createElement(RootLike, { fills, holderAbove, holdsBelow }));
  }
}

beforeEach(() => {
  probe.log = [];
  hub.subs = [];
  hub.subscribed = 0;
  countReads = 0;
  scopeAllReads = 0;
  _resetNotificationsClient();
  window.localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/notifications/counts') countReads += 1;
    if (url === '/api/notifications/counts?scope=all') scopeAllReads += 1;
    return { ok: true, status: 200, json: async () => ({ projectId: 'p1', unread: { total: 0, byDock: {} } }) } as Response;
  }));
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  _resetNotificationsClient();
  vi.unstubAllGlobals();
});

describe('everything below the provider wrap remounts — the feed is held above it', () => {
  it('each provider that attaches at runtime remounts the subtree below the wrap (the remount class)', async () => {
    await attachProvidersOneByOne(false, false);
    expect(probe.log).toEqual(['mount below', 'unmount below', 'mount below', 'unmount below', 'mount below']);
  });

  it('the holder ABOVE the wrap reads the counts ONCE through two attaches, on one hub subscription', async () => {
    await attachProvidersOneByOne(true, false);
    expect(countReads).toBe(1);
    expect(hub.subscribed).toBe(1);
    // …and ONE `scope=all` read for the switcher button's dot.
    expect(scopeAllReads).toBe(1);
  });

  it('a holder BELOW the wrap still costs one read: its remount re-holds inside the deferred release', async () => {
    await attachProvidersOneByOne(false, true);
    expect(probe.log.filter((entry) => entry === 'mount below')).toHaveLength(3);
    expect(countReads).toBe(1);
    expect(scopeAllReads).toBe(1);
    expect(hub.subscribed).toBe(1);
  });

  it('a persisted same-edge layout remounts BOTH docks after the first paint (a second remount class below the wrap)', async () => {
    window.localStorage.setItem('neuralis:workspace:dockLayout', SAME_EDGE);
    await renderTree(createElement(WorkspaceShell, { snapshotReady: true, children: null }));
    expect(probe.log).toEqual([
      'mount primary', 'mount secondary',
      'unmount primary', 'unmount secondary',
      'mount primary', 'mount secondary',
    ]);
  });

  // TRIPWIRE: never hold the notifications feed below `NeuralisHostProvider` —
  // not in the shell, not in a dock. Every provider that attaches at runtime
  // remounts that whole subtree (rows above). This row fails the moment a
  // `useNotificationsFeed(` moves back down.
  it('WorkspaceRoot holds exactly one feed; the shell and the docks hold none (comment-stripped source)', () => {
    const source = (file: string): string =>
      readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
    expect(source('../../WorkspaceRoot.tsx').match(/useNotificationsFeed\(/g)).toHaveLength(1);
    expect(source('../WorkspaceShell.tsx').match(/useNotificationsFeed\(/g)).toBeNull();
    expect(source('../Dock.tsx').match(/useNotificationsFeed\(/g)).toBeNull();
  });
});
