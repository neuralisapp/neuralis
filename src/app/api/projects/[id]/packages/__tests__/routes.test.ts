/**
 * The cookie doors of project-package governance — list, trust, build and the
 * access feature — over the ONE shared body in `rescanProjectPackages.ts`
 * (the admin `project-packages` route reaches the same body through the
 * package-maintenance port).
 *
 * Pinned: the FRESH `canManagePackages` floor answers 403 before anything is
 * read or written; a package outside the caller's WRITE reach answers the same
 * 404 as an unknown one, for every action (the access feature included — it
 * used to store an override under any id string); a native package's trust
 * never moves; every write carries its provenance on the audit row; the list
 * leaves out another member's package for a caller without `files.readOthers`
 * and stamps trust from the runtime, never the manifest.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackageDefinition, SourceScope } from '@neuralis/package-system/contracts';
import { packageInstanceId } from '@neuralis/package-system/contracts';

const h = vi.hoisted(() => ({
  manager: true,
  granted: ['packages.manage'] as string[],
  project: { id: 'p1', packageTrust: {} as Record<string, string>, packageAccessFeature: {} as Record<string, string> },
  records: new Map<string, { packageId: string; packageRoot: string; ownerScope?: unknown; ownerOrigin?: unknown; definition: Record<string, unknown> }>(),
  registry: new Map<string, Record<string, unknown>>(),
  owners: new Map<string, unknown>(),
  origins: new Map<string, unknown>(),
  status: new Map<string, { status: string; reason?: string }>(),
  activated: [] as string[],
  trustWrites: [] as unknown[][],
  featureWrites: [] as unknown[][],
  audit: [] as Array<Record<string, unknown>>,
  reloads: [] as string[],
  hasSource: true,
  toolchain: true,
  buildError: null as Error | null,
}));

vi.mock('@/server/auth/session', () => ({ requireSession: async () => ({ id: 'u1' }) }));
vi.mock('@/server/logging/setup', () => {
  const l: Record<string, unknown> = { debug() {}, info() {}, warn() {}, error() {} };
  l.child = () => l;
  return { getLogger: () => l };
});
vi.mock('@/server/projects/access', () => ({
  resolveProjectAccess: async (userId: string, projectId: string) => (projectId === h.project.id
    ? { project: h.project, member: { role: 'r' }, role: { canManageRoles: false, grantedFeatures: h.granted }, session: { userId, projectId, grantedFeatures: h.granted } }
    : null),
  canManagePackages: () => h.manager,
}));
vi.mock('@/server/store/ProjectStore', () => ({
  // Read only by the pre-extraction routes (the red-first run); the shared body takes the project from its access read.
  getProjectById: async (projectId: string) => (projectId === h.project.id ? h.project : null),
  setPackageTrust: async (...args: unknown[]) => { h.trustWrites.push(args); return true; },
  setPackageAccessFeature: async (...args: unknown[]) => { h.featureWrites.push(args); return true; },
}));
vi.mock('@/server/store/AuditStore', () => ({ writeAuditLog: async (entry: Record<string, unknown>) => { h.audit.push(entry); } }));
vi.mock('@/server/packages/projectPackages', () => ({
  resolveProjectPackageInstance: async (_projectId: string, packageId: string) => h.records.get(packageId) ?? null,
  ensureProjectPackagesLoaded: async () => {},
  listAllActivatedPackages: () => h.activated.map((packageId) => ({ packageId, source: 'local-dir', sourceRoot: '/srv/secret/path' })),
  resetProjectPackageActivation: () => {},
  resyncProjectPackages: async () => ({ scanned: 0, errors: [] }),
}));
vi.mock('@/server/packages/PackageRuntimeManager', () => ({
  getPackageRuntimeManager: () => ({
    reloadProjectPackage: async (_projectId: string, packageId: string) => { h.reloads.push(packageId); },
    getLoader: () => ({ getStatus: (id: string) => h.status.get(id) }),
    getPackageOwnerScope: (_projectId: string, id: string) => h.owners.get(id),
    getPackageOwnerOrigin: (_projectId: string, id: string) => h.origins.get(id),
  }),
}));
vi.mock('@/server/packages/runtime', () => ({
  getCommunityPackageRegistry: () => ({
    getPackage: (id: string) => h.registry.get(id),
    listPackages: () => [...h.registry.values()],
  }),
}));
vi.mock('@/server/host/builtinSlots', () => ({
  BUILTIN_PACKAGE_IDS: new Set(['@neuralis/brain-core']),
  resolveGuestPdkPath: () => '/pdk',
}));
vi.mock('@neuralis/package-system/runtime/wasm-build', () => ({
  hasSourceCode: () => h.hasSource,
  hasWasmToolchain: () => h.toolchain,
  buildWasmPackage: async () => { if (h.buildError) throw h.buildError; return '/abs/dist/package.wasm'; },
}));

import { GET as LIST } from '../route';
import { PUT as TRUST } from '../[slug]/trust/route';
import { POST as BUILD } from '../[slug]/build/route';
import { PUT as ACCESS } from '../[slug]/access-feature/route';

const id = (dir: string, scope: SourceScope = { kind: 'project' }): string => packageInstanceId({ originUri: `packages://${dir}`, projectId: 'p1', scope });
const OWN = id('demo');
const OTHERS = id('theirs', { kind: 'user', userId: 'u2' });
const DEVICE = id('laptop', { kind: 'user', userId: 'u2' });
const UNKNOWN = id('nowhere');

function addPackage(packageId: string, ownerScope: SourceScope | undefined, extra: Partial<PackageDefinition> = {}, plane?: 'local' | 'device'): void {
  const definition = { id: packageId, name: packageId.split('?')[0].replace('packages://', ''), access: { trust: 'untrusted' }, ...extra };
  h.records.set(packageId, { packageId, packageRoot: `/projects/p1/_packages/${packageId}`, ...(ownerScope ? { ownerScope } : {}), ...(plane ? { ownerOrigin: { plane } } : {}), definition });
  h.registry.set(packageId, definition);
  if (ownerScope) h.owners.set(packageId, ownerScope);
  if (plane) h.origins.set(packageId, { plane });
  h.activated.push(packageId);
  h.status.set(packageId, { status: 'loaded' });
}

const params = (slug?: string) => ({ params: Promise.resolve({ id: 'p1', ...(slug ? { slug } : {}) }) as Promise<{ id: string; slug: string }> });
const put = (body: unknown) => new Request('http://h/x', { method: 'PUT', body: JSON.stringify(body) }) as never;
const post = () => new Request('http://h/x', { method: 'POST' }) as never;

beforeEach(() => {
  h.manager = true;
  h.granted = ['packages.manage'];
  h.project.packageTrust = {};
  h.project.packageAccessFeature = {};
  for (const map of [h.records, h.registry, h.owners, h.origins, h.status]) map.clear();
  h.activated = [];
  h.trustWrites = [];
  h.featureWrites = [];
  h.audit = [];
  h.reloads = [];
  h.hasSource = true;
  h.toolchain = true;
  h.buildError = null;
  addPackage(OWN, undefined, { requires: { defaultRoleGrants: { member: ['demo.use'] } } } as Partial<PackageDefinition>);
  addPackage(OTHERS, { kind: 'user', userId: 'u2' });
  h.registry.set('@neuralis/brain-core', { id: '@neuralis/brain-core', name: 'Brain', access: { trust: 'native' }, requires: { accessFeature: 'files.read' } });
});

describe('the FRESH canManagePackages floor', () => {
  it('answers 403 on every door before reading or writing anything', async () => {
    h.manager = false;
    const answers = [
      await LIST(post(), params()),
      await TRUST(put({ trust: 'trusted' }), params(OWN)),
      await BUILD(post(), params(OWN)),
      await ACCESS(put({ featureId: 'files.read' }), params(OWN)),
    ];
    expect(answers.map((r) => r.status)).toEqual([403, 403, 403, 403]);
    expect([h.trustWrites, h.featureWrites, h.audit, h.reloads].map((list) => list.length)).toEqual([0, 0, 0, 0]);
  });
});

describe('a package outside the caller\'s write reach answers like an absent one', () => {
  it('trust, build and the access feature give the SAME 404 for another member\'s package and an unknown id', async () => {
    for (const target of [OTHERS, UNKNOWN]) {
      const answers = [
        await TRUST(put({ trust: 'trusted' }), params(target)),
        await BUILD(post(), params(target)),
        await ACCESS(put({ featureId: 'files.read' }), params(target)),
      ];
      expect(answers.map((r) => r.status)).toEqual([404, 404, 404]);
      const bodies = await Promise.all(answers.map((r) => r.json() as Promise<{ code?: string }>));
      expect(bodies.map((b) => b.code)).toEqual(['package_not_found', 'package_not_found', 'package_not_found']);
    }
    expect([h.trustWrites, h.featureWrites, h.audit].map((list) => list.length)).toEqual([0, 0, 0]);
  });

  it('a holder of files.writeOthers reaches another member\'s package (paired control)', async () => {
    h.granted = ['packages.manage', 'files.writeOthers'];
    expect((await ACCESS(put({ featureId: 'files.read' }), params(OTHERS))).status).toBe(200);
    expect(h.featureWrites).toEqual([['p1', OTHERS, 'files.read']]);
  });

  it('a member\'s USER-scope DEVICE package stays out of reach for files.writeOthers and \'*\' — the same 404', async () => {
    addPackage(DEVICE, { kind: 'user', userId: 'u2' }, {}, 'device');
    for (const granted of [['packages.manage', 'files.writeOthers'], ['*']]) {
      h.granted = granted;
      expect((await ACCESS(put({ featureId: 'files.read' }), params(DEVICE))).status, granted.join()).toBe(404);
    }
    expect(h.featureWrites).toEqual([]);
  });
});

describe('trust', () => {
  it('pins the trust, reloads the package and audits the person', async () => {
    const res = await TRUST(put({ trust: 'trusted' }), params(OWN));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, trust: 'trusted' });
    expect(h.trustWrites).toEqual([['p1', OWN, 'trusted']]);
    expect(h.reloads).toEqual([OWN]);
    expect(h.audit).toEqual([expect.objectContaining({ action: 'package.trust.change', userId: 'u1', details: expect.objectContaining({ trust: 'trusted', via: 'person' }) })]);
  });

  it('refuses a value it does not take, and a native package', async () => {
    expect((await TRUST(put({ trust: 'native' }), params(OWN))).status).toBe(400);
    h.records.get(OWN)!.definition.access = { trust: 'native' };
    expect((await TRUST(put({ trust: 'untrusted' }), params(OWN))).status).toBe(400);
    expect(h.trustWrites).toEqual([]);
  });
});

describe('build', () => {
  it('builds, reloads and answers the log', async () => {
    const res = await BUILD(post(), params(OWN));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; logs: string[] };
    expect(body.ok).toBe(true);
    expect(h.reloads).toEqual([OWN]);
    expect(h.audit[0]).toEqual(expect.objectContaining({ action: 'package.build', details: expect.objectContaining({ success: true, via: 'person' }) }));
  });

  it('names no host path when the build fails, and 400s with no source', async () => {
    h.buildError = new Error('esbuild failed at /srv/projects/p1/_packages/demo/src/tools/a.ts');
    const failed = await BUILD(post(), params(OWN));
    expect(failed.status).toBe(500);
    expect(JSON.stringify(await failed.json())).not.toContain('/srv/');
    h.hasSource = false;
    expect((await BUILD(post(), params(OWN))).status).toBe(400);
  });

  it('a server without the WASM compiler answers 409 toolchain-missing, naming extism-js — nothing built, nothing reloaded, no build audited', async () => {
    h.toolchain = false;
    h.buildError = new Error('must not run');
    const res = await BUILD(post(), params(OWN));
    expect(res.status).toBe(409);
    const body = await res.json() as { ok: boolean; logs: string[]; error: string };
    expect(body).toEqual(expect.objectContaining({ ok: false, error: 'toolchain-missing' }));
    expect(body.logs.join(' ')).toContain('extism-js');
    expect(h.reloads).toEqual([]);
    expect(h.audit).toEqual([]);
  });
});

describe('access feature', () => {
  it('attaches a grantable feature to a project package and to a native package', async () => {
    expect((await ACCESS(put({ featureId: 'files.read' }), params(OWN))).status).toBe(200);
    expect((await ACCESS(put({ featureId: 'files.read' }), params('@neuralis/brain-core'))).status).toBe(200);
    expect(h.featureWrites).toEqual([['p1', OWN, 'files.read'], ['p1', '@neuralis/brain-core', 'files.read']]);
    expect(h.audit.every((e) => (e.details as Record<string, unknown>).via === 'person')).toBe(true);
  });

  it('refuses a feature no package declares, and clears with null', async () => {
    expect((await ACCESS(put({ featureId: 'made.up' }), params(OWN))).status).toBe(400);
    expect((await ACCESS(put({ featureId: null }), params(OWN))).status).toBe(200);
    expect(h.featureWrites).toEqual([['p1', OWN, null]]);
  });
});

describe('list', () => {
  it('lists what the caller may read, with the runtime trust and the native rows, and no host path', async () => {
    h.project.packageTrust = { [OWN]: 'trusted' };
    h.registry.get(OWN)!.access = { trust: 'trusted' };
    const res = await LIST(post(), params());
    expect(res.status).toBe(200);
    const { packages } = await res.json() as { packages: Array<Record<string, unknown>> };
    expect(packages.map((p) => p.id)).toEqual([OWN, '@neuralis/brain-core']);
    expect(packages[0]).toEqual(expect.objectContaining({ slot: 'project', origin: 'packages://demo', trust: 'trusted', trustOverride: 'trusted', status: 'loaded', defaultRoleGrants: { member: ['demo.use'] } }));
    expect(packages[1]).toEqual(expect.objectContaining({ slot: 'native', trust: 'native', accessFeature: { feature: 'files.read', source: 'manifest' } }));
    expect(JSON.stringify(packages)).not.toContain('/srv/secret');
  });

  it('a WASM package that needs a build says whether this server can build it — the SAME predicate the build refuses on', async () => {
    h.registry.get(OWN)!.runtime = { type: 'wasm' } as PackageDefinition['runtime'];
    h.status.set(OWN, { status: 'partial', reason: 'build-missing' });
    const rowOf = async () => ((await (await LIST(post(), params())).json()) as { packages: Array<Record<string, unknown>> }).packages.find((p) => p.id === OWN)!;
    expect((await rowOf()).build).toBe('ready');
    h.toolchain = false;
    expect((await rowOf()).build).toBe('toolchain-missing');
    h.status.set(OWN, { status: 'loaded' });
    expect((await rowOf()).build).toBeUndefined();
  });

  it('shows another member\'s package to a holder of files.readOthers (paired control)', async () => {
    h.granted = ['packages.manage', 'files.readOthers'];
    const { packages } = await (await LIST(post(), params())).json() as { packages: Array<{ id: string }> };
    expect(packages.map((p) => p.id)).toContain(OTHERS);
  });

  it('leaves out a member\'s USER-scope DEVICE package for files.readOthers and \'*\'; its owner sees it', async () => {
    addPackage(DEVICE, { kind: 'user', userId: 'u2' }, {}, 'device');
    const MINE = id('mydevice', { kind: 'user', userId: 'u1' });
    addPackage(MINE, { kind: 'user', userId: 'u1' }, {}, 'device');
    const ids = async () => ((await (await LIST(post(), params())).json()) as { packages: Array<{ id: string }> }).packages.map((p) => p.id);
    for (const granted of [['packages.manage', 'files.readOthers'], ['*']]) {
      h.granted = granted;
      const listed = await ids();
      expect(listed, granted.join()).toContain(OTHERS);
      expect(listed, granted.join()).not.toContain(DEVICE);
    }
    h.granted = ['packages.manage'];
    expect(await ids(), 'owner').toContain(MINE);
  });
});
