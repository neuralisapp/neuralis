/**
 * The Docker install's vectors copied into the desktop app's own Qdrant store
 * (`setup --native --yes --qdrant binary --copy-vectors`): a COLD copy of the
 * install's `<project>_qdrant-data` volume into `<home>/qdrant-storage`, with
 * the Qdrant upgrade's own primitives (`volumeBytes`, `coldTar`, the counts).
 *
 * The copy needs the same Qdrant version on both sides — the store's format is
 * forward-only, so a different version is refused and `neuralis qdrant-upgrade`
 * named. The Docker app must be stopped; the Docker Qdrant stops for the tar
 * (nothing may write while it is copied) and is started again through the one
 * vector-store starter (`ensureCompanion`) on every path. The Docker volume is
 * only ever read. The pass oracle: every collection's exact point count, read
 * from the Docker Qdrant before the stop, equals the count the bundle's binary
 * answers on the copy; a mismatch, or a check that fails, moves the copy aside
 * and names it. A Docker Qdrant that was down is waited for (`/readyz`) first.
 *
 * Cost: one-shot, proportional to the volume — a tar of it on the home's disk
 * (deleted after the extract) and the extracted store; twice the volume's size
 * must be free first. No timer survives the command.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, rename, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';

import { authoredBaseEnv } from '@neuralis/package-system/paths';
import { ensureCompanion, readComposeStack, type ComposeAnswer, type CompanionStart } from '../host-broker/helper.mts';
import type { QdrantPorts } from '../setup/envFile.mts';
import { qdrantImageRef } from '../setup/qdrantVersion.mts';
import { qdrantBinarySpawn } from '../setup/services.mts';
import { checkDisk, coldTar, HopDiedError, hostQdrantApi, listCollections, localTar, mustExec, processExec, readCollection, serverVersion, volumeBytes, waitReady, type Exec, type QdrantApi } from './upgrade.mts';

export type TransferPorts = {
  exec: Exec;
  freeBytes(dir: string): Promise<number>;
  log(line: string): void;
  /** The Docker install's Qdrant on the host loopback, with its key. */
  dockerApi: QdrantApi;
  /** The install folder's compose stack (`readComposeStack`, the one reader). */
  readStack(dir: string): Promise<ComposeAnswer>;
  /** Start the install's vector store when it is not running (`ensureCompanion`). */
  startVectorstore(dir: string): Promise<CompanionStart>;
  /** The bundle's Qdrant binary on `storageDir`, answering; stopped by the caller. */
  startBinary(storageDir: string): Promise<{ api: QdrantApi; stop(): Promise<void> }>;
  now(): Date;
};

export type TransferInput = {
  home: string;
  /** The Docker install's folder (compose cwd, no `-f`). */
  installDir: string;
  volume: string;
  /** The version the Docker store is on (`qdrant-version.json`). */
  recordedVersion: string | null;
  /** The bundle's Qdrant (`QDRANT_TARGET_VERSION`). */
  bundleVersion: string;
};

export type TransferPlan = { volume: string; image: string; bytes: number; free: number; storageDir: string };

export function transferStorageDir(home: string): string {
  return join(home, 'qdrant-storage');
}

/**
 * Everything checked before anything stops — the estimate the desktop app
 * shows, and the first step of the copy: the versions match, the home's store
 * is empty, the volume exists, twice its size is free on the home's disk.
 */
