import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { requireAdmin, requireProjectFeature, type AdminContext } from '@/server/auth/adminGuard';
import { resolveRequestProjectId } from '@/server/auth/requestProject';
import { requireSession } from '@/server/auth/session';
import { getUserById, updateUser } from '@/server/store/UserStore';
import { listAllProjects, updateProject } from '@/server/store/ProjectStore';
import { canAssignRole, hasFeature, rolePriority } from '@neuralis/package-system/access';
import { writeAuditLog } from '@/server/store/AuditStore';
import { validatePasswordComplexity } from '@/server/auth/passwordPolicy';
import { beginLoginAttempt, recordLoginFailure, recordLoginSuccess } from '@/server/auth/rateLimit';
import { resolveClientAddress } from '@/server/auth/requestClient';
import { canGovernUserRecord, diffMemberMaps, type UserRecordVerb } from '@/server/projects/access';
import {
  checkDisableFloor,
  disableUser,
  enableUser,
  offboardUser,
  preflightOffboard,
  resetUserPassword,
} from '@/server/admin/offboardUser';

type RouteParams = { params: Promise<{ id: string }> };

/** ONE refusal for every governance denial — no answer says which project or rule refused. */
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

/**
 * PATCH /api/admin/users/[id]
 *
 * Self-service: a user updates their OWN name/password. Those two branches run
 * BEFORE any project guard and must stay first — `neuralis/src/api/admin.ts`
 * `changeOwnPassword` (the workspace PasswordChangeModal) sends no project at
 * all, and requiring one would lock every member out of their own password.
 *
 * Admin operations (`canInvite` in the guarded project) split by what they
 * touch. `role` is PROJECT-scoped: it changes one member row of the named
 * project, under the role-priority rule there. `name`, `status` and
 * `resetPassword` act on the platform-global USER record, which every project
 * of the target shares — they pass only through `canGovernUserRecord` (the
 * caller governs the target in EVERY project the target belongs to). Nobody
 * acts on their own record here; disable is refused when it would leave a
 * project without an active owner; disable and reset sign the target out on
 * every device (epoch bump). The project comes from the `X-Project-Id` HEADER,
 * with `body.projectId` accepted as an agreeing override.
 */
