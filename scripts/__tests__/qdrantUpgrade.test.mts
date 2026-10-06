/**
 * `pnpm neuralis:qdrant-upgrade` against a fake Docker world: every hop is a
 * digest-pinned, network-less `docker run` in chain order; the key reaches it
 * only through a 0600 env-file that is gone on every exit path; a failure after
 * the stop restores the cold backup and the previous recorded version; a
 * rehearsal never touches compose, the state file or the live volume.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { qdrantImageRef, qdrantStatePath, readQdrantState, writeQdrantState } from '../setup/qdrantVersion.mts';
import { qdrantBinarySpawn } from '../setup/services.mts';
import {
  CONTAINER_HTTP_SCRIPT,
  abortActiveRun,
  cleanupOnExit,
  containerQdrantApi,
  liveHops,
  parseRawHttp,
  pruneBackups,
  runDockerRollback,
  runDockerUpgrade,
  withKeyEnvFile,
  type Exec,
  type QdrantApi,
  type UpgradeContext,
} from '../qdrant-upgrade/upgrade.mts';

const KEY = 'test-key-4f1c9a';

/** Every temp dir a row creates, including the key env-file dirs a mutation may leave behind. */
const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const COLLECTION = 'neuralis_mcp_nodes';
const POINTS = 198_241;

type World = {
  volumes: Map<string, string>; // volume → storage version
  containers: Map<string, { version: string; volume: string; running: boolean }>;
  live: { running: boolean; version: string };
  /** The app WRITES while it runs: every count it is asked for is one higher. */
  app: { running: boolean; writes: number };
  calls: string[][];
  envFiles: Array<{ path: string; mode: number; content: string }>;
  /** A server at this version reports one point fewer. */
  lossAt?: string;
  /** The live collection's status (default green). */
  liveStatus?: string;
  /** The live collection answers an optimizer ERROR for this many GETs (Infinity = always). */
  liveOptimizerErrors?: number;
  /** A hop at this version exits at once. */
  dieAt?: string;
  /** A foreign container runs on this volume. */
  squatter?: string;
  /** The restore command fails. */
  restoreFails?: boolean;
  /** Snapshot DELETE answers this status. */
  snapshotDeleteStatus?: number;
  freeBytes: number;
};

function versionOfImage(image: string): string {
  const m = image.match(/^qdrant\/qdrant:v(\d+\.\d+\.\d+)@sha256:[0-9a-f]{64}$/);
  if (!m) throw new Error(`unpinned image ${image}`);
  return m[1];
}

function fakeServer(world: World, version: () => string, opts: { live: boolean; alive?: () => boolean }): QdrantApi {
  return {
    async request(method, path) {
      if (opts.alive && !opts.alive()) throw new Error('exit 1: container is not running');
      const v = version();
      if (path === '/') return { status: 200, body: { version: v } };
      if (path === '/readyz') return { status: 200, body: null };
      if (path === '/collections') return { status: 200, body: { result: { collections: [{ name: COLLECTION }] } } };
      if (path === `/collections/${COLLECTION}` && method === 'GET') {
        const status = opts.live ? world.liveStatus ?? 'green' : 'green';
        let optimizer: unknown = 'ok';
        if (opts.live && (world.liveOptimizerErrors ?? 0) > 0) {
          world.liveOptimizerErrors = (world.liveOptimizerErrors ?? 0) - 1;
          optimizer = { error: 'Service internal error: segment optimizer failed' };
        }
        return { status: 200, body: { result: { status, optimizer_status: optimizer, payload_schema: { projectId: { data_type: 'keyword' } } } } };
      }
      if (path.endsWith('/points/count')) {
        if (opts.live && world.app.running) world.app.writes += 1;
        return { status: 200, body: { result: { count: POINTS + world.app.writes - (world.lossAt === v ? 1 : 0) } } };
      }
      if (path.includes('/snapshots?wait=true')) return { status: 200, body: { result: { name: `${COLLECTION}-snap.snapshot` } } };
      if (method === 'DELETE') return { status: world.snapshotDeleteStatus ?? 200, body: { result: true } };
      if (method === 'PATCH') return { status: 200, body: { result: true } };
      return { status: 404, body: null };
    },
    async fetchSnapshot(_collection, _name, dest) {
      writeFileSync(dest, 'SNAPSHOT');
    },
  };
}

