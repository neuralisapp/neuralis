import { NextResponse } from 'next/server';
import { requireAdmin } from '@/server/auth/adminGuard';
import { resolveRequestProjectId } from '@/server/auth/requestProject';
import { findUserByEmail, getUserById, listUsers, type UserRecord } from '@/server/store/UserStore';
import { listAllProjects } from '@/server/store/ProjectStore';
import { hasFeature } from '@neuralis/package-system/access';
import { inviteUserToProject } from '@/server/admin/inviteUserToProject';
import { canGovernUserRecord, type UserRecordVerb } from '@/server/projects/access';

const FORBIDDEN = 'Forbidden: insufficient permissions';

/**
 * A guard refusal (`Not a project member` covers a missing project too) is the
 * same 403 as a missing flag, so the status never tells a caller whether a
 * project id exists.
 */
function errorResponse(err: unknown): NextResponse {
  const msg = err instanceof Error ? err.message : 'Failed';
  if (msg === 'Unauthorized') return NextResponse.json({ error: msg }, { status: 401 });
  if (msg.startsWith('Forbidden') || msg === 'Not a project member') {
    return NextResponse.json({ error: msg.startsWith('Forbidden') ? msg : FORBIDDEN }, { status: 403 });
  }
  return NextResponse.json({ error: msg }, { status: 400 });
}

const RECORD_VERBS: Record<'resetPassword' | 'disable' | 'enable' | 'rename' | 'delete', UserRecordVerb> = {
  resetPassword: 'reset_password',
  disable: 'disable',
  enable: 'enable',
  rename: 'rename',
  delete: 'delete',
};

/**
 * GET /api/admin/users — the user roster of the project the caller administers
 * (`canInvite` there), enriched with each user's role in it.
 *
 * - Without `platform.users` the roster is THIS project's members only; with it,
 *   every platform user (tombstones excluded) plus their memberships
 *   (`projects[]`, a cross-project disclosure, `[]` otherwise).
 * - `?email=<address>` is an EXACT lookup — how an administrator adds an
 *   existing user to a project without being shown everyone else.
 * - Each row carries `can`: which user-record verbs this caller may run on it,
 *   decided by the SAME `canGovernUserRecord` the PATCH/DELETE routes enforce —
 *   the tab hides what the server would refuse and never re-derives it.
 *
 * The project comes from the `X-Project-Id` HEADER; a `?projectId=` is accepted
 * as an agreeing override.
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const resolved = resolveRequestProjectId(request, url.searchParams.get('projectId'));
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }
    const ctx = await requireAdmin(resolved.projectId);
    const callerHoldsPlatformUsers = hasFeature(
      { grantedFeatures: ctx.memberRole.grantedFeatures },
      'platform.users',
    );

    const email = url.searchParams.get('email');
    let users: Array<UserRecord | null>;
    if (email !== null) {
      users = email.trim() ? [await findUserByEmail(email)] : [];
    } else if (callerHoldsPlatformUsers) {
      users = await listUsers();
    } else {
      users = await Promise.all(Object.keys(ctx.project.members).map((userId) => getUserById(userId)));
    }
    const listed = users.filter((u): u is UserRecord => u !== null && u.status !== 'deleted');

    const allProjects = await listAllProjects({ includeArchived: true });
    const enriched = listed.map((u) => {
      const member = ctx.project.members[u.id];
      const memberships = callerHoldsPlatformUsers
        ? allProjects
            .filter((p) => p.archivedAt == null && p.members[u.id])
            .map((p) => ({ id: p.id, name: p.name, role: p.members[u.id]!.role }))
        : [];
      const can = Object.fromEntries(
        Object.entries(RECORD_VERBS).map(([key, verb]) => [
          key,
          canGovernUserRecord({
            callerId: ctx.user.id,
            targetId: u.id,
            projects: allProjects,
            verb,
            callerHoldsPlatformUsers,
          }),
        ]),
      ) as Record<keyof typeof RECORD_VERBS, boolean>;
      // The exact lookup reaches a user outside the caller's project so they can
      // be added — it answers who they are, never their account state.
      if (!member && !callerHoldsPlatformUsers) {
        return { id: u.id, email: u.email, name: u.name, isMember: false, can };
      }
      return {
        id: u.id,
        email: u.email,
        name: u.name,
        status: u.status,
        mustChangePassword: u.mustChangePassword,
        lastLoginAt: u.lastLoginAt ?? null,
        invitedBy: u.invitedBy ?? null,
        createdAt: u.createdAt,
        role: member?.role ?? null,
        position: member?.position ?? null,
        tier: member?.tier ?? null,
        isMember: !!member,
        projects: memberships,
        can,
      };
    });

    return NextResponse.json({ users: enriched });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * POST /api/admin/users — invite a new user + add them to a project.
 *
 * Thin cookie wrapper over the ONE invite gate body,
 * `server/admin/inviteUserToProject` (shared with the admin package's
 * `members-invite` route through the governance port — one body, two callers).
 * `requireAdmin` here resolves the SESSION and the historical error texts; the
 * service re-derives the same floor from the live record and decides.
 *
 * The invite TARGET is the project this route authorizes against. Before, it was
 * `requireAdmin()` (⇒ the caller's first project, project **A**) while the write
 * landed on `body.projectId` (project **B**) — and it wrote A's member map into
 * B, replacing B's membership with A's ∪ the new user. Guarding the target
 * closes both halves: the guarded project IS the target.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = await request.json();

    const { email, name, role, password, projectId } = body as {
      email?: string;
      name?: string;
      role?: string;
      password?: string;
      projectId?: string;
    };

    const resolved = resolveRequestProjectId(request, projectId);
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }
    const ctx = await requireAdmin(resolved.projectId);

    const result = await inviteUserToProject(ctx.user.id, ctx.project.id, {
      email: email ?? '',
      name: name ?? '',
      ...(role !== undefined ? { role } : {}),
      ...(password !== undefined ? { password } : {}),
    });

    if (!result.ok) {
      const e = result.error;
      switch (e.code) {
        case 'missing_fields':
          return NextResponse.json({ error: 'email and name are required' }, { status: 400 });
        case 'role_unknown':
          return NextResponse.json({ error: `Unknown role: ${e.role}` }, { status: 400 });
        case 'role_too_strong':
          return NextResponse.json({ error: e.reason }, { status: 403 });
        case 'password_policy':
          return NextResponse.json({ error: e.reason }, { status: 400 });
        case 'email_exists':
          return NextResponse.json({ error: e.message }, { status: 409 });
        // The guard above already proved membership + canInvite; these arms are
        // unreachable races (project deleted mid-flight) — deny like the guard.
        default:
          return NextResponse.json({ error: 'Forbidden: insufficient permissions' }, { status: 403 });
      }
    }

    return NextResponse.json(
      {
        user: result.user,
        tempPassword: result.tempPassword,
        role: result.role,
      },
      { status: 201 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed';
    if (msg.includes('already exists')) {
      return NextResponse.json({ error: msg }, { status: 409 });
    }
    return errorResponse(err);
  }
}
