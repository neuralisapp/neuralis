/**
 * `neuralis:user` — the break-glass CLI, run for real (`node --import tsx`,
 * exactly the package.json script) against a throwaway NEURALIS_HOME. A
 * mutation needs the address typed again; it writes through the same lifecycle
 * body the admin routes use, so a reset bumps the session epoch and every
 * mutation lands one audit row naming the operator.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hostRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const homes: string[] = [];
let home = '';

function seed(id: string, over: Record<string, unknown>): void {
  writeFileSync(
    join(home, 'app', 'users', `${id}.json`),
    JSON.stringify({
      id, email: `${id}@x.co`, name: id.toUpperCase(), passwordHash: 'h', status: 'active', mustChangePassword: false,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over,
    }),
  );
}

function record(id: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, 'app', 'users', `${id}.json`), 'utf-8')) as Record<string, unknown>;
}

function audit(): Array<Record<string, unknown>> {
  const path = join(home, 'app', 'logs', 'audit.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

function run(args: string[], input = ''): { status: number | null; out: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/user.mts', ...args], {
    cwd: hostRoot,
    input,
    encoding: 'utf-8',
    env: { ...process.env, NEURALIS_HOME: home, NEXTAUTH_SECRET: 'test-secret' },
    timeout: 60_000,
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'nrs-user-cli-'));
  homes.push(home);
  for (const dir of ['users', 'logs', 'config']) mkdirSync(join(home, 'app', dir), { recursive: true });
  seed('off', { status: 'disabled', sessionEpoch: 3, disabledAt: '2026-02-01T00:00:00.000Z', disabledBy: 'x' });
  seed('on', { sessionEpoch: 1 });
  seed('gone', { status: 'deleted', email: 'deleted:gone', deletedEmail: 'gone@x.co' });
});

afterAll(() => {
  for (const dir of homes) rmSync(dir, { recursive: true, force: true });
});

describe('neuralis:user', () => {
  it('list shows the live users and only COUNTS tombstones', () => {
    const { status, out } = run(['list']);
    expect(status).toBe(0);
    expect(out).toContain('off@x.co');
    expect(out).toContain('on@x.co');
    expect(out).not.toContain('gone');
    expect(out).toContain('2 user(s); 1 deleted record(s) not shown.');
  }, 60_000);

  it('enable with the address typed again: active, no epoch bump, one audit row naming the operator', () => {
    const { status } = run(['enable', 'off@x.co'], 'OFF@x.co\n');
    expect(status).toBe(0);
    const after = record('off');
    expect(after.status).toBe('active');
    expect(after.sessionEpoch).toBe(3);
    expect(after.disabledAt).toBeUndefined();
    const rows = audit();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'user.enable', userId: null, target: 'off', details: { via: 'cli' } });
    expect(typeof (rows[0]!.details as Record<string, unknown>).operator).toBe('string');
  }, 60_000);

  it('paired control: a wrong confirmation changes nothing and audits nothing', () => {
    const { status, out } = run(['enable', 'off@x.co'], 'on@x.co\n');
    expect(status).toBe(1);
    expect(out).toContain('Not confirmed');
    expect(out).not.toContain('docker compose restart');
    expect(record('off').status).toBe('disabled');
    expect(audit()).toEqual([]);
  }, 60_000);

  it('reset-password bumps the epoch, forces a change and prints the temporary password once', () => {
    const { status, out } = run(['reset-password', 'on@x.co'], 'on@x.co\n');
    expect(status).toBe(0);
    const after = record('on');
    expect(after).toMatchObject({ sessionEpoch: 2, mustChangePassword: true, status: 'active' });
    expect(after.passwordHash).not.toBe('h');
    expect(out).toMatch(/Temporary password for on@x\.co/);
    // The server's in-process revocation never hears this process: the named residual is printed.
    expect(out).toContain('`docker compose restart neuralis` in the host folder');
    expect(out).toContain('MCP client tokens issued before the reset are refused');
    expect(audit()[0]).toMatchObject({ action: 'user.password_reset', target: 'on' });
  }, 60_000);

  it('a tombstone is not addressable by its old email', () => {
    const { status, out } = run(['reset-password', 'gone@x.co'], 'gone@x.co\n');
    expect(status).toBe(1);
    expect(out).toContain('No user with email gone@x.co');
    expect(record('gone').passwordHash).toBe('h');
  }, 60_000);

  it('an unknown command prints the usage and fails', () => {
    const { status, out } = run(['disable', 'on@x.co']);
    expect(status).toBe(1);
    expect(out).toContain('pnpm neuralis:user reset-password <email>');
    expect(record('on').status).toBe('active');
  }, 60_000);
});
