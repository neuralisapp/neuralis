import { FileStore, reportStoreIntegrity, type Logger } from './FileStore';
import { getEnv } from '../config/env';
import { ensureHostDataFormat, HOST_DATA_FORMATS } from './dataFormats';
import { join } from 'path';
import { isSafePathSegment } from '@neuralis/package-system/paths';
import { generateId, nowISO } from '@/lib/utils';
import {
  decodeAppearanceUpload,
  removeAllAppearanceImages,
  writeAppearanceImage,
  type StoredAppearance,
  type StoredAppearanceImage,
} from '../appearance/appearanceImageStore';

/**
 * Visual appearance customisation per user. Surfaced through `UserAvatar`
 * and the dock-left UserInfo button. Every field is optional — when
 * everything is undefined the avatar falls back to the deterministic HSL
 * + initial-letter rendering keyed on `userId`. The picture is stored as a
 * content-addressed file under `<appRoot>/users-assets/<userId>/`; the record
 * carries only the reference.
 */
export type UserAppearance = StoredAppearance;

/**
 * `deleted` is a TOMBSTONE ({@link tombstoneUser}): terminal, never re-enabled —
 * a re-enable would revive every cookie the user still holds.
 */
export type UserStatus = 'active' | 'disabled' | 'deleted';

export type UserRecord = {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  status: UserStatus;
  mustChangePassword: boolean;
  /**
   * Session generation. A cookie session carries the epoch it was issued under
   * and is refused once the record's epoch differs, so a bump signs the user out
   * on every device. Absent reads as 0.
   */
  sessionEpoch?: number;
  disabledAt?: string;
  disabledBy?: string;
  deletedAt?: string;
  deletedBy?: string;
  /** The address a tombstone held; `email` itself is released for reuse. */
  deletedEmail?: string;
  invitedBy?: string;
  lastLoginAt?: string;
  appearance?: UserAppearance;
  createdAt: string;
  updatedAt: string;
};

/** Migrate legacy records that lack new fields. */
function migrateUserRecord(raw: UserRecord): UserRecord {
  if (!raw.status) raw.status = 'active';
  if (raw.mustChangePassword === undefined) raw.mustChangePassword = false;
  return raw;
}

/**
 * The record half of "may this principal hold a session": only `active`. Every
 * identity producer reaches it through `resolveActiveUser`
 * (`server/auth/memberSession.ts`); a `status !== 'disabled'` test instead would
 * admit a tombstone.
 */
export function isActiveUser(record: Pick<UserRecord, 'status'> | null | undefined): boolean {
  return record?.status === 'active';
}

/** The epoch a record is at; absent is 0. */
export function sessionEpochOf(record: Pick<UserRecord, 'sessionEpoch'>): number {
  return typeof record.sessionEpoch === 'number' ? record.sessionEpoch : 0;
}

// ---------------------------------------------------------------------------
// Change signal — who may hold a session has changed
// ---------------------------------------------------------------------------

type UserSessionState = { status: UserStatus; sessionEpoch: number };

/**
 * A REAL transition of the fields that decide whether a principal may hold a
 * session: `status`, `sessionEpoch`, or the record's removal (`after: null`).
 * A rename, an appearance edit or a `lastLoginAt` stamp emits nothing.
 */
export type UserChangeEvent = {
  userId: string;
  before: UserSessionState | null;
  after: UserSessionState | null;
};

export type UserChangeListener = (event: UserChangeEvent) => void;

/**
 * On `globalThis` for the same reason as {@link STORE_SLOT}: the admin routes
 * WRITE in the route graph and the revocation fan-out SUBSCRIBES in the
 * instrumentation graph, so a module-level set would be one set per graph and
 * the event would never arrive.
 */
const LISTENERS_SLOT = Symbol.for('@neuralis/host:userStoreListeners');

function listeners(): Set<UserChangeListener> {
  const g = globalThis as { [LISTENERS_SLOT]?: Set<UserChangeListener> };
  return (g[LISTENERS_SLOT] ??= new Set());
}

export function onUserChange(listener: UserChangeListener): () => void {
  listeners().add(listener);
  return () => {
    listeners().delete(listener);
  };
}

function sessionStateOf(record: UserRecord | null): UserSessionState | null {
  if (!record) return null;
  return { status: migrateUserRecord({ ...record }).status, sessionEpoch: sessionEpochOf(record) };
}

