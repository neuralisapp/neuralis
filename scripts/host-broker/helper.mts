/**
 * Pure helpers for `pnpm neuralis:host-broker` — the sandbox-helper install /
 * upgrade pipeline and the pieces of `status` that must agree with it.
 *
 * Why a separate module: `host-broker.mts` is a CLI entry (it dispatches on
 * `process.argv` at import), so nothing in it can be unit-tested without
 * spawning it. The decisions below are the ones a code-read cannot pin and a
 * wrong answer silently misplaces the confinement binary:
 *
 *   - WHICH PATH the helper is installed to. The broker runs the path its UNIT
 *     names (`Environment=NEURALIS_HOST_BROKER_SANDBOXER=…`); a copy written
 *     anywhere else — including to the `/usr/local/bin` that `sandboxerPath()`
 *     would prefer the moment it exists — is a helper the broker never
 *     executes, while `status` probes the new one and reports green.
 *   - WHETHER `upgrade` may restart the unit. A restart kills every host PTY and
 *     every detached host shell the broker owns; a rebuild running as a detached
 *     host shell would die mid-`docker compose up`.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { envFilePath, parseEnvContent } from '../setup/envFile.mts';

/** Where the image build installs the helper; `docker cp` reads from here. */
export const SANDBOXER_CONTAINER_PATH = '/usr/local/bin/nrs-sandboxer';
/** The recommended host location: root-owned, outside every operator write ceiling. */
export const SANDBOXER_SYSTEM_PATH = '/usr/local/bin/nrs-sandboxer';
export const UNIT_NAME = 'neuralis-host-broker';

/** The systemd user unit `init` / `upgrade` write (`$XDG_CONFIG_HOME`, else `~/.config`). */
export function unitFilePath(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(base, 'systemd', 'user', `${UNIT_NAME}.service`);
}

/** The helper path the running broker was told to execute, or null when the unit does not name one. */
export function parseUnitSandboxerPath(unitText: string): string | null {
  const m = /^Environment=NEURALIS_HOST_BROKER_SANDBOXER=(.+)$/m.exec(unitText);
  if (!m) return null;
  const raw = m[1]!.trim();
  return raw.replace(/^"(.*)"$/, '$1') || null;
}

export type SandboxerPathSource = 'flag' | 'unit' | 'env' | 'system';

/**
 * Resolve the install target. Precedence is the broker's truth first:
 * an explicit `--target`, then the UNIT's own line, then the caller's env
 * override, then the recommended system path. Never "the first path that
 * happens to exist" — that is exactly how a stale copy gets probed green.
 */
export function planInstallTarget(input: {
  explicit: string | undefined;
  unitSandboxer: string | null;
  envSandboxer: string | undefined;
}): { path: string; source: SandboxerPathSource } {
  if (input.explicit) return { path: input.explicit, source: 'flag' };
  if (input.unitSandboxer) return { path: input.unitSandboxer, source: 'unit' };
  const env = input.envSandboxer?.trim();
  if (env) return { path: env, source: 'env' };
  return { path: SANDBOXER_SYSTEM_PATH, source: 'system' };
}

export type RestartDecision =
  | { restart: true }
  | { restart: false; reason: 'install_mode' | 'no_restart_flag' | 'unit_inactive' | 'detached_running' };

/**
 * `upgrade` restarts the unit so the broker picks up the new helper and any
 * broker code change; `install` never restarts (there may be nothing to
 * restart yet). A detached host shell in flight blocks the restart unless the
 * operator says `--force` — the restart would kill it, and if it is the
 * rebuild, kill the rebuild.
 */
export function decideRestart(input: {
  mode: 'install' | 'upgrade';
  noRestart: boolean;
  unitActive: boolean;
  detachedRunning: number;
  force: boolean;
}): RestartDecision {
  if (input.mode === 'install') return { restart: false, reason: 'install_mode' };
  if (input.noRestart) return { restart: false, reason: 'no_restart_flag' };
  if (!input.unitActive) return { restart: false, reason: 'unit_inactive' };
  if (input.detachedRunning > 0 && !input.force) return { restart: false, reason: 'detached_running' };
  return { restart: true };
}

/** `NEURALIS_COMPOSE_PROJECT` from the install's `.env`, or the compose default. */
export function composeProjectFromEnv(envText: string | null): string {
  if (!envText) return 'neuralis';
  const name = parseEnvContent(envText).NEURALIS_COMPOSE_PROJECT?.trim();
  return name || 'neuralis';
}

/** This install's compose stack: the app and vector store by their `neuralis.kind` labels, and what runs. */
export type ComposeStack = { project: string; app: string; vectorstore: string | null; running: string[] };

export type ComposeAnswer =
  | ({ kind: 'services' } & ComposeStack)
  /** The compose file was read but labels no single app service: nothing can be said about the app. */
  | { kind: 'unlabelled'; detail: string }
  | { kind: 'no-docker' }
  | { kind: 'failed'; detail: string };

