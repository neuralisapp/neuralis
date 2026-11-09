/**
 * `source-root-pair-v1` as the operator command loads it: the plane facts come
 * from THIS run's environment (inside the container: `NEURALIS_DOCKER`,
 * `NEURALIS_HOST_HOME`, the mount pairs) and, on the host, from the compose
 * override's mount pairs. Never the live home: every root is a temp dir.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSourceRootPairStep } from '../source-root-pair-v1.mts';
import { loadUpgradeModules, UPGRADES_DIR } from '../../upgrade.mts';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const MACHINE = '/home/op/.neuralis';
/** A run on the machine: no container signal, no mount pairs in the environment. */
const HOST_ENV: NodeJS.ProcessEnv = { NODE_ENV: 'test' };

function home(recordsFor: (home: string) => Record<string, Record<string, unknown>>): { ctx: { home: string; appRoot: string; projectsRoot: string; log: () => void }; read: (file: string) => Record<string, any> } {
  const root = mkdtempSync(join(tmpdir(), 'nrs-source-root-pair-'));
  dirs.push(root);
  const appRoot = join(root, 'app');
  for (const [file, config] of Object.entries(recordsFor(root))) {
    const path = join(appRoot, 'config', 'sources', 'main', file);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify({
      source: file.replace(/\.json$/, ''), scope: { kind: 'project' }, connection: { kind: 'local', config },
      permissions: { default: { read: true, write: false, exec: false } }, createdAt: 'then', updatedAt: 'then', createdBy: 'u1',
    }, null, 2));
  }
  return {
    ctx: { home: root, appRoot, projectsRoot: join(root, 'projects'), log: () => {} },
    read: (file) => JSON.parse(readFileSync(join(appRoot, 'config', 'sources', 'main', file), 'utf8')),
  };
}

describe('source-root-pair-v1 — the host module', () => {
  it('is discovered after package-identity-v2 and raises brain-core/source-config to v3', async () => {
    const modules = await loadUpgradeModules(UPGRADES_DIR);
    const files = modules.map(({ file }) => file);
    expect(files.indexOf('source-root-pair-v1.mts')).toBeGreaterThan(files.indexOf('package-identity-v2.mts'));
    expect(modules.find(({ file }) => file === 'source-root-pair-v1.mts')!.module.kinds).toEqual([{ kind: 'brain-core/source-config', to: 3 }]);
  });

  // Inside the image the command's data home IS `/.neuralis`; here a temp dir stands in for it.
  it('inside the container: its own home is the container spelling, NEURALIS_HOST_HOME and the env mount pairs give the machine halves', async () => {
    const { ctx, read } = home((dataHome) => ({ 'app.json': { root: `${dataHome}/app` }, 'repo.json': { root: '/mounts/repo' } }));
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', NEURALIS_DOCKER: 'true', NEURALIS_HOST_HOME: MACHINE, NEURALIS_MOUNT_repo: '/mounts/repo', NEURALIS_MOUNT_HOST_REPO: '/home/op/repo' };
    await createSourceRootPairStep(join(ctx.home, 'none.yml'), env).apply(ctx);
    expect(read('app.json').connection.config).toEqual({ root: `${ctx.home}/app`, hostRoot: `${MACHINE}/app` });
    expect(read('repo.json').connection.config).toEqual({ root: '/mounts/repo', hostRoot: '/home/op/repo' });
    expect(read('repo.json').formatVersion).toBe(3);
  });

  it('on the machine the compose override names the mount pairs; without it a mount root stays as written (paired control)', async () => {
    const records = (): Record<string, Record<string, unknown>> => ({ 'repo.json': { root: '/mounts/repo-x' } });
    const bare = home(records);
    await createSourceRootPairStep(join(bare.ctx.home, 'absent.yml'), HOST_ENV).apply(bare.ctx);
    expect(bare.read('repo.json').connection.config).toEqual({ root: '/mounts/repo-x' });

    const paired = home(records);
    const override = join(paired.ctx.home, 'docker-compose.override.yml');
    writeFileSync(override, 'services:\n  neuralis:\n    environment:\n      - NEURALIS_MOUNT_repo-x=/mounts/repo-x\n      - NEURALIS_MOUNT_HOST_REPO_X=/home/op/repo-x\n');
    await createSourceRootPairStep(override, HOST_ENV).apply(paired.ctx);
    expect(paired.read('repo.json').connection.config).toEqual({ root: '/mounts/repo-x', hostRoot: '/home/op/repo-x' });
  });
});
