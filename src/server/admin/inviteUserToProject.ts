/**
 * inviteUserToProject — the ONE invite gate body, two callers.
 *
 * Extracted (NOT copied) from `POST /api/admin/users` so the cookie route and
 * the admin package's `members-invite` route (reached via the
 * `hostPorts.governance` port) can never drift: a record's structural
 * invariant binds every WRITER, and so does its authorization gate.
 *
 * Caller identity arrives as a SCALAR `callerUserId` and the floor is
 * re-derived from the LIVE `ProjectRecord` here — never from cached grants and
 * never from caller-supplied role/feature fields (the port-shape rule). It is
 * re-derived TWICE: once on the snapshot (the cheap early error code, before
 * `createUser` runs) and once INSIDE the store's write chain, on the record as
 * it is on disk — the caller's `canInvite`, the caller's own priority, the
 * target role's existence AND its priority, plus the member's `tier`. A change
 * that lands between the two answers `null` (no write) and the snapshot's error
 * code shape, and the account created for the invite is removed again.
 *
 * Errors are TYPED codes: the cookie wrapper maps them to its historical
 * texts/statuses; the package route collapses `role_unknown` and
 * `role_too_strong` into one generic 403 (unified posture, no role oracle).
 */

import { randomBytes } from 'crypto';
import { getProjectById, updateProject } from '../store/ProjectStore';
import { createUser, deleteUser, getUserById } from '../store/UserStore';
import type { ProjectMember, ProjectRecord } from '../store/projectTypes';
import { canAssignRole, rolePriority } from '@neuralis/package-system/access';
import { nowISO } from '../../lib/utils';
import { writeAuditLog } from '../store/AuditStore';
import { hashPassword, validatePasswordComplexity } from '../auth/passwordPolicy';

export type InviteUserInput = {
  email: string;
  name: string;
  role?: string;
  /**
   * Cookie-path only. The package route rejects a body `password` outright —
   * a caller-supplied password would arrive through chat and persist in the
   * member-readable, vector-indexed transcript.
   */
  password?: string;
};

export type InviteUserError =
  | { code: 'project_not_found' }
  | { code: 'caller_not_member' }
  | { code: 'caller_role_unresolved' }
  | { code: 'not_invite_capable' }
  | { code: 'missing_fields' }
  | { code: 'role_unknown'; role: string }
  | { code: 'role_too_strong'; reason: string }
  | { code: 'password_policy'; reason: string }
  | { code: 'email_exists'; message: string };

export type InviteUserResult =
  | {
      ok: true;
      user: { id: string; email: string; name: string };
      role: string;
      /** Present only when no explicit password was supplied (cookie path). */
      tempPassword?: string;
    }
  | { ok: false; error: InviteUserError };

/**
 * The ONE invite floor, over a project record as given (a snapshot, or the
 * record inside the store's write chain): the caller is a member, their role
 * resolves and carries `canInvite`, and — with a `targetRole` — that role
 * exists and is no stronger than the caller's (`canAssignRole`). `null` = allowed.
 * The invite-link verbs and the redeem's live re-check of the INVITER call it too.
 */
export function checkInviteFloor(
  project: Pick<ProjectRecord, 'members' | 'roles'>,
  callerUserId: string,
  targetRole: string | null,
): InviteUserError | null {
  const member = project.members[callerUserId];
  if (!member) return { code: 'caller_not_member' };
  const roleDef = project.roles[member.role];
  if (!roleDef) return { code: 'caller_role_unresolved' };
  // The invite-shaped governance flag — the same floor `requireAdmin` carries.
  if (!roleDef.canInvite) return { code: 'not_invite_capable' };
  if (targetRole === null) return null;
  const targetRoleDef = project.roles[targetRole];
  if (!targetRoleDef) return { code: 'role_unknown', role: targetRole };
  // An admin may not invite someone with a role stronger than their own.
  const roleCheck = canAssignRole({
    callerPriority: rolePriority(member.role, roleDef.priority),
    targetPriority: rolePriority(targetRole, targetRoleDef.priority),
  });
  return roleCheck.allowed ? null : { code: 'role_too_strong', reason: roleCheck.reason };
}

