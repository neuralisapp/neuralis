import { relative, sep } from 'node:path';
import { validateManifest } from '@neuralis/package-system';
import type { PackageDefinition, PackageReader, ScopeOrigin, SourcePlane, SourceScope } from '@neuralis/package-system/contracts';
import { packageInstanceId } from '@neuralis/package-system/contracts';
import { sanitizePackageId } from '@neuralis/package-system/paths';
import { BUILTIN_PACKAGE_IDS } from '../host/builtinSlots';

export type PackageScope = 'builtin' | 'installed' | 'authored' | 'project';

// ---------------------------------------------------------------------------
// Project-level packages (_packages/ directory)
// ---------------------------------------------------------------------------

export type ProjectPackageRecord = {
  /** Directory name under _packages/ */
  slug: string;
  /** definition.id from the package manifest */
  packageId: string;
  /** Fully resolved package definition (manifest + file discovery) */
  definition: PackageDefinition;
  /** Absolute path: {projectRoot}/_packages/{slug}/ */
  packageRoot: string;
  /** When the scanner discovered/refreshed this package */
  discoveredAt: number;
  /** Capped at 'trusted' for project packages — never 'native' */
  trust: 'trusted' | 'untrusted';
  /**
   * WASM runtime only: `mtimeMs:size` of the wasm entry and `dist/routes.json`
   * (`-` when absent). A rebuild changes no manifest byte, so this is the input
   * the sync compares to swap the module; absent for every other runtime.
   */
  artifactStamp?: string;
  /** A device folder's package: the reader its bytes come through (the loader re-reads with it). */
  reader?: PackageReader;
  /** The device is unreachable: the package is listed as not available, from its last read. */
  unavailable?: 'device-offline';
};

// Squat protection for RETIRED platform ids only — packages that no longer
// load anywhere, so no live set can name them. A live builtin is never listed
// here: the derived `BUILTIN_PACKAGE_IDS` arm below covers every one of them.
const RESERVED_PROJECT_PACKAGE_IDS = new Set([
  '@neuralis/orchestrator',
  '@neuralis/terminal',
]);

export function assertProjectPackageIdAllowed(packageId: string): void {
  // Three arms, each deliberate: the retired platform ids (squat protection),
  // the whole `@neuralis/` scope (platform namespace — never squattable from a
  // project drop), and the LIVE deps-discovered builtin set so a project
  // `_packages/` package cannot shadow ANY loaded builtin, `@company/*` included.
  if (
    RESERVED_PROJECT_PACKAGE_IDS.has(packageId) ||
    packageId.startsWith('@neuralis/') ||
    BUILTIN_PACKAGE_IDS.has(packageId)
  ) {
    throw new Error(`Project package id is reserved: ${packageId}`);
  }
}

export function sanitizeProjectPackageDefinition(
  definition: PackageDefinition,
  trust: 'trusted' | 'untrusted' = 'untrusted',
): PackageDefinition {
  assertProjectPackageIdAllowed(definition.id);
  const validation = validateManifest(definition);
  if (!validation.valid) throw new Error(`Invalid authored package manifest ${JSON.stringify(definition.id)}: ${validation.errors[0]}`);
  return {
    ...definition,
    access: {
      ...definition.access,
      trust,
    },
  };
}

export function toResolvedRecord(
  r: ProjectPackageRecord,
  projectId: string,
  scope: SourceScope,
  origin?: { directory: string; uriRoot: string; plane: SourcePlane },
): ResolvedPackageRecord {
  const sanitized = sanitizeProjectPackageDefinition(r.definition, r.trust);
  const validation = validateManifest(sanitized);
  if (!validation.valid) throw new Error(`Invalid authored package manifest ${JSON.stringify(r.packageId)}: ${validation.errors[0]}`);
  const rel = origin ? relative(origin.directory, r.packageRoot).split(sep).join('/') : r.slug;
  if (rel === '..' || rel.startsWith('../')) throw new Error('Package root escapes its source');
  const originUri = origin ? `${origin.uriRoot}${origin.uriRoot.endsWith('://') || origin.uriRoot.endsWith('/') || !rel ? '' : '/'}${rel}` : `packages://${rel}`;
  const runtimeId = packageInstanceId({ originUri, projectId, scope });
  // The instance's data zone must be representable (a leaf over NAME_MAX
  // throws) — refused HERE, where the scanner skips and names the record,
  // never later inside provisioning where it would fail the project's load.
  sanitizePackageId(runtimeId);
  return {
    packageId: runtimeId,
    manifestId: r.packageId,
    originUri,
    scope: 'project',
    ownerScope: scope,
    ...(origin ? { ownerOrigin: { plane: origin.plane } } : {}),
    ownerProjectId: projectId,
    definition: runtimeId === r.packageId ? sanitized : { ...sanitized, id: runtimeId },
    packageRoot: r.packageRoot,
    sourceRoot: r.packageRoot,
    sourceKind: r.definition.source?.kind ?? 'local-dir',
    installedAt: r.discoveredAt,
    updatedAt: r.discoveredAt,
    ...(r.artifactStamp !== undefined ? { artifactStamp: r.artifactStamp } : {}),
    ...(r.reader ? { reader: r.reader } : {}),
    ...(r.unavailable ? { unavailable: r.unavailable } : {}),
  };
}

export type ResolvedPackageRecord = {
  /** Canonical host-derived instance URI; platform packages retain their authored npm id. */
  packageId: string;
  /** Authored npm name used for display and manifest validation, never mutable trust authority. */
  manifestId: string;
  /** Host-derived source URI, independent of the authored npm name. */
  originUri?: string;
  /** Discovery CLASS (builtin/installed/authored/project) — NOT the owning scope. */
  scope: PackageScope;
  /**
   * Owning SOURCE scope (R2b): the project/user/agent scope of the source that
   * contributed this package. Drives runtime advertise-time scope isolation.
   * Absent ⇒ treated as `{ kind: 'project' }` (builtins, default `_packages/`).
   */
  ownerScope?: SourceScope;
  /**
   * The plane of the source that contributed this package, carried from the
   * source owner's `PackageSourceRoot.plane` — the 4th `canAccessScope`
   * argument (a user-scope DEVICE folder serves its owner alone). Never
   * re-derived from the slug or the root's shape. Absent ⇒ no recorded source.
   */
  ownerOrigin?: ScopeOrigin;
  /**
   * Owning PROJECT id, carried explicitly.
   *
   * It is also the `project` of the instance `packageId`; the value travels on
   * the record and the loader requires the two to agree. The loader needs it because a package's declared
   * `connectors[]` must register into ITS project's partition; without it the
   * loader hardcoded `''`, which is the platform lane, i.e. visible in every
   * project. Absent ⇒ host-assigned builtin (the platform lane is correct).
   */
  ownerProjectId?: string;
  definition: PackageDefinition;
  packageRoot?: string;
  sourceRoot?: string;
  sourceRef?: string;
  sourceKind: string;
  installedAt?: number;
  updatedAt?: number;
  /** The scanner's WASM artifact stamp (see `ProjectPackageRecord`). */
  artifactStamp?: string;
  /** A device folder's reader (see `ProjectPackageRecord`); `packageRoot` is then a path on that device. */
  reader?: PackageReader;
  /** See `ProjectPackageRecord`. */
  unavailable?: 'device-offline';
};

export type PackageCatalogMeta = {
  packageId: string;
  scope: PackageScope;
  source: string;
  sourceRef?: string;
  sourceRoot?: string;
  installedAt?: number;
  updatedAt?: number;
};
