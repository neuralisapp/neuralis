#!/usr/bin/env node
/**
 * `neuralis upgrade` — the one command that raises a stored data format the app
 * never raises itself: a kind declared `upgrade: { mode: 'offline', id }`. A
 * build that meets such a kind behind its code version (or an upgrade left
 * half-done) refuses to start and names this command.
 *
 *   neuralis upgrade            dry run: what would change — writes nothing
 *   neuralis upgrade --apply    checkpoint, then upgrade (app STOPPED)
 *
 * A pulled image has no host folder; the same script is baked in:
 *
 *   docker compose stop neuralis
 *   docker compose run --rm --no-deps neuralis node bin/neuralis.mjs upgrade --apply
 *   docker compose up -d -V
 *
 * Both modes refuse while the app runs (`checkOffline`, the boundary a
 * checkpoint restore uses; a native install's proof is the same health probe),
 * and an apply inside a container refuses while `<home>/checkpoints` is not a
 * bind of the host's — a checkpoint in the writable layer is gone at `--rm`.
 * Each upgrade is ONE file under `scripts/upgrades/` whose default export
 * satisfies `OfflineUpgradeModule`; files run in name order and own disjoint
 * kinds. `--apply` order: every module's strict dry run → ONE checkpoint of the
 * union of their files plus the ledger (skipped when resuming) → ledger
 * `state: 'upgrading'` → each module's idempotent apply → state cleared LAST.
 * An interrupted run is resumed by running the same command again.
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveNeuralisHome } from '@neuralis/package-system/paths';
import {
  DATA_FORMAT_LEDGER_RELATIVE_PATH,
  createCheckpoint,
  listDataFormatDeclarations,
  markDataFormatUpgrade,
  pendingOfflineKinds,
  pruneCheckpoints,
  readDataFormatLedger,
  type OfflineUpgradeContext,
  type OfflineUpgradeKind,
  type OfflineUpgradeModule,
} from '@neuralis/package-system/data';
import { appPort, checkOffline, checkpointsArePersistent, composeProbe, httpProbe, type OfflineVerdict } from './checkpoint.mts';
import { CliExit, type CliContext } from './cli/registry.mts';
import { spell } from './cli/spelling.mts';
import { loadHostEnv } from './setup/detect.mts';
import { HOST_CONFIG_SETTINGS } from '../src/server/config/hostConfigSettings.ts';

export const UPGRADES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'upgrades');

export type DiscoveredUpgrade = { file: string; module: OfflineUpgradeModule };

function isModule(value: unknown): value is OfflineUpgradeModule {
  const m = value as Partial<OfflineUpgradeModule> | null;
  return Boolean(m) && typeof m!.id === 'string' && Array.isArray(m!.kinds) && typeof m!.dryRun === 'function' && typeof m!.apply === 'function';
}

/** File-first discovery: every `*.mts` under the directory, in name order. */
export async function loadUpgradeModules(dir: string): Promise<DiscoveredUpgrade[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith('.mts')).sort();
  const found: DiscoveredUpgrade[] = [];
  for (const file of files) {
    const loaded = (await import(pathToFileURL(join(dir, file)).href)) as { default?: unknown };
    if (!isModule(loaded.default)) throw new Error(`${file} does not default-export an offline upgrade module`);
    found.push({ file, module: loaded.default });
  }
  const ids = new Set<string>();
  const owners = new Map<string, string>();
  for (const { file, module } of found) {
    if (ids.has(module.id)) throw new Error(`Two upgrade modules share the id ${module.id}`);
    ids.add(module.id);
    for (const { kind } of module.kinds) {
      const owner = owners.get(kind);
      if (owner) throw new Error(`${kind} is claimed by two upgrade modules (${owner}, ${file})`);
      owners.set(kind, file);
    }
  }
  return found;
}

export type UpgradeSelection = { module: OfflineUpgradeModule; pending: OfflineUpgradeKind[]; resuming: boolean };

/**
 * Derive-and-verify against the kinds the loaded code declares: every pending
 * offline kind — behind its code version, mid-upgrade, or absent from a ledger
 * file that exists (a kind this install has never been through; the kernel's
 * ONE `pendingOfflineKinds` predicate, the boot claim's own) — must be raised by
 * exactly the ONE module its declaration names, to that version.
 */