type SetupOpts = {
  rehearse?: string;
  lossAt?: string;
  freeBytes?: number;
  stateVersion?: string;
  liveStatus?: string;
  liveOptimizerErrors?: number;
  dieAt?: string;
  squatter?: string;
  restoreFails?: boolean;
  snapshotDeleteStatus?: number;
};

function setup(opts: SetupOpts = {}) {
  const home = tempDir('neuralis-upgrade-home-');
  const world: World = {
    volumes: new Map([['neuralis_qdrant-data', '1.13.6'], ['neuralis_qdrant-clone', '1.13.6']]),
    containers: new Map(),
    live: { running: true, version: '1.13.6' },
    app: { running: true, writes: 0 },
    calls: [],
    envFiles: [],
    lossAt: opts.lossAt,
    liveStatus: opts.liveStatus,
    liveOptimizerErrors: opts.liveOptimizerErrors,
    dieAt: opts.dieAt,
    squatter: opts.squatter,
    restoreFails: opts.restoreFails,
    snapshotDeleteStatus: opts.snapshotDeleteStatus,
    freeBytes: opts.freeBytes ?? 100e9,
  };
  const runningOn = (volume: string): string[] => [
    ...[...world.containers].filter(([, c]) => c.running && c.volume === volume).map(([n]) => n),
    ...(world.live.running && volume === 'neuralis_qdrant-data' ? ['neuralis-qdrant-1'] : []),
    ...(world.squatter === volume ? ['squatter'] : []),
  ];
  const exec: Exec = async (cmd, args, o = {}) => {
    world.calls.push([cmd, ...args]);
    if (cmd === process.execPath) return { code: 0, out: '', err: '' }; // setup --compose-only
    const [verb, ...rest] = args;
    if (verb === 'volume' && rest[0] === 'inspect') {
      return world.volumes.has(rest[1]) ? { code: 0, out: '[]', err: '' } : { code: 1, out: '', err: 'no such volume' };
    }
    if (verb === 'ps') {
      if (rest.includes('-a')) return { code: 0, out: '', err: '' };
      const volume = rest[rest.indexOf('--filter') + 1].replace('volume=', '');
      return { code: 0, out: runningOn(volume).join('\n'), err: '' };
    }
    if (verb === 'compose') {
      if (rest[0] === 'stop') {
        if (rest.includes('neuralis')) world.app.running = false;
        if (rest.includes('qdrant')) world.live.running = false;
      }
      if (rest[0] === 'up') {
        world.live.running = true;
        if (rest.length === 2) world.app.running = true; // `up -d` = the whole stack
        const state = await readQdrantState(qdrantStatePath(home));
        world.live.version = state?.version ?? world.live.version;
        world.volumes.set('neuralis_qdrant-data', world.live.version);
      }
      return { code: 0, out: '', err: '' };
    }
    if (verb === 'run' && rest[0] === '--rm') {
      const vol = rest[rest.indexOf('-v') + 1].split(':')[0];
      if (rest.includes('du')) return { code: 0, out: '3600000000\t/data\n', err: '' };
      if (rest.includes('tar')) {
        writeFileSync(o.stdoutPath!, `TAR:${world.volumes.get(vol)}`);
        return { code: 0, out: '', err: '' };
      }
      if (rest.includes('sh')) {
        if (world.restoreFails) return { code: 1, out: '', err: 'tar: short read' };
        world.volumes.set(vol, readFileSync(o.stdinPath!, 'utf-8').replace('TAR:', ''));
        return { code: 0, out: '', err: '' };
      }
    }
    if (verb === 'run' && rest[0] === '-d') {
      const envFile = rest[rest.indexOf('--env-file') + 1];
      world.envFiles.push({ path: envFile, mode: statSync(envFile).mode & 0o777, content: readFileSync(envFile, 'utf-8') });
      tmpDirs.push(dirname(envFile));
      const name = rest[rest.indexOf('--name') + 1];
      const volume = rest[rest.indexOf('-v') + 1].split(':')[0];
      const version = versionOfImage(rest.at(-1)!);
      world.containers.set(name, { version, volume, running: world.dieAt !== version });
      world.volumes.set(volume, version); // the engine migrates the storage in place
      return { code: 0, out: 'cid\n', err: '' };
    }
    if (verb === 'inspect') {
      const c = world.containers.get(rest.at(-1)!);
      return c ? { code: 0, out: c.running ? 'true 0\n' : 'false 101\n', err: '' } : { code: 1, out: '', err: 'no such object' };
    }
    if (verb === 'logs') return { code: 0, out: '', err: 'Error: storage format\n' };
    if (verb === 'stop') {
      const c = world.containers.get(rest.at(-1)!);
      if (c) c.running = false;
      return { code: 0, out: '', err: '' };
    }
    if (verb === 'rm') {
      world.containers.delete(rest.at(-1)!);
      return { code: 0, out: '', err: '' };
    }
    return { code: 0, out: '', err: '' };
  };
  let clock = Date.parse('2026-09-25T02:00:00Z');
  let mono = 0;
  /** A host suspend: the wall clock jumps, the monotonic clock does not. */
  const suspend = (ms: number): void => { clock += ms; };
  const ctx: UpgradeContext = {
    neuralisHome: home,
    neuralisDir: home,
    composeProject: 'neuralis',
    apiKey: KEY,
    from: opts.stateVersion ?? '1.13.6',
    target: '1.19.1',
    rehearseVolume: opts.rehearse ?? null,
    exec,
    liveQdrant: () => fakeServer(world, () => world.live.version, { live: true }),
    containerQdrant: (name) =>
      fakeServer(world, () => world.containers.get(name)!.version, { live: false, alive: () => world.containers.get(name)?.running ?? false }),
    freeBytes: async () => world.freeBytes,
    log: () => undefined,
    sleep: async (ms) => { clock += ms; mono += ms; },
    now: () => new Date(clock),
    monotonicMs: () => mono,
    timeouts: { readyMs: 60_000, settleMs: 600_000, migrationSettleMs: 600_000, pollMs: 5_000 },
  };
  return { home, world, ctx, suspend };
}