export async function PATCH(request: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id } = await params;
    const session = await requireSession();
    const body = await request.json();
    const isSelf = session.id === id;

    const target = await getUserById(id);
    if (!target || target.status === 'deleted') {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Self-service password change — on the login limiter's `(email, address)`
    // axis, so a stolen cookie cannot guess the current password without limit.
    if (isSelf && body.currentPassword && body.newPassword) {
      const address = resolveClientAddress(request.headers).address;
      const gate = beginLoginAttempt(target.email, address);
      if (gate.kind !== 'proceed') {
        return NextResponse.json(
          { error: 'Too many attempts' },
          { status: 429, headers: { 'Retry-After': String(gate.retryAfter) } },
        );
      }
      if (gate.waitMs > 0) await new Promise((resolve) => setTimeout(resolve, gate.waitMs));
      const valid = await bcrypt.compare(body.currentPassword, target.passwordHash);
      if (!valid) {
        recordLoginFailure(target.email, address);
        return NextResponse.json({ error: 'Incorrect current password' }, { status: 403 });
      }
      recordLoginSuccess(target.email, address);

      const check = validatePasswordComplexity(body.newPassword);
      if (!check.valid) {
        return NextResponse.json({ error: check.reason }, { status: 400 });
      }

      const hash = await bcrypt.hash(body.newPassword, 12);
      await updateUser(id, { passwordHash: hash, mustChangePassword: false });
      return NextResponse.json({ ok: true });
    }

    // Self-service name change
    if (isSelf && body.name && !body.status && !body.resetPassword) {
      await updateUser(id, { name: body.name.trim() });
      return NextResponse.json({ ok: true });
    }

    // Admin operations require canInvite in the named project.
    const resolved = resolveRequestProjectId(request, body.projectId);
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }
    const ctx = await requireAdmin(resolved.projectId);

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const statusVerb = body.status === 'disabled' ? 'disable' : body.status === 'active' ? 'enable' : null;
    const recordVerbs: UserRecordVerb[] = [];
    if (name) recordVerbs.push('rename');
    if (statusVerb) recordVerbs.push(statusVerb);
    if (body.resetPassword) recordVerbs.push('reset_password');

    if (recordVerbs.length > 0) {
      if (isSelf && statusVerb === 'disable') {
        return NextResponse.json({ error: 'Cannot disable yourself' }, { status: 400 });
      }
      const projects = await listAllProjects({ includeArchived: true });
      const callerHoldsPlatformUsers = hasFeature({ grantedFeatures: ctx.memberRole.grantedFeatures }, 'platform.users');
      const governed = recordVerbs.every((verb) =>
        canGovernUserRecord({ callerId: ctx.user.id, targetId: id, projects, verb, callerHoldsPlatformUsers }),
      );
      if (!governed) return NextResponse.json({ error: FORBIDDEN }, { status: 403 });
      if (statusVerb === 'disable' && target.status === 'active') {
        const refusal = await checkDisableFloor(ctx.user.id, id, projects);
        if (refusal) {
          return NextResponse.json(
            { error: 'Disabling this user would leave a project without an active owner', ...refusal },
            { status: 409 },
          );
        }
      }
    }

    const actor = { kind: 'user' as const, userId: ctx.user.id, email: ctx.user.email };
    if (name) {
      await updateUser(id, { name });
      await writeAuditLog({ userId: ctx.user.id, userEmail: ctx.user.email, action: 'user.rename', target: id, details: { email: target.email, from: target.name, to: name } });
    }
    if (statusVerb === 'disable') await disableUser(id, actor);
    if (statusVerb === 'enable') await enableUser(id, actor);
    let tempPassword: string | null = null;
    if (body.resetPassword) {
      tempPassword = await resetUserPassword(id, actor);
      if (tempPassword === null) return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    if (body.role) {
      const denial = await changeProjectRole(ctx, id, body.role);
      if (denial) return denial;
    }

    return NextResponse.json(tempPassword === null ? { ok: true } : { ok: true, tempPassword });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * The project-scoped half: one member row of the named project. The caller may
 * not promote above their own priority nor touch a member stronger than them —
 * checked on the snapshot (a cheap early 403) and again inside the store's write
 * chain on the record as it is on disk, with the CALLER's priority re-derived
 * there too. Audited as a membership write of that project.
 */
async function changeProjectRole(ctx: AdminContext, id: string, role: string): Promise<NextResponse | null> {
  const member = ctx.project.members[id];
  const targetRoleDef = ctx.project.roles[role];
  if (!member || !targetRoleDef) return null;
  const promoteCheck = canAssignRole({
    callerPriority: ctx.callerPriority,
    targetPriority: rolePriority(role, targetRoleDef.priority),
  });
  if (!promoteCheck.allowed) {
    return NextResponse.json({ error: promoteCheck.reason }, { status: 403 });
  }
  const touchCheck = canAssignRole({
    callerPriority: ctx.callerPriority,
    targetPriority: rolePriority(member.role, ctx.project.roles[member.role]?.priority),
  });
  if (!touchCheck.allowed) {
    return NextResponse.json(
      { error: 'Forbidden: cannot change the role of a member stronger than you.' },
      { status: 403 },
    );
  }
  const denial: { reason: string | null } = { reason: null };
  const seen: { before: typeof ctx.project.members | null; after: typeof ctx.project.members | null } = {
    before: null,
    after: null,
  };
  const written = await updateProject(ctx.project.id, (p) => {
    const freshTarget = p.members[id];
    const freshTargetRoleDef = p.roles[role];
    const freshCaller = p.members[ctx.user.id];
    const freshCallerRoleDef = freshCaller ? p.roles[freshCaller.role] : undefined;
    if (!freshTarget || !freshTargetRoleDef || !freshCaller || !freshCallerRoleDef) {
      denial.reason = 'Forbidden: the project changed during the role write.';
      return null;
    }
    const callerPriority = rolePriority(freshCaller.role, freshCallerRoleDef.priority);
    const promote = canAssignRole({
      callerPriority,
      targetPriority: rolePriority(role, freshTargetRoleDef.priority),
    });
    if (!promote.allowed) {
      denial.reason = promote.reason;
      return null;
    }
    const touch = canAssignRole({
      callerPriority,
      targetPriority: rolePriority(freshTarget.role, p.roles[freshTarget.role]?.priority),
    });
    if (!touch.allowed) {
      denial.reason = 'Forbidden: cannot change the role of a member stronger than you.';
      return null;
    }
    const members = {
      ...p.members,
      // Tier mirrors the new role's priority so it never goes stale.
      [id]: { ...freshTarget, role, tier: rolePriority(role, freshTargetRoleDef.priority) },
    };
    seen.before = p.members;
    seen.after = members;
    return { members };
  });
  if (denial.reason) return NextResponse.json({ error: denial.reason }, { status: 403 });
  if (written === null) return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  const diff = seen.before && seen.after ? diffMemberMaps(seen.before, seen.after) : null;
  if (diff) {
    await writeAuditLog({
      userId: ctx.user.id,
      userEmail: ctx.user.email,
      action: 'project.update',
      target: ctx.project.id,
      details: { members: diff },
    });
  }
  return null;
}

/**
 * Resolve the caller for the DELETE family: `platform.users` in the named
 * project (a user record is platform-global), then the SAME record predicate
 * the PATCH verbs use, over every project the target belongs to.
 */
async function authorizeDelete(
  request: Request,
  id: string,
): Promise<{ ok: true; ctx: AdminContext; projects: Awaited<ReturnType<typeof listAllProjects>> } | { ok: false; response: NextResponse }> {
  const resolved = resolveRequestProjectId(request, new URL(request.url).searchParams.get('projectId'));
  if (!resolved.ok) {
    return { ok: false, response: NextResponse.json({ error: resolved.error }, { status: resolved.status }) };
  }
  const ctx = await requireProjectFeature(resolved.projectId, 'platform.users');
  if (ctx.user.id === id) {
    return { ok: false, response: NextResponse.json({ error: 'Cannot delete yourself' }, { status: 400 }) };
  }
  const target = await getUserById(id);
  if (!target || target.status === 'deleted') {
    return { ok: false, response: NextResponse.json({ error: 'User not found' }, { status: 404 }) };
  }
  const projects = await listAllProjects({ includeArchived: true });
  const governed = canGovernUserRecord({
    callerId: ctx.user.id,
    targetId: id,
    projects,
    verb: 'delete',
    callerHoldsPlatformUsers: true,
  });
  if (!governed) return { ok: false, response: NextResponse.json({ error: FORBIDDEN }, { status: 403 }) };
  return { ok: true, ctx, projects };
}

/**
 * GET /api/admin/users/[id] — the DELETE preflight: what a delete would remove
 * (memberships, user-scope credential ids) and which projects refuse it (the
 * user is their provenance owner, or their last active owner). Same gate as
 * DELETE; changes nothing.
 */
export async function GET(request: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id } = await params;
    const auth = await authorizeDelete(request, id);
    if (!auth.ok) return auth.response;
    return NextResponse.json({ preflight: await preflightOffboard(auth.ctx.user.id, id, auth.projects) });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * DELETE /api/admin/users/[id] — offboard the user: disable (signed out
 * everywhere) → leave EVERY project, archived included → the user credential
 * scope is deleted → the record becomes a tombstone (`status: 'deleted'`, the
 * email free for a new account). Refused with 409 while the user is a project's
 * provenance owner or its last active owner; one audit row carries the counts.
 */
export async function DELETE(request: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const { id } = await params;
    const auth = await authorizeDelete(request, id);
    if (!auth.ok) return auth.response;

    const result = await offboardUser({
      caller: { userId: auth.ctx.user.id, email: auth.ctx.user.email },
      targetId: id,
      projects: auth.projects,
    });
    if (result.ok) return NextResponse.json({ ok: true, counts: result.counts });
    switch (result.code) {
      case 'not_found':
        return NextResponse.json({ error: 'User not found' }, { status: 404 });
      case 'blocked':
        return NextResponse.json(
          {
            error: 'This user is the creator or the last active owner of a project, so the account cannot be deleted',
            blocking: result.blocking,
            hiddenBlockingCount: result.hiddenBlockingCount,
          },
          { status: 409 },
        );
      case 'changed':
        return NextResponse.json(
          { error: 'A project changed during the delete; the user is disabled and was not deleted', counts: result.counts },
          { status: 409 },
        );
    }
  } catch (err) {
    return errorResponse(err);
  }
}
