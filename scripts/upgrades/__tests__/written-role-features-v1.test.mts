/**
 * `written-role-features-v1` on a throwaway home: every stored list takes one
 * id per right, the shipped builtin roles move to exactly what a new project is
 * seeded with, a hand-built role that held part of a merged group is merged (or,
 * for the two shell-plane pairs, loses the lone half) and is NAMED — in the dry
 * run, and in apply as one audit row written before the record — and nothing
 * ever blocks. Never the live home: every root is a temp dir.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUDIT_ACTION, createWrittenRoleFeaturesUpgrade, FEATURE_MERGES, mergeFeatureList, quietGainFor, warningText } from '../written-role-features-v1.mts';
import { DEFAULT_ROLES } from '../../../src/server/store/projectTypes.ts';

const PRODUCT_PACKAGES = ['admin', 'agent-core', 'brain-core', 'machine-core'];
/** The ids the four product packages provide — a machine-local builtin's grants are not this step's data. */
const productIds = new Set(PRODUCT_PACKAGES.flatMap((name) => {
  const manifest = JSON.parse(readFileSync(new URL(`../../../../packages/${name}/package.json`, import.meta.url), 'utf8')) as { neuralis: { requires: { providesFeatures: Array<{ id: string }> } } };
  return manifest.neuralis.requires.providesFeatures.map((feature) => feature.id);
}));

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

type Fixture = { home: string; appRoot: string; projectsRoot: string; log: (line: string) => void; lines: string[] };

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'nrs-role-features-'));
  dirs.push(root);
  const lines: string[] = [];
  return { home: root, appRoot: join(root, 'app'), projectsRoot: join(root, 'projects'), log: (line) => lines.push(line), lines };
}
const write = (path: string, value: unknown): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2)); };
const json = (path: string): Record<string, any> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
const role = (grantedFeatures: string[], priority: number): Record<string, unknown> => ({ agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures, priority });
const auditRows = (f: Fixture): Array<Record<string, any>> => {
  const path = join(f.appRoot, 'logs', 'audit.jsonl');
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, any>) : [];
};
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

/** What the builtin roles were seeded with by the release before this step (the manifests' `defaultRoleGrants` union). */
const SEEDED_BEFORE: Record<string, string[]> = {
  admin: ['core.agents', 'core.execute', 'exec.local', 'core.observe', 'core.connectors', 'core.web', 'core.logs', 'exec.unconfined', 'exec.device', 'core.prompt-polish', 'core.conversation.fork', 'workflow.read', 'workflow.write', 'workflow.dispatch', 'mcp.connect', 'mcp.sidecar', 'mcp.apps', 'channels.connect', 'channels.manage', 'git.connect', 'credentials.self', 'terminal.local', 'terminal.unconfined', 'terminal.device', 'terminal.supervise', 'device.own', 'files.read', 'files.write', 'files.search', 'sources.sync', 'sources.mount', 'sources.privileged', 'sources.policy', 'files.readOthers', 'files.writeOthers', 'packages.author', 'packages.registry', 'project.dashboard', 'project.members', 'project.audit', 'project.roles', 'project.sources', 'project.limits', 'project.credentials', 'project.credentials.write', 'project.canvas', 'packages.manage', 'project.members.invite', 'project.agents.assign', 'machine.read', 'machine.control', 'exec.machine'],
  manager: ['core.agents', 'core.execute', 'exec.local', 'core.observe', 'core.web', 'core.prompt-polish', 'workflow.read', 'workflow.write', 'workflow.dispatch', 'channels.connect', 'mcp.connect', 'git.connect', 'credentials.self', 'terminal.local', 'device.own', 'files.read', 'files.write', 'files.search', 'sources.sync', 'sources.mount', 'packages.author', 'packages.registry', 'project.dashboard', 'machine.read', 'machine.control'],
  member: ['core.agents', 'core.execute', 'exec.local', 'core.observe', 'core.web', 'core.prompt-polish', 'workflow.read', 'workflow.write', 'channels.connect', 'mcp.connect', 'git.connect', 'credentials.self', 'terminal.local', 'device.own', 'files.read', 'files.search', 'packages.registry', 'project.dashboard', 'machine.read'],
  viewer: ['core.agents', 'core.observe', 'workflow.read', 'files.read', 'project.dashboard'],
};

