/**
 * POST /api/packages/command
 *
 * Generic community package command dispatch.
 * Currently handles runtime-level package lifecycle commands:
 * reload and uninstall. Storage-heavy feature routes remain host-owned.
 */

import { NextRequest, NextResponse } from 'next/server';
import { PackageCommandRouter } from '@neuralis/package-system';
import { requireSession } from '@/server/auth/session';
import { handleDefaultCommunityPackageCommand } from '@/server/packages/dispatch';
import { ensureCommunityRuntime, getCommunityPackageRegistry } from '@/server/packages/runtime';
import { ensureProjectPackagesLoaded } from '@/server/packages/projectPackages';
import { canManagePackages, resolveProjectAccess } from '@/server/projects/access';
import { rolePriority, rolePrioritiesOf } from '@neuralis/package-system/access';

let _commandRouter: PackageCommandRouter | null = null;

function getCommunityCommandRouter(): PackageCommandRouter {
  if (!_commandRouter) {
    _commandRouter = new PackageCommandRouter(getCommunityPackageRegistry());
    _commandRouter.registerFallbackHandler(handleDefaultCommunityPackageCommand);
  }
  return _commandRouter;
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

    const projectId = String(body?.projectId ?? req.headers.get('x-project-id') ?? '').trim();
    if (!projectId) {
      return NextResponse.json({ error: 'Missing projectId' }, { status: 400 });
    }
    const access = await resolveProjectAccess(sessionUserId, projectId);
    if (!access) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (!canManagePackages(access)) {
      return NextResponse.json({ error: 'Forbidden: package management permission required' }, { status: 403 });
    }
    await ensureProjectPackagesLoaded(projectId);

    const packageId = String(body?.packageId ?? '').trim();
    const operation = String(body?.operation ?? '').trim();
    if (!packageId || !operation) {
      return NextResponse.json(
        { error: 'packageId and operation are required' },
        { status: 400 },
      );
    }

    const result = await getCommunityCommandRouter().dispatch({
      packageId,
      operation,
      payload: body?.payload ?? {},
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
      return NextResponse.json({ error: result.error ?? 'Command failed' }, { status: 404 });
    }

    return NextResponse.json({ result: result.data });
  } catch (error) {
    console.error('[packages/command] failed', error);
    return NextResponse.json({ error: 'Package command failed' }, { status: 400 });
  }
}
