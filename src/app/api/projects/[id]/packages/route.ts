/**
 * GET /api/projects/:id/packages
 *
 * Every package of the project the caller's scope may read — its
 * `_packages/` drop zone, each source package folder and the native packages —
 * with the host-stamped trust, the load state, the owning scope and the access
 * feature (the Admin → Packages project tab). The body is the ONE shared
 * `listProjectPackageRows` behind the FRESH `canManagePackages` floor, which
 * the admin `project-packages` route reaches for the CLI and an agent's
 * session; this route is its cookie door, so a role holding the governance
 * flag without `packages.manage` keeps the same reach as at the action routes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/server/auth/session';
import { listProjectPackageRows } from '@/server/packages/rescanProjectPackages';
import { packageOpResponse } from '@/server/packages/packageOpResponse';

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const session = await requireSession().catch(() => null);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id: projectId } = await params;
  try {
    return NextResponse.json({ packages: await listProjectPackageRows(session.id, projectId) });
  } catch (err) {
    return packageOpResponse(err, 'Failed to list the project packages');
  }
}
