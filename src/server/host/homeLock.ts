/**
 * ONE host per data home. Two hosts writing one `~/.neuralis` tree — the Docker
 * stack and the desktop app on the same machine — corrupt it, so the first one
 * holds `<home>/app/host.lock` and every later one asks it whether it is alive.
 *
 * The lock body is `{kind, pid, app, instanceId}`: `kind` is where the holder
 * runs (`docker` | `native`), `app` the origin a process on the HOST reaches it
 * on, `instanceId` a per-process random id `/api/health` echoes. Liveness is
 * ONE health request to `app` that answers with the same `instanceId` — a pid
 * means nothing across the container boundary.
 *
 * Takeover is SAME-KIND only. Every holder rewrites `heartbeatAt` every
 * `LOCK_HEARTBEAT_MS` (10 s). A Docker lock refreshed within three of those is
 * live whatever the health probe says — the proof that crosses network
 * namespaces (two containers on one home each probe their OWN loopback and
 * see no pid of the other, so silence alone proved nothing there); one with no
 * `heartbeatAt` (written by a build before it) has unknown freshness and is
 * judged as before. A native judge reaches a native holder on the same
 * loopback, so a silent native lock is stale once the holder's pid is gone (a
 * supervisor between two restarts answers no health) — the pid is the proof
 * on one machine, so its beat is not waited for. A
 * DIFFERENT-kind holder that does not answer is never taken over: a container
 * probing a native holder's `127.0.0.1:<port>` reaches its own network namespace,
 * not the machine's, so silence proves nothing there. That is a named refusal
 * (`HOME_LOCKED`, exit 11) the operator clears with `neuralis down` or, for
 * a Docker holder, `docker compose stop neuralis` in its install folder; a
 * Docker lock its holder left behind (a killed container) is cleared by
 * starting and cleanly stopping that app once, or by deleting the file.
 *
 * Creation is atomic with its content (a temp file `link()`ed into place — never
 * an empty `wx` file a concurrent reader could judge stale). The desktop
 * supervisor (`neuralis up`) takes the lock before it spawns the host and hands
 * the host its `instanceId` (`NEURALIS_INSTANCE_ID`); the host adopts a lock
 * carrying its own id and leaves its release to the supervisor, which outlives
 * a restart of the host — and stops with it (`followSupervisor`). A host that
 * took the lock itself (the container, a clone's `next start`) releases it
 * through the shutdown owner and on process exit. Every release removes the
 * file only while it carries the releaser's id.
 *
 * A home on a network share is refused by name (`nonLocalHomeReason`): the
 * atomic `link()` above, change notification and Qdrant's storage need a local
 * filesystem, and a WSL tree seen from Windows (`\\wsl$`, `\\wsl.localhost`)
 * may have a second host running on it inside WSL. A filesystem that has no
 * hard links (FAT, exFAT) fails that `link()` and is refused by name too
 * (`NonLocalHomeError`), never with a bare error code. Residual: a drive letter
 * mapped onto a share (`net use Z: \\srv\share`) passes the name check, and
 * an SMB server that answers `link()` passes the lock too.
 *
 * Node built-ins and the kernel only: `neuralis up` (a host script) imports this same file.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';

import { bundleLayout, detectDocker, resolveNeuralisHome } from '@neuralis/package-system/paths';
import { resolveTrustedAppOrigin } from '../oauth/appOrigin';

export type HomeLockKind = 'docker' | 'native';

/** The supervisor's own phases, written into its lock (a host it adopted never rewrites it). */
export type HomeLockState = 'starting' | 'ready' | 'restarting' | 'failed';

export interface HomeLock {
  kind: HomeLockKind;
  pid: number;
  /** The origin a process on the HOST reaches the holder's `/api/health` on. */
  app: string;
  instanceId: string;
  state?: HomeLockState;
  /** Set with `state: 'failed'`: which child gave up and its last exit code. */
  failed?: { child: 'host' | 'qdrant'; code: number };
  /** A supervisor's children (`neuralis up`), rewritten at every (re)start: what `neuralis down` stops when the supervisor is gone. */
  hostPid?: number;
  qdrantPid?: number;
  /** Its optional companions: this home's own Ollama binary and the tunnel connector (both outside the bundle, in the data home). */
  ollamaPid?: number;
  tunnelPid?: number;
  /** A supervisor's bundle (`<resources>`): the exact executables its pids must run before any signal (the kernel's `bundleLayout`). */
  bundle?: string;
  /**
   * A supervisor's random stop nonce: `neuralis down` on Windows, which has no
   * signal to send, asks the supervisor to stop with a request file carrying it
   * (`up.mts` `askSupervisorToStop` / `watchStopRequests`). Only a reader of this lock — its owner — knows it.
   */
  stopNonce?: string;
  /** When the holder last rewrote this lock (epoch ms) — every `LOCK_HEARTBEAT_MS` while it runs. */
  heartbeatAt?: number;
}

