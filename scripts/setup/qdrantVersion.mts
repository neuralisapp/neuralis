/**
 * The Qdrant server version as INSTALLATION STATE.
 *
 * Qdrant's on-disk format is forward-only and upstream supports upgrades one
 * minor at a time: a newer engine migrates the storage in place, an older one
 * then refuses to start on it, and a jump across several minors is unsupported.
 * So the version a deployment runs is a fact about ITS storage, never a code
 * constant: a regenerated compose that simply named the newest pin would start
 * that engine on whatever storage the volume holds.
 *
 * The state lives in `<NEURALIS_HOME>/qdrant-version.json`, outside the app's
 * bind mounts. Setup writes it once — for a fresh install (no storage) the
 * version this release ships; for an existing install without the file, the
 * version it DETECTS on the storage — and afterwards only
 * `pnpm neuralis:qdrant-upgrade` advances it (or rolls it back). There is no
 * default: an existing install whose version cannot be read is refused.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The version this release of the host is built and tested against. */
export const QDRANT_TARGET_VERSION = '1.19.1';

export type QdrantBinaryTarget = 'x86_64-unknown-linux-gnu' | 'aarch64-unknown-linux-musl';

export type QdrantRelease = {
  version: string;
  /** Multi-arch image index digest of `qdrant/qdrant:v<version>`. */
  imageDigest: string;
  /** sha256 of the release tarball per target triple. */
  binarySha256: Record<QdrantBinaryTarget, string>;
};

/**
 * One release per minor, oldest first: the upgrade chain walks this table and
 * never skips a row. 1.16 runs the background RocksDB→Gridstore migration, so
 * no hop may start before the previous one has settled.
 * Refresh: `docker buildx imagetools inspect qdrant/qdrant:v<ver>` for the
 * digest; the release's asset digests (or `sha256sum` of the tarball where the
 * release publishes none) for the binaries. Upstream publishes arm64 as musl
 * only — a `aarch64-unknown-linux-gnu` asset does not exist.
 */
export const QDRANT_RELEASES: readonly QdrantRelease[] = [
  {
    version: '1.13.6',
    imageDigest: 'sha256:bd67306b6cc77c98122cada2321eb60b20d00b19d26cb61c86681e7bd5951498',
    binarySha256: {
      'x86_64-unknown-linux-gnu': 'ee2cdd6eca8c7d041639256cc3db95e7e2e447ffd94165dde92e98160177f4cf',
      'aarch64-unknown-linux-musl': 'b0b915dcc78fa7a1e52aa2225453a1dddef5e187f24b83af03e647858843425d',
    },
  },
  {
    version: '1.14.1',
    imageDigest: 'sha256:419d72603f5346ee22ffc4606bdb7beb52fcb63077766fab678e6622ba247366',
    binarySha256: {
      'x86_64-unknown-linux-gnu': '7d43068cce7477061a7bd91fd5e5e139e35cfacb09d0dcdc4f4a33ace7d782d8',
      'aarch64-unknown-linux-musl': 'ed221c141e240d1443535ba44e71c965f1d2d5e702f01c52c5ad4b7fc64bb604',
    },
  },
  {
    version: '1.15.5',
    imageDigest: 'sha256:0fb8897412abc81d1c0430a899b9a81eb8328aa634e7242d1bc804c1fe8fe863',
    binarySha256: {
      'x86_64-unknown-linux-gnu': '56b41911cc0f891ef47d1a4c5cb1f62a423db654ab3694f83cfd37643fea082d',
      'aarch64-unknown-linux-musl': '9a68ff1b158fd3a73b63e5e07a80c3bef95c869436a946151246b10b4a85bcd4',
    },
  },
  {
    version: '1.16.3',
    imageDigest: 'sha256:0425e3e03e7fd9b3dc95c4214546afe19de2eb2e28ca621441a56663ac6e1f46',
    binarySha256: {
      'x86_64-unknown-linux-gnu': '62e42e3e0fffd609365363be85b63ec27b215b8e7ac9929cf5736c49af0416ec',
      'aarch64-unknown-linux-musl': 'd1685202c98ad680234fb203676247aa948eda08d51d32d4dadce9de98f21394',
    },
  },
  {
    version: '1.17.1',
    imageDigest: 'sha256:94728574965d17c6485dd361aa3c0818b325b9016dac5ea6afec7b4b2700865f',
    binarySha256: {
      'x86_64-unknown-linux-gnu': '318a3b1c548161ad476f9ff70b654787a20fc46685e3e1c2b7dd88b363ef3d58',
      'aarch64-unknown-linux-musl': '9347a4db839f53fe123cc775bd87e4dd02f6c2750783bea02ea4fcae9c923164',
    },
  },
  {
    version: '1.18.3',
    imageDigest: 'sha256:0bd98fa7977f1e75694779359ca4e212822e5a71334e28421182f72f209d5286',
    binarySha256: {
      'x86_64-unknown-linux-gnu': '60663a254cf421dba4db45710872895cd3a714fe1e6978f7927923b5cfae4718',
      'aarch64-unknown-linux-musl': '1e738b45f90935c383b4076c30f377f390964cb5962b5bff24439812d157dc24',
    },
  },
  {
    version: '1.19.1',
    imageDigest: 'sha256:12364fe851b9f17356fc88189fc06d1b521262e04659ec7345975b00c9246a10',
    binarySha256: {
      'x86_64-unknown-linux-gnu': 'eef986e769d4d3e806dd2d546e1b4ecdd416211e54d34b4ed764fac7c58e1085',
      'aarch64-unknown-linux-musl': '0e607c11705fab22f7d667f4749bc0b6b60a8fa9e91de71880a6ebafbbda1b26',
    },
  },
];

