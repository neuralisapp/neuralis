/**
 * Shared host-side project-package governance — the SINGLE source of truth for
 * rescanning a project's packages, clearing its package caches, listing its
 * packages, pinning a package's trust, building a WASM package and attaching
 * a package's access feature.
 *
 * Two doors call each body:
 *   1. The host Next routes (cookie session): `POST /api/packages/rescan` and
 *      `/api/projects/:id/packages[/:package/{trust,build,access-feature}]`.
 *   2. The admin package's `hostPorts.packageMaintenance` methods — its
 *      dashboard buttons, the `manage-cache-and-rescan` skill, an agent's
 *      session and the CLI reach them through the admin routes.
 *
 * The FLOOR is `canManagePackages`, re-derived FRESH from the project store on
 * every call (never the ticket's cached `grantedFeatures`) — so every door
 * enforces IDENTICALLY (deny-by-default). A package the caller cannot reach at
 * write strength is refused exactly like an absent one (404, no existence
 * oracle). projectId resolution is each entrypoint's OWN concern; this module
 * keys on a plain `(userId, projectId)`.
 */

import { collectAllFeatures } from '@neuralis/package-system';
import { canAccessScope, parsePackageInstanceId } from '@neuralis/package-system/contracts';
import type { InviteLinkProvenance, PackageTrust, ProjectPackageBuildResult, ProjectPackageRow } from '@neuralis/package-system/contracts';
import { buildWasmPackage, hasSourceCode, hasWasmToolchain } from '@neuralis/package-system/runtime/wasm-build';
import { getPackageRuntimeManager, type PackageLoadError } from './PackageRuntimeManager';
import {
  ensureProjectPackagesLoaded,
  listAllActivatedPackages,
  packageOriginDevice,
  resetProjectPackageActivation,
  resolveProjectPackageInstance,
  resyncProjectPackages,
} from './projectPackages';
import { getCommunityPackageRegistry } from './runtime';
import { BUILTIN_PACKAGE_IDS, resolveGuestPdkPath } from '../host/builtinSlots';
import { getLogger } from '../logging/setup';
import { setPackageAccessFeature as storeAccessFeature, setPackageTrust as storeTrust } from '../store/ProjectStore';
import { writeAuditLog } from '../store/AuditStore';
import { canManagePackages, resolveProjectAccess, type ProjectAccessContext } from '../projects/access';

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

/**
 * Any other refusal of a package operation: a stable `code` and the HTTP
 * `status` each door answers with (a 404 for a package the caller cannot
 * reach, a 400 for a value the operation does not take).
 */
export class PackageOpRefusal extends Error {
  constructor(readonly status: 400 | 404, readonly code: string, message: string) {
    super(message);
    this.name = 'PackageOpRefusal';
  }
}

/** Re-derive `canManagePackages` FRESH from the project store (FIX-2 floor). */
async function assertCanManagePackages(userId: string, projectId: string): Promise<ProjectAccessContext> {
  const access = await resolveProjectAccess(userId, projectId);
  if (!access || !canManagePackages(access)) {
    throw new PackageManageForbiddenError();
  }
  return access;
}

/** The call's provenance on an audit row — never an authority. */
function auditVia(via: InviteLinkProvenance): Record<string, string> {
  if (via.interactive) return { via: 'person' };
  return via.agentId ? { via: 'agent', agentId: via.agentId } : { via: 'cli' };
}

/**
 * A project package the caller may change: resolved from the host-stamped
 * records (never a caller path), and refused like an absent one when its
 * owning scope is out of the caller's WRITE reach.
 */
async function reachablePackage(access: ProjectAccessContext, projectId: string, packageId: string) {
  const record = await resolveProjectPackageInstance(projectId, packageId);
  if (!record?.packageRoot || !canAccessScope(record.ownerScope ?? { kind: 'project' }, access.session, 'write', record.ownerOrigin)) {
    throw new PackageOpRefusal(404, 'package_not_found', `Package "${packageId}" not found in this project.`);
  }
  return record;
}

/**
 * Rescan EVERY package scanner of a project — the `_packages/` drop-zone and
 * each source package folder — and re-sync the result into the runtime
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

/**
 * Every package of the project the caller's scope may READ — the `_packages/`
 * drop zone, each source package folder and the native packages (whose only
 * per-project setting is the access feature) — from what is loaded now: the
 * scanner records and the runtime's host-stamped definitions, no disk read.
 */