/** Called AFTER the write resolved — never inside the store's per-path chain. */
function emit(event: UserChangeEvent): void {
  for (const listener of listeners()) {
    try {
      listener(event);
    } catch (err) {
      console.error('[UserStore] change listener threw', err);
    }
  }
}

function emitIfTransition(userId: string, before: UserSessionState | null, after: UserSessionState | null): void {
  if (!before || !after) return;
  if (before.status === after.status && before.sessionEpoch === after.sessionEpoch) return;
  emit({ userId, before, after });
}

/**
 * `globalThis`-anchored for the same reason as `ProjectStore` — see its
 * `STORE_SLOT` docblock. A module-level `let` is per-BUNDLE, and this module is
 * compiled into several server graphs, so a per-copy `FileStore` means a
 * per-copy read cache that a `bust()` in another graph cannot reach. Here the
 * stale window is a DISABLED-USER revocation, which makes it an authz floor
 * rather than a display bug.
 */
const STORE_SLOT = Symbol.for('@neuralis/host:userStore');

function getStore(): FileStore<UserRecord> {
  const g = globalThis as { [STORE_SLOT]?: FileStore<UserRecord> };
  // Short read-cache (see ProjectStore): the catch-all resolves the user on
  // every request; a 2s TTL relieves per-request disk reads while bounding
  // disabled-user revocation staleness to the TTL even across processes.
  return (g[STORE_SLOT] ??= new FileStore<UserRecord>(
    join(getEnv().appRoot, 'users'),
    { cacheTtlMs: 2_000 },
  ));
}

/** The store behind every operation, after the host data-format claim (see `dataFormats.ts`). */
async function claimedStore(): Promise<FileStore<UserRecord>> {
  await ensureHostDataFormat(HOST_DATA_FORMATS.user);
  return getStore();
}

export async function createUser(
  email: string,
  name: string,
  passwordHash: string,
  opts?: { status?: Exclude<UserStatus, 'deleted'>; mustChangePassword?: boolean; invitedBy?: string },
): Promise<UserRecord> {
  const store = await claimedStore();
  const existing = await findUserByEmail(email);
  if (existing) throw new Error(`User with email ${email} already exists`);

  const id = generateId();

  const user: UserRecord = {
    id,
    email: email.toLowerCase().trim(),
    name,
    passwordHash,
    status: opts?.status ?? 'active',
    mustChangePassword: opts?.mustChangePassword ?? false,
    invitedBy: opts?.invitedBy,
    createdAt: nowISO(),
    updatedAt: nowISO(),
  };
  await store.put(id, user);
  return user;
}

export async function getUserById(id: string): Promise<UserRecord | null> {
  // An id that cannot name a record file cannot be a user: "no such user",
  // never the store's path-guard throw (a 500 at every caller).
  if (!isSafePathSegment(id)) return null;
  const raw = await (await claimedStore()).get(id);
  if (!raw) return null;
  // A tombstone is never migrated: its picture directory was removed with the
  // account, and a read must not write it back.
  if (hasInlineImage(raw) && raw.status !== 'deleted') return migrateInlineImage(raw);
  return migrateUserRecord(raw);
}

/**
 * A record written before pictures moved to files carries the picture INLINE
 * as `appearance.image.dataUrl` — parsed on every request that reads the user.
 */
function hasInlineImage(record: UserRecord): boolean {
  const image = record.appearance?.image as { dataUrl?: unknown } | undefined;
  return typeof image?.dataUrl === 'string';
}

/**
 * The one-time move of an inline picture into the file store, on the first
 * read that meets it. The bytes pass the same floor as an upload; a picture
 * that fails it (not PNG/JPEG/WebP, over the ceiling) is dropped, never kept
 * inline. Idempotent under concurrent reads: the file is content-addressed and
 * the record write is a producer that writes nothing once the record is clean.
 */
async function migrateInlineImage(raw: UserRecord): Promise<UserRecord> {
  const dataUrl = (raw.appearance?.image as unknown as { dataUrl: string }).dataUrl;
  let stored: StoredAppearanceImage | undefined;
  try {
    stored = await writeAppearanceImage('user', raw.id, decodeAppearanceUpload(dataUrl));
  } catch (err) {
    console.warn('[UserStore] inline profile picture dropped — it did not pass the picture floor', {
      userId: raw.id,
      reason: err instanceof Error ? err.name : 'unknown',
    });
  }
  const migrated = await updateUser(raw.id, (current) => {
    if (!hasInlineImage(current) || !current.appearance) return null;
    const { image: _inline, ...rest } = current.appearance;
    const appearance: UserAppearance = stored ? { ...rest, image: stored } : rest;
    return { appearance: Object.keys(appearance).length > 0 ? appearance : undefined };
  });
  return migrated ?? migrateUserRecord(raw);
}

