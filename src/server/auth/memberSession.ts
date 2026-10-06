/**
 * The ONE host member resolver — every identity producer's chain.
 *
 * A request, a credential or a stored principal becomes a `SessionContext`
 * only through {@link resolveMember}: user record present AND `active` →
 * project present AND not archived → member → role definition →
 * `resolveProjectRoleContext`. A principal refused anywhere on that chain gets
 * NO session, so every consumer's existing deny branch handles it; no consumer
 * carries a second status check.
 *
 * Callers take the view they need off the same object: the unattended port and
 * the `:3101` MCP scope take `.session`, `adminGuard` reads `roleDef`
 * (`canInvite`), `resolveProjectAccess` reads `{ project, member, roleDef }`.
 * The cookie family reaches {@link resolveActiveUser} through the NextAuth `jwt`
 * callback; the `:3101` companions through `resolveSessionUser`.
 *
 * `projectRoleContext.ts` stays a pure function over a record — the status and
 * archive gates live here, in the resolver that feeds it.
 */

import type { SessionContext } from '@neuralis/package-system/contracts';
import { getUserById, isActiveUser, sessionEpochOf, type UserRecord } from '../store/UserStore';
import { getProjectById, type ProjectRecord } from '../store/ProjectStore';
import type { ProjectMember, RoleDefinition } from '../store/projectTypes';
import { resolveProjectRoleContext } from './projectRoleContext';

/**
 * The epoch a cookie session was ISSUED under. A token minted before epochs
 * existed carries none and reads as 0 — it matches an un-bumped record and dies
 * at the first bump. It is never backfilled from the record: a backfill would
 * re-arm a token minted before a password reset.
 */
export type SessionTokenEpoch = { sessionEpoch?: unknown };

/**
 * The user record when the principal may hold a session: present, `active`,
 * and — when a session token is given — issued under the record's current
 * epoch. A READ error propagates (fail closed: the caller refuses, at the cost
 * of a forced re-login).
 */
export async function resolveActiveUser(
  userId: string,
  token?: SessionTokenEpoch,
): Promise<UserRecord | null> {
  const record = await getUserById(userId);
  if (!record || !isActiveUser(record)) return null;
  if (token) {
    const issued = typeof token.sessionEpoch === 'number' ? token.sessionEpoch : 0;
    if (issued !== sessionEpochOf(record)) return null;
  }
  return record;
}

/**
 * The host port a package calls when it must ask "is this principal still
 * active" (a refresh grant, an OAuth bearer, a poller resync) — never
 * `getUserById` + its own `status` compare, which would admit a tombstone. With
 * a `projectId` it asks the whole member chain there (removed member, archived
 * project ⇒ `false`); with a `sessionEpoch` the grant must be issued under the
 * record's current epoch, exactly like a cookie session.
 */
export async function isPrincipalActive(userId: string, projectId?: string, sessionEpoch?: number): Promise<boolean> {
  if (!(await resolveActiveUser(userId, sessionEpoch === undefined ? undefined : { sessionEpoch }))) return false;
  return projectId === undefined || (await resolveMember(userId, projectId)) !== null;
}

export type ResolvedMember = {
  project: ProjectRecord;
  member: ProjectMember;
  roleDef: RoleDefinition;
  /** `priority` is always resolved here — a role definition exists. */
  session: SessionContext & { priority: number };
};

export async function resolveMember(userId: string, projectId: string): Promise<ResolvedMember | null> {
  if (!(await resolveActiveUser(userId))) return null;
  const project = await getProjectById(projectId);
  // An archived project is disabled: its scheduled work must not fire, its
  // package routes must not answer, and its `:3101` sessions must not resolve.
  // `getProjectById` stays unfiltered for the restore/permanent paths.
  if (!project || project.archivedAt != null) return null;
  const member = project.members[userId];
  if (!member) return null;
  const roleDef = project.roles[member.role];
  if (!roleDef) return null;
  const roleCtx = resolveProjectRoleContext(project, userId);
  if (!roleCtx.role || !roleCtx.grantedFeatures || roleCtx.priority === undefined) return null;
  return {
    project,
    member,
    roleDef,
    session: {
      userId,
      projectId,
      role: roleCtx.role,
      priority: roleCtx.priority,
      rolePriorities: roleCtx.rolePriorities,
      grantedFeatures: [...roleCtx.grantedFeatures],
      agentAccess: roleCtx.agentAccess,
      ...(roleCtx.agentOwnership ? { agentOwnership: roleCtx.agentOwnership } : {}),
      ...(roleCtx.spendLimits ? { spendLimits: roleCtx.spendLimits } : {}),
      ...(roleCtx.llmRateLimitRpm != null ? { llmRateLimitRpm: roleCtx.llmRateLimitRpm } : {}),
    },
  };
}

/** The `SessionResolverPort` shape — the view the unattended fire/wake paths take. */
export async function resolveMemberSession(userId: string, projectId: string): Promise<SessionContext | null> {
  return (await resolveMember(userId, projectId))?.session ?? null;
}
