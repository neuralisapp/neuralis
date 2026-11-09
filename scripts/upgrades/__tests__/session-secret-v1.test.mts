/**
 * `session-secret-v1` on a throwaway home: the secret an older install kept in
 * its `.env` (`NEXTAUTH_SECRET`, in the process environment the upgrade command
 * loads) is written once into `app/config/session-secret.key`, 0400; a re-run
 * changes nothing; the file always wins; a set-up home with the secret nowhere
 * blocks, and so does a file that disagrees with the environment. Never the
 * live home: every root is a temp dir.
 */

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCheckpoint } from '@neuralis/package-system/data';
import upgrade from '../session-secret-v1.mts';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
afterEach(() => { vi.unstubAllEnvs(); });

type Fixture = { home: string; appRoot: string; projectsRoot: string; log: (line: string) => void; file: string; logs: string[] };

function home(opts: { users?: boolean; file?: string } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'nrs-session-secret-'));
  dirs.push(root);
  const appRoot = join(root, 'app');
  mkdirSync(join(appRoot, 'config'), { recursive: true });
  if (opts.users !== false) {
    mkdirSync(join(appRoot, 'users'), { recursive: true });
    writeFileSync(join(appRoot, 'users', 'u1.json'), '{}');
  }
  const file = join(appRoot, 'config', 'session-secret.key');
  if (opts.file !== undefined) writeFileSync(file, opts.file, { mode: 0o400 });
  const logs: string[] = [];
  return { home: root, appRoot, projectsRoot: join(root, 'projects'), log: (line) => logs.push(line), file, logs };
}

describe('session-secret-v1 — the session secret moves into the data home', () => {
  it('raises the session secret kind to the version the host declares, offline', () => {
    expect(upgrade.id).toBe('session-secret-v1');
    expect(upgrade.kinds).toEqual([{ kind: 'neuralis/session-secret', to: 1 }]);
  });

  it('writes NEXTAUTH_SECRET into the file once, 0400; the dry run names the file and writes nothing; a re-run is a no-op', async () => {
    const f = home();
    vi.stubEnv('NEXTAUTH_SECRET', ' from-the-env-file ');
    const plan = await upgrade.dryRun(f);
    expect(plan.blockers).toBeUndefined();
    expect(plan.files).toEqual(['app/config/session-secret.key']);
    expect(plan.summary[0]).toBe('session secret: NEXTAUTH_SECRET → app/config/session-secret.key (nobody is signed out)');
    // The manual path is named: an older compose file requires the line until it is regenerated.
    expect(plan.summary[1]).toContain('setup --compose-only');
    expect(() => statSync(f.file)).toThrow();

    await upgrade.apply(f);
    expect(readFileSync(f.file, 'utf-8')).toBe('from-the-env-file\n');
    expect(statSync(f.file).mode & 0o777).toBe(0o400);
    const written = statSync(f.file).mtimeMs;

    // Idempotent: the same environment again changes nothing, and names nothing to checkpoint.
    expect((await upgrade.dryRun(f)).files).toEqual([]);
    await upgrade.apply(f);
    expect(readFileSync(f.file, 'utf-8')).toBe('from-the-env-file\n');
    expect(statSync(f.file).mtimeMs).toBe(written);
  });

  it('the file wins: a file holding the secret with no environment value is kept; the paired environment value equal to it passes too', async () => {
    const f = home({ file: 'kept-secret\n' });
    let plan = await upgrade.dryRun(f);
    expect(plan.blockers).toBeUndefined();
    expect(plan.summary).toEqual(['session secret: already in app/config/session-secret.key']);
    vi.stubEnv('NEXTAUTH_SECRET', 'kept-secret');
    plan = await upgrade.dryRun(f);
    expect(plan.blockers).toBeUndefined();
    await upgrade.apply(f);
    expect(readFileSync(f.file, 'utf-8')).toBe('kept-secret\n');
  });

  it('BLOCKS when the file and the environment disagree — and never overwrites the file', async () => {
    const f = home({ file: 'file-secret\n' });
    vi.stubEnv('NEXTAUTH_SECRET', 'env-secret');
    const plan = await upgrade.dryRun(f);
    expect(plan.blockers?.lines).toEqual(["app/config/session-secret.key · holds a different secret than NEXTAUTH_SECRET in the install's .env — the file is never overwritten"]);
    await expect(upgrade.apply(f)).rejects.toThrow(/session-secret-v1: .*holds a different secret/);
    expect(readFileSync(f.file, 'utf-8')).toBe('file-secret\n');
  });

  it('BLOCKS a set-up home whose secret is neither in the file nor in the environment; a home nobody set up passes and writes nothing (paired control)', async () => {
    const f = home();
    vi.stubEnv('NEXTAUTH_SECRET', '');
    const plan = await upgrade.dryRun(f);
    expect(plan.blockers?.lines[0]).toMatch(/^app\/config\/session-secret\.key · missing, and NEXTAUTH_SECRET is not set for this run, while users exist/);
    await expect(upgrade.apply(f)).rejects.toThrow(/session-secret-v1: .*missing/);
    expect(() => statSync(f.file)).toThrow();

    const empty = home({ users: false });
    const fresh = await upgrade.dryRun(empty);
    expect(fresh.blockers).toBeUndefined();
    expect(fresh.files).toEqual([]);
    await upgrade.apply(empty);
    expect(() => statSync(empty.file)).toThrow();
  });

  it('a checkpoint of the file before the apply records it ABSENT — the first offline kind whose file does not exist yet', async () => {
    const f = home();
    const manifest = await createCheckpoint(f.home, { label: 'upgrade-session-secret-v1', files: ['app/config/session-secret.key'] });
    expect(manifest.roots).toEqual([{ path: 'app/config/session-secret.key', present: false }]);
    expect(manifest.files).toEqual([]);
  });
});
