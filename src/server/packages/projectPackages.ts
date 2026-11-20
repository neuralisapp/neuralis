/**
 * Per-project package activation.
 *
 * Lazily scans and loads each project's packages — its `_packages/` drop zone
 * while the `packages` source is on, and every package folder of an enabled
 * source — when first accessed, and lists the package folders of its
 * switched-off sources without loading them. Multiple projects can be active simultaneously — each gets its own scanner
 * and watcher, and their packages are tracked separately in the runtime.
 */

import { isPackageFolderPath, packageInstanceId, parsePackageInstanceId } from '@neuralis/package-system/contracts';
import { join } from 'node:path';
import { resolveProjectRoot } from '@neuralis/package-system/paths';
import { getEnv } from '../config/env';
import { getLogger } from '../logging/setup';
import { stat } from 'node:fs/promises';
import { getScannerForDir, readPackageFolderManifests, type PackageFolderManifest, type ProjectPackageScanner } from './ProjectPackageScanner';
import { getPackageRuntimeManager, type PackageLoadError } from './PackageRuntimeManager';
import { packageFolderInstance, toResolvedRecord } from './packageRecords';
import { getProjectById } from '../store/ProjectStore';
import { getRuntime } from '../host/bootstrap';
import type { InstalledPackageInfo, PackageReader, SourcePlane, SourceScope, PackageSourceRoot, PackageSourceRoots } from '@neuralis/package-system/contracts';

type Logger = ReturnType<ReturnType<typeof getLogger>['child']>;

/**
 * Which kind of root a scanner reads: the project's `_packages/` drop zone
 * (its fixed path, created when missing) or a source's package folder.
 */
type RootKind = 'drop' | 'folder';
/**
 * A scanner paired with the owning SOURCE scope of the directory it scans
 * (R2b). The default `_packages/` drop-zone is `{ kind: 'project' }`; a
 * source's package folder carries that source's own project/user/agent scope.
 * The scope is stamped onto every record so the runtime can isolate advertise.
 */
type ScannerEntry = { kind: RootKind; scanner: ProjectPackageScanner; ownerScope: SourceScope; plane: SourcePlane; uriRoot: string; device?: string };
/** A folder to scan; `reader` present ⇒ a device folder read over its link (`dir` is its path there, `device` its id). `plane` is the source's own. */
type FlaggedRoot = { kind: RootKind; dir: string; ownerScope: SourceScope; plane: SourcePlane; uriRoot: string; reader?: PackageReader; device?: string };
/** A package folder of a switched-OFF source on this disk: listed from its manifests, never scanned or loaded. */
type DisabledFolder = { sourceSlug: string; dir: string; ownerScope: SourceScope; uriRoot: string };
/** One enumeration of the project's package roots: what loads, and what is listed only. */
type PackageRoots = { roots: FlaggedRoot[]; disabled: DisabledFolder[] };
/** A listed package folder of a switched-OFF source, under the instance id it loads as when the source is on. */
export type DisabledPackageRow = { packageId: string; sourceSlug: string; name: string; version?: string; originUri: string; ownerScope: SourceScope };

/** After an enumeration failure, the next activation attempt of that project waits this long. */
const ENUMERATION_RETRY_MS = 5_000;

type ActivationState = {
  /** Projects scanned + synced + watching. */
  activated: Set<string>;
  /** In-flight activations, so concurrent callers share one. */
  pending: Map<string, Promise<void>>;
  /**
   * All package scanners per activated project (the `_packages/` drop zone
   * first while its source is on, then each source's package folders), each paired with its owning
   * source scope. The source of truth for re-collecting records on any sync and
   * for the installed-packages overview.
   */
  scanners: Map<string, ScannerEntry[]>;
  /** Per-project chain, so two source changes never re-derive one list concurrently. */
  rederiving: Map<string, Promise<boolean>>;
  /** The source-roots provider the change subscription is armed on (once per runtime). */
  subscribedTo: { roots: PackageSourceRoots; unsubscribe: () => void } | null;
  /** When a project's activation last found its sources unreadable — the retry is spaced from it. */
  failedAt: Map<string, number>;
  /** Per project: the listed package folders of its switched-off sources. */
  disabledRows: Map<string, DisabledPackageRow[]>;
  /** Per project, per disabled folder: its manifests at the folder's last mtime. Dropped on a source change. */
  disabledManifests: Map<string, Map<string, { mtimeMs: number; manifests: PackageFolderManifest[] }>>;
};

