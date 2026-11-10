/**
 * Offline upgrade `source-use-grants-v1`: every agent is private to its
 * creator until a user is attached, and using an agent is reading its record
 * (`data://agent-core/<id>/<id>.json`) through the project's `data` policy.
 *
 * - `brain-core/source-config` v6 → v7: each project's `data` config takes
 *   agent-core's private-agent rows as ONE block, inserted right after its
 *   FIRST agent-folder write row (`data://agent-core/*\/** write priority:2
 *   override`) — never appended: everything stored after that row (the
 *   conversation, workflow, plan and log rows) re-decides its own subtree after
 *   the block, and appended last the block's own-stream grant would re-open
 *   another user's conversations to anyone in that agent's stream. Then one
 *   read row per (agent, user) for every user the install already let use an
 *   agent they did not create — assigned to it (`agentOwnership[id].assignedTo`)
 *   or the author of one of its conversations — who is still a project member,
 *   appended LAST (a later deny would revoke it). Every record is stamped v7.
 * - `agent-core/agent` v2 → v3: a record loses its `visibility`, a stored
 *   empty name becomes its slug, and an MCP key (`config.mcpHosting.apiKeyHash`)
 *   is stamped with its minter — the only one the install knows, the creator.
 *
 * It also removes the legacy `data/agent-core/{git-oauth,mcp-oauth}` folders
 * (the app's and each project's) when empty or holding one `{}`-only file; a
 * folder with content is kept and named. A record at the target version is
 * passed through, so a second run writes nothing. The way back is the
 * checkpoint the command takes; the dry run lists every file it rewrites.
 *
 * File name: sorts after `source-uri-subject-v1.mts` (`use` > `uri`),
 * the step before it in the source-config chain.
 */

