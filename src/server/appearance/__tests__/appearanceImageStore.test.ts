/**
 * The appearance picture store decides the TYPE from the bytes and nothing
 * else: an SVG, a renamed executable and a `data:image/png` prefix over SVG
 * bytes are all refused and nothing is written; the accepted file is
 * content-addressed and read back only by its exact hash.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPEARANCE_IMAGE_MAX_BYTES } from '@neuralis/package-system/web-common';

const root = await mkdtemp(join(tmpdir(), 'nrs-appearance-'));
const appRoot = join(root, 'app');
const projectsRoot = join(root, 'projects');

vi.mock('../../config/env', () => ({ getEnv: () => ({ appRoot, projectsRoot }) }));

const {
  AppearanceImageError,
  AppearancePatchError,
  appearanceChanged,
  applyAppearancePatch,
  decodeAppearanceUpload,
  parseAppearancePatch,
  readAppearanceImage,
  removeAllAppearanceImages,
  removeAppearanceImage,
  writeAppearanceImage,
} = await import('../appearanceImageStore');

/** A minimal byte run carrying a real PNG signature. */
function pngBytes(fill = 1): Uint8Array {
  const bytes = new Uint8Array(64).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const EXE = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff]);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(appRoot, { recursive: true, force: true });
  await rm(projectsRoot, { recursive: true, force: true });
});

describe('writeAppearanceImage', () => {
  it('stores a PNG under its sha256 with the sniffed extension, beside the owner', async () => {
    const stored = await writeAppearanceImage('user', 'u1', pngBytes());
    expect(stored.mimeType).toBe('image/png');
    expect(stored.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await readdir(join(appRoot, 'users-assets', 'u1'))).toEqual([`${stored.hash}.png`]);
    const again = await writeAppearanceImage('user', 'u1', pngBytes());
    expect(again.hash).toBe(stored.hash);
  });

  it('a project picture lives in the project tree, so the purge takes it', async () => {
    const stored = await writeAppearanceImage('project', 'p1', pngBytes(2));
    expect(existsSync(join(projectsRoot, 'p1', 'appearance', `${stored.hash}.png`))).toBe(true);
  });

  it.each([
    ['an SVG', SVG],
    ['a renamed executable', EXE],
    ['a short buffer', new Uint8Array([0x89, 0x50, 0x4e])],
  ])('refuses %s and writes nothing', async (_label, bytes) => {
    await expect(writeAppearanceImage('user', 'u1', bytes)).rejects.toMatchObject({ code: 'not_an_image' });
    expect(existsSync(join(appRoot, 'users-assets', 'u1'))).toBe(false);
  });

  it('refuses a picture over the code ceiling', async () => {
    const big = new Uint8Array(APPEARANCE_IMAGE_MAX_BYTES + 1);
    big.set(pngBytes().subarray(0, 8));
    await expect(writeAppearanceImage('user', 'u1', big)).rejects.toBeInstanceOf(AppearanceImageError);
  });

  it('refuses an owner id that is not one path segment', async () => {
    await expect(writeAppearanceImage('user', '../escape', pngBytes())).rejects.toBeInstanceOf(AppearanceImageError);
    await expect(writeAppearanceImage('project', '..', pngBytes())).rejects.toBeInstanceOf(AppearanceImageError);
  });
});

describe('decodeAppearanceUpload', () => {
  it('a data: URL that LIES about its type still reaches the byte sniff, which refuses SVG', async () => {
    const lying = `data:image/png;base64,${Buffer.from(SVG).toString('base64')}`;
    const bytes = decodeAppearanceUpload(lying);
    await expect(writeAppearanceImage('user', 'u1', bytes)).rejects.toMatchObject({ code: 'not_an_image' });
  });

  it('refuses a payload over the ceiling on its length alone, and junk', () => {
    expect(() => decodeAppearanceUpload('A'.repeat(Math.ceil((APPEARANCE_IMAGE_MAX_BYTES * 4) / 3) + 16))).toThrow(
      AppearanceImageError,
    );
    expect(() => decodeAppearanceUpload('not base64 !!')).toThrow(AppearanceImageError);
    expect(() => decodeAppearanceUpload(42)).toThrow(AppearanceImageError);
  });
});

