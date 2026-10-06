import type { PackageDefinition, SourceScope } from '@neuralis/package-system/contracts';
import { namespaceProjectPackageId } from '@neuralis/package-system/contracts';
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
  /** Capped at 'trusted' for project packages — never 'first-party' */
  trust: 'trusted' | 'untrusted';
  /**
   * WASM runtime only: `mtimeMs:size` of the wasm entry and `dist/routes.json`
   * (`-` when absent). A rebuild changes no manifest byte, so this is the input
   * the sync compares to swap the module; absent for every other runtime.
   */
  artifactStamp?: string;
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
): ResolvedPackageRecord {
  // The reserved-id + charset guard runs on the RAW manifest id FIRST (inside
  // `sanitizeProjectPackageDefinition`); THEN the loader/registry id is
  // scope-namespaced so two owning scopes' same-manifest-id packages occupy
  // DISTINCT loader slots (no cross-tenant/cross-scope code substitution). The
  // manifest id is preserved on `manifestId` for the admin trust/access-feature
  // keys + display. Builtins are never namespaced (identity → unchanged).
  const sanitized = sanitizeProjectPackageDefinition(r.definition, r.trust);
  const runtimeId = BUILTIN_PACKAGE_IDS.has(r.packageId)
    ? r.packageId
    : namespaceProjectPackageId(projectId, scope, r.packageId);
  return {
    packageId: runtimeId,
    manifestId: r.packageId,
    scope: 'project',
    ownerScope: scope,
    ownerProjectId: projectId,
    definition: runtimeId === r.packageId ? sanitized : { ...sanitized, id: runtimeId },
    packageRoot: r.packageRoot,
    sourceRoot: r.packageRoot,
    sourceKind: r.definition.source?.kind ?? 'local-dir',
    installedAt: r.discoveredAt,
    updatedAt: r.discoveredAt,
    ...(r.artifactStamp !== undefined ? { artifactStamp: r.artifactStamp } : {}),
  };
}

export type ResolvedPackageRecord = {
  /** The loader/registry id — scope-NAMESPACED for project packages (equals
   *  `manifestId` for builtins). Every loader/registry/snapshot/dispatch surface
   *  keys on this. */
  packageId: string;
  /** The RAW manifest id (pre-namespace) — the STABLE admin/display key. Admin
   *  `packageTrust`/`packageAccessFeature` overrides are keyed by this, so every
   *  namespaced→manifest read (bootstrap Axis-2, snapshot base-access) translates
   *  via it. Equals `packageId` for builtins. */
  manifestId: string;
  /** Discovery CLASS (builtin/installed/authored/project) — NOT the owning scope. */
  scope: PackageScope;
  /**
   * Owning SOURCE scope (R2b): the project/user/agent scope of the source that
   * contributed this package. Drives runtime advertise-time scope isolation.
   * Absent ⇒ treated as `{ kind: 'project' }` (builtins, default `_packages/`).
   */
  ownerScope?: SourceScope;
  /**
   * Owning PROJECT id, carried explicitly.
   *
   * It is also a component of the namespaced `packageId`, but that id must
   * NEVER be parsed back (sourceScope doctrine) — the value travels on the
   * record instead. The loader needs it because a package's declared
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
