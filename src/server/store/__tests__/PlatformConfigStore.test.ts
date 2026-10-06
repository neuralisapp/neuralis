/**
 * PlatformConfigStore registry rework (tunable-tanager Inc 1).
 *
 * The store carries ZERO hardcoded schema — every key is registered
 * (`registerSettings`). These tests self-register synthetic settings (the
 * singleton reset yields an EMPTY registry — see the store header), plus the
 * equivalence suite pins the migration: host + agent-core + brain-core
 * declarations reproduce the pre-registry CONFIG_SCHEMA's getAllSettings()
 * output byte-identically (key-sorted, minus the additive declaredBy /
 * valueSource fields).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlatformConfigStore, ConfigPatchError } from '../PlatformConfigStore';
import { HOST_CONFIG_DECLARER, HOST_CONFIG_SETTINGS } from '../../config/hostConfigSettings';
import type { PackageConfigSetting } from '@neuralis/package-system/contracts';

const HERE = dirname(fileURLToPath(import.meta.url));

const NUM: PackageConfigSetting = {
  key: 'testSteps',
  label: 'Test Steps',
  description: 'A test number',
  type: 'number',
  default: 10,
  envFallback: 'TT_TEST_STEPS',
  category: 'runtime',
  min: 1,
  max: 100,
};
const STR: PackageConfigSetting = {
  key: 'testLabel',
  label: 'Test Label',
  type: 'string',
  default: 'hello',
  category: 'debug',
};
const JSON_SETTING: PackageConfigSetting = {
  key: 'testEndpoints',
  label: 'Test Endpoints',
  type: 'json',
  default: [],
  category: 'providers',
};

let dir: string;
let store: PlatformConfigStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ptc-store-'));
  store = new PlatformConfigStore(dir);
  delete process.env.TT_TEST_STEPS;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.TT_TEST_STEPS;
});

describe('registerSettings', () => {
  it('registers and lists keys (json included)', () => {
    store.registerSettings('pkg-a', [NUM, JSON_SETTING]);
    expect(store.listRegisteredKeys().sort()).toEqual(['testEndpoints', 'testSteps']);
    expect(store.getRegisteredSetting('testSteps')?.declaredBy).toBe('pkg-a');
  });

  it('rejects a malformed key', () => {
    expect(() => store.registerSettings('pkg-a', [{ ...NUM, key: 'has.dots' }])).toThrow(/malformed config key/);
    expect(() => store.registerSettings('pkg-a', [{ ...NUM, key: 'Upper' }])).toThrow(/malformed config key/);
  });

  it('rejects min/max on non-number and out-of-bounds defaults', () => {
    expect(() => store.registerSettings('pkg-a', [{ ...STR, min: 1 }])).toThrow(/min\/max only valid/);
    expect(() => store.registerSettings('pkg-a', [{ ...NUM, min: 50, max: 5 }])).toThrow(/min > max/);
    expect(() => store.registerSettings('pkg-a', [{ ...NUM, default: 500 }])).toThrow(/default out of/);
  });

  it('throws on a CROSS-declarer collision; same-declarer re-register replaces', () => {
    store.registerSettings('pkg-a', [NUM]);
    expect(() => store.registerSettings('pkg-b', [NUM])).toThrow(/already declared by "pkg-a"/);
    store.registerSettings('pkg-a', [{ ...NUM, label: 'Renamed' }]);
    expect(store.getRegisteredSetting('testSteps')?.label).toBe('Renamed');
  });
});

describe('get cascade', () => {
  it('default → env fallback → file override precedence', () => {
    store.registerSettings('pkg-a', [NUM]);
    expect(store.get('testSteps')).toBe(10);
    process.env.TT_TEST_STEPS = '25';
    expect(store.get('testSteps')).toBe(25);
    store.patch('testSteps', 42);
    expect(store.get('testSteps')).toBe(42);
  });

  it('throws a loud error on an unregistered key', () => {
    expect(() => store.get('neverDeclared')).toThrow(/not registered/);
  });
});

describe('patch', () => {
  beforeEach(() => store.registerSettings('pkg-a', [NUM, STR, JSON_SETTING]));

  it('unknown key → ConfigPatchError(unknown_key)', () => {
    try {
      store.patch('nope', 1);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigPatchError);
      expect((err as ConfigPatchError).code).toBe('unknown_key');
    }
  });

  it('type mismatch → invalid_value', () => {
    try {
      store.patch('testSteps', 'not-a-number');
      expect.unreachable();
    } catch (err) {
      expect((err as ConfigPatchError).code).toBe('invalid_value');
    }
  });

  it('number bounds enforced (min/max → invalid_value with bound in message)', () => {
    expect(() => store.patch('testSteps', 0)).toThrow(/below the minimum 1/);
    expect(() => store.patch('testSteps', 101)).toThrow(/above the maximum 100/);
    store.patch('testSteps', 100);
    expect(store.get('testSteps')).toBe(100);
  });

  it('editable:false → read_only', () => {
    store.registerSettings('pkg-a', [{ ...STR, key: 'testLocked', editable: false }]);
    try {
      store.patch('testLocked', 'x');
      expect.unreachable();
    } catch (err) {
      expect((err as ConfigPatchError).code).toBe('read_only');
    }
  });

  it('json accepts arrays/objects and stringified JSON, rejects primitives', () => {
    store.patch('testEndpoints', [{ id: 'a' }]);
    expect(store.get('testEndpoints')).toEqual([{ id: 'a' }]);
    store.patch('testEndpoints', '[{"id":"b"}]');
    expect(store.get('testEndpoints')).toEqual([{ id: 'b' }]);
    expect(() => store.patch('testEndpoints', 5)).toThrow(ConfigPatchError);
  });
});

describe('removeOverride — reset falls back through the cascade, never to a blind default', () => {
  beforeEach(() => store.registerSettings('pkg-a', [NUM, STR]));

  it('an env-backed key resets to the ENV value and reads back valueSource env', () => {
    process.env.TT_TEST_STEPS = '25';
    store.patch('testSteps', 42);
    expect(store.get('testSteps')).toBe(42);
    store.removeOverride('testSteps');
    expect(store.get('testSteps')).toBe(25);
    const row = store.getAllSettings().find((s) => s.key === 'testSteps');
    expect(row?.valueSource).toBe('env');
  });

  it('a plain key resets to the declared default (valueSource default)', () => {
    store.patch('testLabel', 'custom');
    store.removeOverride('testLabel');
    expect(store.get('testLabel')).toBe('hello');
    expect(store.getAllSettings().find((s) => s.key === 'testLabel')?.valueSource).toBe('default');
  });

  it('is idempotent — resetting a key with no override succeeds silently', () => {
    expect(() => store.removeOverride('testLabel')).not.toThrow();
    expect(() => store.removeOverride('testLabel')).not.toThrow();
  });

  it('unknown key → ConfigPatchError(unknown_key); read-only → read_only', () => {
    expect(() => store.removeOverride('neverDeclared')).toThrow(ConfigPatchError);
    store.registerSettings('pkg-a', [{ ...STR, key: 'testFrozen', editable: false }]);
    try {
      store.removeOverride('testFrozen');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ConfigPatchError).code).toBe('read_only');
    }
  });

  it('only the reset key leaves the file — sibling overrides survive', () => {
    store.patch('testSteps', 42);
    store.patch('testLabel', 'kept');
    store.removeOverride('testSteps');
    expect(store.get('testLabel')).toBe('kept');
    const onDisk = JSON.parse(readFileSync(join(dir, 'config', 'platform.json'), 'utf-8')) as Record<string, unknown>;
    expect('testSteps' in onDisk).toBe(false);
    expect(onDisk.testLabel).toBe('kept');
  });
});

describe('a write merges into the file ON DISK, never into a stale cache', () => {
  const file = () => join(dir, 'config', 'platform.json');

  it('an out-of-band edit made after the cache filled survives a patch of ANOTHER key', () => {
    store.registerSettings('pkg-a', [NUM, STR]);
    store.patch('testSteps', 42); // fills the cache from this write
    expect(store.get('testLabel')).toBe('hello');
    // A hand edit / setup re-run / checkpoint restore, behind the store's back.
    const onDisk = JSON.parse(readFileSync(file(), 'utf-8')) as Record<string, unknown>;
    writeFileSync(file(), JSON.stringify({ ...onDisk, testLabel: 'by-hand', unknownFutureKey: 7 }));

    store.patch('testSteps', 43);
    const after = JSON.parse(readFileSync(file(), 'utf-8')) as Record<string, unknown>;
    expect(after).toEqual({ testSteps: 43, testLabel: 'by-hand', unknownFutureKey: 7 });
    // The cache is the merged disk state now, so the read agrees with the file.
    expect(store.get('testLabel')).toBe('by-hand');
  });

  it('removeOverride merges into the disk state too', () => {
    store.registerSettings('pkg-a', [NUM, STR]);
    store.patch('testSteps', 42);
    writeFileSync(file(), JSON.stringify({ testSteps: 42, testLabel: 'by-hand' }));
    store.removeOverride('testSteps');
    expect(JSON.parse(readFileSync(file(), 'utf-8'))).toEqual({ testLabel: 'by-hand' });
  });

  it('an unreadable file REFUSES the write instead of replacing every key with one', () => {
    store.registerSettings('pkg-a', [NUM, STR]);
    store.patch('testSteps', 42);
    writeFileSync(file(), '{ not json');
    expect(() => store.patch('testLabel', 'x')).toThrow(/not a JSON object/);
    expect(readFileSync(file(), 'utf-8')).toBe('{ not json');
  });

  it('a write leaves no temp file behind', () => {
    store.registerSettings('pkg-a', [NUM]);
    store.patch('testSteps', 1);
    store.patch('testSteps', 2);
    expect(readdirSync(join(dir, 'config'))).toEqual(['platform.json']);
  });
});

describe('getAllSettings', () => {
  it('excludes json, sorts by category then key, carries declaredBy + valueSource + bounds', () => {
    store.registerSettings('pkg-a', [NUM, STR, JSON_SETTING]);
    process.env.TT_TEST_STEPS = '25';
    const rows = store.getAllSettings();
    expect(rows.map((r) => r.key)).toEqual(['testLabel', 'testSteps']); // debug < runtime
    const steps = rows.find((r) => r.key === 'testSteps')!;
    expect(steps.declaredBy).toBe('pkg-a');
    expect(steps.valueSource).toBe('env');
    expect(steps.min).toBe(1);
    expect(steps.max).toBe(100);
    const label = rows.find((r) => r.key === 'testLabel')!;
    expect(label.valueSource).toBe('default');
    store.patch('testLabel', 'patched');
    expect(store.getAllSettings().find((r) => r.key === 'testLabel')!.valueSource).toBe('override');
  });
});

describe('full first-party declarations register cleanly', () => {
  // The Inc-1 byte-equivalence pin (44-row fixture vs the deleted
  // CONFIG_SCHEMA) is RETIRED — Inc 2 mutated the schema deliberately
  // (brainEmbedConcurrency deleted, min/max rows added), which is exactly the
  // point where a frozen snapshot stops being an invariant and becomes a
  // regen ritual. The durable guards are the manifest-derived bidirectional
  // drift suite (agent-core configDeclarationDrift) + this smoke: the real
  // manifests register with zero collisions and sane rows.
  it('host + agent-core + brain-core manifests register without collision', () => {
    const repoRoot = resolve(HERE, '../../../../..');
    const agentCore = JSON.parse(
      readFileSync(join(repoRoot, 'packages/agent-core/package.json'), 'utf-8'),
    ) as { neuralis: { configSettings: PackageConfigSetting[] } };
    const brainCore = JSON.parse(
      readFileSync(join(repoRoot, 'packages/brain-core/package.json'), 'utf-8'),
    ) as { neuralis: { configSettings: PackageConfigSetting[] } };

    const s = new PlatformConfigStore(mkdtempSync(join(tmpdir(), 'ptc-eq-')));
    s.registerSettings(HOST_CONFIG_DECLARER, HOST_CONFIG_SETTINGS);
    s.registerSettings('@neuralis/agent-core', agentCore.neuralis.configSettings);
    s.registerSettings('@neuralis/brain-core', brainCore.neuralis.configSettings);

    expect(s.listRegisteredKeys().length).toBe(
      HOST_CONFIG_SETTINGS.length +
        agentCore.neuralis.configSettings.length +
        brainCore.neuralis.configSettings.length,
    );
    // Every non-json row resolves an effective value without throwing.
    for (const row of s.getAllSettings()) {
      expect(row.declaredBy.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// ONE store per process (the operator-endpoint route 500)
// ---------------------------------------------------------------------------

describe('singleton is globalThis-anchored, not module-local', () => {
  afterEach(async () => {
    const mod = await import('../PlatformConfigStore');
    mod.resetPlatformConfigStore();
    vi.resetModules();
  });

  it('a SECOND module copy resolves the same store, with the first copy\'s package keys', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ptc-single-'));
    // Bundle A (instrumentation/bootstrap): creates the store and registers a
    // PACKAGE key. `localLLMs` is exactly this shape — declared by agent-core's
    // manifest, registered ONLY in bootstrap.
    const bundleA = await import('../PlatformConfigStore');
    const fromBootstrap = bundleA.getPlatformConfigStore(home);
    fromBootstrap.registerSettings('@neuralis/agent-core', [JSON_SETTING]);

    // Bundle B (a host `/api/**` route handler): a DIFFERENT webpack bundle, so
    // a fresh module instance with its own module scope. `resetModules` is the
    // closest vitest analogue. Before the globalThis anchor this produced a
    // SECOND store whose registry held the host keys alone, so `get()` threw
    // `Config key not registered` for every package-declared key while
    // `maxProjects` resolved fine — the operator-endpoint route 500.
    vi.resetModules();
    const bundleB = await import('../PlatformConfigStore');
    expect(bundleB).not.toBe(bundleA);
    const fromRoute = bundleB.getPlatformConfigStore(home);

    expect(fromRoute).toBe(fromBootstrap);
    expect(fromRoute.listRegisteredKeys()).toContain(JSON_SETTING.key);
    expect(() => fromRoute.get(JSON_SETTING.key)).not.toThrow();
    expect(fromRoute.get(JSON_SETTING.key)).toEqual([]);
    rmSync(home, { recursive: true, force: true });
  });

  it('reset clears the shared slot so the next call rebuilds an empty registry', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ptc-single2-'));
    const mod = await import('../PlatformConfigStore');
    const first = mod.getPlatformConfigStore(home);
    first.registerSettings('@neuralis/agent-core', [JSON_SETTING]);
    mod.resetPlatformConfigStore();
    const second = mod.getPlatformConfigStore(home);
    expect(second).not.toBe(first);
    expect(second.listRegisteredKeys()).toEqual([]);
    rmSync(home, { recursive: true, force: true });
  });
});
