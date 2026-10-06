/**
 * HostIdentity — sentinel-only.
 *
 * The host identity used by SystemSession is NEVER a real record. All three
 * fields are the sentinel `__system__` constant. No AgentStore.create. No
 * UserStore read. No disk state. Any attempt to persist these values is
 * rejected by path resolvers and store guards (see
 * `packages/package-system/src/paths/neuralisHome.ts` and
 * `packages/agent-core/store/AgentStore.ts`).
 *
 * Consumers who need a project-scoped SystemSession (e.g. sync scheduler
 * iterating real projects) MUST pass a real `{ userId, projectId }` scope to
 * `createSystemSession(reason, callerId, scope)` — the sentinel HostIdentity
 * is only for truly system-level operations (e.g. pre-setup MCP API-key read).
 */

import {
  SYSTEM_USER_ID,
  SYSTEM_PROJECT_ID,
  SYSTEM_AGENT_ID,
  type HostIdentitySnapshot,
} from '@neuralis/package-system/contracts';
import { getLogger } from '../logging/setup';

const GLOBAL_KEY = '__neuralis_host_identity__' as const;

type HostIdentityState = { snapshot: HostIdentitySnapshot };

function getState(): HostIdentityState {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      snapshot: {
        systemUserId: SYSTEM_USER_ID,
        systemProjectId: SYSTEM_PROJECT_ID,
        systemAgentId: SYSTEM_AGENT_ID,
      },
    } satisfies HostIdentityState;
  }
  return g[GLOBAL_KEY] as HostIdentityState;
}

/**
 * Return the sentinel host identity.
 *
 * Synchronous and side-effect-free. No AgentStore writes. No setup dependency.
 * Safe to call at any point in the process lifetime, including before setup
 * has been run.
 */
export function initHostIdentity(): HostIdentitySnapshot {
  const state = getState();
  getLogger().child('host-identity').info('Host identity resolved (sentinel)', {
    systemUserId: state.snapshot.systemUserId,
    systemProjectId: state.snapshot.systemProjectId,
    systemAgentId: state.snapshot.systemAgentId,
  });
  return state.snapshot;
}

/** Return the sentinel snapshot. Equivalent to `initHostIdentity` without logging. */
export function getHostIdentity(): HostIdentitySnapshot {
  return getState().snapshot;
}

/** For tests — reset the cached state (effectively a no-op with sentinels). */
export function resetHostIdentity(): void {
  const g = globalThis as Record<string, unknown>;
  delete g[GLOBAL_KEY];
}
