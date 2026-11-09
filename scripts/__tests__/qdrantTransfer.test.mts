/**
 * The Docker vectors copied into the desktop app's own Qdrant store
 * (`qdrant-upgrade/transfer.mts`), with a fake Docker and two fake Qdrants:
 * the refusals before anything stops (version, a store already there, space),
 * the stop → cold tar → local extract (`--no-same-owner`) → restart order, the
 * per-collection count oracle and the Docker volume only ever read.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import type { ComposeAnswer } from '../host-broker/helper.mts';
import { QDRANT_TARGET_VERSION } from '../setup/qdrantVersion.mts';
import { extractArgs, planTransfer, runTransfer, transferStorageDir, type TransferInput, type TransferPorts } from '../qdrant-upgrade/transfer.mts';
import type { ExecResult, QdrantApi } from '../qdrant-upgrade/upgrade.mts';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function fakeQdrant(version: string, counts: Record<string, number>): QdrantApi {
  return {
    async request(method, path) {
      if (path === '/') return { status: 200, body: { version } };
      if (path === '/collections') return { status: 200, body: { result: { collections: Object.keys(counts).map((name) => ({ name })) } } };
      const info = /^\/collections\/([^/]+)$/.exec(path);
      if (info) return { status: 200, body: { result: { status: 'green', optimizer_status: 'ok' } } };
      const count = /^\/collections\/([^/]+)\/points\/count$/.exec(path);
      if (count && method === 'POST') return { status: 200, body: { result: { count: counts[count[1]!] } } };
      return { status: 404, body: null };
    },
    async fetchSnapshot() { throw new Error('not used'); },
  };
}

type World = { home: string; installDir: string; calls: string[]; ports: TransferPorts; input: TransferInput; restarts: number };

function world(opts: { recorded?: string | null; free?: number; appRunning?: boolean; copyCounts?: Record<string, number> } = {}): World {
  const root = mkdtempSync(join(tmpdir(), 'nrs-transfer-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const installDir = join(root, 'docker-install');
  const calls: string[] = [];
  const counts = { 'brain-x': 120, 'agent-y': 7 };
  const w: World = {
    home, installDir, calls, restarts: 0,
    input: { home, installDir, volume: 'neuralis_qdrant-data', recordedVersion: opts.recorded === undefined ? QDRANT_TARGET_VERSION : opts.recorded, bundleVersion: QDRANT_TARGET_VERSION },
    ports: undefined as unknown as TransferPorts,
  };
  const stack: ComposeAnswer = { kind: 'services', project: 'neuralis', app: 'neuralis', vectorstore: 'qdrant', running: opts.appRunning ? ['neuralis', 'qdrant'] : ['qdrant'] };
  w.ports = {
    async exec(cmd, args, o): Promise<ExecResult> {
      calls.push(`${cmd} ${args.join(' ')}`);
      if (cmd === 'docker' && args[0] === 'run' && args.includes('du')) return { code: 0, out: '4000000\t/data\n', err: '' };
      if (cmd === 'docker' && args[0] === 'run' && args.includes('tar')) {
        writeFileSync(o!.stdoutPath!, 'tar-bytes');
        return { code: 0, out: '', err: '' };
      }
      if (cmd === 'tar') {
        const dest = args[args.indexOf('-C') + 1]!;
        mkdirSync(join(dest, 'collections'), { recursive: true });
        writeFileSync(join(dest, 'raft_state.json'), '{}');
        return { code: 0, out: '', err: '' };
      }
      return { code: 0, out: '', err: '' };
    },
    freeBytes: async () => opts.free ?? 1e12,
    log: () => undefined,
    dockerApi: fakeQdrant(QDRANT_TARGET_VERSION, counts),
    readStack: async () => stack,
    startVectorstore: async () => { w.restarts += 1; return { ok: true, service: 'qdrant', started: false }; },
    startBinary: async (storageDir) => {
      calls.push(`binary ${storageDir}`);
      return { api: fakeQdrant(QDRANT_TARGET_VERSION, opts.copyCounts ?? counts), stop: async () => { calls.push('binary stopped'); } };
    },
    now: () => new Date('2026-10-20T12:00:00Z'),
  };
  return w;
}

describe('the Docker vectors copied into the desktop app\'s own store', () => {
  it('stops ONLY the Docker Qdrant, tars the volume read-only, unpacks it as this user (--no-same-owner), starts it again, and the counts match', async () => {
    const w = world();
    const result = await runTransfer(w.ports, w.input);
    expect(result.collections).toEqual({ 'agent-y': 7, 'brain-x': 120 });
    const storage = transferStorageDir(w.home);
    expect(readdirSync(storage).sort()).toEqual(['collections', 'raft_state.json']);
    const stop = w.calls.findIndex((c) => c === 'docker compose -p neuralis stop qdrant');
    const tar = w.calls.findIndex((c) => c.startsWith('docker run --rm --network none -v neuralis_qdrant-data:/data:ro --entrypoint tar'));
    const unpack = w.calls.findIndex((c) => c.startsWith('tar -C ') && c.includes(' --no-same-owner -xf '));
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(tar).toBeGreaterThan(stop);
    expect(unpack).toBeGreaterThan(tar);
    // The volume is mounted read-only everywhere and never written, the app's service never named.
    for (const call of w.calls.filter((c) => c.includes('neuralis_qdrant-data:'))) expect(call).toContain('neuralis_qdrant-data:/data:ro');
    expect(w.calls.some((c) => / (stop|start|up|rm)\b.* neuralis$/.test(c))).toBe(false);
    // Started before the counts and again after the copy; the tar and the staging folder are gone.
    expect(w.restarts).toBe(2);
    expect(existsSync(`${storage}.copy.tar`)).toBe(false);
    expect(existsSync(`${storage}.copying`)).toBe(false);
    expect(w.calls.at(-1)).toBe('binary stopped');
  });

  it('extractArgs keeps the files this user\'s: --no-same-owner is in the one extract spelling', () => {
    expect(extractArgs('/t/x.tar', '/h/qdrant-storage.copying')).toEqual(['-C', '/h/qdrant-storage.copying', '--no-same-owner', '-xf', '/t/x.tar']);
  });

  it('refuses before anything stops: another Qdrant version, a store already in the home, too little space, the Docker app running', async () => {
    const older = world({ recorded: '1.18.0' });
    await expect(planTransfer(older.ports, older.input)).rejects.toThrow(/on Qdrant 1\.18\.0 and this app's Qdrant is .*`neuralis qdrant-upgrade`/);
    const unknown = world({ recorded: null });
    await expect(runTransfer(unknown.ports, unknown.input)).rejects.toThrow(/no recorded version/);
    for (const w of [older, unknown]) expect(w.calls).toEqual([]);

    const full = world();
    mkdirSync(join(transferStorageDir(full.home), 'collections'), { recursive: true });
    await expect(runTransfer(full.ports, full.input)).rejects.toThrow(/already holds a Qdrant store; the copy never writes over one/);

    const tight = world({ free: 7_000_000 });
    await expect(runTransfer(tight.ports, tight.input)).rejects.toThrow(/Needs 8 MB free for the copy of the Docker vectors/);
    expect(tight.calls.some((c) => c.includes(' stop '))).toBe(false);

    const busy = world({ appRunning: true });
    await expect(runTransfer(busy.ports, busy.input)).rejects.toThrow(/The Docker app runs: stop it first/);
    expect(busy.calls.some((c) => c.includes(' stop '))).toBe(false);
  });

  it('ORACLE: a copy whose counts differ is moved aside and named; the Docker store is untouched and running again', async () => {
    const w = world({ copyCounts: { 'brain-x': 119, 'agent-y': 7 } });
    await expect(runTransfer(w.ports, w.input)).rejects.toThrow(/does not hold the Docker vectors \(brain-x: 120 → 119\); it was moved to .*qdrant-storage\.failed-2026-10-20T12-00-00-000Z\. The Docker store is untouched/);
    expect(existsSync(transferStorageDir(w.home))).toBe(false);
    expect(w.restarts).toBe(2);
  });

  it('a Docker Qdrant that was DOWN is started and waited for (/readyz) before its version and counts are read', async () => {
    const w = world();
    const reads: string[] = [];
    let ready = false;
    const live = w.ports.dockerApi;
    w.ports.dockerApi = {
      ...live,
      async request(method, path, body) {
        reads.push(path);
        if (!ready) {
          ready = reads.filter((p) => p === '/readyz').length >= 2;
          throw new Error('fetch failed');
        }
        return path === '/readyz' ? { status: 200, body: null } : live.request(method, path, body);
      },
    };
    let first = true;
    w.ports.startVectorstore = async () => {
      w.restarts += 1;
      const started = first;
      first = false;
      return { ok: true, service: 'qdrant', started };
    };
    expect((await runTransfer(w.ports, w.input)).collections).toEqual({ 'agent-y': 7, 'brain-x': 120 });
    expect(reads.slice(0, 3)).toEqual(['/readyz', '/readyz', '/readyz']);
    expect(reads[3]).toBe('/');
  });

  it('a check that FAILS (the binary never answers on the copy) still moves the copy aside and names it — the next attempt finds an empty store', async () => {
    const w = world();
    w.ports.startBinary = async () => { throw new Error('this app\'s Qdrant did not answer on the copy'); };
    await expect(runTransfer(w.ports, w.input)).rejects.toThrow(/could not be checked: this app's Qdrant did not answer on the copy; it was moved to .*qdrant-storage\.failed-2026-10-20T12-00-00-000Z\. The Docker store is untouched/);
    const storage = transferStorageDir(w.home);
    expect(existsSync(storage)).toBe(false);
    expect(readdirSync(`${storage}.failed-2026-10-20T12-00-00-000Z`).sort()).toEqual(['collections', 'raft_state.json']);
    expect(w.restarts).toBe(2);
    await expect(planTransfer(w.ports, w.input)).resolves.toMatchObject({ storageDir: storage });
  });
});
