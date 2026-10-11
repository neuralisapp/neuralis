#!/usr/bin/env node
/**
 * neuralis:backup / neuralis:restore — one consistent copy of the whole install,
 * and the way back. `--help` prints the usage below; the procedure and its
 * reasons live in `backup/backup.mts`, and this file wires the real ports.
 */

import { existsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { resolveNeuralisHome } from '@neuralis/package-system/paths';
import { appPort, checkOffline, composeProbe, httpProbe } from './checkpoint.mts';
import type { CliContext } from './cli/registry.mts';
import { spell } from './cli/spelling.mts';
import { detectIsClone, loadHostEnv, resolveConfigDir } from './setup/detect.mts';
import { readEnvFile } from './setup/envFile.mts';
import { askLine } from './setup/ownerCheck.mts';
import { qdrantImageRef, qdrantStatePath, readQdrantState } from './setup/qdrantVersion.mts';
import { processExec } from './qdrant-upgrade/upgrade.mts';
import {
  defaultBackupRoot,
  listBackups,
  runBackup,
  runRestore,
  type BackupPorts,
  type InstallFacts,
  type QdrantMode,
} from './backup/backup.mts';

const HELP = `${spell('backup [options]')}            stop the app + Qdrant, copy the install, start them again
  --out <dir>                 where the backup goes (default: <home>-backups/<time>, beside the home)
  --include-volume <name>     also copy this Docker volume (repeatable): <project>_qdrant-snapshots,
                              a neuralis-machine-* desktop profile, <project>_ollama-data
${spell('backup list')}                 the complete backups under the default folder, newest first
${spell('restore <dir> [options]')}     put a backup back (the app must be stopped; asks to confirm)
  --home <dir>                restore the home there instead of the live one (a throwaway target)
  --volume <name>             restore the Qdrant volume into this one (required with --home)

A backup holds the data home (without qdrant-backups/), the Qdrant volume in docker mode, the
host folder's .env and docker-compose.override.yml. Keep it private: it holds every secret.
Relative paths are read from the folder you run the command in.
A restore never deletes: the current home moves to <home>.before-restore and the current
volume is saved to <home>.before-restore-<volume>.tar before it is replaced; .env and the
override move to *.before-restore. An earlier rescue copy in any of those places is refused, never
overwritten. A backup fails (no manifest, the stopped services started again) when tar reports a file
that changed while it was read — stop whatever still writes under the home and run it again.`;

type Args =
  | { command: 'backup'; out: string | null; include: string[] }
  | { command: 'list' }
  | { command: 'restore'; dir: string; home: string | null; volume: string | null };

function parseArgs(argv: string[], cwd: string): Args {
  const known = new Set(['--out', '--include-volume', '--home', '--volume']);
  const positional: string[] = [];
  const values = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    if (!known.has(arg)) throw new Error(`Unknown flag ${arg}.`);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value.`);
    values.set(arg, [...(values.get(arg) ?? []), value]);
    i++;
  }
  const one = (flag: string): string | null => values.get(flag)?.at(-1) ?? null;
  const path = (value: string | null): string | null => (value === null ? null : resolve(cwd, value));
  const [command = 'backup', operand, ...extra] = positional;
  if (extra.length > 0 || (operand && command !== 'restore')) throw new Error(`Unexpected argument ${extra[0] ?? operand}.\n${HELP}`);
  if (command === 'backup') return { command, out: path(one('--out')), include: values.get('--include-volume') ?? [] };
  if (command === 'list') return { command };
  if (command === 'restore') {
    if (!operand) throw new Error(`restore needs the backup directory: ${spell('restore <dir>')}`);
    return { command, dir: resolve(cwd, operand), home: path(one('--home')), volume: one('--volume') };
  }
  throw new Error(`Unknown command ${command}.\n${HELP}`);
}

/** `installDir` — the compose cwd (never `-f`). */
async function facts(neuralisDir: string): Promise<InstallFacts> {
  const neuralisHome = resolveNeuralisHome().home;
  const isClone = await detectIsClone(neuralisDir);
  const configDir = resolveConfigDir({ isClone, projectRoot: neuralisDir, neuralisHome }, null);
  const env = await readEnvFile(configDir);
  const modes: QdrantMode[] = ['docker', 'binary', 'external', 'skip'];
  const qdrantMode = modes.find((m) => m === env.QDRANT_MODE?.trim()) ?? 'external';
  let toolImage: string | null = null;
  if (qdrantMode === 'docker') {
    const state = await readQdrantState(qdrantStatePath(neuralisHome));
    if (!state) throw new Error(`${qdrantStatePath(neuralisHome)} is missing — run \`${spell('setup --compose-only')}\` first.`);
    toolImage = qdrantImageRef(state.version);
  }
  // The monorepo image build's context is the repo root (`build: context: ..`).
  return { neuralisHome, configDir, buildContext: isClone ? join(neuralisDir, '..') : null, composeProject: env.NEURALIS_COMPOSE_PROJECT?.trim() || 'neuralis', qdrantMode, toolImage };
}

function ports(install: InstallFacts, qdrantUrl: string): BackupPorts {
  return {
    exec: processExec,
    log: (line) => console.log(`  ${line}`),
    freeBytes: async (dir) => {
      const fs = await statfs(dir);
      return fs.bavail * fs.bsize;
    },
    now: () => new Date(),
    monotonicMs: () => performance.now(),
    composeRunning: composeProbe,
    appOffline: () => checkOffline(
      { appPort: appPort(), neuralisDir: install.configDir },
      { inContainer: existsSync('/.dockerenv'), http: httpProbe, composeRunning: composeProbe },
    ),
    qdrantAnswers: async () => (await httpProbe(qdrantUrl)).kind !== 'absent',
    ask: (prompt) => askLine(prompt),
  };
}

export async function run(argv: string[], ctx: CliContext): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return 0;
  }
  // A relative path means the folder the operator typed the command in.
  const args = parseArgs(argv, ctx.cwd);
  // The app port and NEURALIS_HOME the probes and paths use come from the deployment's .env.
  await loadHostEnv(ctx.installDir);
  const install = await facts(ctx.installDir);
  if (args.command === 'list') {
    const root = defaultBackupRoot(install.neuralisHome);
    const found = await listBackups(root);
    if (found.length === 0) console.log(`  No complete backups under ${root}.`);
    for (const { dir, manifest } of found) {
      const bytes = manifest.parts.reduce((sum, p) => sum + p.bytes, 0);
      console.log(`  ${dir}  ${manifest.createdAt}  ${(bytes / 1e6).toFixed(1)} MB  ${manifest.parts.map((p) => p.kind).join(', ')}`);
    }
    return 0;
  }
  const env = await readEnvFile(install.configDir);
  const p = ports(install, env.QDRANT_URL?.trim() || 'http://localhost:6333');
  if (args.command === 'backup') {
    await runBackup(p, install, { outDir: args.out, includeVolumes: args.include });
    console.log('  Keep this folder private: it holds the session secret, the Qdrant key and the credential master key.');
    return 0;
  }
  await runRestore(p, install, { dir: args.dir, home: args.home, volume: args.volume });
  return 0;
}
