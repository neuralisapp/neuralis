import { revokeGrantsPatch } from '../packages/reconcileBuiltinGrantChanges';
import { FileStore, reportStoreIntegrity, type Logger } from './FileStore';
import { getEnv } from '../config/env';
import { ensureHostDataFormat, HOST_DATA_FORMATS } from './dataFormats';
import { assertRecordFormat } from '@neuralis/package-system/data';
import { join } from 'path';
import { stat } from 'fs/promises';
import { nowISO, projectIdFromName } from '@/lib/utils';
import { BUILTIN_ROLE_PRIORITY } from '@neuralis/package-system/access';
import { isSafePathSegment, resolveProjectRoot } from '@neuralis/package-system/paths';
import { initProjectDirectory } from '../projects/projectInit';
import { validateProjectInvariants } from './projectInvariants';
import {
  DEFAULT_ROLES,
  DEFAULT_SPEND_LIMITS,
  type ProjectRecord,
  type RoleDefinition,
} from './projectTypes';

export type { ProjectRecord, ProjectMember } from './projectTypes';
export { DEFAULT_ROLES } from './projectTypes';

/**
 * The store is anchored on `globalThis` because "module-level singleton" is a
 * per-BUNDLE claim, not a per-process one — the `AuditStore` appender and the
 * `PlatformConfigStore` precedent, and this module needed it for a SECOND
 * reason those two do not have: a READ CACHE.
 *
 * Next compiles this module into every graph that imports it. The baked image
 * carries THREE copies (measured 2026-09-07: the instrumentation/bootstrap
 * graph, the route graph and the SSR graph each load a different chunk defining
 * `ProjectUpdateError` + the `cacheTtlMs` construction). Each copy got its own
 * `FileStore`, hence its own 2 s read cache AND its own `bust()` — so a write
 * from the bootstrap graph invalidated only the writer's cache while a route
 * handler kept serving pre-write bytes.
 *
 * State the window precisely: it runs for up to ~2 s **after the last read that
 * FILLED the reader's cache**, never as a fixed delay after the write. Measured
 * by bisection: the flip came at ~1.7 s when the preceding read was 200 ms
 * before the write, and at ~2.5 s when it was 3.2 s before.
 *
 * Live symptom (2026-09-07): an agent delete pruned `agentOwnership` through the
 * agent-lifecycle hook, which runs in the BOOTSTRAP graph. The record file on
 * disk was already pruned before the DELETE returned 200 — sampled at +0 ms —
 * while `GET /api/projects/<id>` still carried the key at +0 / +500 / +1500 ms
 * and only cleared at +2500 ms. A PATCH through the ROUTE graph was visible to
 * that same GET immediately, which is the control that isolates it to
 * cross-graph writes. The admin tab refetches once, ~100 ms after its DELETE,
 * so it baked the stale map into client state and the phantom row outlived the
 * window until a remount: the client was doing the right thing with wrong data,
 * which is why the fix belongs here and not in the tab.
 *
 * `Symbol.for` so every copy resolves the SAME slot. The 2 s TTL stays exactly
 * as it was: it is the authz-revocation staleness floor, and it was never the
 * defect — the defect was that a bust could not reach the other caches.
 */
const STORE_SLOT = Symbol.for('@neuralis/host:projectStore');
/**
 * The role-grant revision every seeded record carries (`roleGrantVersion`) —
 * a per-record marker, raised only by an offline upgrade together with
 * `HOST_DATA_FORMATS.project` (`roleGrantFormatLockstep.test.ts`).
 */
const ROLE_GRANT_VERSION = 19;

/**
 * A project-record signal, emitted after the write resolved, naming the users it
 * concerns. Two kinds are a REAL loss of project access: `members_removed`
 * (members dropped from the member map) and `project_closed` (archived or
 * deleted as a whole — it carries the member ids, since a deleted project cannot
 * be read afterwards). `record_changed` is NOT a loss: a created, restored or
 * patched record changed what its members may see (name, description, members,
 * roles), and `userIds` is the member set BEFORE ∪ AFTER, so a removed member's
 * project list drops it too. The migrate-on-read persist emits nothing.
 */
export type MembershipChangeEvent =
  | { kind: 'members_removed'; projectId: string; userIds: string[] }
  | { kind: 'project_closed'; projectId: string; cause: 'archived' | 'deleted'; userIds: string[] }
  | { kind: 'record_changed'; projectId: string; userIds: string[] };

export type MembershipChangeListener = (event: MembershipChangeEvent) => void;

/** `globalThis`-anchored for the reason `UserStore`'s listener set is. */
const LISTENERS_SLOT = Symbol.for('@neuralis/host:projectStoreListeners');

