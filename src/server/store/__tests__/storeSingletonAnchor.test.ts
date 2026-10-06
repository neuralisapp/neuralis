/**
 * The host record stores are ONE instance per PROCESS, not per module graph.
 *
 * "Module-level singleton" is a per-BUNDLE claim. Next compiles a host module
 * into every server graph that imports it, and the baked image carries THREE
 * copies of `ProjectStore` (measured 2026-09-07: the instrumentation/bootstrap
 * graph, the route graph and the SSR graph each load a different chunk defining
 * `ProjectUpdateError` + the `cacheTtlMs` construction). Before the
 * `globalThis` + `Symbol.for` anchor each copy built its own `FileStore`, hence
 * its own 2 s READ CACHE and its own `bust()` — so a write in one graph left
 * every other graph serving pre-write bytes for up to ~2 s AFTER THE LAST READ
 * THAT FILLED that graph's cache (never a fixed delay after the write).
 *
 * That is not a hypothetical: the agent-lifecycle hook runs in the bootstrap
 * graph, so an agent delete pruned `project.agentOwnership` there, the admin
 * tab's immediate refetch was served the STALE record by the route graph, and
 * the deleted agent reappeared as a phantom ownership row. Measured on the
 * image: the record FILE was pruned before the DELETE returned 200, while the
 * route still served the key at +0 / +500 / +1500 ms — disk and route
 * disagreeing is the whole finding. The `UserStore` twin
 * is worse than cosmetic: its stale window is a DISABLED-USER revocation.
 *
 * These rows are BEHAVIOURAL on purpose. `getStore()` is private, so asserting
 * object identity is impossible from outside; and identity is not the property
 * that matters — a cross-graph read seeing a cross-graph write is. `resetModules`
 * is the closest vitest analogue of a second bundle (the `PlatformConfigStore`
 * anchor test uses the same device).
 *
 * PIN THE WARM-UP. Each row reads through copy B BEFORE the write, or B would
 * simply miss and hit disk and the row would pass with the defect fully intact.
 *
 * The 2 s TTL is NOT the defect and must not be lowered or removed to make
 * these pass: it is the authz-revocation staleness floor. The defect was that a
 * `bust()` could not reach the other copies' caches.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ProjectRecord } from '../projectTypes';

const appRoot = await mkdtemp(join(tmpdir(), 'nrs-store-anchor-'));

vi.mock('../../config/env', () => ({
  getEnv: () => ({ appRoot, projectsRoot: join(appRoot, 'projects-data') }),
}));

beforeAll(async () => {
  await mkdir(join(appRoot, 'projects'), { recursive: true });
  await mkdir(join(appRoot, 'users'), { recursive: true });
});

afterAll(async () => {
  await rm(appRoot, { recursive: true, force: true });
});

function seedProject(id: string): ProjectRecord {
  return {
    id,
    name: id,
    ownerId: 'u-owner',
    members: {
      'u-owner': {
        userId: 'u-owner', name: 'O', email: 'o@x.co', role: 'owner',
        position: 'Owner', tier: 1, addedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    roles: {
      owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
    },
    agentOwnership: { 'doomed-agent': { createdBy: 'u-owner', assignedTo: ['u-two'] } },
    limits: { spend: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} } },
    roleGrantVersion: 18,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as ProjectRecord;
}

describe('ProjectStore is one instance per process, not per module graph', () => {
  it('a write in graph A is visible to a graph B whose read cache is already WARM', async () => {
    const id = 'anchor-projects';
    await writeFile(
      join(appRoot, 'projects', `${id}.json`),
      JSON.stringify(seedProject(id), null, 2),
      'utf-8',
    );

    // Graph A — the instrumentation/bootstrap bundle, where the agent-lifecycle
    // hook (and therefore `pruneAgentOwnership`) runs.
    const graphA = await import('../ProjectStore');

    // Graph B — a route handler bundle. A genuinely separate module instance.
    vi.resetModules();
    const graphB = await import('../ProjectStore');
    expect(graphB, 'resetModules must yield a second module copy').not.toBe(graphA);

    // WARM B's cache with the PRE-write bytes. Without this the row is vacuous:
    // a cold B would read from disk and pass with two stores.
    const warm = await graphB.getProjectById(id);
    expect(warm?.agentOwnership?.['doomed-agent']).toBeDefined();

    // A prunes the key — exactly what the delete hook does.
    await graphA.updateProject(id, (p) => {
      const next = { ...p.agentOwnership };
      delete next['doomed-agent'];
      return { agentOwnership: next };
    });

    // B must see it. With a per-bundle store this returned the stale record for
    // up to the 2 s TTL, and the admin tab redrew the deleted agent from it.
    const after = await graphB.getProjectById(id);
    expect(after?.agentOwnership?.['doomed-agent']).toBeUndefined();
  });
});

describe('UserStore is one instance per process, not per module graph', () => {
  it('a status change in graph A is visible to a graph B with a WARM cache', async () => {
    const id = 'anchor-user';
    await writeFile(
      join(appRoot, 'users', `${id}.json`),
      JSON.stringify({
        id,
        email: 'anchor@x.co',
        name: 'Anchor',
        passwordHash: 'x',
        status: 'active',
        mustChangePassword: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }, null, 2),
      'utf-8',
    );

    const graphA = await import('../UserStore');
    vi.resetModules();
    const graphB = await import('../UserStore');
    expect(graphB).not.toBe(graphA);

    expect((await graphB.getUserById(id))?.status).toBe('active');

    // The revocation. This is an AUTHZ read, which is why the stale window here
    // is a floor rather than a display bug.
    await graphA.updateUser(id, { status: 'disabled' });

    expect((await graphB.getUserById(id))?.status).toBe('disabled');
  });
});

/**
 * The same three-graph mechanism, second incident class: a LISTENER SET. The
 * admin routes write in the route graph and the revocation fan-out subscribes in
 * the instrumentation graph, so a module-level `Set` would hold the subscriber
 * in one copy while the write emits into an empty set in the other.
 */
