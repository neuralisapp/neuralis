/**
 * PackageAppIcon — the lazy, visible-only lifecycle of a package's declared
 * app picture: ONE shared IntersectionObserver, a scope per VISIBLE coordinate
 * (never one per searchable app), shared leases across consumers, release on
 * offscreen/hide/unmount, a stale-mint release, the typed capacity refusal
 * settling to the glyph with no retry, and the dock projection's primitive
 * descriptor. Driven without a DOM: the observer is a fake and the effect body
 * is the exported lifecycle runner.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackageRuntimeSnapshot } from '@neuralis/package-system/contracts';
import { __resetPackageAssetScopeForTests } from '../packageAssetScope';
import {
  isRenderedVisible,
  observePackageAppIconVisibility,
  runPackageAppIconLifecycle,
} from '../PackageAppIcon';
import { buildPackageDockItems } from '../dockRuntime';

type Entry = { target: Element; isIntersecting: boolean };

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly observed = new Set<Element>();
  disconnected = false;
  constructor(readonly callback: (entries: Entry[]) => void) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(element: Element): void { this.observed.add(element); }
  unobserve(element: Element): void { this.observed.delete(element); }
  disconnect(): void { this.disconnected = true; this.observed.clear(); }
  fire(entries: Entry[]): void { this.callback(entries); }
}

function fakeElement(hiddenAncestor = false): Element {
  return { closest: () => (hiddenAncestor ? ({} as Element) : null) } as unknown as Element;
}

let fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let mintStatus = 200;
let heartbeatStatus = 200;
let mintCounter = 0;

beforeEach(() => {
  vi.useFakeTimers();
  fetchCalls = [];
  mintStatus = 200;
  heartbeatStatus = 200;
  mintCounter = 0;
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    fetchCalls.push({ url, init });
    if (init.method === 'POST') {
      if (mintStatus === 429) {
        return new Response(JSON.stringify({ error: 'Icon unavailable', code: 'icon_capacity' }), { status: 429 });
      }
      if (mintStatus !== 200) return new Response('{}', { status: mintStatus });
      mintCounter += 1;
      const body = JSON.parse(String(init.body)) as { surfaceId: string };
      return new Response(JSON.stringify({
        handle: `h${mintCounter}`,
        url: `/api/package-app/_scope/h${mintCounter}/shared/${body.surfaceId}.png`,
      }), { status: 200 });
    }
    if (init.method === 'PATCH') return new Response('{}', { status: heartbeatStatus });
    return new Response('{}', { status: 200 });
  }));
});

afterEach(() => {
  __resetPackageAssetScopeForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const mints = () => fetchCalls.filter((call) => call.init.method === 'POST');
const closes = () => fetchCalls.filter((call) => call.init.method === 'DELETE');
const patches = () => fetchCalls.filter((call) => call.init.method === 'PATCH');

/** One rendered tile: what the component does, without React. */
function mountTile(dockId: string, element: Element = fakeElement()) {
  const state = { url: null as string | null, revoked: 0, active: false };
  let cleanup: () => void = () => {};
  const run = () => {
    cleanup();
    cleanup = runPackageAppIconLifecycle({
      packageId: 'pkg',
      dockId,
      declaration: `app/shared/${dockId}.png`,
      projectId: 'proj-1',
      agentId: 'agent-1',
      active: state.active,
      setUrl: (url) => { state.url = url; },
      // The component bumps its generation, which re-runs the effect.
      onRevoked: () => { state.revoked += 1; run(); },
    });
  };
  const stopObserving = observePackageAppIconVisibility(element, (visible) => {
    if (visible === state.active) return;
    state.active = visible;
    run();
  });
  run();
  return { state, element, unmount: () => { stopObserving(); cleanup(); } };
}

describe('the ONE shared visibility observer', () => {
  it('more than 128 searchable apps acquire ONLY the visible coordinates', async () => {
    const tiles = Array.from({ length: 200 }, (_, i) => mountTile(`app${i}`));
    expect(FakeIntersectionObserver.instances).toHaveLength(1);
    const observer = FakeIntersectionObserver.instances[0]!;
    expect(observer.observed.size).toBe(200);
    // Nothing is visible until the observer says so: no mint at mount.
    await vi.runAllTicks();
    expect(mints()).toHaveLength(0);

    observer.fire(tiles.map((tile, i) => ({ target: tile.element, isIntersecting: i < 12 })));
    await vi.waitFor(() => expect(tiles.slice(0, 12).every((tile) => tile.state.url)).toBe(true));
    expect(mints()).toHaveLength(12);
    expect(tiles.slice(12).every((tile) => tile.state.url === null)).toBe(true);
    for (const tile of tiles) tile.unmount();
    expect(observer.disconnected).toBe(true);
  });

  it('a tile inside a hidden/closed ancestor never acquires, though it intersects', async () => {
    const hidden = mountTile('hidden', fakeElement(true));
    const observer = FakeIntersectionObserver.instances[0]!;
    observer.fire([{ target: hidden.element, isIntersecting: true }]);
    await vi.runAllTicks();
    expect(mints()).toHaveLength(0);
    expect(isRenderedVisible(fakeElement(true))).toBe(false);
    expect(isRenderedVisible(fakeElement(false))).toBe(true);
    hidden.unmount();
  });

  it('going offscreen releases the lease (last ref closes); coming back mints a fresh one', async () => {
    const tile = mountTile('app');
    const observer = FakeIntersectionObserver.instances[0]!;
    observer.fire([{ target: tile.element, isIntersecting: true }]);
    await vi.waitFor(() => expect(tile.state.url).toBeTruthy());
    observer.fire([{ target: tile.element, isIntersecting: false }]);
    expect(tile.state.url).toBeNull();
    expect(closes()).toHaveLength(1);
    observer.fire([{ target: tile.element, isIntersecting: true }]);
    await vi.waitFor(() => expect(tile.state.url).toBeTruthy());
    expect(mints()).toHaveLength(2);
    tile.unmount();
    expect(closes()).toHaveLength(2);
  });
});

