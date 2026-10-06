/**
 * Appearance pictures — the user's and the project's — stored as
 * content-addressed files beside the record, never inside it.
 *
 *   user    → `<appRoot>/users-assets/<userId>/<sha256>.<ext>`
 *   project → `<projectsRoot>/<projectId>/appearance/<sha256>.<ext>`
 *
 * The record carries `{ hash, mimeType, updatedAt }` only (≈100 B). Every
 * catch-all request parses the user and project records, so a picture inside
 * them would be paid on every request; a hash URL is fetched once per browser
 * and cached immutably.
 *
 * Floors (the byte lane: never ask the browser to RENDER what a member wrote):
 * - the TYPE is decided from the bytes alone (`sniffRasterImage`: PNG, JPEG or
 *   WebP; SVG, GIF and everything else refused) — the declared type and the
 *   file name are never consulted;
 * - the size ceiling is the kernel code constant `APPEARANCE_IMAGE_MAX_BYTES`;
 * - the stored extension comes from the sniff, and the serving route answers
 *   with the type of that STORED extension.
 *
 * Every id and hash is a validated single segment before it reaches a path, and
 * every path goes through the kernel containment module.
 */

import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { durableReplaceFile } from '@neuralis/package-system/data';
import {
  isSafePathSegment,
  openContainedHandle,
  resolveContained,
  resolveContainedLexical,
  resolveProjectRoot,
} from '@neuralis/package-system/paths';
import { APPEARANCE_IMAGE_MAX_BYTES, sniffRasterImage } from '@neuralis/package-system/web-common';
import { normalizeIconName } from '@neuralis/package-system/icons';
import { getEnv } from '../config/env';
import { nowISO } from '@/lib/utils';

export type AppearanceImageKind = 'user' | 'project';

export type AppearanceImageMime = 'image/png' | 'image/jpeg' | 'image/webp';

/** What a record stores about its picture. */
export type StoredAppearanceImage = {
  /** sha256 of the stored bytes, lowercase hex — also the file name. */
  hash: string;
  mimeType: AppearanceImageMime;
  updatedAt: string;
};

export type AppearanceImageErrorCode = 'too_large' | 'not_an_image' | 'invalid_encoding';

export class AppearanceImageError extends Error {
  readonly code: AppearanceImageErrorCode;
  constructor(code: AppearanceImageErrorCode, message: string) {
    super(message);
    this.name = 'AppearanceImageError';
    this.code = code;
  }
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

const EXTENSION_BY_MIME: Readonly<Record<AppearanceImageMime, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export function isAppearanceImageHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

export function isAppearanceImageMime(value: unknown): value is AppearanceImageMime {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp';
}

/** A stored-image record as read back from disk, or `undefined` when it is not one. */
export function parseStoredAppearanceImage(raw: unknown): StoredAppearanceImage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const image = raw as Record<string, unknown>;
  if (!isAppearanceImageHash(image.hash) || !isAppearanceImageMime(image.mimeType)) return undefined;
  return {
    hash: image.hash,
    mimeType: image.mimeType,
    updatedAt: typeof image.updatedAt === 'string' ? image.updatedAt : nowISO(),
  };
}

/**
 * The bytes of a base64 upload, bounded BEFORE decoding: a payload whose
 * decoded size would pass the ceiling is refused on its length alone.
 * Accepts a bare base64 string or a `data:<type>;base64,` URL (the declared
 * type is discarded — the bytes decide).
 */
export function decodeAppearanceUpload(input: unknown): Uint8Array {
  if (typeof input !== 'string' || input.length === 0) {
    throw new AppearanceImageError('invalid_encoding', 'The picture must be a base64 string');
  }
  const comma = input.startsWith('data:') ? input.indexOf(',') : -1;
  const body = comma >= 0 ? input.slice(comma + 1) : input;
  if (Math.floor((body.length * 3) / 4) > APPEARANCE_IMAGE_MAX_BYTES + 2) {
    throw new AppearanceImageError('too_large', `The picture must be ${APPEARANCE_IMAGE_MAX_BYTES / 1024} KB or smaller`);
  }
  if (!BASE64_PATTERN.test(body)) {
    throw new AppearanceImageError('invalid_encoding', 'The picture must be a base64 string');
  }
  return new Uint8Array(Buffer.from(body, 'base64'));
}

