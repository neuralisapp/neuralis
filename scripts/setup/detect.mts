/**
 * Environment auto-detection for Neuralis setup.
 * Checks: Docker, Qdrant, Ollama, platform, existing config, install mode.
 */

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { platform as osPlatform } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { resolveNeuralisHome } from '@neuralis/package-system/paths';
import { readEnvFile } from './envFile.mts';

/**
 * Stat /var/run/docker.sock and return its owning GID.
 *
 * Kept inline here (NOT imported from `../src/server/docker/socketGid`) because
 * this file is run by tsx under Node ESM, and cross-boundary TS imports from
 * Next.js-owned source trip `ERR_MODULE_NOT_FOUND` at runtime. The canonical
 * copy lives in `src/server/docker/socketGid.ts` for the host bundle; this is
 * the script-side mirror — ~10 lines, no drift risk.
 */
async function detectDockerSocketGid(): Promise<number | null> {
  try {
    const info = await stat('/var/run/docker.sock');
    return typeof info.gid === 'number' ? info.gid : null;
  } catch {
    return null;
  }
}

// ── Types ──────────────────────────────────────────────────────

export type Platform = 'linux' | 'macos' | 'windows' | 'wsl';

export type DetectedEnv = {
  platform: Platform;
  docker: boolean;
  dockerVersion: string | null;
  qdrant: { running: boolean; url: string; version: string | null };
  ollama: { running: boolean; url: string; models: string[] };
  neuralisHome: string;
  existingEnv: Record<string, string> | null;
  existingSetup: boolean; // has users/
  isClone: boolean;
  projectRoot: string; // repo root or cwd
  uid: number;
  gid: number;
  /**
   * GID that owns /var/run/docker.sock on the host. Used as a supplementary
   * group inside the neuralis container so the non-root app user can talk to
   * the bind-mounted Docker socket (machine-core spawns Webtop containers via
   * the socket). `null` on platforms where the socket is not a unix socket
   * we own (macOS Desktop, Windows) or when detection fails.
   */
  dockerGid: number | null;
};

// ── HTTP helper ────────────────────────────────────────────────

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

// ── Detectors ──────────────────────────────────────────────────

function detectPlatform(): Platform {
  const p = osPlatform();
  if (p === 'darwin') return 'macos';
  if (p === 'win32') return 'windows';
  // Check WSL
  try {
    const version = execSync('cat /proc/version 2>/dev/null', { encoding: 'utf-8' });
    if (/microsoft|wsl/i.test(version)) return 'wsl';
  } catch { /* not WSL */ }
  return 'linux';
}

function detectDocker(): { available: boolean; version: string | null } {
  try {
    const out = execSync('docker --version 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
    const match = out.match(/Docker version ([\d.]+)/);
    // Also check if Docker daemon is running
    execSync('docker info 2>/dev/null', { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' });
    return { available: true, version: match?.[1] ?? null };
  } catch {
    return { available: false, version: null };
  }
}

async function detectQdrant(url: string): Promise<{ running: boolean; version: string | null }> {
  try {
    const data = await httpGet(`${url}/healthz`);
    // Try to get version from /cluster/info or /
    let version: string | null = null;
    try {
      const info = await httpGet(url);
      const parsed = JSON.parse(info);
      version = parsed.version ?? null;
    } catch { /* ok */ }
    return { running: true, version };
  } catch {
    return { running: false, version: null };
  }
}

async function detectOllama(url: string): Promise<{ running: boolean; models: string[] }> {
  try {
    const data = await httpGet(`${url}/api/tags`);
    const parsed = JSON.parse(data);
    const models = (parsed.models ?? []).map((m: { name: string }) => m.name);
    return { running: true, models };
  } catch {
    return { running: false, models: [] };
  }
}

function resolveHome(): string {
  return resolveNeuralisHome().home;
}

async function detectExistingEnv(envPath: string): Promise<Record<string, string> | null> {
  try {
    const content = await readFile(envPath, 'utf-8');
    const parsed: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      parsed[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return Object.keys(parsed).length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export async function detectIsClone(cwd: string): Promise<boolean> {
  // Check cwd and parent (script may be called from neuralis/)
  if (await fileExists(join(cwd, 'pnpm-workspace.yaml'))) return true;
  if (await fileExists(join(cwd, '..', 'pnpm-workspace.yaml'))) return true;
  return false;
}

/**
 * Where `.env` and `docker-compose.yml` live: `--output` when given, the host
 * folder on the host (npm scaffold or source checkout), `NEURALIS_HOME`
 * inside a pulled container. Every operator
 * command that reads them asks this, never its own copy.
 */
export function resolveConfigDir(
  env: Pick<DetectedEnv, 'isClone' | 'projectRoot' | 'neuralisHome'>,
  outputOverride: string | null,
  inContainer = existsSync('/.dockerenv'),
): string {
  if (outputOverride) return outputOverride;
  return env.isClone || !inContainer ? env.projectRoot : env.neuralisHome;
}

/**
 * Fill `process.env` from the deployment's `.env` for a host-plane operator
 * command (the stores read their roots and the session secret through it). A
 * value already in the environment — the container's — wins.
 */
export async function loadHostEnv(neuralisDir: string): Promise<void> {
  const neuralisHome = resolveNeuralisHome().home;
  const configDir = resolveConfigDir({ isClone: await detectIsClone(neuralisDir), projectRoot: neuralisDir, neuralisHome }, null);
  for (const [key, value] of Object.entries(await readEnvFile(configDir))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function detectExistingSetup(neuralisHome: string): Promise<boolean> {
  // Check if users/ directory has any JSON files
  try {
    const usersDir = join(neuralisHome, 'app', 'users');
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(usersDir);
    return files.some(f => f.endsWith('.json'));
  } catch {
    return false;
  }
}

// ── Main detect ────────────────────────────────────────────────

export async function detectEnvironment(): Promise<DetectedEnv> {
  const platform = detectPlatform();
  const docker = detectDocker();
  const neuralisHome = resolveHome();
  const cwd = process.cwd();
  const isClone = await detectIsClone(cwd);
  const projectRoot = isClone ? cwd : cwd;
  const envPath = isClone
    ? join(projectRoot, '.env')
    : join(neuralisHome, '.env');

  const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
  const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';

  const [qdrant, ollama, existingEnv, existingSetup, dockerGid] = await Promise.all([
    detectQdrant(qdrantUrl),
    detectOllama(ollamaUrl),
    detectExistingEnv(envPath),
    detectExistingSetup(neuralisHome),
    detectDockerSocketGid(),
  ]);

  return {
    platform,
    docker: docker.available,
    dockerVersion: docker.version,
    qdrant: { running: qdrant.running, url: qdrantUrl, version: qdrant.version },
    ollama: { running: ollama.running, url: ollamaUrl, models: ollama.models },
    neuralisHome,
    existingEnv,
    existingSetup,
    isClone,
    projectRoot,
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
    dockerGid,
  };
}
