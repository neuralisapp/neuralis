/**
 * Environment auto-detection for Neuralis setup.
 * Checks: Docker (its cause, its Compose plugin), Qdrant, Ollama, platform,
 * existing config, install mode, the host ports a compose file publishes, and
 * whether a folder lies on a bind from the host.
 */

import { execSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import { hostname, platform as osPlatform } from 'node:os';
import { isAbsolute, join } from 'node:path';
import http from 'node:http';
import { resolveNeuralisHome } from '@neuralis/package-system/paths';
import { CliExit } from '../cli/registry.mts';
import { imageSetupCommand, installLayout, spell, spellOn, type InstallLayout } from '../cli/spelling.mts';
import { hostQdrantUrl, readEnvFile, type CarriedOverEnv, type PortTriple } from './envFile.mts';

/**
 * Stat /var/run/docker.sock and return its owning GID.
 *
 * Kept inline here (NOT imported from `../src/server/docker/socketGid`) because
 * this file is run by tsx under Node ESM, and cross-boundary TS imports from
 * Next.js-owned source trip `ERR_MODULE_NOT_FOUND` at runtime. The canonical
 * copy lives in `src/server/docker/socketGid.ts` for the host bundle; this is
 * the script-side mirror — ~10 lines, no drift risk.
 */
async function detectDockerSocketGid(): Promise<number | null> {
  try {
    const info = await stat('/var/run/docker.sock');
    return typeof info.gid === 'number' ? info.gid : null;
  } catch {
    return null;
  }
}

// ── Types ──────────────────────────────────────────────────────

export type Platform = 'linux' | 'macos' | 'windows' | 'wsl';

export type DetectedEnv = {
  platform: Platform;
  docker: boolean;
  dockerVersion: string | null;
  /** Why `docker` is false (null when it answers) — a refusal names the fix for this cause. */
  dockerCause: DockerCause | null;
  /** The Compose v2 CLI plugin is installed (`docker compose`). */
  dockerCompose: boolean;
  qdrant: { running: boolean; url: string; version: string | null };
  ollama: { running: boolean; url: string; models: string[] };
  neuralisHome: string;
  existingSetup: boolean; // has users/
  isClone: boolean;
  projectRoot: string; // repo root or cwd
  uid: number;
  gid: number;
  /**
   * GID that owns /var/run/docker.sock on the host. Used as a supplementary
   * group inside the neuralis container so the non-root app user can talk to
   * the bind-mounted Docker socket (machine-core spawns Webtop containers via
   * the socket). `null` on platforms where the socket is not a unix socket
   * we own (macOS Desktop, Windows) or when detection fails.
   */
  dockerGid: number | null;
};

// ── HTTP helper ────────────────────────────────────────────────

function httpGet(url: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Detectors ──────────────────────────────────────────────────

function detectPlatform(): Platform {
  const p = osPlatform();
  if (p === 'darwin') return 'macos';
  if (p === 'win32') return 'windows';
  // Check WSL
  try {
    const version = execSync('cat /proc/version 2>/dev/null', { encoding: 'utf-8' });
    if (/microsoft|wsl/i.test(version)) return 'wsl';
  } catch { /* not WSL */ }
  return 'linux';
}

/** One program run without a shell: its output, and the spawn error (`ENOENT` = not on PATH). */
export type ProgramResult = { stdout: string; stderr: string; status: number | null; error: NodeJS.ErrnoException | null };
export type ProgramRunner = (file: string, args: string[]) => ProgramResult;

const runProgram: ProgramRunner = (file, args) => {
  const result = spawnSync(file, args, { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status, error: (result.error as NodeJS.ErrnoException | undefined) ?? null };
};

/** Why Docker cannot be used: no CLI on PATH · no daemon answering · this user may not open its socket. */
export type DockerCause = 'missing' | 'daemon' | 'permission';

export type DockerDetection = { available: boolean; version: string | null; cause: DockerCause | null; compose: boolean };

/**
 * The client's plugins and the daemon's version in ONE `docker info`: the
 * plugin list is client-side (the Compose v2 answer, even with no daemon), an
 * empty server version means the daemon did not answer, and stderr says why.
 */
const DOCKER_INFO_FORMAT = '{{json .ClientInfo.Plugins}}|{{.ServerVersion}}';

/**
 * Docker CLI present, its daemon answering, and the Compose plugin — each
 * failure with its cause. No shell: a `2>/dev/null` redirect meant cmd.exe
 * looked for a `\dev\null` path and failed, so Windows never detected Docker.
 */
export function detectDocker(run: ProgramRunner = runProgram): DockerDetection {
  const result = run('docker', ['info', '--format', DOCKER_INFO_FORMAT]);
  if (result.error?.code === 'ENOENT') return { available: false, version: null, cause: 'missing', compose: false };
  const line = result.stdout.trim().split('\n').at(-1) ?? '';
  const split = line.lastIndexOf('|');
  let compose = false;
  try {
    const plugins = JSON.parse(split >= 0 ? line.slice(0, split) : line) as Array<{ Name?: unknown; Err?: unknown }> | null;
    compose = Array.isArray(plugins) && plugins.some((plugin) => plugin.Name === 'compose' && !plugin.Err);
  } catch {
    // An unreadable plugin list: Compose is not proven.
  }
  const version = split >= 0 ? line.slice(split + 1).trim() : '';
  if (result.status === 0 && result.error === null && version) return { available: true, version, cause: null, compose };
  return { available: false, version: null, cause: /permission denied/i.test(result.stderr) ? 'permission' : 'daemon', compose };
}

export async function detectQdrant(url: string): Promise<{ running: boolean; version: string | null }> {
  try {
    const data = await httpGet(`${url}/healthz`);
    // Try to get version from /cluster/info or /
    let version: string | null = null;
    try {
      const info = await httpGet(url);
      const parsed = JSON.parse(info);
      version = parsed.version ?? null;
    } catch { /* ok */ }
    return { running: true, version };
  } catch {
    return { running: false, version: null };
  }
}

async function detectOllama(url: string): Promise<{ running: boolean; models: string[] }> {
  try {
    const data = await httpGet(`${url}/api/tags`);
    const parsed = JSON.parse(data);
    const models = (parsed.models ?? []).map((m: { name: string }) => m.name);
    return { running: true, models };
  } catch {
    return { running: false, models: [] };
  }
}

function resolveHome(): string {
  return resolveNeuralisHome().home;
}

async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export async function detectIsClone(cwd: string): Promise<boolean> {
  // Check cwd and parent (script may be called from neuralis/)
  if (await fileExists(join(cwd, 'pnpm-workspace.yaml'))) return true;
  if (await fileExists(join(cwd, '..', 'pnpm-workspace.yaml'))) return true;
  return false;
}

/**
 * Where `.env` and `docker-compose.yml` live: `--output` when given,
 * `NEURALIS_HOME` in the image's own tree (the `container` layout), and the
 * install folder in every other layout — an npm folder, a clone or the
 * development checkout, inside a container or not (`npm run start` /
 * `next start` loads `.env` from there). The layout is `installLayout`'s,
 * never a second detector; the install folder is its own package dir in every
 * layout but a folder, which its manifest decides first. Every operator
 * command that reads them asks this, never its own copy.
 */
export function resolveConfigDir(
  env: Pick<DetectedEnv, 'projectRoot' | 'neuralisHome'>,
  outputOverride: string | null,
  inContainer = existsSync('/.dockerenv'),
): string {
  if (outputOverride) return outputOverride;
  return installLayout(env.projectRoot, env.projectRoot, inContainer) === 'container' ? env.neuralisHome : env.projectRoot;
}

/**
 * The HOST path of the data home — what a generated compose file binds and
 * hands the app as `NEURALIS_HOST_HOME`. Inside a container the process sees
 * the bind target, so the host path arrives as an absolute `NEURALIS_HOST_HOME`
 * (the one-shot setup container is given it; the running app container already
 * carries it). Anywhere else the data home is its own host path. Files are
 * still read and written at `neuralisHome`.
 */
export function resolveHostHome(
  neuralisHome: string,
  inContainer = existsSync('/.dockerenv'),
  hostHome: string | undefined = process.env.NEURALIS_HOST_HOME,
): string {
  return inContainer && hostHome && isAbsolute(hostHome) ? hostHome : neuralisHome;
}

// ── Host ports ─────────────────────────────────────────────────

/** A host port the generated compose publishes: what it is for, the port and the bind address. */
export type PortClaim = { key: string; port: number; address: '0.0.0.0' | '127.0.0.1' };
/** One port a running container publishes, and the Compose project that owns it (null: none). */
export type PublishedPort = { port: number; project: string | null; container: string };
/** A claimed port something else holds; `holder` names it when Docker can (null: a host process). */
export type BusyPort = PortClaim & { holder: string | null };
/** Which of `claims` cannot be bound right now. */
export type PortProbe = (claims: PortClaim[]) => Promise<PortClaim[]>;

/** Runs a program without a shell, asynchronously — parallel probes. */
export type AsyncProgramRunner = (file: string, args: string[]) => Promise<ProgramResult>;

const runProgramAsync: AsyncProgramRunner = (file, args) => new Promise((resolve) => {
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 30_000 });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  child.on('error', (error: NodeJS.ErrnoException) => resolve({ stdout, stderr, status: null, error }));
  child.on('close', (status) => resolve({ stdout, stderr, status, error: null }));
});

/** Every published port on this daemon, with its Compose project — ONE `docker ps`; null when Docker cannot answer. */
export async function listPublishedPorts(run: AsyncProgramRunner = runProgramAsync): Promise<PublishedPort[] | null> {
  const result = await run('docker', ['ps', '--format', '{{.Label "com.docker.compose.project"}}\t{{.Names}}\t{{.Ports}}']);
  if (result.error || result.status !== 0) return null;
  const rows: PublishedPort[] = [];
  for (const line of result.stdout.split('\n')) {
    const [project = '', container = '', ports = ''] = line.split('\t');
    if (!container) continue;
    // Each published entry is `<ip>:<host>-><container>/<proto>`; Docker folds
    // consecutive identity mappings into a RANGE (`0.0.0.0:3100-3101->3100-3101/tcp`),
    // and IPv6 spells the address `[::]:` or `:::`. An exposed, unpublished port has no `->`.
    const published = new Set<number>();
    for (const [, from, to] of ports.matchAll(/:(\d+)(?:-(\d+))?->/g)) {
      for (let port = Number(from); port <= Number(to ?? from); port++) published.add(port);
    }
    for (const port of published) rows.push({ port, project: project || null, container });
  }
  return rows;
}

/** How a holder reads in a refusal or a prompt. */
export function holderOf(row: PublishedPort): string {
  return row.project ? `Compose project "${row.project}"` : `container ${row.container}`;
}

/**
 * The host plane's probe: one `listen` per claim, on the address the compose
 * file publishes, in parallel. It sees this machine's network namespace — under
 * Docker Desktop the daemon binds on the other side of the VM, where a holder
 * stays invisible until `docker compose up`.
 */
export const listenProbe: PortProbe = async (claims) => {
  const busy = await Promise.all(claims.map((claim) => new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'EADDRINUSE' || error.code === 'EACCES'));
    server.listen({ port: claim.port, host: claim.address, exclusive: true }, () => server.close(() => resolve(false)));
  })));
  return claims.filter((_, i) => busy[i]);
};

