/**
 * `source-uri-subject-v1` as the operator command loads it: discovered after
 * the v5 step, raising the source-config kind to v6. Never the live home: every
 * root is a temp dir.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadUpgradeModules, UPGRADES_DIR } from '../../upgrade.mts';
import { subjectOf } from '../source-uri-subject-v1.mts';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

describe('source-uri-subject-v1 — the stored subject by strength', { timeout: 60_000 }, () => {
  it('sorts after source-to-host-v1 and raises source-config to v6', async () => {
    const modules = await loadUpgradeModules(UPGRADES_DIR);
    const files = modules.map(({ file }) => file);
    expect(files.indexOf('source-uri-subject-v1.mts')).toBeGreaterThan(files.indexOf('source-to-host-v1.mts'));
    expect(modules.find(({ file }) => file === 'source-uri-subject-v1.mts')!.module.kinds)
      .toEqual([{ kind: 'brain-core/source-config', to: 6 }]);
  });

  it('moves only a built-in GRANT row, to the weakest role it names', () => {
    const grant = { pattern: 'x', permissions: { read: true }, override: true };
    expect(subjectOf({ ...grant, roles: ['owner', 'admin'] })).toEqual({ priority: 2 });
    expect(subjectOf({ ...grant, roles: ['admin', 'owner'] })).toEqual({ priority: 2 });
    expect(subjectOf({ ...grant, roles: ['owner'] })).toEqual({ priority: 1 });
    expect(subjectOf({ ...grant, roles: ['constructor'] })).toEqual({ keep: 'own-names' });
    expect(subjectOf({ ...grant, roles: ['owner', 'reviewer'] })).toEqual({ keep: 'own-names' });
    // A deny row keeps its name: `priority` is grant-only, so moving it would switch the deny off.
    expect(subjectOf({ pattern: 'x', permissions: { read: false }, roles: ['owner'] })).toEqual({ keep: 'not-grant' });
    expect(subjectOf({ pattern: 'x', permissions: { read: true }, roles: ['owner', 'admin'] })).toEqual({ keep: 'not-grant' });
    expect(subjectOf({ ...grant, roles: [] })).toBeNull();
    expect(subjectOf(grant)).toBeNull();
  });

  it('dry-runs a stopped install, then applies in place and writes nothing the second time', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nrs-source-uri-subject-'));
    dirs.push(home);
    const appRoot = join(home, 'app');
    const projectsRoot = join(home, 'projects');
    const sources = join(appRoot, 'config', 'sources', 'main');
    mkdirSync(sources, { recursive: true });
    const record = (source: string, paths: unknown[], formatVersion = 5) => JSON.stringify({
      source, scope: { kind: 'project' }, connection: { kind: 'host', config: { root: '/mounts/x' } },
      permissions: { default: { read: true, write: true, exec: true }, paths },
      createdAt: 't', updatedAt: 't', createdBy: 'u1', formatVersion,
    }, null, 2);
    const ownerAdmin = { pattern: 'data://admin/audit/**', permissions: { read: true }, roles: ['owner', 'admin'], override: true };
    const reviewer = { pattern: 'data://x/**', permissions: { read: true }, roles: ['reviewer'], override: true };
    const ownerOnly = { pattern: 'data://admin/keys/**', permissions: { read: true, write: true }, roles: ['owner'], override: true };
    const legacyDeny = { pattern: 'data://agent-core/logs/system.jsonl', permissions: { read: true }, roles: ['owner', 'admin'] };
    writeFileSync(join(sources, 'data.json'), record('data', [{ pattern: 'data://admin/audit/**', permissions: { read: false } }, ownerAdmin, ownerOnly, reviewer, legacyDeny]));
    writeFileSync(join(sources, 'repo.json'), record('repo', []));
    writeFileSync(join(sources, 'later.json'), record('later', [ownerAdmin], 6));
    const laterBefore = readFileSync(join(sources, 'later.json'), 'utf8');

    const { module } = (await loadUpgradeModules(UPGRADES_DIR)).find(({ file }) => file === 'source-uri-subject-v1.mts')!;
    const ctx = { home, appRoot, projectsRoot, log: () => undefined };
    const plan = await module.dryRun(ctx);
    expect(plan.blockers).toBeUndefined();
    expect(plan.summary).toEqual([
      'source configs: 3 read, 2 to rewrite (every record stamped v6)',
      'path rules: 2 owner/admin grant row(s) take priority; kept as named roles: 1 naming a project role, 1 not a grant row',
    ]);
    expect(readFileSync(join(sources, 'data.json'), 'utf8')).toContain('"roles"');

    await module.apply(ctx);
    const data = JSON.parse(readFileSync(join(sources, 'data.json'), 'utf8'));
    expect(data.formatVersion).toBe(6);
    expect(data.permissions.paths).toEqual([
      { pattern: 'data://admin/audit/**', permissions: { read: false } },
      { pattern: 'data://admin/audit/**', permissions: { read: true }, override: true, priority: 2 },
      { pattern: 'data://admin/keys/**', permissions: { read: true, write: true }, override: true, priority: 1 },
      reviewer,
      legacyDeny,
    ]);
    expect(JSON.parse(readFileSync(join(sources, 'repo.json'), 'utf8')).formatVersion).toBe(6);
    expect(readFileSync(join(sources, 'later.json'), 'utf8')).toBe(laterBefore);

    // Idempotent: the second run finds every record at v6 and writes nothing.
    expect((await module.dryRun(ctx)).files).toEqual([]);
    const inodes = ['data.json', 'repo.json', 'later.json'].map((name) => statSync(join(sources, name)).ino);
    await module.apply(ctx);
    expect(['data.json', 'repo.json', 'later.json'].map((name) => statSync(join(sources, name)).ino)).toEqual(inodes);
  });
});
