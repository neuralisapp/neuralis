import { requireSession, type SessionUser } from './session';
import type { ProjectRecord } from '../store/ProjectStore';
import type { ProjectMember, RoleDefinition } from '../store/projectTypes';
import { hasFeature } from '@neuralis/package-system/access';
import { resolveMember } from './memberSession';

/**
 * Guards for the host's own `/api/admin/**` and `/api/oauth/**` routes.
 *
 * **O-2 is closed structurally here.** `projectId` is REQUIRED at the type
 * level — the old "no projectId ⇒ the caller's FIRST listed project" fallback is
 * gone. It silently authorized an operation against a project the caller never
 * named (and, on `POST /api/admin/users`, then WROTE to a different one), and it
 * wrongly refused a legitimate owner whose first-listed project belonged to
 * someone else. Every caller now derives the project explicitly, and `tsc`
 * enumerates them.
 *
 * **D-B is closed here too.** `ProjectRecord.ownerId` is provenance ("who
 * created it") and no longer feeds any authority decision: `isOwner` and
 * `requireOwner` are deleted. Their replacement is
 * {@link requireProjectFeature} — a feature carries the decision, name-free and
 * over the ONE kernel predicate.
 *
 * There is deliberately NO absolute role-STRENGTH guard in this module (D-G).
 * The only decision that genuinely needs one is tenant delete/restore, which
 * cannot be expressed as a feature, and that is carried by `isOwnerStrengthOf`
 * in `server/projects/access.ts`. The relative question ("may I assign THIS
 * rank?") is the kernel's `canAssignRole`. Two helpers for the same absolute
 * question was a trap, not a floor — the next author picks one at random.
 */
export type AdminContext = {
  user: SessionUser;
  project: ProjectRecord;
  member: ProjectMember;
  memberRole: RoleDefinition;
  /** Caller's ordinal role priority (lower = stronger). Gates role assignment. */
  callerPriority: number;
};

/**
 * Resolve the caller's membership context in `projectId`, WITHOUT applying any
 * capability gate. Private: every exported guard adds its own gate on top, so
 * there is exactly one place that resolves identity and several that decide.
 * The chain is the ONE member resolver's, so an archived project, a missing
 * one, a removed member and an unresolvable role are the same refusal.
 */
async function resolveAdminContext(projectId: string): Promise<AdminContext> {
  const user = await requireSession();

  if (!projectId) throw new Error('Missing projectId');

  const resolved = await resolveMember(user.id, projectId);
  if (!resolved) throw new Error('Not a project member');

  return {
    user,
    project: resolved.project,
    member: resolved.member,
    memberRole: resolved.roleDef,
    callerPriority: resolved.session.priority,
  };
}

/**
 * Require the caller to be an admin (`canInvite = true`) of `projectId`.
 *
 * `canInvite` is the invite-shaped governance flag this guard has always meant;
 * it is kept for the user-management routes that genuinely are invite-shaped.
 * Routes whose decision is carried by a FEATURE use {@link requireProjectFeature}
 * instead — see its docblock for why it does not also require `canInvite`.
 */
export async function requireAdmin(projectId: string): Promise<AdminContext> {
  const ctx = await resolveAdminContext(projectId);
  if (!ctx.memberRole.canInvite) throw new Error('Forbidden: insufficient permissions');
  return ctx;
}

/**
 * Feature-gated project guard — the D-B replacement for `requireOwner` on every
 * route whose decision is a capability.
 *
 * **It deliberately does NOT also require `canInvite` (M3).** The feature
 * carries the decision, full stop; stacking the invite flag underneath would be
 * a hidden second gate that silently denies a role an owner explicitly granted
 * the feature to, and would make the feature grant a lie. Reachability is the
 * feature; `canInvite` remains the gate for the invite-shaped routes only.
 *
 * Uses the ONE `hasFeature` predicate — the `'*'` wildcard arm therefore still
 * satisfies it, so owner-strength callers are unaffected.
 */
export async function requireProjectFeature(projectId: string, feature: string): Promise<AdminContext> {
  const ctx = await resolveAdminContext(projectId);
  if (!hasFeature({ grantedFeatures: ctx.memberRole.grantedFeatures }, feature)) {
    throw new Error(`Forbidden: ${feature} required`);
  }
  return ctx;
}
