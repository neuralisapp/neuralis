/**
 * PUT /api/projects/:id/packages/:slug/trust
 *
 * Flip a user package's trust level. Storage stays in the platform zone
 * (`ProjectRecord.packageTrust`) so agents cannot self-elevate via `fs_write`.
 *
 * Body: { trust: 'trusted' | 'untrusted' | null }
 *   - 'trusted' / 'untrusted' — pin an override
 *   - null — clear the override (revert to manifest default)
 *
 * After the write, the host reloads the package so the new trust level takes
 * effect in the running runtime (WASM memory caps, allowedHosts, etc.).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/server/auth/session';
import { getProjectById, setPackageTrust } from '@/server/store/ProjectStore';
import { writeAuditLog } from '@/server/store/AuditStore';
import { getPackageRuntimeManager } from '@/server/packages/PackageRuntimeManager';
import { getProjectPackageScanner } from '@/server/packages/ProjectPackageScanner';
import { getEnv } from '@/server/config/env';
import { getLogger } from '@/server/logging/setup';
import { resolveProjectRoot } from '@neuralis/package-system/paths';
import { canManagePackages, resolveProjectAccess } from '@/server/projects/access';

type Params = { params: Promise<{ id: string; slug: string }> };

export async function PUT(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const session = await requireSession().catch(() => null);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: projectId, slug } = await params;
  const project = await getProjectById(projectId);
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const access = await resolveProjectAccess(session.id, projectId);
  if (!access || !canManagePackages(access)) {
    return NextResponse.json(
      { error: 'Forbidden: package management permission required' },
      { status: 403 },
    );
  }

  const body = await req.json().catch(() => null);
  if (!body || !('trust' in body)) {
    return NextResponse.json(
      { error: 'Invalid body: { trust: "trusted" | "untrusted" | null } required' },
      { status: 400 },
    );
  }
  const trust = body.trust as unknown;
  if (trust !== 'trusted' && trust !== 'untrusted' && trust !== null) {
    return NextResponse.json(
      { error: 'Invalid trust value: must be "trusted", "untrusted", or null' },
      { status: 400 },
    );
  }

  // Verify the package actually exists in this project before writing trust.
  const env = getEnv();
  const logger = getLogger().child('package-trust');
  const projectRoot = resolveProjectRoot(env.projectsRoot, projectId);
  const scanner = getProjectPackageScanner(projectRoot, logger);
  await scanner.scan();
  const record = scanner.getPackage(slug);
  if (!record) {
    return NextResponse.json(
      { error: `Package "${slug}" not found in project "${projectId}"` },
      { status: 404 },
    );
  }

  // First-party packages are immutable for trust (they live outside _packages/
  // and this route can't reach them; still, refuse defensively).
  const manifestTrust = record.definition.access?.trust;
  if (manifestTrust === 'first-party') {
    return NextResponse.json(
      { error: 'Cannot change trust of a first-party package' },
      { status: 400 },
    );
  }

  // Write trust to ProjectRecord (platform zone).
  const updated = await setPackageTrust(projectId, record.packageId, trust as 'trusted' | 'untrusted' | null);
  if (!updated) {
    return NextResponse.json({ error: 'Failed to persist trust' }, { status: 500 });
  }

  await writeAuditLog({
    userId: session.id,
    action: 'package.trust.change',
    target: `${projectId}/${slug}`,
    details: { trust, packageId: record.packageId },
  });

  // Reload so the loader picks up the new trust immediately (affects WASM limits,
  // cross-package API gating, and allowedHosts).
  let reloadError: string | undefined;
  try {
    await getPackageRuntimeManager().reloadProjectPackage(projectId, slug);
  } catch (err) {
    reloadError = err instanceof Error ? err.message : String(err);
    logger.warn('Package reload after trust change failed', {
      projectId,
      slug,
      packageId: record.packageId,
      error: reloadError,
    });
  }

  return NextResponse.json({
    ok: true,
    trust,
    ...(reloadError ? { reloadWarning: 'reload-failed' } : {}),
  });
}
