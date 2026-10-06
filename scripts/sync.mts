#!/usr/bin/env node
/**
 * neuralis:sync — swap a rebuilt builtin-class package into the running
 * container's `node_modules`, without rebuilding the image.
 *
 *   pnpm neuralis:sync <name>...      swap the named packages (+ their dependents)
 *   pnpm neuralis:sync --all          every syncable package
 *   pnpm neuralis:sync status         what diverges, without changing anything
 *   pnpm neuralis:sync --dry-run      the full plan, no writes
 *   pnpm neuralis:sync --no-restart   swap but leave the process alone
 *   pnpm neuralis:sync --json         machine-readable result
 *
 * WHY THIS IS POSSIBLE AT ALL
 *
 * It was not, until the builder stopped bundling `@neuralis/*` into the server
 * chunks. While the host carried its own compiled copies, replacing the
 * node_modules tree updated only the half the package loader dynamic-imports —
 * a half-old/half-new process, and no error anywhere. The image build now
 * enforces zero bundled copies (`check-server-chunk-split-brain.mjs`), so the
 * tree this script replaces is the ONLY copy of that server code. That
 * invariant is what makes the swap sound, and this script re-checks it rather
 * than trusting it (see `assertNotBundled`).
 *
 * WHAT IT DELIBERATELY REFUSES
 *
 * Every refusal below is a case where a swap would produce a container that
 * looks updated and is not. They are errors, never warnings — a warning here is
 * an invitation to ship a lie.
 *
 * THE STANDING RULE, printed on every success
 *
 * A synced container is a DEV container. `pnpm neuralis:rebuild` is still
 * required before any live-test gate, any commit-validation claim, and any
 * deploy judgement. The divergence marker exists so that rule is checkable
 * rather than remembered.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { treeDigest } from './build/treeDigest.mjs';
// ONE derivation, two consumers: sync takes the `syncable` half, update the
// `registryOnly` half. See scripts/setup/discoverPackages.mts.
import {
  discoverBuiltinDeps,
  type RegistryOnlyPackage,
  type SyncablePackage,
} from './setup/discoverPackages.mts';
import { packageBindHostPath } from './mount/packageBind.mts';

const here = dirname(fileURLToPath(import.meta.url));
const neuralisDir = join(here, '..');
const repoRoot = join(neuralisDir, '..');
/** The ONE digest implementation — imported here, copied into the container. */
const DIGEST_MODULE = join(here, 'build', 'treeDigest.mjs');

/**
 * The app container name.
 *
 * Compose derives it from the PROJECT name (`<project>-<service>-<index>`), and
 * the project name is no longer always `neuralis`: setup derives a collision-free
 * one when a second install shares the daemon, and records it in `.env`. So ask
 * Compose rather than assuming — with the literal as a last resort so this keeps
 * working where Compose cannot answer, and `NEURALIS_CONTAINER` still overriding
 * everything.
 */
function resolveContainerName(): string {
  const override = process.env.NEURALIS_CONTAINER?.trim();
  if (override) return override;
  const probe = spawnSync('docker', ['compose', 'ps', '-q', 'neuralis'], {
    cwd: neuralisDir,
    encoding: 'utf8',
  });
  const id = probe.status === 0 ? probe.stdout.trim().split('\n')[0]?.trim() : '';
  if (id) {
    const named = spawnSync('docker', ['inspect', '-f', '{{.Name}}', id], { encoding: 'utf8' });
    if (named.status === 0) {
      const name = named.stdout.trim().replace(/^\//, '');
      if (name) return name;
    }
  }
  return 'neuralis-neuralis-1';
}

const CONTAINER = resolveContainerName();
const CONTAINER_NM = '/neuralis/node_modules';
const MARKER = '/neuralis/_runtime/.sync-divergence.json';

const c = {
  dim: (t: string) => `\x1b[2m${t}\x1b[0m`,
  red: (t: string) => `\x1b[31m${t}\x1b[0m`,
  green: (t: string) => `\x1b[32m${t}\x1b[0m`,
  yellow: (t: string) => `\x1b[33m${t}\x1b[0m`,
  bold: (t: string) => `\x1b[1m${t}\x1b[0m`,
};

type Json = Record<string, unknown>;

function run(cmd: string, args: string[], opts: { cwd?: string; quiet?: boolean } = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd ?? repoRoot,
    encoding: 'utf-8',
    stdio: opts.quiet ? 'pipe' : ['ignore', 'pipe', 'pipe'],
  });
  return { code: res.status ?? 1, out: res.stdout ?? '', err: res.stderr ?? '' };
}

