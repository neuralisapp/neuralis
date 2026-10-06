/**
 * GET /api/agents — the agents of the `X-Project-Id` project the cookie caller
 * may reach, for the workspace's agent list.
 *
 * The host names no product: it resolves the caller through the ONE cookie
 * resolver (`resolveSessionContext` — active user, membership re-verified,
 * deny-by-default role, sentinel refused) and asks whichever package provides
 * the kernel `agent-directory` contract for `listAgents(session)`. The feature
 * gate and the per-agent filter are that provider's, the same body its own
 * agent-list route runs; a refusal it throws (`{ status }`) is answered with
 * that status. No provider mounted ⇒ 503.
 *
 * COOKIE-ONLY by design: a skill script or any other ticket caller lists
 * agents through the provider's own route on the package catch-all.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { getRuntime } from '@/server/host/bootstrap';
import { resolveRequestProjectId } from '@/server/auth/requestProject';
import { getSessionUser } from '@/server/auth/session';
import { resolveSessionContext, SessionResolutionError } from '@/server/auth/resolveSessionContext';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Authentication answers first, as on the package catch-all: an anonymous
  // caller learns nothing about how its request was shaped.
  if (!(await getSessionUser())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const project = resolveRequestProjectId(req, req.nextUrl.searchParams.get('projectId'));
  if (!project.ok) return NextResponse.json({ error: project.error }, { status: project.status });

  let session;
  try {
    // The catch-all route this replaces refuses a must-change-password user.
    session = await resolveSessionContext(req, project.projectId, { refuseMustChangePassword: true });
  } catch (err) {
    if (err instanceof SessionResolutionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  let directory;
  try {
    const runtime = await getRuntime();
    await runtime.whenReady();
    directory = runtime.services.get('agent-directory');
  } catch {
    return NextResponse.json({ error: 'Runtime not ready', code: 'runtime_not_ready' }, { status: 503 });
  }
  if (!directory) {
    return NextResponse.json({ error: 'Agent directory not mounted', code: 'agent_directory_unmounted' }, { status: 503 });
  }

  try {
    return NextResponse.json(await directory.listAgents(session));
  } catch (err) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Refused' }, { status });
    }
    console.error('[api/agents] listAgents failed', err);
    return NextResponse.json({ error: 'Agent list failed' }, { status: 500 });
  }
}