export type ExecResult = { code: number; stdout: string; stderr: string };
/** `docker <args>` in `cwd`; rejects with an `ENOENT` error when there is no Docker CLI. */
export type DockerExec = (args: readonly string[], cwd: string) => Promise<ExecResult>;

/** The real `docker` runner: captured, never a shell. */
export const dockerExec: DockerExec = (args, cwd) => new Promise((resolveRun, reject) => {
  const child = spawn('docker', [...args], { cwd });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stderr += d.toString()));
  child.on('error', reject);
  child.on('close', (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
});

/**
 * The app and vector-store service names from `docker compose config --format
 * json`: the services setup labels `neuralis.kind: app` / `vectorstore`. Null
 * when the output is not a compose model or labels no single app service.
 */
export function parseComposeServices(stdout: string): { app: string; vectorstore: string | null } | null {
  let model: { services?: Record<string, { labels?: Record<string, unknown> | string[] }> };
  try {
    model = JSON.parse(stdout) as typeof model;
  } catch {
    return null;
  }
  const kindOf = (labels: Record<string, unknown> | string[] | undefined): unknown =>
    Array.isArray(labels) ? labels.find((l) => l.startsWith('neuralis.kind='))?.slice('neuralis.kind='.length) : labels?.['neuralis.kind'];
  const services = Object.entries(model.services ?? {});
  const app = services.filter(([, s]) => kindOf(s.labels) === 'app').map(([name]) => name);
  if (app.length !== 1) return null;
  return { app: app[0]!, vectorstore: services.find(([, s]) => kindOf(s.labels) === 'vectorstore')?.[0] ?? null };
}

/** The compose project an install folder records (`.env` NEURALIS_COMPOSE_PROJECT), the default without one. */
export function composeProjectOf(installDir: string): string {
  let envText: string | null = null;
  try {
    envText = readFileSync(envFilePath(installDir), 'utf-8');
  } catch {
    // No .env yet: the project is the default setup would record.
  }
  return composeProjectFromEnv(envText);
}

/**
 * THE reader of "which service is the app, and does it run" for every operator
 * command (the offline gate, rebuild, backup, update): the services by label,
 * then what runs, both in the install folder with `-p <project>` and no `-f`
 * (a `-f` skips the override file). `withRunning: false` skips the `ps`;
 * `composeFileRan: true` is a caller that just ran `compose up` in this folder
 * (rebuild), so the file is not looked for first — Compose itself answers.
 */
