/**
 * The stack half of `neuralis update --apply` on an npm install folder or an
 * image-only folder: once
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
 * unit-tested with a fake runner and no Docker. An image-only folder runs the
 * sequence in a one-shot container of the image: `IMAGE_PORTS` asks the app's
 * own `/api/health` through `docker compose exec`, and the upgrade runs as
 * `docker compose run` of the app service (its network reaches the vector
 * store; this container's loopback is its own).
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';

import { companionUpArgs, composeDetail, readComposeStack, type ComposeStack, type DockerExec, type ExecResult } from '../host-broker/helper.mts';
import { checkpointFromUpgradeOutput, upgradeRaisedNothing, upgradeResumed } from '../upgrade.mts';
import { composeRunArgs } from '../cli/registry.mts';

export type { ComposeStack, ExecResult };

export type HealthAnswer =
  /** `degraded`: the app serves while a package reports a partial state (a vector store not reachable yet). */
  | { kind: 'ready'; degraded?: true }
  /** The build refused to start; `code` is the health route's closed-set class (`upgrade_required`, …). */
  | { kind: 'refused'; code: string }
  | { kind: 'starting'; detail: string }
  | { kind: 'absent' };

/** Where the app answers: its published URL, and its compose service (an image-only folder asks through `exec`). */
export type HealthTarget = { url: string; cwd: string; project: string; app: string };

export type StackPorts = {
  /** One command in `cwd`; `tee` streams its stdout to the operator while capturing it. */
  exec(cmd: string, args: readonly string[], opts: { cwd: string; tee: boolean }): Promise<ExecResult>;
  health(target: HealthTarget): Promise<HealthAnswer>;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(line: string): void;
};

export type StepName = 'compose' | 'stop' | 'vector store' | 'upgrade' | 'recreate' | 'health';

/**
 * `regenerated`: the compose file was rewritten (it may be before the `compose`
 * step itself completes — the read that follows can still fail).
 * `upgradeRan`: on a stop, the upgrade step was started and may have written (a checkpoint, or
 * its absence, means something; false: it stopped before its checkpoint, outside a resumed run, so
 * nothing was written); on success,
 * it raised a data format (false: it answered "nothing to upgrade").
 */
export type ApplyOutcome =
  | { ok: true; checkpoint: string | null; done: StepName[]; seconds: number; app: string; regenerated: true; upgradeRan: boolean }
  /** `stack` is the regenerated compose's, once it could be read — what the commands left to run act on. */
  | { ok: false; step: StepName; reason: string; checkpoint: string | null; done: StepName[]; stack: ComposeStack | null; regenerated: boolean; upgradeRan: boolean };

/** The health route answers within this after a recreate, or the update stops and says so. */
export const HEALTH_TIMEOUT_MS = 300_000;
export const HEALTH_POLL_MS = 2_000;

/**
 * Before anything moves: an app that answers on its port while no compose
 * service of this folder runs it is a process outside compose (a native run).
 * Stopping the stack would not stop it, so the update refuses and names it.
 */
export async function outsideComposeRefusal(stack: ComposeStack, appPort: number, ports: Pick<StackPorts, 'health'>, cwd: string): Promise<string | null> {
  if (stack.running.includes(stack.app)) return null;
  const answer = await ports.health({ url: healthUrl(appPort), cwd, project: stack.project, app: stack.app });
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
  return answer.kind === 'no-docker' ? 'no Docker CLI on this machine' : composeDetail(answer);
}

/** The commands the sequence runs, in order — the dry run prints them, the apply runs them. */
export function stackCommands(input: { stack: ComposeStack | null; project: string; recreate: 'up' | 'rebuild'; spellVerb: (verb: string) => string }): string[] {
  const app = input.stack?.app ?? '<app service>';
  return [
    input.spellVerb('setup --compose-only'),
    `docker compose -p ${input.project} stop ${app}   (only when it runs)`,
    ...(input.stack?.vectorstore ? [`docker compose -p ${input.project} ${companionUpArgs(input.stack.vectorstore).join(' ')}   (only when it is not running)`] : []),
    input.spellVerb('upgrade --apply'),
    input.recreate === 'rebuild' ? input.spellVerb('rebuild') : `docker compose -p ${input.project} up -d -V`,
    'wait for /api/health',
  ];
}

