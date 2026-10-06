/**
 * uiModuleLoader — attaches first-party package UIs at RUNTIME, the one lane a
 * package's workspace UI reaches the host through.
 *
 * The runtime route hands the workspace a `ui` view next to the snapshot (the
 * server-derived module URLs and the union stylesheet — `packageUiModules.ts`).
 * For each module this loader, in order:
 * 1. fills the kernel's shared-module table from the host's OWN instances
 *    (React ×5 + the kernel client) — a bundle never carries a second copy;
 * 2. checks the pins FAIL-CLOSED: the host API version of the bundle's record
 *    and the React major it was built against, against this page's React;
 * 3. plans the modules with the kernel's `planUiModuleInstall` (a missing
 *    provider skips the consumer) and installs them CONCURRENTLY, each one
 *    only after its own tier-2 providers — a hung import holds its consumers,
 *    never an independent module;
 * 4. declares a provider's tier-2 ids (`app.module.provides`) BEFORE its
 *    import, so its own `publishSharedModule` calls are accepted, then
 *    `import()`s the derived same-origin URL and calls every
 *    `install…HostComponents({ registry, port })` export with a GUARDED
 *    registry: a module registers only under its own package id, may fill a
 *    host slot only as itself, and every surface it registers renders inside
 *    its own error boundary — one broken bundle never takes the workspace down.
 *
 * A package's module is imported at most once (two module instances of one
 * package is a split brain). A module, once imported, lives until the page
 * reloads: a changed hash for a loaded package is logged and waits for the
 * reload.
 *
 * Cost: one GET per module file (cold), zero warm (immutable hash URLs); no
 * poll — the status store notifies on transitions only, and the one timer is
 * the bounded release of the workspace's wait (`armUiModuleHoldRelease`).
 */

import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as ReactJsxRuntime from 'react/jsx-runtime';
import * as ReactJsxDevRuntime from 'react/jsx-dev-runtime';
import * as KernelClient from '@neuralis/package-system/client';
import type { HostComponentRegistration, PackageHostRegistry } from '@neuralis/package-system/client';
import {
  UI_MODULE_HOST_API_VERSION,
  UI_MODULE_INSTALL_EXPORT,
  declareSharedModules,
  hasSharedModule,
  planUiModuleInstall,
  publishSharedModule,
} from '@neuralis/package-system/client/shared-modules';
import type { PackageUiAttachments, UiModuleDescriptor } from '@neuralis/package-system/contracts';
import { workspaceHostPort } from './buildWorkspaceHostPort';
import { getHostRegistry, hostSlotOwnerViolation, isHostSlotKey } from './hostRegistryInstance';

/**
 * The module lane's URL prefix. The server owns the URL (`packageUiModules.ts`
 * `PACKAGE_UI_ROUTE_PREFIX`, a server module this client file cannot import);
 * the twin is pinned equal by `packageUiModules.test.ts`.
 */
export const UI_MODULE_URL_PREFIX = '/api/package-ui';

export type UiModuleStatus = 'idle' | 'loading' | 'settled';

type LoaderState = {
  status: UiModuleStatus;
  /** Package id → the module hash this page imported (or tried to). */
  attempted: Map<string, string>;
  pending: Set<string>;
  sheetUrl: string | null;
  published: boolean;
  listeners: Set<() => void>;
  /** The workspace stopped waiting on the first settle (its bounded release fired). */
  holdReleased: boolean;
  /** Package id → why the SERVER refused its module (from the `ui` view; no extra request). */
  refused: Map<string, string>;
  /** Package id → why its attach failed on THIS page, when the reason is a named one (`no-install-export`). */
  attachFailed: Map<string, string>;
  holdTimer: ReturnType<typeof setTimeout> | null;
};

const STATE_KEY = Symbol.for('neuralis.workspace.uiModuleLoader');

