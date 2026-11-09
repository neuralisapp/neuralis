/**
 * Offline upgrade `source-uri-subject-v1`: a stored path rule that names the
 * built-in owner/admin roles takes the subject by STRENGTH —
 * `roles` ⊆ {owner, admin} becomes `priority: <the weakest one's anchor>` (2
 * when admin is named, 1 for owner alone): the caller's ROLE priority, n or
 * stronger (lower = stronger) — so a
 * project role at the same strength under another name passes it too, the way
 * the manifests now declare it. `brain-core/source-config` v5 → v6; every
 * record is stamped `formatVersion: 6`.
 *
 * Only a GRANT row moves (`override: true`, every declared bit `true`):
 * `priority` is grant-only, so moving a deny row would switch its deny off. A
 * row naming a project's own role, an empty `roles`, or a non-grant row keeps
 * its `roles` byte for byte (the dry run counts the non-grant ones). Nothing
 * else of a record changes. A record at v6 or above is passed through; `apply`
 * re-reads every record, so a second run writes nothing.
 *
 * File name: sorts after `source-to-host-v1.mts` (`u` > `t`), the step before it
 * in the source-config chain. The way back is the checkpoint the command takes.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { durableReplaceFile, type OfflineUpgradeContext, type OfflineUpgradeModule, type OfflineUpgradePlan } from '@neuralis/package-system/data';

/**
 * The kind and the format THIS step writes — pinned, never the live
 * declaration (and no import of the package that declares it: a host script
 * reaches a package's data only as files). `upgrade.test.mts` pins that every
 * shipped step matches a declared one.
 */
const SOURCE_CONFIG_KIND = 'brain-core/source-config';
const STEP_VERSION = 6;

/** The built-in names this step converts and their anchors, pinned as they were when it was written. Migration DATA. */
const CONVERTED_ROLES: Readonly<Record<string, number>> = { owner: 1, admin: 2 };

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** `override: true` and at least one declared bit, every one `true` (the kernel's grant-only rule). */
function isGrantRow(rule: Json): boolean {
  if (rule.override !== true || !isObject(rule.permissions)) return false;
  const bits = (['read', 'write', 'exec'] as const).map((bit) => (rule.permissions as Json)[bit]).filter((bit) => bit !== undefined);
  return bits.length > 0 && bits.every((bit) => bit === true);
}

/** The subject one rule takes: `priority` for a built-in grant row, `null` when it keeps `roles`. */
export function subjectOf(rule: Json): { priority: number } | { keep: 'own-names' | 'not-grant' } | null {
  const roles = rule.roles;
  if (!Array.isArray(roles) || roles.length === 0 || rule.priority !== undefined) return null;
  if (!roles.every((name) => typeof name === 'string' && Object.hasOwn(CONVERTED_ROLES, name))) return { keep: 'own-names' };
  if (!isGrantRow(rule)) return { keep: 'not-grant' };
  return { priority: Math.max(...roles.map((name) => CONVERTED_ROLES[name as string]!)) };
}

export type SourceSubjectRow = { file: string; converted: number; ownNames: number; notGrant: number; next?: Json };

/** The v6 record for one stored config (pure; exported for the unit suite). */
export function subjectRecordOf(record: Json): Omit<SourceSubjectRow, 'file'> {
  if (typeof record.formatVersion === 'number' && record.formatVersion >= STEP_VERSION) return { converted: 0, ownNames: 0, notGrant: 0 };
  const counts = { converted: 0, ownNames: 0, notGrant: 0 };
  const permissions = isObject(record.permissions) ? record.permissions : undefined;
  const paths = Array.isArray(permissions?.paths) ? permissions.paths : undefined;
  const nextPaths = paths?.map((rule: unknown) => {
    if (!isObject(rule)) return rule;
    const subject = subjectOf(rule);
    if (subject === null) return rule;
    if ('keep' in subject) {
      if (subject.keep === 'own-names') counts.ownNames += 1;
      else counts.notGrant += 1;
      return rule;
    }
    counts.converted += 1;
    const { roles: _named, ...rest } = rule;
    return { ...rest, priority: subject.priority };
  });
  const next: Json = {
    ...record,
    ...(permissions && nextPaths ? { permissions: { ...permissions, paths: nextPaths } } : {}),
    formatVersion: STEP_VERSION,
  };
  return { ...counts, next };
}

/** Every source config of the install, classified. Reads only. */
export async function inspectSourceSubjects(ctx: Pick<OfflineUpgradeContext, 'appRoot' | 'home'>): Promise<SourceSubjectRow[]> {
  const base = join(ctx.appRoot, 'config', 'sources');
  let projects: string[];
  try {
    projects = (await readdir(base)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const rows: SourceSubjectRow[] = [];
  for (const projectId of projects) {
    const dir = join(base, projectId);
    if (!(await stat(dir)).isDirectory()) continue;
    for (const name of (await readdir(dir)).filter((entry) => entry.endsWith('.json')).sort()) {
      const path = join(dir, name);
      const record = JSON.parse(await readFile(path, 'utf8')) as unknown;
      if (!isObject(record)) throw new Error(`${path} is not a source config`);
      rows.push({ file: relative(ctx.home, path), ...subjectRecordOf(record) });
    }
  }
  return rows;
}

function summaryOf(rows: readonly SourceSubjectRow[]): OfflineUpgradePlan {
  const sum = (key: 'converted' | 'ownNames' | 'notGrant'): number => rows.reduce((total, row) => total + row[key], 0);
  const writes = rows.filter((row) => row.next).length;
  return {
    files: writes > 0 ? ['app/config/sources'] : [],
    summary: [
      `source configs: ${rows.length} read, ${writes} to rewrite (every record stamped v${STEP_VERSION})`,
      `path rules: ${sum('converted')} owner/admin grant row(s) take priority; kept as named roles: ${sum('ownNames')} naming a project role, ${sum('notGrant')} not a grant row`,
    ],
  };
}

export default {
  id: 'source-uri-subject-v1',
  kinds: [{ kind: SOURCE_CONFIG_KIND, to: STEP_VERSION }],
  async dryRun(ctx) {
    return summaryOf(await inspectSourceSubjects(ctx));
  },
  async apply(ctx) {
    let written = 0;
    for (const row of await inspectSourceSubjects(ctx)) {
      if (!row.next) continue;
      await durableReplaceFile(join(ctx.home, row.file), JSON.stringify(row.next, null, 2));
      written += 1;
    }
    ctx.log(`source-uri-subject-v1: ${written} source config(s) rewritten`);
  },
} satisfies OfflineUpgradeModule;
