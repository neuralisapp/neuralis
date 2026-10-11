/**
 * `neuralis convert` — the destructive half of the one-shot move of a 0.1.0
 * install folder to the npm layout. The scaffolder half (`create-neuralis
 * convert`) has already written the new `package.json` and the record; this
 * half must delete EXACTLY the old tarball's entries, behind a checkpoint, only
 * with the app stopped, and be both resumable and reversible.
 *
 * Hermetic: a mkdtemp folder, NEURALIS_HOME in the sandbox, the app port
 * pointed at a listener the test owns (or at nothing), a fake `docker` on PATH.
 */

import { createServer, type Server } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCheckpoint } from '@neuralis/package-system/data';
import { deleteEntries, run, unitServesFolder } from '../convert.mts';
import type { CliContext } from '../cli/registry.mts';

const OLD_MANIFEST = `${JSON.stringify({ name: 'neuralis', version: '0.1.0', dependencies: { '@acme/ops': 'file:/srv/ops' } }, null, 2)}\n`;
// The two catch-all route files are the shape the real 0.1.0 tarball ships (7 such files):
// a `..` inside a segment, which the kernel checkpoint's traversal floor refuses as an entry.
const ENTRIES = ['package.json', 'README.md', 'scripts/update.mts', 'scripts/setup/detect.mts', 'src/a.ts', 'src/app/api/packages/[...path]/route.ts', 'src/app/api/package-app/%5Fpub/[token]/[...path]/route.ts', 'Dockerfile'];

let sandbox = '';
let stoppedPort = '';
const saved: Record<string, string | undefined> = {};

function setEnv(key: string, value: string): void {
  if (!(key in saved)) saved[key] = process.env[key];
  process.env[key] = value;
}

/** A port nothing listens on: bound once, then released (fetch refuses the well-known low ports outright). */
async function freePort(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return String(port);
}

beforeEach(async () => {
  stoppedPort = await freePort();
  sandbox = mkdtempSync(join(tmpdir(), 'neuralis-convert-'));
  const bin = join(sandbox, 'bin');
  mkdirSync(bin);
  // `docker compose ps` answers "no services running" — a stopped stack.
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'docker'), 0o755);
  setEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
  setEnv('NEURALIS_HOME', join(sandbox, 'home'));
  setEnv('XDG_CONFIG_HOME', join(sandbox, 'config'));
  setEnv('NEURALIS_APP_PORT', stoppedPort);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete saved[key];
  }
});

