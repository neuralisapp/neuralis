/**
 * `neuralis up | down | status` — the desktop app's host, run on the machine
 * itself: the image's own tree (`<resources>/host`, the kernel's `native`
 * install kind) supervised by this one process instead of a container and a
 * compose file.
 *
 *   neuralis up --foreground   start Qdrant and the host, print ONE JSON `ready` line on stdout (a
 *                              `locked` line naming the holder instead when another host holds the
 *                              home), supervise until SIGTERM/SIGINT or stdin closes (the desktop app's form)
 *   neuralis up                the same, detached; its output goes to <home>/app/logs/host.log
 *   neuralis down              stop the host holding this data home (its lock's process), wait ≤ 30 s;
 *                              a killed supervisor's children still running are stopped first
 *   neuralis status [--json]   stopped | starting | ready | restarting | failed
 *
 * The data home is `NEURALIS_HOME` alone; its `.env` is `<home>/app/config/.env`
 * (the kernel's `nativeConfigDir`). This process plays the compose file's part:
 * it AUTHORS each child's environment from that `.env` plus a fixed set — never
 * its own login environment, never `NEURALIS_DOCKER` / `NEURALIS_HOST_HOME` —
 * binds everything to `NEURALIS_BIND_HOST`, and forwards the MCP-Apps sandbox
 * origin (`NEURALIS_MCP_SANDBOX_PORT`) to the app port with a byte pipe: the
 * `Host` header keeps the sandbox port, so the request proxy fences it exactly
 * as it does behind Docker's second publish.
 *
 * Start order: the data-home lock (`HOME_LOCKED`) → an owner
 * (`FIRST_RUN_REQUIRED`), the session secret file (a home set up by an older
 * Docker install: exit 1, upgrade it there first) and this host's own `.env`
 * (`NATIVE_CONFIG_REQUIRED`: a home set up by Docker, which
 * `setup --native --yes` adopts) → pending offline upgrades (`UPGRADE_REQUIRED`) →
 * every port free (`PORT_TAKEN`) → the confinement helper (verified, else the
 * confined local shell stays dark and the log names why) → Qdrant: the
 * binary in binary mode; in docker mode (this home's own compose file) and
 * external mode with a recorded install folder, that folder's vector-store
 * service through the one starter (`ensureCompanion`: `up -d --no-deps
 * <vectorstore>` — never the Docker app's service), then a bounded wait for its
 * `/healthz` and one keyed request (a store that does not answer or refuses the
 * key still starts the host, and the `ready` line says so; one this run could
 * not start is started again on the optional-companion cadence until it
 * answers) → the host → the sandbox
 * pipe → `/api/health` 200 carrying this run's instance id. When this run
 * stops, this home's OWN Qdrant in Docker (docker mode) is stopped after the
 * host (`stopCompanion`, bounded); the Docker install's (external mode) keeps
 * serving its app, and a host restart (the host child exits, this process
 * starts it again) stops nothing. After the FIRST ready line the optional
 * companions start, none of them waited for or fatal to the host: this home's
 * own Ollama (`OLLAMA_MODE=binary`: the pinned release fetched into the data home
 * when missing and supervised on loopback; `docker`: its companions-file
 * container through the same starter) with its embedding model pulled when
 * absent, and the tunnel connector (`NEURALIS_TUNNEL=cloudflare`) — after ready,
 * so nothing reaches the host from outside before it answers here. An optional
 * child that exits is retried, at most once per 30 s, and never ends the run.
 * Bound to every address (the LAN switch), this machine still reaches the
 * host on loopback (`origins`). The
 * bundle's integrity is NOT checked here — a process inside the bundle cannot
 * vouch for it; the desktop app checks it before spawning this.
 *
 * Supervision is event-driven (a child's `exit`) with a 1/2/4/8/16 s backoff per
 * child; becoming ready again resets it, and a sixth death in a row ends the
 * run (`CHILD_FAILED`). The only polling is bounded and at start: Qdrant's
 * `/healthz` and the host's `/api/health` until they answer. The host is spawned
 * with an `'ipc'` channel to this process (`followSupervisor`): the stop is the
 * message `shutdown` on every OS (Windows has no SIGTERM to send), and the
 * channel's loss stops the host even when this process is SIGKILLed; the lock
 * records both children's pids for `down` and the next `up`, which stop what a
 * killed supervisor left running (Qdrant cannot follow the channel) before they
 * clear or take over its lock.
 *
 * The bundle's paths are the kernel's ONE `bundleLayout`; each child's
 * environment starts from the platform's authored base (`authoredBaseEnv`:
 * `PATH` with the platform's delimiter, and Windows' system keys), and no child
 * opens a console window (`windowsHide`). `down` stops the supervisor with
 * SIGTERM; on Windows, where a signal is `TerminateProcess` (and would take
 * the host down without its drain), with a request file carrying the lock's
 * random stop nonce, which this process watches for (`STOP_REQUEST_FILE`).
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { basename, dirname, join, posix, win32 } from 'node:path';

import { authoredBaseEnv, bundleLayout, describeSandboxProbe, homeNeedsNarrowing, installKindOf, narrowPrivateDir, nativeConfigDir, probeSandboxHelper, resolveNeuralisHome, runAclCommand, type AclCommandRunner } from '@neuralis/package-system/paths';
import {
  acquireHomeLock,
  EXIT_HOME_LOCKED,
  holderAlive,
  HomeLockBusyError,
  homeLockedMessage,
  homeLockPath,
  judgeHomeLock,
  NonLocalHomeError,
  nonLocalHomeReason,
  PROCESS_LOCK_PROBE,
  readHomeLock,
  releaseHomeLock,
  startLockHeartbeat,
  SUPERVISOR_ENV,
  SUPERVISOR_SHUTDOWN_MESSAGE,
  updateHomeLock,
  type HomeLock,
  type HomeLockState,
  type LockProbe,
} from '../src/server/host/homeLock.ts';
import { CliExit, type CliContext } from './cli/registry.mts';
import { readSessionSecretFile } from '../src/server/config/sessionSecretFile.ts';
import { ensureCompanion, sha256File, stopCompanion, type CompanionKind, type CompanionStart, type CompanionStop } from './host-broker/helper.mts';
import { cloudflaredExecutable, tunnelDir } from './setup/cloudflaredVersion.mts';
import { OLLAMA_EMBEDDING_TAG, OLLAMA_OWN_PORT, ollamaAsset, ollamaBinarySpawn, ollamaExecutableCandidates, ollamaInstallDir, parseOllamaMode, type OllamaMode } from './setup/ollamaVersion.mts';
import { listenProbe, PORT_ROLES, UPGRADE_DOCKER_FIRST, type PortClaim, type PortProbe } from './setup/detect.mts';
import { parseEnvContent, qdrantBinaryPorts, type QdrantPorts } from './setup/envFile.mts';
import { authoredEnv, downloadPinned, ollamaAnswers, pullOllamaModel, qdrantBinarySpawn, type PullProgress } from './setup/services.mts';
import { EXIT_UPGRADE_REQUIRED } from './upgrade.mts';

/** The `neuralis up` exit codes — the contract the desktop app reads. */
export const EXIT = {
  OK: 0,
  GENERAL: 1,
  PORT_TAKEN: 10,
  HOME_LOCKED: EXIT_HOME_LOCKED,
  UPGRADE_REQUIRED: EXIT_UPGRADE_REQUIRED,
  FIRST_RUN_REQUIRED: 13,
  CHILD_FAILED: 14,
  NATIVE_CONFIG_REQUIRED: 15,
} as const;

/** What a native install's `.env` decides, read once per start. */
export type NativeConfig = {
  env: Record<string, string>;
  bindHost: string;
  ports: { app: number; mcp: number; sandbox: number };
  /**
   * `url`: where the host reaches Qdrant (null in memory); `composeDir`: the
   * folder whose vector-store service `up` starts — this home's own compose
   * file in docker mode, the recorded Docker install's in external mode.
   */
  qdrant: { mode: 'binary' | 'docker' | 'external' | 'inmemory'; ports: QdrantPorts; url: string | null; composeDir: string | null };
  /**
   * The local-model companion (`OLLAMA_MODE`): `binary` is supervised here,
   * `docker` started through the companions' compose file beside `.env`; `url`
   * is where THIS install's own Ollama answers (loopback), null otherwise.
   */
  ollama: { mode: OllamaMode; port: number; url: string | null; composeDir: string | null };
  /** `NEURALIS_TUNNEL=cloudflare`: this host runs the tunnel connector, after it is ready. */
  tunnel: boolean;
  /** The origins users reach (`APP_URL`, `MCP_BASE_URL`): the tunnel's or a LAN's, else this run's own. */
  publicApp: string | null;
};