/** The upgrade command, named in every refusal. */
export const QDRANT_UPGRADE_COMMAND = 'pnpm neuralis:qdrant-upgrade';

type ParsedVersion = { major: number; minor: number; patch: number };

export function parseQdrantVersion(raw: string): ParsedVersion | null {
  const match = raw.trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function findQdrantRelease(version: string): QdrantRelease | null {
  return QDRANT_RELEASES.find((release) => release.version === version) ?? null;
}

/** Digest-pinned image reference; throws for a version the table does not pin. */
export function qdrantImageRef(version: string): string {
  const release = findQdrantRelease(version);
  if (!release) throw new Error(`Qdrant ${version} is not a pinned release — no image digest is known for it.`);
  return `qdrant/qdrant:v${release.version}@${release.imageDigest}`;
}

/** The release asset for this machine, or null where upstream ships none. */
export function qdrantBinaryAsset(
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): { url: string; filename: string; sha256: string } | null {
  const release = findQdrantRelease(version);
  if (!release || platform !== 'linux') return null;
  const target: QdrantBinaryTarget | null =
    arch === 'x64' ? 'x86_64-unknown-linux-gnu' : arch === 'arm64' ? 'aarch64-unknown-linux-musl' : null;
  if (!target) return null;
  const filename = `qdrant-${target}.tar.gz`;
  return {
    url: `https://github.com/qdrant/qdrant/releases/download/v${release.version}/${filename}`,
    filename,
    sha256: release.binarySha256[target],
  };
}

/**
 * The versions an upgrade from `from` to `to` starts, in order, one per minor
 * (the last element is `to`). Throws when either end is not a pinned release or
 * `to` is older than `from` — storage never moves backwards.
 */
export function qdrantUpgradeChain(from: string, to: string = QDRANT_TARGET_VERSION): string[] {
  const fromIdx = QDRANT_RELEASES.findIndex((release) => release.version === from);
  const toIdx = QDRANT_RELEASES.findIndex((release) => release.version === to);
  if (fromIdx < 0) throw new Error(`Qdrant ${from} is not a pinned release; the upgrade chain starts only from one.`);
  if (toIdx < 0) throw new Error(`Qdrant ${to} is not a pinned release.`);
  if (toIdx < fromIdx) throw new Error(`Qdrant storage never moves backwards (${from} → ${to}).`);
  return QDRANT_RELEASES.slice(fromIdx + 1, toIdx + 1).map((release) => release.version);
}

export type QdrantGap =
  | { kind: 'current' }
  | { kind: 'behind'; hops: number }
  | { kind: 'refuse'; message: string };

/**
 * Setup may render the state's version when it is at most one minor behind the
 * target; anything wider (or newer, or unpinned) is refused with the command
 * named, in docker AND binary mode.
 */
export function assessQdrantGap(stateVersion: string, target: string = QDRANT_TARGET_VERSION): QdrantGap {
  const state = parseQdrantVersion(stateVersion);
  const wanted = parseQdrantVersion(target);
  if (!state || !wanted) return { kind: 'refuse', message: `Unreadable Qdrant version "${stateVersion}".` };
  if (!findQdrantRelease(stateVersion)) {
    return {
      kind: 'refuse',
      message: `Qdrant ${stateVersion} (recorded for this install) is not a release this host pins; it cannot render or upgrade it.`,
    };
  }
  if (state.major !== wanted.major || state.minor > wanted.minor || (state.minor === wanted.minor && state.patch > wanted.patch)) {
    return { kind: 'refuse', message: `Qdrant ${stateVersion} is newer than this host's ${target}; storage never moves backwards.` };
  }
  const gap = wanted.minor - state.minor;
  if (gap === 0 && state.patch === wanted.patch) return { kind: 'current' };
  if (gap <= 1) return { kind: 'behind', hops: qdrantUpgradeChain(stateVersion, target).length };
  return {
    kind: 'refuse',
    message:
      `This install runs Qdrant ${stateVersion}; this host ships ${target} — ${gap} minors apart, and Qdrant ` +
      `upgrades one minor at a time. Run \`${QDRANT_UPGRADE_COMMAND}\` (it walks every minor with a cold backup ` +
      'and a rollback), then re-run this command.',
  };
}

// ── The state file ─────────────────────────────────────────────

export type QdrantStateSource = 'fresh' | 'detected' | 'upgrade' | 'rollback';

export type QdrantState = {
  version: string;
  /** The version before the last change — what a rollback returns to. */
  previous: string | null;
  source: QdrantStateSource;
  recordedAt: string;
};

export function qdrantStatePath(neuralisHome: string): string {
  return join(neuralisHome, 'qdrant-version.json');
}

/** null when the file does not exist; throws when it exists but is not a state. */
export async function readQdrantState(path: string): Promise<QdrantState | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as Partial<QdrantState>;
  const sources: QdrantStateSource[] = ['fresh', 'detected', 'upgrade', 'rollback'];
  if (
    typeof parsed.version !== 'string' || !parseQdrantVersion(parsed.version) ||
    (parsed.previous !== null && typeof parsed.previous !== 'string') ||
    !sources.includes(parsed.source as QdrantStateSource) ||
    typeof parsed.recordedAt !== 'string'
  ) {
    throw new Error(`${path} is not a Qdrant version record — fix or remove it (setup re-detects a removed one).`);
  }
  return parsed as QdrantState;
}