function loaderState(): LoaderState {
  const g = globalThis as unknown as Record<symbol, LoaderState | undefined>;
  let s = g[STATE_KEY];
  if (!s) {
    s = {
      status: 'idle',
      attempted: new Map(),
      pending: new Set(),
      sheetUrl: null,
      published: false,
      listeners: new Set(),
      holdReleased: false,
      holdTimer: null,
      refused: new Map(),
      attachFailed: new Map(),
    };
    g[STATE_KEY] = s;
  }
  return s;
}

function emit(): void {
  for (const listener of [...loaderState().listeners]) {
    try {
      listener();
    } catch {
      // a listener failure must not interrupt the loader
    }
  }
}

function setStatus(next: UiModuleStatus): void {
  const s = loaderState();
  if (s.status === next) return;
  s.status = next;
  if (next === 'settled' && s.holdTimer !== null) {
    clearTimeout(s.holdTimer);
    s.holdTimer = null;
  }
  emit();
}

/** Subscribe to loader transitions (status, a package leaving `pending`). */
export function subscribeUiModules(listener: () => void): () => void {
  loaderState().listeners.add(listener);
  return () => {
    loaderState().listeners.delete(listener);
  };
}

export function getUiModuleStatus(): UiModuleStatus {
  return loaderState().status;
}

/** Why the host refused `packageId`'s UI module or could not attach it, or `null` — its surfaces name it in place. */
export function uiModuleRefusalReason(packageId: string): string | null {
  const s = loaderState();
  return s.refused.get(packageId) ?? s.attachFailed.get(packageId) ?? null;
}

/** Whether `packageId`'s module is being fetched right now (its surfaces render a loading placeholder). */
export function isUiModulePending(packageId: string): boolean {
  return loaderState().pending.has(packageId);
}

/**
 * Whether the workspace still waits for its UI modules: until the first module
 * set has SETTLED — before the scoped snapshot's `ui` view arrived (`idle`) and
 * while it attaches (`loading`) — and only until the bounded release fires.
 */
export function isUiModuleHoldActive(): boolean {
  const s = loaderState();
  return s.status !== 'settled' && !s.holdReleased;
}

/**
 * Bound the hold: after `ms` without a settle the hold ends, so an `import()`
 * that never settles releases the workspace instead of holding it (its
 * surfaces keep their own "Loading…" until the module lands). One timer per
 * page, cleared by the settle. Returns the cancel handle.
 */
export function armUiModuleHoldRelease(ms: number): () => void {
  const s = loaderState();
  if (s.status === 'settled' || s.holdReleased || s.holdTimer !== null) return () => {};
  const timer = setTimeout(() => {
    const current = loaderState();
    current.holdTimer = null;
    current.holdReleased = true;
    emit();
  }, ms);
  s.holdTimer = timer;
  return () => {
    const current = loaderState();
    if (current.holdTimer === timer) {
      clearTimeout(timer);
      current.holdTimer = null;
    }
  };
}

