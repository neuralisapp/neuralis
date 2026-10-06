#!/usr/bin/env node
/**
 * neuralis:qdrant-upgrade — move this install's Qdrant to the version the host
 * ships, one minor at a time, with a cold backup and a rollback. `--help`
 * prints the usage below; the procedure and its reasons live in
 * `qdrant-upgrade/upgrade.mts`, and this file wires the real ports.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNeuralisHome } from '@neuralis/package-system/paths';
import { detectIsClone, resolveConfigDir } from './setup/detect.mts';
import { readEnvFile } from './setup/envFile.mts';
import { askLine, promptOwnerCredentials, verifyOwnerCredentials } from './setup/ownerCheck.mts';
import {
  binaryInstallProbe,
  dockerInstallProbe,
  qdrantStatePath,
  qdrantUpgradeChain,
  resolveQdrantState,
  QDRANT_TARGET_VERSION,
  type QdrantInstallProbe,
} from './setup/qdrantVersion.mts';
import { downloadQdrantBinary, qdrantBinarySpawn, startQdrantBinary, stopQdrantBinary } from './setup/services.mts';
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
  type UpgradeOutcome,
} from './qdrant-upgrade/upgrade.mts';

const c = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' };
const ok = `${c.green}✓${c.reset}`;
const fail = `${c.red}✗${c.reset}`;
const dot = `${c.dim}·${c.reset}`;

const HELP = `pnpm neuralis:qdrant-upgrade [options]

  --dry-run              the hop chain; changes nothing
  --rehearse <volume>    the whole chain on a CLONED Docker volume
  --rollback <dir>       restore a run's cold backup (with --rehearse <volume> for a rehearsal's)
  --settle-minutes <n>   the settle cap per version (default 60; the 1.16 hop at least 240)
  --keep-backups <n>     backup dirs of the same kind kept after a successful run (default 2)

Settle rule, on the source and after every hop: ready, optimizer_status ok, not red, and the
exact point count equal to the one recorded with the app stopped. Green is not required (a
long optimization keeps a collection yellow); the status reached is recorded.
Nothing else may rebuild or recreate the stack while this runs.`;

/** neuralis/ — the compose cwd (never `-f`) and where setup lives. */
const neuralisDir = join(dirname(fileURLToPath(import.meta.url)), '..');

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

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(HELP);
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  const neuralisHome = resolveNeuralisHome().home;
  const configDir = resolveConfigDir({ isClone: await detectIsClone(neuralisDir), projectRoot: neuralisDir, neuralisHome }, null);
  const env = await readEnvFile(configDir);
  const mode = env.QDRANT_MODE;
  if (mode !== 'docker' && mode !== 'binary') {
    throw new Error(`QDRANT_MODE is "${mode ?? ''}" in ${join(configDir, '.env')}; this command manages only the docker and binary modes.`);
  }
  const apiKey = env.QDRANT_API_KEY?.trim();
  if (!apiKey) throw new Error(`${join(configDir, '.env')} has no QDRANT_API_KEY; re-run \`pnpm neuralis:setup\` first.`);
  const composeProject = env.NEURALIS_COMPOSE_PROJECT?.trim() || 'neuralis';
  const liveUrl = mode === 'docker' ? 'http://127.0.0.1:6333' : env.QDRANT_URL || 'http://localhost:6333';
  const binDir = join(neuralisHome, 'bin');
  const storageDir = join(neuralisHome, 'qdrant-storage');

  const probe: QdrantInstallProbe = mode === 'docker'
    ? dockerInstallProbe({ composeProject, composeFilePath: join(configDir, 'docker-compose.yml'), runningVersion: await versionOnGet(liveUrl) })
    : binaryInstallProbe({ storageDir, binaryPath: join(binDir, 'qdrant'), runningVersion: await versionOnGet(liveUrl) });
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
      return;
    }
  }
  if (args.dryRun) {
    console.log(`\n  ${dot} Dry run: nothing was changed.\n`);
    return;
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
    return;
  }

  const base: BaseContext = {
    neuralisHome,
    apiKey,
    from,
    target,
    exec,
    liveQdrant: () => hostQdrantApi(liveUrl, apiKey),
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
    const ctx = {
      ...base,
      neuralisDir,
      composeProject,
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
          // Same spawn contract as setup's managed start; a hop listens on loopback only.
          const spec = qdrantBinarySpawn(storage, apiKey, { QDRANT__SERVICE__HOST: '127.0.0.1' });
          const child = spawn(binaryPath, spec.args, { stdio: 'ignore', env: spec.env });
          const exited = new Promise<void>((r) => child.once('exit', () => r()));
          return {
            async stop() {
              child.kill('SIGTERM');
              await Promise.race([exited, new Promise((r) => setTimeout(r, 120_000))]);
              if (child.exitCode === null && child.signalCode === null) throw new Error('A Qdrant hop did not stop within 120 s.');
            },
          };
        },
        stopManaged: () => stopQdrantBinary(binDir),
        async startManaged() {
          if (!(await startQdrantBinary(binDir, storageDir, apiKey))) throw new Error(`No Qdrant binary at ${join(binDir, 'qdrant')}.`);
        },
        async stopApp() {
          if (hasComposeApp) {
            const res = spawnSync('docker', ['compose', 'stop', 'neuralis'], { cwd: neuralisDir, stdio: 'inherit' });
            if (res.status !== 0) throw new Error('Stopping the app failed.');
            return;
          }
          const answer = (await askLine('Stop the native app (pnpm start) now, then answer y')).toLowerCase();
          if (!answer.startsWith('y')) throw new Error('The app must be stopped first.');
        },
        async startApp() {
          if (hasComposeApp) spawnSync('docker', ['compose', 'up', '-d'], { cwd: neuralisDir, stdio: 'inherit' });
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
}

// A signal skips every `finally`. First the run's record says `aborted` and one
// line names the state and the command that continues from it (nothing is
// restarted against a store that may be partly upgraded); then no key env-file
// and no hop container still holding the storage survive the process.
process.on('exit', () => {
  const line = abortActiveRun();
  if (line) console.error(`\n  ${fail} ${line}\n`);
  cleanupOnExit((name) => { spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 30_000 }); });
});
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

main().catch((err) => {
  console.error(`\n  ${fail} ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
