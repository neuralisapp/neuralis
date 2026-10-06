/**
 * Durable record writers: the data-directory skeleton, the owner and project
 * records, and the per-project source configs.
 *
 * Extracted from `setup.mts` (F3 INC-S1) so the idempotence rules below can be
 * unit-tested — the wizard module has no exports and runs `main()` at load.
 *
 * The rules, and why each exists:
 *
 * - **Source configs are never overwritten.** The wizard used to rewrite all
 *   three on every run, discarding admin edits to permissions, uri-policy rows
 *   and sync excludes. A missing file is filled in; an existing one is left
 *   exactly as it is.
 * - **The seed is a faithful port of brain-core's declared sources**
 *   (`neuralis.sources[]`, the declaration a new project is seeded from) on
 *   every field it shares — proven by a deep-equal drift test, not by
 *   assertion. The one deliberate divergence is `permissions.paths` on
 *   `packages` (see `PACKAGES_PATHS`).
 * - **A new project's id comes from the app's ONE derivation**
 *   (`projectIdFromName`, `src/lib/utils.ts` — a dependency-free module), and an
 *   existing project's id is never re-derived: `resolveSetupProjectId` maintains
 *   the record the owner names, by its stored id and owner.
 * - **The wizard seeds `packages` and `brain`, never `data`.** A `data` source
 *   carries a seed only the package registry can derive (the machine-written
 *   paths the kernel keeps out of a new project's index), and the wizard runs
 *   before any package loads. brain-core's boot repair creates the missing
 *   `data` source on the first boot — the project is already known to it
 *   through these two configs — and unions the manifest baselines and floors
 *   into it in the same pass. Before that boot no process reads the project's
 *   source configs.
 * - **The project record is MINIMAL.** It carries no role map at all: the
 *   canonical `DEFAULT_ROLES` is derived from package manifests at runtime, and
 *   the record migration seeds it on first read. The copy that lived here had
 *   drifted into granting `admin` the `'*'` wildcard that the platform
 *   deliberately removed, with `canManageRoles: false` contradicting it. An
 *   empty map (not an absent key) is what the migration and the admin readers
 *   both handle.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SetupConfig } from './types.mts';
import { projectIdFromName } from '../../src/lib/utils';

// ---------------------------------------------------------------------------
// Source config seed — ported from brain-core's declared `sources[]`
// (drift-guarded by scripts/__tests__/setupIdempotence.test.mts)
// ---------------------------------------------------------------------------

const DEFAULT_PACKAGES_SYNC_EXCLUDES = [
  'node_modules/**', '**/node_modules/**',
  '.git/**', '**/.git/**',
  'dist/**', '**/dist/**',
  'build/**', '**/build/**',
  '*.tsbuildinfo', '**/*.tsbuildinfo',
  '*.wasm', '**/*.wasm',
  '.env', '**/.env',
  '.env.*', '**/.env.*',
  '*.pem', '**/*.pem',
  '*.key', '**/*.key',
  'id_rsa', '**/id_rsa',
  'id_ed25519', '**/id_ed25519',
  'credentials/**', '**/credentials/**',
];

const PACKAGES_DESCRIPTION = 'Project package drop-zone (_packages/) — WASM and source packages load from here.';
const BRAIN_DESCRIPTION = 'Vector memory — semantic search across everything synced into the brain.';

const PACKAGES_PATHS = [
  { pattern: 'packages://*/tools/**', permissions: { read: true, write: true } },
  { pattern: 'packages://*/files/**', permissions: { read: true, write: true } },
  { pattern: 'packages://*/assets/**', permissions: { read: true, write: true } },
  { pattern: 'packages://*/src/**', permissions: { read: true, write: false } },
];

export type SourceConfigSeed = Record<string, unknown> & { source: string };

/**
 * The per-project source configs the wizard seeds: `packages` and `brain`.
 * Roots are stored RELATIVE to the project root so one config file works
 * across host and container layouts.
 */
