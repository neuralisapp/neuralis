/**
 * GET /api/admin/project-packages — rows key the loader status and the trust
 * override by the exact `_packages/<slug>` instance URI, the id the scanner
 * stamps, so a loaded drop never reads `loading` and an admin's trust pin shows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  projects: [] as Array<Record<string, unknown>>,
  status: new Map<string, { status: string; reason?: string }>(),
  projectsRoot: '',
}));

vi.mock('@/server/auth/session', () => ({ requireSession: async () => ({ id: 'owner-1' }) }));
vi.mock('@/server/projects/access', () => ({ hasPlatformFeatureInAnyProject: () => true }));
vi.mock('@/server/store/ProjectStore', () => ({ listAllProjects: async () => mocks.projects }));
vi.mock('@/server/config/env', () => ({ getEnv: () => ({ projectsRoot: mocks.projectsRoot }) }));
vi.mock('@/server/packages/PackageRuntimeManager', () => ({
  getPackageRuntimeManager: () => ({ getLoader: () => ({ getStatus: (id: string) => mocks.status.get(id) }) }),
}));

import { GET } from '../route';

const INSTANCE = 'packages://demo?project=p1&scope=project';

beforeAll(async () => {
  mocks.projectsRoot = await mkdtemp(join(tmpdir(), 'nrs-admin-pkgs-'));
  const root = join(mocks.projectsRoot, 'p1', '_packages', 'demo');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', neuralis: { id: 'demo', name: 'Demo' } }));
});

afterAll(async () => {
  await rm(mocks.projectsRoot, { recursive: true, force: true });
});

beforeEach(() => {
  mocks.status = new Map([[INSTANCE, { status: 'loaded' }]]);
  mocks.projects = [{ id: 'p1', name: 'P1', packageTrust: { [INSTANCE]: 'trusted' } }];
});

async function rows(): Promise<Array<Record<string, unknown>>> {
  const res = await GET();
  expect(res.status).toBe(200);
  return ((await res.json()) as { packages: Array<Record<string, unknown>> }).packages;
}

describe('GET /api/admin/project-packages — exact instance keys', () => {
  it('reads the loader status and the trust override of the instance URI', async () => {
    expect(await rows()).toEqual([expect.objectContaining({
      packageId: INSTANCE, slug: 'demo', name: 'Demo', status: 'active', trust: 'trusted', trustOverride: 'trusted',
    })]);
  });

  it('PAIRED CONTROL — a manifest-keyed trust entry and slot are never consulted', async () => {
    mocks.status = new Map([['demo', { status: 'loaded' }]]);
    mocks.projects = [{ id: 'p1', name: 'P1', packageTrust: { demo: 'trusted' } }];
    const [row] = await rows();
    expect(row).toMatchObject({ packageId: INSTANCE, status: 'loading', trust: 'untrusted' });
    expect(row).not.toHaveProperty('trustOverride');
  });
});
