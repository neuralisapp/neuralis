/**
 * Project record STRUCTURAL invariants — the ONE body, in a dependency-free
 * module.
 *
 * Two byte-similar copies used to exist (`projects/access.ts
 * validateProjectInvariants` and `store/ProjectStore.ts
 * validateProjectRecordInvariants`) and they had already drifted: only the
 * `access.ts` one validated `agentOwnership`. This module is the merge of both
 * (the superset).
 *
 * ADOPTION by every WRITER is the invariant — consolidating the body was never
 * enough on its own. It runs at exactly TWO sites, both inside `ProjectStore`:
 * every write `updateProject` makes (object form or producer) and the rename
 * branch. The narrow setters (`setProjectArchived` / `setPackageTrust` /
 * `setPackageAccessFeature`) and `getAndMigrate`'s persist-on-read skip it BY
 * DESIGN — none of them can touch `members`/`roles`/`agentOwnership`, and
 * throwing on a READ path would brick a legacy record instead of healing it.
 * On top of that, the host `PATCH /api/projects/[id]` pre-validates, and the
 * admin package's `PATCH config/roles` reaches it by going through
 * `patchProjectRoles` on the `hostPorts.governance` port into that same
 * `updateProject`.
 *
 * That last one is why this paragraph exists. It used to write `<project>.json`
 * RAW — outside `updateProject` entirely — and was unguarded until a live probe
 * used it: `{"roles":{}}` returned `200` and erased every role of a real
 * project, `owner` included, while the host route rejected the byte-identical
 * body. The stop-gap was a second globalThis port carrying THIS function across
 * the package boundary; the real fix was removing the raw write. **A package
 * route never writes a host record directly — the governance port is the only
 * path, and a new writer of this record belongs on `updateProject`, not beside
 * it.**
 *
 * It lives under `store/` and imports ONLY `projectTypes` on purpose: `access.ts`
 * imports `getProjectById` FROM `ProjectStore.ts`, so putting the shared body in
 * `access.ts` would close a `ProjectStore → access → ProjectStore` cycle — the
 * exact direction `host/builtinFeatures.ts`'s docblock says this layer was split
 * to avoid.
 *
 * These are STRUCTURAL record invariants, not authorization decisions. The
 * `ownerMember.role !== 'owner'` line in particular is NOT a D-A violation: it
 * does not decide what anyone may do, it asserts that the project's provenance
 * owner (`ProjectRecord.ownerId` — "who created it", D-B) is still a member and
 * still holds the seeded `owner` role, so the record cannot be written into a
 * shape where the seeded role is orphaned. Do not "fix" it into a priority check.
 */

import type { ProjectRecord } from './projectTypes';

/**
 * Validate a whole project record. Returns an error string (reject) or `null`.
 *
 * Called by `updateProject` (every store write) and available to any route that
 * wants to pre-flight a patch. Deliberately total over the record — a caller
 * cannot opt out of an arm.
 */
export function validateProjectInvariants(project: ProjectRecord): string | null {
  const ownerMember = project.members[project.ownerId];
  if (!ownerMember) {
    return 'Project owner must remain a member';
  }
  // Provenance invariant, NOT an authority check — see the module docblock.
  if (ownerMember.role !== 'owner') {
    return 'Project owner member must keep the owner role';
  }
  if (!project.roles.owner) {
    return 'Project roles must include owner';
  }
  for (const [userId, member] of Object.entries(project.members)) {
    if (member.userId !== userId) {
      return `Project member key must match userId: ${userId}`;
    }
    if (!project.roles[member.role]) {
      return `Project member "${userId}" references unknown role "${member.role}"`;
    }
  }
  for (const [agentId, ownership] of Object.entries(project.agentOwnership ?? {})) {
    if (!ownership.createdBy || typeof ownership.createdBy !== 'string') {
      return `Agent ownership "${agentId}" must include createdBy`;
    }
    if (!Array.isArray(ownership.assignedTo)) {
      return `Agent ownership "${agentId}" assignedTo must be an array`;
    }
  }
  return null;
}