function port(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

/** The native `.env`; null when there is none. */
export function readNativeConfig(configDir: string): NativeConfig | null {
  let text: string;
  try {
    text = readFileSync(join(configDir, '.env'), 'utf-8');
  } catch {
    return null;
  }
  const env = parseEnvContent(text);
  const declared = env.QDRANT_MODE?.trim();
  const mode = declared === 'binary' || declared === 'docker' || declared === 'external' ? declared : 'inmemory';
  const ports = qdrantBinaryPorts(env);
  const url = mode === 'binary' || mode === 'docker' ? `http://127.0.0.1:${ports.http}` : mode === 'external' ? env.QDRANT_URL?.trim() || null : null;
  const composeDir = mode === 'docker' ? configDir : mode === 'external' ? env.NEURALIS_QDRANT_COMPOSE_DIR?.trim() || null : null;
  const ollamaMode = parseOllamaMode(env.OLLAMA_MODE) ?? 'none';
  const ollamaPort = port(env.NEURALIS_OLLAMA_PORT, OLLAMA_OWN_PORT);
  const own = ollamaMode === 'binary' || ollamaMode === 'docker';
  return {
    env,
    bindHost: env.NEURALIS_BIND_HOST?.trim() || '127.0.0.1',
    ports: { app: port(env.NEURALIS_APP_PORT, 3100), mcp: port(env.MCP_HTTP_PORT, 3101), sandbox: port(env.NEURALIS_MCP_SANDBOX_PORT, 3102) },
    qdrant: { mode, ports, url, composeDir },
    ollama: { mode: ollamaMode, port: ollamaPort, url: own ? `http://127.0.0.1:${ollamaPort}` : null, composeDir: ollamaMode === 'docker' ? configDir : null },
    tunnel: env.NEURALIS_TUNNEL?.trim() === 'cloudflare',
    publicApp: env.APP_URL?.trim() || null,
  };
}

/**
 * What this data home lacks before a native start, in the order it is judged:
 * an owner (a fresh home: the first-run setup), the session secret file (a
 * home an older Docker install set up — its secret still sits in that
 * install's `.env`; a native home set up before the move carries it in its own
 * `.env` instead, and `runUp` answers that one 12), this host's own `.env` (a
 * home Docker set up: adopt it).
 * `ready` is the host's own `getSetupState` rule plus the native `.env`.
 */
export function setupState(home: string, config: NativeConfig | null): 'no-owner' | 'no-secret' | 'no-native-config' | 'ready' {
  let owner = false;
  try {
    owner = readdirSync(join(home, 'app', 'users')).some((name) => name.endsWith('.json'));
  } catch {
    // no users folder: a fresh home
  }
  if (!owner) return 'no-owner';
  if (readSessionSecretFile(join(home, 'app')) === null) return 'no-secret';
  return config ? 'ready' : 'no-native-config';
}

/**
 * The origins a run serves on THIS machine, as the `ready` line and `status`
 * name them. A bind on every address (`0.0.0.0` / `::` — the LAN switch) is
 * reached here through loopback.
 */
export function origins(config: NativeConfig): { app: string; mcp: string; sandbox: string } {
  const local = config.bindHost === '0.0.0.0' ? '127.0.0.1' : config.bindHost === '::' ? '::1' : config.bindHost;
  const host = local.includes(':') ? `[${local}]` : local;
  return { app: `http://${host}:${config.ports.app}`, mcp: `http://${host}:${config.ports.mcp}`, sandbox: `http://${host}:${config.ports.sandbox}` };
}

/** Keys a native host never gets, whatever `.env` says: they would make it act as a container. */
const CONTAINER_ONLY_KEYS = ['NEURALIS_DOCKER', 'NEURALIS_HOST_HOME'] as const;

/**
 * The host child's whole environment: the `.env` keys, the three the process
 * locale needs from this one (`HOME`, `TZ`, `LANG`), the platform's authored
 * base (`PATH` led by the bundle's `bin/` and Node; Windows' system keys), the
 * image's own `ENV` lines (`NODE_ENV`, `NEXT_TELEMETRY_DISABLED`,
 * `KEEP_ALIVE_TIMEOUT`) and the run's facts. Nothing else of this process's
 * environment reaches it.
 */
export function hostChildEnv(input: {
  config: NativeConfig; home: string; resources: string; instanceId: string; helper: string | null;
  parent: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  /** The host package's own version — what Admin → Config shows, as an image's build arg does in Docker. */
  version?: string | null;
}): NodeJS.ProcessEnv {
  const platform = input.platform ?? process.platform;
  const layout = bundleLayout(input.resources, platform);
  const env: Record<string, string> = { ...input.config.env };
  for (const key of CONTAINER_ONLY_KEYS) delete env[key];
  for (const key of ['HOME', 'TZ', 'LANG'] as const) {
    const value = input.parent[key];
    if (value) env[key] = value;
  }
  Object.assign(env, {
    ...authoredBaseEnv(platform, input.parent, [layout.binDir, layout.nodeBinDir]),
    NODE_ENV: 'production',
    NEXT_TELEMETRY_DISABLED: '1',
    KEEP_ALIVE_TIMEOUT: '55000',
    NEURALIS_HOME: input.home,
    NEURALIS_BIND_HOST: input.config.bindHost,
    HOSTNAME: input.config.bindHost,
    PORT: String(input.config.ports.app),
    // `${NEURALIS_API}` for skill scripts: the bound address itself, never a `localhost` that may resolve to ::1.
    NEURALIS_INTERNAL_API_BASE: origins(input.config).app,
    NEURALIS_INSTANCE_ID: input.instanceId,
    // The channel the host follows (`followSupervisor`): this process's stop, and its death, SIGKILL included.
    [SUPERVISOR_ENV]: 'ipc',
    // What a confined shell must reach to run the bundled jq, node and `neuralis` (the shim in bin/ runs the CLI
    // package) — the platform's PATH delimiter, which the reader splits on (`;` on Windows, where `:` is in `C:\`).
    NEURALIS_TOOLCHAIN_ROOT: layout.toolchainRoots.join(platform === 'win32' ? win32.delimiter : posix.delimiter),
  });
  if (input.helper) env.NEURALIS_LANDLOCK_SANDBOXER = input.helper;
  if (input.version) env.NEURALIS_VERSION = input.version;
  return authoredEnv(env);
}

/** The version a host package ships (`package.json`), or null — a label only, never fatal. */
export function hostPackageVersion(packageDir: string): string | null {
  try {
    const version = (JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf-8')) as { version?: unknown }).version;
    return typeof version === 'string' && version.trim() ? version.trim() : null;
  } catch {
    return null;
  }
}

// ── The confinement helper ───────────────────────────────────

export type HelperVerdict = { ok: true; path: string } | { ok: false; reason: string };

/**
 * This OS's confinement backend (`bundleLayout().confinement`): a bundled one
 * (Linux `nrs-sandboxer`, Windows x64 `wxc-exec.exe`) is first held to its
 * sha256 in the device client's `native/manifest.json`; macOS's is the OS's
 * own `/usr/bin/sandbox-exec`. Linux: then the kernel's ONE helper probe
 * (`probeSandboxHelper` — the device broker's and the device CLI's too), which
 * reads what `--selftest` PRINTS, never only its exit code. macOS and Windows
 * prove theirs where the argv builder lives: the host's own boot probe
 * (agent-core `landlockProbe`) runs the same kernel probe — four printed rows
 * after an unconfined control — and confined shells stay refused until it does.
 */
export function verifyBundledHelper(resources: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): HelperVerdict {
  const { cliNative: native, confinement } = bundleLayout(resources, platform, arch);
  if (!confinement) return { ok: false, reason: 'no confinement helper exists for this platform' };
  const { path, pin: rel } = confinement;
  if (rel) {
    let expected: unknown;
    try {
      expected = (JSON.parse(readFileSync(join(native, 'manifest.json'), 'utf-8')) as { files?: Record<string, { sha256?: unknown }> }).files?.[rel]?.sha256;
    } catch {
      return { ok: false, reason: 'the device client\'s native manifest is missing or unreadable' };
    }
    if (typeof expected !== 'string') return { ok: false, reason: `the manifest pins no hash for ${rel}` };
    if (!existsSync(path)) return { ok: false, reason: `${rel} is missing from the bundle` };
    if (sha256File(path) !== expected) return { ok: false, reason: `${rel} does not match its pinned sha256` };
  } else if (!existsSync(path)) {
    return { ok: false, reason: `${path} is missing on this machine` };
  }
  if (confinement.backend !== 'landlock') return { ok: true, path };
  const probe = probeSandboxHelper(path);
  return probe.helper ? { ok: true, path } : { ok: false, reason: describeSandboxProbe(probe.reason) };
}

// ── The run ──────────────────────────────────────────────────

export type HealthAnswer = { status: number; instanceId: string | null; state: string | null; code: string | null };

/** Everything a run reads from the world — injectable for tests. */
export interface UpDeps {
  /** The OS this run's paths, environments and stop path are spelled for. */
  platform: NodeJS.Platform;
  probePorts: PortProbe;
  lockProbe: LockProbe;
  /** `<app>/api/health`: its HTTP status, `instanceId` and body `status`/`code`, or null when nothing answers. */
  health(app: string): Promise<HealthAnswer | null>;
  /** Qdrant's `/healthz` answers. */
  qdrantUp(url: string): Promise<boolean>;
  /** One keyed request (`GET /collections`): does Qdrant accept this key? */
  qdrantKey(url: string, apiKey: string | undefined): Promise<'ok' | 'unauthorized' | 'unreachable'>;
  /** Start a companion service of the compose stack in `dir` when it is not running (`ensureCompanion`). */
  companion(dir: string, kind: CompanionKind): Promise<CompanionStart>;
  /** Stop it again — this home's own stack only (`stopCompanion`). */
  companionStop(dir: string, kind: CompanionKind): Promise<CompanionStop>;
  /** Does an Ollama answer at `url`? (one bounded request) */
  ollamaUp(url: string): Promise<boolean>;
  /** This home's Ollama binary — downloaded (pinned, verified) when missing; null where none exists for this OS. */
  ollamaInstall(home: string): Promise<string | null>;
  /** Pull `model` into the Ollama at `url` (its own API), progress per status line. */
  ollamaPull(url: string, model: string, onProgress: (progress: PullProgress) => void): Promise<boolean>;
  /** Is `model` present in the Ollama at `url`? */
  ollamaHas(url: string, model: string): Promise<boolean>;
  verifyHelper(resources: string): HelperVerdict;
  /** Windows: the `whoami` / `icacls` runs that make a home outside the profile private (`narrowPrivateDir`). */
  acl: AclCommandRunner;
  /**
   * `neuralis upgrade --check` for this data home, in a child process: loading
   * every upgrade module costs seconds and ~300 MB, which the resident
   * supervisor must not keep. Its exit code and output.
   */
  upgradeCheck(packageDir: string, home: string): { status: number | null; output: string };
  /** Restart delays per child; a death beyond the list ends the run. */
  backoffMs: readonly number[];
  /** How long the host and Qdrant each get to answer at start (and after a restart). */
  readyTimeoutMs: number;
  /** Graceful stop window per child before SIGKILL. */
  stopTimeoutMs: number;
  pollMs: number;
}

export const PROCESS_UP_DEPS: UpDeps = {
  platform: process.platform,
  probePorts: listenProbe,
  lockProbe: PROCESS_LOCK_PROBE,
  async health(app) {
    try {
      const response = await fetch(new URL('/api/health', app), { signal: AbortSignal.timeout(2_000), redirect: 'error' });
      const body = (await response.json()) as { instanceId?: unknown; status?: unknown; code?: unknown };
      const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
      return { status: response.status, instanceId: text(body.instanceId), state: text(body.status), code: text(body.code) };
    } catch {
      return null;
    }
  },
  async qdrantUp(url) {
    try {
      return (await fetch(new URL('/healthz', url), { signal: AbortSignal.timeout(2_000) })).ok;
    } catch {
      return false;
    }
  },
  async qdrantKey(url, apiKey) {
    try {
      const response = await fetch(new URL('/collections', url), { signal: AbortSignal.timeout(2_000), headers: apiKey ? { 'api-key': apiKey } : {} });
      if (response.status === 401 || response.status === 403) return 'unauthorized';
      return response.ok ? 'ok' : 'unreachable';
    } catch {
      return 'unreachable';
    }
  },
  companion: (dir, kind) => ensureCompanion(dir, kind),
  companionStop: (dir, kind) => stopCompanion(dir, kind),
  ollamaUp: (url) => ollamaAnswers(url),
  async ollamaInstall(home) {
    const dir = ollamaInstallDir(home);
    const found = ollamaExecutableCandidates(dir).find((path) => existsSync(path));
    if (found) return found;
    const asset = ollamaAsset();
    if (!asset) return null;
    await downloadPinned(asset, dir, null);
    return ollamaExecutableCandidates(dir).find((path) => existsSync(path)) ?? null;
  },
  ollamaPull: (url, model, onProgress) => pullOllamaModel(model, url, onProgress),
  async ollamaHas(url, model) {
    try {
      const response = await fetch(new URL('/api/tags', url), { signal: AbortSignal.timeout(2_000), redirect: 'error' });
      const body = (await response.json()) as { models?: Array<{ name?: unknown; model?: unknown }> };
      return (body.models ?? []).some((m) => m.name === model || m.model === model);
    } catch {
      return false;
    }
  },
  verifyHelper: (resources) => verifyBundledHelper(resources),
  acl: runAclCommand,
  upgradeCheck(packageDir, home) {
    const res = spawnSync(process.execPath, [join(packageDir, 'bin', 'neuralis.mjs'), 'upgrade', '--check'], {
      cwd: packageDir, encoding: 'utf-8', timeout: 120_000, windowsHide: true,
      env: authoredEnv({ ...authoredBaseEnv(process.platform, process.env), NEURALIS_HOME: home, ...(process.env.HOME ? { HOME: process.env.HOME } : {}) }),
    });
    return { status: res.error ? null : res.status, output: `${res.stdout ?? ''}${res.stderr ?? ''}` };
  },
  backoffMs: [1_000, 2_000, 4_000, 8_000, 16_000],
  // The host's own bootstrap (every package's init) takes about a minute on a cold start.
  readyTimeoutMs: 180_000,
  // Above the host's own shutdown deadline (32 s), so its drain finishes first.
  stopTimeoutMs: 40_000,
  pollMs: 500,
};

type Io = Pick<CliContext, 'stdout' | 'stderr' | 'env' | 'stdin'>;

/** One JSON state line on stdout — the only thing `up --foreground` writes there. */
function emit(io: Io, line: Record<string, unknown>): void {
  io.stdout(`${JSON.stringify(line)}\n`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll `check` until it answers true, `gone()` turns true, or the deadline passes. */
async function until(check: () => Promise<boolean>, timeoutMs: number, pollMs: number, gone: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!gone() && Date.now() < deadline) {
    if (await check()) return true;
    await sleep(pollMs);
  }
  return false;
}

/**
 * Stop `child`: the `shutdown` message over its `'ipc'` channel when it has one
 * (the host — the same drain as its SIGTERM, on every OS), then the channel
 * closed, which a host still booting (no listener yet) finds closed when it
 * looks and stops on too; else SIGTERM (Qdrant; on Windows that is
 * `TerminateProcess` — its WAL keeps the store consistent); SIGKILL after
 * `timeoutMs`; resolves when it has exited.
 */
function stopChild(child: ChildProcess | null, timeoutMs: number): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    if (child.connected) {
      child.send(SUPERVISOR_SHUTDOWN_MESSAGE, () => { if (child.connected) child.disconnect(); });
    } else {
      child.kill('SIGTERM');
    }
  });
}

