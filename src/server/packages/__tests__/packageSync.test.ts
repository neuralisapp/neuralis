/**
 * The project package sync — a rescan, a reload or a rebuild leaves every
 * project package exactly as it is on disk.
 *
 * Runs the REAL host chain (`ensureProjectPackagesLoaded` → `syncFromScanners`,
 * `rescanProjectPackages`, `PackageRuntimeManager`, `ProjectPackageScanner`)
 * over an in-test loader typed by the kernel `RuntimeLoaderPort` (a host test
 * importing the runtime package is a host→product edge the coupling guard
 * refuses). The fake keeps the two loader behaviours the sync must survive:
 * it stores its OWN mutated copy of a definition (a `lifecycle` shell), and its
 * `load` yields before refusing an id already loaded — so two interleaved
 * syncs reproduce "Package already loaded". Bootstrap, env, logger, project
 * store and access are faked as well.
 *
 * The rules pinned: a rescan syncs EVERY scanner (a source package survives);
 * a sync reloads a package only when its input changed — the scanner record's
 * definition after trust overrides plus the WASM artifact stamp — never because
 * the loader's own stored copy differs; syncs and project reloads run one at a
 * time per project; a record-less reload costs exactly one reload at the next
 * sync; only a PROJECT-scope package grants its default roles.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const h = vi.hoisted(() => ({
  projectsRoot: '',
  sources: new Map<string, { dir: string; scope: Record<string, string> }>(),
  trust: new Map<string, Record<string, string>>(),
  updates: [] as Array<{ id: string; patch: unknown }>,
  log: [] as Array<{ level: string; msg: string; meta?: Record<string, unknown> }>,
  core: null as unknown,
  onLog: null as null | ((msg: string, meta?: Record<string, unknown>) => void),
}));

function mkLogger(prefix: string): Record<string, unknown> {
  const push = (level: string) => (msg: string, meta?: Record<string, unknown>) => {
    h.log.push({ level, msg: `${prefix}${msg}`, meta });
    h.onLog?.(msg, meta);
  };
  const l: Record<string, unknown> = { debug: () => {}, info: push('info'), warn: push('warn'), error: push('error') };
  l.child = () => l;
  return l;
}

vi.mock('../../host/bootstrap', () => ({
  getRuntime: async () => h.core,
  BUILTIN_PACKAGE_IDS: new Set<string>(),
}));
vi.mock('../../config/env', () => ({ getEnv: () => ({ projectsRoot: h.projectsRoot }) }));
vi.mock('../../logging/setup', () => ({ getLogger: () => mkLogger('[host] ') }));
vi.mock('../../store/ProjectStore', () => ({
  getProjectById: async (id: string) => ({ id, roles: {}, packageTrust: h.trust.get(id) ?? {} }),
  updateProject: async (id: string, producer: (current: unknown) => unknown) => {
    h.updates.push({
      id,
      patch: producer({
        id,
        roles: { member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 30 } },
      }),
    });
  },
}));
vi.mock('../../projects/access', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveProjectAccess: async () => ({ role: 'owner' }),
  canManagePackages: () => true,
}));

import { PackageRegistry } from '@neuralis/package-system';
import type { PackageDefinition, RuntimeLoaderPort, RuntimePackageStatus } from '@neuralis/package-system/contracts';
import { getFsWatchHub } from '@neuralis/package-system/data';
import { ensureProjectPackagesLoaded, resetProjectPackageActivation } from '../projectPackages';
import { rescanProjectPackages } from '../rescanProjectPackages';
import { getPackageRuntimeManager } from '../PackageRuntimeManager';
import { getProjectPackageScanner, getScannerForDir } from '../ProjectPackageScanner';
import { toResolvedRecord } from '../packageRecords';

/** The loader surface the sync calls, with the real loader's two hazards (see the header). */
class FakeLoader implements RuntimeLoaderPort {
  readonly #loaded = new Map<string, RuntimePackageStatus & { manifestId?: string; ownerProjectId?: string }>();
  readonly #log = mkLogger('[loader] ') as { info: (msg: string, meta?: Record<string, unknown>) => void };