function membershipListeners(): Set<MembershipChangeListener> {
  const g = globalThis as { [LISTENERS_SLOT]?: Set<MembershipChangeListener> };
  return (g[LISTENERS_SLOT] ??= new Set());
}

export function onMembershipChange(listener: MembershipChangeListener): () => void {
  membershipListeners().add(listener);
  return () => {
    membershipListeners().delete(listener);
  };
}

/** Called AFTER the write resolved — never inside the store's per-path chain. */
function emitMembershipChange(event: MembershipChangeEvent): void {
  for (const listener of membershipListeners()) {
    try {
      listener(event);
    } catch (err) {
      console.error('[ProjectStore] membership listener threw', err);
    }
  }
}

function emitRemovedMembers(
  projectId: string,
  before: ProjectRecord['members'],
  after: ProjectRecord['members'],
): void {
  const userIds = Object.keys(before).filter((userId) => before[userId] && !after[userId]);
  if (userIds.length > 0) emitMembershipChange({ kind: 'members_removed', projectId, userIds });
}

function emitRecordChanged(projectId: string, ...memberMaps: ProjectRecord['members'][]): void {
  const userIds = [...new Set(memberMaps.flatMap((members) => Object.keys(members)))];
  if (userIds.length > 0) emitMembershipChange({ kind: 'record_changed', projectId, userIds });
}

/**
 * The workspace-facing view of `record_changed`: fires only for a record the
 * given user is (or just was) a member of, and hands over the project id ALONE —
 * no name, no member ids. The client re-reads through the projected
 * `GET /api/projects`, which applies that caller's own view.
 */
export function onProjectRecordChange(
  userId: string,
  listener: (event: { projectId: string }) => void,
): () => void {
  return onMembershipChange((event) => {
    if (event.kind !== 'record_changed' || !event.userIds.includes(userId)) return;
    listener({ projectId: event.projectId });
  });
}

export class ProjectUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectUpdateError';
  }
}

/**
 * Liveness probe for the enumerated admin union — the floor of the ONE role
 * seed (`seedRolesForNewProject`).
 *
 * `DEFAULT_ROLES.admin.grantedFeatures` is derived at module load from every
 * builtin manifest through `readPackageRequires`, whose body swallows ALL read
 * errors (`catch { return undefined }`), over a builtin set the `NEURALIS_BUILTINS`
 * env var can override (documented for slim images). A missing, unreadable or
 * deliberately-narrowed manifest therefore yields a SHORT or EMPTY union with no
 * throw and no log — and a seed would persist it at `roleGrantVersion:
 * ROLE_GRANT_VERSION`, which nothing at runtime revisits: every project admin
 * would lose the dashboard, credentials, config, canvas, logs, terminal,
 * workflows, MCP and every `core.*` id, silently and permanently, and the three
 * non-admin builtins would be seeded from the same degenerate lists.
 *
 * So the seed fails CLOSED on one id from each of the three packages that must
 * be present in a healthy union: `createProject` refuses and persists nothing,
 * and a setup-written record stays unseeded (its empty role map grants nothing)
 * until a boot with every builtin manifest readable seeds it.
 */
const DEWILDCARD_LIVENESS_IDS = ['project.dashboard', 'drive.read', 'core.agents'] as const;

let warnedDegenerateAdminGrants = false;

/**
 * `true` when the manifest-derived union is safe to persist as `admin`'s
 * enumerated grant list. Exported because it is the ONE predicate both writers
 * share — do not re-implement it at a third write site.
 */
export function adminGrantUnionIsLive(nextAdminGrants: readonly string[]): boolean {
  if (nextAdminGrants.length === 0) return false;
  return DEWILDCARD_LIVENESS_IDS.every((id) => nextAdminGrants.includes(id));
}

function getStore(): FileStore<ProjectRecord> {
  const g = globalThis as { [STORE_SLOT]?: FileStore<ProjectRecord> };
  // Short read-cache: the catch-all reads every project from disk on EVERY
  // request (membership/role/disabled gates), which contends with stream disk
  // I/O. A 2s TTL collapses request-burst reads to one disk hit while bounding
  // authz-revocation staleness to the TTL even across an out-of-band writer.
  // ONE instance per PROCESS (see STORE_SLOT) — never per bundle, or a write in
  // one graph leaves the other graphs' caches serving stale bytes.
  return (g[STORE_SLOT] ??= new FileStore<ProjectRecord>(
    join(getEnv().appRoot, 'projects'),
    { cacheTtlMs: 2_000 },
  ));
}

