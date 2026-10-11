/**
 * A LIST read persists the seed exactly as `getProjectById` does: setup writes
 * an UNSEEDED first project, and the raw readers outside the host (admin's
 * `readProjectFiles`) see the seed as soon as ANY host read has met the record.
 * A record stamped by a newer build is never written back.
 */

import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';

const home = vi.hoisted(() => {
  const { mkdtempSync } = require('fs') as typeof import('fs');
  const { tmpdir } = require('os') as typeof import('os');
  const { join: j } = require('path') as typeof import('path');
  return mkdtempSync(j(tmpdir(), 'list-read-seed-'));
});

vi.mock('../../config/env', () => ({
  getEnv: () => ({ appRoot: join(home, 'app'), projectsRoot: join(home, 'projects') }),
}));

import { listAllProjects, listProjectsForUser } from '../ProjectStore';

const projectsDir = join(home, 'app', 'projects');
const unseeded = (id: string) => ({
  id,
  name: id,
  ownerId: 'user-1',
  members: { 'user-1': { userId: 'user-1', name: 'Owner', email: 'o@example.com', role: 'owner', position: 'Owner', tier: 1, addedAt: '2026-10-06T00:00:00.000Z' } },
  roles: {},
  createdAt: '2026-10-06T00:00:00.000Z',
  updatedAt: '2026-10-06T00:00:00.000Z',
});
const onDisk = async (id: string) => JSON.parse(await readFile(join(projectsDir, `${id}.json`), 'utf-8')) as Record<string, unknown>;

afterAll(async () => { await rm(home, { recursive: true, force: true }); });

describe('list reads persist the seed of a setup-written project', () => {
  it('an unseeded record is persisted SEEDED by listAllProjects; a newer-stamped one is left byte-identical', async () => {
    await mkdir(projectsDir, { recursive: true });
    await writeFile(join(projectsDir, 'acme.json'), JSON.stringify(unseeded('acme'), null, 2));
    const newer = { ...unseeded('future'), roleGrantVersion: 99, roles: { owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 } } };
    const newerText = JSON.stringify(newer, null, 2);
    await writeFile(join(projectsDir, 'future.json'), newerText);

    const listed = await listAllProjects();
    expect(listed.find((p) => p.id === 'acme')?.roleGrantVersion).toBe(19);

    const acme = await onDisk('acme');
    expect(acme.roleGrantVersion).toBe(19);
    expect(Object.keys(acme.roles as object)).toContain('owner');
    expect((acme.roles as Record<string, { grantedFeatures: string[] }>).owner!.grantedFeatures).toEqual(['*']);
    expect(await readFile(join(projectsDir, 'future.json'), 'utf-8')).toBe(newerText);
  });

  it('listProjectsForUser persists through the same path', async () => {
    await writeFile(join(projectsDir, 'beta.json'), JSON.stringify(unseeded('beta'), null, 2));
    // Past the store's 2 s list cache, so the new file is seen.
    await new Promise((r) => setTimeout(r, 2_100));
    const mine = await listProjectsForUser('user-1');
    expect(mine.map((p) => p.id)).toContain('beta');
    expect((await onDisk('beta')).roleGrantVersion).toBe(19);
  });
});
