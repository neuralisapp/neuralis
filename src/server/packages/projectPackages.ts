/**
 * Per-project package activation.
 *
 * Lazily scans and loads `_packages/` for each project when first accessed.
 * Multiple projects can be active simultaneously — each gets its own scanner
 * and watcher, and their packages are tracked separately in the runtime.
 */

import { packageInstanceId, parsePackageInstanceId } from '@neuralis/package-system/contracts';
import { join } from 'node:path';
import { resolveProjectRoot } from '@neuralis/package-system/paths';
import { getEnv } from '../config/env';
import { getLogger } from '../logging/setup';
import { getProjectPackageScanner, getScannerForDir, type ProjectPackageScanner } from './ProjectPackageScanner';
import { getPackageRuntimeManager, type PackageLoadError } from './PackageRuntimeManager';
import { toResolvedRecord } from './packageRecords';
import { getProjectById } from '../store/ProjectStore';
import { getRuntime } from '../host/bootstrap';
import type { InstalledPackageInfo, SourceScope, PackageSourceRoot, PackageSourceRoots } from '@neuralis/package-system/contracts';

type Logger = ReturnType<ReturnType<typeof getLogger>['child']>;

/**
 * A scanner paired with the owning SOURCE scope of the directory it scans
 * (R2b). The default `_packages/` drop-zone is `{ kind: 'project' }`; a
 * `recognizesPackages`-flagged source carries its own project/user/agent scope.
 * The scope is stamped onto every record so the runtime can isolate advertise.
 */
type ScannerEntry = { scanner: ProjectPackageScanner; ownerScope: SourceScope; uriRoot: string };
type FlaggedRoot = { dir: string; ownerScope: SourceScope; uriRoot: string };

type ActivationState = {
  /** Projects scanned + synced + watching. */
  activated: Set<string>;
  /** In-flight activations, so concurrent callers share one. */
  pending: Map<string, Promise<void>>;
  /**
   * All package scanners per activated project (default `_packages/` FIRST,
   * then each `recognizesPackages`-flagged source), each paired with its owning
   * source scope. The source of truth for re-collecting records on any sync and
   * for the installed-packages overview.
   */
  scanners: Map<string, ScannerEntry[]>;
  /** Per-project chain, so two source changes never re-derive one list concurrently. */
  rederiving: Map<string, Promise<boolean>>;
  /** The source-roots provider the change subscription is armed on (once per runtime). */
  subscribedTo: { roots: PackageSourceRoots; unsubscribe: () => void } | null;
};

const GLOBAL_KEY = '__neuralis_project_package_activation__' as const;

// ONE copy per process, like the runtime manager and the scanner map: the
// server bundles each evaluate this module, and a per-bundle list would let one
// route's sync unload the packages another route's list loaded.
function activationState(): ActivationState {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { activated: new Set(), pending: new Map(), scanners: new Map(), rederiving: new Map(), subscribedTo: null } satisfies ActivationState;
  }
  return g[GLOBAL_KEY] as ActivationState;
}

/**
 * Ensure a project's `_packages/` are scanned, loaded into the runtime,
 * and watched for changes. Idempotent — subsequent calls are instant no-ops.
 */
export async function ensureProjectPackagesLoaded(projectId: string): Promise<void> {
  const state = activationState();
  if (state.activated.has(projectId)) return;

  // Deduplicate concurrent calls for the same project
  const pending = state.pending.get(projectId);
  if (pending) return pending;

  const promise = activateProject(projectId);
  state.pending.set(projectId, promise);

  try {
    await promise;
  } finally {
    state.pending.delete(projectId);
  }
}