const GLOBAL_KEY = '__neuralis_project_package_activation__' as const;

// ONE copy per process, like the runtime manager and the scanner map: the
// server bundles each evaluate this module, and a per-bundle list would let one
// route's sync unload the packages another route's list loaded.
function activationState(): ActivationState {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      activated: new Set(), pending: new Map(), scanners: new Map(), rederiving: new Map(), subscribedTo: null,
      failedAt: new Map(), disabledRows: new Map(), disabledManifests: new Map(),
    } satisfies ActivationState;
  }
  return g[GLOBAL_KEY] as ActivationState;
}

/**
 * Ensure a project's packages are scanned, loaded into the runtime, and
 * watched for changes. Idempotent — subsequent calls are instant no-ops. A
 * project whose sources could not be read is not activated; the next attempt
 * runs at the first call {@link ENUMERATION_RETRY_MS} after the failure.
 */
export async function ensureProjectPackagesLoaded(projectId: string): Promise<void> {
  const state = activationState();
  if (state.activated.has(projectId)) return;
  const failedAt = state.failedAt.get(projectId);
  if (failedAt !== undefined && Date.now() - failedAt < ENUMERATION_RETRY_MS) return;

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
  const logger = getLogger().child('project-packages');
  const state = activationState();

  // The drop zone and every package folder of an enabled source this process
  // opens, each carrying its source's OWN project/user/agent scope. The
  // packages LOAD here; the per-caller advertise isolation (only the owning
  // user/agent sees them) is enforced downstream at the snapshot + stream
  // boundary via the stamped `ownerScope`. Unreadable sources load nothing
  // and leave the project unactivated — a switched-off `packages` source must
  // not load its drop because brain-core could not answer.
  const plan = await listPackageRoots(projectId, logger);
  if (plan === null) {
    state.failedAt.set(projectId, Date.now());
    return;
  }
  state.failedAt.delete(projectId);
  const entries = plan.roots.map((root) => entryFor(projectId, root, logger));

  // A re-activation (after clear-cache) drops this project's listener from a
  // scanner the new list no longer holds.
  const previous = activationState().scanners.get(projectId) ?? [];
  activationState().scanners.set(projectId, entries);
  await releaseDropped(projectId, previous, entries);

  // Initial scan of every scanner, then ONE combined sync (the runtime manager
  // unloads packages no longer present, so all records must arrive together).
  await Promise.all(entries.map((e) => e.scanner.scan()));
  await syncFromScanners(projectId, entries, logger, { invalidate: true });
  await refreshDisabledRows(projectId, plan.disabled);

  for (const entry of entries) watchEntry(projectId, entry, logger);

  activationState().activated.add(projectId);
}

/** The scanner entry of a root — one scanner per resolved dir (a device folder: per instance). */
function entryFor(projectId: string, root: FlaggedRoot, logger: Logger): ScannerEntry {
  const scanner = getScannerForDir(root.dir, logger, root.reader, { projectId, scope: root.ownerScope, uriRoot: root.uriRoot });
  return { kind: root.kind, scanner, ownerScope: root.ownerScope, plane: root.plane, uriRoot: root.uriRoot, ...(root.device ? { device: root.device } : {}) };
}

/**
 * Each scanner watches its own root; any change re-collects records from ALL
 * of the project's scanners (the scanner has already rescanned itself before
 * this fires). The list is read AT FIRE TIME, so a source added since never
 * has its packages unloaded by a sync from an older list.
 */
function watchEntry(projectId: string, { kind, scanner }: ScannerEntry, logger: Logger): void {
  scanner.startWatching(projectId, () => {
    const entries = activationState().scanners.get(projectId);
    if (!entries) return;
    syncFromScanners(projectId, entries, logger).catch((err) =>
      logger.warn('Watch-triggered package sync failed', { projectId, error: String(err) }),
    );
  }, { createRoot: kind === 'drop' });
}

