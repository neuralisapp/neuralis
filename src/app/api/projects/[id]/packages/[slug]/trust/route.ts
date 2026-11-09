/**
 * PUT /api/projects/:id/packages/:package/trust
 *
 * Pin a project package's trust, or clear the pin. The body — the FRESH
 * `canManagePackages` floor, the package resolved from the host-stamped
 * records and refused like an absent one outside the caller's write reach, the
 * platform-zone write, the audit row and the reload — is the ONE shared
 * `setProjectPackageTrust`, which the admin `project-packages` route reaches
 * for the CLI and an agent's session. This route is its cookie door.
 *
 * Body: { trust: 'trusted' | 'untrusted' | null }   (null clears the pin)
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/server/auth/session';
import { setProjectPackageTrust } from '@/server/packages/rescanProjectPackages';
import { packageOpResponse } from '@/server/packages/packageOpResponse';

type Params = { params: Promise<{ id: string; slug: string }> };

export async function PUT(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const session = await requireSession().catch(() => null);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id: projectId, slug: packageId } = await params;
  const body = (await req.json().catch(() => null)) as { trust?: unknown } | null;
  if (!body || !('trust' in body)) {
    return NextResponse.json({ error: 'Invalid body: { trust: "trusted" | "untrusted" | null } required' }, { status: 400 });
  }
  try {
    const result = await setProjectPackageTrust(session.id, projectId, packageId, body.trust, { interactive: true });
    return NextResponse.json({ ok: true, trust: result.trust, ...(result.reloadFailed ? { reloadWarning: 'reload-failed' } : {}) });
  } catch (err) {
    return packageOpResponse(err, 'Failed to set trust');
  }
}
