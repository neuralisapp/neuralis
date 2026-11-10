/**
 * `neuralis up | down | status` on a throwaway desktop bundle and data home:
 * fake `server.js` and `qdrant` children (real processes on free loopback
 * ports), the real lock, the real sandbox pipe. Pins the exit-code contract
 * (0 · 1 · 10 · 11 · 12 · 13 · 14 · 15), the ONE ready line, the authored child
 * environments, the stdin-EOF / SIGTERM stop, the backoff restart and `status`,
 * and the way a home a Docker install set up opens here: the real offline
 * `upgrade --apply`, then `up` 15, the adopt (`setup --native --yes`), `up` ready.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer, connect, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { NATIVE_MARKER, readInstallRecords, resolveNeuralisHome } from '@neuralis/package-system/paths';
import { DATA_FORMAT_LEDGER_RELATIVE_PATH, listDataFormatDeclarations, offlineUpgradeSteps } from '@neuralis/package-system/data';
import { CliExit, type CliContext } from '../cli/registry.mts';
import { parseEnvContent } from '../setup/envFile.mts';
import { loadUpgradeModules, runUpgrade, UPGRADES_DIR } from '../upgrade.mts';
import { homeLockPath, PROCESS_LOCK_PROBE, readHomeLock, type LockProbe } from '../../src/server/host/homeLock.ts';
import { askSupervisorToStop, awaitDetachedReady, EXIT, hostChildEnv, hostPackageVersion, ignoreClosedPipe, PROCESS_UP_DEPS, readNativeConfig, readStatus, runDown, runUp, STOP_REQUEST_FILE, verifyBundledHelper, type UpDeps } from '../up.mts';
import { stopQdrantBinary } from '../setup/services.mts';
import { authoredBaseEnv, bundleLayout } from '@neuralis/package-system/paths';
import { createHash } from 'node:crypto';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

// Windows: a reader holding `host.lock` refuses the rename over it. Armed, every rename of a
// `"ready"` state onto the lock fails with EPERM (measured: `up` died on it, 1 of 2 cold starts).
const lockRenameFault = vi.hoisted(() => ({ armed: false }));
// The same reader makes deleting `host.lock` itself fail (EBUSY) while armed.
const lockUnlinkFault = vi.hoisted(() => ({ armed: false }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const renameSync: typeof fs.renameSync = (from, to) => {
    if (lockRenameFault.armed && String(to).endsWith('host.lock') && fs.readFileSync(from, 'utf-8').includes('"state":"ready"')) {
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
    fs.renameSync(from, to);
  };
  const unlinkSync: typeof fs.unlinkSync = (path) => {
    if (lockUnlinkFault.armed && String(path).endsWith('host.lock')) throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${String(path)}'`), { code: 'EBUSY' });
    fs.unlinkSync(path);
  };
  return { ...fs, default: { ...fs, renameSync, unlinkSync }, renameSync, unlinkSync };
});

async function freePorts(n: number): Promise<number[]> {
  const servers: Server[] = [];
  const ports: number[] = [];
  for (let i = 0; i < n; i++) {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    ports.push((server.address() as { port: number }).port);
  }
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  return ports;
}

/** A fake host: answers `/api/health` with its instance id, echoes the Host header, dumps its env; `.env` keys steer it. */
const FAKE_SERVER = `
const http = require('node:http');
const fs = require('node:fs');
const env = process.env;
fs.writeFileSync(env.FAKE_HOST_DUMP, JSON.stringify(env));
const starts = Number(fs.existsSync(env.FAKE_HOST_COUNT) ? fs.readFileSync(env.FAKE_HOST_COUNT, 'utf8') : '0') + 1;
fs.writeFileSync(env.FAKE_HOST_COUNT, String(starts));
if (starts <= Number(env.FAKE_HOST_CRASHES || '0')) process.exit(3);
fs.writeFileSync(env.FAKE_HOST_COUNT + '.pid', String(process.pid));
if (process.connected) fs.writeFileSync(env.FAKE_HOST_COUNT + '.ipc', 'connected');
// The supervisor's stop over the ipc channel (the real host: followSupervisor → its SIGTERM path).
process.on('message', (m) => { if (m === 'shutdown') { fs.writeFileSync(env.FAKE_HOST_COUNT + '.stopped', 'shutdown'); process.exit(0); } });
http.createServer((req, res) => {
  if (req.url === '/api/health') {
    const refused = env.FAKE_HOST_REFUSED === '1';
    res.writeHead(refused ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(refused ? { status: 'error', error: 'bootstrap_failed', code: 'upgrade_required', instanceId: env.NEURALIS_INSTANCE_ID } : { status: 'ready', instanceId: env.NEURALIS_INSTANCE_ID }));
    return;
  }
  res.end('host-header=' + req.headers.host);
}).listen(Number(env.PORT), env.HOSTNAME);
process.on('SIGTERM', () => { fs.writeFileSync(env.FAKE_HOST_COUNT + '.stopped', '1'); process.exit(0); });
`;

/** A fake Qdrant binary: `/healthz`, its env dumped into its cwd. */
const FAKE_QDRANT = `#!${process.execPath}
const http = require('node:http');
require('node:fs').writeFileSync('qdrant-env.json', JSON.stringify(process.env));
http.createServer((req, res) => { res.end('ok'); }).listen(Number(process.env.QDRANT__SERVICE__HTTP_PORT), process.env.QDRANT__SERVICE__HOST);
process.on('SIGTERM', () => process.exit(0));
`;

type World = { resources: string; packageDir: string; home: string; ports: number[]; dump: string; count: string };

const SESSION_SECRET = 's3cret-session';