async function activateProject(projectId: string): Promise<void> {
  const env = getEnv();
  const logger = getLogger().child('project-packages');
  const projectRoot = resolveProjectRoot(env.projectsRoot, projectId);

  const entries: ScannerEntry[] = [];

  // C3 — the default `_packages/` drop-zone scanner ALWAYS runs, from the fixed
  // path, with NO brain-core dependency. It loads at activation from ~10 route
  // entry points before source enumeration is guaranteed ready, so its load
  // must never depend on a brain-core call (boot-order hazard). The drop-zone is
  // implicitly project-scope.
  entries.push({ scanner: getProjectPackageScanner(projectRoot, logger), ownerScope: { kind: 'project' }, uriRoot: 'packages://' });

  // C2/R2b — source-driven: in ADDITION, any enabled, local source flagged
  // `recognizesPackages` gets its own scanner, carrying the source's OWN
  // project/user/agent scope. The packages LOAD here; the per-caller advertise
  // isolation (only the owning user/agent sees them) is enforced downstream at
  // the snapshot + stream boundary via the stamped `ownerScope`.
  for (const { dir, ownerScope, uriRoot } of (await listFlaggedPackageRoots(projectId, logger)) ?? []) {
    entries.push({ scanner: getScannerForDir(dir, logger), ownerScope, uriRoot });
  }

  // A re-activation (after clear-cache) drops this project's listener from a
  // scanner the new list no longer holds.
  const previous = activationState().scanners.get(projectId) ?? [];
  activationState().scanners.set(projectId, entries);
  await releaseDropped(projectId, previous, entries);

  // Initial scan of every scanner, then ONE combined sync (the runtime manager
  // unloads packages no longer present, so all records must arrive together).
  await Promise.all(entries.map((e) => e.scanner.scan()));
  await syncFromScanners(projectId, entries, logger, { invalidate: true });

  for (const entry of entries) watchEntry(projectId, entry, logger);

  activationState().activated.add(projectId);
}

/**
 * Each scanner watches its own root; any change re-collects records from ALL
 * of the project's scanners (the scanner has already rescanned itself before
 * this fires). The list is read AT FIRE TIME, so a source added since never
 * has its packages unloaded by a sync from an older list.
 */
function watchEntry(projectId: string, { scanner, uriRoot }: ScannerEntry, logger: Logger): void {
  scanner.startWatching(projectId, () => {
    const entries = activationState().scanners.get(projectId);
    if (!entries) return;
    syncFromScanners(projectId, entries, logger).catch((err) =>
      logger.warn('Watch-triggered package sync failed', { projectId, error: String(err) }),
    );
  }, { createRoot: uriRoot === 'packages://' });
}

async function releaseDropped(projectId: string, previous: readonly ScannerEntry[], next: readonly ScannerEntry[]): Promise<void> {
  const kept = new Set(next.map((e) => e.scanner));
  for (const scanner of new Set(previous.map((e) => e.scanner))) {
    if (!kept.has(scanner)) await scanner.removeListener(projectId);
  }
}

const rootKey = (root: FlaggedRoot): string => JSON.stringify([root.dir, root.ownerScope, root.uriRoot]);

/**
 * Re-derive an activated project's flagged roots and apply only the
 * difference: a new root is scanned and watched, a removed or unflagged one
 * loses this project's listener. An unchanged set touches no disk beyond the
 * one listing. Returns whether the scanner list changed; the caller syncs.
 */
function rederiveFlaggedRoots(projectId: string, logger: Logger): Promise<boolean> {
  const state = activationState();
  // The previous run's own caller receives its rejection; this one only waits its turn.
  const turn = (state.rederiving.get(projectId) ?? Promise.resolve(false)).then(() => undefined, () => undefined);
  const run = turn.then(async () => {
    const current = state.scanners.get(projectId);
    if (!current) return false;
    const desired = await listFlaggedPackageRoots(projectId, logger);
    if (desired === null) return false; // an unreadable inventory never drops a loaded source
    const [dropZone, ...flagged] = current;
    if (!dropZone) return false;
    const held = new Map(flagged.map((e) => [rootKey({ dir: e.scanner.packagesDir, ownerScope: e.ownerScope, uriRoot: e.uriRoot }), e]));
    const wanted = new Map(desired.map((root) => [rootKey(root), root]));
    if (held.size === wanted.size && [...wanted.keys()].every((key) => held.has(key))) return false;
    const next: ScannerEntry[] = [dropZone, ...[...wanted].map(([key, root]) => held.get(key)
      ?? { scanner: getScannerForDir(root.dir, logger), ownerScope: root.ownerScope, uriRoot: root.uriRoot })];
    const added = next.slice(1).filter((e) => !flagged.includes(e));
    state.scanners.set(projectId, next);
    await Promise.all(added.map((e) => e.scanner.scan()));
    for (const entry of added) watchEntry(projectId, entry, logger);
    await releaseDropped(projectId, current, next);
    logger.info('Flagged package sources re-derived', { projectId, added: added.length, dropped: flagged.filter((e) => !next.includes(e)).length });
    return true;
  });
  state.rederiving.set(projectId, run);
  const settle = (): void => { if (state.rederiving.get(projectId) === run) state.rederiving.delete(projectId); };
  void run.then(settle, settle);
  return run;
}

