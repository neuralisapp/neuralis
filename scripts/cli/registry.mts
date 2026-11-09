/**
 * The ONE `neuralis` command registry: verb → module, and the ONE thrown-error →
 * exit-code boundary. `bin/neuralis.mjs` (`npx neuralis <verb>` in an install
 * folder) and the monorepo's `pnpm neuralis:<verb>` aliases both enter here, so
 * there is no second dispatch path that could skip the resolvers or the boundary.
 *
 * Three directories, read once and handed to every module through the context:
 *
 *   packageDir  the code — the folder that holds `bin/`, `scripts/`, `src/` and
 *               the host `package.json`; on an npm install folder it is
 *               `node_modules/neuralis`.
 *   installDir  the deployment — `.env`, the compose files, the operator's
 *               package list. LAZY: resolved on the first read by the kernel's
 *               `locateInstall` (`--install <dir>`, else the walk up from the
 *               working directory, else the data home's install record) — the
 *               host package itself, an npm install folder, an image-only
 *               folder, or the desktop app's bundle (whose `.env` the setup
 *               module's `resolveConfigDir` finds in the data home); none ⇒ the
 *               read throws a refusal. A verb that never reads it runs anywhere.
 *   cwd         where the operator typed the command (`INIT_CWD` under npm/pnpm),
 *               the base of every relative path argument.
 *
 * Modules never call `process.exit`: `run` returns the exit code or throws a
 * `CliExit`, and `main` prints it. Verb modules load lazily, so a command pays
 * only for its own import graph.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  detectDocker,
  IMAGE_HOST_BIN,
  imageHandoff,
  installKindOf,
  locateInstall,
  locateRefusal,
  predatesImageKind,
  readImageTag,
  resolveNeuralisHome,
  takeInstallFlag,
} from '@neuralis/package-system/paths';

/** The code folder (`bin/..`), from this file's own location — the one place a module derives one. */
export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The published host image; an image-only folder's `.env` NEURALIS_IMAGE_TAG names its tag. */
export const HOST_IMAGE = 'neuralisapp/neuralis';

/** Everything a command needs — fully injectable for tests. */
export interface CliContext {
  /** The code folder (`bin/..`). */
  readonly packageDir: string;
  /** The deployment folder; reading it outside one throws a `CliExit`. */
  readonly installDir: string;
  /** The folder the command was typed in (relative path arguments resolve here). */
  readonly cwd: string;
  /** Raw stdout writer (no implicit newline). */
  readonly stdout: (text: string) => void;
  /** Raw stderr writer (no implicit newline). */
  readonly stderr: (text: string) => void;
  /** Environment snapshot. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Interactive input (setup's wizard, the restore confirmations). */
  readonly stdin: NodeJS.ReadableStream;
}

/**
 * One CLI command. `run` returns the process exit code — it never calls
 * process.exit itself.
 */
export interface CommandModule {
  /** Command name (`search`, …) or publisher subcommand name (`login`, …). */
  readonly name: string;
  /** Set for `publisher <sub>` group members. */
  readonly group?: 'publisher';
  /** One-line description for help output. */
  readonly summary: string;
  /** Usage line, e.g. `neuralweb download <ref> [--out <path>]`. */
  readonly usage: string;
  readonly run: (argv: string[], ctx: CliContext) => Promise<number>;
  /** How the verb runs on an image-only install folder (`imageRoute`). */
  readonly image?: VerbOptions;
}

/** A refusal or failure with its exit code; the boundary prints `message` and every `detail` line. */
export class CliExit extends Error {
  readonly code: number;
  readonly detail: readonly string[];
  constructor(code: number, message: string, detail: readonly string[] = []) {
    super(message);
    this.name = 'CliExit';
    this.code = code;
    this.detail = detail;
  }
}

/** THE single thrown-error → exit-code boundary. */
export function exitCodeFor(error: unknown, ctx: Pick<CliContext, 'stderr'>): number {
  if (error instanceof CliExit) {
    ctx.stderr(`\n  ✗ ${error.message}\n`);
    for (const line of error.detail) ctx.stderr(`    ${line}\n`);
    ctx.stderr('\n');
    return error.code;
  }
  ctx.stderr(`\n  ✗ ${error instanceof Error ? error.message : String(error)}\n\n`);
  return 1;
}

