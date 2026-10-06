#!/usr/bin/env node
/**
 * neuralis:rebuild — the ONE-RULE rebuild + bounded self-cleanup (B3).
 *
 * Wraps the canonical dev rebuild so a source-checkout developer never has to
 * remember the exact incantation NOR let the Docker vhdx balloon:
 *
 *   0. Before the build, the compose file is regenerated (`pnpm neuralis:setup
 *      --compose-only`, idempotent, `.env`-preserving): the build's named
 *      contexts — one per local package (`file:` dependency of package.json),
 *      the exported build lock — and the private-registry `.npmrc` secret are
 *      DERIVED from this machine's state at that moment, so a `pkg add/remove`
 *      takes effect at the next rebuild with nothing else to run.
 *   1. `docker compose up -d --build -V` — run from `neuralis/` with NO `-f`.
 *      This is load-bearing (see .claude/skills/neuralis-docker): ANY `-f` (or a
 *      wrong cwd) makes Compose skip docker-compose.override.yml, so the stack
 *      comes up `healthy` but with ZERO mounts. Running from the neuralis dir with
 *      no `-f` is the only invocation that auto-merges the override. `-V`
 *      (--renew-anon-volumes) is mandatory while the --neuralis overlay declares
 *      anon volumes, else the fresh image is masked by stale _runtime/node_modules.
 *   1b. The managed MCP sidecar image (`neuralisapp/mcp-sidecar:dev`, agent-core
 *      `docker/mcp-sidecar/`) — built ONLY when there is a reason: the image is
 *      missing, or its `io.neuralis.sidecar.source-hash` label differs from the
 *      sha256 of that directory today. A matching label costs one line and no
 *      build. The context is the MONOREPO path (the agent-core tarball ships no
 *      `docker/`), so an installed tree skips the step by name. A failed sidecar
 *      build is never fatal: the app is up, and a managed-sidecar spawn answers
 *      `SIDECAR_IMAGE_MISSING` exactly as it did before this step existed.
 *   1c. After a green build, the build's report is copied out of the new
 *      container: the UI modules the build judged incompatible with this host
 *      are named, and — when local packages were built — the lock their own
 *      dependencies resolved to is kept in `<NEURALIS_HOME>/build/` for the next
 *      build, beside the sha256 of the tracked lock it was resolved over.
 *   2. After a GREEN build, reclaim what the rebuild orphaned — both prunes are
 *      inherently bounded and safe (they never touch a NAMED or an in-use volume):
 *        · `docker volume prune -f` (DEFAULT — no `--all`) removes only ANONYMOUS
 *          dangling volumes, i.e. exactly the previous container's orphaned
 *          _runtime + node_modules. Every NAMED volume is spared by construction:
 *          qdrant-data / ollama-data (attached anyway), the webtop profile volumes
 *          (`neuralis-machine-*`, named → survive for reuse, cf. B4a/B4b), and any
 *          OTHER project's named volumes. `--all` would be the dangerous form that
 *          also drops named volumes — never use it here. (Verified 2026-07-14: a
 *          label filter is WRONG — Compose does NOT label anon volumes, so the
 *          filter matches nothing and reclaims 0 B.)
 *        · First try `docker builder prune --all --max-used-space 35GB`, which preserves
 *          valuable warm cache while leaving headroom for Docker's GiB-vs-decimal and shared-record accounting.
 *          Then read `docker system df --format '{{json .}}'`: Docker Desktop's
 *          containerd snapshotter was live-proven on 2026-07-23 to retain 46.49 GB
 *          after that command and had previously grown to 63.3 GB. If reported
 *          Build Cache remains above 40 GB OR cannot be measured, run the hard
 *          fallback `docker builder prune --all -f`. The fallback removes only
 *          UNUSED build cache (never images, containers, or volumes), but
 *          intentionally accepts a cold next build rather than another full-disk
 *          incident. A normal cleanup run exits 0 only after a final measurement
 *          proves Build Cache is at or below 40 GB.
 *
 * This is a DEV convenience for the source/monorepo channel (it runs `--build`,
 * which only that channel ever does — an image-pull deploy never builds). The
 * durable prod cap is the daemon-level `builder.gc` config (B1) + the future
 * label-scoped watchdog (B6); this wrapper is the interim per-rebuild reclaim.
 *
 * Flags: `--no-prune` skips step 2; `--no-sidecar` skips step 1b; any other args are
 * forwarded to `up`.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256Dir } from './build/treeDigest.mjs';
import { homedir } from 'node:os';
import {
  composeProjectFromEnv,
  parseSha256sum,
  resolveInstalledSandboxer,
  sha256File,
  SANDBOXER_CONTAINER_PATH,
  SANDBOXER_SYSTEM_PATH,
  UNIT_NAME,
} from './host-broker/helper.mts';

// ── ANSI (house style) ────────────────────────────────────────────
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

/**
 * Preferred warm-cache target and post-prune hard trigger. `--max-used-space` is
 * not itself a reliable hard ceiling on Docker Desktop's containerd snapshotter,
 * so the measured fallback below owns enforcement.
 */