export async function readComposeStack(installDir: string, exec: DockerExec = dockerExec, opts: { withRunning?: boolean; composeFileRan?: boolean } = {}): Promise<ComposeAnswer> {
  if (!opts.composeFileRan && !existsSync(join(installDir, 'docker-compose.yml'))) return { kind: 'failed', detail: `${installDir} has no docker-compose.yml` };
  const project = composeProjectOf(installDir);
  const run = async (args: string[]): Promise<ExecResult | 'no-docker'> => {
    try {
      return await exec(['compose', '-p', project, ...args], installDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'no-docker';
      return { code: 127, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
    }
  };
  // --no-interpolate: the model is read for names and labels only; the secrets `.env` feeds stay out of it.
  const config = await run(['config', '--format', 'json', '--no-interpolate']);
  if (config === 'no-docker') return { kind: 'no-docker' };
  if (config.code !== 0) return { kind: 'failed', detail: `\`docker compose config\` failed: ${lastLine(config.stderr) || `exit ${config.code}`}` };
  const services = parseComposeServices(config.stdout);
  if (!services) return { kind: 'unlabelled', detail: `${installDir}/docker-compose.yml labels no single \`neuralis.kind: app\` service — regenerate it with setup` };
  if (opts.withRunning === false) return { kind: 'services', project, ...services, running: [] };
  const ps = await run(['ps', '--status', 'running', '--services']);
  if (ps === 'no-docker') return { kind: 'no-docker' };
  if (ps.code !== 0) return { kind: 'failed', detail: `\`docker compose ps\` failed: ${lastLine(ps.stderr) || `exit ${ps.code}`}` };
  return { kind: 'services', project, ...services, running: ps.stdout.split('\n').map((s) => s.trim()).filter(Boolean) };
}

function lastLine(text: string): string {
  return text.trim().split('\n').at(-1) ?? '';
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function isWritableDir(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The systemd user unit, ONE builder for `init --print-unit` and `upgrade`'s
 * refresh — two renderings would drift on the very line (`…_SANDBOXER=`) the
 * install target is read back from.
 */
export function buildUnitText(input: {
  execPath: string;
  /** `<packageDir>/bin/neuralis.mjs` — the unit runs `host-broker run` through the one CLI. */
  bin: string;
  /** The `NEURALIS_HOME` the broker's own paths derive from. */
  home: string;
  socket: string;
  secret: string;
  ceiling: string;
  scratch: string;
  sandboxer: string;
}): string {
  return `[Unit]
Description=Neuralis host broker
After=network.target

[Service]
Type=simple
ExecStart=${input.execPath} ${input.bin} host-broker run
Environment=NEURALIS_HOME=${input.home}
Environment=NEURALIS_HOST_BROKER_SOCKET=${input.socket}
Environment=NEURALIS_HOST_BROKER_SECRET_FILE=${input.secret}
Environment=NEURALIS_HOST_BROKER_CEILING_FILE=${input.ceiling}
Environment=NEURALIS_HOST_BROKER_SCRATCH_ROOT=${input.scratch}
Environment=NEURALIS_HOST_BROKER_SANDBOXER=${input.sandboxer}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/** Parse `sha256sum` output (`<hex>  <path>`) into the hex, or null. */
export function parseSha256sum(out: string): string | null {
  const m = /^([0-9a-f]{64})\s/m.exec(out);
  return m ? m[1]! : null;
}

/**
 * The helper path the BROKER executes — ONE resolution shared by the CLI and
 * `neuralis:rebuild`'s drift line. The unit's own line is the truth once a unit
 * exists; before that, the caller's env override, then the system path if it
 * is already installed there, then the per-user fallback. `preferEnv` is for
 * a foreground `run`, where the operator set the env for that process.
 */
export function resolveInstalledSandboxer(input: {
  unitText: string | null;
  envSandboxer: string | undefined;
  systemExists: boolean;
  homeDir: string;
  preferEnv?: boolean;
}): { path: string; source: 'unit' | 'env' | 'system' | 'home' } {
  const env = input.envSandboxer?.trim();
  const fromUnit = input.unitText ? parseUnitSandboxerPath(input.unitText) : null;
  if (input.preferEnv && env) return { path: env, source: 'env' };
  if (fromUnit) return { path: fromUnit, source: 'unit' };
  if (env) return { path: env, source: 'env' };
  if (input.systemExists) return { path: SANDBOXER_SYSTEM_PATH, source: 'system' };
  return { path: `${input.homeDir}/.local/bin/nrs-sandboxer`, source: 'home' };
}

// ---------------------------------------------------------------------------
// `grant` — the operator's half of the request→grant channel (D-C)
// ---------------------------------------------------------------------------

export type CeilingList = 'read' | 'write' | 'exec';

/**
 * Add directories to one ceiling list, preserving every other key verbatim
 * (the `$comment`, `$suggestedExecRoots`, `confinement`, the detached keys —
 * anything the operator wrote). Refuses a malformed file rather than "fixing"
 * it: the broker's loader treats malformed JSON as DENY-ALL, and a grant that
 * rewrote a broken file would silently turn deny-all into a fresh, wrong file.
 */
export function applyGrant(
  ceilingText: string,
  list: CeilingList,
  dirs: readonly string[],
): { ok: true; text: string; added: string[]; already: string[] } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ceilingText);
  } catch (err) {
    return { ok: false, reason: `ceiling is not valid JSON (${err instanceof Error ? err.message : String(err)}) — fix it by hand first` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'ceiling is not a JSON object' };
  const ceiling = parsed as Record<string, unknown>;
  const current = Array.isArray(ceiling[list]) ? (ceiling[list] as unknown[]).filter((v): v is string => typeof v === 'string') : [];
  const added: string[] = [];
  const already: string[] = [];
  for (const dir of dirs) {
    if (current.includes(dir)) already.push(dir);
    else {
      current.push(dir);
      added.push(dir);
    }
  }
  ceiling[list] = current;
  return { ok: true, text: `${JSON.stringify(ceiling, null, 2)}\n`, added, already };
}

/**
 * D-G — the toolchain roots an operator most often has to name in `exec`
 * before an agent can run `node`, `pnpm`, `cargo` or a `~/.local/bin` CLI
 * on the host. A SUGGESTION written into `$suggestedExecRoots` (a JSON string
 * array the broker ignores — never a `//` comment, the loader is strict
 * `JSON.parse`), never a grant. Irrelevant in unconfined mode.
 */
export function detectToolchainRoots(homeDir: string, exists: (path: string) => boolean): string[] {
  const candidates = [
    `${homeDir}/.nvm`,
    `${homeDir}/.cargo/bin`,
    `${homeDir}/.local/bin`,
    '/usr/local',
  ];
  return candidates.filter((p) => exists(p));
}

/** The suggested roots NOT yet in the ceiling's `exec` (or covered by one of its entries). */
export function suggestedExecRootsMissing(suggested: readonly string[], exec: readonly string[]): string[] {
  const covered = (p: string) => exec.some((e) => p === e || p.startsWith(e.endsWith('/') ? e : `${e}/`));
  return suggested.filter((p) => !covered(p));
}
