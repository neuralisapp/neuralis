/**
 * The stack half of `neuralis update --apply` on an npm install folder: once
 * the code and the image tags have moved, the same command regenerates compose,
 * stops THIS install's app, raises the stored data formats, recreates the
 * stack and waits for the health answer — and stops at the first step that
 * fails, writing nothing further.
 *
 * What it acts on is read from the install folder, never assumed: the compose
 * project from `.env` NEURALIS_COMPOSE_PROJECT (the name setup records and
 * preserves), the app and the vector store from the regenerated compose file's
 * `neuralis.kind` service labels, and the health port from `.env`
 * NEURALIS_APP_PORT. Every compose call runs in the install folder with no
 * `-f`: a `-f` makes Compose skip `docker-compose.override.yml`, and the stack
 * would come up without its mounts. The vector store is never stopped — the
 * data-format upgrade reads it — and is started when it is down.
 *
 * Every process and probe goes through `StackPorts`, so the whole sequence is
 * unit-tested with a fake runner and no Docker.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { readComposeStack, type ComposeStack, type DockerExec, type ExecResult } from '../host-broker/helper.mts';
import { checkpointFromUpgradeOutput } from '../upgrade.mts';

export type { ComposeStack, ExecResult };

export type HealthAnswer =
  | { kind: 'ready' }
  /** The build refused to start; `code` is the health route's closed-set class (`upgrade_required`, …). */
  | { kind: 'refused'; code: string }
  | { kind: 'starting'; detail: string }
  | { kind: 'absent' };

export type StackPorts = {
  /** One command in `cwd`; `tee` streams its stdout to the operator while capturing it. */
  exec(cmd: string, args: readonly string[], opts: { cwd: string; tee: boolean }): Promise<ExecResult>;
  health(url: string): Promise<HealthAnswer>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
};

export type StepName = 'compose' | 'stop' | 'vector store' | 'upgrade' | 'recreate' | 'health';

export type ApplyOutcome =
  | { ok: true; checkpoint: string | null; done: StepName[]; seconds: number }
  /** `stack` is the regenerated compose's, once it could be read — what the commands left to run act on. */
  | { ok: false; step: StepName; reason: string; checkpoint: string | null; done: StepName[]; stack: ComposeStack | null };

/** The health route answers within this after a recreate, or the update stops and says so. */
export const HEALTH_TIMEOUT_MS = 300_000;
export const HEALTH_POLL_MS = 2_000;

/**
 * Before anything moves: an app that answers on its port while no compose
 * service of this folder runs it is a process outside compose (a native run).
 * Stopping the stack would not stop it, so the update refuses and names it.
 */
export async function outsideComposeRefusal(stack: ComposeStack, appPort: number, ports: Pick<StackPorts, 'health'>): Promise<string | null> {
  if (stack.running.includes(stack.app)) return null;
  const answer = await ports.health(healthUrl(appPort));
  if (answer.kind === 'absent') return null;
  return `the app answers on port ${appPort}, but this folder's compose project ${stack.project} runs no ${stack.app} service — a process outside compose (a native run) serves it`;
}

export function healthUrl(appPort: number): string {
  return `http://127.0.0.1:${appPort}/api/health`;
}

/** The stack as the ONE reader (`host-broker/helper.mts` `readComposeStack`) reports it; a string is why it cannot be read. */
export async function stackOf(installDir: string, ports: Pick<StackPorts, 'exec'>): Promise<ComposeStack | string> {
  const exec: DockerExec = (args, cwd) => ports.exec('docker', args, { cwd, tee: false });
  const answer = await readComposeStack(installDir, exec);
  if (answer.kind === 'services') return { project: answer.project, app: answer.app, vectorstore: answer.vectorstore, running: answer.running };
  return answer.kind === 'no-docker' ? 'no Docker CLI on this machine' : answer.detail;
}

/** The commands the sequence runs, in order — the dry run prints them, the apply runs them. */
export function stackCommands(input: { stack: ComposeStack | null; project: string; recreate: 'up' | 'rebuild'; spellVerb: (verb: string) => string }): string[] {
  const app = input.stack?.app ?? '<app service>';
  return [
    input.spellVerb('setup --compose-only'),
    `docker compose -p ${input.project} stop ${app}   (only when it runs)`,
    ...(input.stack?.vectorstore ? [`docker compose -p ${input.project} up -d ${input.stack.vectorstore}   (only when it is not running)`] : []),
    input.spellVerb('upgrade --apply'),
    input.recreate === 'rebuild' ? input.spellVerb('rebuild') : `docker compose -p ${input.project} up -d -V`,
    'wait for /api/health',
  ];
}

