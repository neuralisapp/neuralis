/**
 * Offline upgrade `two-word-features-v1`: every stored feature id takes the
 * connector-layer two-word name (`files.*`, `sources.*`, `exec.local`,
 * `terminal.local`, `machine.control`, …) and the deleted `drive.mount.host`
 * leaves the stored grants. On a stopped app this module:
 *
 *  (i)   rewrites `neuralis/project` to v4 (role-grant revision 21): EVERY role,
 *        builtin and custom, renames its `grantedFeatures` in place — order
 *        kept, duplicates dropped, `'*'` untouched — and so does every
 *        `packageGrantFeatures` list; a `packageAccessFeature` override takes
 *        the new id, except the deleted one, which STAYS (fail-closed: the
 *        package stays hidden until an owner picks a new access feature —
 *        dropping it would widen who sees the package);
 *  (ii)  renames the same ids in `app/config/builtin-removals.json`, dropping
 *        the deleted one;
 *  (iii) renames the per-file toggle of the renamed `machine-control` skill on
 *        every agent record, conversation and workflow entry (agent-core's `renameFileToggleKeys`),
 *        so a stored "off" stays off.
 *
 * A rename never invents a capability: a role that held `drive.mount.host`
 * without `device.own` does NOT gain `device.own`; the dry run names it.
 *
 * A record at format v4 or above is skipped (the step this module owns), and
 * the rewrite does not look at the stored `roleGrantVersion` — an earlier step
 * stamped its own revision. An unseeded record (setup's empty role map) is
 * seeded at the current revision on its first read and is skipped. `apply`
 * re-reads every record; it never writes back the dry run's snapshot, because
 * the earlier steps of the chain apply in between (the device step adds
 * `device.own`).
 *
 * File name: sorts after `source-device-v1.mts`, the chain order of
 * `neuralis/project`. The way back is the checkpoint the command takes.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { durableReplaceFile, type OfflineUpgradeContext, type OfflineUpgradeModule, type OfflineUpgradePlan } from '@neuralis/package-system/data';
import { isSafePathSegment, resolvePackageDataDir } from '@neuralis/package-system/paths';
import { renameFileToggleKeys } from '@neuralis/agent-core/upgrade';
import { HOST_DATA_FORMATS, PROJECT_UPGRADE_STEPS } from '../../src/server/store/dataFormats';
import { BUILTIN_GRANT_CHANGES_FILE } from '../../src/server/packages/reconcileBuiltinGrantChanges';

/** The role-grant revision THIS step produces (a chained step pins its own). */
const ROLE_GRANT_REVISION = 21;

/** The deleted id: a device's owner attaches its sources under `device.own`, nobody else does. */
export const DELETED_FEATURE = 'drive.mount.host';

/** Old id → new id; `null` = deleted. Migration DATA, read once by this module. */
export const FEATURE_RENAMES: Readonly<Record<string, string | null>> = {
  'drive.read': 'files.read',
  'drive.write': 'files.write',
  'drive.search': 'files.search',
  'filesystem.observeScoped': 'files.readOthers',
  'filesystem.modifyScoped': 'files.writeOthers',
  'drive.mount': 'sources.mount',
  'drive.mount.privileged': 'sources.privileged',
  'drive.sync': 'sources.sync',
  'drive.policy': 'sources.policy',
  [DELETED_FEATURE]: null,
  'exec.container': 'exec.local',
  'exec.host': 'exec.device',
  'terminal.read': 'terminal.local',
  'terminal.container': 'terminal.unconfined',
  'terminal.native': 'terminal.device',
  'machine.drive': 'machine.control',
};

/** Renamed file ids whose per-file toggles are stored on agent records and conversations. */
export const FILE_ID_RENAMES: Readonly<Record<string, string>> = { 'machine-driving': 'machine-control' };

const DEVICE_OWN = 'device.own';

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/** One id list renamed in place: order kept, the deleted id dropped, duplicates dropped. */
export function renameFeatureList(list: readonly string[]): { next: string[]; changed: number } {
  const next: string[] = [];
  let changed = 0;
  for (const id of list) {
    const renamed = Object.hasOwn(FEATURE_RENAMES, id) ? FEATURE_RENAMES[id]! : id;
    // Counted: every renamed id, the deleted one, and a duplicate the rename produced or the list carried.
    if (renamed !== id || (renamed !== null && next.includes(renamed))) changed += 1;
    if (renamed !== null && !next.includes(renamed)) next.push(renamed);
  }
  return { next, changed };
}

