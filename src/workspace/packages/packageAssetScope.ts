'use client';

/**
 * packageAssetScope — the TAB-LOCAL, refcounted client of the identity-free
 * package asset scope (CARD1 3A).
 *
 * One scope per `(projectId, agentId, packageId, surfaceKind, surfaceId,
 * fingerprint)` coordinate is minted and REUSED across consumers (multiple
 * cards of one type, widget re-renders): concurrent `acquire()` calls share a
 * single in-flight mint, the returned scoped URL is STABLE for the whole
 * document generation, a 60 s heartbeat keeps the server scope alive while
 * any consumer holds a reference, and the LAST release sends a best-effort
 * close (`DELETE`). A heartbeat 403/410 REVOKES the generation: every
 * consumer's `onRevoked` fires, the cached state drops, and the next
 * `acquire()` mints a fresh document generation.
 *
 * The handle shape matches agent-core's `ScopedAssetHandle` factory contract
 * (`IframeCardConfig.source: { kind: 'scoped-asset', acquire }`) — the
 * card hydrator (run by the card-owning package's `workspace.provider` fill,
 * which receives `workspaceAssetScope` below) and `IframeWidget` share this
 * module. The mint POST is host-only (cookie session + `x-project-id` /
 * `x-agent-id` headers); the NAVIGATED url and every subresource request
 * carry NO identity — no token or project ever enters a query string.
 */

export const ASSET_SCOPE_HEARTBEAT_MS = 60_000;

/**
 * The ONE client-side classifier for a snapshot surface url (CARD1 3C) —
 * shared by the widget renderer strategy and the card reconcile so the two
 * render paths can never drift apart.
 *
 * `true` = ASSET-BACKED: the value is either still relative or already the
 * host-internal LOGICAL descriptor `/api/packages/{packageId}/app/…` that the
 * snapshot rewrote it to. Neither is ever navigated — the client mints an
 * opaque asset scope from the COORDINATE and navigates the identity-free
 * `/api/package-app/_scope/{handle}/surface/…` url instead.
 *
 * `false` = a genuinely REMOTE absolute url, passed through as-is. Only
 * trusted/first-party packages reach this branch: the snapshot drops an
 * untrusted absolute surface fail-closed.
 *
 * DELIBERATE DIVERGENCE — the absolute test below restates the kernel's
 * `isAbsoluteAssetUrl` (`@neuralis/package-system/validation/surfaceLayout.ts`),
 * which is the SOURCE of the rule; every server-side caller imports it. This
 * client copy exists only because the `validation` subpath would pull AJV into
 * the browser bundle and there is no `surfaceLayout`-only export subpath. If
 * the kernel predicate widens, widen this line in the SAME commit.
 */
export function isAssetBackedSurfaceUrl(url: string): boolean {
  if (url.startsWith('/api/packages/')) return true;
  // Mirrors kernel `isAbsoluteAssetUrl` — see the divergence note above.
  return !(/^(https?:)?\/\//i.test(url) || url.startsWith('/'));
}

export type AssetScopeCoordinate = {
  projectId: string;
  agentId?: string;
  packageId: string;
  surfaceKind: 'widget' | 'card';
  surfaceId: string;
  /**
   * Client-side declaration fingerprint (renderer/url/bridge digest) — a
   * refcount/cache COORDINATE only, no authority; the server computes its own.
   */
  fingerprint: string;
};

export type PackageAssetScopeHandle = {
  /** Scoped, identity-free URL — stable for this document generation. */
  url: string;
  /** Idempotent release; the LAST release sends a best-effort close. */
  release(): void;
  /** Revocation signal (heartbeat 403/410). Returns the unsubscribe. */
  onRevoked(cb: () => void): () => void;
};

type ScopeState = {
  handle: string;
  url: string;
};

type ScopeEntry = {
  refCount: number;
  /** Monotonic document generation — bumps on every revoke/remint. */
  generation: number;
  inFlight: Promise<ScopeState> | null;
  state: ScopeState | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  revokedCallbacks: Set<() => void>;
};

const entries = new Map<string, ScopeEntry>();

function coordKey(coord: AssetScopeCoordinate): string {
  return JSON.stringify([
    coord.projectId,
    coord.agentId ?? null,
    coord.packageId,
    coord.surfaceKind,
    coord.surfaceId,
    coord.fingerprint,
  ]);
}

function mintHeaders(coord: AssetScopeCoordinate): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-project-id': coord.projectId,
  };
  if (coord.agentId) headers['x-agent-id'] = coord.agentId;
  return headers;
}

async function mintScope(coord: AssetScopeCoordinate): Promise<ScopeState> {
  const res = await fetch(`/api/packages/${encodeURIComponent(coord.packageId)}/app-scope`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: mintHeaders(coord),
    body: JSON.stringify({
      projectId: coord.projectId,
      surfaceKind: coord.surfaceKind,
      surfaceId: coord.surfaceId,
      rendererFingerprint: coord.fingerprint,
    }),
  });
  if (!res.ok) {
    throw new Error(`asset scope mint failed (${res.status})`);
  }
  const body = (await res.json()) as { handle?: string; url?: string };
  if (!body.handle || !body.url) {
    throw new Error('asset scope mint returned no handle');
  }
  return { handle: body.handle, url: body.url };
}