/**
 * The store behind every operation: the host data-format claim runs first, so
 * no project record is read — and migrated-on-read — by a build older than the
 * data (one resolved promise + a Map lookup after the first call).
 */
async function claimedStore(): Promise<FileStore<ProjectRecord>> {
  await ensureHostDataFormat(HOST_DATA_FORMATS.project);
  return getStore();
}

/**
 * THE per-record write floor. Role-grant and host identity format revisions
 * are independent markers: a record stamped by a NEWER build stays readable, but this build
 * refuses to write it (`RecordNewerError`) — every write here would run this
 * build's normalizers over fields it does not know.
 */
function assertProjectRecordWritable(raw: unknown): void {
  assertRecordFormat(HOST_DATA_FORMATS.project.kind, storedRoleGrantVersion(raw), ROLE_GRANT_VERSION);
  assertRecordFormat(HOST_DATA_FORMATS.project.kind, (raw as { formatVersion?: number } | null)?.formatVersion, HOST_DATA_FORMATS.project.version);
}

function isNewerProjectRecord(raw: unknown): boolean {
  const stored = storedRoleGrantVersion(raw);
  const format = (raw as { formatVersion?: number } | null)?.formatVersion;
  return (stored !== undefined && stored > ROLE_GRANT_VERSION) || (typeof format === 'number' && format > HOST_DATA_FORMATS.project.version);
}

function storedRoleGrantVersion(raw: unknown): number | undefined {
  const stored = (raw as { roleGrantVersion?: unknown } | null)?.roleGrantVersion;
  return typeof stored === 'number' ? stored : undefined;
}

/**
 * The purged-id tombstones, beside (never inside) `app/projects/`: four readers
 * parse every `*.json` in that directory as a project record. No read cache — a
 * tombstone is consulted only when an id is minted.
 */
function purgedIdsDir(): string {
  return join(getEnv().appRoot, 'projects-purged');
}

/**
 * Record that `id` was permanently deleted, so it is never minted again. Written
 * as the FIRST step of a purge: a purge that fails half-way still blocks the id,
 * and a retry rewrites the same tombstone. Anything a package keyed by the id and
 * failed to remove (vectors, desktop profiles, tokens) can never be inherited by
 * a later project of the same name. Restoring a record that is tombstoned but was
 * never purged (the purge failed before the record went) stays legal; the
 * tombstone is then inert, since the record itself already holds the id.
 */
export async function markProjectIdPurged(id: string): Promise<void> {
  await ensureHostDataFormat(HOST_DATA_FORMATS.projectPurged);
  await new FileStore<{ id: string; purgedAt: string }>(purgedIdsDir()).put(id, { id, purgedAt: nowISO() });
}

/**
 * An id is taken while ANY tenant-keyed trace of it exists, not only a record:
 * `initProjectDirectory` creates INTO an existing tree, the source-config and
 * project-credential dirs are keyed by the same id (so a surviving credential blob
 * would decrypt for the new tenant), and a purged id keeps its tombstone. Any stat
 * error other than ENOENT is RETHROWN: the create is refused. Answering "taken"
 * instead would spin `resolveUniqueId` forever on an unreadable root.
 */