async function world(opts: { setUp?: boolean; env?: Record<string, string>; qdrant?: boolean; qdrantLines?: string[] } = {}): Promise<World> {
  const root = mkdtempSync(join(tmpdir(), 'nrs-up-'));
  roots.push(root);
  const resources = join(root, 'resources');
  const packageDir = join(resources, 'host');
  mkdirSync(join(packageDir, '_runtime'), { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'neuralis', bin: { neuralis: 'bin/neuralis.mjs' } }));
  writeFileSync(join(packageDir, NATIVE_MARKER), '');
  writeFileSync(join(packageDir, '_runtime', 'server.js'), FAKE_SERVER);
  mkdirSync(join(resources, 'qdrant'), { recursive: true });
  writeFileSync(join(resources, 'qdrant', 'qdrant'), FAKE_QDRANT);
  chmodSync(join(resources, 'qdrant', 'qdrant'), 0o755);
  const home = join(root, 'home');
  const ports = await freePorts(5);
  const dump = join(root, 'host-env.json');
  const count = join(root, 'host-starts');
  if (opts.setUp !== false) {
    mkdirSync(join(home, 'app', 'config'), { recursive: true });
    mkdirSync(join(home, 'app', 'users'), { recursive: true });
    writeFileSync(join(home, 'app', 'users', 'u1.json'), '{}');
    // The session secret is the data home's file — never a `.env` line, never a child's env.
    writeFileSync(join(home, 'app', 'config', 'session-secret.key'), `${SESSION_SECRET}\n`, { mode: 0o400 });
    const qdrant = opts.qdrant ?? true;
    writeFileSync(join(home, 'app', 'config', '.env'), [
      `NEURALIS_APP_PORT=${ports[0]}`, `MCP_HTTP_PORT=${ports[1]}`, `NEURALIS_MCP_SANDBOX_PORT=${ports[2]}`,
      'NEURALIS_BIND_HOST=127.0.0.1',
      ...(opts.qdrantLines ?? (qdrant ? ['QDRANT_MODE=binary', 'QDRANT_API_KEY=qkey', `NEURALIS_QDRANT_PORT=${ports[3]}`, `NEURALIS_QDRANT_GRPC_PORT=${ports[4]}`] : ['QDRANT_MODE=skip'])),
      'NEURALIS_DOCKER=true',
      'NEURALIS_HOST_HOME=/should/never/reach/the/host',
      `FAKE_HOST_DUMP=${dump}`, `FAKE_HOST_COUNT=${count}`,
      ...Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`),
    ].join('\n'));
  }
  return { resources, packageDir, home, ports, dump, count };
}

const FAST: UpDeps = {
  ...PROCESS_UP_DEPS,
  // Docker is never asked by a test: a stop of this home's own store answers "nothing running".
  companionStop: async () => ({ ok: true, service: 'qdrant', stopped: false }),
  ollamaInstall: async () => { throw new Error('a test never downloads Ollama'); },
  verifyHelper: () => ({ ok: false, reason: 'no helper in the test bundle' }),
  upgradeCheck: () => ({ status: 0, output: '' }),
  backoffMs: [40, 40],
  readyTimeoutMs: 8_000,
  stopTimeoutMs: 3_000,
  pollMs: 40,
};

function io(home: string, extra: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const stdin = new PassThrough();
  return {
    out, err, stdin,
    ctx: { stdout: (t: string) => { out.push(t); }, stderr: (t: string) => { err.push(t); }, stdin, env: { NEURALIS_HOME: home, HOME: '/home/op', TZ: 'Europe/Budapest', LANG: 'hu_HU.UTF-8', NRS_PROBE_LOGIN: '1', AWS_SECRET_ACCESS_KEY: 'login-secret', ...extra } },
  };
}

function lines(out: string[]): Array<Record<string, unknown>> {
  return out.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function waitFor(predicate: () => boolean, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 30));
  }
}

describe('up --foreground: the start, the ready line, the stop', () => {
  it('starts Qdrant then the host, prints ONE ready line with the three origins, and stops on stdin EOF — exit 0, lock released', async () => {
    const w = await world();
    const run = io(w.home);
    const done = runUp({ packageDir: w.packageDir, io: run.ctx, deps: FAST, watchStdin: true });
    await waitFor(() => run.out.join('').includes('"ready"'));
    const ready = lines(run.out);
    expect(ready).toHaveLength(1);
    const lock = readHomeLock(w.home);
    expect(lock).toMatchObject({ kind: 'native', pid: process.pid, state: 'ready' });
    expect(ready[0]).toEqual({
      state: 'ready',
      app: `http://127.0.0.1:${w.ports[0]}`, mcp: `http://127.0.0.1:${w.ports[1]}`, sandbox: `http://127.0.0.1:${w.ports[2]}`,
      instanceId: (lock as { instanceId: string }).instanceId,
      vectors: 'qdrant',
      ollama: 'none',
      tunnel: false,
    });

    // The sandbox origin is a byte pipe onto the app port: the Host header keeps the sandbox port.
    const echoed = await new Promise<string>((resolve, reject) => {
      const socket = connect(w.ports[2]!, '127.0.0.1', () => socket.write(`GET /x HTTP/1.1\r\nHost: 127.0.0.1:${w.ports[2]}\r\nConnection: close\r\n\r\n`));
      let text = '';
      socket.on('data', (d) => { text += String(d); });
      socket.on('end', () => resolve(text));
      socket.on('error', reject);
    });
    expect(echoed).toContain(`host-header=127.0.0.1:${w.ports[2]}`);

    run.stdin.end();
    expect(await done).toBe(EXIT.OK);
    expect(existsSync(homeLockPath(w.home))).toBe(false);
    // The host was stopped by the `shutdown` message on its ipc channel, not by a signal.
    expect(readFileSync(`${w.count}.stopped`, 'utf-8')).toBe('shutdown');
  }, 30_000);

  it('a "ready" write the OS keeps refusing is said, never fatal: the ready line, the held lock and a clean stop', async () => {
    const w = await world();
    const run = io(w.home);
    lockRenameFault.armed = true;
    try {
      const done = runUp({ packageDir: w.packageDir, io: run.ctx, deps: FAST, watchStdin: true });
      await waitFor(() => run.out.join('').includes('"ready"'));
      expect(run.err.join('')).toMatch(/Could not record "ready" in .*host\.lock yet \(EPERM\); the next heartbeat writes it\./);
      expect(readHomeLock(w.home)).toMatchObject({ kind: 'native', pid: process.pid });
      expect(readdirSync(dirname(homeLockPath(w.home))).filter((n) => n.endsWith('.update.tmp'))).toEqual([]);
      run.stdin.end();
      expect(await done).toBe(EXIT.OK);
      expect(existsSync(homeLockPath(w.home))).toBe(false);
    } finally {
      lockRenameFault.armed = false;
    }
  }, 30_000);

  it('the host child\'s environment is AUTHORED: .env keys + HOME/TZ/LANG + the run\'s facts — no login env, never NEURALIS_DOCKER/NEURALIS_HOST_HOME', async () => {
    const w = await world();
    const run = io(w.home);
    const done = runUp({ packageDir: w.packageDir, io: run.ctx, deps: FAST, watchStdin: true });
    await waitFor(() => run.out.join('').includes('"ready"'));
    const env = JSON.parse(readFileSync(w.dump, 'utf-8')) as Record<string, string>;
    run.stdin.end();
    await done;
    expect(env.NRS_PROBE_LOGIN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.NEURALIS_DOCKER).toBeUndefined();
    expect(env.NEURALIS_HOST_HOME).toBeUndefined();
    // No child of `up` carries any session secret: the host reads its file.
    expect(env.NEXTAUTH_SECRET).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain(SESSION_SECRET);
    expect(env).toMatchObject({
      HOME: '/home/op', TZ: 'Europe/Budapest', LANG: 'hu_HU.UTF-8',
      NEURALIS_HOME: w.home, HOSTNAME: '127.0.0.1', NEURALIS_BIND_HOST: '127.0.0.1', PORT: String(w.ports[0]),
      NEURALIS_INTERNAL_API_BASE: `http://127.0.0.1:${w.ports[0]}`,
      // The shim in bin/ runs node on the CLI's dist: a confined shell reaches all three, or `neuralis` is EACCES.
      NEURALIS_TOOLCHAIN_ROOT: `${w.resources}/bin:${w.resources}/node/bin:${w.resources}/cli/dist`,
      PATH: `${w.resources}/bin:${w.resources}/node/bin:/usr/bin:/bin`,
      NODE_ENV: 'production',
      NEURALIS_SUPERVISOR: 'ipc',
    });
    expect(env.NEURALIS_LANDLOCK_SANDBOXER).toBeUndefined(); // the helper was not proven
    // Qdrant: PATH, HOME and exactly the authored QDRANT__ set — no session secret, nothing of the login env.
    const qenv = JSON.parse(readFileSync(join(w.home, 'qdrant-storage', 'qdrant-env.json'), 'utf-8')) as Record<string, string>;
    expect(Object.keys(qenv).filter((k) => k.startsWith('QDRANT__')).sort()).toEqual([
      'QDRANT__SERVICE__API_KEY', 'QDRANT__SERVICE__GRPC_PORT', 'QDRANT__SERVICE__HOST', 'QDRANT__SERVICE__HTTP_PORT', 'QDRANT__STORAGE__STORAGE_PATH', 'QDRANT__TELEMETRY_DISABLED',
    ]);
    expect(qenv.QDRANT__SERVICE__HOST).toBe('127.0.0.1');
    expect(JSON.stringify(qenv)).not.toMatch(/s3cret-session|login-secret|NRS_PROBE_LOGIN/);
  }, 30_000);

  it('a host that dies is restarted after the backoff and a new ready line follows; SIGTERM stops the run', async () => {
    const w = await world({ env: { FAKE_HOST_CRASHES: '1' } });
    const run = io(w.home);
    const before = new Set(process.listeners('SIGTERM'));
    const done = runUp({ packageDir: w.packageDir, io: run.ctx, deps: FAST, watchStdin: false });
    await waitFor(() => run.out.join('').includes('"ready"'));
    expect(lines(run.out).map((l) => l.state)).toEqual(['restarting', 'ready']);
    expect(lines(run.out)[0]).toMatchObject({ child: 'host', code: 3, attempt: 1 });
    // The run's own SIGTERM handler (calling it directly: emitting the signal would reach the test runner's too).
    const added = process.listeners('SIGTERM').filter((l) => !before.has(l));
    expect(added).toHaveLength(1);
    (added[0] as () => void)();
    expect(await done).toBe(EXIT.OK);
    expect(process.listeners('SIGTERM').filter((l) => !before.has(l))).toHaveLength(0);
  }, 30_000);

  it('a child that keeps dying ends the run with ONE failed line and exit 14; the lock stays marked failed for status', async () => {
    const w = await world({ env: { FAKE_HOST_CRASHES: '99' } });
    const run = io(w.home);
    expect(await runUp({ packageDir: w.packageDir, io: run.ctx, deps: FAST, watchStdin: true })).toBe(EXIT.CHILD_FAILED);
    const states = lines(run.out);
    expect(states.map((l) => l.state)).toEqual(['restarting', 'restarting', 'failed']);
    expect(states.at(-1)).toEqual({ state: 'failed', child: 'host', code: 3 });
    expect(readHomeLock(w.home)).toMatchObject({ state: 'failed', failed: { child: 'host', code: 3 } });
    const status = await readStatus({ NEURALIS_HOME: w.home }, { ...FAST, lockProbe: { ...FAST.lockProbe, neuralisPidAlive: () => false } });
    expect(status).toMatchObject({ state: 'failed', pid: null, app: null });
  }, 30_000);

  it('a host whose bootstrap refuses (health `error`) is not restarted: the run ends at once', async () => {
    const w = await world({ env: { FAKE_HOST_REFUSED: '1' } });
    const run = io(w.home);
    expect(await runUp({ packageDir: w.packageDir, io: run.ctx, deps: FAST, watchStdin: true })).toBe(EXIT.CHILD_FAILED);
    expect(run.err.join('')).toContain('The host refused to boot: upgrade_required');
    expect(readFileSync(w.count, 'utf-8')).toBe('1');
  }, 30_000);
});

