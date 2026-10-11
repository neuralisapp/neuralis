#!/usr/bin/env node
/**
 * neuralis reset:vector — Wipe the vector layer (Qdrant collections + lock).
 *
 * Destructive store recovery with the app stopped. Model changes use the
 * online shadow rebuild; dense-only clearing preserves indexed content.
 *
 * Steps:
 *   1. Prompt owner email + password, verify against app/users/*.json (bcrypt).
 *   2. Drop every Qdrant collection matching the configured prefix.
 *   3. Delete embedding-lock.json so the next boot can write a fresh record.
 *   4. Optionally purge the sync sidecar cache under ~/.neuralis/projects/**.
 */

import { readdir, unlink, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readLock, resetOwnedCollections, StoreResetPartialError } from '@neuralis/brain-core';
import { appPort, checkOffline, composeProbe, httpProbe, type OfflineProbes } from './checkpoint.mts';
import type { CliContext } from './cli/registry.mts';
import { loadHostEnv } from './setup/detect.mts';
import { askLine, promptOwnerCredentials, verifyOwnerCredentials, type OwnerRecord } from './setup/ownerCheck.mts';
// EVERY Qdrant call below goes through this helper: `/collections` and
// `DELETE /collections/<name>` both require the `api-key` header on an
// authenticated instance. A list/delete error refuses lock/cache cleanup.
import { qdrantFetch } from '../src/server/config/qdrantFetch';

// ── ANSI ──────────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};
const ok = `${c.green}✓${c.reset}`;
const warn = `${c.yellow}⚠${c.reset}`;
const fail = `${c.red}✗${c.reset}`;
const dot = `${c.dim}·${c.reset}`;

// ── Paths ─────────────────────────────────────────────────────────

function resolveNeuralisHome(): string {
  return process.env.NEURALIS_HOME || join(process.env.HOME || '/root', '.neuralis');
}

function lockPath(home: string): string { return join(home, 'app', 'config', 'embedding-lock.json'); }
function projectsDir(home: string): string { return join(home, 'projects'); }

// ── Prompts ───────────────────────────────────────────────────────
// Each question opens and closes its own readline (`askLine`): an interface
// left open on stdin echoes the hidden password in clear.

async function askYes(prompt: string, def = false): Promise<boolean> {
  const suffix = def ? 'Y/n' : 'y/N';
  const raw = (await askLine(`${prompt} [${suffix}]`)).toLowerCase();
  if (!raw) return def;
  return raw.startsWith('y');
}

// ── Owner auth ────────────────────────────────────────────────────

async function verifyOwner(home: string): Promise<OwnerRecord> {
  const { email, password } = await promptOwnerCredentials();
  return verifyOwnerCredentials(home, email, password);
}

// ── Qdrant ────────────────────────────────────────────────────────

type QdrantCollections = { result: { collections: { name: string }[] } };

async function qdrantListCollections(url: string): Promise<string[]> {
  const res = await qdrantFetch(`${url}/collections`);
  if (!res.ok) throw new Error(`Qdrant ${url} responded ${res.status} on /collections`);
  const body = (await res.json()) as QdrantCollections;
  return body.result.collections.map((c) => c.name);
}

async function qdrantDeleteCollection(url: string, name: string): Promise<void> {
  const res = await qdrantFetch(`${url}/collections/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Qdrant DELETE ${name} failed: ${res.status}`);
  }
}

function resolveQdrantUrl(): string {
  return process.env.QDRANT_URL || 'http://localhost:6333';
}

function resolveCollectionPrefix(): string {
  return process.env.MCP_QDRANT_COLLECTION_PREFIX || 'neuralis_mcp';
}

function resolveExplicitCollection(): string | null {
  return process.env.MCP_QDRANT_COLLECTION || null;
}

// ── Main ──────────────────────────────────────────────────────────

