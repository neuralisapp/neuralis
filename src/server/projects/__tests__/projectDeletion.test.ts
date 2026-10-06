import { beforeEach, describe, expect, it, vi } from 'vitest';

const APP_ROOT = '/home/test/.neuralis/app';
const PROJECTS_ROOT = '/home/test/.neuralis/projects';

const order: string[] = [];

const mocks = vi.hoisted(() => ({
  getEnv: vi.fn(),
  getProjectById: vi.fn(),
  deleteProject: vi.fn(),
  setProjectArchived: vi.fn(),
  markProjectIdPurged: vi.fn(),
  deprovisionProjectForAll: vi.fn(),
  whenReady: vi.fn(),
  rm: vi.fn(),
  existsSync: vi.fn(),
  realpathSync: vi.fn(),
  deleteProjectAgentScopes: vi.fn(),
}));

vi.mock('../../store/credentialStoreInstance', () => ({
  getCredentialStore: () => ({ deleteProjectAgentScopes: mocks.deleteProjectAgentScopes }),
}));

vi.mock('../../config/env', () => ({ getEnv: mocks.getEnv }));

vi.mock('../../store/ProjectStore', () => ({
  getProjectById: mocks.getProjectById,
  deleteProject: mocks.deleteProject,
  setProjectArchived: mocks.setProjectArchived,
  markProjectIdPurged: mocks.markProjectIdPurged,
}));

// The host reaches packages ONLY through the loader's fan-out — never a
// package API of its own.
vi.mock('../../host/bootstrap', () => ({
  getRuntime: vi.fn(async () => ({
    whenReady: mocks.whenReady,
    getLoader: () => ({ deprovisionProjectForAll: mocks.deprovisionProjectForAll }),
  })),
}));

vi.mock('fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')['promises']>()),
  rm: mocks.rm,
}));
// Partial, not wholesale: `@neuralis/package-system/paths` reads `fs.constants`
// at module scope for the containment primitive's open flags, and a bare object
// mock makes that import throw before a single test runs.
vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  existsSync: mocks.existsSync,
  realpathSync: mocks.realpathSync,
}));

import { archiveProject, restoreProject, purgeProject, ProjectLifecycleError } from '../projectDeletion';

function projectRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-1',
    name: 'Project',
    ownerId: 'owner',
    members: {},
    roles: {},
    agentOwnership: { 'agent-a': { createdBy: 'owner', assignedTo: [] } },
    limits: { daily: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} } },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  mocks.getEnv.mockReturnValue({ appRoot: APP_ROOT, projectsRoot: PROJECTS_ROOT });
  // Paths don't exist on the mock fs → safeRemove uses resolve() (no realpath).
  mocks.existsSync.mockReturnValue(false);
  mocks.markProjectIdPurged.mockImplementation(async () => { order.push('tombstone'); });
  mocks.whenReady.mockImplementation(async () => { order.push('ready'); });
  mocks.deprovisionProjectForAll.mockImplementation(async () => { order.push('deprovision'); });
  mocks.rm.mockImplementation(async (p: string) => { order.push(`rm:${p}`); });
  mocks.deleteProject.mockImplementation(async () => { order.push('deleteProject'); return true; });
  mocks.deleteProjectAgentScopes.mockImplementation(() => { order.push('agentCreds'); return 0; });
});

