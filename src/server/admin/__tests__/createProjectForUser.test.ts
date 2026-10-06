/**
 * The ONE project-create gate body. Pins: owner-strength floor (priority ≤ 1,
 * admin@2 excluded), gate ORDER (authorization before capacity — an
 * unauthorized caller never learns the instance count), the cap, and the
 * seed-throw mapping.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProjectRecord } from '../../store/projectTypes';

const listAllProjects = vi.fn();
const createProject = vi.fn();
vi.mock('../../store/ProjectStore', () => ({
  listAllProjects: (...a: unknown[]) => listAllProjects(...a),
  createProject: (...a: unknown[]) => createProject(...a),
}));

const getUserById = vi.fn();
vi.mock('../../store/UserStore', () => ({
  getUserById: (...a: unknown[]) => getUserById(...a),
}));

const configGet = vi.fn();
vi.mock('../../store/PlatformConfigStore', () => ({
  getPlatformConfigStore: () => ({ get: (...a: unknown[]) => configGet(...a) }),
}));

const writeAuditLog = vi.fn();
vi.mock('../../store/AuditStore', () => ({
  writeAuditLog: (...a: unknown[]) => writeAuditLog(...a),
}));

const requireReadyRuntime = vi.fn();
vi.mock('../../projects/projectInit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../projects/projectInit')>()),
  requireReadyRuntime: (...a: unknown[]) => requireReadyRuntime(...a),
}));

import { createProjectForUser } from '../createProjectForUser';
import { RuntimeNotReadyError } from '../../projects/projectInit';

function projectWith(userId: string, role: string, priority: number): ProjectRecord {
  return {
    id: `p-${role}`,
    name: 'P',
    ownerId: 'other',
    members: {
      [userId]: { userId, name: 'U', email: 'u@x.co', role, position: '', tier: priority, addedAt: 't' },
    },
    roles: {
      [role]: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: [], priority },
    },
    agentOwnership: {},
    limits: { spend: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} } },
    createdAt: 't',
    updatedAt: 't',
  } as ProjectRecord;
}

beforeEach(() => {
  vi.clearAllMocks();
  getUserById.mockResolvedValue({ id: 'u1', name: 'U', email: 'u@x.co' });
  configGet.mockReturnValue(0); // no cap
  createProject.mockResolvedValue({ id: 'p-new', name: 'New' });
  requireReadyRuntime.mockResolvedValue({});
});

describe('createProjectForUser', () => {
  it('allows an owner-strength caller (priority 1, any project)', async () => {
    listAllProjects.mockResolvedValue([projectWith('u1', 'owner', 1)]);
    const res = await createProjectForUser('u1', { name: 'New' });
    expect(res.ok).toBe(true);
    expect(createProject).toHaveBeenCalledWith('New', 'u1', undefined, { name: 'U', email: 'u@x.co' });
    expect(writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'project.create' }));
  });

  it('a CUSTOM role at priority 1 behaves exactly like the built-in owner (D-A acceptance)', async () => {
    listAllProjects.mockResolvedValue([projectWith('u1', 'chief', 1)]);
    const res = await createProjectForUser('u1', { name: 'New' });
    expect(res.ok).toBe(true);
  });

  it('denies admin strength (priority 2) — and BEFORE the cap, hiding the instance count', async () => {
    configGet.mockReturnValue(1); // cap already exceeded by the fixture below
    listAllProjects.mockResolvedValue([projectWith('u1', 'admin', 2)]);
    const res = await createProjectForUser('u1', { name: 'New' });
    expect(res).toEqual({ ok: false, error: { code: 'not_owner_strength' } });
  });

  it('enforces the instance cap for an authorized caller', async () => {
    configGet.mockReturnValue(1);
    listAllProjects.mockResolvedValue([projectWith('u1', 'owner', 1)]);
    const res = await createProjectForUser('u1', { name: 'New' });
    expect(res).toEqual({ ok: false, error: { code: 'project_limit', max: 1 } });
    expect(createProject).not.toHaveBeenCalled();
  });

  it('two concurrent creates at cap-1 cannot both pass the cap', async () => {
    configGet.mockReturnValue(2);
    // A store that GROWS when a create lands — the list the second create counts
    // must include the first create's project.
    const live: ProjectRecord[] = [projectWith('u1', 'owner', 1)];
    listAllProjects.mockImplementation(async () => [...live]);
    createProject.mockImplementation(async (name: string) => {
      await new Promise((r) => setTimeout(r, 5));
      const p = { ...projectWith('u1', 'owner', 1), id: `p-${live.length}`, name };
      live.push(p);
      return p;
    });
    const results = await Promise.all([
      createProjectForUser('u1', { name: 'A' }),
      createProjectForUser('u1', { name: 'B' }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: { code: 'project_limit', max: 2 } }]);
    expect(live).toHaveLength(2);
  });

  it('runtime not ready ⇒ runtime_not_ready BEFORE anything is written (no record, no audit)', async () => {
    listAllProjects.mockResolvedValue([projectWith('u1', 'owner', 1)]);
    requireReadyRuntime.mockRejectedValue(new RuntimeNotReadyError());
    const res = await createProjectForUser('u1', { name: 'New' });
    expect(res).toEqual({ ok: false, error: { code: 'runtime_not_ready' } });
    expect(createProject).not.toHaveBeenCalled();
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it('readiness never answers before the gates — an unauthorized caller still gets not_owner_strength', async () => {
    listAllProjects.mockResolvedValue([projectWith('u1', 'admin', 2)]);
    requireReadyRuntime.mockRejectedValue(new RuntimeNotReadyError());
    const res = await createProjectForUser('u1', { name: 'New' });
    expect(res).toEqual({ ok: false, error: { code: 'not_owner_strength' } });
    expect(requireReadyRuntime).not.toHaveBeenCalled();
  });

  it('a not-ready runtime surfacing INSIDE the create maps to runtime_not_ready, never seed_failed', async () => {
    listAllProjects.mockResolvedValue([projectWith('u1', 'owner', 1)]);
    createProject.mockRejectedValue(new RuntimeNotReadyError());
    const res = await createProjectForUser('u1', { name: 'New' });
    expect(res).toEqual({ ok: false, error: { code: 'runtime_not_ready' } });
  });

  it('maps a seed throw to the typed seed_failed code (persists nothing)', async () => {
    listAllProjects.mockResolvedValue([projectWith('u1', 'owner', 1)]);
    createProject.mockRejectedValue(new Error('ROLE_SEED_UNION_DEGENERATE'));
    const res = await createProjectForUser('u1', { name: 'New' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('seed_failed');
  });

  it('rejects a blank name before touching any store', async () => {
    const res = await createProjectForUser('u1', { name: '   ' });
    expect(res).toEqual({ ok: false, error: { code: 'invalid_name', message: 'Project name must not be empty' } });
    expect(listAllProjects).not.toHaveBeenCalled();
  });

  it('applies the SAME 120-character cap a rename does — 121 is refused, 120 passes', async () => {
    listAllProjects.mockResolvedValue([projectWith('u1', 'owner', 1)]);
    const refused = await createProjectForUser('u1', { name: 'x'.repeat(121) });
    expect(refused).toEqual({
      ok: false,
      error: { code: 'invalid_name', message: 'Project name must be at most 120 characters' },
    });
    expect(createProject).not.toHaveBeenCalled();

    const accepted = await createProjectForUser('u1', { name: 'x'.repeat(120) });
    expect(accepted.ok).toBe(true);
  });

  it('stores the trimmed name', async () => {
    listAllProjects.mockResolvedValue([projectWith('u1', 'owner', 1)]);
    await createProjectForUser('u1', { name: '  Ügyfél teszt  ' });
    expect(createProject).toHaveBeenCalledWith('Ügyfél teszt', 'u1', undefined, { name: 'U', email: 'u@x.co' });
  });
});
