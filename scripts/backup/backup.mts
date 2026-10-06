/**
 * The whole-install backup and restore behind `pnpm neuralis:backup` /
 * `pnpm neuralis:restore`, written against ports (a process runner, the free-space
 * probe, the offline check, the typed confirmation) so every refusal is exercised
 * without a daemon. The cold-tar mechanics are the Qdrant upgrade's own
 * (`coldTar`/`restoreTar`/`assertVolumeIdle`/`volumeBytes`/`checkDisk`).
 *
 * A backup is one consistent point: the app and Qdrant stop for the tar and come
 * back afterwards. It holds the data home (minus `qdrant-backups/`, the upgrade's
 * own rollback tars), the Qdrant volume in docker mode (`brain://` content lives
 * only there), the host folder's `.env` (it sits outside the home and carries the
 * session secret and the Qdrant key) and the machine-local
 * `docker-compose.override.yml`. Other named volumes — snapshot exports, desktop
 * profiles, a compose-managed Ollama — are named and left out unless asked for.
 * The directory is 0700 and every file in it 0600: it holds every secret.
 *
 * A restore never deletes: the incoming tars are listed before anything moves,
 * the CURRENT volume is cold-tarred beside the old home first (`restoreTar` empties
 * the volume before it extracts), and the old home is moved to
 * `<home>.before-restore`. `--home` / `--volume` point it at a throwaway target.
 */