/**
 * Inside the image the container's own network is not the host's, so a claim
 * is tried where the stack will bind it: one throwaway `docker run -p` of the
 * image THIS container runs (the tag the user pulled need not exist locally),
 * per port, in parallel — a single run with every port stops at the first busy
 * one. Anything but "port in use" is a refusal, never "assume free".
 */
export async function dockerRunProbe(run: AsyncProgramRunner = runProgramAsync, self: string = hostname()): Promise<PortProbe> {
  const inspected = await run('docker', ['inspect', self, '--format', '{{.Image}}']);
  const image = inspected.stdout.trim();
  if (inspected.error || inspected.status !== 0 || !image) {
    throw new Error(`Cannot tell which image this container runs (docker inspect ${self}), so the host ports cannot be checked. Nothing was written.`);
  }
  return async (claims) => {
    const results = await Promise.all(claims.map((claim) => run('docker', [
      'run', '--rm', '--label', 'neuralis.kind=probe', '--entrypoint', 'true',
      '-p', `${claim.address}:${claim.port}:${claim.port}`, image,
    ])));
    const busy: PortClaim[] = [];
    results.forEach((result, i) => {
      if (!result.error && result.status === 0) return;
      if (/port is already allocated|address already in use/i.test(result.stderr)) busy.push(claims[i]!);
      else throw new Error(`Checking host port ${claims[i]!.port} failed: ${result.stderr.trim().split('\n').at(-1) ?? 'docker run failed'}. Nothing was written.`);
    });
    return busy;
  };
}

