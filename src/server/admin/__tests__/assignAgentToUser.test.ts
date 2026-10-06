/**
 * Agent↔user assignment (A7). Pins the architect's blocker + additions:
 * a first-time entry takes the agent's RESOLVED real creator (never '' /
 * never the caller); unknown agent ≡ non-member target (one denied answer,
 * no existence oracle); idempotent re-assign; remove on an absent entry is a
 * no-WRITE no-op (materializing would narrow third-party read); the last
 * assignee may be removed but the entry stays; self-assign is legal for a
 * flag-holder.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProjectRecord } from '../../store/projectTypes';

const getProjectById = vi.fn();
const updateProject = vi.fn();
vi.mock('../../store/ProjectStore', () => ({
  getProjectById: (...a: unknown[]) => getProjectById(...a),
  updateProject: (...a: unknown[]) => updateProject(...a),
}));

const getUserById = vi.fn();
vi.mock('../../store/UserStore', () => ({
  getUserById: (...a: unknown[]) => getUserById(...a),
}));

const writeAuditLog = vi.fn();
vi.mock('../../store/AuditStore', () => ({
  writeAuditLog: (...a: unknown[]) => writeAuditLog(...a),
}));

const agentGet = vi.fn();
// The `agent-directory` provider's trusted lookup, over the fixture's
// `(agentId, projectId) → { id, userId }` rows.
vi.mock('../../host/bootstrap', () => ({
  getRuntime: async () => ({
    whenReady: async () => {},
    services: {
      get: () => ({
        lookupAgent: async (projectId: string, agentId: string) => {
          const agent = (await agentGet(agentId, projectId)) as { id: string; userId: string } | null;
          return agent ? { id: agent.id, createdBy: agent.userId } : null;
        },
      }),
    },
  }),
}));

import { assignAgentToUser } from '../assignAgentToUser';

function project(overrides?: Partial<ProjectRecord>): ProjectRecord {
  return {
    id: 'p1',
    name: 'P1',
    ownerId: 'u-owner',
    members: {
      'u-gov': { userId: 'u-gov', name: 'G', email: 'g@x.co', role: 'admin', position: '', tier: 2, addedAt: 't' },
      'u-plain': { userId: 'u-plain', name: 'M', email: 'm@x.co', role: 'member', position: '', tier: 20, addedAt: 't' },
      'u-target': { userId: 'u-target', name: 'T', email: 't@x.co', role: 'member', position: '', tier: 20, addedAt: 't' },
    },
    roles: {
      admin: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: [], priority: 2 },
      member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 20 },
    },
    agentOwnership: {},
    limits: { daily: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} } },
    ...overrides,
  } as ProjectRecord;
}

/**
 * The RECORDED WRITES — what actually reached disk.
 *
 * `updateProject` takes a PRODUCER now, so `mock.calls[0][1]` is a function, and
 * a call is no longer evidence of a write: a producer that answers `null` writes
 * nothing. The mock therefore implements the CONTRACT (run the producer against
 * the same record the service read; `null` ⇒ no write, current record back) and
 * every assertion moved onto `writes`.
 */
const writes: Array<{ id: string; patch: Record<string, unknown> }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  writes.length = 0;
  getProjectById.mockResolvedValue(project());
  updateProject.mockImplementation(async (id: unknown, patch: unknown) => {
    const current = await getProjectById(id);
    const produced =
      typeof patch === 'function'
        ? (patch as (p: ProjectRecord) => Record<string, unknown> | null)(current as ProjectRecord)
        : (patch as Record<string, unknown>);
    if (produced === null) return current;
    writes.push({ id: id as string, patch: produced });
    return { ...(current as object), ...produced };
  });
  getUserById.mockResolvedValue({ id: 'u-gov', email: 'g@x.co', name: 'G' });
  agentGet.mockResolvedValue({ id: 'scout', userId: 'u-creator' });
});