/** Owner confirmation belongs to main; this operation additionally requires proven quiescence. */
export async function resetVectorStore(
  opts: { home: string; qdrantUrl: string; prefix: string; explicit: string | null; appPort: number; neuralisDir: string },
  probes: OfflineProbes,
  transport = { list: qdrantListCollections, drop: qdrantDeleteCollection },
): Promise<string[]> {
  const verdict = await checkOffline(opts, { ...probes, composeRunning: async cwd => {
    const answer = await probes.composeRunning(cwd);
    if (answer.kind === 'failed') throw new Error('Could not prove the compose application is stopped');
    return answer;
  } });
  if (!verdict.offline) throw new Error(`Stop the application before resetting: ${verdict.reason}`);
  const lock = await readLock(join(opts.home, 'app'));
  return resetOwnedCollections({
    list: () => transport.list(opts.qdrantUrl),
    drop: name => transport.drop(opts.qdrantUrl, name),
    cleanup: async () => {
      try { await unlink(lockPath(opts.home)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    },
  }, { prefix: opts.prefix, explicit: opts.explicit, lock });
}

export async function run(_argv: string[], ctx: CliContext): Promise<number> {
  const neuralisDir = ctx.installDir;
  await loadHostEnv(neuralisDir);
  console.log();
  console.log(`  ${c.cyan}${c.bold}── neuralis reset:vector ${'─'.repeat(32)}${c.reset}`);
  console.log();
  console.log(`  ${c.yellow}This will delete every Qdrant collection used by Neuralis and`);
  console.log(`  reset the embedding lock. brain:// content and its version history`);
  console.log(`  live only there and are LOST. Review journal files remain, but references`);
  console.log(`  to deleted content may become unresolved. Connector sources can be synced`);
  console.log(`  again; optional embedding incurs its configured costs.${c.reset}`);
  console.log();

  const home = resolveNeuralisHome();
  const qdrantUrl = resolveQdrantUrl();
  const prefix = resolveCollectionPrefix();
  const explicit = resolveExplicitCollection();

  console.log(`  ${dot} NEURALIS_HOME : ${c.bold}${home}${c.reset}`);
  console.log(`  ${dot} Qdrant URL    : ${c.bold}${qdrantUrl}${c.reset}`);
  console.log(`  ${dot} Collections   : ${c.bold}${explicit ?? `${prefix}_*`}${c.reset}`);
  console.log();

  // 1. Owner authentication.
  const owner = await verifyOwner(home);
  console.log(`  ${ok} Authenticated as ${c.bold}${owner.email}${c.reset}`);
  console.log();

  if (!(await askYes('Proceed with vector reset?', false))) {
    console.log(`  ${warn} Aborted.`);
    return 0;
  }
  console.log();

  // 2. Qdrant collection wipe.
  let dropped: string[];
  try {
    dropped = await resetVectorStore({ home, qdrantUrl, prefix, explicit, neuralisDir,
      appPort: appPort() }, {
      inContainer: existsSync('/.dockerenv'), http: httpProbe, composeRunning: composeProbe,
    });
    for (const name of dropped) {
      console.log(`  ${ok} Dropped Qdrant collection ${c.bold}${name}${c.reset}`);
    }
  } catch (err) {
    if (err instanceof StoreResetPartialError) {
      console.error(`  Dropped: ${err.dropped.join(', ') || '(none)'}. Retry remaining: ${err.remaining.join(', ')}.`);
    }
    throw err;
  }

  // 4. Optional sidecar cache purge.
  const projects = projectsDir(home);
  if (existsSync(projects) && (await askYes('Also purge per-project sync caches (.brain-store)?', false))) {
    let purged = 0;
    const entries = await readdir(projects, { withFileTypes: true });
    const projectIds = entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
    for (const pid of projectIds) {
      const cacheDir = join(projects, pid, 'data', 'brain-core', '.brain-store');
      if (existsSync(cacheDir)) {
        await rm(cacheDir, { recursive: true, force: true });
        console.log(`  ${ok} Purged ${c.bold}${cacheDir}${c.reset}`);
        purged++;
      }
    }
    if (purged === 0) console.log(`  ${dot} No sidecar caches found.`);
  }

  console.log();
  console.log(`  ${ok} Reset complete. ${c.dim}Dropped ${dropped.length} collection(s).${c.reset}`);
  console.log(`  ${dot} Restart the app, then explicitly sync connector sources as needed.`);
  console.log();
  return 0;
}