/** How often a holder refreshes its lock's `heartbeatAt`: one small rewrite (temp + rename) per tick. */
export const LOCK_HEARTBEAT_MS = 10_000;

/** A lock refreshed within this window is held, whatever the health probe answered (three missed beats). */
export const LOCK_FRESH_MS = 3 * LOCK_HEARTBEAT_MS;

/** Is `lock` refreshed recently enough to be held? False when it carries no heartbeat (unknown freshness). */
export function heartbeatFresh(lock: HomeLock, now: number): boolean {
  return typeof lock.heartbeatAt === 'number' && now - lock.heartbeatAt < LOCK_FRESH_MS;
}

/**
 * Why `home` cannot hold a host here, or null: a Windows UNC path — a WSL tree
 * (`\\wsl$\…`, `\\wsl.localhost\…`) or any other network share — has no
 * dependable `link()`, change notification or Qdrant storage. Named, never
 * guessed around.
 */
export function nonLocalHomeReason(home: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'win32') return null;
  const path = home.replace(/\//g, '\\');
  if (!path.startsWith('\\\\')) return null;
  const wsl = /^\\\\(\?\\UNC\\)?wsl(\$|\.localhost)\\/i.test(path);
  return wsl
    ? `${home} is a WSL folder seen from Windows. A host here could not lock it, watch it or keep its vectors safely, and the WSL host may be running on it — start Neuralis inside WSL, or use a data folder on this computer's own drive.`
    : `${home} is on a network share. A host needs its data folder on this computer's own drive (it locks, watches and stores vectors there).`;
}

/**
 * A data home whose filesystem cannot hold the lock: its `link()` failed other
 * than with `EEXIST` (no hard links — FAT, exFAT). The message is the refusal.
 */
export class NonLocalHomeError extends Error {
  constructor(home: string, code: string | undefined) {
    super(`${home} is on a filesystem that cannot hold the host's lock (no hard links: ${code ?? 'link failed'}) — FAT and exFAT drives cannot. A host needs its data folder on this computer's own drive (NTFS, APFS, ext4 or similar).`);
    this.name = 'NonLocalHomeError';
  }
}

/**
 * A stale lock (its holder is gone) that could not be removed: the OS refused
 * the delete (`EBUSY`, `EPERM`, `EACCES` — on Windows another process holds the
 * file open without letting it be deleted). Never retried into a takeover: the
 * file stays, nothing starts, and the message is the refusal (`HOME_LOCKED`).
 */
export class HomeLockBusyError extends Error {
  constructor(home: string, holder: HomeLock | 'corrupt', code: string) {
    const who = holder === 'corrupt'
      ? 'it is not a valid lock'
      : holder.kind === 'docker' ? `its Docker holder does not answer and has not refreshed it for ${LOCK_FRESH_MS / 1000} s` : `its holder, process ${holder.pid}, is gone`;
    super(`The lock at ${homeLockPath(home)} is stale (${who}), but it could not be removed (${code}): another process still has the file open, or this user may not delete it. Close the program that has it open (a file viewer, a backup or a virus scan) and start Neuralis again. Nothing was started.`);
    this.name = 'HomeLockBusyError';
  }
}

/** The exit code a refused start ends with — the `neuralis up` contract's `HOME_LOCKED`. */
export const EXIT_HOME_LOCKED = 11;

/** One health probe at start; a holder slower than this to answer is treated as silent. */
export const LOCK_PROBE_TIMEOUT_MS = 2_000;

export function homeLockPath(home: string): string {
  return join(home, 'app', 'host.lock');
}

