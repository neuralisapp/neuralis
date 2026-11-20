/**
 * Offline upgrade `written-role-features-v1`: every pair (or trio) of stored
 * feature ids that named ONE thing becomes one id — the agent shell and the
 * terminal on the server (`server.shell`), the same without the sandbox
 * (`server.unconfined`), another member's computer (`device.others`), source
 * management (`sources.manage`), and the ids folded into `platform.vector`,
 * `platform.projects`, `project.members`, `project.audit`, `core.execute`,
 * `files.read` and `machine.control`; `packages.author` leaves the stored
 * grants. `neuralis/project` v5 → v6, role-grant revision 23. On a stopped app
 * this module:
 *
 *  (i)   rewrites EVERY role, builtin and custom, and every
 *        `packageGrantFeatures` list — order kept, duplicates dropped, `'*'`
 *        untouched. A list that held only PART of a merge group takes the
 *        merged id (it now holds the whole group), except for the two
 *        shell-plane pairs (`server.unconfined`, `device.others`), where a lone
 *        half is DROPPED: merging it up would hand a hand-built role the
 *        unsandboxed agent shell or another member's commands it never had.
 *        A list that already held a group's SURVIVING id (`files.read`,
 *        `core.execute`, `machine.control`, …) keeps it and now also holds what
 *        that id absorbed — a gain, so it is named like every other partial
 *        holding (half of a new pair, an absorbed id without its surviving
 *        one): one warning line. Silent are ONLY the widenings the shipped
 *        roles take by name (`BUILTIN_WIDENINGS`) and a record below v4 whose
 *        `machine.drive` became `machine.control` (that id always ran the
 *        desktop shell);
 *  (ii)  points a `packageAccessFeature` override at the merged id; the
 *        deleted one STAYS (fail-closed: the package stays hidden until an
 *        owner picks a new access feature);
 *  (iii) renames the same ids in `app/config/builtin-removals.json`.
 *
 * Nothing blocks: the warnings go to the dry run and the apply output, and in
 * APPLY each one is ALSO one row in the platform audit log
 * (`app/logs/audit.jsonl`, action `role.features_merged`), written through the
 * kernel appender into THIS context's app root before that project's file is
 * replaced — a crash in between repeats a row on the rerun, it never loses one.
 * A failed append throws, and the upgrade stays resumable.
 *
 * A record at format v6 or above is skipped (the step this module owns), and so
 * is an unseeded record (setup's empty role map), seeded current on its first
 * read. A record below v4 still carries the ids the `two-word-features-v1`
 * step renames, so the dry run composes that rename first; `apply` re-reads
 * every record, because the earlier steps of the chain apply in between.
 *
 * The file name sorts after `written-role-agents-v1.mts`, the step before it
 * in the `neuralis/project` chain. The way back is the checkpoint the command takes.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { durableReplaceFile, JsonlAppender, type OfflineUpgradeContext, type OfflineUpgradeModule, type OfflineUpgradePlan } from '@neuralis/package-system/data';
import { containedOrThrow } from '@neuralis/package-system/paths';
import { HOST_DATA_FORMATS, PROJECT_UPGRADE_STEPS } from '../../src/server/store/dataFormats';
import { BUILTIN_GRANT_CHANGES_FILE } from '../../src/server/packages/reconcileBuiltinGrantChanges';
import { renameFeatureList as renameTwoWordFeatures } from './two-word-features-v1.mts';

/** The role-grant revision THIS step produces (a chained step pins its own). */
const ROLE_GRANT_REVISION = 23;

/** The audit action every warning row carries (the host `AuditAction` union lists it). */
export const AUDIT_ACTION = 'role.features_merged';

/** Merged id → the stored ids it replaces (the merged id itself first when it existed before). Migration DATA. */
export const MERGE_GROUPS: Readonly<Record<string, readonly string[]>> = {
  'server.shell': ['exec.local', 'terminal.local'],
  'server.unconfined': ['exec.unconfined', 'terminal.unconfined'],
  'device.others': ['exec.device', 'terminal.device'],
  'sources.manage': ['sources.sync', 'sources.mount'],
  'platform.vector': ['platform.vector', 'platform.vector.reset', 'platform.vector.maintain'],
  'platform.projects': ['platform.projects', 'platform.projects.create'],
  'project.members': ['project.members', 'project.members.invite', 'project.agents.assign'],
  'project.audit': ['project.audit', 'core.logs'],
  'core.execute': ['core.execute', 'core.prompt-polish', 'core.conversation.fork'],
  'files.read': ['files.read', 'files.search'],
  'machine.control': ['machine.control', 'exec.machine'],
};