/** A verb whose implementation is the `run` export of one script, loaded on dispatch. */
type ScriptModule = { run: (argv: string[], ctx: CliContext) => Promise<number> };

/**
 * How a verb runs on an image-only install folder: `oneshot` in a container of
 * the folder's image with the standard mounts (this process, when it already is
 * one), `compose` as `docker compose run` of the folder's app service (its
 * network, env and binds), `refuse` by name.
 */
export type OnImage = 'oneshot' | 'compose' | 'refuse';

export type VerbOptions = {
  onImage: OnImage | ((argv: readonly string[]) => OnImage);
  /** Bind the data home's parent at its host path (every path the verb writes is a host path). */
  homeParent?: true;
  prefix?: readonly string[];
};

function verb(name: string, summary: string, usage: string, load: () => Promise<ScriptModule>, opts: VerbOptions): CommandModule {
  const command: CommandModule = {
    name,
    summary,
    usage,
    image: opts,
    run: async (argv, ctx) => {
      const route = imageRoute(command, argv, ctx);
      if (route.run === 'compose') return composeRun(name, argv, ctx, ctx.installDir);
      if (route.run === 'handoff') return runInImage(name, argv, ctx, ctx.installDir, route.homeParent);
      return (await load()).run([...(opts.prefix ?? []), ...argv], ctx);
    },
  };
  return command;
}

/** The operator verbs — one thin adapter each over the script that owns the work. */
export const OPS_COMMANDS: readonly CommandModule[] = [
  verb('setup', 'Install wizard: data directories, .env, the compose file', 'neuralis setup [--advanced] [--compose-only] [--output <dir>] [--help]', () => import('../setup.mts'), { onImage: 'oneshot' }),
  verb('rebuild', 'Rebuild the image (an install folder: its derived image) and recreate the stack', 'neuralis rebuild [--no-sidecar]', () => import('../rebuild.mts'), { onImage: 'refuse' }),
  verb('sync', 'Swap a package into the running container without a rebuild', 'neuralis sync [status | <package> | --all] [--dry-run] [--no-restart] [--json]', () => import('../sync.mts'), { onImage: 'refuse' }),
  verb('update', 'Move this install to a published release line (the `neuralis` client updates itself first)', 'neuralis update [<package>] [--version <x> | --manifest <https url|file>] [--apply] [--json]', () => import('../update.mts'), { onImage: 'oneshot' }),
  verb('upgrade', 'Raise the stored data formats a release needs (app stopped)', 'neuralis upgrade [--dry-run | --apply]', () => import('../upgrade.mts'), { onImage: 'compose' }),
  verb('mount', 'Expose a host folder to the container', 'neuralis mount <add|list|remove> …', () => import('../mount.mts'), { onImage: 'oneshot' }),
  verb('pkg', 'Build a package into the host image (then rebuild) — `neuralis package` installs one while the host runs', 'neuralis pkg <list|add|remove> …', () => import('../pkg.mts'), { onImage: 'refuse' }),
  verb('user', 'Recover a locked-out account', 'neuralis user <list|enable|reset-password> [<email>]', () => import('../user.mts'), { onImage: 'compose' }),
  verb('checkpoint', 'List or restore control-plane checkpoints', 'neuralis checkpoint <list | restore <id>>', () => import('../checkpoint.mts'), { onImage: (argv) => (argv[0] === 'restore' ? 'compose' : 'oneshot') }),
  verb('backup', 'Back up the whole install', 'neuralis backup [--out <dir>] [--include-volume <name>] | backup list', () => import('../backup.mts'), { onImage: 'oneshot', homeParent: true }),
  verb('restore', 'Restore a whole-install backup (app stopped)', 'neuralis restore <dir> [--home <dir> --volume <name>]', () => import('../backup.mts'), { onImage: 'oneshot', homeParent: true, prefix: ['restore'] }),
  verb('qdrant-upgrade', 'Upgrade the Qdrant engine one minor at a time', 'neuralis qdrant-upgrade [--dry-run | --rehearse <volume> | --rollback <dir>]', () => import('../qdrant-upgrade.mts'), { onImage: 'oneshot' }),
  verb('reset-vector', 'Drop the vector collections and the embedding lock', 'neuralis reset-vector', () => import('../reset-vector.mts'), { onImage: 'compose' }),
  verb('convert', 'Turn a 0.1.0 unpacked install folder into an npm project (one-shot, app stopped)', 'neuralis convert --from <old version> | --rollback <checkpoint id>', () => import('../convert.mts'), { onImage: 'refuse' }),
  verb('up', 'Start the desktop app\'s host (Qdrant, the app, the sandbox origin) and supervise it', 'neuralis up [--foreground]', () => import('../up.mts'), { onImage: 'refuse', prefix: ['up'] }),
  verb('down', 'Stop the host that holds this data home', 'neuralis down', () => import('../up.mts'), { onImage: 'refuse', prefix: ['down'] }),
  verb('status', 'What runs on this data home: stopped, starting, ready, restarting or failed', 'neuralis status [--json]', () => import('../up.mts'), { onImage: 'refuse', prefix: ['status'] }),
  verb('start', 'Start a source clone\'s app natively, on the port its .env names', 'neuralis start', () => import('../start.mts'), { onImage: 'refuse' }),
  // Image-only: in the one-shot container with the data home at its host path, so the `cloudflared` image it runs
  // through the Docker socket mounts the tunnel folder by that path; the connector itself is a compose service.
  verb('tunnel', 'Reach this host from anywhere: a Cloudflare named tunnel (app., mcp., sandbox.DOMAIN)', 'neuralis tunnel [on <domain> [--access <email|@domain>] | off]', () => import('../tunnel.mts'), { onImage: 'oneshot', homeParent: true }),
];

