/**
 * GET /api/packages/dock
 *
 * Dock entries for the workspace DockLeft component.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/server/auth/session';
import { getDockSnapshot } from '@/server/packages/snapshot';
import { ensureProjectPackagesLoaded } from '@/server/packages/projectPackages';
import { resolveProjectAccess } from '@/server/projects/access';
import { resolveVerifiedAgentScope } from '@/server/auth/resolveVerifiedAgentScope';

export async function GET(req: NextRequest): Promise<NextResponse> {
  let user;
  try {
    user = await requireSession();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const projectId = req.headers.get('x-project-id')?.trim() || '';
  if (!projectId) {
    return NextResponse.json({ error: 'Missing projectId' }, { status: 400 });
  }
  const access = await resolveProjectAccess(user.id, projectId);
  if (!access) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  await ensureProjectPackagesLoaded(projectId);

  // A raw header is not an agent identity: a forged, unknown or inaccessible
  // id resolves to NO agent (the surface is simply unfiltered by agent — never
  // a 403, which would confirm the id exists).
  const agentId = await resolveVerifiedAgentScope(access.session, req.headers.get('x-agent-id') ?? undefined);
  const dock = getDockSnapshot(
    {
      host: 'neuralis-workspace',
      projectId,
      userId: user.id,
      ...(agentId ? { agentId } : {}),
      role: access.member.role,
      grantedFeatures: access.role.grantedFeatures,
      ...(access.project.packageAccessFeature ? { packageAccessFeature: access.project.packageAccessFeature } : {}),
    },
    access.role.grantedFeatures,
  );
  return NextResponse.json({ dock });
}