/**
 * The whole sequence. Each step runs only when every step before it succeeded.
 * `plane: 'image'` (an image-only folder, run in a one-shot container) runs
 * the upgrade as `docker compose run -T` of the app service — `-T` because its
 * output is parsed for the checkpoint id — and asks the app's health inside
 * the stack, never on the host's loopback.
 */
export async function applyStack(
  input: {
    installDir: string; packageDir: string; project: string; appPort: number; recreate: 'up' | 'rebuild'; plane: 'host' | 'image';
    /** Extra `-v` pairs of the image plane's `upgrade` run (`upgradeDeviceBinds`). */
    upgradeBinds?: readonly string[];
    /** The compose regeneration as another command (a target image's own-tree `setup --compose-only --output`); default this code's. */
    regenerate?: { file: string; args: readonly string[] };
  },
  ports: StackPorts,
): Promise<ApplyOutcome> {
  const done: StepName[] = [];
  let checkpoint: string | null = null;
  let read: ComposeStack | null = null;
  let regenerated = false;
  let upgradeRan = false;
  const stop = (step: StepName, reason: string): ApplyOutcome => ({ ok: false, step, reason, checkpoint, done, stack: read, regenerated, upgradeRan });
  const cwd = input.installDir;
  const bin = join(input.packageDir, 'bin', 'neuralis.mjs');
  const neuralis = (verb: string[], tee = true): Promise<ExecResult> => ports.exec(process.execPath, [bin, ...verb], { cwd, tee }).catch(spawnFailure);
  const compose = (args: string[], tee = true): Promise<ExecResult> => ports.exec('docker', ['compose', '-p', input.project, ...args], { cwd, tee }).catch(spawnFailure);

  ports.log('regenerating docker-compose.yml …');
  const setup = input.regenerate
    ? await ports.exec(input.regenerate.file, input.regenerate.args, { cwd, tee: true }).catch(spawnFailure)
    : await neuralis(['setup', '--compose-only']);
  if (setup.code !== 0) return stop('compose', `setup --compose-only exited ${setup.code}`);
  regenerated = true;
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
    const started = await compose(companionUpArgs(stack.vectorstore));
    if (started.code !== 0) return stop('vector store', `docker compose up -d ${stack.vectorstore} exited ${started.code}`);
  }
  done.push('vector store');

  ports.log('raising the stored data formats …');
  upgradeRan = true;
  const upgrade = input.plane === 'image'
    ? await ports.exec('docker', composeRunArgs({ project: input.project, app: stack.app }, 'upgrade', ['--apply'], { tty: false, operator: undefined, binds: input.upgradeBinds ?? [] }), { cwd, tee: true }).catch(spawnFailure)
    : await neuralis(['upgrade', '--apply']);
  checkpoint = checkpointFromUpgradeOutput(upgrade.stdout);
  if (upgrade.code !== 0) {
    // Data may have moved only after a checkpoint or inside a resumed run; any earlier stop wrote nothing.
    upgradeRan = checkpoint !== null || upgradeResumed(upgrade.stdout);
    return stop('upgrade', `upgrade --apply exited ${upgrade.code}`);
  }
  upgradeRan = !upgradeRaisedNothing(upgrade.stdout);
  done.push('upgrade');

  ports.log(input.recreate === 'rebuild' ? 'building this install\'s derived image and recreating …' : 'recreating the stack …');
  const recreated = input.recreate === 'rebuild' ? await neuralis(['rebuild']) : await compose(['up', '-d', '-V']);
  if (recreated.code !== 0) return stop('recreate', `${input.recreate === 'rebuild' ? 'rebuild' : 'docker compose up -d -V'} exited ${recreated.code}`);
  done.push('recreate');

  const target: HealthTarget = { url: healthUrl(input.appPort), cwd, project: stack.project, app: stack.app };
  ports.log(`waiting for ${input.plane === 'image' ? `/api/health inside the ${stack.app} service` : target.url} …`);
  const started = ports.now();
  let last: HealthAnswer = { kind: 'absent' };
  for (;;) {
    last = await ports.health(target);
    if (last.kind === 'ready') {
      if (last.degraded) ports.log('the app serves, and a package reports degraded health (a vector store that is not reachable yet, for one) — Admin health names which');
      done.push('health');
      return { ok: true, checkpoint, done, seconds: Math.round((ports.now() - started) / 1000), app: stack.app, regenerated: true, upgradeRan };
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

/** The health route's answer, read the same way through HTTP or through `compose exec`. */
function healthOf(status: number, body: { status?: unknown; code?: unknown; phase?: unknown } | null): HealthAnswer {
  if (status === 200 && body?.status === 'ready') return { kind: 'ready' };
  if (status === 200 && body?.status === 'degraded') return { kind: 'ready', degraded: true };
  if (body?.status === 'error') return { kind: 'refused', code: typeof body.code === 'string' ? body.code : 'bootstrap_failed' };
  return { kind: 'starting', detail: `HTTP ${status}${typeof body?.status === 'string' ? ` ${body.status}` : ''}${typeof body?.phase === 'string' ? ` (${body.phase})` : ''}` };
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
  async health({ url }) {
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(HEALTH_POLL_MS), redirect: 'manual' });
    } catch (err) {
      const code = (err as { cause?: { code?: unknown } }).cause?.code;
      return code === 'ECONNREFUSED' || code === 'ECONNRESET' ? { kind: 'absent' } : { kind: 'starting', detail: typeof code === 'string' ? code : 'no answer' };
    }
    return healthOf(response.status, (await response.json().catch(() => null)) as Parameters<typeof healthOf>[1]);
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  log: (line) => console.log(`  · ${line}`),
};

