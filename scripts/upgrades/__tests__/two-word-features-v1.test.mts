/**
 * `two-word-features-v1` and `platform-config-v2` on a throwaway home: every
 * stored role (custom ones included) takes the new ids in place, the deleted
 * `drive.mount.host` leaves the grant lists but STAYS as an access override
 * (fail-closed), the stored skill toggles follow the renamed skill, and the
 * project chain v2 → v3 → v4 runs in one `--apply` without the v4 write
 * losing what v3 added. Never the live home: every root is a temp dir.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listDataFormatDeclarations, offlineUpgradeSteps } from '@neuralis/package-system/data';
import { createTwoWordFeaturesUpgrade, renameFeatureList } from '../two-word-features-v1.mts';
import { createPlatformConfigUpgrade, RETIRED_PLATFORM_KEYS } from '../platform-config-v2.mts';
import { loadUpgradeModules, runUpgrade, UPGRADES_DIR } from '../../upgrade.mts';
import { HOST_CONFIG_SETTINGS } from '../../../src/server/config/hostConfigSettings.ts';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

type Fixture = { home: string; appRoot: string; projectsRoot: string; log: (line: string) => void };

function write(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function role(grantedFeatures: string[], priority: number): Record<string, unknown> {
  return { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures, priority };
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'nrs-two-word-'));
  dirs.push(root);
  return { home: root, appRoot: join(root, 'app'), projectsRoot: join(root, 'projects'), log: () => {} };
}

function files(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full); else out.set(full, readFileSync(full, 'utf8'));
    }
  };
  walk(root);
  return out;
}

const json = (path: string): Record<string, any> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;

/** A v3 project (after the device step), a custom role, package overrides, removals, toggles. */
function v3Home(): Fixture {
  const f = fixture();
  write(join(f.appRoot, 'projects', 'main.json'), {
    id: 'main',
    roleGrantVersion: 20,
    formatVersion: 3,
    roles: {
      owner: role(['*'], 1),
      admin: role(['core.agents', 'drive.read', 'exec.host', 'terminal.native', 'drive.mount.host', 'device.own'], 2),
      member: role(['drive.read', 'drive.write', 'terminal.read', 'exec.container'], 20),
      // A custom role: renamed in place, a duplicate the rename produces dropped, the deleted id gone.
      reviewer: role(['files.read', 'drive.read', 'drive.mount.host', 'drive.mount.privileged', 'machine.drive', 'filesystem.observeScoped'], 15),
    },
    packageGrantFeatures: { 'packages://ext?project=main': { member: ['drive.search', 'drive.mount.host', 'ext.use'] } },
    packageAccessFeature: { renamed: 'drive.policy', dead: 'drive.mount.host', custom: 'ext.use' },
  });
  // A record an earlier build stamped {21, 3}: rewritten all the same (the step keys on its own format).
  write(join(f.appRoot, 'projects', 'stamped.json'), { id: 'stamped', roleGrantVersion: 21, formatVersion: 3, roles: { member: role(['drive.read'], 20) } });
  // Already v4: never touched. Unseeded: born current on its first read.
  write(join(f.appRoot, 'projects', 'done.json'), { id: 'done', roleGrantVersion: 21, formatVersion: 4, roles: { member: role(['drive.read'], 20) } });
  write(join(f.appRoot, 'projects', 'fresh.json'), { id: 'fresh', roles: {} });
  write(join(f.appRoot, 'config', 'builtin-removals.json'), {
    removals: [{ packageId: '@neuralis/brain-core', features: ['drive.read', 'drive.mount.host', 'gone.feature'], removedAt: 'then' }],
    additions: [],
  });
  write(join(f.projectsRoot, 'main', 'data', 'agent-core', 'a1', 'a1.json'), {
    id: 'a1',
    config: { packages: { overrides: { '@neuralis/machine-core': { files: { skill: { 'machine-driving': { enabled: false } } } } } } },
  });
  write(join(f.projectsRoot, 'main', 'data', 'agent-core', 'a1', 'conversations', 'c1', 'meta.json'), {
    id: 'c1',
    settings: { fileOverrides: { '@neuralis/machine-core': { skill: { 'machine-driving': { enabled: false } } } } },
  });
  write(join(f.projectsRoot, 'main', 'data', 'agent-core', 'a1', 'workflows', 'w1', 'entry.json'), {
    id: 'w1',
    packages: { overrides: { '@neuralis/machine-core': { files: { skill: { 'machine-driving': { enabled: false } } } } } },
  });
  return f;
}

