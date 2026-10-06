/**
 * POST /api/packages/install
 *
 * Community package install endpoint.
 * The request can provide a JSON package definition or a local definitionPath/sourceRoot
 * reference. The runtime is invalidated immediately after install.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/server/auth/session';
import {
  assertInstallSourceAllowed,
  inspectInstallablePackage,
  installPackageToProject,
} from '@/server/packages/packageInstaller';
import { ensureCommunityRuntime } from '@/server/packages/runtime';
import {
  listProjectsForUser,
  getProjectById,
} from '@/server/store/ProjectStore';
import { resolveProjectRoot } from '@neuralis/package-system/paths';
import { getEnv } from '@/server/config/env';
import { writeAuditLog } from '@/server/store/AuditStore';
import { canManagePackages, resolveProjectAccess } from '@/server/projects/access';

export async function POST(req: NextRequest): Promise<NextResponse> {
  let session;
  try {
    session = await requireSession();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  await ensureCommunityRuntime();

  try {
    const body = await req.json();
    const requestedProjectId = typeof body?.projectId === 'string' ? body.projectId.trim() : '';
    const project = requestedProjectId
      ? await getProjectById(requestedProjectId)
      : (await listProjectsForUser(session.id))[0] ?? null;

    if (!project || !project.members[session.id]) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const access = await resolveProjectAccess(session.id, project.id);
    if (!access || !canManagePackages(access)) {
      return NextResponse.json({ error: 'Forbidden: package management permission required' }, { status: 403 });
    }
    const projectRoot = resolveProjectRoot(getEnv().projectsRoot, project.id);
    assertInstallSourceAllowed(body, projectRoot);

    if (body?.dryRun === true) {
      const discovered = inspectInstallablePackage(body);
      return NextResponse.json({
        package: discovered.definition,
        artifact: discovered.artifact,
        projectId: project.id,
      });
    }
    // Prefer project-scoped install (_packages/ model)
    const record = await installPackageToProject(body, projectRoot);

    writeAuditLog({
      userId: session.id,
      action: 'package.install',
      target: record.packageId,
      details: { projectId: project.id, slug: record.slug },
    });

    return NextResponse.json({
      package: {
        packageId: record.packageId,
        slug: record.slug,
        packageRoot: record.packageRoot,
        trust: record.trust,
      },
    }, { status: 201 });
  } catch (error) {
    console.error('[packages/install] failed', error);
    return NextResponse.json({ error: 'Package install failed' }, { status: 400 });
  }
}
