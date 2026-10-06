/**
 * Test doubles for the kernel `RuntimeInstance` the host routes reach through
 * `getRuntime()` — a ready runtime whose service lookup answers from the
 * members a test hands in. Only the members a route calls are stubbed; a test
 * that reaches another one fails loudly on `undefined`.
 */

import type { AgentDirectory, PackageServices, ServiceContractId, SessionContext } from '@neuralis/package-system/contracts';

type AgentRow = { id: string; userId?: string };

/**
 * An `agent-directory` over a `(agentId, projectId) → row` store with the
 * OWN-agent rule only: an agent resolves for the user who created it, and a
 * foreign and a missing id get the same denial (oracle-free). The full policy
 * is the provider's and is pinned in its own package.
 */
export function ownAgentDirectory(get: (agentId: string, projectId: string) => Promise<AgentRow | null | undefined>): AgentDirectory {
  return {
    async resolveRequestedAgent(session: SessionContext, requestedAgentId: string) {
      const agent = await get(requestedAgentId, session.projectId);
      return agent && agent.userId === session.userId
        ? { agentId: agent.id, denied: false }
        : { agentId: undefined, denied: true };
    },
    async lookupAgent(projectId: string, agentId: string) {
      const agent = await get(agentId, projectId);
      return agent ? { id: agent.id, createdBy: agent.userId ?? '' } : null;
    },
    async listAgents() {
      throw new Error('ownAgentDirectory: listAgents is not stubbed');
    },
  };
}

/**
 * A ready runtime stub: `whenReady` resolves, `services.get` answers from
 * `services`, `services.providerOf` from `providers` (contract id → package id).
 */
export function stubRuntime<T extends object>(
  members: T,
  services: PackageServices = {},
  providers: Partial<Record<ServiceContractId, string>> = {},
) {
  return {
    whenReady: async () => undefined,
    services: {
      get: <K extends keyof PackageServices>(key: K) => services[key],
      oauthCallbackFor: () => services['oauth-callback'],
      providerOf: (contract: ServiceContractId) => providers[contract],
    },
    ...members,
  };
}
