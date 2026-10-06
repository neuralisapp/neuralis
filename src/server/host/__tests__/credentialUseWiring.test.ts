/**
 * Source-drift pins for the credential-use gate WIRING (use-limits v1).
 *
 * The gate BODY is unit-tested in `credentialUseGate.test.ts`; what those
 * tests cannot see is whether bootstrap actually applies it at every
 * resolve choke point. The launch-path spend gate shipped silently inert
 * once for exactly this reason (backgroundQuotaGate.test.ts precedent), so
 * these pins fail the build if a refactor drops a wrapping:
 *
 *   1. the package resolver (`ctx.credentials`) routes through gatedRead;
 *   2. the runtime boot credential resolver, shared by provider config readers;
 *   3. `mcpTokenStore.readScoped` (sidecar env/token reads never traverse
 *      the resolver);
 *   4. the exclusion set derives from BUILTIN packages only (first-party by
 *      source — an untrusted manifest's `category:'llm'` must never exempt).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PackageDefinition, RuntimeHealthReport } from '@neuralis/package-system/contracts';
import { getPackageDiagnosticsPort, type BootstrapPhase } from '../bootstrap';

const SRC = readFileSync(join(__dirname, '../bootstrap.ts'), 'utf-8');

describe('credential-use gate wiring (source-drift pins)', () => {
  it('wraps the package credential resolver', () => {
    expect(SRC).toMatch(/resolveCredential: \(id, scope\) =>\s*\n\s*gatedCredentialRead\(/);
    // The raw resolver exists exactly once and only the wrapper consumes it.
    expect(SRC.match(/rawCredentialResolver\.resolveCredential/g)).toHaveLength(1);
  });

  it('passes the same use-gated resolver into runtime boot for every package', () => {
    const boot = SRC.slice(SRC.indexOf('const instance = await runtimeProvider.boot('));
    expect(boot).toContain('credentialResolver,');
    expect(SRC).not.toContain('setConfigProvider');
  });

  it('wraps mcpTokenStore.readScoped (sidecar secrets count at grant time)', () => {
    const readScoped = SRC.slice(SRC.indexOf('async readScoped('), SRC.indexOf('async writeScoped('));
    expect(readScoped).toContain('gatedCredentialRead(');
  });

  it('derives exclusions from the entire builtin list, including its runtime provider', () => {
    expect(SRC).toContain('deriveLlmExcludedIds(builtinPackages)');
    expect(SRC).toContain('const builtinManifests = await readBuiltinManifests()');
    expect(SRC).toContain('derived LLM exclusion set is EMPTY');
  });

  it('registers raw manifest configuration before importing the runtime provider', () => {
    const manifests = SRC.indexOf('const builtinManifests = await readBuiltinManifests()');
    const registration = SRC.indexOf('platformConfig.registerSettings(');
    const nativeImport = SRC.indexOf('await loadRuntimeProvider(');
    const boot = SRC.indexOf('await runtimeProvider.boot(');
    expect(manifests).toBeGreaterThan(-1);
    expect(registration).toBeGreaterThan(manifests);
    expect(nativeImport).toBeGreaterThan(registration);
    expect(boot).toBeGreaterThan(nativeImport);
    expect(SRC.match(/await loadRuntimeProvider\(/g)).toHaveLength(1);
  });

  it('leaves the build-refused builtins out BEFORE the set-level checks, and names them to the runtime', () => {
    const record = SRC.indexOf('await readBuildRefusals(HOST_ROOT)');
    const admit = SRC.indexOf('const { admitted: builtinPackages, refused: refusedBuiltins, keyCollisions } = admitBuiltins(');
    expect(record).toBeGreaterThan(SRC.indexOf('const builtinManifests = await readBuiltinManifests()'));
    expect(admit).toBeGreaterThan(record);
    // The host's own keys are in the store before admission judges a package against them.
    expect(SRC.indexOf('const platformConfig = getPlatformConfigStore(env.appRoot)')).toBeLessThan(admit);
    expect(SRC).toContain('(key) => platformConfig.getRegisteredSetting(key)?.declaredBy,');
    expect(SRC.indexOf('resolveServiceProviders(builtinPackages)')).toBeGreaterThan(admit);
    expect(SRC.indexOf('collectDeclaredConfigSettings(builtinPackages')).toBeGreaterThan(admit);
    const boot = SRC.slice(SRC.indexOf('const instance = await runtimeProvider.boot('));
    expect(boot).toMatch(/builtinPackages,\s*\n\s*refusedBuiltins,/);
    // A refused builtin is still a dependency: its manifest keeps its features provided.
    expect(SRC).toContain('providers: [...builtinManifests, ...instance.getLoader().listLoaded()]');
  });

  it('gives admin the existing rules, usage and exclusions through the typed host port', () => {
    expect(SRC).toContain('credentialUsePort,');
    expect(SRC).toContain('credentialUseAdmin: { rules: credentialUseRules, usage: credentialUsageStore, excludedIds: credentialUseGate.excludedIds }');
    expect(SRC).not.toContain('__neuralis_credential_use__');
  });
});

describe('package diagnostics host port', () => {
  const globalState = globalThis as Record<string, unknown>;
  const stateKey = '__neuralis_runtime_bootstrap__';
  const previousState = globalState[stateKey];
  afterEach(() => {
    if (previousState === undefined) delete globalState[stateKey];
    else globalState[stateKey] = previousState;
  });

  function fixture(phase: BootstrapPhase) {
    const definitions: PackageDefinition[] = [{
      id: '@fixture/runtime', name: 'Runtime', access: { trust: 'first-party' },
    }];
    const report: RuntimeHealthReport = { status: 'ok', packages: [], refused: [] };
    const listLoaded = vi.fn(() => definitions);
    const health = vi.fn(async () => report);
    const whenReady = vi.fn(async () => {});
    const instance = { getLoader: () => ({ listLoaded }), health, whenReady };
    const state = { phase, instance: null as typeof instance | null, error: null as string | null };
    globalState[stateKey] = state;
    const port = getPackageDiagnosticsPort();
    return { definitions, report, listLoaded, health, whenReady, instance, state, port };
  }

  it('wires the actual producer into the typed bootstrap port', () => {
    expect(SRC).toContain('packageDiagnostics: getPackageDiagnosticsPort(),');
  });

  it('reads the instance assigned after port construction and includes late-loaded definitions', async () => {
    const current = fixture('loading');
    current.state.instance = current.instance;
    current.state.phase = 'ready';
    expect(current.port.listDefinitions()).toBe(current.definitions);
    current.definitions.push({ id: 'late-scoped-package', name: 'Late', access: { trust: 'untrusted' } });
    expect(current.port.listDefinitions()).toBe(current.definitions);
    expect(current.port.listDefinitions()).toContainEqual(expect.objectContaining({ id: 'late-scoped-package' }));
    expect(await current.port.health()).toBe(current.report);
    expect(current.health).toHaveBeenCalledOnce();
    expect(current.whenReady).not.toHaveBeenCalled();
  });

  it.each<BootstrapPhase>(['starting', 'loading', 'error'])('refuses %s even when an instance exists', async (phase) => {
    const current = fixture(phase);
    current.state.instance = current.instance;
    current.state.error = 'PRIVATE_PATH_SENTINEL';
    expect(() => current.port.listDefinitions()).toThrow('Runtime diagnostics not ready');
    await expect(current.port.health()).rejects.toMatchObject({ code: 'runtime_not_ready', status: 503 });
    expect(current.listLoaded).not.toHaveBeenCalled();
    expect(current.health).not.toHaveBeenCalled();
    expect(current.whenReady).not.toHaveBeenCalled();
  });

  it('refuses an absent instance rather than returning an empty catalogue', async () => {
    const current = fixture('ready');
    expect(() => current.port.listDefinitions()).toThrow('Runtime diagnostics not ready');
    await expect(current.port.health()).rejects.toMatchObject({ code: 'runtime_not_ready', status: 503 });
  });

  it('propagates the actual runtime health rejection after readiness', async () => {
    const current = fixture('ready');
    current.state.instance = current.instance;
    const failure = new Error('health hook failed');
    current.health.mockRejectedValue(failure);
    await expect(current.port.health()).rejects.toBe(failure);
    expect(current.port.listDefinitions()).toBe(current.definitions);
  });
});
