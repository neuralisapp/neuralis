#!/usr/bin/env node
/**
 * `neuralis upgrade` — the one command that raises a stored data format the app
 * never raises itself: a kind declared `upgrade: { mode: 'offline', id }`. A
 * build that meets such a kind behind its code version (or an upgrade left
 * half-done) refuses to start and names this command.
 *
 *   neuralis upgrade            dry run: what would change — writes nothing
 *   neuralis upgrade --check    exit 12 when anything is pending, 0 when not — reads only the ledger
 *   neuralis upgrade --apply    checkpoint, then upgrade (app STOPPED)
 *
 * A pulled image has no host folder; the same script is baked in, and
 * `neuralis upgrade --apply` on an image-only folder runs it through
 * `docker compose run --rm --no-deps` of the app service (the verb row's
 * `onImage`, `cli/registry.mts`).
 *
 * Both modes refuse while the app runs (`checkOffline`, the boundary a
 * checkpoint restore uses; a native install's proof is the same health probe),
 * and an apply inside a container refuses while `<home>/checkpoints` is not a
 * bind of the host's — a checkpoint in the writable layer is gone at `--rm`.
 * Each upgrade is ONE file under `scripts/upgrades/` whose default export
 * satisfies `OfflineUpgradeModule`; files run in name order. A kind is raised by
 * the ONE module its declaration names — or, for a kind whose declaration is a
 * CHAIN, by one module per step, and the file order must be the chain order.
 * `--apply` order: every module's strict dry run → ONE checkpoint of the union
 * of their files plus the ledger (skipped when resuming) → ledger
 * `state: 'upgrading'` (with the `from` each kind starts at) → each module's
 * idempotent apply → state cleared LAST. An interrupted run is resumed by
 * running the same command again; it re-runs every step above that `from`.
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installKindOf, resolveNeuralisHome } from '@neuralis/package-system/paths';
import {
  DATA_FORMAT_LEDGER_RELATIVE_PATH,
  createCheckpoint,
  listDataFormatDeclarations,
  markDataFormatUpgrade,
  offlineUpgradeSteps,
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
    for (const { kind, to } of module.kinds) {
      // One module per (kind, target): a chained kind has one module per step.
      const owner = owners.get(`${kind}@${to}`);
      if (owner) throw new Error(`${kind} v${to} is claimed by two upgrade modules (${owner}, ${file})`);
      owners.set(`${kind}@${to}`, file);
    }
  }
  return found;
}

export type UpgradeSelection = { module: OfflineUpgradeModule; pending: OfflineUpgradeKind[]; resuming: boolean };

/** What the ledger records for one kind: its final target this run, and the version its data starts from. */
export type UpgradeMark = OfflineUpgradeKind & { from: number };

/**
 * Derive-and-verify against the kinds the loaded code declares: every pending
 * offline kind — behind its code version, mid-upgrade, or absent from a ledger
 * file that exists (a kind this install has never been through; the kernel's
 * ONE `pendingOfflineKinds` predicate, the boot claim's own) — is raised by every
 * step of its chain above the version its data holds, each step by exactly the
 * ONE module that step names, and the modules' file order is the chain order.
 */
