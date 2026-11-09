/**
 * ONE host per data home (`homeLock.ts`): a temp home, an injected liveness
 * probe. Pins the takeover rule — same kind and silent ⇒ stale; a different
 * kind is never taken over — the adopt-by-instance-id handover, the atomic
 * create, and a release that removes only the releaser's own lock.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';

// A filesystem without hard links (FAT, exFAT), injected: `link()` throws the code set here.
const linkFault = vi.hoisted(() => ({ code: null as string | null }));
// Windows: a reader holding `host.lock` makes the rename over it fail with a sharing violation — the next `times` renames throw `code`.
const renameFault = vi.hoisted(() => ({ code: 'EPERM', times: 0, calls: 0 }));
// Windows: the same reader makes deleting `host.lock` itself fail with `code` (temp files are not affected).
const unlinkFault = vi.hoisted(() => ({ code: null as string | null }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const linkSync: typeof fs.linkSync = (from, to) => {
    if (linkFault.code) throw Object.assign(new Error(`${linkFault.code}: operation not permitted, link`), { code: linkFault.code });
    fs.linkSync(from, to);
  };
  const renameSync: typeof fs.renameSync = (from, to) => {
    renameFault.calls += 1;
    if (renameFault.times > 0) {
      renameFault.times -= 1;
      throw Object.assign(new Error(`${renameFault.code}: operation not permitted, rename`), { code: renameFault.code });
    }
    fs.renameSync(from, to);
  };
  const unlinkSync: typeof fs.unlinkSync = (path) => {
    if (unlinkFault.code && String(path).endsWith('host.lock')) throw Object.assign(new Error(`${unlinkFault.code}: resource busy or locked, unlink '${String(path)}'`), { code: unlinkFault.code });
    fs.unlinkSync(path);
  };
  return { ...fs, default: { ...fs, linkSync, renameSync, unlinkSync }, linkSync, renameSync, unlinkSync };
});
import {
  acquireHomeLock,
  followSupervisor,
  holderAlive,
  HomeLockBusyError,
  NonLocalHomeError,
  nonLocalHomeReason,
  processLockProbe,
  PROCESS_LOCK_PROBE,
  splitWindowsCommandLine,
  viewRuns,
  type ProcessView,
  type SupervisedProcess,
  homeLockPath,
  homeLockedMessage,
  judgeHomeLock,
  LOCK_FRESH_MS,
  startLockHeartbeat,
  readHomeLock,
  releaseHomeLock,
  updateHomeLock,
  type HomeLock,
  type LockProbe,
} from '../homeLock';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function home(lock?: unknown): string {
  const h = mkdtempSync(join(tmpdir(), 'nrs-home-lock-'));
  roots.push(h);
  mkdirSync(dirname(homeLockPath(h)), { recursive: true });
  if (lock !== undefined) writeFileSync(homeLockPath(h), typeof lock === 'string' ? lock : JSON.stringify(lock));
  return h;
}

const probe = (answers: { instance?: string | null; pidAlive?: boolean }): LockProbe => ({
  instanceAt: async () => answers.instance ?? null,
  neuralisPidAlive: () => answers.pidAlive ?? false,
  runs: () => answers.pidAlive ?? false,
});
const me = (kind: 'native' | 'docker', instanceId = 'me'): HomeLock => ({ kind, pid: process.pid, app: 'http://127.0.0.1:3100', instanceId });
const held = (kind: 'native' | 'docker', instanceId = 'them'): HomeLock => ({ kind, pid: 4242, app: 'http://127.0.0.1:3200', instanceId });

describe('judging the lock', () => {
  it('no file is free; its own id is own; an answering holder is live whatever its kind', async () => {
    expect(await judgeHomeLock(home(), me('native'), probe({}))).toEqual({ kind: 'free' });
    expect((await judgeHomeLock(home(held('native', 'me')), me('native'), probe({}))).kind).toBe('own');
    expect((await judgeHomeLock(home(held('docker')), me('native'), probe({ instance: 'them' }))).kind).toBe('live');
    expect((await judgeHomeLock(home(held('native')), me('docker'), probe({ instance: 'them' }))).kind).toBe('live');
    // An answer carrying ANOTHER id is a different process on that origin: not the holder.
    expect((await judgeHomeLock(home(held('native')), me('native'), probe({ instance: 'someone-else' }))).kind).toBe('stale');
  });

  it('silent: same kind ⇒ stale (native also needs its pid gone); a different kind ⇒ foreign, never stale', async () => {
    expect((await judgeHomeLock(home(held('native')), me('native'), probe({ pidAlive: false }))).kind).toBe('stale');
    expect((await judgeHomeLock(home(held('native')), me('native'), probe({ pidAlive: true }))).kind).toBe('live');
    expect((await judgeHomeLock(home(held('docker')), me('docker'), probe({ pidAlive: true }))).kind).toBe('stale');
    expect((await judgeHomeLock(home(held('native')), me('docker'), probe({}))).kind).toBe('foreign');
    expect((await judgeHomeLock(home(held('docker')), me('native'), probe({}))).kind).toBe('foreign');
  });

  it('Docker ↔ Docker: a lock its holder still refreshes is held though nothing answers from here; three missed beats make it stale; no beat at all keeps the old rule', async () => {
    const now = 1_000_000_000;
    const fresh = { ...held('docker'), heartbeatAt: now - 5_000 };
    expect((await judgeHomeLock(home(fresh), me('docker'), probe({}), now)).kind).toBe('live');
    expect(await acquireHomeLock(home(fresh), me('docker'), probe({}), now)).toMatchObject({ ok: false, verdict: { kind: 'live' } });
    const gone = { ...held('docker'), heartbeatAt: now - LOCK_FRESH_MS - 1 };
    expect((await judgeHomeLock(home(gone), me('docker'), probe({}), now)).kind).toBe('stale');
    expect((await judgeHomeLock(home(held('docker')), me('docker'), probe({}), now)).kind).toBe('stale');
    // A fresh beat never makes a DIFFERENT kind takeable, nor a foreign lock less foreign.
    expect((await judgeHomeLock(home(gone), me('native'), probe({}), now)).kind).toBe('foreign');
  });

  it('native on one machine: the holder\'s own process is the proof — gone ⇒ stale even with a fresh beat (no wait after a crash); alive ⇒ live', async () => {
    const now = 1_000_000_000;
    const fresh = { ...held('native'), heartbeatAt: now - 1_000 };
    expect((await judgeHomeLock(home(fresh), me('native'), probe({ pidAlive: false }), now)).kind).toBe('stale');
    expect((await judgeHomeLock(home(fresh), me('native'), probe({ pidAlive: true }), now)).kind).toBe('live');
  });

  it('the refusal names the lock file and how long ago its holder refreshed it — and says when it stopped', () => {
    const h = home();
    const now = 1_000_000_000;
    const fresh = homeLockedMessage(h, { ...held('docker'), heartbeatAt: now - 4_000 }, false, now).join('\n');
    expect(fresh).toContain(homeLockPath(h));
    expect(fresh).toContain('last refreshed 4 s ago.');
    const old = homeLockedMessage(h, { ...held('docker'), heartbeatAt: now - 7 * 60_000 }, false, now).join('\n');
    expect(old).toContain('last refreshed 7 min ago — its host has stopped refreshing it');
    expect(old).toContain('`docker compose ps`');
    // Judged live (its health answered) with a late beat: the refusal says it runs, never that it stopped.
    const late = homeLockedMessage(h, { ...held('native'), heartbeatAt: now - 51_000 }, true, now).join('\n');
    expect(late).toContain('last refreshed 51 s ago, yet its host is still running.');
    expect(late).not.toContain('stopped refreshing');
    expect(homeLockedMessage(h, held('native'), true, now).join('\n')).toContain(`Its lock: ${homeLockPath(h)}.`);
  });

  it('a file that is no lock is stale (no live holder of this code wrote it)', async () => {
    expect((await judgeHomeLock(home('{"kind":"native"'), me('native'), probe({}))).kind).toBe('stale');
    expect(readHomeLock(home('not json'))).toBe('corrupt');
  });
});

describe('the heartbeat', () => {
  it('rewrites only its own lock\'s heartbeatAt on every tick, and nothing after its stop', async () => {
    const h = home({ ...held('native', 'sup'), heartbeatAt: 1 });
    const stop = startLockHeartbeat(h, 'sup', 20);
    await new Promise((r) => setTimeout(r, 70));
    const beat = (readHomeLock(h) as HomeLock).heartbeatAt!;
    expect(beat).toBeGreaterThan(1);
    expect(readHomeLock(h)).toMatchObject({ instanceId: 'sup', pid: 4242 });
    stop();
    await new Promise((r) => setTimeout(r, 60));
    expect((readHomeLock(h) as HomeLock).heartbeatAt).toBe(beat);
    // Another holder's lock is never refreshed.
    const other = home({ ...held('native', 'them'), heartbeatAt: 1 });
    const stopOther = startLockHeartbeat(other, 'sup', 20);
    await new Promise((r) => setTimeout(r, 60));
    stopOther();
    expect((readHomeLock(other) as HomeLock).heartbeatAt).toBe(1);
  });
});

describe('a state write the OS refuses for a moment (Windows sharing violation)', () => {
  const tmpLeft = (h: string): string[] => readdirSync(dirname(homeLockPath(h))).filter((n) => n.endsWith('.update.tmp'));

  it('a transient EPERM/EBUSY/EACCES is retried within the bound and the write lands; no temp file is left', () => {
    for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
      const h = home(held('native', 'sup'));
      Object.assign(renameFault, { code, times: 2, calls: 0 });
      expect(updateHomeLock(h, 'sup', { state: 'ready' })).toBe(true);
      expect(renameFault.calls).toBe(3);
      expect(readHomeLock(h)).toMatchObject({ instanceId: 'sup', state: 'ready' });
      expect(tmpLeft(h)).toEqual([]);
    }
  });

  it('past the bound it throws, removes its temp file, leaves the held lock intact, and the next write (the heartbeat) carries the state', () => {
    const h = home({ ...held('native', 'sup'), state: 'starting', heartbeatAt: 1 });
    Object.assign(renameFault, { code: 'EPERM', times: 100, calls: 0 });
    expect(() => updateHomeLock(h, 'sup', { state: 'ready' })).toThrow(/EPERM/);
    renameFault.times = 0;
    expect(renameFault.calls).toBeLessThanOrEqual(6);
    expect(tmpLeft(h)).toEqual([]);
    // The floor: the file is still THIS holder's lock — nobody else can take the home.
    expect(readHomeLock(h)).toMatchObject({ instanceId: 'sup', pid: 4242, state: 'starting' });
    expect(updateHomeLock(h, 'sup', { heartbeatAt: 2 })).toBe(true);
    expect(readHomeLock(h)).toMatchObject({ state: 'ready', heartbeatAt: 2 });
  });

  it('a non-transient error is not retried (paired control)', () => {
    const h = home(held('native', 'sup'));
    Object.assign(renameFault, { code: 'ENOSPC', times: 1, calls: 0 });
    expect(() => updateHomeLock(h, 'sup', { state: 'ready' })).toThrow(/ENOSPC/);
    expect(renameFault.calls).toBe(1);
    expect(tmpLeft(h)).toEqual([]);
    expect(updateHomeLock(h, 'sup', { heartbeatAt: 3 })).toBe(true);
    expect(readHomeLock(h)).toMatchObject({ state: 'ready' });
  });
});

describe('taking, adopting and releasing it', () => {
  it('creates atomically with its content and leaves no temp file', async () => {
    const h = home();
    expect(await acquireHomeLock(h, me('native'), probe({}))).toEqual({ ok: true, adopted: false, tookOver: null });
    expect(readHomeLock(h)).toEqual(me('native'));
    expect(readdirSync(dirname(homeLockPath(h)))).toEqual(['host.lock']);
  });

  it('a live or a foreign holder refuses and the file is untouched; a stale same-kind one is replaced', async () => {
    const live = home(held('docker'));
    expect(await acquireHomeLock(live, me('native'), probe({ instance: 'them' }))).toMatchObject({ ok: false, verdict: { kind: 'live' } });
    const foreign = home(held('native'));
    expect(await acquireHomeLock(foreign, me('docker'), probe({}))).toMatchObject({ ok: false, verdict: { kind: 'foreign' } });
    expect(readHomeLock(foreign)).toEqual(held('native'));
    const stale = home(held('docker'));
    expect(await acquireHomeLock(stale, me('docker'), probe({}))).toMatchObject({ ok: true, tookOver: held('docker') });
    expect(readHomeLock(stale)).toEqual(me('docker'));
  });

  it('creates the lock on an EMPTY data home (no app/ yet) — the boot before setup must not crash; control: app/ present', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'nrs-home-lock-empty-'));
    roots.push(empty);
    expect(await acquireHomeLock(empty, me('native'), probe({}))).toEqual({ ok: true, adopted: false, tookOver: null });
    expect(readHomeLock(empty)).toEqual(me('native'));
    const ready = home();
    expect(await acquireHomeLock(ready, me('native'), probe({}))).toEqual({ ok: true, adopted: false, tookOver: null });
  });

  it('a stale lock another process keeps open (Windows: EBUSY/EPERM/EACCES on its delete) is a named refusal — the file stays, no second lock; released, it is taken over (paired control)', async () => {
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      const h = home(held('native'));
      unlinkFault.code = code;
      try {
        const refused = await acquireHomeLock(h, me('native'), probe({ pidAlive: false })).catch((err: unknown) => err);
        expect(refused).toBeInstanceOf(HomeLockBusyError);
        expect((refused as Error).message).toBe(`The lock at ${homeLockPath(h)} is stale (its holder, process 4242, is gone), but it could not be removed (${code}): another process still has the file open, or this user may not delete it. Close the program that has it open (a file viewer, a backup or a virus scan) and start Neuralis again. Nothing was started.`);
      } finally {
        unlinkFault.code = null;
      }
      expect(readHomeLock(h)).toEqual(held('native'));
      expect(readdirSync(dirname(homeLockPath(h)))).toEqual(['host.lock']);
      expect(await acquireHomeLock(h, me('native'), probe({ pidAlive: false }))).toMatchObject({ ok: true, tookOver: held('native') });
      expect(readHomeLock(h)).toEqual(me('native'));
    }
    // A Docker-kind stale lock is judged by its beat, not a pid: the refusal says so.
    const docker = home({ ...held('docker'), heartbeatAt: 1 });
    unlinkFault.code = 'EBUSY';
    try {
      const refused = await acquireHomeLock(docker, me('docker'), probe({})).catch((err: unknown) => err);
      expect((refused as Error).message).toContain('its Docker holder does not answer and has not refreshed it for 30 s');
    } finally {
      unlinkFault.code = null;
    }
  });

  it('a host handed the supervisor\'s id adopts its lock; the state update and the release touch only the own id', async () => {
    const h = home({ ...held('native', 'sup'), state: 'starting' });
    expect(await acquireHomeLock(h, me('native', 'sup'), probe({}))).toEqual({ ok: true, adopted: true, tookOver: null });
    expect(updateHomeLock(h, 'other', { state: 'ready' })).toBe(false);
    expect(updateHomeLock(h, 'sup', { state: 'ready' })).toBe(true);
    expect(readHomeLock(h)).toMatchObject({ instanceId: 'sup', state: 'ready', pid: 4242 });
    expect(releaseHomeLock(h, 'other')).toBe(false);
    expect(releaseHomeLock(h, 'sup')).toBe(true);
    expect(readHomeLock(h)).toBeNull();
  });
});

// Before any signal a recorded pid must RUN the bundle's own executable: a
// loose "its command line says neuralis" match lets a reused pid be killed.
describe('PROCESS_LOCK_PROBE.runs — the exact executable, never a name match', () => {
  it('names the script a node process runs (symlink-resolved), and refuses any other path or a foreign process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nrs-runs-neuralis-'));
    roots.push(dir);
    const script = join(dir, 'server.js');
    writeFileSync(script, 'setInterval(() => {}, 1000);');
    const linked = join(dir, 'link.js');
    symlinkSync(script, linked);
    const ours = spawn(process.execPath, [linked], { stdio: 'ignore' });
    // A foreign process whose command line still says "neuralis" (its path does).
    const foreign = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', join(dir, 'neuralis')], { stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 300));
      expect(PROCESS_LOCK_PROBE.runs(ours.pid!, script)).toBe(true);
      expect(PROCESS_LOCK_PROBE.runs(ours.pid!, join(dir, 'other.js'))).toBe(false);
      expect(PROCESS_LOCK_PROBE.neuralisPidAlive(foreign.pid!)).toBe(true); // the loose rule would claim it
      expect(PROCESS_LOCK_PROBE.runs(foreign.pid!, script)).toBe(false);
      expect(PROCESS_LOCK_PROBE.runs(999_999_9, script)).toBe(false);
    } finally {
      ours.kill('SIGKILL');
      foreign.kill('SIGKILL');
    }
  });
});

// A host `neuralis up` supervises must not outlive it and stops on its word on
// every OS: up spawns it with an `'ipc'` channel (`NEURALIS_SUPERVISOR=ipc`).
// The `shutdown` message and the channel's loss (the supervisor died, SIGKILL
// included) both reach the host's ordinary SIGTERM path. A real child, a real channel.
describe('followSupervisor — the host stops on its supervisor\'s word, and ends with it', () => {
  const HOME_LOCK = join(dirname(fileURLToPath(import.meta.url)), '..', 'homeLock.ts');
  const TSX = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs');

  const spawned: ChildProcess[] = [];
  afterAll(() => { for (const proc of spawned) if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); });

  function child(marked: boolean): { proc: ChildProcess; mark: string; armed: Promise<void> } {
    const dir = mkdtempSync(join(tmpdir(), 'nrs-follow-'));
    roots.push(dir);
    const script = join(dir, 'host.mts');
    const mark = join(dir, 'terminated');
    writeFileSync(script, [
      "import { writeFileSync } from 'node:fs';",
      `import { followSupervisor } from ${JSON.stringify(HOME_LOCK)};`,
      `process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(mark)}, 'SIGTERM'); process.exit(0); });`,
      "process.stdout.write(followSupervisor(process.env) + '\\n');",
      'setInterval(() => {}, 1_000);',
    ].join('\n'));
    const { NEURALIS_SUPERVISOR: _drop, ...base } = process.env;
    const proc = spawn(process.execPath, ['--import', pathToFileURL(TSX).href, script], {
      stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
      env: { ...base, ...(marked ? { NEURALIS_SUPERVISOR: 'ipc' } : {}) },
    });
    spawned.push(proc);
    const armed = new Promise<void>((resolve, reject) => {
      proc.stdout!.on('data', (chunk: Buffer) => { if (/following|unsupervised/.test(chunk.toString())) resolve(); });
      proc.once('exit', (code) => reject(new Error(`exited ${code} before arming`)));
    });
    return { proc, mark, armed };
  }

  const exited = (proc: ChildProcess, ms: number): Promise<boolean> => new Promise((resolve) => {
    if (proc.exitCode !== null) { resolve(true); return; }
    const timer = setTimeout(() => resolve(false), ms);
    proc.once('exit', () => { clearTimeout(timer); resolve(true); });
  });

  it('marked: the `shutdown` message reaches the SIGTERM path; any other message does not (paired control)', async () => {
    const supervised = child(true);
    await supervised.armed;
    supervised.proc.send('stop-please');
    expect(await exited(supervised.proc, 1_500)).toBe(false);
    expect(existsSync(supervised.mark)).toBe(false);
    supervised.proc.send('shutdown');
    expect(await exited(supervised.proc, 10_000)).toBe(true);
    expect(readFileSync(supervised.mark, 'utf-8')).toBe('SIGTERM');
  }, 30_000);

  it('marked: the channel\'s loss (the supervisor gone) reaches the SIGTERM path; unmarked (Docker, a clone): nothing happens', async () => {
    const supervised = child(true);
    await supervised.armed;
    supervised.proc.disconnect();
    expect(await exited(supervised.proc, 10_000)).toBe(true);
    expect(readFileSync(supervised.mark, 'utf-8')).toBe('SIGTERM');

    const free = child(false);
    await free.armed;
    free.proc.send('shutdown');
    free.proc.disconnect();
    expect(await exited(free.proc, 1_500)).toBe(false);
    expect(existsSync(free.mark)).toBe(false);
    free.proc.kill('SIGKILL');
    await exited(free.proc, 5_000);
  }, 30_000);

  it('a marker with no channel (a process that inherited the env, not the channel) is reported, never followed', () => {
    expect(followSupervisor({})).toBe('unsupervised');
    const noChannel = new EventEmitter() as unknown as SupervisedProcess;
    expect(followSupervisor({ NEURALIS_SUPERVISOR: 'ipc' }, noChannel)).toBe('no-pipe');
  });

  it('a channel already closed when the host looks (stopped while it booted) stops it at once; an open one waits', () => {
    const stand = (connected: boolean) => {
      const proc = Object.assign(new EventEmitter(), { connected, send: () => true, channel: { unref: () => {} } });
      const signalled: string[] = [];
      proc.on('SIGTERM', (sig: string) => signalled.push(sig));
      return { proc: proc as unknown as SupervisedProcess, signalled };
    };
    const closed = stand(false);
    expect(followSupervisor({ NEURALIS_SUPERVISOR: 'ipc' }, closed.proc)).toBe('following');
    expect(closed.signalled).toEqual(['SIGTERM']);
    const open = stand(true);
    expect(followSupervisor({ NEURALIS_SUPERVISOR: 'ipc' }, open.proc)).toBe('following');
    expect(open.signalled).toEqual([]);
  });
});

describe('liveness without /proc — each platform\'s reader, injected', () => {
  const bundle = '/Applications/Neuralis.app/Contents/Resources';
  const winBundle = 'C:\\Program Files\\Neuralis\\resources';

  it('macOS: the one `ps` line proves the executable at its start or right after a program named node — never as a later argument', () => {
    const exe = `${bundle}/host/_runtime/server.js`;
    const view = (command: string): ProcessView => ({ command });
    expect(viewRuns(view(`${bundle}/node/bin/node ${exe}`), exe, 'darwin')).toBe(true);
    expect(viewRuns(view(`/Users/Jo Doe/node/bin/node ${exe} --flag`), exe, 'darwin')).toBe(true);
    expect(viewRuns(view(`${bundle}/qdrant/qdrant`), `${bundle}/qdrant/qdrant`, 'darwin')).toBe(true);
    expect(viewRuns(view(`/usr/bin/vim ${exe}`), exe, 'darwin')).toBe(false);
    expect(viewRuns(view(`${bundle}/node/bin/node ${exe}.bak`), exe, 'darwin')).toBe(false);
    expect(viewRuns(view(`${bundle}/node/bin/node other.js ${exe}`), exe, 'darwin')).toBe(false);
  });

  it('Windows: the WMI program and command line, case-insensitive; a relative argument (no cwd known) is unproven', () => {
    const exe = `${winBundle}\\host\\_runtime\\server.js`;
    const node = `${winBundle}\\node\\node.exe`;
    expect(splitWindowsCommandLine(`"${node}" "${exe}" --x`)).toEqual([node, exe, '--x']);
    expect(splitWindowsCommandLine('a "b c" \\"d')).toEqual(['a', 'b c', '"d']);
    expect(viewRuns({ argv: [node, exe.toUpperCase()], cwd: null }, exe, 'win32')).toBe(true);
    expect(viewRuns({ argv: [`${winBundle}\\qdrant\\qdrant.exe`], cwd: null }, `${winBundle}\\qdrant\\qdrant.exe`, 'win32')).toBe(true);
    expect(viewRuns({ argv: [node, 'host\\_runtime\\server.js'], cwd: null }, exe, 'win32')).toBe(false);
    expect(viewRuns({ argv: [node, 'other.js', exe], cwd: null }, exe, 'win32')).toBe(false);
  });

  it('the probe asks the reader only when liveness is judged, and an unreadable process is never "ours"', () => {
    const asked: number[] = [];
    const exe = `${bundle}/host/bin/neuralis.mjs`;
    const reader = (answer: ProcessView | null) => (pid: number) => { asked.push(pid); return answer; };
    const mac = processLockProbe('darwin', reader({ command: `${bundle}/node/bin/node ${exe} up --foreground` }));
    expect(mac.runs(process.pid, exe)).toBe(true);
    expect(mac.neuralisPidAlive(process.pid)).toBe(true);
    expect(processLockProbe('darwin', reader({ command: '/usr/bin/vim notes.txt' })).neuralisPidAlive(process.pid)).toBe(false);
    expect(processLockProbe('win32', reader(null)).runs(process.pid, exe)).toBe(false);
    // A pid that does not exist: no reader call for neuralisPidAlive (the kill(0) answers first).
    const before = asked.length;
    expect(processLockProbe('darwin', reader({ command: exe })).neuralisPidAlive(2 ** 22 + 7)).toBe(false);
    expect(asked.length).toBe(before);
    // holderAlive asks for the bundle's supervisor — the kernel layout's host bin.
    const lock: HomeLock = { kind: 'native', pid: process.pid, app: 'http://127.0.0.1:1', instanceId: 'x', bundle };
    expect(holderAlive(lock, mac)).toBe(true);
    expect(holderAlive({ ...lock, bundle: '/elsewhere' }, mac)).toBe(false);
  });
});

describe('a home on a network share is refused by name', () => {
  it('Windows: a WSL tree (\\\\wsl$, \\\\wsl.localhost) and any other UNC share; a drive path and every non-Windows path pass', () => {
    expect(nonLocalHomeReason('\\\\wsl$\\Ubuntu\\home\\op\\.neuralis', 'win32')).toMatch(/WSL folder seen from Windows/);
    expect(nonLocalHomeReason('\\\\wsl.localhost\\Ubuntu\\home\\op\\.neuralis', 'win32')).toMatch(/WSL folder/);
    expect(nonLocalHomeReason('//WSL.LOCALHOST/Ubuntu/home/op/.neuralis', 'win32')).toMatch(/WSL folder/);
    expect(nonLocalHomeReason('\\\\fileserver\\share\\neuralis', 'win32')).toMatch(/network share/);
    expect(nonLocalHomeReason('C:\\Users\\op\\.neuralis', 'win32')).toBeNull();
    expect(nonLocalHomeReason('/home/op/.neuralis', 'linux')).toBeNull();
    expect(nonLocalHomeReason('//wsl$/Ubuntu', 'linux')).toBeNull();
  });
});

describe('a home whose filesystem has no hard links is refused by name', () => {
  it('a link() failure other than EEXIST (FAT/exFAT: EPERM, ENOTSUP, EOPNOTSUPP) is NonLocalHomeError naming the home — never a bare code — and leaves no file', async () => {
    for (const code of ['EPERM', 'ENOTSUP', 'EOPNOTSUPP']) {
      const h = home();
      linkFault.code = code;
      try {
        const refused = await acquireHomeLock(h, me('native'), probe({})).catch((err: unknown) => err);
        expect(refused).toBeInstanceOf(NonLocalHomeError);
        expect((refused as Error).message).toBe(`${h} is on a filesystem that cannot hold the host's lock (no hard links: ${code}) — FAT and exFAT drives cannot. A host needs its data folder on this computer's own drive (NTFS, APFS, ext4 or similar).`);
      } finally {
        linkFault.code = null;
      }
      expect(readdirSync(dirname(homeLockPath(h)))).toEqual([]);
    }
  });

  it('CONTROL — the same home with link() working takes the lock', async () => {
    const h = home();
    expect(await acquireHomeLock(h, me('native'), probe({}))).toEqual({ ok: true, adopted: false, tookOver: null });
  });
});
