import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory FileStore double keyed by id.
const store = new Map<string, Record<string, unknown>>();

const fileStoreDouble = {
  list: vi.fn(async () => Array.from(store.values())),
  get: vi.fn(async (id: string) => store.get(id) ?? null),
  put: vi.fn(async (id: string, rec: Record<string, unknown>) => { store.set(id, rec); }),
  delete: vi.fn(async (id: string) => store.delete(id)),
  // `update` implements the kernel CONTRACT, not a shortcut: read what is
  // stored, hand it to `fn`, write only when `fn` returns a record, and answer
  // with what is stored afterwards (`null` when there is none).
  update: vi.fn(async (
    id: string,
    fn: (current: Record<string, unknown> | null) => Record<string, unknown> | undefined,
  ) => {
    const current = store.get(id) ?? null;
    const next = fn(current);
    if (next === undefined) return current;
    store.set(id, next);
    return next;
  }),
};

vi.mock('../FileStore', () => ({
  FileStore: class {
    constructor() {
      return fileStoreDouble as unknown as object;
    }
  },
}));

vi.mock('../../config/env', () => ({
  getEnv: () => ({ appRoot: '/tmp/appRoot', projectsRoot: '/tmp/projectsRoot' }),
}));

import {
  listProjectsForUser,
  listAllProjects,
  setProjectArchived,
} from '../ProjectStore';

function record(id: string, userId: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    ownerId: userId,
    members: {
      [userId]: { userId, name: 'U', email: 'u@x.com', role: 'owner', position: 'Owner', tier: 1, addedAt: '2026-01-01T00:00:00.000Z' },
    },
    roles: {
      owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
    },
    agentOwnership: {},
    limits: { daily: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} } },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  store.set('active-1', record('active-1', 'owner'));
  store.set('archived-1', record('archived-1', 'owner', { archivedAt: '2026-06-30T00:00:00.000Z' }));
});

describe('listProjectsForUser', () => {
  it('excludes archived projects by default', async () => {
    const list = await listProjectsForUser('owner');
    expect(list.map((p) => p.id)).toEqual(['active-1']);
  });

  it('includes archived projects with includeArchived', async () => {
    const list = await listProjectsForUser('owner', { includeArchived: true });
    expect(list.map((p) => p.id).sort()).toEqual(['active-1', 'archived-1']);
  });
});

describe('listAllProjects', () => {
  it('excludes archived projects by default', async () => {
    const list = await listAllProjects();
    expect(list.map((p) => p.id)).toEqual(['active-1']);
  });

  it('includes archived projects with includeArchived', async () => {
    const list = await listAllProjects({ includeArchived: true });
    expect(list.map((p) => p.id).sort()).toEqual(['active-1', 'archived-1']);
  });
});

describe('setProjectArchived', () => {
  it('sets archivedAt on an active project', async () => {
    const updated = await setProjectArchived('active-1', '2026-07-01T00:00:00.000Z');
    expect(updated?.archivedAt).toBe('2026-07-01T00:00:00.000Z');
    expect((store.get('active-1') as { archivedAt?: string }).archivedAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('clears archivedAt (restore)', async () => {
    const updated = await setProjectArchived('archived-1', null);
    expect(updated?.archivedAt).toBeUndefined();
    expect((store.get('archived-1') as { archivedAt?: string }).archivedAt).toBeUndefined();
  });

  it('returns null for a missing project', async () => {
    const updated = await setProjectArchived('nope', null);
    expect(updated).toBeNull();
  });
});