  async load(definition: PackageDefinition, packageRoot?: string, manifestId?: string, ownerProjectId?: string): Promise<void> {
    // The real `load` awaits its file resolution before the duplicate check.
    await new Promise((r) => setTimeout(r, 5));
    if (this.#loaded.has(definition.id)) throw new Error(`Package already loaded: ${definition.id}`);
    // Its OWN copy, mutated: never byte-equal to the definition it was handed.
    const stored: PackageDefinition = { ...definition, lifecycle: {} } as PackageDefinition;
    this.#loaded.set(definition.id, { packageId: definition.id, definition: stored, status: 'loaded', packageRoot, manifestId, ownerProjectId });
    this.#log.info('Package loaded', { packageId: definition.id });
  }

  async reload(definition: PackageDefinition, packageRoot?: string, manifestId?: string, ownerProjectId?: string): Promise<void> {
    const prev = this.#loaded.get(definition.id);
    if (prev) await this.unload(definition.id);
    await this.load(definition, packageRoot, manifestId ?? prev?.manifestId, ownerProjectId ?? prev?.ownerProjectId);
    await this.start(definition.id);
  }

  async unload(packageId: string): Promise<boolean> {
    if (!this.#loaded.delete(packageId)) return false;
    this.#log.info('Package unloaded', { packageId });
    return true;
  }

  async start(packageId: string): Promise<void> {
    const s = this.#loaded.get(packageId);
    if (s) s.started = true;
  }

  getStatus(packageId: string): RuntimePackageStatus | undefined {
    return this.#loaded.get(packageId);
  }

  isLoaded(packageId: string): boolean {
    return this.#loaded.has(packageId);
  }

  listLoaded(): PackageDefinition[] {
    return [...this.#loaded.values()].map((s) => s.definition);
  }

  getPackageApi<T>(): T | undefined {
    return undefined;
  }

  onChange(): () => void {
    return () => {};
  }

  async provisionProjectForAll(): Promise<void> {}
  async deprovisionProjectForAll(): Promise<void> {}
  async revokePrincipalForAll(): Promise<void> {}
}

let loader: FakeLoader;
let tmp = '';

const HELLO_PING = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'hello_ping',
  type: 'object',
  description: 'Echo a message back.',
  properties: { msg: { type: 'string', description: 'The message to echo.' } },
  required: ['msg'],
  additionalProperties: false,
  'x-neuralis': {
    family: 'hello',
    operation: 'hello.ping',
    transport: 'embedded',
    defaults: {},
    annotations: { readOnlyHint: true, category: 'read' },
  },
};

/** Mirrors `~/projects/testpackages/hello-r2` (wasm runtime, one tool schema). */
async function writePkg(
  dir: string,
  id: string,
  runtime: 'wasm' | 'node',
  extra: Record<string, unknown> = {},
): Promise<void> {
  await fs.mkdir(path.join(dir, 'tools'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: id,
      version: '0.1.0',
      private: true,
      neuralis: {
        id,
        name: id,
        version: '0.1.0',
        description: 'sync fixture',
        ...(runtime === 'wasm'
          ? { runtime: { type: 'wasm', hosted: { tools: 'all', prompts: 'none', resources: 'none' } } }
          : {}),
        ...extra,
      },
    }),
  );
  await fs.writeFile(path.join(dir, 'tools', 'hello_ping.json'), JSON.stringify(HELLO_PING));
}

async function editDescription(pkgDir: string, description: string): Promise<void> {
  const pj = path.join(pkgDir, 'package.json');
  const m = JSON.parse(await fs.readFile(pj, 'utf8')) as { neuralis: { description: string } };
  m.neuralis.description = description;
  await fs.writeFile(pj, JSON.stringify(m));
}

const settle = (ms = 1500) => new Promise((r) => setTimeout(r, ms));

function reloadsOf(spy: { mock: { calls: unknown[][] } }, id: string): number {
  return spy.mock.calls.filter((c) => (c[0] as { id: string }).id === id).length;
}

function projectId(dir: string, pid: string): string {
  return toResolvedRecord(getScannerForDir(dir).listPackages()[0]!, pid, { kind: 'project' }).packageId;
}

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'neuralis-package-sync-'));
  h.projectsRoot = path.join(tmp, 'projects');
  const registry = new PackageRegistry();
  loader = new FakeLoader();
  h.core = {
    whenReady: async () => undefined,
    getLoader: () => loader,
    getRegistry: () => registry,
    getRuntime: () => ({ invalidate: () => undefined }),
    services: new Map([
      [
        'package-source-roots',
        {
          listPackageSourceRoots: async (pid: string) => {
            const src = h.sources.get(pid);
            return src
              ? [{
                  slug: 'testpackages', uriRoot: 'testpackages://', containerRoot: src.dir,
                  scope: src.scope, recognizesPackages: true, enabled: true, kind: 'local',
                }]
              : [];
          },
        },
      ],
    ]),
  };
});