async function releaseDropped(projectId: string, previous: readonly ScannerEntry[], next: readonly ScannerEntry[]): Promise<void> {
  const kept = new Set(next.map((e) => e.scanner));
  for (const scanner of new Set(previous.map((e) => e.scanner))) {
    if (!kept.has(scanner)) await scanner.removeListener(projectId);
  }
}

const rootKey = (root: Pick<FlaggedRoot, 'kind' | 'dir' | 'ownerScope' | 'plane' | 'uriRoot' | 'reader'>): string =>
  JSON.stringify([root.kind, root.dir, root.ownerScope, root.plane, root.uriRoot, root.reader?.id ?? 'local']);

/**
 * Re-derive an activated project's package roots — the drop zone included,
 * keyed like every other root — and apply only the difference: a new root is
 * scanned and watched, a removed or switched-off one loses this project's
 * listener. An unchanged set touches no disk beyond the one listing and the
 * listed folders' mtimes. Returns whether the scanner list changed; the caller syncs.
 */
function rederiveFlaggedRoots(projectId: string, logger: Logger): Promise<boolean> {
  const state = activationState();
  // The previous run's own caller receives its rejection; this one only waits its turn.
  const turn = (state.rederiving.get(projectId) ?? Promise.resolve(false)).then(() => undefined, () => undefined);
  const run = turn.then(async () => {
    const current = state.scanners.get(projectId);
    if (!current) return false;
    const desired = await listPackageRoots(projectId, logger);
    if (desired === null) return false; // an unreadable inventory never drops a loaded source
    await refreshDisabledRows(projectId, desired.disabled);
    const held = new Map(current.map((e) => [rootKey({ ...e, dir: e.scanner.packagesDir, reader: e.scanner.reader }), e]));
    const wanted = new Map(desired.roots.map((root) => [rootKey(root), root]));
    if (held.size === wanted.size && [...wanted.keys()].every((key) => held.has(key))) return false;
    const next: ScannerEntry[] = [...wanted].map(([key, root]) => held.get(key) ?? entryFor(projectId, root, logger));
    const added = next.filter((e) => !current.includes(e));
    state.scanners.set(projectId, next);
    await Promise.all(added.map((e) => e.scanner.scan()));
    for (const entry of added) watchEntry(projectId, entry, logger);
    await releaseDropped(projectId, current, next);
    logger.info('Package roots re-derived', { projectId, added: added.length, dropped: current.filter((e) => !next.includes(e)).length });
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
  state.disabledManifests.delete(projectId);
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
 * C2/R2b (pure) — select the folders to scan from brain-core's enumerated
 * package-source candidates, each paired with the source's OWNING scope. A
 * folder is scanned iff its source lists it in `packageFolders` (each entry
 * re-checked here with the kernel's `isPackageFolderPath` before it is joined
 * onto a root), is enabled, has a root THIS process opens (`containerRoot`: an
 * in-process folder, or a device folder on this machine's own disk that
 * brain-core and agent-core judged loadable) OR a `device` reader (another
 * device's folder, or any device's from inside a container — read over its
 * link, one reader per package folder), and is not the default `packages`
 * drop-zone (its fixed path, `listPackageRoots`). User/agent-scoped sources
 * ARE included (R2b): they load, and their packages carry the source's scope so
 * advertise-time isolation can hide them from other callers. Loading is never
 * execution: a package from any non-native root keeps only its declarative
 * and WASM contributions (the loader's DISCOVERY-IS-NOT-EXECUTION demote).
 * Deny-by-default on every OTHER axis; logs each skip when a logger is supplied.
 *
 * Exported for the floor-gate test (proves the scope is carried through, and the
 * advertise isolation — not the LOAD — is what keeps a user-scoped source private).
 */
export function selectFlaggedPackageRoots(
  roots: PackageSourceRoot[],
  logger?: Logger,
): FlaggedRoot[] {
  const selected: FlaggedRoot[] = [];
  for (const r of roots) {
    if (r.slug === DROP_SOURCE_SLUG) continue; // the drop zone is read from its fixed path (`listPackageRoots`)
    if (r.packageFolders.length === 0) continue;
    if (!r.enabled) {
      logger?.debug?.('Skipping disabled package source', { slug: r.slug });
      continue;
    }
    if (!r.containerRoot && !r.device) {
      logger?.debug?.('Skipping package source with no root this host can read', { slug: r.slug, kind: r.kind });
      continue;
    }
    for (const folder of r.packageFolders) {
      if (!isPackageFolderPath(folder)) {
        logger?.warn('Skipping a package folder that is not source-relative', { slug: r.slug });
        continue;
      }
      const uriRoot = folder ? `${r.uriRoot}${folder}` : r.uriRoot;
      if (r.containerRoot) {
        selected.push({ kind: 'folder', dir: folder ? join(r.containerRoot, ...folder.split('/')) : r.containerRoot, ownerScope: r.scope, plane: r.plane, uriRoot });
        continue;
      }
      if (!r.device) continue;
      try {
        const opened = r.device.openReader(folder);
        selected.push({ kind: 'folder', dir: opened.root, ownerScope: r.scope, plane: r.plane, uriRoot, reader: opened.reader, device: r.device.id });
      } catch (error) {
        logger?.warn('Skipping a device package folder that cannot be opened', { slug: r.slug, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return selected;
}

/** The source whose switch the `_packages/` drop zone follows. */
const DROP_SOURCE_SLUG = 'packages';

/**
 * (pure) The package folders of switched-OFF sources this process reads on
 * its own disk — listed, never loaded. The drop zone is not here (it follows
 * its source in `listPackageRoots`); a device folder of a switched-off source
 * has no reader, so it lists nothing.
 */
export function selectDisabledPackageFolders(roots: PackageSourceRoot[]): DisabledFolder[] {
  const folders: DisabledFolder[] = [];
  for (const r of roots) {
    if (r.enabled || r.slug === DROP_SOURCE_SLUG || !r.containerRoot) continue;
    for (const folder of r.packageFolders) {
      if (!isPackageFolderPath(folder)) continue;
      folders.push({
        sourceSlug: r.slug,
        dir: folder ? join(r.containerRoot, ...folder.split('/')) : r.containerRoot,
        ownerScope: r.scope,
        uriRoot: folder ? `${r.uriRoot}${folder}` : r.uriRoot,
      });
    }
  }
  return folders;
}

/**
 * The project's package roots from brain-core's enumerated package sources,
 * arming the change subscription on first use. The `_packages/` drop zone
 * (fixed path, project scope) follows the `packages` source's switch: it
 * loads when no source-roots service exists (a generic host) or the project
 * has no `packages` source, and is listed only while that source is off. An
 * enumeration failure answers `null` — the caller loads nothing new.
 */
async function listPackageRoots(projectId: string, logger: Logger): Promise<PackageRoots | null> {
  const dropDir = join(resolveProjectRoot(getEnv().projectsRoot, projectId), '_packages');
  const drop: FlaggedRoot = { kind: 'drop', dir: dropDir, ownerScope: { kind: 'project' }, plane: 'local', uriRoot: 'packages://' };
  try {
    const runtime = await getRuntime();
    await runtime.whenReady();
    const sourceRoots = runtime.services.get('package-source-roots');
    if (!sourceRoots) {
      logger.debug?.('package-source-roots unavailable — only _packages/ active', { projectId });
      return { roots: [drop], disabled: [] };
    }
    armSourceRootsSubscription(sourceRoots, logger);
    const rows = await sourceRoots.listPackageSourceRoots(projectId);
    const dropOn = rows.find((r) => r.slug === DROP_SOURCE_SLUG)?.enabled !== false;
    const flagged = selectFlaggedPackageRoots(rows, logger);
    if (flagged.length > 0) logger.debug?.('Flagged package sources active', { projectId, count: flagged.length });
    return {
      roots: dropOn ? [drop, ...flagged] : flagged,
      disabled: [
        ...(dropOn ? [] : [{ sourceSlug: DROP_SOURCE_SLUG, dir: dropDir, ownerScope: drop.ownerScope, uriRoot: drop.uriRoot }]),
        ...selectDisabledPackageFolders(rows),
      ],
    };
  } catch (err) {
    logger.warn('Failed to enumerate flagged package sources', { projectId, error: String(err) });
    return null;
  }
}

/**
 * Re-list the switched-off folders' packages. A folder whose mtime has not
 * moved reuses its last manifests (a source change drops them all); a missing
 * folder lists nothing. A folder that cannot form an instance id is skipped,
 * like the scanner skips it.
 */
async function refreshDisabledRows(projectId: string, folders: readonly DisabledFolder[]): Promise<void> {
  const state = activationState();
  const previous = state.disabledManifests.get(projectId);
  const cache = new Map<string, { mtimeMs: number; manifests: PackageFolderManifest[] }>();
  const rows: DisabledPackageRow[] = [];
  for (const folder of folders) {
    const mtimeMs = await stat(folder.dir).then((s) => s.mtimeMs, () => null);
    if (mtimeMs === null) continue;
    const key = rootKey({ kind: 'folder', dir: folder.dir, ownerScope: folder.ownerScope, plane: 'local', uriRoot: folder.uriRoot });
    const held = previous?.get(key);
    const manifests = held?.mtimeMs === mtimeMs ? held.manifests : await readPackageFolderManifests(folder.dir);
    cache.set(key, { mtimeMs, manifests });
    for (const manifest of manifests) {
      try {
        const { packageId, originUri } = packageFolderInstance(manifest, projectId, folder.ownerScope, { directory: folder.dir, uriRoot: folder.uriRoot });
        rows.push({ packageId, sourceSlug: folder.sourceSlug, name: manifest.name, ...(manifest.version ? { version: manifest.version } : {}), originUri, ownerScope: folder.ownerScope });
      } catch { /* a folder name no instance URI can carry — the scanner skips it too */ }
    }
  }
  state.disabledManifests.set(projectId, cache);
  state.disabledRows.set(projectId, rows);
}

/**
 * The listed package folders of the project's switched-off sources (no disk
 * read). The host's own listing shows a row only where the caller's session
 * reads the source at source level and the folder's manifest on the path axis
 * (`loadVisibleDisabledPackageIds`).
 */
export function listDisabledPackageRows(projectId: string): readonly DisabledPackageRow[] {
  return activationState().disabledRows.get(projectId) ?? [];
}

/**
 * Re-derive the package roots, then re-read EVERY scanner of a project from
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
  activationState().disabledManifests.delete(projectId);
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
  const loaded: InstalledPackageInfo[] = resolveScannerRecords(projectId, activationState().scanners.get(projectId) ?? []).records.map((resolved) => ({
    packageId: resolved.packageId, source: resolved.sourceKind,
    installedAt: resolved.installedAt, updatedAt: resolved.updatedAt, sourceRoot: resolved.packageRoot,
  }));
  // A switched-off source's folders: never loaded, listed under the id they load as.
  const listed = listDisabledPackageRows(projectId).map((row): InstalledPackageInfo => ({
    packageId: row.packageId, source: 'local-dir', sourceDisabled: true, sourceSlug: row.sourceSlug,
  }));
  return [...loaded, ...listed];
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
        records.push(toResolvedRecord(record, projectId, entry.ownerScope, { directory: entry.scanner.packagesDir, uriRoot: entry.uriRoot, plane: entry.plane }));
      } catch (error) {
        skipped.push({ packageId: record.packageId, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { records, skipped };
}

/**
 * The paired device an activated package's origin lives on — the id of the
 * device folder whose scanner contributed it — or undefined (this server).
 * Read from the activation state, no disk read; an offline device's package
 * still names its device.
 */
export function packageOriginDevice(projectId: string, originUri: string): string | undefined {
  return deviceOfOrigin(activationState().scanners.get(projectId) ?? [], originUri);
}

/** The device of the scanner whose root holds `originUri` (a segment boundary, never a bare prefix). */
export function deviceOfOrigin(entries: readonly { uriRoot: string; device?: string }[], originUri: string): string | undefined {
  for (const entry of entries) {
    if (!entry.device) continue;
    const base = entry.uriRoot;
    const under = base.endsWith('://') || base.endsWith('/') ? originUri.startsWith(base) : originUri === base || originUri.startsWith(`${base}/`);
    if (under) return entry.device;
  }
  return undefined;
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