import { chmod, copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { assertVolumeIdle, checkDisk, coldTar, mustExec, restoreTar, volumeBytes, type Exec } from '../qdrant-upgrade/upgrade.mts';
import type { ComposeAnswer } from '../checkpoint.mts';
import { qdrantVolumeName } from '../setup/qdrantVersion.mts';

export type QdrantMode = 'docker' | 'binary' | 'external' | 'skip';
export type OfflineVerdict = { offline: true } | { offline: false; reason: string };

export type BackupPorts = {
  exec: Exec;
  log: (line: string) => void;
  freeBytes: (dir: string) => Promise<number>;
  now: () => Date;
  monotonicMs: () => number;
  /** `docker compose ps --status running --services` in a folder (`composeProbe`, checkpoint.mts). */
  composeRunning: (cwd: string) => Promise<ComposeAnswer>;
  /** The app is not running (port + compose — `checkOffline`, checkpoint.mts). */
  appOffline: () => Promise<OfflineVerdict>;
  /** Binary mode: does the native Qdrant still answer on its URL? */
  qdrantAnswers: () => Promise<boolean>;
  /** The operator's typed answer to a prompt. */
  ask: (prompt: string) => Promise<string>;
};

export type InstallFacts = {
  neuralisHome: string;
  /** Where `.env` and both compose files live — the compose cwd, never `-f`. */
  configDir: string;
  /** The image build's context on the monorepo channel (the repo root); null when nothing builds here. */
  buildContext: string | null;
  composeProject: string;
  qdrantMode: QdrantMode;
  /** The local image the throwaway tar containers run (docker mode: the recorded Qdrant image). */
  toolImage: string | null;
};

export type BackupPart = { kind: 'home' | 'volume' | 'env' | 'override'; name: string; file: string; bytes: number };
export type BackupManifest = {
  format: 1;
  createdAt: string;
  neuralisHome: string;
  composeProject: string;
  qdrantMode: QdrantMode;
  parts: BackupPart[];
};

const MANIFEST = 'manifest.json';
/** The Qdrant upgrade's rollback tars: a copy of an older volume, not install state. */
const EXCLUDED_HOME_DIRS = ['qdrant-backups'];

export function defaultBackupRoot(neuralisHome: string): string {
  return join(dirname(neuralisHome), `${basename(neuralisHome)}-backups`);
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The nearest existing directory at or above `dir` — what free space is measured on. */
function existingAncestor(dir: string): string {
  let current = resolve(dir);
  while (!existsSync(current) && dirname(current) !== current) current = dirname(current);
  return current;
}

/** The image the throwaway tar containers run — a volume part cannot be copied without it. */
function toolImage(facts: InstallFacts): string {
  if (!facts.toolImage) {
    throw new Error(`Copying a Docker volume needs the recorded Qdrant image (docker mode); this install runs Qdrant in ${facts.qdrantMode} mode. Nothing was changed.`);
  }
  return facts.toolImage;
}

async function private0600(file: string): Promise<number> {
  await chmod(file, 0o600);
  const bytes = (await stat(file)).size;
  if (bytes === 0) throw new Error(`${file} is empty.`);
  return bytes;
}

/** The volumes a backup takes: the Qdrant store in docker mode, plus the ones asked for. */
function backupVolumes(facts: InstallFacts, include: string[]): string[] {
  const base = facts.qdrantMode === 'docker' ? [qdrantVolumeName(facts.composeProject)] : [];
  return [...new Set([...base, ...include])];
}

async function nameLeftOut(ports: BackupPorts, facts: InstallFacts, taken: string[]): Promise<void> {
  const res = await ports.exec('docker', ['volume', 'ls', '-q']);
  if (res.code !== 0) return;
  const optional = res.out.split('\n').map((s) => s.trim()).filter((name) =>
    name === `${facts.composeProject}_qdrant-snapshots`
    || name === `${facts.composeProject}_ollama-data`
    || name.startsWith('neuralis-machine-'));
  const left = optional.filter((name) => !taken.includes(name));
  if (left.length > 0) ports.log(`not included (add with --include-volume <name>): ${left.join(', ')}`);
}

// ── Backup ─────────────────────────────────────────────────────

export type BackupOptions = { outDir: string | null; includeVolumes: string[] };
export type BackupResult = { dir: string; manifest: BackupManifest; bytes: number; ms: number };

export async function runBackup(ports: BackupPorts, facts: InstallFacts, opts: BackupOptions): Promise<BackupResult> {
  const started = ports.monotonicMs();
  const home = resolve(facts.neuralisHome);
  const envFile = join(facts.configDir, '.env');
  if (!existsSync(envFile)) {
    throw new Error(`No .env at ${envFile} — it carries the session secret and the Qdrant key, and a backup without it cannot be restored. Nothing was changed.`);
  }
  const stamp = ports.now().toISOString().replace(/[:.]/g, '-');
  const dir = resolve(opts.outDir ?? join(defaultBackupRoot(home), stamp));
  if (isInside(home, dir)) throw new Error(`Refusing to write the backup inside the home it copies (${dir}). Nothing was changed.`);
  for (const tree of [facts.configDir, facts.buildContext]) {
    if (tree && isInside(resolve(tree), dir)) {
      throw new Error(`Refusing to write the backup inside ${tree}: it is a Docker build context or the compose folder, and the backup holds every secret. Nothing was changed.`);
    }
  }
  if (existsSync(dir)) throw new Error(`${dir} already exists — a backup never writes over another. Nothing was changed.`);

  const volumes = backupVolumes(facts, opts.includeVolumes);
  const image = volumes.length > 0 ? toolImage(facts) : '';
  for (const volume of volumes) await mustExec(ports, ['volume', 'inspect', volume], `find the ${volume} volume — nothing was changed`);
  await nameLeftOut(ports, facts, volumes);

  const homeBytes = Number((await mustExec(ports, ['-sb', ...EXCLUDED_HOME_DIRS.map((d) => `--exclude=${d}`), home], `measure ${home}`, undefined, 'du')).out.trim().split(/\s+/)[0]);
  let total = Number.isFinite(homeBytes) ? homeBytes : 0;
  for (const volume of volumes) total += await volumeBytes(ports, volume, image, true);
  await checkDisk(ports, total, existingAncestor(dir), 1, 'the backup');

  const compose = await ports.composeRunning(facts.configDir);
  const running = compose.kind === 'services' ? compose.running : [];
  const stop = ['neuralis', 'qdrant'].filter((s) => running.includes(s));
  const parts: BackupPart[] = [];
  try {
    for (const service of stop) await mustExec(ports, ['compose', 'stop', service], `stop ${service}`, { cwd: facts.configDir });
    const offline = await ports.appOffline();
    if (!offline.offline) throw new Error(`Refusing to back up: ${offline.reason}. Stop the app first. Nothing was written.`);
    if (facts.qdrantMode === 'binary' && await ports.qdrantAnswers()) {
      throw new Error('Refusing to back up: the native Qdrant still answers, and its storage is inside the home. Stop it first. Nothing was written.');
    }
    for (const volume of volumes) await assertVolumeIdle(ports, volume, 'back it up');

    await mkdir(dirname(dir), { recursive: true, mode: 0o700 });
    await mkdir(dir, { mode: 0o700 });
    await chmod(dir, 0o700);

    const homeTar = join(dir, 'home.tar');
    const tarred = await ports.exec('tar', ['-C', home, ...EXCLUDED_HOME_DIRS.map((d) => `--exclude=./${d}`), '-cpf', homeTar, '.']);
    if (tarred.code !== 0) {
      // GNU tar exits 1 when a file changed while it was read (a desktop container or the
      // host broker writing under the home): the copy is not one consistent point, so it is
      // a failure — no manifest is written, so the folder is never offered as a backup.
      const changed = /file changed as we read it|file removed before we read it/.test(tarred.err);
      throw new Error(
        `tar of ${home} failed (exit ${tarred.code}): ${tarred.err.trim().split('\n').slice(-3).join(' | ')}\n` +
        (changed ? '  Something still writes under the home (a desktop container, the host broker). Stop it and run the backup again.\n' : '') +
        `  ${dir} holds no manifest and is never offered as a backup; delete it.`,
      );
    }
    const homeTarBytes = await private0600(homeTar);
    parts.push({ kind: 'home', name: home, file: 'home.tar', bytes: homeTarBytes });
    ports.log(`home: ${mb(homeTarBytes)} → ${homeTar} (left out: ${EXCLUDED_HOME_DIRS.join(', ')})`);

    for (const volume of volumes) {
      const file = `volume-${volume}.tar`;
      const bytes = await coldTar(ports, volume, image, join(dir, file));
      parts.push({ kind: 'volume', name: volume, file, bytes });
      ports.log(`volume ${volume}: ${mb(bytes)} → ${join(dir, file)}`);
    }

    await copyFile(envFile, join(dir, 'env'));
    parts.push({ kind: 'env', name: envFile, file: 'env', bytes: await private0600(join(dir, 'env')) });
    const override = join(facts.configDir, 'docker-compose.override.yml');
    if (existsSync(override)) {
      await copyFile(override, join(dir, 'docker-compose.override.yml'));
      parts.push({ kind: 'override', name: override, file: 'docker-compose.override.yml', bytes: await private0600(join(dir, 'docker-compose.override.yml')) });
    } else {
      ports.log(`no ${override} — this install has no mounts to keep`);
    }

    // Written LAST: a directory without one is an interrupted backup and is never offered.
    const manifest: BackupManifest = {
      format: 1,
      createdAt: ports.now().toISOString(),
      neuralisHome: home,
      composeProject: facts.composeProject,
      qdrantMode: facts.qdrantMode,
      parts,
    };
    await writeFile(join(dir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    await chmod(join(dir, MANIFEST), 0o600);
    const bytes = parts.reduce((sum, p) => sum + p.bytes, 0);
    const ms = Math.round(ports.monotonicMs() - started);
    ports.log(`backup complete: ${mb(bytes)} in ${(ms / 1000).toFixed(1)} s → ${dir}`);
    return { dir, manifest, bytes, ms };
  } finally {
    if (stop.length > 0) {
      // `start`, never `up`: exactly the containers it stopped, unchanged — `up` would
      // start every service and apply a pending compose regen without `-V`.
      const restart = ['compose', 'start', ...[...stop].reverse()];
      const res = await ports.exec('docker', restart, { cwd: facts.configDir });
      if (res.code === 0) ports.log(`restarted: ${stop.join(', ')}`);
      else ports.log(`WARNING: the stopped services did not start (exit ${res.code}) — run \`docker ${restart.join(' ')}\` in ${facts.configDir}`);
    }
  }
}

function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

// ── List ───────────────────────────────────────────────────────

export async function listBackups(root: string): Promise<Array<{ dir: string; manifest: BackupManifest }>> {
  let names: string[] = [];
  try { names = await readdir(root); } catch { return []; }
  const out: Array<{ dir: string; manifest: BackupManifest }> = [];
  for (const name of names.sort().reverse()) {
    const dir = join(root, name);
    try { out.push({ dir, manifest: await readManifest(dir) }); } catch { /* incomplete: no manifest */ }
  }
  return out;
}

async function readManifest(dir: string): Promise<BackupManifest> {
  const parsed = JSON.parse(await readFile(join(dir, MANIFEST), 'utf-8')) as BackupManifest;
  if (parsed.format !== 1 || !Array.isArray(parsed.parts)) throw new Error(`${dir}/${MANIFEST} is not a backup manifest.`);
  return parsed;
}

// ── Restore ────────────────────────────────────────────────────

export type RestoreOptions = { dir: string; home: string | null; volume: string | null };
export type RestoreResult = { home: string; beforeRestore: string | null; volumeSafety: string[]; volume: string | null };

export async function runRestore(ports: BackupPorts, facts: InstallFacts, opts: RestoreOptions): Promise<RestoreResult> {
  const dir = resolve(opts.dir);
  let manifest: BackupManifest;
  try {
    manifest = await readManifest(dir);
  } catch {
    throw new Error(`${dir} holds no complete backup (no ${MANIFEST}). Nothing was changed.`);
  }
  const liveHome = resolve(facts.neuralisHome);
  const target = resolve(opts.home ?? liveHome);
  const live = target === liveHome;
  const liveVolume = qdrantVolumeName(facts.composeProject);

  const homePart = manifest.parts.find((p) => p.kind === 'home');
  if (!homePart) throw new Error(`${dir} has no home part. Nothing was changed.`);
  for (const part of manifest.parts) {
    if (basename(part.file) !== part.file) throw new Error(`${dir}/${MANIFEST} names a part outside the backup (${part.file}). Nothing was changed.`);
  }
  const volumeParts = manifest.parts.filter((p) => p.kind === 'volume');
  const qdrantPart = volumeParts.find((p) => p.name.endsWith('_qdrant-data')) ?? null;
  let targetVolume: string | null = null;
  if (qdrantPart) {
    targetVolume = opts.volume ?? (live ? liveVolume : null);
    if (!targetVolume) throw new Error('A restore into another home must name its Qdrant volume with --volume (a cloned or new one). Nothing was changed.');
    if (!live && targetVolume === liveVolume) throw new Error(`Refusing to restore the live ${liveVolume} under a throwaway home. Nothing was changed.`);
  }
  const otherVolumes = volumeParts.filter((p) => p !== qdrantPart);
  if (otherVolumes.length > 0 && !live) ports.log(`not restored into a throwaway target: ${otherVolumes.map((p) => p.name).join(', ')}`);
  const volumeJobs = [
    ...(qdrantPart && targetVolume ? [{ part: qdrantPart, volume: targetVolume }] : []),
    ...(live ? otherVolumes.map((part) => ({ part, volume: part.name })) : []),
  ];
  const image = volumeJobs.length > 0 ? toolImage(facts) : '';

  if (live) {
    const offline = await ports.appOffline();
    if (!offline.offline) throw new Error(`Refusing to restore: ${offline.reason}. Stop the app first. Nothing was changed.`);
    if (facts.qdrantMode === 'binary' && await ports.qdrantAnswers()) {
      throw new Error('Refusing to restore: the native Qdrant still answers. Stop it first. Nothing was changed.');
    }
  }

  // Every incoming tar must list cleanly BEFORE anything moves: restoreTar empties the volume first.
  for (const part of [homePart, ...volumeJobs.map((j) => j.part)]) {
    const file = join(dir, part.file);
    if (!existsSync(file) || (await stat(file)).size === 0) throw new Error(`${file} is missing or empty. Nothing was changed.`);
    const listing = await ports.exec('tar', ['-tf', file]);
    if (listing.code !== 0 || !listing.out.trim()) {
      throw new Error(`${file} does not read as a tar (exit ${listing.code}): ${listing.err.trim().split('\n').slice(-2).join(' | ')}. Nothing was changed.`);
    }
  }

  const beforeRestore = `${target}.before-restore`;
  if (existsSync(beforeRestore)) throw new Error(`${beforeRestore} already exists — move it away first; a restore never overwrites an earlier rescue copy. Nothing was changed.`);
  const safety = (volume: string): string => `${beforeRestore}-${volume}.tar`;
  // The .env and the override keep their rescue copies too — `rename` would replace an earlier one.
  const configParts = live
    ? manifest.parts
      .filter((p) => p.kind === 'env' || p.kind === 'override')
      .map((part) => ({ part, dest: join(facts.configDir, part.kind === 'env' ? '.env' : 'docker-compose.override.yml') }))
    : [];
  for (const { dest } of configParts) {
    if (existsSync(`${dest}.before-restore`)) {
      throw new Error(`${dest}.before-restore already exists — move it away first; a restore never overwrites an earlier rescue copy. Nothing was changed.`);
    }
  }
  let need = 0;
  for (const job of volumeJobs) {
    if (existsSync(safety(job.volume))) throw new Error(`${safety(job.volume)} already exists. Nothing was changed.`);
    await mustExec(ports, ['volume', 'inspect', job.volume], `find the ${job.volume} volume (create it first: \`docker volume create ${job.volume}\`, or \`docker compose up --no-start qdrant\` for the live one) — nothing was changed`);
    await assertVolumeIdle(ports, job.volume, 'restore it');
    need += job.part.bytes + await volumeBytes(ports, job.volume, image, true);
  }
  need += homePart.bytes;
  await checkDisk(ports, need, existingAncestor(dirname(target)), 1, 'the restored data and the safety copy of the current volume');

  ports.log(`restoring ${dir}`);
  ports.log(`  home    → ${target}${existsSync(target) ? ` (the current one moves to ${beforeRestore})` : ''}`);
  for (const job of volumeJobs) ports.log(`  volume  → ${job.volume} (its current content is saved to ${safety(job.volume)} first)`);
  if (live) ports.log(`  .env    → ${join(facts.configDir, '.env')} (the current one moves to .env.before-restore)`);
  const typed = (await ports.ask(`Type ${basename(dir)} to restore it`)).trim();
  if (typed !== basename(dir)) throw new Error('Not confirmed; nothing changed.');

  // From here on things move: every step is recorded, so a failure says what changed and where
  // each rescue copy is, instead of leaving an unexplained half-restored pair.
  const done: string[] = [];
  const volumeSafety: string[] = [];
  let movedHome: string | null = null;
  let step = '';
  try {
    for (const job of volumeJobs) {
      step = `saving the current ${job.volume} to ${safety(job.volume)}`;
      const saved = await coldTar(ports, job.volume, image, safety(job.volume));
      volumeSafety.push(safety(job.volume));
      done.push(`the current ${job.volume} was saved to ${safety(job.volume)}`);
      ports.log(`saved the current ${job.volume}: ${mb(saved)} → ${safety(job.volume)}`);
      step = `replacing ${job.volume} (it is emptied first; its previous content is in ${safety(job.volume)})`;
      await restoreTar(ports, job.volume, image, join(dir, job.part.file));
      done.push(`${job.volume} was replaced from the backup`);
      ports.log(`restored ${job.volume}`);
    }

    step = `moving the home aside and extracting the backup into ${target}`;
    if (existsSync(target)) {
      await rename(target, beforeRestore);
      movedHome = beforeRestore;
      done.push(`the current home was moved to ${beforeRestore}`);
    }
    // `tar -xp` restores the archived mode of `.` itself, so the home ends with the mode it was backed up with.
    await mkdir(target, { recursive: true, mode: 0o700 });
    await mustExec(ports, ['-C', target, '-xpf', join(dir, homePart.file)], `extract the home into ${target}`, undefined, 'tar');
    done.push(`the home was restored into ${target}`);
    ports.log(`restored the home into ${target}`);

    for (const { part, dest } of configParts) {
      step = `putting ${dest} back`;
      if (existsSync(dest)) {
        await rename(dest, `${dest}.before-restore`);
        done.push(`${dest} was moved to ${dest}.before-restore`);
      }
      await copyFile(join(dir, part.file), dest);
      await chmod(dest, 0o600);
      done.push(`${dest} was restored`);
      ports.log(`restored ${dest}`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `The restore stopped half-way, while ${step}: ${reason}\n` +
      (done.length > 0 ? `  Already done:\n${done.map((d) => `    - ${d}`).join('\n')}\n` : '  Nothing had been changed yet.\n') +
      '  Nothing was deleted: put a rescue copy back by hand, or fix the cause and restore again.',
    );
  }

  if (live) {
    // The restored .env names the image tag the backup was taken on, so the compose file is regenerated in every case.
    ports.log('next: `pnpm neuralis:setup --compose-only`, then `docker compose up -d -V`');
  } else {
    ports.log(`the backup's .env and override stay in ${dir} — this target is not the live install`);
  }
  return { home: target, beforeRestore: movedHome, volumeSafety, volume: targetVolume };
}
