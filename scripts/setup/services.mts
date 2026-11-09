/**
 * Service management for Qdrant, Ollama and the pinned companion downloads.
 * Handles native Qdrant fallback, Ollama model pulls and verified downloads.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { createZstdDecompress } from 'node:zlib';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { authoredBaseEnv, tarCommand } from '@neuralis/package-system/paths';
import { sha256File } from '../host-broker/helper.mts';
import type { QdrantPorts } from './envFile.mts';
import { qdrantBinaryAsset, qdrantBinaryName } from './qdrantVersion.mts';

// ── Qdrant Binary ──────────────────────────────────────────────

/**
 * Download, VERIFY and unpack the pinned Qdrant release for this machine.
 * The version is the install's recorded one (`setup/qdrantVersion.mts`), never
 * `latest`: a floating binary would start whatever engine upstream shipped
 * last on storage an older one wrote. The archive is checked against the
 * pinned sha256 BEFORE it is unpacked, and a mismatch installs nothing.
 * `tar -xf` reads both upstream forms — the `.tar.gz` (GNU and BSD tar detect
 * the compression) and Windows' `.zip` (its System32 `tar` is bsdtar).
 * `destDir` receives the `qdrant` binary (`qdrant.exe` on Windows, where no
 * mode bit exists to set).
 */
export async function downloadQdrantBinary(destDir: string, version: string): Promise<string | null> {
  const info = qdrantBinaryAsset(version);
  if (!info) return null;

  await mkdir(destDir, { recursive: true });
  const archivePath = join(destDir, info.filename);

  try {
    await downloadFile(info.url, archivePath);
    const actual = sha256File(archivePath);
    if (actual !== info.sha256) {
      throw new Error(
        `Qdrant ${version} download failed verification: sha256 ${actual} is not the pinned ${info.sha256}. Nothing was installed.`,
      );
    }
    const tar = tarCommand(process.platform, process.env);
    if (!tar) throw new Error('SystemRoot is not set: the system tar.exe cannot be found. Nothing was installed.');
    execFileSync(tar, ['-xf', archivePath, '-C', destDir], { stdio: 'pipe', timeout: 60_000, windowsHide: true });
  } finally {
    await unlink(archivePath).catch(() => {});
  }

  const binaryPath = join(destDir, qdrantBinaryName());
  if (process.platform !== 'win32') await chmod(binaryPath, 0o755);
  return binaryPath;
}

/**
 * A child's environment built from nothing but `vars`. The one cast: the host's
 * `ProcessEnv` type (Next's global declarations) requires `NODE_ENV`, which an
 * authored child environment legitimately lacks.
 */
export function authoredEnv(vars: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return { ...vars } as NodeJS.ProcessEnv;
}

/** On-prem: no phone-home. Qdrant reports anonymous usage upstream unless told not to. */
export const QDRANT_TELEMETRY_OFF = { QDRANT__TELEMETRY_DISABLED: 'true' } as const;

/**
 * How a native Qdrant is started on a storage dir — the ENVIRONMENT IS
 * AUTHORED, never inherited: the caller's own environment (setup loads `.env`
 * into it; the desktop app's carries the login session) holds the session
 * secret and provider keys, and none of it is the vector store's business. The
 * child gets the caller's `base` — `authoredBaseEnv` (`PATH`; on Windows its
 * system keys) and `HOME`, never a guessed default — telemetry off and exactly
 * these settings: bound to `127.0.0.1` (REST and gRPC alike; the API key stays
 * the second wall), the install's two ports, the storage path and the key.
 * The storage path is the config key `storage.storage_path` in its
 * `QDRANT__STORAGE__STORAGE_PATH` env form: the binary's CLI has no storage flag in any release of the chain (clap
 * refuses an unknown option, and the process exits at once); the key rides the
 * env too — never argv. The working directory is the storage dir, so its
 * relative `snapshots/` and `.qdrant-initialized` land there, never in a
 * checkout or a read-only app bundle.
 */
export function qdrantBinarySpawn(
  storageDir: string,
  apiKey: string | undefined,
  ports: QdrantPorts,
  base: Readonly<Record<string, string | undefined>>,
): { args: string[]; env: NodeJS.ProcessEnv; cwd: string } {
  const kept = Object.fromEntries(Object.entries(base).filter((entry): entry is [string, string] => Boolean(entry[1])));
  return {
    args: [],
    cwd: storageDir,
    env: authoredEnv({
      ...kept,
      QDRANT__SERVICE__HOST: '127.0.0.1',
      QDRANT__SERVICE__HTTP_PORT: String(ports.http),
      QDRANT__SERVICE__GRPC_PORT: String(ports.grpc),
      QDRANT__STORAGE__STORAGE_PATH: storageDir,
      ...QDRANT_TELEMETRY_OFF,
      ...(apiKey ? { QDRANT__SERVICE__API_KEY: apiKey } : {}),
    }),
  };
}

export async function startQdrantBinary(
  binDir: string,
  storageDir: string,
  apiKey: string | undefined,
  ports: QdrantPorts,
): Promise<boolean> {
  const binaryPath = join(binDir, qdrantBinaryName());
  try { await access(binaryPath); } catch { return false; }

  await mkdir(storageDir, { recursive: true });

  // The key must be RESOLVED before this spawn (the caller passes it in):
  // a keyless native server with keyed clients is an outage, not a fallback.
  // A restart of an already-running binary is required for a key change —
  // the env only applies to the process it starts.
  const spec = qdrantBinarySpawn(storageDir, apiKey, ports, { ...authoredBaseEnv(process.platform, process.env), HOME: process.env.HOME });
  const child = spawn(binaryPath, spec.args, { detached: true, stdio: 'ignore', env: spec.env, cwd: spec.cwd, windowsHide: true });
  child.unref();

  // Write PID file for stop
  await writeFile(join(binDir, 'qdrant.pid'), String(child.pid), 'utf-8');
  return true;
}

