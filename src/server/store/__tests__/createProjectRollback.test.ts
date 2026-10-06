/**
 * A project whose init fails does not survive it. `createProject` claims the
 * record BEFORE `initProjectDirectory` runs (the claim is the id race's lock),
 * so a failed init — the runtime not ready, a package's `provisionProject` hook
 * throwing — must hand the claimed id to the purge path (archive → purge: what
 * was provisioned, the tree, the record; the id tombstoned) and rethrow the
 * ORIGINAL error. Paired control: a healthy init purges nothing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  put: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
  initProjectDirectory: vi.fn(),
  archiveProject: vi.fn(),
  purgeProject: vi.fn(),
}));

vi.mock('../FileStore', () => ({
  FileStore: class {
    put = mocks.put;
    get = mocks.get;
    list = mocks.list;
    update = mocks.update;
  },
}));

vi.mock('../../config/env', () => ({
  getEnv: () => ({
    appRoot: '/tmp/nrs-create-project-rollback-test',
    projectsRoot: '/tmp/nrs-create-project-rollback-test/projects-data',
  }),
}));

vi.mock('../../projects/projectInit', () => ({
  initProjectDirectory: mocks.initProjectDirectory,
}));

vi.mock('../../projects/projectDeletion', () => ({
  archiveProject: mocks.archiveProject,
  purgeProject: mocks.purgeProject,
}));

import { ProjectProvisionError } from '@neuralis/package-system/contracts';
import type { ProjectRecord } from '../projectTypes';
import { createProject } from '../ProjectStore';

describe('createProject — a failed init rolls the claimed record back', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.update.mockImplementation(async (_id: string, fn: (current: ProjectRecord | null) => ProjectRecord | undefined) => fn(null));
    mocks.list.mockResolvedValue([]);
    mocks.archiveProject.mockResolvedValue(undefined);
    mocks.purgeProject.mockResolvedValue(undefined);
  });

  it('a provisioning failure purges the claimed id and rethrows the original error', async () => {
    const failure = new ProjectProvisionError('@acme/broken', 'EACCES /secret');
    mocks.initProjectDirectory.mockRejectedValueOnce(failure);
    const err = await createProject('Doomed', 'owner-1').catch((e: unknown) => e);
    expect(err).toBe(failure);
    const claimedId = mocks.initProjectDirectory.mock.calls[0]?.[0];
    expect(mocks.archiveProject).toHaveBeenCalledWith(claimedId);
    expect(mocks.purgeProject).toHaveBeenCalledWith(claimedId);
  });

  it('a rollback that itself fails still rethrows the ORIGINAL error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failure = new ProjectProvisionError('@acme/broken', 'boom');
    mocks.initProjectDirectory.mockRejectedValueOnce(failure);
    mocks.purgeProject.mockRejectedValueOnce(new Error('disk gone'));
    await expect(createProject('Doomed', 'owner-1')).rejects.toBe(failure);
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it('control: a healthy init purges nothing', async () => {
    mocks.initProjectDirectory.mockResolvedValueOnce(undefined);
    await createProject('Healthy', 'owner-1');
    expect(mocks.archiveProject).not.toHaveBeenCalled();
    expect(mocks.purgeProject).not.toHaveBeenCalled();
  });
});
