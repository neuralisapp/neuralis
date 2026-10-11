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
import { checkOffline, checkpointsArePersistent, httpProbe, type ComposeAnswer, type OfflineProbes, type ProbeAnswer } from '../checkpoint.mts';
import { parseComposeServices, readComposeStack, type DockerExec } from '../host-broker/helper.mts';
import { buildComposeContent, NO_BUILD_INPUTS } from '../setup/compose.mts';
import { qdrantImageRef } from '../setup/qdrantVersion.mts';

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
      return over.compose ?? svc([]);
    },
  };
  return state;
}

const OPTS = { appPort: 3100, neuralisDir: '/tmp/host' };

/** The stack the one reader reports for the generated compose (app `neuralis`, vector store `qdrant`). */
function svc(running: string[], app = 'neuralis'): ComposeAnswer {
  return { kind: 'services', project: 'neuralis', app, vectorstore: 'qdrant', running };
}
const LOOPBACK = 'http://127.0.0.1:3100/api/health';
const SERVICE = 'http://neuralis:3100/api/health';

describe('the offline decision', () => {
  it('refuses while the app answers on its port — compose is not even asked', async () => {
    const p = probes({ http: { [LOOPBACK]: { kind: 'answered' } } });
    expect(await checkOffline(OPTS, p)).toEqual({ offline: false, reason: `the app answers on ${LOOPBACK}` });
    expect(p.composeCalls).toBe(0);
  });

  it('refuses while compose shows the neuralis service running, even with the port silent', async () => {
    const p = probes({ compose: svc(['qdrant', 'neuralis']) });
    const verdict = await checkOffline(OPTS, p);
    expect(verdict.offline).toBe(false);
    expect(verdict).toMatchObject({ reason: expect.stringContaining('docker compose ps') });
  });

  it('a probe it cannot settle (a timeout) is a refusal, never a guess', async () => {
    const p = probes({ http: { [LOOPBACK]: { kind: 'unknown', detail: 'TimeoutError' } } });
    expect(await checkOffline(OPTS, p)).toMatchObject({ offline: false, reason: expect.stringContaining('could not prove') });
  });

  it('PAIRED CONTROL — silent port + compose with only other services running ⇒ offline', async () => {
    const p = probes({ compose: svc(['qdrant']) });
    expect(await checkOffline(OPTS, p)).toEqual({ offline: true });
    expect(p.composeCalls).toBe(1);
  });

  it('the app is the LABELLED service, never the literal name: a renamed app that runs refuses; an unlabelled compose cannot prove anything', async () => {
    expect(await checkOffline(OPTS, probes({ compose: svc(['web', 'qdrant'], 'web') }))).toEqual({ offline: false, reason: '`docker compose ps` shows the web service running' });
    expect(await checkOffline(OPTS, probes({ compose: svc(['neuralis'], 'web') }))).toEqual({ offline: true });
    expect(await checkOffline(OPTS, probes({ compose: { kind: 'unlabelled', detail: 'no app label' } }))).toMatchObject({ offline: false, reason: expect.stringContaining('could not prove') });
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

describe('the HTTP probe resolves a name on its own bound', () => {
  const notFound = Object.assign(new Error('getaddrinfo ENOTFOUND neuralis'), { code: 'ENOTFOUND' });

  it('a definite "no such host" that takes longer than the 2 s HTTP bound is ABSENT (Docker DNS: ~5 s for a stopped service)', async () => {
    const slowNxdomain = (): Promise<never> => new Promise((_resolve, reject) => setTimeout(() => reject(notFound), 2_300));
    expect(await httpProbe(SERVICE, { lookup: slowNxdomain })).toEqual({ kind: 'absent' });
  });

  it('PAIRED CONTROL — a lookup still pending at its bound cannot prove anything: unknown, a refusal', async () => {
    const pending = (): Promise<never> => new Promise(() => {});
    expect(await httpProbe(SERVICE, { lookup: pending, lookupTimeoutMs: 50 })).toEqual({ kind: 'unknown', detail: 'neuralis: ETIMEOUT' });
    const servfail = (): Promise<never> => Promise.reject(Object.assign(new Error('boom'), { code: 'ESERVFAIL' }));
    expect(await httpProbe(SERVICE, { lookup: servfail })).toEqual({ kind: 'unknown', detail: 'neuralis: ESERVFAIL' });
  });

  it('an IP literal is never looked up', async () => {
    const forbidden = (): Promise<never> => { throw new Error('looked up an IP literal'); };
    const port = await new Promise<number>((done) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => done(p)); }); });
    expect(await httpProbe(`http://127.0.0.1:${port}/api/health`, { lookup: forbidden })).toEqual({ kind: 'absent' });
  });
});