/**
 * The claims something other than this install holds. On a host layout the
 * listen probe and Docker's table (one memoised `docker ps`, when Docker
 * answers) run together — the table names a holder and catches a port another
 * project publishes that the probe cannot see from inside a container; in the
 * image Docker's table answers first and only the unclaimed rest is tried.
 * A port this install's own Compose project publishes is never busy — a
 * re-run or a regeneration beside the running stack is the normal case.
 */
export async function findBusyPorts(claims: PortClaim[], ctx: {
  ownProject: string | null;
  published: () => Promise<PublishedPort[] | null>;
  probe: PortProbe;
  probeFirst: boolean;
}): Promise<BusyPort[]> {
  const holderFor = (table: PublishedPort[] | null, port: number) => table?.find((row) => row.port === port) ?? null;
  const own = (row: PublishedPort | null) => row !== null && ctx.ownProject !== null && row.project === ctx.ownProject;
  if (ctx.probeFirst) {
    // The table is read even when the listen probe finds every port free: a
    // setup running inside a container probes ITS network namespace, blind to
    // what the daemon publishes on the host (null without Docker — no exec).
    const [probed, table] = await Promise.all([ctx.probe(claims), ctx.published()]);
    const hit = new Set(probed.map((claim) => claim.key));
    return claims.flatMap((claim): BusyPort[] => {
      const row = holderFor(table, claim.port);
      if (own(row)) return [];
      if (row) return [{ ...claim, holder: holderOf(row) }];
      return hit.has(claim.key) ? [{ ...claim, holder: null }] : [];
    });
  }
  const table = await ctx.published();
  const named: BusyPort[] = [];
  const rest: PortClaim[] = [];
  for (const claim of claims) {
    const row = holderFor(table, claim.port);
    if (own(row)) continue;
    if (row) named.push({ ...claim, holder: holderOf(row) });
    else rest.push(claim);
  }
  const probed = new Set((rest.length > 0 ? await ctx.probe(rest) : []).map((claim) => claim.key));
  return claims.flatMap((claim): BusyPort[] => {
    const hit = named.find((row) => row.key === claim.key);
    if (hit) return [hit];
    return probed.has(claim.key) ? [{ ...claim, holder: null }] : [];
  });
}