describe('two-word-features-v1 — the stored ids take their two-word names', () => {
  it('renames in place, keeps order, drops the deleted id and the duplicates a rename produces', () => {
    expect(renameFeatureList(['files.read', 'drive.read', 'drive.mount.host', 'core.agents', '*'])).toEqual({
      next: ['files.read', 'core.agents', '*'],
      changed: 2,
    });
    expect(renameFeatureList(['core.agents'])).toEqual({ next: ['core.agents'], changed: 0 });
  });

  it('dry run names every file and the losing roles and writes nothing; apply rewrites; a re-run writes nothing', async () => {
    const f = v3Home();
    const upgrade = createTwoWordFeaturesUpgrade();
    const before = files(f.home);
    const plan = await upgrade.dryRun(f);
    expect(plan.blockers).toBeUndefined();
    expect([...plan.files].sort()).toEqual([
      'app/config/builtin-removals.json',
      'app/projects/main.json',
      'app/projects/stamped.json',
      'projects/main/data/agent-core/a1/a1.json',
      'projects/main/data/agent-core/a1/conversations/c1/meta.json',
      'projects/main/data/agent-core/a1/workflows/w1/entry.json',
    ]);
    expect(plan.summary).toContain('  projects/main/data/agent-core/a1/workflows/w1/entry.json: 1');
    const summary = plan.summary.join('\n');
    // A rename never invents a capability: the custom role that held the deleted id without device.own is NAMED.
    expect(summary).toContain('role main · reviewer: held drive.mount.host without device.own');
    expect(summary).not.toMatch(/role main · admin:/);
    expect(summary).toContain('project main package dead: access feature drive.mount.host no longer exists');
    expect(files(f.home)).toEqual(before);

    await upgrade.apply(f);
    const main = json(join(f.appRoot, 'projects', 'main.json'));
    expect(main).toMatchObject({ roleGrantVersion: 21, formatVersion: 4 });
    expect(main.roles.owner.grantedFeatures).toEqual(['*']);
    expect(main.roles.admin.grantedFeatures).toEqual(['core.agents', 'files.read', 'exec.device', 'terminal.device', 'device.own']);
    expect(main.roles.member.grantedFeatures).toEqual(['files.read', 'files.write', 'terminal.local', 'exec.local']);
    expect(main.roles.reviewer.grantedFeatures).toEqual(['files.read', 'sources.privileged', 'machine.control', 'files.readOthers']);
    expect(main.roles.reviewer.grantedFeatures).not.toContain('device.own');
    expect(main.packageGrantFeatures).toEqual({ 'packages://ext?project=main': { member: ['files.search', 'ext.use'] } });
    // The deleted id STAYS as an access override: dropping it would show the package to everyone.
    expect(main.packageAccessFeature).toEqual({ renamed: 'sources.policy', dead: 'drive.mount.host', custom: 'ext.use' });
    expect(json(join(f.appRoot, 'projects', 'stamped.json'))).toMatchObject({ roleGrantVersion: 21, formatVersion: 4, roles: { member: { grantedFeatures: ['files.read'] } } });
    expect(json(join(f.appRoot, 'projects', 'done.json')).roles.member.grantedFeatures).toEqual(['drive.read']);
    expect(json(join(f.appRoot, 'projects', 'fresh.json'))).toEqual({ id: 'fresh', roles: {} });
    expect(json(join(f.appRoot, 'config', 'builtin-removals.json')).removals[0].features).toEqual(['files.read', 'gone.feature']);
    // A stored "off" stays off under the renamed skill id.
    expect(json(join(f.projectsRoot, 'main', 'data', 'agent-core', 'a1', 'a1.json')).config.packages.overrides['@neuralis/machine-core'].files.skill)
      .toEqual({ 'machine-control': { enabled: false } });
    expect(json(join(f.projectsRoot, 'main', 'data', 'agent-core', 'a1', 'conversations', 'c1', 'meta.json')).settings.fileOverrides['@neuralis/machine-core'].skill)
      .toEqual({ 'machine-control': { enabled: false } });
    // A workflow entry narrows files with the same vocabulary: its stored "off" stays off too.
    expect(json(join(f.projectsRoot, 'main', 'data', 'agent-core', 'a1', 'workflows', 'w1', 'entry.json')).packages.overrides['@neuralis/machine-core'].files.skill)
      .toEqual({ 'machine-control': { enabled: false } });

    const done = files(f.home);
    expect((await upgrade.dryRun(f)).files).toEqual([]);
    await upgrade.apply(f);
    expect(files(f.home)).toEqual(done);
  });

  it('ONE --apply carries a v19/v2 record through v3, v4 and v5: new ids, {22, 5}, the v3 write was {20, 3}, and device.own survives', { timeout: 60_000 }, async () => {
    const f = fixture();
    const project = join(f.appRoot, 'projects', 'main.json');
    write(project, {
      id: 'main',
      roleGrantVersion: 19,
      formatVersion: 2,
      roles: { owner: role(['*'], 1), admin: role(['core.agents', 'drive.read', 'exec.host'], 2), member: role(['drive.read'], 20) },
    });
    // Every offline kind current except the project chain, which stands at the identity step.
    await loadUpgradeModules(UPGRADES_DIR);
    const ledger: Record<string, { version: number; raisedAt: string }> = {};
    for (const decl of listDataFormatDeclarations()) {
      if (offlineUpgradeSteps(decl).length > 0) ledger[decl.kind] = { version: decl.kind === 'neuralis/project' ? 2 : decl.version, raisedAt: 'then' };
    }
    write(join(f.appRoot, 'config', 'data-formats.json'), ledger);

    let afterDeviceStep: Record<string, any> | null = null;
    let afterFeatureStep: Record<string, any> | null = null;
    const outcome = await runUpgrade({
      appRuns: 'docker',
      apply: true,
      modulesDir: UPGRADES_DIR,
      roots: f,
      offline: async () => ({ offline: true }),
      log: (line) => {
        if (line === 'source-device-v1: applied.') afterDeviceStep = json(project);
        if (line === 'two-word-features-v1: applied.') afterFeatureStep = json(project);
      },
    });
    expect(outcome).toMatchObject({ applied: true, pending: ['neuralis/project'] });
    expect(afterDeviceStep).toMatchObject({ roleGrantVersion: 20, formatVersion: 3 });
    const done = json(project);
    expect(afterFeatureStep).toMatchObject({ roleGrantVersion: 21, formatVersion: 4 });
    expect(done).toMatchObject({ roleGrantVersion: 22, formatVersion: 5 });
    expect(done.roles.admin.grantedFeatures).toEqual(['core.agents', 'files.read', 'exec.device', 'device.own']);
    // The v4 apply re-read the record the v3 apply wrote — never its own dry-run snapshot.
    expect(done.roles.admin.grantedFeatures).toContain('device.own');
    expect(done.roles.member.grantedFeatures).toEqual(['files.read', 'device.own']);
  });
});

