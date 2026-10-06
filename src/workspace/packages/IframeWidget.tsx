'use client';

import { memo, useEffect, useState } from 'react';
import type { PackageTrust } from '@neuralis/package-system/contracts';
import { externalFrameProfile, OPAQUE_FRAME_SANDBOX } from '@neuralis/package-system/client';
import { useWorkspaceSession } from '../store/selectors';
import {
  acquirePackageAssetScope,
  type PackageAssetScopeHandle,
} from './packageAssetScope';

/**
 * Scoped-asset coordinate WITHOUT the session half — `projectId`/`agentId`
 * are read from the workspace store at MINT TIME (3A seam (b): every
 * project/agent switch unmounts + remints in v1, so the mint-time read is
 * consistent; the frozen render context is the §7 follow-up).
 */
export type IframeWidgetAssetCoordinate = {
  packageId: string;
  /** K1 — the widget's EXACT declared `type`. */
  surfaceId: string;
  /** Client-side declaration fingerprint (refcount coordinate only). */
  fingerprint: string;
};

export type IframeWidgetSource =
  | { kind: 'absolute'; url: string; trust?: PackageTrust }
  | { kind: 'scoped-asset'; coordinate: IframeWidgetAssetCoordinate };

/**
 * The frame's sandbox — the kernel's ONE external-frame predicate decides, never
 * a local copy. Only a first-party ABSOLUTE `https://` source on a foreign
 * origin gets the external-app profile (its own origin, popups, downloads —
 * never `allow-top-navigation*`); a scoped asset, a root-relative or
 * protocol-relative url, a trusted/untrusted package, or an unknown host origin
 * (no window) keeps the opaque sandbox.
 */
export function iframeWidgetSandbox(source: IframeWidgetSource, hostOrigin: string | null): string {
  if (source.kind !== 'absolute' || !hostOrigin) return OPAQUE_FRAME_SANDBOX;
  return externalFrameProfile(source.url, source.trust, hostOrigin)?.sandbox ?? OPAQUE_FRAME_SANDBOX;
}

type IframeWidgetProps = {
  title: string;
  source: IframeWidgetSource;
};

/**
 * The PRIMITIVE projection of an {@link IframeWidgetSource} — every field that
 * reaches the navigated URL or the mint coordinate, and nothing else.
 *
 * WHY IT EXISTS (scope-churn regression, 2026-07-27). The mint effect below is
 * keyed on THESE VALUES, never on the `source` OBJECT. `resolveWidgetRenderer`
 * (`WidgetRendererStrategy.tsx`) deliberately builds a fresh `source` literal on
 * every call, and the runtime hub re-hydrates the widget registry on every
 * CONNECT — not only on a real change (`api/events/route.ts` sends
 * `runtime:snapshot` when the stream opens). Keying the effect on object
 * identity therefore turned every hub reconnect (network blip, WSL resume,
 * server restart, `_packages` invalidation) into `release()` → refCount 0 →
 * `DELETE` → fresh `POST` → a NEW random handle → a new URL → a full frame
 * reload of every asset-backed widget. On primitives the same re-hydrate is a
 * no-op, while a genuine manifest change still moves `fingerprint` and remints.
 *
 * The rule for future edits: EVERY field that can change the minted URL or the
 * scope coordinate belongs here AND in the effect's dependency list. The
 * `iframeWidgetScopeDeps` drift guard in `__tests__/iframeWidgetScope.test.ts`
 * fails when a coordinate field stops moving a dependency.
 */
export type IframeWidgetScopeDeps = {
  readonly kind: IframeWidgetSource['kind'];
  readonly absoluteUrl: string | null;
  readonly packageId: string | null;
  readonly surfaceId: string | null;
  readonly fingerprint: string | null;
};

/** Flatten a `source` into the primitive dependency values of the mint effect. */
export function iframeWidgetScopeDeps(source: IframeWidgetSource): IframeWidgetScopeDeps {
  if (source.kind === 'absolute') {
    return {
      kind: 'absolute',
      absoluteUrl: source.url,
      packageId: null,
      surfaceId: null,
      fingerprint: null,
    };
  }
  const { packageId, surfaceId, fingerprint } = source.coordinate;
  return { kind: 'scoped-asset', absoluteUrl: null, packageId, surfaceId, fingerprint };
}

export type IframeWidgetScopeEffectParams = IframeWidgetScopeDeps & {
  readonly projectId: string | null;
  readonly agentId: string | null;
  /** Publishes the navigable src (`null` = keep the placeholder). */
  readonly setSrc: (src: string | null) => void;
  /** Heartbeat 403/410 — the consumer starts a fresh document generation. */
  readonly onRevoked: () => void;
};

