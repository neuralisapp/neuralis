/**
 * toProjectView — the ONE feature-keyed projection of a `ProjectRecord` for
 * member-facing reads (owner decision D2, periodic-pelican phase 2).
 *
 * A bare project membership used to return the FULL record (every member's
 * email, every role's grant list, every member's spend cap) to every role that
 * can call `GET /api/projects*` — including `viewer`. The projection keys each
 * sensitive slice on a FEATURE (never a role name, per D-A):
 *
 *   - `project.members` → OTHER members' emails
 *   - `project.roles`   → OTHER roles' `grantedFeatures` + `packageTrust` +
 *                         `packageAccessFeature` + `appliedPackageGrants`
 *   - `project.limits`  → OTHER members' `limits.spend.byUser` rows
 *
 * Two floors that are NOT feature-keyed:
 *
 *   - SELF-KNOWLEDGE: the caller always sees their OWN member row in full
 *     (email included), their OWN byUser spend row, and their OWN role's
 *     `grantedFeatures` — the workspace client gates widgets/skills off
 *     `roles[ownRole].grantedFeatures` (buildWorkspaceHostPort/UserInfo), so
 *     stripping it would blank the workspace for exactly the weak roles this
 *     projection protects.
 *   - WRITE-IMPLIES-READ: a caller whose role carries `canManageRoles: true`
 *     gets the FULL record. The members/roles/limits WRITE gate is that flag,
 *     and the limits editor round-trips the fetched copy into a wholesale
 *     `spend` replace — a flag-holder on a projected copy would silently erase
 *     every other member's byUser row on save (the leak-fix-widens-privilege
 *     class). Costs no security: a flag holder can grant themselves the three
 *     features anyway.
 *
 * The admin package's `projects/:id` route applies the SAME reductions
 * in-handler (it cannot import host code); the two copies are kept
 * field-identical by test.
 */

import { hasFeature } from '@neuralis/package-system/access';
import type {
  ProjectRecord,
  ProjectMember,
  RoleDefinition,
} from '../store/projectTypes';

export type ProjectViewCaller = {
  userId: string;
  /** The caller's resolved grant list for THIS project (undefined ⇒ none). */
  grantedFeatures: readonly string[] | undefined;
};

export type ProjectMemberView = Omit<ProjectMember, 'email'> & { email?: string };
export type RoleDefinitionView = Omit<RoleDefinition, 'grantedFeatures'> & {
  grantedFeatures?: string[];
};

export type ProjectView = Omit<ProjectRecord, 'members' | 'roles'> & {
  members: Record<string, ProjectMemberView>;
  roles: Record<string, RoleDefinitionView>;
};

export function toProjectView(project: ProjectRecord, caller: ProjectViewCaller): ProjectView {
  const session = { grantedFeatures: caller.grantedFeatures ? [...caller.grantedFeatures] : undefined };
  const ownRole = project.members[caller.userId]?.role;

  // WRITE-IMPLIES-READ: the members/roles/limits write gate is the flag.
  if (ownRole && project.roles[ownRole]?.canManageRoles) return project;

  const seeEmails = hasFeature(session, 'project.members');
  const seeRoles = hasFeature(session, 'project.roles');
  const seeLimits = hasFeature(session, 'project.limits');
  if (seeEmails && seeRoles && seeLimits) return project;

  const members: Record<string, ProjectMemberView> = {};
  for (const [id, m] of Object.entries(project.members)) {
    if (seeEmails || id === caller.userId) {
      members[id] = m;
    } else {
      const { email: _email, ...rest } = m;
      members[id] = rest;
    }
  }

  const roles: Record<string, RoleDefinitionView> = {};
  for (const [name, r] of Object.entries(project.roles)) {
    if (seeRoles || name === ownRole) {
      roles[name] = r;
    } else {
      const { grantedFeatures: _grants, ...rest } = r;
      roles[name] = rest;
    }
  }

  const byUser = seeLimits
    ? project.limits.spend.byUser
    : Object.fromEntries(
        Object.entries(project.limits.spend.byUser).filter(([id]) => id === caller.userId),
      );

  const view: ProjectView = {
    ...project,
    members,
    roles,
    limits: { ...project.limits, spend: { ...project.limits.spend, byUser } },
  };
  if (!seeRoles) {
    delete view.packageTrust;
    delete view.packageAccessFeature;
    delete view.appliedPackageGrants;
  }
  return view;
}
