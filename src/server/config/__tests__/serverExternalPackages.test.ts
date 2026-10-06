import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeNeuralisExternalPackages,
  isMachineLocalDepSpec,
  makeHostDepManifestReader,
} from '../serverExternalPackages';
import { machineLocalHostDependencies } from '../../../testing/hostDepManifests';

const FIXTURES: Record<string, unknown> = {
  '@neuralis/agent-core': { name: '@neuralis/agent-core', neuralis: { id: '@neuralis/agent-core' } },
  // referenceOnly is INCLUDED (D-D): package-system must stay external.
  '@neuralis/package-system': { name: '@neuralis/package-system', neuralis: { referenceOnly: true } },
  '@acme/demo': { name: '@acme/demo', neuralis: {} },
  react: { name: 'react' },
  express: { name: 'express' },
  'broken-null-neuralis': { name: 'broken-null-neuralis', neuralis: null },
};

const readFixture = (name: string): unknown => {
  if (!(name in FIXTURES)) throw new Error(`ENOENT: ${name}/package.json`);
  return FIXTURES[name];
};

describe('computeNeuralisExternalPackages (computed serverExternalPackages, D-D)', () => {
  it('includes every neuralis-block dep — any scope, referenceOnly INCLUDED — and sorts', () => {
    expect(
      computeNeuralisExternalPackages(
        ['react', '@neuralis/package-system', '@acme/demo', 'express', '@neuralis/agent-core'],
        readFixture,
      ),
    ).toEqual(['@acme/demo', '@neuralis/agent-core', '@neuralis/package-system']);
  });

  it('excludes deps without a neuralis object block (absent or null)', () => {
    expect(
      computeNeuralisExternalPackages(['react', 'broken-null-neuralis'], readFixture),
    ).toEqual([]);
  });

  it('fails loud on an unreadable manifest', () => {
    expect(() => computeNeuralisExternalPackages(['ghost-package'], readFixture)).toThrow(
      /cannot read package\.json of declared dependency "ghost-package"/,
    );
  });

  it('fails loud on a non-object manifest', () => {
    expect(() =>
      computeNeuralisExternalPackages(['weird'], () => 'not-an-object'),
    ).toThrow(/is not an object/);
  });

  it('derives the live host list: the 5 tracked builtins plus any machine-local dev deps', () => {
    // The tracked pin stays exact (the 5 shipped builtins); local-source
    // (file:/link:) deps are a legitimate operator state — `pnpm neuralis:pkg
    // add --path` writes an uncommitted dep line — and they DO belong on the
    // externals list (they load in-process like every builtin), so the
    // expectation is 5-tracked ∪ local, never a hardcoded 5 that goes red with
    // dogfood state. See src/testing/hostDepManifests.ts.
    const hostRoot = join(__dirname, '..', '..', '..', '..');
    const dependencies = (JSON.parse(readFileSync(join(hostRoot, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
    }).dependencies ?? {};
    const computed = computeNeuralisExternalPackages(
      Object.keys(dependencies),
      makeHostDepManifestReader(hostRoot, { readFileSync }, join),
    );
    const machineLocalWithBlock = machineLocalHostDependencies()
      .filter(({ name }) => {
        const manifest = JSON.parse(
          readFileSync(join(hostRoot, 'node_modules', name, 'package.json'), 'utf-8'),
        ) as { neuralis?: unknown };
        return manifest.neuralis !== undefined && manifest.neuralis !== null;
      })
      .map(({ name }) => name);
    expect(computed).toEqual(
      [
        '@neuralis/admin',
        '@neuralis/agent-core',
        '@neuralis/brain-core',
        '@neuralis/machine-core',
        '@neuralis/package-system',
        ...machineLocalWithBlock,
      ].sort(),
    );
  });

  it('classifies machine-local dep specs (file:/link:) and nothing else', () => {
    expect(isMachineLocalDepSpec('file:/home/op/packages/ecom')).toBe(true);
    expect(isMachineLocalDepSpec('file:/tmp/pkg-1.0.0.tgz')).toBe(true);
    expect(isMachineLocalDepSpec('link:../somewhere')).toBe(true);
    expect(isMachineLocalDepSpec('1.0.0')).toBe(false);
    expect(isMachineLocalDepSpec('^2.0.0')).toBe(false);
    expect(isMachineLocalDepSpec('workspace:*')).toBe(false);
    expect(isMachineLocalDepSpec('npm:foo@1.0.0')).toBe(false);
  });
});