/** The deleted id: the scaffold launcher follows `files.write`, nothing else read it. */
export const DELETED_FEATURE = 'packages.author';

/** The two shell-plane pairs whose LONE half is dropped, never merged up — with the title an owner grants instead. */
export const DROP_LONE_HALF: Readonly<Record<string, string>> = {
  'server.unconfined': 'Server without the sandbox',
  'device.others': "Use other members' computers (sandboxed) and see their folder paths",
};

/** Old id → merged id; `null` = deleted. Derived from the groups — ONE table. */
export const FEATURE_MERGES: Readonly<Record<string, string | null>> = Object.freeze({
  ...Object.fromEntries(Object.entries(MERGE_GROUPS).flatMap(([to, from]) => from.filter((id) => id !== to).map((id) => [id, to]))),
  [DELETED_FEATURE]: null,
});

/**
 * The widenings the shipped roles take through an id they already hold —
 * silent for a role of THAT name only: viewer searches (`files.read`), manager
 * and member fork (`core.execute`), manager runs the desktop shell
 * (`machine.control`). Any other gain is named.
 */
export const BUILTIN_WIDENINGS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  viewer: { 'files.read': ['files.search'] },
  manager: { 'core.execute': ['core.conversation.fork'], 'machine.control': ['exec.machine'] },
  member: { 'core.execute': ['core.conversation.fork'] },
};

/** One partially-held group of one list. */
export type MergeWarning = { held: string[]; missing: string[]; now: string | null; merged: string };

/** Whether a gain through a held surviving id is one the caller states silently. */
export type QuietGain = (merged: string, gained: readonly string[]) => boolean;

