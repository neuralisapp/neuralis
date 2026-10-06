/**
 * POST /api/projects/:id/packages/:slug/build
 *
 * Run the WASM build pipeline for a user package (`_packages/{slug}/`).
 * Requires an authenticated session, project membership, and package-management
 * permission. Build output is executable package runtime input, so it is treated
 * as a privileged package operation even when trust does not change.
 *
 * Response: JSON with build log, success flag, durationMs. On success the host
 * reloads the package so the freshly built `dist/package.wasm` picks up.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/server/auth/session';
import { getProjectById } from '@/server/store/ProjectStore';
import { writeAuditLog } from '@/server/store/AuditStore';
import { getPackageRuntimeManager } from '@/server/packages/PackageRuntimeManager';
import { getProjectPackageScanner } from '@/server/packages/ProjectPackageScanner';
import { getEnv } from '@/server/config/env';
import { getLogger } from '@/server/logging/setup';
import { resolveProjectRoot } from '@neuralis/package-system/paths';
import {
  buildWasmPackage,
  hasSourceCode,
} from '@neuralis/package-system/runtime/wasm-build';
import { resolveGuestPdkPath } from '@/server/host/builtinSlots';
import { canManagePackages, resolveProjectAccess } from '@/server/projects/access';

type Params = { params: Promise<{ id: string; slug: string }> };

type BuildResult = {
  ok: boolean;
  slug: string;
  wasmPath?: string;
  logs: string[];
  durationMs: number;
  error?: string;
};

const BUILD_FAILED = 'build-failed';
const RELOAD_FAILED = 'reload-failed';

export async function POST(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  const session = await requireSession().catch(() => null);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id: projectId, slug } = await params;
  const project = await getProjectById(projectId);
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const access = await resolveProjectAccess(session.id, projectId);
  if (!access) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (!canManagePackages(access)) {
    return NextResponse.json({ error: 'Forbidden: package management permission required' }, { status: 403 });
  }

  const env = getEnv();
  const logger = getLogger().child('package-build');
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

  const logs: string[] = [];
  const started = Date.now();

  if (!hasSourceCode(record.packageRoot)) {
    const result: BuildResult = {
      ok: false,
      slug,
      logs: ['No buildable source found. A WASM package needs at least one of: src/tools/*.ts, src/routes/*.ts, src/lifecycle.ts (the node convention; the old single-entry src/index.ts is no longer supported).'],
      durationMs: Date.now() - started,
      error: 'no-source',
    };
    return NextResponse.json(result, { status: 400 });
  }

  logs.push('Building WASM package');

  let wasmPath: string | undefined;
  let buildError: string | undefined;
  try {
    // The host resolves the guest PDK path from its runtime layout (bundling-immune)
    // and passes it — wasmBuild's own `require.resolve`/`__dirname` self-resolution
    // fails inside the Next bundle (BUG B).
    wasmPath = await buildWasmPackage(record.packageRoot, { pdkGuestPath: resolveGuestPdkPath() });
    logs.push('Build complete');
  } catch (err) {
    buildError = err instanceof Error ? err.message : String(err);
    logger.error('Package build failed', { projectId, slug, packageId: record.packageId, error: buildError });
    logs.push('Build failed. Check server logs for details.');
  }

  const durationMs = Date.now() - started;

  await writeAuditLog({
    userId: session.id,
    action: 'package.build',
    target: `${projectId}/${slug}`,
    details: { success: !buildError, durationMs, error: buildError },
  });

  if (buildError) {
    const result: BuildResult = { ok: false, slug, logs, durationMs, error: BUILD_FAILED };
    return NextResponse.json(result, { status: 500 });
  }

  // Reload package so the loader transitions from `partial` → `loaded` (WASM wired).
  try {
    await getPackageRuntimeManager().reloadProjectPackage(projectId, slug);
    logs.push('Package reloaded; runtime ready');
  } catch (err) {
    const reloadErr = err instanceof Error ? err.message : String(err);
    logger.warn('Package reload after build failed', { projectId, slug, packageId: record.packageId, error: reloadErr });
    logs.push(`Reload after build failed (${RELOAD_FAILED}). Run rescan or check server logs.`);
    // Keep ok=true because the build itself succeeded; the user can manually rescan.
  }

  logger.info('Package build completed', { projectId, slug, packageId: record.packageId, wasmPath });
  const result: BuildResult = { ok: true, slug, logs, durationMs };
  return NextResponse.json(result);
}
