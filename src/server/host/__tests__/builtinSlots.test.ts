/**
 * Discovery + trust unit tests for the scope-agnostic builtin-class loading
 * (crystalline-lagoon). Covers verification items #1 (discovery), #2 (trust)
 * and #8 (R2 ordering: exclusion BEFORE trust-overwrite).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { selectBuiltinPackageIds, assignBuiltinTrust, type DepManifest } from '../builtinSlots';
import type { PackageDefinition } from '@neuralis/package-system/contracts';

const FIXTURE_DEPS: Record<string, string> = {
  '@acme/demo': 'file:/somewhere/acme-demo',
  '@acme/refonly': '^1.0.0',
  '@acme/contract-example': '^1.0.0',
  '@neuralis/agent-core': 'workspace:*',
  '@neuralis/package-system': 'workspace:*',
  '@neuralis/example-builtin': 'workspace:*',
  zod: '^3.0.0',
  react: '^19.0.0',
  'not-installed': '^1.0.0',
};

const FIXTURE_MANIFESTS: Record<string, DepManifest | undefined> = {
  '@acme/demo': { neuralis: { id: '@acme/demo' } },
  '@acme/refonly': { neuralis: { id: '@acme/refonly', referenceOnly: true } },
  // The example-builtin shape from a foreign scope: carries a block with
  // a deliberate trusted+embedded combination — must be excludable via
  // referenceOnly, never silently promoted.
  '@acme/contract-example': {
    neuralis: { id: '@acme/contract-example', referenceOnly: true, access: { trust: 'trusted' } },
  },
  '@neuralis/agent-core': { neuralis: { id: '@neuralis/agent-core' } },
  // package-system has NO neuralis block in reality — signal #2 excludes it
  // even without the explicit reference-only set.
  '@neuralis/package-system': {},
  '@neuralis/example-builtin': { neuralis: { id: '@neuralis/example-builtin' } },
  zod: {},
  react: {},
  'not-installed': undefined, // resolution failure
};

const readFixtureManifest = (name: string): DepManifest | undefined => FIXTURE_MANIFESTS[name];

describe('selectBuiltinPackageIds (discovery signal)', () => {
  it('includes any-scope deps that carry a neuralis block', () => {
    const ids = selectBuiltinPackageIds(FIXTURE_DEPS, readFixtureManifest);
    expect(ids).toContain('@acme/demo');
    expect(ids).toContain('@neuralis/agent-core');
  });

  it('excludes plain npm deps without a neuralis block', () => {
    const ids = selectBuiltinPackageIds(FIXTURE_DEPS, readFixtureManifest);
    expect(ids).not.toContain('zod');
    expect(ids).not.toContain('react');
  });

  it('excludes unresolvable deps without throwing', () => {
    const ids = selectBuiltinPackageIds(FIXTURE_DEPS, readFixtureManifest);
    expect(ids).not.toContain('not-installed');
  });

  it('honors the scope-agnostic neuralis.referenceOnly opt-out', () => {
    const ids = selectBuiltinPackageIds(FIXTURE_DEPS, readFixtureManifest);
    expect(ids).not.toContain('@acme/refonly');
  });

  it('R2: a reference-only trusted+embedded package is excluded BEFORE any trust assignment', () => {
    // Discovery must never surface it — bootstrap's first-party overwrite only
    // runs on discovery output, so exclusion here IS the ordering guarantee.
    const ids = selectBuiltinPackageIds(FIXTURE_DEPS, readFixtureManifest);
    expect(ids).not.toContain('@acme/contract-example');
  });

  it('R2: the explicit REFERENCE_ONLY set excludes the platform reference packages even when they carry a block', () => {
    const ids = selectBuiltinPackageIds(FIXTURE_DEPS, readFixtureManifest);
    // example-builtin carries a block in this fixture (as in reality) —
    // the belt-and-suspenders set must still exclude it.
    expect(ids).not.toContain('@neuralis/example-builtin');
    expect(ids).not.toContain('@neuralis/package-system');
  });

  it('returns a sorted, deterministic list', () => {
    const ids = selectBuiltinPackageIds(FIXTURE_DEPS, readFixtureManifest);
    expect(ids).toEqual([...ids].sort());
  });

  it('the load-bearing comment on REFERENCE_ONLY_PACKAGE_IDS is present (R2 guard)', () => {
    const source = readFileSync(new URL('../builtinSlots.ts', import.meta.url), 'utf-8');
    expect(source).toMatch(/LOAD-BEARING \(R2\)/);
  });
});

describe('assignBuiltinTrust (host-assigned first-party)', () => {
  it('overwrites a missing self-declaration to first-party', () => {
    const def = { id: '@acme/demo', name: 'Acme Demo' } as PackageDefinition;
    expect(assignBuiltinTrust(def).access?.trust).toBe('first-party');
  });

  it('overwrites a weaker self-declaration (source-based authorization)', () => {
    const def = {
      id: '@acme/demo',
      name: 'Acme Demo',
      access: { trust: 'untrusted', externalPolicy: 'oauth-only' },
    } as PackageDefinition;
    const assigned = assignBuiltinTrust(def);
    expect(assigned.access?.trust).toBe('first-party');
    // Other access fields survive the overwrite.
    expect(assigned.access?.externalPolicy).toBe('oauth-only');
  });

  it('does not mutate the input definition', () => {
    const def = { id: '@acme/demo', name: 'Acme Demo', access: { trust: 'untrusted' } } as PackageDefinition;
    assignBuiltinTrust(def);
    expect(def.access?.trust).toBe('untrusted');
  });
});
