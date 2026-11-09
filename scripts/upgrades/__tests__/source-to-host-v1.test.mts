/**
 * `source-to-host-v1` as the operator command loads it: discovered after the
 * v4 step, raising the source-config kind to v5 and the two stored-plane kinds
 * to v2 in ONE module. Never the live home: every root is a temp dir.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadUpgradeModules, UPGRADES_DIR } from '../../upgrade.mts';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

describe('source-to-host-v1 — the host module', { timeout: 60_000 }, () => {
  it('sorts after source-to-folder-v1 and raises source-config to v5 with the two stored-plane kinds to v2', async () => {
    const modules = await loadUpgradeModules(UPGRADES_DIR);
    const files = modules.map(({ file }) => file);
    expect(files.indexOf('source-to-host-v1.mts')).toBeGreaterThan(files.indexOf('source-to-folder-v1.mts'));
    expect(modules.find(({ file }) => file === 'source-to-host-v1.mts')!.module.kinds).toEqual([
      { kind: 'brain-core/source-config', to: 5 },
      { kind: 'agent-core/conversation-messages', to: 2 },
      { kind: 'agent-core/shell-run', to: 2 },
    ]);
  });

  it('dry-runs a stopped install, then applies in place and writes nothing the second time', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nrs-source-to-host-host-'));
    dirs.push(home);
    const appRoot = join(home, 'app');
    const projectsRoot = join(home, 'projects');
    const sources = join(appRoot, 'config', 'sources', 'main');
    mkdirSync(sources, { recursive: true });
    const record = (source: string, config: Record<string, unknown>) => JSON.stringify({
      source, scope: { kind: 'project' }, connection: { kind: 'folder', config }, permissions: { default: { read: true, write: false, exec: false } },
      createdAt: 't', updatedAt: 't', createdBy: 'u1', formatVersion: 4,
    }, null, 2);
    writeFileSync(join(sources, 'repo.json'), record('repo', { root: '/mounts/repo' }));
    writeFileSync(join(sources, 'laptop.json'), record('laptop', { root: '/home/u1', device: 'dev_a' }));
    const conv = join(projectsRoot, 'main', 'data', 'agent-core', 'alice', 'conversations', 'c1');
    mkdirSync(conv, { recursive: true });
    writeFileSync(join(conv, 'messages.jsonl'), '{"structuredContent":{"plane":"host","device":"dev_a"}}\n');
    const { module } = (await loadUpgradeModules(UPGRADES_DIR)).find(({ file }) => file === 'source-to-host-v1.mts')!;
    const ctx = { home, appRoot, projectsRoot, log: () => undefined };
    const plan = await module.dryRun(ctx);
    expect(plan.blockers).toBeUndefined();
    expect(plan.summary).toContain('host sources: 1 on this server, 1 on a device (was folder); other kinds 0; already v5 0');
    expect(readFileSync(join(sources, 'repo.json'), 'utf8')).toContain('"kind": "folder"');
    await module.apply(ctx);
    expect(JSON.parse(readFileSync(join(sources, 'laptop.json'), 'utf8'))).toMatchObject({ connection: { kind: 'host', config: { root: '/home/u1', device: 'dev_a' } }, formatVersion: 5 });
    expect(readFileSync(join(conv, 'messages.jsonl'), 'utf8')).toBe('{"structuredContent":{"plane":"device","device":"dev_a"}}\n');
    expect((await module.dryRun(ctx)).files).toEqual([]);
  });
});