describe('up: the refusals before anything starts', () => {
  it('13 without an owner; 1 with an owner but no session secret file; 15 with both but no native .env; 12 when an offline upgrade is pending; 10 when a port is taken — each releases the lock', async () => {
    const fresh = await world({ setUp: false });
    expect(await runUp({ packageDir: fresh.packageDir, io: io(fresh.home).ctx, deps: FAST, watchStdin: true })).toBe(EXIT.FIRST_RUN_REQUIRED);
    expect(existsSync(homeLockPath(fresh.home))).toBe(false);

    // A home an older Docker install set up: its secret is still in that install's .env. Never 12
    // (a native `upgrade --apply` finds no NEXTAUTH_SECRET) and never 15 (the adopt refuses alike).
    const older = await world();
    rmSync(join(older.home, 'app', 'config', 'session-secret.key'), { force: true });
    await expect(runUp({ packageDir: older.packageDir, io: io(older.home).ctx, deps: FAST, watchStdin: true }))
      .rejects.toMatchObject({ code: EXIT.GENERAL, message: expect.stringContaining('run `neuralis upgrade --apply` from the Docker install first') });
    expect(existsSync(homeLockPath(older.home))).toBe(false);

    // A NATIVE home set up before the move: the line is in its own .env, which a native
    // `upgrade --apply` reads — 12, never the Docker text.
    const olderNative = await world({ env: { NEXTAUTH_SECRET: 'pre-move-native' } });
    rmSync(join(olderNative.home, 'app', 'config', 'session-secret.key'), { force: true });
    const native = io(olderNative.home);
    expect(await runUp({ packageDir: olderNative.packageDir, io: native.ctx, deps: FAST, watchStdin: true })).toBe(EXIT.UPGRADE_REQUIRED);
    expect(native.err.join('')).toContain('`neuralis upgrade --apply`');
    expect(native.err.join('')).not.toContain('Docker');
    expect(existsSync(homeLockPath(olderNative.home))).toBe(false);

    const adoptable = await world();
    rmSync(join(adoptable.home, 'app', 'config', '.env'));
    const ask = io(adoptable.home);
    expect(await runUp({ packageDir: adoptable.packageDir, io: ask.ctx, deps: FAST, watchStdin: true })).toBe(EXIT.NATIVE_CONFIG_REQUIRED);
    expect(ask.err.join('')).toContain('setup --native --yes');
    expect(existsSync(homeLockPath(adoptable.home))).toBe(false);

    const pending = await world();
    const run = io(pending.home);
    expect(await runUp({ packageDir: pending.packageDir, io: run.ctx, deps: { ...FAST, upgradeCheck: () => ({ status: 12, output: '  Pending: x\n' }) }, watchStdin: true })).toBe(EXIT.UPGRADE_REQUIRED);
    expect(run.err.join('')).toContain('Pending: x');
    expect(existsSync(homeLockPath(pending.home))).toBe(false);

    const taken = await world();
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(taken.ports[0], '127.0.0.1', resolve));
    const busy = io(taken.home);
    try {
      expect(await runUp({ packageDir: taken.packageDir, io: busy.ctx, deps: FAST, watchStdin: true })).toBe(EXIT.PORT_TAKEN);
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
    expect(busy.err.join('')).toContain(`Port ${taken.ports[0]} (the app) is in use`);
    expect(existsSync(homeLockPath(taken.home))).toBe(false);
  }, 30_000);

  it('11 while another live host holds the home; a different-kind silent holder is never taken over; a dead same-kind one is', async () => {
    const w = await world();
    mkdirSync(dirname(homeLockPath(w.home)), { recursive: true });
    const silent: LockProbe = { instanceAt: async () => null, neuralisPidAlive: () => false, runs: () => false };
    const live: LockProbe = { instanceAt: async () => 'other', neuralisPidAlive: () => true, runs: () => true };

    writeFileSync(homeLockPath(w.home), JSON.stringify({ kind: 'native', pid: 4242, app: 'http://127.0.0.1:1', instanceId: 'other' }));
    const a = io(w.home);
    expect(await runUp({ packageDir: w.packageDir, io: a.ctx, deps: { ...FAST, lockProbe: live }, watchStdin: true })).toBe(EXIT.HOME_LOCKED);
    expect(a.err.join('')).toContain('A desktop (native) Neuralis host holds this data home');

    writeFileSync(homeLockPath(w.home), JSON.stringify({ kind: 'docker', pid: 1, app: 'http://127.0.0.1:1', instanceId: 'docker-one' }));
    const b = io(w.home);
    expect(await runUp({ packageDir: w.packageDir, io: b.ctx, deps: { ...FAST, lockProbe: silent }, watchStdin: true })).toBe(EXIT.HOME_LOCKED);
    expect(lines(b.out)).toEqual([{ state: 'locked', holder: 'docker', app: 'http://127.0.0.1:1', answered: false, lock: homeLockPath(w.home) }]);
    expect(b.err.join('')).toContain('`docker compose stop neuralis` in its install folder');
    expect(b.err.join('')).toContain(`start it once and stop it cleanly, or delete ${homeLockPath(w.home)} yourself`);
    expect(readHomeLock(w.home)).toMatchObject({ kind: 'docker', instanceId: 'docker-one' });

    // Paired control: the same silent holder of THIS kind is stale — taken over, the run starts.
    writeFileSync(homeLockPath(w.home), JSON.stringify({ kind: 'native', pid: 4242, app: 'http://127.0.0.1:1', instanceId: 'dead-one' }));
    const c = io(w.home);
    const done = runUp({ packageDir: w.packageDir, io: c.ctx, deps: { ...FAST, lockProbe: silent }, watchStdin: true });
    await waitFor(() => c.out.join('').includes('"ready"'));
    expect(c.err.join('')).toContain('Took over a stale lock');
    c.stdin.end();
    expect(await done).toBe(EXIT.OK);
  }, 30_000);

  // A SIGKILLed supervisor leaves Qdrant running (it cannot follow a pipe). The
  // next `up` must not take the lock over, meet the orphan's port (10), release
  // the lock and lose the orphan's pid: it stops the orphan first — or, when the
  // recorded pid is not the bundle's Qdrant, refuses and keeps the lock.
  it('a stale lock whose dead supervisor left Qdrant running: the next up stops it (proven pid) and starts; a foreign pid is refused, the lock kept', async () => {
    const w = await world();
    const qdrantBin = join(w.resources, 'qdrant', 'qdrant');
    const qdrantUrl = `http://127.0.0.1:${w.ports[3]}`;
    const startQdrant = () => spawn(qdrantBin, [], { cwd: w.resources, stdio: 'ignore', env: { ...process.env, QDRANT__SERVICE__HTTP_PORT: String(w.ports[3]), QDRANT__SERVICE__HOST: '127.0.0.1' } });
    const answering = async (): Promise<void> => { for (let i = 0; i < 100 && !(await FAST.qdrantUp(qdrantUrl)); i++) await new Promise((r) => setTimeout(r, 50)); };
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const deadSupervisor = { kind: 'native', pid: 999_999, app: `http://127.0.0.1:${w.ports[0]}`, instanceId: 'killed-sup', state: 'ready', bundle: w.resources };
    mkdirSync(dirname(homeLockPath(w.home)), { recursive: true });
    const orphan = startQdrant();
    const foreign = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'qdrant'], { stdio: 'ignore' });
    try {
      await answering();
      expect(await FAST.qdrantUp(qdrantUrl)).toBe(true);
      // 1. The recorded pid is not this bundle's Qdrant (reused): refused by name, nothing signalled, the lock kept with its pids.
      const reused = { ...deadSupervisor, qdrantPid: foreign.pid };
      writeFileSync(homeLockPath(w.home), JSON.stringify(reused));
      const a = io(w.home);
      expect(await runUp({ packageDir: w.packageDir, io: a.ctx, deps: FAST, watchStdin: true })).toBe(EXIT.HOME_LOCKED);
      expect(a.err.join('')).toContain(`no process the lock records runs this bundle's Qdrant`);
      expect(readHomeLock(w.home)).toEqual(reused);
      expect(alive(foreign.pid!)).toBe(true);
      expect(await FAST.qdrantUp(qdrantUrl)).toBe(true);
      expect(existsSync(w.count)).toBe(false); // no host was started
      // 2. The recorded pid IS the orphan: stopped, the stale lock taken over, the run starts on the freed port.
      writeFileSync(homeLockPath(w.home), JSON.stringify({ ...deadSupervisor, qdrantPid: orphan.pid }));
      const b = io(w.home);
      const done = runUp({ packageDir: w.packageDir, io: b.ctx, deps: FAST, watchStdin: true });
      await waitFor(() => b.out.join('').includes('"ready"'));
      expect(b.err.join('')).toContain(`Stopped the Qdrant its supervisor left running (process ${orphan.pid})`);
      expect(b.err.join('')).toContain('Took over a stale lock');
      expect(orphan.exitCode !== null || orphan.signalCode !== null).toBe(true);
      expect(readHomeLock(w.home)).toMatchObject({ pid: process.pid, qdrantPid: expect.any(Number) });
      expect((readHomeLock(w.home) as { qdrantPid: number }).qdrantPid).not.toBe(orphan.pid);
      b.stdin.end();
      expect(await done).toBe(EXIT.OK);
    } finally {
      if (orphan.exitCode === null && orphan.signalCode === null) orphan.kill('SIGKILL');
      foreign.kill('SIGKILL');
    }
  }, 30_000);

  it('a host package without the native marker is refused by name', async () => {
    const w = await world();
    rmSync(join(w.packageDir, NATIVE_MARKER));
    await expect(runUp({ packageDir: w.packageDir, io: io(w.home).ctx, deps: FAST, watchStdin: true })).rejects.toThrow(/runs the desktop app's own host bundle/);
  });
});

