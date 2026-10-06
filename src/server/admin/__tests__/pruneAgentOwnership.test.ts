/**
 * `pruneAgentOwnership` against a REAL `FileStore` in a temp appRoot.
 *
 * It cannot live in `assignAgentToUser.test.ts`: that suite `vi.mock`s the
 * whole `ProjectStore` away, so a producer there is a callback the test itself
 * invokes — it can never observe the store's per-record write chain, which is
 * the property this function exists to inherit. The harness is
 * `store/__tests__/ProjectStore.update.test.ts`'s (mkdtemp appRoot +
 * `vi.mock('../../config/env')`).
 *
 * Three rows: the key goes and the call reports `true`; an ABSENT key writes
 * NOTHING and reports `false` (materializing an empty record here would narrow
 * third-party read, and touching `updatedAt` would lie about a write); and a
 * prune racing an ASSIGNMENT for a different agent leaves both effects
 * standing — the producer form is what makes that true, and the object form is
 * the paired control that deterministically loses one of them.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ProjectRecord } from '../../store/projectTypes';

const appRoot = await mkdtemp(join(tmpdir(), 'nrs-prune-ownership-'));

vi.mock('../../config/env', () => ({
  getEnv: () => ({ appRoot, projectsRoot: join(appRoot, 'projects-data') }),
}));

const writeAuditLog = vi.fn();
vi.mock('../../store/AuditStore', () => ({
  writeAuditLog: (...a: unknown[]) => writeAuditLog(...a),
}));

// `assignAgentToUser` resolves the agent's real creator through the runtime's
// agent directory (a dynamic import of the bootstrap).
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
// `builtinSlots` also feeds the project record's default-role derivation, so
// it is a PARTIAL mock: only the bootstrap handle above is faked out.
vi.mock('../../host/builtinSlots', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
}));

const { pruneAgentOwnership } = await import('../assignAgentToUser');
const { assignAgentToUser } = await import('../assignAgentToUser');
const { updateProject } = await import('../../store/ProjectStore');

beforeAll(async () => {
  await mkdir(join(appRoot, 'projects'), { recursive: true });
  await mkdir(join(appRoot, 'users'), { recursive: true });
});

afterAll(async () => {
  await rm(appRoot, { recursive: true, force: true });
});

beforeEach(() => {
  agentGet.mockReset();
  writeAuditLog.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function seedRecord(id: string, over: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id,
    name: id,
    ownerId: 'u-owner',
    members: {
      'u-owner': {
        userId: 'u-owner', name: 'O', email: 'o@x.co', role: 'owner',
        position: 'Owner', tier: 1, addedAt: '2026-01-01T00:00:00.000Z',
      },
      'u-two': {
        userId: 'u-two', name: 'T', email: 't@x.co', role: 'member',
        position: 'Member', tier: 2, addedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    roles: {
      owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
      member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 20 },
    },
    agentOwnership: {},
    limits: { spend: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} } },
    roleGrantVersion: 18,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as ProjectRecord;
}

async function seed(id: string, over: Partial<ProjectRecord> = {}): Promise<void> {
  await writeFile(
    join(appRoot, 'projects', `${id}.json`),
    JSON.stringify(seedRecord(id, over), null, 2),
    'utf-8',
  );
}

/** Read the record as RAW BYTES — never through the store's own cache. */
async function readOnDisk(id: string): Promise<ProjectRecord> {
  return JSON.parse(await readFile(join(appRoot, 'projects', `${id}.json`), 'utf-8')) as ProjectRecord;
}

describe('pruneAgentOwnership', () => {
  it('removes the key and reports true, leaving every other entry standing', async () => {
    await seed('prune-hit', {
      agentOwnership: {
        'agent-gone': { createdBy: 'u-owner', assignedTo: ['u-two'] },
        'agent-stays': { createdBy: 'u-owner', assignedTo: [] },
      },
    });

    await expect(
      pruneAgentOwnership({
        projectId: 'prune-hit',
        agentId: 'agent-gone',
        actorUserId: 'u-owner',
        reason: 'agent_deleted',
      }),
    ).resolves.toBe(true);

    const after = await readOnDisk('prune-hit');
    expect(Object.keys(after.agentOwnership ?? {})).toEqual(['agent-stays']);
  });

  it('an ABSENT key writes NOTHING and reports false — updatedAt is untouched', async () => {
    await seed('prune-miss', {
      agentOwnership: { 'agent-stays': { createdBy: 'u-owner', assignedTo: [] } },
    });
    const before = await readOnDisk('prune-miss');

    await expect(
      pruneAgentOwnership({ projectId: 'prune-miss', agentId: 'never-owned', reason: 'agent_created' }),
    ).resolves.toBe(false);

    expect(await readOnDisk('prune-miss')).toEqual(before);
  });

  it('a missing project reports false rather than throwing', async () => {
    await expect(
      pruneAgentOwnership({ projectId: 'no-such-project', agentId: 'a1', reason: 'agent_deleted' }),
    ).resolves.toBe(false);
  });

  it('a prune racing an ASSIGNMENT for another agent: BOTH land', async () => {
    await seed('prune-race', {
      agentOwnership: {
        'agent-a': { createdBy: 'u-owner', assignedTo: ['u-two'] },
        'agent-b': { createdBy: 'u-owner', assignedTo: [] },
      },
    });
    agentGet.mockResolvedValue({ id: 'agent-b', userId: 'u-owner' });

    await Promise.all([
      pruneAgentOwnership({ projectId: 'prune-race', agentId: 'agent-a', reason: 'agent_deleted' }),
      assignAgentToUser('u-owner', 'prune-race', { agentId: 'agent-b', userId: 'u-two' }),
    ]);

    const after = await readOnDisk('prune-race');
    expect(after.agentOwnership?.['agent-a']).toBeUndefined();
    expect(after.agentOwnership?.['agent-b']?.assignedTo).toEqual(['u-two']);
  });

  it('(control) the same pair from ONE stale read via the OBJECT form loses the assignment', async () => {
    // Not a defect being pinned — the documented limit of the object patch, and
    // the measurement that makes the row above non-vacuous.
    await seed('prune-race-object', {
      agentOwnership: {
        'agent-a': { createdBy: 'u-owner', assignedTo: ['u-two'] },
        'agent-b': { createdBy: 'u-owner', assignedTo: [] },
      },
    });
    const stale = seedRecord('prune-race-object', {
      agentOwnership: {
        'agent-a': { createdBy: 'u-owner', assignedTo: ['u-two'] },
        'agent-b': { createdBy: 'u-owner', assignedTo: [] },
      },
    }).agentOwnership!;

    const pruned = { ...stale };
    delete pruned['agent-a'];
    const assigned = { ...stale, 'agent-b': { createdBy: 'u-owner', assignedTo: ['u-two'] } };

    await updateProject('prune-race-object', { agentOwnership: pruned });
    await updateProject('prune-race-object', { agentOwnership: assigned });

    const after = await readOnDisk('prune-race-object');
    expect(after.agentOwnership?.['agent-a']).toBeDefined();
  });
});