/**
 * A source-config commit for `projectId`. Only an activated or activating
 * project is reconciled (a later first activation reads the fresh list);
 * an activating one is awaited first, so a commit landing mid-activation is
 * applied on top of the list the activation read.
 */
function onSourceRootsChanged(projectId: string, logger: Logger): void {
  const state = activationState();
  if (!state.activated.has(projectId) && !state.pending.has(projectId)) return;
  void (async () => {
    await ensureProjectPackagesLoaded(projectId);
    if (await rederiveFlaggedRoots(projectId, logger)) {
      await syncFromScanners(projectId, state.scanners.get(projectId) ?? [], logger);
    }
  })().catch((err) => logger.warn('Source-triggered package sync failed', { projectId, error: String(err) }));
}

/** Arm the provider's change subscription once per runtime, at its first use. */
function armSourceRootsSubscription(roots: PackageSourceRoots, logger: Logger): void {
  const state = activationState();
  if (state.subscribedTo?.roots === roots) return;
  state.subscribedTo?.unsubscribe();
  state.subscribedTo = { roots, unsubscribe: roots.subscribePackageSourceRoots((projectId) => onSourceRootsChanged(projectId, logger)) };
}

/**
 * C2/R2b (pure) — select the roots to scan from brain-core's enumerated
 * package-source candidates, each paired with the source's OWNING scope. A
 * source is scanned iff it is `recognizesPackages`, enabled, local, and not the
 * default `packages` drop-zone (handled unconditionally by C3). User/agent-scoped
 * sources ARE now included (R2b): they load, and their packages carry the
 * source's scope so advertise-time isolation can hide them from other callers.
 * Deny-by-default on every OTHER axis; logs each skip when a logger is supplied.
 *
 * Exported for the floor-gate test (proves the scope is carried through, and the
 * advertise isolation — not the LOAD — is what keeps a user-scoped source private).
 */
export function selectFlaggedPackageRoots(
  roots: PackageSourceRoot[],
  logger?: Logger,
): Array<{ dir: string; ownerScope: SourceScope; uriRoot: string }> {
  const selected: Array<{ dir: string; ownerScope: SourceScope; uriRoot: string }> = [];
  for (const r of roots) {
    if (r.slug === 'packages') continue; // C3 — the default drop-zone is unconditional
    if (!r.recognizesPackages) continue;
    if (r.kind !== 'local') {
      logger?.debug?.('Skipping non-local package source', { slug: r.slug, kind: r.kind });
      continue;
    }
    if (!r.enabled) {
      logger?.debug?.('Skipping disabled package source', { slug: r.slug });
      continue;
    }
    if (!r.containerRoot) continue;
    selected.push({ dir: r.containerRoot, ownerScope: r.scope, uriRoot: r.uriRoot });
  }
  return selected;
}

/**
 * C2 — fetch the project's package-source candidates from brain-core and apply
 * the floor; arms the change subscription on first use. brain-core absent ⇒
 * only `_packages/` is active (graceful); an enumeration failure ⇒ `null`.
 */