export async function planTransfer(ports: Pick<TransferPorts, 'exec' | 'freeBytes' | 'log'>, input: TransferInput): Promise<TransferPlan> {
  if (input.recordedVersion !== input.bundleVersion) {
    throw new Error(
      `The Docker vectors are on Qdrant ${input.recordedVersion ?? '(no recorded version)'} and this app's Qdrant is ${input.bundleVersion}; a store copies only between the same version. ` +
      `Run \`neuralis qdrant-upgrade\` in ${input.installDir} first, or keep Docker's Qdrant (the default). Nothing was changed.`,
    );
  }
  const storageDir = transferStorageDir(input.home);
  if (existsSync(storageDir) && readdirSync(storageDir).length > 0) {
    throw new Error(`${storageDir} already holds a Qdrant store; the copy never writes over one. Move it aside first. Nothing was changed.`);
  }
  const image = qdrantImageRef(input.bundleVersion);
  await mustExec(ports, ['volume', 'inspect', input.volume], `find the ${input.volume} volume — nothing was changed`);
  const bytes = await volumeBytes(ports, input.volume, image, true);
  const free = await ports.freeBytes(input.home);
  await checkDisk({ freeBytes: async () => free, log: ports.log }, bytes, input.home, 2, 'the copy of the Docker vectors');
  return { volume: input.volume, image, bytes, free, storageDir };
}

/** The local extract: owned by this user whatever the volume's owner was (`--no-same-owner`). */
export function extractArgs(tarFile: string, dest: string): string[] {
  return ['-C', dest, '--no-same-owner', '-xf', tarFile];
}

export type TransferResult = { bytes: number; collections: Record<string, number> };

