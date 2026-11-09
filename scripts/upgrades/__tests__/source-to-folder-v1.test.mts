/**
 * `source-to-folder-v1` as the operator command loads it. Never the live home:
 * every root is a temp dir.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadUpgradeModules, UPGRADES_DIR, type DiscoveredUpgrade } from '../../upgrade.mts';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

describe('source-to-folder-v1 — the host module', () => {
  // Loading every upgrade module is the cost, once: measured 2.7–3.7 s cold under tsx and
  // 4.2–5.0 s under vitest's transform (2026-11-02), so the load has its own bound and the rows reuse it.
  let modules: DiscoveredUpgrade[] = [];
  beforeAll(async () => { modules = await loadUpgradeModules(UPGRADES_DIR); }, 30_000);

  it('is discovered after source-root-pair-v1 and source-device-v1 and raises brain-core/source-config to v4', () => {
    const files = modules.map(({ file }) => file);
    expect(files.indexOf('source-to-folder-v1.mts')).toBeGreaterThan(files.indexOf('source-root-pair-v1.mts'));
    expect(files.indexOf('source-to-folder-v1.mts')).toBeGreaterThan(files.indexOf('source-device-v1.mts'));
    expect(modules.find(({ file }) => file === 'source-to-folder-v1.mts')!.module.kinds).toEqual([{ kind: 'brain-core/source-config', to: 4 }]);
    // The retired agent-core kind is no module's any more.
    expect(modules.flatMap(({ module }) => module.kinds.map((k) => k.kind))).not.toContain('agent-core/host-source-config');
  });

  it('merges a stopped install\'s folders in place', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nrs-source-to-folder-host-'));
    dirs.push(home);
    const appRoot = join(home, 'app');
    const dir = join(appRoot, 'config', 'sources', 'main');
    mkdirSync(dir, { recursive: true });
    const record = (source: string, connection: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({
      source, scope: { kind: 'project' }, connection, permissions: { default: { read: true, write: false, exec: false } },
      createdAt: 'then', updatedAt: 'then', createdBy: 'u1', formatVersion: 3, ...extra,
    }, null, 2);
    writeFileSync(join(dir, 'repo.json'), record('repo', { kind: 'local', config: { root: '/mounts/repo' } }, { recognizesPackages: true }));
    writeFileSync(join(dir, 'laptop.json'), record('laptop', { kind: 'host', config: { root: '/home/me', device: 'dev_a' } }));
    const module = modules.find(({ file }) => file === 'source-to-folder-v1.mts')!.module;
    const ctx = { home, appRoot, projectsRoot: join(home, 'projects'), log: () => {} };
    await module.apply(ctx);
    const read = (file: string) => JSON.parse(readFileSync(join(dir, file), 'utf8'));
    expect(read('repo.json')).toMatchObject({ connection: { kind: 'folder', config: { root: '/mounts/repo' } }, packageFolders: [''], formatVersion: 4 });
    expect(read('laptop.json')).toMatchObject({ connection: { kind: 'folder', config: { root: '/home/me', device: 'dev_a' } }, formatVersion: 4 });
  });
});