/** Where a verb runs: here, as `docker compose run` of the app service, or handed to a one-shot container. */
export type ImageRoute = { run: 'here' } | { run: 'compose' } | { run: 'handoff'; homeParent: boolean };

/**
 * The image gate. `here` unless the install is an image-only folder; there a
 * `refuse` verb throws by name, a `compose` verb inside a container runs as
 * `docker compose run`, and every other verb runs here only inside a container
 * that already carries what it needs (the data home's parent at its host path,
 * for `homeParent`) — else it is handed to a one-shot container of the folder's
 * image, which reaches this gate again from inside.
 */
export function imageRoute(command: Pick<CommandModule, 'name' | 'image'>, argv: readonly string[], ctx: CliContext): ImageRoute {
  let installDir: string;
  try {
    installDir = ctx.installDir;
  } catch {
    return { run: 'here' }; // outside an install folder the verb's own refusal (or its --help) answers
  }
  if (!command.image || installKindOf(installDir) !== 'image') return { run: 'here' };
  const opts = command.image;
  const mode = typeof opts.onImage === 'function' ? opts.onImage(argv) : opts.onImage;
  if (mode === 'refuse') throw imageRefusal(command.name);
  const inContainer = detectDocker(ctx.env as NodeJS.ProcessEnv);
  if (inContainer && mode === 'compose') return { run: 'compose' };
  const homeBound = ctx.env.NEURALIS_HOME !== undefined && ctx.env.NEURALIS_HOME === ctx.env.NEURALIS_HOST_HOME;
  if (inContainer && (!opts.homeParent || homeBound)) return { run: 'here' };
  return { run: 'handoff', homeParent: opts.homeParent === true };
}

function imageRefusal(name: string): CliExit {
  if (name === 'up' || name === 'down' || name === 'status') {
    return new CliExit(1, `"${name}" runs the desktop app's host, not an image-only install folder`, [
      'This folder runs with Docker Compose: `docker compose up -d` · `docker compose down` · `docker compose ps`, in the folder.',
    ]);
  }
  if (name === 'convert') {
    return new CliExit(1, '"convert" does not run on an image-only install folder', ['It runs the published image as it is: there is nothing to convert.']);
  }
  return new CliExit(1, `"${name}" does not run on an image-only install folder`, [
    'It runs the published image as it is: there is no package list to build, sync or register packages into.',
    'A package joins this kind of install while it runs: `neuralis package install <name>` (the Neuralis client), applied at the next restart.',
    'Restart on the image: `docker compose up -d -V` in the folder · move to another release: `neuralis update --apply`.',
  ]);
}