function selectPendingUpgrades(
  modules: readonly DiscoveredUpgrade[],
  ledger: Awaited<ReturnType<typeof readDataFormatLedger>>,
  ledgerExisted: boolean,
): { selection: UpgradeSelection[]; marks: UpgradeMark[] } {
  const declarations = new Map(listDataFormatDeclarations().map((decl) => [decl.kind, decl]));
  for (const [kind, entry] of Object.entries(ledger)) {
    if (entry.state !== 'upgrading') continue;
    const decl = declarations.get(kind);
    if (!decl || offlineUpgradeSteps(decl).length === 0) throw new Error(`No upgrade module completes the half-done upgrade of ${kind}`);
  }
  const position = new Map(modules.map(({ module }, index) => [module.id, index]));
  for (const { file, module } of modules) {
    for (const { kind, to } of module.kinds) {
      const decl = declarations.get(kind);
      const steps = decl ? offlineUpgradeSteps(decl) : [];
      if (!decl || !steps.some((step) => step.id === module.id && step.to === to)) {
        const declared = steps.map((step) => `${step.id} → v${step.to}`).join(', ') || 'none';
        throw new Error(`${file} raises ${kind} to v${to}, but this build declares ${decl ? `v${decl.version} (upgrade ${declared})` : 'no such kind'}`);
      }
    }
  }
  for (const decl of declarations.values()) {
    const entry = ledger[decl.kind];
    if (entry && entry.version > decl.version) {
      throw new Error(`${decl.kind} is at v${entry.version} on disk but this build reads v${decl.version}: the data is newer than the code — start the build that wrote it, or go back with \`${spell('checkpoint restore <id>')}\``);
    }
    // The chain runs in file order, so the files must sort in chain order.
    const order = offlineUpgradeSteps(decl).map((step) => position.get(step.id)).filter((at): at is number => at !== undefined);
    if (order.some((at, i) => i > 0 && at < order[i - 1]!)) {
      throw new Error(`${decl.kind}: its upgrade chain (${offlineUpgradeSteps(decl).map((step) => step.id).join(' → ')}) must run in that order, but the module files sort differently`);
    }
  }
  const selected: UpgradeSelection[] = [];
  const marks: UpgradeMark[] = [];
  for (const { kind, from, to } of pendingOfflineKinds(ledger, ledgerExisted, declarations.values())) {
    marks.push({ kind, to, from });
    for (const step of offlineUpgradeSteps(declarations.get(kind)!).filter((s) => s.to > from)) {
      const owners = modules.filter(({ module }) => module.id === step.id && module.kinds.some((k) => k.kind === kind && k.to === step.to));
      if (owners.length !== 1) throw new Error(`${kind} needs the ${step.id} upgrade module, found ${owners.length}`);
      const { module } = owners[0]!;
      let row = selected.find((s) => s.module === module);
      if (!row) selected.push(row = { module, pending: [], resuming: false });
      row.pending.push({ kind, to: step.to });
      if (ledger[kind]?.state === 'upgrading') row.resuming = true;
    }
  }
  return { selection: modules.flatMap(({ module }) => selected.filter((s) => s.module === module)), marks };
}

export type UpgradeOptions = {
  apply: boolean;
  modulesDir: string;
  roots: { home: string; appRoot: string; projectsRoot: string };
  offline: () => Promise<OfflineVerdict>;
  log: (line: string) => void;
  /** Checkpoints kept after a completed apply (`dataCheckpointKeep`); absent ⇒ none pruned. */
  keepCheckpoints?: number;
  /** How this install's app is stopped and started — the desktop app's own host, or a Docker stack. */
  appRuns: 'native' | 'docker';
};

/** The stop and start an operator types for `appRuns`, in the upgrade's own words. */
export function appStopStart(appRuns: UpgradeOptions['appRuns']): { stop: string; start: string } {
  return appRuns === 'native'
    ? { stop: `quit the desktop app, or \`${spell('down')}\``, start: `\`${spell('up')}\`, or open the desktop app` }
    : { stop: '`docker compose stop neuralis` in the host folder, or stop the process', start: '`docker compose up -d -V`' };
}

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

/** `upgrade --check`'s answer when something is pending — the `neuralis up` contract's `UPGRADE_REQUIRED`. */
export const EXIT_UPGRADE_REQUIRED = 12;

/**
 * What an apply would raise, from the ledger and the loaded modules alone: no
 * offline gate, no module dry run (a dry run may read the vector store, which
 * is not running before a start), nothing written. Each line names a module and
 * the kinds it raises; the blockers are the apply's own dry run to list.
 */
export async function pendingUpgrades(modulesDir: string, appRoot: string): Promise<string[]> {
  const modules = await loadUpgradeModules(modulesDir);
  const ledgerExisted = existsSync(join(appRoot, DATA_FORMAT_LEDGER_RELATIVE_PATH));
  const { selection } = selectPendingUpgrades(modules, await readDataFormatLedger(appRoot), ledgerExisted);
  return selection.map(({ module, pending, resuming }) => `${module.id}: ${pending.map((k) => `${k.kind} → v${k.to}`).join(', ')}${resuming ? ' (resuming)' : ''}`);
}

