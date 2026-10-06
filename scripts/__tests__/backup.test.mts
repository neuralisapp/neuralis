/**
 * `pnpm neuralis:backup` / `neuralis:restore` against a fake Docker world whose
 * volumes are temp directories: every `docker run` the cold-tar helpers issue is
 * executed for real against that directory (tar, du, the restore's find+tar), so
 * "the volume is byte-identical" is measured on bytes, not on recorded calls.
 * No daemon, no network, no live home.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { runBackup, runRestore, type BackupPorts, type InstallFacts } from '../backup/backup.mts';
import { processExec, type Exec } from '../qdrant-upgrade/upgrade.mts';

const IMAGE = 'qdrant/qdrant:v1.19.1@sha256:12364fe851b9f17356fc88189fc06d1b521262e04659ec7345975b00c9246a10';

const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type World = {
  volumes: Map<string, string>;
  running: Set<string>;
  /** A foreign container on this volume. */
  squatter?: string;
  /** The home tar (`tar -cpf`) answers this instead of running. */
  homeTarFails?: { code: number; err: string };
  /** The home extract (`tar -xpf`) fails. */
  extractFails?: boolean;
  calls: string[][];
};

function run(cmd: string, args: string[], opts: { cwd?: string; stdoutPath?: string; stdinPath?: string } = {}) {
  const outFd = opts.stdoutPath ? openSync(opts.stdoutPath, 'w', 0o600) : null;
  const inFd = opts.stdinPath ? openSync(opts.stdinPath, 'r') : null;
  try {
    const res = spawnSync(cmd, args, { cwd: opts.cwd, stdio: [inFd ?? 'ignore', outFd ?? 'pipe', 'pipe'], encoding: 'utf-8' });
    return { code: res.status ?? 1, out: outFd === null ? (res.stdout ?? '') : '', err: res.stderr ?? '' };
  } finally {
    if (outFd !== null) closeSync(outFd);
    if (inFd !== null) closeSync(inFd);
  }
}

function fakeExec(world: World): Exec {
  return async (cmd, args, opts = {}) => {
    world.calls.push([cmd, ...args]);
    if (cmd === 'tar' && args.includes('-cpf') && world.homeTarFails) return { code: world.homeTarFails.code, out: '', err: world.homeTarFails.err };
    if (cmd === 'tar' && args.includes('-xpf') && world.extractFails) return { code: 2, out: '', err: 'tar: Cannot open: Permission denied' };
    if (cmd !== 'docker') return run(cmd, args, opts);
    const [sub, ...rest] = args;
    if (sub === 'compose') {
      if (rest[0] === 'stop') { world.running.delete(rest[1]!); return { code: 0, out: '', err: '' }; }
      if (rest[0] === 'start') { for (const s of rest.slice(1)) world.running.add(s); return { code: 0, out: '', err: '' }; }
    }
    if (sub === 'volume' && rest[0] === 'inspect') return { code: world.volumes.has(rest[1]!) ? 0 : 1, out: '', err: 'no such volume' };
    if (sub === 'volume' && rest[0] === 'ls') return { code: 0, out: [...world.volumes.keys()].join('\n'), err: '' };
    if (sub === 'ps') {
      const volume = rest[rest.indexOf('--filter') + 1]!.replace('volume=', '');
      const busy = world.squatter === volume || (world.running.has('qdrant') && volume.endsWith('_qdrant-data'));
      return { code: 0, out: busy ? 'c0ffee\n' : '', err: '' };
    }
    if (sub === 'run') {
      const bind = rest[rest.indexOf('-v') + 1]!;
      const dir = world.volumes.get(bind.split(':')[0]!);
      if (!dir) return { code: 1, out: '', err: 'no such volume' };
      const entry = rest[rest.indexOf('--entrypoint') + 1]!;
      const image = rest[rest.indexOf('--entrypoint') + 2]!;
      expect(image).toBe(IMAGE);
      const inner = rest.slice(rest.indexOf('--entrypoint') + 3).map((a) => a.replaceAll('/data', dir));
      return run(entry, inner, opts);
    }
    return { code: 1, out: '', err: `unexpected docker ${args.join(' ')}` };
  };
}