/** The whole sequence. Each step runs only when every step before it succeeded. */
export async function applyStack(
  input: { installDir: string; packageDir: string; project: string; appPort: number; recreate: 'up' | 'rebuild' },
  ports: StackPorts,
): Promise<ApplyOutcome> {
  const done: StepName[] = [];
  let checkpoint: string | null = null;
  let read: ComposeStack | null = null;
  const stop = (step: StepName, reason: string): ApplyOutcome => ({ ok: false, step, reason, checkpoint, done, stack: read });
  const cwd = input.installDir;
  const bin = join(input.packageDir, 'bin', 'neuralis.mjs');
  const neuralis = (verb: string[], tee = true): Promise<ExecResult> => ports.exec(process.execPath, [bin, ...verb], { cwd, tee }).catch(spawnFailure);
  const compose = (args: string[], tee = true): Promise<ExecResult> => ports.exec('docker', ['compose', '-p', input.project, ...args], { cwd, tee }).catch(spawnFailure);

  ports.log('regenerating docker-compose.yml …');
  const setup = await neuralis(['setup', '--compose-only']);
  if (setup.code !== 0) return stop('compose', `setup --compose-only exited ${setup.code}`);
  const stack = await stackOf(cwd, ports);
  if (typeof stack === 'string') return stop('compose', stack);
  read = stack;
  done.push('compose');

  if (stack.running.includes(stack.app)) {
    ports.log(`stopping ${stack.app} (compose project ${stack.project}) …`);
    const stopped = await compose(['stop', stack.app]);
    if (stopped.code !== 0) return stop('stop', `docker compose stop ${stack.app} exited ${stopped.code}`);
  } else {
    ports.log(`${stack.app} is not running — nothing to stop`);
  }
  done.push('stop');

  if (stack.vectorstore && !stack.running.includes(stack.vectorstore)) {
    ports.log(`starting ${stack.vectorstore} — the upgrade reads the vector store …`);
    const started = await compose(['up', '-d', stack.vectorstore]);
    if (started.code !== 0) return stop('vector store', `docker compose up -d ${stack.vectorstore} exited ${started.code}`);
  }
  done.push('vector store');

  ports.log('raising the stored data formats …');
  const upgrade = await neuralis(['upgrade', '--apply']);
  checkpoint = checkpointFromUpgradeOutput(upgrade.stdout);
  if (upgrade.code !== 0) return stop('upgrade', `upgrade --apply exited ${upgrade.code}`);
  done.push('upgrade');

  ports.log(input.recreate === 'rebuild' ? 'building this install\'s derived image and recreating …' : 'recreating the stack …');
  const recreated = input.recreate === 'rebuild' ? await neuralis(['rebuild']) : await compose(['up', '-d', '-V']);
  if (recreated.code !== 0) return stop('recreate', `${input.recreate === 'rebuild' ? 'rebuild' : 'docker compose up -d -V'} exited ${recreated.code}`);
  done.push('recreate');

  const url = healthUrl(input.appPort);
  ports.log(`waiting for ${url} …`);
  const started = ports.now();
  let last: HealthAnswer = { kind: 'absent' };
  for (;;) {
    last = await ports.health(url);
    if (last.kind === 'ready') {
      done.push('health');
      return { ok: true, checkpoint, done, seconds: Math.round((ports.now() - started) / 1000) };
    }
    if (last.kind === 'refused') return stop('health', `the new build refuses to start: ${last.code} (\`docker compose -p ${stack.project} logs ${stack.app}\` names the reason)`);
    if (ports.now() - started >= HEALTH_TIMEOUT_MS) {
      return stop('health', `no ready answer within ${HEALTH_TIMEOUT_MS / 1000} s (last: ${last.kind === 'starting' ? last.detail : 'nothing listens'})`);
    }
    await ports.sleep(HEALTH_POLL_MS);
  }
}

function spawnFailure(err: unknown): ExecResult {
  return { code: 127, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
}

/** The real ports: child processes in the install folder and one bounded HTTP probe. */
export const PROCESS_PORTS: StackPorts = {
  exec(cmd, args, opts) {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, [...args], { cwd: opts.cwd, stdio: ['inherit', 'pipe', opts.tee ? 'inherit' : 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (opts.tee) process.stdout.write(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  },
  async health(url) {
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(HEALTH_POLL_MS), redirect: 'manual' });
    } catch (err) {
      const code = (err as { cause?: { code?: unknown } }).cause?.code;
      return code === 'ECONNREFUSED' || code === 'ECONNRESET' ? { kind: 'absent' } : { kind: 'starting', detail: typeof code === 'string' ? code : 'no answer' };
    }
    const body = (await response.json().catch(() => null)) as { status?: unknown; code?: unknown; phase?: unknown } | null;
    if (response.status === 200 && body?.status === 'ready') return { kind: 'ready' };
    if (body?.status === 'error') return { kind: 'refused', code: typeof body.code === 'string' ? body.code : 'bootstrap_failed' };
    return { kind: 'starting', detail: `HTTP ${response.status}${typeof body?.status === 'string' ? ` ${body.status}` : ''}${typeof body?.phase === 'string' ? ` (${body.phase})` : ''}` };
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  log: (line) => console.log(`  · ${line}`),
};