/** One child with the terminal, signals forwarded; its exit code (or 128 + signal) is the answer. */
function inherit(file: string, args: readonly string[], cwd: string, what: string): Promise<number> {
  return new Promise<number>((resolveExit, reject) => {
    const child = spawn(file, [...args], { cwd, stdio: 'inherit' });
    const forward = (signal: NodeJS.Signals) => () => { child.kill(signal); };
    const onInt = forward('SIGINT');
    const onTerm = forward('SIGTERM');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    const done = () => { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); };
    child.on('error', (err) => { done(); reject(new CliExit(1, `cannot start ${what}: ${err.message}`)); });
    child.on('exit', (code, signal) => { done(); resolveExit(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)); });
  });
}

/**
 * `docker` argv of a one-shot container of `image` for the install folder (the
 * kernel's `imageHandoff`: the standard mounts as this machine names them, the
 * folder as working directory). The ONE builder for every handoff here: a verb
 * into the folder's image, `update` into the target image.
 */
export function imageRunCommand(ctx: CliContext, input: { installDir: string; image: string; homeParent: boolean; env: ReadonlyArray<readonly [string, string]>; command: readonly string[]; workdir?: string | null }): string[] {
  const handoff = imageHandoff({
    env: ctx.env,
    cwd: ctx.cwd,
    stdinTty: (ctx.stdin as NodeJS.ReadStream).isTTY === true,
    installDir: input.installDir,
    image: input.image,
    homeParent: input.homeParent,
    extraEnv: input.env,
    command: input.command,
    ...(input.workdir !== undefined ? { workdir: input.workdir } : {}),
  });
  if (!handoff.ok) throw new CliExit(1, `cannot start ${input.image}: ${handoff.reason}`);
  return handoff.args;
}

/**
 * The verb in a container with the standard mounts (`imageRunArgs`): the
 * folder's own image — except `update`, and every verb on a folder whose tag
 * predates the image kind, which run in THIS code's release (the folder's
 * older image cannot move itself, nor run in an image-only folder).
 */
async function runInImage(name: string, argv: readonly string[], ctx: CliContext, installDir: string, homeParent: boolean): Promise<number> {
  const folderTag = readImageTag(installDir)!;
  const own = (JSON.parse(readFileSync(join(ctx.packageDir, 'package.json'), 'utf-8')) as { version?: unknown }).version;
  const image = `${HOST_IMAGE}:${(name === 'update' || predatesImageKind(folderTag)) && typeof own === 'string' ? own : folderTag}`;
  const args = imageRunCommand(ctx, { installDir, image, homeParent, env: [], command: ['node', IMAGE_HOST_BIN, name, ...argv] });
  return inherit('docker', args, installDir, `the ${image} container`);
}

/**
 * `docker` argv of a verb run as the app service (`-T` without a terminal; the
 * operator's name passed on for the audit row). `binds` are extra `-v` pairs —
 * `upgrade` gets the device folders ({@link upgradeDeviceBinds}); the app
 * service itself never binds them.
 */
export function composeRunArgs(stack: { project: string; app: string }, name: string, argv: readonly string[], opts: { tty: boolean; operator: string | undefined; binds?: readonly string[] }): string[] {
  return [
    'compose', '-p', stack.project, 'run', '--rm', '--no-deps',
    ...(opts.tty ? [] : ['-T']),
    ...(opts.operator ? ['-e', `NEURALIS_OPERATOR=${opts.operator}`] : []),
    ...(opts.binds ?? []),
    stack.app, 'node', 'bin/neuralis.mjs', name, ...argv,
  ];
}

/**
 * The `-v` pairs an `upgrade` run of the app service needs beyond the stack's
 * own binds: the server's broker secret (`<home>/host-broker`, read-only) and
 * the WHOLE device folder (`<home>/device` — its per-host identities live
 * below it, and `source-device-v1` writes the server's device identity
 * there). The running app never binds either: they are the device's
 * credentials, so only this one-shot run sees them.
 *
 * An app-service run happens only from the one-shot container of an
 * image-only folder: `home` is the data home as that container sees it, the
 * bind sources are the HOST's paths (`NEURALIS_HOST_HOME`). Outside a
 * container, or without that variable, nothing is bound. A folder that is not
 * there is not bound — Docker would create it root-owned — except `device`,
 * made here (0700, as this user) when the broker secret exists, so the
 * identity the upgrade writes lands on the host.
 */