async function listFlaggedPackageRoots(projectId: string, logger: Logger): Promise<FlaggedRoot[] | null> {
  try {
    const runtime = await getRuntime();
    await runtime.whenReady();
    const sourceRoots = runtime.services.get('package-source-roots');
    if (!sourceRoots) {
      logger.debug?.('package-source-roots unavailable — only _packages/ active', { projectId });
      return [];
    }
    armSourceRootsSubscription(sourceRoots, logger);
    const roots = await sourceRoots.listPackageSourceRoots(projectId);
    const selected = selectFlaggedPackageRoots(roots, logger);
    if (selected.length > 0) logger.debug?.('Flagged package sources active', { projectId, count: selected.length });
    return selected;
  } catch (err) {
    logger.warn('Failed to enumerate flagged package sources', { projectId, error: String(err) });
    return null;
  }
}

/**
 * Re-derive the flagged roots, then re-read EVERY scanner of a project from
 * disk and run ONE combined sync — the rescan route's path. A rescan of one
 * scanner alone would hand the sync an incomplete desired set, and its unload
 * pass would drop every package another scanner owns. Activates the project
 * first. `scanned` sums all scanners.
 */
export async function resyncProjectPackages(
  projectId: string,
): Promise<{ scanned: number; errors: PackageLoadError[] }> {
  await ensureProjectPackagesLoaded(projectId);
  const logger = getLogger().child('project-packages');
  await rederiveFlaggedRoots(projectId, logger);
  const entries = activationState().scanners.get(projectId);
  // An empty list would unload every package of the project — never sync one.
  if (!entries) throw new Error(`Project packages are not activated: ${projectId}`);
  const counts = await Promise.all(entries.map((e) => e.scanner.rescan()));
  const errors = await syncFromScanners(projectId, entries, logger);
  return { scanned: counts.reduce((sum, n) => sum + n, 0), errors };
}

/** Collect records from all of a project's scanners and run ONE combined sync. */
async function syncFromScanners(
  projectId: string,
  entries: ScannerEntry[],
  logger: Logger,
  options?: { invalidate?: boolean },
): Promise<PackageLoadError[]> {
  // Stamp the OWNING source scope (R2b) onto each record so the runtime
  // manager can isolate advertise per caller and derive the canonical instance ID.
  // `toResolvedRecord` sets `ownerScope` and the canonical `packageId` from the
  // per-scanner origin and scope (default drop zone ⇒ project scope).
  const resolved = resolveScannerRecords(projectId, entries);
  const records = await applyTrustOverrides(projectId, resolved.records);
  const sync = await getPackageRuntimeManager().syncProjectPackagesToRuntime(projectId, records, { ...options, confirmedDeleted: await confirmedDeletedInstances(projectId, entries) });
  const errors = [...resolved.skipped, ...sync.errors];
  if (records.length > 0) {
    logger.info('Project packages synced', { projectId, count: records.length });
  }
  // Surface a refused load/reload (cross-scope collision, within-sync duplicate id)
  // that the watch/activation path would otherwise drop silently.
  for (const e of errors) {
    logger.warn('Project package refused during sync', { projectId, packageId: e.packageId, error: e.error });
  }
  return errors;
}

/**
 * Clear a project's package caches WITHOUT re-scanning ("Clear cache" op):
 * drop the activation flag so the next `ensureProjectPackagesLoaded` re-activates
 * (re-scan + re-sync from disk), and clear each known scanner's record cache. The
 * existing scanner singletons + watchers are left in place — a later re-activation
 * reuses the same dir-keyed scanner instances (`getScannerForDir`); their
 * listeners are keyed by project, so re-registering replaces this project's
 * listener rather than adding a second one, and one hub watcher per directory
 * remains. Caller is responsible for invalidating the runtime snapshot.
 */
export function resetProjectPackageActivation(projectId: string): void {
  activationState().activated.delete(projectId);
  const entries = activationState().scanners.get(projectId);
  if (entries) {
    for (const { scanner } of entries) scanner.clearCache();
  }
}

/**
 * Return installed package metadata for the requested activated project.
 * The runtime's `installedPackagesProvider` (the packages overview API).
 */