/** How long a stop waits for this home's own companion container (`docker compose stop -t 10` plus the CLI's own start-up). */
const VECTORSTORE_STOP_BOUND_MS = 20_000;

/** An optional child (Ollama, the tunnel connector) is retried forever, at most once per this long. */
const OPTIONAL_RETRY_MAX_MS = 30_000;

/** The optional-companion cadence: the restart delays first, then once per `OPTIONAL_RETRY_MAX_MS`. */
const optionalRetryMs = (backoffMs: readonly number[], attempt: number): number => Math.min(backoffMs[attempt] ?? OPTIONAL_RETRY_MAX_MS, OPTIONAL_RETRY_MAX_MS);

/** The request file `neuralis down` writes on Windows: the supervisor's id and the lock's stop nonce. */
export const STOP_REQUEST_FILE = 'host.stop';

const stopRequestPath = (home: string): string => join(dirname(homeLockPath(home)), STOP_REQUEST_FILE);

/** The same bytes compared in constant time (hashed first, so unequal lengths leak nothing either). */
function sameSecret(a: string, b: string): boolean {
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * Ask the supervisor holding `lock` to stop: write the request file (a temp
 * file renamed into place) with its id and stop nonce. The nonce is read from
 * the lock, which only its owner can read; the supervisor ignores — and
 * deletes — a request that carries anything else.
 */
export function askSupervisorToStop(home: string, lock: Pick<HomeLock, 'instanceId' | 'stopNonce'>): void {
  const path = stopRequestPath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ instanceId: lock.instanceId, nonce: lock.stopNonce })}\n`, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * The supervisor's side on Windows: one directory watch on `<home>/app` (no
 * polling) that stops the run on a request carrying this run's id and nonce.
 * Any other request is removed and ignored. Cost: one watch handle;
 * an event is a name compare, and only `host.stop` is read (a few bytes).
 */
export function watchStopRequests(home: string, instanceId: string, nonce: string, onStop: () => void): FSWatcher {
  const path = stopRequestPath(home);
  const check = (): void => {
    let text: string;
    try {
      text = readFileSync(path, 'utf-8');
    } catch {
      return;
    }
    try { unlinkSync(path); } catch { /* removed meanwhile */ }
    try {
      const request = JSON.parse(text) as { instanceId?: unknown; nonce?: unknown };
      if (request.instanceId === instanceId && typeof request.nonce === 'string' && sameSecret(request.nonce, nonce)) onStop();
    } catch {
      // Not a request: removed, ignored.
    }
  };
  check(); // a request left from an earlier run is cleared, never honoured
  const watcher = watch(dirname(path), (_event, name) => { if (name === null || basename(String(name)) === STOP_REQUEST_FILE) check(); });
  watcher.unref();
  return watcher;
}

/** The `:3102` origin: a byte pipe onto the app port (the `Host` header keeps the sandbox port). */
function startSandboxPipe(bindHost: string, from: number, to: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      const upstream = createConnection({ host: bindHost, port: to });
      socket.pipe(upstream).pipe(socket);
      const close = (): void => { socket.destroy(); upstream.destroy(); };
      socket.once('error', close);
      upstream.once('error', close);
    });
    server.once('error', reject);
    server.listen({ host: bindHost, port: from, exclusive: true }, () => resolve(server));
  });
}

/**
 * `up --foreground`. Returns the exit code; never calls `process.exit`. `stopOn`
 * wires the stop signals (stdin EOF + SIGTERM/SIGINT in production).
 */
export async function runUp(input: {
  packageDir: string;
  io: Io;
  deps?: UpDeps;
  /** The detached form has no stdin to watch: it stops on a signal only. */
  watchStdin: boolean;
}): Promise<number> {
  const deps = input.deps ?? PROCESS_UP_DEPS;
  const { io } = input;
  const say = (line: string): void => io.stderr(`  ${line}\n`);
  if (installKindOf(input.packageDir) !== 'native') {
    throw new CliExit(EXIT.GENERAL, '`neuralis up` runs the desktop app\'s own host bundle, and this is not one', [
      'A Docker install starts with `docker compose up -d` in its install folder; a clone with `neuralis start`.',
    ]);
  }
  const resources = dirname(input.packageDir);
  const layout = bundleLayout(resources, deps.platform);
  const { home } = resolveNeuralisHome(io.env as NodeJS.ProcessEnv);
  const nonLocal = nonLocalHomeReason(home, deps.platform);
  if (nonLocal) throw new CliExit(EXIT.GENERAL, nonLocal);
  const configDir = nativeConfigDir(home);
  const config = readNativeConfig(configDir);
  const instanceId = randomUUID();
  const appOrigin = config ? origins(config).app : 'http://127.0.0.1:3100';

  // 1. The data-home lock — before anything reads the tree for real. A stale lock
  //    of this kind is taken over only once what its dead supervisor left running
  //    is stopped (by the pids it records, proven to run the bundle's executable);
  //    anything unexplained keeps that lock, so `down` still sees it.
  //    On Windows a home outside the account's profile is first made private to
  //    this account — before the lock and its stop nonce are written into it.
  if (!existsSync(join(home, 'app', 'users')) && homeNeedsNarrowing(home, io.env, deps.platform)) {
    mkdirSync(home, { recursive: true });
    await narrowPrivateDir(home, deps.acl).catch((err: unknown) => { throw new CliExit(EXIT.GENERAL, err instanceof Error ? err.message : String(err)); });
  }
  mkdirSync(join(home, 'app'), { recursive: true });
  // Windows has no signal `down` could send: it asks with this nonce instead (`watchStopRequests`).
  const stopNonce = deps.platform === 'win32' ? randomBytes(32).toString('hex') : undefined;
  const lock: HomeLock = { kind: 'native', pid: process.pid, app: appOrigin, instanceId, state: 'starting', bundle: resources, heartbeatAt: Date.now(), ...(stopNonce ? { stopNonce } : {}) };
  const prior = await judgeHomeLock(home, lock, deps.lockProbe);
  if (prior.kind === 'stale' && prior.lock !== 'corrupt') {
    const refusal = await stopOrphans(home, prior.lock, say, { ...deps, waitMs: deps.stopTimeoutMs });
    if (refusal) {
      say(`The lock at ${homeLockPath(home)} is stale (its supervisor, process ${prior.lock.pid}, is gone), but ${refusal.message}.`);
      for (const line of refusal.detail) say(line);
      return EXIT.HOME_LOCKED;
    }
  }
  const acquired = await acquireHomeLock(home, lock, deps.lockProbe).catch((err: unknown) => {
    if (err instanceof HomeLockBusyError) throw new CliExit(EXIT.HOME_LOCKED, err.message);
    throw err instanceof NonLocalHomeError ? new CliExit(EXIT.GENERAL, err.message) : err;
  });
  if (!acquired.ok) {
    // The holder as a state line too: the desktop app offers to stop a Docker holder (it never takes the lock).
    emit(io, { state: 'locked', holder: acquired.verdict.lock.kind, app: acquired.verdict.lock.app, answered: acquired.verdict.kind === 'live', lock: homeLockPath(home) });
    for (const line of homeLockedMessage(home, acquired.verdict.lock, acquired.verdict.kind === 'live')) say(line);
    return EXIT.HOME_LOCKED;
  }
  if (acquired.tookOver) say(`Took over a stale lock at ${homeLockPath(home)} (its holder no longer answers).`);
  const stopBeat = startLockHeartbeat(home, instanceId);
  const release = (): void => { stopBeat(); releaseHomeLock(home, instanceId); };
  // A refused write keeps this holder's lock in place and its patch rides the next heartbeat
  // (`updateHomeLock`), so it is said, never fatal: the host it reports keeps running.
  const recordLock = (patch: Parameters<typeof updateHomeLock>[2], what: string): void => {
    try {
      updateHomeLock(home, instanceId, patch);
    } catch (err) {
      say(`Could not record ${what} in ${homeLockPath(home)} yet (${(err as NodeJS.ErrnoException).code ?? 'write failed'}); the next heartbeat writes it.`);
    }
  };
  const setState = (state: HomeLockState, failed?: HomeLock['failed']): void => {
    recordLock({ state, ...(failed ? { failed } : {}) }, `"${state}"`);
  };

  // 1b. An owner, the session secret, this host's own config.
  const setup = setupState(home, config);
  if (setup === 'no-owner') {
    release();
    say(`This data home (${home}) is not set up yet: no owner account.`);
    say('The desktop app sets it up on first start (`neuralis setup --native --yes --owner-email …`).');
    return EXIT.FIRST_RUN_REQUIRED;
  }
  if (setup === 'no-secret' && config?.env.NEXTAUTH_SECRET?.trim()) {
    // A native home set up before the secret moved: the line is in THIS host's `.env`, which
    // this host's own `upgrade --apply` reads — the desktop app runs it on 12.
    release();
    say(`This data home (${home}) keeps its session secret in ${join(configDir, '.env')}, not yet in its own file.`);
    say('Run `neuralis upgrade --apply` (the app stays stopped meanwhile), then start again.');
    return EXIT.UPGRADE_REQUIRED;
  }
  if (setup === 'no-secret') {
    release();
    throw new CliExit(EXIT.GENERAL, `This data home (${home}) was set up by an earlier Docker install and has no session secret file yet: ${UPGRADE_DOCKER_FIRST}`, [
      'With that stack stopped, `neuralis upgrade --apply` in its install folder moves the secret into the data home; then start again here.',
    ]);
  }
  if (setup === 'no-native-config' || !config) {
    release();
    say(`This data home (${home}) is set up, but not for this app: no .env in ${configDir}.`);
    say('The desktop app adopts it on start (`neuralis setup --native --yes`, no owner flags): users, projects and settings stay as they are.');
    return EXIT.NATIVE_CONFIG_REQUIRED;
  }

  // 2. Offline upgrades the stored data needs before this build boots (the verb itself, in a child).
  const check = deps.upgradeCheck(input.packageDir, home);
  if (check.status !== EXIT.OK) {
    release();
    io.stderr(check.output);
    if (check.status === EXIT.UPGRADE_REQUIRED) {
      say('Run `neuralis upgrade --apply` (the app stays stopped meanwhile), then start again.');
      return EXIT.UPGRADE_REQUIRED;
    }
    say(`\`neuralis upgrade --check\` failed (exit ${check.status ?? 'none'}); nothing was started.`);
    return EXIT.GENERAL;
  }

  // 3. Every listener's port, on the one bind address.
  const claims: PortClaim[] = [
    { key: 'app', port: config.ports.app, address: config.bindHost as PortClaim['address'] },
    { key: 'mcp', port: config.ports.mcp, address: config.bindHost as PortClaim['address'] },
    { key: 'sandbox', port: config.ports.sandbox, address: config.bindHost as PortClaim['address'] },
    ...(config.qdrant.mode === 'binary'
      ? [{ key: 'qdrant', port: config.qdrant.ports.http, address: '127.0.0.1' as const }, { key: 'qdrantGrpc', port: config.qdrant.ports.grpc, address: '127.0.0.1' as const }]
      : []),
  ];
  const busy = await deps.probePorts(claims);
  if (busy.length > 0) {
    release();
    for (const claim of busy) say(`Port ${claim.port} (${PORT_ROLES[claim.key]?.label ?? claim.key}) is in use by another program: free it, or set ${PORT_ROLES[claim.key]?.envKey ?? claim.key} in ${join(configDir, '.env')}.`);
    return EXIT.PORT_TAKEN;
  }

  // 4. The confinement helper: exported only when proven.
  const helper = deps.verifyHelper(resources);
  if (!helper.ok) say(`Confined local shells are unavailable on this machine: ${helper.reason}.`);

  const run = { stopped: false };
  let stopResolve: () => void = () => {};
  const stopRequested = new Promise<void>((resolve) => { stopResolve = resolve; });
  const requestStop = (): void => { if (!run.stopped) { run.stopped = true; stopResolve(); } };
  const onSignal = (): void => requestStop();
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  const onStdinEnd = (): void => requestStop();
  if (input.watchStdin) {
    io.stdin.once('end', onStdinEnd);
    io.stdin.once('close', onStdinEnd);
    io.stdin.resume();
  }
  const stopWatch = stopNonce ? watchStopRequests(home, instanceId, stopNonce, requestStop) : null;

  let qdrant: ChildProcess | null = null;
  let host: ChildProcess | null = null;
  let ollama: ChildProcess | null = null;
  let tunnel: ChildProcess | null = null;
  let pipe: Server | null = null;
  let failure: { child: 'host' | 'qdrant'; code: number } | null = null;
  const qdrantUrl = `http://127.0.0.1:${config.qdrant.ports.http}`;
  const spec = config.qdrant.mode === 'binary'
    ? qdrantBinarySpawn(join(home, 'qdrant-storage'), config.env.QDRANT_API_KEY?.trim() || undefined, config.qdrant.ports, { ...authoredBaseEnv(deps.platform, io.env), HOME: io.env.HOME })
    : null;
  const hostEnv = hostChildEnv({ config, home, resources, instanceId, helper: helper.ok ? helper.path : null, parent: io.env, platform: deps.platform, version: hostPackageVersion(input.packageDir) });
  const forward = (child: ChildProcess): void => {
    child.stdout?.on('data', (chunk: Buffer) => io.stderr(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => io.stderr(chunk.toString()));
  };

  /**
   * Supervise one child: start it, await readiness, restart on an unexpected
   * exit. The host and Qdrant end the run after the last backoff; an OPTIONAL
   * child (Ollama, the tunnel connector) never does — the host runs without
   * it, and it is retried at most once per `OPTIONAL_RETRY_MAX_MS`.
   */
  type ChildName = 'host' | 'qdrant' | 'ollama' | 'tunnel';
  const supervise = (name: ChildName, start: () => ChildProcess, ready: () => Promise<boolean>, onReady: () => void): Promise<void> => new Promise((settle) => {
    let deaths = 0;
    const optional = name === 'ollama' || name === 'tunnel';
    const launch = (): void => {
      if (run.stopped) { settle(); return; }
      const child = start();
      if (name === 'host') host = child; else if (name === 'qdrant') qdrant = child; else if (name === 'ollama') ollama = child; else tunnel = child;
      recordLock(name === 'host' ? { hostPid: child.pid } : name === 'qdrant' ? { qdrantPid: child.pid } : name === 'ollama' ? { ollamaPid: child.pid } : { tunnelPid: child.pid }, `the ${name} pid`);
      forward(child);
      let exited = false;
      child.once('exit', (code, signal) => {
        exited = true;
        if (run.stopped) { settle(); return; }
        const exitCode = code ?? (signal ? 128 : 1);
        const delay = optional ? optionalRetryMs(deps.backoffMs, deaths) : deps.backoffMs[deaths];
        deaths += 1;
        if (optional) {
          // Never a host state: the host keeps serving while its companion comes back.
          say(`${name === 'ollama' ? 'Ollama' : 'The tunnel connector'} exited (${exitCode}); again in ${Math.round(delay! / 1000)} s.`);
          setTimeout(launch, delay);
          return;
        }
        if (delay === undefined) {
          failure = { child: name === 'host' ? 'host' : 'qdrant', code: exitCode };
          requestStop();
          settle();
          return;
        }
        setState('restarting');
        emit(io, { state: 'restarting', child: name, code: exitCode, attempt: deaths, inMs: delay });
        setTimeout(launch, delay);
      });
      void until(ready, deps.readyTimeoutMs, deps.pollMs, () => run.stopped || exited).then((ok) => {
        if (ok && !run.stopped && !exited) {
          deaths = 0;
          onReady();
        }
      });
    };
    launch();
  });

  /** Stop one companion container of this home's own compose file, bounded (`compose stop -t 10` plus the CLI's start-up). */
  const boundedStop = async (dir: string, kind: CompanionKind): Promise<void> => {
    const what = kind === 'vectorstore' ? 'The vector store' : 'Ollama';
    let bound: NodeJS.Timeout | undefined;
    const stopped = await Promise.race([deps.companionStop(dir, kind), new Promise<null>((resolve) => { bound = setTimeout(() => resolve(null), VECTORSTORE_STOP_BOUND_MS); })]);
    clearTimeout(bound);
    if (stopped === null) say(`${what} in ${dir} did not stop within ${VECTORSTORE_STOP_BOUND_MS / 1000} s; it keeps running until Docker stops it.`);
    else if (!stopped.ok) say(`${what} in ${dir} was not stopped: ${stopped.reason}.`);
    else if (stopped.stopped) say(`Stopped ${stopped.service} in ${dir}.`);
  };

  /**
   * After the FIRST ready: the optional companions, none of which the host
   * waits for or fails on — this install's Ollama (its binary fetched when
   * missing, or its container started), the embedding model pulled when it is
   * not there (indexing waits for it meanwhile), and the tunnel connector, so
   * nothing reaches the host from outside before it answers here.
   */
  const companionsDone: Promise<void>[] = [];
  let companionsStarted = false;
  const startCompanions = (): void => {
    if (companionsStarted || run.stopped) return;
    companionsStarted = true;
    const ollamaUrl = config.ollama.url;
    if (config.ollama.mode === 'binary' && ollamaUrl) {
      companionsDone.push((async () => {
        let executable: string | null;
        try {
          executable = await deps.ollamaInstall(home);
        } catch (err) {
          say(`Ollama could not be fetched: ${err instanceof Error ? err.message : String(err)}; the host runs without it.`);
          return;
        }
        if (!executable) { say('Ollama publishes no build for this computer; the host runs without it.'); return; }
        if (run.stopped) return;
        const spec = ollamaBinarySpawn(home, config.ollama.port, { ...authoredBaseEnv(deps.platform, io.env), HOME: io.env.HOME });
        mkdirSync(spec.env.OLLAMA_MODELS!, { recursive: true });
        await supervise('ollama', () => spawn(executable!, spec.args, { cwd: dirname(executable!), env: authoredEnv(spec.env), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }), () => deps.ollamaUp(ollamaUrl), () => { void pullEmbeddingModel(ollamaUrl); });
      })());
    } else if (config.ollama.mode === 'docker' && ollamaUrl && config.ollama.composeDir) {
      const dir = config.ollama.composeDir;
      companionsDone.push((async () => {
        const started = await deps.companion(dir, 'embeddings');
        if (!started.ok) { say(`Ollama in ${dir} did not start: ${started.reason}; the host runs without it.`); return; }
        if (await until(() => deps.ollamaUp(ollamaUrl), deps.readyTimeoutMs, deps.pollMs, () => run.stopped)) await pullEmbeddingModel(ollamaUrl);
      })());
    }
    if (config.tunnel) {
      const executable = cloudflaredExecutable(home, deps.platform);
      if (!existsSync(executable)) {
        say(`The tunnel is on, but ${executable} is missing: run \`neuralis tunnel on\` again; the host runs on this machine only meanwhile.`);
      } else {
        const configFile = join(tunnelDir(home), 'config.yml');
        companionsDone.push(supervise('tunnel', () => spawn(executable, ['tunnel', '--no-autoupdate', '--config', configFile, 'run'], {
          cwd: tunnelDir(home), env: authoredEnv({ ...authoredBaseEnv(deps.platform, io.env), ...(io.env.HOME ? { HOME: io.env.HOME } : {}) }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        }), async () => true, () => {}));
      }
    }
  };

  /** Pull the embedding model when this install's Ollama lacks it — one progress line per status change. */
  const pullEmbeddingModel = async (url: string): Promise<void> => {
    if (run.stopped || await deps.ollamaHas(url, OLLAMA_EMBEDDING_TAG)) return;
    say(`Fetching the embedding model ${OLLAMA_EMBEDDING_TAG} into Ollama; indexing waits for it.`);
    let last = '';
    const ok = await deps.ollamaPull(url, OLLAMA_EMBEDDING_TAG, (progress) => {
      if (progress.status === last) return;
      last = progress.status;
      say(`Ollama: ${progress.status}`);
    });
    say(ok ? `The embedding model ${OLLAMA_EMBEDDING_TAG} is ready.` : `The embedding model ${OLLAMA_EMBEDDING_TAG} could not be fetched; \`ollama pull ${OLLAMA_EMBEDDING_TAG}\` fetches it by hand.`);
  };

  // 5. Qdrant first, so the host finds its vector store at boot. A configured store that does not
  // answer is still the host's store: the host serves without it and joins it when it answers;
  // in-memory vectors exist only where no Qdrant is configured.
  let qdrantDone: Promise<void> = Promise.resolve();
  let vectors: { store: 'qdrant' | 'memory'; reason?: 'configured' | 'unreachable' | 'unauthorized' } = config.qdrant.url ? { store: 'qdrant' } : { store: 'memory', reason: 'configured' };
  const vectorsUnreachable = (url: string, waited: boolean): void => {
    vectors = { store: 'qdrant', reason: 'unreachable' };
    say(`Qdrant did not answer on ${url}${waited ? ` within ${Math.round(deps.readyTimeoutMs / 1000)} s` : ''}; the host starts, and search and indexing continue by themselves when the vector store answers.`);
  };
  const keyRefused = (url: string): void => {
    vectors = { store: 'qdrant', reason: 'unauthorized' };
    say(`Qdrant on ${url} refuses this app's key (QDRANT_API_KEY in ${join(configDir, '.env')}); the host starts, and search and indexing stay unavailable until the key matches. \`neuralis setup --native --yes --refresh-qdrant\` reads the Docker install's key again; the next start uses it.`);
  };
  /**
   * A vector store this run could not bring up at start: one `/healthz` probe and,
   * while it does not answer, one start of its service per step on the
   * optional-companion cadence, until it answers, refuses the key or the run stops.
   * The stop wakes the pending step, and the stop path joins this before it stops the store.
   */
  let vectorRetryDone: Promise<void> = Promise.resolve();
  let wakeVectorRetry: () => void = () => {};
  const retryVectorStore = async (url: string, dir: string, startFailure: string): Promise<void> => {
    say(`Neuralis keeps starting the vector store in ${dir} until it answers.`);
    let lastFailure = startFailure;
    for (let attempt = 0; !run.stopped; attempt += 1) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, optionalRetryMs(deps.backoffMs, attempt));
        wakeVectorRetry = () => { clearTimeout(timer); resolve(); };
      });
      if (run.stopped) return;
      if (await deps.qdrantUp(url)) {
        if ((await deps.qdrantKey(url, config.env.QDRANT_API_KEY?.trim() || undefined)) === 'unauthorized') keyRefused(url);
        else {
          vectors = { store: 'qdrant' };
          say(`Qdrant answers on ${url} now; the host's search and indexing continue by themselves.`);
        }
        return;
      }
      if (run.stopped) return;
      const start = await deps.companion(dir, 'vectorstore');
      if (start.ok && start.started) say(`Started ${start.service} in ${dir}.`);
      else if (!start.ok && start.reason !== lastFailure) say(`The vector store in ${dir} did not start: ${start.reason}.`);
      lastFailure = start.ok ? '' : start.reason;
    }
  };
  if (spec) {
    mkdirSync(spec.cwd, { recursive: true });
    let firstReady: () => void = () => {};
    const qdrantFirstReady = new Promise<void>((resolve) => { firstReady = resolve; });
    qdrantDone = supervise('qdrant', () => spawn(layout.qdrant, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }), () => deps.qdrantUp(qdrantUrl), () => firstReady());
    const answered = await Promise.race([qdrantFirstReady.then(() => true), stopRequested.then(() => true), sleep(deps.readyTimeoutMs).then(() => false)]);
    if (!answered) vectorsUnreachable(qdrantUrl, true);
  } else if (config.qdrant.url && !run.stopped) {
    // A Qdrant in Docker (this home's own, or the Docker install's): its vector-store service only.
    const url = config.qdrant.url;
    const dir = config.qdrant.composeDir;
    const start = dir ? await deps.companion(dir, 'vectorstore') : null;
    if (start && !start.ok) say(`The vector store in ${dir} did not start: ${start.reason}.`);
    else if (start?.started) say(`Started ${start.service} in ${dir}.`);
    // Waited for only when its service runs (or was just started); a failed start or no folder: one probe.
    const waits = start?.ok === true;
    const answered = waits ? await until(() => deps.qdrantUp(url), deps.readyTimeoutMs, deps.pollMs, () => run.stopped) : await deps.qdrantUp(url);
    if (!answered && !run.stopped) {
      vectorsUnreachable(url, waits);
      if (dir) vectorRetryDone = retryVectorStore(url, dir, start && !start.ok ? start.reason : '');
    } else if (answered && (await deps.qdrantKey(url, config.env.QDRANT_API_KEY?.trim() || undefined)) === 'unauthorized') {
      keyRefused(url);
    }
  }

  // 6–8. The host, the sandbox origin, then the one ready line per readiness.
  let hostDone: Promise<void> = Promise.resolve();
  if (!run.stopped) {
    hostDone = supervise('host', () => spawn(process.execPath, [layout.server], { cwd: layout.runtime, env: hostEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true }), async () => {
      const answer = await deps.health(origins(config).app);
      if (answer?.instanceId !== instanceId) return false;
      // A refused bootstrap (a data format, a failed package boot) does not heal by waiting or restarting.
      if (answer.state === 'error') {
        say(`The host refused to boot: ${answer.code ?? 'bootstrap_failed'} — its log above says why.`);
        failure = { child: 'host', code: EXIT.GENERAL };
        requestStop();
        return false;
      }
      return answer.status === 200;
    }, () => {
      setState('ready');
      emit(io, {
        state: 'ready', ...origins(config), instanceId, vectors: vectors.store, ...(vectors.reason ? { vectorsReason: vectors.reason } : {}),
        // Where users reach it when that is not this machine's loopback (a tunnel, the LAN switch): the window follows it.
        ...(config.publicApp && config.publicApp !== origins(config).app ? { publicApp: config.publicApp } : {}),
        ollama: config.ollama.mode,
        tunnel: config.tunnel,
      });
      startCompanions();
    });
    try {
      pipe = await startSandboxPipe(config.bindHost, config.ports.sandbox, config.ports.app);
    } catch (err) {
      say(`The MCP-Apps sandbox origin could not listen on ${config.ports.sandbox}: ${err instanceof Error ? err.message : String(err)}`);
      failure = { child: 'host', code: EXIT.PORT_TAKEN };
      requestStop();
    }
  }

  await stopRequested;
  wakeVectorRetry();
  // Stop: the tunnel first (no new remote requests), the host (its own shutdown drains in-flight turns), Ollama, Qdrant, then the pipe.
  await stopChild(tunnel, deps.stopTimeoutMs);
  await stopChild(host, deps.stopTimeoutMs);
  await stopChild(ollama, deps.stopTimeoutMs);
  await stopChild(qdrant, deps.stopTimeoutMs);
  if (config.ollama.mode === 'docker' && config.ollama.composeDir) await boundedStop(config.ollama.composeDir, 'embeddings');
  // This home's own Qdrant in Docker stops with it — never the Docker install's (external mode), never `down`;
  // after a start still in flight from the retry, so nothing starts it again behind the stop.
  await vectorRetryDone;
  if (config.qdrant.mode === 'docker' && config.qdrant.composeDir) await boundedStop(config.qdrant.composeDir, 'vectorstore');
  await Promise.all([hostDone, qdrantDone, ...companionsDone]);
  await new Promise<void>((resolve) => (pipe ? pipe.close(() => resolve()) : resolve()));
  stopWatch?.close();
  process.off('SIGTERM', onSignal);
  process.off('SIGINT', onSignal);
  io.stdin.off('end', onStdinEnd);
  io.stdin.off('close', onStdinEnd);
  if (input.watchStdin) io.stdin.pause();
  if (failure) {
    const failed: { child: 'host' | 'qdrant'; code: number } = failure;
    // The lock stays, marked failed, so `status` can say why; its pid is gone, so the next start takes it.
    stopBeat();
    setState('failed', failed);
    emit(io, { state: 'failed', child: failed.child, code: failed.code });
    return EXIT.CHILD_FAILED;
  }
  release();
  return EXIT.OK;
}

