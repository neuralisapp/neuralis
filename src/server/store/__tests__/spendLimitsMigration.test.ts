/**
 * periodic-pelican — legacy `limits.daily` (plain USD/day numbers) → `limits.spend`
 * (per-rule { amountUsd, period }) structural normalize, plus the field-wise
 * `limits` merge in `updateProject` (a spend-only patch must not erase
 * `rateLimitRpm` — the `{"roles":{}}`-wipe class, F4).
 */

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

import { migrateProjectRecord, updateProject } from '../ProjectStore';
import type { ProjectRecord } from '../projectTypes';

function rawProject(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'p1',
    name: 'P1',
    ownerId: 'owner-1',
    members: { 'owner-1': { userId: 'owner-1', name: 'O', email: 'o@x', role: 'owner', position: 'Owner', tier: 1, addedAt: '2026-01-01' } },
    roles: {
      owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
    },
    agentOwnership: {},
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...over,
  };
}

describe('migrateProjectRecord — limits.daily → limits.spend', () => {
  it('converts plain numbers to day rules and drops the daily key', () => {
    const r = migrateProjectRecord(rawProject({
      limits: {
        daily: { projectTotal: 200, byRole: { manager: 10, owner: null }, byUser: { u1: 10 }, byAgent: { coder: 10 } },
        rateLimitRpm: 100,
      },
    }));
    expect(r.limits.spend).toEqual({
      projectTotal: { amountUsd: 200, period: 'day' },
      byRole: { manager: { amountUsd: 10, period: 'day' }, owner: null },
      byUser: { u1: { amountUsd: 10, period: 'day' } },
      byAgent: { coder: { amountUsd: 10, period: 'day' } },
    });
    expect((r.limits as Record<string, unknown>).daily).toBeUndefined();
    expect(r.limits.rateLimitRpm).toBe(100);
  });

  it('is idempotent — an already-converted record is untouched', () => {
    const once = migrateProjectRecord(rawProject({
      limits: { daily: { projectTotal: 5, byRole: {}, byUser: {}, byAgent: {} } },
    }));
    const twice = migrateProjectRecord(once as unknown as Record<string, unknown>);
    expect(twice.limits.spend.projectTotal).toEqual({ amountUsd: 5, period: 'day' });
  });

  it('seeds empty spend limits when the record has none', () => {
    const r = migrateProjectRecord(rawProject({}));
    expect(r.limits.spend).toEqual({ projectTotal: null, byRole: {}, byUser: {}, byAgent: {} });
  });

  it('drops non-numeric legacy values to null instead of fabricating rules', () => {
    const r = migrateProjectRecord(rawProject({
      limits: { daily: { projectTotal: 'oops', byRole: { x: Infinity }, byUser: {}, byAgent: {} } },
    }));
    expect(r.limits.spend.projectTotal).toBeNull();
    expect(r.limits.spend.byRole.x).toBeNull();
  });
});

describe('updateProject — field-wise limits merge (F4)', () => {
  beforeEach(() => {
    store.clear();
    store.set('p1', rawProject({
      limits: {
        spend: { projectTotal: { amountUsd: 200, period: 'day' }, byRole: {}, byUser: {}, byAgent: {} },
        rateLimitRpm: 60,
      },
    }));
  });

  it('a spend-only patch keeps rateLimitRpm', async () => {
    const next = await updateProject('p1', {
      limits: {
        spend: { projectTotal: { amountUsd: 50, period: 'week' }, byRole: {}, byUser: {}, byAgent: {} },
      } as ProjectRecord['limits'],
    });
    expect(next?.limits.spend.projectTotal).toEqual({ amountUsd: 50, period: 'week' });
    expect(next?.limits.rateLimitRpm).toBe(60);
  });

  it('an rpm-only patch keeps the spend rules', async () => {
    const next = await updateProject('p1', {
      limits: { rateLimitRpm: 10 } as ProjectRecord['limits'],
    });
    expect(next?.limits.rateLimitRpm).toBe(10);
    expect(next?.limits.spend.projectTotal).toEqual({ amountUsd: 200, period: 'day' });
  });

  it('an explicit rateLimitRpm: null clears the rate limit', async () => {
    const next = await updateProject('p1', {
      limits: {
        spend: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} },
        rateLimitRpm: null,
      },
    });
    expect(next?.limits.rateLimitRpm).toBeNull();
  });
});