const hopImages = (world: World) => world.calls.filter((c) => c[1] === 'run' && c[2] === '-d').map((c) => versionOfImage(c.at(-1)!));

function assertNoKeyAnywhere(world: World): void {
  for (const call of world.calls) expect(call.join(' ')).not.toContain(KEY);
  for (const env of world.envFiles) {
    expect(env.mode).toBe(0o600);
    expect(env.content).toContain(`QDRANT__SERVICE__API_KEY=${KEY}`);
    expect(existsSync(env.path)).toBe(false);
  }
}

describe('the real run (docker mode)', () => {
  it('stops the APP before recording, then Qdrant before the cold backup, walks every intermediate minor, then lets compose run the target', async () => {
    const { home, world, ctx } = setup();
    await writeQdrantState(qdrantStatePath(home), { version: '1.13.6', previous: null, source: 'detected', recordedAt: 'x' });
    const out = await runDockerUpgrade(ctx);
    expect(out.result).toBe('upgraded');
    expect(hopImages(world)).toEqual(['1.14.1', '1.15.5', '1.16.3', '1.17.1', '1.18.3']);
    const stopApp = world.calls.findIndex((c) => c.join(' ') === 'docker compose stop neuralis');
    const snapshot = world.calls.findIndex((c) => c.join(' ') === 'docker compose stop qdrant');
    const stopAt = snapshot;
    const tarAt = world.calls.findIndex((c) => c.includes('tar') && c.includes('-cf'));
    expect(stopApp).toBeGreaterThan(-1);
    expect(stopApp).toBeLessThan(stopAt);
    // The counts were recorded with no writer: the app's writes never moved them.
    expect(out.record.collections[COLLECTION].points).toBe(POINTS);
    expect(out.record.snapshots.every((s) => s.deletedInside)).toBe(true);
    const firstHop = world.calls.findIndex((c) => c[2] === '-d');
    const regen = world.calls.findIndex((c) => c[0] === process.execPath && c.includes('--compose-only'));
    const upQdrant = world.calls.findIndex((c) => c.join(' ') === 'docker compose up -d qdrant');
    expect(stopAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(tarAt);
    expect(tarAt).toBeLessThan(firstHop);
    expect(firstHop).toBeLessThan(regen);
    expect(regen).toBeLessThan(upQdrant);
    for (const hop of world.calls.filter((c) => c[2] === '-d')) {
      expect(hop).toContain('--network');
      expect(hop[hop.indexOf('--network') + 1]).toBe('none');
      expect(hop).not.toContain('-p');
      expect(hop).not.toContain('--publish');
    }
    expect(await readQdrantState(qdrantStatePath(home))).toMatchObject({ version: '1.19.1', previous: '1.13.6', source: 'upgrade' });
    expect(world.calls.some((c) => c.includes('down'))).toBe(false);
    assertNoKeyAnywhere(world);
    const tar = out.record.coldTar!.file;
    expect(statSync(tar).mode & 0o777).toBe(0o600);
    expect(statSync(out.backupDir).mode & 0o777).toBe(0o700);
    expect(statSync(out.record.snapshots[0].file).mode & 0o777).toBe(0o600);
  });

  it('an app that writes while it runs cannot move the recorded counts — they are taken after it stops', async () => {
    const { home, world, ctx } = setup();
    await writeQdrantState(qdrantStatePath(home), { version: '1.13.6', previous: null, source: 'detected', recordedAt: 'x' });
    // A write happens before the command starts; the app keeps writing until stopped.
    world.app.writes = 7;
    const out = await runDockerUpgrade(ctx);
    expect(out.result).toBe('upgraded');
    expect(out.record.collections[COLLECTION].points).toBe(POINTS + 7);
    expect(out.record.hops.every((h) => h.collections[COLLECTION].points === POINTS + 7)).toBe(true);
  });

  it('a collection that stays YELLOW settles — green is not required, the reached status is recorded', async () => {
    const { home, world, ctx } = setup({ liveStatus: 'yellow' });
    await writeQdrantState(qdrantStatePath(home), { version: '1.13.6', previous: null, source: 'detected', recordedAt: 'x' });
    const out = await runDockerUpgrade(ctx);
    expect(out.result).toBe('upgraded');
    expect(out.record.collections[COLLECTION].status).toBe('yellow');
    expect(out.record.hops.map((h) => typeof h.settledMs)).toEqual(Array(6).fill('number'));
    expect(world.app.running).toBe(true);
  });

  it('an optimizer that never reports ok is refused at the cap — BEFORE the app was stopped', async () => {
    const { home, world, ctx } = setup({ liveOptimizerErrors: Number.POSITIVE_INFINITY });
    await writeQdrantState(qdrantStatePath(home), { version: '1.13.6', previous: null, source: 'detected', recordedAt: 'x' });
    await expect(runDockerUpgrade(ctx)).rejects.toThrow(/did not settle within 10 min[\s\S]*optimizer[\s\S]*--settle-minutes/);
    expect(world.calls.some((c) => c.join(' ') === 'docker compose stop neuralis')).toBe(false);
    expect(world.calls.some((c) => c.includes('tar'))).toBe(false);
    expect(world.app.running).toBe(true);
  });

  it('a host suspend (wall clock +7 h) does not fail a settle wait early — deadlines are monotonic', async () => {
    const { home, ctx, suspend } = setup({ liveOptimizerErrors: 60 });
    await writeQdrantState(qdrantStatePath(home), { version: '1.13.6', previous: null, source: 'detected', recordedAt: 'x' });
    const sleep = ctx.sleep;
    let jumped = false;
    ctx.sleep = async (ms) => {
      if (!jumped) { jumped = true; suspend(7 * 3_600_000); }
      await sleep(ms);
    };
    // 60 error polls × 5 s = 5 min of real waiting, inside the 10-min cap.
    expect((await runDockerUpgrade(ctx)).result).toBe('upgraded');
  });

  it('a hop that exits is reported at once with its log tail — no ten-minute readyz wait — and rolls back', async () => {
    const { home, world, ctx } = setup({ dieAt: '1.15.5' });
    await writeQdrantState(qdrantStatePath(home), { version: '1.13.6', previous: null, source: 'detected', recordedAt: 'x' });
    const started = ctx.now().getTime();
    await expect(runDockerUpgrade(ctx)).rejects.toThrow(/Qdrant 1\.15\.5 exited \(false 101\)[\s\S]*Rolled back/);
    expect(ctx.now().getTime() - started).toBeLessThan(ctx.timeouts.readyMs);
    expect(world.volumes.get('neuralis_qdrant-data')).toBe('1.13.6');
  });

  it('a snapshot Qdrant refuses to delete is reported, never silently kept', async () => {
    const lines: string[] = [];
    const { home, ctx } = setup({ snapshotDeleteStatus: 500 });
    ctx.log = (l) => lines.push(l);
    await writeQdrantState(qdrantStatePath(home), { version: '1.13.6', previous: null, source: 'detected', recordedAt: 'x' });
    const out = await runDockerUpgrade(ctx);
    expect(out.record.snapshots[0].deletedInside).toBe(false);
    expect(lines.some((l) => l.includes('WARNING: Qdrant kept snapshot'))).toBe(true);
  });

  it('a rollback that itself fails leaves the record FAILED with both reasons and the tar named', async () => {
    const { home, ctx } = setup({ lossAt: '1.14.1', restoreFails: true });
    await writeQdrantState(qdrantStatePath(home), { version: '1.13.6', previous: null, source: 'detected', recordedAt: 'x' });
    await expect(runDockerUpgrade(ctx)).rejects.toThrow(/ROLLBACK FAILED[\s\S]*cold backup is intact/);
    const dir = readdirSync(join(home, 'qdrant-backups'))[0];
    const record = JSON.parse(readFileSync(join(home, 'qdrant-backups', dir, 'record.json'), 'utf-8'));
    expect(record.result).toBe('failed');
    expect(record.error).toMatch(/198240 points where 198241 were recorded.*ROLLBACK FAILED/);
  });

  it('--rollback refuses to restore while any container runs on the volume', async () => {
    const { home, world, ctx } = setup();
    await writeQdrantState(qdrantStatePath(home), { version: '1.13.6', previous: null, source: 'detected', recordedAt: 'x' });
    const out = await runDockerUpgrade(ctx);
    world.squatter = 'neuralis_qdrant-data';
    await expect(runDockerRollback(ctx, out.backupDir)).rejects.toThrow(/Refusing to restore the cold backup: neuralis_qdrant-data is in use by running container\(s\) squatter/);
    expect(world.calls.some((c) => c.includes('sh') && c.includes('-i'))).toBe(false);
  });

  it('a hop that loses a point rolls back: cold backup restored, recorded version untouched, the old stack back up', async () => {
    const { home, world, ctx } = setup({ lossAt: '1.16.3' });
    await writeQdrantState(qdrantStatePath(home), { version: '1.13.6', previous: null, source: 'detected', recordedAt: 'x' });
    await expect(runDockerUpgrade(ctx)).rejects.toThrow(/1\.16\.3: neuralis_mcp_nodes did not settle[\s\S]*198240 points where 198241 were recorded[\s\S]*Rolled back/);
    expect(hopImages(world)).toEqual(['1.14.1', '1.15.5', '1.16.3']);
    expect(world.volumes.get('neuralis_qdrant-data')).toBe('1.13.6');
    expect(world.calls.some((c) => c.includes('sh') && c.includes('-i'))).toBe(true);
    expect(await readQdrantState(qdrantStatePath(home))).toMatchObject({ version: '1.13.6', source: 'detected' });
    expect(world.live).toEqual({ running: true, version: '1.13.6' });
    expect(world.containers.size).toBe(0);
    assertNoKeyAnywhere(world);
  });

  it('a failure at the FINAL hop also returns the recorded version to the previous one', async () => {
    const { home, world, ctx } = setup({ lossAt: '1.19.1' });
    await writeQdrantState(qdrantStatePath(home), { version: '1.13.6', previous: null, source: 'detected', recordedAt: 'x' });
    await expect(runDockerUpgrade(ctx)).rejects.toThrow(/Rolled back/);
    expect(await readQdrantState(qdrantStatePath(home))).toMatchObject({ version: '1.13.6', previous: '1.19.1', source: 'rollback' });
    expect(world.calls.filter((c) => c.includes('--compose-only'))).toHaveLength(2);
    expect(world.live.version).toBe('1.13.6');
  });

  it('too little free disk refuses BEFORE anything is stopped', async () => {
    const { world, ctx } = setup({ freeBytes: 5e9 });
    await expect(runDockerUpgrade(ctx)).rejects.toThrow(/Needs .* MB free/);
    expect(world.calls.some((c) => c[1] === 'compose')).toBe(false);
    expect(world.live.running).toBe(true);
  });

  it('a recorded version the live server contradicts is refused before the app is even stopped', async () => {
    const { world, ctx } = setup();
    world.live.version = '1.14.1';
    await expect(runDockerUpgrade(ctx)).rejects.toThrow(/recorded version is 1\.13\.6, but the server answers 1\.14\.1/);
    expect(world.calls.some((c) => c[1] === 'compose')).toBe(false);
    expect(world.app.running).toBe(true);
  });
});

describe('the rehearsal on a cloned volume', () => {
  it('walks the WHOLE chain on the clone and never touches compose, the state file or the live volume', async () => {
    const { home, world, ctx } = setup({ rehearse: 'neuralis_qdrant-clone' });
    const out = await runDockerUpgrade(ctx);
    expect(out.result).toBe('rehearsed');
    expect(hopImages(world)).toEqual(['1.13.6', '1.14.1', '1.15.5', '1.16.3', '1.17.1', '1.18.3', '1.19.1']);
    expect(world.calls.some((c) => c[1] === 'compose' || c[0] === process.execPath)).toBe(false);
    expect(existsSync(qdrantStatePath(home))).toBe(false);
    expect(world.volumes.get('neuralis_qdrant-data')).toBe('1.13.6');
    expect(world.volumes.get('neuralis_qdrant-clone')).toBe('1.19.1');
    assertNoKeyAnywhere(world);

    // …and the forced rollback restores the clone to 1.13.6 and verifies it.
    await runDockerRollback(ctx, out.backupDir);
    expect(world.volumes.get('neuralis_qdrant-clone')).toBe('1.13.6');
    expect(world.calls.some((c) => c[1] === 'compose')).toBe(false);
  });

  it('refuses the live volume as a clone', async () => {
    const { world, ctx } = setup({ rehearse: 'neuralis_qdrant-data' });
    await expect(runDockerUpgrade(ctx)).rejects.toThrow(/needs a CLONE/);
    expect(world.calls.some((c) => c[1] === 'run')).toBe(false);
  });
});

describe('the key env-file', () => {
  it('is 0600 in a 0700 dir while in use and gone when the work THROWS', async () => {
    let seen = '';
    await expect(withKeyEnvFile(KEY, async (file) => {
      seen = file;
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(file, '..')).mode & 0o777).toBe(0o700);
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(existsSync(seen)).toBe(false);
    expect(existsSync(join(seen, '..'))).toBe(false);
  });
});

describe('the container transport', () => {
  it('keeps the key out of the docker argv; the script expands it inside the container', async () => {
    const calls: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: 0, out: 'HTTP/1.0 200 OK\r\ncontent-type: application/json\r\n\r\n{"result":{"count":3}}', err: '' };
    };
    const res = await containerQdrantApi(exec, 'hop').request('POST', '/collections/c/points/count', { exact: true });
    expect(res).toEqual({ status: 200, body: { result: { count: 3 } } });
    expect(calls[0]).toEqual(['docker', 'exec', 'hop', 'bash', '-c', CONTAINER_HTTP_SCRIPT, 'qdrant-http', 'POST', '/collections/c/points/count', '{"exact":true}']);
    expect(CONTAINER_HTTP_SCRIPT).toContain('"$QDRANT__SERVICE__API_KEY"');
  });

  it('parses a status line without a body', () => {
    expect(parseRawHttp('HTTP/1.1 503 Service Unavailable\r\n\r\n')).toEqual({ status: 503, body: null });
    expect(() => parseRawHttp('')).toThrow(/No HTTP status/);
  });
});