describe('assignAgentToUser', () => {
  it('denies a caller without the canManageRoles flag', async () => {
    const res = await assignAgentToUser('u-plain', 'p1', { agentId: 'scout', userId: 'u-target' });
    expect(res).toEqual({ ok: false, error: { code: 'not_governance_capable' } });
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('unknown agent and non-member target return the SAME denied answer', async () => {
    agentGet.mockResolvedValue(null);
    const unknownAgent = await assignAgentToUser('u-gov', 'p1', { agentId: 'ghost', userId: 'u-target' });
    agentGet.mockResolvedValue({ id: 'scout', userId: 'u-creator' });
    const nonMember = await assignAgentToUser('u-gov', 'p1', { agentId: 'scout', userId: 'u-stranger' });
    expect(unknownAgent).toEqual({ ok: false, error: { code: 'denied' } });
    expect(nonMember).toEqual(unknownAgent);
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('first-time entry takes the agent record\'s REAL creator — never "" and never the caller', async () => {
    const res = await assignAgentToUser('u-gov', 'p1', { agentId: 'scout', userId: 'u-target' });
    expect(res).toEqual({ ok: true, agentId: 'scout', assignedTo: ['u-target'], changed: true });
    expect(writes).toHaveLength(1);
    const written = writes[0].patch as {
      agentOwnership: Record<string, { createdBy: string; assignedTo: string[] }>;
    };
    expect(written.agentOwnership.scout.createdBy).toBe('u-creator');
    expect(written.agentOwnership.scout.createdBy).not.toBe('');
    expect(written.agentOwnership.scout.createdBy).not.toBe('u-gov');
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'agent.assign', target: 'scout' }),
    );
  });

  it('idempotent re-assign: no duplicate, no write, changed:false', async () => {
    getProjectById.mockResolvedValue(
      project({ agentOwnership: { scout: { createdBy: 'u-creator', assignedTo: ['u-target'] } } }),
    );
    const res = await assignAgentToUser('u-gov', 'p1', { agentId: 'scout', userId: 'u-target' });
    expect(res).toEqual({ ok: true, agentId: 'scout', assignedTo: ['u-target'], changed: false });
    // The producer RUNS (that is where the decision now lives) and answers
    // `null`, so nothing is written — the assertion is on the write, not the call.
    expect(writes).toEqual([]);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it('remove on an ABSENT entry is a no-write no-op (must not materialize the record)', async () => {
    const res = await assignAgentToUser('u-gov', 'p1', { agentId: 'scout', userId: 'u-target', remove: true });
    expect(res).toEqual({ ok: true, agentId: 'scout', assignedTo: [], changed: false });
    expect(writes).toEqual([]);
  });

  it('removing the last assignee keeps the entry with an empty list (UI parity)', async () => {
    getProjectById.mockResolvedValue(
      project({ agentOwnership: { scout: { createdBy: 'u-creator', assignedTo: ['u-target'] } } }),
    );
    const res = await assignAgentToUser('u-gov', 'p1', { agentId: 'scout', userId: 'u-target', remove: true });
    expect(res).toEqual({ ok: true, agentId: 'scout', assignedTo: [], changed: true });
    expect(writes).toHaveLength(1);
    const written = writes[0].patch as {
      agentOwnership: Record<string, { createdBy: string; assignedTo: string[] }>;
    };
    expect(written.agentOwnership.scout).toEqual({ createdBy: 'u-creator', assignedTo: [] });
  });

  it('self-assign is legal for a flag-holder (pin so nobody "fixes" it later)', async () => {
    const res = await assignAgentToUser('u-gov', 'p1', { agentId: 'scout', userId: 'u-gov' });
    expect(res.ok).toBe(true);
  });

  it('a caller who LOSES the flag mid-write is denied by the producer, not written', async () => {
    // The snapshot pre-check passes, then the record the chain hands the
    // producer no longer carries the flag: a fence at the boundary (GR1), not a
    // stale-snapshot write.
    getProjectById
      .mockResolvedValueOnce(project())
      .mockResolvedValueOnce(
        project({
          roles: {
            admin: { agents: '*', canInvite: true, canManageRoles: false, grantedFeatures: [], priority: 2 },
            member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 20 },
          },
        } as Partial<ProjectRecord>),
      );
    const res = await assignAgentToUser('u-gov', 'p1', { agentId: 'scout', userId: 'u-target' });
    expect(res).toEqual({ ok: false, error: { code: 'denied' } });
    expect(writes).toEqual([]);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it('a target who LOSES membership mid-write is denied by the producer', async () => {
    getProjectById
      .mockResolvedValueOnce(project())
      .mockResolvedValueOnce(
        project({
          members: {
            'u-gov': { userId: 'u-gov', name: 'G', email: 'g@x.co', role: 'admin', position: '', tier: 2, addedAt: 't' },
          },
        } as Partial<ProjectRecord>),
      );
    const res = await assignAgentToUser('u-gov', 'p1', { agentId: 'scout', userId: 'u-target' });
    expect(res).toEqual({ ok: false, error: { code: 'denied' } });
    expect(writes).toEqual([]);
  });

  it('the ownership map is built from the FRESH record — a concurrent entry survives', async () => {
    // The lost-update pin: the snapshot the service read has no `other` entry,
    // the record the chain hands the producer does. Under the object-patch form
    // the write would carry the snapshot's map and erase it.
    getProjectById
      .mockResolvedValueOnce(project())
      .mockResolvedValueOnce(
        project({ agentOwnership: { other: { createdBy: 'u-creator', assignedTo: ['u-target'] } } }),
      );
    const res = await assignAgentToUser('u-gov', 'p1', { agentId: 'scout', userId: 'u-target' });
    expect(res.ok).toBe(true);
    const written = writes[0].patch as {
      agentOwnership: Record<string, { createdBy: string; assignedTo: string[] }>;
    };
    expect(Object.keys(written.agentOwnership).sort()).toEqual(['other', 'scout']);
  });

  it('fails CLOSED when agent-core cannot resolve', async () => {
    agentGet.mockRejectedValue(new Error('loader down'));
    const res = await assignAgentToUser('u-gov', 'p1', { agentId: 'scout', userId: 'u-target' });
    expect(res).toEqual({ ok: false, error: { code: 'agent_core_unavailable' } });
    expect(updateProject).not.toHaveBeenCalled();
  });
});