describe('platform-config-v2 — the retired keys leave platform.json', () => {
  it('drops only the listed keys, keeps a registered one and an unknown one, and a re-run writes nothing', async () => {
    const f = fixture();
    const path = join(f.appRoot, 'config', 'platform.json');
    write(path, { hostBrokerSocketPath: '/run/neuralis/host-broker/host-broker.sock', maxProjects: 3, someoneElsesKey: 'kept' });
    const upgrade = createPlatformConfigUpgrade();
    const before = files(f.home);
    const plan = await upgrade.dryRun(f);
    expect(plan.files).toEqual(['app/config/platform.json']);
    expect(plan.summary.join('\n')).toContain('hostBrokerSocketPath');
    expect(plan.summary.join('\n')).not.toContain('/run/neuralis');
    expect(files(f.home)).toEqual(before);

    await upgrade.apply(f);
    expect(json(path)).toEqual({ maxProjects: 3, someoneElsesKey: 'kept' });
    const done = files(f.home);
    expect((await upgrade.dryRun(f)).files).toEqual([]);
    await upgrade.apply(f);
    expect(files(f.home)).toEqual(done);
  });

  it('no retired key is a key this build registers', () => {
    const registered = new Set(HOST_CONFIG_SETTINGS.map((setting) => setting.key));
    expect(RETIRED_PLATFORM_KEYS.filter((key) => registered.has(key))).toEqual([]);
  });

  it('no platform.json: nothing to do', async () => {
    const f = fixture();
    expect(await createPlatformConfigUpgrade().dryRun(f)).toEqual({ files: [], summary: ['app/config/platform.json: no retired key'] });
  });
});
