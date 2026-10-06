/**
 * resolveVerifiedAgentScope — the canonical VERIFIED agent scope for host
 * routes (CARD1 3A, K7).
 *
 * A raw `x-agent-id` header is NOT an agent identity. This resolver is the
 * ONE place a named agent becomes one: `resolveSessionContext`, the four
 * package snapshot routes and the asset-scope routes (mint / GET / heartbeat
 * handle binding, source-owner scope checks) all take ONLY its result. The
 * catch-all's cookie plane takes the verdict (`resolveAgentAxis`) instead,
 * because there a denied id must answer 404 rather than collapse to no agent.
 *
 * This is a thin ADAPTER over the policy of the package that provides the
 * `agent-directory` contract (looked up by contract id, never by package name):
 * `AgentDirectory.resolveRequestedAgent` owns the strict deny-by-default
 * `?agentId` predicate (omnivorous-magpie F5) and answers ORACLE-FREE — a
 * missing and a foreign agent produce the same result. It does NOT re-state
 * the policy.
 *
 * Semantics (deny-by-default, NON-ENUMERATING):
 *   - absent / blank                          → `undefined`
 *   - existing + usable by the fresh session  → the canonical agent id
 *   - unknown / forged / foreign / deleted    → `undefined` — externally
 *     IDENTICAL to "absent", so a caller probing agent ids gets the same
 *     surface-not-visible response, never an existence-confirming 403.
 *   - no directory / runtime not ready        → denied (never a widening)
 */

import type { AgentDirectory, SessionContext } from '@neuralis/package-system/contracts';
import { getRuntime } from '../host/bootstrap';

/** The directory slice the adapter asks (test seam — prod passes the runtime's). */
export type VerifiedAgentDirectory = Pick<AgentDirectory, 'resolveRequestedAgent'>;

/**
 * The agent axis WITH its verdict: `denied` is true when an id was named and
 * failed (unknown, forged, foreign, or no directory to ask). A caller that must
 * refuse a denied id passes this object through — destructuring it and
 * re-stating `denied: false` turns a deny into an allow.
 */
export type AgentAxis = { agentId: string | undefined; denied: boolean };

/**
 * Pure half: resolve against an injected directory. Exported for unit tests;
 * the default entries below bind the live runtime's directory.
 */
export async function resolveAgentAxisWith(
  directory: VerifiedAgentDirectory | undefined,
  session: SessionContext,
  requestedAgentId: string | undefined,
): Promise<AgentAxis> {
  const candidate = requestedAgentId?.trim();
  if (!candidate) return { agentId: undefined, denied: false };
  if (!directory) return { agentId: undefined, denied: true };
  const resolution = await directory.resolveRequestedAgent(session, candidate);
  // A named id either resolves to an agent or is denied — never "no agent, allowed".
  if (resolution.denied || !resolution.agentId) return { agentId: undefined, denied: true };
  return { agentId: resolution.agentId, denied: false };
}

/**
 * Resolve the requested agent id against the LIVE agent directory with the
 * caller's fresh canonical `SessionContext`. The directory reads its store only
 * when an id was named. An unavailable directory is a DENY — it must never
 * widen scope.
 */
export async function resolveAgentAxis(
  session: SessionContext,
  requestedAgentId: string | undefined,
): Promise<AgentAxis> {
  if (!requestedAgentId?.trim()) return { agentId: undefined, denied: false };
  try {
    const runtime = await getRuntime();
    await runtime.whenReady();
    return await resolveAgentAxisWith(runtime.services.get('agent-directory'), session, requestedAgentId);
  } catch {
    return { agentId: undefined, denied: true };
  }
}

/** The advertise-filter view: a denied id collapses to "no agent" (non-enumerating). */
export async function resolveVerifiedAgentScope(
  session: SessionContext,
  requestedAgentId: string | undefined,
): Promise<string | undefined> {
  return (await resolveAgentAxis(session, requestedAgentId)).agentId;
}
