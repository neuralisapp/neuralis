/**
 * `neuralis:checkpoint` — the offline decision `restore` makes before it puts a
 * checkpoint back, and the CLI itself run for real (`node --import tsx`,
 * exactly the package.json script) against a throwaway NEURALIS_HOME.
 *
 * The probes are injected for the decision table; the CLI rows never reach the
 * compose probe (the `list` verb has no guard, and the refused `restore` stops
 * at the HTTP probe), so no row here talks to a Docker daemon.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCheckpoint } from '@neuralis/package-system/data';
import { checkOffline, type ComposeAnswer, type OfflineProbes, type ProbeAnswer } from '../checkpoint.mts';

const hostRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const homes: string[] = [];

afterAll(() => {
  for (const dir of homes) rmSync(dir, { recursive: true, force: true });
});

function probes(over: {
  inContainer?: boolean;
  http?: Record<string, ProbeAnswer>;
  compose?: ComposeAnswer;
}): OfflineProbes & { composeCalls: number; httpCalls: string[] } {
  const state = {
    composeCalls: 0,
    httpCalls: [] as string[],
    inContainer: over.inContainer ?? false,
    async http(url: string): Promise<ProbeAnswer> {
      state.httpCalls.push(url);
      return over.http?.[url] ?? { kind: 'absent' };
    },
    async composeRunning(): Promise<ComposeAnswer> {
      state.composeCalls += 1;
      return over.compose ?? { kind: 'services', running: [] };
    },
  };
  return state;
}

const OPTS = { appPort: 3100, neuralisDir: '/tmp/host' };
const LOOPBACK = 'http://127.0.0.1:3100/api/health';
const SERVICE = 'http://neuralis:3100/api/health';

describe('the offline decision', () => {
  it('refuses while the app answers on its port — compose is not even asked', async () => {
    const p = probes({ http: { [LOOPBACK]: { kind: 'answered' } } });
    expect(await checkOffline(OPTS, p)).toEqual({ offline: false, reason: `the app answers on ${LOOPBACK}` });
    expect(p.composeCalls).toBe(0);
  });

  it('refuses while compose shows the neuralis service running, even with the port silent', async () => {
    const p = probes({ compose: { kind: 'services', running: ['qdrant', 'neuralis'] } });
    const verdict = await checkOffline(OPTS, p);
    expect(verdict.offline).toBe(false);
    expect(verdict).toMatchObject({ reason: expect.stringContaining('docker compose ps') });
  });

  it('a probe it cannot settle (a timeout) is a refusal, never a guess', async () => {
    const p = probes({ http: { [LOOPBACK]: { kind: 'unknown', detail: 'TimeoutError' } } });
    expect(await checkOffline(OPTS, p)).toMatchObject({ offline: false, reason: expect.stringContaining('could not prove') });
  });

  it('PAIRED CONTROL — silent port + compose with only other services running ⇒ offline', async () => {
    const p = probes({ compose: { kind: 'services', running: ['qdrant'] } });
    expect(await checkOffline(OPTS, p)).toEqual({ offline: true });
    expect(p.composeCalls).toBe(1);
  });

  it('a native install (no docker CLI) with a silent port is offline', async () => {
    expect(await checkOffline(OPTS, probes({ compose: { kind: 'no-docker' } }))).toEqual({ offline: true });
  });

  it('inside a one-off container: the service name is probed too, and compose is never called', async () => {
    const running = probes({ inContainer: true, http: { [SERVICE]: { kind: 'answered' } } });
    expect(await checkOffline(OPTS, running)).toMatchObject({ offline: false, reason: expect.stringContaining(SERVICE) });
    expect(running.httpCalls).toEqual([LOOPBACK, SERVICE]);

    const stopped = probes({ inContainer: true });
    expect(await checkOffline(OPTS, stopped)).toEqual({ offline: true });
    expect(stopped.composeCalls).toBe(0);
  });
});

function runCli(args: string[], env: Record<string, string>): Promise<{ status: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/checkpoint.mts', ...args], {
      cwd: hostRoot,
      env: { ...process.env, ...env },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    child.stdin.end();
    child.on('close', (status) => done({ status, out }));
  });
}

async function scratchHome(): Promise<{ home: string; id: string; file: string }> {
  const home = mkdtempSync(join(tmpdir(), 'nrs-checkpoint-cli-'));
  homes.push(home);
  mkdirSync(join(home, 'app', 'config'), { recursive: true });
  const file = join(home, 'app', 'config', 'platform.json');
  writeFileSync(file, '{"before":true}\n');
  const manifest = await createCheckpoint(home, { label: 'neuralis-platform-config-v1-v2', files: ['app/config/platform.json'] });
  writeFileSync(file, '{"after":true}\n');
  return { home, id: manifest.id, file };
}

describe('neuralis:checkpoint (the CLI)', () => {
  it('list names the checkpoint, newest first', async () => {
    const { home, id } = await scratchHome();
    const { status, out } = await runCli(['list'], { NEURALIS_HOME: home });
    expect(status).toBe(0);
    expect(out).toContain(id);
    expect(out).toContain('1 checkpoint(s), newest first.');
  }, 60_000);

  it('restore REFUSES while something answers on the app port, and changes nothing', async () => {
    const { home, id, file } = await scratchHome();
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    try {
      const port = (server.address() as AddressInfo).port;
      const { status, out } = await runCli(['restore', id], { NEURALIS_HOME: home, NEURALIS_APP_PORT: String(port) });
      expect(status).toBe(1);
      expect(out).toContain(`Refusing to restore: the app answers on http://127.0.0.1:${port}/api/health`);
      expect(readFileSync(file, 'utf-8')).toBe('{"after":true}\n');
    } finally {
      await new Promise((closed) => server.close(closed));
    }
  }, 60_000);
});
