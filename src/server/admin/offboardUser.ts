/**
 * The platform USER-record lifecycle: disable, enable, password reset, and the
 * delete (offboarding) that composes them. One body for every caller — the
 * admin routes (`/api/admin/users/[id]`) and the host-shell break-glass CLI
 * (`scripts/user.mts`) — so the epoch bump, the owner floor and the audit rows
 * cannot drift between them.
 *
 * WHO may act is decided before these run (`canGovernUserRecord` in
 * `projects/access.ts`); what these guarantee is the SHAPE of each transition:
 *
 * - disable and password reset bump `sessionEpoch`, so every cookie the user
 *   holds is refused on its next request (the `jwt` callback compares it);
 * - enable does NOT bump and resumes nothing — work that paused while the user
 *   was disabled stays paused until a person resumes it;
 * - delete = owner-floor preflight → disable → membership sweep in EVERY project
 *   (archived included) through the store's producer → the user's credential
 *   scope → tombstone, with ONE audit row carrying the counts.
 *
 * Package-owned state (running turns, terminals, channel pollers, webtops,
 * user-scope sources) is not touched here: the status/epoch/tombstone writes
 * emit the `UserStore` change signal and the membership sweep emits the
 * `ProjectStore` one; the revocation fan-out subscribed to them closes it.
 */

import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { canGovernUserRecord, isOwnerStrengthOf, leavesProjectWithoutActiveOwner } from '../projects/access';
import { isPrincipalActive } from '../auth/memberSession';
import {
  getUserById,
  sessionEpochOf,
  tombstoneUser,
  updateUser,
} from '../store/UserStore';
import {
  listAllProjects,
  ProjectUpdateError,
  updateProject,
  type ProjectRecord,
} from '../store/ProjectStore';
import { getCredentialStore } from '../store/credentialStoreInstance';
import { writeAuditLog } from '../store/AuditStore';
import { nowISO } from '../../lib/utils';

/** Who performs a lifecycle write: a signed-in user, or the operator on the host shell. */
export type UserLifecycleActor =
  | { kind: 'user'; userId: string; email: string }
  | { kind: 'cli'; operator: string };

function auditIdentity(actor: UserLifecycleActor): { userId: string | null; userEmail?: string } {
  return actor.kind === 'user' ? { userId: actor.userId, userEmail: actor.email } : { userId: null };
}

function actorDetails(actor: UserLifecycleActor): Record<string, string> {
  return actor.kind === 'cli' ? { via: 'cli', operator: actor.operator } : {};
}

/** active → disabled, with an epoch bump. `false` when nothing changed. */
export async function disableUser(targetId: string, actor: UserLifecycleActor): Promise<boolean> {
  const seen: { email: string | null } = { email: null };
  const disabledBy = actor.kind === 'user' ? actor.userId : `cli:${actor.operator}`;
  await updateUser(targetId, (current) => {
    if (current.status !== 'active') return null;
    seen.email = current.email;
    return {
      status: 'disabled',
      sessionEpoch: sessionEpochOf(current) + 1,
      disabledAt: nowISO(),
      disabledBy,
    };
  });
  if (seen.email === null) return false;
  await writeAuditLog({
    ...auditIdentity(actor),
    action: 'user.disable',
    target: targetId,
    details: { email: seen.email, ...actorDetails(actor) },
  });
  return true;
}

/** disabled → active. No epoch bump, nothing resumed. `false` when nothing changed. */
export async function enableUser(targetId: string, actor: UserLifecycleActor): Promise<boolean> {
  const seen: { email: string | null } = { email: null };
  await updateUser(targetId, (current) => {
    if (current.status !== 'disabled') return null;
    seen.email = current.email;
    return { status: 'active', disabledAt: undefined, disabledBy: undefined };
  });
  if (seen.email === null) return false;
  await writeAuditLog({
    ...auditIdentity(actor),
    action: 'user.enable',
    target: targetId,
    details: { email: seen.email, ...actorDetails(actor) },
  });
  return true;
}

/**
 * A fresh temporary password (the user must change it at the next login) and an
 * epoch bump, so a session opened with the old password ends. Returns the
 * temporary password once, or `null` when there is no such (non-deleted) user.
 */
