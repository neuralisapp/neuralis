/**
 * `source-use-grants-v1` as the operator command loads it: discovered after
 * the v6 step, raising source-config to v7 and the agent record to v3. Never
 * the live home: every root is a temp dir.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateUriPolicy } from '@neuralis/package-system/policies';
import type { ConnectorHierarchicalPermissions } from '@neuralis/package-system/contracts';
import { loadUpgradeModules, UPGRADES_DIR } from '../../upgrade.mts';
import { attachRow, grantPathsOf, PRIVATE_AGENT_BLOCK } from '../source-use-grants-v1.mts';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const OWNER = 'u-owner';
const MEMBER = 'u-member';
const OTHER = 'u-other';
const GONE = 'u-gone';
const ZONE = 'data://agent-core';
const ANCHOR = { pattern: `${ZONE}/*/**`, permissions: { write: true }, override: true, priority: 2 };
/** The stored `data` rows before the anchor and the first rows after it, as a v6 install holds them. */
const BEFORE = [
  { pattern: `${ZONE}/**`, permissions: { read: true, write: true, exec: false } },
  { pattern: `${ZONE}/*/**`, permissions: { write: false } },
  { pattern: `${ZONE}/$self/**`, permissions: { write: true }, override: true },
  ANCHOR,
];
const AFTER = [
  { pattern: `${ZONE}/*/conversations/**`, permissions: { read: false } },
  { pattern: `${ZONE}/$self/conversations/**`, permissions: { read: true }, users: ['$owner'], override: true },
  { pattern: `${ZONE}/*/conversations/**`, permissions: { read: true }, override: true, priority: 2 },
];

function write(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}
const json = (path: string): any => JSON.parse(readFileSync(path, 'utf8'));

/** The read bit a member (priority 3) gets on `uri` inside `agentId`'s stream. */
function reads(paths: unknown[], uri: string, userId: string, agentId: string, resourceOwnerUserId: string): boolean {
  const config = { default: { read: true, write: true, exec: false }, paths } as ConnectorHierarchicalPermissions;
  return evaluateUriPolicy(config, uri, { userId, role: 'member', agentId, priority: 3, rolePriorities: undefined, source: 'data', resourceOwnerUserId }).read;
}