// ── down / status ────────────────────────────────────────────

export type StatusReport = {
  state: 'stopped' | 'starting' | 'ready' | 'restarting' | 'failed';
  pid: number | null;
  instanceId: string | null;
  app: string | null;
  mcp: string | null;
  sandbox: string | null;
  qdrant: { mode: NativeConfig['qdrant']['mode']; state: 'running' | 'stopped' | 'failed' };
  home: string;
  lock: { kind: 'native' | 'docker'; app: string } | null;
};

/** What runs on this data home, from its lock, one health request and (every mode with a Qdrant) one Qdrant request. */
export async function readStatus(env: Readonly<Record<string, string | undefined>>, deps: Pick<UpDeps, 'health' | 'qdrantUp' | 'lockProbe'> = PROCESS_UP_DEPS): Promise<StatusReport> {
  const { home } = resolveNeuralisHome(env as NodeJS.ProcessEnv);
  const config = readNativeConfig(nativeConfigDir(home));
  const mode = config?.qdrant.mode ?? 'inmemory';
  const lock = readHomeLock(home);
  const held = lock !== null && lock !== 'corrupt' ? lock : null;
  const answer = held ? await deps.health(held.app) : null;
  const live = held !== null && answer?.instanceId === held.instanceId;
  const pidAlive = held !== null && held.kind === 'native' && holderAlive(held, deps.lockProbe);
  let state: StatusReport['state'] = 'stopped';
  if (held && live && answer?.status === 200) state = 'ready';
  else if (held && (live || pidAlive)) state = held.state === 'restarting' ? 'restarting' : 'starting';
  else if (held?.state === 'failed') state = 'failed';
  const running = held !== null && (live || pidAlive);
  const qdrantUrl = config?.qdrant.url ?? null;
  const qdrantState: StatusReport['qdrant']['state'] = qdrantUrl === null
    ? 'stopped'
    : mode === 'binary' && held?.state === 'failed' && held.failed?.child === 'qdrant'
      ? 'failed'
      : (await deps.qdrantUp(qdrantUrl)) ? 'running' : 'stopped';
  const served = running && held?.kind === 'native' && config ? origins(config) : null;
  return {
    state,
    pid: running ? held!.pid : null,
    instanceId: running ? held!.instanceId : null,
    app: running ? (served?.app ?? held!.app) : null,
    mcp: served?.mcp ?? null,
    sandbox: served?.sandbox ?? null,
    qdrant: { mode, state: qdrantState },
    home,
    lock: held ? { kind: held.kind, app: held.app } : null,
  };
}

