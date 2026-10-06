import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getProjectById: vi.fn() }));

vi.mock('../../store/ProjectStore', () => ({ getProjectById: mocks.getProjectById }));
// The member resolver checks the USER first; these rows are about the project.
vi.mock('../../store/UserStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../store/UserStore')>()),
  getUserById: async (id: string) => ({ id, status: 'active' }),
}));

import { resolveProjectAccess } from '../access';

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-1',
    name: 'Project',
    ownerId: 'owner',
    members: {
      owner: { userId: 'owner', name: 'O', email: 'o@x.com', role: 'owner', position: 'Owner', tier: 1, addedAt: '2026-01-01T00:00:00.000Z' },
    },
    roles: { owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 } },
    agentOwnership: {},
    limits: { daily: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} } },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('resolveProjectAccess — archived deny (happy-wondering-yeti)', () => {
  it('resolves access for an active project', async () => {
    mocks.getProjectById.mockResolvedValue(project());
    const access = await resolveProjectAccess('owner', 'proj-1');
    expect(access).not.toBeNull();
    expect(access?.member.userId).toBe('owner');
  });

  it('DENIES access (null) for an archived project even to the owner', async () => {
    mocks.getProjectById.mockResolvedValue(project({ archivedAt: '2026-07-01T00:00:00.000Z' }));
    const access = await resolveProjectAccess('owner', 'proj-1');
    expect(access).toBeNull();
  });

  it('returns null for a missing project', async () => {
    mocks.getProjectById.mockResolvedValue(null);
    expect(await resolveProjectAccess('owner', 'nope')).toBeNull();
  });
});
