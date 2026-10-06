/**
 * Another user's display card is served only to someone who shares a project
 * with them; everyone else gets the same 404 as an unknown id — the endpoint is
 * not a directory of the platform.
 *
 * PATCH stores the picture by REFERENCE: the bytes decide the type (an SVG or a
 * `data:image/png` prefix over SVG is a 400 with nothing written), and a
 * replaced picture's file is removed once the record no longer names it.
 */

import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'nrs-profile-route-'));
const assets = join(root, 'app', 'users-assets', 'me');

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getUserById: vi.fn(),
  updateUser: vi.fn(),
  listProjectsForUser: vi.fn(),
}));

vi.mock('@/server/config/env', () => ({
  getEnv: () => ({ appRoot: join(root, 'app'), projectsRoot: join(root, 'projects') }),
}));
vi.mock('@/server/auth/session', () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock('@/server/store/UserStore', () => ({
  getUserById: mocks.getUserById,
  updateUser: mocks.updateUser,
}));
vi.mock('@/server/store/ProjectStore', () => ({ listProjectsForUser: mocks.listProjectsForUser }));

const { GET, PATCH } = await import('../route');

type Rec = { id: string; name: string; email: string; appearance?: Record<string, unknown> };
let record: Rec;

function req(userId?: string) {
  return new NextRequest(`http://localhost/api/user/profile${userId ? `?userId=${userId}` : ''}`);
}

function patch(body: unknown) {
  return new NextRequest('http://localhost/api/user/profile', { method: 'PATCH', body: JSON.stringify(body) });
}

function pngDataUrl(fill: number): string {
  const bytes = new Uint8Array(40).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
}

beforeEach(async () => {
  await rm(root, { recursive: true, force: true });
  record = { id: 'me', name: 'Me', email: 'me@x.co' };
  mocks.getSessionUser.mockResolvedValue({ id: 'me', email: 'me@x.co', name: 'Me' });
  mocks.getUserById.mockImplementation(async (id: string) => ({ id, name: id, email: `${id}@x.co` }));
  mocks.listProjectsForUser.mockResolvedValue([{ id: 'p1', members: { me: {}, mate: {} } }]);
  // The producer runs against the record as the store would hand it.
  mocks.updateUser.mockImplementation(async (_id: string, producer: (current: Rec) => Partial<Rec> | null) => {
    const produced = producer(record);
    if (produced) record = { ...record, ...produced };
    return record;
  });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('GET /api/user/profile', () => {
  it('your own card needs no shared project', async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(mocks.listProjectsForUser).not.toHaveBeenCalled();
  });

  it('a co-member\'s card is served', async () => {
    const res = await GET(req('mate'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: 'mate', email: 'mate@x.co' });
  });

  it('paired control: a user who shares no project is the same 404 as an unknown id', async () => {
    const res = await GET(req('stranger'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(mocks.getUserById).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/user/profile', () => {
  it('an upload is stored as a file and the record carries only its reference', async () => {
    const res = await PATCH(patch({ appearance: { iconName: 'rocket', color: '#123456', image: pngDataUrl(1) } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { appearance: { iconName: string; image: { hash: string; mimeType: string } } };
    expect(body.appearance.iconName).toBe('Rocket');
    expect(body.appearance.image.mimeType).toBe('image/png');
    expect(JSON.stringify(record).length).toBeLessThan(1024);
    expect(await readdir(assets)).toEqual([`${body.appearance.image.hash}.png`]);
  });

  it('a replaced picture\'s file is removed; an icon-only edit keeps the picture', async () => {
    await PATCH(patch({ appearance: { iconName: 'Star', color: null, image: pngDataUrl(1) } }));
    const first = (record.appearance?.image as { hash: string }).hash;
    await PATCH(patch({ appearance: { iconName: 'Heart', color: null } }));
    expect((record.appearance?.image as { hash: string }).hash).toBe(first);
    await PATCH(patch({ appearance: { iconName: 'Heart', color: null, image: pngDataUrl(2) } }));
    const second = (record.appearance?.image as { hash: string }).hash;
    expect(second).not.toBe(first);
    expect(await readdir(assets)).toEqual([`${second}.png`]);
  });

  it.each([
    ['an SVG behind a png data: prefix', `data:image/png;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64')}`],
    ['a renamed executable', Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff]).toString('base64')],
  ])('refuses %s with a 400 and writes nothing', async (_label, image) => {
    const res = await PATCH(patch({ appearance: { iconName: 'Star', image } }));
    expect(res.status).toBe(400);
    expect(existsSync(assets)).toBe(false);
    expect(mocks.updateUser).not.toHaveBeenCalled();
  });

  it('refuses an unknown icon, a foreign key and a top-level field', async () => {
    expect((await PATCH(patch({ appearance: { iconName: 'NoSuchGlyph' } }))).status).toBe(400);
    expect((await PATCH(patch({ appearance: { dataUrl: 'x' } }))).status).toBe(400);
    expect((await PATCH(patch({ image: pngDataUrl(1) }))).status).toBe(400);
  });

  it('appearance: null resets everything and removes the picture file', async () => {
    await PATCH(patch({ appearance: { iconName: 'Star', image: pngDataUrl(1) } }));
    const res = await PATCH(patch({ appearance: null }));
    expect(res.status).toBe(200);
    expect(record.appearance).toBeUndefined();
    expect(await readdir(assets)).toEqual([]);
  });
});
