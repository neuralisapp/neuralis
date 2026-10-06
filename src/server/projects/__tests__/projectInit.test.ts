/**
 * `initProjectDirectory` creates the project's directories and hands the rest
 * to the packages' `provisionProject` fan-out. It writes NO source config: the
 * default sources are seeded by the package that declares them (brain-core's
 * own floor test pins what a new project gets). A runtime that is not ready
 * refuses BEFORE the first mkdir (paired: the ready row creates them).
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '', core: null as unknown }));

vi.mock('../../config/env', () => ({
  getEnv: () => ({ appRoot: join(state.root, 'app'), projectsRoot: join(state.root, 'projects') }),
}));

vi.mock('../../host/bootstrap', () => ({
  getRuntime: async () => {
    if (!state.core) throw new Error('runtime not ready');
    return { whenReady: async () => {}, ...(state.core as object) };
  },
}));

import { initProjectDirectory, RuntimeNotReadyError } from '../projectInit';

function sourcesDir(projectId: string): string {
  return join(state.root, 'app', 'config', 'sources', projectId);
}

describe('initProjectDirectory', () => {
  beforeEach(() => {
    state.root = mkdtempSync(join(tmpdir(), 'nrs-init-'));
  });
  afterEach(() => {
    rmSync(state.root, { recursive: true, force: true });
    state.core = null;
  });

  it('creates the directories and hands the project to every package — writing no source config itself', async () => {
    const provisionProjectForAll = vi.fn(async () => undefined);
    state.core = { getLoader: () => ({ provisionProjectForAll }) };
    await initProjectDirectory('fresh', 'owner-1');
    const projectDir = join(state.root, 'projects', 'fresh');
    expect(existsSync(join(projectDir, 'data'))).toBe(true);
    expect(existsSync(join(projectDir, '_packages'))).toBe(true);
    expect(existsSync(join(state.root, 'app', 'credentials', 'projects', 'fresh'))).toBe(true);
    expect(provisionProjectForAll).toHaveBeenCalledWith('fresh', projectDir, 'owner-1');
    expect(existsSync(sourcesDir('fresh'))).toBe(false);
  });

  it('a provisioning failure propagates to the caller (which refuses and rolls back the create)', async () => {
    const failure = new Error('EACCES /home/secret/path');
    state.core = {
      getLoader: () => ({ provisionProjectForAll: async () => { throw failure; } }),
    };
    await expect(initProjectDirectory('failing', 'owner-1')).rejects.toBe(failure);
  });

  it('runtime not ready ⇒ RuntimeNotReadyError and NOTHING written (no project dir, no credential dir, no source)', async () => {
    await expect(initProjectDirectory('early', 'owner-1')).rejects.toBeInstanceOf(RuntimeNotReadyError);
    expect(existsSync(join(state.root, 'projects'))).toBe(false);
    expect(existsSync(join(state.root, 'app'))).toBe(false);
    expect(existsSync(sourcesDir('early'))).toBe(false);
  });
});