export async function resetUserPassword(targetId: string, actor: UserLifecycleActor): Promise<string | null> {
  const tempPassword = randomBytes(9).toString('base64url');
  const passwordHash = await bcrypt.hash(tempPassword, 12);
  const seen: { email: string | null } = { email: null };
  await updateUser(targetId, (current) => {
    seen.email = current.email;
    return { passwordHash, mustChangePassword: true, sessionEpoch: sessionEpochOf(current) + 1 };
  });
  if (seen.email === null) return null;
  await writeAuditLog({
    ...auditIdentity(actor),
    action: 'user.password_reset',
    target: targetId,
    details: { email: seen.email, ...actorDetails(actor) },
  });
  return tempPassword;
}

export type BlockingProject = {
  projectId: string;
  name: string;
  reason: 'provenance_owner' | 'last_active_owner';
};

/**
 * A refusal names only the projects the CALLER is a member of; the rest are a
 * count, so the answer never enumerates a tenant the caller cannot see.
 */
export type OwnerFloorRefusal = { blocking: BlockingProject[]; hiddenBlockingCount: number };

function splitByVisibility(
  callerId: string,
  blocked: Array<{ project: ProjectRecord; reason: BlockingProject['reason'] }>,
): OwnerFloorRefusal | null {
  if (blocked.length === 0) return null;
  const blocking: BlockingProject[] = [];
  let hiddenBlockingCount = 0;
  for (const { project, reason } of blocked) {
    if (project.members[callerId]) blocking.push({ projectId: project.id, name: project.name, reason });
    else hiddenBlockingCount += 1;
  }
  return { blocking, hiddenBlockingCount };
}

/**
 * The projects `targetId` is the last ACTIVE owner-strength member of. Reads
 * the status of each other owner-strength member through the ONE liveness port.
 */
async function lastActiveOwnerProjects(targetId: string, projects: readonly ProjectRecord[]): Promise<ProjectRecord[]> {
  const coOwners = new Set<string>();
  for (const project of projects) {
    if (!isOwnerStrengthOf(project, targetId)) continue;
    for (const userId of Object.keys(project.members)) {
      if (userId !== targetId && isOwnerStrengthOf(project, userId)) coOwners.add(userId);
    }
  }
  const active = new Set<string>();
  await Promise.all(
    [...coOwners].map(async (userId) => {
      if (await isPrincipalActive(userId)) active.add(userId);
    }),
  );
  return leavesProjectWithoutActiveOwner(targetId, projects, active);
}

/** The disable floor: refused when a project would be left without an active owner. */
export async function checkDisableFloor(
  callerId: string,
  targetId: string,
  projects: readonly ProjectRecord[],
): Promise<OwnerFloorRefusal | null> {
  const blocked = await lastActiveOwnerProjects(targetId, projects);
  return splitByVisibility(
    callerId,
    blocked.map((project) => ({ project, reason: 'last_active_owner' as const })),
  );
}

export type OffboardPreflight = OwnerFloorRefusal & {
  /** Projects (archived included) the user is a member of — every one is left. */
  memberships: number;
  /** The user-scope credential ids that are deleted with the user. */
  credentialIds: string[];
};

/**
 * What a delete would do, and what refuses it: the provenance owner of a
 * project (there is no transfer path) and the last active owner of one.
 */
export async function preflightOffboard(
  callerId: string,
  targetId: string,
  projects: readonly ProjectRecord[],
): Promise<OffboardPreflight> {
  const lastOwner = new Set((await lastActiveOwnerProjects(targetId, projects)).map((p) => p.id));
  const blocked: Array<{ project: ProjectRecord; reason: BlockingProject['reason'] }> = [];
  for (const project of projects) {
    if (project.ownerId === targetId) blocked.push({ project, reason: 'provenance_owner' });
    else if (lastOwner.has(project.id)) blocked.push({ project, reason: 'last_active_owner' });
  }
  const refusal = splitByVisibility(callerId, blocked) ?? { blocking: [], hiddenBlockingCount: 0 };
  return {
    ...refusal,
    memberships: projects.filter((p) => p.members[targetId] !== undefined).length,
    credentialIds: getCredentialStore().listUser(targetId),
  };
}

export type OffboardCounts = { memberships: number; assignments: number; credentials: number };

