/**
 * `neuralis convert` — the destructive half of the one-shot move of a 0.1.0
 * install folder (the host tarball unpacked in place) to the npm layout (a
 * folder whose `package.json` depends on `neuralis`). A stored-layout change is
 * an OFFLINE one-shot on a stopped app, never a runtime "detect the old layout"
 * arm; nothing in the platform reads the old layout after this.
 *
 *   npx --yes create-neuralis@<v> convert <dir>    the entry point: records the
 *       old manifest, lock and tarball entry list under `.neuralis-convert/`,
 *       writes the new `package.json` (the old one's operator lines carried
 *       verbatim), runs `npm install`, then execs the INSTALLED
 *       `neuralis convert --from <old>` — this module; when that stops before
 *       its checkpoint, the scaffolder puts the folder back as it found it.
 *   neuralis convert --from <old>       app stopped (`checkOffline`): the old
 *       entries still in the folder go into ONE archive inside the record
 *       (`tree.tgz`, its listing checked against them), ONE checkpoint of the
 *       record, then delete exactly the old tarball's entries (never `.env`,
 *       `.npmrc`, the compose files or anything the listing does not name), then
 *       the record. Re-running resumes; a folder with no record is already converted.
 *   neuralis convert --rollback <id>    app stopped: put the checkpoint back,
 *       unpack its archive and the old `package.json`/lock in place;
 *       `rm -rf node_modules && npm install` then reinstalls the old tree.
 *
 * The checkpoint lives in the install folder (`checkpoints/<id>/`) because what
 * it holds is the folder's own code, not data under `NEURALIS_HOME`. The old
 * tree rides in an archive, not as checkpoint entries, because a Next.js host
 * ships catch-all route files (`src/app/api/packages/[...path]/route.ts`): the
 * kernel checkpoint refuses any path segment holding `..`, a traversal floor
 * this command does not get to relax. The archive is byte-exact (an operator's
 * edit to a shipped file comes back too) and needs no registry to restore.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { createCheckpoint, listCheckpoints, restoreCheckpoint } from '@neuralis/package-system/data';
import { appPort, checkOffline, composeProbe, httpProbe } from './checkpoint.mts';
import { CliExit, type CliContext } from './cli/registry.mts';
import { loadHostEnv } from './setup/detect.mts';
import { unitFilePath } from './host-broker/helper.mts';

/** Written by `create-neuralis convert`; its presence means "not converted yet". */
export const CONVERT_RECORD_DIR = '.neuralis-convert';
/** The old tree's entries, archived inside the record before anything is deleted. */
export const TREE_ARCHIVE = 'tree.tgz';
/** Every convert checkpoint's label starts with this; rollback restores nothing else. */
const CONVERT_LABEL_PREFIX = 'convert-from-';

export type ConvertRecord = { from: string; to: string; entries: string[]; checkpoint?: string };

const USAGE = 'usage: neuralis convert --from <old version> | --rollback <checkpoint id>';

function readRecord(installDir: string): ConvertRecord | null {
  const file = join(installDir, CONVERT_RECORD_DIR, 'from.json');
  if (!existsSync(file)) return null;
  const record = JSON.parse(readFileSync(file, 'utf-8')) as Partial<ConvertRecord>;
  if (typeof record.from !== 'string' || typeof record.to !== 'string' || !Array.isArray(record.entries) || !record.entries.every((e) => typeof e === 'string')) {
    throw new CliExit(1, `${join(installDir, CONVERT_RECORD_DIR, 'from.json')} is not a convert record`, ['Re-run `npx --yes create-neuralis@<version> convert .`.']);
  }
  assertEntriesInside(record.entries);
  return record as ConvertRecord;
}

/**
 * Every entry is a relative path inside the folder. The listing is read from the
 * operator's registry (`npm pack --dry-run --json`), so an absolute path or a `..`
 * segment is refused before anything is checkpointed or deleted.
 */
export function assertEntriesInside(entries: readonly string[]): void {
  const outside = entries.filter((entry) => entry === '' || isAbsolute(entry) || entry.split(/[\\/]/).includes('..'));
  if (outside.length > 0) {
    throw new CliExit(1, `the convert record names ${outside.length} entr${outside.length === 1 ? 'y' : 'ies'} outside the install folder (first: ${JSON.stringify(outside[0])}) — nothing was deleted`, ['Re-run `npx --yes create-neuralis@<version> convert .` against the registry the 0.1.0 package came from.']);
  }
}

/**
 * A folder that was BUILT natively (`.next/` — the image channel never writes it
 * there) starts from the host code this command deletes; it moves to a clone instead.
 */
function refuseNativeRun(installDir: string): void {
  if (!existsSync(join(installDir, '.next'))) return;
  throw new CliExit(1, `${installDir} was run natively (it has a .next/ build) — convert moves Docker-run folders only. Nothing was deleted.`, [
    `Put the old manifest back: mv ${CONVERT_RECORD_DIR}/package.json package.json (and ${CONVERT_RECORD_DIR}/package-lock.json), then rm -rf node_modules ${CONVERT_RECORD_DIR} && npm install.`,
    'A native install moves to a source clone: `git clone https://github.com/neuralisapp/neuralis`, copy this folder\'s .env into the clone, then build and start there. The data under NEURALIS_HOME is untouched.',
  ]);
}

