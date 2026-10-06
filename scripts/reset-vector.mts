#!/usr/bin/env node
/**
 * neuralis reset:vector — Wipe the vector layer (Qdrant collections + lock).
 *
 * Intended for the one legitimate case where changing the embedding model is
 * required: the collection's vector dimension is immutable, so we must drop,
 * recreate, and resync. The prismatic-weaving-loom plan mandates a loud,
 * owner-authenticated entry point rather than silent fallbacks.
 *
 * Steps:
 *   1. Prompt owner email + password, verify against app/users/*.json (bcrypt).
 *   2. Drop every Qdrant collection matching the configured prefix.
 *   3. Delete embedding-lock.json so the next boot can write a fresh record.
 *   4. Optionally purge the sync sidecar cache under ~/.neuralis/projects/**.
 */

import { readdir, unlink, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { askLine, promptOwnerCredentials, verifyOwnerCredentials, type OwnerRecord } from './setup/ownerCheck.mts';
// EVERY Qdrant call below goes through this helper: `/collections` and
// `DELETE /collections/<name>` both require the `api-key` header on an
// authenticated instance, and a bare `fetch` here 401s — which the script
// swallows as "Qdrant error", so the documented rescue silently drops nothing.
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

async function main(): Promise<void> {
  console.log();
  console.log(`  ${c.cyan}${c.bold}── neuralis reset:vector ${'─'.repeat(32)}${c.reset}`);
  console.log();
  console.log(`  ${c.yellow}This will delete every Qdrant collection used by Neuralis and`);
  console.log(`  reset the embedding lock. brain:// content and its version history`);
  console.log(`  live only there and are LOST; connector-backed sources are re-embedded`);
  console.log(`  (and paid for) on their next sync.${c.reset}`);
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
    return;
  }
  console.log();

  // 2. Qdrant collection wipe.
  let dropped = 0;
  try {
    const collections = await qdrantListCollections(qdrantUrl);
    const targets = explicit
      ? collections.filter((n) => n === explicit)
      : collections.filter((n) => n.startsWith(`${prefix}_`) || n === prefix);

    if (targets.length === 0) {
      console.log(`  ${dot} No matching Qdrant collections found.`);
    }
    for (const name of targets) {
      await qdrantDeleteCollection(qdrantUrl, name);
      console.log(`  ${ok} Dropped Qdrant collection ${c.bold}${name}${c.reset}`);
      dropped++;
    }
  } catch (err) {
    console.log(`  ${fail} Qdrant error: ${(err as Error).message}`);
    console.log(`  ${dot} Continuing with lock/cache cleanup.`);
  }

  // 3. Delete embedding-lock.json.
  const lock = lockPath(home);
  if (existsSync(lock)) {
    await unlink(lock);
    console.log(`  ${ok} Removed ${c.bold}${lock}${c.reset}`);
  } else {
    console.log(`  ${dot} No lock file at ${lock}`);
  }

  // 4. Optional sidecar cache purge.
  const projects = projectsDir(home);
  if (existsSync(projects) && (await askYes('Also purge per-project sync caches (.brain-store)?', false))) {
    let purged = 0;
    const projectIds = (await readdir(projects)).filter(async (p) => {
      try { return (await stat(join(projects, p))).isDirectory(); } catch { return false; }
    });
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
  console.log(`  ${ok} Reset complete. ${c.dim}Dropped ${dropped} collection(s).${c.reset}`);
  console.log(`  ${dot} Next boot will write a fresh embedding-lock.json and re-sync.`);
  console.log();
}

main().catch((err) => {
  console.error(`\n  ${fail} ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
