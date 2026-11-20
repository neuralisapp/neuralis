import { NextResponse } from 'next/server';
import {
  normalizeProvidedFeatures,
  buildFeatureConsumersIndex,
  summarizeConsumers,
  type FeatureConsumerSummary,
} from '@neuralis/package-system';
import { requireAdmin } from '@/server/auth/adminGuard';
import { resolveRequestProjectId } from '@/server/auth/requestProject';
import { getCommunityPackageRegistry } from '@/server/packages/runtime';
import {
  passesProjectAndOwnerScope,
  type PackageVisibilityScope,
} from '@/server/packages/packageVisibility';
import { loadReadHiddenView } from '@/server/packages/packageReadFloor';
import { BUILTIN_PACKAGE_IDS } from '@/server/host/bootstrap';
import { isManifestReadHidden, isPlatformTierFeature } from '@neuralis/package-system/access';
import type { PackageDefinition } from '@neuralis/package-system/contracts';

/** One feature with human metadata + the contributions it gates (consumers). */
export type FeatureCatalogEntry = {
  id: string;
  title?: string;
  description?: string;
  /** What this feature controls (tools/skills/commands/widgets/docks). Derived, not stored. */
  consumers: FeatureConsumerSummary;
  /** The NON-builtin packages that declare this id too (or alone) — shown on the row, never hidden. */
  declaredBy?: string[];
};

/** The features that share an id's first segment (`files.read` → `files`). */
export type FeatureCatalogGroup = {
  /** The first segment of every id in the group. */
  key: string;
  /** The segment, capitalized — the header the Roles editor shows. */
  title: string;
  /** Crosses the project boundary (the kernel tier label); such groups sort last. */
  platformTier: boolean;
  /** Sorted feature ids. */
  features: string[];
  entries: FeatureCatalogEntry[];
};

export type FeatureCatalogResponse = {
  groups: FeatureCatalogGroup[];
};

type Declared = { title?: string; description?: string; metaFromBuiltin: boolean; declaredBy: string[] };

/**
 * One entry per id over every declaring package: a builtin's title and
 * description win; any other declarer is NAMED on the entry, so a drop cannot
 * dress its own id — or a builtin's — in a builtin's words unseen.
 */
function collectDeclarations(definitions: PackageDefinition[], overrides: Record<string, string>): Map<string, Declared> {
  const byId = new Map<string, Declared>();
  const declare = (pkg: PackageDefinition, id: string, meta?: { title?: string; description?: string }): void => {
    const builtin = BUILTIN_PACKAGE_IDS.has(pkg.id);
    const row = byId.get(id) ?? { metaFromBuiltin: false, declaredBy: [] };
    byId.set(id, row);
    if (!builtin && !row.declaredBy.includes(pkg.name)) row.declaredBy.push(pkg.name);
    if (!meta || row.metaFromBuiltin) return;
    if (builtin || (row.title === undefined && row.description === undefined)) {
      row.title = meta.title;
      row.description = meta.description;
      row.metaFromBuiltin = builtin;
    }
  };
  for (const pkg of definitions) {
    for (const feature of normalizeProvidedFeatures(pkg.requires?.providesFeatures)) declare(pkg, feature.id, feature);
    // A declared base-access gate (`requires.accessFeature`) is grantable even when it is not in `providesFeatures`.
    const declaredAccess = pkg.requires?.accessFeature;
    if (declaredAccess) declare(pkg, declaredAccess);
    // An override-ATTACHED base-access feature lives in no manifest: it stays grantable (a package whose only gate it is).
    const overrideAccess = overrides[pkg.id];
    if (overrideAccess) declare(pkg, overrideAccess);
  }
  return byId;
}

