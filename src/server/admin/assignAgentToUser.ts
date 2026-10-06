/**
 * The `agentOwnership` writers. Two of them, deliberately in one module: it is
 * the ONLY place the map is mutated, and keeping the producer shape in one file
 * is what stops a second, weaker copy appearing.
 *
 *  - `assignAgentToUser` — the admin package's `agents-assign` route, reached
 *    through the `hostPorts.governance` port. A caller ACT, gated.
 *  - `pruneAgentOwnership` — the CONSEQUENCE of an agent create/delete whose
 *    gate already passed. Not a caller act, not on the port, not a route.
 *
 * assignAgentToUser — agent↔user assignment (`agentOwnership.assignedTo`) for
 * the admin package's `agents-assign` route via the
 * `hostPorts.governance` port.
 *
 * Floor = the LIVE role's `canManageRoles` FLAG — identical to the host's
 * privileged `PATCH /api/projects/[id]` gate that carries the same write from
 * the Agents tab. The route's `project.agents.assign` feature is reachability
 * only; feature-without-flag denies (flag-AND-feature — strictly stronger than
 * the flag alone, never weaker).
 *
 * Unknown agent and non-member target return the SAME `denied` code — no
 * existence oracle. A first-time ownership entry takes the agent's REAL
 * creator (`AgentRecord.userId`) resolved through the host's agent-core
 * handle: `createdBy` is an authority source for `agents:'own'` roles, so it
 * is NEVER `''` (both persistence validators reject it) and NEVER the caller
 * (that would silently grant the caller 'own'-update on the agent).
 *
 * Side effect to keep documented: creating an entry where none existed
 * RESTRICTS third parties (record-present-no-match denies read for other
 * `agents:'own'` holders, record-absent read-allows). For that reason a
 * `remove` against an ABSENT entry is a no-write no-op — it must not
 * materialize the record.
 *
 * The ownership map is computed inside an `updateProject` PRODUCER, on the
 * record as it is on disk at write time: carrying the map in from the read
 * above would erase a concurrent assignment. The flag and the target's
 * membership are re-asked there on that same record, and a mid-flight change
 * answers `denied` instead of writing — a fence at the boundary, never a
 * widening.
 */

import { getProjectById, updateProject } from '../store/ProjectStore';
import { canManageProjectRoles } from '../projects/access';
import type { AgentOwnershipEntry } from '../store/projectTypes';
import { getUserById } from '../store/UserStore';
import { writeAuditLog } from '../store/AuditStore';

export type AssignAgentInput = { agentId: string; userId: string; remove?: boolean };

export type AssignAgentError =
  | { code: 'project_not_found' }
  | { code: 'caller_not_member' }
  | { code: 'caller_role_unresolved' }
  | { code: 'not_governance_capable' }
  | { code: 'denied' }
  | { code: 'agent_core_unavailable' };

export type AssignAgentResult =
  | { ok: true; agentId: string; assignedTo: string[]; changed: boolean }
  | { ok: false; error: AssignAgentError };

