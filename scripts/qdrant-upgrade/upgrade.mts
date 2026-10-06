/**
 * The Qdrant upgrade procedure behind `pnpm neuralis:qdrant-upgrade`, written
 * against ports (a process runner, a Qdrant REST client, a clock) so every
 * step — including each failure path — is exercised without a daemon.
 *
 * The shape, and why each step is there:
 *  1. Refuse without twice the storage size free — nothing has changed yet.
 *  2. Check the source against the settle rule (`waitSettled`) while the app
 *     still runs; then STOP THE APP and RECORD: version, collections, exact
 *     point counts, `payload_schema`. The counts are the pass oracle of every
 *     hop, so nothing may write while they are taken. Any failure after the
 *     app stop and before the tar restarts it.
 *  3. SNAPSHOT every collection and copy it OUT (operator-owned, 0600 in a
 *     0700 dir) — then delete it inside Qdrant, so snapshots never pile up.
 *  4. STOP Qdrant and write a COLD tar of the storage (refused while anything
 *     runs on the volume). Upstream's snapshot restore has open bugs across
 *     versions; the cold tar plus the previous recorded version IS the rollback.
 *  5. Walk every minor. An intermediate hop is a digest-pinned `docker run`
 *     on the volume with NO network and NO host port (binary mode: the
 *     sha256-verified release binary on loopback); the key reaches it through
 *     a 0600 env-file deleted on every exit path — never argv, never printed.
 *     Each hop must meet the settle rule — ready, optimizer ok, not red, the
 *     exact recorded count; green is not required (1.16 migrates
 *     RocksDB→Gridstore in the background — it gets the long cap).
 *  6. The FINAL hop advances the recorded version, regenerates compose through
 *     setup's own generator and starts the stack the normal way.
 *  Any failure after the Qdrant stop restores the tar and the previous version.
 *  A signal marks the record `aborted` and restarts nothing (`abortActiveRun`).
 *  `down -v` appears nowhere.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, rmSync, writeFileSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  qdrantImageRef,
  qdrantStatePath,
  qdrantUpgradeChain,
  qdrantVolumeName,
  readQdrantState,
  writeQdrantState,
  type QdrantState,
} from '../setup/qdrantVersion.mts';

// ── Ports ──────────────────────────────────────────────────────

export type ExecResult = { code: number; out: string; err: string };
export type ExecOptions = {
  cwd?: string;
  /** Stream stdout into this file (created 0600) instead of capturing it. */
  stdoutPath?: string;
  /** Feed this file to stdin. */
  stdinPath?: string;
};
export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => Promise<ExecResult>;

/**
 * The real port: streams stdout to / stdin from host files this (operator) process owns.
 * With `stdoutPath` it resolves only once the file is flushed and closed — the child's
 * exit comes first, and a caller that stats or reads the file must see all of it.
 */
export const processExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let flushed: Promise<void> = Promise.resolve();
    let sinkFailed = false;
    if (opts.stdoutPath) {
      const sink = createWriteStream(opts.stdoutPath, { mode: 0o600 });
      flushed = new Promise((done) => {
        sink.on('close', () => done());
        sink.on('error', (e) => { sinkFailed = true; err += `${e.message}\n`; done(); });
      });
      child.stdout.pipe(sink);
    } else child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    if (opts.stdinPath) createReadStream(opts.stdinPath).pipe(child.stdin);
    else child.stdin.end();
    child.on('error', (e) => resolve({ code: 127, out, err: e.message }));
    child.on('close', (code) => { void flushed.then(() => resolve({ code: sinkFailed && code === 0 ? 1 : code ?? 1, out, err })); });
  });

export type QdrantResponse = { status: number; body: unknown };

/** One Qdrant server, reached however this mode reaches it. */
export type QdrantApi = {
  request(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<QdrantResponse>;
  /** Copy a server-side snapshot file out to `dest`. */
  fetchSnapshot(collection: string, name: string, dest: string): Promise<void>;
};

export type UpgradeTimeouts = {
  readyMs: number;
  settleMs: number;
  /** The 1.16 hop migrates RocksDB→Gridstore in the background. */
  migrationSettleMs: number;
  pollMs: number;
};

export const DEFAULT_TIMEOUTS: UpgradeTimeouts = {
  readyMs: 10 * 60_000,
  settleMs: 60 * 60_000,
  migrationSettleMs: 4 * 60 * 60_000,
  pollMs: 5_000,
};

/** The minor whose hop runs the storage migration. */
const MIGRATION_MINOR = '1.16.';

/** What every mode shares. */
export type BaseContext = {
  neuralisHome: string;
  apiKey: string;
  /** The recorded version the storage is on. */
  from: string;
  target: string;
  exec: Exec;
  /** The managed server on its loopback port. */
  liveQdrant: () => QdrantApi;
  freeBytes: (dir: string) => Promise<number>;
  log: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** Wall clock: timestamps only. */
  now: () => Date;
  /** Monotonic ms (`performance.now()`): every deadline. A host suspend never fails a wait early. */
  monotonicMs: () => number;
  timeouts: UpgradeTimeouts;
};

export type UpgradeContext = BaseContext & {
  /** The host folder: compose cwd (never `-f`) and setup's location. */
  neuralisDir: string;
  composeProject: string;
  /** Rehearsal: a CLONED volume; nothing live is touched. */
  rehearseVolume: string | null;
  /** A hop container, reached through `docker exec`. */
  containerQdrant: (container: string) => QdrantApi;
};

// ── The key env-file (never argv) ──────────────────────────────

const liveEnvFiles = new Set<string>();
const liveHopContainers = new Set<string>();

/**
 * Synchronous cleanup for the CLI's `exit` hook: a signal skips every
 * `finally`. The env-file carries the key, and a hop container left running
 * holds the storage — a later `--rollback` must never restore under it.
 */
export function cleanupOnExit(removeContainer: (name: string) => void): void {
  for (const name of liveHopContainers) {
    try { removeContainer(name); } catch { /* best effort at exit */ }
  }
  liveHopContainers.clear();
  for (const dir of liveEnvFiles) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort at exit */ }
  }
  liveEnvFiles.clear();
}