/**
 * Stop the binary `startQdrantBinary` started, by its pid file (SIGTERM: Qdrant
 * flushes and exits). Never on Windows: a signal there is `TerminateProcess`,
 * and a recorded pid proves nothing about who holds that number now — the
 * desktop app's `neuralis up` owns its Qdrant and stops it (`neuralis down`).
 */
export async function stopQdrantBinary(binDir: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === 'win32') {
    throw new Error('On Windows a Qdrant is never stopped by its process id: stop the app that runs it (`neuralis down` for the desktop app), then run this again.');
  }
  try {
    const { readFile } = await import('node:fs/promises');
    const pid = (await readFile(join(binDir, 'qdrant.pid'), 'utf-8')).trim();
    process.kill(Number(pid), 'SIGTERM');
  } catch { /* not running */ }
}

// ── Ollama ─────────────────────────────────────────────────────

export type PullProgress = { status: string; completed?: number; total?: number };

/**
 * Pull `model` into the Ollama at `url` through its own API (`POST /api/pull`,
 * a stream of JSON lines) — no shell, no curl: the URL and the model name are
 * data, never a command line. `onProgress` sees each status line (the first
 * run shows the download). True when the stream ends with `success`.
 */
export async function pullOllamaModel(
  model: string,
  url: string,
  onProgress: (progress: PullProgress) => void = () => {},
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  let response: Response;
  try {
    response = await fetchImpl(new URL('/api/pull', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      redirect: 'error',
    });
  } catch {
    return false;
  }
  if (!response.ok || !response.body) return false;
  const decoder = new TextDecoder();
  let buffered = '';
  let last = '';
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
      if (!line) continue;
      try {
        const frame = JSON.parse(line) as { status?: unknown; completed?: unknown; total?: unknown; error?: unknown };
        if (typeof frame.error === 'string') return false;
        if (typeof frame.status !== 'string') continue;
        last = frame.status;
        onProgress({
          status: frame.status,
          ...(typeof frame.completed === 'number' ? { completed: frame.completed } : {}),
          ...(typeof frame.total === 'number' ? { total: frame.total } : {}),
        });
      } catch {
        // Not a JSON line: skipped.
      }
    }
  }
  return last === 'success';
}

/** Does an Ollama answer at `url` (`GET /api/version`, bounded)? */
export async function ollamaAnswers(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    return (await fetchImpl(new URL('/api/version', url), { signal: AbortSignal.timeout(2_000), redirect: 'error' })).ok;
  } catch {
    return false;
  }
}

// ── Pinned downloads (Ollama, cloudflared) ─────────────────────

/**
 * Download `asset` into `destDir`, VERIFY its pinned sha256 before anything is
 * unpacked or made executable, then unpack it: a bare executable is renamed to
 * `executable`; a `.tgz`/`.zip` goes through the system tar (bsdtar on Windows);
 * a `.tar.zst` is decompressed by Node's own zstd first (no `zstd` program is
 * assumed). A mismatch installs nothing and removes the download.
 */
export async function downloadPinned(
  asset: { url: string; filename: string; sha256: string; unpack: 'raw' | 'tgz' | 'zip' | 'tar.zst' },
  destDir: string,
  executable: string | null,
): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const archivePath = join(destDir, `${asset.filename}.part`);
  try {
    await downloadFile(asset.url, archivePath);
    // Streamed: an Ollama archive is ≈1.5 GB, never read into memory whole.
    const hash = createHash('sha256');
    await pipeline(createReadStream(archivePath), hash);
    const actual = hash.digest('hex');
    if (actual !== asset.sha256) {
      throw new Error(`${asset.filename} failed verification: sha256 ${actual} is not the pinned ${asset.sha256}. Nothing was installed.`);
    }
    if (asset.unpack === 'raw') {
      if (!executable) throw new Error(`${asset.filename} is a bare executable: name where it goes.`);
      await rename(archivePath, executable);
      if (process.platform !== 'win32') await chmod(executable, 0o755);
      return;
    }
    let tarInput = archivePath;
    if (asset.unpack === 'tar.zst') {
      tarInput = join(destDir, `${asset.filename}.tar`);
      await pipeline(createReadStream(archivePath), createZstdDecompress(), createWriteStream(tarInput));
    }
    const tar = tarCommand(process.platform, process.env);
    if (!tar) throw new Error('SystemRoot is not set: the system tar.exe cannot be found. Nothing was installed.');
    try {
      execFileSync(tar, ['-xf', tarInput, '-C', destDir], { stdio: 'pipe', timeout: 600_000, windowsHide: true });
    } finally {
      if (tarInput !== archivePath) await unlink(tarInput).catch(() => {});
    }
  } finally {
    await unlink(archivePath).catch(() => {});
  }
}

// ── Qdrant Health Check (with retry) ───────────────────────────

export async function waitForQdrant(url: string, maxRetries = 15, intervalMs = 1000): Promise<boolean> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await httpGet(`${url}/healthz`, 2000);
      return true;
    } catch {
      await sleep(intervalMs);
    }
  }
  return false;
}

// ── Helpers ────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function httpGet(url: string, timeoutMs = 3000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const get = url.startsWith('https') ? https.get : http.get;

    get(url, (res) => {
      // Follow redirects
      if (res.statusCode === 301 || res.statusCode === 302) {
        const location = res.headers.location;
        if (!location) return reject(new Error('Redirect without location'));
        file.close();
        return downloadFile(location, dest).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        res.resume();
        return reject(new Error(`GET ${url} answered ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => { file.close(); reject(err); });
  });
}
