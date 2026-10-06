/**
 * Shared host-side package-runtime mutations — the SINGLE source of truth for
 * "rescan this project's packages" and "clear this project's package caches".
 *
 * Two entrypoints call these:
 *   1. The host Next route `POST /api/packages/rescan` (cookie session).
 *   2. The admin package's `hostPorts.packageMaintenance` methods — reached by
 *      its dashboard "Rescan packages" / "Clear cache" buttons and the
 *      `manage-cache-and-rescan` skill through the admin routes.
 *
 * The FLOOR is `canManagePackages`, re-derived FRESH from the project store on
 * every call (never the ticket's cached `grantedFeatures`) — so the host route,
 * the admin route, and the skill all enforce IDENTICALLY (deny-by-default).
 * projectId resolution is each entrypoint's OWN concern; this module keys on a
 * plain `(userId, projectId)`.
 */

import { getPackageRuntimeManager, type PackageLoadError } from './PackageRuntimeManager';
import { resetProjectPackageActivation, resyncProjectPackages } from './projectPackages';
import { canManagePackages, resolveProjectAccess } from '../projects/access';

/** Result of a successful {@link rescanProjectPackages} call (keystone-lattice parity). */
export type PackageRescanResult = {
  scanned: number;
  /** Per-package load failures (a bad `x-neuralis`, etc.) — surfaced, never silently dropped. */
  packageErrors?: PackageLoadError[];
};

/**
 * Thrown when the caller fails the FRESH `canManagePackages` floor. Carries a
 * stable `code` so both the host Next route (`instanceof`) and the admin package
 * route (duck-typed `code`, since admin cannot import host code) map it to 403.
 */
export class PackageManageForbiddenError extends Error {
  readonly code = 'package_manage_forbidden';
  constructor(message = 'Forbidden: package management permission required') {
    super(message);
    this.name = 'PackageManageForbiddenError';
  }
}

/** Re-derive `canManagePackages` FRESH from the project store (FIX-2 floor). */
async function assertCanManagePackages(userId: string, projectId: string): Promise<void> {
  const access = await resolveProjectAccess(userId, projectId);
  if (!access || !canManagePackages(access)) {
    throw new PackageManageForbiddenError();
  }
}

/**
 * Rescan EVERY package scanner of a project — the `_packages/` drop-zone and
 * each `recognizesPackages` source — and re-sync the result into the runtime
 * (`resyncProjectPackages`, which also applies the trust overrides). Eager:
 * re-reads disk immediately. Returns `{ scanned, packageErrors? }`, `scanned`
 * summed over all scanners. Throws {@link PackageManageForbiddenError} on
 * access denial.
 */
export async function rescanProjectPackages(userId: string, projectId: string): Promise<PackageRescanResult> {
  await assertCanManagePackages(userId, projectId);
  const { scanned, errors } = await resyncProjectPackages(projectId);
  return {
    scanned,
    ...(errors.length > 0 ? { packageErrors: errors } : {}),
  };
}

/**
 * Clear a single project's in-memory package caches WITHOUT a disk reload — a
 * REAL, lighter, LAZY counterpart to {@link rescanProjectPackages}: it drops the
 * project's activation flag + each scanner's record cache (so the NEXT package
 * access re-scans disk from scratch) and invalidates the runtime snapshot (so the
 * next snapshot read recomputes). Distinct from rescan, which re-scans eagerly
 * right now. Throws {@link PackageManageForbiddenError} on access denial.
 */
export async function clearProjectPackageCaches(userId: string, projectId: string): Promise<void> {
  await assertCanManagePackages(userId, projectId);

  const manager = getPackageRuntimeManager();
  await manager.ensureInitialized();
  const affected = [...manager.getProjectPackageIds(projectId)];

  // Drop activation + scanner record caches → next access re-reads disk lazily.
  resetProjectPackageActivation(projectId);
  // Drop the runtime snapshot → next snapshot read recomputes from the registry.
  manager.invalidateRuntime('manual', affected.length > 0 ? affected : undefined);
}