/** `isUiModuleHoldActive` as a hook — the workspace's loading branch. */
export function useUiModulesPending(): boolean {
  return React.useSyncExternalStore(subscribeUiModules, isUiModuleHoldActive, () => false);
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');

const LANE_HASH = /^[0-9a-f]{64}$/;

/** Whether `url` is a module-lane URL under `hash` (sha256 hex) — the only URL shape the loader imports or links. */
function isLaneUrl(url: unknown, hash: string): url is string {
  return LANE_HASH.test(hash) && typeof url === 'string' && url.startsWith(`${UI_MODULE_URL_PREFIX}/${hash}/`);
}

/**
 * The `ui` view the runtime route attaches, or `null` for a payload without one
 * (the SSR seed). A descriptor whose URLs are not lane URLs under its own hash
 * is dropped, so the loader can never be pointed at another origin or route.
 */
export function readUiAttachments(snapshot: unknown): PackageUiAttachments | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const ui = (snapshot as { ui?: unknown }).ui;
  if (!ui || typeof ui !== 'object') return null;
  const { modules, sheet } = ui as { modules?: unknown; sheet?: unknown };
  if (!Array.isArray(modules)) return null;
  const valid = modules.filter((m): m is UiModuleDescriptor => {
    const d = m as Partial<UiModuleDescriptor> | null;
    return Boolean(
      d &&
        typeof d.packageId === 'string' &&
        typeof d.hash === 'string' &&
        isLaneUrl(d.entryUrl, d.hash) &&
        (d.cssUrl === undefined || isLaneUrl(d.cssUrl, d.hash)) &&
        isStringArray(d.sharedImports) &&
        (d.provides === undefined || isStringArray(d.provides)) &&
        typeof d.hostApiVersion === 'number' &&
        typeof d.reactMajor === 'number',
    );
  });
  const s = sheet as { hash?: unknown; url?: unknown; bytes?: unknown } | null | undefined;
  const validSheet =
    s && typeof s.hash === 'string' && isLaneUrl(s.url, s.hash) && typeof s.bytes === 'number'
      ? { hash: s.hash, url: s.url, bytes: s.bytes }
      : null;
  const refused = Array.isArray((ui as { refused?: unknown }).refused)
    ? ((ui as { refused: unknown[] }).refused).filter(
        (r): r is { packageId: string; reason: string } =>
          Boolean(r) && typeof (r as { packageId?: unknown }).packageId === 'string' && typeof (r as { reason?: unknown }).reason === 'string',
      )
    : [];
  return { modules: valid, sheet: validSheet, refused };
}

/** Fill tier 1 of the kernel's shared table from the host's OWN instances — once per page. */
export function publishHostSharedModules(): void {
  const s = loaderState();
  if (s.published) return;
  publishSharedModule('react', React);
  publishSharedModule('react-dom', ReactDOM);
  publishSharedModule('react-dom/client', ReactDOMClient);
  publishSharedModule('react/jsx-runtime', ReactJsxRuntime);
  publishSharedModule('react/jsx-dev-runtime', ReactJsxDevRuntime);
  publishSharedModule('@neuralis/package-system/client', KernelClient);
  s.published = true;
}

/** The pin check, FAIL-CLOSED: `null` = may load, else the reason it may not. */
export function uiModulePinViolation(descriptor: UiModuleDescriptor, hostReactVersion: string = React.version): string | null {
  if (descriptor.hostApiVersion !== UI_MODULE_HOST_API_VERSION) {
    return `host API ${descriptor.hostApiVersion}, this host speaks ${UI_MODULE_HOST_API_VERSION}`;
  }
  const hostMajor = Number.parseInt(hostReactVersion, 10);
  if (!Number.isInteger(hostMajor) || descriptor.reactMajor !== hostMajor) {
    return `built for React ${descriptor.reactMajor}, the host runs React ${hostReactVersion}`;
  }
  return null;
}

type SurfaceBoundaryProps = { surface: string; children?: React.ReactNode };

/** One per runtime-attached surface: a throwing bundle shows a placeholder, never a dead workspace. */
class SurfaceBoundary extends React.Component<SurfaceBoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error(`[package-ui] surface "${this.props.surface}" failed to render`, error);
  }

  render(): React.ReactNode {
    if (this.state.failed) {
      return React.createElement(
        'div',
        { className: 'flex h-full items-center justify-center p-4 text-center text-sm text-white/55' },
        'This widget failed to load.',
      );
    }
    return this.props.children;
  }
}

function withSurfaceBoundary(surface: string, Component: unknown): unknown {
  if (typeof Component !== 'function' && (typeof Component !== 'object' || Component === null)) return Component;
  const Inner = Component as React.ComponentType<Record<string, unknown>>;
  function BoundedSurface(props: Record<string, unknown>): React.ReactElement {
    return React.createElement(SurfaceBoundary, { surface }, React.createElement(Inner, props));
  }
  BoundedSurface.displayName = `BoundedSurface(${surface})`;
  return BoundedSurface;
}