/** The apply's checkpoint line — the one place it is worded, and read back by `update --apply`. */
export function checkpointTakenLine(id: string): string {
  return `Checkpoint ${id} taken (\`${spell(`checkpoint restore ${id}`)}\` goes back to it).`;
}

/** The checkpoint id an `upgrade --apply` run printed; null when it took none (nothing pending, or a resumed run). */
export function checkpointFromUpgradeOutput(output: string): string | null {
  return /Checkpoint (\S+) taken \(/.exec(output)?.[1] ?? null;
}

/** The line an apply prints when no data format was raised — a caller parsing the output reads it through `upgradeRaisedNothing`. */
const NOTHING_TO_UPGRADE = 'Nothing to upgrade: every offline data format is current.';

export function upgradeRaisedNothing(output: string): boolean {
  return output.includes(NOTHING_TO_UPGRADE);
}

export async function runUpgrade(opts: UpgradeOptions): Promise<UpgradeOutcome> {
  const verdict = await opts.offline();
  if (!verdict.offline) {
    throw new Error(`Refusing to upgrade: ${verdict.reason}. Stop the app first (${appStopStart(opts.appRuns).stop}), then run this again.`);
  }
  const modules = await loadUpgradeModules(opts.modulesDir);
  const ledgerExisted = existsSync(join(opts.roots.appRoot, DATA_FORMAT_LEDGER_RELATIVE_PATH));
  const { selection, marks } = selectPendingUpgrades(modules, await readDataFormatLedger(opts.roots.appRoot), ledgerExisted);
  const pending = marks.map((mark) => mark.kind);
  if (selection.length === 0) {
    opts.log(NOTHING_TO_UPGRADE);
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
  await markDataFormatUpgrade(opts.roots.appRoot, marks, 'begin');
  for (const { module } of selection) {
    await module.apply(ctx);
    opts.log(`${module.id}: applied.`);
  }
  await markDataFormatUpgrade(opts.roots.appRoot, marks, 'complete');
  if (opts.keepCheckpoints !== undefined) {
    const pruned = await pruneCheckpoints(opts.roots.home, opts.keepCheckpoints);
    if (pruned.length > 0) opts.log(`Pruned ${pruned.length} older checkpoint(s) (dataCheckpointKeep ${opts.keepCheckpoints}).`);
  }
  opts.log(`Upgrade complete. Start this build (${appStopStart(opts.appRuns).start}).`);
  return { pending, applied: true, ...(checkpoint ? { checkpoint } : {}) };
}

export async function run(argv: string[], ctx: CliContext): Promise<number> {
  const args = new Set(argv);
  const unknown = [...args].filter((arg) => arg !== '--apply' && arg !== '--dry-run' && arg !== '--check');
  if (unknown.length > 0 || ['--apply', '--dry-run', '--check'].filter((mode) => args.has(mode)).length > 1) throw new CliExit(1, 'Usage: neuralis upgrade [--dry-run | --check | --apply]');
  const installDir = ctx.installDir;
  await loadHostEnv(installDir);
  const roots = resolveNeuralisHome();
  if (args.has('--check')) {
    const pending = await pendingUpgrades(UPGRADES_DIR, roots.appRoot);
    if (pending.length === 0) {
      console.log(`  ${NOTHING_TO_UPGRADE}`);
      return 0;
    }
    console.log('  Pending (an apply would raise these):');
    for (const line of pending) console.log(`    ${line}`);
    console.log(`  With the app stopped: \`${spell('upgrade --apply')}\` (\`${spell('upgrade')}\` lists what blocks it first).`);
    return EXIT_UPGRADE_REQUIRED;
  }
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
    appRuns: installKindOf(installDir) === 'native' ? 'native' : 'docker',
  });
  return 0;
}