/** The hop containers this process started and has not removed yet. */
export function liveHops(): string[] {
  return [...liveHopContainers];
}

/** Runs `fn` with a 0600 env-file in a 0700 temp dir; the dir is removed on every exit path. */
export async function withKeyEnvFile<T>(apiKey: string, fn: (envFile: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'neuralis-qdrant-'));
  liveEnvFiles.add(dir);
  try {
    await chmod(dir, 0o700);
    const envFile = join(dir, 'qdrant.env');
    await writeFile(envFile, `QDRANT__SERVICE__API_KEY=${apiKey}\nQDRANT__TELEMETRY_DISABLED=true\n`, { mode: 0o600 });
    await chmod(envFile, 0o600);
    return await fn(envFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
    liveEnvFiles.delete(dir);
  }
}

// ── The run in flight (for the signal path) ────────────────────

export type RunPhase = 'preflight' | 'recording' | 'backup' | 'hops' | 'final';

type ActiveRun = {
  dir: string;
  record: UpgradeRecord;
  mode: 'docker' | 'binary';
  rehearseVolume: string | null;
  phase: RunPhase;
  appStopped: boolean;
};

let activeRun: ActiveRun | null = null;

function beginRun(run: Omit<ActiveRun, 'phase' | 'appStopped'>): ActiveRun {
  activeRun = { ...run, phase: 'preflight', appStopped: false };
  return activeRun;
}

/**
 * The exit hook's first step on a signal: the run's `record.json` says
 * `aborted` — phase, last completed hop, whether the app was stopped — and the
 * returned line names the state and the exact command that continues from it.
 * Nothing is started here: a store that may be partly upgraded is never handed
 * back to the app automatically. `null` when no run is in flight.
 */
