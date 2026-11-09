#!/usr/bin/env node
/**
 * neuralis:qdrant-upgrade — move this install's Qdrant to the version the host
 * ships, one minor at a time, with a cold backup and a rollback. `--help`
 * prints the usage below; the procedure and its reasons live in
 * `qdrant-upgrade/upgrade.mts`, and this file wires the real ports.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { authoredBaseEnv, installKindOf, resolveNeuralisHome } from '@neuralis/package-system/paths';
import { appPort, checkOffline, composeProbe, httpProbe } from './checkpoint.mts';
import type { CliContext } from './cli/registry.mts';
import { installLayout, spell } from './cli/spelling.mts';
import { resolveConfigDir } from './setup/detect.mts';
import { writeDesktopCompanionCompose } from './setup/compose.mts';
import { OLLAMA_OWN_PORT } from './setup/ollamaVersion.mts';
import { hostQdrantUrl, qdrantBinaryPorts, qdrantHostPort, readEnvFile } from './setup/envFile.mts';
import { askLine, promptOwnerCredentials, verifyOwnerCredentials } from './setup/ownerCheck.mts';
import {
  binaryInstallProbe,
  dockerInstallProbe,
  qdrantBinaryName,
  qdrantImageRef,
  qdrantStatePath,
  qdrantUpgradeChain,
  readQdrantState,
  resolveQdrantState,
  QDRANT_TARGET_VERSION,
  type QdrantInstallProbe,
} from './setup/qdrantVersion.mts';
import { downloadQdrantBinary, qdrantBinarySpawn, startQdrantBinary, stopQdrantBinary } from './setup/services.mts';
import { readHomeLock } from '../src/server/host/homeLock.ts';
import { runDown } from './up.mts';
import {
  DEFAULT_TIMEOUTS,
  backupRoot,
  containerQdrantApi,
  hostQdrantApi,
  pruneBackups,
  abortActiveRun,
  cleanupOnExit,
  runBinaryUpgrade,
  runDockerRollback,
  runDockerUpgrade,
  loadRecord,
  rollbackBinary,
  processExec as exec,
  type BaseContext,
  type Exec,
  type QdrantApi,
  type UpgradeOutcome,
} from './qdrant-upgrade/upgrade.mts';

/**
 * The live server from a one-shot container of an image-only folder: the
 * compose project's own Qdrant container (the host loopback it publishes on is
 * not this container's), found again per request — a recreate gives it a new id.
 */
/**
 * The desktop app runs the Qdrant binary its own build ships, under its supervisor: a binary
 * staged in `<home>/bin` would raise the storage beyond what that binary reads. Its Qdrant
 * moves with the app's own update; a Docker-mode Qdrant beside the app upgrades here.
 */
export function desktopBinaryRefusal(desktop: boolean, mode: 'docker' | 'binary'): string | null {
  if (!desktop || mode !== 'binary') return null;
  return 'Refusing: the desktop app runs the Qdrant its own build ships — a new Qdrant arrives with the app\'s update (the app checks at start; the tray has "Check for updates…"). Nothing was changed.';
}

export function composeQdrantApi(run: Exec, composeProject: string, cwd: string): QdrantApi {
  const container = async (): Promise<QdrantApi> => {
    const ps = await run('docker', ['compose', '-p', composeProject, 'ps', '-q', 'qdrant'], { cwd });
    const id = ps.out.trim().split('\n')[0];
    if (ps.code !== 0 || !id) throw new Error(`the qdrant service of compose project ${composeProject} is not running`);
    return containerQdrantApi(run, id);
  };
  return {
    request: async (method, path, body) => (await container()).request(method, path, body),
    fetchSnapshot: async (collection, name, dest) => (await container()).fetchSnapshot(collection, name, dest),
  };
}

const c = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' };
const ok = `${c.green}✓${c.reset}`;
const fail = `${c.red}✗${c.reset}`;
const dot = `${c.dim}·${c.reset}`;

const HELP = `${spell('qdrant-upgrade [options]')}

  --dry-run              the hop chain; changes nothing
  --rehearse <volume>    the whole chain on a CLONED Docker volume
  --rollback <dir>       restore a run's cold backup (with --rehearse <volume> for a rehearsal's)
  --settle-minutes <n>   the settle cap per version (default 60; the 1.16 hop at least 240)
  --keep-backups <n>     backup dirs of the same kind kept after a successful run (default 2)

Settle rule, on the source and after every hop: ready, optimizer_status ok, not red, and the
exact point count equal to the one recorded with the app stopped. Green is not required (a
long optimization keeps a collection yellow); the status reached is recorded.
Nothing else may rebuild or recreate the stack while this runs.`;