beforeEach(() => {
  h.updates.length = 0;
  h.onLog = null;
});

afterAll(async () => {
  await getFsWatchHub().closeAll();
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

describe('a rescan syncs EVERY scanner of the project', () => {
  it('a recognizesPackages-source package survives POST /api/packages/rescan, and `scanned` sums all scanners', async () => {
    const pid = 'rs-all';
    const src = path.join(tmp, 'mounts', 'testpackages-rs-all');
    h.sources.set(pid, { dir: src, scope: { kind: 'project' } });
    await writePkg(path.join(h.projectsRoot, pid, '_packages', 'drop-a'), 'drop-a', 'node');
    await writePkg(path.join(src, 'hello-r2'), 'hello-r2', 'wasm');
    await ensureProjectPackagesLoaded(pid);
    const helloId = projectId(src, pid);
    expect(loader.isLoaded(helloId)).toBe(true);

    const result = await rescanProjectPackages('u1', pid);
    expect(result.scanned).toBe(2);
    expect(getPackageRuntimeManager().getProjectPackageIds(pid).has(helloId)).toBe(true);
    expect(loader.isLoaded(helloId)).toBe(true);
  });
});

describe('a sync reloads only what changed on disk', () => {
  it('an unchanged rescan reloads nothing (declarative AND wasm)', async () => {
    const pid = 'unchanged';
    const drops = path.join(h.projectsRoot, pid, '_packages');
    await writePkg(path.join(drops, 'decl-a'), 'decl-a', 'node');
    await writePkg(path.join(drops, 'wasm-b'), 'wasm-b', 'wasm');
    await ensureProjectPackagesLoaded(pid);
    const reload = vi.spyOn(loader, 'reload');
    await rescanProjectPackages('u1', pid);
    expect(reload).not.toHaveBeenCalled();
  });

  it('NO OSCILLATION: sync → fresh scanner records → sync reloads nothing', async () => {
    const pid = 'oscillate';
    await writePkg(path.join(h.projectsRoot, pid, '_packages', 'osc-a'), 'osc-a', 'node');
    await ensureProjectPackagesLoaded(pid);
    const scanner = getProjectPackageScanner(path.join(h.projectsRoot, pid));
    const reload = vi.spyOn(loader, 'reload');
    const mgr = getPackageRuntimeManager();
    for (let i = 0; i < 3; i++) {
      await scanner.rescan();
      const records = scanner.listPackages().map((r) => toResolvedRecord(r, pid, { kind: 'project' }));
      expect((await mgr.syncProjectPackagesToRuntime(pid, records)).errors).toEqual([]);
    }
    expect(reload).not.toHaveBeenCalled();
  });

  it('a changed manifest reloads exactly once', async () => {
    const pid = 'changed';
    const pkgDir = path.join(h.projectsRoot, pid, '_packages', 'chg-a');
    await writePkg(pkgDir, 'chg-a', 'node');
    await ensureProjectPackagesLoaded(pid);
    const id = projectId(path.join(h.projectsRoot, pid, '_packages'), pid);
    const reload = vi.spyOn(loader, 'reload');
    await editDescription(pkgDir, 'changed');
    await rescanProjectPackages('u1', pid);
    await settle();
    await rescanProjectPackages('u1', pid);
    expect(reloadsOf(reload, id)).toBe(1);
  });

  it('WASM: a new artifact stamp under the same manifest reloads exactly once; the same stamp again reloads nothing', async () => {
    const pid = 'wasm-stamp';
    const pkgDir = path.join(h.projectsRoot, pid, '_packages', 'wasm-s');
    await writePkg(pkgDir, 'wasm-s', 'wasm');
    await ensureProjectPackagesLoaded(pid);
    const id = projectId(path.join(h.projectsRoot, pid, '_packages'), pid);
    const reload = vi.spyOn(loader, 'reload');

    // A CLI `neuralis-build` in the drop rewrites `dist/` — no manifest byte moves.
    await fs.mkdir(path.join(pkgDir, 'dist'), { recursive: true });
    await fs.writeFile(path.join(pkgDir, 'dist', 'routes.json'), '[]');
    await rescanProjectPackages('u1', pid);
    await settle(); // the watcher's own sync of the same write lands here too
    expect(reloadsOf(reload, id)).toBe(1);

    await rescanProjectPackages('u1', pid);
    expect(reloadsOf(reload, id)).toBe(1);
    expect(loader.getStatus(id)?.status).not.toBe('error');
  });

  it('a record-less reload (admin `package.reload`) costs exactly ONE reload at the next sync', async () => {
    const pid = 'recordless';
    await writePkg(path.join(h.projectsRoot, pid, '_packages', 'rl-a'), 'rl-a', 'node');
    await ensureProjectPackagesLoaded(pid);
    const id = projectId(path.join(h.projectsRoot, pid, '_packages'), pid);
    await getPackageRuntimeManager().reloadPackage(id);
    const reload = vi.spyOn(loader, 'reload');
    await rescanProjectPackages('u1', pid);
    await rescanProjectPackages('u1', pid);
    expect(reloadsOf(reload, id)).toBe(1);
  });

  it('the trust-escalation guard still refuses a reload that would raise trust', async () => {
    const pid = 'escalate';
    await writePkg(path.join(h.projectsRoot, pid, '_packages', 'esc-a'), 'esc-a', 'node');
    await ensureProjectPackagesLoaded(pid);
    const id = projectId(path.join(h.projectsRoot, pid, '_packages'), pid);
    h.trust.set(pid, { 'esc-a': 'trusted' });
    const reload = vi.spyOn(loader, 'reload');
    await rescanProjectPackages('u1', pid);
    expect(reloadsOf(reload, id)).toBe(0);
    expect(loader.getStatus(id)?.definition.access?.trust).toBe('untrusted');
  });
});

describe('syncs and project reloads run one at a time per project', () => {
  it('two full syncs racing on one changed package leave it loaded with no error', async () => {
    const pid = 'race-two';
    const src = path.join(tmp, 'mounts', 'testpackages-race-two');
    h.sources.set(pid, { dir: src, scope: { kind: 'project' } });
    await writePkg(path.join(src, 'hello-r2'), 'hello-r2', 'wasm');
    await ensureProjectPackagesLoaded(pid);
    const scanner = getScannerForDir(src);
    const id = projectId(src, pid);
    await editDescription(path.join(src, 'hello-r2'), 'changed');
    await scanner.scan();
    const records = scanner.listPackages().map((r) => toResolvedRecord(r, pid, { kind: 'project' }));
    const mgr = getPackageRuntimeManager();
    const [a, b] = await Promise.all([
      mgr.syncProjectPackagesToRuntime(pid, records),
      mgr.syncProjectPackagesToRuntime(pid, records),
    ]);
    expect([...a.errors, ...b.errors]).toEqual([]);
    expect(loader.isLoaded(id)).toBe(true);
  });

  it('a second sync entering while the first one is mid-reload (after its unload) waits — no "already loaded"', async () => {
    const pid = 'race-mid';
    const src = path.join(tmp, 'mounts', 'testpackages-race-mid');
    h.sources.set(pid, { dir: src, scope: { kind: 'project' } });
    await writePkg(path.join(src, 'hello-r2'), 'hello-r2', 'node');
    await ensureProjectPackagesLoaded(pid);
    const scanner = getScannerForDir(src);
    const id = projectId(src, pid);
    await editDescription(path.join(src, 'hello-r2'), 'changed');
    await scanner.scan();
    const records = scanner.listPackages().map((r) => toResolvedRecord(r, pid, { kind: 'project' }));
    const mgr = getPackageRuntimeManager();
    let second: ReturnType<typeof mgr.syncProjectPackagesToRuntime> | null = null;
    h.onLog = (msg, meta) => {
      if (msg === 'Package unloaded' && meta?.packageId === id && !second) {
        second = mgr.syncProjectPackagesToRuntime(pid, records);
      }
    };
    const first = await mgr.syncProjectPackagesToRuntime(pid, records);
    expect(second).not.toBeNull();
    const w2 = await (second as unknown as ReturnType<typeof mgr.syncProjectPackagesToRuntime>);
    expect([...first.errors, ...w2.errors]).toEqual([]);
    expect(loader.isLoaded(id)).toBe(true);
  });

  it('the build route\'s reload racing a sync of the same id: no error, and the queued sync reloads nothing more', async () => {
    const pid = 'race-build';
    const drops = path.join(h.projectsRoot, pid, '_packages');
    await writePkg(path.join(drops, 'b-pkg'), 'b-pkg', 'node');
    await ensureProjectPackagesLoaded(pid);
    const scanner = getProjectPackageScanner(path.join(h.projectsRoot, pid));
    const id = projectId(drops, pid);
    await editDescription(path.join(drops, 'b-pkg'), 'rebuilt');
    await scanner.scan();
    const records = scanner.listPackages().map((r) => toResolvedRecord(r, pid, { kind: 'project' }));
    const mgr = getPackageRuntimeManager();
    const reload = vi.spyOn(loader, 'reload');
    let queued: ReturnType<typeof mgr.syncProjectPackagesToRuntime> | null = null;
    h.onLog = (msg, meta) => {
      if (msg === 'Package unloaded' && meta?.packageId === id && !queued) {
        queued = mgr.syncProjectPackagesToRuntime(pid, records);
      }
    };
    await mgr.reloadProjectPackage(pid, 'b-pkg');
    expect(queued).not.toBeNull();
    const after = await (queued as unknown as ReturnType<typeof mgr.syncProjectPackagesToRuntime>);
    expect(after.errors).toEqual([]);
    expect(loader.isLoaded(id)).toBe(true);
    expect(reloadsOf(reload, id)).toBe(1);
  });

  it('a rescan racing a watcher sync leaves the source package loaded', async () => {
    const pid = 'race-watch';
    const src = path.join(tmp, 'mounts', 'testpackages-race-watch');
    h.sources.set(pid, { dir: src, scope: { kind: 'project' } });
    await writePkg(path.join(h.projectsRoot, pid, '_packages', 'drop-a'), 'drop-a', 'node');
    await writePkg(path.join(src, 'hello-r2'), 'hello-r2', 'wasm');
    await ensureProjectPackagesLoaded(pid);
    const id = projectId(src, pid);
    await fs.writeFile(path.join(src, 'hello-r2', 'tools', 'touch.txt'), 'x');
    await rescanProjectPackages('u1', pid);
    await settle();
    expect(loader.isLoaded(id)).toBe(true);
  });
});

describe('re-activation after clear-cache', () => {
  it('reloads nothing, and a newly flagged source survives a watch event on an OLD scanner', async () => {
    const pid = 'reactivate';
    const drops = path.join(h.projectsRoot, pid, '_packages');
    await writePkg(path.join(drops, 'drop-a'), 'drop-a', 'node');
    await ensureProjectPackagesLoaded(pid);
    const dropId = projectId(drops, pid);
    const reload = vi.spyOn(loader, 'reload');

    // A source flagged after the first activation; clear-cache re-activates.
    const src = path.join(tmp, 'mounts', 'testpackages-reactivate');
    await writePkg(path.join(src, 'late-src'), 'late-src', 'node');
    h.sources.set(pid, { dir: src, scope: { kind: 'project' } });
    resetProjectPackageActivation(pid);
    await ensureProjectPackagesLoaded(pid);
    const srcId = projectId(src, pid);
    expect(loader.isLoaded(srcId)).toBe(true);
    expect(reloadsOf(reload, dropId)).toBe(0);

    // The drop-zone scanner's watcher was registered at the FIRST activation.
    await fs.writeFile(path.join(drops, 'drop-a', 'tools', 'touch.txt'), 'x');
    await settle();
    expect(loader.isLoaded(srcId)).toBe(true);
    expect(getPackageRuntimeManager().getProjectPackageIds(pid).has(srcId)).toBe(true);
  });
});

describe('one activation state per process', () => {
  it('a second copy of the module (another server bundle) rescans with the list the first copy re-activated', async () => {
    const pid = 'two-bundles';
    await writePkg(path.join(h.projectsRoot, pid, '_packages', 'drop-a'), 'drop-a', 'node');
    vi.resetModules();
    const other = await import('../rescanProjectPackages');
    const otherActivation = await import('../projectPackages');
    // The other bundle activates the project first, before the source exists.
    await otherActivation.ensureProjectPackagesLoaded(pid);

    // Flagged after the first activation; clear-cache re-activates through THIS copy.
    const src = path.join(tmp, 'mounts', 'testpackages-two-bundles');
    await writePkg(path.join(src, 'late-src'), 'late-src', 'node');
    h.sources.set(pid, { dir: src, scope: { kind: 'project' } });
    resetProjectPackageActivation(pid);
    await ensureProjectPackagesLoaded(pid);
    const srcId = projectId(src, pid);
    expect(loader.isLoaded(srcId)).toBe(true);

    const result = await other.rescanProjectPackages('u1', pid);
    expect(result.scanned).toBe(2);
    expect(loader.isLoaded(srcId)).toBe(true);
  });
});

describe('default role grants — project scope only', () => {
  const granting = { requires: { providesFeatures: ['g.use'], defaultRoleGrants: { member: ['g.use'] } } };

  it('a USER-scoped source package writes nothing onto the project roles', async () => {
    const pid = 'grant-user';
    const src = path.join(tmp, 'mounts', 'testpackages-grant-user');
    h.sources.set(pid, { dir: src, scope: { kind: 'user', userId: 'u1' } });
    await writePkg(path.join(src, 'g-user'), 'g-user', 'node', granting);
    await ensureProjectPackagesLoaded(pid);
    expect(h.updates.filter((u) => u.id === pid)).toEqual([]);
  });

  it('a PROJECT-scoped source package grants its defaults like a drop', async () => {
    const pid = 'grant-project';
    const src = path.join(tmp, 'mounts', 'testpackages-grant-project');
    h.sources.set(pid, { dir: src, scope: { kind: 'project' } });
    await writePkg(path.join(src, 'g-proj'), 'g-proj', 'node', granting);
    await ensureProjectPackagesLoaded(pid);
    const writes = h.updates.filter((u) => u.id === pid);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.patch).toMatchObject({ roles: { member: { grantedFeatures: ['g.use'] } } });
  });
});