export function abortActiveRun(): string | null {
  const run = activeRun;
  if (!run) return null;
  activeRun = null;
  const { record, dir } = run;
  const storageChanged = run.phase === 'hops' || run.phase === 'final';
  const lastCompletedHop = record.hops.at(-1)?.version ?? null;
  record.result = 'aborted';
  record.aborted = { phase: run.phase, lastCompletedHop, appStopped: run.appStopped, storageChanged };
  try {
    writeFileSync(join(dir, 'record.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  } catch { /* the line below still names the dir */ }
  const hop = lastCompletedHop ? `last completed hop ${lastCompletedHop}` : 'no hop completed';
  const rollback = `pnpm neuralis:qdrant-upgrade${run.rehearseVolume ? ` --rehearse ${run.rehearseVolume}` : ''} --rollback ${dir}`;
  if (run.rehearseVolume) {
    return storageChanged
      ? `ABORTED: the clone ${run.rehearseVolume} may be partly upgraded (${hop}). Restore it with: ${rollback}`
      : `ABORTED before any hop: the clone ${run.rehearseVolume} is still on ${record.from}. Record: ${join(dir, 'record.json')}`;
  }
  if (storageChanged) {
    return `ABORTED: the storage may be partly upgraded (${hop}); the app is STOPPED and was not restarted. Restore with: ${rollback}`;
  }
  if (!run.appStopped) return `ABORTED before the stack was stopped: nothing changed. Record: ${join(dir, 'record.json')}`;
  return run.mode === 'docker'
    ? `ABORTED before any hop: the storage is unchanged (still ${record.from}) but the app is STOPPED. Start the stack from the host folder with: docker compose up -d`
    : `ABORTED before any hop: the storage is unchanged (still ${record.from}) but the app is STOPPED. Start the Qdrant binary and the app as before (\`pnpm start\` or \`docker compose up -d\`).`;
}

// ── The record ─────────────────────────────────────────────────

export type CollectionRecord = { points: number; status: string; optimizerStatus: string; payloadSchema: unknown };

export type UpgradeRecord = {
  startedAt: string;
  rehearsal: boolean;
  volume: string;
  from: string;
  target: string;
  chain: string[];
  collections: Record<string, CollectionRecord>;
  snapshots: Array<{ collection: string; file: string; bytes: number; deletedInside: boolean }>;
  coldTar: { file: string; bytes: number } | null;
  hops: Array<{ version: string; collections: Record<string, CollectionRecord>; settledMs: number }>;
  result: 'running' | 'upgraded' | 'rehearsed' | 'rolled-back' | 'failed' | 'restored' | 'aborted';
  error?: string;
  /** Written by the exit hook when a signal ended the run. */
  aborted?: { phase: RunPhase; lastCompletedHop: string | null; appStopped: boolean; storageChanged: boolean };
};

const COLLECTION_NAME = /^[A-Za-z0-9_-]{1,128}$/;
const SNAPSHOT_NAME = /^[A-Za-z0-9_.:-]{1,256}$/;

function result<T>(res: QdrantResponse, what: string): T {
  if (res.status !== 200) throw new Error(`Qdrant ${what} answered HTTP ${res.status}.`);
  const body = res.body as { result?: T } | null;
  if (!body || body.result === undefined) throw new Error(`Qdrant ${what} returned no result.`);
  return body.result;
}

export async function serverVersion(api: QdrantApi): Promise<string> {
  const res = await api.request('GET', '/');
  const version = (res.body as { version?: unknown } | null)?.version;
  if (res.status !== 200 || typeof version !== 'string') throw new Error('Qdrant did not report its version on GET /.');
  return version;
}

export async function listCollections(api: QdrantApi): Promise<string[]> {
  const names = result<{ collections: Array<{ name: string }> }>(await api.request('GET', '/collections'), 'GET /collections')
    .collections.map((c) => c.name);
  for (const name of names) {
    if (!COLLECTION_NAME.test(name)) throw new Error(`Refusing an unexpected collection name ${JSON.stringify(name)}.`);
  }
  return names.sort();
}

export async function readCollection(api: QdrantApi, name: string): Promise<CollectionRecord> {
  const info = result<{ status: string; optimizer_status: unknown; payload_schema?: unknown }>(
    await api.request('GET', `/collections/${name}`),
    `GET /collections/${name}`,
  );
  const count = result<{ count: number }>(
    await api.request('POST', `/collections/${name}/points/count`, { exact: true }),
    `count ${name}`,
  );
  return {
    points: count.count,
    status: info.status,
    optimizerStatus: typeof info.optimizer_status === 'string' ? info.optimizer_status : JSON.stringify(info.optimizer_status),
    payloadSchema: info.payload_schema ?? null,
  };
}

// ── Waits ──────────────────────────────────────────────────────

/** A hop container that exited: waiting longer cannot help. */
export class HopDiedError extends Error {}

async function waitReady(ctx: BaseContext, api: QdrantApi, label: string): Promise<void> {
  const deadline = ctx.monotonicMs() + ctx.timeouts.readyMs;
  for (;;) {
    try {
      if ((await api.request('GET', '/readyz')).status === 200) return;
    } catch (err) {
      if (err instanceof HopDiedError) throw err;
      /* not listening yet */
    }
    if (ctx.monotonicMs() >= deadline) throw new Error(`${label}: /readyz did not answer within ${ctx.timeouts.readyMs / 1000}s.`);
    await ctx.sleep(ctx.timeouts.pollMs);
  }
}

export type SettleReached = Record<string, { status: string; points: number; settledMs: number }>;

/**
 * THE SETTLE RULE, on every version (the source and each hop): every
 * collection has `optimizer_status: ok`, is not `red`, and — when `expected`
 * is given — holds EXACTLY the recorded number of points (exact count). Green
 * is NOT required: a 1.13 collection with a long optimization in flight stays
 * yellow for hours, which is what the upgrade exists to fix. The status each
 * collection reached and how long it took are RECORDED, never gating. The cap
 * (`--settle-minutes`; the 1.16 hop gets the migration budget) is the only
 * failure bound, measured on the monotonic clock.
 */
async function waitSettled(
  ctx: BaseContext,
  api: QdrantApi,
  version: string,
  collections: string[],
  expected?: Record<string, number>,
): Promise<{ settledMs: number; reached: SettleReached }> {
  const started = ctx.monotonicMs();
  const budget = version.startsWith(MIGRATION_MINOR) ? ctx.timeouts.migrationSettleMs : ctx.timeouts.settleMs;
  const reached: SettleReached = {};
  for (const name of collections) {
    for (;;) {
      const info = result<{ status: string; optimizer_status: unknown }>(
        await api.request('GET', `/collections/${name}`),
        `GET /collections/${name}`,
      );
      if (info.status === 'red') throw new Error(`Qdrant ${version}: collection ${name} is red (${JSON.stringify(info.optimizer_status)}).`);
      const points = expected ? (await readCollection(api, name)).points : -1;
      const countOk = !expected || points === expected[name];
      if (info.optimizer_status === 'ok' && countOk) {
        reached[name] = { status: info.status, points, settledMs: ctx.monotonicMs() - started };
        break;
      }
      const waited = ctx.monotonicMs() - started;
      if (waited >= budget) {
        const why = info.optimizer_status !== 'ok'
          ? `optimizer ${JSON.stringify(info.optimizer_status)}`
          : `${points} points where ${expected?.[name]} were recorded`;
        throw new Error(
          `Qdrant ${version}: ${name} did not settle within ${Math.round(budget / 60_000)} min ` +
            `(status ${info.status}, ${why}). A lasting count difference is data loss; an optimizer error ` +
            'needs the server log. Give a slow host longer with --settle-minutes <n>.',
        );
      }
      if (Math.floor(waited / 60_000) > Math.floor((waited - ctx.timeouts.pollMs) / 60_000)) {
        ctx.log(`Qdrant ${version}: ${name} not settled after ${Math.floor(waited / 60_000)} min (status ${info.status}); waiting (cap ${Math.round(budget / 60_000)} min)`);
      }
      await ctx.sleep(ctx.timeouts.pollMs);
    }
  }
  return { settledMs: ctx.monotonicMs() - started, reached };
}

/** Ready, the right version and collections, and settled by the rule above. */
async function verifyServer(
  ctx: BaseContext,
  api: QdrantApi,
  version: string,
  record: UpgradeRecord,
): Promise<{ collections: Record<string, CollectionRecord>; settledMs: number }> {
  await waitReady(ctx, api, `Qdrant ${version}`);
  const running = await serverVersion(api);
  if (running !== version) throw new Error(`Expected Qdrant ${version}, the server answers ${running}.`);
  const names = await listCollections(api);
  const expected = Object.keys(record.collections).sort();
  if (names.join(',') !== expected.join(',')) {
    throw new Error(`Qdrant ${version}: collections [${names.join(', ')}] differ from the recorded [${expected.join(', ')}].`);
  }
  const expectedPoints = Object.fromEntries(names.map((n) => [n, record.collections[n].points]));
  const { settledMs } = await waitSettled(ctx, api, version, names, expectedPoints);
  const collections: Record<string, CollectionRecord> = {};
  for (const name of names) collections[name] = await readCollection(api, name);
  ctx.log(`Qdrant ${version}: ready, counts match, settled in ${Math.round(settledMs / 1000)}s (${names.map((n) => `${n} ${collections[n].status}`).join(', ')})`);
  return { collections, settledMs };
}

// ── Docker primitives ──────────────────────────────────────────

export async function mustExec(ctx: Pick<BaseContext, 'exec'>, args: string[], what: string, opts?: ExecOptions, cmd = 'docker'): Promise<ExecResult> {
  const res = await ctx.exec(cmd, args, opts);
  if (res.code !== 0) throw new Error(`${what} failed (${cmd} exit ${res.code}): ${res.err.trim().split('\n').slice(-3).join(' | ')}`);
  return res;
}

function compose(ctx: UpgradeContext, args: string[], what: string): Promise<ExecResult> {
  // From the host folder with no `-f`: the only form that merges the override.
  return mustExec(ctx, ['compose', ...args], what, { cwd: ctx.neuralisDir });
}

export function hopContainerName(version: string): string {
  return `neuralis-qdrant-upgrade-${version.replace(/\./g, '-')}-${randomBytes(3).toString('hex')}`;
}

/**
 * Start `version` on the volume — no network, no host port, the key through
 * the env-file — run `check` against it, then stop it gracefully. The
 * container is removed on every path.
 */
async function withHopContainer<T>(
  ctx: UpgradeContext,
  volume: string,
  version: string,
  check: (api: QdrantApi, name: string) => Promise<T>,
): Promise<T> {
  const name = hopContainerName(version);
  return withKeyEnvFile(ctx.apiKey, async (envFile) => {
    liveHopContainers.add(name);
    try {
      await mustExec(
        ctx,
        ['run', '-d', '--name', name, '--network', 'none', '--env-file', envFile, '-v', `${volume}:/qdrant/storage`, qdrantImageRef(version)],
        `start Qdrant ${version}`,
      );
      const out = await check(aliveChecked(ctx, ctx.containerQdrant(name), name, version), name);
      // A graceful stop flushes the WAL before the next engine opens the storage.
      await mustExec(ctx, ['stop', '-t', '120', name], `stop Qdrant ${version}`);
      return out;
    } finally {
      await ctx.exec('docker', ['rm', '-f', name]);
      liveHopContainers.delete(name);
    }
  });
}

/** A failed request to a hop asks docker whether it still runs; an exited hop fails at once, with its log tail. */
function aliveChecked(ctx: BaseContext, api: QdrantApi, name: string, version: string): QdrantApi {
  return {
    async request(method, path, body) {
      try {
        return await api.request(method, path, body);
      } catch (err) {
        const state = await ctx.exec('docker', ['inspect', '-f', '{{.State.Running}} {{.State.ExitCode}}', name]);
        if (state.code === 0 && state.out.trim().startsWith('false')) {
          const logs = await ctx.exec('docker', ['logs', '--tail', '20', name]);
          throw new HopDiedError(
            `Qdrant ${version} exited (${state.out.trim()}): ${(logs.err || logs.out).trim().split('\n').slice(-5).join(' | ')}`,
          );
        }
        throw err;
      }
    },
    fetchSnapshot: (collection, snapshot, dest) => api.fetchSnapshot(collection, snapshot, dest),
  };
}

/** Nothing may run on a volume while its files are tarred or replaced. */
export async function assertVolumeIdle(ctx: Pick<BaseContext, 'exec'>, volume: string, what: string): Promise<void> {
  const running = (await mustExec(ctx, ['ps', '-q', '--filter', `volume=${volume}`], `check who runs on ${volume}`)).out.trim();
  if (running) {
    throw new Error(`Refusing to ${what}: ${volume} is in use by running container(s) ${running.split('\n').join(', ')}. Stop them first.`);
  }
}

export async function volumeBytes(ctx: Pick<BaseContext, 'exec'>, volume: string, image: string, allowEmpty = false): Promise<number> {
  const res = await mustExec(
    ctx,
    ['run', '--rm', '--network', 'none', '-v', `${volume}:/data:ro`, '--entrypoint', 'du', image, '-sb', '/data'],
    `measure ${volume}`,
  );
  const bytes = Number(res.out.trim().split(/\s+/)[0]);
  if (!Number.isFinite(bytes) || bytes < 0 || (bytes === 0 && !allowEmpty)) throw new Error(`Could not read the size of ${volume}.`);
  return bytes;
}

export async function coldTar(ctx: Pick<BaseContext, 'exec'>, volume: string, image: string, dest: string): Promise<number> {
  await assertVolumeIdle(ctx, volume, 'take the cold backup');
  // Streamed to a host file THIS process creates: operator-owned, 0600.
  await mustExec(
    ctx,
    ['run', '--rm', '--network', 'none', '-v', `${volume}:/data:ro`, '--entrypoint', 'tar', image, '-C', '/data', '-cf', '-', '.'],
    `cold backup of ${volume}`,
    { stdoutPath: dest },
  );
  await chmod(dest, 0o600);
  const bytes = (await stat(dest)).size;
  if (bytes === 0) throw new Error('The cold backup is empty.');
  return bytes;
}

export async function restoreTar(ctx: Pick<BaseContext, 'exec'>, volume: string, image: string, src: string): Promise<void> {
  await assertVolumeIdle(ctx, volume, 'restore the cold backup');
  await mustExec(
    ctx,
    [
      'run', '--rm', '-i', '--network', 'none', '-v', `${volume}:/data`, '--entrypoint', 'sh', image,
      '-c', 'find /data -mindepth 1 -delete && tar -C /data -xf -',
    ],
    `restore ${volume} from the cold backup`,
    { stdinPath: src },
  );
}

// ── Backups ────────────────────────────────────────────────────

export function backupRoot(neuralisHome: string): string {
  return join(neuralisHome, 'qdrant-backups');
}

async function makeBackupDir(ctx: BaseContext, kind: 'upgrade' | 'rehearsal'): Promise<string> {
  const root = backupRoot(ctx.neuralisHome);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const stamp = ctx.now().toISOString().replace(/[:.]/g, '-');
  const dir = join(root, `${stamp}-${kind}-${ctx.from}-to-${ctx.target}`);
  await mkdir(dir, { mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}

async function saveRecord(dir: string, record: UpgradeRecord): Promise<void> {
  const file = join(dir, 'record.json');
  await writeFile(file, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  await chmod(file, 0o600);
}

export async function loadRecord(dir: string): Promise<UpgradeRecord> {
  return JSON.parse(await readFile(join(dir, 'record.json'), 'utf-8')) as UpgradeRecord;
}

async function snapshotOut(ctx: BaseContext, api: QdrantApi, dir: string, record: UpgradeRecord): Promise<void> {
  const snapDir = join(dir, 'snapshots');
  await mkdir(snapDir, { mode: 0o700 });
  for (const collection of Object.keys(record.collections)) {
    const created = result<{ name: string }>(
      await api.request('POST', `/collections/${collection}/snapshots?wait=true`),
      `snapshot ${collection}`,
    );
    if (!SNAPSHOT_NAME.test(created.name)) throw new Error(`Refusing an unexpected snapshot name ${JSON.stringify(created.name)}.`);
    const dest = join(snapDir, `${collection}--${created.name}`);
    await api.fetchSnapshot(collection, created.name, dest);
    await chmod(dest, 0o600);
    const bytes = (await stat(dest)).size;
    // Retention: nothing stays inside Qdrant; the host copy is the only one.
    const removed = await api.request('DELETE', `/collections/${collection}/snapshots/${created.name}`);
    if (removed.status !== 200) {
      ctx.log(`WARNING: Qdrant kept snapshot ${created.name} (DELETE answered HTTP ${removed.status}); remove it inside Qdrant by hand`);
    }
    record.snapshots.push({ collection, file: dest, bytes, deletedInside: removed.status === 200 });
    ctx.log(`snapshot ${collection}: ${Math.round(bytes / 1e6)} MB → ${dest}`);
  }
}

/**
 * Retention: after a SUCCESSFUL run keep the newest `keep` backup dirs OF THAT KIND (each
 * holds a full cold tar + snapshots, ≈2× the storage). Never the current one;
 * a failed or rolled-back run prunes nothing.
 */
export async function pruneBackups(
  neuralisHome: string,
  keep: number,
  current: string,
  kind: 'upgrade' | 'rehearsal',
): Promise<string[]> {
  const root = backupRoot(neuralisHome);
  // Per kind: a rehearsal never evicts a real run's cold backup, and back.
  const dirs = (await readdir(root))
    .filter((d) => /^\d{4}-\d{2}-\d{2}T/.test(d) && d.includes(`-${kind}-`))
    .sort()
    .reverse();
  const doomed = dirs.slice(Math.max(keep, 1)).map((d) => join(root, d)).filter((d) => d !== current);
  for (const dir of doomed) await rm(dir, { recursive: true, force: true });
  return doomed;
}

// ── The procedure ──────────────────────────────────────────────

/**
 * The source server, BEFORE the app stops: ready, the recorded version, and
 * settled by the rule (no count to compare yet) — so the app is down only for
 * the part of the run that needs it.
 */
async function checkSource(ctx: BaseContext, api: QdrantApi): Promise<string[]> {
  await waitReady(ctx, api, `Qdrant ${ctx.from}`);
  const running = await serverVersion(api);
  if (running !== ctx.from) {
    throw new Error(`The recorded version is ${ctx.from}, but the server answers ${running}. Nothing was changed.`);
  }
  const names = await listCollections(api);
  await waitSettled(ctx, api, ctx.from, names);
  return names;
}

/**
 * With NO writer (the app is stopped; a rehearsal clone has none): the exact
 * counts recorded here are the oracle every hop must reproduce.
 */
async function recordCounts(ctx: BaseContext, api: QdrantApi, names: string[], record: UpgradeRecord): Promise<void> {
  for (const name of names) record.collections[name] = await readCollection(api, name);
  ctx.log(`recorded ${names.length} collection(s): ${names.map((n) => `${n}=${record.collections[n].points} (${record.collections[n].status})`).join(', ')}`);
}

export async function checkDisk(
  ctx: Pick<BaseContext, 'freeBytes' | 'log'>,
  bytes: number,
  dir: string,
  factor = 2,
  what = 'the snapshots and the cold backup',
): Promise<void> {
  const free = await ctx.freeBytes(dir);
  ctx.log(`storage ${Math.round(bytes / 1e6)} MB, free ${Math.round(free / 1e6)} MB in ${dir}`);
  if (free < factor * bytes) {
    throw new Error(`Needs ${Math.round((factor * bytes) / 1e6)} MB free for ${what}; ${Math.round(free / 1e6)} MB is. Nothing was changed.`);
  }
}

/**
 * Every hop image is local before anything stops: a pull that fails mid-chain
 * (registry down, a broken credential helper) would otherwise cost a rollback
 * and the app's downtime.
 */
async function ensureImages(ctx: BaseContext, versions: string[]): Promise<void> {
  for (const version of versions) {
    const ref = qdrantImageRef(version);
    if ((await ctx.exec('docker', ['image', 'inspect', ref])).code === 0) continue;
    ctx.log(`pulling ${ref}`);
    await mustExec(ctx, ['pull', ref], `pull ${ref} — nothing was changed`);
  }
}

export type UpgradeOutcome = { result: UpgradeRecord['result']; backupDir: string; record: UpgradeRecord };

/** Real run (docker mode) or rehearsal on a cloned volume. */
export async function runDockerUpgrade(ctx: UpgradeContext): Promise<UpgradeOutcome> {
  try {
    return await dockerUpgrade(ctx);
  } finally {
    activeRun = null;
  }
}

async function dockerUpgrade(ctx: UpgradeContext): Promise<UpgradeOutcome> {
  const chain = qdrantUpgradeChain(ctx.from, ctx.target);
  if (chain.length === 0) throw new Error(`Qdrant is already at ${ctx.target}.`);
  const liveVolume = qdrantVolumeName(ctx.composeProject);
  const volume = ctx.rehearseVolume ?? liveVolume;
  if (ctx.rehearseVolume) await assertRehearsalVolume(ctx, ctx.rehearseVolume, liveVolume);
  else await mustExec(ctx, ['volume', 'inspect', volume], `find the ${volume} volume`);

  const dir = await makeBackupDir(ctx, ctx.rehearseVolume ? 'rehearsal' : 'upgrade');
  const record: UpgradeRecord = {
    startedAt: ctx.now().toISOString(),
    rehearsal: ctx.rehearseVolume !== null,
    volume,
    from: ctx.from,
    target: ctx.target,
    chain,
    collections: {},
    snapshots: [],
    coldTar: null,
    hops: [],
    result: 'running',
  };
  const run = beginRun({ dir, record, mode: 'docker', rehearseVolume: ctx.rehearseVolume });
  // The backup dir is never left empty: an early failure or a signal still finds a record.
  await saveRecord(dir, record);
  ctx.log(`plan: ${[ctx.from, ...chain].join(' → ')} on ${volume}; backups in ${dir}`);

  // 1: the disk check changes nothing.
  try {
    await checkDisk(ctx, await volumeBytes(ctx, volume, qdrantImageRef(ctx.from)), dir);
    await ensureImages(ctx, chain);
  } catch (err) {
    record.result = 'failed';
    record.error = (err as Error).message;
    await saveRecord(dir, record);
    throw err;
  }

  // 2–3: the source settles while the app still runs; THEN the app stops, so
  // nothing writes while the counts every hop must reproduce are recorded; the
  // snapshots come from that same quiet server. A failure before the cold
  // backup restarts the unchanged stack.
  run.phase = 'recording';
  try {
    if (ctx.rehearseVolume) {
      await withHopContainer(ctx, volume, ctx.from, async (api) => {
        await recordCounts(ctx, api, await checkSource(ctx, api), record);
        await snapshotOut(ctx, api, dir, record);
      });
    } else {
      const api = ctx.liveQdrant();
      const names = await checkSource(ctx, api);
      await compose(ctx, ['stop', 'neuralis'], 'stop the app');
      run.appStopped = true;
      await recordCounts(ctx, api, names, record);
      await snapshotOut(ctx, api, dir, record);
    }
  } catch (err) {
    record.result = 'failed';
    record.error = (err as Error).message;
    if (run.appStopped) {
      await compose(ctx, ['up', '-d'], 'restart the unchanged stack').catch(() => undefined);
      record.error += ' The app was restarted; nothing was changed.';
    }
    await saveRecord(dir, record);
    throw new Error(record.error);
  }
  await saveRecord(dir, record);

  // 4: from here on a failure restores the cold backup.
  let stateAdvanced = false;
  try {
    run.phase = 'backup';
    if (!ctx.rehearseVolume) await compose(ctx, ['stop', 'qdrant'], 'stop Qdrant');
    const tarFile = join(dir, 'qdrant-data.tar');
    record.coldTar = { file: tarFile, bytes: await coldTar(ctx, volume, qdrantImageRef(ctx.from), tarFile) };
    await saveRecord(dir, record);
    ctx.log(`cold backup: ${Math.round(record.coldTar.bytes / 1e6)} MB → ${tarFile}`);

    // 5: every hop but the last is a throwaway container (all of them in a rehearsal).
    run.phase = 'hops';
    const containerHops = ctx.rehearseVolume ? chain : chain.slice(0, -1);
    for (const version of containerHops) {
      ctx.log(`hop → ${version}`);
      const hop = await withHopContainer(ctx, volume, version, (api) => verifyServer(ctx, api, version, record));
      record.hops.push({ version, ...hop });
      await saveRecord(dir, record);
    }

    if (ctx.rehearseVolume) {
      record.result = 'rehearsed';
      await saveRecord(dir, record);
      return { result: record.result, backupDir: dir, record };
    }

    // 6: the final hop is the stack itself, on the regenerated compose.
    const statePath = qdrantStatePath(ctx.neuralisHome);
    const before = await readQdrantState(statePath);
    run.phase = 'final';
    await writeQdrantState(statePath, nextState(ctx.target, before?.version ?? ctx.from, 'upgrade', ctx.now()));
    stateAdvanced = true;
    await regenerateCompose(ctx);
    await compose(ctx, ['up', '-d', 'qdrant'], `start Qdrant ${ctx.target}`);
    const final = await verifyServer(ctx, ctx.liveQdrant(), ctx.target, record);
    record.hops.push({ version: ctx.target, ...final });
    await compose(ctx, ['up', '-d'], 'start the app');
    record.result = 'upgraded';
    await saveRecord(dir, record);
    return { result: record.result, backupDir: dir, record };
  } catch (err) {
    record.error = (err as Error).message;
    ctx.log(`FAILED: ${record.error}`);
    if (!record.coldTar) {
      // The stop may have happened; nothing was written to the storage yet.
      if (!ctx.rehearseVolume) await compose(ctx, ['up', '-d'], 'restart the unchanged stack').catch(() => undefined);
      record.result = 'failed';
      await saveRecord(dir, record);
      throw err;
    }
    ctx.log('rolling back to the cold backup');
    try {
      await rollbackDocker(ctx, record, dir, stateAdvanced);
    } catch (rollbackErr) {
      record.result = 'failed';
      record.error += ` | ROLLBACK FAILED: ${(rollbackErr as Error).message}`;
      await saveRecord(dir, record);
      throw new Error(`${record.error}\n  The cold backup is intact: ${record.coldTar.file}. Re-run with --rollback ${dir}.`);
    }
    record.result = 'rolled-back';
    await saveRecord(dir, record);
    throw new Error(`${record.error}\n  Rolled back: Qdrant ${ctx.from} is running on the restored storage. Backup: ${dir}`);
  }
}

function nextState(version: string, previous: string, source: QdrantState['source'], now: Date): QdrantState {
  return { version, previous, source, recordedAt: now.toISOString() };
}

async function regenerateCompose(ctx: UpgradeContext): Promise<void> {
  // Through setup's own generator — the compose file is never hand-edited.
  const res = await ctx.exec(process.execPath, ['--import', 'tsx', 'scripts/setup.mts', '--compose-only'], { cwd: ctx.neuralisDir });
  if (res.code !== 0) throw new Error(`Regenerating compose failed: ${res.err.trim() || res.out.trim()}`);
}

async function assertRehearsalVolume(ctx: UpgradeContext, clone: string, liveVolume: string): Promise<void> {
  if (clone === liveVolume) throw new Error(`--rehearse needs a CLONE; ${clone} is the live volume.`);
  await mustExec(ctx, ['volume', 'inspect', clone], `find the ${clone} volume`);
  const users = (await mustExec(ctx, ['ps', '-a', '-q', '--filter', `volume=${clone}`], `check who uses ${clone}`)).out.trim();
  if (users) throw new Error(`${clone} is attached to a container (${users.split('\n').join(', ')}); a rehearsal needs it unused.`);
}

/**
 * Restore the cold backup onto the volume and bring back `record.from`.
 * Real run: the recorded version returns to `from` (when it had advanced),
 * compose is regenerated and the stack restarted. Rehearsal: the clone is
 * restored and verified with a throwaway container.
 */
export async function rollbackDocker(ctx: UpgradeContext, record: UpgradeRecord, dir: string, stateAdvanced: boolean): Promise<void> {
  if (!record.coldTar) throw new Error(`${dir} holds no cold backup; nothing to restore.`);
  const fromImage = qdrantImageRef(record.from);
  if (record.rehearsal) {
    await restoreTar(ctx, record.volume, fromImage, record.coldTar.file);
    await withHopContainer(ctx, record.volume, record.from, (api) => verifyServer(ctx, api, record.from, record));
    return;
  }
  await ctx.exec('docker', ['compose', 'stop', 'neuralis', 'qdrant'], { cwd: ctx.neuralisDir });
  await restoreTar(ctx, record.volume, fromImage, record.coldTar.file);
  if (stateAdvanced) {
    const statePath = qdrantStatePath(ctx.neuralisHome);
    const current = await readQdrantState(statePath);
    await writeQdrantState(statePath, nextState(record.from, current?.version ?? record.target, 'rollback', ctx.now()));
    await regenerateCompose(ctx);
  }
  await compose(ctx, ['up', '-d', 'qdrant'], `start Qdrant ${record.from}`);
  await verifyServer(ctx, ctx.liveQdrant(), record.from, record);
  await compose(ctx, ['up', '-d'], 'start the app');
}

/** `--rollback <dir>`: restore a finished run's backup on operator request. */
export async function runDockerRollback(ctx: UpgradeContext, dir: string): Promise<UpgradeOutcome> {
  const record = await loadRecord(dir);
  if (record.rehearsal !== (ctx.rehearseVolume !== null) || (ctx.rehearseVolume && ctx.rehearseVolume !== record.volume)) {
    throw new Error(`${dir} is a ${record.rehearsal ? `rehearsal on ${record.volume}` : 'real run'} backup; pass the matching mode.`);
  }
  const state = await readQdrantState(qdrantStatePath(ctx.neuralisHome));
  const advanced = !record.rehearsal && state?.version !== record.from;
  await rollbackDocker(ctx, record, dir, advanced);
  record.result = 'restored';
  await saveRecord(dir, record);
  return { result: record.result, backupDir: dir, record };
}

// ── Binary mode ────────────────────────────────────────────────

export type BinaryPorts = {
  /** Download + sha256-verify the pinned release into `destDir`; the binary's path. */
  download(version: string, destDir: string): Promise<string>;
  /** Start a hop server on the storage, loopback only, the key in its spawn env. */
  startHop(binaryPath: string, storageDir: string): Promise<{ stop(): Promise<void> }>;
  /** Stop / start the managed server (`<bin>/qdrant`, its pid file). */
  stopManaged(): Promise<void>;
  startManaged(): Promise<void>;
  /** The app runs natively or in compose; the CLI knows which. */
  stopApp(): Promise<void>;
  startApp(): Promise<void>;
};

export type BinaryContext = BaseContext & {
  storageDir: string;
  binDir: string;
  binary: BinaryPorts;
};

async function waitDown(ctx: BaseContext, api: QdrantApi): Promise<void> {
  const deadline = ctx.monotonicMs() + ctx.timeouts.readyMs;
  for (;;) {
    try {
      await api.request('GET', '/readyz');
    } catch {
      return;
    }
    if (ctx.monotonicMs() >= deadline) throw new Error('Qdrant is still answering after the stop.');
    await ctx.sleep(ctx.timeouts.pollMs);
  }
}

/** Binary mode: stop the PID → tar the storage dir → sha256-verified binaries per hop. */
export async function runBinaryUpgrade(ctx: BinaryContext): Promise<UpgradeOutcome> {
  try {
    return await binaryUpgrade(ctx);
  } finally {
    activeRun = null;
  }
}

async function binaryUpgrade(ctx: BinaryContext): Promise<UpgradeOutcome> {
  const chain = qdrantUpgradeChain(ctx.from, ctx.target);
  if (chain.length === 0) throw new Error(`Qdrant is already at ${ctx.target}.`);
  const dir = await makeBackupDir(ctx, 'upgrade');
  const record: UpgradeRecord = {
    startedAt: ctx.now().toISOString(),
    rehearsal: false,
    volume: ctx.storageDir,
    from: ctx.from,
    target: ctx.target,
    chain,
    collections: {},
    snapshots: [],
    coldTar: null,
    hops: [],
    result: 'running',
  };
  const run = beginRun({ dir, record, mode: 'binary', rehearseVolume: null });
  await saveRecord(dir, record);
  ctx.log(`plan: ${[ctx.from, ...chain].join(' → ')} on ${ctx.storageDir}; backups in ${dir}`);

  // The source settles with the app running; the app stops BEFORE the counts
  // are recorded: they are the exact oracle of every hop.
  try {
    const du = await mustExec(ctx, ['-sb', ctx.storageDir], `measure ${ctx.storageDir}`, undefined, 'du');
    await checkDisk(ctx, Number(du.out.trim().split(/\s+/)[0]), dir);
    run.phase = 'recording';
    const names = await checkSource(ctx, ctx.liveQdrant());
    await ctx.binary.stopApp();
    run.appStopped = true;
    await recordCounts(ctx, ctx.liveQdrant(), names, record);
    await snapshotOut(ctx, ctx.liveQdrant(), dir, record);
  } catch (err) {
    record.result = 'failed';
    record.error = (err as Error).message;
    if (run.appStopped) await ctx.binary.startApp().catch(() => undefined);
    await saveRecord(dir, record);
    throw err;
  }
  await saveRecord(dir, record);

  let stateAdvanced = false;
  try {
    run.phase = 'backup';
    await ctx.binary.stopManaged();
    await waitDown(ctx, ctx.liveQdrant());
    const tarFile = join(dir, 'qdrant-storage.tar');
    await mustExec(ctx, ['-C', ctx.storageDir, '-cf', tarFile, '.'], 'cold backup of the storage dir', undefined, 'tar');
    await chmod(tarFile, 0o600);
    record.coldTar = { file: tarFile, bytes: (await stat(tarFile)).size };
    const previousBinary = join(dir, `qdrant-${ctx.from}`);
    await copyFile(join(ctx.binDir, 'qdrant'), previousBinary);
    await chmod(previousBinary, 0o700);
    await saveRecord(dir, record);

    run.phase = 'hops';
    for (const version of chain) {
      const binary = await ctx.binary.download(version, join(ctx.binDir, 'versions', version));
      ctx.log(`hop → ${version}`);
      if (version !== ctx.target) {
        const hop = await ctx.binary.startHop(binary, ctx.storageDir);
        try {
          record.hops.push({ version, ...(await verifyServer(ctx, ctx.liveQdrant(), version, record)) });
        } finally {
          await hop.stop();
        }
        await saveRecord(dir, record);
        continue;
      }
      const staged = join(ctx.binDir, `qdrant.${version}.tmp`);
      await copyFile(binary, staged);
      await chmod(staged, 0o755);
      await rename(staged, join(ctx.binDir, 'qdrant'));
      const statePath = qdrantStatePath(ctx.neuralisHome);
      const before = await readQdrantState(statePath);
      run.phase = 'final';
      await writeQdrantState(statePath, nextState(ctx.target, before?.version ?? ctx.from, 'upgrade', ctx.now()));
      stateAdvanced = true;
      await ctx.binary.startManaged();
      record.hops.push({ version, ...(await verifyServer(ctx, ctx.liveQdrant(), version, record)) });
    }
    await ctx.binary.startApp();
    record.result = 'upgraded';
    await saveRecord(dir, record);
    return { result: record.result, backupDir: dir, record };
  } catch (err) {
    record.error = (err as Error).message;
    ctx.log(`FAILED: ${record.error}`);
    if (record.coldTar) {
      ctx.log('rolling back to the cold backup');
      try {
        await rollbackBinary(ctx, record, dir, stateAdvanced);
        record.result = 'rolled-back';
      } catch (rollbackErr) {
        record.result = 'failed';
        record.error += ` | ROLLBACK FAILED: ${(rollbackErr as Error).message}`;
        await saveRecord(dir, record);
        throw new Error(`${record.error}\n  The cold backup is intact: ${record.coldTar.file}. Re-run with --rollback ${dir}.`);
      }
    } else {
      await ctx.binary.startManaged().catch(() => undefined);
      record.result = 'failed';
    }
    if (run.appStopped) await ctx.binary.startApp().catch(() => undefined);
    await saveRecord(dir, record);
    throw record.result === 'rolled-back'
      ? new Error(`${record.error}\n  Rolled back: Qdrant ${ctx.from} is running on the restored storage. Backup: ${dir}`)
      : err;
  }
}

export async function rollbackBinary(ctx: BinaryContext, record: UpgradeRecord, dir: string, stateAdvanced: boolean): Promise<void> {
  if (!record.coldTar) throw new Error(`${dir} holds no cold backup; nothing to restore.`);
  await ctx.binary.stopManaged().catch(() => undefined);
  await waitDown(ctx, ctx.liveQdrant());
  for (const entry of await readdir(ctx.storageDir)) await rm(join(ctx.storageDir, entry), { recursive: true, force: true });
  await mustExec(ctx, ['-C', ctx.storageDir, '-xf', record.coldTar.file], 'restore the storage dir', undefined, 'tar');
  await copyFile(join(dir, `qdrant-${record.from}`), join(ctx.binDir, 'qdrant'));
  await chmod(join(ctx.binDir, 'qdrant'), 0o755);
  if (stateAdvanced) {
    const statePath = qdrantStatePath(ctx.neuralisHome);
    const current = await readQdrantState(statePath);
    await writeQdrantState(statePath, nextState(record.from, current?.version ?? record.target, 'rollback', ctx.now()));
  }
  await ctx.binary.startManaged();
  await verifyServer(ctx, ctx.liveQdrant(), record.from, record);
}

// ── Transports ─────────────────────────────────────────────────

/**
 * HTTP/1.0 over bash's /dev/tcp INSIDE a hop container, which has no network
 * and no published port. The key is expanded from the container's own env
 * inside bash (a builtin `printf`, so no process argv carries it); the
 * `docker exec` argv carries only the method, path and body.
 */
export const CONTAINER_HTTP_SCRIPT = [
  'exec 3<>/dev/tcp/127.0.0.1/6333 || exit 97',
  `printf '%s %s HTTP/1.0\\r\\nHost: localhost\\r\\napi-key: %s\\r\\nContent-Type: application/json\\r\\nContent-Length: %s\\r\\n\\r\\n%s' "$1" "$2" "$QDRANT__SERVICE__API_KEY" "\${#3}" "$3" >&3`,
  'cat <&3',
].join('\n');

export function parseRawHttp(raw: string): QdrantResponse {
  const split = raw.indexOf('\r\n\r\n');
  const head = split >= 0 ? raw.slice(0, split) : raw;
  const status = Number(head.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/)?.[1]);
  if (!Number.isFinite(status)) throw new Error('No HTTP status line from the hop container.');
  const text = split >= 0 ? raw.slice(split + 4) : '';
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status, body };
}

export function containerQdrantApi(exec: Exec, container: string): QdrantApi {
  return {
    async request(method, path, body) {
      const res = await exec('docker', [
        'exec', container, 'bash', '-c', CONTAINER_HTTP_SCRIPT, 'qdrant-http', method, path, body === undefined ? '' : JSON.stringify(body),
      ]);
      if (res.code !== 0) throw new Error(`${method} ${path} in ${container}: exit ${res.code}`);
      return parseRawHttp(res.out);
    },
    async fetchSnapshot(collection, name, dest) {
      const res = await exec('docker', ['cp', `${container}:/qdrant/snapshots/${collection}/${name}`, dest]);
      if (res.code !== 0) throw new Error(`copying snapshot ${name} out of ${container} failed: ${res.err.trim()}`);
    },
  };
}

/** The managed server on the host's loopback; the key rides a header in-process. */
export function hostQdrantApi(baseUrl: string, apiKey: string): QdrantApi {
  const url = baseUrl.replace(/\/+$/, '');
  const headers = { 'api-key': apiKey, 'content-type': 'application/json' };
  return {
    async request(method, path, body) {
      const res = await fetch(`${url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      let parsed: unknown = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
      return { status: res.status, body: parsed };
    },
    async fetchSnapshot(collection, name, dest) {
      const res = await fetch(`${url}/collections/${collection}/snapshots/${name}`, { headers });
      if (res.status !== 200 || !res.body) throw new Error(`downloading snapshot ${name} answered HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(dest, { mode: 0o600 }));
    },
  };
}