describe('a home a Docker install set up opens here', () => {
  /** sha256 of every file under these home-relative roots — what the adopt must leave byte-identical. */
  function digest(home: string, rels: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (rel: string): void => {
      const abs = join(home, rel);
      if (!existsSync(abs)) return;
      if (statSync(abs).isDirectory()) { for (const name of readdirSync(abs)) walk(join(rel, name)); return; }
      out[rel] = createHash('sha256').update(readFileSync(abs)).digest('hex');
    };
    for (const rel of rels) walk(rel);
    return out;
  }

  it('ORACLE: `upgrade --apply` moves the secret from the install .env into the home → `up` 15 → the adopt → `up` ready, with users, projects, credentials and the Qdrant record untouched', async () => {
    const w = await world({ setUp: false });
    // A home set up by an older Docker install: records, credential key files, a recorded Qdrant
    // version, a ledger current on every kind but the session secret's — and NO secret file.
    const app = join(w.home, 'app');
    for (const dir of ['users', 'projects', 'config']) mkdirSync(join(app, dir), { recursive: true });
    writeFileSync(join(app, 'users', 'u1.json'), JSON.stringify({ id: 'u1', email: 'owner@example.com', status: 'active' }));
    writeFileSync(join(app, 'projects', 'main.json'), JSON.stringify({ id: 'main', name: 'Main' }));
    writeFileSync(join(app, 'config', 'credential-master.key'), 'k'.repeat(32), { mode: 0o400 });
    writeFileSync(join(w.home, 'qdrant-version.json'), JSON.stringify({ version: '1.19.1', previous: null, source: 'fresh', recordedAt: '2026-10-01T00:00:00.000Z' }));
    await loadUpgradeModules(UPGRADES_DIR); // declares every shipped kind
    const ledger = Object.fromEntries(listDataFormatDeclarations()
      .filter((decl) => offlineUpgradeSteps(decl).length > 0 && decl.kind !== 'neuralis/session-secret')
      .map((decl) => [decl.kind, { version: decl.version, raisedAt: '2026-10-01T00:00:00.000Z' }]));
    writeFileSync(join(app, DATA_FORMAT_LEDGER_RELATIVE_PATH), JSON.stringify(ledger));
    const kept = digest(w.home, ['app/users', 'app/projects', 'app/config/credential-master.key', 'qdrant-version.json']);

    // 1. The offline step, with the install folder's `.env` loaded as the upgrade command does.
    vi.stubEnv('NEXTAUTH_SECRET', SESSION_SECRET);
    try {
      const outcome = await runUpgrade({ apply: true, modulesDir: UPGRADES_DIR, roots: resolveNeuralisHome({ ...process.env, NEURALIS_HOME: w.home }), offline: async () => ({ offline: true }), log: () => {}, appRuns: 'native' });
      expect(outcome).toMatchObject({ pending: ['neuralis/session-secret'], applied: true });
    } finally {
      vi.unstubAllEnvs();
    }
    const secretFile = join(app, 'config', 'session-secret.key');
    expect(readFileSync(secretFile, 'utf-8')).toBe(`${SESSION_SECRET}\n`);
    expect(statSync(secretFile).mode & 0o777).toBe(0o400);

    // 2. `up`: set up, but not for this app.
    expect(await runUp({ packageDir: w.packageDir, io: io(w.home).ctx, deps: FAST, watchStdin: true })).toBe(EXIT.NATIVE_CONFIG_REQUIRED);

    // 3. The adopt — no owner flags, an empty stdin, no install folder to read: this home records
    //    no Docker install, so this app's own Qdrant is chosen (its default reads the recorded one).
    const { run } = await import('../setup.mts');
    const stdin = new PassThrough();
    stdin.end();
    const setupCtx: CliContext = {
      packageDir: w.packageDir,
      get installDir(): string { throw new CliExit(1, 'the adopt never reads an install folder'); },
      cwd: w.packageDir, env: { NEURALIS_HOME: w.home }, stdin, stdout: () => {}, stderr: () => {},
    };
    await expect(run(['--native', '--yes'], setupCtx)).rejects.toThrow(/records no Docker install of this data home/);
    expect(await run(['--native', '--yes', '--qdrant', 'binary'], setupCtx)).toBe(0);
    const envText = readFileSync(join(app, 'config', '.env'), 'utf-8');
    expect(envText).not.toContain('NEXTAUTH_SECRET');
    expect(envText).not.toContain(SESSION_SECRET);
    expect(parseEnvContent(envText)).toMatchObject({ NEURALIS_BIND_HOST: '127.0.0.1', QDRANT_MODE: 'binary' });
    expect(digest(w.home, ['app/users', 'app/projects', 'app/config/credential-master.key', 'qdrant-version.json'])).toEqual(kept);
    expect(readInstallRecords(w.home)).toEqual([{ kind: 'native', dir: w.packageDir, configDir: join(app, 'config') }]);

    // 4. `up` again: ready, and no child carries the secret. (The two FAKE_ keys only steer the fake host.)
    appendFileSync(join(app, 'config', '.env'), `FAKE_HOST_DUMP=${w.dump}\nFAKE_HOST_COUNT=${w.count}\n`);
    const run2 = io(w.home);
    const done = runUp({ packageDir: w.packageDir, io: run2.ctx, deps: FAST, watchStdin: true });
    await waitFor(() => run2.out.join('').includes('"ready"'), 15_000);
    const hostEnv = readFileSync(w.dump, 'utf-8');
    const qdrantEnv = readFileSync(join(w.home, 'qdrant-storage', 'qdrant-env.json'), 'utf-8');
    run2.stdin.end();
    expect(await done).toBe(EXIT.OK);
    for (const env of [hostEnv, qdrantEnv]) {
      expect(env).not.toContain(SESSION_SECRET);
      expect(env).not.toContain('NEXTAUTH_SECRET');
    }
  }, 90_000);
});

