/**
 * Per-project package activation.
 *
 * Lazily scans and loads `_packages/` for each project when first accessed.
 * Multiple projects can be active simultaneously — each gets its own scanner
 * and watcher, and their packages are tracked separately in the runtime.
 */

import { resolveProjectRoot } from '@neuralis/package-system/paths';
import { getEnv } from '../config/env';
import { getLogger } from '../logging/setup';
import { getProjectPackageScanner, getScannerForDir, type ProjectPackageScanner } from './ProjectPackageScanner';
import { getPackageRuntimeManager, type PackageLoadError } from './PackageRuntimeManager';
import { toResolvedRecord } from './packageRecords';
import { getProjectById } from '../store/ProjectStore';
import { getRuntime } from '../host/bootstrap';
import type { InstalledPackageInfo, SourceScope, PackageSourceRoot } from '@neuralis/package-system/contracts';

type Logger = ReturnType<ReturnType<typeof getLogger>['child']>;

/**
 * A scanner paired with the owning SOURCE scope of the directory it scans
 * (R2b). The default `_packages/` drop-zone is `{ kind: 'project' }`; a
 * `recognizesPackages`-flagged source carries its own project/user/agent scope.
 * The scope is stamped onto every record so the runtime can isolate advertise.
 */
type ScannerEntry = { scanner: ProjectPackageScanner; ownerScope: SourceScope };

type ActivationState = {
  /** Projects scanned + synced + watching. */
  activated: Set<string>;
  /** In-flight activations, so concurrent callers share one. */
  pending: Map<string, Promise<void>>;
  /**
   * All package scanners per activated project (default `_packages/` + each
   * `recognizesPackages`-flagged source), each paired with its owning source
   * scope. The source of truth for re-collecting records on any sync and for
   * the installed-packages overview.
   */
  scanners: Map<string, ScannerEntry[]>;
};

const GLOBAL_KEY = '__neuralis_project_package_activation__' as const;

// ONE copy per process, like the runtime manager and the scanner map: the
// server bundles each evaluate this module, and a per-bundle list would let one
// route's sync unload the packages another route's list loaded.
function activationState(): ActivationState {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { activated: new Set(), pending: new Map(), scanners: new Map() } satisfies ActivationState;
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
  entries.push({ scanner: getProjectPackageScanner(projectRoot, logger), ownerScope: { kind: 'project' } });

  // C2/R2b — source-driven: in ADDITION, any enabled, local source flagged
  // `recognizesPackages` gets its own scanner, carrying the source's OWN
  // project/user/agent scope. The packages LOAD here; the per-caller advertise
  // isolation (only the owning user/agent sees them) is enforced downstream at
  // the snapshot + stream boundary via the stamped `ownerScope`.
  for (const { dir, ownerScope } of await listFlaggedPackageRoots(projectId, logger)) {
    entries.push({ scanner: getScannerForDir(dir, logger), ownerScope });
  }

  activationState().scanners.set(projectId, entries);

  // Initial scan of every scanner, then ONE combined sync (the runtime manager
  // unloads packages no longer present, so all records must arrive together).
  await Promise.all(entries.map((e) => e.scanner.scan()));
  await syncFromScanners(projectId, entries, logger, { invalidate: true });

  // Each scanner watches its own root; any change re-collects records from ALL
  // scanners (the scanner has already rescanned itself before this fires). The
  // list is read AT FIRE TIME: a re-activation (after clear-cache) may add a
  // newly flagged source while the old watchers keep their callbacks, and a
  // sync from the old list would unload the new source's packages.
  for (const { scanner } of entries) {
    scanner.startWatching(() => {
      syncFromScanners(projectId, activationState().scanners.get(projectId) ?? entries, logger).catch((err) =>
        logger.warn('Watch-triggered package sync failed', { projectId, error: String(err) }),
      );
    });
  }

  activationState().activated.add(projectId);
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
): Array<{ dir: string; ownerScope: SourceScope }> {
  const selected: Array<{ dir: string; ownerScope: SourceScope }> = [];
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
    selected.push({ dir: r.containerRoot, ownerScope: r.scope });
  }
  return selected;
}

/**
 * C2 — fetch the project's package-source candidates from brain-core and apply
 * the floor. brain-core absent ⇒ only `_packages/` is active (graceful).
 */
async function listFlaggedPackageRoots(
  projectId: string,
  logger: Logger,
): Promise<Array<{ dir: string; ownerScope: SourceScope }>> {
  try {
    const runtime = await getRuntime();
    await runtime.whenReady();
    const sourceRoots = runtime.services.get('package-source-roots');
    if (!sourceRoots) {
      logger.debug?.('package-source-roots unavailable — only _packages/ active', { projectId });
      return [];
    }
    const roots = await sourceRoots.listPackageSourceRoots(projectId);
    const selected = selectFlaggedPackageRoots(roots, logger);
    if (selected.length > 0) logger.info('Flagged package sources active', { projectId, count: selected.length });
    return selected;
  } catch (err) {
    logger.warn('Failed to enumerate flagged package sources', { projectId, error: String(err) });
    return [];
  }
}

/**
 * Re-read EVERY scanner of a project from disk and run ONE combined sync — the
 * rescan route's path. A rescan of one scanner alone would hand the sync an
 * incomplete desired set, and its unload pass would drop every package another
 * scanner owns. Activates the project first. `scanned` sums all scanners.
 */
export async function resyncProjectPackages(
  projectId: string,
): Promise<{ scanned: number; errors: PackageLoadError[] }> {
  await ensureProjectPackagesLoaded(projectId);
  const logger = getLogger().child('project-packages');
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
  const records = await applyTrustOverrides(
    projectId,
    // Stamp the OWNING source scope (R2b) onto each record so the runtime
    // manager can isolate advertise per caller AND scope-namespace the loader id.
    // `toResolvedRecord` sets `ownerScope` + the namespaced `packageId` from the
    // per-scanner scope (default `_packages/` scanner ⇒ `{ kind: 'project' }`).
    entries.flatMap((e) =>
      e.scanner.listPackages().map((rec) => toResolvedRecord(rec, projectId, e.ownerScope)),
    ),
  );
  const { errors } = await getPackageRuntimeManager().syncProjectPackagesToRuntime(projectId, records, options);
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
 * reuses the same dir-keyed scanner instances (`getScannerForDir`) and
 * `startWatching` no-ops while a watcher is live, so no duplicate watchers form.
 * Caller is responsible for invalidating the runtime snapshot.
 */
export function resetProjectPackageActivation(projectId: string): void {
  activationState().activated.delete(projectId);
  const entries = activationState().scanners.get(projectId);
  if (entries) {
    for (const { scanner } of entries) scanner.clearCache();
  }
}

/**
 * Aggregate installed package metadata across all activated projects.
 * The runtime's `installedPackagesProvider` (the packages overview API).
 */
export function listAllActivatedPackages(): InstalledPackageInfo[] {
  const result: InstalledPackageInfo[] = [];

  for (const entries of activationState().scanners.values()) {
    for (const { scanner } of entries) {
      for (const record of scanner.listPackages()) {
        result.push({
          packageId: record.packageId,
          source: record.definition.source?.kind ?? 'local-dir',
          installedAt: record.discoveredAt,
          updatedAt: record.discoveredAt,
          sourceRoot: record.packageRoot,
        });
      }
    }
  }

  return result;
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
    // Trust overrides are admin-set by the MANIFEST id (stable across scope), not
    // the namespaced loader id.
    const override = trustOverrides[r.manifestId];
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
