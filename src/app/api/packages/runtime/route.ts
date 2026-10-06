/**
 * GET /api/packages/runtime
 *
 * Full PackageRuntimeSnapshot for the community workspace.
 * Snapshot ETag is returned for clients, but requests are always rebuilt because
 * metadata is filtered by the caller's current feature grants.
 */

import { NextRequest, NextResponse } from 'next/server';
import type { PackageRuntimeSnapshot } from '@neuralis/package-system/contracts';
import { requireSession } from '@/server/auth/session';
import { ensureCommunityRuntime } from '@/server/packages/runtime';
import { ensureProjectPackagesLoaded } from '@/server/packages/projectPackages';
import { getPackageSnapshot } from '@/server/packages/snapshot';
import { getUiAttachments, viewUiAttachments } from '@/server/packages/packageUiModules';
import { resolveProjectAccess } from '@/server/projects/access';
import { resolveVerifiedAgentScope } from '@/server/auth/resolveVerifiedAgentScope';

export async function GET(req: NextRequest): Promise<NextResponse> {
  let session;
  try {
    session = await requireSession();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const projectId = req.headers.get('x-project-id')?.trim() || '';
  if (!projectId) {
    return NextResponse.json({ error: 'Missing projectId' }, { status: 400 });
  }
  const access = await resolveProjectAccess(session.id, projectId);
  if (!access) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  // A raw header is not an agent identity: a forged, unknown or inaccessible
  // id resolves to NO agent — never a 403, which would confirm the id exists.
  const agentId = await resolveVerifiedAgentScope(access.session, req.headers.get('x-agent-id') ?? undefined);

  // Ensure agent-core registry is ready before accessing sync getters
  await ensureCommunityRuntime();

  // Ensure project packages are loaded before building snapshot
  await ensureProjectPackagesLoaded(projectId);

  // The first-party UI modules + the union stylesheet, built once per
  // first-party package set. A build failure costs the attachments, never the
  // snapshot.
  const ui = await getUiAttachments().catch(() => null);

  // The snapshot is read from the shared registry as it stands — this route
  // writes nothing into it. An agent's own MCP servers reach that agent as its
  // `[mcp]` tools, never as packages in a process-global registry every other
  // project's snapshot is built from.
  const snapshot = getPackageSnapshot(
    {
      host: 'neuralis-workspace',
      projectId,
      userId: session.id,
      ...(agentId ? { agentId } : {}),
      role: access.member.role,
      grantedFeatures: access.role.grantedFeatures,
      ...(access.project.packageAccessFeature ? { packageAccessFeature: access.project.packageAccessFeature } : {}),
    },
    access.role.grantedFeatures,
  );

  // `ui` rides beside the snapshot: modules of the packages THIS snapshot
  // shows, and the one sheet.
  const body: PackageRuntimeSnapshot = ui
    ? { ...snapshot, ui: viewUiAttachments(ui, new Set(snapshot.packages.map((pkg) => pkg.id))) }
    : snapshot;
  return NextResponse.json(body, {
    headers: {
      ETag: `"${snapshot.revision}"`,
      'Cache-Control': 'no-cache',
    },
  });
}