import { readdir, readFile, rmdir, stat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import {
  durableReplaceFile,
  durableUnlink,
  syncDirectory,
  type OfflineUpgradeContext,
  type OfflineUpgradeModule,
  type OfflineUpgradePlan,
} from '@neuralis/package-system/data';
import { globToRegExp } from '@neuralis/package-system/policies';
// The step before this one in the source-config chain. A dry run reads the disk before that step
// applied, so a record below its version is read the way that step will have written it.
import { subjectRecordOf } from './source-uri-subject-v1.mts';

/** The kinds and formats THIS step writes — pinned, never the live declarations. */
const SOURCE_CONFIG_KIND = 'brain-core/source-config';
const SOURCE_STEP_VERSION = 7;
const AGENT_KIND = 'agent-core/agent';
const AGENT_STEP_VERSION = 3;

/** agent-core's data zone as a stored `data` config spells it (`<self>` resolved). Migration DATA. */
const ZONE = 'data://agent-core';
const ANCHOR = { pattern: `${ZONE}/*/**`, permissions: { write: true }, override: true, priority: 2 };
/** The private-agent rows, in their contract order (agent-core's manifest declares the same block). */
export const PRIVATE_AGENT_BLOCK: readonly Json[] = [
  { pattern: `${ZONE}/*/**`, permissions: { read: false } },
  { pattern: `${ZONE}/$self/**`, permissions: { read: true }, override: true },
  { pattern: `${ZONE}/*/**`, permissions: { read: true }, override: true, priority: 2 },
  { pattern: `${ZONE}/*/*.json`, permissions: { read: false } },
  { pattern: `${ZONE}/*/*.json`, permissions: { read: true }, users: ['$owner'], override: true },
  { pattern: `${ZONE}/memory/**`, permissions: { read: true }, override: true },
  { pattern: `${ZONE}/connectors/**`, permissions: { read: true }, override: true },
  { pattern: `${ZONE}/rules/**`, permissions: { read: true }, override: true },
  { pattern: `${ZONE}/*/*.json`, permissions: { write: false }, floor: true },
];
const LEGACY_OAUTH_DIRS = ['git-oauth', 'mcp-oauth'] as const;
/** An agent id the attach pattern can carry literally (no glob or token character). */
const LITERAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Key-order-free equality for stored rows. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const sameRow = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

/** The one stored row that lets `userId` use agent `agentId`. */
export function attachRow(agentId: string, userId: string): Json {
  return { pattern: `${ZONE}/${agentId}/${agentId}.json`, permissions: { read: true }, users: [userId], override: true };
}

/** A stored subject-scoped READ grant whose pattern reaches inside an agent folder (the block's first row would clear it). */
function isShadowedGrant(rule: Json): boolean {
  const subject = rule.users !== undefined || rule.roles !== undefined || rule.priority !== undefined;
  if (!subject || rule.override !== true || !isObject(rule.permissions) || rule.permissions.read !== true) return false;
  if (typeof rule.pattern !== 'string') return false;
  const matcher = globToRegExp(rule.pattern.replaceAll('$self', 'probe-agent'));
  return matcher.test(`${ZONE}/probe-agent/probe-agent.json`) || matcher.test(`${ZONE}/probe-agent/files/x`);
}

export type UseGrant = { projectId: string; agentId: string; userId: string; reason: 'assigned' | 'conversations' };
export type DroppedGrant = { projectId: string; agentId: string; userId: string };

/**
 * One project's `data` paths with the block after the first anchor (unless a
 * run already put it there) and the missing attach rows appended last — or the
 * reason it cannot. Pure; exported for the unit suite.
 */
export function grantPathsOf(paths: readonly unknown[], grants: readonly Pick<UseGrant, 'agentId' | 'userId'>[]):
  { paths: unknown[]; blockInserted: boolean; attached: number } | { blocker: string } {
  const at = paths.findIndex((rule) => sameRow(rule, ANCHOR));
  if (at < 0) return { blocker: `no agent-folder write row (${ANCHOR.pattern} write priority:2 override) to place the private-agent rows after` };
  const shadowed = paths.slice(0, at).filter((rule) => isObject(rule) && isShadowedGrant(rule));
  if (shadowed.length > 0) {
    return { blocker: `${shadowed.length} subject-scoped read grant row(s) before the agent-folder write row would be cleared: ${shadowed.map((rule) => (rule as Json).pattern).join(', ')}` };
  }
  const hasBlock = paths.some((_, start) => PRIVATE_AGENT_BLOCK.every((row, offset) => sameRow(paths[start + offset], row)));
  const next = hasBlock ? [...paths] : [...paths.slice(0, at + 1), ...PRIVATE_AGENT_BLOCK.map((row) => structuredClone(row)), ...paths.slice(at + 1)];
  let attached = 0;
  for (const { agentId, userId } of grants) {
    const row = attachRow(agentId, userId);
    if (next.some((rule) => sameRow(rule, row))) continue;
    next.push(row);
    attached += 1;
  }
  return { paths: next, blockInserted: !hasBlock, attached };
}

/** The v3 agent record (pure; exported for the unit suite). `null` = unchanged (already v3). */
export function agentRecordOf(record: Json): { next: Json; visibility: boolean; renamed: boolean; minted: boolean } | { blocker: string } | null {
  if (typeof record.formatVersion === 'number' && record.formatVersion >= AGENT_STEP_VERSION) return null;
  const { visibility, ...next } = record;
  let renamed = false;
  if (typeof next.name === 'string' && next.name.trim() === '') {
    if (typeof next.slug !== 'string' || next.slug.trim() === '') return { blocker: 'empty name and no slug to repair it from' };
    next.name = next.slug;
    renamed = true;
  }
  let minted = false;
  const config = isObject(next.config) ? next.config : undefined;
  const hosting = isObject(config?.mcpHosting) ? config.mcpHosting : undefined;
  if (hosting && typeof hosting.apiKeyHash === 'string' && hosting.apiKeyHash !== '' && hosting.mintedBy === undefined) {
    if (typeof next.userId !== 'string' || next.userId === '') return { blocker: 'an MCP key with no creator to stamp as its minter' };
    next.config = { ...config, mcpHosting: { ...hosting, mintedBy: next.userId } };
    minted = true;
  }
  next.formatVersion = AGENT_STEP_VERSION;
  return { next, visibility: visibility !== undefined, renamed, minted };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}
async function entries(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return [];
    throw error;
  }
}
async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