/**
 * The registry a runtime module installs into: its registrations are its OWN
 * (package id), a host slot only under its own key, and every surface is
 * bounded. A violation throws inside the module's install call and is reported
 * as that module's failure.
 */
export function guardedRegistryFor(packageId: string, registry: PackageHostRegistry): PackageHostRegistry {
  return {
    register(reg: HostComponentRegistration): void {
      if (reg.packageSlug !== packageId) {
        throw new Error(`[package-ui] ${packageId} tried to register "${reg.componentImport}" as ${reg.packageSlug}`);
      }
      const violation = hostSlotOwnerViolation(reg);
      if (violation) throw new Error(`[package-ui] ${violation}`);
      registry.register(
        isHostSlotKey(reg.componentImport)
          ? reg
          : { ...reg, Component: withSurfaceBoundary(reg.componentImport, reg.Component) },
      );
    },
    unregister: (componentImport) => {
      const owner = registry.list().find((r) => r.componentImport === componentImport)?.packageSlug;
      return owner === packageId ? registry.unregister(componentImport) : false;
    },
    resolve: (componentImport) => registry.resolve(componentImport),
    list: () => registry.list(),
    unregisterPackage: (slug) => (slug === packageId ? registry.unregisterPackage(slug) : 0),
    subscribe: (listener) => registry.subscribe(listener),
  };
}

function ensureStylesheet(url: string, marker: string): void {
  if (typeof document === 'undefined') return;
  const existing = document.head.querySelector<HTMLLinkElement>(`link[data-neuralis-ui="${marker}"]`);
  if (existing?.getAttribute('href') === url) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = url;
  link.dataset.neuralisUi = marker;
  // The union sheet goes LAST in <head>: it is a superset of the build sheet in
  // the correct utility order, so for every tie it is the copy that wins.
  document.head.appendChild(link);
  existing?.remove();
}

type ModuleImporter = (url: string) => Promise<Record<string, unknown>>;

const importModuleUrl: ModuleImporter = async (url) =>
  (await import(/* turbopackIgnore: true */ /* webpackIgnore: true */ url)) as Record<string, unknown>;

/**
 * Attach ONE module. Its tier-2 ids are declared BEFORE the import — the
 * module publishes them while it evaluates or installs, and the kernel table
 * refuses an undeclared id. A declared id the module never published is
 * logged; a consumer reading it then fails its own attach, contained there.
 */
export async function installModule(
  descriptor: UiModuleDescriptor,
  importer: ModuleImporter = importModuleUrl,
): Promise<void> {
  if (descriptor.cssUrl) ensureStylesheet(descriptor.cssUrl, `module:${descriptor.packageId}`);
  declareSharedModules(descriptor.packageId, descriptor.provides ?? []);
  const started = performance.now();
  const namespace = await importer(descriptor.entryUrl);
  const fetched = performance.now();
  const registry = guardedRegistryFor(descriptor.packageId, getHostRegistry());
  const installers = Object.keys(namespace).filter((name) => UI_MODULE_INSTALL_EXPORT.test(name) && typeof namespace[name] === 'function');
  if (installers.length === 0) {
    throw Object.assign(new Error('the module exports no install…HostComponents function'), { reason: 'no-install-export' });
  }
  for (const name of installers) {
    (namespace[name] as (opts: { registry: PackageHostRegistry; port: typeof workspaceHostPort }) => void)({
      registry,
      port: workspaceHostPort,
    });
  }
  const unpublished = (descriptor.provides ?? []).filter((id) => !hasSharedModule(id));
  if (unpublished.length > 0) {
    console.error(`[package-ui] ${descriptor.packageId} declared but did not publish: ${unpublished.join(', ')}`);
  }
  console.info(
    `[package-ui] ${descriptor.packageId} attached: fetch ${Math.round(fetched - started)} ms, ` +
      `install ${Math.round(performance.now() - fetched)} ms`,
  );
}

/**
 * Start attaching every module of `view` not attached yet, and return one
 * settle promise per started module (none rejects). The modules install
 * CONCURRENTLY: each awaits only its tier-2 providers (its `sharedImports` that
 * another candidate `provides`), so one `import()` that never settles holds its
 * own consumers and nothing else.
 */
