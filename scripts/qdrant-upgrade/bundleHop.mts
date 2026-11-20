/**
 * The desktop app's own Qdrant moves with the app: the bundle ships ONE binary
 * (`QDRANT_TARGET_VERSION`) and `up` starts it on `<home>/qdrant-storage`. Before
 * that start the home's recorded version is held against the bundle's
 * (`assessQdrantGap`, the rule setup applies to every install):
 *
 *  - current, or no record yet (setup writes it) → start as before;
 *  - one minor (or a patch) behind → a cold copy of the storage into
 *    `<home>/qdrant-backups/<from>-to-<target>-<stamp>/` while no Qdrant runs, then
 *    the start; the record advances once the server answers the bundle's version;
 *  - wider, newer or unreadable → no start, a named reason (the app carries no
 *    intermediate binary; the reason names the release to install first).
 */

import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { assessQdrantGap, QDRANT_TARGET_VERSION, qdrantStatePath, qdrantUpgradeChain, readQdrantState, writeQdrantState } from '../setup/qdrantVersion.mts';
import { backupStamp, checkDisk, createBackupDir, freeBytesOf, processExec, tarStorageDir, type Exec } from './upgrade.mts';

export type BundleHopPorts = {
  exec: Exec;
  freeBytes(dir: string): Promise<number>;
  /** The version `GET /` reports, or null when it does not answer one. */
  serverVersion(url: string, apiKey: string | undefined): Promise<string | null>;
  now(): Date;
};

export const PROCESS_BUNDLE_HOP_PORTS: BundleHopPorts = {
  exec: processExec,
  freeBytes: freeBytesOf,
  async serverVersion(url, apiKey) {
    try {
      const response = await fetch(new URL('/', url), { signal: AbortSignal.timeout(2_000), headers: apiKey ? { 'api-key': apiKey } : {} });
      const version = ((await response.json()) as { version?: unknown }).version;
      return response.ok && typeof version === 'string' ? version : null;
    } catch {
      return null;
    }
  },
  now: () => new Date(),
};

export type BundleHop =
  | { kind: 'start' }
  | { kind: 'hop'; from: string; target: string; backupDir: string | null }
  | { kind: 'refuse'; reason: string };

/** The bytes the storage occupies on disk (sparse files count their blocks; where `blocks` is unknown, their size). */
async function storageBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await storageBytes(path);
    else if (entry.isFile()) {
      const info = await stat(path);
      total += Number.isFinite(info.blocks) && info.blocks > 0 ? info.blocks * 512 : info.size;
    }
  }
  return total;
}

function refusal(from: string, target: string, message: string): string {
  let chain: string[];
  try {
    chain = qdrantUpgradeChain(from, target);
  } catch {
    return `${message} This app's Qdrant does not start; search and indexing stay off.`;
  }
  // Older by more than one minor: the newest pinned release of every minor in between.
  const minorOf = (version: string): string => version.split('.').slice(0, 2).join('.');
  const newest = new Map<string, string>();
  for (const version of chain) if (minorOf(version) !== minorOf(target)) newest.set(minorOf(version), version);
  const between = [...newest.values()];
  return `This app's vector store is on Qdrant ${from}; this app ships ${target}, and Qdrant moves one minor at a time. ` +
    `Install the Neuralis release that ships Qdrant ${between.join(', then ')} first and start it once, then this one. ` +
    'Until then this app\'s Qdrant does not start; search and indexing stay off. Nothing was changed. ' +
    'If a Docker install set this data folder up, the record describes that install\'s store: run `neuralis qdrant-upgrade` in its folder instead.';
}

/** Before the bundle's Qdrant starts (none runs on this storage): what this start does with it. */
export async function prepareBundleQdrant(ports: BundleHopPorts, home: string, say: (line: string) => void, target: string = QDRANT_TARGET_VERSION): Promise<BundleHop> {
  let state;
  try {
    state = await readQdrantState(qdrantStatePath(home));
  } catch (err) {
    return { kind: 'refuse', reason: `${(err as Error).message} This app's Qdrant does not start; search and indexing stay off.` };
  }
  if (!state) return { kind: 'start' };
  const gap = assessQdrantGap(state.version, target);
  if (gap.kind === 'current') return { kind: 'start' };
  if (gap.kind === 'refuse') return { kind: 'refuse', reason: refusal(state.version, target, gap.message) };
  const from = state.version;
  const storageDir = join(home, 'qdrant-storage');
  const entries = await readdir(storageDir).catch(() => [] as string[]);
  if (entries.length === 0) return { kind: 'hop', from, target, backupDir: null };
  let dir: string | null = null;
  try {
    await checkDisk({ freeBytes: (d) => ports.freeBytes(d), log: () => {} }, await storageBytes(storageDir), home, 1, 'the cold copy of the vector store');
    dir = await createBackupDir(home, `${from}-to-${target}-${backupStamp(ports.now())}`);
    say(`This app's Qdrant moves from ${from} to ${target}, and Qdrant's storage only moves forward: copying ${storageDir} to ${dir} first, with Qdrant stopped. A large store takes a while.`);
    await tarStorageDir(ports, storageDir, join(dir, 'qdrant-storage.tar'));
    return { kind: 'hop', from, target, backupDir: dir };
  } catch (err) {
    if (dir) await rm(dir, { recursive: true, force: true });
    return { kind: 'refuse', reason: `Qdrant ${from} → ${target} needs a cold copy of ${storageDir} first: ${(err as Error).message} This app's Qdrant does not start; search and indexing stay off.` };
  }
}

/** After the hop's server answered: the record advances when it reports the bundle's version — the line to say. */
export async function recordBundleHop(ports: BundleHopPorts, home: string, hop: Extract<BundleHop, { kind: 'hop' }>, url: string, apiKey: string | undefined): Promise<string> {
  const running = await ports.serverVersion(url, apiKey);
  if (running !== hop.target) return `Qdrant answers ${running ?? 'no version'} where this app ships ${hop.target}; the recorded version stays ${hop.from}.`;
  try {
    await writeQdrantState(qdrantStatePath(home), { version: hop.target, previous: hop.from, source: 'upgrade', recordedAt: ports.now().toISOString() });
  } catch (err) {
    return `Qdrant runs ${hop.target}, but its record could not be written (${(err as Error).message}); the next start copies the store again.`;
  }
  return `Qdrant moved from ${hop.from} to ${hop.target}${hop.backupDir ? `; the copy of the store before it is in ${hop.backupDir}` : ''}.`;
}