export function upgradeDeviceBinds(env: Readonly<Record<string, string | undefined>>, home: string): string[] {
  const hostHome = env.NEURALIS_HOST_HOME;
  if (!detectDocker(env as NodeJS.ProcessEnv) || !hostHome || !hostHome.startsWith('/')) return [];
  const binds: string[] = [];
  const broker = existsSync(join(home, 'host-broker'));
  if (broker) binds.push('-v', `${hostHome}/host-broker:/.neuralis/host-broker:ro`);
  if (broker && !existsSync(join(home, 'device'))) mkdirSync(join(home, 'device'), { recursive: true, mode: 0o700 });
  if (existsSync(join(home, 'device'))) binds.push('-v', `${hostHome}/device:/.neuralis/device`);
  return binds;
}

/** The verb as `docker compose run` of the folder's app service — the compose network, env and binds. */
async function composeRun(name: string, argv: readonly string[], ctx: CliContext, installDir: string): Promise<number> {
  const { composeDetail, readComposeStack } = await import('../host-broker/helper.mts');
  const stack = await readComposeStack(installDir, undefined, { withRunning: false });
  if (stack.kind !== 'services') {
    throw new CliExit(1, `"${name}" runs in this folder's app service, which cannot be read`, [stack.kind === 'no-docker' ? 'No Docker CLI answers here.' : composeDetail(stack)]);
  }
  const binds = name === 'upgrade' ? upgradeDeviceBinds(ctx.env, resolveNeuralisHome(ctx.env as NodeJS.ProcessEnv).home) : [];
  const args = composeRunArgs(stack, name, argv, { tty: (ctx.stdin as NodeJS.ReadStream).isTTY === true, operator: ctx.env.NEURALIS_OPERATOR, binds });
  return inherit('docker', args, installDir, `\`docker compose run ${stack.app}\``);
}

/**
 * Verbs a release moved out of this command line. Dispatching one answers where
 * the work lives now — text only: nothing is loaded, nothing is spawned.
 */
export const MOVED_VERBS: Readonly<Record<string, readonly string[]>> = {
  'host-broker': [
    'Every machine the app reaches — this server too — is a paired device now, run by the separate client.',
    'On that machine, as the user whose files and shell the app should reach (Node.js 22.22 or newer — a',
    'server that runs only Docker installs it first; the device runs on the machine, never in a container):',
    '  npm install -g @neuralis/cli',
    '  neuralis device pair      sign in once in the browser (the server: skip it after `upgrade --apply`)',
    '  neuralis device install   the login service; `--unconfined` on a machine one person uses',
    '  neuralis device status    neuralis device grant <dir> [--write] [--host <url>]    neuralis device run',
  ],
};

/**
 * Verbs of the separate Neuralis client (`@neuralis/cli`), which signs in and
 * acts as a person or an agent; the global `neuralis` forwards every operator
 * verb here. Dispatching one on this bin answers where it lives.
 */
export const CLIENT_VERBS = [
  'login', 'logout', 'whoami', 'request', 'skill', 'package', 'device', 'mcp', 'plugin', 'launch',
] as const;

/**
 * Verbs a later release adds. Dispatching one answers by name instead of
 * "unknown", so an ops verb can never squat one silently.
 */
export const RESERVED_VERBS = [
  'fs', 'agent', 'workflow', 'shells', 'git', 'source', 'connect',
] as const;

/**
 * The install a command acts on (the kernel's `locateInstall`: `explicit`, else
 * the walk up from `start`, else the records in `home`); none ⇒ a refusal naming
 * the rule (a skipped stale record is named only there).
 */
export function resolveInstallDir(start: string, home: string = resolveNeuralisHome().home, explicit: string | null = null): string {
  const found = locateInstall({ start, explicit, home });
  if (!found.ok) {
    const refusal = locateRefusal(found);
    throw new CliExit(1, refusal.message, refusal.detail);
  }
  return found.location.dir!;
}