/**
 * Whether the icon (or picture, or monogram) sits on a tile of the chosen
 * colour (`filled`, the default) or on nothing — the icon drawn IN the colour,
 * a picture keeping its own alpha (`transparent`).
 */
export type AppearanceBackground = 'filled' | 'transparent';

/**
 * An appearance as a record stores it — the user's and the project's share the
 * shape. `background` is stored only when `transparent`: absent IS filled, so
 * an existing record needs no migration.
 */
export type StoredAppearance = {
  iconName?: string;
  color?: string;
  background?: 'transparent';
  image?: StoredAppearanceImage;
};

/**
 * A parsed appearance edit. `reset` clears everything (picture included);
 * `iconAndColor`, when present, REPLACES the icon and the colour; `image` is
 * `undefined` (keep), `null` (remove) or the uploaded bytes.
 */
export type AppearancePatch = {
  reset: boolean;
  iconAndColor?: { iconName?: string; color?: string };
  /** `undefined` keeps the stored background. */
  background?: AppearanceBackground;
  image?: Uint8Array | null;
};

export class AppearancePatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppearancePatchError';
  }
}

const HEX_COLOR = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const APPEARANCE_PATCH_KEYS = new Set(['iconName', 'color', 'background', 'image']);

/**
 * The ONE appearance-edit rule, shared by the user profile and the project
 * record: `null` resets; an object may carry `iconName` (a platform
 * icon-library name, stored in its canonical spelling), `color` (hex),
 * `background` (`filled` | `transparent`) and `image` (base64 upload, or `null`
 * to remove). Any other key, an unknown icon, a non-hex colour, any other
 * background or an undecodable/oversized upload throws — nothing is written
 * then. The upload's TYPE is decided later, from its bytes.
 */
export function parseAppearancePatch(raw: unknown): AppearancePatch {
  if (raw === null) return { reset: true };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppearancePatchError('appearance must be an object or null');
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!APPEARANCE_PATCH_KEYS.has(key)) throw new AppearancePatchError(`appearance.${key} is not a supported field`);
  }
  const patch: AppearancePatch = { reset: false };
  if ('iconName' in obj || 'color' in obj) {
    const iconAndColor: { iconName?: string; color?: string } = {};
    if (obj.iconName !== undefined && obj.iconName !== null) {
      const iconName = typeof obj.iconName === 'string' ? normalizeIconName(obj.iconName) : null;
      if (!iconName) throw new AppearancePatchError('appearance.iconName must be a name from the platform icon library');
      iconAndColor.iconName = iconName;
    }
    if (obj.color !== undefined && obj.color !== null) {
      if (typeof obj.color !== 'string' || !HEX_COLOR.test(obj.color)) {
        throw new AppearancePatchError('appearance.color must be a hex colour like #6366f1');
      }
      iconAndColor.color = obj.color;
    }
    patch.iconAndColor = iconAndColor;
  }
  if (obj.background !== undefined) {
    if (obj.background !== 'filled' && obj.background !== 'transparent') {
      throw new AppearancePatchError('appearance.background must be "filled" or "transparent"');
    }
    patch.background = obj.background;
  }
  if (obj.image === null) patch.image = null;
  else if (obj.image !== undefined) patch.image = decodeAppearanceUpload(obj.image);
  return patch;
}

/**
 * Apply a parsed edit to the stored appearance. `stored` is the written
 * picture of an upload (`patch.image` bytes), `undefined` otherwise. Answers
 * `undefined` when nothing is left.
 */
export function applyAppearancePatch(
  current: StoredAppearance | undefined,
  patch: AppearancePatch,
  stored: StoredAppearanceImage | undefined,
): StoredAppearance | undefined {
  const next: StoredAppearance = patch.reset ? {} : { ...(current ?? {}) };
  if (patch.iconAndColor) {
    delete next.iconName;
    delete next.color;
    Object.assign(next, patch.iconAndColor);
  }
  if (patch.background === 'transparent') next.background = 'transparent';
  else if (patch.background === 'filled') delete next.background;
  if (patch.image === null) delete next.image;
  else if (stored) next.image = stored;
  return Object.keys(next).length > 0 ? next : undefined;
}