function selectPendingUpgrades(
  modules: readonly DiscoveredUpgrade[],
  ledger: Awaited<ReturnType<typeof readDataFormatLedger>>,
  ledgerExisted: boolean,
): UpgradeSelection[] {
  const declarations = new Map(listDataFormatDeclarations().map((decl) => [decl.kind, decl]));
  for (const [kind, entry] of Object.entries(ledger)) {
    if (entry.state !== 'upgrading') continue;
    const owner = declarations.get(kind)?.upgrade?.id;
    if (!owner || !modules.some(({ module }) => module.id === owner)) throw new Error(`No upgrade module completes the half-done upgrade of ${kind}`);
  }
  for (const { file, module } of modules) {
    for (const { kind, to } of module.kinds) {
      const decl = declarations.get(kind);
      if (!decl || decl.upgrade?.id !== module.id || decl.version !== to) {
        throw new Error(`${file} raises ${kind} to v${to}, but this build declares ${decl ? `v${decl.version} (upgrade ${decl.upgrade?.id ?? 'none'})` : 'no such kind'}`);
      }
    }
  }
  for (const decl of declarations.values()) {
    const entry = ledger[decl.kind];
    if (entry && entry.version > decl.version) {
      throw new Error(`${decl.kind} is at v${entry.version} on disk but this build reads v${decl.version}: the data is newer than the code — start the build that wrote it, or go back with \`${spell('checkpoint restore <id>')}\``);
    }
  }
  const selected: UpgradeSelection[] = [];
  for (const { kind, to } of pendingOfflineKinds(ledger, ledgerExisted, declarations.values())) {
    const upgradeId = declarations.get(kind)!.upgrade!.id;
    const owners = modules.filter(({ module }) => module.id === upgradeId && module.kinds.some((k) => k.kind === kind));
    if (owners.length !== 1) throw new Error(`${kind} needs the ${upgradeId} upgrade module, found ${owners.length}`);
    const { module } = owners[0]!;
    let row = selected.find((s) => s.module === module);
    if (!row) selected.push(row = { module, pending: [], resuming: false });
    row.pending.push({ kind, to });
    if (ledger[kind]?.state === 'upgrading') row.resuming = true;
  }
  return modules.flatMap(({ module }) => selected.filter((s) => s.module === module));
}

export type UpgradeOptions = {
  apply: boolean;
  modulesDir: string;
  roots: { home: string; appRoot: string; projectsRoot: string };
  offline: () => Promise<OfflineVerdict>;
  log: (line: string) => void;
  /** Checkpoints kept after a completed apply (`dataCheckpointKeep`); absent ⇒ none pruned. */
  keepCheckpoints?: number;
};

/**
 * The `dataCheckpointKeep` retention from `platform.json`, inside the bounds
 * the host declares for it; an absent or out-of-range value is the declared
 * default. The checkpoints are this command's own (the app takes none).
 */