type Args = { dryRun: boolean; rehearse: string | null; rollback: string | null; keepBackups: number; settleMinutes: number | null };

function parseArgs(argv: string[]): Args {
  const value = (flag: string): string | null => {
    const idx = argv.indexOf(flag);
    if (idx < 0) return null;
    const v = argv[idx + 1];
    if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value.`);
    return v;
  };
  const known = new Set(['--dry-run', '--rehearse', '--rollback', '--keep-backups', '--settle-minutes']);
  for (const arg of argv) if (arg.startsWith('--') && !known.has(arg)) throw new Error(`Unknown flag ${arg}.`);
  const keep = Number(value('--keep-backups') ?? '2');
  if (!Number.isInteger(keep) || keep < 1) throw new Error('--keep-backups expects an integer ≥ 1.');
  const settleRaw = value('--settle-minutes');
  const settle = settleRaw === null ? null : Number(settleRaw);
  if (settle !== null && (!Number.isInteger(settle) || settle < 1)) throw new Error('--settle-minutes expects an integer ≥ 1.');
  return {
    dryRun: argv.includes('--dry-run'),
    rehearse: value('--rehearse'),
    rollback: value('--rollback'),
    keepBackups: keep,
    settleMinutes: settle,
  };
}

async function versionOnGet(url: string): Promise<string | null> {
  try {
    // `GET /` is unauthenticated upstream: no key is sent to find the version.
    const res = await fetch(url.replace(/\/+$/, '') + '/', { signal: AbortSignal.timeout(3000) });
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
}

async function upgradeQdrant(argv: string[], cliCtx: CliContext): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return 0;
  }
  const args = parseArgs(argv);
  const neuralisHome = resolveNeuralisHome().home;
  const configDir = resolveConfigDir({ projectRoot: cliCtx.installDir, neuralisHome }, null);
  // The desktop app's own Qdrant: its compose file sits beside its `.env` in the
  // data home, and runs no app service (`neuralis up` is the app).
  const desktop = installKindOf(cliCtx.installDir) === 'native';
  /** The compose cwd (never `-f`): the install folder, or the desktop app's config folder. */
  const neuralisDir = desktop ? configDir : cliCtx.installDir;
  const env = await readEnvFile(configDir);
  const mode = env.QDRANT_MODE;
  if (mode !== 'docker' && mode !== 'binary') {
    throw new Error(`QDRANT_MODE is "${mode ?? ''}" in ${join(configDir, '.env')}; this command manages only the docker and binary modes.`);
  }
  const refusal = desktopBinaryRefusal(desktop, mode);
  if (refusal) throw new Error(refusal);
  const apiKey = env.QDRANT_API_KEY?.trim();
  if (!apiKey) throw new Error(`${join(configDir, '.env')} has no QDRANT_API_KEY; re-run \`${spell('setup')}\` first.`);
  const composeProject = env.NEURALIS_COMPOSE_PROJECT?.trim() || 'neuralis';
  const liveUrl = hostQdrantUrl(env);
  const binDir = join(neuralisHome, 'bin');
  const storageDir = join(neuralisHome, 'qdrant-storage');

  const probe: QdrantInstallProbe = mode === 'docker'
    ? dockerInstallProbe({ composeProject, composeFilePath: join(configDir, 'docker-compose.yml'), runningVersion: await versionOnGet(liveUrl) })
    : binaryInstallProbe({ storageDir, binaryPath: join(binDir, qdrantBinaryName()), runningVersion: await versionOnGet(liveUrl) });
  // A dry run or a rehearsal records nothing about the live install.
  const resolution = await resolveQdrantState({
    statePath: qdrantStatePath(neuralisHome),
    probe,
    persist: !args.dryRun && !args.rehearse,
  });
  if (resolution.kind === 'refuse') throw new Error(resolution.message);
  const from = resolution.state.version;
  const target = QDRANT_TARGET_VERSION;

  console.log();
  console.log(`  ${c.cyan}${c.bold}── neuralis qdrant-upgrade ${'─'.repeat(30)}${c.reset}`);
  console.log(`  ${dot} mode      : ${c.bold}${mode}${args.rehearse ? ` (REHEARSAL on ${args.rehearse})` : ''}${c.reset}`);
  console.log(`  ${dot} recorded  : ${c.bold}${from}${c.reset} ${c.dim}(${qdrantStatePath(neuralisHome)})${c.reset}`);
  console.log(`  ${dot} target    : ${c.bold}${target}${c.reset}`);
  console.log(`  ${dot} backups   : ${c.bold}${backupRoot(neuralisHome)}${c.reset}`);
  if (args.rehearse && mode !== 'docker') throw new Error('--rehearse runs on a cloned Docker volume; binary mode has no rehearsal form.');

  if (!args.rollback) {
    const chain = qdrantUpgradeChain(from, target);
    console.log(`  ${dot} chain     : ${c.bold}${[from, ...chain].join(' → ')}${c.reset}`);
    if (chain.length === 0) {
      console.log(`\n  ${ok} Already at ${target}. Nothing to do.\n`);
      return 0;
    }
  }
  if (args.dryRun) {
    console.log(`\n  ${dot} Dry run: nothing was changed.\n`);
    return 0;
  }

  console.log();
  const { email, password } = await promptOwnerCredentials();
  const owner = await verifyOwnerCredentials(neuralisHome, email, password);
  console.log(`  ${ok} Authenticated as ${c.bold}${owner.email}${c.reset}`);
  const what = args.rollback
    ? `restore the backup in ${args.rollback}`
    : args.rehearse
      ? `rehearse the upgrade on the clone ${args.rehearse}`
      : 'STOP the app and Qdrant and upgrade the live storage';
  const answer = (await askLine(`Proceed to ${what}? [y/N]`)).toLowerCase();
  if (!answer.startsWith('y')) {
    console.log(`  ${dot} Aborted.`);
    return 0;
  }

  const base: BaseContext = {
    neuralisHome,
    apiKey,
    from,
    target,
    exec,
    // An image-only folder runs this in a one-shot container: the host loopback is not its own.
    liveQdrant: installLayout(neuralisDir, cliCtx.packageDir) === 'image' ? () => composeQdrantApi(exec, composeProject, neuralisDir) : () => hostQdrantApi(liveUrl, apiKey),
    freeBytes: async (dir) => {
      const fs = await statfs(dir);
      return fs.bavail * fs.bsize;
    },
    log: (line) => console.log(`  ${dot} ${line}`),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    monotonicMs: () => performance.now(),
    // Every settle wait is bounded; --settle-minutes widens it for a collection
    // whose optimizer is still indexing (the 1.16 migration budget never shrinks).
    timeouts: args.settleMinutes === null
      ? DEFAULT_TIMEOUTS
      : {
        ...DEFAULT_TIMEOUTS,
        settleMs: args.settleMinutes * 60_000,
        migrationSettleMs: Math.max(DEFAULT_TIMEOUTS.migrationSettleMs, args.settleMinutes * 60_000),
      },
  };

  let outcome: UpgradeOutcome;
  if (mode === 'docker') {
    if (desktop && !args.rehearse) {
      const offline = await checkOffline({ appPort: appPort(env), neuralisDir }, { inContainer: false, http: httpProbe, composeRunning: composeProbe });
      if (!offline.offline) throw new Error(`Refusing: ${offline.reason}. Quit the desktop app (or \`neuralis down\`) first. Nothing was changed.`);
    }
    const ctx = {
      ...base,
      neuralisDir,
      packageDir: cliCtx.packageDir,
      composeProject,
      appService: desktop ? null : 'neuralis',
      regenerate: desktop
        ? async () => {
          const state = await readQdrantState(qdrantStatePath(neuralisHome));
          if (!state) throw new Error(`${qdrantStatePath(neuralisHome)} is missing.`);
          // The file carries this home's Ollama too (`OLLAMA_MODE=docker`): rewritten with it, never without.
          await writeDesktopCompanionCompose(configDir, { project: composeProject, qdrant: { image: qdrantImageRef(state.version), port: qdrantHostPort(env) }, ollama: env.OLLAMA_MODE?.trim() === 'docker' ? { port: Number(env.NEURALIS_OLLAMA_PORT) || OLLAMA_OWN_PORT } : null }, { date: new Date().toISOString().split('T')[0]!, version: (JSON.parse(readFileSync(join(cliCtx.packageDir, 'package.json'), 'utf-8')) as { version: string }).version });
        }
        : null,
      rehearseVolume: args.rehearse,
      containerQdrant: (name: string) => containerQdrantApi(exec, name),
    };
    outcome = args.rollback ? await runDockerRollback(ctx, args.rollback) : await runDockerUpgrade(ctx);
  } else {
    const hasComposeApp = existsSync(join(configDir, 'docker-compose.yml'));
    const ctx = {
      ...base,
      storageDir,
      binDir,
      binary: {
        async download(version: string, destDir: string) {
          const path = await downloadQdrantBinary(destDir, version);
          if (!path) throw new Error(`Qdrant publishes no binary for ${process.platform}/${process.arch}.`);
          return path;
        },
        async startHop(binaryPath: string, storage: string) {
          // Same spawn contract as setup's managed start: loopback, this install's ports, the authored env.
          const spec = qdrantBinarySpawn(storage, apiKey, qdrantBinaryPorts(env), { ...authoredBaseEnv(process.platform, process.env), HOME: process.env.HOME });
          const child = spawn(binaryPath, spec.args, { stdio: 'ignore', env: spec.env, cwd: spec.cwd, windowsHide: true });
          const exited = new Promise<void>((r) => child.once('exit', () => r()));
          return {
            async stop() {
              child.kill('SIGTERM');
              await Promise.race([exited, new Promise((r) => setTimeout(r, 120_000))]);
              if (child.exitCode === null && child.signalCode === null) throw new Error('A Qdrant hop did not stop within 120 s.');
            },
          };
        },
        async stopManaged() {
          // Windows: never by a recorded pid (`stopQdrantBinary` refuses) — the desktop
          // app's supervisor (`neuralis up`) stops what it runs, on `down`'s stop request.
          const lock = readHomeLock(neuralisHome);
          if (process.platform === 'win32' && lock !== null && lock !== 'corrupt' && lock.kind === 'native') {
            await runDown(process.env, (line) => console.log(`  ${dot} ${line}`));
            return;
          }
          await stopQdrantBinary(binDir);
        },
        async startManaged() {
          if (!(await startQdrantBinary(binDir, storageDir, apiKey, qdrantBinaryPorts(env)))) throw new Error(`No Qdrant binary at ${join(binDir, qdrantBinaryName())}.`);
        },
        async stopApp() {
          if (hasComposeApp) {
            const res = spawnSync('docker', ['compose', 'stop', 'neuralis'], { cwd: neuralisDir, stdio: 'inherit', windowsHide: true });
            if (res.status !== 0) throw new Error('Stopping the app failed.');
            return;
          }
          const answer = (await askLine('Stop the native app (pnpm start) now, then answer y')).toLowerCase();
          if (!answer.startsWith('y')) throw new Error('The app must be stopped first.');
        },
        async startApp() {
          if (hasComposeApp) spawnSync('docker', ['compose', 'up', '-d'], { cwd: neuralisDir, stdio: 'inherit', windowsHide: true });
          else console.log(`  ${dot} Start the app again (pnpm start).`);
        },
      },
    };
    if (args.rollback) {
      const record = await loadRecord(args.rollback);
      await ctx.binary.stopApp();
      await rollbackBinary(ctx, record, args.rollback, from !== record.from);
      await ctx.binary.startApp();
      outcome = { result: 'restored', backupDir: args.rollback, record };
    } else {
      outcome = await runBinaryUpgrade(ctx);
    }
  }

  if (outcome.result === 'upgraded' || outcome.result === 'rehearsed') {
    const kind = outcome.result === 'rehearsed' ? 'rehearsal' : 'upgrade';
    const pruned = await pruneBackups(neuralisHome, args.keepBackups, outcome.backupDir, kind);
    for (const dir of pruned) console.log(`  ${dot} pruned old backup ${dir}`);
  }
  console.log(`\n  ${ok} ${outcome.result}. Record: ${join(outcome.backupDir, 'record.json')}\n`);
  return 0;
}

/**
 * A signal skips every `finally`. First the run's record says `aborted` and one
 * line names the state and the command that continues from it (nothing is
 * restarted against a store that may be partly upgraded); then no key env-file
 * and no hop container still holding the storage survive the process. The
 * handlers are installed for THIS verb only, on dispatch — never at import.
 */
export async function run(argv: string[], ctx: CliContext): Promise<number> {
  process.on('exit', () => {
    const line = abortActiveRun();
    if (line) console.error(`\n  ${fail} ${line}\n`);
    cleanupOnExit((name) => { spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 30_000, windowsHide: true }); });
  });
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
  return upgradeQdrant(argv, ctx);
}