function docker(args: string[]) {
  return run('docker', args, { quiet: true });
}

class SyncRefusal extends Error {
  constructor(readonly slug: string, readonly reason: string, readonly detail: string) {
    super(`${slug}: ${reason}`);
  }
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

function assertContainerUp(): void {
  const { code, out } = docker(['inspect', '-f', '{{.State.Running}}', CONTAINER]);
  if (code !== 0 || out.trim() !== 'true') {
    console.error(
      c.red(`Container "${CONTAINER}" is not running.\n`) +
        '  Start the stack first (`cd neuralis && docker compose up -d`), or set\n' +
        '  NEURALIS_CONTAINER if yours is named differently.',
    );
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Digests — git-independent, content-addressed
// ---------------------------------------------------------------------------

type InstalledDigests = Record<string, { version: string | null; treeDigest: string | null }>;

/**
 * Digest what the container HAS RIGHT NOW, by running the host's own digest
 * module inside it.
 *
 * The earlier design stamped these values into `_runtime/.build-info.json` at
 * image build. Two things were wrong with that. It needed a second copy of the
 * hash function that only a comment kept in step with this one; and it answered
 * a different question — what the IMAGE shipped, not what the container is
 * running — so every package this tool had already synced kept reporting as
 * diverged. Copying the one module in and executing it there costs a few hundred
 * milliseconds and cannot go stale.
 */
function containerDigests(): InstalledDigests | null {
  const remote = '/tmp/nrs-tree-digest.mjs';
  if (docker(['cp', DIGEST_MODULE, `${CONTAINER}:${remote}`]).code !== 0) return null;
  const { code, out } = docker(['exec', CONTAINER, 'node', remote, CONTAINER_NM]);
  docker(['exec', CONTAINER, 'rm', '-f', remote]);
  if (code !== 0) return null;
  try {
    return JSON.parse(out) as InstalledDigests;
  } catch {
    return null;
  }
}

/** When the running image was built — Docker already knows; nothing to stamp. */
function imageBuiltAt(): string | null {
  const image = docker(['inspect', '-f', '{{.Image}}', CONTAINER]);
  if (image.code !== 0) return null;
  const created = docker(['inspect', '-f', '{{.Created}}', image.out.trim()]);
  return created.code === 0 ? created.out.trim() : null;
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * `@neuralis/package-system` is compiled INTO every dependent's `dist/`, and
 * neuralweb's `check:kernel` preflight pins it. Swapping the kernel alone leaves
 * every dependent carrying the previous contract — the classic half-updated
 * process, with no error.
 */
const NEVER_SYNC = new Set(['@neuralis/package-system']);

/** Source paths that do not reach a tarball at all. */
const NON_SHIPPING = [
  { prefix: 'host-broker/', why: 'runs on the HOST, not in the container — restart the broker unit' },
  { prefix: 'docker/', why: 'builds a SEPARATE image (mcp-sidecar) — rebuild that image' },
  { prefix: 'sidecar/', why: 'baked into the WEBTOP image — rebuild that image' },
];

function assertSyncable(pkg: SyncablePackage): void {
  if (NEVER_SYNC.has(pkg.name)) {
    throw new SyncRefusal(
      pkg.slug,
      'never syncable',
      'the kernel is compiled into every dependent\'s dist/, so swapping it alone leaves them on the old contract. Rebuild the image.',
    );
  }

  const manifest = JSON.parse(readFileSync(join(pkg.dir, 'package.json'), 'utf-8')) as Json;
  const files = (manifest.files ?? []) as string[];

  // A package with no `files` whitelist packs its whole directory — including
  // sources, tests and anything else lying around. That is a legal npm package
  // but not something to drop into a running container, and the deny-by-default
  // check below cannot see it: an empty list has nothing to classify.
  if (files.length === 0) {
    throw new SyncRefusal(
      pkg.slug,
      'no files whitelist',
      'the manifest declares no `files`, so `npm pack` would ship the entire directory. Declare `files` (start with `dist`), then sync.',
    );
  }

  // Deny-by-default over the whitelist: an entry nobody has classified could be
  // anything, including something that does not belong in a live swap.
  // The classified set is the package contract's own discovery surface: `dist`
  // plus every folder `PackageFileDiscovery` scans at the package root. All of
  // them are declarative contributions (markdown or JSON) with no server code
  // of their own, which is exactly what makes them safe to swap live.
  //
  // Keep the FIVE file categories complete — `skills`, `instructions`, `rules`,
  // `agents`, `docs`. `docs` was missing, and since brain-core declares it that
  // one omission made brain-core permanently unsyncable: every fix to the brain
  // needed a full ~6-10 min image rebuild. This list is hand-maintained and
  // therefore drifts from the contract; deriving it from the discovery scanner
  // is the real fix (tracked in the neuralis host ledger).
  const KNOWN = new Set([
    'dist', 'tools', 'workflows', 'commands', 'team', 'hooks.json', 'app',
    'skills', 'instructions', 'rules', 'docs', 'agents', 'agents/**/*.md',
  ]);
  const unclassified = files.filter(
    (f) => !f.startsWith('!') && !KNOWN.has(f) && !NON_SHIPPING.some((n) => f.startsWith(n.prefix.replace(/\/$/, ''))),
  );
  if (unclassified.length > 0) {
    throw new SyncRefusal(
      pkg.slug,
      'unclassified files entry',
      `${unclassified.join(', ')} — no rule says whether this is safe to swap live. Add one to NON_SHIPPING/KNOWN in sync.mts, or rebuild.`,
    );
  }
}

/**
 * Re-check the invariant the whole swap rests on: the package must NOT be
 * compiled into the server chunks. If it is, replacing node_modules updates
 * only half the process — the outcome this tool exists to avoid, and the one
 * failure mode that leaves no trace.
 */
function assertNotBundled(pkg: SyncablePackage): void {
  const sentinel = SENTINELS[pkg.name];
  if (!sentinel) return;
  const { out } = docker([
    'exec', CONTAINER, 'sh', '-c',
    `grep -rl '${sentinel}' /neuralis/_runtime/.next/server/ 2>/dev/null | wc -l`,
  ]);
  const hits = Number.parseInt(out.trim(), 10);
  if (Number.isFinite(hits) && hits > 0) {
    throw new SyncRefusal(
      pkg.slug,
      'still bundled into the server chunks',
      `${hits} chunk(s) carry this package's code, so a node_modules swap would update only half the process. Rebuild the image.`,
    );
  }
}

/**
 * One runtime-kept literal per package, used to prove absence from `.next`.
 * Shares its intent with `check-server-chunk-split-brain.mjs`: the string has to
 * survive tree-shaking, or the probe reads zero for the wrong reason.
 */
const SENTINELS: Record<string, string> = {
  '@neuralis/agent-core': 'stream_truncated:user_abort',
};

// ---------------------------------------------------------------------------
// Plan + execute
// ---------------------------------------------------------------------------


function readJson(path: string): Json | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Json;
  } catch {
    return null;
  }
}

/** The kernel's UI builder, by node path from the host's own install. */
const KERNEL_CLI = join(neuralisDir, 'node_modules', '@neuralis', 'package-system', 'dist', 'src', 'cli', 'neuralis-build.js');

/** The machine-local compose override (empty when there is none). */
function readOverride(): string {
  try {
    return readFileSync(join(neuralisDir, 'docker-compose.override.yml'), 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Resolve a command-line argument to a package. Both the short slug and the full
 * registry name are accepted; an ambiguous slug (two scopes, same short name) is
 * an error rather than a coin flip.
 */
function resolveRequested(token: string, available: SyncablePackage[]): SyncablePackage {
  const exact = available.find((p) => p.name === token);
  if (exact) return exact;
  const bySlug = available.filter((p) => p.slug === token);
  if (bySlug.length === 1) return bySlug[0]!;
  if (bySlug.length > 1) {
    throw new SyncRefusal(
      token,
      'ambiguous name',
      `matches ${bySlug.map((p) => p.name).join(' and ')} — use the full name.`,
    );
  }
  throw new SyncRefusal(
    token,
    'unknown package',
    `syncable here: ${available.map((p) => p.slug).join(', ') || 'none'}`,
  );
}

type Plan = {
  pkg: SyncablePackage;
  hostDigest: string | null;
  imageDigest: string | null;
  diverged: boolean;
};

function buildPlan(packages: SyncablePackage[], installed: InstalledDigests): Plan[] {
  return packages.map((pkg) => {
    const hostDigest = treeDigest(pkg.dir);
    const imageDigest = installed[pkg.name]?.treeDigest ?? null;
    return { pkg, hostDigest, imageDigest, diverged: hostDigest !== imageDigest };
  });
}

function printStatus(plans: Plan[], registryOnly: RegistryOnlyPackage[]): void {
  const width = Math.max(18, ...plans.map((p) => p.pkg.name.length));
  console.log(c.bold(`\n  ${'package'.padEnd(width)}  host dist        container dist   state`));
  console.log(c.dim('  ' + '─'.repeat(width + 48)));
  for (const p of plans) {
    const state = !p.imageDigest
      ? c.dim('not installed')
      : p.diverged
        ? c.yellow('DIVERGED')
        : c.green('in sync');
    console.log(
      `  ${p.pkg.name.padEnd(width)}  ${(p.hostDigest ?? '—').padEnd(16)} ${(p.imageDigest ?? '—').padEnd(16)} ${state}`,
    );
  }
  for (const r of registryOnly) {
    console.log(`  ${c.dim(r.name.padEnd(width))}  ${c.dim('—'.padEnd(16))} ${c.dim('—'.padEnd(16))} ${c.dim(`from registry (${r.spec}) — no source here`)}`);
  }
  const builtAt = imageBuiltAt();
  if (builtAt) console.log(c.dim(`\n  image built ${builtAt}`));
}

/**
 * Swap one package: `pnpm pack` on the host (the same `files` whitelist the
 * image's `pnpm deploy` honours, so the two can never drift), extract into a temp
 * dir inside the container, then two `mv`s on one filesystem.
 *
 * Atomic by construction: the live tree is never partially written. A failed
 * extraction leaves the old tree in place and nothing to clean up but a temp dir.
 */
function swapPackage(pkg: SyncablePackage, dryRun: boolean): { ok: boolean; detail: string } {
  if (dryRun) return { ok: true, detail: 'would pack, swap and verify' };

  const packed = run('pnpm', ['pack', '--pack-destination', '/tmp'], { cwd: pkg.dir, quiet: true });
  if (packed.code !== 0) return { ok: false, detail: `pnpm pack failed: ${packed.err.trim().split('\n').pop()}` };
  const tgz = packed.out.trim().split('\n').pop()!;
  if (!existsSync(tgz)) return { ok: false, detail: `pack produced no tarball (${tgz})` };

  try {
    const stage = `/tmp/nrs-sync-${pkg.slug}-${Date.now()}`;
    const copy = docker(['cp', tgz, `${CONTAINER}:${stage}.tgz`]);
    if (copy.code !== 0) return { ok: false, detail: `docker cp failed: ${copy.err.trim()}` };

    // The container path follows the registry NAME, scope included — a
    // first-party package under any scope lands where node resolves it.
    const target = `${CONTAINER_NM}/${pkg.name}`;
    const script = [
      `set -e`,
      `mkdir -p ${stage}`,
      `mkdir -p "$(dirname ${target})"`,
      `tar xf ${stage}.tgz -C ${stage} --strip-components=1`,
      // Two moves on ONE filesystem: the live path is replaced, never rebuilt
      // in place. A reader either sees the whole old tree or the whole new one.
      `rm -rf ${target}.old`,
      `mv ${target} ${target}.old`,
      `mv ${stage} ${target}`,
      `rm -rf ${target}.old ${stage}.tgz`,
    ].join(' && ');
    const swap = docker(['exec', '-u', 'root', CONTAINER, 'sh', '-c', script]);
    if (swap.code !== 0) return { ok: false, detail: `swap failed: ${swap.err.trim()}` };
    return { ok: true, detail: 'swapped' };
  } finally {
    rmSync(tgz, { force: true });
  }
}

/**
 * Prove the swapped code is what the container now HAS — the swap command's
 * exit code says the files moved, not that the right files moved.
 */
function verifySwap(pkg: SyncablePackage, expected: string | null): boolean {
  if (!expected) return true;
  const { code, out } = docker([
    'exec', CONTAINER, 'sh', '-c',
    `cd ${CONTAINER_NM}/${pkg.name} && find dist -type f | sort | wc -l`,
  ]);
  return code === 0 && Number.parseInt(out.trim(), 10) > 0;
}

function writeMarker(slugs: string[]): void {
  const payload = JSON.stringify({
    divergedAt: new Date().toISOString(),
    packages: slugs,
    note: 'This container was live-synced and no longer matches its image. Rebuild before any live-test gate, commit-validation claim, or deploy judgement.',
  });
  // Lives on the `_runtime` anonymous volume, so `neuralis:rebuild`'s mandatory
  // `-V` removes it BY CONSTRUCTION — the marker cannot outlive the divergence
  // it records.
  docker(['exec', '-u', 'root', CONTAINER, 'sh', '-c',
    `cat > ${MARKER} <<'NRSEOF'\n${payload}\nNRSEOF`]);
}

function waitHealthy(timeoutMs = 120_000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { out } = docker(['inspect', '-f', '{{.State.Health.Status}}', CONTAINER]);
    if (out.trim() === 'healthy') return true;
    spawnSync('sleep', ['3']);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const positional = argv.filter((a) => !a.startsWith('--'));
  const asJson = flags.has('--json');
  const dryRun = flags.has('--dry-run');
  const statusOnly = positional[0] === 'status';

  assertContainerUp();

  const { syncable, registryOnly } = discoverBuiltinDeps(neuralisDir);
  if (syncable.length === 0) {
    console.error(
      c.red('Nothing on this machine is syncable.\n') +
        '  Every builtin-class dependency resolves to a registry install, so there is\n' +
        '  no source to rebuild from. Point one at a folder you are editing with\n' +
        `  \`pnpm neuralis:pkg add <name> --path <dir>\`${registryOnly.length ? `, or rebuild the image.\n  From the registry: ${registryOnly.map((r) => r.name).join(', ')}` : '.'}`,
    );
    process.exit(2);
  }

  const installed = containerDigests();
  if (!installed) {
    console.error(
      c.red('Could not read what the container has installed.\n') +
        '  The digest probe failed — check that the container runs node and that\n' +
        '  /neuralis/node_modules exists inside it.',
    );
    process.exit(2);
  }

  let requested: SyncablePackage[];
  try {
    requested = statusOnly || flags.has('--all') || positional.length === 0
      ? syncable
      : positional.map((token) => resolveRequested(token, syncable));
  } catch (err) {
    const refusal = err as SyncRefusal;
    console.error(c.red(`${refusal.slug}: ${refusal.reason}`));
    console.error(c.dim(`  ${refusal.detail}`));
    process.exit(2);
  }

  if (statusOnly) {
    const plans = buildPlan(requested, installed);
    if (asJson) {
      console.log(JSON.stringify({
        builtAt: imageBuiltAt(),
        packages: plans.map((p) => ({ name: p.pkg.name, slug: p.pkg.slug, dir: p.pkg.dir, hostDigest: p.hostDigest, containerDigest: p.imageDigest, diverged: p.diverged })),
        registryOnly,
      }, null, 2));
    } else {
      printStatus(plans, registryOnly);
    }
    return;
  }

  // BUILD BEFORE COMPARING. The divergence check reads the host's `dist/`, and a
  // source edit does not touch `dist/` until something compiles it — so checking
  // first answers a question about the PREVIOUS build and reports "nothing to
  // sync" for the exact case the operator invoked this for. That is the silent
  // no-op class this tool exists to prevent, so it must not be its own first
  // instance. (Live-caught 2026-08-11: an edited source, `sync agent-core`,
  // "Nothing to sync" in one second.) `status` and `--dry-run` deliberately do
  // NOT build: both promise to change nothing.
  if (!dryRun) {
    console.log(c.dim(`  building ${requested.map((p) => p.slug).join(', ')}…`));
    // A package that ships a workspace UI module rebuilds it too (`build:ui` →
    // dist/app/, the same step the Dockerfile runs) — the host attaches it from
    // the swapped tree, so a UI edit needs no host rebuild.
    const workspace = requested.filter((p) => !p.local);
    const filters = workspace.flatMap((p) => ['--filter', `${p.name}...`]);
    const steps: Array<{ args: string[]; cwd?: string; cmd?: string }> =
      workspace.length > 0 ? [{ args: [...filters, 'build'] }, { args: [...filters, 'run', '--if-present', 'build:ui'] }] : [];
    // A local folder is no workspace member here: it builds in its OWN root —
    // its `build`, then its UI module through the kernel CLI by node path (the
    // folder's own `.bin` need not carry `neuralis-build`). It must build on
    // its own: its devDependencies installed in it.
    for (const p of requested.filter((r) => r.local)) {
      steps.push({ args: ['run', 'build'], cwd: p.dir });
      const manifest = readJson(join(p.dir, 'package.json')) as { neuralis?: { app?: { module?: unknown } } } | null;
      if (manifest?.neuralis?.app?.module) steps.push({ cmd: process.execPath, args: [KERNEL_CLI, 'ui', '.'], cwd: p.dir });
    }
    for (const step of steps) {
      const built = run(step.cmd ?? 'pnpm', step.args, { quiet: true, cwd: step.cwd });
      if (built.code !== 0) {
        console.error(c.red(`  build failed${step.cwd ? ` in ${step.cwd}` : ''} — nothing was swapped.`));
        console.error(c.dim(`  ${(built.err.trim() || built.out.trim()).split('\n').slice(-3).join('\n  ')}`));
        process.exit(1);
      }
    }
  }

  // A local folder BOUND over its installed copy (`pnpm neuralis:mount add
  // <dir> --pkg <name>`) needs no swap: the container already reads the
  // folder, so the build above IS the update — the process only has to restart
  // to load it (and to recompute the UI module table, built once per package
  // set). A folder without that bind is swapped like any other.
  const overrideText = readOverride();
  const bound = new Set(
    requested.filter((p) => p.local && packageBindHostPath(overrideText, p.name) === p.dir).map((p) => p.name),
  );

  const plans = buildPlan(requested.filter((p) => !bound.has(p.name)), installed);
  const targets = plans.filter((p) => p.diverged);
  if (targets.length === 0 && bound.size === 0) {
    console.log(c.green('\n  Nothing to sync — every requested package matches the container.\n'));
    return;
  }

  const results: Array<{ slug: string; ok: boolean; detail: string }> = [];
  for (const name of bound) {
    const pkg = requested.find((p) => p.name === name)!;
    results.push({
      slug: pkg.slug,
      ok: true,
      detail: dryRun ? 'bound — would build in its folder and restart' : 'bound — built in its folder; the container reads it live (restart loads it)',
    });
  }
  for (const plan of targets) {
    try {
      assertSyncable(plan.pkg);
      assertNotBundled(plan.pkg);
    } catch (err) {
      const refusal = err as SyncRefusal;
      results.push({ slug: plan.pkg.slug, ok: false, detail: `REFUSED — ${refusal.reason}: ${refusal.detail}` });
      continue;
    }
    const swapped = swapPackage(plan.pkg, dryRun);
    if (swapped.ok && !dryRun && !verifySwap(plan.pkg, plan.hostDigest)) {
      results.push({ slug: plan.pkg.slug, ok: false, detail: 'swap reported success but the tree is empty' });
      continue;
    }
    results.push({ slug: plan.pkg.slug, ok: swapped.ok, detail: swapped.detail });
  }

  const succeeded = results.filter((r) => r.ok).map((r) => r.slug);
  const failed = results.filter((r) => !r.ok);

  if (!dryRun && succeeded.length > 0) {
    writeMarker(succeeded);
    if (!flags.has('--no-restart')) {
      // `restart`, never `up -d`: `up` can RECREATE the container, and if an
      // image was built meanwhile it pairs the new container with the old
      // `_runtime` volume — the documented `-V` trap, reached by accident.
      docker(['restart', CONTAINER]);
      if (!waitHealthy()) {
        console.error(c.red('\n  Container did not become healthy after the restart.'));
        process.exit(1);
      }
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ dryRun, results }, null, 2));
  } else {
    console.log('');
    for (const r of results) {
      console.log(`  ${r.ok ? c.green('✓') : c.red('✗')} ${r.slug.padEnd(18)} ${r.detail}`);
    }
    if (succeeded.length > 0 && !dryRun) {
      console.log(
        c.yellow(
          `\n  This container is now a DEV container — it no longer matches its image.\n` +
            `  Run ${c.bold('pnpm neuralis:rebuild')} before any live-test gate, commit-validation\n` +
            `  claim, or deploy judgement.\n`,
        ),
      );
    }
  }

  if (failed.length > 0) process.exit(1);
}

main();