/** Why a dead supervisor's lock must stay: what still runs or answers, and what clears it. */
type OrphanRefusal = { message: string; detail: string[] };

/**
 * A supervisor that died without stopping its children (SIGKILL) leaves them
 * on this home. Before its lock is cleared (`down`) or taken over (the next
 * `up`), each child it records is stopped — SIGTERM, then a bounded wait until
 * the pid no longer runs it — but only once that pid runs the bundle's own
 * executable (a reused pid is never signalled). Then nothing may still answer
 * for it — the host on the lock's own instance id, Qdrant on the configured
 * port: one that no recorded process of the bundle explains, or a child still
 * running at the deadline, is a refusal and the lock (with its pids) stays.
 */
async function stopOrphans(home: string, lock: HomeLock, say: (line: string) => void, deps: Pick<UpDeps, 'health' | 'qdrantUp' | 'lockProbe' | 'pollMs'> & { waitMs: number }): Promise<OrphanRefusal | null> {
  const config = readNativeConfig(nativeConfigDir(home));
  const exe = lock.bundle ? bundleLayout(lock.bundle) : null;
  const qdrantUrl = config?.qdrant.mode === 'binary' ? `http://127.0.0.1:${config.qdrant.ports.http}` : null;
  const orphans = [
    { name: 'host', pid: lock.hostPid, exe: exe?.server, where: lock.app, answers: async () => (await deps.health(lock.app))?.instanceId === lock.instanceId },
    { name: 'Qdrant', pid: lock.qdrantPid, exe: exe?.qdrant, where: qdrantUrl ?? 'its port', answers: async () => (qdrantUrl ? deps.qdrantUp(qdrantUrl) : false) },
    // The optional companions run executables of the DATA HOME (fetched there), stopped by their recorded pid alone.
    { name: 'Ollama', pid: lock.ollamaPid, exe: ollamaExecutableCandidates(ollamaInstallDir(home)).find((path) => existsSync(path)), where: 'its port', answers: async () => false },
    { name: 'tunnel connector', pid: lock.tunnelPid, exe: cloudflaredExecutable(home), where: 'Cloudflare', answers: async () => false },
  ];
  for (const orphan of orphans) {
    const { pid, exe: executable } = orphan;
    if (pid !== undefined && executable && deps.lockProbe.runs(pid, executable)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Gone in between: the wait below decides.
      }
      if (!(await until(async () => !deps.lockProbe.runs(pid, executable), deps.waitMs, deps.pollMs, () => false))) {
        return {
          message: `the ${orphan.name} its supervisor left running (process ${pid}) still runs ${Math.round(deps.waitMs / 1000)} s after SIGTERM`,
          detail: ['It may still be draining a turn; run `neuralis down` again, or stop it yourself. The lock stays until then.'],
        };
      }
      say(`Stopped the ${orphan.name} its supervisor left running (process ${pid}).`);
    }
    if (await orphan.answers()) {
      return {
        message: `a ${orphan.name} still answers on ${orphan.where}, and no process the lock records runs this bundle's ${orphan.name}`,
        detail: [`Its supervisor (process ${lock.pid}) is gone. Stop what serves ${orphan.where} yourself, then run \`neuralis down\`. The lock stays until then.`],
      };
    }
  }
  return null;
}