export async function assignAgentToUser(
  callerUserId: string,
  projectId: string,
  input: AssignAgentInput,
): Promise<AssignAgentResult> {
  const project = await getProjectById(projectId);
  if (!project) return { ok: false, error: { code: 'project_not_found' } };

  const member = project.members[callerUserId];
  if (!member) return { ok: false, error: { code: 'caller_not_member' } };
  const roleDef = project.roles[member.role];
  if (!roleDef) return { ok: false, error: { code: 'caller_role_unresolved' } };
  if (!canManageProjectRoles({ member, role: roleDef })) {
    return { ok: false, error: { code: 'not_governance_capable' } };
  }

  // Resolve the agent through the runtime's `agent-directory` provider (dynamic
  // import — bootstrap publishes the port that calls back into this module).
  // The caller's governance gate passed above, so this is the directory's
  // TRUSTED lookup. Fail CLOSED when the runtime or the directory is
  // unavailable (the `agent_core_unavailable` code is the admin route's
  // contract).
  let agentCreator: string | null = null;
  try {
    const { getRuntime } = await import('../host/bootstrap');
    const runtime = await getRuntime();
    await runtime.whenReady();
    const directory = runtime.services.get('agent-directory');
    if (!directory) return { ok: false, error: { code: 'agent_core_unavailable' } };
    const agent = await directory.lookupAgent(projectId, input.agentId);
    agentCreator = agent ? agent.createdBy : null;
  } catch {
    return { ok: false, error: { code: 'agent_core_unavailable' } };
  }

  const targetIsMember = Boolean(project.members[input.userId]);
  if (agentCreator == null || !targetIsMember) {
    return { ok: false, error: { code: 'denied' } };
  }

  // The ownership map is computed INSIDE the store's write chain, from the
  // record as it is on disk at that moment — an ownership map carried in from
  // the snapshot above would erase a concurrent assignment. The floor is
  // re-derived there too: the caller's governance flag and the target's
  // membership are asked again on the FRESH record, and a mid-flight change
  // denies rather than writes (GR1 — a fence at the boundary, not a widening).
  const outcome: { changed: boolean; assignedTo: string[]; denied: boolean } = {
    changed: false,
    assignedTo: [],
    denied: false,
  };

  const written = await updateProject(project.id, (p) => {
    const freshMember = p.members[callerUserId];
    const freshRole = freshMember ? p.roles[freshMember.role] : undefined;
    if (!freshMember || !freshRole || !canManageProjectRoles({ member: freshMember, role: freshRole })) {
      outcome.denied = true;
      return null;
    }
    if (!p.members[input.userId]) {
      outcome.denied = true;
      return null;
    }

    const ownership = { ...(p.agentOwnership ?? {}) };
    const existing = ownership[input.agentId];

    if (input.remove && !existing) {
      // No-write no-op: materializing the record would narrow third-party read.
      outcome.assignedTo = [];
      outcome.changed = false;
      return null;
    }

    const entry: AgentOwnershipEntry = existing
      ? { ...existing, assignedTo: [...existing.assignedTo] }
      : { createdBy: agentCreator, assignedTo: [] };

    let changed = false;
    if (input.remove) {
      const next = entry.assignedTo.filter((u) => u !== input.userId);
      changed = next.length !== entry.assignedTo.length;
      entry.assignedTo = next;
    } else if (!entry.assignedTo.includes(input.userId)) {
      entry.assignedTo.push(input.userId);
      changed = true;
    }
    changed = changed || !existing;

    outcome.assignedTo = entry.assignedTo;
    outcome.changed = changed;
    if (!changed) return null;

    ownership[input.agentId] = entry;
    return { agentOwnership: ownership };
  });

  if (outcome.denied) return { ok: false, error: { code: 'denied' } };
  if (written === null) return { ok: false, error: { code: 'project_not_found' } };

  if (outcome.changed) {
    const caller = await getUserById(callerUserId);
    void writeAuditLog({
      userId: callerUserId,
      ...(caller ? { userEmail: caller.email } : {}),
      action: input.remove ? 'agent.unassign' : 'agent.assign',
      target: input.agentId,
      details: { projectId: project.id, userId: input.userId },
    });
  }

  return { ok: true, agentId: input.agentId, assignedTo: outcome.assignedTo, changed: outcome.changed };
}

/**
 * Drop an agent's `agentOwnership` entry. Returns whether a key was actually
 * removed.
 *
 * THIS IS A CONSEQUENCE, NOT A PERMISSION. It runs only from the host's agent
 * lifecycle hooks, after `AgentService` has already passed `canAccessAgent`
 * and written to the store, so it carries no gate of its own — there is no
 * caller identity left to gate: `actorUserId` is provenance for the log line,
 * never authority.
 *
 * NEVER expose it on `hostPorts.governance` and NEVER give it a
 * route. That port carries CALLER ACTS, each of which re-derives its own floor
 * from the live record; a function with no floor sitting beside them would be
 * an unguarded ownership write reachable by anything that can reach the port.
 *
 * Two reasons it fires, and both must clear the key:
 *  - `agent_deleted` — the agent is gone, so its entry is a fossil that keeps
 *    denying `agents:'own'` readers (record-present-no-match denies) forever.
 *  - `agent_created` — an id can be REUSED (a template-provisioned agent
 *    re-created under the same slug). A stale entry would silently hand the new
 *    agent to whoever was assigned the old one, and — worse — lock its real
 *    creator out of it.
 *
 * The create-time clear changes an authority answer SILENTLY (record-present
 * DENY becomes creator ALLOW), so a removal always emits one structured line.
 * It is not an audit row: nobody performed this act.
 *
 * The map is computed inside an `updateProject` PRODUCER so a concurrent
 * assignment is never erased, and an ABSENT key returns `null` — no write, no
 * `updatedAt` bump, and no materialized empty record (which would narrow
 * third-party read).
 */
export async function pruneAgentOwnership(input: {
  projectId: string;
  agentId: string;
  actorUserId?: string;
  reason: 'agent_deleted' | 'agent_created';
}): Promise<boolean> {
  let removed = false;

  const written = await updateProject(input.projectId, (p) => {
    if (!p.agentOwnership || !(input.agentId in p.agentOwnership)) return null;
    const ownership = { ...p.agentOwnership };
    delete ownership[input.agentId];
    removed = true;
    return { agentOwnership: ownership };
  });

  if (written === null) return false;
  if (removed) {
    console.info(
      '[agent-ownership] pruned',
      JSON.stringify({
        projectId: input.projectId,
        agentId: input.agentId,
        reason: input.reason,
        ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}),
      }),
    );
  }
  return removed;
}
