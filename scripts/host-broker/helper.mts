/**
 * The compose-stack reader and the small digest helpers the operator commands
 * share (the offline gate, rebuild, backup, update, setup, checkpoint) — ONE
 * reader of "which service is the app, and does it run", so no command grows
 * its own. The folder name is historical: the host-access broker it once also
 * served moved into the device client (`neuralis device`, `@neuralis/cli`).
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { envFilePath, parseEnvContent } from '../setup/envFile.mts';

/** Where the image build installs the confinement helper (`neuralis rebuild` compares a device's copy with it). */
export const SANDBOXER_CONTAINER_PATH = '/usr/local/bin/nrs-sandboxer';

/** `NEURALIS_COMPOSE_PROJECT` from the install's `.env`, or the compose default. */
export function composeProjectFromEnv(envText: string | null): string {
  if (!envText) return 'neuralis';
  const name = parseEnvContent(envText).NEURALIS_COMPOSE_PROJECT?.trim();
  return name || 'neuralis';
}

/** This install's compose stack: the app and vector store by their `neuralis.kind` labels, and what runs. */
export type ComposeStack = { project: string; app: string; vectorstore: string | null; running: string[] };

/**
 * The companion services a compose file may carry beside (or instead of) the
 * app, by their `neuralis.kind` label: the vector store and the local-model
 * server (`embeddings`, Ollama).
 */
export type CompanionKind = 'vectorstore' | 'embeddings';

export type ComposeAnswer =
  | ({ kind: 'services' } & ComposeStack)
  /**
   * A compose file with companions and no app — the desktop app's own Qdrant
   * and/or Ollama (`setup --native`): at most one of each, at least one.
   */
  | { kind: 'companions'; project: string; vectorstore: string | null; embeddings: string | null; running: string[] }
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
  const named = servicesByKind(stdout);
  const app = named?.get('app') ?? [];
  if (app.length !== 1) return null;
  return { app: app[0]!, vectorstore: named?.get('vectorstore')?.[0] ?? null };
}

/** Service names per `neuralis.kind` label; null when the output is not a compose model. */
function servicesByKind(stdout: string): Map<unknown, string[]> | null {
  let model: { services?: Record<string, { labels?: Record<string, unknown> | string[] }> };
  try {
    model = JSON.parse(stdout) as typeof model;
  } catch {
    return null;
  }
  const kindOf = (labels: Record<string, unknown> | string[] | undefined): unknown =>
    Array.isArray(labels) ? labels.find((l) => l.startsWith('neuralis.kind='))?.slice('neuralis.kind='.length) : labels?.['neuralis.kind'];
  const byKind = new Map<unknown, string[]>();
  for (const [name, service] of Object.entries(model.services ?? {})) {
    const kind = kindOf(service.labels);
    byKind.set(kind, [...(byKind.get(kind) ?? []), name]);
  }
  return byKind;
}