/**
 * `down`: SIGTERM the lock's own process and wait for it — on Windows the stop
 * request instead, and the wait ends when the supervisor released its lock or
 * its process is gone (no per-poll process query); a dead supervisor's
 * children are stopped, then its lock removed.
 */
export async function runDown(env: Readonly<Record<string, string | undefined>>, say: (line: string) => void, deps: Pick<UpDeps, 'health' | 'qdrantUp' | 'lockProbe' | 'pollMs' | 'platform'> & { waitMs: number } = { ...PROCESS_UP_DEPS, waitMs: 30_000 }): Promise<number> {
  const { home } = resolveNeuralisHome(env as NodeJS.ProcessEnv);
  const lock = readHomeLock(home);
  if (lock === null) {
    say('Nothing runs on this data home.');
    return EXIT.OK;
  }
  if (lock === 'corrupt') {
    throw new CliExit(EXIT.GENERAL, `${homeLockPath(home)} is not a lock this command can read`, ['If no Neuralis host runs on this data home, delete the file, then start again.']);
  }
  if (lock.kind === 'docker') {
    throw new CliExit(EXIT.GENERAL, 'a Docker host holds this data home — this command does not stop a container', homeLockedMessage(home, lock, (await deps.health(lock.app))?.instanceId === lock.instanceId));
  }
  if (!holderAlive(lock, deps.lockProbe)) {
    const refusal = await stopOrphans(home, lock, say, deps);
    if (refusal) throw new CliExit(EXIT.GENERAL, refusal.message, refusal.detail);
    if (!releaseHomeLock(home, lock.instanceId)) {
      const now = readHomeLock(home);
      if (now !== null && now !== 'corrupt' && now.instanceId === lock.instanceId) {
        throw new CliExit(EXIT.GENERAL, `${homeLockPath(home)} could not be removed: another program still has the lock file open`, [
          `Its supervisor, process ${lock.pid}, is gone. Close the program that has the file open (a file viewer, a backup or a virus scan), then run \`neuralis down\` again.`,
        ]);
      }
      say('The lock changed meanwhile: run `neuralis status` to see who holds this data home now.');
      return EXIT.OK;
    }
    say(`Removed the lock (its supervisor, process ${lock.pid}, is gone).`);
    return EXIT.OK;
  }
  // A signal needs proof the pid is the holder: the bundle's own supervisor, or a
  // self-claimed host (no bundle) that answers with the lock's id right now.
  if (!lock.bundle && (await deps.health(lock.app))?.instanceId !== lock.instanceId) {
    throw new CliExit(EXIT.GENERAL, `process ${lock.pid} looks like a Neuralis process but does not answer as this lock's host on ${lock.app}`, [
      'Nothing was signalled. If it is the host that holds this data home, stop it where it runs (Ctrl-C in its terminal); if not, delete the lock.',
    ]);
  }
  const windows = deps.platform === 'win32';
  if (windows) {
    // A kill here is TerminateProcess: the supervisor and, through its job object, the host would die undrained.
    if (!lock.bundle || !lock.stopNonce) {
      throw new CliExit(EXIT.GENERAL, `the host on ${lock.app} (process ${lock.pid}) takes no stop request`, [
        'Nothing was signalled — on Windows a signal ends a process without its drain. Stop it where it runs (close its window, or Ctrl-C in its terminal).',
      ]);
    }
    askSupervisorToStop(home, lock);
  } else {
    process.kill(lock.pid, 'SIGTERM');
  }
  const stopped = windows
    ? (): boolean => {
      const now = readHomeLock(home);
      return now === null || now === 'corrupt' || now.instanceId !== lock.instanceId || !pidExists(lock.pid);
    }
    : (): boolean => !holderAlive(lock, deps.lockProbe);
  const deadline = Date.now() + deps.waitMs;
  while (Date.now() < deadline) {
    if (stopped()) {
      say('Stopped.');
      return EXIT.OK;
    }
    await sleep(deps.pollMs);
  }
  throw new CliExit(EXIT.GENERAL, `process ${lock.pid} is still running ${Math.round(deps.waitMs / 1000)} s after ${windows ? 'the stop request' : 'SIGTERM'}`, ['It may still be draining a turn; run `neuralis status` again, or stop it yourself.']);
}

