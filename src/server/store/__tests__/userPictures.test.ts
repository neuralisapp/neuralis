/**
 * User records as the store reads them — never converted on read:
 * - a picture lives in the file store, the record carries only its reference;
 *   a read never rewrites a record;
 * - a record without `status` is not an active principal (no read-time default);
 * - a deleted user's picture directory goes with the account (tombstone AND
 *   hard delete).
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'nrs-user-pictures-'));
const appRoot = join(root, 'app');

vi.mock('../../config/env', () => ({ getEnv: () => ({ appRoot, projectsRoot: join(root, 'projects') }) }));

const { getUserById, isActiveUser, tombstoneUser, deleteUser } = await import('../UserStore');
const { decodeAppearanceUpload, writeAppearanceImage } = await import('../../appearance/appearanceImageStore');

function pngDataUrl(): string {
  const bytes = new Uint8Array(4096).fill(7);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
}

async function seed(id: string, appearance: unknown, over: Record<string, unknown> = {}): Promise<void> {
  await mkdir(join(appRoot, 'users'), { recursive: true });
  await writeFile(
    join(appRoot, 'users', `${id}.json`),
    JSON.stringify({
      id,
      email: `${id}@x.co`,
      name: id,
      passwordHash: 'h',
      status: 'active',
      mustChangePassword: false,
      appearance,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...over,
    }),
  );
}

/** A user whose picture sits in the file store, as the upload route writes it. */
async function seedWithPicture(id: string): Promise<void> {
  const image = await writeAppearanceImage('user', id, decodeAppearanceUpload(pngDataUrl()));
  await seed(id, { image });
}

beforeEach(async () => {
  await rm(appRoot, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('a read never converts a user record', () => {
  it('a record is served as stored and the file is not rewritten', async () => {
    await seedWithPicture('u3');
    const before = await readFile(join(appRoot, 'users', 'u3.json'), 'utf-8');
    const user = await getUserById('u3');
    expect(user?.appearance?.image?.mimeType).toBe('image/png');
    expect(await readFile(join(appRoot, 'users', 'u3.json'), 'utf-8')).toBe(before);
  });

  it('a record without `status` is NOT an active principal — no default fills it', async () => {
    await seed('u7', { iconName: 'Star' }, { status: undefined });
    const user = await getUserById('u7');
    expect(user?.status).toBeUndefined();
    expect(isActiveUser(user)).toBe(false);
    // PAIRED CONTROL — the same record with `status: 'active'` is.
    await seed('u8', { iconName: 'Star' });
    expect(isActiveUser(await getUserById('u8'))).toBe(true);
  });
});

describe('a deleted user\'s pictures go with the account', () => {
  it('tombstoneUser removes users-assets/<id>/', async () => {
    await seedWithPicture('u4');
    expect(existsSync(join(appRoot, 'users-assets', 'u4'))).toBe(true);
    await tombstoneUser('u4', 'admin');
    expect(existsSync(join(appRoot, 'users-assets', 'u4'))).toBe(false);
  });

  it('a read of a tombstone never writes its picture back', async () => {
    await seedWithPicture('u6');
    await tombstoneUser('u6', 'admin');
    await getUserById('u6');
    expect(existsSync(join(appRoot, 'users-assets', 'u6'))).toBe(false);
  });

  it('deleteUser removes users-assets/<id>/ too', async () => {
    await seedWithPicture('u5');
    await deleteUser('u5');
    expect(existsSync(join(appRoot, 'users-assets', 'u5'))).toBe(false);
  });
});

describe('getUserById path-segment guard', () => {
  it('answers "no such user" for an id that cannot name a record file, never a throw', async () => {
    await expect(getUserById('../users/x')).resolves.toBeNull();
    await expect(getUserById('a/b')).resolves.toBeNull();
  });
});