export type OffboardResult =
  | { ok: true; counts: OffboardCounts }
  | { ok: false; code: 'not_found' }
  | ({ ok: false; code: 'blocked' } & OwnerFloorRefusal)
  /** A project changed under the sweep; the user stays DISABLED, nothing was deleted. */
  | { ok: false; code: 'changed'; counts: OffboardCounts };

/**
 * Delete a user: preflight → disable → sweep every membership (and every
 * `assignedTo` reference) → delete the user credential scope → tombstone.
 *
 * Each membership removal re-derives the caller's authority on the record as it
 * is on disk (the same predicate the route asked, over that one project); a
 * refusal stops the sweep with the user already disabled — a safe, reversible
 * state — and the tombstone is never written. `createdBy` stays: it is
 * provenance, and an agent's creator is an authority source for `agents:'own'`.
 */
export async function offboardUser(input: {
  caller: { userId: string; email: string };
  targetId: string;
  /** The snapshot the route authorized against (archived included). */
  projects: readonly ProjectRecord[];
}): Promise<OffboardResult> {
  const { caller, targetId } = input;
  const target = await getUserById(targetId);
  if (!target || target.status === 'deleted') return { ok: false, code: 'not_found' };

  const preflight = await preflightOffboard(caller.userId, targetId, input.projects);
  if (preflight.blocking.length > 0 || preflight.hiddenBlockingCount > 0) {
    return {
      ok: false,
      code: 'blocked',
      blocking: preflight.blocking,
      hiddenBlockingCount: preflight.hiddenBlockingCount,
    };
  }

  const actor: UserLifecycleActor = { kind: 'user', userId: caller.userId, email: caller.email };
  await disableUser(targetId, actor);

  // Re-listed AFTER the disable: a membership granted between the snapshot and
  // now is swept too.
  const counts: OffboardCounts = { memberships: 0, assignments: 0, credentials: 0 };
  const sweptProjects: string[] = [];
  for (const project of await listAllProjects({ includeArchived: true })) {
    const referenced =
      project.members[targetId] !== undefined
      || Object.values(project.agentOwnership ?? {}).some((o) => o.assignedTo.includes(targetId));
    if (!referenced) continue;
    const step = { refused: false, member: false, assignments: 0 };
    try {
      await updateProject(project.id, (fresh) => {
        if (!canGovernUserRecord({
          callerId: caller.userId,
          targetId,
          projects: [fresh],
          verb: 'delete',
          callerHoldsPlatformUsers: true,
        })) {
          step.refused = true;
          return null;
        }
        const members = { ...fresh.members };
        step.member = members[targetId] !== undefined;
        delete members[targetId];
        const agentOwnership: ProjectRecord['agentOwnership'] = {};
        for (const [agentId, entry] of Object.entries(fresh.agentOwnership ?? {})) {
          const assignedTo = entry.assignedTo.filter((userId) => userId !== targetId);
          step.assignments += entry.assignedTo.length - assignedTo.length;
          agentOwnership[agentId] = { ...entry, assignedTo };
        }
        if (!step.member && step.assignments === 0) return null;
        return { members, agentOwnership };
      });
    } catch (err) {
      if (!(err instanceof ProjectUpdateError)) throw err;
      step.refused = true;
    }
    if (step.refused) {
      // The removals already made are real writes — they are recorded, under the
      // membership action, never as a delete that did not happen.
      if (sweptProjects.length > 0) {
        await writeAuditLog({
          ...auditIdentity(actor),
          action: 'project.update',
          target: targetId,
          details: { reason: 'offboard_incomplete', email: target.email, ...counts, projects: sweptProjects },
        });
      }
      return { ok: false, code: 'changed', counts };
    }
    if (step.member) counts.memberships += 1;
    counts.assignments += step.assignments;
    if (step.member || step.assignments > 0) sweptProjects.push(project.id);
  }

  counts.credentials = getCredentialStore().deleteUserScope(targetId);
  await tombstoneUser(targetId, caller.userId);
  await writeAuditLog({
    ...auditIdentity(actor),
    action: 'user.delete',
    target: targetId,
    details: { email: target.email, ...counts, projects: sweptProjects },
  });
  return { ok: true, counts };
}
