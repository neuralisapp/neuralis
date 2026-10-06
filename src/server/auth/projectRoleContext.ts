/**
 * `resolveProjectRoleContext` — the ONE projection of a `ProjectRecord` into the
 * role / grants / priority / ownership / limits a `SessionContext` carries.
 *
 * It lives in its OWN module, not beside `resolveSessionContext`, because it is
 * a PURE function over a record while that file's other half imports NextAuth's
 * options, which read boot-critical env at module scope. Every consumer that
 * only needs the projection — the catch-all cookie branch, and the ONE member
 * resolver (`memberSession.ts`) every storage-rebuilt session goes through —
 * gets it without that import chain. It stays pure: the user-status and
 * archive gates live in the resolver that FEEDS it. `resolveSessionContext` re-exports it, so there is
 * still exactly one implementation and one import path for existing callers.
 */

import type { ProjectRecord } from '../store/ProjectStore';
import type { SessionContext } from '@neuralis/package-system/contracts';
import { rolePriority, rolePrioritiesOf } from '@neuralis/package-system/access';

export interface ProjectRoleContext {
  role: string | undefined;
  priority: number | undefined;
  /**
   * The project's role → priority map. Travels on the `SessionContext` so the
   * uri-policy role layer can order a `byRole` entry written against a CUSTOM
   * role name by STRENGTH instead of comparing it by name — the gates that read
   * it live in packages and never see a `ProjectRecord`.
   */
  rolePriorities: Record<string, number> | undefined;
  grantedFeatures: string[] | undefined;
  agentAccess: '*' | 'own' | 'view' | undefined;
  agentOwnership: Record<string, { createdBy: string; assignedTo: string[] }> | undefined;
  spendLimits: SessionContext['spendLimits'];
  llmRateLimitRpm: number | null | undefined;
}

/**
 * Resolve a member's role / features / priority / spend-limits / ownership from a
 * project record. The ONE implementation of the catch-all's cookie-branch
 * deny-gate inputs — imported by the catch-all route, `resolveSessionContext`
 * and the member resolver so they can never drift (architect F4). A non-member
 * (or missing project) yields `role`/`grantedFeatures` undefined ⇒ the caller
 * denies (deny-by-default).
 */
export function resolveProjectRoleContext(
  project: ProjectRecord | null,
  userId: string,
): ProjectRoleContext {
  const ctx: ProjectRoleContext = {
    role: undefined,
    priority: undefined,
    rolePriorities: undefined,
    grantedFeatures: undefined,
    agentAccess: undefined,
    agentOwnership: undefined,
    spendLimits: undefined,
    llmRateLimitRpm: undefined,
  };
  if (!project) return ctx;
  ctx.rolePriorities = rolePrioritiesOf(project.roles);
  const member = project.members[userId];
  if (member) {
    ctx.role = member.role;
    const roleDef = project.roles[member.role];
    if (roleDef) {
      ctx.grantedFeatures = roleDef.grantedFeatures;
      ctx.agentAccess = roleDef.agents;
      ctx.priority = rolePriority(member.role, roleDef.priority);
    }
  }
  if (project.limits?.spend) ctx.spendLimits = project.limits.spend;
  if (project.limits?.rateLimitRpm != null) ctx.llmRateLimitRpm = project.limits.rateLimitRpm;
  if (project.agentOwnership) ctx.agentOwnership = project.agentOwnership;
  return ctx;
}
