import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  listPackages: vi.fn(),
  /** Which package ids are INSTALLED in the project under test. */
  projectPackageIds: new Set<string>(),
  /** Source-owner scope per package id, if any. */
  ownerScope: new Map<string, unknown>(),
}));

vi.mock('@/server/auth/adminGuard', () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock('@/server/packages/runtime', () => ({
  getCommunityPackageRegistry: () => ({ listPackages: mocks.listPackages }),
}));
// `packageVisibility` itself is deliberately NOT mocked — the whole point of
// this file's R2C-006 block is that the route runs the REAL shared ladder
// predicate. Only the two host singletons it reaches for are stubbed.
vi.mock('@/server/packages/PackageRuntimeManager', () => ({
  getPackageRuntimeManager: () => ({
    getProjectPackageIds: () => mocks.projectPackageIds,
    getPackageOwnerScope: (_p: string, id: string) => mocks.ownerScope.get(id),
    getPackageManifestId: (_p: string, id: string) => id,
  }),
}));
vi.mock('@/server/host/bootstrap', () => ({ BUILTIN_PACKAGE_IDS: new Set(['brain-core', 'agent-core']) }));
vi.mock('@/server/store/ProjectStore', () => ({ getProjectById: async () => null }));

import { GET } from '../route';

function adminCtx(packageAccessFeature?: Record<string, string>) {
  return {
    user: { id: 'admin', email: 'a@x.com' },
    isOwner: true,
    callerPriority: 1,
    member: { userId: 'admin', role: 'owner' },
    memberRole: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
    project: { id: 'proj-1', ownerId: 'admin', members: {}, roles: {}, ...(packageAccessFeature ? { packageAccessFeature } : {}) },
  };
}

function req(projectId?: string) {
  const headers = new Headers();
  if (projectId) headers.set('X-Project-Id', projectId);
  return new Request('http://localhost/api/admin/feature-catalog', { headers });
}

const DEFS = [
  { id: 'pkg-x', name: 'Package X', requires: {} }, // no manifest features — only an override can attach one
  { id: 'pkg-y', name: 'Package Y', requires: { providesFeatures: [{ id: 'y.feature' }] } },
  { id: 'pkg-z', name: 'Package Z', requires: { accessFeature: 'z.access' } }, // manifest-declared accessFeature (FIX-2 floor)
];

describe('GET /api/admin/feature-catalog — R2b project-aware override union', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listPackages.mockReturnValue(DEFS);
    mocks.projectPackageIds = new Set(DEFS.map((d) => d.id));
    mocks.ownerScope = new Map();
  });

  it('surfaces an override-attached accessFeature under its declaring package group', async () => {
    mocks.requireAdmin.mockResolvedValue(adminCtx({ 'pkg-x': 'labs.access' }));
    const res = await GET(req('proj-1'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const xGroup = body.groups.find((g: any) => g.packageId === 'pkg-x');
    // pkg-x declares no providesFeatures — without the override union its group
    // would be empty and dropped by the `g.features.length > 0` filter.
    expect(xGroup).toBeDefined();
    expect(xGroup.features).toContain('labs.access');
    // requireAdmin received the project id from the X-Project-Id header.
    expect(mocks.requireAdmin).toHaveBeenCalledWith('proj-1');
  });

  it('keeps the FIX-2 floor: a manifest-declared accessFeature still surfaces', async () => {
    mocks.requireAdmin.mockResolvedValue(adminCtx());
    const res = await GET(req('proj-1'));
    const body = (await res.json()) as any;
    const zGroup = body.groups.find((g: any) => g.packageId === 'pkg-z');
    expect(zGroup.features).toContain('z.access');
    // pkg-x has no manifest features and no override here ⇒ empty group dropped.
    expect(body.groups.find((g: any) => g.packageId === 'pkg-x')).toBeUndefined();
  });

  // O-2 — the header is REQUIRED. The old "no header ⇒ the caller's first
  // project" fallback returned a catalog whose override-attached entries
  // belonged to a project the caller never named.
  it('no X-Project-Id header ⇒ 400, and the guard is never reached', async () => {
    mocks.requireAdmin.mockResolvedValue(adminCtx());
    const res = await GET(req());
    expect(res.status).toBe(400);
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
  });

  it('reads the HEADER only — a query projectId cannot redirect the catalog', async () => {
    mocks.requireAdmin.mockResolvedValue(adminCtx());
    const headers = new Headers({ 'X-Project-Id': 'proj-1' });
    const res = await GET(new Request('http://localhost/api/admin/feature-catalog?projectId=proj-2', { headers }));
    expect(res.status).toBe(200);
    expect(mocks.requireAdmin).toHaveBeenCalledWith('proj-1');
  });
});