describe('backup retention', () => {
  it('keeps the newest N run dirs OF THE SAME KIND and never the current one', async () => {
    const home = tempDir('neuralis-prune-');
    const root = join(home, 'qdrant-backups');
    const names = ['2026-09-20T01-00-00-000Z-upgrade-a', '2026-09-21T01-00-00-000Z-rehearsal-b', '2026-09-22T01-00-00-000Z-upgrade-c'];
    for (const n of names) mkdirSync(join(root, n), { recursive: true });
    mkdirSync(join(root, '2026-09-19T01-00-00-000Z-upgrade-z'), { recursive: true });
    // Per kind: two upgrade dirs are kept, the rehearsal is never counted against them.
    const pruned = await pruneBackups(home, 2, join(root, names[2]), 'upgrade');
    expect(pruned).toEqual([join(root, '2026-09-19T01-00-00-000Z-upgrade-z')]);
    expect(existsSync(join(root, names[0]))).toBe(true);
    expect(existsSync(join(root, names[1]))).toBe(true);
    // A second rehearsal never deletes a real run's cold backup.
    mkdirSync(join(root, '2026-09-23T01-00-00-000Z-rehearsal-d'), { recursive: true });
    expect(await pruneBackups(home, 1, join(root, '2026-09-23T01-00-00-000Z-rehearsal-d'), 'rehearsal')).toEqual([join(root, names[1])]);
    expect(existsSync(join(root, names[2]))).toBe(true);
  });
});