const BUILDER_WARM_TARGET = '35GB';
const BUILDER_HARD_LIMIT_DISPLAY = '40GB';
const BUILDER_HARD_LIMIT_BYTES = 40 * 1_000_000_000;

/** neuralis/ dir = parent of scripts/ — the ONE correct compose cwd. */
const neuralisDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Run a command, inheriting stdio (streams the build log live). */
function run(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: 'inherit' });
    child.on('error', (err) => {
      console.error(`  ${fail} failed to spawn ${cmd}: ${(err as Error).message}`);
      resolve(127);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** Run a command capturing stdout (for prune reclaim reporting). Non-throwing. */
function capture(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, opts);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => resolve({ code: 127, out, err: (e as Error).message }));
    child.on('close', (code) => resolve({ code: code ?? 1, out, err }));
  });
}

function reclaimedLine(out: string): string | null {
  const m = out.match(/Total reclaimed space:\s*(.+)/i);
  return m ? m[1].trim() : null;
}

function parseDockerBytes(value: string): number | null {
  const match = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*([kmgtp]?b)$/i);
  if (!match) return null;
  const powers: Record<string, number> = { b: 0, kb: 1, mb: 2, gb: 3, tb: 4, pb: 5 };
  const power = powers[match[2].toLowerCase()];
  return Number(match[1]) * 1000 ** power;
}

async function buildCacheSize(
  captureCommand: typeof capture = capture,
): Promise<{ bytes: number; display: string } | null> {
  const usage = await captureCommand('docker', ['system', 'df', '--format', '{{json .}}']);
  if (usage.code !== 0) return null;
  for (const line of usage.out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { Type?: string; Size?: string };
      if (row.Type !== 'Build Cache' || !row.Size) continue;
      const bytes = parseDockerBytes(row.Size);
      return bytes === null ? null : { bytes, display: row.Size };
    } catch {
      // Ignore non-JSON lines from older Docker versions.
    }
  }
  return null;
}