describe('source-use-grants-v1 — private agents on the stored data policy', { timeout: 60_000 }, () => {
  it('sorts after source-uri-subject-v1 and raises source-config to v7 and the agent record to v3', async () => {
    const modules = await loadUpgradeModules(UPGRADES_DIR);
    const files = modules.map(({ file }) => file);
    expect(files.indexOf('source-use-grants-v1.mts')).toBeGreaterThan(files.indexOf('source-uri-subject-v1.mts'));
    expect(modules.find(({ file }) => file === 'source-use-grants-v1.mts')!.module.kinds)
      .toEqual([{ kind: 'brain-core/source-config', to: 7 }, { kind: 'agent-core/agent', to: 3 }]);
  });

  it('stores the block row for row as agent-core\'s manifest declares it, right after the manifest\'s agent-folder write row', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../packages/agent-core/package.json'), 'utf8'));
    const rows = (manifest.neuralis.uriPolicies['data://<self>/**'].paths as unknown[])
      .map((row) => JSON.parse(JSON.stringify(row).replaceAll('data://<self>/', `${ZONE}/`)));
    const at = rows.findIndex((row) => JSON.stringify(Object.entries(row).sort()) === JSON.stringify(Object.entries(ANCHOR).sort()));
    expect(at).toBeGreaterThanOrEqual(0);
    const key = (row: unknown) => JSON.stringify(row, Object.keys(row as object).concat('read', 'write', 'exec').sort());
    expect(rows.slice(at + 1, at + 1 + PRIVATE_AGENT_BLOCK.length).map(key)).toEqual(PRIVATE_AGENT_BLOCK.map(key));
  });

  it('places the block after the FIRST anchor — appended last it would open another user\'s conversation in the agent\'s stream', () => {
    const stored = [...BEFORE, ...AFTER, ANCHOR];
    const out = grantPathsOf(stored, [{ agentId: 'x', userId: MEMBER }]);
    if ('blocker' in out) throw new Error(out.blocker);
    expect(out.paths).toEqual([...BEFORE, ...PRIVATE_AGENT_BLOCK, ...AFTER, ANCHOR, attachRow('x', MEMBER)]);
    const conversation = `${ZONE}/x/conversations/c-owner/messages.jsonl`;
    expect(reads(out.paths, conversation, MEMBER, 'x', OWNER)).toBe(false);
    // The rejected shape: the same rows with the block appended at the end.
    const appended = [...stored, ...PRIVATE_AGENT_BLOCK, attachRow('x', MEMBER)];
    expect(reads(appended, conversation, MEMBER, 'x', OWNER)).toBe(true);
    // The record's read bit is the use verdict: attached yes, an unattached member no, the creator yes.
    expect(reads(out.paths, `${ZONE}/x/x.json`, MEMBER, 'x', OWNER)).toBe(true);
    expect(reads(out.paths, `${ZONE}/x/x.json`, OTHER, 'x', OWNER)).toBe(false);
    expect(reads(out.paths, `${ZONE}/x/x.json`, OWNER, 'x', OWNER)).toBe(true);
    // The shared folders the block restores stay member-readable from any agent's stream.
    for (const shared of ['rules/x.md', 'connectors/c.json', 'memory/m.md']) expect(reads(out.paths, `${ZONE}/${shared}`, OTHER, 'y', OWNER)).toBe(true);
    // An attach row before the block's deny would not hold (the order is the contract).
    expect(reads([...BEFORE.slice(0, 1), attachRow('x', MEMBER), ...BEFORE.slice(1), ...PRIVATE_AGENT_BLOCK], `${ZONE}/x/x.json`, MEMBER, 'x', OWNER)).toBe(false);
  });

  it('blocks a config without the anchor and one whose subject grant precedes it; an existing block is not inserted twice', () => {
    expect(grantPathsOf(AFTER, [])).toEqual({ blocker: expect.stringMatching(/no agent-folder write row/) });
    const early = { pattern: `${ZONE}/*/files/**`, permissions: { read: true }, users: [MEMBER], override: true };
    expect(grantPathsOf([early, ...BEFORE], [])).toEqual({ blocker: expect.stringMatching(/1 subject-scoped read grant row/) });
    // A grant outside the agent folders, or without a subject, does not block.
    const shared = { pattern: `${ZONE}/codex-usage.json`, permissions: { read: true }, users: [MEMBER], override: true };
    expect(grantPathsOf([shared, ...BEFORE], [])).not.toHaveProperty('blocker');
    const once = [...BEFORE, ...PRIVATE_AGENT_BLOCK, ...AFTER, attachRow('x', MEMBER)];
    expect(grantPathsOf(once, [{ agentId: 'x', userId: MEMBER }])).toEqual({ paths: once, blockInserted: false, attached: 0 });
  });

  it('dry-runs a stopped install, applies exactly the expected rows and records, and writes nothing the second time', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nrs-source-use-grants-'));
    dirs.push(home);
    const appRoot = join(home, 'app');
    const projectsRoot = join(home, 'projects');
    const sources = join(appRoot, 'config', 'sources', 'p1');
    const zone = join(projectsRoot, 'p1', 'data', 'agent-core');
    write(join(appRoot, 'projects', 'p1.json'), {
      id: 'p1',
      members: { [OWNER]: { userId: OWNER, role: 'owner' }, [MEMBER]: { userId: MEMBER, role: 'member' }, [OTHER]: { userId: OTHER, role: 'member' } },
      agentOwnership: { x: { createdBy: OWNER, assignedTo: [MEMBER] } },
    });
    const source = (name: string, paths: unknown[]) => ({
      source: name, scope: { kind: 'project' }, connection: { kind: 'host', config: { root: '/x' } },
      permissions: { default: { read: true, write: true, exec: false }, paths }, createdBy: OWNER, formatVersion: 6,
    });
    write(join(sources, 'data.json'), source('data', [...BEFORE, ...AFTER]));
    write(join(sources, 'brain.json'), source('brain', []));
    const agent = (id: string, userId: string, extra: Record<string, unknown> = {}) =>
      write(join(zone, id, `${id}.json`), { id, projectId: 'p1', userId, name: id.toUpperCase(), slug: id, visibility: 'private', config: {}, formatVersion: 2, ...extra });
    agent('x', OWNER, { name: ' ' });
    agent('y', MEMBER);
    agent('z', OWNER, { config: { mcpHosting: { enabled: true, apiKeyHash: 'h' } } });
    const meta = (id: string, conversation: string, userId: string) => write(join(zone, id, 'conversations', conversation, 'meta.json'), { id: conversation, userId, agentId: id });
    meta('x', 'c1', MEMBER);
    meta('y', 'c1', OWNER); // a conversation with an agent its author did not create → granted
    meta('y', 'c2', OWNER);
    meta('y', 'c3', MEMBER); // the creator's own → nothing
    meta('y', 'c4', GONE); // no longer a member → nothing
    mkdirSync(join(zone, 'z', 'conversations', 'c1'), { recursive: true }); // no meta yet → nothing
    write(join(zone, 'memory', 'notes.md'), 'shared'); // a shared folder, not an agent
    write(join(zone, 'git-oauth', 'git-oauth-pending.json'), '{}');
    write(join(zone, 'mcp-oauth', 'mcp-oauth-pending.json'), '{"state":{"a":1}}');
    mkdirSync(join(appRoot, 'data', 'agent-core', 'git-oauth'), { recursive: true });

    const { module } = (await loadUpgradeModules(UPGRADES_DIR)).find(({ file }) => file === 'source-use-grants-v1.mts')!;
    const ctx = { home, appRoot, projectsRoot, log: () => undefined };
    const before = readFileSync(join(sources, 'data.json'), 'utf8');
    const plan = await module.dryRun(ctx);
    expect(plan.blockers).toBeUndefined();
    expect(plan.files).toEqual([
      'app/config/sources/p1/brain.json', 'app/config/sources/p1/data.json',
      'projects/p1/data/agent-core/x/x.json', 'projects/p1/data/agent-core/y/y.json', 'projects/p1/data/agent-core/z/z.json',
      'projects/p1/data/agent-core/git-oauth', 'app/data/agent-core/git-oauth',
    ]);
    expect(plan.summary).toEqual([
      'source configs: 2 read, 2 to rewrite (every record stamped v7); 1 data config(s) take the private-agent rows after their agent-folder write row',
      'use grants: 2 read row(s) on an agent record, appended last — a user assigned to, or holding a conversation with, an agent they did not create:',
      `  p1 · x → ${MEMBER} (assigned)`,
      `  p1 · y → ${OWNER} (conversations)`,
      'not granted (no longer a project member): 1',
      `  p1 · y ← ${GONE}`,
      'agent records: 3 read, 3 to rewrite (stamped v3): 3 lose visibility, 1 empty name → slug, 1 MCP key minter stamped',
      '  name repaired: projects/p1/data/agent-core/x/x.json',
      'legacy OAuth pending folders: 2 removed, 1 kept (hold content: projects/p1/data/agent-core/mcp-oauth)',
    ]);
    expect(readFileSync(join(sources, 'data.json'), 'utf8')).toBe(before);

    await module.apply(ctx);
    const data = json(join(sources, 'data.json'));
    expect(data.formatVersion).toBe(7);
    expect(data.permissions.paths).toEqual([...BEFORE, ...PRIVATE_AGENT_BLOCK, ...AFTER, attachRow('x', MEMBER), attachRow('y', OWNER)]);
    expect(JSON.stringify(data)).not.toContain(GONE);
    expect(json(join(sources, 'brain.json'))).toEqual({ ...source('brain', []), formatVersion: 7 });
    const x = json(join(zone, 'x', 'x.json'));
    expect(x).not.toHaveProperty('visibility');
    expect([x.name, x.formatVersion]).toEqual(['x', 3]);
    expect(json(join(zone, 'y', 'y.json')).name).toBe('Y');
    expect(json(join(zone, 'z', 'z.json')).config.mcpHosting).toEqual({ enabled: true, apiKeyHash: 'h', mintedBy: OWNER });
    expect(existsSync(join(zone, 'git-oauth'))).toBe(false);
    expect(existsSync(join(appRoot, 'data', 'agent-core', 'git-oauth'))).toBe(false);
    expect(readFileSync(join(zone, 'mcp-oauth', 'mcp-oauth-pending.json'), 'utf8')).toBe('{"state":{"a":1}}');

    // Idempotent: the second run finds every record at its target and writes nothing.
    expect((await module.dryRun(ctx)).files).toEqual([]);
    const watched = [join(sources, 'data.json'), join(sources, 'brain.json'), join(zone, 'x', 'x.json'), join(zone, 'z', 'z.json')];
    const inodes = watched.map((path) => statSync(path).ino);
    await module.apply(ctx);
    expect(watched.map((path) => statSync(path).ino)).toEqual(inodes);
  });

  it('names a config without the anchor as a blocker and the apply refuses before writing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nrs-source-use-grants-block-'));
    dirs.push(home);
    const appRoot = join(home, 'app');
    const path = join(appRoot, 'config', 'sources', 'p1', 'data.json');
    write(path, { source: 'data', permissions: { default: { read: true, write: true, exec: false }, paths: AFTER }, formatVersion: 6 });
    const before = readFileSync(path, 'utf8');
    const { module } = (await loadUpgradeModules(UPGRADES_DIR)).find(({ file }) => file === 'source-use-grants-v1.mts')!;
    const ctx = { home, appRoot, projectsRoot: join(home, 'projects'), log: () => undefined };
    expect((await module.dryRun(ctx)).blockers?.lines).toEqual([expect.stringMatching(/^p1 · brain-core\/source-config · app\/config\/sources\/p1\/data.json · permissions.paths · — · no agent-folder write row/)]);
    await expect(module.apply(ctx)).rejects.toThrow(/1 blocking item/);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});