/** Did an edit change what members see? A resend of the same icon, colour and background is not a change. */
export function appearanceChanged(before: StoredAppearance | undefined, after: StoredAppearance | undefined): boolean {
  return (
    before?.iconName !== after?.iconName ||
    before?.color !== after?.color ||
    before?.background !== after?.background ||
    before?.image?.hash !== after?.image?.hash
  );
}

/** The directory a picture of `kind`/`ownerId` lives in, or `null` for an id that cannot name one. */
function ownerDir(kind: AppearanceImageKind, ownerId: string): string | null {
  if (!isSafePathSegment(ownerId)) return null;
  const env = getEnv();
  if (kind === 'user') {
    const resolved = resolveContainedLexical(env.appRoot, `users-assets/${ownerId}`);
    return resolved.ok ? resolved.path.realPath : null;
  }
  let projectRoot: string;
  try {
    projectRoot = resolveProjectRoot(env.projectsRoot, ownerId);
  } catch {
    return null;
  }
  const resolved = resolveContainedLexical(projectRoot, 'appearance');
  return resolved.ok ? resolved.path.realPath : null;
}

function fileName(hash: string, mimeType: AppearanceImageMime): string {
  return `${hash}.${EXTENSION_BY_MIME[mimeType]}`;
}

/**
 * Sniff, bound, hash and store one picture. Writing the same bytes twice is
 * the same file (content address). Throws {@link AppearanceImageError} for a
 * refused picture — nothing is written then.
 */
export async function writeAppearanceImage(
  kind: AppearanceImageKind,
  ownerId: string,
  bytes: Uint8Array,
): Promise<StoredAppearanceImage> {
  if (bytes.byteLength > APPEARANCE_IMAGE_MAX_BYTES) {
    throw new AppearanceImageError('too_large', `The picture must be ${APPEARANCE_IMAGE_MAX_BYTES / 1024} KB or smaller`);
  }
  const sniffed = sniffRasterImage(bytes);
  if (!sniffed) {
    throw new AppearanceImageError('not_an_image', 'The picture must be a PNG, JPEG or WebP image');
  }
  const dir = ownerDir(kind, ownerId);
  if (!dir) throw new AppearanceImageError('invalid_encoding', 'Invalid picture owner');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const target = resolveContainedLexical(dir, fileName(hash, sniffed.mimeType));
  if (!target.ok) throw new AppearanceImageError('invalid_encoding', 'Invalid picture owner');
  await durableReplaceFile(target.path.realPath, bytes, { mode: 0o600 });
  return { hash, mimeType: sniffed.mimeType, updatedAt: nowISO() };
}

/**
 * The stored bytes of `image`, or `null` for every failure alike (missing,
 * escaped, not a regular file, over the ceiling) — the route turns every
 * `null` into the same 404.
 */
export async function readAppearanceImage(
  kind: AppearanceImageKind,
  ownerId: string,
  image: StoredAppearanceImage,
): Promise<Buffer | null> {
  const dir = ownerDir(kind, ownerId);
  if (!dir || !isAppearanceImageHash(image.hash)) return null;
  const resolved = await resolveContained(dir, fileName(image.hash, image.mimeType));
  if (!resolved.ok) return null;
  const opened = await openContainedHandle(resolved.path, APPEARANCE_IMAGE_MAX_BYTES);
  if (!opened.ok) return null;
  try {
    return await opened.handle.readFile();
  } catch {
    return null;
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

/** Remove one stored picture (a replaced or cleared one). Missing is not an error. */
export async function removeAppearanceImage(
  kind: AppearanceImageKind,
  ownerId: string,
  image: StoredAppearanceImage,
): Promise<void> {
  const dir = ownerDir(kind, ownerId);
  if (!dir || !isAppearanceImageHash(image.hash)) return;
  const target = resolveContainedLexical(dir, fileName(image.hash, image.mimeType));
  if (!target.ok) return;
  await rm(target.path.realPath, { force: true });
}

/** Remove every stored picture of one owner (a deleted user). Missing is not an error. */
export async function removeAllAppearanceImages(kind: AppearanceImageKind, ownerId: string): Promise<void> {
  const dir = ownerDir(kind, ownerId);
  if (!dir) return;
  await rm(dir, { recursive: true, force: true });
}
