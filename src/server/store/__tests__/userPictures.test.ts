/**
 * User pictures leave the record:
 * - a record that still carries an INLINE `appearance.image.dataUrl` (the old
 *   shape, ≈190 KB parsed on every request) is moved into the file store on the
 *   first read, once; a picture that fails the floor is dropped, never kept
 *   inline;
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

const { getUserById, tombstoneUser, deleteUser } = await import('../UserStore');

function pngDataUrl(): string {
  const bytes = new Uint8Array(4096).fill(7);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
}

async function seed(id: string, appearance: unknown): Promise<void> {
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
    }),
  );
}

beforeEach(async () => {
  await rm(appRoot, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('inline picture migration', () => {
  it('moves an inline PNG into users-assets on the first read; the record shrinks under 1 KB', async () => {
    await seed('u1', { iconName: 'Bot', image: { dataUrl: pngDataUrl(), mimeType: 'image/png', updatedAt: 't' } });
    const user = await getUserById('u1');
    expect(user?.appearance?.iconName).toBe('Bot');
    expect(user?.appearance?.image?.mimeType).toBe('image/png');
    const files = await readdir(join(appRoot, 'users-assets', 'u1'));
    expect(files).toEqual([`${user!.appearance!.image!.hash}.png`]);
    const onDisk = await readFile(join(appRoot, 'users', 'u1.json'), 'utf-8');
    expect(onDisk.length).toBeLessThan(1024);
    expect(onDisk).not.toContain('dataUrl');
  });

  it('a second read writes nothing more (idempotent)', async () => {
    await seed('u1', { image: { dataUrl: pngDataUrl(), mimeType: 'image/png', updatedAt: 't' } });
    const [a, b] = await Promise.all([getUserById('u1'), getUserById('u1')]);
    expect(a?.appearance?.image?.hash).toBe(b?.appearance?.image?.hash);
    expect(await readdir(join(appRoot, 'users-assets', 'u1'))).toHaveLength(1);
  });

  it('an inline SVG that claimed to be a PNG is dropped, never kept inline', async () => {
    const svg = `data:image/png;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64')}`;
    await seed('u2', { color: '#112233', image: { dataUrl: svg, mimeType: 'image/png', updatedAt: 't' } });
    const user = await getUserById('u2');
    expect(user?.appearance).toEqual({ color: '#112233' });
    expect(existsSync(join(appRoot, 'users-assets', 'u2'))).toBe(false);
  });

  it('paired control: a record without an inline picture is not rewritten', async () => {
    await seed('u3', { iconName: 'Star' });
    const before = await readFile(join(appRoot, 'users', 'u3.json'), 'utf-8');
    await getUserById('u3');
    expect(await readFile(join(appRoot, 'users', 'u3.json'), 'utf-8')).toBe(before);
  });
});

describe('a deleted user\'s pictures go with the account', () => {
  it('tombstoneUser removes users-assets/<id>/', async () => {
    await seed('u4', { image: { dataUrl: pngDataUrl(), mimeType: 'image/png', updatedAt: 't' } });
    await getUserById('u4');
    expect(existsSync(join(appRoot, 'users-assets', 'u4'))).toBe(true);
    await tombstoneUser('u4', 'admin');
    expect(existsSync(join(appRoot, 'users-assets', 'u4'))).toBe(false);
  });

  it('a read of a tombstone never writes its picture back', async () => {
    await seed('u6', { image: { dataUrl: pngDataUrl(), mimeType: 'image/png', updatedAt: 't' } });
    await tombstoneUser('u6', 'admin');
    await getUserById('u6');
    expect(existsSync(join(appRoot, 'users-assets', 'u6'))).toBe(false);
  });

  it('deleteUser removes users-assets/<id>/ too', async () => {
    await seed('u5', { image: { dataUrl: pngDataUrl(), mimeType: 'image/png', updatedAt: 't' } });
    await getUserById('u5');
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
