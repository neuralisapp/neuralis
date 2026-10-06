/**
 * packageAssetScope client (CARD1 3A) — refcounted per-coordinate reuse:
 * concurrent acquires share ONE mint, the scoped URL is stable within a
 * document generation, the last release sends a best-effort close, a
 * heartbeat 403/410 revokes + notifies + forces a fresh mint on the next
 * acquire, and no identity ever appears in a query string.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquirePackageAssetScope,
  __resetPackageAssetScopeForTests,
  ASSET_SCOPE_HEARTBEAT_MS,
  type AssetScopeCoordinate,
} from '../packageAssetScope';

const COORD: AssetScopeCoordinate = {
  projectId: 'proj-1',
  agentId: 'agent-1',
  packageId: 'example-package',
  surfaceKind: 'widget',
  surfaceId: 'example_workspace',
  fingerprint: 'fp-client-1',
};

type FetchCall = { url: string; init: RequestInit };

let fetchCalls: FetchCall[] = [];
let mintCounter = 0;
let heartbeatStatus = 200;

function installFetchMock() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      fetchCalls.push({ url, init });
      const method = init.method ?? 'GET';
      if (method === 'POST') {
        mintCounter += 1;
        return new Response(
          JSON.stringify({
            handle: `handle-${mintCounter}`,
            url: `/api/package-app/_scope/handle-${mintCounter}/surface/index.html`,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (method === 'PATCH') {
        return new Response(JSON.stringify({ ok: heartbeatStatus === 200 }), { status: heartbeatStatus });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  fetchCalls = [];
  mintCounter = 0;
  heartbeatStatus = 200;
  installFetchMock();
});

afterEach(() => {
  __resetPackageAssetScopeForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const mintsMade = () => fetchCalls.filter((c) => (c.init.method ?? 'GET') === 'POST');
const closesMade = () => fetchCalls.filter((c) => c.init.method === 'DELETE');

describe('acquirePackageAssetScope', () => {
  it('concurrent acquires share ONE mint and get the SAME stable URL', async () => {
    const [a, b] = await Promise.all([
      acquirePackageAssetScope(COORD),
      acquirePackageAssetScope(COORD),
    ]);
    expect(mintsMade()).toHaveLength(1);
    expect(a.url).toBe(b.url);
    // A later acquire reuses the live state without a new mint.
    const c = await acquirePackageAssetScope(COORD);
    expect(mintsMade()).toHaveLength(1);
    expect(c.url).toBe(a.url);
    a.release(); b.release(); c.release();
  });

  it('the scoped URL and every request carry NO identity query', async () => {
    const handle = await acquirePackageAssetScope(COORD);
    expect(handle.url).not.toContain('?');
    expect(handle.url).not.toContain('projectId');
    for (const call of fetchCalls) {
      expect(call.url).not.toContain('?');
      expect(call.url).not.toContain('projectId=');
    }
    handle.release();
  });

  it('distinct coordinates mint distinct scopes', async () => {
    const a = await acquirePackageAssetScope(COORD);
    const b = await acquirePackageAssetScope({ ...COORD, surfaceId: 'other_widget' });
    expect(mintsMade()).toHaveLength(2);
    expect(a.url).not.toBe(b.url);
    a.release(); b.release();
  });

  it('the LAST release sends one best-effort close; release is idempotent', async () => {
    const a = await acquirePackageAssetScope(COORD);
    const b = await acquirePackageAssetScope(COORD);
    a.release();
    a.release(); // idempotent
    expect(closesMade()).toHaveLength(0);
    b.release();
    expect(closesMade()).toHaveLength(1);
    const closeBody = JSON.parse(String(closesMade()[0].init.body));
    expect(closeBody.handle).toBe('handle-1');
  });

  it('heartbeats every 60 s while held; stops after the last release', async () => {
    const handle = await acquirePackageAssetScope(COORD);
    await vi.advanceTimersByTimeAsync(ASSET_SCOPE_HEARTBEAT_MS * 2 + 5);
    const patches = fetchCalls.filter((c) => c.init.method === 'PATCH');
    expect(patches.length).toBe(2);
    handle.release();
    await vi.advanceTimersByTimeAsync(ASSET_SCOPE_HEARTBEAT_MS * 2);
    expect(fetchCalls.filter((c) => c.init.method === 'PATCH').length).toBe(2);
  });

  it('heartbeat 410 revokes: notifies onRevoked and the next acquire re-mints', async () => {
    const handle = await acquirePackageAssetScope(COORD);
    const revoked = vi.fn();
    handle.onRevoked(revoked);

    heartbeatStatus = 410;
    await vi.advanceTimersByTimeAsync(ASSET_SCOPE_HEARTBEAT_MS + 5);
    expect(revoked).toHaveBeenCalledTimes(1);

    // Fresh document generation on the next acquire.
    heartbeatStatus = 200;
    const fresh = await acquirePackageAssetScope(COORD);
    expect(mintsMade()).toHaveLength(2);
    expect(fresh.url).toContain('handle-2');
    expect(fresh.url).not.toBe(handle.url);
    handle.release();
    fresh.release();
  });

  it('a revoked generation does NOT close the successor on release', async () => {
    const stale = await acquirePackageAssetScope(COORD);
    heartbeatStatus = 410;
    await vi.advanceTimersByTimeAsync(ASSET_SCOPE_HEARTBEAT_MS + 5);
    heartbeatStatus = 200;
    const fresh = await acquirePackageAssetScope(COORD);
    stale.release(); // stale generation release — must not close handle-2
    expect(closesMade()).toHaveLength(0);
    fresh.release();
    expect(closesMade()).toHaveLength(1);
    expect(JSON.parse(String(closesMade()[0].init.body)).handle).toBe('handle-2');
  });

  it('onRevoked on an already-revoked generation fires immediately', async () => {
    const handle = await acquirePackageAssetScope(COORD);
    heartbeatStatus = 410;
    await vi.advanceTimersByTimeAsync(ASSET_SCOPE_HEARTBEAT_MS + 5);
    const late = vi.fn();
    handle.onRevoked(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('a failed mint rejects, releases the ref and allows a retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Surface not available' }), { status: 404 })),
    );
    await expect(acquirePackageAssetScope(COORD)).rejects.toThrow(/mint failed/);

    installFetchMock();
    const handle = await acquirePackageAssetScope(COORD);
    expect(handle.url).toContain('handle-1');
    handle.release();
  });

  it('mint POST carries the coordinate headers/body (host-only, header scope)', async () => {
    const handle = await acquirePackageAssetScope(COORD);
    const mint = mintsMade()[0];
    const headers = mint.init.headers as Record<string, string>;
    expect(headers['x-project-id']).toBe('proj-1');
    expect(headers['x-agent-id']).toBe('agent-1');
    const body = JSON.parse(String(mint.init.body));
    expect(body).toMatchObject({
      projectId: 'proj-1',
      surfaceKind: 'widget',
      surfaceId: 'example_workspace',
      rendererFingerprint: 'fp-client-1',
    });
    handle.release();
  });
});
