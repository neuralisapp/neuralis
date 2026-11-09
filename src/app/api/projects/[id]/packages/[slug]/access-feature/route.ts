/**
 * PUT /api/projects/:id/packages/:package/access-feature
 *
 * Attach the feature a caller needs to see a package, or clear it —
 * RESTRICT-ONLY: it never grants access, so it can never weaken a floor or
 * create a trust tier. `:package` is the exact runtime id (a project package's
 * instance URI, a native package's `@scope/name`). The body — the FRESH
 * `canManagePackages` floor, the package checked to exist and to sit in the
 * caller's write reach, the grantable-feature check, the platform-zone write
 * (`ProjectRecord.packageAccessFeature`) and the audit row — is the ONE shared
 * `setProjectPackageAccessFeature`, which the admin `project-packages` route
 * reaches for the CLI and an agent's session. This route is its cookie door.
 *
 * Body: { featureId: string | null }   (null or '' clears it)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/server/auth/session';
import { setProjectPackageAccessFeature } from '@/server/packages/rescanProjectPackages';
import { packageOpResponse } from '@/server/packages/packageOpResponse';

type Params = { params: Promise<{ id: string; slug: string }> };

export async function PUT(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const session = await requireSession().catch(() => null);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id: projectId, slug: packageId } = await params;
  const body = (await req.json().catch(() => null)) as { featureId?: unknown } | null;
  if (!body || !('featureId' in body)) {
    return NextResponse.json({ error: 'Invalid body: { featureId: string | null } required' }, { status: 400 });
  }
  try {
    const result = await setProjectPackageAccessFeature(session.id, projectId, packageId, body.featureId, { interactive: true });
    return NextResponse.json({ ok: true, featureId: result.featureId });
  } catch (err) {
    return packageOpResponse(err, 'Failed to set the access feature');
  }
}