export function buildSourceConfigSeeds(params: {
  projectId: string;
  createdBy: string;
  now?: string;
  hostHome?: string | undefined;
  isDocker?: boolean;
}): SourceConfigSeed[] {
  const now = params.now ?? new Date().toISOString();
  const isDocker = params.isDocker ?? (process.env.NEURALIS_DOCKER === 'true' || existsSync('/.dockerenv'));
  const hostHome = params.hostHome ?? process.env.NEURALIS_HOST_HOME;
  const hostProjectRoot = isDocker && hostHome ? join(hostHome, 'projects', params.projectId) : undefined;

  return [
    {
      source: 'packages',
      scope: { kind: 'project' },
      connection: {
        kind: 'local',
        config: {
          root: '_packages',
          ...(hostProjectRoot ? { hostRoot: join(hostProjectRoot, '_packages') } : {}),
        },
      },
      permissions: {
        default: { read: true, write: true, exec: false },
        paths: PACKAGES_PATHS,
      },
      description: PACKAGES_DESCRIPTION,
      sync: {
        exclude: DEFAULT_PACKAGES_SYNC_EXCLUDES,
        trigger: 'auto',
        alwaysActive: true,
      },
      createdAt: now,
      updatedAt: now,
      createdBy: params.createdBy,
    },
    {
      source: 'brain',
      scope: { kind: 'project' },
      connection: { kind: 'brain', config: {} },
      permissions: {
        default: { read: true, write: true, exec: false },
        byRole: { viewer: { write: false } },
        paths: [],
      },
      description: BRAIN_DESCRIPTION,
      createdAt: now,
      updatedAt: now,
      createdBy: params.createdBy,
    },
  ];
}

export type SourceConfigWriteResult = {
  /** Source names whose config file did not exist and was seeded. */
  written: string[];
  /** Source names whose existing config file was left untouched. */
  preserved: string[];
};

/** Seed missing source configs; never touch an existing one. */
export async function writeSourceConfigsPreserving(
  neuralisHome: string,
  projectId: string,
  createdBy: string,
  seeds?: SourceConfigSeed[],
): Promise<SourceConfigWriteResult> {
  const sourcesDir = join(neuralisHome, 'app', 'config', 'sources', projectId);
  await mkdir(sourcesDir, { recursive: true, mode: 0o700 });

  const written: string[] = [];
  const preserved: string[] = [];
  for (const seed of seeds ?? buildSourceConfigSeeds({ projectId, createdBy })) {
    const filePath = join(sourcesDir, `${seed.source}.json`);
    if (existsSync(filePath)) {
      preserved.push(seed.source);
      continue;
    }
    await writeFile(filePath, JSON.stringify(seed, null, 2), 'utf-8');
    written.push(seed.source);
  }
  return { written, preserved };
}

// ---------------------------------------------------------------------------
// Directory skeleton + identity records
// ---------------------------------------------------------------------------

export async function createDirectorySkeleton(neuralisHome: string, projectId: string): Promise<void> {
  const dirs = [
    join(neuralisHome, 'app'),
    join(neuralisHome, 'app', 'users'),
    join(neuralisHome, 'app', 'projects'),
    join(neuralisHome, 'app', 'config'),
    join(neuralisHome, 'app', 'config', 'sources'),
    join(neuralisHome, 'app', 'config', 'sources', projectId),
    join(neuralisHome, 'app', 'credentials'),
    join(neuralisHome, 'app', 'credentials', 'global'),
    join(neuralisHome, 'app', 'credentials', 'projects', projectId),
    join(neuralisHome, 'app', 'sessions'),
    join(neuralisHome, 'app', 'packages'),
    join(neuralisHome, 'app', 'logs'),
    join(neuralisHome, 'projects'),
    join(neuralisHome, 'projects', projectId),
    join(neuralisHome, 'projects', projectId, 'data'),
    join(neuralisHome, 'projects', projectId, '_packages'),
  ];
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
}

export async function writeOwnerRecord(config: SetupConfig): Promise<string> {
  const now = new Date().toISOString();
  const record = {
    id: config.ownerUserId,
    email: config.owner.email,
    name: config.owner.name,
    passwordHash: config.owner.passwordHash,
    status: 'active',
    mustChangePassword: false,
    createdAt: now,
    updatedAt: now,
  };
  const filePath = join(config.neuralisHome, 'app', 'users', `${config.ownerUserId}.json`);
  await writeFile(filePath, JSON.stringify(record, null, 2), 'utf-8');
  return config.ownerUserId;
}

/**
 * The project record, minimal by design.
 *
 * `roles: {}` rather than a hand-written map: the platform derives the
 * canonical role definitions from package manifests and the record migration
 * seeds them on first read, replaying every repair the record has not seen.
 * An empty map (not an absent key) is what the admin readers dereference
 * safely, and omitting `roleGrantVersion` is what makes the migration run.
 */
