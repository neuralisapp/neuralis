/**
 * GET /api/appearance/{user|project}/{id}/{hash} — the picture byte lane.
 *
 * The gate is the record's own read gate (a user: yourself or a co-member; a
 * project: a member through the ONE member chain), and EVERY refusal is the
 * same 404 — a stranger's real picture and an id that does not exist answer
 * byte-identically. A hit is served with the STORED type, `nosniff` and an
 * immutable private cache.
 */

import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'nrs-appearance-route-'));

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getUserById: vi.fn(),
  listProjectsForUser: vi.fn(),
  getProjectById: vi.fn(),
}));

vi.mock('@/server/config/env', () => ({
  getEnv: () => ({ appRoot: join(root, 'app'), projectsRoot: join(root, 'projects') }),
}));
vi.mock('@/server/auth/session', () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock('@/server/store/UserStore', () => ({
  getUserById: mocks.getUserById,
  isActiveUser: (record: { status?: string } | null) => record?.status === 'active',
  sessionEpochOf: () => 0,
}));
vi.mock('@/server/store/ProjectStore', () => ({
  listProjectsForUser: mocks.listProjectsForUser,
  getProjectById: mocks.getProjectById,
}));

const { writeAppearanceImage } = await import('@/server/appearance/appearanceImageStore');
const { GET } = await import('../route');

function png(fill: number): Uint8Array {
  const bytes = new Uint8Array(48).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

const ROLE = { agents: '*', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 20 };

function project(id: string, memberIds: string[], image?: unknown) {
  return {
    id,
    name: id,
    ownerId: memberIds[0],
    members: Object.fromEntries(memberIds.map((uid) => [uid, { userId: uid, role: 'member' }])),
    roles: { member: ROLE },
    agentOwnership: {},
    limits: { spend: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} } },
    ...(image ? { appearance: { image } } : {}),
  };
}

async function get(kind: string, id: string, hash: string) {
  return GET(new NextRequest(`http://localhost/api/appearance/${kind}/${id}/${hash}`), {
    params: Promise.resolve({ kind, id, hash }),
  });
}

let mateImage: Awaited<ReturnType<typeof writeAppearanceImage>>;
let strangerImage: Awaited<ReturnType<typeof writeAppearanceImage>>;
let projectImage: Awaited<ReturnType<typeof writeAppearanceImage>>;

beforeEach(async () => {
  await rm(root, { recursive: true, force: true });
  mateImage = await writeAppearanceImage('user', 'mate', png(1));
  strangerImage = await writeAppearanceImage('user', 'stranger', png(2));
  projectImage = await writeAppearanceImage('project', 'p1', png(3));
  mocks.getSessionUser.mockResolvedValue({ id: 'me', email: 'me@x.co', name: 'Me' });
  mocks.getUserById.mockImplementation(async (id: string) => ({
    id,
    status: 'active',
    appearance: id === 'mate' ? { image: mateImage } : id === 'stranger' ? { image: strangerImage } : undefined,
  }));
  mocks.listProjectsForUser.mockResolvedValue([project('p1', ['me', 'mate'])]);
  mocks.getProjectById.mockImplementation(async (id: string) =>
    id === 'p1' ? project('p1', ['me', 'mate'], projectImage) : id === 'p2' ? project('p2', ['stranger'], projectImage) : null,
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('GET /api/appearance — users', () => {
  it('a co-member\'s picture is served with the stored type, nosniff and an immutable private cache', async () => {
    const res = await get('user', 'mate', mateImage.hash);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(new Uint8Array(await res.arrayBuffer())[0]).toBe(0x89);
  });

  it('a stranger\'s REAL picture is the same 404 as an unknown user and a stale hash', async () => {
    const stranger = await get('user', 'stranger', strangerImage.hash);
    const unknown = await get('user', 'nobody', strangerImage.hash);
    const stale = await get('user', 'mate', 'f'.repeat(64));
    for (const res of [stranger, unknown, stale]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
  });

  it('no session, a bad kind and a malformed hash are 404 too', async () => {
    mocks.getSessionUser.mockResolvedValueOnce(null);
    expect((await get('user', 'mate', mateImage.hash)).status).toBe(404);
    expect((await get('agent', 'mate', mateImage.hash)).status).toBe(404);
    expect((await get('user', 'mate', '../../etc')).status).toBe(404);
  });
});

describe('GET /api/appearance — projects', () => {
  it('a member reads the project picture; a non-member gets the uniform 404', async () => {
    expect((await get('project', 'p1', projectImage.hash)).status).toBe(200);
    const foreign = await get('project', 'p2', projectImage.hash);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: 'not_found' });
  });

  it('an archived project answers 404 even to its member (the member chain refuses it)', async () => {
    mocks.getProjectById.mockResolvedValue({ ...project('p1', ['me'], projectImage), archivedAt: '2026-10-01T00:00:00.000Z' });
    expect((await get('project', 'p1', projectImage.hash)).status).toBe(404);
  });
});