/** The process exists (a permission error means it does — someone else's). */
function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * `up` without `--foreground`: the same run, detached, its output appended to
 * `<home>/app/logs/host.log`; this process returns once the host is ready (or
 * the child ended).
 */
async function startDetached(ctx: CliContext): Promise<number> {
  const { home } = resolveNeuralisHome(ctx.env as NodeJS.ProcessEnv);
  const logs = join(home, 'app', 'logs');
  mkdirSync(logs, { recursive: true });
  const logPath = join(logs, 'host.log');
  const fd = openSync(logPath, 'a', 0o600);
  const child = spawn(process.execPath, [join(ctx.packageDir, 'bin', 'neuralis.mjs'), 'up', '--foreground', '--no-stdin'], {
    detached: true, stdio: ['ignore', fd, fd], env: ctx.env as NodeJS.ProcessEnv, windowsHide: true,
  });
  closeSync(fd);
  const { code, lines } = await awaitDetachedReady(home, child, logPath);
  for (const line of lines) ctx.stderr(`  ${line}\n`);
  child.unref();
  return code;
}

/**
 * The detached start's wait. Ready is the run's OWN signal: `/api/health` 200
 * carrying the instance id the child's lock names (the lock binds the answer
 * to THIS child, so another host on the port never counts) — or the lock's
 * `ready`, whichever is first. A reader holding the lock file (a scanner, an
 * indexer) can keep its `ready` write failing for minutes while the host
 * already serves; the start returns then too, and the heartbeat writes the
 * lock once the reader lets go. The lock directory is watched, and while a
 * lock names the child, one health request per `pollMs` is asked.
 */
