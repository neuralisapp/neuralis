/**
 * R-4 — `createProject` stamps the ONE role seed (`seedRolesForNewProject`),
 * and it must REFUSE on a degenerate admin union.
 *
 * `DEFAULT_ROLES.admin.grantedFeatures` is built at module load from every
 * builtin manifest through a read that swallows ALL errors, over a builtin set
 * `NEURALIS_BUILTINS` can override for slim images. R-4 measured why a seed
 * from a degenerate union is permanent damage: `manager` / `member` / `viewer`
 * land at 0/33, 0/19, 0/7 and nothing at runtime ever revisits a seeded
 * record. So the create THROWS `ROLE_SEED_UNION_DEGENERATE` and persists
 * nothing. These tests pin both halves: the healthy path is stamped current,
 * and the degenerate path throws WITHOUT reaching the store. The
 * "nothing was written" assert is the actual floor — a throw that already wrote
 * would pass a `rejects.toThrow` on its own.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  put: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  // The store double carries `update` too — `createProject` does not use it, but
  // a double that lacks a store method silently turns a real regression into a
  // `TypeError` in an unrelated assertion.
  update: vi.fn(),
  initProjectDirectory: vi.fn(),
}));

// A per-run root: the real data-format claim writes its ledger under `appRoot`, and a
// FIXED path keeps that ledger across runs — a later build's format raise then reads
// as "stored data predates this build" on every machine that ran the suite before.
const TEST_ROOT = vi.hoisted(() => `/tmp/nrs-${process.pid}-${Math.random().toString(36).slice(2)}`);

vi.mock('../FileStore', () => ({
  FileStore: class {
    put = mocks.put;
    get = mocks.get;
    list = mocks.list;
    update = mocks.update;
  },
}));

vi.mock('../../config/env', () => ({
  // Both roots: the id choice stats the project tree under `projectsRoot` too.
  getEnv: () => ({
    appRoot: TEST_ROOT,
    projectsRoot: `${TEST_ROOT}/projects-data`,
  }),
}));

vi.mock('../../projects/projectInit', () => ({
  initProjectDirectory: mocks.initProjectDirectory,
}));

import type { ProjectRecord } from '../projectTypes';
import { createProject, DEFAULT_ROLES } from '../ProjectStore';

const LIVENESS_IDS = ['project.dashboard', 'drive.read', 'core.agents'] as const;

/** The record the id CLAIM wrote (`createProject` writes through `update`). */
async function lastWritten(): Promise<ProjectRecord> {
  const result = mocks.update.mock.results.at(-1);
  expect(result).toBeDefined();
  return (await result!.value) as ProjectRecord;
}

/** Run `fn` with the module-load union replaced in place, then restore it. */
async function withAdminUnion(next: string[], fn: () => Promise<void>): Promise<void> {
  const real = [...DEFAULT_ROLES.admin.grantedFeatures];
  DEFAULT_ROLES.admin.grantedFeatures.length = 0;
  DEFAULT_ROLES.admin.grantedFeatures.push(...next);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await fn();
  } finally {
    warn.mockRestore();
    DEFAULT_ROLES.admin.grantedFeatures.length = 0;
    DEFAULT_ROLES.admin.grantedFeatures.push(...real);
  }
}

describe('createProject — admin-union liveness floor', () => {
  beforeEach(() => {
    mocks.get.mockResolvedValue(null);
    mocks.put.mockResolvedValue(undefined);
    mocks.update.mockReset();
    // An empty store: the claim's producer sees no record and writes its own.
    mocks.update.mockImplementation(async (_id: string, fn: (current: ProjectRecord | null) => ProjectRecord | undefined) => fn(null));
    mocks.list.mockResolvedValue([]);
    mocks.initProjectDirectory.mockResolvedValue(undefined);
  });

  it('a HEALTHY union is stamped at the current role-grant version', async () => {
    const project = await createProject('Healthy', 'owner-1');
    expect(project.roleGrantVersion).toBe(19);
    expect(project.roles.admin.grantedFeatures).not.toContain('*');
    expect(project.roles.admin.grantedFeatures).toEqual(expect.arrayContaining([...LIVENESS_IDS]));
    expect((await lastWritten()).roleGrantVersion).toBe(19);
  });

  it('R-4 — an EMPTY union REFUSES, and nothing reaches the store', async () => {
    await withAdminUnion([], async () => {
      await expect(createProject('Degenerate', 'owner-1')).rejects.toThrow(
        /ROLE_SEED_UNION_DEGENERATE/,
      );
      // The floor: the refusal happens BEFORE any persistence, so there is no
      // half-seeded record to repair and no directory to clean up.
      expect(mocks.put).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.initProjectDirectory).not.toHaveBeenCalled();
    });
  });

  it('R-4 — a SHORT-but-nonempty union (missing one liveness id) is refused too', async () => {
    const short = DEFAULT_ROLES.admin.grantedFeatures.filter((f) => f !== 'core.agents');
    expect(short.length).toBeGreaterThan(0);
    await withAdminUnion(short, async () => {
      await expect(createProject('Short', 'owner-1')).rejects.toThrow(
        /ROLE_SEED_UNION_DEGENERATE/,
      );
      expect(mocks.put).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
    });
  });

  it('R-4 — the refusal does not mutate the shared DEFAULT_ROLES.admin object', async () => {
    await withAdminUnion([], async () => {
      await expect(createProject('NoAliasing', 'owner-1')).rejects.toThrow(
        /ROLE_SEED_UNION_DEGENERATE/,
      );
      expect(DEFAULT_ROLES.admin.grantedFeatures).toEqual([]);
    });
    // …and a subsequent HEALTHY creation is unaffected by the refused one.
    // (This replaces the old "repaired by a later healthy pass" case: nothing is
    // persisted any more, so there is nothing to repair — only the next healthy
    // CREATE has to work.)
    const healthy = await createProject('AfterDegenerate', 'owner-1');
    expect(healthy.roles.admin.grantedFeatures).not.toContain('*');
    expect(healthy.roleGrantVersion).toBe(19);
    expect((await lastWritten()).roles.admin.grantedFeatures).not.toContain('*');
  });

  it('R-4 — the refusal names the diagnosis: the id set AND the "nothing was written" fact', async () => {
    await withAdminUnion([], async () => {
      await expect(createProject('Diagnostic', 'owner-1')).rejects.toThrow(
        /project\.dashboard, drive\.read, core\.agents/,
      );
      await expect(createProject('Diagnostic', 'owner-1')).rejects.toThrow(/Nothing was written/);
    });
  });
});
