import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectRecord } from '../../store/projectTypes';
import type { ProjectRecordPatch } from '../../store/ProjectStore';
import { BUILTIN_GRANT_CHANGES_FILE, reconcileBuiltinGrantChanges } from '../reconcileBuiltinGrantChanges';

/**
 * A builtin the operator removed takes the grants of the features only it
 * provided; a builtin the operator ADDED after a project exists grants its
 * manifest defaults there once — both read from the record `pnpm neuralis:pkg`
 * wrote. The app root is a mkdtemp sandbox; the project store is an in-memory
 * map driven through the same producer shape.
 */

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function appRootWith(records: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'neuralis-builtin-grant-changes-'));
  roots.push(root);
  if (records !== undefined) {
    mkdirSync(join(root, 'config'), { recursive: true });
    writeFileSync(join(root, BUILTIN_GRANT_CHANGES_FILE), JSON.stringify(records));
  }
  return root;
}

function project(roles: Record<string, string[]>, priorities: Record<string, number> = {}): ProjectRecord {
  return {
    id: 'p1',
    roles: Object.fromEntries(
      Object.entries(roles).map(([name, grantedFeatures]) => [
        name,
        { grantedFeatures, ...(priorities[name] !== undefined ? { priority: priorities[name] } : {}) },
      ]),
    ),
    appliedPackageGrants: { '@acme/gone': '1.0.0' },
  } as unknown as ProjectRecord;
}

function harness(initial: ProjectRecord) {
  const store = new Map<string, ProjectRecord>([['p1', initial]]);
  const writes: ProjectRecordPatch[] = [];
  return {
    store,
    writes,
    listProjectIds: async () => [...store.keys()],
    updateProject: async (id: string, producer: (current: ProjectRecord) => ProjectRecordPatch | null) => {
      const patch = producer(store.get(id)!);
      if (patch) {
        writes.push(patch);
        store.set(id, { ...store.get(id)!, ...patch } as ProjectRecord);
      }
    },
    logger: { info: () => {}, warn: () => {} },
  };
}

describe('reconcileBuiltinGrantChanges — removals', () => {
  it('no record: nothing is read beyond the stat, nothing written', async () => {
    const h = harness(project({ member: ['acme.use'] }));
    await reconcileBuiltinGrantChanges({ ...h, appRoot: appRootWith(undefined), builtinIds: new Set(), providers: [] });
    expect(h.writes).toEqual([]);
  });

  it('revokes the recorded features no loaded package still provides, keeps the shared one, clears the marker, deletes the record', async () => {
    const h = harness(project({ owner: ['*'], member: ['acme.use', 'shared.read', 'other.x'] }));
    const appRoot = appRootWith({ removals: [{ packageId: '@acme/gone', features: ['acme.use', 'shared.read'], removedAt: 'now' }] });
    await reconcileBuiltinGrantChanges({
      ...h,
      appRoot,
      builtinIds: new Set(['@neuralis/agent-core']),
      providers: [{ id: '@neuralis/agent-core', requires: { providesFeatures: ['shared.read'] } }],
    });
    const p = h.store.get('p1')!;
    expect(p.roles.member.grantedFeatures).toEqual(['shared.read', 'other.x']);
    expect(p.roles.owner.grantedFeatures).toEqual(['*']);
    expect(p.appliedPackageGrants).toEqual({});
    expect(existsSync(join(appRoot, BUILTIN_GRANT_CHANGES_FILE))).toBe(false);
  });

  it('control: a package that is a dependency AGAIN keeps its grants — the record is dropped unapplied', async () => {
    const h = harness(project({ member: ['acme.use'] }));
    const appRoot = appRootWith({ removals: [{ packageId: '@acme/gone', features: ['acme.use'], removedAt: 'now' }] });
    await reconcileBuiltinGrantChanges({ ...h, appRoot, builtinIds: new Set(['@acme/gone']), providers: [] });
    expect(h.writes).toEqual([]);
    expect(h.store.get('p1')!.roles.member.grantedFeatures).toEqual(['acme.use']);
    expect(existsSync(join(appRoot, BUILTIN_GRANT_CHANGES_FILE))).toBe(false);
  });
});