/** Atomic (temp + rename), operator-only. */
export async function writeQdrantState(path: string, state: QdrantState): Promise<void> {
  const tmp = `${path}.tmp.${randomBytes(4).toString('hex')}`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

/** What setup can observe about an install that has no state file yet. */
export type QdrantInstallProbe = {
  /** Does storage exist? `null` = cannot tell from here. */
  storageExists(): Promise<boolean | null>;
  /** The version a server on this storage answers on `GET /`, if one runs. */
  runningVersion(): Promise<string | null>;
  /** Docker mode: the tag in the current compose file. Binary mode: the installed binary's `--version`. */
  installedVersion(): Promise<string | null>;
};

export type QdrantStateResolution =
  | { kind: 'state'; state: QdrantState; created: boolean }
  | { kind: 'refuse'; message: string };

/**
 * The recorded state, or — when there is none — the bootstrap: a fresh install
 * records the target, an existing one records what it detects, and one whose
 * version cannot be read is refused. Never a default.
 */
export async function resolveQdrantState(input: {
  statePath: string;
  probe: QdrantInstallProbe;
  now?: () => Date;
  target?: string;
  /** false = report what would be recorded without writing it (a dry run). */
  persist?: boolean;
}): Promise<QdrantStateResolution> {
  const persist = input.persist ?? true;
  const existing = await readQdrantState(input.statePath);
  if (existing) return { kind: 'state', state: existing, created: false };

  const now = (input.now ?? (() => new Date()))().toISOString();
  const storage = await input.probe.storageExists();
  if (storage === false) {
    const state: QdrantState = { version: input.target ?? QDRANT_TARGET_VERSION, previous: null, source: 'fresh', recordedAt: now };
    if (persist) await writeQdrantState(input.statePath, state);
    return { kind: 'state', state, created: persist };
  }

  const detected = (await input.probe.runningVersion()) ?? (await input.probe.installedVersion());
  const parsed = detected ? parseQdrantVersion(detected) : null;
  if (!detected || !parsed) {
    return {
      kind: 'refuse',
      message:
        'This install has Qdrant storage but no recorded Qdrant version, and the version could not be read ' +
        '(no server answered and no installed version was found). Start the existing stack so its Qdrant ' +
        `answers, then re-run this command — it records the running version. Nothing was written.`,
    };
  }
  const version = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  const state: QdrantState = { version, previous: null, source: 'detected', recordedAt: now };
  if (persist) await writeQdrantState(input.statePath, state);
  return { kind: 'state', state, created: persist };
}

/** The `qdrant/qdrant:v<x.y.z>` tag in a generated compose file, if any. */
export function composeQdrantVersion(composeContent: string): string | null {
  const match = composeContent.match(/^\s*image:\s*qdrant\/qdrant:v(\d+\.\d+\.\d+)(?:@sha256:[0-9a-f]{64})?\s*$/m);
  return match ? match[1] : null;
}

// ── Install probes (docker / binary) ───────────────────────────

/** The named volume Compose gives `qdrant-data` under this project name. */
export function qdrantVolumeName(composeProject: string): string {
  return `${composeProject}_qdrant-data`;
}

type SpawnSyncLike = (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string; error?: Error };

const realSpawnSync: SpawnSyncLike = (cmd, args) => {
  const result = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 15_000 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
};

/**
 * Docker mode: storage = the project's `qdrant-data` volume; the installed
 * version = the tag of the current compose file. `null` from the volume probe
 * means this shell cannot ask the daemon — never read as "absent".
 */
export function dockerInstallProbe(input: {
  composeProject: string;
  composeFilePath: string;
  runningVersion: string | null;
  run?: SpawnSyncLike;
}): QdrantInstallProbe {
  const run = input.run ?? realSpawnSync;
  return {
    async storageExists() {
      const result = run('docker', ['volume', 'inspect', qdrantVolumeName(input.composeProject)]);
      if (result.error || result.status === null) return null;
      if (result.status === 0) return true;
      return /no such volume/i.test(result.stderr) ? false : null;
    },
    async runningVersion() {
      return input.runningVersion;
    },
    async installedVersion() {
      try {
        return composeQdrantVersion(await readFile(input.composeFilePath, 'utf-8'));
      } catch {
        return null;
      }
    },
  };
}

/** Binary mode: storage = the storage dir; the installed version = `qdrant --version`. */
export function binaryInstallProbe(input: {
  storageDir: string;
  binaryPath: string;
  runningVersion: string | null;
  run?: SpawnSyncLike;
}): QdrantInstallProbe {
  const run = input.run ?? realSpawnSync;
  return {
    async storageExists() {
      try {
        return (await readdir(input.storageDir)).length > 0;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === 'ENOENT' ? false : null;
      }
    },
    async runningVersion() {
      return input.runningVersion;
    },
    async installedVersion() {
      const result = run(input.binaryPath, ['--version']);
      if (result.error || result.status !== 0) return null;
      return result.stdout.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
    },
  };
}