/**
 * Inside the app container: one fetch of its own `/api/health` on :3100, the
 * status and the body on one line (a 503 body carries the closed-set `code`).
 */
const IN_APP_HEALTH = "fetch('http://127.0.0.1:3100/api/health',{signal:AbortSignal.timeout(2000),redirect:'manual'})" +
  ".then(async(r)=>process.stdout.write(r.status+' '+(await r.text())),(e)=>process.stdout.write('0 '+String(e?.cause?.code??e?.name)))";

/** An image-only folder's ports: the app's health through `docker compose exec` (one spawn per poll). */
export const IMAGE_PORTS: StackPorts = {
  ...PROCESS_PORTS,
  async health({ cwd, project, app }) {
    const answer = await PROCESS_PORTS.exec('docker', ['compose', '-p', project, 'exec', '-T', app, 'node', '-e', IN_APP_HEALTH], { cwd, tee: false }).catch(spawnFailure);
    // A container that is not running (yet), or a restart in progress: not an answer.
    if (answer.code !== 0) return { kind: 'starting', detail: answer.stderr.trim().split('\n').at(-1) || `exec exited ${answer.code}` };
    const space = answer.stdout.indexOf(' ');
    const status = Number(answer.stdout.slice(0, space));
    const rest = answer.stdout.slice(space + 1);
    if (!(status > 0)) return { kind: 'starting', detail: rest || 'no answer' };
    let body: Parameters<typeof healthOf>[1] = null;
    try {
      body = JSON.parse(rest) as Parameters<typeof healthOf>[1];
    } catch {
      // not JSON: the status alone decides
    }
    return healthOf(status, body);
  },
};