function hashTree(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      h.update(relative(dir, p));
      if (statSync(p).isDirectory()) walk(p);
      else h.update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

type Setup = {
  world: World;
  ports: BackupPorts;
  facts: InstallFacts;
  home: string;
  configDir: string;
  volumeDir: string;
  logs: string[];
  answers: string[];
};

function setup(opts: { mode?: 'docker' | 'binary'; freeBytes?: number; offline?: boolean; qdrantAnswers?: boolean } = {}): Setup {
  const root = tempDir('neuralis-backup-');
  const home = join(root, '.neuralis');
  mkdirSync(join(home, 'app', 'config'), { recursive: true });
  writeFileSync(join(home, 'app', 'config', 'platform.json'), '{"a":1}\n');
  mkdirSync(join(home, 'host-broker'), { recursive: true });
  writeFileSync(join(home, 'host-broker', 'secret'), 'broker-secret\n', { mode: 0o600 });
  mkdirSync(join(home, 'qdrant-backups', 'old-run'), { recursive: true });
  writeFileSync(join(home, 'qdrant-backups', 'old-run', 'cold.tar'), 'OLD ROLLBACK TAR');
  if (opts.mode === 'binary') {
    mkdirSync(join(home, 'qdrant-storage'), { recursive: true });
    writeFileSync(join(home, 'qdrant-storage', 'segment'), 'VECTORS');
  }
  const configDir = join(root, 'host');
  mkdirSync(configDir);
  writeFileSync(join(configDir, '.env'), 'NEXTAUTH_SECRET=s\nNEURALIS_COMPOSE_PROJECT=neuralis\n', { mode: 0o600 });
  writeFileSync(join(configDir, 'docker-compose.override.yml'), 'services: {}\n');
  const volumeDir = join(root, 'vol-qdrant-data');
  mkdirSync(join(volumeDir, 'collections', 'c1'), { recursive: true });
  writeFileSync(join(volumeDir, 'collections', 'c1', 'points.bin'), 'POINTS-v1');
  const world: World = {
    volumes: new Map(opts.mode === 'binary' ? [] : [['neuralis_qdrant-data', volumeDir], ['neuralis_qdrant-snapshots', tempDir('neuralis-snap-')]]),
    running: new Set(opts.mode === 'binary' ? [] : ['neuralis', 'qdrant']),
    calls: [],
  };
  const logs: string[] = [];
  const answers: string[] = [];
  let clock = 0;
  const ports: BackupPorts = {
    exec: fakeExec(world),
    log: (line) => logs.push(line),
    freeBytes: async () => opts.freeBytes ?? 1e12,
    now: () => new Date('2026-10-04T12:00:00Z'),
    monotonicMs: () => (clock += 1500),
    composeRunning: async () => ({ kind: 'services', running: [...world.running] }),
    appOffline: async () => (opts.offline === false ? { offline: false, reason: 'the app answers on http://127.0.0.1:3100/api/health' } : { offline: true }),
    qdrantAnswers: async () => opts.qdrantAnswers ?? false,
    ask: async () => answers.shift() ?? '',
  };
  const facts: InstallFacts = {
    neuralisHome: home,
    configDir,
    buildContext: root,
    composeProject: 'neuralis',
    qdrantMode: opts.mode ?? 'docker',
    toolImage: opts.mode === 'binary' ? null : IMAGE,
  };
  return { world, ports, facts, home, configDir, volumeDir, logs, answers };
}

function tarList(file: string): string[] {
  return spawnSync('tar', ['-tf', file], { encoding: 'utf-8' }).stdout.split('\n').filter(Boolean);
}

describe('neuralis:backup', () => {
  it('stops the app and Qdrant, takes the four parts at one point, and starts them again', async () => {
    const s = setup();
    const out = join(tempDir('neuralis-out-'), 'b1');
    const result = await runBackup(s.ports, s.facts, { outDir: out, includeVolumes: [] });

    const stopAt = s.world.calls.findIndex((c) => c.join(' ') === 'docker compose stop neuralis');
    const qdrantStopAt = s.world.calls.findIndex((c) => c.join(' ') === 'docker compose stop qdrant');
    const tarAt = s.world.calls.findIndex((c) => c[0] === 'tar' && c.includes('-cpf'));
    const upAt = s.world.calls.findIndex((c) => c.join(' ') === 'docker compose start qdrant neuralis');
    expect(stopAt).toBeGreaterThan(-1);
    expect(qdrantStopAt).toBeGreaterThan(stopAt);
    expect(tarAt).toBeGreaterThan(qdrantStopAt);
    expect(upAt).toBeGreaterThan(tarAt);
    expect(s.world.running).toEqual(new Set(['neuralis', 'qdrant']));
    // Only what it stopped, never `up`: `up` would apply a pending compose regen without -V.
    expect(s.world.calls.some((c) => c[1] === 'compose' && c[2] === 'up')).toBe(false);

    expect(result.manifest.parts.map((p) => p.kind)).toEqual(['home', 'volume', 'env', 'override']);
    expect(result.manifest.parts.every((p) => p.bytes > 0)).toBe(true);
    const home = tarList(join(out, 'home.tar'));
    expect(home).toContain('./host-broker/secret');
    expect(home).toContain('./app/config/platform.json');
    expect(home.some((p) => p.includes('qdrant-backups'))).toBe(false);
    expect(tarList(join(out, 'volume-neuralis_qdrant-data.tar'))).toContain('./collections/c1/points.bin');
    expect(readFileSync(join(out, 'env'), 'utf-8')).toContain('NEXTAUTH_SECRET=s');
    expect(s.logs.join('\n')).toMatch(/backup complete: [\d.]+ MB in [\d.]+ s/);
    expect(s.logs.join('\n')).toContain('not included (add with --include-volume <name>): neuralis_qdrant-snapshots');
  });

  it('the folder is 0700 and every file in it 0600 — it holds every secret', async () => {
    const s = setup();
    const out = join(tempDir('neuralis-out-'), 'b1');
    await runBackup(s.ports, s.facts, { outDir: out, includeVolumes: [] });
    expect(statSync(out).mode & 0o777).toBe(0o700);
    for (const name of readdirSync(out)) expect(statSync(join(out, name)).mode & 0o777, name).toBe(0o600);
  });

  it('an asked-for volume rides along', async () => {
    const s = setup();
    const out = join(tempDir('neuralis-out-'), 'b1');
    const result = await runBackup(s.ports, s.facts, { outDir: out, includeVolumes: ['neuralis_qdrant-snapshots'] });
    expect(result.manifest.parts.filter((p) => p.kind === 'volume').map((p) => p.name)).toEqual(['neuralis_qdrant-data', 'neuralis_qdrant-snapshots']);
  });

  it('refuses without the .env — nothing stopped, nothing written', async () => {
    const s = setup();
    rmSync(join(s.configDir, '.env'));
    const out = join(tempDir('neuralis-out-'), 'b1');
    await expect(runBackup(s.ports, s.facts, { outDir: out, includeVolumes: [] })).rejects.toThrow(/No \.env/);
    expect(s.world.calls.some((c) => c.includes('stop'))).toBe(false);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses without enough free space — nothing stopped, nothing written', async () => {
    const s = setup({ freeBytes: 10 });
    const out = join(tempDir('neuralis-out-'), 'b1');
    await expect(runBackup(s.ports, s.facts, { outDir: out, includeVolumes: [] })).rejects.toThrow(/MB free for the backup/);
    expect(s.world.calls.some((c) => c.includes('stop'))).toBe(false);
    expect(existsSync(out)).toBe(false);
  });

  it('refuses a folder inside the compose folder or the image build context — it holds every secret', async () => {
    const s = setup();
    await expect(runBackup(s.ports, s.facts, { outDir: join(s.configDir, 'b1'), includeVolumes: [] })).rejects.toThrow(/Docker build context or the compose folder/);
    const inRepo = setup();
    await expect(runBackup(inRepo.ports, inRepo.facts, { outDir: join(inRepo.facts.buildContext!, 'elsewhere', 'b1'), includeVolumes: [] }))
      .rejects.toThrow(/Docker build context or the compose folder/);
    expect(s.world.calls.some((c) => c.includes('stop'))).toBe(false);
  });

  it('a file that changed while tar read it fails the backup: no manifest, the stopped services started again, the cause named', async () => {
    const s = setup();
    s.world.homeTarFails = { code: 1, err: 'tar: ./host-broker-shells/x.log: file changed as we read it' };
    const out = join(tempDir('neuralis-out-'), 'b1');
    await expect(runBackup(s.ports, s.facts, { outDir: out, includeVolumes: [] })).rejects.toThrow(/Something still writes under the home[\s\S]*never offered as a backup/);
    expect(existsSync(join(out, 'manifest.json'))).toBe(false);
    expect(s.world.calls.some((c) => c.join(' ') === 'docker compose start qdrant neuralis')).toBe(true);
  });

  it('refuses a folder inside the home it copies', async () => {
    const s = setup();
    await expect(runBackup(s.ports, s.facts, { outDir: join(s.home, 'backups', 'b1'), includeVolumes: [] })).rejects.toThrow(/inside the home/);
  });

  it('refuses while something else holds the volume, writes no manifest, and starts the stack again', async () => {
    const s = setup();
    s.world.squatter = 'neuralis_qdrant-data';
    const out = join(tempDir('neuralis-out-'), 'b1');
    await expect(runBackup(s.ports, s.facts, { outDir: out, includeVolumes: [] })).rejects.toThrow(/in use by running container/);
    expect(existsSync(join(out, 'manifest.json'))).toBe(false);
    expect(s.world.running).toEqual(new Set(['neuralis', 'qdrant']));
  });

  it('refuses while the app still answers after the stop, and starts the stack again', async () => {
    const s = setup({ offline: false });
    const out = join(tempDir('neuralis-out-'), 'b1');
    await expect(runBackup(s.ports, s.facts, { outDir: out, includeVolumes: [] })).rejects.toThrow(/the app answers/);
    expect(existsSync(join(out, 'home.tar'))).toBe(false);
    expect(s.world.calls.some((c) => c.join(' ') === 'docker compose start qdrant neuralis')).toBe(true);
  });

  it('binary mode: the storage rides in the home tar, no volume is touched, and a running native Qdrant is refused', async () => {
    const refused = setup({ mode: 'binary', qdrantAnswers: true });
    await expect(runBackup(refused.ports, refused.facts, { outDir: join(tempDir('neuralis-out-'), 'b'), includeVolumes: [] }))
      .rejects.toThrow(/native Qdrant still answers/);

    const s = setup({ mode: 'binary' });
    const out = join(tempDir('neuralis-out-'), 'b1');
    const result = await runBackup(s.ports, s.facts, { outDir: out, includeVolumes: [] });
    expect(result.manifest.parts.map((p) => p.kind)).toEqual(['home', 'env', 'override']);
    expect(tarList(join(out, 'home.tar'))).toContain('./qdrant-storage/segment');
    expect(s.world.calls.some((c) => c[0] === 'docker' && c[1] === 'run')).toBe(false);
  });
});

describe('the real process port', () => {
  it('resolves a stdout-to-file run only once the file is complete — the size a cold tar reports is the size on disk', async () => {
    const dir = tempDir('neuralis-exec-');
    for (let i = 0; i < 4; i++) {
      const dest = join(dir, `out${i}`);
      const res = await processExec('head', ['-c', '100000000', '/dev/zero'], { stdoutPath: dest });
      expect(res.code).toBe(0);
      expect(statSync(dest).size).toBe(100_000_000);
      rmSync(dest);
    }
  }, 60_000);
});

describe('neuralis:restore', () => {
  async function backedUp(s: Setup): Promise<string> {
    const out = join(tempDir('neuralis-out-'), 'b1');
    await runBackup(s.ports, s.facts, { outDir: out, includeVolumes: [] });
    s.world.calls.length = 0;
    s.world.running.clear();
    return out;
  }

  it('a bad incoming tar is refused BEFORE anything moves: the volume and the home stay byte-identical', async () => {
    const s = setup();
    const out = await backedUp(s);
    writeFileSync(join(s.volumeDir, 'collections', 'c1', 'points.bin'), 'POINTS-v2');
    writeFileSync(join(out, 'volume-neuralis_qdrant-data.tar'), 'not a tar at all, just bytes');
    const volumeBefore = hashTree(s.volumeDir);
    const homeBefore = hashTree(s.home);
    s.answers.push('b1');
    await expect(runRestore(s.ports, s.facts, { dir: out, home: null, volume: null })).rejects.toThrow(/does not read as a tar/);
    expect(hashTree(s.volumeDir)).toBe(volumeBefore);
    expect(hashTree(s.home)).toBe(homeBefore);
    expect(existsSync(`${s.home}.before-restore`)).toBe(false);
    expect(s.world.calls.some((c) => c.includes('-xf') || c.some((a) => a.includes('-delete')))).toBe(false);
  });

  it('refuses while the app runs (live target)', async () => {
    const s = setup();
    const out = await backedUp(s);
    const running = { ...s.ports, appOffline: async () => ({ offline: false as const, reason: 'the app answers on http://127.0.0.1:3100/api/health' }) };
    await expect(runRestore(running, s.facts, { dir: out, home: null, volume: null })).rejects.toThrow(/Refusing to restore: the app answers/);
  });

  it('a live restore saves the current volume first, moves the old home aside, and replaces .env keeping the old one', async () => {
    const s = setup();
    const out = await backedUp(s);
    writeFileSync(join(s.volumeDir, 'collections', 'c1', 'points.bin'), 'POINTS-v2');
    writeFileSync(join(s.home, 'app', 'config', 'platform.json'), '{"a":2}\n');
    writeFileSync(join(s.configDir, '.env'), 'NEXTAUTH_SECRET=new\n');
    s.answers.push('b1');
    const result = await runRestore(s.ports, s.facts, { dir: out, home: null, volume: null });

    expect(readFileSync(join(s.volumeDir, 'collections', 'c1', 'points.bin'), 'utf-8')).toBe('POINTS-v1');
    expect(result.volumeSafety).toEqual([`${s.home}.before-restore-neuralis_qdrant-data.tar`]);
    expect(tarList(result.volumeSafety[0]!)).toContain('./collections/c1/points.bin');
    const saved = spawnSync('tar', ['-xOf', result.volumeSafety[0]!, './collections/c1/points.bin'], { encoding: 'utf-8' }).stdout;
    expect(saved).toBe('POINTS-v2');
    expect(readFileSync(join(s.home, 'app', 'config', 'platform.json'), 'utf-8')).toBe('{"a":1}\n');
    expect(readFileSync(join(`${s.home}.before-restore`, 'app', 'config', 'platform.json'), 'utf-8')).toBe('{"a":2}\n');
    expect(readFileSync(join(s.configDir, '.env'), 'utf-8')).toContain('NEXTAUTH_SECRET=s');
    expect(readFileSync(join(s.configDir, '.env.before-restore'), 'utf-8')).toBe('NEXTAUTH_SECRET=new\n');
    expect(statSync(join(s.configDir, '.env')).mode & 0o777).toBe(0o600);
    expect(s.logs).toContain('next: `pnpm neuralis:setup --compose-only`, then `docker compose up -d -V`');
    const safetyAt = s.world.calls.findIndex((c) => c.includes('-cf'));
    const wipeAt = s.world.calls.findIndex((c) => c.some((a) => a.includes('-delete')));
    expect(safetyAt).toBeGreaterThan(-1);
    expect(wipeAt).toBeGreaterThan(safetyAt);
  });

  it('a throwaway restore (--home + --volume) never touches the live home, volume or .env', async () => {
    const s = setup();
    const out = await backedUp(s);
    const clone = tempDir('neuralis-clone-');
    s.world.volumes.set('neuralis_qdrant-clone', clone);
    const liveVolume = hashTree(s.volumeDir);
    const liveHome = hashTree(s.home);
    const liveEnv = readFileSync(join(s.configDir, '.env'), 'utf-8');
    const target = join(tempDir('neuralis-target-'), 'home');
    s.answers.push('b1');
    const offline = { ...s.ports, appOffline: async () => ({ offline: false as const, reason: 'live app runs' }) };
    await runRestore(offline, s.facts, { dir: out, home: target, volume: 'neuralis_qdrant-clone' });

    expect(readFileSync(join(clone, 'collections', 'c1', 'points.bin'), 'utf-8')).toBe('POINTS-v1');
    expect(readFileSync(join(target, 'host-broker', 'secret'), 'utf-8')).toBe('broker-secret\n');
    expect(hashTree(s.volumeDir)).toBe(liveVolume);
    expect(hashTree(s.home)).toBe(liveHome);
    expect(readFileSync(join(s.configDir, '.env'), 'utf-8')).toBe(liveEnv);
  });

  it('a throwaway home needs its own volume, and never the live one', async () => {
    const s = setup();
    const out = await backedUp(s);
    const target = join(tempDir('neuralis-target-'), 'home');
    await expect(runRestore(s.ports, s.facts, { dir: out, home: target, volume: null })).rejects.toThrow(/must name its Qdrant volume/);
    await expect(runRestore(s.ports, s.facts, { dir: out, home: target, volume: 'neuralis_qdrant-data' })).rejects.toThrow(/Refusing to restore the live/);
  });

  it('nothing changes without the typed confirmation', async () => {
    const s = setup();
    const out = await backedUp(s);
    writeFileSync(join(s.volumeDir, 'collections', 'c1', 'points.bin'), 'POINTS-v2');
    const before = hashTree(s.volumeDir);
    s.answers.push('yes');
    await expect(runRestore(s.ports, s.facts, { dir: out, home: null, volume: null })).rejects.toThrow(/Not confirmed/);
    expect(hashTree(s.volumeDir)).toBe(before);
    expect(existsSync(`${s.home}.before-restore`)).toBe(false);
  });

  it('never overwrites an earlier rescue copy of .env or the override — refused before the confirmation, nothing changed', async () => {
    for (const file of ['.env', 'docker-compose.override.yml']) {
      const s = setup();
      const out = await backedUp(s);
      writeFileSync(join(s.configDir, `${file}.before-restore`), 'THE FIRST RESCUE COPY\n');
      writeFileSync(join(s.volumeDir, 'collections', 'c1', 'points.bin'), 'POINTS-v2');
      const before = hashTree(s.volumeDir);
      s.answers.push('b1');
      await expect(runRestore(s.ports, s.facts, { dir: out, home: null, volume: null })).rejects.toThrow(/before-restore already exists/);
      expect(readFileSync(join(s.configDir, `${file}.before-restore`), 'utf-8')).toBe('THE FIRST RESCUE COPY\n');
      expect(hashTree(s.volumeDir)).toBe(before);
      expect(s.answers).toEqual(['b1']);
    }
  });

  it('a failure half-way names every step already done and every rescue copy', async () => {
    const s = setup();
    const out = await backedUp(s);
    s.world.extractFails = true;
    s.answers.push('b1');
    const err = await runRestore(s.ports, s.facts, { dir: out, home: null, volume: null }).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/stopped half-way, while moving the home aside/);
    expect(err?.message).toContain(`the current neuralis_qdrant-data was saved to ${s.home}.before-restore-neuralis_qdrant-data.tar`);
    expect(err?.message).toContain('neuralis_qdrant-data was replaced from the backup');
    expect(err?.message).toContain(`the current home was moved to ${s.home}.before-restore`);
    expect(existsSync(`${s.home}.before-restore`)).toBe(true);
  });

  it('never overwrites an earlier rescue copy', async () => {
    const s = setup();
    const out = await backedUp(s);
    mkdirSync(`${s.home}.before-restore`);
    s.answers.push('b1');
    await expect(runRestore(s.ports, s.facts, { dir: out, home: null, volume: null })).rejects.toThrow(/already exists/);
  });

  it('refuses a manifest whose part points outside the backup folder', async () => {
    const s = setup();
    const out = await backedUp(s);
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf-8')) as { parts: Array<{ file: string }> };
    manifest.parts[0]!.file = '../elsewhere.tar';
    writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest));
    await expect(runRestore(s.ports, s.facts, { dir: out, home: null, volume: null })).rejects.toThrow(/outside the backup/);
  });
});