/**
 * The next free port above `from` for each busy claim: never a port another
 * claim keeps, another busy claim got, or a container publishes; each
 * candidate is probed, a taken one skipped. Bounded — a refusal past it.
 */
export async function nextFreePorts(busy: PortClaim[], keep: number[], ctx: { probe: PortProbe; published: PublishedPort[] | null }): Promise<Map<string, number>> {
  const taken = new Set([...keep, ...(ctx.published ?? []).map((row) => row.port)]);
  const chosen = new Map<string, number>();
  let pending = busy.map((claim) => ({ claim, next: claim.port + 1 }));
  for (let round = 0; pending.length > 0; round++) {
    if (round >= 20) throw new Error(`No free port found above ${pending.map((p) => p.claim.port).join(', ')}. Nothing was written.`);
    const candidates = pending.map(({ claim, next }) => {
      let port = next;
      while (taken.has(port) && port < 65535) port++;
      taken.add(port);
      return { claim: { ...claim, port }, origin: claim };
    });
    const stillBusy = new Set((await ctx.probe(candidates.map((c) => c.claim))).map((c) => c.key));
    pending = [];
    for (const { claim, origin } of candidates) {
      if (stillBusy.has(claim.key)) pending.push({ claim: origin, next: claim.port + 1 });
      else chosen.set(claim.key, claim.port);
    }
  }
  return chosen;
}

