/**
 * A device folder's packages, read over its link and never copied here.
 *
 * Pinned: the host re-checks every package folder with the kernel predicate
 * before it joins one onto a root (and opens a device reader per folder); the
 * scanner reads ONLY through its reader — the same path on this disk holds a
 * different package; an unreachable device keeps its last records, listed as
 * not available, and confirms no deletion; the runtime manager hands the loader
 * the device reader, or — while the device is offline — a stub with nothing to
 * run or advertise and no read at all.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PackageDefinition, PackageLoadOptions, PackageReader, PackageReaderEntry, PackageSourceRoot, RuntimeLoaderPort, RuntimePackageStatus } from '@neuralis/package-system/contracts';

const h = vi.hoisted(() => ({ core: null as unknown }));
vi.mock('../../host/bootstrap', () => ({ getRuntime: async () => h.core, BUILTIN_PACKAGE_IDS: new Set<string>() }));
vi.mock('../../store/ProjectStore', () => ({
  getProjectById: async (id: string) => ({ id, roles: {}, packageTrust: {} }),
  removeDeletedPackageReferences: async () => {},
  updateProject: async () => {},
}));

import { deviceOfOrigin, selectFlaggedPackageRoots } from '../projectPackages';
import { ProjectPackageScanner, getScannerForDir } from '../ProjectPackageScanner';
import { toResolvedRecord, type ResolvedPackageRecord } from '../packageRecords';
import { getPackageRuntimeManager } from '../PackageRuntimeManager';
import { passesProjectAndOwnerScope } from '../packageVisibility';

let root = '';
const logger = { info: () => {}, warn: () => {}, debug: () => {} };

/** An in-memory device folder rooted at `root`; `online` is its link. */
function deviceReader(files: Record<string, string>, state: { online: boolean }, source = 'laptop'): PackageReader & { calls: string[] } {
  const calls: string[] = [];
  const rel = (p: string): string => path.relative(root, p).split(path.sep).join('/');
  const dirs = new Set<string>(['']);
  for (const f of Object.keys(files)) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const guard = (): void => { if (!state.online) throw new Error('device_offline'); };
  return {
    id: `device:dev_far:${source}:${root}`,
    transport: 'device',
    calls,
    async readText(p) { guard(); calls.push(`read ${rel(p)}`); const b = files[rel(p)]; if (b === undefined) throw new Error('ENOENT'); return b; },
    async readBytes(p) { guard(); const b = files[rel(p)]; if (b === undefined) throw new Error('ENOENT'); return new Uint8Array(Buffer.from(b)); },
    async list(dir) {
      guard();
      const base = rel(dir);
      if (!dirs.has(base)) throw new Error('ENOENT');
      const prefix = base ? `${base}/` : '';
      const out = new Map<string, PackageReaderEntry>();
      for (const entry of [...dirs, ...Object.keys(files)]) {
        if (!entry.startsWith(prefix) || entry === base) continue;
        const name = entry.slice(prefix.length).split('/')[0]!;
        const isDirectory = dirs.has(`${prefix}${name}`);
        out.set(name, { name, isDirectory, isFile: !isDirectory });
      }
      return [...out.values()];
    },
    async stat(p) { guard(); const r = rel(p); if (dirs.has(r)) return { isDirectory: true }; return files[r] !== undefined ? { isDirectory: false } : null; },
    uriOf: (p) => `${source}://pkgs/${rel(p)}`,
    available: () => state.online,
  };
}