function runCli(args: string[], env: Record<string, string>): Promise<{ status: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/cli/registry.mts', 'checkpoint', ...args], {
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

describe('a container-form checkpoint is a way back only on the persistent mount', () => {
  // `/proc/self/mountinfo` lines: field 5 is the mount point.
  const mounted = (...points: string[]) => () => points.map((p, i) => `${100 + i} 1 0:1 / ${p} rw,relatime - ext4 /dev/sda1 rw`).join('\n');

  it('the generated compose binds <home>/checkpoints next to app/ and projects/', () => {
    const content = buildComposeContent({
      composeProject: 'neuralis', uid: 1000, gid: 1000, dockerGid: null, appPort: 3100, mcpPort: 3101, sandboxPort: 3102,
      nextAuthUrl: 'http://localhost:3100', brainInfraMode: 'local', qdrantMode: 'external', qdrantUrl: 'http://q:6333',
      qdrantImage: qdrantImageRef('1.13.6'), qdrantDashboard: false, codexLoopbackPublish: false, composeOllama: false,
      neuralisHome: '/home/op/.neuralis',
      machine: { desktopVariant: 'ubuntu-xfce', image: 'neuralisapp/webtop-ubuntu-xfce:0.1.0', containerScope: 'user', idleMinutes: 30, screen: '1920x1080', sidecarPort: 9400, cdpPort: 9222, seccompUnconfined: false, dockerSocket: '/var/run/docker.sock' },
      monorepo: false, imageTag: '0.2.0', hostBroker: { enabled: false, socketPath: '/x/s', secretFile: '/x/f' }, build: NO_BUILD_INPUTS, operatorImage: null,
    }, { date: '2026-10-09', version: '0.2.0' });
    expect(content).toContain('      - /home/op/.neuralis/checkpoints:/.neuralis/checkpoints\n');
  });

  it('inside a container the checkpoints folder must be a mount; on the host every folder is persistent', () => {
    expect(checkpointsArePersistent('/.neuralis', true, mounted('/.neuralis/app', '/.neuralis/projects', '/.neuralis/checkpoints'))).toBe(true);
    // A compose file written before the bind: app/ and projects/ are mounted, checkpoints/ is the writable layer.
    expect(checkpointsArePersistent('/.neuralis', true, mounted('/.neuralis/app', '/.neuralis/projects'))).toBe(false);
    // The whole home bound (a one-off `-v <home>:/.neuralis`) covers it too.
    expect(checkpointsArePersistent('/.neuralis', true, mounted('/.neuralis'))).toBe(true);
    expect(checkpointsArePersistent('/.neuralis', false, () => { throw new Error('never read on the host'); })).toBe(true);
  });

  it('upgrade --apply checks the mount BEFORE it runs anything, and names the bind that fixes it', () => {
    const source = readFileSync(join(hostRoot, 'scripts', 'upgrade.mts'), 'utf-8');
    const guard = source.indexOf('!checkpointsArePersistent(roots.home, inContainer)');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(source.indexOf('await runUpgrade({'));
    expect(source).toContain('-v <NEURALIS_HOME on the host>/checkpoints:/.neuralis/checkpoints');
  });
});

describe('the one compose reader', () => {
  function folder(env = 'NEURALIS_COMPOSE_PROJECT=neuralis-x\n'): string {
    const dir = mkdtempSync(join(tmpdir(), 'neuralis-compose-'));
    writeFileSync(join(dir, 'docker-compose.yml'), 'name: neuralis-x\n');
    writeFileSync(join(dir, '.env'), env);
    return dir;
  }
  const MODEL = JSON.stringify({ services: { app1: { labels: { 'neuralis.kind': 'app' } }, vs: { labels: ['neuralis.kind=vectorstore'] }, webtop: {} } });

  it('reads the services by label and what runs, with -p <the .env project>, in the folder, never -f', async () => {
    const dir = folder();
    const calls: string[] = [];
    const exec: DockerExec = async (args, cwd) => {
      expect(cwd).toBe(dir);
      calls.push(args.join(' '));
      return args.includes('config') ? { code: 0, stdout: MODEL, stderr: '' } : { code: 0, stdout: 'app1\nwebtop\n', stderr: '' };
    };
    expect(await readComposeStack(dir, exec)).toEqual({ kind: 'services', project: 'neuralis-x', app: 'app1', vectorstore: 'vs', running: ['app1', 'webtop'] });
    expect(calls).toEqual(['compose -p neuralis-x config --format json --no-interpolate', 'compose -p neuralis-x ps --status running --services']);
    expect(await readComposeStack(dir, exec, { withRunning: false })).toMatchObject({ running: [] });
  });

  it('no compose file, no Docker, a failing daemon and an unlabelled model each answer by name', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'neuralis-compose-'));
    expect(await readComposeStack(empty, async () => { throw new Error('unreached'); })).toMatchObject({ kind: 'failed', detail: expect.stringContaining('has no docker-compose.yml') });
    const dir = folder('');
    const enoent = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
    expect(await readComposeStack(dir, async () => { throw enoent; })).toEqual({ kind: 'no-docker' });
    expect(await readComposeStack(dir, async () => ({ code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' }))).toEqual({ kind: 'failed', detail: '`docker compose config` failed: Cannot connect to the Docker daemon' });
    expect(await readComposeStack(dir, async () => ({ code: 0, stdout: '{"services":{"a":{}}}', stderr: '' }))).toMatchObject({ kind: 'unlabelled' });
  });

  it('parses both label forms; two app services or no model is null', () => {
    expect(parseComposeServices(MODEL)).toEqual({ app: 'app1', vectorstore: 'vs' });
    expect(parseComposeServices(JSON.stringify({ services: { a: { labels: { 'neuralis.kind': 'app' } }, b: { labels: ['neuralis.kind=app'] } } }))).toBeNull();
    expect(parseComposeServices('not json')).toBeNull();
  });
});