/** A folder the scaffolder half just wrote: new manifest, the record, and every old entry still there. */
function halfConverted(): string {
  const dir = join(sandbox, 'site');
  for (const entry of ENTRIES.filter((e) => e !== 'package.json')) {
    mkdirSync(join(dir, entry, '..'), { recursive: true });
    writeFileSync(join(dir, entry), `0.1.0 ${entry}\n`);
  }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ private: true, dependencies: { '@acme/ops': 'file:/srv/ops', neuralis: '0.2.0' } }, null, 2)}\n`);
  writeFileSync(join(dir, '.env'), 'NEURALIS_CONVERT_TEST_KEEP=1\n');
  writeFileSync(join(dir, 'docker-compose.override.yml'), 'services: {}\n');
  writeFileSync(join(dir, 'scripts', 'my-own.sh'), 'echo operator\n');
  mkdirSync(join(dir, '.neuralis-convert'));
  writeFileSync(join(dir, '.neuralis-convert', 'package.json'), OLD_MANIFEST);
  writeFileSync(join(dir, '.neuralis-convert', 'package-lock.json'), '{"lockfileVersion":3}\n');
  writeFileSync(join(dir, '.neuralis-convert', 'from.json'), JSON.stringify({ from: '0.1.0', to: '0.2.0', entries: ENTRIES }));
  return dir;
}

function ctx(dir: string): CliContext {
  return { packageDir: join(dir, 'node_modules', 'neuralis'), installDir: dir, cwd: dir, env: process.env, stdin: process.stdin, stdout: () => {}, stderr: () => {} };
}

describe('neuralis convert --from', () => {
  it('deletes exactly the old entries — catch-all route files included — behind one checkpoint and keeps everything the listing does not name', async () => {
    const dir = halfConverted();
    expect(await run(['--from', '0.1.0'], ctx(dir))).toBe(0);
    for (const entry of ENTRIES.filter((e) => e !== 'package.json')) expect(existsSync(join(dir, entry)), entry).toBe(false);
    expect(existsSync(join(dir, 'src'))).toBe(false); // left empty → removed
    expect(readFileSync(join(dir, 'scripts', 'my-own.sh'), 'utf8')).toBe('echo operator\n'); // not in the listing → kept, with its folder
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('NEURALIS_CONVERT_TEST_KEEP=1\n');
    expect(existsSync(join(dir, 'docker-compose.override.yml'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies.neuralis).toBe('0.2.0');
    expect(existsSync(join(dir, '.neuralis-convert'))).toBe(false);
    const [checkpoint] = readdirSync(join(dir, 'checkpoints'));
    expect(checkpoint).toMatch(/convert-from-0\.1\.0$/);
    // The checkpoint holds the record; the old tree rides in its archive, by name.
    expect(readdirSync(join(dir, 'checkpoints', checkpoint!)).sort()).toEqual(['.neuralis-convert', 'manifest.json']);
    expect(readFileSync(join(dir, 'checkpoints', checkpoint!, '.neuralis-convert', 'package.json'), 'utf8')).toBe(OLD_MANIFEST);
    const listed = execFileSync('tar', ['-tzf', join(dir, 'checkpoints', checkpoint!, '.neuralis-convert', 'tree.tgz')], { encoding: 'utf8' }).trim().split('\n').sort();
    expect(listed).toEqual(ENTRIES.filter((e) => e !== 'package.json').sort());
    // Idempotent: a converted folder has no record, and a re-run changes nothing.
    expect(await run(['--from', '0.1.0'], ctx(dir))).toBe(0);
    expect(readdirSync(join(dir, 'checkpoints'))).toHaveLength(1);
  });

  it('--rollback puts the 0.1.0 tree and its own package.json and lock back', async () => {
    const dir = halfConverted();
    await run(['--from', '0.1.0'], ctx(dir));
    const [checkpoint] = readdirSync(join(dir, 'checkpoints'));
    expect(await run(['--rollback', checkpoint!], ctx(dir))).toBe(0);
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(OLD_MANIFEST);
    expect(readFileSync(join(dir, 'package-lock.json'), 'utf8')).toBe('{"lockfileVersion":3}\n');
    for (const entry of ENTRIES.filter((e) => e !== 'package.json')) expect(readFileSync(join(dir, entry), 'utf8')).toBe(`0.1.0 ${entry}\n`);
    expect(existsSync(join(dir, '.neuralis-convert'))).toBe(false);
  });

  it('--rollback restores only a convert checkpoint: another checkpoint id in the folder restores nothing', async () => {
    const dir = halfConverted();
    writeFileSync(join(dir, 'app.json'), 'before\n');
    const other = await createCheckpoint(dir, { label: 'upgrade-credential-key-v2', files: ['app.json'] });
    writeFileSync(join(dir, 'app.json'), 'after\n');
    await expect(run(['--rollback', other.id], ctx(dir))).rejects.toThrow(/is not a convert checkpoint of this folder — nothing was restored/);
    expect(readFileSync(join(dir, 'app.json'), 'utf8')).toBe('after\n');
    await expect(run(['--rollback', 'no-such-id'], ctx(dir))).rejects.toThrow(/nothing was restored/);
  });

  it('--rollback takes back an .npmrc the scaffolder wrote, and keeps one the folder already had', async () => {
    for (const wroteNpmrc of [true, false]) {
      const dir = halfConverted();
      writeFileSync(join(dir, '.neuralis-convert', 'from.json'), JSON.stringify({ from: '0.1.0', to: '0.2.0', entries: ENTRIES, wroteNpmrc }));
      writeFileSync(join(dir, '.npmrc'), 'save-exact=true\n');
      await run(['--from', '0.1.0'], ctx(dir));
      const [checkpoint] = readdirSync(join(dir, 'checkpoints'));
      expect(await run(['--rollback', checkpoint!], ctx(dir))).toBe(0);
      expect(existsSync(join(dir, '.npmrc')), String(wroteNpmrc)).toBe(!wroteNpmrc);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a tar that cannot archive stops the conversion before anything is deleted, and the same folder converts once it can', async () => {
    const dir = halfConverted();
    const shim = join(sandbox, 'broken-tar');
    mkdirSync(shim);
    writeFileSync(join(shim, 'tar'), '#!/bin/sh\necho "tar: simulated failure" >&2\nexit 2\n');
    chmodSync(join(shim, 'tar'), 0o755);
    const path = process.env.PATH ?? '';
    setEnv('PATH', `${shim}:${path}`);
    await expect(run(['--from', '0.1.0'], ctx(dir))).rejects.toThrow(/tar -czf failed \(exit 2\) — nothing was deleted/);
    for (const entry of ENTRIES.filter((e) => e !== 'package.json')) expect(existsSync(join(dir, entry)), entry).toBe(true);
    expect(existsSync(join(dir, 'checkpoints'))).toBe(false);
    process.env.PATH = path;
    expect(await run(['--from', '0.1.0'], ctx(dir))).toBe(0);
    expect(existsSync(join(dir, 'src', 'app'))).toBe(false);
  });

  it('refuses while the app answers on its port and deletes nothing; the same folder converts once it is stopped', async () => {
    const dir = halfConverted();
    const server: Server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      setEnv('NEURALIS_APP_PORT', String(port));
      await expect(run(['--from', '0.1.0'], ctx(dir))).rejects.toThrow(/Refusing to convert: the app answers/);
      for (const entry of ENTRIES.filter((e) => e !== 'package.json')) expect(existsSync(join(dir, entry)), entry).toBe(true);
      expect(existsSync(join(dir, 'checkpoints'))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    setEnv('NEURALIS_APP_PORT', stoppedPort);
    expect(await run(['--from', '0.1.0'], ctx(dir))).toBe(0);
    expect(existsSync(join(dir, 'scripts', 'update.mts'))).toBe(false);
  });

  it('refuses a folder that was run natively (.next/) and deletes nothing, checkpoints nothing', async () => {
    const dir = halfConverted();
    mkdirSync(join(dir, '.next'));
    await expect(run(['--from', '0.1.0'], ctx(dir))).rejects.toThrow(/was run natively[\s\S]*Nothing was deleted/);
    for (const entry of ENTRIES.filter((e) => e !== 'package.json')) expect(existsSync(join(dir, entry)), entry).toBe(true);
    expect(existsSync(join(dir, 'checkpoints'))).toBe(false);
    expect(readFileSync(join(dir, '.neuralis-convert', 'package.json'), 'utf8')).toBe(OLD_MANIFEST);
  });

  it('refuses a listing entry outside the folder (absolute or `..`) before deleting anything', async () => {
    const dir = halfConverted();
    const outside = join(sandbox, 'outside.txt');
    writeFileSync(outside, 'not the folder\'s\n');
    for (const bad of ['../outside.txt', outside, 'scripts/../../outside.txt']) {
      writeFileSync(join(dir, '.neuralis-convert', 'from.json'), JSON.stringify({ from: '0.1.0', to: '0.2.0', entries: ['README.md', bad] }));
      await expect(run(['--from', '0.1.0'], ctx(dir))).rejects.toThrow(/outside the install folder[\s\S]*nothing was deleted/);
      expect(() => deleteEntries(dir, ['README.md', bad])).toThrow(/outside the install folder/);
    }
    expect(readFileSync(outside, 'utf8')).toBe('not the folder\'s\n');
    expect(existsSync(join(dir, 'README.md'))).toBe(true);
    expect(existsSync(join(dir, 'checkpoints'))).toBe(false);
  });

  it('refuses a record that names another version, and a folder that is not an npm install folder', async () => {
    const dir = halfConverted();
    await expect(run(['--from', '0.0.9'], ctx(dir))).rejects.toThrow(/the convert record says this folder was 0\.1\.0/);
    writeFileSync(join(dir, 'package.json'), OLD_MANIFEST);
    await expect(run(['--from', '0.1.0'], ctx(dir))).rejects.toThrow(/is not an npm install folder/);
    await expect(run(['--from'], ctx(dir))).rejects.toThrow(/exactly one of --from/);
  });
});

describe('unitServesFolder (the re-render hint names only this folder\'s unit)', () => {
  it('a unit whose ExecStart names this folder → hint; a unit serving another install or no unit → none', () => {
    const dir = mkdtempSync(join(tmpdir(), 'convert-unit-'));
    try {
      const unit = join(dir, 'neuralis-host-broker.service');
      writeFileSync(unit, 'ExecStart=/usr/bin/node /srv/inst/host-broker/server.mjs\n');
      expect(unitServesFolder('/srv/inst', unit)).toBe(true);
      expect(unitServesFolder('/srv/inst/', unit)).toBe(true);
      expect(unitServesFolder('/srv/other', unit)).toBe(false);
      expect(unitServesFolder('/srv/ins', unit)).toBe(false);
      expect(unitServesFolder('/srv/inst', join(dir, 'missing.service'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