describe('pins used by the hops', () => {
  it('every hop image is the pinned digest reference', () => {
    expect(qdrantImageRef('1.16.3')).toMatch(/^qdrant\/qdrant:v1\.16\.3@sha256:0425e3e0/);
  });
});

describe('a hop image that cannot be pulled', () => {
  it('fails before the app stops or any hop runs, and names the image', async () => {
    const { world, ctx } = setup();
    const inner = ctx.exec;
    ctx.exec = async (cmd, args, o) => {
      if (args[0] === 'image' && args[1] === 'inspect' && String(args[2]).includes('v1.18.3')) return { code: 1, out: '', err: 'No such image' };
      if (args[0] === 'pull') return { code: 1, out: '', err: 'error getting credentials' };
      return inner(cmd, args, o);
    };
    await expect(runDockerUpgrade(ctx)).rejects.toThrow(/pull qdrant\/qdrant:v1\.18\.3.*nothing was changed/);
    expect(world.app.running).toBe(true);
    expect(world.live.running).toBe(true);
    expect(world.containers.size).toBe(0);
  });
});

describe('an interrupted run (signal → exit hook)', () => {
  it('removes every hop container still running and every key env-file', async () => {
    const { home, world, ctx } = setup({ rehearse: 'neuralis_qdrant-clone' });
    const removed: string[] = [];
    let during: string[] = [];
    const inner = ctx.exec;
    ctx.exec = async (cmd, args, o) => {
      const res = await inner(cmd, args, o);
      if (args[0] === 'run' && args[1] === '-d' && during.length === 0) {
        during = liveHops();
        // What `process.on('exit')` runs when a signal lands here.
        cleanupOnExit((name) => removed.push(name));
      }
      return res;
    };
    await runDockerUpgrade(ctx).catch(() => undefined);
    expect(during).toHaveLength(1);
    expect(removed).toEqual(during);
    expect(world.envFiles.every((e) => !existsSync(e.path))).toBe(true);
    expect(home).toBeTruthy();
  });
});