/** GET /api/admin/feature-catalog — the project's grantable features, grouped by the id's first segment. */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    // R2b — project-aware: a base-access feature ATTACHED via the per-project
    // override (`ProjectRecord.packageAccessFeature`) lives in no manifest, so a
    // manifest-only catalog would never surface it as grantable in the Roles
    // editor. `requireAdmin(projectId)` already loads the ProjectRecord; reuse
    // `ctx.project` (no second store read).
    //
    // O-2 — the `X-Project-Id` header is REQUIRED; the one caller, the admin
    // package's Roles editors, sends it. The "no header ⇒ the caller's first
    // project" fallback returned a catalog whose override-attached entries
    // belonged to a project the caller never named.
    const resolved = resolveRequestProjectId(request);
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }
    const ctx = await requireAdmin(resolved.projectId);
    const overrides = ctx.project.packageAccessFeature ?? {};
    const registry = getCommunityPackageRegistry();
    // R2C-006 — ROLES ARE PROJECT-LEVEL, NOT PLATFORM-LEVEL, therefore the
    // surface that sets a role's features must filter by project. This catalog
    // is the input to a project-scoped decision; feeding it the process-global
    // `registry.listPackages()` was a category error before it was a leak — and
    // it was also a leak: the `title`/`description` a foreign project's
    // `_packages/` drop declares were copied verbatim into an admin's Roles
    // editor in every OTHER project.
    //
    // The filter is the ONE shared ladder predicate, never a re-inlined copy.
    // `agentId` is absent by design (an admin acts as themselves, not as an
    // agent), which safely UNDER-shows agent-scoped packages.
    const scope: PackageVisibilityScope = {
      host: 'neuralis-workspace',
      projectId: resolved.projectId,
      userId: ctx.user.id,
      role: ctx.member.role,
      grantedFeatures: ctx.memberRole.grantedFeatures,
      packageAccessFeature: overrides,
      readHidden: await loadReadHiddenView(ctx.session, resolved.projectId),
    };
    const definitions = registry
      .listPackages()
      .filter((definition) => passesProjectAndOwnerScope(definition, scope))
      // A source package whose manifest the admin cannot read names nothing here.
      .filter((definition) => !isManifestReadHidden(scope.readHidden, definition.id));

    // The consumers index is built over the SAME filtered set. It used to span
    // ALL packages, justified as "a feature may be referenced by a contribution
    // in another package" — true, but `summarizeConsumers` emits each consumer's
    // NAME, so a foreign drop declaring any contribution with
    // `requires.features:['files.read']` (a native feature that survives
    // the group filter) had its contribution name rendered here. Filtering both
    // halves keeps the legitimate cross-NATIVE references — an agent-core
    // tool consuming brain-core's `files.read`, both visible — and drops only
    // foreign-project consumers. Route-level consumers are intentionally absent
    // — see featureConsumersIndex scope note + the test-time audit.
    const consumersIndex = buildFeatureConsumersIndex(definitions);

    const bySegment = new Map<string, FeatureCatalogEntry[]>();
    for (const [id, declared] of collectDeclarations(definitions, overrides)) {
      const segment = id.split('.')[0]!;
      const entry: FeatureCatalogEntry = {
        id,
        ...(declared.title !== undefined ? { title: declared.title } : {}),
        ...(declared.description !== undefined ? { description: declared.description } : {}),
        consumers: summarizeConsumers(consumersIndex.get(id)),
        ...(declared.declaredBy.length > 0 ? { declaredBy: declared.declaredBy } : {}),
      };
      bySegment.set(segment, [...(bySegment.get(segment) ?? []), entry]);
    }
    const groups: FeatureCatalogGroup[] = [...bySegment]
      .map(([segment, entries]) => {
        entries.sort((a, b) => a.id.localeCompare(b.id));
        return {
          key: segment,
          title: segment.charAt(0).toUpperCase() + segment.slice(1),
          platformTier: entries.every((entry) => isPlatformTierFeature(entry.id)),
          features: entries.map((entry) => entry.id),
          entries,
        };
      })
      // Project-tier groups alphabetically, then the platform tier.
      .sort((a, b) => Number(a.platformTier) - Number(b.platformTier) || a.key.localeCompare(b.key));

    return NextResponse.json({ groups } satisfies FeatureCatalogResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Forbidden';
    const status = msg === 'Unauthorized' ? 401 : msg.startsWith('Forbidden') ? 403 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
