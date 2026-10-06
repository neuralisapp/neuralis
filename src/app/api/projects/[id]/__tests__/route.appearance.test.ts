/**
 * The project appearance (icon, colour, picture) is every member's switcher
 * identity: owner-STRENGTH to change, like the name, and audited as CHANGED.
 * The edit merges with the record inside the store chain (producer form) and
 * re-derives the floor there; the picture is stored by reference and its type
 * comes from the bytes.
 */

import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'nrs-project-appearance-'));
const pictures = join(root, 'projects', 'proj-1', 'appearance');

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  getProjectById: vi.fn(),
  updateProject: vi.fn(),
  writeAuditLog: vi.fn(),
}));

vi.mock('@/server/config/env', () => ({
  getEnv: () => ({ appRoot: join(root, 'app'), projectsRoot: join(root, 'projects') }),
}));
vi.mock('@/server/auth/session', () => ({ requireSession: mocks.requireSession }));
vi.mock('@/server/store/ProjectStore', () => ({
  getProjectById: mocks.getProjectById,
  updateProject: mocks.updateProject,
  ProjectUpdateError: class ProjectUpdateError extends Error {},
}));
vi.mock('@/server/projects/projectDeletion', () => ({ archiveProject: vi.fn() }));
vi.mock('@/server/store/AuditStore', () => ({ writeAuditLog: mocks.writeAuditLog }));

const { PATCH } = await import('../route');

type Rec = Record<string, unknown> & { appearance?: Record<string, unknown> };
let record: Rec;

function projectWith(role: { name: string; priority: number }): Rec {
  return {
    id: 'proj-1',
    name: 'Project',
    ownerId: 'owner-user',
    members: { caller: { userId: 'caller', name: 'C', email: 'c@x.co', role: role.name, position: '', tier: 1, addedAt: 't' } },
    roles: { [role.name]: { agents: '*', canInvite: true, canManageRoles: role.priority <= 2, grantedFeatures: ['*'], priority: role.priority } },
    agentOwnership: {},
    limits: { spend: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} } },
    createdAt: 't',
    updatedAt: 't',
  };
}

function patch(body: unknown) {
  return PATCH(new NextRequest('http://localhost/api/projects/proj-1', { method: 'PATCH', body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: 'proj-1' }),
  });
}

function pngDataUrl(fill: number): string {
  const bytes = new Uint8Array(40).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`;
}

beforeEach(async () => {
  await rm(root, { recursive: true, force: true });
  record = projectWith({ name: 'owner', priority: 1 });
  mocks.requireSession.mockResolvedValue({ id: 'caller', email: 'c@x.co', name: 'C' });
  mocks.getProjectById.mockImplementation(async () => record);
  mocks.updateProject.mockImplementation(async (_id: string, patchOrProducer: unknown) => {
    const produced = typeof patchOrProducer === 'function' ? (patchOrProducer as (r: Rec) => Rec | null)(record) : patchOrProducer;
    if (produced) {
      record = { ...record, ...(produced as Rec) };
      if ((produced as Rec).appearance === null) delete record.appearance;
    }
    return record;
  });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('PATCH /api/projects/:id — appearance', () => {
  it('the owner sets icon, colour and picture: 200, stored by reference, ONE audit row saying only "changed"', async () => {
    const res = await patch({ appearance: { iconName: 'rocket', color: '#224466', image: pngDataUrl(1) } });
    expect(res.status).toBe(200);
    expect(record.appearance).toMatchObject({ iconName: 'Rocket', color: '#224466', image: { mimeType: 'image/png' } });
    expect(await readdir(pictures)).toHaveLength(1);
    expect(mocks.writeAuditLog).toHaveBeenCalledTimes(1);
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'project.update',
      target: 'proj-1',
      details: { appearance: { changed: true } },
    }));
    const view = (await res.json()) as { appearance?: unknown };
    expect(view.appearance).toBeDefined();
  });

  it('an admin (priority 2, holds canManageRoles) is NOT owner-strength: 403, nothing written', async () => {
    record = projectWith({ name: 'admin', priority: 2 });
    const res = await patch({ appearance: { iconName: 'Rocket', color: null, image: pngDataUrl(1) } });
    expect(res.status).toBe(403);
    expect(mocks.updateProject).not.toHaveBeenCalled();
    expect(existsSync(pictures)).toBe(false);
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it('paired control: a non-owner resending the CURRENT icon and colour is not an edit', async () => {
    record = { ...projectWith({ name: 'member', priority: 20 }), appearance: { iconName: 'Rocket', color: '#224466' } };
    const res = await patch({ appearance: { iconName: 'Rocket', color: '#224466' } });
    expect(res.status).toBe(200);
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it('the floor is re-derived in the chain: a caller demoted between the check and the write is refused', async () => {
    mocks.getProjectById.mockImplementationOnce(async () => record);
    const demoted = projectWith({ name: 'member', priority: 20 });
    mocks.updateProject.mockImplementationOnce(async (_id: string, producer: (r: Rec) => Rec | null) => {
      expect(producer(demoted)).toBeNull();
      return demoted;
    });
    const res = await patch({ appearance: { iconName: 'Star', color: null } });
    expect(res.status).toBe(403);
    expect(mocks.writeAuditLog).not.toHaveBeenCalled();
  });

  it('a replaced picture\'s file is removed; reset clears everything', async () => {
    await patch({ appearance: { iconName: 'Star', color: null, image: pngDataUrl(1) } });
    await patch({ appearance: { iconName: 'Star', color: null, image: pngDataUrl(2) } });
    expect(await readdir(pictures)).toHaveLength(1);
    await patch({ appearance: null });
    expect(record.appearance).toBeUndefined();
    expect(await readdir(pictures)).toEqual([]);
  });

  it('refuses an SVG upload and an unknown icon with 400, nothing written', async () => {
    const svg = `data:image/png;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64')}`;
    expect((await patch({ appearance: { iconName: 'Star', image: svg } })).status).toBe(400);
    expect((await patch({ appearance: { iconName: 'NoSuchGlyph' } })).status).toBe(400);
    expect(existsSync(pictures)).toBe(false);
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/projects/:id — appearance background', () => {
  it('the owner makes the background transparent: 200, stored, audited as changed', async () => {
    record = { ...record, appearance: { iconName: 'Rocket', color: '#224466' } };
    const res = await patch({ appearance: { iconName: 'Rocket', color: '#224466', background: 'transparent' } });
    expect(res.status).toBe(200);
    expect(record.appearance).toEqual({ iconName: 'Rocket', color: '#224466', background: 'transparent' });
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ details: { appearance: { changed: true } } }));
  });

  it('a non-owner flipping ONLY the background is an edit: 403, nothing written', async () => {
    record = { ...projectWith({ name: 'member', priority: 20 }), appearance: { iconName: 'Rocket', color: '#224466' } };
    const res = await patch({ appearance: { iconName: 'Rocket', color: '#224466', background: 'transparent' } });
    expect(res.status).toBe(403);
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });

  it('an unknown background is a 400, nothing written', async () => {
    const res = await patch({ appearance: { iconName: 'Rocket', background: 'glass' } });
    expect(res.status).toBe(400);
    expect(mocks.updateProject).not.toHaveBeenCalled();
  });
});