describe('the native binary is started through its config env, never an unknown flag', () => {
  it('the storage path rides QDRANT__STORAGE__STORAGE_PATH and the argv is empty', () => {
    const spec = qdrantBinarySpawn('/srv/q', KEY, { QDRANT__SERVICE__HOST: '127.0.0.1' });
    expect(spec.args).toEqual([]);
    expect(spec.env.QDRANT__STORAGE__STORAGE_PATH).toBe('/srv/q');
    expect(spec.env.QDRANT__SERVICE__API_KEY).toBe(KEY);
    expect(spec.env.QDRANT__SERVICE__HOST).toBe('127.0.0.1');
  });

  it('telemetry is off on every native start — setup\'s (no extra env) and the upgrade hop alike', () => {
    expect(qdrantBinarySpawn('/srv/q', KEY).env.QDRANT__TELEMETRY_DISABLED).toBe('true');
    expect(qdrantBinarySpawn('/srv/q', undefined, { QDRANT__SERVICE__HOST: '127.0.0.1' }).env.QDRANT__TELEMETRY_DISABLED).toBe('true');
  });

  it('no spawn site in the scripts passes --storage-path (it exists in no release of the chain)', () => {
    const scripts = join(dirname(fileURLToPath(import.meta.url)), '..');
    for (const file of ['setup/services.mts', 'qdrant-upgrade.mts', 'qdrant-upgrade/upgrade.mts']) {
      const code = readFileSync(join(scripts, file), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, file).not.toContain('--storage-path');
    }
  });
});