function assertNpmFolder(installDir: string): void {
  const manifest = JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf-8')) as { dependencies?: Record<string, unknown> };
  if (typeof manifest.dependencies?.neuralis !== 'string') {
    throw new CliExit(1, `${installDir} is not an npm install folder (its package.json does not depend on neuralis)`, [
      'Start the conversion with `npx --yes create-neuralis@<version> convert .` — it writes that package.json first.',
    ]);
  }
}

/**
 * The entries of the old tarball that are still in the folder. `package.json`
 * is never one of them: the folder's manifest is the new one by now.
 */
export function remainingEntries(installDir: string, entries: readonly string[]): string[] {
  return entries.filter((entry) => entry !== 'package.json' && existsSync(join(installDir, entry)));
}

/** Delete the files, then every directory the listing implies that is left empty — deepest first. */
export function deleteEntries(installDir: string, entries: readonly string[]): { deleted: number; keptDirs: string[] } {
  assertEntriesInside(entries);
  let deleted = 0;
  const dirs = new Set<string>();
  for (const entry of entries) {
    const abs = join(installDir, entry);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    rmSync(abs);
    deleted += 1;
    for (let d = dirname(entry); d !== '.'; d = dirname(d)) dirs.add(d);
  }
  for (const dir of [...dirs].sort((a, b) => b.split('/').length - a.split('/').length)) {
    const abs = join(installDir, dir);
    if (existsSync(abs) && readdirSync(abs).length === 0) rmdirSync(abs);
  }
  const keptDirs = [...new Set([...dirs].map((d) => d.split('/')[0]!))].filter((d) => existsSync(join(installDir, d))).sort();
  return { deleted, keptDirs };
}