/**
 * The mint effect body, extracted so it can be driven by a unit test in a host
 * suite that has no DOM. It is called ONLY from the `useEffect` below; the
 * returned function is that effect's cleanup (idempotent release).
 */
export function runIframeWidgetScopeEffect(
  params: IframeWidgetScopeEffectParams,
): () => void {
  const {
    kind, absoluteUrl, packageId, surfaceId, fingerprint,
    projectId, agentId, setSrc, onRevoked,
  } = params;

  if (kind === 'absolute') {
    setSrc(absoluteUrl);
    return () => {};
  }
  // Fail closed on an incomplete coordinate (no project yet, or a source the
  // flattening could not project) — the placeholder stays, nothing is minted.
  if (!projectId || !packageId || !surfaceId || !fingerprint) {
    setSrc(null);
    return () => {};
  }

  let cancelled = false;
  let handle: PackageAssetScopeHandle | null = null;
  let unsubscribe: (() => void) | null = null;
  setSrc(null);
  void acquirePackageAssetScope({
    projectId,
    agentId: agentId ?? undefined,
    packageId,
    surfaceKind: 'widget',
    surfaceId,
    fingerprint,
  })
    .then((acquired) => {
      if (cancelled) {
        acquired.release();
        return;
      }
      handle = acquired;
      setSrc(acquired.url);
      unsubscribe = acquired.onRevoked(() => {
        // Fresh document generation: placeholder + re-acquire.
        if (!cancelled) onRevoked();
      });
    })
    .catch(() => {
      // Not visible / denied — the placeholder stays (non-enumerating).
    });

  return () => {
    cancelled = true;
    unsubscribe?.();
    handle?.release();
  };
}

/**
 * Client-only iframe widget (CARD1 3A).
 *
 * Asset-backed widgets NEVER navigate the host-internal
 * `/api/packages/{id}/app/...` descriptor and NEVER carry `?projectId=` (the
 * legacy query-identity path is deleted): the widget acquires a refcounted,
 * identity-free asset scope (`packageAssetScope`) and loads the opaque
 * `/api/package-app/_scope/{handle}/surface/…` URL. The placeholder renders
 * until the mint resolves; a revocation (403/410 — access loss, package
 * update, server restart) drops back to the placeholder and re-acquires as a
 * fresh document generation.
 *
 * Absolute URLs are only emitted by the snapshot for first-party / trusted
 * packages — untrusted absolute URLs are dropped upstream. A first-party
 * external `https://` app gets its OWN origin (`iframeWidgetSandbox`); every
 * other frame keeps the opaque sandbox, and none ever gets top navigation.
 */
export const IframeWidget = memo(function IframeWidget({ title, source }: IframeWidgetProps) {
  const { projectId, agentId } = useWorkspaceSession();
  const { kind, absoluteUrl, packageId, surfaceId, fingerprint } = iframeWidgetScopeDeps(source);
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(absoluteUrl);
  const [generation, setGeneration] = useState(0);
  const sandbox = iframeWidgetSandbox(source, typeof window === 'undefined' ? null : window.location.origin);

  useEffect(
    () => runIframeWidgetScopeEffect({
      kind,
      absoluteUrl,
      packageId,
      surfaceId,
      fingerprint,
      projectId,
      agentId,
      setSrc: setResolvedSrc,
      onRevoked: () => setGeneration((n) => n + 1),
    }),
    // PRIMITIVES ONLY — never the `source` object. See `IframeWidgetScopeDeps`:
    // the renderer hands us a fresh literal on every registry re-hydrate, so an
    // identity dependency would release + re-mint (and reload the frame) on
    // every hub connect. Anything new that changes the URL or the coordinate
    // must be added to `iframeWidgetScopeDeps` AND to this list.
    [kind, absoluteUrl, packageId, surfaceId, fingerprint, projectId, agentId, generation],
  );

  if (!resolvedSrc) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-white/45">
        Loading…
      </div>
    );
  }

  return (
    <iframe
      // A sandbox change applies only to a NEW browsing context.
      key={sandbox}
      title={title}
      src={resolvedSrc}
      className="h-full w-full border-0 bg-transparent"
      sandbox={sandbox}
      referrerPolicy="strict-origin-when-cross-origin"
      allow="clipboard-read; clipboard-write"
    />
  );
});