export function createCliContext(input: {
  packageDir: string;
  cwd: string;
  /** Where the install-folder walk starts (the process working directory). */
  installFrom: string;
  env: Readonly<Record<string, string | undefined>>;
  stdin: NodeJS.ReadableStream;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** `--install <dir>`, taken off the command line. */
  explicitInstall?: string | null;
  /** The data home whose install record is the last resort (default: the env's). */
  home?: string;
}): CliContext {
  let installDir: string | null = null;
  return {
    packageDir: input.packageDir,
    get installDir(): string {
      installDir ??= resolveInstallDir(
        input.installFrom,
        input.home ?? resolveNeuralisHome(input.env as NodeJS.ProcessEnv).home,
        input.explicitInstall ?? null,
      );
      return installDir;
    },
    cwd: input.cwd,
    stdout: input.stdout,
    stderr: input.stderr,
    env: input.env,
    stdin: input.stdin,
  };
}

function renderHelp(): string {
  const width = Math.max(...OPS_COMMANDS.map((m) => m.name.length));
  return [
    'Usage: neuralis <command> [options]',
    '',
    'Commands:',
    ...OPS_COMMANDS.map((m) => `  ${m.name.padEnd(width)}  ${m.summary}`),
    '',
    `The Neuralis client (\`npm i -g @neuralis/cli\`): ${CLIENT_VERBS.join(', ')}`,
    `Reserved for a later release: ${RESERVED_VERBS.join(', ')}`,
    '',
  ].join('\n');
}

/** Dispatch one command line through the boundary. */
export async function dispatch(argv: string[], ctx: CliContext): Promise<number> {
  const [name, ...rest] = argv;
  try {
    if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
      ctx.stdout(`${renderHelp()}\n`);
      return name === undefined ? 1 : 0;
    }
    if (name === '--version' || name === '-v') {
      const manifest = JSON.parse(readFileSync(join(ctx.packageDir, 'package.json'), 'utf-8')) as { version?: unknown };
      ctx.stdout(`${String(manifest.version)}\n`);
      return 0;
    }
    if (Object.hasOwn(MOVED_VERBS, name)) {
      throw new CliExit(1, `"${name}" moved to \`neuralis device\` (@neuralis/cli)`, MOVED_VERBS[name]!);
    }
    if ((CLIENT_VERBS as readonly string[]).includes(name)) {
      throw new CliExit(1, `"${name}" is a command of the Neuralis client, not of this install folder`, ['Install it once: `npm install -g @neuralis/cli` — then `neuralis ' + name + ' …` works from anywhere, and the operator commands keep working from here.']);
    }
    if ((RESERVED_VERBS as readonly string[]).includes(name)) {
      throw new CliExit(1, `"${name}" is reserved for a later release`, ['`neuralis --help` lists the commands this release has.']);
    }
    const command = OPS_COMMANDS.find((m) => m.name === name);
    if (!command) throw new CliExit(1, `unknown command "${name}"`, ['`neuralis --help` lists the commands.']);
    return await command.run(rest, ctx);
  } catch (error) {
    return exitCodeFor(error, ctx);
  }
}

/** The process entry: the working directories are read here, once. */
export async function main(argv: string[]): Promise<number> {
  const stderr = (text: string): void => { process.stderr.write(text); };
  let taken: ReturnType<typeof takeInstallFlag>;
  try {
    taken = takeInstallFlag(argv);
  } catch (error) {
    return exitCodeFor(new CliExit(1, error instanceof Error ? error.message : String(error)), { stderr });
  }
  const ctx = createCliContext({
    packageDir: PACKAGE_DIR,
    cwd: process.env.INIT_CWD || process.cwd(),
    installFrom: process.cwd(),
    env: process.env,
    stdin: process.stdin,
    stdout: (text) => { process.stdout.write(text); },
    stderr,
    explicitInstall: taken.explicit,
  });
  return dispatch(taken.argv, ctx);
}

// The monorepo's `neuralis:*` package scripts run this file directly
// (`node --import tsx scripts/cli/registry.mts <verb>`); the bin imports `main`.
// Never a top-level await here: a verb module imports `CliExit` from this file,
// and awaiting `main` during this module's own evaluation would deadlock that cycle.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