describe('the icon lease', () => {
  it('Dock + Menu + Inbox showing the same picture share ONE scope and ONE url', async () => {
    const consumers = [mountTile('calendar'), mountTile('calendar'), mountTile('calendar')];
    const observer = FakeIntersectionObserver.instances[0]!;
    observer.fire(consumers.map((tile) => ({ target: tile.element, isIntersecting: true })));
    await vi.waitFor(() => expect(consumers.every((tile) => tile.state.url)).toBe(true));
    expect(mints()).toHaveLength(1);
    expect(new Set(consumers.map((tile) => tile.state.url)).size).toBe(1);
    expect(JSON.parse(String(mints()[0]!.init.body))).toEqual({
      projectId: 'proj-1',
      purpose: 'icon',
      surfaceKind: 'dock',
      surfaceId: 'calendar',
      rendererFingerprint: 'app/shared/calendar.png',
    });
    consumers[0]!.unmount();
    consumers[1]!.unmount();
    expect(closes()).toHaveLength(0);
    consumers[2]!.unmount();
    expect(closes()).toHaveLength(1);
  });

  it('a mint that lands after unmount is released at once and never published', async () => {
    const tile = mountTile('late');
    const observer = FakeIntersectionObserver.instances[0]!;
    observer.fire([{ target: tile.element, isIntersecting: true }]);
    tile.unmount();
    await vi.waitFor(() => expect(closes()).toHaveLength(1));
    expect(tile.state.url).toBeNull();
  });

  it('the typed capacity refusal settles to the glyph with NO retry, NO heartbeat, NO timer', async () => {
    mintStatus = 429;
    const tile = mountTile('full');
    const observer = FakeIntersectionObserver.instances[0]!;
    observer.fire([{ target: tile.element, isIntersecting: true }]);
    await vi.waitFor(() => expect(mints()).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(mints()).toHaveLength(1);
    expect(patches()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(tile.state.revoked).toBe(0);
    expect(tile.state.url).toBeNull();
    tile.unmount();
  });

  it('a revocation drops the url and a still-visible consumer re-mints ONCE (retry on invalidation)', async () => {
    const tile = mountTile('revoked');
    const observer = FakeIntersectionObserver.instances[0]!;
    observer.fire([{ target: tile.element, isIntersecting: true }]);
    await vi.waitFor(() => expect(tile.state.url).toBeTruthy());
    const first = tile.state.url;
    heartbeatStatus = 410;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tile.state.revoked).toBe(1);
    await vi.waitFor(() => expect(tile.state.url).toBeTruthy());
    expect(tile.state.url).not.toBe(first);
    expect(mints()).toHaveLength(2);
    tile.unmount();
  });

  it('an incomplete coordinate (no project) never mints', async () => {
    const urls: Array<string | null> = [];
    const cleanup = runPackageAppIconLifecycle({
      packageId: 'pkg', dockId: 'd', declaration: 'app/shared/d.png', projectId: null, agentId: null,
      active: true, setUrl: (url) => urls.push(url), onRevoked: () => {},
    });
    await vi.runAllTicks();
    cleanup();
    expect(mints()).toHaveLength(0);
    expect(urls.every((url) => url === null)).toBe(true);
  });
});

describe('dock projection — the primitive image descriptor', () => {
  function snapshotWith(image?: string): PackageRuntimeSnapshot {
    return {
      packages: [],
      surfaces: [{
        kind: 'dock', id: 'pkg.dock', label: 'Pkg', icon: 'Package', packageId: 'pkg',
        ...(image ? { image } : {}),
        action: { type: 'open-widget', widget: 'pkg-widget' },
      }],
    } as unknown as PackageRuntimeSnapshot;
  }

  it('a declared picture becomes a frozen primitive descriptor; the glyph stays', () => {
    const [item] = buildPackageDockItems(snapshotWith('app/shared/icon.png'));
    expect(item?.icon).toBe('Package');
    expect(item?.image).toEqual({ packageId: 'pkg', dockId: 'pkg.dock', declaration: 'app/shared/icon.png' });
    expect(Object.isFrozen(item?.image)).toBe(true);
    expect(Object.values(item!.image!).every((value) => typeof value === 'string')).toBe(true);
  });

  it('no declaration → no descriptor', () => {
    const [item] = buildPackageDockItems(snapshotWith());
    expect(item?.image).toBeUndefined();
  });
});