/** The system `tar` (the 0.1.0 scaffolder unpacked the host with it), run in the folder; `state` says what a failure leaves. */
function tar(installDir: string, args: string[], state: string): string {
  const result = spawnSync('tar', args, { cwd: installDir, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new CliExit(1, `could not run tar: ${result.error.message} — ${state}`, ['convert archives and restores the old tree with the system `tar`.']);
  if (result.status !== 0) throw new CliExit(1, `tar ${args[0]} failed (exit ${result.status}) — ${state}`, [(result.stderr ?? '').trim().split('\n').slice(-3).join(' ')]);
  return result.stdout ?? '';
}

/**
 * Archive `entries` (relative, inside the folder) into the record, then list the
 * archive back: the delete runs only when every entry is in it, by name.
 * Cost: one gzip pass over the old tree (the 0.1.0 host: 443 files, 4.1 MB → ~1.2 MB).
 */
export function archiveEntries(installDir: string, entries: readonly string[]): string {
  assertEntriesInside(entries);
  const archive = join(CONVERT_RECORD_DIR, TREE_ARCHIVE);
  tar(installDir, ['-czf', archive, '--', ...entries], 'nothing was deleted');
  const listed = new Set(tar(installDir, ['-tzf', archive], 'nothing was deleted').split('\n').filter(Boolean));
  const missing = entries.filter((entry) => !listed.has(entry));
  if (missing.length > 0 || listed.size !== entries.length) {
    throw new CliExit(1, `the archive of the old tree lists ${listed.size} entries for ${entries.length} files (first missing: ${JSON.stringify(missing[0] ?? '')}) — nothing was deleted`, ['Re-run the command; if it fails the same way, keep the folder as it is and report it.']);
  }
  return archive;
}

/** The one host-wide unit names THIS folder's broker — a unit serving another install is left alone. */
export function unitServesFolder(installDir: string, unitPath: string = unitFilePath()): boolean {
  if (!existsSync(unitPath)) return false;
  return readFileSync(unitPath, 'utf-8').includes(`${installDir.replace(/\/+$/, '')}/`);
}

async function offlineOrRefuse(installDir: string, what: string): Promise<void> {
  await loadHostEnv(installDir);
  const verdict = await checkOffline(
    { appPort: appPort(), neuralisDir: installDir },
    { inContainer: existsSync('/.dockerenv'), http: httpProbe, composeRunning: composeProbe },
  );
  if (!verdict.offline) {
    throw new CliExit(1, `Refusing to ${what}: ${verdict.reason}.`, ['Stop the app first (`docker compose stop neuralis` in this folder), then run this again.']);
  }
}

async function convert(installDir: string, from: string): Promise<number> {
  assertNpmFolder(installDir);
  const record = readRecord(installDir);
  if (!record) {
    console.log(`  ✓ ${installDir} is already an npm install folder (no ${CONVERT_RECORD_DIR}/ record) — nothing to convert.`);
    return 0;
  }
  if (record.from !== from) throw new CliExit(1, `the convert record says this folder was ${record.from}, not ${from}`, [USAGE]);
  refuseNativeRun(installDir);
  await offlineOrRefuse(installDir, 'convert');

  const remaining = remainingEntries(installDir, record.entries);
  let checkpoint = record.checkpoint;
  if (!checkpoint) {
    if (remaining.length > 0) archiveEntries(installDir, remaining);
    const manifest = await createCheckpoint(installDir, { label: `${CONVERT_LABEL_PREFIX}${from}`, files: [CONVERT_RECORD_DIR] });
    checkpoint = manifest.id;
    writeFileSync(join(installDir, CONVERT_RECORD_DIR, 'from.json'), `${JSON.stringify({ ...record, checkpoint }, null, 2)}\n`);
  }
  const { deleted, keptDirs } = deleteEntries(installDir, remaining);
  rmSync(join(installDir, CONVERT_RECORD_DIR), { recursive: true, force: true });

  const checkpointDir = join(installDir, 'checkpoints', checkpoint);
  console.log(`  ✓ converted: ${deleted} file(s) of the ${from} host tree removed; this folder now depends on neuralis ${record.to}.`);
  for (const dir of keptDirs) console.log(`  · kept ${dir}/ — it holds files the ${from} package did not ship`);
  console.log(`  · checkpoint: ${checkpointDir}`);
  if (unitServesFolder(installDir)) {
    console.log('  · this folder\'s host-broker unit: re-render it once with `npx neuralis host-broker upgrade` (its path moved into node_modules/neuralis).');
  }
  console.log(`  · next: npx neuralis update --version ${record.to} --apply   (image tag + companions, then compose → upgrade → up → health, run by the command)`);
  console.log('  · going back (app stopped):');
  console.log(`  ·   code   : npx neuralis convert --rollback ${checkpoint} && rm -rf node_modules && npm install`);
  console.log(`  ·   images : write NEURALIS_IMAGE_TAG=${from} (and NEURALIS_MACHINE_IMAGE back) into .env, then docker compose up -d -V`);
  console.log('  ·   data   : the checkpoint `npx neuralis upgrade --apply` names (`npx neuralis checkpoint restore <id>`)');
  return 0;
}

async function rollback(installDir: string, id: string): Promise<number> {
  await offlineOrRefuse(installDir, 'roll the conversion back');
  // Checked BEFORE anything is restored: another checkpoint under this folder (an
  // upgrade's, when NEURALIS_HOME is the folder) would put its files back wholesale.
  const summary = (await listCheckpoints(installDir)).find((c) => c.id === id);
  if (!summary || !summary.label.startsWith(CONVERT_LABEL_PREFIX)) {
    throw new CliExit(1, `${id} is not a convert checkpoint of this folder — nothing was restored`, [`\`ls checkpoints/\` shows the folder's checkpoints; a convert one is named …-${CONVERT_LABEL_PREFIX}<version>.`]);
  }
  await restoreCheckpoint(installDir, id);
  const recordDir = join(installDir, CONVERT_RECORD_DIR);
  if (!existsSync(join(recordDir, 'package.json'))) {
    throw new CliExit(1, `checkpoint ${id} carries no ${CONVERT_RECORD_DIR}/package.json — it is not a convert checkpoint`, ["The folder's package.json is unchanged."]);
  }
  const wroteNpmrc = (JSON.parse(readFileSync(join(recordDir, 'from.json'), 'utf-8')) as { wroteNpmrc?: unknown }).wroteNpmrc === true;
  // No archive: no old file was left in the folder when the conversion ran.
  const archive = join(CONVERT_RECORD_DIR, TREE_ARCHIVE);
  const state = `the folder's package.json is unchanged; ${archive} is in place to retry`;
  const restored = existsSync(join(installDir, archive)) ? tar(installDir, ['-tzf', archive], state).split('\n').filter(Boolean).length : 0;
  if (restored > 0) tar(installDir, ['-xpzf', archive], state);
  await rename(join(recordDir, 'package.json'), join(installDir, 'package.json'));
  if (existsSync(join(recordDir, 'package-lock.json'))) await rename(join(recordDir, 'package-lock.json'), join(installDir, 'package-lock.json'));
  if (wroteNpmrc) rmSync(join(installDir, '.npmrc'), { force: true });
  rmSync(recordDir, { recursive: true, force: true });
  console.log(`  ✓ restored ${restored} file(s) of the old tree and the old package.json from ${id}.`);
  console.log('  · next: rm -rf node_modules && npm install   (reinstalls the old tree)');
  return 0;
}

export async function run(argv: string[], ctx: CliContext): Promise<number> {
  const flag = argv[0];
  const value = argv[1];
  if ((flag !== '--from' && flag !== '--rollback') || !value || argv.length !== 2) throw new CliExit(1, 'convert needs exactly one of --from <old version> or --rollback <checkpoint id>', [USAGE]);
  return flag === '--from' ? convert(ctx.installDir, value) : rollback(ctx.installDir, value);
}