async function enforceBuilderCacheGuard(
  captureCommand: typeof capture = capture,
): Promise<boolean> {
  const bounded = await captureCommand('docker', [
    'builder',
    'prune',
    '--all',
    '-f',
    '--max-used-space',
    BUILDER_WARM_TARGET,
  ]);
  if (bounded.code === 0) {
    const reclaimed = reclaimedLine(bounded.out);
    console.log(
      `  ${ok} builder prune (all unused; warm-cache target ${BUILDER_WARM_TARGET})${
        reclaimed ? ` — reclaimed ${c.bold}${reclaimed}${c.reset}` : ''
      }`,
    );
  } else {
    console.log(
      `  ${warn} bounded builder prune failed: ${bounded.err.trim() || `exit ${bounded.code}`}`,
    );
  }

  const measured = await buildCacheSize(captureCommand);
  if (measured && measured.bytes <= BUILDER_HARD_LIMIT_BYTES) {
    console.log(
      `  ${ok} measured Build Cache ${c.bold}${measured.display}${c.reset} (at/below hard guard ${BUILDER_HARD_LIMIT_DISPLAY}).`,
    );
    return true;
  }

  if (measured) {
    console.log(
      `  ${warn} measured Build Cache ${c.bold}${measured.display}${c.reset} is still above hard guard ${BUILDER_HARD_LIMIT_DISPLAY}; pruning all UNUSED build cache.`,
    );
  } else {
    console.log(
      `  ${warn} could not measure Build Cache after bounded cleanup; pruning all UNUSED build cache before retrying the measurement.`,
    );
  }

  const hard = await captureCommand('docker', ['builder', 'prune', '--all', '-f']);
  if (hard.code !== 0) {
    console.log(
      `  ${fail} hard cache fallback failed: ${hard.err.trim() || `exit ${hard.code}`}`,
    );
    return false;
  }

  const reclaimed = reclaimedLine(hard.out);
  const after = await buildCacheSize(captureCommand);
  if (!after) {
    console.log(
      `  ${fail} hard cache fallback${
        reclaimed ? ` reclaimed ${c.bold}${reclaimed}${c.reset}, but` : ''
      } Build Cache could not be remeasured.`,
    );
    return false;
  }
  if (after.bytes > BUILDER_HARD_LIMIT_BYTES) {
    console.log(
      `  ${fail} hard cache fallback${
        reclaimed ? ` reclaimed ${c.bold}${reclaimed}${c.reset}, but` : ''
      } Build Cache is still ${c.bold}${after.display}${c.reset} (above ${BUILDER_HARD_LIMIT_DISPLAY}).`,
    );
    return false;
  }

  console.log(
    `  ${ok} hard cache fallback${
      reclaimed ? ` — reclaimed ${c.bold}${reclaimed}${c.reset}` : ''
    }; verified ${c.bold}${after.display}${c.reset} (at/below ${BUILDER_HARD_LIMIT_DISPLAY}).`,
  );
  return true;
}

/**
 * The image just rebuilt `nrs-sandboxer`; the HOST copy the broker executes did
 * not change. Say so, measured — a stale host helper passed every exit-code
 * probe for two weeks on the owner's box (2026-09-02) — and name the verb.
 * Only when a host plane is provisioned (secret file present); never fatal.
 */
async function reportHostHelperDrift(): Promise<void> {
  const home = process.env.NEURALIS_HOME?.trim() || join(homedir(), '.neuralis');
  if (!existsSync(join(home, 'host-broker', 'secret'))) return;
  const unitPath = join(
    process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'),
    'systemd', 'user', `${UNIT_NAME}.service`,
  );
  let unitText: string | null = null;
  try { unitText = readFileSync(unitPath, 'utf-8'); } catch { /* no unit */ }
  const helper = resolveInstalledSandboxer({
    unitText,
    envSandboxer: process.env.NEURALIS_HOST_BROKER_SANDBOXER,
    systemExists: existsSync(SANDBOXER_SYSTEM_PATH),
    homeDir: homedir(),
  });
  let envText: string | null = null;
  try { envText = readFileSync(join(neuralisDir, '.env'), 'utf-8'); } catch { /* fresh tree */ }
  const ps = await capture('docker', ['compose', '-p', composeProjectFromEnv(envText), 'ps', '-q', 'neuralis'], { cwd: neuralisDir });
  const id = ps.code === 0 ? ps.out.trim().split('\n')[0]?.trim() : '';
  if (!id) return;
  const sum = await capture('docker', ['exec', id, 'sha256sum', SANDBOXER_CONTAINER_PATH]);
  const imageSha = sum.code === 0 ? parseSha256sum(sum.out) : null;
  if (!imageSha) return;
  const installedSha = existsSync(helper.path) ? sha256File(helper.path) : null;
  if (installedSha === imageSha) {
    console.log(`  ${ok} host helper      : ${c.dim}${helper.path} matches the new image${c.reset}`);
    return;
  }
  console.log(
    `  ${warn} host helper      : ${c.yellow}${installedSha ? 'differs from' : 'missing —'} the new image's nrs-sandboxer` +
      ` — run ${c.bold}pnpm neuralis:host-broker upgrade${c.reset}${c.yellow} (the host broker never reloads on a rebuild)${c.reset}`,
  );
}

