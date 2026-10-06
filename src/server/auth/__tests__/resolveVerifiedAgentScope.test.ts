/**
 * resolveVerifiedAgentScope (CARD1 3A, K7) — the raw `x-agent-id` header is
 * never an agent identity. The POLICY (own / foreign / `view` / `'*'` /
 * ownership records / missing project) belongs to the `agent-directory`
 * provider and is pinned there; this file pins the host ADAPTER: blank is "no
 * agent", a named id is either the directory's answer or DENIED, and a missing
 * directory is a deny — never a widening.
 */

import { describe, it, expect, vi } from 'vitest';
import type { SessionContext } from '@neuralis/package-system/contracts';
import { resolveAgentAxisWith, type VerifiedAgentDirectory } from '../resolveVerifiedAgentScope';

function makeDirectory(answer: { agentId: string | undefined; denied: boolean }): VerifiedAgentDirectory {
  return { resolveRequestedAgent: vi.fn(async () => answer) };
}

const session = { userId: 'user-1', projectId: 'proj-1', role: 'member', grantedFeatures: [] } as unknown as SessionContext;

describe('resolveAgentAxisWith', () => {
  it('absent / blank → no agent, not denied, directory never asked', async () => {
    const directory = makeDirectory({ agentId: 'x', denied: false });
    for (const id of [undefined, '', '   ']) {
      expect(await resolveAgentAxisWith(directory, session, id)).toEqual({ agentId: undefined, denied: false });
    }
    expect(directory.resolveRequestedAgent).not.toHaveBeenCalled();
  });

  it('a resolved id passes through, trimmed before the directory sees it', async () => {
    const directory = makeDirectory({ agentId: 'agent-1', denied: false });
    expect(await resolveAgentAxisWith(directory, session, ' agent-1 ')).toEqual({ agentId: 'agent-1', denied: false });
    expect(directory.resolveRequestedAgent).toHaveBeenCalledWith(session, 'agent-1');
  });

  it('a denied id is denied with no agent', async () => {
    expect(await resolveAgentAxisWith(makeDirectory({ agentId: undefined, denied: true }), session, 'agent-2'))
      .toEqual({ agentId: undefined, denied: true });
  });

  it('a named id the directory answers with NO agent is a deny, never "allowed, no agent"', async () => {
    expect(await resolveAgentAxisWith(makeDirectory({ agentId: undefined, denied: false }), session, 'agent-3'))
      .toEqual({ agentId: undefined, denied: true });
  });

  it('no directory (nobody provides the contract) → denied', async () => {
    expect(await resolveAgentAxisWith(undefined, session, 'agent-1')).toEqual({ agentId: undefined, denied: true });
  });
});
