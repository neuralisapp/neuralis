/**
 * POST /api/packages/publish
 *
 * Local publish artifact generation in community mode. Exports a project-scoped
 * package definition to a host-derived path UNDER the project root.
 *
 * Trust boundary: like install/command, this is a package-management surface —
 * it requires project membership + `canManagePackages`, never trusts a
 * caller-supplied output path (the artifact is always written under the
 * server-derived project root), and only publishes a package id present in THIS
 * project's scope (scanned packages ∪ deps-discovered builtins).
 */

import { isAbsolute, join, relative } from 'node:path';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/server/auth/session';
import { packageSlug, publishPackage } from '@/server/packages/packagePublisher';
import { getProjectPackageScanner } from '@/server/packages/ProjectPackageScanner';
import { ensureCommunityRuntime } from '@/server/packages/runtime';
import { ensureProjectPackagesLoaded } from '@/server/packages/projectPackages';
import { BUILTIN_PACKAGE_IDS } from '@/server/host/builtinSlots';
import { listProjectsForUser, getProjectById } from '@/server/store/ProjectStore';
import { resolveProjectRoot } from '@neuralis/package-system/paths';
import { getEnv } from '@/server/config/env';
import { writeAuditLog } from '@/server/store/AuditStore';
import { canManagePackages, resolveProjectAccess } from '@/server/projects/access';

/** True when `child` is `parent` or nested within it (no `..` escape, no absolute). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

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

    const requestedProjectId = String(body?.projectId ?? req.headers.get('x-project-id') ?? '').trim();
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

    const packageId = String(body?.packageId ?? '').trim();
    if (!packageId) {
      return NextResponse.json({ error: 'packageId is required' }, { status: 400 });
    }

    await ensureProjectPackagesLoaded(project.id);
    const projectRoot = resolveProjectRoot(getEnv().projectsRoot, project.id);

    // Scope the publishable id to THIS project: deps-discovered builtins ∪ the
    // project's scanned `_packages/`. Never serialize an arbitrary global
    // registry id (cross-tenant metadata-leak primitive).
    const scoped = new Set<string>(BUILTIN_PACKAGE_IDS);
    for (const record of getProjectPackageScanner(projectRoot).listPackages()) {
      scoped.add(record.packageId);
    }
    if (!scoped.has(packageId)) {
      return NextResponse.json({ error: 'Package not available in this project' }, { status: 403 });
    }

    // Defense-in-depth containment: the artifact path is host-derived and must
    // stay under the project root (never a caller-supplied outputDir).
    const artifactBase = join(projectRoot, 'publish', packageSlug(packageId));
    if (!isInside(projectRoot, artifactBase)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const result = publishPackage(packageId, projectRoot);

    writeAuditLog({
      userId: session.id,
      action: 'package.publish',
      target: result.packageId,
      details: { projectId: project.id, artifactPath: result.artifactPath },
    });

    return NextResponse.json({ publish: result }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Package publish failed';
    console.error('[packages/publish] failed', error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
