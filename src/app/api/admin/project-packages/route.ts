/**
 * GET /api/admin/project-packages
 *
 * Cross-project overview of installed user packages. Read-only. Used by the
 * admin panel Packages tab.
 *
 * Lives on the host (not inside the admin package) because the catch-all
 * `/api/packages/*` route requires a per-request `x-project-id` header — which
 * is antithetical to a cross-project view. This endpoint reads the filesystem
 * directly (same pattern as admin's ProjectStore helpers), then enriches rows
 * with runtime status from the PackageRuntimeManager singleton.
 */

import { NextResponse } from 'next/server';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { requireSession } from '@/server/auth/session';
import { hasPlatformFeatureInAnyProject } from '@/server/projects/access';
import { listAllProjects } from '@/server/store/ProjectStore';
import { getPackageRuntimeManager } from '@/server/packages/PackageRuntimeManager';
import { getEnv } from '@/server/config/env';
import { namespaceProjectPackageId } from '@neuralis/package-system/contracts';

type AdminPackageRow = {
  projectId: string;
  projectName: string;
  slug: string;
  packageId: string;
  name: string;
  version?: string;
  trust: 'first-party' | 'trusted' | 'untrusted';
  trustOverride?: 'trusted' | 'untrusted';
  status: 'active' | 'partial' | 'loading' | 'error' | 'disabled';
  /** Copy 4 of the four-copy union — kernel `PackagePartialReason` is the source. */
  partialReason?: 'build-missing' | 'runtime-unavailable' | 'untrusted-node' | 'untrusted-mcp';
  sourceKind?: string;
  runtimeType?: string;
};

type NeuralisManifest = {
  id?: string;
  name?: string;
  version?: string;
  access?: { trust?: string };
  source?: { kind?: string };
  runtime?: { type?: string };
};

export async function GET(): Promise<NextResponse> {
  const session = await requireSession().catch(() => null);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const projects = await listAllProjects();
  // D-A — this route enumerates `_packages/` across EVERY project, so it is a
  // cross-tenant read with no single `session.projectId` to gate on. The old
  // `role === 'owner' || role === 'admin'` name test is replaced by the ONE
  // feature predicate, evaluated per project (the documented
  // non-`SessionContext` carve-out, sibling of `isOwnerStrengthOfAnyProject`).
  if (!hasPlatformFeatureInAnyProject(session.id, projects, 'platform.projects')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const rows: AdminPackageRow[] = [];
  const env = getEnv();
  const loader = getPackageRuntimeManager().getLoader();

  for (const project of projects) {
    const packagesDir = join(env.projectsRoot, project.id, '_packages');
    const slugs = await readdirSafe(packagesDir);
    const trustOverrides = project.packageTrust ?? {};

    for (const slug of slugs) {
      const pkgRoot = join(packagesDir, slug);
      if (!(await isDirectory(pkgRoot))) continue;

      const manifest = await readManifest(pkgRoot);
      if (!manifest) continue;

      const packageId = manifest.id ?? slug;
      const manifestTrust = (manifest.access?.trust as AdminPackageRow['trust']) ?? 'untrusted';
      const override = trustOverrides[packageId]; // trust key = manifest id (stable)
      const effectiveTrust: AdminPackageRow['trust'] = override ?? manifestTrust;
      // The loader slot is keyed by the scope-NAMESPACED id. This route reads only
      // `{projectId}/_packages/` (project scope), so namespace with `{kind:'project'}`
      // or the status would be stuck at 'loading' forever.
      const loaderStatus = loader.getStatus(
        namespaceProjectPackageId(project.id, { kind: 'project' }, packageId),
      );

      let status: AdminPackageRow['status'] = 'loading';
      if (loaderStatus?.status === 'partial') status = 'partial';
      else if (loaderStatus?.status === 'error') status = 'error';
      else if (loaderStatus?.status === 'loaded') status = 'active';

      rows.push({
        projectId: project.id,
        projectName: project.name,
        slug,
        packageId,
        name: manifest.name ?? slug,
        version: manifest.version,
        trust: effectiveTrust,
        ...(override ? { trustOverride: override } : {}),
        status,
        ...(loaderStatus?.reason
          ? { partialReason: loaderStatus.reason as AdminPackageRow['partialReason'] }
          : {}),
        sourceKind: manifest.source?.kind,
        runtimeType: manifest.runtime?.type,
      });
    }
  }

  rows.sort((a, b) => {
    if (a.projectName !== b.projectName) return a.projectName.localeCompare(b.projectName);
    return a.name.localeCompare(b.name);
  });

  return NextResponse.json({ packages: rows });
}

async function readdirSafe(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readManifest(pkgRoot: string): Promise<NeuralisManifest | null> {
  try {
    const raw = await readFile(join(pkgRoot, 'package.json'), 'utf-8');
    const parsed = JSON.parse(raw) as {
      name?: string;
      version?: string;
      neuralis?: NeuralisManifest;
    };
    return {
      id: parsed.neuralis?.id ?? parsed.name,
      name: parsed.neuralis?.name ?? parsed.name,
      version: parsed.version ?? parsed.neuralis?.version,
      access: parsed.neuralis?.access,
      source: parsed.neuralis?.source,
      runtime: parsed.neuralis?.runtime,
    };
  } catch {
    return null;
  }
}