type ProjectRow = { file: string; next: Json; renamed: number; lostDevice: string[]; deadAccess: string[] };
type ToggleRow = { file: string; next: unknown; changed: number };
type RemovalRow = { file: string; next: Json; changed: number } | null;

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function listDir(dir: string): Promise<{ name: string; dir: boolean; file: boolean }[]> {
  try {
    // Dirent types do not follow symlinks: a symlinked entry is neither walked nor read.
    return (await readdir(dir, { withFileTypes: true }))
      .map((entry) => ({ name: entry.name, dir: entry.isDirectory(), file: entry.isFile() }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function inspectProjects(ctx: OfflineUpgradeContext): Promise<ProjectRow[]> {
  const dir = join(ctx.appRoot, 'projects');
  const rows: ProjectRow[] = [];
  for (const entry of await listDir(dir)) {
    if (!entry.file || !entry.name.endsWith('.json')) continue;
    const path = join(dir, entry.name);
    const record = await readJson(path);
    if (!isObject(record)) throw new Error(`${relative(ctx.home, path)} is not a project record`);
    const roles = isObject(record.roles) ? record.roles : {};
    if (record.roleGrantVersion === undefined && Object.keys(roles).length === 0) continue; // unseeded: born current on its first read
    if (typeof record.formatVersion === 'number' && record.formatVersion >= PROJECT_UPGRADE_STEPS.features.to) continue;
    const projectId = typeof record.id === 'string' ? record.id : entry.name.slice(0, -'.json'.length);
    let renamed = 0;
    const lostDevice: string[] = [];
    const nextRoles: Json = {};
    for (const [name, definition] of Object.entries(roles)) {
      if (!isObject(definition) || !isStringList(definition.grantedFeatures)) {
        nextRoles[name] = definition;
        continue;
      }
      const features = definition.grantedFeatures;
      const { next, changed } = renameFeatureList(features);
      renamed += changed;
      if (features.includes(DELETED_FEATURE) && !next.includes('*') && !next.includes(DEVICE_OWN)) lostDevice.push(name);
      nextRoles[name] = { ...definition, grantedFeatures: next };
    }
    const next: Json = { ...record, roles: nextRoles, roleGrantVersion: ROLE_GRANT_REVISION, formatVersion: PROJECT_UPGRADE_STEPS.features.to };
    if (isObject(record.packageGrantFeatures)) {
      const grants: Json = {};
      for (const [pkg, byRole] of Object.entries(record.packageGrantFeatures)) {
        if (!isObject(byRole)) {
          grants[pkg] = byRole;
          continue;
        }
        const nextByRole: Json = {};
        for (const [role, list] of Object.entries(byRole)) {
          if (!isStringList(list)) {
            nextByRole[role] = list;
            continue;
          }
          const renamedList = renameFeatureList(list);
          renamed += renamedList.changed;
          nextByRole[role] = renamedList.next;
        }
        grants[pkg] = nextByRole;
      }
      next.packageGrantFeatures = grants;
    }
    const deadAccess: string[] = [];
    if (isObject(record.packageAccessFeature)) {
      const access: Json = {};
      for (const [pkg, feature] of Object.entries(record.packageAccessFeature)) {
        const target = typeof feature === 'string' && Object.hasOwn(FEATURE_RENAMES, feature) ? FEATURE_RENAMES[feature] : undefined;
        if (target === null) deadAccess.push(pkg);
        if (typeof target === 'string') renamed += 1;
        access[pkg] = typeof target === 'string' ? target : feature;
      }
      next.packageAccessFeature = access;
    }
    rows.push({ file: relative(ctx.home, path), next, renamed, lostDevice: lostDevice.map((role) => `${projectId} · ${role}`), deadAccess: deadAccess.map((pkg) => `${projectId} · ${pkg}`) });
  }
  return rows;
}

async function inspectRemovals(ctx: OfflineUpgradeContext): Promise<RemovalRow> {
  const path = join(ctx.appRoot, BUILTIN_GRANT_CHANGES_FILE);
  let record: unknown;
  try {
    record = await readJson(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!isObject(record) || !Array.isArray(record.removals)) return null;
  let changed = 0;
  const removals = record.removals.map((entry: unknown) => {
    if (!isObject(entry) || !isStringList(entry.features)) return entry;
    const renamed = renameFeatureList(entry.features);
    changed += renamed.changed;
    return { ...entry, features: renamed.next };
  });
  return changed > 0 ? { file: relative(ctx.home, path), next: { ...record, removals }, changed } : null;
}

/** Agent records, conversation metas (forks included) and workflow entries under every project's agent-core zone. */
async function inspectToggles(ctx: OfflineUpgradeContext): Promise<ToggleRow[]> {
  const rows: ToggleRow[] = [];
  const consider = async (path: string): Promise<void> => {
    const { record, changed } = renameFileToggleKeys(await readJson(path), FILE_ID_RENAMES);
    if (changed > 0) rows.push({ file: relative(ctx.home, path), next: record, changed });
  };
  const conversation = async (dir: string): Promise<void> => {
    for (const entry of await listDir(dir)) {
      if (entry.file && entry.name === 'meta.json') await consider(join(dir, entry.name));
      if (entry.dir && entry.name === 'forks') {
        for (const fork of await listDir(join(dir, 'forks'))) if (fork.dir) await conversation(join(dir, 'forks', fork.name));
      }
    }
  };
  for (const project of await listDir(ctx.projectsRoot)) {
    if (!project.dir || !isSafePathSegment(project.name)) continue;
    const coreRoot = resolvePackageDataDir(ctx.projectsRoot, project.name, 'agent-core');
    for (const agent of await listDir(coreRoot)) {
      if (!agent.dir) continue;
      const agentRoot = join(coreRoot, agent.name);
      for (const entry of await listDir(agentRoot)) {
        if (entry.file && entry.name === `${agent.name}.json`) await consider(join(agentRoot, entry.name));
        if (entry.dir && entry.name === 'conversations') {
          for (const conv of await listDir(join(agentRoot, 'conversations'))) if (conv.dir) await conversation(join(agentRoot, 'conversations', conv.name));
        }
        // A workflow entry narrows files with the same vocabulary (`workflows/<id>/entry.json`).
        if (entry.dir && entry.name === 'workflows') {
          for (const flow of await listDir(join(agentRoot, 'workflows'))) {
            if (!flow.dir) continue;
            const file = (await listDir(join(agentRoot, 'workflows', flow.name))).find((f) => f.file && f.name === 'entry.json');
            if (file) await consider(join(agentRoot, 'workflows', flow.name, 'entry.json'));
          }
        }
      }
    }
  }
  return rows;
}

type Plan = { projects: ProjectRow[]; removals: RemovalRow; toggles: ToggleRow[] };

async function plan(ctx: OfflineUpgradeContext): Promise<Plan> {
  return { projects: await inspectProjects(ctx), removals: await inspectRemovals(ctx), toggles: await inspectToggles(ctx) };
}

function asPlan(p: Plan): OfflineUpgradePlan {
  const lost = p.projects.flatMap((row) => row.lostDevice);
  const dead = p.projects.flatMap((row) => row.deadAccess);
  return {
    files: [...p.projects.map((row) => row.file), ...(p.removals ? [p.removals.file] : []), ...p.toggles.map((row) => row.file)],
    summary: [
      `projects: ${p.projects.length} raised to revision ${ROLE_GRANT_REVISION}, ${p.projects.reduce((n, row) => n + row.renamed, 0)} feature id(s) renamed or dropped`,
      ...p.projects.filter((row) => row.renamed > 0).map((row) => `  ${row.file}: ${row.renamed}`),
      `builtin grant changes: ${p.removals ? `${p.removals.changed} id(s) in ${p.removals.file}` : 'nothing to rename'}`,
      `skill toggles: ${p.toggles.reduce((n, row) => n + row.changed, 0)} renamed (${Object.entries(FILE_ID_RENAMES).map(([from, to]) => `${from} → ${to}`).join(', ')}) in ${p.toggles.length} file(s)`,
      ...p.toggles.map((row) => `  ${row.file}: ${row.changed}`),
      ...lost.map((line) => `role ${line}: held ${DELETED_FEATURE} without ${DEVICE_OWN} — it no longer attaches its own device's sources (an owner grants ${DEVICE_OWN} to keep that)`),
      ...dead.map((line) => `project ${line.replace(' · ', ' package ')}: access feature ${DELETED_FEATURE} no longer exists — the package stays hidden until an owner picks a new one`),
    ],
  };
}

export function createTwoWordFeaturesUpgrade(): OfflineUpgradeModule {
  return {
    id: PROJECT_UPGRADE_STEPS.features.id,
    kinds: [{ kind: HOST_DATA_FORMATS.project.kind, to: PROJECT_UPGRADE_STEPS.features.to }],
    dryRun: async (ctx) => asPlan(await plan(ctx)),
    async apply(ctx) {
      // Re-read every record: the earlier steps of the chain wrote in between the dry runs and this apply.
      const p = await plan(ctx);
      for (const row of p.projects) await durableReplaceFile(join(ctx.home, row.file), JSON.stringify(row.next, null, 2));
      if (p.removals) await durableReplaceFile(join(ctx.home, p.removals.file), JSON.stringify(p.removals.next, null, 2));
      for (const row of p.toggles) await durableReplaceFile(join(ctx.home, row.file), JSON.stringify(row.next, null, 2));
      ctx.log(`two-word-features-v1: ${p.projects.length} project(s) raised, ${p.removals ? 1 : 0} grant-change record and ${p.toggles.length} agent/conversation/workflow file(s) rewritten`);
    },
  };
}

export default createTwoWordFeaturesUpgrade() satisfies OfflineUpgradeModule;