export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  const users = await (await claimedStore()).list(
    (u) => u.email === email.toLowerCase().trim(),
  );
  return users[0] ? migrateUserRecord(users[0]) : null;
}

export async function listUsers(): Promise<UserRecord[]> {
  const all = await (await claimedStore()).list();
  return all.map(migrateUserRecord);
}

export async function hasAnyUsers(): Promise<boolean> {
  const all = await (await claimedStore()).list();
  return all.length > 0;
}

/**
 * The fields a general user write may touch. `deleted` is not a reachable
 * status here — {@link tombstoneUser} is the one path to it.
 */
export type UserRecordPatch = Partial<
  Pick<
    UserRecord,
    'name' | 'passwordHash' | 'mustChangePassword' | 'lastLoginAt' | 'appearance' | 'sessionEpoch' | 'disabledAt' | 'disabledBy'
  > & { status: Exclude<UserStatus, 'deleted'> }
>;

/**
 * The PRODUCER form (the `ProjectStore.updateProject` shape): handed the record
 * as it is on disk inside the per-path chain, so a patch computed FROM it — an
 * epoch bump — cannot lose a concurrent write. `null` writes nothing.
 */
export type UserPatchProducer = (current: UserRecord) => UserRecordPatch | null;

export async function updateUser(
  id: string,
  patch: UserRecordPatch | UserPatchProducer,
): Promise<UserRecord | null> {
  // The read happens INSIDE the store's per-path chain, so a login stamping
  // `lastLoginAt` and an admin rename landing in the same tick no longer erase
  // each other.
  const seen: { before: UserSessionState | null } = { before: null };
  const stored = await (await claimedStore()).update(id, (raw) => {
    if (!raw) return undefined;
    const user = migrateUserRecord(raw);
    seen.before = sessionStateOf(user);
    // A tombstone is terminal: no write revives it.
    if (user.status === 'deleted') return undefined;
    const produced = typeof patch === 'function' ? patch(user) : patch;
    if (produced === null) return undefined;
    return { ...user, ...produced, updatedAt: nowISO() };
  });
  emitIfTransition(id, seen.before, sessionStateOf(stored));
  return stored ? migrateUserRecord(stored) : null;
}

/**
 * Turn a user into a TOMBSTONE: `status: 'deleted'`, no password hash, and the
 * address moved to `deletedEmail` so `email` is free for a new account. The id,
 * the name and the provenance stay, so transcripts and audit rows still resolve
 * who wrote them. Returns `null` when there is no such user.
 */
export async function tombstoneUser(id: string, deletedBy: string): Promise<UserRecord | null> {
  const seen: { before: UserSessionState | null } = { before: null };
  const stored = await (await claimedStore()).update(id, (raw) => {
    if (!raw) return undefined;
    const user = migrateUserRecord(raw);
    seen.before = sessionStateOf(user);
    if (user.status === 'deleted') return undefined;
    const now = nowISO();
    return {
      ...user,
      status: 'deleted',
      email: `deleted:${user.id}`,
      deletedEmail: user.email,
      passwordHash: '',
      mustChangePassword: false,
      deletedAt: now,
      deletedBy,
      updatedAt: now,
    };
  });
  emitIfTransition(id, seen.before, sessionStateOf(stored));
  if (stored?.status === 'deleted') await removeUserPictures(id);
  return stored ? migrateUserRecord(stored) : null;
}

/** A deleted user's pictures go with the account; a failure is logged, never thrown into the delete. */
async function removeUserPictures(userId: string): Promise<void> {
  await removeAllAppearanceImages('user', userId).catch((err: unknown) => {
    console.error('[UserStore] removing a deleted user\'s pictures failed', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

export async function deleteUser(id: string): Promise<boolean> {
  const store = await claimedStore();
  const before = sessionStateOf(await store.get(id));
  const deleted = await store.delete(id);
  if (deleted) {
    emit({ userId: id, before, after: null });
    await removeUserPictures(id);
  }
  return deleted;
}

/**
 * Boot integrity check: logs every user record that exists but cannot be read
 * or parsed (`list` skips those silently), by relative path, plus the scan time.
 * Reads disk once, outside the data-format claim — it migrates and writes nothing.
 */
export function verifyUserRecords(logger: Logger): Promise<number> {
  return reportStoreIntegrity(getStore(), 'app/users', logger);
}
