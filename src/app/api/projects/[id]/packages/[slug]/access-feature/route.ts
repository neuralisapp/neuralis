/**
 * PUT /api/projects/:id/packages/:slug/access-feature
 *
 * R2b (scope-guarding-magpie) — set or clear the owner/admin base-access feature
 * OVERRIDE for a package. Storage lives in the platform zone
 * (`ProjectRecord.packageAccessFeature`) so agents cannot self-elevate via
 * `fs_write`. RESTRICT-ONLY: the override only ATTACHES a required feature to an
 * already-loaded package (e.g. isolate a first-party package that declared no
 * `requires.accessFeature`); it never grants access, so it can never weaken a
 * floor or create a trust tier.
 *
 * The `:slug` param is the package id the Packages tab sends — in the current UI
 * that is the **scope-namespaced snapshot id** (`pkg.id`, e.g.
 * `p.main.project.word-count`); a manifest-id caller is also supported. The override
 * is STORED keyed by whatever id was sent. The readers (bootstrap Axis-2
 * `resolveScopeHiddenIds` for the stream, `snapshot.ts` base-access gate for the
 * client snapshot) match with a DUAL-KEY lookup `overrides[manifestId] ??
 * overrides[id]` (`getPackageManifestId(projectId, id) ?? id`), so BOTH a
 * namespaced write (the real UI) AND a manifest-id write resolve — no reload
 * needed. **Do NOT simplify the reader to manifest-only: it would silently break
 * the namespaced key the workspace Packages panel actually writes.**
 *
 * Body: { featureId: string | null }
 *   - non-empty string — attach the required feature
 *   - null / ''        — clear the override
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/server/auth/session';
import { getProjectById, setPackageAccessFeature } from '@/server/store/ProjectStore';
import { writeAuditLog } from '@/server/store/AuditStore';
import { canManagePackages, resolveProjectAccess } from '@/server/projects/access';
import { getCommunityPackageRegistry } from '@/server/packages/runtime';
import { collectAllFeatures } from '@neuralis/package-system';

type Params = { params: Promise<{ id: string; slug: string }> };

export async function PUT(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const session = await requireSession().catch(() => null);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: projectId, slug: packageId } = await params;
  const project = await getProjectById(projectId);
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const access = await resolveProjectAccess(session.id, projectId);
  if (!access || !canManagePackages(access)) {
    return NextResponse.json(
      { error: 'Forbidden: package management permission required' },
      { status: 403 },
    );
  }

  const body = await req.json().catch(() => null);
  if (!body || !('featureId' in body)) {
    return NextResponse.json(
      { error: 'Invalid body: { featureId: string | null } required' },
      { status: 400 },
    );
  }
  const raw = body.featureId as unknown;
  if (raw !== null && typeof raw !== 'string') {
    return NextResponse.json(
      { error: 'Invalid featureId: must be a non-empty string or null' },
      { status: 400 },
    );
  }
  // Empty/whitespace string clears the override (parity with `null`).
  const featureId = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;

  // R2b — restrict-only is preserved, but a SET must name a GRANTABLE feature
  // (one in the project's feature catalog, or an already-set override id), so the
  // owner can actually grant it to a role. Reject an unknown id (the UI floor).
  // Clearing (null) is always allowed.
  if (featureId !== null) {
    const grantable = new Set(collectAllFeatures(getCommunityPackageRegistry().listPackages()));
    for (const existing of Object.values(project.packageAccessFeature ?? {})) grantable.add(existing);
    if (!grantable.has(featureId)) {
      return NextResponse.json(
        { error: `Unknown feature id: ${featureId}. Declare it (providesFeatures / accessFeature) or pick an existing feature.` },
        { status: 400 },
      );
    }
  }

  const updated = await setPackageAccessFeature(projectId, packageId, featureId);
  if (!updated) {
    return NextResponse.json({ error: 'Failed to persist access-feature override' }, { status: 500 });
  }

  await writeAuditLog({
    userId: session.id,
    action: 'package.access_feature.change',
    target: `${projectId}/${packageId}`,
    details: { featureId, packageId },
  });

  return NextResponse.json({ ok: true, featureId });
}
