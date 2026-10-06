/**
 * Service management for Qdrant and Ollama.
 * Handles native Qdrant fallback and Ollama model pulls.
 */

import { execFileSync, execSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, chmod, mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { sha256File } from '../host-broker/helper.mts';
import { qdrantBinaryAsset } from './qdrantVersion.mts';

// ── Qdrant Binary ──────────────────────────────────────────────

/**
 * Download, VERIFY and unpack the pinned Qdrant release for this machine.
 * The version is the install's recorded one (`setup/qdrantVersion.mts`), never
 * `latest`: a floating binary would start whatever engine upstream shipped
 * last on storage an older one wrote. The tarball is checked against the
 * pinned sha256 BEFORE it is unpacked, and a mismatch installs nothing.
 * `destDir` receives the `qdrant` binary.
 */
export async function downloadQdrantBinary(destDir: string, version: string): Promise<string | null> {
  const info = qdrantBinaryAsset(version);
  if (!info) return null;

  await mkdir(destDir, { recursive: true });
  const tarPath = join(destDir, info.filename);

  try {
    await downloadFile(info.url, tarPath);
    const actual = sha256File(tarPath);
    if (actual !== info.sha256) {
      throw new Error(
        `Qdrant ${version} download failed verification: sha256 ${actual} is not the pinned ${info.sha256}. Nothing was installed.`,
      );
    }
    execFileSync('tar', ['xzf', tarPath, '-C', destDir], { stdio: 'pipe', timeout: 60_000 });
  } finally {
    await unlink(tarPath).catch(() => {});
  }

  const binaryPath = join(destDir, 'qdrant');
  await chmod(binaryPath, 0o755);
  return binaryPath;
}

/** On-prem: no phone-home. Qdrant reports anonymous usage upstream unless told not to. */
export const QDRANT_TELEMETRY_OFF = { QDRANT__TELEMETRY_DISABLED: 'true' } as const;

/**
 * How a native Qdrant is started on a storage dir. The storage path is the
 * config key `storage.storage_path`, set through its `QDRANT__STORAGE__STORAGE_PATH`
 * env form: the binary's CLI has no storage flag in any release of the chain
 * (clap refuses an unknown option, and the process exits at once). The key
 * rides the env too — never argv. `extraEnv` adds hop-only settings.
 * Telemetry is off on every start, setup's and the upgrade's alike.
 */
export function qdrantBinarySpawn(
  storageDir: string,
  apiKey: string | undefined,
  extraEnv: Record<string, string> = {},
): { args: string[]; env: NodeJS.ProcessEnv } {
  return {
    args: [],
    env: {
      ...process.env,
      QDRANT__STORAGE__STORAGE_PATH: storageDir,
      ...QDRANT_TELEMETRY_OFF,
      ...(apiKey ? { QDRANT__SERVICE__API_KEY: apiKey } : {}),
      ...extraEnv,
    },
  };
}

export async function startQdrantBinary(
  binDir: string,
  storageDir: string,
  apiKey?: string,
): Promise<boolean> {
  const binaryPath = join(binDir, 'qdrant');
  try { await access(binaryPath); } catch { return false; }

  await mkdir(storageDir, { recursive: true });

  // The key must be RESOLVED before this spawn (the caller passes it in):
  // a keyless native server with keyed clients is an outage, not a fallback.
  // A restart of an already-running binary is required for a key change —
  // the env only applies to the process it starts.
  const spec = qdrantBinarySpawn(storageDir, apiKey);
  const child = spawn(binaryPath, spec.args, { detached: true, stdio: 'ignore', env: spec.env });
  child.unref();

  // Write PID file for stop
  await writeFile(join(binDir, 'qdrant.pid'), String(child.pid), 'utf-8');
  return true;
}

export async function stopQdrantBinary(binDir: string): Promise<void> {
  try {
    const { readFile } = await import('node:fs/promises');
    const pid = (await readFile(join(binDir, 'qdrant.pid'), 'utf-8')).trim();
    process.kill(Number(pid), 'SIGTERM');
  } catch { /* not running */ }
}

// ── Ollama ─────────────────────────────────────────────────────

export function pullOllamaModel(model: string, url: string): boolean {
  try {
    // Use the Ollama API to pull
    execSync(
      `curl -sf -X POST ${url}/api/pull -d '{"name":"${model}"}' -o /dev/null`,
      { stdio: 'pipe', timeout: 300_000 },
    );
    return true;
  } catch {
    return false;
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