describe('archiveProject', () => {
  it('sets archivedAt via the narrow setter', async () => {
    mocks.getProjectById.mockResolvedValue(projectRecord());
    await archiveProject('proj-1');
    expect(mocks.setProjectArchived).toHaveBeenCalledWith('proj-1', expect.any(String));
  });

  it('throws not_found for a missing project', async () => {
    mocks.getProjectById.mockResolvedValue(null);
    await expect(archiveProject('nope')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('restoreProject', () => {
  it('clears archivedAt for an archived project', async () => {
    mocks.getProjectById.mockResolvedValue(projectRecord({ archivedAt: '2026-06-30T00:00:00.000Z' }));
    await restoreProject('proj-1');
    expect(mocks.setProjectArchived).toHaveBeenCalledWith('proj-1', null);
  });

  it('refuses to restore a project that is not archived', async () => {
    mocks.getProjectById.mockResolvedValue(projectRecord());
    await expect(restoreProject('proj-1')).rejects.toBeInstanceOf(ProjectLifecycleError);
    await expect(restoreProject('proj-1')).rejects.toMatchObject({ code: 'not_archived' });
    expect(mocks.setProjectArchived).not.toHaveBeenCalled();
  });
});

describe('purgeProject', () => {
  it('refuses to purge a project that is not archived', async () => {
    mocks.getProjectById.mockResolvedValue(projectRecord());
    await expect(purgeProject('proj-1')).rejects.toMatchObject({ code: 'not_archived' });
    expect(mocks.rm).not.toHaveBeenCalled();
    expect(mocks.deleteProject).not.toHaveBeenCalled();
  });

  it('tombstones the id FIRST, deprovisions every package, THEN the fs tree, record, sources, project + agent creds', async () => {
    mocks.getProjectById.mockResolvedValue(projectRecord({ archivedAt: '2026-06-30T00:00:00.000Z' }));

    await purgeProject('proj-1');

    expect(order.slice(0, 2)).toEqual(['tombstone', 'deprovision']);
    expect(mocks.markProjectIdPurged).toHaveBeenCalledWith('proj-1');
    expect(mocks.deprovisionProjectForAll).toHaveBeenCalledWith('proj-1');

    // The removed path set (through the containment guard).
    expect(mocks.rm).toHaveBeenCalledWith(`${PROJECTS_ROOT}/proj-1`, expect.objectContaining({ recursive: true, force: true }));
    expect(mocks.rm).toHaveBeenCalledWith(`${APP_ROOT}/config/sources/proj-1`, expect.anything());
    expect(mocks.rm).toHaveBeenCalledWith(`${APP_ROOT}/credentials/projects/proj-1`, expect.anything());
    // The agent credentials go by PROJECT through the store — never an
    // ownership-key walk over the tenant-shared `agents/` root.
    expect(mocks.deleteProjectAgentScopes).toHaveBeenCalledWith('proj-1');
    expect(mocks.rm).not.toHaveBeenCalledWith(`${APP_ROOT}/credentials/agents/agent-a`, expect.anything());
    expect(mocks.deleteProject).toHaveBeenCalledWith('proj-1');

    // Ordering: deprovision → tree rm → deleteProject.
    expect(order.indexOf('deprovision')).toBeLessThan(order.indexOf(`rm:${PROJECTS_ROOT}/proj-1`));
    expect(order.indexOf(`rm:${PROJECTS_ROOT}/proj-1`)).toBeLessThan(order.indexOf('deleteProject'));
  });

  it('a rejected package boot fence propagates before any removal', async () => {
    mocks.getProjectById.mockResolvedValue(projectRecord({ archivedAt: '2026-06-30T00:00:00.000Z' }));
    const failure = Object.assign(new Error('Project deprovision failed'), { name: 'ProjectDeprovisionError' });
    mocks.deprovisionProjectForAll.mockRejectedValueOnce(failure);
    await expect(purgeProject('proj-1')).rejects.toBe(failure);
    expect(mocks.whenReady).not.toHaveBeenCalled();
    expect(mocks.rm).not.toHaveBeenCalled();
    expect(mocks.deleteProject).not.toHaveBeenCalled();
    expect(mocks.deleteProjectAgentScopes).not.toHaveBeenCalled();
  });

  it('a pending package boot fence holds all removals until its hook settles', async () => {
    mocks.getProjectById.mockResolvedValue(projectRecord({ archivedAt: '2026-06-30T00:00:00.000Z' }));
    let release!: () => void;
    mocks.deprovisionProjectForAll.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const purge = purgeProject('proj-1');
    await vi.waitFor(() => expect(mocks.deprovisionProjectForAll).toHaveBeenCalled());
    expect(mocks.rm).not.toHaveBeenCalled();
    expect(mocks.deleteProject).not.toHaveBeenCalled();
    release();
    await purge;
    expect(mocks.rm).toHaveBeenCalled();
  });

  it('a package that fails deprovisioning STOPS the purge before any rm — the id stays tombstoned', async () => {
    mocks.getProjectById.mockResolvedValue(projectRecord({ archivedAt: '2026-06-30T00:00:00.000Z' }));
    const failure = Object.assign(new Error('docker down'), { packageId: '@neuralis/machine-core' });
    mocks.deprovisionProjectForAll.mockRejectedValue(failure);

    await expect(purgeProject('proj-1')).rejects.toBe(failure);

    expect(mocks.markProjectIdPurged).toHaveBeenCalledWith('proj-1');
    expect(mocks.rm).not.toHaveBeenCalled();
    expect(mocks.deleteProject).not.toHaveBeenCalled();
    expect(mocks.deleteProjectAgentScopes).not.toHaveBeenCalled();
  });

  it('a retry after a failed deprovision re-runs the whole order and completes', async () => {
    mocks.getProjectById.mockResolvedValue(projectRecord({ archivedAt: '2026-06-30T00:00:00.000Z' }));
    mocks.deprovisionProjectForAll.mockRejectedValueOnce(new Error('timeout'));
    await expect(purgeProject('proj-1')).rejects.toThrow('timeout');
    order.length = 0;

    await purgeProject('proj-1');

    expect(order.slice(0, 2)).toEqual(['tombstone', 'deprovision']);
    expect(mocks.deleteProject).toHaveBeenCalledWith('proj-1');
    expect(mocks.markProjectIdPurged).toHaveBeenCalledTimes(2);
  });

  it('fails closed when a target realpath-resolves OUTSIDE its zone (symlink escape)', async () => {
    mocks.getProjectById.mockResolvedValue(projectRecord({ archivedAt: '2026-06-30T00:00:00.000Z' }));
    // The project tree target exists and its realpath escapes projectsRoot.
    mocks.existsSync.mockImplementation((p: string) => p === `${PROJECTS_ROOT}/proj-1` || p === PROJECTS_ROOT);
    mocks.realpathSync.mockImplementation((p: string) =>
      p === `${PROJECTS_ROOT}/proj-1` ? '/etc/evil' : p,
    );

    await expect(purgeProject('proj-1')).rejects.toThrow(/outside its zone/);
    expect(mocks.rm).not.toHaveBeenCalledWith('/etc/evil', expect.anything());
  });
});