describe('reconcileBuiltinGrantChanges — additions', () => {
  const added = {
    id: '@company/shop',
    version: '2.0.0',
    requires: {
      providesFeatures: ['shop.use', { id: 'shop.admin' }],
      defaultRoleGrants: {
        owner: ['shop.use'],
        admin: ['shop.use', 'shop.admin'],
        member: ['shop.use', 'not.provided', '*'],
        chief: ['shop.admin'],
        wild: ['shop.use'],
      },
    },
  };
  const record = { additions: [{ packageId: '@company/shop', addedAt: 'now' }] };
  // owner p1 (apex, enumerated list) · chief p1 (custom apex) · wild ('*') ·
  // admin p2 · member p30. Only admin + member may receive a builtin grant.
  const base = () =>
    project(
      { owner: ['x'], chief: [], wild: ['*'], admin: ['a'], member: [] },
      { owner: 1, chief: 1, wild: 20, admin: 2, member: 30 },
    );

  it('applies the manifest defaults once: admin receives, apex and `*` untouched, only PROVIDED features, marker = version', async () => {
    const h = harness(base());
    const appRoot = appRootWith(record);
    await reconcileBuiltinGrantChanges({ ...h, appRoot, builtinIds: new Set(['@company/shop']), providers: [added] });
    const p = h.store.get('p1')!;
    expect(p.roles.admin.grantedFeatures).toEqual(['a', 'shop.use', 'shop.admin']);
    expect(p.roles.member.grantedFeatures).toEqual(['shop.use']);
    expect(p.roles.owner.grantedFeatures).toEqual(['x']);
    expect(p.roles.chief.grantedFeatures).toEqual([]);
    expect(p.roles.wild.grantedFeatures).toEqual(['*']);
    expect(p.appliedPackageGrants).toEqual({ '@acme/gone': '1.0.0', '@company/shop': '2.0.0' });
    expect(existsSync(join(appRoot, BUILTIN_GRANT_CHANGES_FILE))).toBe(false);
  });

  it('a second boot is a no-op, and a manual revoke after the apply survives it', async () => {
    const h = harness(base());
    await reconcileBuiltinGrantChanges({ ...h, appRoot: appRootWith(record), builtinIds: new Set(['@company/shop']), providers: [added] });
    // The owner revokes by hand; the operator re-affirms the same version (a second record).
    const after = h.store.get('p1')!;
    h.store.set('p1', { ...after, roles: { ...after.roles, member: { ...after.roles.member, grantedFeatures: [] } } });
    const writesBefore = h.writes.length;
    await reconcileBuiltinGrantChanges({ ...h, appRoot: appRootWith(record), builtinIds: new Set(['@company/shop']), providers: [added] });
    expect(h.writes.length).toBe(writesBefore);
    expect(h.store.get('p1')!.roles.member.grantedFeatures).toEqual([]);
  });

  it('a boot WITHOUT the package keeps the record byte-for-byte; the next boot WITH it applies once', async () => {
    const h = harness(base());
    const appRoot = appRootWith(record);
    const file = join(appRoot, BUILTIN_GRANT_CHANGES_FILE);
    const bytes = readFileSync(file);
    await reconcileBuiltinGrantChanges({ ...h, appRoot, builtinIds: new Set(['@neuralis/agent-core']), providers: [] });
    expect(h.writes).toEqual([]);
    expect(readFileSync(file).equals(bytes)).toBe(true);

    await reconcileBuiltinGrantChanges({ ...h, appRoot, builtinIds: new Set(['@company/shop']), providers: [added] });
    expect(h.writes).toHaveLength(1);
    expect(existsSync(file)).toBe(false);
  });

  it('a mixed file: the removal and the present addition are consumed, the absent addition is written back alone', async () => {
    const h = harness(base());
    const appRoot = appRootWith({
      removals: [{ packageId: '@acme/gone', features: [], removedAt: 'now' }],
      additions: [{ packageId: '@company/shop', addedAt: 'now' }, { packageId: '@company/later', addedAt: 'now' }],
    });
    await reconcileBuiltinGrantChanges({ ...h, appRoot, builtinIds: new Set(['@company/shop']), providers: [added] });
    const left = JSON.parse(readFileSync(join(appRoot, BUILTIN_GRANT_CHANGES_FILE), 'utf8')) as Record<string, unknown>;
    expect(left).toEqual({ removals: [], additions: [{ packageId: '@company/later', addedAt: 'now' }] });
  });

  it('a builtin that grants nothing by default consumes its record without a project write', async () => {
    const h = harness(base());
    const appRoot = appRootWith(record);
    await reconcileBuiltinGrantChanges({
      ...h,
      appRoot,
      builtinIds: new Set(['@company/shop']),
      providers: [{ id: '@company/shop', version: '1.0.0', requires: { providesFeatures: ['shop.use'] } }],
    });
    expect(h.writes).toEqual([]);
    expect(existsSync(join(appRoot, BUILTIN_GRANT_CHANGES_FILE))).toBe(false);
  });
});
