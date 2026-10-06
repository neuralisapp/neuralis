/**
 * POST /api/packages/query
 *
 * Generic community package query dispatch.
 * After Phase 4, both the workspace and the package authoring UI can access
 * package contribution metadata through the same surface.
 */

import { NextRequest, NextResponse } from 'next/server';
import { PackageQueryRouter } from '@neuralis/package-system';
import { requireSession } from '@/server/auth/session';
import { handleDefaultCommunityPackageQuery } from '@/server/packages/dispatch';
import { ensureCommunityRuntime, getCommunityPackageRegistry } from '@/server/packages/runtime';
import { ensureProjectPackagesLoaded } from '@/server/packages/projectPackages';
import { canManagePackages, resolveProjectAccess } from '@/server/projects/access';
import { rolePriority, rolePrioritiesOf } from '@neuralis/package-system/access';

let _queryRouter: PackageQueryRouter | null = null;

function getCommunityQueryRouter(): PackageQueryRouter {
  if (!_queryRouter) {
    _queryRouter = new PackageQueryRouter(getCommunityPackageRegistry());
    _queryRouter.registerFallbackHandler(handleDefaultCommunityPackageQuery);
  }
  return _queryRouter;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let sessionUserId = '';
  try {
    sessionUserId = (await requireSession()).id;
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await ensureCommunityRuntime();

  try {
    const body = await req.json();
    const packageId = String(body?.packageId ?? '').trim();
    const operation = String(body?.operation ?? '').trim();
    if (!packageId || !operation) {
      return NextResponse.json(
        { error: 'packageId and operation are required' },
        { status: 400 },
      );
    }

    const projectId = String(body?.projectId ?? req.headers.get('x-project-id') ?? '').trim();
    if (!projectId) {
      return NextResponse.json({ error: 'Missing projectId' }, { status: 400 });
    }
    const access = await resolveProjectAccess(sessionUserId, projectId);
    if (!access) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    // Parity with command/install: package-query dispatch returns full
    // PackageDefinitions + absolute packageRoot host paths (dispatch.ts), so it
    // is a package-management surface, not member-readable introspection.
    if (!canManagePackages(access)) {
      return NextResponse.json({ error: 'Forbidden: package management permission required' }, { status: 403 });
    }
    await ensureProjectPackagesLoaded(projectId);

    const result = await getCommunityQueryRouter().dispatch({
      packageId,
      operation,
      params: body?.params ?? {},
      // S-5 — thread the FULL resolved scope (ONE identity type), mirroring
      // runtime/route.ts; a truncated {userId,projectId,agentId} is a partial
      // re-state of SessionContext.
      context: {
        userId: sessionUserId,
        projectId,
        agentId: typeof body?.agentId === 'string' ? body.agentId : undefined,
        role: access.member.role,
        priority: rolePriority(access.member.role, access.role.priority),
        rolePriorities: rolePrioritiesOf(access.project.roles),
        grantedFeatures: access.role.grantedFeatures,
        agentAccess: access.role.agents,
        agentOwnership: access.project.agentOwnership,
      },
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error ?? 'Query failed' }, { status: 404 });
    }

    return NextResponse.json({ result: result.data });
  } catch (error) {
    console.error('[packages/query] failed', error);
    return NextResponse.json({ error: 'Package query failed' }, { status: 400 });
  }
}
