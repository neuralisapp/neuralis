/**
 * `source-zone-merge-v1` as the operator command loads it: discovered after
 * the v7 step, raising source-config to v8, with agent-core's record census as
 * the reference judge. Never the live home: every root is a temp dir.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePackageDataDir } from '@neuralis/package-system/paths';
import { loadUpgradeModules, UPGRADES_DIR } from '../../upgrade.mts';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const NONE = { read: false, write: false, exec: false };
const seed = (source: string) => ({
  source,
  scope: { kind: 'user', userId: 'u1' },
  connection: { kind: 'host', config: { root: 'neuralis-tree:skills' } },
  permissions: { default: NONE, byUser: { u1: { read: true, write: true, exec: true } }, byRole: { owner: { read: true }, admin: { read: true } } },
  createdBy: 'u1',
  formatVersion: 7,
});

function home() {
  const root = mkdtempSync(join(tmpdir(), 'nrs-zone-merge-host-'));
  dirs.push(root);
  const appRoot = join(root, 'app');
  const projectsRoot = join(root, 'projects');
  for (const project of ['main', 'busy']) {
    const dir = join(appRoot, 'config', 'sources', project);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'neuralis-skills.json'), JSON.stringify(seed('neuralis-skills'), null, 2));
  }
  // `busy`'s agent record names a package instance of its skills folder.
  const agentDir = join(resolvePackageDataDir(projectsRoot, 'busy', 'agent-core'), 'a1');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'a1.json'), JSON.stringify({ id: 'a1', packages: ['neuralis-skills://ops?project=busy&scope=user&user=u1'] }));
  const logs: string[] = [];
  return { ctx: { home: root, appRoot, projectsRoot, log: (line: string) => logs.push(line) }, logs, sources: (project: string) => readdirSync(join(appRoot, 'config', 'sources', project)).sort() };
}

describe('source-zone-merge-v1 — the Neuralis tree skills folder joins the tree source', { timeout: 60_000 }, () => {
  it('sorts after source-use-grants-v1 and raises source-config to v8', async () => {
    const modules = await loadUpgradeModules(UPGRADES_DIR);
    const files = modules.map(({ file }) => file);
    expect(files.indexOf('source-zone-merge-v1.mts')).toBeGreaterThan(files.indexOf('source-use-grants-v1.mts'));
    expect(modules.find(({ file }) => file === 'source-zone-merge-v1.mts')!.module.kinds).toEqual([{ kind: 'brain-core/source-config', to: 8 }]);
  });

  it('dry run writes nothing; apply merges the free folder and lists the one the census names', async () => {
    const step = (await loadUpgradeModules(UPGRADES_DIR)).find(({ file }) => file === 'source-zone-merge-v1.mts')!.module;
    const h = home();
    const mtime = statSync(join(h.ctx.appRoot, 'config', 'sources', 'main', 'neuralis-skills.json')).mtimeMs;
    const plan = await step.dryRun(h.ctx as never);
    expect(plan.summary).toContain('Neuralis-tree skills folders: 1 merged into the Neuralis tree, 0 dropped beside an attached one, 1 listed untouched');
    expect(statSync(join(h.ctx.appRoot, 'config', 'sources', 'main', 'neuralis-skills.json')).mtimeMs).toBe(mtime);
    const started = performance.now();
    await step.apply(h.ctx as never);
    const wall = performance.now() - started;
    expect(wall).toBeLessThan(2000);
    expect(h.sources('main')).toEqual(['neuralis.json']);
    expect(h.sources('busy')).toEqual(['neuralis-skills.json']);
    const busy = JSON.parse(readFileSync(join(h.ctx.appRoot, 'config', 'sources', 'busy', 'neuralis-skills.json'), 'utf8'));
    expect(busy).toEqual({ ...seed('neuralis-skills'), formatVersion: 8 });
    expect(h.logs.at(-1)).toBe('source-zone-merge-v1: 2 source config(s) written, 1 merged or dropped skills folder(s) removed');
  });
});