/**
 * Whose Qdrant answers: this install's OWN when the carried mode explains it —
 * docker and its own Compose project publishes that port, or binary/external
 * and the recorded URL is the one answering. Anything else is someone else's,
 * and setup offers it rather than adopting it. A re-run never re-decides an
 * install's own mode.
 */
export function qdrantOwnership(input: {
  carriedMode: string | null;
  carriedUrl: string | null;
  answeringUrl: string;
  ownProject: string | null;
  published: PublishedPort[] | null;
}): 'own' | 'foreign' {
  const origin = (url: string | null): string | null => {
    try {
      const parsed = new URL(url ?? '');
      if (parsed.hostname === '127.0.0.1') parsed.hostname = 'localhost';
      return parsed.origin;
    } catch {
      return null;
    }
  };
  if (input.carriedMode === 'docker') {
    const port = Number(new URL(input.answeringUrl).port || 80);
    return input.ownProject !== null && (input.published ?? []).some((row) => row.port === port && row.project === input.ownProject) ? 'own' : 'foreign';
  }
  if (input.carriedMode === 'binary' || input.carriedMode === 'external') {
    const carried = origin(input.carriedUrl);
    return carried !== null && carried === origin(input.answeringUrl) ? 'own' : 'foreign';
  }
  return 'foreign';
}

/** Each published host port: its `.env` key, and how a prompt names it. */
export const PORT_ROLES: Record<string, { envKey: string; label: string }> = {
  app: { envKey: 'NEURALIS_APP_PORT', label: 'the app' },
  mcp: { envKey: 'MCP_HTTP_PORT', label: 'MCP' },
  sandbox: { envKey: 'NEURALIS_MCP_SANDBOX_PORT', label: 'the MCP Apps sandbox origin' },
  qdrant: { envKey: 'NEURALIS_QDRANT_PORT', label: 'Qdrant' },
  codex: { envKey: 'NEURALIS_CODEX_LOOPBACK', label: 'the ChatGPT sign-in callback' },
};

/** The host ports the generated compose publishes (the ChatGPT callback is fixed at 1455 by the IdP). */
export function portClaims(input: { ports: PortTriple; qdrantPort: number | null; codex: boolean }): PortClaim[] {
  return [
    { key: 'app', port: input.ports.app, address: '0.0.0.0' },
    { key: 'mcp', port: input.ports.mcp, address: '0.0.0.0' },
    { key: 'sandbox', port: input.ports.sandbox, address: '0.0.0.0' },
    ...(input.qdrantPort !== null ? [{ key: 'qdrant', port: input.qdrantPort, address: '127.0.0.1' as const }] : []),
    ...(input.codex ? [{ key: 'codex', port: 1455, address: '127.0.0.1' as const }] : []),
  ];
}

/** How this layout checks ports: a listen on the host; a throwaway `docker run -p` in the image. Docker's table is read once. */
export type PortCheck = { probe: PortProbe; probeFirst: boolean; published: () => Promise<PublishedPort[] | null> };

export function portCheck(layout: InstallLayout, docker: boolean): PortCheck {
  let table: Promise<PublishedPort[] | null> | null = null;
  const published = () => (table ??= docker ? listPublishedPorts() : Promise.resolve(null));
  if (layout !== 'container') return { probe: listenProbe, probeFirst: true, published };
  let probe: Promise<PortProbe> | null = null;
  return { probe: async (claims) => (await (probe ??= dockerRunProbe()))(claims), probeFirst: false, published };
}