/** Where the image carries the build report (`neuralis/Dockerfile` step 4b). */
const BUILD_REPORT_CONTAINER_DIR = '/neuralis/_runtime/build';

/**
 * 1c. Copy the build report out of the new container: name every UI module the
 * build refused for this host, and keep the local packages' build lock for the
 * next build. Never fatal — the app is up either way.
 */
async function collectBuildReport(): Promise<void> {
  let envText: string | null = null;
  try { envText = readFileSync(join(neuralisDir, '.env'), 'utf-8'); } catch { /* fresh tree */ }
  const ps = await capture('docker', ['compose', '-p', composeProjectFromEnv(envText), 'ps', '-q', 'neuralis'], { cwd: neuralisDir });
  const id = ps.code === 0 ? ps.out.trim().split('\n')[0]?.trim() : '';
  if (!id) return;
  const scratch = mkdtempSync(join(tmpdir(), 'neuralis-build-report-'));
  try {
    const copied = await capture('docker', ['cp', `${id}:${BUILD_REPORT_CONTAINER_DIR}/.`, scratch]);
    if (copied.code !== 0) {
      console.log(`  ${warn} build report     : not readable from the new container (${copied.err.trim() || `exit ${copied.code}`})`);
      return;
    }
    try {
      const report = JSON.parse(readFileSync(join(scratch, 'ui-compat.json'), 'utf-8')) as {
        checked?: number;
        refused?: Array<{ packageId: string; reason: string }>;
      };
      const refused = report.refused ?? [];
      if (refused.length === 0) {
        console.log(`  ${ok} UI modules       : ${c.dim}${report.checked ?? 0} checked, none refused${c.reset}`);
      }
      for (const r of refused) {
        console.log(
          `  ${warn} UI module refused: ${c.bold}${r.packageId}${c.reset} (${r.reason}) — its widgets name the reason in place; ` +
            `its owner rebuilds it with neuralis-build ui against this host`,
        );
      }
    } catch {
      /* an image built before the report existed */
    }
    try {
      const report = JSON.parse(readFileSync(join(scratch, 'validate.json'), 'utf-8')) as {
        refused?: Array<{ packageId: string; errors: string[] }>;
      };
      for (const r of report.refused ?? []) {
        console.log(
          `  ${warn} package refused  : ${c.bold}${r.packageId}${c.reset} — the runtime will not load it (${r.errors.join('; ')}); ` +
            `the rest of the platform runs, Admin health names it`,
        );
      }
    } catch {
      /* an image built before the report existed */
    }
    const lock = join(scratch, 'pnpm-lock.yaml');
    const tracked = join(scratch, 'tracked-lock.sha256');
    if (existsSync(lock) && existsSync(tracked)) {
      const home = process.env.NEURALIS_HOME?.trim() || join(homedir(), '.neuralis');
      const dir = join(home, 'build');
      mkdirSync(dir, { recursive: true });
      // Lock first, hash last, each through a rename: a reader never pairs a new
      // hash with an old lock.
      for (const name of ['pnpm-lock.yaml', 'tracked-lock.sha256']) {
        const staged = join(dir, `.${name}.tmp`);
        writeFileSync(staged, readFileSync(join(scratch, name)));
        renameSync(staged, join(dir, name));
      }
      console.log(`  ${ok} build lock       : ${c.dim}local packages' resolution kept in ${dir} for the next build${c.reset}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The managed MCP sidecar image the host manager resolves (agent-core `lifecycle.ts`). */
const SIDECAR_IMAGE = 'neuralisapp/mcp-sidecar:dev';
const SIDECAR_SOURCE_HASH_LABEL = 'io.neuralis.sidecar.source-hash';
/** Monorepo path — the agent-core tarball `files` whitelist ships no `docker/`, so an installed tree has none. */
const sidecarContextDir = join(neuralisDir, '..', 'packages', 'agent-core', 'docker', 'mcp-sidecar');

/**
 * 1b. The sidecar image, only when there is a reason: missing, or its
 * source-hash label differs from the tree. Never fatal — the app runs without
 * it (a managed-sidecar spawn answers SIDECAR_IMAGE_MISSING, as before).
 */
async function ensureSidecarImage(): Promise<void> {
  if (!existsSync(join(sidecarContextDir, 'Dockerfile'))) {
    console.log(`  ${dot} sidecar image  : ${c.dim}skipped — no ${sidecarContextDir} (installed tree; the sidecar image is not distributed there yet)${c.reset}`);
    return;
  }
  const sourceHash = sha256Dir(sidecarContextDir);
  const inspect = await capture('docker', ['image', 'inspect', '--format', `{{ index .Config.Labels "${SIDECAR_SOURCE_HASH_LABEL}" }}`, SIDECAR_IMAGE]);
  const builtHash = inspect.code === 0 ? inspect.out.trim() : null;
  if (builtHash === sourceHash) {
    console.log(`  ${ok} sidecar image  : ${c.dim}${SIDECAR_IMAGE} up to date (source ${sourceHash.slice(0, 12)}) — not rebuilt${c.reset}`);
    return;
  }
  const reason = builtHash === null ? 'missing' : `source changed (${builtHash.slice(0, 12) || 'unlabelled'} → ${sourceHash.slice(0, 12)})`;
  console.log(`  ${dot} sidecar image  : ${c.bold}${SIDECAR_IMAGE}${c.reset} ${c.dim}${reason} — building${c.reset}`);
  const code = await run('docker', ['build', '-f', join(sidecarContextDir, 'Dockerfile'), '-t', SIDECAR_IMAGE, '--label', `${SIDECAR_SOURCE_HASH_LABEL}=${sourceHash}`, sidecarContextDir]);
  if (code !== 0) {
    console.log(`  ${warn} sidecar image build failed (exit ${code}) — the app is up; managed MCP sidecars stay unavailable until the build in ${sidecarContextDir}/Dockerfile succeeds.`);
    return;
  }
  console.log(`  ${ok} sidecar image  : ${SIDECAR_IMAGE} built (source ${sourceHash.slice(0, 12)})`);
}

/**
 * The build args the generated compose interpolates (monorepo channel):
 * `NEURALIS_VERSION` from the host package.json, `NEURALIS_REVISION` from the
 * checkout. Cosmetic — they label the image and the admin environment table —
 * so a value that cannot be read is left to the compose default, never fatal.
 */
async function buildIdentityEnv(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  try {
    const version = (JSON.parse(readFileSync(join(neuralisDir, 'package.json'), 'utf-8')) as { version?: unknown }).version;
    if (typeof version === 'string' && version) env.NEURALIS_VERSION = version;
  } catch {
    // An unreadable package.json fails the build itself a moment later.
  }
  const rev = await capture('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: neuralisDir });
  if (rev.code === 0 && rev.out.trim()) env.NEURALIS_REVISION = rev.out.trim();
  return env;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const noPrune = args.includes('--no-prune');
  const noSidecar = args.includes('--no-sidecar');
  const passThrough = args.filter((a) => a !== '--no-prune' && a !== '--no-sidecar');

  // Preflight: a machine-absolute file: specifier in the TRACKED lockfile means
  // a plain `pnpm install` ran while a local package's dep line existed — a
  // machine path in a tracked file, which the build's lock check would then
  // treat as the authority. Fail fast with the name and the fix.
  try {
    const lockfile = readFileSync(join(neuralisDir, '..', 'pnpm-lock.yaml'), 'utf-8');
    const contaminated = [...lockfile.matchAll(/specifier: (file:\/[^\n]*)/g)].map((m) => m[1]);
    if (contaminated.length > 0) {
      console.error(`  ${fail} pnpm-lock.yaml carries machine-absolute specifier(s):`);
      for (const spec of contaminated) console.error(`      ${spec}`);
      console.error(`      A plain \`pnpm install\` ran while a local package's dep line existed.`);
      console.error(`      Fix: ${c.bold}git checkout -- pnpm-lock.yaml${c.reset} (then use \`pnpm install --lockfile=false\` for dev deps).`);
      process.exit(1);
    }
  } catch {
    // No lockfile (installed tree) — nothing to preflight.
  }

  console.log();
  console.log(`  ${c.cyan}${c.bold}── neuralis:rebuild ${'─'.repeat(34)}${c.reset}`);
  console.log(`  ${dot} cwd            : ${c.bold}${neuralisDir}${c.reset} ${c.dim}(no -f → override auto-merges)${c.reset}`);
  console.log(`  ${dot} command        : ${c.bold}docker compose up -d --build -V${passThrough.length ? ' ' + passThrough.join(' ') : ''}${c.reset}`);
  console.log(`  ${dot} sidecar image  : ${noSidecar ? `${c.dim}skipped (--no-sidecar)${c.reset}` : `${c.bold}${SIDECAR_IMAGE}${c.reset} ${c.dim}only when missing or its source changed${c.reset}`}`);
  console.log(`  ${dot} compose        : ${c.bold}regenerated first${c.reset} ${c.dim}(build contexts + secret derived from package.json and .env)${c.reset}`);
  console.log(`  ${dot} post-cleanup   : ${noPrune ? `${c.dim}skipped (--no-prune)${c.reset}` : `${c.bold}anonymous-volume prune + measured builder guard (target ${BUILDER_WARM_TARGET}, hard ${BUILDER_HARD_LIMIT_DISPLAY})${c.reset}`}`);
  console.log();

  // 0. Re-derive the build inputs into the compose file (named contexts for the
  // local packages, the exported build lock, the `.npmrc` secret). A problem it
  // names — a vanished folder, a bad `.npmrc` — stops here, before Docker.
  const composeCode = await run('pnpm', ['run', '--silent', 'neuralis:setup', '--compose-only'], { cwd: neuralisDir });
  if (composeCode !== 0) {
    console.log();
    console.log(`  ${fail} compose regeneration failed (exit ${composeCode}) — nothing was built.`);
    process.exit(composeCode);
  }

  // 1. The ONE-RULE rebuild.
  const buildCode = await run('docker', ['compose', 'up', '-d', '--build', '-V', ...passThrough], {
    cwd: neuralisDir,
    env: await buildIdentityEnv(),
  });
  if (buildCode !== 0) {
    console.log();
    console.log(`  ${fail} rebuild failed (exit ${buildCode}) — skipping cleanup so nothing is reclaimed under a broken build.`);
    process.exit(buildCode);
  }
  console.log();
  console.log(`  ${ok} rebuild complete (exit 0).`);

  // 1b. The sidecar image, only when there is a reason.
  if (!noSidecar) await ensureSidecarImage();
  await collectBuildReport();
  await reportHostHelperDrift();

  if (noPrune) {
    console.log(`  ${dot} cleanup skipped.`);
    console.log();
    return;
  }

  // 2a. Orphaned ANONYMOUS volumes only (default prune, no `--all`): removes the
  // previous container's _runtime + node_modules churn, spares every named volume
  // (qdrant-data, webtop profiles, other projects) by construction.
  const vol = await capture('docker', ['volume', 'prune', '-f']);
  if (vol.code === 0) {
    const r = reclaimedLine(vol.out);
    console.log(`  ${ok} volume prune (anonymous dangling only)${r ? ` — reclaimed ${c.bold}${r}${c.reset}` : ''}`);
  } else {
    console.log(`  ${warn} volume prune skipped: ${vol.err.trim() || `exit ${vol.code}`}`);
  }

  // 2b. Bound the BuildKit cache and prove the hard postcondition.
  const cacheGuardPassed = await enforceBuilderCacheGuard();
  if (!cacheGuardPassed) {
    console.log();
    console.log(
      `  ${fail} rebuild succeeded, but cleanup could not prove Build Cache is at/below ${BUILDER_HARD_LIMIT_DISPLAY}.`,
    );
    console.log();
    process.exitCode = 1;
    return;
  }

  console.log();
  console.log(`  ${ok} done.`);
  console.log();
}

main().catch((err) => {
  console.error(`\n  ${fail} ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