export async function listProjectPackageRows(userId: string, projectId: string): Promise<ProjectPackageRow[]> {
  const access = await assertCanManagePackages(userId, projectId);
  await ensureProjectPackagesLoaded(projectId);
  const manager = getPackageRuntimeManager();
  const registry = getCommunityPackageRegistry();
  const loader = manager.getLoader();
  const trustOverrides = access.project.packageTrust ?? {};
  const featureOverrides = access.project.packageAccessFeature ?? {};
  const rows: ProjectPackageRow[] = [];
  // Asked once per listing, and only when a row needs a build.
  let toolchain: boolean | undefined;
  const buildState = (): 'ready' | 'toolchain-missing' => ((toolchain ??= hasWasmToolchain()) ? 'ready' : 'toolchain-missing');
  const row = (id: string, trust: PackageTrust, slot: ProjectPackageRow['slot'], origin: string): ProjectPackageRow | null => {
    const definition = registry.getPackage(id);
    if (!definition) return null;
    const status = loader.getStatus(id);
    const needsBuild = definition.runtime?.type === 'wasm' && status?.status === 'partial' && status.reason === 'build-missing';
    const override = featureOverrides[id];
    const manifestFeature = definition.requires?.accessFeature;
    return {
      id,
      name: definition.name || id,
      ...(definition.version ? { version: definition.version } : {}),
      ...(definition.description ? { description: definition.description } : {}),
      slot,
      origin,
      trust,
      ...(trustOverrides[id] ? { trustOverride: trustOverrides[id] } : {}),
      ...(definition.runtime?.type ? { runtime: definition.runtime.type } : {}),
      status: !status ? 'loading' : status.status === 'partial' ? 'partial' : status.status === 'error' ? 'error' : 'loaded',
      ...(status?.status === 'partial' ? { partialReason: status.reason ?? 'runtime-unavailable' } : {}),
      ...(needsBuild ? { build: buildState() } : {}),
      ownerScope: manager.getPackageOwnerScope(projectId, id) ?? { kind: 'project' },
      ...(override ? { accessFeature: { feature: override, source: 'override' as const } } : manifestFeature ? { accessFeature: { feature: manifestFeature, source: 'manifest' as const } } : {}),
    };
  };
  for (const info of listAllActivatedPackages(projectId)) {
    const ownerScope = manager.getPackageOwnerScope(projectId, info.packageId) ?? { kind: 'project' as const };
    // A member's or another agent's package is absent, never marked, for a caller outside that scope.
    if (!canAccessScope(ownerScope, access.session, 'read', manager.getPackageOwnerOrigin(projectId, info.packageId))) continue;
    const origin = parsePackageInstanceId(info.packageId)?.originUri ?? info.packageId;
    const definition = registry.getPackage(info.packageId);
    const built = row(info.packageId, definition?.access?.trust === 'trusted' ? 'trusted' : 'untrusted', origin.startsWith('packages://') ? 'project' : 'source', origin);
    if (!built) continue;
    const device = built.slot === 'source' ? packageOriginDevice(projectId, origin) : undefined;
    if (device) built.device = device;
    const grants = ownerScope.kind === 'project' ? definition?.requires?.defaultRoleGrants : undefined;
    rows.push(grants && Object.keys(grants).length > 0 ? { ...built, defaultRoleGrants: grants } : built);
  }
  for (const id of BUILTIN_PACKAGE_IDS) {
    const built = row(id, 'native', 'native', id);
    if (built) rows.push(built);
  }
  return rows;
}

/**
 * Pin a project package's trust (`trusted` / `untrusted`) or clear the pin
 * (`null`), then reload it so the runtime runs it at the new level. The pin
 * lives in the platform zone (`ProjectRecord.packageTrust`), out of any
 * agent's `fs_write` reach.
 */
export async function setProjectPackageTrust(
  userId: string,
  projectId: string,
  packageId: string,
  trust: unknown,
  via: InviteLinkProvenance,
): Promise<{ trust: 'trusted' | 'untrusted' | null; reloadFailed?: true }> {
  const access = await assertCanManagePackages(userId, projectId);
  if (trust !== 'trusted' && trust !== 'untrusted' && trust !== null) {
    throw new PackageOpRefusal(400, 'invalid_trust', 'Trust is "trusted", "untrusted" or null (clear the pin).');
  }
  const record = await reachablePackage(access, projectId, packageId);
  if (record.definition.access?.trust === 'native') {
    throw new PackageOpRefusal(400, 'native_trust_locked', 'A native package\'s trust cannot change.');
  }
  if (!await storeTrust(projectId, record.packageId, trust)) throw new Error('Failed to persist trust');
  await writeAuditLog({
    userId,
    action: 'package.trust.change',
    target: `${projectId}/${record.packageId}`,
    details: { trust, packageId: record.packageId, ...auditVia(via) },
  });
  try {
    await getPackageRuntimeManager().reloadProjectPackage(projectId, record.packageId);
    return { trust };
  } catch (err) {
    getLogger().child('package-trust').warn('Package reload after trust change failed', {
      projectId, packageId: record.packageId, error: err instanceof Error ? err.message : String(err),
    });
    return { trust, reloadFailed: true };
  }
}