/** The quiet gains of one stored list: the role's shipped widenings, and a below-v4 `machine.drive`. */
export function quietGainFor(roleName: string, renamedFromDrive: boolean): QuietGain {
  return (merged, gained) =>
    gained.every((id) => BUILTIN_WIDENINGS[roleName]?.[merged]?.includes(id) === true)
    || (renamedFromDrive && merged === 'machine.control');
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/**
 * One id list merged in place: each member of a group becomes the group's id at
 * the position of its first member, a lone shell-plane half is dropped, the
 * deleted id is dropped, duplicates are dropped, `'*'` stays.
 */
export function mergeFeatureList(list: readonly string[], quiet: QuietGain = () => false): { next: string[]; changed: number; warnings: MergeWarning[] } {
  const warnings: MergeWarning[] = [];
  const dropped = new Set<string>();
  for (const [merged, group] of Object.entries(MERGE_GROUPS)) {
    const held = group.filter((id) => list.includes(id));
    if (held.length === 0 || held.length === group.length) continue;
    const missing = group.filter((id) => !held.includes(id));
    const drop = Object.hasOwn(DROP_LONE_HALF, merged);
    if (drop) for (const id of held) dropped.add(id);
    if (held.includes(merged) && quiet(merged, missing)) continue;
    warnings.push({ held, missing, now: drop ? null : merged, merged });
  }
  const next: string[] = [];
  let changed = 0;
  for (const id of list) {
    const target = dropped.has(id) ? null : Object.hasOwn(FEATURE_MERGES, id) ? FEATURE_MERGES[id]! : id;
    if (target !== id || (target !== null && next.includes(target))) changed += 1;
    if (target !== null && !next.includes(target)) next.push(target);
  }
  return { next, changed, warnings };
}

/** The warning sentence — never a promise of a half-undo: the merged id is one right. */
export function warningText(where: string, warning: MergeWarning): string {
  const held = warning.held.join(' + ');
  const without = warning.missing.join(' + ');
  if (warning.now === null) {
    return `${where}: held ${held} without ${without} — lost ${held}; give it ${DROP_LONE_HALF[warning.merged]} in Admin → Roles if intended`;
  }
  const covers = warning.held.length + warning.missing.length > 2 ? 'all of them' : 'both';
  if (warning.held.includes(warning.merged)) {
    return `${where}: held ${held} without ${without} — gained ${without}: ${warning.merged} now covers ${covers}; removing ${warning.merged} removes ${covers}`;
  }
  return `${where}: held ${held} without ${without} — now holds ${warning.now}, which covers ${covers}; removing ${warning.now} removes ${covers}`;
}

type AuditRow = { timestamp: string; userId: null; action: string; target: string; details: Json };
type ProjectRow = { file: string; next: Json; changed: number; warnings: string[]; audit: AuditRow[]; deadAccess: string[] };
type RemovalRow = { file: string; next: Json; changed: number } | null;

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

function auditRow(projectId: string, role: string, warning: MergeWarning, pkg?: string): AuditRow {
  return {
    timestamp: new Date().toISOString(),
    userId: null,
    action: AUDIT_ACTION,
    target: `project:${projectId}`,
    details: { role, ...(pkg ? { package: pkg } : {}), held: warning.held, missing: warning.missing, now: warning.now, step: PROJECT_UPGRADE_STEPS.features2.id },
  };
}

async function inspectProjects(ctx: OfflineUpgradeContext): Promise<ProjectRow[]> {
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
    const record = await readJson(path);
    if (!isObject(record)) throw new Error(`${relative(ctx.home, path)} is not a project record`);
    const roles = isObject(record.roles) ? record.roles : {};
    if (record.roleGrantVersion === undefined && Object.keys(roles).length === 0) continue; // unseeded: born current on its first read
    if (typeof record.formatVersion === 'number' && record.formatVersion >= PROJECT_UPGRADE_STEPS.features2.to) continue;
    // Below v4 the stored ids are the ones `two-word-features-v1` renames first (the dry run runs before it applies).
    const preTwoWord = typeof record.formatVersion !== 'number' || record.formatVersion < PROJECT_UPGRADE_STEPS.features.to;
    const current = (list: readonly string[]): string[] => (preTwoWord ? renameTwoWordFeatures(list).next : [...list]);
    const projectId = typeof record.id === 'string' ? record.id : name.slice(0, -'.json'.length);
    const file = relative(ctx.home, path);
    let changed = 0;
    const warnings: string[] = [];
    const audit: AuditRow[] = [];
    const nextRoles: Json = {};
    for (const [roleName, definition] of Object.entries(roles)) {
      if (!isObject(definition) || !isStringList(definition.grantedFeatures)) {
        nextRoles[roleName] = definition;
        continue;
      }
      const merged = mergeFeatureList(current(definition.grantedFeatures), quietGainFor(roleName, preTwoWord && definition.grantedFeatures.includes('machine.drive')));
      changed += merged.changed;
      for (const warning of merged.warnings) {
        warnings.push(warningText(`${file} · role ${roleName}`, warning));
        audit.push(auditRow(projectId, roleName, warning));
      }
      nextRoles[roleName] = { ...definition, grantedFeatures: merged.next };
    }
    const next: Json = { ...record, roles: nextRoles, roleGrantVersion: ROLE_GRANT_REVISION, formatVersion: PROJECT_UPGRADE_STEPS.features2.to };
    if (isObject(record.packageGrantFeatures)) {
      const grants: Json = {};
      for (const [pkg, byRole] of Object.entries(record.packageGrantFeatures)) {
        if (!isObject(byRole)) {
          grants[pkg] = byRole;
          continue;
        }
        const nextByRole: Json = {};
        for (const [roleName, list] of Object.entries(byRole)) {
          if (!isStringList(list)) {
            nextByRole[roleName] = list;
            continue;
          }
          const merged = mergeFeatureList(current(list), quietGainFor(roleName, preTwoWord && list.includes('machine.drive')));
          changed += merged.changed;
          for (const warning of merged.warnings) {
            warnings.push(warningText(`${file} · package ${pkg} grant to role ${roleName}`, warning));
            audit.push(auditRow(projectId, roleName, warning, pkg));
          }
          nextByRole[roleName] = merged.next;
        }
        grants[pkg] = nextByRole;
      }
      next.packageGrantFeatures = grants;
    }
    const deadAccess: string[] = [];
    if (isObject(record.packageAccessFeature)) {
      const access: Json = {};
      for (const [pkg, feature] of Object.entries(record.packageAccessFeature)) {
        const stored = typeof feature === 'string' ? current([feature])[0] ?? feature : feature;
        const target = typeof stored === 'string' && Object.hasOwn(FEATURE_MERGES, stored) ? FEATURE_MERGES[stored] : undefined;
        if (target === null) deadAccess.push(`${projectId} package ${pkg}`);
        if (typeof target === 'string') changed += 1;
        access[pkg] = typeof target === 'string' ? target : stored;
      }
      next.packageAccessFeature = access;
    }
    rows.push({ file, next, changed, warnings, audit, deadAccess });
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
    // A removal names what LEAVES the roles: no group-completeness rule, every old id takes its merged id.
    const next: string[] = [];
    for (const id of renameTwoWordFeatures(entry.features).next) {
      const target = Object.hasOwn(FEATURE_MERGES, id) ? FEATURE_MERGES[id]! : id;
      if (target !== id || (target !== null && next.includes(target))) changed += 1;
      if (target !== null && !next.includes(target)) next.push(target);
    }
    return { ...entry, features: next };
  });
  return changed > 0 ? { file: relative(ctx.home, path), next: { ...record, removals }, changed } : null;
}

