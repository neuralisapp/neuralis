/**
 * Offline upgrade `written-role-agents-v1`: every stored role says how far its
 * holders manage agents. A role record without an `agents` field takes one —
 * a builtin role name its builtin level, any other role `own` (it manages the
 * agents its holders made or were assigned). `neuralis/project` v4 → v5,
 * role-grant revision 22. A role that already names its level is never
 * touched, and nothing else of a record changes.
 *
 * A record at format v5 or above is skipped (the step this module owns); an
 * unseeded record (setup's empty role map) is seeded at the current revision on
 * its first read and is skipped. `apply` re-reads every record: the earlier
 * steps of the chain apply in between.
 *
 * File name: sorts after `two-word-features-v1.mts` (`w` > `t`), the step
 * before it in the `neuralis/project` chain. The way back is the checkpoint the
 * command takes.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { durableReplaceFile, type OfflineUpgradeContext, type OfflineUpgradeModule, type OfflineUpgradePlan } from '@neuralis/package-system/data';
import { HOST_DATA_FORMATS, PROJECT_UPGRADE_STEPS } from '../../src/server/store/dataFormats';

/** The role-grant revision THIS step produces (a chained step pins its own). */
const ROLE_GRANT_REVISION = 22;

/** The builtin roles' agent levels, pinned as they were when this step was written. Migration DATA. */
export const BUILTIN_AGENT_ACCESS: Readonly<Record<string, '*' | 'own' | 'view'>> = {
  owner: '*',
  admin: '*',
  manager: '*',
  member: 'own',
  viewer: 'view',
};

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

type ProjectRow = { file: string; next: Json; stamped: string[] };

/** The level a role without one takes. */
export function agentAccessFor(roleName: string): '*' | 'own' | 'view' {
  return Object.hasOwn(BUILTIN_AGENT_ACCESS, roleName) ? BUILTIN_AGENT_ACCESS[roleName]! : 'own';
}

async function plan(ctx: OfflineUpgradeContext): Promise<ProjectRow[]> {
  const dir = join(ctx.appRoot, 'projects');
  let names: string[] = [];
  try {
    names = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => e.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const rows: ProjectRow[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const record = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!isObject(record)) throw new Error(`${relative(ctx.home, path)} is not a project record`);
    const roles = isObject(record.roles) ? record.roles : {};
    if (record.roleGrantVersion === undefined && Object.keys(roles).length === 0) continue; // unseeded: born current on its first read
    if (typeof record.formatVersion === 'number' && record.formatVersion >= PROJECT_UPGRADE_STEPS.agents.to) continue;
    const projectId = typeof record.id === 'string' ? record.id : name.slice(0, -'.json'.length);
    const stamped: string[] = [];
    const nextRoles: Json = {};
    for (const [roleName, definition] of Object.entries(roles)) {
      if (isObject(definition) && definition.agents === undefined) {
        const level = agentAccessFor(roleName);
        nextRoles[roleName] = { ...definition, agents: level };
        stamped.push(`${projectId} · ${roleName} → ${level}`);
      } else {
        nextRoles[roleName] = definition;
      }
    }
    rows.push({
      file: relative(ctx.home, path),
      next: { ...record, roles: nextRoles, roleGrantVersion: ROLE_GRANT_REVISION, formatVersion: PROJECT_UPGRADE_STEPS.agents.to },
      stamped,
    });
  }
  return rows;
}

function asPlan(rows: ProjectRow[]): OfflineUpgradePlan {
  const stamped = rows.flatMap((row) => row.stamped);
  return {
    files: rows.map((row) => row.file),
    summary: [
      `projects: ${rows.length} raised to revision ${ROLE_GRANT_REVISION}, ${stamped.length} role(s) without an agent level stamped`,
      ...stamped.map((line) => `  role ${line}`),
    ],
  };
}

export function createWrittenRoleAgentsUpgrade(): OfflineUpgradeModule {
  return {
    id: PROJECT_UPGRADE_STEPS.agents.id,
    kinds: [{ kind: HOST_DATA_FORMATS.project.kind, to: PROJECT_UPGRADE_STEPS.agents.to }],
    dryRun: async (ctx) => asPlan(await plan(ctx)),
    async apply(ctx) {
      const rows = await plan(ctx);
      for (const row of rows) await durableReplaceFile(join(ctx.home, row.file), JSON.stringify(row.next, null, 2));
      ctx.log(`${PROJECT_UPGRADE_STEPS.agents.id}: ${rows.length} project(s) raised, ${rows.reduce((n, row) => n + row.stamped.length, 0)} role(s) stamped`);
    },
  };
}

export default createWrittenRoleAgentsUpgrade() satisfies OfflineUpgradeModule;