const FILES = {
  'tools-pkg/package.json': JSON.stringify({ name: 'tools-pkg', neuralis: { id: 'tools-pkg', name: 'Device tools', description: 'from the DEVICE' } }),
  'tools-pkg/skills/greet/SKILL.md': '---\nname: greet\ndescription: device skill\n---\nbody\n',
};

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'neuralis-device-folder-'));
  // The SAME path on this disk holds another package — never to be read.
  await fs.mkdir(path.join(root, 'tools-pkg'), { recursive: true });
  await fs.writeFile(path.join(root, 'tools-pkg', 'package.json'), JSON.stringify({ name: 'tools-pkg', neuralis: { id: 'tools-pkg', name: 'Disk tools', description: 'from THIS DISK' } }));
});
afterAll(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe('selectFlaggedPackageRoots — device folders and the folder re-check', () => {
  const base: PackageSourceRoot = { slug: 'acme', uriRoot: 'acme://', containerRoot: '/projects/p1/acme', scope: { kind: 'project' }, plane: 'local', packageFolders: [''], enabled: true, kind: 'folder' };

  it('a device row opens ONE reader per package folder and scans its root ON the device', () => {
    const opened: string[] = [];
    const reader = { id: 'device:x', transport: 'device' } as PackageReader;
    const selected = selectFlaggedPackageRoots([{
      ...base, slug: 'laptop', uriRoot: 'laptop://', containerRoot: '', plane: 'device', packageFolders: ['pkgs', '.claude'],
      device: { id: 'dev_far', openReader: (folder) => { opened.push(folder); return { root: `/home/bob/work/${folder}`, reader }; } },
    }]);
    expect(opened).toEqual(['pkgs', '.claude']);
    expect(selected).toEqual([
      { dir: '/home/bob/work/pkgs', ownerScope: { kind: 'project' }, plane: 'device', uriRoot: 'laptop://pkgs', reader, device: 'dev_far' },
      { dir: '/home/bob/work/.claude', ownerScope: { kind: 'project' }, plane: 'device', uriRoot: 'laptop://.claude', reader, device: 'dev_far' },
    ]);
    // Paired control: a folder this process opens carries no device.
    expect(selectFlaggedPackageRoots([base])).toEqual([{ dir: '/projects/p1/acme', ownerScope: { kind: 'project' }, plane: 'local', uriRoot: 'acme://' }]);
  });

  it('a package row names the device its origin lives on — at a segment boundary, never a bare prefix', () => {
    const entries = [
      { uriRoot: 'packages://' },
      { uriRoot: 'acme://' },
      { uriRoot: 'laptop://pkgs', device: 'dev_far' },
      { uriRoot: 'desk://', device: 'dev_desk' },
    ];
    expect(deviceOfOrigin(entries, 'laptop://pkgs/tools-pkg')).toBe('dev_far');
    expect(deviceOfOrigin(entries, 'laptop://pkgs')).toBe('dev_far');
    expect(deviceOfOrigin(entries, 'desk://tools-pkg')).toBe('dev_desk');
    // Controls: a sibling folder sharing the prefix, a server folder and the drop zone are this server.
    expect(deviceOfOrigin(entries, 'laptop://pkgsextra/x')).toBeUndefined();
    expect(deviceOfOrigin(entries, 'acme://tools-pkg')).toBeUndefined();
    expect(deviceOfOrigin(entries, 'packages://tools-pkg')).toBeUndefined();
  });

  it('a folder that is not source-relative is never joined onto a root — on either transport', () => {
    const opened: string[] = [];
    const selected = selectFlaggedPackageRoots([
      { ...base, packageFolders: ['../escape', 'ok'] },
      { ...base, slug: 'laptop', containerRoot: '', packageFolders: ['/etc', 'a/../..'], device: { id: 'dev_far', openReader: (f) => { opened.push(f); return { root: f, reader: {} as PackageReader }; } } },
    ], logger as never);
    expect(selected.map((s) => s.dir)).toEqual(['/projects/p1/acme/ok']);
    expect(opened).toEqual([]);
  });
});

describe('ProjectPackageScanner over a device reader', () => {
  it('reads only the device; offline keeps the last records as not available and confirms no deletion; online again clears it', async () => {
    const state = { online: true };
    const reader = deviceReader(FILES, state);
    const scanner = new ProjectPackageScanner(root, logger, reader);
    expect(await scanner.scan()).toBe(1);
    const [record] = scanner.listPackages();
    expect(record!.definition.description).toBe('from the DEVICE');
    expect(record!.reader).toBe(reader);
    expect(record!.unavailable).toBeUndefined();
    expect(record!.definition.skills?.[0]).toMatchObject({ uri: 'laptop://pkgs/tools-pkg/skills/greet/SKILL.md' });
    expect(record!.definition.skills?.[0]?.containerDir).toBeUndefined();

    state.online = false;
    reader.calls.length = 0;
    expect(await scanner.scan()).toBe(1);
    expect(reader.calls).toEqual([]);
    expect(scanner.unavailable).toBe(true);
    expect(scanner.listPackages().map((r) => r.unavailable)).toEqual(['device-offline']);
    expect(scanner.isConfirmedDeleted(path.join(root, 'tools-pkg'))).toBe(false);
    expect(scanner.isConfirmedDeleted(path.join(root, 'gone'))).toBe(false);

    state.online = true;
    await scanner.scan();
    expect(scanner.unavailable).toBe(false);
    expect(scanner.listPackages()[0]!.unavailable).toBeUndefined();
  });

  it('cost bound: one scan of a two-file device package costs a fixed, small number of link calls — and an offline scan none', async () => {
    const state = { online: true };
    const reader = deviceReader(FILES, state);
    const counting = { ...reader, calls: reader.calls } as PackageReader & { calls: string[] };
    let rpc = 0;
    for (const key of ['readText', 'readBytes', 'list', 'stat'] as const) {
      const inner = (reader as unknown as Record<string, unknown>)[key] as (...a: unknown[]) => Promise<unknown>;
      (counting as unknown as Record<string, unknown>)[key] = (...a: unknown[]) => { rpc += 1; return inner(...a); };
    }
    await new ProjectPackageScanner(root, logger, counting).scan();
    // folder stat + list · package stat + list · 2 manifest reads · discovery
    // (dir stats/lists of the category folders + one read per markdown/json file).
    // Measured 28 on this fixture (2026-10-24).
    expect(rpc).toBeLessThanOrEqual(30);
    const measured = rpc;
    rpc = 0;
    state.online = false;
    await new ProjectPackageScanner(root, logger, counting).scan();
    expect(rpc).toBe(0);
    expect(measured).toBeGreaterThan(0);
  });

  it('CONTROL: the local reader on the same root reads THIS disk', async () => {
    const scanner = new ProjectPackageScanner(root, logger);
    await scanner.scan();
    expect(scanner.listPackages()[0]!.definition.description).toBe('from THIS DISK');
  });

  it('a device folder and the same path on this disk are two scanners', () => {
    const reader = deviceReader(FILES, { online: true });
    expect(getScannerForDir(root, logger, reader)).not.toBe(getScannerForDir(root, logger));
    expect(getScannerForDir(root, logger, reader)).toBe(getScannerForDir(root, logger, reader));
  });
});

describe('one device folder, several SOURCE instances — never one shared scanner', () => {
  const a = { projectId: 'pa', scope: { kind: 'project' } as const, uriRoot: 'srca://pkgs' };
  const b = { projectId: 'pb', scope: { kind: 'user', userId: 'u1' } as const, uriRoot: 'srcb://pkgs' };

  it('two sources on one device folder: two scanners, each record\'s skill URI under its OWN source', async () => {
    const sa = getScannerForDir(root, logger, deviceReader(FILES, { online: true }, 'srca'), a);
    const sb = getScannerForDir(root, logger, deviceReader(FILES, { online: true }, 'srcb'), b);
    expect(sa).not.toBe(sb);
    await Promise.all([sa.scan(), sb.scan()]);
    expect(sa.listPackages()[0]!.definition.skills?.[0]?.uri).toMatch(/^srca:\/\/pkgs\//);
    expect(sb.listPackages()[0]!.definition.skills?.[0]?.uri).toMatch(/^srcb:\/\/pkgs\//);
  });

  it('the same reader in two projects / scopes: two scanners (the reader alone does not name the instance)', () => {
    const reader = deviceReader(FILES, { online: true }, 'same');
    const one = getScannerForDir(root, logger, reader, { ...a, uriRoot: 'same://pkgs' });
    expect(getScannerForDir(root, logger, reader, { ...b, uriRoot: 'same://pkgs' })).not.toBe(one);
    expect(getScannerForDir(root, logger, reader, { ...a, projectId: 'pb', uriRoot: 'same://pkgs' })).not.toBe(one);
    expect(getScannerForDir(root, logger, reader, { ...a, uriRoot: 'same://pkgs' })).toBe(one);
  });

  it('the last listener out stops the watch and evicts the scanner; the source re-created gets a FRESH one', async () => {
    let stops = 0;
    const reader = { ...deviceReader(FILES, { online: true }, 'srcp'), watch: () => () => { stops += 1; } };
    const instance = { ...a, uriRoot: 'srcp://pkgs' };
    const first = getScannerForDir(root, logger, reader, instance);
    first.startWatching('pa', () => {});
    first.startWatching('pz', () => {});
    await first.removeListener('pz');
    expect(getScannerForDir(root, logger, reader, instance)).toBe(first);
    expect(stops).toBe(0);
    await first.removeListener('pa');
    expect(stops).toBe(1);
    const again = getScannerForDir(root, logger, reader, instance);
    expect(again).not.toBe(first);
    await again.scan();
    expect(again.listPackages()[0]!.definition.skills?.[0]?.uri).toMatch(/^srcp:\/\/pkgs\//);
  });

  it('CONTROL: two projects on one LOCAL folder still share one scanner', () => {
    expect(getScannerForDir(root, logger, undefined, a)).toBe(getScannerForDir(root, logger, undefined, b));
  });
});

describe('a package folder that IS the package (packageFolders: [".claude"], slug "")', () => {
  const SKILL = '---\nname: greet\ndescription: a .claude skill\n---\nbody\n';

  it('on a DEVICE: one record named after its folder, its skill listed', async () => {
    const scanner = new ProjectPackageScanner(path.join(root, '.claude'), logger, deviceReader({ '.claude/skills/greet/SKILL.md': SKILL }, { online: true }));
    expect(await scanner.scan()).toBe(1);
    const [record] = scanner.listPackages();
    expect(record).toMatchObject({ slug: '', packageId: 'claude' });
    expect(record!.definition.skills?.map((s) => s.id)).toEqual(['greet']);
    expect(() => toResolvedRecord(record!, 'p1', { kind: 'project' }, { directory: path.join(root, '.claude'), uriRoot: 'laptop://.claude', plane: 'device' })).not.toThrow();
  });

  it('on THIS disk: the same', async () => {
    const local = await fs.mkdtemp(path.join(os.tmpdir(), 'neuralis-root-pkg-'));
    try {
      await fs.mkdir(path.join(local, '.claude', 'skills', 'greet'), { recursive: true });
      await fs.writeFile(path.join(local, '.claude', 'skills', 'greet', 'SKILL.md'), SKILL);
      const scanner = new ProjectPackageScanner(path.join(local, '.claude'), logger);
      expect(await scanner.scan()).toBe(1);
      expect(scanner.listPackages()[0]).toMatchObject({ slug: '', packageId: 'claude' });
      expect(scanner.listPackages()[0]!.definition.skills?.map((s) => s.id)).toEqual(['greet']);
    } finally {
      await fs.rm(local, { recursive: true, force: true });
    }
  });

  it('a manifest that fails validation is refused WITH its reason, never an empty one', async () => {
    const warns: string[] = [];
    // A folder whose name leaves no usable id: the refusal names the validator's first error.
    const scanner = new ProjectPackageScanner(path.join(root, '___'), { ...logger, warn: (_m: string, meta?: Record<string, unknown>) => { warns.push(String(meta?.error)); } }, deviceReader({ '___/skills/a/SKILL.md': SKILL }, { online: true }));
    await scanner.scan();
    expect(warns.join('\n')).toMatch(/Invalid authored package manifest "": \S+/);
  });
});

describe('PackageRuntimeManager — what the loader is handed for a device package', () => {
  it('online: the definition, its device root and its reader; offline: a stub, no root, no read', async () => {
    const calls: Array<{ definition: PackageDefinition; packageRoot?: string; options?: PackageLoadOptions }> = [];
    const loaded = new Map<string, RuntimePackageStatus>();
    const loader = {
      load: async (definition: PackageDefinition, packageRoot?: string, _m?: string, _o?: string, options?: PackageLoadOptions) => {
        calls.push({ definition, ...(packageRoot ? { packageRoot } : {}), ...(options ? { options } : {}) });
        loaded.set(definition.id, { packageId: definition.id, definition, status: options?.unavailable ? 'partial' : 'loaded' } as RuntimePackageStatus);
      },
      reload: async (definition: PackageDefinition, packageRoot?: string, m?: string, o?: string, options?: PackageLoadOptions) => {
        loaded.delete(definition.id);
        await loader.load(definition, packageRoot, m, o, options);
      },
      unload: async (id: string) => loaded.delete(id),
      start: async () => {},
      getStatus: (id: string) => loaded.get(id),
      listLoaded: () => [...loaded.values()].map((s) => s.definition),
    } as unknown as RuntimeLoaderPort;
    h.core = { whenReady: async () => {}, getLoader: () => loader, getRegistry: () => ({}), getRuntime: () => ({ invalidate: () => {} }) };

    const state = { online: true };
    const reader = deviceReader(FILES, state);
    const scanner = new ProjectPackageScanner(root, logger, reader);
    await scanner.scan();
    const toRecords = () => scanner.listPackages().map((r) => toResolvedRecord(r, 'p1', { kind: 'user', userId: 'bob' }, { directory: root, uriRoot: 'laptop://pkgs', plane: 'device' }));

    await getPackageRuntimeManager().syncProjectPackagesToRuntime('p1', toRecords());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.packageRoot).toBe(path.join(root, 'tools-pkg'));
    expect(calls[0]!.options).toEqual({ reader });
    expect(calls[0]!.definition.skills?.length).toBe(1);

    state.online = false;
    await scanner.scan();
    await getPackageRuntimeManager().syncProjectPackagesToRuntime('p1', toRecords());
    expect(calls).toHaveLength(2);
    const stub = calls[1]!;
    expect(stub.packageRoot).toBeUndefined();
    expect(stub.options).toEqual({ unavailable: 'device-offline' });
    expect(stub.definition.skills).toBeUndefined();
    expect(stub.definition.descriptionForModel).toMatch(/^Not available — the device that holds this package is offline/);
    expect(stub.definition.access?.trust).toBe('untrusted');
  });
});

/** A loader that records what it loads, for a runtime-manager sync without a host. */
function recordingLoader(): RuntimeLoaderPort {
  const loaded = new Map<string, RuntimePackageStatus>();
  const loader = {
    load: async (definition: PackageDefinition) => { loaded.set(definition.id, { packageId: definition.id, definition, status: 'loaded' } as RuntimePackageStatus); },
    reload: async (definition: PackageDefinition) => { loaded.set(definition.id, { packageId: definition.id, definition, status: 'loaded' } as RuntimePackageStatus); },
    unload: async (id: string) => loaded.delete(id),
    start: async () => {},
    getStatus: (id: string) => loaded.get(id),
    listLoaded: () => [...loaded.values()].map((s) => s.definition),
  } as unknown as RuntimeLoaderPort;
  return loader;
}

describe('a member\'s USER-scope DEVICE folder — its packages serve their owner alone', () => {
  // The plane rides from the source owner's row (`PackageSourceRoot.plane`) to
  // the package record and the manager — never re-derived from the row's shape:
  // the loopback folder opens in process and carries a `containerRoot` like a
  // server folder does.
  it('loopback and remote shapes are hidden from files.readOthers and \'*\'; the owner sees them; the same scope on the local plane stays visible', async () => {
    // The manager keeps the first runtime it meets; a run of this test alone brings its own.
    h.core ??= { whenReady: async () => {}, getLoader: recordingLoader, getRegistry: () => ({}), getRuntime: () => ({ invalidate: () => {} }) };
    const member = { kind: 'user', userId: 'm1' } as const;
    const reader = deviceReader(FILES, { online: true }, 'far');
    const roots: PackageSourceRoot[] = [
      { slug: 'mine', uriRoot: 'mine://', containerRoot: root, scope: member, plane: 'device', packageFolders: [''], enabled: true, kind: 'host' },
      { slug: 'far', uriRoot: 'far://', containerRoot: '', scope: member, plane: 'device', packageFolders: [''], enabled: true, kind: 'host', device: { id: 'dev_far', openReader: () => ({ root, reader }) } },
      { slug: 'srv', uriRoot: 'srv://', containerRoot: root, scope: member, plane: 'local', packageFolders: [''], enabled: true, kind: 'host' },
    ];
    const records: ResolvedPackageRecord[] = [];
    for (const flagged of selectFlaggedPackageRoots(roots)) {
      const scanner = getScannerForDir(flagged.dir, logger, flagged.reader, { projectId: 'p-dev', scope: flagged.ownerScope, uriRoot: flagged.uriRoot });
      await scanner.scan();
      records.push(...scanner.listPackages().map((r) => toResolvedRecord(r, 'p-dev', flagged.ownerScope, { directory: flagged.dir, uriRoot: flagged.uriRoot, plane: flagged.plane })));
    }
    const manager = getPackageRuntimeManager();
    await manager.syncProjectPackagesToRuntime('p-dev', records);
    const bySlug = (slug: string) => records.find((r) => r.originUri?.startsWith(`${slug}://`))!.definition;
    const visible = (slug: string, userId: string, grantedFeatures: string[]) => passesProjectAndOwnerScope(bySlug(slug), { host: 'neuralis-workspace', projectId: 'p-dev', userId, grantedFeatures });

    for (const slug of ['mine', 'far']) {
      expect(manager.getPackageOwnerOrigin('p-dev', bySlug(slug).id), slug).toEqual({ plane: 'device' });
      expect(visible(slug, 'admin1', ['files.readOthers']), `${slug}: files.readOthers`).toBe(false);
      expect(visible(slug, 'admin1', ['*']), `${slug}: '*'`).toBe(false);
      expect(visible(slug, 'm1', []), `${slug}: owner`).toBe(true);
    }
    expect(manager.getPackageOwnerOrigin('p-dev', bySlug('srv').id)).toEqual({ plane: 'local' });
    expect(visible('srv', 'admin1', ['files.readOthers']), 'local plane: files.readOthers').toBe(true);
    expect(visible('srv', 'admin1', []), 'local plane: no grant').toBe(false);
    expect(manager.getPackageOwnerScope('p-dev', bySlug('mine').id)).toEqual(member);
  });
});