/**
 * The member row an invite writes, computed from the role AS IT IS on the
 * record handed in — `tier` mirrors the role's ordinal priority so it never
 * diverges from the role definition; `position` stays a free-text label (D-A).
 */
export function memberRecordFor(
  project: Pick<ProjectRecord, 'roles'>,
  user: { id: string; name: string; email: string },
  role: string,
): ProjectMember {
  return {
    userId: user.id,
    name: user.name,
    email: user.email,
    role,
    position: '',
    tier: rolePriority(role, project.roles[role]?.priority),
    addedAt: nowISO(),
  };
}

export async function inviteUserToProject(
  callerUserId: string,
  projectId: string,
  input: InviteUserInput,
): Promise<InviteUserResult> {
  const project = await getProjectById(projectId);
  if (!project) return { ok: false, error: { code: 'project_not_found' } };

  const callerFloor = checkInviteFloor(project, callerUserId, null);
  if (callerFloor) return { ok: false, error: callerFloor };

  const email = input.email?.trim();
  const name = input.name?.trim();
  if (!email || !name) return { ok: false, error: { code: 'missing_fields' } };

  const targetRole = input.role ?? 'member';
  const floor = checkInviteFloor(project, callerUserId, targetRole);
  if (floor) return { ok: false, error: floor };

  // Whitespace-only used to slip past complexity AND `mustChangePassword` while
  // the generated temp password was silently discarded; trimming once up front
  // makes "no usable password" one state.
  const password = input.password?.trim() || undefined;
  if (password) {
    const check = validatePasswordComplexity(password);
    if (!check.valid) {
      return { ok: false, error: { code: 'password_policy', reason: check.reason ?? 'Invalid password' } };
    }
  }

  const tempPassword = password ?? randomBytes(9).toString('base64url');
  const hash = await hashPassword(tempPassword);

  let user;
  try {
    user = await createUser(email, name, hash, {
      status: 'active',
      mustChangePassword: !password,
      invitedBy: callerUserId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed';
    if (msg.includes('already exists')) {
      return { ok: false, error: { code: 'email_exists', message: msg } };
    }
    throw err;
  }

  // Producer form: the member map is built from the record the store's chain
  // just read, so a concurrent invite is not erased — and the producer re-derives
  // the WHOLE floor the snapshot above checked, not just the target role's
  // existence. The window that makes the full set load-bearing: an owner
  // strengthens a custom role from 10 to 1 while an admin (priority 2) is
  // inviting into it — the snapshot's `canAssignRole` allowed it, and the
  // member would land in a now-apex role carrying a stale `tier` computed from
  // the OLD priority. `tier` is therefore computed here too, from the role as it
  // is on disk.
  //
  // The snapshot pre-checks stay: they are the cheap early error codes (and
  // they answer BEFORE `createUser` runs, which is the ordering that matters for
  // the common case). These are the fence, and every refusal writes nothing.
  const refusal: { error: InviteUserError | null } = { error: null };
  const written = await updateProject(project.id, (p) => {
    // A role that vanished in between is a typed refusal here: without it the
    // write reaches `validateProjectInvariants`, which throws a generic error
    // AFTER `createUser` already ran.
    refusal.error = checkInviteFloor(p, callerUserId, targetRole);
    if (refusal.error) return null;
    return { members: { ...p.members, [user.id]: memberRecordFor(p, user, targetRole) } };
  }).catch(async (err: unknown) => {
    await deleteUser(user.id);
    throw err;
  });
  if (refusal.error || written === null) {
    // The record was created for THIS membership and never received it: remove
    // it, or a refused invite leaves an account nobody administers.
    await deleteUser(user.id);
    return { ok: false, error: refusal.error ?? { code: 'project_not_found' } };
  }

  const caller = await getUserById(callerUserId);
  void writeAuditLog({
    userId: callerUserId,
    ...(caller ? { userEmail: caller.email } : {}),
    action: 'user.invite',
    target: user.id,
    details: { email: user.email, role: targetRole, projectId: project.id },
  });

  return {
    ok: true,
    user: { id: user.id, email: user.email, name: user.name },
    role: targetRole,
    ...(password ? {} : { tempPassword }),
  };
}
