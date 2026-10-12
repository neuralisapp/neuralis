'use client';

import { useEffect, useRef, useState, type ComponentType, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { useWorkspaceSession } from '../store/selectors';
import {
  acquirePackageAssetScope,
  type PackageAssetScopeHandle,
} from './packageAssetScope';
import type { PackageAppImage } from './dockRuntime';

/**
 * PackageAppIcon — the ONE renderer of a package's declared app picture, for
 * every place the workspace shows a package app (dock tile, edit tray, app
 * menu, inbox, notification popover).
 *
 * It renders a FIXED `size`×`size` box that shows `fallback` (the declared
 * glyph) until the picture's bytes arrive, and whenever they cannot: no image
 * declared, the consumer is off-screen or inside a hidden/closed ancestor, the
 * scope is refused (not visible, or the icon capacity answer), revoked, or the
 * bytes fail to decode. The box never changes size, so a late picture never
 * shifts layout.
 *
 * Acquisition is LAZY and VISIBLE-ONLY: a scope is minted through the shared
 * refcounted `packageAssetScope` client only while this consumer is actually
 * on screen, and released when it scrolls away, hides or unmounts — so a long
 * launcher holds a scope per VISIBLE picture, never one per searchable app.
 * Several consumers of the same picture share one scope and one url. ONE
 * module-level IntersectionObserver serves every icon; there is no poll and no
 * retry timer — a new attempt comes from a visibility change, a revocation or
 * a remount.
 */
export function PackageAppIcon(props: {
  image?: PackageAppImage;
  size: number;
  fallback: ReactNode;
  className?: string;
}): ReactElement {
  const { image, size, fallback, className } = props;
  const { projectId, agentId } = useWorkspaceSession();
  const packageId = image?.packageId ?? null;
  const dockId = image?.dockId ?? null;
  const declaration = image?.declaration ?? null;

  const boxRef = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  // A picture whose bytes failed to decode stays on the glyph until its
  // coordinate (or the scope generation) changes — never a retry loop.
  const coordinateKey = JSON.stringify([projectId, agentId, packageId, dockId, declaration, generation]);
  const [brokenKey, setBrokenKey] = useState<string | null>(null);
  const active = visible && brokenKey !== coordinateKey;

  useEffect(() => {
    const element = boxRef.current;
    if (!packageId || !element) return undefined;
    return observePackageAppIconVisibility(element, setVisible);
  }, [packageId]);

  useEffect(
    () => runPackageAppIconLifecycle({
      packageId,
      dockId,
      declaration,
      projectId,
      agentId,
      active,
      setUrl,
      onRevoked: () => setGeneration((n) => n + 1),
    }),
    // PRIMITIVES ONLY — the descriptor object is rebuilt on every snapshot.
    [packageId, dockId, declaration, projectId, agentId, active, generation],
  );

  return (
    <span
      ref={boxRef}
      className={className}
      style={{
        width: size,
        height: size,
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflow: 'hidden',
      }}
    >
      {url && active ? (
        <img
          src={url}
          alt=""
          width={size}
          height={size}
          decoding="async"
          draggable={false}
          referrerPolicy="no-referrer"
          style={{ width: size, height: size, objectFit: 'contain' }}
          onError={() => setBrokenKey(coordinateKey)}
        />
      ) : (
        fallback
      )}
    </span>
  );
}

export type PackageAppIconLifecycleParams = {
  readonly packageId: string | null;
  readonly dockId: string | null;
  readonly declaration: string | null;
  readonly projectId: string | null;
  readonly agentId: string | null;
  /** Visible on screen and not known-broken. */
  readonly active: boolean;
  /** Publishes the picture url (`null` = show the glyph). */
  readonly setUrl: (url: string | null) => void;
  /** Heartbeat 403/410 — the consumer starts a fresh generation. */
  readonly onRevoked: () => void;
};

/**
 * The acquire/release effect body, extracted so a host suite with no DOM can
 * drive it. Called ONLY from the effect above; the returned function is that
 * effect's cleanup.
 */
export function runPackageAppIconLifecycle(params: PackageAppIconLifecycleParams): () => void {
  const { packageId, dockId, declaration, projectId, agentId, active, setUrl, onRevoked } = params;
  if (!active || !packageId || !dockId || !declaration || !projectId) {
    setUrl(null);
    return () => {};
  }

  let cancelled = false;
  let handle: PackageAssetScopeHandle | null = null;
  let unsubscribe: (() => void) | null = null;
  void acquirePackageAssetScope({
    projectId,
    agentId: agentId ?? undefined,
    packageId,
    purpose: 'icon',
    surfaceKind: 'dock',
    surfaceId: dockId,
    fingerprint: declaration,
  })
    .then((acquired) => {
      if (cancelled) {
        acquired.release();
        return;
      }
      handle = acquired;
      setUrl(acquired.url);
      unsubscribe = acquired.onRevoked(() => {
        if (cancelled) return;
        setUrl(null);
        onRevoked();
      });
    })
    .catch(() => {
      // Not visible, denied or the icon capacity refusal: the glyph stays and
      // nothing is scheduled.
      if (!cancelled) setUrl(null);
    });

  return () => {
    cancelled = true;
    unsubscribe?.();
    handle?.release();
    setUrl(null);
  };
}

// ---------------------------------------------------------------------------
// The ONE shared visibility observer
// ---------------------------------------------------------------------------

const visibilityListeners = new Map<Element, (visible: boolean) => void>();
let sharedObserver: IntersectionObserver | null = null;

/**
 * Is a rendered element really showing? Intersection alone is not enough: a
 * `visibility: hidden` ancestor or a `[hidden]`/`[inert]` subtree still
 * intersects the viewport.
 */
export function isRenderedVisible(element: Element): boolean {
  if (element.closest('[hidden],[inert]')) return false;
  const check = (element as Element & { checkVisibility?: (options?: object) => boolean }).checkVisibility;
  return typeof check === 'function'
    ? check.call(element, { visibilityProperty: true, checkVisibilityCSS: true })
    : true;
}

/**
 * Watch one icon box through the module's single IntersectionObserver. The
 * observer is created with the first watched box and disconnected with the
 * last; the callback fires only on an intersection change of a watched box.
 */
export function observePackageAppIconVisibility(
  element: Element,
  onChange: (visible: boolean) => void,
): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    onChange(isRenderedVisible(element));
    return () => {};
  }
  visibilityListeners.set(element, onChange);
  sharedObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      visibilityListeners.get(entry.target)?.(entry.isIntersecting && isRenderedVisible(entry.target));
    }
  });
  sharedObserver.observe(element);
  return () => {
    visibilityListeners.delete(element);
    sharedObserver?.unobserve(element);
    if (visibilityListeners.size === 0) {
      sharedObserver?.disconnect();
      sharedObserver = null;
    }
  };
}

/**
 * A dock/menu/inbox glyph: the package's declared picture when it has one
 * (through `PackageAppIcon`, acquired only while visible), else the glyph
 * itself — so an item without a picture holds no store subscription or
 * observer.
 */
export function AppGlyph({ image, icon: Icon, size, className, style }: {
  image?: PackageAppImage;
  icon: ComponentType<{ className?: string; style?: CSSProperties }>;
  size: number;
  className?: string;
  style?: CSSProperties;
}): ReactElement {
  const glyph = <Icon className={className} style={style} />;
  return image ? <PackageAppIcon image={image} size={size} fallback={glyph} /> : glyph;
}
