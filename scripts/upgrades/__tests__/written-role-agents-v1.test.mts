/**
 * `written-role-agents-v1` on a throwaway home: a stored role with no `agents`
 * takes one (builtin name → its builtin level, any other role → `own`), a role
 * that names one is untouched, a record already at v5 is never re-read or
 * lowered, and a second run writes nothing. Never the live home.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentAccessFor, createWrittenRoleAgentsUpgrade } from '../written-role-agents-v1.mts';
import { DEFAULT_ROLES } from '../../../src/server/store/projectTypes.ts';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function home() {
  const root = mkdtempSync(join(tmpdir(), 'nrs-role-agents-'));
  dirs.push(root);
  return { home: root, appRoot: join(root, 'app'), projectsRoot: join(root, 'projects'), log: () => {} };
}
const write = (path: string, value: unknown): void => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2)); };
const json = (path: string): Record<string, any> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;

describe('written-role-agents-v1', () => {
  it('the pinned builtin levels equal the shipped default roles (custom names → own)', () => {
    for (const [name, def] of Object.entries(DEFAULT_ROLES)) expect(agentAccessFor(name)).toBe(def.agents);
    expect(agentAccessFor('developer')).toBe('own');
  });

  it('stamps only the roles that name no level, raises the record, and a second run writes nothing', async () => {
    const f = home();
    const main = join(f.appRoot, 'projects', 'main.json');
    write(main, {
      id: 'main', roleGrantVersion: 21, formatVersion: 4,
      roles: {
        member: { grantedFeatures: ['files.read'], priority: 20 },
        developer: { grantedFeatures: ['files.write'], priority: 15 },
        viewer: { agents: 'view', grantedFeatures: [], priority: 30 },
      },
    });
    const raised = join(f.appRoot, 'projects', 'later.json');
    write(raised, { id: 'later', roleGrantVersion: 22, formatVersion: 5, roles: { odd: { grantedFeatures: [] } } });
    const unseeded = join(f.appRoot, 'projects', 'fresh.json');
    write(unseeded, { id: 'fresh', roles: {} });
    const before = { raised: readFileSync(raised, 'utf8'), unseeded: readFileSync(unseeded, 'utf8') };

    const mod = createWrittenRoleAgentsUpgrade();
    const plan = await mod.dryRun(f);
    expect(plan.files).toEqual(['app/projects/main.json']);
    expect(plan.summary).toEqual([
      'projects: 1 raised to revision 22, 2 role(s) without an agent level stamped',
      '  role main · member → own',
      '  role main · developer → own',
    ]);
    await mod.apply(f);
    const after = json(main);
    expect([after.formatVersion, after.roleGrantVersion]).toEqual([5, 22]);
    expect(after.roles.member).toEqual({ grantedFeatures: ['files.read'], priority: 20, agents: 'own' });
    expect(after.roles.developer.agents).toBe('own');
    expect(after.roles.viewer).toEqual({ agents: 'view', grantedFeatures: [], priority: 30 });
    // A record a later step raised is never re-read or lowered; an unseeded one waits for its first read.
    expect(readFileSync(raised, 'utf8')).toBe(before.raised);
    expect(readFileSync(unseeded, 'utf8')).toBe(before.unseeded);
    expect((await mod.dryRun(f)).files).toEqual([]);
  });

  it("a builtin role name takes its builtin level — an owner role with no field gets '*', never less", async () => {
    const f = home();
    const p = join(f.appRoot, 'projects', 'p.json');
    write(p, { id: 'p', roleGrantVersion: 21, formatVersion: 4, roles: { owner: { grantedFeatures: ['*'], priority: 1 }, viewer: { grantedFeatures: [], priority: 30 } } });
    await createWrittenRoleAgentsUpgrade().apply(f);
    expect(json(p).roles.owner.agents).toBe('*');
    expect(json(p).roles.viewer.agents).toBe('view');
  });
});