type AgentRow = { file: string; projectId: string; agentId: string; creator: string | undefined; record: Json };
type SourceRow = { file: string; projectId: string; next?: Json; blockInserted: boolean; attached: number };
type RecordRow = { file: string; next?: Json; visibility: boolean; renamed: boolean; minted: boolean };
type FolderRow = { dir: string; remove: boolean };

export type UseGrantsInspection = {
  sources: SourceRow[];
  records: RecordRow[];
  grants: UseGrant[];
  dropped: DroppedGrant[];
  folders: FolderRow[];
  blockers: string[];
};

/** Every agent of one project: `<projectsRoot>/<p>/data/agent-core/<id>/<id>.json`. */
async function agentsOf(ctx: Pick<OfflineUpgradeContext, 'home' | 'projectsRoot'>, projectId: string, blockers: string[]): Promise<AgentRow[]> {
  const zone = join(ctx.projectsRoot, projectId, 'data', 'agent-core');
  const rows: AgentRow[] = [];
  for (const name of await entries(zone)) {
    const path = join(zone, name, `${name}.json`);
    let record: unknown;
    try {
      record = await readJson(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') continue;
      throw error;
    }
    const file = relative(ctx.home, path);
    if (!isObject(record) || record.id !== name) {
      blockers.push(`${projectId} · ${AGENT_KIND} · ${file} · id · — · not an agent record of that folder`);
      continue;
    }
    if (!LITERAL_ID.test(name)) {
      blockers.push(`${projectId} · ${AGENT_KIND} · ${file} · id · ${name} · not a literal id an attach row can name`);
      continue;
    }
    rows.push({ file, projectId, agentId: name, creator: typeof record.userId === 'string' && record.userId !== '' ? record.userId : undefined, record });
  }
  return rows;
}

/** The distinct authors of an agent's conversations (`conversations/<c>/meta.json` `userId`). */
async function conversationAuthors(ctx: Pick<OfflineUpgradeContext, 'home' | 'projectsRoot'>, agent: AgentRow, blockers: string[]): Promise<Set<string>> {
  const dir = join(ctx.projectsRoot, agent.projectId, 'data', 'agent-core', agent.agentId, 'conversations');
  const authors = new Set<string>();
  for (const name of await entries(dir)) {
    const path = join(dir, name, 'meta.json');
    let meta: unknown;
    try {
      meta = await readJson(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      if (error instanceof SyntaxError) {
        blockers.push(`${agent.projectId} · agent-core/conversation-meta · ${relative(ctx.home, path)} · — · — · unreadable JSON (its author cannot be granted)`);
        continue;
      }
      throw error;
    }
    if (isObject(meta) && typeof meta.userId === 'string' && meta.userId !== '') authors.add(meta.userId);
  }
  return authors;
}

/** A legacy OAuth pending folder is removable when empty or holding exactly one `{}`-only file. */
async function legacyFolder(dir: string): Promise<FolderRow | null> {
  if (!(await isDir(dir))) return null;
  const names = await entries(dir);
  if (names.length === 0) return { dir, remove: true };
  if (names.length !== 1) return { dir, remove: false };
  const path = join(dir, names[0]!);
  if (!(await stat(path)).isFile()) return { dir, remove: false };
  try {
    const value = await readJson(path);
    return { dir, remove: isObject(value) && Object.keys(value).length === 0 };
  } catch (error) {
    if (error instanceof SyntaxError) return { dir, remove: false };
    throw error;
  }
}

/** The whole install, classified. Reads only. */
export async function inspectUseGrants(ctx: Pick<OfflineUpgradeContext, 'appRoot' | 'home' | 'projectsRoot'>): Promise<UseGrantsInspection> {
  const blockers: string[] = [];
  const sourcesBase = join(ctx.appRoot, 'config', 'sources');
  const projectIds = [...new Set([...(await entries(sourcesBase)), ...(await entries(ctx.projectsRoot))])].sort();
  const grants: UseGrant[] = [];
  const dropped: DroppedGrant[] = [];
  const records: RecordRow[] = [];
  const sources: SourceRow[] = [];
  const folders: FolderRow[] = [];

  for (const projectId of projectIds) {
    const project = await readJson(join(ctx.appRoot, 'projects', `${projectId}.json`)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    const members = isObject(project) && isObject(project.members) ? project.members : {};
    const ownership = isObject(project) && isObject(project.agentOwnership) ? project.agentOwnership : {};
    const projectGrants: UseGrant[] = [];
    for (const agent of await agentsOf(ctx, projectId, blockers)) {
      const assigned = isObject(ownership[agent.agentId]) && Array.isArray((ownership[agent.agentId] as Json).assignedTo)
        ? ((ownership[agent.agentId] as Json).assignedTo as unknown[]).filter((id): id is string => typeof id === 'string' && id !== '')
        : [];
      const authors = await conversationAuthors(ctx, agent, blockers);
      for (const userId of [...new Set([...assigned, ...authors])].sort()) {
        if (userId === agent.creator || userId.startsWith('$')) continue;
        if (!Object.hasOwn(members, userId)) {
          dropped.push({ projectId, agentId: agent.agentId, userId });
          continue;
        }
        projectGrants.push({ projectId, agentId: agent.agentId, userId, reason: assigned.includes(userId) ? 'assigned' : 'conversations' });
      }
      const repaired = agentRecordOf(agent.record);
      if (repaired && 'blocker' in repaired) blockers.push(`${projectId} · ${AGENT_KIND} · ${agent.file} · name/config · — · ${repaired.blocker}`);
      else records.push(repaired ? { file: agent.file, ...repaired } : { file: agent.file, visibility: false, renamed: false, minted: false });
    }

    let dataSeen = false;
    for (const name of (await entries(join(sourcesBase, projectId))).filter((entry) => entry.endsWith('.json'))) {
      const path = join(sourcesBase, projectId, name);
      if (!(await stat(path)).isFile()) continue;
      const stored = await readJson(path);
      const file = relative(ctx.home, path);
      if (!isObject(stored)) throw new Error(`${path} is not a source config`);
      const record = subjectRecordOf(stored).next ?? stored;
      const isData = record.source === 'data';
      dataSeen ||= isData;
      if (typeof record.formatVersion === 'number' && record.formatVersion >= SOURCE_STEP_VERSION) {
        sources.push({ file, projectId, blockInserted: false, attached: 0 });
        continue;
      }
      let next: Json = { ...record, formatVersion: SOURCE_STEP_VERSION };
      let blockInserted = false;
      let attached = 0;
      if (isData) {
        const permissions = isObject(record.permissions) ? record.permissions : undefined;
        const outcome = grantPathsOf(Array.isArray(permissions?.paths) ? permissions.paths : [], projectGrants);
        if ('blocker' in outcome) {
          blockers.push(`${projectId} · ${SOURCE_CONFIG_KIND} · ${file} · permissions.paths · — · ${outcome.blocker}`);
          continue;
        }
        ({ blockInserted, attached } = outcome);
        next = { ...next, permissions: { ...permissions, paths: outcome.paths } };
      }
      sources.push({ file, projectId, next, blockInserted, attached });
    }
    if (!dataSeen && projectGrants.length > 0) {
      blockers.push(`${projectId} · ${SOURCE_CONFIG_KIND} · — · — · — · ${projectGrants.length} use grant(s) but no data source config to hold them`);
    }
    grants.push(...projectGrants);
    for (const dir of LEGACY_OAUTH_DIRS) {
      const row = await legacyFolder(join(ctx.projectsRoot, projectId, 'data', 'agent-core', dir));
      if (row) folders.push(row);
    }
  }
  for (const dir of LEGACY_OAUTH_DIRS) {
    const row = await legacyFolder(join(ctx.appRoot, 'data', 'agent-core', dir));
    if (row) folders.push(row);
  }
  return { sources, records, grants, dropped, folders, blockers };
}

/** The dry run's plan: every file the apply rewrites or removes, the grants by name, and the blockers. */
export function planOf(home: string, found: UseGrantsInspection): OfflineUpgradePlan {
  const sourceWrites = found.sources.filter((row) => row.next);
  const recordWrites = found.records.filter((row) => row.next);
  const removed = found.folders.filter((row) => row.remove);
  const kept = found.folders.filter((row) => !row.remove);
  const count = (key: 'visibility' | 'renamed' | 'minted'): number => recordWrites.filter((row) => row[key]).length;
  return {
    files: [...sourceWrites.map((row) => row.file), ...recordWrites.map((row) => row.file), ...removed.map((row) => relative(home, row.dir))],
    summary: [
      `source configs: ${found.sources.length} read, ${sourceWrites.length} to rewrite (every record stamped v${SOURCE_STEP_VERSION}); ${sourceWrites.filter((row) => row.blockInserted).length} data config(s) take the private-agent rows after their agent-folder write row`,
      `use grants: ${found.grants.length} read row(s) on an agent record, appended last — a user assigned to, or holding a conversation with, an agent they did not create:`,
      ...found.grants.map((grant) => `  ${grant.projectId} · ${grant.agentId} → ${grant.userId} (${grant.reason})`),
      ...(found.dropped.length > 0
        ? [`not granted (no longer a project member): ${found.dropped.length}`, ...found.dropped.map((row) => `  ${row.projectId} · ${row.agentId} ← ${row.userId}`)]
        : []),
      `agent records: ${found.records.length} read, ${recordWrites.length} to rewrite (stamped v${AGENT_STEP_VERSION}): ${count('visibility')} lose visibility, ${count('renamed')} empty name → slug, ${count('minted')} MCP key minter stamped`,
      ...recordWrites.filter((row) => row.renamed).map((row) => `  name repaired: ${row.file}`),
      `legacy OAuth pending folders: ${removed.length} removed, ${kept.length} kept${kept.length > 0 ? ` (hold content: ${kept.map((row) => relative(home, row.dir)).join(', ')})` : ''}`,
    ],
    ...(found.blockers.length > 0
      ? { blockers: { lines: found.blockers, remedy: 'add the listed agent-folder write row back to the listed data config, move a listed grant row after it, name the listed agent, or fix the listed file — then run this again' } }
      : {}),
  };
}

export default {
  id: 'source-use-grants-v1',
  kinds: [{ kind: SOURCE_CONFIG_KIND, to: SOURCE_STEP_VERSION }, { kind: AGENT_KIND, to: AGENT_STEP_VERSION }],
  async dryRun(ctx) {
    return planOf(ctx.home, await inspectUseGrants(ctx));
  },
  async apply(ctx) {
    const found = await inspectUseGrants(ctx);
    if (found.blockers.length > 0) throw new Error(`source-use-grants-v1: ${found.blockers.length} blocking item(s); run the dry run`);
    let written = 0;
    for (const row of [...found.sources, ...found.records]) {
      if (!row.next) continue;
      await durableReplaceFile(join(ctx.home, row.file), JSON.stringify(row.next, null, 2));
      written += 1;
    }
    let removed = 0;
    for (const row of found.folders.filter((folder) => folder.remove)) {
      for (const name of await entries(row.dir)) await durableUnlink(join(row.dir, name));
      await rmdir(row.dir);
      await syncDirectory(dirname(row.dir));
      removed += 1;
    }
    ctx.log(`source-use-grants-v1: ${written} file(s) rewritten (${found.grants.length} use grant(s)), ${removed} legacy OAuth folder(s) removed`);
  },
} satisfies OfflineUpgradeModule;
