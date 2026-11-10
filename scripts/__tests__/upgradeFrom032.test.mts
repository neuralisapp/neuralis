/**
 * The whole shipped chain over a 0.3.2 data home: the published 0.3.2 image
 * wrote it through its own API (an owner, a member, a removed member, a shared
 * and a private agent, conversations, workflows, a local source, path rules),
 * and the shapes a paired device leaves (a device source, stored messages and
 * background shells in their 0.3.2 vocabulary, legacy OAuth folders) were added
 * by hand. Its keys, logs and password hashes are left out.
 *
 * The dry run of every module reads the disk BEFORE the earlier modules
 * applied, so this pins the two ways that went wrong in 0.4.0: a step that
 * blocked on a row an earlier step would have rewritten, and a checkpoint
 * that copied one file twice because one step lists a folder and another a
 * file inside it.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pendingUpgrades, runUpgrade, UPGRADES_DIR } from '../upgrade.mts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'home-0.3.2');
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

/** Every file under `root` with its bytes, keyed by its `/`-joined relative path. */
function snapshot(root: string, skip: (rel: string) => boolean): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const rel = relative(root, abs).split('\\').join('/');
      if (skip(rel)) continue;
      if (statSync(abs).isDirectory()) walk(abs);
      else out.set(rel, readFileSync(abs, 'utf8'));
    }
  };
  walk(root);
  return out;
}

describe('upgrading a real 0.3.2 home through every shipped module', { timeout: 120_000 }, () => {
  it('dry-runs without a blocker, applies once, every write lies under the checkpoint, and a second run writes nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nrs-upgrade-032-'));
    dirs.push(home);
    cpSync(FIXTURE, home, { recursive: true });
    const roots = { home, appRoot: join(home, 'app'), projectsRoot: join(home, 'projects') };
    const saved = process.env.NEXTAUTH_SECRET;
    process.env.NEXTAUTH_SECRET = 'fixture-session-secret-0-3-2';
    try {
      const run = async (apply: boolean): Promise<{ logs: string[]; outcome: Awaited<ReturnType<typeof runUpgrade>> }> => {
        const logs: string[] = [];
        const outcome = await runUpgrade({ apply, modulesDir: UPGRADES_DIR, roots, offline: async () => ({ offline: true }), log: (line) => logs.push(line), appRuns: 'docker' });
        return { logs, outcome };
      };

      const before = snapshot(home, () => false);
      const dry = await run(false);
      expect(dry.logs.join('\n')).not.toContain('Blocking');
      expect(snapshot(home, () => false)).toEqual(before);

      const applied = await run(true);
      expect(applied.outcome).toMatchObject({ applied: true, checkpoint: expect.any(String) });
      expect(await pendingUpgrades(UPGRADES_DIR, roots.appRoot)).toEqual([]);

      // The way back covers every file the chain wrote or removed (the ledger is the command's own).
      const manifest = JSON.parse(readFileSync(join(home, 'checkpoints', applied.outcome.checkpoint!, 'manifest.json'), 'utf8')) as { roots: { path: string }[]; files: { path: string }[] };
      expect(new Set(manifest.files.map((file) => file.path)).size).toBe(manifest.files.length);
      const after = snapshot(home, (rel) => rel === 'checkpoints');
      const touched = [...new Set([...before.keys(), ...after.keys()])].filter((rel) => before.get(rel) !== after.get(rel) && rel !== 'app/config/data-formats.json');
      expect(touched.length).toBeGreaterThan(0);
      const uncovered = touched.filter((rel) => !manifest.roots.some((root) => rel === root.path || rel.startsWith(`${root.path}/`)));
      expect(uncovered).toEqual([]);

      // The agent-folder write row the use-grants step anchors on is the one the subject step converted.
      const data = JSON.parse(readFileSync(join(roots.appRoot, 'config', 'sources', 'my-workspace', 'data.json'), 'utf8')) as { formatVersion: number; permissions: { paths: Record<string, unknown>[] } };
      expect(data.formatVersion).toBeGreaterThanOrEqual(7);
      expect(data.permissions.paths.filter((rule) => rule.roles !== undefined && (rule.roles as string[]).every((name) => name === 'owner' || name === 'admin'))).toEqual([]);

      const settled = snapshot(home, () => false);
      const again = await run(true);
      expect(again.outcome).toMatchObject({ applied: false });
      expect(snapshot(home, () => false)).toEqual(settled);
    } finally {
      if (saved === undefined) delete process.env.NEXTAUTH_SECRET;
      else process.env.NEXTAUTH_SECRET = saved;
    }
  });
});