/**
 * Build a WASM project package from its `src/` (`dist/package.wasm`) and
 * reload it. The build output is executable runtime input, so it rides the
 * same floor as a trust change even though no trust moves. The log a person
 * reads names no host path; the failure detail goes to the host log.
 */
export async function buildProjectPackage(
  userId: string,
  projectId: string,
  packageId: string,
  via: InviteLinkProvenance,
): Promise<ProjectPackageBuildResult> {
  const access = await assertCanManagePackages(userId, projectId);
  const record = await reachablePackage(access, projectId, packageId);
  const logger = getLogger().child('package-build');
  const started = Date.now();
  if (!hasSourceCode(record.packageRoot!)) {
    return {
      ok: false,
      logs: ['No buildable source found. A WASM package needs at least one of: src/tools/*.ts, src/routes/*.ts, src/lifecycle.ts (the node convention; the old single-entry src/index.ts is no longer supported).'],
      durationMs: Date.now() - started,
      error: 'no-source',
    };
  }
  if (!hasWasmToolchain()) {
    return {
      ok: false,
      logs: ['This server has no WASM compiler (extism-js on its PATH), so it builds no package. Install extism-js on this server, or build the package where it is installed (neuralis-build) and put its dist/ beside the package.'],
      durationMs: Date.now() - started,
      error: 'toolchain-missing',
    };
  }
  const logs = ['Building WASM package'];
  let buildError: string | undefined;
  try {
    // The host resolves the guest PDK path from its runtime layout (bundling-immune):
    // wasmBuild's own self-resolution fails inside the Next bundle.
    await buildWasmPackage(record.packageRoot!, { pdkGuestPath: resolveGuestPdkPath() });
    logs.push('Build complete');
  } catch (err) {
    buildError = err instanceof Error ? err.message : String(err);
    logger.error('Package build failed', { projectId, packageId: record.packageId, error: buildError });
    logs.push('Build failed. Check server logs for details.');
  }
  const durationMs = Date.now() - started;
  await writeAuditLog({
    userId,
    action: 'package.build',
    target: `${projectId}/${record.packageId}`,
    details: { success: !buildError, durationMs, ...(buildError ? { error: buildError } : {}), ...auditVia(via) },
  });
  if (buildError) return { ok: false, logs, durationMs, error: 'build-failed' };
  // The reload moves the package from `partial` (build missing) to `loaded`.
  try {
    await getPackageRuntimeManager().reloadProjectPackage(projectId, record.packageId);
    logs.push('Package reloaded; runtime ready');
  } catch (err) {
    logger.warn('Package reload after build failed', { projectId, packageId: record.packageId, error: err instanceof Error ? err.message : String(err) });
    logs.push('Reload after build failed (reload-failed). Run rescan or check server logs.');
  }
  logger.info('Package build completed', { projectId, packageId: record.packageId });
  return { ok: true, logs, durationMs };
}

/**
 * Attach a feature a caller needs to see a package (restrict-only — it never
 * grants access), or clear it (`null` / empty). Keyed by the exact runtime id
 * both readers use, so it applies with no reload. The package must exist and
 * sit in the caller's write reach: a native package of this host, or a
 * project package of a scope the caller may change. A set names a grantable
 * feature (one some package declares, or an override already in use).
 */
export async function setProjectPackageAccessFeature(
  userId: string,
  projectId: string,
  packageId: string,
  featureId: unknown,
  via: InviteLinkProvenance,
): Promise<{ featureId: string | null }> {
  const access = await assertCanManagePackages(userId, projectId);
  if (featureId !== null && typeof featureId !== 'string') {
    throw new PackageOpRefusal(400, 'invalid_feature', 'The feature is a non-empty string, or null to clear it.');
  }
  const feature = typeof featureId === 'string' && featureId.trim().length > 0 ? featureId.trim() : null;
  if (!BUILTIN_PACKAGE_IDS.has(packageId)) await reachablePackage(access, projectId, packageId);
  if (feature !== null) {
    const grantable = new Set(collectAllFeatures(getCommunityPackageRegistry().listPackages()));
    for (const existing of Object.values(access.project.packageAccessFeature ?? {})) grantable.add(existing);
    if (!grantable.has(feature)) {
      throw new PackageOpRefusal(400, 'unknown_feature', `Unknown feature id: ${feature}. Declare it (providesFeatures / accessFeature) or pick an existing feature.`);
    }
  }
  if (!await storeAccessFeature(projectId, packageId, feature)) throw new Error('Failed to persist the access feature');
  await writeAuditLog({
    userId,
    action: 'package.access_feature.change',
    target: `${projectId}/${packageId}`,
    details: { featureId: feature, packageId, ...auditVia(via) },
  });
  return { featureId: feature };
}