export function buildProjectRecord(config: SetupConfig, userId: string, now = new Date().toISOString()) {
  return {
    id: config.projectId,
    name: config.projectName,
    ownerId: userId,
    members: {
      [userId]: {
        userId,
        name: config.owner.name,
        email: config.owner.email,
        role: 'owner',
        position: 'Owner',
        tier: 1,
        addedAt: now,
      },
    },
    roles: {},
    createdAt: now,
    updatedAt: now,
  };
}

export async function writeProjectRecord(config: SetupConfig, userId: string): Promise<void> {
  const record = buildProjectRecord(config, userId);
  const filePath = join(config.neuralisHome, 'app', 'projects', `${config.projectId}.json`);
  await writeFile(filePath, JSON.stringify(record, null, 2), 'utf-8');
}

export type ExistingProject = { id: string; name: string; ownerId: string | null; archivedAt: string | null };

/** Every project record already on disk. */
export async function listExistingProjects(neuralisHome: string): Promise<ExistingProject[]> {
  const dir = join(neuralisHome, 'app', 'projects');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: ExistingProject[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(await readFile(join(dir, entry), 'utf-8')) as {
        id?: string;
        name?: string;
        ownerId?: string;
        archivedAt?: string | null;
      };
      if (raw.id) {
        out.push({
          id: raw.id,
          name: raw.name ?? raw.id,
          ownerId: typeof raw.ownerId === 'string' && raw.ownerId.trim() ? raw.ownerId.trim() : null,
          archivedAt: raw.archivedAt ?? null,
        });
      }
    } catch {
      // Unreadable record — not this function's problem to repair.
    }
  }
  return out;
}

export type SetupProjectResolution =
  | { ok: true; projectId: string; projectName: string; ownerUserId: string | null }
  | { ok: false; reason: string };

/**
 * Which project a setup run writes for, and under whose id.
 *
 * A FRESH install (no users yet) mints the id from the answered name through
 * the app's own derivation. An EXISTING install never mints: it maintains a
 * record already on disk — the non-archived one whose id is the answer exactly,
 * else the ONE non-archived record carrying the answer as its name — and hands
 * back that record's stored id and owner. A project renamed in the app keeps
 * passing, because its id never changes with its name. Refused, never guessed:
 * no record at all while users exist (the owner purged the last project — the
 * app creates the next one), an answer matching no record, a name two records
 * share (answer with the id), and a record without an owner (setup would seed
 * source configs owned by nobody).
 */
export function resolveSetupProjectId(input: {
  existingSetup: boolean;
  projects: ExistingProject[];
  answer: string;
}): SetupProjectResolution {
  const answer = input.answer.trim();
  if (!input.existingSetup) {
    return { ok: true, projectId: projectIdFromName(answer), projectName: answer, ownerUserId: null };
  }
  const live = input.projects.filter((p) => !p.archivedAt);
  if (live.length === 0) {
    return {
      ok: false,
      reason: 'This install has users but no active project record. Create the project from the app.',
    };
  }
  const byId = live.find((p) => p.id === answer);
  const byName = live.filter((p) => p.name === answer);
  if (!byId && byName.length > 1) {
    return {
      ok: false,
      reason: `More than one project is named "${answer}" (${byName.map((p) => p.id).join(', ')}). Answer with the project id.`,
    };
  }
  const match = byId ?? byName[0];
  if (!match) {
    return {
      ok: false,
      reason: `No active project is named "${answer}" or has that id. Setup maintains an existing project; create further projects from the app.`,
    };
  }
  if (!match.ownerId) {
    return { ok: false, reason: `Project "${match.id}" has no owner recorded; setup cannot seed its source configs.` };
  }
  return { ok: true, projectId: match.id, projectName: match.name, ownerUserId: match.ownerId };
}

/**
 * Source-config directories with no matching project record.
 *
 * These are the residue of an earlier bug: a re-run answered with a different
 * project name wrote a whole directory tree and three source configs for a
 * project record that was never created. They are inert (source configs are
 * read per existing project id) but confusing, so the wizard reports them.
 * It never deletes: project removal is a guarded operation that belongs to the
 * app, not to a setup script.
 */
export async function findOrphanSourceConfigDirs(neuralisHome: string): Promise<string[]> {
  const sourcesRoot = join(neuralisHome, 'app', 'config', 'sources');
  let candidates: string[];
  try {
    candidates = await readdir(sourcesRoot);
  } catch {
    return [];
  }
  const known = new Set((await listExistingProjects(neuralisHome)).map((p) => p.id));
  return candidates.filter((name) => !known.has(name) && !name.startsWith('.')).sort();
}