async function isProjectIdTaken(candidate: string): Promise<boolean> {
  if (await (await claimedStore()).get(candidate)) return true;
  const { projectsRoot, appRoot } = getEnv();
  const traces = [
    () => resolveProjectRoot(projectsRoot, candidate),
    () => join(appRoot, 'config', 'sources', candidate),
    () => join(appRoot, 'credentials', 'projects', candidate),
    () => join(purgedIdsDir(), `${candidate}.json`),
  ];
  for (const trace of traces) {
    try {
      await stat(trace());
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return false;
}

async function resolveUniqueId(baseId: string): Promise<string> {
  let candidate = baseId;
  let n = 2;
  while (await isProjectIdTaken(candidate)) {
    candidate = `${baseId}-${n}`;
    n += 1;
  }
  return candidate;
}

/**
 * The project record as this build reads it — the ONE read normalizer, applied
 * on every read (and persisted by `getAndMigrate` when it changed anything).
 *
 * A record setup wrote is born UNSEEDED (an empty role map, no
 * `roleGrantVersion`, no `agentOwnership`, no `limits`: setup cannot derive the
 * role catalog, the host derives it from the package manifests). Its first read
 * seeds it through the ONE `seedRolesForNewProject`, the same seed
 * `createProject` stamps, and fills the two defaults setup does not write.
 *
 * Nothing else is converted. Every record since role-grant version 19 is born
 * current (both writers seed at 19), so a record is either current or unseeded.
 * A role-grant change after 19 — a new `defaultRoleGrants` feature for existing
 * projects, a rename, a revoke — ships as an OFFLINE upgrade module under
 * `scripts/upgrades/` that raises `neuralis/project` in the same change, never
 * as a replay table read here. A record stamped by a NEWER build is served as
 * read and never rewritten (`assertProjectRecordWritable`).
 */
export function migrateProjectRecord(raw: Record<string, unknown>): ProjectRecord {
  const r = raw as ProjectRecord;
  if (isUnseededProjectRecord(r)) {
    const seeded = seedRolesForNewProject();
    if (seeded) {
      r.roles = seeded.roles;
      r.roleGrantVersion = seeded.roleGrantVersion;
    } else {
      // Fail closed: an empty role map grants nothing, and nothing is persisted.
      r.roles = r.roles ?? {};
      if (!warnedDegenerateAdminGrants) {
        warnedDegenerateAdminGrants = true;
        console.warn(
          `[ProjectStore] project "${String(r.id ?? '<unknown>')}" was NOT seeded: the builtin feature union is ` +
            `degenerate (${DEFAULT_ROLES.admin.grantedFeatures.length} ids; expected ${DEWILDCARD_LIVENESS_IDS.join(', ')}). ` +
            'Its role map stays empty (nobody holds a feature) until a boot with every builtin manifest readable seeds it.',
        );
      }
    }
  }
  if (!r.agentOwnership) r.agentOwnership = {};
  if (!r.limits) r.limits = { spend: structuredClone(DEFAULT_SPEND_LIMITS) };
  return r;
}

/** Setup's shape: no role map and no `roleGrantVersion` — the one record `migrateProjectRecord` seeds. */
function isUnseededProjectRecord(r: Partial<ProjectRecord>): boolean {
  return r.roleGrantVersion === undefined && (!r.roles || Object.keys(r.roles).length === 0);
}

/** Would `migrateProjectRecord` change this record? A constant-time gate for the list readers. */
function projectRecordNeedsMigration(raw: Partial<ProjectRecord>): boolean {
  return isUnseededProjectRecord(raw) || !raw.agentOwnership || !raw.limits;
}

async function getAndMigrate(id: string): Promise<ProjectRecord | null> {
  const store = await claimedStore();
  const raw = await store.get(id);
  if (!raw) return null;
  return persistMigrated(store, id, raw);
}

/**
 * The ONE read normalizer's persist: migrate, and write back only when the
 * migration changed something. A list read goes through here for exactly the
 * records {@link projectRecordNeedsMigration} names, so a setup-written project
 * is persisted seeded by whichever host read meets it first.
 */
async function persistMigrated(
  store: Awaited<ReturnType<typeof claimedStore>>,
  id: string,
  raw: ProjectRecord,
): Promise<ProjectRecord> {
  // A newer build's record is served as read, never migrated back to disk.
  if (isNewerProjectRecord(raw)) return migrateProjectRecord(raw as unknown as Record<string, unknown>);
  // Snapshot BEFORE migrating: migrateProjectRecord mutates `raw` in place,
  // so comparing raw to its own return value was a self-comparison and the
  // persist branch was dead — roleGrantVersion/repairs never landed on disk
  // (re-applied in memory on every read; MCP1 Inc2 live-test finding).
  const before = JSON.stringify(raw);
  const migrated = migrateProjectRecord(raw as unknown as Record<string, unknown>);
  if (before === JSON.stringify(migrated)) return migrated;
  // This is a put-on-READ: a plain `getProjectById` writes. Doing it with the
  // record read OUTSIDE the store's chain is how a read could overwrite a write
  // that landed in between, so the persist re-reads and re-migrates INSIDE the
  // chain — and writes nothing when another writer already migrated it.
  const persisted = await store.update(id, (current) => {
    if (!current || isNewerProjectRecord(current)) return undefined;
    const currentRaw = JSON.stringify(current);
    // Mutates `current` in place, which is exactly what we want to hand back on
    // the no-write branch: `update` returns the record it read.
    const currentMigrated = migrateProjectRecord(current as unknown as Record<string, unknown>);
    return currentRaw === JSON.stringify(currentMigrated) ? undefined : currentMigrated;
  });
  // A record deleted between the read and the persist leaves the in-memory
  // migration as the honest answer for this READ.
  return persisted ?? migrated;
}

/**
 * Patch shape for {@link updateProject} — the fields a general project write may
 * touch. `archivedAt` / `packageTrust` / `packageAccessFeature` are deliberately
 * absent: they have their own narrow setters so a member/role/limits patch can
 * never archive a project or move a trust override.
 */
export type ProjectRecordPatch = Partial<
  Pick<
    ProjectRecord,
    'name' | 'description' | 'members' | 'roles' | 'agentOwnership' | 'limits' | 'appliedPackageGrants' | 'packageGrantFeatures'
  >
> & {
  /** `null` clears the appearance; absent keeps it. */
  appearance?: ProjectRecord['appearance'] | null;
};

/**
 * The PRODUCER form of a project patch: it is handed the record as it is ON DISK
 * inside the store's per-path chain and returns the patch to apply, or `null` to
 * write nothing.
 *
 * This is the shape every writer that computes its patch FROM the record must
 * use. The object form reads the record once, computes, and writes — so two
 * concurrent writers compute from the same base and the second erases the
 * first's fields (measured live: three concurrent package-grant revocations left
 * 2 of 3 markers standing). A producer's map is built from the record the chain
 * just read, so the merge is atomic.
 *
 * A producer re-derives its own AUTHORIZATION floor from the record it is handed
 * too — never from the snapshot its caller read earlier. A mismatch returns
 * `null` (no write) and the caller answers its own denial code.
 */
export type ProjectPatchProducer = (current: ProjectRecord) => ProjectRecordPatch | null;

/**
 * Read-modify-write a project record INSIDE the store's per-path chain.
 *
 * Module-private on purpose: it is the ONE place the migrate → mutate → write
 * sequence lives, shared by `updateProject` and the three narrow setters. `fn`
 * sees a MIGRATED record; returning `undefined` writes nothing. `null` comes
 * back only when the record does not exist.
 */
async function mutateProject(
  id: string,
  fn: (current: ProjectRecord) => ProjectRecord | undefined,
): Promise<ProjectRecord | null> {
  // A mutable holder rather than a plain `let`: TypeScript does not track an
  // assignment made inside a callback, so a narrowed local would read as `null`.
  const captured: { migrated: ProjectRecord | null; next: ProjectRecord | undefined } = {
    migrated: null,
    next: undefined,
  };
  const stored = await (await claimedStore()).update(id, (raw) => {
    if (!raw) return undefined;
    assertProjectRecordWritable(raw);
    captured.migrated = migrateProjectRecord(raw as unknown as Record<string, unknown>);
    captured.next = fn(captured.migrated);
    return captured.next;
  });
  if (stored === null) return null;
  return captured.next ?? captured.migrated;
}

/** Apply a patch with the field rules every project write shares. */
function applyProjectPatch(project: ProjectRecord, patch: ProjectRecordPatch): ProjectRecord {
  let packageGrantFeatures = patch.packageGrantFeatures ?? project.packageGrantFeatures;
  if (patch.roles && patch.packageGrantFeatures === undefined && packageGrantFeatures) {
    packageGrantFeatures = Object.fromEntries(Object.entries(packageGrantFeatures).map(([id, claims]) => [id,
      Object.fromEntries(Object.entries(claims).map(([role, features]) => [role,
        features.filter((feature) => Boolean(project.roles[role]?.grantedFeatures.includes(feature)) === Boolean(patch.roles?.[role]?.grantedFeatures.includes(feature))),
      ])),
    ]));
  }
  return {
    ...project,
    name: patch.name ?? project.name,
    description: patch.description !== undefined ? patch.description : project.description,
    appearance: patch.appearance !== undefined ? patch.appearance ?? undefined : project.appearance,
    members: patch.members ?? project.members,
    roles: patch.roles ?? project.roles,
    agentOwnership: patch.agentOwnership ?? project.agentOwnership,
    // Field-wise merge (periodic-pelican, F4): a spend-only patch must not
    // silently erase `rateLimitRpm` (and vice versa). The old whole-object
    // replace was the `{"roles":{}}`-wipe class in a shape the historical fix
    // did not cover.
    // The stored limits are the BASE, so a key this build does not know (one a
    // newer build added) survives a limits patch instead of being dropped.
    limits: patch.limits
      ? {
          ...project.limits,
          spend: patch.limits.spend ?? project.limits.spend,
          rateLimitRpm:
            'rateLimitRpm' in patch.limits ? patch.limits.rateLimitRpm : project.limits.rateLimitRpm,
        }
      : project.limits,
    appliedPackageGrants: patch.appliedPackageGrants ?? project.appliedPackageGrants,
    packageGrantFeatures,
    updatedAt: nowISO(),
  };
}

/**
 * THE role seed of a project record — `createProject` stamps it on a new
 * record, `migrateProjectRecord` on the record setup wrote. `null` when the
 * admin union is degenerate (`adminGrantUnionIsLive`): the system cannot
 * compute what the roles should CONTAIN, so it seeds nothing — R-4 measured
 * that seeding anyway leaves permanent damage (`manager` / `member` / `viewer`
 * seeded from the same degenerate module-load lists, measured `0/33`, `0/19`,
 * `0/7`, with nothing at runtime ever revisiting them).
 *
 * A "refill empty builtin roles" repair is deliberately NOT the answer to a
 * degenerate seed: an empty `grantedFeatures` list is also what a deliberate
 * revoke leaves behind (`PATCH /config/roles` accepts truncating a surviving
 * role), so the fingerprint is ambiguous and a repair would silently undo an
 * operator's intent. The same holds for a custom priority-1 role, where an
 * empty list is a coherent governance-only design — never widen one.
 */
function seedRolesForNewProject(): { roles: Record<string, RoleDefinition>; roleGrantVersion: number } | null {
  if (!adminGrantUnionIsLive(DEFAULT_ROLES.admin.grantedFeatures)) return null;
  return { roles: { ...DEFAULT_ROLES }, roleGrantVersion: ROLE_GRANT_VERSION };
}

export async function createProject(
  name: string,
  ownerId: string,
  description?: string,
  ownerProfile?: { name: string; email: string },
): Promise<ProjectRecord> {
  const store = await claimedStore();
  const baseId = projectIdFromName(name);
  const now = nowISO();

  // The ONE seed, fail-closed: a degenerate admin union persists nothing. The
  // single server-side caller (`POST /api/projects`) answers this throw `409`.
  const seededRoles = seedRolesForNewProject();
  if (!seededRoles) {
    throw new Error(
      `ROLE_SEED_UNION_DEGENERATE: createProject("${name}") refused — the builtin feature ` +
        `union is degenerate (${DEFAULT_ROLES.admin.grantedFeatures.length} ids; expected at least ` +
        `${DEWILDCARD_LIVENESS_IDS.join(', ')}). Nothing was written. A boot with every builtin ` +
        'manifest readable (check NEURALIS_BUILTINS and the node_modules/@neuralis/* tree) seeds ' +
        'the project correctly; seeding it now would leave manager/member/viewer permanently ' +
        "empty and hand admin a list that no later boot repairs.",
    );
  }

  const seed: Omit<ProjectRecord, 'id'> = {
    name,
    description,
    ownerId,
    members: {
      [ownerId]: {
        userId: ownerId,
        name: ownerProfile?.name ?? '',
        email: ownerProfile?.email ?? '',
        role: 'owner',
        position: 'Owner',
        // Mirror of the role's priority — derived from the anchor, never a
        // literal, so the scale can move without a silent drift here.
        tier: BUILTIN_ROLE_PRIORITY.owner,
        addedAt: now,
      },
    },
    roles: seededRoles.roles,
    agentOwnership: {},
    limits: { spend: structuredClone(DEFAULT_SPEND_LIMITS) },
    roleGrantVersion: seededRoles.roleGrantVersion,
    formatVersion: 2,
    createdAt: now,
    updatedAt: now,
  };
  // The free-id check reads outside any chain; the CLAIM does not. Two creates
  // of one name can both see the id free — only the first claim writes it, the
  // other moves on to the next free id instead of overwriting that record.
  let project: ProjectRecord;
  for (;;) {
    const candidate: ProjectRecord = { id: await resolveUniqueId(baseId), ...seed };
    const claimed = await store.update(candidate.id, (current) => (current ? undefined : candidate));
    if (claimed === candidate) {
      project = candidate;
      break;
    }
  }
  const { id } = project;

  try {
    await initProjectDirectory(id, ownerId);
  } catch (err) {
    // A project some package never provisioned is broken with no self-heal, so
    // the claimed record does not survive its failed init: the purge path
    // removes whatever was already provisioned, the tree and the record (the id
    // is tombstoned, never re-minted). The original error is what the caller sees.
    await rollBackFailedCreate(id);
    throw err;
  }
  emitRecordChanged(id, project.members);
  return project;
}

async function rollBackFailedCreate(id: string): Promise<void> {
  try {
    const { archiveProject, purgeProject } = await import('../projects/projectDeletion');
    await archiveProject(id);
    await purgeProject(id);
  } catch (err) {
    // eslint-disable-next-line no-console -- host project-lifecycle diagnostic, the sibling idiom (projectDeletion)
    console.error(
      `[ProjectStore] rollback of failed create "${id}" did not complete (${err instanceof Error ? err.name : typeof err}); an owner can purge it`,
    );
  }
}

export async function getProjectById(id: string): Promise<ProjectRecord | null> {
  // An id that cannot name a record file cannot be a project: it answers the
  // same "no such project" every caller already handles, never the store's
  // path-guard throw (an unhandled 500 at every route that looks a project up).
  if (!isSafePathSegment(id)) return null;
  return getAndMigrate(id);
}

export async function listProjectsForUser(
  userId: string,
  { includeArchived = false }: { includeArchived?: boolean } = {},
): Promise<ProjectRecord[]> {
  const store = await claimedStore();
  const all = await store.list();
  const results: ProjectRecord[] = [];
  for (const raw of all) {
    const migrated = await readListed(store, raw);
    if (!includeArchived && migrated.archivedAt != null) continue;
    const isMember = migrated.members[userId] !== undefined;
    if (isMember) results.push(migrated);
  }
  return results;
}

/**
 * The ONE general project write, in two forms.
 *
 * OBJECT patch — the caller already holds the whole map it wants persisted (the
 * client sends `members`/`roles` wholesale on `PATCH /api/projects/[id]`). The
 * map REPLACES rather than merges, deliberately: an omitted key is a delete, and
 * the role-map write floor is built on that.
 *
 * PRODUCER patch — the caller computes its patch FROM the record. Everything
 * that does must use this form; see {@link ProjectPatchProducer} for why.
 *
 * Both run migrate → patch → merge → `validateProjectInvariants` (throwing
 * `ProjectUpdateError`) inside the store's per-path chain. `name` is a display
 * label like any other field: the id is fixed at creation and NEVER re-derived
 * from a name — every tenant-keyed store (data tree, vectors, source configs,
 * credentials, webtop volumes, OAuth tokens) hangs off it.
 */
export async function updateProject(
  id: string,
  patch: ProjectRecordPatch | ProjectPatchProducer,
): Promise<ProjectRecord | null> {
  const seen: { before: ProjectRecord['members'] | null; after: ProjectRecord['members'] | null } = {
    before: null,
    after: null,
  };
  const result = await mutateProject(id, (project) => {
    const produced = typeof patch === 'function' ? patch(project) : patch;
    if (produced === null) return undefined;
    const updated = applyProjectPatch(project, produced);
    // ONE invariant body, shared with the HTTP patch path (`projects/access.ts`).
    // Note the deliberate tightening: this also validates `agentOwnership`,
    // which the local copy did not. Every entry that ever reached disk went
    // through `validateAgentOwnership` (a superset check) on the PATCH route, so
    // no existing record can start failing.
    const invariantError = validateProjectInvariants(updated);
    if (invariantError) throw new ProjectUpdateError(invariantError);
    seen.before = project.members;
    seen.after = updated.members;
    return updated;
  });
  if (seen.before && seen.after) {
    emitRemovedMembers(id, seen.before, seen.after);
    emitRecordChanged(id, seen.before, seen.after);
  }
  return result;
}

export async function listAllProjects(
  { includeArchived = false }: { includeArchived?: boolean } = {},
): Promise<ProjectRecord[]> {
  const store = await claimedStore();
  const all = await store.list();
  const migrated: ProjectRecord[] = [];
  for (const raw of all) migrated.push(await readListed(store, raw));
  return includeArchived ? migrated : migrated.filter((p) => p.archivedAt == null);
}

/** A listed record, normalized — persisted through {@link persistMigrated} only when the migration changes it. */
async function readListed(store: Awaited<ReturnType<typeof claimedStore>>, raw: ProjectRecord): Promise<ProjectRecord> {
  if (!projectRecordNeedsMigration(raw) || typeof raw.id !== 'string' || !isSafePathSegment(raw.id)) {
    return migrateProjectRecord(raw as unknown as Record<string, unknown>);
  }
  return persistMigrated(store, raw.id, raw);
}

export async function deleteProject(id: string): Promise<boolean> {
  // The members are read BEFORE the delete: a deleted project cannot be read
  // afterwards, and the listeners must know whose access just ended.
  const store = await claimedStore();
  const userIds = Object.keys((await store.get(id))?.members ?? {});
  const deleted = await store.delete(id);
  if (deleted) emitMembershipChange({ kind: 'project_closed', projectId: id, cause: 'deleted', userIds });
  return deleted;
}

/**
 * happy-wondering-yeti — set or clear the soft-archive marker. Narrow setter
 * mirroring `setPackageTrust`/`setPackageAccessFeature`: deliberately NOT part of
 * `updateProject`'s Pick, so a general member/role/limits patch can never
 * archive/restore a project. `archivedAt = ISO string` archives; `null` restores.
 */
export async function setProjectArchived(
  id: string,
  archivedAt: string | null,
): Promise<ProjectRecord | null> {
  const seen = { archived: false, restored: false, userIds: [] as string[] };
  const result = await mutateProject(id, (project) => {
    seen.archived = archivedAt != null && project.archivedAt == null;
    seen.restored = archivedAt == null && project.archivedAt != null;
    seen.userIds = Object.keys(project.members);
    return {
      ...project,
      archivedAt: archivedAt ?? undefined,
      updatedAt: nowISO(),
    };
  });
  if (result && seen.archived) {
    emitMembershipChange({ kind: 'project_closed', projectId: id, cause: 'archived', userIds: seen.userIds });
  }
  if (result && seen.restored && seen.userIds.length > 0) {
    emitMembershipChange({ kind: 'record_changed', projectId: id, userIds: seen.userIds });
  }
  return result;
}

/**
 * Set or clear the trust override for a specific package within a project.
 * `null` removes the override, reverting the package to its manifest-declared
 * default trust (typically `untrusted`). Narrower than `updateProject` to avoid
 * inadvertent overwrites from admin routes that patch unrelated fields.
 */
export async function setPackageTrust(
  projectId: string,
  packageId: string,
  trust: 'trusted' | 'untrusted' | null,
): Promise<ProjectRecord | null> {
  return mutateProject(projectId, (project) => {
    const nextTrust: Record<string, 'trusted' | 'untrusted'> = { ...(project.packageTrust ?? {}) };
    if (trust === null) {
      delete nextTrust[packageId];
    } else {
      nextTrust[packageId] = trust;
    }
    return {
      ...project,
      packageTrust: Object.keys(nextTrust).length > 0 ? nextTrust : undefined,
      updatedAt: nowISO(),
    };
  });
}

/**
 * R2b (scope-guarding-magpie) — set or clear the owner/admin base-access feature
 * OVERRIDE for a package within a project. `null` removes the override. Exact
 * sibling of `setPackageTrust`: narrower than `updateProject` to avoid
 * inadvertent overwrites. RESTRICT-ONLY by construction — it only attaches a
 * required feature, there is no grant path, so it can never weaken a floor.
 */
export async function setPackageAccessFeature(
  projectId: string,
  packageId: string,
  featureId: string | null,
): Promise<ProjectRecord | null> {
  return mutateProject(projectId, (project) => {
    const next: Record<string, string> = { ...(project.packageAccessFeature ?? {}) };
    if (featureId === null) {
      delete next[packageId];
    } else {
      next[packageId] = featureId;
    }
    return {
      ...project,
      packageAccessFeature: Object.keys(next).length > 0 ? next : undefined,
      updatedAt: nowISO(),
    };
  });
}

export async function ensureDefaultProject(
  userId: string,
  profile?: { name: string; email: string },
): Promise<ProjectRecord> {
  const userProjects = await listProjectsForUser(userId);
  if (userProjects.length > 0) return userProjects[0]!;
  throw new Error(
    profile
      ? `No project exists for user ${profile.email}. Run setup or create a project explicitly.`
      : 'No project exists for this user. Run setup or create a project explicitly.',
  );
}

/**
 * Boot integrity check: logs every project record that exists but cannot be read
 * or parsed (`list` skips those silently), by relative path, plus the scan time.
 * Reads disk once, outside the data-format claim — it migrates and writes nothing.
 */
export function verifyProjectRecords(logger: Logger): Promise<number> {
  return reportStoreIntegrity(getStore(), 'app/projects', logger);
}

/** Only the scanner's positively proved deletions may clear mutable instance provenance. */
export async function removeDeletedPackageReferences(projectId: string, packageId: string, revoke: ReadonlySet<string>): Promise<void> {
  await mutateProject(projectId, (project) => {
    const packageTrust = { ...project.packageTrust };
    const packageAccessFeature = { ...project.packageAccessFeature };
    const hadMutable = packageId in packageTrust || packageId in packageAccessFeature;
    delete packageTrust[packageId];
    delete packageAccessFeature[packageId];
    const patch = revokeGrantsPatch(project, packageId, revoke);
    if (!hadMutable && !patch) return undefined;
    return { ...project, ...(patch?.roles ? { roles: patch.roles } : {}),
      appliedPackageGrants: patch?.appliedPackageGrants ?? project.appliedPackageGrants, packageGrantFeatures: patch?.packageGrantFeatures ?? project.packageGrantFeatures, packageTrust, packageAccessFeature, updatedAt: nowISO() };
  });
}