/** A model with no app service and at most one of each companion, at least one (the desktop app's own); else null. */
function companionsOnly(stdout: string): { vectorstore: string | null; embeddings: string | null } | null {
  const named = servicesByKind(stdout);
  if (!named || named.has('app')) return null;
  const stores = named.get('vectorstore') ?? [];
  const models = named.get('embeddings') ?? [];
  if (stores.length > 1 || models.length > 1 || stores.length + models.length === 0) return null;
  return { vectorstore: stores[0] ?? null, embeddings: models[0] ?? null };
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
  const companions = services ? null : companionsOnly(config.stdout);
  if (!services && !companions) return { kind: 'unlabelled', detail: `${installDir}/docker-compose.yml labels no single \`neuralis.kind: app\` service — regenerate it with setup` };
  const answer = (running: string[]): ComposeAnswer => (services ? { kind: 'services', project, ...services, running } : { kind: 'companions', project, ...companions!, running });
  if (opts.withRunning === false) return answer([]);
  const ps = await run(['ps', '--status', 'running', '--services']);
  if (ps === 'no-docker') return { kind: 'no-docker' };
  if (ps.code !== 0) return { kind: 'failed', detail: `\`docker compose ps\` failed: ${lastLine(ps.stderr) || `exit ${ps.code}`}` };
  return answer(ps.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
}

/** Why an answer that is not `services` names no app (the line a refusal prints; `no-docker` is the caller's own). */
export function composeDetail(answer: Extract<ComposeAnswer, { kind: 'companions' | 'unlabelled' | 'failed' }>): string {
  return answer.kind === 'companions' ? 'its docker-compose.yml runs companion services and no app service' : answer.detail;
}

/**
 * The compose arguments that start ONE companion service — and nothing else:
 * `--no-deps`, one named service, so the app's service is never started by it.
 * The one spelling `update` and `neuralis up` both run.
 */
export function companionUpArgs(service: string): string[] {
  return ['up', '-d', '--no-deps', service];
}

export type CompanionStart = { ok: true; service: string; started: boolean } | { ok: false; reason: string };

/**
 * Start the `kind` companion of the compose stack in `dir` when it is not
 * running (`neuralis up` on the desktop app's host — its Qdrant and its Ollama
 * — and the vector copy that stopped it): the service by its `neuralis.kind`
 * label, in the folder with `-p <project>` and no `-f`, through
 * `companionUpArgs`. THE one starter: a second companion is a label, never a
 * second starter.
 */
export async function ensureCompanion(dir: string, kind: CompanionKind, exec: DockerExec = dockerExec): Promise<CompanionStart> {
  const stack = await readComposeStack(dir, exec);
  if (stack.kind === 'no-docker') return { ok: false, reason: 'no Docker CLI on this machine' };
  if (stack.kind === 'failed' || stack.kind === 'unlabelled') return { ok: false, reason: composeDetail(stack) };
  const service = kind === 'vectorstore' ? stack.vectorstore : stack.kind === 'companions' ? stack.embeddings : null;
  if (!service) return { ok: false, reason: `${dir}/docker-compose.yml labels no \`neuralis.kind: ${kind}\` service` };
  if (stack.running.includes(service)) return { ok: true, service, started: false };
  let res: ExecResult;
  try {
    res = await exec(['compose', '-p', stack.project, ...companionUpArgs(service)], dir);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (res.code !== 0) return { ok: false, reason: `\`docker compose up -d ${service}\` failed: ${lastLine(res.stderr) || `exit ${res.code}`}` };
  return { ok: true, service, started: true };
}

/** The compose arguments that stop ONE companion — `stop` (never `down`: the volume and the container stay). */
export function companionStopArgs(service: string): string[] {
  return ['stop', '-t', '10', service];
}

export type CompanionStop = { ok: true; service: string; stopped: boolean } | { ok: false; reason: string };

/**
 * Stop the `kind` companion `ensureCompanion` started — the desktop app's OWN
 * only: the stack in `dir` must carry companions and no app service (the
 * compose file `setup --native` writes beside the home's `.env`). A stack that
 * runs an app — a Docker install's, whose Qdrant its app shares — is refused,
 * never stopped. `stop`, never `down`; nothing when it is not running or the
 * stack has no such companion.
 */
export async function stopCompanion(dir: string, kind: CompanionKind, exec: DockerExec = dockerExec): Promise<CompanionStop> {
  const stack = await readComposeStack(dir, exec);
  if (stack.kind === 'no-docker') return { ok: false, reason: 'no Docker CLI on this machine' };
  if (stack.kind === 'services') return { ok: false, reason: `${dir}/docker-compose.yml runs an app service too — its companions are not this app's to stop` };
  if (stack.kind === 'failed' || stack.kind === 'unlabelled') return { ok: false, reason: composeDetail(stack) };
  const service = stack[kind];
  if (!service) return { ok: true, service: '', stopped: false };
  if (!stack.running.includes(service)) return { ok: true, service, stopped: false };
  let res: ExecResult;
  try {
    res = await exec(['compose', '-p', stack.project, ...companionStopArgs(service)], dir);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
  if (res.code !== 0) return { ok: false, reason: `\`docker compose stop ${service}\` failed: ${lastLine(res.stderr) || `exit ${res.code}`}` };
  return { ok: true, service, stopped: true };
}

function lastLine(text: string): string {
  return text.trim().split('\n').at(-1) ?? '';
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Parse `sha256sum` output (`<hex>  <path>`) into the hex, or null. */
export function parseSha256sum(out: string): string | null {
  const m = /^([0-9a-f]{64})\s/m.exec(out);
  return m ? m[1]! : null;
}
