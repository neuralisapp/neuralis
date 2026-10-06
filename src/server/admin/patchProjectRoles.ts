/**
 * patchProjectRoles — the ONE role-map write body behind the admin package's
 * `PATCH config/roles`, reached through the `hostPorts.governance`
 * port. Sibling of `inviteUserToProject` / `createProjectForUser` /
 * `assignAgentToUser`: SCALAR caller identity, floor re-derived from the LIVE
 * `ProjectRecord`, typed error codes the route maps to its historical texts.
 *
 * WHY it exists: this route used to write `<project>.json` RAW — read the file,
 * mutate, `${file}.tmp.${Date.now()}` + rename — outside the store's per-record
 * chain, outside `ProjectStore`, with a clock-keyed temp name and no cache bust.
 * A role save racing a package grant apply/revoke lost in BOTH directions and
 * could still tear the record. It needed a host-injected copy of the structural
 * invariant to be safe at all, because it never went through `updateProject`.
 * Now it does, and that port is gone.
 *
 * A package route must NEVER write a host record directly. The port is the only
 * path — that prohibition is the surviving half of the lesson, and it stands
 * whatever the next writer looks like.
 *
 * The whole decision runs INSIDE `updateProject`'s producer, on the record as it
 * is on disk at write time: the governance flag, the caller's own priority and
 * grant set, and the kernel write floor are all re-derived there, so a caller
 * demoted since the request arrived is refused rather than served.
 */

import { updateProject, ProjectUpdateError } from '../store/ProjectStore';
import { canManageProjectRoles, validateRoles } from '../projects/access';
import { resolveProjectRoleContext } from '../auth/resolveSessionContext';
import { validateRoleMapWrite, type RoleDefinitionLike } from '@neuralis/package-system/access';
import type { RoleDefinition } from '../store/projectTypes';

export type PatchProjectRolesResult =
  | { ok: true; project: { id: string } }
  | {
      ok: false;
      error: {
        /**
         * `denied` — the caller's role does not carry the governance flag.
         * `forbidden` — the kernel role-map write floor refused (with a reason).
         * `invalid` — the role-map SHAPE floor or the record's structural
         *   invariant refused (with a reason).
         * `not_found` — no such project.
         */
        code: 'not_found' | 'denied' | 'forbidden' | 'invalid';
        reason?: string;
      };
    };

export async function patchProjectRoles(
  callerUserId: string,
  projectId: string,
  roles: Record<string, RoleDefinitionLike>,
): Promise<PatchProjectRolesResult> {
  const refusal: { denied: boolean; forbidden: string | null; invalid: string | null } = {
    denied: false,
    forbidden: null,
    invalid: null,
  };

  let project;
  try {
    project = await updateProject(projectId, (p) => {
      const ctx = resolveProjectRoleContext(p, callerUserId);
      const member = p.members[callerUserId];
      const roleDef = ctx.role ? p.roles[ctx.role] : undefined;

      // GOVERNANCE gate — the role's own `canManageRoles` FLAG, and nothing
      // else. Deliberately NOT the module's own feature: `project.roles` is what
      // the RouteDispatcher already required to reach the handler, so an arm on
      // it would be vacuously true and would hand the whole role map to every
      // READ-tier holder. Governance must not be self-grantable through a
      // capability toggle.
      if (!member || !roleDef || !canManageProjectRoles({ member, role: roleDef })) {
        refusal.denied = true;
        return null;
      }
      // Deny-by-default on an unresolvable caller: the kernel body takes a
      // REQUIRED priority + grant set, and both plausible defaults are wrong.
      if (ctx.priority === undefined || ctx.grantedFeatures === undefined) {
        refusal.denied = true;
        return null;
      }

      // STRUCTURAL shape FIRST among the validators (but AFTER the governance
      // gate — a caller who may not write must not learn shape verdicts). The
      // same floor the host `PATCH /api/projects/[id]` runs, and nothing below
      // covers it: the kernel write floor normalizes a non-array
      // `grantedFeatures` to `[]` instead of rejecting it, and the record
      // invariant inspects no role shape — so this path used to persist
      // `{"grantedFeatures":"x"}` that the host route refused.
      const shapeError = validateRoles(roles);
      if (shapeError) {
        refusal.invalid = shapeError;
        return null;
      }

      // Priority + feature-conservation guard via the shared kernel body — the
      // same function the host's `validateRolesPatchPriority` calls.
      const denial = validateRoleMapWrite({
        existing: p.roles,
        next: roles,
        caller: { priority: ctx.priority, grantedFeatures: ctx.grantedFeatures },
      });
      if (denial) {
        refusal.forbidden = denial;
        return null;
      }

      // WHOLE-MAP write, exactly as before: an omitted name is a DELETE, and the
      // write floor above is built on that. The cast is the bridge from the
      // caller-supplied JSON the kernel body validates to the stored shape; the
      // structural invariant inside `updateProject` is what rejects a map the
      // record cannot hold (an orphaned owner, a member pointing at a role that
      // no longer exists).
      return { roles: roles as Record<string, RoleDefinition> };
    });
  } catch (err) {
    if (err instanceof ProjectUpdateError) {
      return { ok: false, error: { code: 'invalid', reason: err.message } };
    }
    throw err;
  }

  if (project === null) return { ok: false, error: { code: 'not_found' } };
  if (refusal.denied) return { ok: false, error: { code: 'denied' } };
  if (refusal.invalid) return { ok: false, error: { code: 'invalid', reason: refusal.invalid } };
  if (refusal.forbidden) return { ok: false, error: { code: 'forbidden', reason: refusal.forbidden } };
  return { ok: true, project: { id: project.id } };
}
