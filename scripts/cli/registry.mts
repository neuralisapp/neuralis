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
 *               package list. LAZY: resolved on the first read by walking up
 *               from the working directory to the host package itself (the
 *               monorepo member, a public clone, the image's `/neuralis`) or to
 *               a folder whose `package.json` depends on `neuralis`; none ⇒ the
 *               read throws a refusal. A verb that never reads it runs anywhere.
 *   cwd         where the operator typed the command (`INIT_CWD` under npm/pnpm),
 *               the base of every relative path argument.
 *
 * Modules never call `process.exit`: `run` returns the exit code or throws a
 * `CliExit`, and `main` prints it. Verb modules load lazily, so a command pays
 * only for its own import graph.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The code folder (`bin/..`), from this file's own location — the one place a module derives one. */
export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

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

function verb(name: string, summary: string, usage: string, load: () => Promise<ScriptModule>, prefix: readonly string[] = []): CommandModule {
  return { name, summary, usage, run: async (argv, ctx) => (await load()).run([...prefix, ...argv], ctx) };
}

/** The operator verbs — one thin adapter each over the script that owns the work. */
export const OPS_COMMANDS: readonly CommandModule[] = [
  verb('setup', 'Install wizard: data directories, .env, the compose file', 'neuralis setup [--compose-only] [--output <dir>]', () => import('../setup.mts')),
  verb('rebuild', 'Rebuild the image (an install folder: its derived image) and recreate the stack', 'neuralis rebuild [--no-sidecar]', () => import('../rebuild.mts')),
  verb('sync', 'Swap a package into the running container without a rebuild', 'neuralis sync [status | <package> | --all] [--dry-run] [--no-restart] [--json]', () => import('../sync.mts')),
  verb('update', 'Move this install to a published release line', 'neuralis update [<package>] [--version <x> | --manifest <https url|file>] [--apply] [--json]', () => import('../update.mts')),
  verb('upgrade', 'Raise the stored data formats a release needs (app stopped)', 'neuralis upgrade [--dry-run | --apply]', () => import('../upgrade.mts')),
  verb('mount', 'Expose a host folder to the container', 'neuralis mount <add|list|remove> …', () => import('../mount.mts')),
  verb('pkg', 'Register or remove a first-party package', 'neuralis pkg <list|add|remove> …', () => import('../pkg.mts')),
  verb('user', 'Recover a locked-out account', 'neuralis user <list|enable|reset-password> [<email>]', () => import('../user.mts')),
  verb('checkpoint', 'List or restore control-plane checkpoints', 'neuralis checkpoint <list | restore <id>>', () => import('../checkpoint.mts')),
  verb('backup', 'Back up the whole install', 'neuralis backup [--out <dir>] [--include-volume <name>] | backup list', () => import('../backup.mts')),
  verb('restore', 'Restore a whole-install backup (app stopped)', 'neuralis restore <dir> [--home <dir> --volume <name>]', () => import('../backup.mts'), ['restore']),
  verb('qdrant-upgrade', 'Upgrade the Qdrant engine one minor at a time', 'neuralis qdrant-upgrade [--dry-run | --rehearse <volume> | --rollback <dir>]', () => import('../qdrant-upgrade.mts')),
  verb('reset-vector', 'Drop the vector collections and the embedding lock', 'neuralis reset-vector', () => import('../reset-vector.mts')),
  verb('host-broker', 'Provision, run and maintain the host-access broker', 'neuralis host-broker <init|install|upgrade|run|status|grant|attach>', () => import('../host-broker.mts')),
  verb('convert', 'Turn a 0.1.0 unpacked install folder into an npm project (one-shot, app stopped)', 'neuralis convert --from <old version> | --rollback <checkpoint id>', () => import('../convert.mts')),
];

/**
 * Verbs a later release adds to this same registry (remote and device
 * commands). Dispatching one answers by name instead of "unknown", so an ops
 * verb can never squat one silently.
 */
export const RESERVED_VERBS = [
  'login', 'logout', 'whoami', 'device', 'mcp', 'plugin', 'skill', 'fs', 'agent',
  'workflow', 'shells', 'git', 'source', 'connect', 'up', 'down', 'tunnel',
] as const;

/** The host package itself, or an install folder that depends on it. */
function isInstallManifest(dir: string): boolean {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return false;
  let manifest: { name?: unknown; bin?: unknown; dependencies?: Record<string, unknown> };
  try {
    manifest = JSON.parse(readFileSync(file, 'utf-8')) as typeof manifest;
  } catch {
    return false;
  }
  // The `bin` entry is what tells the host package from the monorepo's ROOT
  // workspace manifest, which carries the same name.
  const hostPackage = manifest.name === 'neuralis' && typeof (manifest.bin as Record<string, unknown> | undefined)?.neuralis === 'string';
  return hostPackage || typeof manifest.dependencies?.neuralis === 'string';
}

/** Walk up from `start` to the nearest install folder; none ⇒ a refusal naming the rule. */
export function resolveInstallDir(start: string): string {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (isInstallManifest(dir)) return dir;
    if (dirname(dir) === dir) break;
  }
  throw new CliExit(1, `not inside a Neuralis install folder (searched upward from ${resolve(start)})`, [
    'Run this inside the folder `npm create neuralis` made (its package.json depends on `neuralis`),',
    'inside a clone of the public host repository, or in `neuralis/` of the development checkout.',
  ]);
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
}): CliContext {
  let installDir: string | null = null;
  return {
    packageDir: input.packageDir,
    get installDir(): string {
      installDir ??= resolveInstallDir(input.installFrom);
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
  const ctx = createCliContext({
    packageDir: PACKAGE_DIR,
    cwd: process.env.INIT_CWD || process.cwd(),
    installFrom: process.cwd(),
    env: process.env,
    stdin: process.stdin,
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
  });
  return dispatch(argv, ctx);
}

// The monorepo's `neuralis:*` package scripts run this file directly
// (`node --import tsx scripts/cli/registry.mts <verb>`); the bin imports `main`.
// Never a top-level await here: a verb module imports `CliExit` from this file,
// and awaiting `main` during this module's own evaluation would deadlock that cycle.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