/**
 * R2C-006 — the catalog is PROJECT-scoped, on BOTH halves.
 *
 * Roles are project-level, not platform-level, so the surface that sets a role's
 * features must filter by project. The route enumerated the process-global
 * `registry.listPackages()` instead, and the global snapshot carries every
 * project's `_packages/` drops.
 *
 * The SECOND half is the one a draft of this fix got wrong: the consumers index
 * was kept global on the reasoning that a feature may legitimately be referenced
 * from another package. True — but `summarizeConsumers` emits each consumer's
 * NAME, so a foreign drop declaring any contribution with
 * `requires.features:['drive.read']` had its contribution name rendered in this
 * project's Roles editor. An assertion that the consumers index was UNCHANGED
 * would have pinned that leak.
 *
 * PAIRED CONTROL: remove either filter and exactly the matching row reddens.
 */
describe('GET /api/admin/feature-catalog — R2C-006 project scoping', () => {
  const FOREIGN_TOOL = 'foreign_secret_tool';

  const SCOPED_DEFS = [
    // A BUILTIN — visible in every project, and the owner of `drive.read`.
    {
      id: 'brain-core',
      name: 'Brain Core',
      requires: { providesFeatures: [{ id: 'drive.read', title: 'Read files' }] },
    },
    // A BUILTIN consuming another builtin's feature — the legitimate
    // cross-first-party reference that must SURVIVE the filter.
    {
      id: 'agent-core',
      name: 'Agent Core',
      requires: { providesFeatures: [{ id: 'core.agents' }] },
      tools: [{ name: 'delegate', requires: { features: ['drive.read'] } }],
    },
    // ANOTHER project's `_packages/` drop. Not installed here.
    {
      id: 'foreign-drop',
      name: 'Foreign Drop',
      requires: { providesFeatures: [{ id: 'foreign.feature', title: 'FOREIGN TITLE', description: 'FOREIGN DESC' }] },
      tools: [{ name: FOREIGN_TOOL, requires: { features: ['drive.read'] } }],
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listPackages.mockReturnValue(SCOPED_DEFS);
    // `foreign-drop` is deliberately absent from THIS project's install set.
    mocks.projectPackageIds = new Set<string>();
    mocks.ownerScope = new Map();
    mocks.requireAdmin.mockResolvedValue(adminCtx());
  });

  it('omits another project’s drop, and its declared title/description, from the groups', async () => {
    const body = (await (await GET(req('proj-1'))).json()) as any;
    expect(body.groups.map((g: any) => g.packageId).sort()).toEqual(['agent-core', 'brain-core']);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('FOREIGN TITLE');
    expect(raw).not.toContain('FOREIGN DESC');
    expect(raw).not.toContain('foreign.feature');
  });

  it('omits the foreign drop’s contribution NAME from a VISIBLE feature’s consumers', async () => {
    const body = (await (await GET(req('proj-1'))).json()) as any;
    const brain = body.groups.find((g: any) => g.packageId === 'brain-core');
    const driveRead = brain.entries.find((e: any) => e.id === 'drive.read');
    // `drive.read` is first-party and survives the group filter — which is
    // exactly why its consumers list was the leak channel.
    expect(driveRead.consumers.byKind.tool ?? []).not.toContain(FOREIGN_TOOL);
    expect(JSON.stringify(body)).not.toContain(FOREIGN_TOOL);
  });

  it('KEEPS the cross-first-party consumer (the still-works control)', async () => {
    const body = (await (await GET(req('proj-1'))).json()) as any;
    const brain = body.groups.find((g: any) => g.packageId === 'brain-core');
    const driveRead = brain.entries.find((e: any) => e.id === 'drive.read');
    expect(driveRead.consumers.byKind.tool).toContain('delegate');
    expect(driveRead.consumers.total).toBe(1);
  });

  it('shows the drop once it IS installed in this project', async () => {
    mocks.projectPackageIds = new Set(['foreign-drop']);
    const body = (await (await GET(req('proj-1'))).json()) as any;
    expect(body.groups.map((g: any) => g.packageId)).toContain('foreign-drop');
    const brain = body.groups.find((g: any) => g.packageId === 'brain-core');
    const driveRead = brain.entries.find((e: any) => e.id === 'drive.read');
    expect(driveRead.consumers.byKind.tool).toContain(FOREIGN_TOOL);
  });
});
