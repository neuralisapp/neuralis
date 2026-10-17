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
 *   docker compose run --rm --no-deps neuralis node bin/neuralis.mjs checkpoint restore <id>
 *
 * `restore` is OFFLINE-only: it refuses while the app answers on its port, or
 * while `docker compose ps` in the host folder shows the app service (the one
 * labelled `neuralis.kind: app`) running — a live process would keep writing over the files being put back.
 * A probe that cannot settle is a refusal — with ONE accepted guess: a name that
 * answers `EAI_AGAIN` counts as absent (see `NAME_LOOKUP_TIMEOUT_MS`), so stopping
 * the app first stays the operator's primary guard. Then it asks
 * for the id again, because a restore replaces the listed files wholesale:
 * every write made after the checkpoint is lost.
 *
 * The copy/restore mechanics are the kernel's (`@neuralis/package-system/data`);
 * this script owns only the offline decision the kernel leaves to its caller.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { resolveNeuralisHome } from '@neuralis/package-system/paths';
import {
  listCheckpoints,
  readDataFormatLedger,
  restoreCheckpoint,
} from '@neuralis/package-system/data';
import { CliExit, type CliContext } from './cli/registry.mts';
import { spell } from './cli/spelling.mts';
import { readComposeStack, type ComposeAnswer } from './host-broker/helper.mts';
import { bindMountOf, loadHostEnv } from './setup/detect.mts';
import { askLine } from './setup/ownerCheck.mts';

const USAGE = `Usage:
  ${spell('checkpoint list')}
  ${spell('checkpoint restore <id>')}`;

/** What one HTTP probe learned. `unknown` is anything that is not a clean "nobody there". */
export type ProbeAnswer = { kind: 'answered' } | { kind: 'absent' } | { kind: 'unknown'; detail: string };

export type { ComposeAnswer, ComposeStack, DockerExec, ExecResult } from './host-broker/helper.mts';

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
    if (compose.kind === 'services' && compose.running.includes(compose.app)) {
      return { offline: false, reason: `\`docker compose ps\` shows the ${compose.app} service running` };
    }
    if (compose.kind === 'unlabelled') return { offline: false, reason: `could not prove the app is stopped (${compose.detail})` };
    // `no-docker` is a native install; `failed` is a folder with no compose
    // stack (no compose file, daemon down) — nothing there can be running.
  }
  return { offline: true };
}

/** Connection-level errors that mean "nothing listens / no such host". */
const ABSENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

/**
 * How long a NAME may take to resolve. Separate from the 2 s HTTP bound because
 * Docker's embedded DNS takes ~5 s to answer for the stopped app's service name
 * (measured: `EAI_AGAIN`). An absent code above reads as absent; a lookup still
 * pending at this bound, or any other code, is "cannot prove", a refusal.
 * `EAI_AGAIN` is NOT a definite answer: a running app's name also answers it while
 * Docker's embedded resolver itself is down (a dockerd restart under live-restore).
 * Counting it as unknown would refuse on every host whose DNS forward times out,
 * so the window is accepted and named — `docker compose stop neuralis` comes first.
 */
export const NAME_LOOKUP_TIMEOUT_MS = 15_000;

type Lookup = (hostname: string) => Promise<unknown>;

function lookupWithin(hostname: string, lookup: Lookup, ms: number): Promise<{ code?: string } | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: 'ETIMEOUT' }), ms);
    timer.unref();
    lookup(hostname).then(
      () => { clearTimeout(timer); resolve(null); },
      (err: { code?: unknown }) => { clearTimeout(timer); resolve({ code: typeof err?.code === 'string' ? err.code : 'ELOOKUP' }); },
    );
  });
}

export async function httpProbe(url: string, deps: { lookup?: Lookup; lookupTimeoutMs?: number } = {}): Promise<ProbeAnswer> {
  const { hostname } = new URL(url);
  if (isIP(hostname) === 0) {
    const failed = await lookupWithin(hostname, deps.lookup ?? ((name) => dnsLookup(name)), deps.lookupTimeoutMs ?? NAME_LOOKUP_TIMEOUT_MS);
    if (failed?.code && ABSENT_CODES.has(failed.code)) return { kind: 'absent' };
    if (failed) return { kind: 'unknown', detail: `${hostname}: ${failed.code}` };
  }
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

/** The offline gate's compose port: the one reader, on the real runner. */
export function composeProbe(cwd: string): Promise<ComposeAnswer> {
  return readComposeStack(cwd);
}

/**
 * Inside a container a checkpoint is only a way back when `<home>/checkpoints`
 * is a bind of the host's — the writable layer goes with `--rm` or a recreate.
 * Reads `/proc/self/mountinfo` (`bindMountOf`); outside a container every
 * directory is persistent.
 */
export function checkpointsArePersistent(home: string, inContainer: boolean, mountinfo: () => string = () => readFileSync('/proc/self/mountinfo', 'utf-8')): boolean {
  if (!inContainer) return true;
  return bindMountOf(resolve(home, 'checkpoints'), mountinfo()) !== null;
}

/** The app's host port: `.env` NEURALIS_APP_PORT (pass the file's values when they are not loaded), else 3100. */
export function appPort(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const parsed = Number(env.NEURALIS_APP_PORT);
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

export async function run(argv: string[], ctx: CliContext): Promise<number> {
  const [command, id] = argv;
  const installDir = ctx.installDir;
  await loadHostEnv(installDir);
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
    return 0;
  }

  if (command !== 'restore' || !id) throw new CliExit(1, 'checkpoint needs `list` or `restore <id>`', USAGE.split('\n'));

  const verdict = await checkOffline(
    { appPort: appPort(), neuralisDir: installDir },
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
    throw new Error(`No complete checkpoint named ${id}. \`${spell('checkpoint list')}\` shows them.`);
  }
  console.log('  Restoring replaces every file this checkpoint lists; anything written after it is lost.');
  const typed = await askLine(`Type ${id} again to restore it`);
  if (typed !== id) throw new Error('Not confirmed; nothing changed.');
  const result = await restoreCheckpoint(home, id);
  console.log(`  Restored ${result.restoredFiles} file(s) from ${result.id}.`);
  await printLedger(appRoot);
  console.log('  Start the build these data formats belong to.');
  return 0;
}
