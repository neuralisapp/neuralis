/**
 * `stored-device-codes-v1` as the operator command loads it: discovered after
 * `source-to-host-v1` (the step before it in the conversation-messages chain),
 * raising `agent-core/conversation-messages` to v3. Never the live home: every
 * root is a temp dir.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { loadUpgradeModules, UPGRADES_DIR } from '../../upgrade.mts';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

describe('stored-device-codes-v1 — the host module', { timeout: 60_000 }, () => {
  it('sorts after source-to-host-v1 and raises conversation-messages to v3', async () => {
    const modules = await loadUpgradeModules(UPGRADES_DIR);
    const files = modules.map(({ file }) => file);
    expect(files.indexOf('stored-device-codes-v1.mts')).toBeGreaterThan(files.indexOf('source-to-host-v1.mts'));
    expect(modules.find(({ file }) => file === 'stored-device-codes-v1.mts')!.module.kinds).toEqual([
      { kind: 'agent-core/conversation-messages', to: 3 },
    ]);
  });

  it('dry-runs a stopped install naming the log, applies the stored code once, and writes nothing the second time', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nrs-device-codes-host-'));
    dirs.push(home);
    const projectsRoot = join(home, 'projects');
    const conv = join(projectsRoot, 'main', 'data', 'agent-core', 'alice', 'conversations', 'c1');
    mkdirSync(conv, { recursive: true });
    const log = join(conv, 'messages.jsonl');
    // A stored refusal code, and the same code QUOTED inside text (history: it stays).
    writeFileSync(log, '{"structuredContent":{"code":"host_plane_denied"}}\n{"text":"it said \\"code\\":\\"host_plane_denied\\" earlier"}\n');
    const { module } = (await loadUpgradeModules(UPGRADES_DIR)).find(({ file }) => file === 'stored-device-codes-v1.mts')!;
    const ctx = { home, appRoot: join(home, 'app'), projectsRoot, log: () => undefined };
    const plan = await module.dryRun(ctx);
    expect(plan.files).toEqual([relative(home, log)]);
    expect(plan.summary?.join('\n')).toContain('1 to rewrite (1 stored code(s)');
    expect(readFileSync(log, 'utf8')).toContain('"code":"host_plane_denied"}}');
    await module.apply(ctx);
    expect(readFileSync(log, 'utf8')).toBe('{"structuredContent":{"code":"device_denied"}}\n{"text":"it said \\"code\\":\\"host_plane_denied\\" earlier"}\n');
    expect((await module.dryRun(ctx)).files).toEqual([]);
  });
});