describe('down and status', () => {
  it('status: stopped with no lock; down with no lock says so; a dead same-kind lock is removed by down', async () => {
    const w = await world();
    expect(await readStatus({ NEURALIS_HOME: w.home }, FAST)).toEqual({
      state: 'stopped', pid: null, instanceId: null, app: null, mcp: null, sandbox: null,
      qdrant: { mode: 'binary', state: 'stopped' }, home: w.home, lock: null,
    });
    const said: string[] = [];
    expect(await runDown({ NEURALIS_HOME: w.home }, (l) => said.push(l), { ...FAST, waitMs: 100 })).toBe(EXIT.OK);
    expect(said).toEqual(['Nothing runs on this data home.']);
    mkdirSync(dirname(homeLockPath(w.home)), { recursive: true });
    writeFileSync(homeLockPath(w.home), JSON.stringify({ kind: 'native', pid: 999999, app: 'http://127.0.0.1:1', instanceId: 'gone' }));
    // Another program holds the lock file open: down says so and never claims it removed it.
    lockUnlinkFault.armed = true;
    try {
      await expect(runDown({ NEURALIS_HOME: w.home }, (l) => said.push(l), { ...FAST, waitMs: 100, lockProbe: { instanceAt: async () => null, neuralisPidAlive: () => false, runs: () => false } })).rejects.toThrow(/could not be removed: another program still has the lock file open/);
    } finally {
      lockUnlinkFault.armed = false;
    }
    expect(existsSync(homeLockPath(w.home))).toBe(true);
    expect(said.some((l) => l.startsWith('Removed the lock'))).toBe(false);
    // Released, the same down removes it (control).
    expect(await runDown({ NEURALIS_HOME: w.home }, (l) => said.push(l), { ...FAST, waitMs: 100, lockProbe: { instanceAt: async () => null, neuralisPidAlive: () => false, runs: () => false } })).toBe(EXIT.OK);
    expect(existsSync(homeLockPath(w.home))).toBe(false);
    // A Docker holder is not this command's to stop.
    writeFileSync(homeLockPath(w.home), JSON.stringify({ kind: 'docker', pid: 1, app: 'http://127.0.0.1:1', instanceId: 'd' }));
    await expect(runDown({ NEURALIS_HOME: w.home }, () => {}, { ...FAST, waitMs: 100 })).rejects.toThrow(/a Docker host holds this data home/);
  });

  it('status of a running host: ready, with its pid, instance id and origins; the json types of the contract', async () => {
    const w = await world();
    const run = io(w.home);
    const done = runUp({ packageDir: w.packageDir, io: run.ctx, deps: FAST, watchStdin: true });
    await waitFor(() => run.out.join('').includes('"ready"'));
    const status = await readStatus({ NEURALIS_HOME: w.home }, FAST);
    expect(status).toMatchObject({
      state: 'ready', pid: process.pid, app: `http://127.0.0.1:${w.ports[0]}`, mcp: `http://127.0.0.1:${w.ports[1]}`, sandbox: `http://127.0.0.1:${w.ports[2]}`,
      qdrant: { mode: 'binary', state: 'running' }, home: w.home, lock: { kind: 'native', app: `http://127.0.0.1:${w.ports[0]}` },
    });
    expect(typeof status.instanceId).toBe('string');
    // The lock names the children `down` must stop if this supervisor dies, and the host holds the channel it follows.
    expect(readHomeLock(w.home)).toMatchObject({ hostPid: Number(readFileSync(`${w.count}.pid`, 'utf-8')), qdrantPid: expect.any(Number) });
    expect(readFileSync(`${w.count}.ipc`, 'utf-8')).toBe('connected');
    // No stop nonce off Windows: SIGTERM is the stop there, and the lock stays as it was.
    expect((readHomeLock(w.home) as { stopNonce?: string }).stopNonce).toBeUndefined();
    run.stdin.end();
    await done;
  }, 30_000);

  // A supervisor killed with SIGKILL leaves its children running. `down` never
  // clears a lock whose origin still answers with the lock's id: it stops the
  // recorded host (and Qdrant), then clears it — or refuses, keeping the lock.
  it('down stops the host a dead supervisor left answering, then clears the lock; without a recorded host pid it refuses', async () => {
    const w = await world();
    const orphanEnv = { ...process.env, FAKE_HOST_DUMP: w.dump, FAKE_HOST_COUNT: w.count, PORT: String(w.ports[0]), HOSTNAME: '127.0.0.1', NEURALIS_INSTANCE_ID: 'orphan-1' };
    const server = join(w.packageDir, '_runtime', 'server.js');
    const orphan = spawn(process.execPath, [server], { env: orphanEnv, stdio: 'ignore' });
    // A reused pid: a foreign process now holds the number the lock recorded. It is never signalled.
    const foreign = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'neuralis'], { stdio: 'ignore' });
    try {
      const app = `http://127.0.0.1:${w.ports[0]}`;
      await waitFor(() => existsSync(`${w.count}.pid`));
      const deadSupervisor = { kind: 'native', pid: 999_999, app, instanceId: 'orphan-1', state: 'ready', bundle: w.resources };
      const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
      mkdirSync(dirname(homeLockPath(w.home)), { recursive: true });
      const gone: LockProbe = { ...PROCESS_LOCK_PROBE, instanceAt: async () => null, neuralisPidAlive: () => false };
      const answers = async (): Promise<boolean> => (await FAST.health(app))?.instanceId === 'orphan-1';
      for (let i = 0; i < 100 && !(await answers()); i++) await new Promise((r) => setTimeout(r, 50));
      expect(await answers()).toBe(true);
      // The paired controls: the same live orphan with no host pid on record, or with a reused pid — refused, nothing signalled, the lock kept.
      for (const recorded of [{}, { hostPid: foreign.pid }, { pid: foreign.pid }]) {
        writeFileSync(homeLockPath(w.home), JSON.stringify({ ...deadSupervisor, ...recorded }));
        await expect(runDown({ NEURALIS_HOME: w.home }, () => {}, { ...FAST, waitMs: 3_000, lockProbe: gone })).rejects.toThrow(/still answers/);
        expect(readHomeLock(w.home)).toMatchObject({ instanceId: 'orphan-1' });
        expect(alive(foreign.pid!)).toBe(true);
        expect(await answers()).toBe(true);
      }
      // Recorded: stopped by SIGTERM, then the lock goes.
      writeFileSync(homeLockPath(w.home), JSON.stringify({ ...deadSupervisor, hostPid: orphan.pid }));
      const said: string[] = [];
      expect(await runDown({ NEURALIS_HOME: w.home }, (l) => said.push(l), { ...FAST, waitMs: 5_000, lockProbe: gone })).toBe(EXIT.OK);
      expect(existsSync(`${w.count}.stopped`)).toBe(true);
      expect(await answers()).toBe(false);
      expect(readHomeLock(w.home)).toBeNull();
      expect(said.join('\n')).toMatch(new RegExp(`Stopped the host its supervisor left running \\(process ${orphan.pid}\\)`));
      // Qdrant, left running the same way: stopped by its recorded pid while it answers on the configured port.
      const qdrantBin = join(w.resources, 'qdrant', 'qdrant');
      const qdrant = spawn(qdrantBin, [], { cwd: w.resources, stdio: 'ignore', env: { ...process.env, QDRANT__SERVICE__HTTP_PORT: String(w.ports[3]), QDRANT__SERVICE__HOST: '127.0.0.1' } });
      const qdrantUrl = `http://127.0.0.1:${w.ports[3]}`;
      try {
        for (let i = 0; i < 100 && !(await FAST.qdrantUp(qdrantUrl)); i++) await new Promise((r) => setTimeout(r, 50));
        // A Qdrant answering on the port does not make a reused pid a target.
        writeFileSync(homeLockPath(w.home), JSON.stringify({ ...deadSupervisor, qdrantPid: foreign.pid }));
        await expect(runDown({ NEURALIS_HOME: w.home }, () => {}, { ...FAST, waitMs: 3_000, lockProbe: gone })).rejects.toThrow(/no process the lock records runs this bundle's Qdrant/);
        expect(alive(foreign.pid!)).toBe(true);
        writeFileSync(homeLockPath(w.home), JSON.stringify({ ...deadSupervisor, qdrantPid: qdrant.pid }));
        const saidQ: string[] = [];
        expect(await runDown({ NEURALIS_HOME: w.home }, (l) => saidQ.push(l), { ...FAST, waitMs: 5_000, lockProbe: gone })).toBe(EXIT.OK);
        expect(await FAST.qdrantUp(qdrantUrl)).toBe(false);
        expect(saidQ.join('\n')).toContain(`Stopped the Qdrant its supervisor left running (process ${qdrant.pid})`);
      } finally {
        if (qdrant.exitCode === null && qdrant.signalCode === null) qdrant.kill('SIGKILL');
      }
    } finally {
      if (orphan.exitCode === null && orphan.signalCode === null) orphan.kill('SIGKILL');
      foreign.kill('SIGKILL');
    }
  }, 30_000);
});

describe('the foreground run outlives its reader', () => {
  // The desktop app killed mid-quit closes the pipes `up` writes to; the host's drain lines would then
  // end `up` on EPIPE before it released the lock.
  it('a write to a closed pipe is dropped, any other stream error still throws', async () => {
    const reader = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['pipe', 'ignore', 'ignore'] });
    await new Promise((r) => reader.once('exit', r));
    const closed = reader.stdin!;
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    // Paired control: unguarded, the same error event is fatal.
    expect(() => closed.emit('error', epipe)).toThrow('write EPIPE');
    ignoreClosedPipe(closed);
    expect(() => closed.emit('error', epipe)).not.toThrow();
    expect(() => closed.emit('error', Object.assign(new Error('boom'), { code: 'EIO' }))).toThrow('boom');
    // A real write after the reader is gone: no uncaught error.
    await new Promise<void>((resolve) => { closed.write('draining\n', () => resolve()); });
  });
});