describe('the access-change listener sets are one per process, not per module graph', () => {
  it('a UserStore subscriber in graph A hears a status write made in graph B', async () => {
    const id = 'anchor-listener-user';
    await writeFile(
      join(appRoot, 'users', `${id}.json`),
      JSON.stringify({
        id, email: 'listener@x.co', name: 'L', passwordHash: 'x', status: 'active', mustChangePassword: false,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      'utf-8',
    );
    const graphA = await import('../UserStore');
    vi.resetModules();
    const graphB = await import('../UserStore');
    expect(graphB).not.toBe(graphA);

    const heard: string[] = [];
    const off = graphA.onUserChange((e) => heard.push(`${e.userId}:${e.after?.status}`));
    try {
      await graphB.updateUser(id, { status: 'disabled' });
    } finally {
      off();
    }
    expect(heard).toEqual([`${id}:disabled`]);
  });

  it('a ProjectStore subscriber in graph A hears an archive made in graph B', async () => {
    const id = 'anchor-listener-project';
    await writeFile(join(appRoot, 'projects', `${id}.json`), JSON.stringify(seedProject(id), null, 2), 'utf-8');
    const graphA = await import('../ProjectStore');
    vi.resetModules();
    const graphB = await import('../ProjectStore');
    expect(graphB).not.toBe(graphA);

    const heard: unknown[] = [];
    const off = graphA.onMembershipChange((e) => heard.push(e));
    try {
      await graphB.setProjectArchived(id, '2026-09-25T00:00:00.000Z');
    } finally {
      off();
    }
    expect(heard).toEqual([{ kind: 'project_closed', projectId: id, cause: 'archived', userIds: ['u-owner'] }]);
  });
});