function isLock(value: unknown): value is HomeLock {
  const v = value as Partial<HomeLock> | null;
  return Boolean(v) && (v!.kind === 'docker' || v!.kind === 'native') && Number.isInteger(v!.pid)
    && typeof v!.app === 'string' && typeof v!.instanceId === 'string' && v!.instanceId.length > 0;
}

/** The lock on disk; `null` when there is none. A file that is no lock reads as `'corrupt'`. */
export function readHomeLock(home: string): HomeLock | null | 'corrupt' {
  let text: string;
  try {
    text = readFileSync(homeLockPath(home), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return 'corrupt';
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isLock(parsed) ? parsed : 'corrupt';
  } catch {
    return 'corrupt';
  }
}

/** What liveness asks of the world — injectable for tests. */
export interface LockProbe {
  /** The `instanceId` `<app>/api/health` reports, or null when nothing answers with one. */
  instanceAt(app: string): Promise<string | null>;
  /** The process exists on THIS machine and is a Neuralis process (its command line says so) — liveness only, never enough to signal it. */
  neuralisPidAlive(pid: number): boolean;
  /** The process runs exactly `executable` (its program or script, symlinks resolved): what a pid must prove before a signal. */
  runs(pid: number, executable: string): boolean;
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * What the OS says one process runs, or null when it is gone or unreadable:
 * Linux `argv` and `cwd` (from `/proc`); Windows `argv` (the program from
 * `ExecutablePath`, the rest parsed from `CommandLine`) and no cwd; macOS the
 * one `ps -o command=` line, which cannot be split where a path holds a space.
 */
export type ProcessView =
  | { argv: string[]; cwd: string | null }
  | { command: string };

/** Reads one process's view; injectable so each platform's matching is testable on any machine. */
export type ProcessReader = (pid: number) => ProcessView | null;

/**
 * The OS reader for `platform`. Every read is one bounded synchronous call
 * (`/proc` files; `ps` on macOS; one PowerShell `Win32_Process` query on
 * Windows), made only where liveness is judged — taking or judging the lock,
 * `status`, `down` and the orphan proof — never on a timer.
 */
export function osProcessReader(platform: NodeJS.Platform = process.platform): ProcessReader {
  if (platform === 'darwin') {
    return (pid) => {
      const res = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf-8', timeout: 5_000, windowsHide: true });
      const command = res.status === 0 ? res.stdout.trim() : '';
      return command ? { command } : null;
    };
  }
  if (platform === 'win32') {
    return (pid) => {
      if (!Number.isInteger(pid) || pid <= 0) return null;
      const query = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { [Console]::Out.Write((@{ exe = $p.ExecutablePath; cmd = $p.CommandLine } | ConvertTo-Json -Compress)) }`;
      const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], { encoding: 'utf-8', timeout: 15_000, windowsHide: true });
      if (res.status !== 0 || !res.stdout.trim()) return null;
      try {
        const found = JSON.parse(res.stdout) as { exe?: unknown; cmd?: unknown };
        const argv = typeof found.cmd === 'string' ? splitWindowsCommandLine(found.cmd) : [];
        if (typeof found.exe === 'string' && found.exe) argv.splice(0, argv.length > 0 ? 1 : 0, found.exe);
        return argv.length > 0 ? { argv, cwd: null } : null;
      } catch {
        return null;
      }
    };
  }
  return (pid) => {
    try {
      return {
        argv: readFileSync(`/proc/${pid}/cmdline`, 'utf-8').split('\0').filter(Boolean),
        cwd: readlinkSync(`/proc/${pid}/cwd`),
      };
    } catch {
      return null;
    }
  };
}

/**
 * A Windows command line split on spaces and tabs outside double quotes; a
 * quote toggles grouping and `\"` is a literal quote. Enough for the quoted
 * executable paths this file compares; the C runtime's rule for a run of
 * backslashes before a quote is not modelled.
 */
export function splitWindowsCommandLine(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let any = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '\\' && line[i + 1] === '"') { current += '"'; i += 1; any = true; continue; }
    if (ch === '"') { quoted = !quoted; any = true; continue; }
    if (!quoted && (ch === ' ' || ch === '\t')) {
      if (any) out.push(current);
      current = '';
      any = false;
      continue;
    }
    current += ch;
    any = true;
  }
  if (any) out.push(current);
  return out;
}

/**
 * Does `view` run `executable` as its program or as the program's first
 * argument (a script run by Node)? Linux resolves a relative argument against
 * the process's cwd; Windows compares case-insensitively; macOS reads the one
 * command line: the path at its start, or right after a program named `node`.
 * Anything else — a relative path where no cwd is known — is unproven.
 */
export function viewRuns(view: ProcessView, executable: string, platform: NodeJS.Platform): boolean {
  const wants = [...new Set([executable, realOrSelf(executable)])];
  if ('command' in view) {
    return wants.some((want) => {
      if (view.command === want || view.command.startsWith(`${want} `)) return true;
      for (let at = view.command.indexOf(` ${want}`); at >= 0; at = view.command.indexOf(` ${want}`, at + 1)) {
        const after = view.command[at + 1 + want.length];
        if ((after === undefined || after === ' ') && /(^|\/)node$/.test(view.command.slice(0, at))) return true;
      }
      return false;
    });
  }
  const windows = platform === 'win32';
  const norm = (p: string): string => (windows ? win32.resolve(p).toLowerCase() : p);
  const targets = new Set(wants.map(norm));
  return view.argv.slice(0, 2).some((arg) => {
    if (view.cwd === null && !(windows ? win32.isAbsolute(arg) : isAbsolute(arg))) return false;
    const full = view.cwd === null ? arg : resolve(view.cwd, arg);
    return targets.has(norm(full)) || targets.has(norm(realOrSelf(full)));
  });
}

/** The real probe for `platform`, reading processes through `read`. */
export function processLockProbe(platform: NodeJS.Platform = process.platform, read: ProcessReader = osProcessReader(platform)): LockProbe {
  return {
    async instanceAt(app) {
      try {
        const response = await fetch(new URL('/api/health', app), { signal: AbortSignal.timeout(LOCK_PROBE_TIMEOUT_MS), redirect: 'error' });
        const body = (await response.json()) as { instanceId?: unknown };
        return typeof body.instanceId === 'string' ? body.instanceId : null;
      } catch {
        return null;
      }
    },
    neuralisPidAlive(pid) {
      try {
        process.kill(pid, 0);
      } catch {
        // ESRCH: gone. EPERM: another user's process — not the one that wrote this lock.
        return false;
      }
      const view = read(pid);
      // Unreadable (no answer from the OS): the pid alone is the answer.
      if (!view) return true;
      return /neuralis/i.test('command' in view ? view.command : view.argv.join(' '));
    },
    runs(pid, executable) {
      const view = read(pid);
      return view !== null && viewRuns(view, executable, platform); // gone, another user's, or unreadable: unproven is not ours
    },
  };
}

export const PROCESS_LOCK_PROBE: LockProbe = processLockProbe();

/** Is the lock's own process alive? Its exact supervisor when the lock names a bundle. */
export function holderAlive(lock: HomeLock, probe: LockProbe): boolean {
  return lock.bundle ? probe.runs(lock.pid, bundleLayout(lock.bundle).hostBin) : probe.neuralisPidAlive(lock.pid);
}

export type LockVerdict =
  | { kind: 'free' }
  | { kind: 'own'; lock: HomeLock }
  | { kind: 'live'; lock: HomeLock }
  /** Safe to take over: same kind, silent (and for `native`, its pid gone). */
  | { kind: 'stale'; lock: HomeLock | 'corrupt' }
  /** A different-kind holder that does not answer: never taken over. */
  | { kind: 'foreign'; lock: HomeLock };

/** Judge the lock in `home` for a would-be holder of `kind` and `instanceId`. */
export async function judgeHomeLock(home: string, self: { kind: HomeLockKind; instanceId: string }, probe: LockProbe = PROCESS_LOCK_PROBE, now: number = Date.now()): Promise<LockVerdict> {
  const lock = readHomeLock(home);
  if (lock === null) return { kind: 'free' };
  // A file that is no lock was written by no live holder of this code: nothing to ask.
  if (lock === 'corrupt') return { kind: 'stale', lock };
  if (lock.instanceId === self.instanceId) return { kind: 'own', lock };
  if ((await probe.instanceAt(lock.app)) === lock.instanceId) return { kind: 'live', lock };
  if (lock.kind !== self.kind) return { kind: 'foreign', lock };
  // Native on the same machine: the holder's own process is the proof (gone ⇒ stale at once, no wait for its beat).
  if (lock.kind === 'native') return holderAlive(lock, probe) ? { kind: 'live', lock } : { kind: 'stale', lock };
  // Docker: two containers never see each other's loopback or pids — a lock still refreshed by its holder is held.
  if (heartbeatFresh(lock, now)) return { kind: 'live', lock };
  return { kind: 'stale', lock };
}

/** Write `lock` as a new file, atomically with its content; false when a lock already exists. */
function createLockFile(home: string, lock: HomeLock): boolean {
  const path = homeLockPath(home);
  const tmp = `${path}.${process.pid}.${lock.instanceId}.tmp`;
  // A host boots on an empty data home too (before setup), where `app/` does not exist yet.
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(lock)}\n`, { encoding: 'utf-8', mode: 0o600 });
  try {
    linkSync(tmp, path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    throw new NonLocalHomeError(home, code);
  } finally {
    unlinkSync(tmp);
  }
}

export type AcquireResult =
  | { ok: true; adopted: boolean; tookOver: HomeLock | 'corrupt' | null }
  | { ok: false; verdict: Extract<LockVerdict, { kind: 'live' | 'foreign' }> };

/**
 * Take the lock for `lock.kind`/`lock.instanceId`: create it, adopt one that
 * already carries this id, or replace a stale same-kind one (re-read right
 * before the delete, so a lock that changed hands meanwhile is judged again).
 */
export async function acquireHomeLock(home: string, lock: HomeLock, probe: LockProbe = PROCESS_LOCK_PROBE, now: number = Date.now()): Promise<AcquireResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const verdict = await judgeHomeLock(home, lock, probe, now);
    if (verdict.kind === 'own') return { ok: true, adopted: true, tookOver: null };
    if (verdict.kind === 'live' || verdict.kind === 'foreign') return { ok: false, verdict };
    if (verdict.kind === 'stale') {
      const now = readHomeLock(home);
      const same = now === 'corrupt' ? verdict.lock === 'corrupt' : now !== null && verdict.lock !== 'corrupt' && now.instanceId === verdict.lock.instanceId;
      if (!same) continue;
      try {
        unlinkSync(homeLockPath(home));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code && TRANSIENT_RENAME_CODES.has(code)) throw new HomeLockBusyError(home, verdict.lock, code);
        if (code !== 'ENOENT') throw err;
      }
      if (createLockFile(home, lock)) return { ok: true, adopted: false, tookOver: verdict.lock };
      continue;
    }
    if (createLockFile(home, lock)) return { ok: true, adopted: false, tookOver: null };
  }
  throw new Error(`${homeLockPath(home)} kept changing hands while this process tried to take it`);
}

type HomeLockPatch = Partial<Pick<HomeLock, 'state' | 'failed' | 'pid' | 'hostPid' | 'qdrantPid' | 'ollamaPid' | 'tunnelPid' | 'heartbeatAt'>>;

/** Windows answers a rename over (or a delete of) a file another process has open with one of these, for as long as the reader holds it. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** The waits between rename attempts (ms): five attempts, ≤ 375 ms blocked, and only on a refused rename. */
const RENAME_RETRY_WAITS_MS = [25, 50, 100, 200] as const;
/** Patches a failed write could not land, per held lock — the next write of that lock (the heartbeat's) carries them. */
const unwrittenPatches = new Map<string, HomeLockPatch>();

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      const wait = RENAME_RETRY_WAITS_MS[attempt];
      if (wait === undefined || !TRANSIENT_RENAME_CODES.has(code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }
}

/**
 * Rewrite the lock this process holds (the supervisor's state); a lock with
 * another id is left alone. The ONE writer of a held lock — `up`'s state and
 * the heartbeat both write through it. A rename Windows refuses while a reader
 * holds the file is retried within a bound; a write that still fails throws,
 * removes its temp file and leaves the previous lock — still this holder's —
 * in place (never two hosts on one home), and its patch rides the next write.
 */
export function updateHomeLock(home: string, instanceId: string, patch: HomeLockPatch): boolean {
  const current = readHomeLock(home);
  if (current === null || current === 'corrupt' || current.instanceId !== instanceId) return false;
  const path = homeLockPath(home);
  const key = `${path}\0${instanceId}`;
  const merged = { ...unwrittenPatches.get(key), ...patch };
  const tmp = `${path}.${process.pid}.update.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify({ ...current, ...merged })}\n`, { encoding: 'utf-8', mode: 0o600 });
    renameWithRetry(tmp, path);
  } catch (err) {
    unwrittenPatches.set(key, merged);
    try { unlinkSync(tmp); } catch { /* never written, or already gone */ }
    throw err;
  }
  unwrittenPatches.delete(key);
  return true;
}

/**
 * Refresh this holder's `heartbeatAt` every `LOCK_HEARTBEAT_MS` until the
 * returned stop runs. Unreferenced: it never holds the process open. A beat
 * that fails to write (a full disk, a reader holding the file on Windows) is
 * retried at the next tick; three missed beats in a row let a same-kind
 * successor take the lock, which is the point.
 */
export function startLockHeartbeat(home: string, instanceId: string, everyMs: number = LOCK_HEARTBEAT_MS): () => void {
  const timer = setInterval(() => {
    try {
      updateHomeLock(home, instanceId, { heartbeatAt: Date.now() });
    } catch {
      // the next tick writes again
    }
  }, everyMs);
  timer.unref();
  return () => { clearInterval(timer); };
}

/** Remove the lock if it still carries `instanceId`; true when it did. */
export function releaseHomeLock(home: string, instanceId: string): boolean {
  const current = readHomeLock(home);
  if (current === null || current === 'corrupt' || current.instanceId !== instanceId) return false;
  try {
    unlinkSync(homeLockPath(home));
    return true;
  } catch {
    return false;
  }
}

/** How long ago, in words: `42 s`, `7 min`, `3 h`. */
function ageText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 120 ? `${s} s` : s < 7_200 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3_600)} h`;
}

/** The refusal a second host prints: which kind holds the tree, its lock file and when it was last refreshed, and what clears it. `answered`: the holder was judged live (its health answer, its running process or a fresh beat). */
export function homeLockedMessage(home: string, holder: HomeLock, answered: boolean, now: number = Date.now()): string[] {
  const how = holder.kind === 'docker' ? '`docker compose stop neuralis` in its install folder (its Qdrant keeps running)' : '`neuralis down`';
  const beat = typeof holder.heartbeatAt === 'number'
    ? ` Its lock (${homeLockPath(home)}) was last refreshed ${ageText(now - holder.heartbeatAt)} ago${heartbeatFresh(holder, now) ? '' : answered ? ', yet its host is still running' : ' — its host has stopped refreshing it'}.`
    : ` Its lock: ${homeLockPath(home)}.`;
  return [
    `A ${holder.kind === 'docker' ? 'Docker' : 'desktop (native)'} Neuralis host holds this data home (${home}): ${holder.app}${answered ? ' is running' : ' does not answer from here'}.${beat}`,
    `Two hosts on one data home corrupt it. Stop that one first — ${how} — then start this one.`,
    ...(holder.kind === 'docker' && !answered
      ? [`If \`docker compose ps\` in its install folder shows no running app (it stopped without letting go): start it once and stop it cleanly, or delete ${homeLockPath(home)} yourself — a desktop host never takes a Docker lock over (only another Docker host does, once that lock has gone 30 s without a refresh).`]
      : []),
  ];
}

const INSTANCE_ID_SLOT = Symbol.for('@neuralis/host:instanceId');

/**
 * This process's id — the one the lock and `/api/health` carry. The supervisor
 * hands its child the id it locked with (`NEURALIS_INSTANCE_ID`); otherwise a
 * fresh one per process. `globalThis`-anchored: the health route and the boot
 * claim are compiled into different server graphs.
 */
export function currentInstanceId(): string {
  const g = globalThis as { [INSTANCE_ID_SLOT]?: string };
  return (g[INSTANCE_ID_SLOT] ??= process.env.NEURALIS_INSTANCE_ID?.trim() || randomUUID());
}

/** The marker `neuralis up` sets on its host child, whose stdio carries an `'ipc'` channel to it. */
export const SUPERVISOR_ENV = 'NEURALIS_SUPERVISOR';

/** The one message the supervisor sends its host over that channel: stop, exactly as on SIGTERM. */
export const SUPERVISOR_SHUTDOWN_MESSAGE = 'shutdown';

/** The part of a Node process the supervisor channel uses — the real `process`, or a test double. */
export type SupervisedProcess = Pick<NodeJS.Process, 'on' | 'once' | 'emit' | 'connected' | 'send' | 'channel'>;

/**
 * A host `neuralis up` supervises never outlives it, and stops on its word on
 * every OS. The supervisor spawns it with an `'ipc'` channel: the message
 * `shutdown` (Windows delivers no SIGTERM — a `kill` there is
 * `TerminateProcess`) and the channel's `disconnect` (the supervisor died,
 * SIGKILL included) both stop the host as a SIGTERM does — the SIGTERM event
 * itself, so the shutdown owner (`shutdown.ts`, it drains first) and Next's own
 * server cleanup run exactly as on a signal. A channel already closed when
 * this runs (the supervisor stopped or died while the host was still booting,
 * and the event fired before anyone listened) stops it at once. No marker
 * (Docker, a clone's `next start`): nothing; a marker on a process that never
 * had a channel is reported (`'no-pipe'`), never followed. Cost: the channel
 * Node already holds, unreferenced, no timer.
 */
export function followSupervisor(env: Readonly<Record<string, string | undefined>>, proc: SupervisedProcess = process): 'unsupervised' | 'following' | 'no-pipe' {
  if (env[SUPERVISOR_ENV] === undefined) return 'unsupervised';
  if (typeof proc.send !== 'function') return 'no-pipe';
  let gone = false;
  const stop = (): void => {
    if (gone) return;
    gone = true;
    proc.emit('SIGTERM', 'SIGTERM');
  };
  if (!proc.connected) {
    stop();
    return 'following';
  }
  proc.on('message', (message: unknown) => { if (message === SUPERVISOR_SHUTDOWN_MESSAGE) stop(); });
  proc.once('disconnect', stop);
  // The listeners above re-reference the channel; the supervisor's life must not hold this process open.
  proc.channel?.unref();
  return 'following';
}

type AddShutdownStep = (label: string, run: () => void | Promise<void>) => void;

/**
 * The host's own claim, FIRST in `instrumentation.register()` after the signal
 * handlers: take (or adopt) the lock for this data home, release it through the
 * shutdown owner and on exit. A live or a different-kind holder ends this
 * process with `HOME_LOCKED` and the reason in the log (so does a stale lock
 * another process keeps open, `HomeLockBusyError`), a home on a network
 * share (`nonLocalHomeReason`) or on a filesystem with no hard links
 * (`NonLocalHomeError`) with 1 — nothing booted. The origin is the declared app origin (the one OAuth uses): what a
 * process on the host reaches this one on.
 */
export async function claimHomeLock(addShutdownStep: AddShutdownStep, probe: LockProbe = PROCESS_LOCK_PROBE): Promise<void> {
  const { home } = resolveNeuralisHome();
  const log = (await import('../logging/setup')).getLogger().child('home-lock');
  const nonLocal = nonLocalHomeReason(home);
  if (nonLocal) {
    log.error(nonLocal);
    process.exit(1);
  }
  const lock: HomeLock = { kind: detectDocker() ? 'docker' : 'native', pid: process.pid, app: resolveTrustedAppOrigin(), instanceId: currentInstanceId(), heartbeatAt: Date.now() };
  let result: AcquireResult;
  try {
    result = await acquireHomeLock(home, lock, probe);
  } catch (err) {
    if (err instanceof HomeLockBusyError) {
      log.error(err.message);
      process.exit(EXIT_HOME_LOCKED);
    }
    if (!(err instanceof NonLocalHomeError)) throw err;
    log.error(err.message);
    process.exit(1);
  }
  if (!result.ok) {
    for (const line of homeLockedMessage(home, result.verdict.lock, result.verdict.kind === 'live')) log.error(line);
    process.exit(EXIT_HOME_LOCKED);
  }
  if (result.tookOver) log.info(`Took over a stale lock at ${homeLockPath(home)} (its holder no longer answers).`);
  if (followSupervisor(process.env) === 'no-pipe') log.warn(`${SUPERVISOR_ENV} is set but this process has no channel to its supervisor: it will not stop with it.`);
  // An adopted lock is the supervisor's: it outlives a restart of this process, `neuralis up` refreshes and releases it.
  if (result.adopted) return;
  const stopBeat = startLockHeartbeat(home, lock.instanceId);
  addShutdownStep('home lock', () => { stopBeat(); releaseHomeLock(home, lock.instanceId); });
  process.once('exit', () => { releaseHomeLock(home, lock.instanceId); });
}