function revokeEntry(key: string, entry: ScopeEntry): void {
  entry.generation += 1;
  entry.state = null;
  entry.inFlight = null;
  stopHeartbeat(entry);
  const callbacks = [...entry.revokedCallbacks];
  entry.revokedCallbacks.clear();
  if (entry.refCount <= 0) entries.delete(key);
  for (const cb of callbacks) {
    try {
      cb();
    } catch {
      // consumer callbacks are best-effort
    }
  }
}

function startHeartbeat(key: string, coord: AssetScopeCoordinate, entry: ScopeEntry): void {
  if (entry.heartbeatTimer) return;
  entry.heartbeatTimer = setInterval(() => {
    const state = entry.state;
    if (!state) return;
    void fetch(`/api/packages/${encodeURIComponent(coord.packageId)}/app-scope`, {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: mintHeaders(coord),
      body: JSON.stringify({ handle: state.handle }),
    })
      .then((res) => {
        if (res.status === 403 || res.status === 410) {
          // Access loss / package update / restart — new document generation.
          if (entry.state === state) revokeEntry(key, entry);
        }
      })
      .catch(() => {
        // Transient network failure — the server-owned idle expiry converges.
      });
  }, ASSET_SCOPE_HEARTBEAT_MS);
}

function stopHeartbeat(entry: ScopeEntry): void {
  if (entry.heartbeatTimer) {
    clearInterval(entry.heartbeatTimer);
    entry.heartbeatTimer = null;
  }
}

function closeScope(coord: AssetScopeCoordinate, state: ScopeState): void {
  // Best-effort — the server-owned idle expiry is the mandatory convergence.
  void fetch(`/api/packages/${encodeURIComponent(coord.packageId)}/app-scope`, {
    method: 'DELETE',
    credentials: 'same-origin',
    keepalive: true,
    headers: mintHeaders(coord),
    body: JSON.stringify({ handle: state.handle }),
  }).catch(() => {});
}

/**
 * Acquire a refcounted scope for the coordinate. Resolves once the scoped URL
 * is available; rejects when the mint is denied (the consumer keeps its
 * placeholder). The returned handle's `release()` is idempotent.
 */
export async function acquirePackageAssetScope(
  coord: AssetScopeCoordinate,
): Promise<PackageAssetScopeHandle> {
  const key = coordKey(coord);
  let entry = entries.get(key);
  if (!entry) {
    entry = {
      refCount: 0,
      generation: 0,
      inFlight: null,
      state: null,
      heartbeatTimer: null,
      revokedCallbacks: new Set(),
    };
    entries.set(key, entry);
  }
  entry.refCount += 1;
  const generationAtAcquire = entry.generation;

  if (!entry.state && !entry.inFlight) {
    entry.inFlight = mintScope(coord)
      .then((state) => {
        // A revoke while minting starts a fresh generation — drop stale wins.
        if (entry!.generation === generationAtAcquire) {
          entry!.state = state;
          entry!.inFlight = null;
          startHeartbeat(key, coord, entry!);
        }
        return state;
      })
      .catch((err) => {
        if (entry!.generation === generationAtAcquire) entry!.inFlight = null;
        throw err;
      });
  }

  let state: ScopeState;
  try {
    state = entry.state ?? (await entry.inFlight!);
  } catch (err) {
    releaseRef(key, coord);
    throw err;
  }

  let released = false;
  return {
    url: state.url,
    release: () => {
      if (released) return;
      released = true;
      releaseRef(key, coord);
    },
    onRevoked: (cb: () => void) => {
      const live = entries.get(key);
      // A handle from an already-revoked generation notifies immediately on
      // next tick semantics being overkill here — the consumer re-acquires.
      if (!live || live.generation !== generationAtAcquire) {
        cb();
        return () => {};
      }
      live.revokedCallbacks.add(cb);
      return () => {
        entries.get(key)?.revokedCallbacks.delete(cb);
      };
    },
  };
}

function releaseRef(key: string, coord: AssetScopeCoordinate): void {
  const entry = entries.get(key);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount > 0) return;
  const state = entry.state;
  stopHeartbeat(entry);
  entries.delete(key);
  if (state) closeScope(coord, state);
}

/** Test-only: drop every cached entry/timer (never used in production code). */
export function __resetPackageAssetScopeForTests(): void {
  for (const entry of entries.values()) stopHeartbeat(entry);
  entries.clear();
}

/**
 * The ONE asset-scope client handed to package code (every `workspace.provider`
 * fill gets this object): the same refcount/heartbeat state the widgets use,
 * never a second copy. Module-level, so its identity is stable — a consumer
 * uses it as an effect dependency.
 */
export const workspaceAssetScope = Object.freeze({
  isAssetBacked: isAssetBackedSurfaceUrl,
  acquire: acquirePackageAssetScope,
});
