/**
 * POST /api/projects/:id/packages/:package/build
 *
 * Build a WASM project package from its `src/` and reload it. The body — the
 * FRESH `canManagePackages` floor (a build's output is executable runtime
 * input), the package refused like an absent one outside the caller's write
 * reach, the audit row and the reload — is the ONE shared
 * `buildProjectPackage`, which the admin `project-packages` route reaches for
 * the CLI and an agent's session. This route is its cookie door.
 *
 * Response: `{ ok, logs, durationMs, error? }` — 400 with no source, 409 when
 * this server has no WASM compiler (`toolchain-missing`, named in the logs),
 * 500 when the build fails (the detail is in the host log).
 */

import { NextRequest, NextResponse } from 'next/server';
import { projectPackageBuildStatus } from '@neuralis/package-system/contracts';
import { requireSession } from '@/server/auth/session';
import { buildProjectPackage } from '@/server/packages/rescanProjectPackages';
import { packageOpResponse } from '@/server/packages/packageOpResponse';

type Params = { params: Promise<{ id: string; slug: string }> };

export async function POST(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const session = await requireSession().catch(() => null);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { id: projectId, slug: packageId } = await params;
  try {
    const result = await buildProjectPackage(session.id, projectId, packageId, { interactive: true });
    return NextResponse.json(result, { status: projectPackageBuildStatus(result) });
  } catch (err) {
    return packageOpResponse(err, 'Build failed');
  }
}