describe('the confinement helper and the config read', () => {
  // The selftest verdict is the kernel probe's (its own suite owns every arm); these rows pin
  // that up asks it, on the bundled helper whose bytes match the client manifest.
  it.skipIf(process.platform !== 'linux')('exported only when its sha matches the client manifest AND the kernel probe proves it', () => {
    const root = mkdtempSync(join(tmpdir(), 'nrs-up-helper-'));
    roots.push(root);
    const native = join(root, 'cli', 'native');
    const rel = `nrs-sandboxer/linux-${process.arch}/nrs-sandboxer`;
    const bin = join(native, rel);
    mkdirSync(dirname(bin), { recursive: true });
    const helper = (transcript: string, code = 0): void => {
      const script = `#!/bin/sh\nprintf '%s\\n' ${transcript.split('\n').map((l) => `'${l}'`).join(' ')} >&2\nexit ${code}\n`;
      writeFileSync(bin, script);
      chmodSync(bin, 0o755);
      writeFileSync(join(native, 'manifest.json'), JSON.stringify({ version: 1, files: { [rel]: { sha256: createHash('sha256').update(script).digest('hex') } } }));
    };
    const both = 'selftest: Landlock ABI 6 (>= 3) OK\nselftest: PASS (inside allowed, outside denied EACCES)\nselftest: PASS seccomp (x)';
    helper(both);
    expect(verifyBundledHelper(root)).toEqual({ ok: true, path: bin });
    // An old helper: exit 0, the Landlock pair only — not proof.
    helper('selftest: Landlock ABI 6 (>= 3) OK\nselftest: PASS (inside allowed, outside denied EACCES)');
    expect(verifyBundledHelper(root)).toMatchObject({ ok: false, reason: expect.stringContaining('predates the alternate-ABI seccomp filter') });
    helper(both, 95);
    expect(verifyBundledHelper(root)).toMatchObject({ ok: false, reason: expect.stringContaining('seccomp AF_UNIX filter did not enforce') });
    writeFileSync(bin, 'tampered');
    expect(verifyBundledHelper(root)).toMatchObject({ ok: false, reason: expect.stringContaining('does not match its pinned sha256') });
    expect(verifyBundledHelper(root, 'darwin', 'arm64')).toMatchObject({ ok: false });
  });

  it('hostChildEnv sets the helper only when proven, and an empty bind falls back to loopback', async () => {
    const w = await world({ qdrant: false });
    const config = readNativeConfig(join(w.home, 'app', 'config'))!;
    expect(config.qdrant.mode).toBe('inmemory');
    const env = hostChildEnv({ config: { ...config, bindHost: '127.0.0.1' }, home: w.home, resources: w.resources, instanceId: 'i', helper: '/r/cli/native/h', parent: {} });
    expect(env.NEURALIS_LANDLOCK_SANDBOXER).toBe('/r/cli/native/h');
    expect(env.HOME).toBeUndefined();
    expect(env.NEURALIS_VERSION).toBeUndefined();
  });

  it('the host child names the bundle\'s own version (Admin → Config), read from its package.json — never "(source checkout)"', async () => {
    const w = await world({ qdrant: false });
    const config = readNativeConfig(join(w.home, 'app', 'config'))!;
    const dir = mkdtempSync(join(tmpdir(), 'nrs-host-version-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'neuralis', version: '0.3.3' }));
    const version = hostPackageVersion(dir);
    expect(version).toBe('0.3.3');
    expect(hostChildEnv({ config, home: w.home, resources: w.resources, instanceId: 'i', helper: null, parent: {}, version }).NEURALIS_VERSION).toBe('0.3.3');
    expect(hostPackageVersion(join(dir, 'missing'))).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('up with Qdrant in Docker — this home\'s own compose file, or the Docker install\'s', () => {
  /** A Qdrant stand-in: `/healthz` always; `/collections` only with the key `dkey`. */
  async function dockerQdrant(): Promise<{ url: string; close: () => Promise<void> }> {
    const http = await import('node:http');
    const server = http.createServer((req, res) => {
      if (req.url === '/healthz') { res.end('ok'); return; }
      const ok = req.headers['api-key'] === 'dkey';
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(ok ? '{"result":{"collections":[]}}' : '{"status":{"error":"Must provide an API key"}}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
  }

  it('external with a recorded install folder: starts ONLY its vector store there, waits for it, hands the host the URL and key — the ready line says qdrant; status probes it', async () => {
    const q = await dockerQdrant();
    const w = await world({ qdrantLines: ['BRAIN_INFRA_MODE=local', 'QDRANT_MODE=external', `QDRANT_URL=${q.url}`, 'QDRANT_API_KEY=dkey', 'NEURALIS_QDRANT_COMPOSE_DIR=/srv/docker-install'] });
    const started: string[] = [];
    const stops: string[] = [];
    const deps: UpDeps = { ...FAST, companion: async (dir) => { started.push(dir); return { ok: true, service: 'qdrant', started: true }; }, companionStop: async (dir) => { stops.push(dir); return { ok: true, service: 'qdrant', stopped: true }; } };
    const run = io(w.home);
    const done = runUp({ packageDir: w.packageDir, io: run.ctx, deps, watchStdin: true });
    await waitFor(() => run.out.join('').includes('"ready"'));
    expect(started).toEqual(['/srv/docker-install']);
    expect(lines(run.out)[0]).toMatchObject({ state: 'ready', vectors: 'qdrant' });
    expect(lines(run.out)[0]).not.toHaveProperty('vectorsReason');
    expect(run.err.join('')).toContain('Started qdrant in /srv/docker-install');
    const hostEnv = JSON.parse(readFileSync(w.dump, 'utf-8')) as Record<string, string>;
    expect(hostEnv).toMatchObject({ QDRANT_URL: q.url, QDRANT_API_KEY: 'dkey', BRAIN_INFRA_MODE: 'local' });
    // Nothing of Qdrant is this run's to stop or to claim a port for.
    expect(readHomeLock(w.home)).not.toHaveProperty('qdrantPid');
    const status = await readStatus({ NEURALIS_HOME: w.home }, FAST);
    expect(status.qdrant).toEqual({ mode: 'external', state: 'running' });
    run.stdin.end();
    expect(await done).toBe(EXIT.OK);
    // The Docker install's Qdrant serves its app: never stopped by this one.
    expect(stops).toEqual([]);
    await q.close();
    // Paired control: the same config with nothing listening reads stopped.
    expect((await readStatus({ NEURALIS_HOME: w.home }, FAST)).qdrant).toEqual({ mode: 'external', state: 'stopped' });
  }, 30_000);

  it('a key the Docker Qdrant refuses: the host still starts, the ready line says qdrant/unauthorized and the log names --refresh-qdrant', async () => {
    const q = await dockerQdrant();
    const w = await world({ qdrantLines: ['BRAIN_INFRA_MODE=local', 'QDRANT_MODE=external', `QDRANT_URL=${q.url}`, 'QDRANT_API_KEY=rotated-away'] });
    const run = io(w.home);
    const done = runUp({ packageDir: w.packageDir, io: run.ctx, deps: { ...FAST, companion: async () => { throw new Error('no folder recorded: never called'); } }, watchStdin: true });
    await waitFor(() => run.out.join('').includes('"ready"'));
    expect(lines(run.out)[0]).toMatchObject({ state: 'ready', vectors: 'qdrant', vectorsReason: 'unauthorized' });
    expect(run.err.join('')).toContain('the host starts, and search and indexing stay unavailable until the key matches');
    expect(run.err.join('')).toContain('--refresh-qdrant');
    expect(run.err.join('')).not.toContain('in-memory');
    run.stdin.end();
    expect(await done).toBe(EXIT.OK);
    await q.close();
  }, 30_000);

  it('docker mode: the vector store of THIS home\'s compose file (beside its .env) is started; a failed start is named, the host starts on qdrant/unreachable, the store is started again on the optional cadence — bounded, and the stop ends it', async () => {
    const [qport] = await freePorts(1);
    // The host dies once: a host restart under this run must stop nothing.
    const w = await world({ qdrantLines: ['BRAIN_INFRA_MODE=local', 'QDRANT_MODE=docker', `NEURALIS_QDRANT_PORT=${qport}`, 'QDRANT_API_KEY=dkey', 'NEURALIS_COMPOSE_PROJECT=neuralis-desktop-x'], env: { FAKE_HOST_CRASHES: '1' } });
    const dir = join(w.home, 'app', 'config');
    const asked: string[] = [];
    const stops: string[] = [];
    const probes: string[] = [];
    const deps: UpDeps = {
      ...FAST,
      qdrantUp: async (url) => { probes.push(url); return false; },
      companion: async (d) => { asked.push(d); return { ok: false, reason: 'no Docker CLI on this machine' }; },
      companionStop: async (d) => { stops.push(d); return { ok: true, service: 'qdrant', stopped: true }; },
    };
    const run = io(w.home);
    const done = runUp({ packageDir: w.packageDir, io: run.ctx, deps, watchStdin: true });
    await waitFor(() => run.out.join('').includes('"ready"'));
    expect(asked[0]).toBe(dir);
    expect(lines(run.out).map((l) => l.state)).toEqual(['restarting', 'ready']);
    expect(lines(run.out)[1]).toMatchObject({ vectors: 'qdrant', vectorsReason: 'unreachable' });
    // A failed start is not waited for: one probe, then the host (no `within N s` wait).
    expect(run.err.join('')).toContain(`Qdrant did not answer on http://127.0.0.1:${qport}; the host starts, and search and indexing continue by themselves when the vector store answers.`);
    expect(run.err.join('')).not.toContain('in-memory');
    expect(run.err.join('')).toContain(`Neuralis keeps starting the vector store in ${dir} until it answers.`);
    // The cadence: the two test backoff steps (40 ms), then the 30 s step — one probe + one start each, nothing more.
    await waitFor(() => asked.length >= 3);
    await new Promise((r) => setTimeout(r, 400));
    expect(asked).toEqual([dir, dir, dir]);
    expect(probes).toHaveLength(3);
    // The same failure is named once, not once per step.
    expect(run.err.join('').split(`The vector store in ${dir} did not start: no Docker CLI on this machine`)).toHaveLength(2);
    // The host restart (its child exited, this process started it again) stopped nothing.
    expect(stops).toEqual([]);
    const stoppedAt = Date.now();
    run.stdin.end();
    expect(await done).toBe(EXIT.OK);
    // The stop wakes the pending 30 s step instead of waiting it out, and starts nothing behind it.
    expect(Date.now() - stoppedAt).toBeLessThan(10_000);
    expect(asked).toHaveLength(3);
    // The full stop: this home's own store, after the host.
    expect(stops).toEqual([dir]);
    expect(run.err.join('')).toContain(`Stopped qdrant in ${dir}.`);
  }, 30_000);

  it.each([
    ['answers', 'dkey', 'Qdrant answers on'],
    ['refuses the key', 'rotated-away', 'search and indexing stay unavailable until the key matches'],
  ] as const)('docker mode: the retry stops on the first step the store %s', async (_what, key, said) => {
    const [qport] = await freePorts(1);
    const w = await world({ qdrantLines: ['BRAIN_INFRA_MODE=local', 'QDRANT_MODE=docker', `NEURALIS_QDRANT_PORT=${qport}`, `QDRANT_API_KEY=${key}`, 'NEURALIS_COMPOSE_PROJECT=neuralis-desktop-x'] });
    const http = await import('node:http');
    // The store's service: down at start; the retry's first start brings it up.
    const store = http.createServer((req, res) => {
      if (req.url === '/healthz') { res.end('ok'); return; }
      const ok = req.headers['api-key'] === 'dkey';
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
      res.end(ok ? '{"result":{"collections":[]}}' : '{}');
    });
    const asked: string[] = [];
    const deps: UpDeps = {
      ...FAST,
      companion: async (d) => {
        asked.push(d);
        if (asked.length === 1) return { ok: false, reason: 'Docker is starting' };
        await new Promise<void>((resolve) => store.listen(qport, '127.0.0.1', resolve));
        return { ok: true, service: 'qdrant', started: true };
      },
    };
    const run = io(w.home);
    const done = runUp({ packageDir: w.packageDir, io: run.ctx, deps, watchStdin: true });
    await waitFor(() => run.err.join('').includes(said));
    await waitFor(() => run.out.join('').includes('"ready"'));
    await new Promise((r) => setTimeout(r, 300));
    // Initial start + the retry's one start; the next step's probe answered and ended it.
    expect(asked).toHaveLength(2);
    expect(run.err.join('')).toContain(`Started qdrant in ${join(w.home, 'app', 'config')}.`);
    run.stdin.end();
    expect(await done).toBe(EXIT.OK);
    await new Promise<void>((resolve) => store.close(() => resolve()));
  }, 30_000);
});

describe('the optional companions and the LAN switch', () => {
  it('Ollama binary: fetched and started AFTER the ready line, the embedding model pulled once, its pid recorded, stopped with the run — and its absence never blocks the host', async () => {
    const w = await world({ qdrant: false, env: { OLLAMA_MODE: 'binary', NEURALIS_OLLAMA_PORT: '11435' } });
    const fake = join(dirname(w.home), 'ollama');
    writeFileSync(fake, '#!/bin/sh\nexec sleep 60\n');
    chmodSync(fake, 0o755);
    const pulled: string[] = [];
    let installs = 0;
    const deps: UpDeps = {
      ...FAST,
      ollamaInstall: async () => { installs += 1; return fake; },
      ollamaUp: async () => true,
      ollamaHas: async () => false,
      ollamaPull: async (url, model, onProgress) => { pulled.push(`${url} ${model}`); onProgress({ status: 'pulling manifest' }); onProgress({ status: 'success' }); return true; },
    };
    const run = io(w.home);
    const done = runUp({ packageDir: w.packageDir, io: run.ctx, deps, watchStdin: true });
    await waitFor(() => run.out.join('').includes('"ready"'));
    expect(lines(run.out)[0]).toMatchObject({ state: 'ready', ollama: 'binary', tunnel: false });
    expect(lines(run.out)[0]).not.toHaveProperty('publicApp');
    await waitFor(() => pulled.length === 1);
    expect(pulled).toEqual(['http://127.0.0.1:11435 qwen3-embedding:0.6b']);
    expect(installs).toBe(1);
    const pid = (readHomeLock(w.home) as { ollamaPid?: number }).ollamaPid;
    expect(pid).toEqual(expect.any(Number));
    run.stdin.end();
    expect(await done).toBe(EXIT.OK);
    expect(() => process.kill(pid!, 0)).toThrow();
    // Paired control: an Ollama that cannot be fetched — the host is ready all the same and the log says why.
    const w2 = await world({ qdrant: false, env: { OLLAMA_MODE: 'binary' } });
    const run2 = io(w2.home);
    const done2 = runUp({ packageDir: w2.packageDir, io: run2.ctx, deps: { ...FAST, ollamaInstall: async () => { throw new Error('offline'); } }, watchStdin: true });
    await waitFor(() => run2.out.join('').includes('"ready"'));
    await waitFor(() => run2.err.join('').includes('Ollama could not be fetched: offline'));
    run2.stdin.end();
    expect(await done2).toBe(EXIT.OK);
  }, 30_000);

  it('the LAN switch binds every address but THIS machine still reaches it on loopback; a declared public origin rides the ready line', async () => {
    const w = await world({ qdrant: false, env: { APP_URL: 'https://app.example.com' } });
    const config = readNativeConfig(join(w.home, 'app', 'config'))!;
    const lan = { ...config, bindHost: '0.0.0.0' };
    const env = hostChildEnv({ config: lan, home: w.home, resources: w.resources, instanceId: 'i', helper: null, parent: {} });
    expect(env.HOSTNAME).toBe('0.0.0.0');
    expect(env.NEURALIS_INTERNAL_API_BASE).toBe(`http://127.0.0.1:${w.ports[0]}`);
    expect(config.publicApp).toBe('https://app.example.com');
    const run = io(w.home);
    const done = runUp({ packageDir: w.packageDir, io: run.ctx, deps: FAST, watchStdin: true });
    await waitFor(() => run.out.join('').includes('"ready"'));
    expect(lines(run.out)[0]).toMatchObject({ app: `http://127.0.0.1:${w.ports[0]}`, publicApp: 'https://app.example.com', ollama: 'none' });
    run.stdin.end();
    expect(await done).toBe(EXIT.OK);
  }, 30_000);
});

describe('one bundle layout, an authored environment per OS', () => {
  const config = (bindHost = '127.0.0.1') => ({ env: { NEURALIS_APP_PORT: '3100' }, bindHost, ports: { app: 3100, mcp: 3101, sandbox: 3102 }, qdrant: { mode: 'inmemory' as const, ports: { http: 6333, grpc: 6334 }, url: null, composeDir: null }, ollama: { mode: 'none' as const, port: 11435, url: null, composeDir: null }, tunnel: false, publicApp: null });
  const parent = {
    HOME: '/home/op', TZ: 'Europe/Budapest', LANG: 'hu_HU.UTF-8', AWS_SECRET_ACCESS_KEY: 'login-secret', PATH: '/login/path',
    // Windows names are case-insensitive: a parent spelling `Path`/`systemroot` still hands them over.
    systemroot: 'C:\\Windows', windir: 'C:\\Windows', SystemDrive: 'C:', PATHEXT: '.COM;.EXE;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    USERPROFILE: 'C:\\Users\\op', LOCALAPPDATA: 'C:\\Users\\op\\AppData\\Local', APPDATA: 'C:\\Users\\op\\AppData\\Roaming',
    ProgramData: 'C:\\ProgramData', TEMP: 'C:\\Users\\op\\AppData\\Local\\Temp', TMP: 'C:\\Users\\op\\AppData\\Local\\Temp', ProgramFiles: 'D:\\Apps',
  };
  const env = (platform: NodeJS.Platform, res = '/r') => hostChildEnv({ config: config(), home: '/h', resources: res, instanceId: 'i', helper: null, parent, platform });

  it('Linux: the PATH and toolchain roots of the kernel layout, `:`-joined, nothing of the login env — unchanged', () => {
    const l = bundleLayout('/r', 'linux');
    const linux = env('linux');
    expect(linux.PATH).toBe(`${l.binDir}:${l.nodeBinDir}:/usr/bin:/bin`);
    expect(linux.NEURALIS_TOOLCHAIN_ROOT).toBe(l.toolchainRoots.join(':'));
    expect(linux).not.toHaveProperty('SystemRoot');
    expect(linux.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(linux).toMatchObject({ HOME: '/home/op', NEURALIS_SUPERVISOR: 'ipc' });
  });

  it('Windows: `;`-joined, node.exe\'s own folder, System32 + PowerShell + Docker Desktop on PATH, the system keys kept, the login rest dropped', () => {
    const l = bundleLayout('/r', 'win32');
    const win = env('win32');
    expect(l.nodeBinDir).toBe(join('/r', 'node'));
    expect(win.NEURALIS_TOOLCHAIN_ROOT).toBe(l.toolchainRoots.join(';'));
    expect(win.NEURALIS_TOOLCHAIN_ROOT).not.toContain(':');
    const path = win.PATH!.split(';');
    expect(path.slice(0, 2)).toEqual([l.binDir, l.nodeBinDir]);
    expect(path).toEqual(expect.arrayContaining(['C:\\Windows\\System32', 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0', 'D:\\Apps\\Docker\\Docker\\resources\\bin']));
    expect(win).toMatchObject({
      SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', PATHEXT: '.COM;.EXE;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      USERPROFILE: 'C:\\Users\\op', LOCALAPPDATA: 'C:\\Users\\op\\AppData\\Local', APPDATA: 'C:\\Users\\op\\AppData\\Roaming', ProgramData: 'C:\\ProgramData', TEMP: 'C:\\Users\\op\\AppData\\Local\\Temp',
    });
    expect(win.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(win.PATH).not.toContain('/login/path');
  });

  it('macOS: Homebrew, the admin dirs and both Docker Desktop CLI folders follow the system dirs; no Windows key', () => {
    const mac = env('darwin');
    expect(mac.PATH!.split(':')).toEqual([join('/r', 'bin'), join('/r', 'node', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/opt/homebrew/bin', '/Applications/Docker.app/Contents/Resources/bin', '/home/op/.docker/bin']);
    expect(mac).not.toHaveProperty('SystemRoot');
    expect(authoredBaseEnv('darwin', {})).toEqual({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin' });
    // Paired control: Linux gets none of the macOS folders.
    expect(authoredBaseEnv('linux', parent)).toEqual({ PATH: '/usr/bin:/bin' });
  });

  it('a binary Qdrant is never stopped by its recorded pid on Windows — named, nothing signalled', async () => {
    await expect(stopQdrantBinary('/nowhere', 'win32')).rejects.toThrow(/never stopped by its process id/);
    // Paired control: elsewhere the pid file is read (none here: nothing to stop, no error).
    await expect(stopQdrantBinary('/nowhere', 'linux')).resolves.toBeUndefined();
  });

  it('the confinement backend per OS: the bundled wxc-exec held to its pin and handed to the host to prove; Seatbelt by its absolute path; none on Windows ARM', () => {
    const root = mkdtempSync(join(tmpdir(), 'nrs-up-mxc-'));
    roots.push(root);
    const { confinement } = bundleLayout(root, 'win32', 'x64');
    mkdirSync(dirname(confinement!.path), { recursive: true });
    writeFileSync(confinement!.path, 'MZ wxc-exec');
    const pin = (sha: string): void => writeFileSync(join(root, 'cli', 'native', 'manifest.json'), JSON.stringify({ version: 1, files: { [confinement!.pin!]: { sha256: sha } } }));
    pin(createHash('sha256').update('MZ wxc-exec').digest('hex'));
    // No probe here: the host's boot probe proves it with the argv builder it owns.
    expect(verifyBundledHelper(root, 'win32', 'x64')).toEqual({ ok: true, path: confinement!.path });
    pin('0'.repeat(64));
    expect(verifyBundledHelper(root, 'win32', 'x64')).toEqual({ ok: false, reason: 'mxc/win32-x64/wxc-exec.exe does not match its pinned sha256' });
    expect(verifyBundledHelper('/r', 'win32', 'arm64')).toEqual({ ok: false, reason: 'no confinement helper exists for this platform' });
    expect(verifyBundledHelper('/r', 'darwin', 'arm64')).toEqual(existsSync('/usr/bin/sandbox-exec')
      ? { ok: true, path: '/usr/bin/sandbox-exec' }
      : { ok: false, reason: '/usr/bin/sandbox-exec is missing on this machine' });
  });
});

// Windows has no SIGTERM to deliver (a kill is TerminateProcess, and the job
// object takes the host down undrained): `down` asks the supervisor with a
// request file carrying the lock's random nonce. Driven here with the platform
// injected, on this machine's real watch and real processes.
describe('down on Windows: a stop request, never a signal', () => {
  const WIN: UpDeps = { ...FAST, platform: 'win32' };

  it('the lock carries a stop nonce; a request with the wrong nonce is removed and ignored; down with the lock\'s nonce stops the run — the host by its shutdown message', async () => {
    const w = await world({ qdrant: false });
    const run = io(w.home);
    const done = runUp({ packageDir: w.packageDir, io: run.ctx, deps: WIN, watchStdin: false });
    await waitFor(() => run.out.join('').includes('"ready"'));
    const lock = readHomeLock(w.home) as { instanceId: string; stopNonce?: string };
    expect(lock.stopNonce).toMatch(/^[0-9a-f]{64}$/);
    const request = join(dirname(homeLockPath(w.home)), STOP_REQUEST_FILE);

    // Mutation control: the right id with a forged nonce never stops it.
    askSupervisorToStop(w.home, { instanceId: lock.instanceId, stopNonce: 'f'.repeat(64) });
    await waitFor(() => !existsSync(request));
    await new Promise((r) => setTimeout(r, 300));
    expect(readHomeLock(w.home)).toMatchObject({ instanceId: lock.instanceId, state: 'ready' });

    const said: string[] = [];
    expect(await runDown({ NEURALIS_HOME: w.home }, (l) => said.push(l), { ...WIN, waitMs: 10_000, lockProbe: { ...PROCESS_LOCK_PROBE, runs: () => true } })).toBe(EXIT.OK);
    expect(said).toEqual(['Stopped.']);
    expect(await done).toBe(EXIT.OK);
    expect(readHomeLock(w.home)).toBeNull();
    expect(readFileSync(`${w.count}.stopped`, 'utf-8')).toBe('shutdown');
  }, 30_000);

  it('a fresh home outside the profile is made private before the lock and its nonce are written into it; one inside the profile is left alone', async () => {
    const outside = await world({ setUp: false });
    const calls: Array<{ cmd: string; app: boolean }> = [];
    const acl: UpDeps['acl'] = async (cmd) => {
      calls.push({ cmd, app: existsSync(join(outside.home, 'app')) });
      return { code: 0, stdout: cmd === 'whoami' ? '"pc\\op","S-1-5-21-7-8-9-1001"\n' : '', stderr: '' };
    };
    expect(await runUp({ packageDir: outside.packageDir, io: io(outside.home, { USERPROFILE: '/profiles/op' }).ctx, deps: { ...WIN, acl }, watchStdin: false })).toBe(EXIT.FIRST_RUN_REQUIRED);
    expect(calls).toEqual([{ cmd: 'whoami', app: false }, { cmd: 'icacls', app: false }]);

    const inside = await world({ setUp: false });
    const none: string[] = [];
    expect(await runUp({ packageDir: inside.packageDir, io: io(inside.home, { USERPROFILE: dirname(inside.home) }).ctx, deps: { ...WIN, acl: async (cmd) => { none.push(cmd); return { code: 0, stdout: '', stderr: '' }; } }, watchStdin: false })).toBe(EXIT.FIRST_RUN_REQUIRED);
    expect(none).toEqual([]);

    // A refused narrowing stops the start before anything is written there.
    const refused = await world({ setUp: false });
    await expect(runUp({ packageDir: refused.packageDir, io: io(refused.home, { USERPROFILE: '/profiles/op' }).ctx, deps: { ...WIN, acl: async () => ({ code: 5, stdout: '', stderr: 'Access is denied.' }) }, watchStdin: false }))
      .rejects.toMatchObject({ code: EXIT.GENERAL, message: expect.stringContaining('cannot restrict') });
    expect(existsSync(join(refused.home, 'app'))).toBe(false);
  }, 30_000);

  it('a holder that takes no request (no nonce, or no bundle) is refused by name — nothing signalled, the lock kept', async () => {
    const w = await world({ qdrant: false });
    mkdirSync(dirname(homeLockPath(w.home)), { recursive: true });
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'neuralis'], { stdio: 'ignore' });
    try {
      const old = { kind: 'native', pid: holder.pid, app: 'http://127.0.0.1:1', instanceId: 'old-sup', bundle: w.resources };
      writeFileSync(homeLockPath(w.home), JSON.stringify(old));
      const alive: LockProbe = { instanceAt: async () => 'old-sup', neuralisPidAlive: () => true, runs: () => true };
      await expect(runDown({ NEURALIS_HOME: w.home }, () => {}, { ...WIN, waitMs: 100, lockProbe: alive })).rejects.toThrow(/takes no stop request/);
      expect(readHomeLock(w.home)).toEqual(old);
      expect(holder.exitCode).toBeNull();
      expect(existsSync(join(dirname(homeLockPath(w.home)), STOP_REQUEST_FILE))).toBe(false);
    } finally {
      holder.kill('SIGKILL');
    }
  }, 30_000);
});

describe('the detached start returns on the run\'s own readiness', () => {
  const fakeChild = (pid: number) => {
    const child = Object.assign(new EventEmitter(), { pid });
    return child as unknown as Parameters<typeof awaitDetachedReady>[1] & Pick<EventEmitter, 'emit'>;
  };
  const homeWithLock = (lock: Record<string, unknown>): string => {
    const home = mkdtempSync(join(tmpdir(), 'nrs-up-detach-'));
    mkdirSync(dirname(homeLockPath(home)), { recursive: true });
    writeFileSync(homeLockPath(home), JSON.stringify(lock));
    return home;
  };

  it('a lock stuck at `starting` (a reader holds the file, every rewrite fails) does not hold the start: /api/health 200 with the lock\'s instance id is ready', async () => {
    const home = homeWithLock({ kind: 'native', pid: 4242, app: 'http://127.0.0.1:9', instanceId: 'run-1', state: 'starting' });
    const asked: string[] = [];
    const t0 = Date.now();
    const result = await awaitDetachedReady(home, fakeChild(4242), '/log', {
      pollMs: 20,
      health: async (app) => { asked.push(app); return { status: 200, instanceId: 'run-1', state: 'ok', code: null }; },
    });
    expect(result.code).toBe(EXIT.OK);
    expect(result.lines[0]).toContain('Neuralis runs on http://127.0.0.1:9');
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(asked[0]).toBe('http://127.0.0.1:9');
    rmSync(home, { recursive: true, force: true });
  });

  it('paired control: an answer from ANOTHER instance on that port, or a lock of another pid, is never ready — the child\'s exit ends the wait', async () => {
    const home = homeWithLock({ kind: 'native', pid: 4242, app: 'http://127.0.0.1:9', instanceId: 'run-1', state: 'starting' });
    const wrongInstance = fakeChild(4242);
    let asks = 0;
    const pending = awaitDetachedReady(home, wrongInstance, '/log', {
      pollMs: 20,
      health: async () => { asks += 1; return { status: 200, instanceId: 'someone-else', state: 'ok', code: null }; },
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(asks).toBeGreaterThan(1);
    wrongInstance.emit('exit', 3);
    expect(await pending).toMatchObject({ code: 3 });

    const otherPid = fakeChild(1);
    let otherAsks = 0;
    const second = awaitDetachedReady(home, otherPid, '/log', { pollMs: 20, health: async () => { otherAsks += 1; return { status: 200, instanceId: 'run-1', state: 'ok', code: null }; } });
    await new Promise((r) => setTimeout(r, 100));
    otherPid.emit('exit', null);
    expect(await second).toMatchObject({ code: EXIT.GENERAL });
    expect(otherAsks).toBe(0);
    rmSync(home, { recursive: true, force: true });
  });
});