export function checkpointKeep(platform: Record<string, unknown>): number {
  const setting = HOST_CONFIG_SETTINGS.find((s) => s.key === 'dataCheckpointKeep');
  const fallback = typeof setting?.default === 'number' ? setting.default : 1;
  const value = platform.dataCheckpointKeep;
  const min = typeof setting?.min === 'number' ? setting.min : 1;
  const max = typeof setting?.max === 'number' ? setting.max : Number.MAX_SAFE_INTEGER;
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

async function readPlatformJson(appRoot: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(join(appRoot, 'config', 'platform.json'), 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export type UpgradeOutcome = { pending: string[]; applied: boolean; checkpoint?: string };

/** The apply's checkpoint line — the one place it is worded, and read back by `update --apply`. */
export function checkpointTakenLine(id: string): string {
  return `Checkpoint ${id} taken (\`${spell(`checkpoint restore ${id}`)}\` goes back to it).`;
}

/** The checkpoint id an `upgrade --apply` run printed; null when it took none (nothing pending, or a resumed run). */
export function checkpointFromUpgradeOutput(output: string): string | null {
  return /Checkpoint (\S+) taken \(/.exec(output)?.[1] ?? null;
}

export async function runUpgrade(opts: UpgradeOptions): Promise<UpgradeOutcome> {
  const verdict = await opts.offline();
  if (!verdict.offline) {
    throw new Error(`Refusing to upgrade: ${verdict.reason}. Stop the app first (\`docker compose stop neuralis\` in the host folder, or stop the process), then run this again.`);
  }
  const modules = await loadUpgradeModules(opts.modulesDir);
  const ledgerExisted = existsSync(join(opts.roots.appRoot, DATA_FORMAT_LEDGER_RELATIVE_PATH));
  const selection = selectPendingUpgrades(modules, await readDataFormatLedger(opts.roots.appRoot), ledgerExisted);
  const pending = selection.flatMap((s) => s.pending.map((k) => k.kind));
  if (selection.length === 0) {
    opts.log('Nothing to upgrade: every offline data format is current.');
    return { pending, applied: false };
  }
  const ctx: OfflineUpgradeContext = { ...opts.roots, log: opts.log };
  const files = new Set<string>();
  const blockers: string[] = [];
  const remedies = new Set<string>();
  for (const { module, pending: kinds, resuming } of selection) {
    opts.log(`${module.id}: ${kinds.map((k) => `${k.kind} → v${k.to}`).join(', ')}${resuming ? ' (resuming)' : ''}`);
    const plan = await module.dryRun(ctx);
    for (const line of plan.summary) opts.log(`  ${line}`);
    for (const file of plan.files) files.add(file);
    for (const line of plan.blockers?.lines ?? []) blockers.push(`${module.id}: ${line}`);
    if (plan.blockers?.lines.length) remedies.add(plan.blockers.remedy);
  }
  // Dry run or apply alike: the list first, then one verdict — before any checkpoint or ledger write.
  if (blockers.length > 0) {
    opts.log('Blocking (module: project · kind · file · field · reference · reason):');
    for (const line of blockers) opts.log(`  ${line}`);
    throw new Error(`${blockers.length} blocking item(s) above: ${[...remedies].join('; ')}.`);
  }
  if (!opts.apply) {
    opts.log('Dry run — nothing was changed. Re-run with --apply to upgrade.');
    return { pending, applied: false };
  }
  let checkpoint: string | undefined;
  // A resumed run keeps the first run's checkpoint: it is the point before any write.
  if (!selection.some((s) => s.resuming)) {
    files.add(relative(opts.roots.home, join(opts.roots.appRoot, DATA_FORMAT_LEDGER_RELATIVE_PATH)));
    checkpoint = (await createCheckpoint(opts.roots.home, { label: `upgrade-${selection.map((s) => s.module.id).join('-')}`, files: [...files] })).id;
    opts.log(checkpointTakenLine(checkpoint));
  }
  const kinds = selection.flatMap((s) => s.pending);
  await markDataFormatUpgrade(opts.roots.appRoot, kinds, 'begin');
  for (const { module } of selection) {
    await module.apply(ctx);
    opts.log(`${module.id}: applied.`);
  }
  await markDataFormatUpgrade(opts.roots.appRoot, kinds, 'complete');
  if (opts.keepCheckpoints !== undefined) {
    const pruned = await pruneCheckpoints(opts.roots.home, opts.keepCheckpoints);
    if (pruned.length > 0) opts.log(`Pruned ${pruned.length} older checkpoint(s) (dataCheckpointKeep ${opts.keepCheckpoints}).`);
  }
  opts.log('Upgrade complete. Start this build (`docker compose up -d -V`).');
  return { pending, applied: true, ...(checkpoint ? { checkpoint } : {}) };
}

export async function run(argv: string[], ctx: CliContext): Promise<number> {
  const args = new Set(argv);
  const unknown = [...args].filter((arg) => arg !== '--apply' && arg !== '--dry-run');
  if (unknown.length > 0 || (args.has('--apply') && args.has('--dry-run'))) throw new CliExit(1, 'Usage: neuralis upgrade [--dry-run | --apply]');
  const installDir = ctx.installDir;
  await loadHostEnv(installDir);
  const roots = resolveNeuralisHome();
  const inContainer = existsSync('/.dockerenv');
  if (args.has('--apply') && !checkpointsArePersistent(roots.home, inContainer)) {
    throw new CliExit(1, `${join(roots.home, 'checkpoints')} is not a bind of the host's — a checkpoint taken here would vanish with this container`, [
      'Regenerate the compose file (it binds <NEURALIS_HOME>/checkpoints), or bind it for this one run:',
      'docker compose run --rm --no-deps -v <NEURALIS_HOME on the host>/checkpoints:/.neuralis/checkpoints neuralis node bin/neuralis.mjs upgrade --apply',
    ]);
  }
  await runUpgrade({
    apply: args.has('--apply'),
    modulesDir: UPGRADES_DIR,
    roots,
    offline: () => checkOffline(
      { appPort: appPort(), neuralisDir: installDir },
      { inContainer, http: httpProbe, composeRunning: composeProbe },
    ),
    log: (line) => console.log(`  ${line}`),
    keepCheckpoints: checkpointKeep(await readPlatformJson(roots.appRoot)),
  });
  return 0;
}