function startModules(view: PackageUiAttachments, importer: ModuleImporter): Promise<void>[] {
  const s = loaderState();
  publishHostSharedModules();
  const refusedBefore = s.refused.size;
  s.refused = new Map(view.refused.map((r) => [r.packageId, r.reason]));
  if (s.refused.size !== refusedBefore || s.refused.size > 0) emit();
  if (view.sheet && s.sheetUrl !== view.sheet.url) {
    ensureStylesheet(view.sheet.url, 'union-sheet');
    s.sheetUrl = view.sheet.url;
  }

  const candidates: UiModuleDescriptor[] = [];
  for (const descriptor of view.modules) {
    const seen = s.attempted.get(descriptor.packageId);
    if (seen !== undefined) {
      if (seen !== descriptor.hash) {
        console.info(`[package-ui] ${descriptor.packageId} has a new build — it attaches on the next reload`);
      }
      continue;
    }
    const violation = uiModulePinViolation(descriptor);
    s.attempted.set(descriptor.packageId, descriptor.hash);
    if (violation) {
      console.error(`[package-ui] ${descriptor.packageId} refused: ${violation}`);
      continue;
    }
    candidates.push(descriptor);
  }
  if (candidates.length === 0) return [];

  const byId = new Map(candidates.map((d) => [d.packageId, d]));
  const plan = planUiModuleInstall(
    candidates.map((d) => ({ packageId: d.packageId, sharedImports: d.sharedImports, provides: d.provides })),
  );
  for (const skip of plan.skipped) {
    console.error(`[package-ui] ${skip.packageId} not installed: ${skip.reason.code} (${skip.reason.id})`);
  }
  const providerOf = new Map<string, string>();
  for (const d of candidates) for (const id of d.provides ?? []) providerOf.set(id, d.packageId);
  for (const id of plan.order) s.pending.add(id);
  setStatus('loading');
  emit();
  // `plan.order` puts every provider before its consumers, so a provider's
  // settle promise exists when its consumer is started.
  const settles = new Map<string, Promise<void>>();
  for (const id of plan.order) {
    const descriptor = byId.get(id);
    if (!descriptor) continue;
    const providers = [
      ...new Set(descriptor.sharedImports.map((sid) => providerOf.get(sid)).filter((p): p is string => p !== undefined && p !== id)),
    ].map((p) => settles.get(p) ?? Promise.resolve());
    settles.set(
      id,
      (async () => {
        try {
          await Promise.all(providers);
          await installModule(descriptor, importer);
        } catch (error) {
          console.error(`[package-ui] ${id} failed to attach`, error);
          const reason = (error as { reason?: unknown } | null)?.reason;
          if (typeof reason === 'string') s.attachFailed.set(id, reason);
        } finally {
          s.pending.delete(id);
          emit();
        }
      })(),
    );
  }
  return [...settles.values()];
}

/**
 * Attach every module of `view` not attached yet; resolves when this view's
 * modules have settled. Each package is started at most once per page, so a
 * snapshot arriving mid-load starts only what is new and never waits behind a
 * module that is still loading. The plan sees only this call's candidates: a
 * new consumer of a provider attempted by an earlier call is not ordered after
 * it (the module set changes only with a restart today). The status settles
 * once nothing is pending.
 * A `null` view (no `ui` on this payload) changes nothing.
 */
export function ensureUiModules(
  view: PackageUiAttachments | null,
  importer: ModuleImporter = importModuleUrl,
): Promise<void> {
  if (!view || typeof window === 'undefined') return Promise.resolve();
  let settles: Promise<void>[] = [];
  try {
    settles = startModules(view, importer);
  } catch (error) {
    console.error('[package-ui] module attach failed', error);
  }
  return Promise.all(settles).then(() => {
    if (loaderState().pending.size === 0) setStatus('settled');
  });
}