/**
 * `--compose-only` asks nothing: a busy port is refused with the `.env` line
 * that moves it, writing nothing.
 */
export function busyPortRefusal(busy: BusyPort[], free: Map<string, number>): CliExit {
  const lines = busy.map((b) => {
    const role = PORT_ROLES[b.key]!;
    const fix = b.key === 'codex' ? `${role.envKey}=off` : `${role.envKey}=${free.get(b.key)}`;
    return `Port ${b.port} (${role.label}) is in use${b.holder ? ` — held by ${b.holder}` : ''}: set ${fix} in .env.`;
  });
  return new CliExit(1, `${busy.length === 1 ? 'A port' : 'Ports'} this install publishes ${busy.length === 1 ? 'is' : 'are'} in use.`, [
    ...lines,
    `Then run ${spell('setup --compose-only')} again. Nothing was written.`,
  ]);
}

/** What is wrong with this machine's Docker for the folder, and its fix on this platform. */
export function dockerFolderProblem(docker: Pick<DockerDetection, 'available' | 'cause' | 'compose'>, platform: Platform, composeOnly: boolean): [string, string] | null {
  const desktop = platform === 'macos' || platform === 'windows';
  const wslDesktop = 'Docker Desktop for Windows with this distro enabled under Settings → Resources → WSL integration';
  if (docker.cause === 'missing') {
    if (desktop) return ['Docker is not installed.', 'Install Docker Desktop: https://docs.docker.com/desktop/'];
    if (platform === 'wsl') return ['Docker is not installed in this WSL distro.', `Install ${wslDesktop}, or Docker Engine inside WSL: https://docs.docker.com/engine/install/`];
    return ['Docker is not installed.', 'Install Docker Engine with the Compose plugin: https://docs.docker.com/engine/install/'];
  }
  // `--compose-only` writes the compose file from `.env`: the CLI and its plugin are enough.
  if (!composeOnly && !docker.available) {
    if (docker.cause === 'permission') {
      if (desktop) return ['This user may not open the Docker socket.', 'Restart Docker Desktop, then run setup again as the user who runs it.'];
      return ['This user may not open the Docker socket.', 'Add yourself to the docker group, then log in again: sudo usermod -aG docker "$USER"'];
    }
    if (desktop) return ['Docker is installed but its daemon does not answer.', 'Start Docker Desktop.'];
    if (platform === 'wsl') return ['Docker is installed but its daemon does not answer.', `Start ${wslDesktop} — or, with Docker Engine inside WSL: sudo service docker start`];
    return ['Docker is installed but its daemon does not answer.', 'Start it: sudo systemctl start docker'];
  }
  if (docker.compose) return null;
  if (desktop) return ['Docker Compose v2 (`docker compose`) is missing.', 'Update Docker Desktop — it ships Compose v2.'];
  return ['Docker Compose v2 (`docker compose`) is missing.', 'Install the Compose plugin (Debian/Ubuntu: sudo apt install docker-compose-plugin): https://docs.docker.com/compose/install/linux/'];
}

/**
 * The mount point that carries `dir` when it is not the container's own root
 * filesystem — a bind (or volume) from outside — read from
 * `/proc/self/mountinfo` (field 5, octal-escaped). Null when `dir` lies on `/`.
 */
export function bindMountOf(dir: string, mountinfo: string): string | null {
  let best: string | null = null;
  for (const line of mountinfo.split('\n')) {
    const field = line.split(' ')[4];
    if (!field) continue;
    const point = field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    const covers = point === '/' || dir === point || dir.startsWith(point.endsWith('/') ? point : `${point}/`);
    if (covers && (best === null || point.length > best.length)) best = point;
  }
  return best === '/' ? null : best;
}

/**
 * Fill `process.env` from the deployment's `.env` for a host-plane operator
 * command (the stores read their roots and the session secret through it). A
 * value already in the environment — the container's — wins.
 */
