import { describe, expect, it, vi } from 'vitest';

// Simulate a deploy where a customer-scope builtin (@acme/demo) is loaded —
// the live deps-discovered set, not just the static @neuralis reserved ids.
vi.mock('../../host/builtinSlots', () => ({
  BUILTIN_PACKAGE_IDS: new Set(['@neuralis/agent-core', '@acme/demo']),
}));

import {
  assertProjectPackageIdAllowed,
  sanitizeProjectPackageDefinition,
  toResolvedRecord,
  type ProjectPackageRecord,
} from '../packageRecords';

describe('project package record security', () => {
  it('rejects reserved first-party package ids for project packages', () => {
    expect(() => assertProjectPackageIdAllowed('@neuralis/agent-core')).toThrow(/reserved/);
    expect(() => assertProjectPackageIdAllowed('@neuralis/custom')).toThrow(/reserved/);
  });

  it('keeps a retired platform id reserved although no live set names it', () => {
    expect(() => assertProjectPackageIdAllowed('@neuralis/orchestrator')).toThrow(/reserved/);
    expect(() => assertProjectPackageIdAllowed('@neuralis/terminal')).toThrow(/reserved/);
  });

  it('rejects a project package shadowing a loaded customer-scope builtin', () => {
    expect(() => assertProjectPackageIdAllowed('@acme/demo')).toThrow(/reserved/);
  });

  it('allows an unrelated customer-scope project package', () => {
    expect(() => assertProjectPackageIdAllowed('@acme/other')).not.toThrow();
  });

  it('forces project package definitions to untrusted by default', () => {
    const definition = sanitizeProjectPackageDefinition({
      id: 'user-package',
      name: 'User Package',
      access: { trust: 'first-party' },
    } as any);

    expect(definition.access?.trust).toBe('untrusted');
  });

  it('preserves only explicit trusted overrides when resolving records', () => {
    const record: ProjectPackageRecord = {
      slug: 'user-package',
      packageId: 'user-package',
      packageRoot: '/tmp/project/_packages/user-package',
      discoveredAt: 1,
      trust: 'trusted',
      definition: {
        id: 'user-package',
        name: 'User Package',
        access: { trust: 'first-party' },
      } as any,
    };

    expect(
      toResolvedRecord(record, 'test-project', { kind: 'project' }).definition.access?.trust,
    ).toBe('trusted');
  });
});

describe('toResolvedRecord — scope-namespacing (tenant-namespaced-packages)', () => {
  const base = (id: string): ProjectPackageRecord => ({
    slug: id.replace(/[@/]/g, '-'),
    packageId: id,
    packageRoot: `/tmp/p/_packages/${id}`,
    discoveredAt: 1,
    trust: 'untrusted',
    definition: { id, name: id } as any,
  });

  it('namespaces the loader id + definition.id per owning scope, preserving manifestId', () => {
    const r = toResolvedRecord(base('my-pkg'), 'proj-1', { kind: 'agent', userId: 'u1', agentId: 'a1' });
    expect(r.manifestId).toBe('my-pkg');
    expect(r.packageId).not.toBe('my-pkg');
    expect(r.packageId).toBe(r.definition.id);       // loader id == definition.id
    expect(r.packageId.startsWith('p.')).toBe(true);
    expect(r.ownerScope).toEqual({ kind: 'agent', userId: 'u1', agentId: 'a1' });
  });

  it('two agent scopes of the SAME manifest id get DISTINCT namespaced ids (coexist)', () => {
    const a = toResolvedRecord(base('foo'), 'p', { kind: 'agent', userId: 'u', agentId: 'A' });
    const b = toResolvedRecord(base('foo'), 'p', { kind: 'agent', userId: 'u', agentId: 'B' });
    expect(a.manifestId).toBe(b.manifestId);         // same manifest id
    expect(a.packageId).not.toBe(b.packageId);       // distinct loader slots
  });

  it('two projects with the SAME manifest id get DISTINCT namespaced ids (no substitution)', () => {
    const a = toResolvedRecord(base('foo'), 'p1', { kind: 'project' });
    const b = toResolvedRecord(base('foo'), 'p2', { kind: 'project' });
    expect(a.packageId).not.toBe(b.packageId);
  });
});
