#!/usr/bin/env node
/**
 * neuralis:checkpoint — list and restore the control-plane checkpoints the app
 * takes by itself, at boot, before it raises a stored data format.
 *
 *   pnpm neuralis:checkpoint list
 *   pnpm neuralis:checkpoint restore <id>
 *
 * A pulled image has no host folder; the same script is baked in and runs in a
 * one-off container, with the app container stopped first:
 *
 *   docker compose stop neuralis
 *   docker compose run --rm --no-deps neuralis node --import tsx scripts/checkpoint.mts restore <id>
 *
 * `restore` is OFFLINE-only: it refuses while the app answers on its port, or
 * while `docker compose ps` in the host folder shows the `neuralis` service
 * running — a live process would keep writing over the files being put back.
 * Anything the probes cannot settle is a refusal, never a guess. Then it asks
 * for the id again, because a restore replaces the listed files wholesale:
 * every write made after the checkpoint is lost.
 *
 * The copy/restore mechanics are the kernel's (`@neuralis/package-system/data`);
 * this script owns only the offline decision the kernel leaves to its caller.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveNeuralisHome } from '@neuralis/package-system/paths';
import {
  listCheckpoints,
  readDataFormatLedger,
  restoreCheckpoint,
} from '@neuralis/package-system/data';
import { loadHostEnv } from './setup/detect.mts';
import { askLine } from './setup/ownerCheck.mts';

const neuralisDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Usage:
  pnpm neuralis:checkpoint list
  pnpm neuralis:checkpoint restore <id>`;

/** What one HTTP probe learned. `unknown` is anything that is not a clean "nobody there". */
export type ProbeAnswer = { kind: 'answered' } | { kind: 'absent' } | { kind: 'unknown'; detail: string };

export type ComposeAnswer =
  | { kind: 'services'; running: string[] }
  | { kind: 'no-docker' }
  | { kind: 'failed'; detail: string };

export type OfflineProbes = {
  /** True inside a container (`/.dockerenv`): compose is not reachable from there. */
  inContainer: boolean;
  http(url: string): Promise<ProbeAnswer>;
  composeRunning(cwd: string): Promise<ComposeAnswer>;
};

export type OfflineVerdict = { offline: true } | { offline: false; reason: string };

/**
 * The offline decision. Host plane: the app port on loopback + compose. In a
 * one-off container: loopback (this container) + the `neuralis` service name,
 * which resolves to the app container while it runs (a `compose run` container
 * does not take the service alias).
 */
export async function checkOffline(
  opts: { appPort: number; neuralisDir: string },
  probes: OfflineProbes,
): Promise<OfflineVerdict> {
  const urls = [`http://127.0.0.1:${opts.appPort}/api/health`];
  if (probes.inContainer) urls.push('http://neuralis:3100/api/health');
  for (const url of urls) {
    const answer = await probes.http(url);
    if (answer.kind === 'answered') return { offline: false, reason: `the app answers on ${url}` };
    if (answer.kind === 'unknown') {
      return { offline: false, reason: `could not prove the app is stopped (${url}: ${answer.detail})` };
    }
  }
  if (!probes.inContainer) {
    const compose = await probes.composeRunning(opts.neuralisDir);
    if (compose.kind === 'services' && compose.running.includes('neuralis')) {
      return { offline: false, reason: '`docker compose ps` shows the neuralis service running' };
    }
    // `no-docker` is a native install; `failed` is a folder with no compose
    // stack (no compose file, daemon down) — nothing there can be running.
  }
  return { offline: true };
}

/** Connection-level errors that mean "nothing listens / no such host". */
const ABSENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

export async function httpProbe(url: string): Promise<ProbeAnswer> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000), redirect: 'manual' });
    return { kind: 'answered' };
  } catch (err) {
    const cause = (err as { cause?: { code?: unknown } }).cause;
    const code = typeof cause?.code === 'string' ? cause.code : undefined;
    if (code && ABSENT_CODES.has(code)) return { kind: 'absent' };
    return { kind: 'unknown', detail: code ?? (err instanceof Error ? err.name : String(err)) };
  }
}

export function composeProbe(cwd: string): Promise<ComposeAnswer> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['compose', 'ps', '--status', 'running', '--services'], { cwd });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => {
      const code = (e as NodeJS.ErrnoException).code;
      resolve(code === 'ENOENT' ? { kind: 'no-docker' } : { kind: 'failed', detail: e.message });
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ kind: 'services', running: out.split('\n').map((s) => s.trim()).filter(Boolean) });
      } else {
        resolve({ kind: 'failed', detail: err.trim() || `exit ${code}` });
      }
    });
  });
}

export function appPort(): number {
  const parsed = Number(process.env.NEURALIS_APP_PORT);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : 3100;
}

async function printLedger(appRoot: string): Promise<void> {
  const ledger = await readDataFormatLedger(appRoot);
  const kinds = Object.keys(ledger).sort();
  if (kinds.length === 0) {
    console.log('  Data formats: no ledger yet (written at the first boot of a build that keeps one).');
    return;
  }
  console.log('  Data formats on disk:');
  for (const kind of kinds) console.log(`    ${kind.padEnd(36)} v${ledger[kind]!.version}`);
}

async function main(): Promise<void> {
  const [command, id] = process.argv.slice(2);
  await loadHostEnv(neuralisDir);
  const { home, appRoot } = resolveNeuralisHome();

  if (command === 'list') {
    const checkpoints = await listCheckpoints(home);
    if (checkpoints.length === 0) {
      console.log(`  No checkpoints under ${join(home, 'checkpoints')}.`);
    } else {
      for (const cp of checkpoints) {
        console.log(`  ${cp.id}  ${cp.createdAt}  ${cp.fileCount} file(s)  ${cp.label}`);
      }
      console.log(`  ${checkpoints.length} checkpoint(s), newest first.`);
    }
    await printLedger(appRoot);
    return;
  }

  if (command !== 'restore' || !id) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  const verdict = await checkOffline(
    { appPort: appPort(), neuralisDir },
    { inContainer: existsSync('/.dockerenv'), http: httpProbe, composeRunning: composeProbe },
  );
  if (!verdict.offline) {
    throw new Error(
      `Refusing to restore: ${verdict.reason}. Stop the app first (\`docker compose stop neuralis\` in the ` +
        'host folder, or stop the process), then run this again.',
    );
  }
  const known = await listCheckpoints(home);
  if (!known.some((cp) => cp.id === id)) {
    throw new Error(`No complete checkpoint named ${id}. \`pnpm neuralis:checkpoint list\` shows them.`);
  }
  console.log('  Restoring replaces every file this checkpoint lists; anything written after it is lost.');
  const typed = await askLine(`Type ${id} again to restore it`);
  if (typed !== id) throw new Error('Not confirmed; nothing changed.');
  const result = await restoreCheckpoint(home, id);
  console.log(`  Restored ${result.restoredFiles} file(s) from ${result.id}.`);
  await printLedger(appRoot);
  console.log('  Start the build these data formats belong to.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