export async function loadHostEnv(neuralisDir: string): Promise<void> {
  const neuralisHome = resolveNeuralisHome().home;
  const configDir = resolveConfigDir({ projectRoot: neuralisDir, neuralisHome }, null);
  for (const [key, value] of Object.entries(await readEnvFile(configDir))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function detectExistingSetup(neuralisHome: string): Promise<boolean> {
  // Check if users/ directory has any JSON files
  try {
    const usersDir = join(neuralisHome, 'app', 'users');
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(usersDir);
    return files.some(f => f.endsWith('.json'));
  } catch {
    return false;
  }
}

// ── Main detect ────────────────────────────────────────────────

/** `projectRoot` is the install folder the operator command runs for (`ctx.installDir`). */
export async function detectEnvironment(projectRoot: string): Promise<DetectedEnv> {
  const platform = detectPlatform();
  const docker = detectDocker();
  const neuralisHome = resolveHome();
  const isClone = await detectIsClone(projectRoot);

  const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
  const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';

  const [qdrant, ollama, existingSetup, dockerGid] = await Promise.all([
    detectQdrant(qdrantUrl),
    detectOllama(ollamaUrl),
    detectExistingSetup(neuralisHome),
    detectDockerSocketGid(),
  ]);

  return {
    platform,
    docker: docker.available,
    dockerVersion: docker.version,
    dockerCause: docker.cause,
    dockerCompose: docker.compose,
    qdrant: { running: qdrant.running, url: qdrantUrl, version: qdrant.version },
    ollama: { running: ollama.running, url: ollamaUrl, models: ollama.models },
    neuralisHome,
    existingSetup,
    isClone,
    projectRoot,
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
    dockerGid,
  };
}

// ── Preflight refusals and the answering Qdrant (pure; setup.mts asks the questions) ──

/** The image's own data home (`ENV NEURALIS_HOME` in the Dockerfile): a bind target, never a host path. */
const IMAGE_DATA_HOME = '/.neuralis';

/** The fix lines every image-channel refusal ends with; `folder` is the install folder when known. */
export function imageFix(version: string, composeOnly: boolean, folder: string | null = null): string[] {
  return ['Run it from the image like this (Linux or WSL2):', ...imageSetupCommand(version, composeOnly, folder).map((line) => `  ${line}`), 'Nothing was written.'];
}

export const INSTALL_HELP = 'https://docs.neuralisapp.com/getting-started/installation#if-something-fails';

/**
 * Every wall setup can see before any prompt or write, by layout. Null when
 * nothing is missing.
 *
 * - **container** — the image writes an install folder for the HOST, so it needs
 *   what the host alone can say: where the data home is on the host (an absolute
 *   `NEURALIS_HOST_HOME`, unless the home is bound at its own host path), a
 *   reachable Docker (the socket), and the install folder (`--output`) on a bind
 *   it can write. The bind check proves a bind, not that the host path equals
 *   the container path (`-v "$PWD:/out"` passes); the documented
 *   `-v "$PWD:$PWD"` is what makes every printed path a host path. Write access
 *   to the data home is the data root check (`ensureWritableOrExplain`).
 * - **folder** — an npm install folder runs the published image only (native
 *   runs from a source clone), so a full setup needs a Docker that answers and
 *   the Compose plugin; `--compose-only` needs the CLI and the plugin.
 */
export function setupRefusal(input: {
  layout: InstallLayout;
  platform: Platform;
  neuralisHome: string;
  hostHome: string | undefined;
  docker: Pick<DockerDetection, 'available' | 'cause' | 'compose'>;
  version: string;
  composeOnly: boolean;
  /** The folder `.env` and the compose file land in, as this process sees it. */
  output: { dir: string; bound: boolean; writable: boolean };
}): CliExit | null {
  if (input.layout === 'folder') {
    const problem = dockerFolderProblem(input.docker, input.platform, input.composeOnly);
    if (!problem) return null;
    return new CliExit(1, `${problem[0]} An npm install folder runs Neuralis with Docker Compose.`, [
      problem[1],
      `Then run ${spellOn('folder', input.composeOnly ? 'setup --compose-only' : 'setup')} again. More: ${INSTALL_HELP}`,
      'Nothing was written.',
    ]);
  }
  if (input.layout !== 'container') return null;
  const fix = imageFix(input.version, input.composeOnly, input.composeOnly ? input.output.dir : null);
  if (input.hostHome && !isAbsolute(input.hostHome)) {
    return new CliExit(1, `NEURALIS_HOST_HOME must be the absolute host path of the data home, not "${input.hostHome}".`, fix);
  }
  if (!input.hostHome && input.neuralisHome === IMAGE_DATA_HOME) {
    return new CliExit(1, 'NEURALIS_HOST_HOME is not set, so this container cannot tell where its data home lives on the host.', [
      `The compose file setup writes binds the data home by its host path; inside the image it is only ${IMAGE_DATA_HOME}.`,
      ...fix,
    ]);
  }
  if (!input.docker.available) {
    const why = input.docker.cause === 'permission'
      ? 'this user may not open the bound socket — add its group: --group-add "$(stat -c %g /var/run/docker.sock)".'
      : 'the socket is not bound, or no daemon answers through it — bind it: -v /var/run/docker.sock:/var/run/docker.sock.';
    return new CliExit(1, `Docker is not reachable from this container: ${why}`, [
      'Setup uses it to detect Docker, to read the vector store\'s volume and to pre-pull the desktop image.',
      ...fix,
    ]);
  }
  if (!input.output.bound) {
    return new CliExit(1, `The install folder ${input.output.dir} is not bound from the host: .env and the compose file would stay inside this container.`, [
      'Bind the folder at its own path and name it as the output: -v "$PWD:$PWD" … --output "$PWD".',
      ...fix,
    ]);
  }
  if (!input.output.writable) {
    return new CliExit(1, `The install folder ${input.output.dir} is not writable by this user.`, [
      'The image runs as its own user unless it is given yours: --user "$(id -u):$(id -g)".',
      ...fix,
    ]);
  }
  return null;
}

/** A Qdrant that answers where this install looks, and whose it is (`qdrantOwnership`). */
export type QdrantAnswer = { url: string; version: string | null; owner: 'own' | 'foreign' } | null;

/**
 * The Qdrant that answers where this install looks — the recorded URL on a
 * re-run (detection probed only the default), the default otherwise — and
 * whose it is. Null when none answers. A carried docker mode whose own Compose
 * project publishes the carried port is this install's own whether or not the
 * probe reaches it: inside the setup container the host loopback is invisible.
 * That answer carries `version: null`, so the install's Qdrant version comes
 * from its recorded state (`resolveInstallQdrantVersion`), not the live server.
 */
export async function answeringQdrant(env: Pick<DetectedEnv, 'qdrant'>, carried: CarriedOverEnv, ownProject: string, check: Pick<PortCheck, 'published'>): Promise<QdrantAnswer> {
  const recorded = carried.qdrantMode ? hostQdrantUrl({ QDRANT_MODE: carried.qdrantMode, QDRANT_URL: carried.qdrantUrl ?? undefined, NEURALIS_QDRANT_PORT: String(carried.qdrantPort) }) : null;
  const probe = recorded && recorded !== env.qdrant.url ? { url: recorded, ...(await detectQdrant(recorded)) } : env.qdrant;
  if (carried.qdrantMode === 'docker' && !probe.running) {
    const url = `http://localhost:${carried.qdrantPort}`;
    if (qdrantOwnership({ carriedMode: 'docker', carriedUrl: null, answeringUrl: url, ownProject, published: await check.published() }) === 'own') {
      return { url, version: null, owner: 'own' };
    }
  }
  if (!probe.running) return null;
  const owner = qdrantOwnership({ carriedMode: carried.qdrantMode, carriedUrl: carried.qdrantUrl, answeringUrl: probe.url, ownProject, published: await check.published() });
  return { url: probe.url, version: probe.version, owner };
}