type Plan = { projects: ProjectRow[]; removals: RemovalRow };

async function plan(ctx: OfflineUpgradeContext): Promise<Plan> {
  return { projects: await inspectProjects(ctx), removals: await inspectRemovals(ctx) };
}

function asPlan(p: Plan): OfflineUpgradePlan {
  const warnings = p.projects.flatMap((row) => row.warnings);
  const dead = p.projects.flatMap((row) => row.deadAccess);
  return {
    files: [...p.projects.map((row) => row.file), ...(p.removals ? [p.removals.file] : [])],
    summary: [
      `projects: ${p.projects.length} raised to revision ${ROLE_GRANT_REVISION}, ${p.projects.reduce((n, row) => n + row.changed, 0)} feature id(s) merged or dropped`,
      ...p.projects.filter((row) => row.changed > 0).map((row) => `  ${row.file}: ${row.changed}`),
      `builtin grant changes: ${p.removals ? `${p.removals.changed} id(s) in ${p.removals.file}` : 'nothing to merge'}`,
      `partially held rights: ${warnings.length}${warnings.length > 0 ? ' — each one is also written to the audit log (Admin → Logs) when applied' : ''}`,
      ...warnings.map((line) => `  ${line}`),
      ...dead.map((line) => `project ${line}: access feature ${DELETED_FEATURE} no longer exists — the package stays hidden until an owner picks a new one`),
    ],
  };
}

export function createWrittenRoleFeaturesUpgrade(): OfflineUpgradeModule {
  return {
    id: PROJECT_UPGRADE_STEPS.features2.id,
    kinds: [{ kind: HOST_DATA_FORMATS.project.kind, to: PROJECT_UPGRADE_STEPS.features2.to }],
    dryRun: async (ctx) => asPlan(await plan(ctx)),
    async apply(ctx) {
      // Re-read every record: the earlier steps of the chain wrote in between the dry runs and this apply.
      const p = await plan(ctx);
      const appender = new JsonlAppender<AuditRow>();
      const auditFile = containedOrThrow(join(ctx.appRoot, 'logs'), 'audit.jsonl', 'audit log');
      for (const row of p.projects) {
        // The rows land BEFORE the record is replaced: a crash in between repeats a row, never loses one.
        await appender.appendMany(auditFile, row.audit);
        await durableReplaceFile(join(ctx.home, row.file), JSON.stringify(row.next, null, 2));
      }
      if (p.removals) await durableReplaceFile(join(ctx.home, p.removals.file), JSON.stringify(p.removals.next, null, 2));
      for (const line of p.projects.flatMap((row) => row.warnings)) ctx.log(`${PROJECT_UPGRADE_STEPS.features2.id}: ${line}`);
      ctx.log(`${PROJECT_UPGRADE_STEPS.features2.id}: ${p.projects.length} project(s) raised, ${p.projects.reduce((n, row) => n + row.audit.length, 0)} warning(s) audited, ${p.removals ? 1 : 0} grant-change record rewritten`);
    },
  };
}

export default createWrittenRoleFeaturesUpgrade() satisfies OfflineUpgradeModule;