describe('written-role-features-v1 — one id per right', () => {
  it('the table names 19 old ids, each merged into a surviving id or deleted', () => {
    expect(Object.keys(FEATURE_MERGES)).toHaveLength(19);
    expect(FEATURE_MERGES['packages.author']).toBeNull();
  });

  it('merges one list: a half of a new pair merges up, a lone shell-plane half drops, an absorbed id without its survivor merges up, a survivor alone gains what it absorbed — each named', () => {
    expect(mergeFeatureList(['exec.local', 'core.agents'])).toMatchObject({
      next: ['server.shell', 'core.agents'],
      warnings: [{ held: ['exec.local'], missing: ['terminal.local'], now: 'server.shell' }],
    });
    // D1b: merging up would hand a hand-built role the unsandboxed shell / another member's commands.
    expect(mergeFeatureList(['terminal.unconfined', 'exec.device', 'files.read'])).toMatchObject({
      next: ['files.read'],
      warnings: [
        { held: ['terminal.unconfined'], missing: ['exec.unconfined'], now: null },
        { held: ['exec.device'], missing: ['terminal.device'], now: null },
        { held: ['files.read'], missing: ['files.search'], now: 'files.read' },
      ],
    });
    // Reverse: the absorbed right without the surviving one.
    expect(mergeFeatureList(['files.search'])).toMatchObject({ next: ['files.read'], warnings: [{ held: ['files.search'], missing: ['files.read'], now: 'files.read' }] });
    // The survivor alone GAINS what it absorbed — named, with what it gained; the whole group is silent, the order kept.
    const widened = mergeFeatureList(['core.execute', 'machine.control', 'exec.local', 'terminal.local', 'packages.author', '*']);
    expect(widened).toEqual({
      next: ['core.execute', 'machine.control', 'server.shell', '*'],
      changed: 3,
      warnings: [
        { held: ['core.execute'], missing: ['core.prompt-polish', 'core.conversation.fork'], now: 'core.execute', merged: 'core.execute' },
        { held: ['machine.control'], missing: ['exec.machine'], now: 'machine.control', merged: 'machine.control' },
      ],
    });
    expect(warningText('p · role ops', widened.warnings[1]!)).toBe('p · role ops: held machine.control without exec.machine — gained exec.machine: machine.control now covers both; removing machine.control removes both');
    expect(mergeFeatureList(['files.read', 'files.search', 'core.execute', 'core.prompt-polish', 'core.conversation.fork']).warnings).toEqual([]);
  });

  it('only the shipped widening of a BUILTIN role name stays silent; the same list on another role, or a wider gain, is named', () => {
    expect(mergeFeatureList(['files.read'], quietGainFor('viewer', false)).warnings).toEqual([]);
    expect(mergeFeatureList(['core.execute', 'core.prompt-polish'], quietGainFor('member', false)).warnings).toEqual([]);
    expect(mergeFeatureList(['files.read'], quietGainFor('reader', false)).warnings).toEqual([
      { held: ['files.read'], missing: ['files.search'], now: 'files.read', merged: 'files.read' },
    ]);
    // A member that never held core.prompt-polish gains it too: not the shipped widening, named.
    expect(mergeFeatureList(['core.execute'], quietGainFor('member', false)).warnings).toHaveLength(1);
    // The below-v4 machine.drive rename is the one silent survivor outside the builtin names.
    expect(mergeFeatureList(['machine.control'], quietGainFor('driver', true)).warnings).toEqual([]);
  });

  it('the shipped builtin roles move to exactly what a new project is seeded with, without a warning', async () => {
    const f = fixture();
    const roles = Object.fromEntries(Object.entries(SEEDED_BEFORE).map(([name, list]) => [name, role(list, DEFAULT_ROLES[name]!.priority)]));
    write(join(f.appRoot, 'projects', 'p.json'), { id: 'p', roleGrantVersion: 22, formatVersion: 5, roles: { owner: role(['*'], 1), ...roles } });
    const plan = await createWrittenRoleFeaturesUpgrade().dryRun(f);
    expect(plan.blockers).toBeUndefined();
    expect(plan.summary).toContain('partially held rights: 0');
    await createWrittenRoleFeaturesUpgrade().apply(f);
    const after = json(join(f.appRoot, 'projects', 'p.json'));
    expect(after.roles.owner.grantedFeatures).toEqual(['*']);
    for (const name of Object.keys(SEEDED_BEFORE)) {
      expect([...after.roles[name].grantedFeatures].sort(), name).toEqual(DEFAULT_ROLES[name]!.grantedFeatures.filter((id) => productIds.has(id)).sort());
    }
    // The widenings, stated: manager and member fork (core.execute), viewer searches (files.read),
    // manager opens the desktop shell (machine.control) — each through an id it already held.
    expect(after.roles.manager.grantedFeatures).toEqual(expect.arrayContaining(['core.execute', 'files.read', 'machine.control', 'sources.manage', 'server.shell']));
    expect(after.roles.viewer.grantedFeatures).toContain('files.read');
    expect(auditRows(f)).toEqual([]);
  });

  it('a hand-built role is merged and named — dry run writes nothing, apply audits BEFORE the record, a re-run writes nothing', async () => {
    const f = fixture();
    const main = join(f.appRoot, 'projects', 'main.json');
    write(main, {
      id: 'main', roleGrantVersion: 22, formatVersion: 5,
      roles: {
        owner: role(['*'], 1),
        operator: role(['exec.device', 'files.read'], 15),
        searcher: role(['files.search'], 25),
        full: role(['exec.local', 'terminal.local', 'files.read', 'files.search'], 16),
      },
      packageGrantFeatures: { 'packages://ext?project=main': { searcher: ['core.logs', 'ext.use'] } },
      packageAccessFeature: { tool: 'sources.sync', dead: 'packages.author', custom: 'ext.use' },
    });
    // Unseeded, and already v6: never read.
    write(join(f.appRoot, 'projects', 'fresh.json'), { id: 'fresh', roles: {} });
    write(join(f.appRoot, 'projects', 'done.json'), { id: 'done', roleGrantVersion: 23, formatVersion: 6, roles: { member: role(['exec.local'], 20) } });
    write(join(f.appRoot, 'config', 'builtin-removals.json'), {
      removals: [{ packageId: '@neuralis/brain-core', features: ['files.search', 'files.read', 'sources.sync', 'sources.mount', 'packages.author', 'drive.sync'], removedAt: 'then' }],
      additions: [],
    });
    const upgrade = createWrittenRoleFeaturesUpgrade();
    const before = files(f.home);
    const plan = await upgrade.dryRun(f);
    expect(plan.blockers).toBeUndefined();
    expect([...plan.files].sort()).toEqual(['app/config/builtin-removals.json', 'app/projects/main.json']);
    const summary = plan.summary.join('\n');
    expect(summary).toContain('partially held rights: 4');
    expect(summary).toContain('app/projects/main.json · role operator: held files.read without files.search — gained files.search: files.read now covers both; removing files.read removes both');
    expect(summary).toContain("app/projects/main.json · role operator: held exec.device without terminal.device — lost exec.device; give it Use other members' computers (sandboxed) and see their folder paths in Admin → Roles if intended");
    expect(summary).toContain('app/projects/main.json · role searcher: held files.search without files.read — now holds files.read, which covers both; removing files.read removes both');
    expect(summary).toContain('package packages://ext?project=main grant to role searcher: held core.logs without project.audit — now holds project.audit');
    expect(summary).not.toMatch(/role full:/);
    expect(summary).toContain('project main package dead: access feature packages.author no longer exists');
    expect(files(f.home)).toEqual(before);
    expect(auditRows(f)).toEqual([]);

    await upgrade.apply(f);
    const after = json(main);
    expect(after).toMatchObject({ roleGrantVersion: 23, formatVersion: 6 });
    expect(after.roles.operator.grantedFeatures).toEqual(['files.read']);
    expect(after.roles.searcher.grantedFeatures).toEqual(['files.read']);
    expect(after.roles.full.grantedFeatures).toEqual(['server.shell', 'files.read']);
    expect(after.packageGrantFeatures).toEqual({ 'packages://ext?project=main': { searcher: ['project.audit', 'ext.use'] } });
    // The deleted access feature STAYS: the package stays hidden (fail-closed) until an owner picks one.
    expect(after.packageAccessFeature).toEqual({ tool: 'sources.manage', dead: 'packages.author', custom: 'ext.use' });
    // A removal names what leaves: every old id takes its merged id (a pre-rename id is renamed first).
    expect(json(join(f.appRoot, 'config', 'builtin-removals.json')).removals[0].features).toEqual(['files.read', 'sources.manage']);
    expect(json(join(f.appRoot, 'projects', 'done.json')).roles.member.grantedFeatures).toEqual(['exec.local']);
    expect(json(join(f.appRoot, 'projects', 'fresh.json'))).toEqual({ id: 'fresh', roles: {} });
    const rows = auditRows(f);
    expect(rows.map((row) => [row.action, row.userId, row.target, row.details.role, row.details.held, row.details.now])).toEqual([
      [AUDIT_ACTION, null, 'project:main', 'operator', ['exec.device'], null],
      [AUDIT_ACTION, null, 'project:main', 'operator', ['files.read'], 'files.read'],
      [AUDIT_ACTION, null, 'project:main', 'searcher', ['files.search'], 'files.read'],
      [AUDIT_ACTION, null, 'project:main', 'searcher', ['core.logs'], 'project.audit'],
    ]);
    expect(rows.every((row) => row.details.step === 'written-role-features-v1')).toBe(true);
    expect(f.lines.some((line) => line.includes('role searcher: held files.search'))).toBe(true);

    const done = files(f.home);
    expect((await upgrade.dryRun(f)).files).toEqual([]);
    await upgrade.apply(f);
    expect(files(f.home)).toEqual(done);
    expect(auditRows(f)).toHaveLength(4);
  });

  it('a record below v4 is judged AFTER the earlier rename: machine.drive is the survivor, never a warning', async () => {
    const f = fixture();
    write(join(f.appRoot, 'projects', 'old.json'), {
      id: 'old', roleGrantVersion: 20, formatVersion: 3,
      roles: { driver: role(['machine.drive', 'drive.search'], 15) },
    });
    const plan = await createWrittenRoleFeaturesUpgrade().dryRun(f);
    expect(plan.files).toEqual(['app/projects/old.json']);
    const summary = plan.summary.join('\n');
    expect(summary).not.toMatch(/machine/);
    // drive.search → files.search → files.read: the absorbed id without its survivor, named.
    expect(summary).toContain('role driver: held files.search without files.read — now holds files.read');
  });

  it('a failed audit append throws before the record is replaced', async () => {
    const f = fixture();
    const main = join(f.appRoot, 'projects', 'main.json');
    write(main, { id: 'main', roleGrantVersion: 22, formatVersion: 5, roles: { searcher: role(['files.search'], 25) } });
    // A directory where the log file belongs: the append cannot write.
    mkdirSync(join(f.appRoot, 'logs', 'audit.jsonl'), { recursive: true });
    const before = readFileSync(main, 'utf8');
    await expect(createWrittenRoleFeaturesUpgrade().apply(f)).rejects.toThrow();
    expect(readFileSync(main, 'utf8')).toBe(before);
  });
});