async function untilSet(read: () => unknown): Promise<void> {
  for (let i = 0; i < 1000 && !read(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(read()).toBeTruthy();
}

describe('a signal mid-run (the exit hook calls abortActiveRun)', () => {
  it('during the hops: record.json says aborted with the last completed hop, and the line names the rollback command', async () => {
    const { home, world, ctx } = setup();
    await writeQdrantState(qdrantStatePath(home), { version: '1.13.6', previous: null, source: 'detected', recordedAt: 'x' });
    let line: string | null = null;
    const inner = ctx.exec;
    let hopsStarted = 0;
    ctx.exec = async (cmd, args, o) => {
      if (args[0] === 'run' && args[1] === '-d' && ++hopsStarted === 3) {
        // What the exit hook does on SIGINT; the process then ends, so nothing after it runs.
        line = abortActiveRun();
        cleanupOnExit(() => undefined);
        return new Promise(() => undefined);
      }
      return inner(cmd, args, o);
    };
    void runDockerUpgrade(ctx);
    await untilSet(() => line);
    const dir = readdirSync(join(home, 'qdrant-backups'))[0];
    const record = JSON.parse(readFileSync(join(home, 'qdrant-backups', dir, 'record.json'), 'utf-8'));
    expect(record.result).toBe('aborted');
    expect(record.aborted).toEqual({ phase: 'hops', lastCompletedHop: '1.15.5', appStopped: true, storageChanged: true });
    expect(line).toContain(`pnpm neuralis:qdrant-upgrade --rollback ${join(home, 'qdrant-backups', dir)}`);
    expect(line).toMatch(/app is STOPPED and was not restarted/);
    expect(world.app.running).toBe(false);
  });

  it('before any hop: the storage is unchanged, the app is stopped, and the line says how to start it', async () => {
    const { home, ctx } = setup();
    await writeQdrantState(qdrantStatePath(home), { version: '1.13.6', previous: null, source: 'detected', recordedAt: 'x' });
    let line: string | null = null;
    const inner = ctx.exec;
    ctx.exec = async (cmd, args, o) => {
      if (args.join(' ') === 'compose stop qdrant') {
        line = abortActiveRun();
        cleanupOnExit(() => undefined);
        return new Promise(() => undefined);
      }
      return inner(cmd, args, o);
    };
    void runDockerUpgrade(ctx);
    await untilSet(() => line);
    const dir = readdirSync(join(home, 'qdrant-backups'))[0];
    const record = JSON.parse(readFileSync(join(home, 'qdrant-backups', dir, 'record.json'), 'utf-8'));
    expect(record.aborted).toMatchObject({ phase: 'backup', lastCompletedHop: null, appStopped: true, storageChanged: false });
    expect(line).toMatch(/storage is unchanged \(still 1\.13\.6\) but the app is STOPPED[\s\S]*docker compose up -d/);
  });

  it('the backup dir holds a record from its first moment, and no run is registered after the command returns', async () => {
    const { home, ctx } = setup({ freeBytes: 5e9 });
    let seen: string[] = [];
    const inner = ctx.exec;
    ctx.exec = async (cmd, args, o) => {
      if (args.includes('du') && seen.length === 0) {
        const dir = readdirSync(join(home, 'qdrant-backups'))[0];
        seen = readdirSync(join(home, 'qdrant-backups', dir));
      }
      return inner(cmd, args, o);
    };
    await runDockerUpgrade(ctx).catch(() => undefined);
    expect(seen).toEqual(['record.json']);
    expect(abortActiveRun()).toBeNull();
  });
});
