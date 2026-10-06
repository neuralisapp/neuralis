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

/** One feature with human metadata (C9) + the contributions it gates (consumers). */
export type FeatureCatalogEntry = {
  id: string;
  title?: string;
  description?: string;
  /** What this feature controls (tools/skills/commands/widgets/docks). Derived, not stored. */
  consumers: FeatureConsumerSummary;
};

export type FeatureCatalogGroup = {
  packageId: string;
  packageName: string;
  /** Sorted feature ids (kept for backward-compatible consumers). */
  features: string[];
  /** Rich per-feature metadata + consumers (C9). */
  entries: FeatureCatalogEntry[];
};

export type FeatureCatalogResponse = {
  groups: FeatureCatalogGroup[];
};

/** GET /api/admin/feature-catalog — runtime feature list grouped by package. */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    // R2b — project-aware: a base-access feature ATTACHED via the per-project
    // override (`ProjectRecord.packageAccessFeature`) lives in no manifest, so a
    // manifest-only catalog would never surface it as grantable in the Roles
    // editor. `requireAdmin(projectId)` already loads the ProjectRecord; reuse
    // `ctx.project` (no second store read).
    //
    // O-2 — the `X-Project-Id` header is now REQUIRED. Both callers already send
    // it (the admin Roles editor and brain-core's access-feature picker); the
    // "no header ⇒ the caller's first project" fallback returned a catalog whose
    // override-attached entries belonged to a project the caller never named.
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
    };
    const definitions = registry
      .listPackages()
      .filter((definition) => passesProjectAndOwnerScope(definition, scope));

    // The consumers index is built over the SAME filtered set. It used to span
    // ALL packages, justified as "a feature may be referenced by a contribution
    // in another package" — true, but `summarizeConsumers` emits each consumer's
    // NAME, so a foreign drop declaring any contribution with
    // `requires.features:['drive.read']` (a first-party feature that survives
    // the group filter) had its contribution name rendered here. Filtering both
    // halves keeps the legitimate cross-FIRST-PARTY references — an agent-core
    // tool consuming brain-core's `drive.read`, both visible — and drops only
    // foreign-project consumers. Route-level consumers are intentionally absent
    // — see featureConsumersIndex scope note + the test-time audit.
    const consumersIndex = buildFeatureConsumersIndex(definitions);

    const groups: FeatureCatalogGroup[] = definitions
      .map((pkg) => {
        const provided = normalizeProvidedFeatures(pkg.requires?.providesFeatures);
        const entries: FeatureCatalogEntry[] = provided
          .map((f) => ({
            id: f.id,
            title: f.title,
            description: f.description,
            consumers: summarizeConsumers(consumersIndex.get(f.id)),
          }))
          .sort((a, b) => a.id.localeCompare(b.id));
        // R2b — surface a declared base-access gate (`requires.accessFeature`) as
        // a grantable feature under its declaring package, even when it isn't in
        // `providesFeatures`, so an owner can grant base access to a role.
        const af = pkg.requires?.accessFeature;
        if (af && !entries.some((e) => e.id === af)) {
          entries.push({ id: af, consumers: summarizeConsumers(consumersIndex.get(af)) });
          entries.sort((a, b) => a.id.localeCompare(b.id));
        }
        // R2b — an override-ATTACHED base-access feature (no manifest declaration)
        // surfaces under its declaring package's group so the owner can grant it.
        // A package whose ONLY gate is the override now has entries.length === 1
        // and survives the empty-group filter below.
        const overrideAf = overrides[pkg.id];
        if (overrideAf && !entries.some((e) => e.id === overrideAf)) {
          entries.push({ id: overrideAf, consumers: summarizeConsumers(consumersIndex.get(overrideAf)) });
          entries.sort((a, b) => a.id.localeCompare(b.id));
        }
        return {
          packageId: pkg.id,
          packageName: pkg.name,
          features: entries.map((e) => e.id),
          entries,
        };
      })
      .filter((g) => g.features.length > 0)
      .sort((a, b) => a.packageName.localeCompare(b.packageName));

    return NextResponse.json({ groups } satisfies FeatureCatalogResponse);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Forbidden';
    const status = msg === 'Unauthorized' ? 401 : msg.startsWith('Forbidden') ? 403 : 400;
    return NextResponse.json({ error: msg }, { status });
  }
}