export function awaitDetachedReady(
  home: string,
  child: Pick<ChildProcess, 'pid' | 'once'>,
  logPath: string,
  deps: Pick<UpDeps, 'health' | 'pollMs'> = PROCESS_UP_DEPS,
): Promise<{ code: number; lines: string[] }> {
  return new Promise((resolve) => {
    const watcher = watch(dirname(homeLockPath(home)));
    let done = false;
    let asking = false;
    const finish = (code: number, lines: string[]): void => {
      if (done) return;
      done = true;
      watcher.close();
      clearInterval(poll);
      resolve({ code, lines });
    };
    const ready = (lock: HomeLock): void => finish(EXIT.OK, [`Neuralis runs on ${lock.app} (log: ${logPath}). \`neuralis down\` stops it.`]);
    const childLock = (): HomeLock | null => {
      const lock = readHomeLock(home);
      return lock !== null && lock !== 'corrupt' && lock.pid === child.pid ? lock : null;
    };
    watcher.on('change', () => {
      const lock = childLock();
      if (lock?.state === 'ready') ready(lock);
    });
    const poll = setInterval(() => {
      const lock = childLock();
      if (!lock || asking) return;
      if (lock.state === 'ready') { ready(lock); return; }
      asking = true;
      void deps.health(lock.app).then((answer) => {
        asking = false;
        if (answer?.status === 200 && answer.instanceId === lock.instanceId) ready(lock);
      });
    }, deps.pollMs);
    child.once('exit', (code) => finish(code ?? EXIT.GENERAL, [`It stopped (exit ${code ?? '?'}): ${logPath} says why.`]));
  });
}

/** Drop writes to a pipe whose reader is gone (`EPIPE`) instead of dying on them; any other error still throws. */
export function ignoreClosedPipe(stream: NodeJS.WritableStream): void {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err;
  });
}

export async function run(argv: string[], ctx: CliContext): Promise<number> {
  const [verb, ...rest] = argv;
  if (verb === 'down') return runDown(ctx.env, (line) => ctx.stderr(`  ${line}\n`));
  if (verb === 'status') {
    const report = await readStatus(ctx.env);
    if (rest.includes('--json')) {
      ctx.stdout(`${JSON.stringify(report)}\n`);
    } else {
      ctx.stdout(`  ${report.state}${report.app ? ` — ${report.app}` : ''} · Qdrant ${report.qdrant.mode} ${report.qdrant.state} · ${report.home}\n`);
      if (report.lock && report.lock.kind === 'docker') ctx.stdout(`  A Docker host holds this data home (${report.lock.app}).\n`);
    }
    return EXIT.OK;
  }
  const unknown = rest.filter((arg) => arg !== '--foreground' && arg !== '--no-stdin');
  if (unknown.length > 0) throw new CliExit(EXIT.GENERAL, `unknown option ${unknown[0]}`, ['Usage: neuralis up [--foreground]']);
  if (!rest.includes('--foreground')) return startDetached(ctx);
  // The parent reading this run's output may go away mid-stop (the desktop app
  // killed): a write to its closed pipe must not end the stop half-done, which
  // would leave the lock and Qdrant behind.
  ignoreClosedPipe(process.stdout);
  ignoreClosedPipe(process.stderr);
  return runUp({ packageDir: ctx.packageDir, io: ctx, watchStdin: !rest.includes('--no-stdin') });
}
