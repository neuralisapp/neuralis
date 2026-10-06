import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/server/auth/session';
import { SetupRequiredError, assertSetupComplete } from '@/server/init';
import { listProjectsForUser } from '@/server/store/ProjectStore';
import { createProjectForUser } from '@/server/admin/createProjectForUser';
import { toProjectView } from '@/server/projects/projectView';
import { resolveProjectRoleContext } from '@/server/auth/resolveSessionContext';

export async function GET(): Promise<NextResponse> {
  let user;
  try {
    user = await requireSession();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    await assertSetupComplete();
  } catch (err) {
    if (err instanceof SetupRequiredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
  const projects = await listProjectsForUser(user.id);
  // D2 — every record through the ONE feature-keyed projection, with the
  // caller's features resolved PER PROJECT (they differ across memberships).
  return NextResponse.json(
    projects.map((p) =>
      toProjectView(p, {
        userId: user.id,
        grantedFeatures: resolveProjectRoleContext(p, user.id).grantedFeatures,
      }),
    ),
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let user;
  try {
    user = await requireSession();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    await assertSetupComplete();
  } catch (err) {
    if (err instanceof SetupRequiredError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid project body' }, { status: 400 });
  }
  const { name, description } = body as { name?: unknown; description?: unknown };

  // Thin cookie wrapper over the ONE create gate body,
  // `server/admin/createProjectForUser` (shared with the admin package's
  // `projects-create` route through the governance port). Gate order —
  // owner-strength BEFORE capacity (non-inference) — lives in the service.
  const result = await createProjectForUser(user.id, {
    name: typeof name === 'string' ? name : '',
    ...(typeof description === 'string' ? { description } : {}),
  });

  if (!result.ok) {
    switch (result.error.code) {
      case 'invalid_name':
        return NextResponse.json({ error: result.error.message }, { status: 400 });
      case 'not_owner_strength':
        return NextResponse.json({ error: 'Only an owner can create projects' }, { status: 403 });
      case 'project_limit':
        return NextResponse.json(
          { error: `Project limit reached (max ${result.error.max})` },
          { status: 403 },
        );
      case 'seed_failed':
        return NextResponse.json({ error: result.error.message }, { status: 409 });
      case 'runtime_not_ready':
        return NextResponse.json(
          { error: 'The platform is still starting — try again shortly', code: 'runtime_not_ready' },
          { status: 503 },
        );
      case 'provisioning_failed':
        return NextResponse.json(
          { error: result.error.message, code: 'provisioning_failed' },
          { status: 503 },
        );
      // caller_unknown: a live cookie session without a user record is a race.
      default:
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  // Uniform projection on the create echo — the creator is seeded as owner
  // (canManageRoles) so this resolves to the full record by construction.
  return NextResponse.json(
    toProjectView(result.project, {
      userId: user.id,
      grantedFeatures: resolveProjectRoleContext(result.project, user.id).grantedFeatures,
    }),
    { status: 201 },
  );
}
