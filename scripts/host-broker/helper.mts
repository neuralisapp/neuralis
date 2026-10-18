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

/** Parse `sha256sum` output (`<hex>  <path>`) into the hex, or null. */
export function parseSha256sum(out: string): string | null {
  const m = /^([0-9a-f]{64})\s/m.exec(out);
  return m ? m[1]! : null;
}
