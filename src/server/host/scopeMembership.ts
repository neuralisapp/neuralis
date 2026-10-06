/**
 * The host's ONE {@link ScopeMembershipPort} — the storage facts the kernel's
 * credential-scope ownership predicate (`assertScopeMatchesSession`,
 * `@neuralis/package-system/access`) cannot know and must never read itself.
 *
 * The predicate is pure and lives in the kernel because two planes now ask the
 * same question: the admin package's credential/log routes and, since the Codex
 * credential grew its four scopes, the host's `codexCredentialWriter` port gate.
 * This adapter adds NO decision — it maps the host's existing stores onto the
 * port and answers the fail-closed value on any failure, so a storage error can
 * never turn a denial into a 500 or, worse, into an allow.
 *
 * Both facts come from an EXISTING owner:
 *  - membership from `ProjectStore.listProjectsForUser` (archived projects are
 *    excluded there by default — an archived tenant is not a confinement set);
 *  - agent existence from the `agent-directory` provider's trusted lookup
 *    (`AgentDirectory.lookupAgent`, looked up by contract id — the same one the
 *    ownership writer in `server/admin/assignAgentToUser.ts` asks). Deliberately
 *    NOT a second reader of the agent-file layout: the package that owns that
 *    layout answers, or the probe fails closed.
 *
 * `ProjectRecord.agentOwnership` is NOT consulted here: an unowned agent is
 * legal, so an absent ownership entry is not proof the agent does not exist —
 * which is exactly the direction a confinement check must not get wrong.
 */

import type { ScopeMembershipPort } from '@neuralis/package-system/access';
import { listProjectsForUser } from '../store/ProjectStore';

let cached: ScopeMembershipPort | undefined;

/** The process-wide port. Stateless — the stores behind it are the state. */
export function getScopeMembershipPort(): ScopeMembershipPort {
  cached ??= {
    async listCallerProjects(userId: string) {
      if (!userId) return [];
      try {
        const projects = await listProjectsForUser(userId);
        // Only TRUTHY entries count as membership — a malformed record with a
        // null member must not become a shared project for the `user` arm.
        return projects.map((p) => ({
          id: p.id,
          memberIds: Object.entries(p.members ?? {}).filter(([, m]) => !!m).map(([id]) => id),
        }));
      } catch {
        return [];
      }
    },
    async agentBelongsToProject(projectId: string, agentId: string) {
      if (!projectId || !agentId) return false;
      try {
        const { getRuntime } = await import('./bootstrap');
        const runtime = await getRuntime();
        await runtime.whenReady();
        const directory = runtime.services.get('agent-directory');
        if (!directory) return false;
        // No access context: this asks EXISTENCE inside a named project, and the
        // caller's right to reach it is the kernel predicate's own question.
        return Boolean(await directory.lookupAgent(projectId, agentId));
      } catch {
        return false;
      }
    },
  };
  return cached;
}