export async function runTransfer(ports: TransferPorts, input: TransferInput): Promise<TransferResult> {
  const plan = await planTransfer(ports, input);
  const stack = await ports.readStack(input.installDir);
  if (stack.kind !== 'services' && stack.kind !== 'companions') {
    throw new Error(`The Docker install in ${input.installDir} cannot be read: ${stack.kind === 'no-docker' ? 'no Docker CLI on this machine' : stack.detail}. Nothing was changed.`);
  }
  if (stack.kind === 'services' && stack.running.includes(stack.app)) {
    throw new Error(`The Docker app runs: stop it first (\`docker compose -p ${stack.project} stop ${stack.app}\` in ${input.installDir}). Nothing was changed.`);
  }
  const service = stack.vectorstore;
  if (!service) throw new Error(`${input.installDir}/docker-compose.yml labels no vector store. Nothing was changed.`);

  // The counts come from the Docker Qdrant itself, before it stops.
  const started = await ports.startVectorstore(input.installDir);
  if (!started.ok) throw new Error(`The Docker Qdrant did not start: ${started.reason}. Nothing was changed.`);
  if (started.started) {
    try {
      await waitReady(READY, ports.dockerApi, `The Docker Qdrant (${started.service}), just started`);
    } catch (err) {
      throw new Error(`${err instanceof Error ? err.message : String(err)} Nothing was changed.`);
    }
  }
  const live = await serverVersion(ports.dockerApi);
  if (live !== input.bundleVersion) {
    throw new Error(`The Docker Qdrant runs ${live} and this app's Qdrant is ${input.bundleVersion}: run \`neuralis qdrant-upgrade\` in ${input.installDir} first. Nothing was changed.`);
  }
  const expected: Record<string, number> = {};
  for (const name of await listCollections(ports.dockerApi)) expected[name] = (await readCollection(ports.dockerApi, name)).points;
  ports.log(`Docker vectors: ${Object.entries(expected).map(([n, p]) => `${n}=${p}`).join(', ') || 'no collections'} (${Math.round(plan.bytes / 1e6)} MB)`);

  const staging = `${plan.storageDir}.copying`;
  const tarFile = `${plan.storageDir}.copy.tar`;
  try {
    await mustExec(ports, ['compose', '-p', stack.project, 'stop', service], `stop the Docker Qdrant (${service})`, { cwd: input.installDir });
    await coldTar(ports, plan.volume, plan.image, tarFile);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true, mode: 0o700 });
    await mustExec(ports, extractArgs(tarFile, staging), `unpack the copy into ${staging}`, undefined, localTar());
    await rm(plan.storageDir, { recursive: true, force: true });
    await rename(staging, plan.storageDir);
  } finally {
    await rm(tarFile, { force: true });
    await rm(staging, { recursive: true, force: true });
    const back = await ports.startVectorstore(input.installDir);
    ports.log(back.ok ? `the Docker Qdrant runs again (${back.service})` : `WARNING: the Docker Qdrant did not start again: ${back.reason}`);
  }

  // The oracle: the bundle's own binary on the copy answers the same counts.
  // Any failure from here moves the copy aside, so the next attempt finds an empty store.
  const got: Record<string, number> = {};
  let failure: string | null = null;
  try {
    const binary = await ports.startBinary(plan.storageDir);
    try {
      for (const name of await listCollections(binary.api)) got[name] = (await readCollection(binary.api, name)).points;
    } finally {
      await binary.stop();
    }
    const differs = [...new Set([...Object.keys(expected), ...Object.keys(got)])].filter((name) => expected[name] !== got[name]);
    if (differs.length > 0) failure = `The copy does not hold the Docker vectors (${differs.map((n) => `${n}: ${expected[n] ?? 'none'} → ${got[n] ?? 'none'}`).join(', ')})`;
  } catch (err) {
    failure = `The copy could not be checked: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (failure !== null) {
    const aside = `${plan.storageDir}.failed-${ports.now().toISOString().replace(/[:.]/g, '-')}`;
    await rename(plan.storageDir, aside);
    throw new Error(`${failure}; it was moved to ${aside}. The Docker store is untouched.`);
  }
  ports.log(`copied ${Object.keys(got).length} collection(s) into ${plan.storageDir}; every point count matches`);
  return { bytes: plan.bytes, collections: got };
}

/** How long a Qdrant just started (Docker's, or the bundle's binary on the copy) gets to answer `/readyz`. */
const READY = {
  timeouts: { readyMs: 120_000, pollMs: 500 },
  monotonicMs: () => performance.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

/**
 * The real ports: Docker through its CLI, the Docker Qdrant on its loopback
 * port with its key, and the bundle's binary on the copy — loopback, this
 * host's Qdrant ports and key, its authored environment — stopped after the
 * counts (SIGTERM, then SIGKILL after 30 s).
 */
export function processTransferPorts(input: {
  binary: string;
  apiKey: string;
  ports: QdrantPorts;
  docker: { url: string; apiKey: string };
  log: (line: string) => void;
}): TransferPorts {
  return {
    exec: processExec,
    freeBytes: async (dir) => {
      const fs = await statfs(dir);
      return fs.bavail * fs.bsize;
    },
    log: input.log,
    dockerApi: hostQdrantApi(input.docker.url, input.docker.apiKey),
    readStack: (dir) => readComposeStack(dir),
    startVectorstore: (dir) => ensureCompanion(dir, 'vectorstore'),
    async startBinary(storageDir) {
      const spec = qdrantBinarySpawn(storageDir, input.apiKey, input.ports, { ...authoredBaseEnv(process.platform, process.env), HOME: process.env.HOME });
      const child = spawn(input.binary, spec.args, { cwd: spec.cwd, env: spec.env, stdio: 'ignore', windowsHide: true });
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      const api = hostQdrantApi(`http://127.0.0.1:${input.ports.http}`, input.apiKey);
      const stop = async (): Promise<void> => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const kill = setTimeout(() => child.kill('SIGKILL'), 30_000);
        child.kill('SIGTERM');
        await exited;
        clearTimeout(kill);
      };
      const watched: QdrantApi = {
        ...api,
        request: async (method, path, body) => {
          if (child.exitCode !== null) throw new HopDiedError(`this app's Qdrant exited on the copy (exit ${child.exitCode})`);
          return api.request(method, path, body);
        },
      };
      try {
        await waitReady(READY, watched, 'this app\'s Qdrant on the copy');
      } catch (err) {
        await stop();
        throw err;
      }
      return { api, stop };
    },
    now: () => new Date(),
  };
}