describe('readAppearanceImage / remove', () => {
  it('reads back by the exact hash, and a removed or unknown hash is null', async () => {
    const stored = await writeAppearanceImage('user', 'u1', pngBytes());
    expect((await readAppearanceImage('user', 'u1', stored))?.byteLength).toBe(64);
    expect(await readAppearanceImage('user', 'u1', { ...stored, hash: 'f'.repeat(64) })).toBeNull();
    expect(await readAppearanceImage('user', 'u2', stored)).toBeNull();
    await removeAppearanceImage('user', 'u1', stored);
    expect(await readAppearanceImage('user', 'u1', stored)).toBeNull();
  });

  it('removeAllAppearanceImages drops the owner directory', async () => {
    await writeAppearanceImage('user', 'u1', pngBytes());
    await removeAllAppearanceImages('user', 'u1');
    expect(existsSync(join(appRoot, 'users-assets', 'u1'))).toBe(false);
  });
});

describe('parseAppearancePatch — the ONE user/project appearance rule', () => {
  it('null resets; icon names normalize into the library spelling', () => {
    expect(parseAppearancePatch(null)).toEqual({ reset: true });
    expect(parseAppearancePatch({ iconName: 'chart-line', color: '#112233' })).toEqual({
      reset: false,
      iconAndColor: { iconName: 'ChartLine', color: '#112233' },
    });
  });

  it.each([
    [{ iconName: 'NoSuchGlyph' }],
    [{ color: 'red' }],
    [{ extra: 1 }],
    [{ image: 'not base64 !!' }],
    [[]],
  ])('refuses %j', (raw) => {
    expect(() => parseAppearancePatch(raw)).toThrow();
  });

  it('applyAppearancePatch replaces icon+colour, keeps the picture unless told otherwise', () => {
    const image = { hash: 'a'.repeat(64), mimeType: 'image/png' as const, updatedAt: 't' };
    const current = { iconName: 'Bot', color: '#000000', image };
    expect(applyAppearancePatch(current, { reset: false, iconAndColor: { iconName: 'Star' } }, undefined)).toEqual({
      iconName: 'Star',
      image,
    });
    expect(applyAppearancePatch(current, { reset: false, image: null }, undefined)).toEqual({
      iconName: 'Bot',
      color: '#000000',
    });
    expect(applyAppearancePatch(current, { reset: true }, undefined)).toBeUndefined();
    expect(appearanceChanged(current, { ...current })).toBe(false);
    expect(appearanceChanged(current, { ...current, color: '#ffffff' })).toBe(true);
    expect(AppearancePatchError).toBeDefined();
  });
});

describe('the background — filled (absent) or transparent', () => {
  it('parses the two values and nothing else', () => {
    expect(parseAppearancePatch({ background: 'transparent' })).toEqual({ reset: false, background: 'transparent' });
    expect(parseAppearancePatch({ iconName: 'Star', background: 'filled' })).toEqual({
      reset: false,
      iconAndColor: { iconName: 'Star' },
      background: 'filled',
    });
    for (const bad of ['none', '', null, true, 'TRANSPARENT']) {
      expect(() => parseAppearancePatch({ background: bad })).toThrow(AppearancePatchError);
    }
  });

  it('is stored only when transparent; filled removes it; an edit without it keeps it; reset clears it', () => {
    const current = { iconName: 'Bot', color: '#000000' };
    const clear = applyAppearancePatch(current, { reset: false, background: 'transparent' }, undefined);
    expect(clear).toEqual({ iconName: 'Bot', color: '#000000', background: 'transparent' });
    expect(applyAppearancePatch(clear, { reset: false, iconAndColor: { iconName: 'Star' } }, undefined)).toEqual({
      iconName: 'Star',
      background: 'transparent',
    });
    expect(applyAppearancePatch(clear, { reset: false, background: 'filled' }, undefined)).toEqual(current);
    expect(applyAppearancePatch(clear, { reset: true }, undefined)).toBeUndefined();
  });

  it('a background flip is a change (the owner-strength floor sees it); a resend is not', () => {
    const current = { iconName: 'Bot', color: '#000000' };
    expect(appearanceChanged(current, { ...current, background: 'transparent' })).toBe(true);
    expect(appearanceChanged({ ...current, background: 'transparent' }, { ...current, background: 'transparent' })).toBe(false);
  });
});