export function listAllActivatedPackages(projectId?: string): InstalledPackageInfo[] {
  if (!projectId) return [];
  return resolveScannerRecords(projectId, activationState().scanners.get(projectId) ?? []).records.map((resolved) => ({
    packageId: resolved.packageId, source: resolved.sourceKind,
    installedAt: resolved.installedAt, updatedAt: resolved.updatedAt, sourceRoot: resolved.packageRoot,
  }));
}

/**
 * Every scanner record stamped with its instance identity. A record that
 * cannot form one (a directory name no instance URI may carry — `?`, `#`, `\`,
 * a control character) is skipped and named, never allowed to fail the
 * project's other packages.
 */
function resolveScannerRecords(projectId: string, entries: readonly ScannerEntry[]): { records: import('./packageRecords').ResolvedPackageRecord[]; skipped: PackageLoadError[] } {
  const records: import('./packageRecords').ResolvedPackageRecord[] = [];
  const skipped: PackageLoadError[] = [];
  for (const entry of entries) {
    for (const record of entry.scanner.listPackages()) {
      try {
        records.push(toResolvedRecord(record, projectId, entry.ownerScope, { directory: entry.scanner.packagesDir, uriRoot: entry.uriRoot }));
      } catch (error) {
        skipped.push({ packageId: record.packageId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { records, skipped };
}

/** Match against host-stamped records from every owning scanner, never a caller path. */
export async function resolveProjectPackageInstance(projectId: string, packageId: string): Promise<import('./packageRecords').ResolvedPackageRecord | null> {
  const coordinates = parsePackageInstanceId(packageId);
  if (!coordinates || coordinates.projectId !== projectId) return null;
  await ensureProjectPackagesLoaded(projectId);
  const entries = activationState().scanners.get(projectId) ?? [];
  await Promise.all(entries.map((entry) => entry.scanner.scan()));
  const record = resolveScannerRecords(projectId, entries).records.find((candidate) => candidate.packageId === packageId);
  return record ? (await applyTrustOverrides(projectId, [record]))[0] : null;
}

async function confirmedDeletedInstances(projectId: string, entries: ScannerEntry[]): Promise<string[]> {
  const project = await getProjectById(projectId);
  const candidates = new Set([...getPackageRuntimeManager().getProjectPackageIds(projectId),
    ...Object.keys(project?.packageTrust ?? {}), ...Object.keys(project?.packageAccessFeature ?? {}), ...Object.keys(project?.appliedPackageGrants ?? {}), ...Object.keys(project?.packageGrantFeatures ?? {})]);
  return [...candidates].filter((id) => {
    const coordinates = parsePackageInstanceId(id);
    if (!coordinates || coordinates.projectId !== projectId) return false;
    return entries.some((entry) => {
      const prefix = entry.uriRoot.endsWith('://') ? entry.uriRoot : `${entry.uriRoot.replace(/\/$/, '')}/`;
      if (!coordinates.originUri.startsWith(prefix)) return false;
      const rel = coordinates.originUri.slice(prefix.length);
      if (rel.includes('/')) return false;
      const root = join(entry.scanner.packagesDir, rel);
      return packageInstanceId({ originUri: coordinates.originUri, projectId, scope: entry.ownerScope }) === id && entry.scanner.isConfirmedDeleted(root);
    });
  });
}

/**
 * Apply trust overrides from ProjectRecord to resolved package records.
 * EXPORTED as the ONE copy (the project reload path uses it too): a path that
 * skipped it silently downgraded an admin-trusted drop to `untrusted` in the
 * running runtime (measured live 2026-08-15) — every path that hands records to
 * the runtime manager MUST route through here.
 */
export async function applyTrustOverrides(
  projectId: string,
  records: import('./packageRecords').ResolvedPackageRecord[],
): Promise<import('./packageRecords').ResolvedPackageRecord[]> {
  const project = await getProjectById(projectId);
  const trustOverrides = project?.packageTrust ?? {};

  return records.map((r) => {
    // Mutable trust is confined to this exact source/path/scope instance.
    const override = trustOverrides[r.packageId];
    if (override === 'trusted') {
      return {
        ...r,
        definition: {
          ...r.definition,
          access: { ...r.definition.access, trust: 'trusted' as const },
        },
      };
    }
    return r;
  });
}
