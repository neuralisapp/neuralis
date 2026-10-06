/**
 * uiModuleLoader — the fail-closed pins, the guarded registry a runtime module
 * installs into, the host slots' owner floor, the `ui` view parser, and the
 * tier-2 declaration a provider needs BEFORE its import, and the concurrent
 * install (a hung module holds only its own consumers).
 *
 * Each refusal has its accepted twin. The slot rows run the REAL kernel
 * registry, so "an owner collision is checked against the existing registry"
 * is measured on the registry the host actually uses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPackageHostRegistry } from '@neuralis/package-system/client';
import {
  SHARED_MODULE_GLOBAL_KEY,
  UI_MODULE_HOST_API_VERSION,
  publishSharedModule,
  readSharedModule,
} from '@neuralis/package-system/client/shared-modules';
import type { UiModuleDescriptor } from '@neuralis/package-system/contracts';
import {
  armUiModuleHoldRelease,
  ensureUiModules,
  guardedRegistryFor,
  installModule,
  isUiModuleHoldActive,
  isUiModulePending,
  readUiAttachments,
  uiModuleRefusalReason,
  uiModulePinViolation,
} from '../uiModuleLoader';
import { HOST_SLOTS, hostSlotKey, isHostSlotKey, listWorkspaceProviders } from '../hostRegistryInstance';

const Surface = (): null => null;

function descriptor(over: Partial<UiModuleDescriptor> = {}): UiModuleDescriptor {
  return {
    packageId: '@acme/ui',
    hash: 'a'.repeat(64),
    entryUrl: `/api/package-ui/${'a'.repeat(64)}/host.js`,
    sharedImports: ['react'],
    hostApiVersion: UI_MODULE_HOST_API_VERSION,
    reactMajor: 19,
    ...over,
  };
}

describe('uiModulePinViolation (fail-closed)', () => {
  it('loads a module built for this host API and React major (the accepted twin)', () => {
    expect(uiModulePinViolation(descriptor(), '19.3.0')).toBeNull();
  });

  it('refuses another host API version', () => {
    expect(uiModulePinViolation(descriptor({ hostApiVersion: UI_MODULE_HOST_API_VERSION + 1 }), '19.3.0')).toMatch(/host API/);
  });

  it('refuses another React major, and an unreadable host React version', () => {
    expect(uiModulePinViolation(descriptor({ reactMajor: 18 }), '19.3.0')).toMatch(/React/);
    expect(uiModulePinViolation(descriptor(), 'canary')).toMatch(/React/);
  });
});

describe('guardedRegistryFor — what a runtime module may register', () => {
  it('registers its own surface, wrapped in a per-surface error boundary', () => {
    const registry = createPackageHostRegistry();
    guardedRegistryFor('@acme/ui', registry).register({ packageSlug: '@acme/ui', componentImport: '@acme/ui/app/x', Component: Surface });
    const resolved = registry.resolve('@acme/ui/app/x') as { displayName?: string } | null;
    expect(resolved).not.toBeNull();
    expect(resolved).not.toBe(Surface);
    expect(resolved?.displayName).toBe('BoundedSurface(@acme/ui/app/x)');
  });

  it('refuses a registration under another package id', () => {
    const registry = createPackageHostRegistry();
    expect(() =>
      guardedRegistryFor('@acme/ui', registry).register({ packageSlug: '@other/pkg', componentImport: '@other/pkg/app/x', Component: Surface }),
    ).toThrow(/tried to register/);
    expect(registry.list()).toEqual([]);
  });

  it('fills a provider slot only under its OWN key, unwrapped', () => {
    const registry = createPackageHostRegistry();
    const guarded = guardedRegistryFor('@acme/ui', registry);
    guarded.register({ packageSlug: '@acme/ui', componentImport: hostSlotKey(HOST_SLOTS.provider, '@acme/ui'), Component: Surface });
    expect(registry.resolve('workspace.provider:@acme/ui')).toBe(Surface);
    expect(() =>
      guarded.register({ packageSlug: '@acme/ui', componentImport: 'workspace.provider:@other/pkg', Component: Surface }),
    ).toThrow(/another package's provider slot/);
    expect(() => guarded.register({ packageSlug: '@acme/ui', componentImport: HOST_SLOTS.provider, Component: Surface })).toThrow(
      /under its own key/,
    );
  });

  it("cannot unregister another package's registration", () => {
    const registry = createPackageHostRegistry();
    registry.register({ packageSlug: '@other/pkg', componentImport: '@other/pkg/app/x', Component: Surface });
    const guarded = guardedRegistryFor('@acme/ui', registry);
    expect(guarded.unregister('@other/pkg/app/x')).toBe(false);
    expect(guarded.unregisterPackage('@other/pkg')).toBe(0);
    expect(registry.resolve('@other/pkg/app/x')).toBe(Surface);
  });
});

describe('host slots — owner collision on the existing registry', () => {
  it('a single-owner slot refuses a second owner, and accepts the same owner again', () => {
    const registry = createPackageHostRegistry();
    registry.register({ packageSlug: '@acme/a', componentImport: HOST_SLOTS.emptyState, Component: Surface });
    registry.register({ packageSlug: '@acme/a', componentImport: HOST_SLOTS.emptyState, Component: Surface });
    expect(() => registry.register({ packageSlug: '@acme/b', componentImport: HOST_SLOTS.emptyState, Component: Surface })).toThrow(
      /already registered by "@acme\/a"/,
    );
  });

  it('provider fills of two packages coexist, in registration order', () => {
    // The live host registry singleton: provider keys never collide across owners.
    expect(listWorkspaceProviders()).toEqual([]);
    expect(hostSlotKey(HOST_SLOTS.provider, '@acme/a')).not.toBe(hostSlotKey(HOST_SLOTS.provider, '@acme/b'));
    expect(isHostSlotKey('workspace.provider:@acme/a')).toBe(true);
    expect(isHostSlotKey(HOST_SLOTS.agentActivity)).toBe(true);
    expect(isHostSlotKey('@acme/ui/app/x')).toBe(false);
  });
});

describe('readUiAttachments', () => {
  const sheet = { hash: 'c'.repeat(64), url: `/api/package-ui/${'c'.repeat(64)}/workspace.css`, bytes: 3 };

  it('reads the view the runtime route attaches, and nothing from a payload without one', () => {
    const view = readUiAttachments({ revision: 'r', ui: { modules: [descriptor(), { packageId: 1 }], sheet } });
    expect(view?.modules).toEqual([descriptor()]);
    expect(view?.sheet).toEqual(sheet);
    expect(readUiAttachments({ revision: 'r' })).toBeNull();
    expect(readUiAttachments(null)).toBeNull();
  });

  it('drops a descriptor or sheet whose URL is not a lane URL under its own hash (paired with the accepted twin)', () => {
    const other = 'b'.repeat(64);
    const view = readUiAttachments({
      ui: {
        modules: [
          descriptor({ provides: ['@acme/ui/app/store'] }),
          descriptor({ packageId: '@x/abs', entryUrl: 'https://evil.example/host.js' }),
          descriptor({ packageId: '@x/other-hash', entryUrl: `/api/package-ui/${other}/host.js` }),
          descriptor({ packageId: '@x/css', cssUrl: '/api/packages/x/host.css' }),
          descriptor({ packageId: '@x/provides', provides: [1 as unknown as string] }),
          descriptor({ packageId: '@x/dotted-hash', hash: '../../x', entryUrl: '/api/package-ui/../../x/host.js' }),
        ],
        sheet: { ...sheet, url: '//evil.example/workspace.css' },
      },
    });
    expect(view?.modules.map((m) => m.packageId)).toEqual(['@acme/ui']);
    expect(view?.sheet).toBeNull();
  });
});

describe('installModule — a provider declares its tier-2 ids BEFORE its import', () => {
  const STORE_ID = '@acme/ui/app/store';
  const storeNamespace = { useStore: () => null };
  let installs = 0;
  // The module publishes its tier-2 instance while it evaluates — the shape of
  // a real `app/host.tsx` that calls `publishSharedModule` at its top level.
  const providerImporter = async (): Promise<Record<string, unknown>> => {
    publishSharedModule(STORE_ID, storeNamespace);
    return { installAcmeHostComponents: () => { installs += 1; } };
  };

  beforeEach(() => {
    installs = 0;
    const g = globalThis as Record<string, unknown>;
    delete g[SHARED_MODULE_GLOBAL_KEY];
    delete g.__neuralis_shared_module_providers__;
  });

  it('a declared provider publishes and installs', async () => {
    await installModule(descriptor({ provides: [STORE_ID] }), providerImporter);
    expect(readSharedModule(STORE_ID)).toBe(storeNamespace);
    expect(installs).toBe(1);
  });

  it('the same module without its declaration fails at its own publish (the paired control)', async () => {
    await expect(installModule(descriptor(), providerImporter)).rejects.toThrow(/not a shared module/);
    expect(installs).toBe(0);
  });

  it("refuses to declare an id outside the package's own namespace before importing anything", async () => {
    let imported = false;
    await expect(
      installModule(descriptor({ provides: ['@other/pkg/app/store'] }), async () => {
        imported = true;
        return {};
      }),
    ).rejects.toThrow(/not a module of @acme\/ui/);
    expect(imported).toBe(false);
  });
});

describe('a refused module names its reason where its surfaces render', () => {
  const g = globalThis as Record<PropertyKey, unknown>;
  const STATE = Symbol.for('neuralis.workspace.uiModuleLoader');

  beforeEach(() => {
    delete g[STATE];
    g.window = globalThis;
  });

  afterEach(() => {
    delete g[STATE];
    delete g.window;
  });

  it('reads the refusals of the ui view (a malformed row is dropped) and keeps them for the renderer', async () => {
    const view = readUiAttachments({
      ui: { modules: [], sheet: null, refused: [{ packageId: '@acme/old', reason: 'react-major' }, { packageId: 7 }] },
    });
    expect(view?.refused).toEqual([{ packageId: '@acme/old', reason: 'react-major' }]);
    await ensureUiModules(view);
    expect(uiModuleRefusalReason('@acme/old')).toBe('react-major');
    expect(uiModuleRefusalReason('@acme/fine')).toBeNull();
  });

  it('control: a later view without the refusal clears it (a rebuilt module attaches next reload)', async () => {
    await ensureUiModules({ modules: [], sheet: null, refused: [{ packageId: '@acme/old', reason: 'host-api-version' }] });
    expect(uiModuleRefusalReason('@acme/old')).toBe('host-api-version');
    await ensureUiModules({ modules: [], sheet: null, refused: [] });
    expect(uiModuleRefusalReason('@acme/old')).toBeNull();
  });
});

describe('the workspace hold on its UI modules is bounded', () => {
  const g = globalThis as Record<PropertyKey, unknown>;
  const STATE = Symbol.for('neuralis.workspace.uiModuleLoader');

  beforeEach(() => {
    delete g[STATE];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete g[STATE];
    delete g.window;
  });

  it('a module set that never settles holds the workspace only until the release fires (paired: one tick earlier it still holds)', () => {
    armUiModuleHoldRelease(6000);
    expect(isUiModuleHoldActive()).toBe(true);
    vi.advanceTimersByTime(5999);
    expect(isUiModuleHoldActive()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isUiModuleHoldActive()).toBe(false);
  });

  it('a settle before the release ends the hold and clears the timer', async () => {
    g.window = globalThis;
    armUiModuleHoldRelease(6000);
    await ensureUiModules({ modules: [], sheet: null, refused: [] });
    expect(isUiModuleHoldActive()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a cancelled release (the workspace unmounted) never fires', () => {
    const cancel = armUiModuleHoldRelease(6000);
    cancel();
    vi.advanceTimersByTime(60_000);
    expect(isUiModuleHoldActive()).toBe(true);
  });
});

describe('ensureUiModules — modules install concurrently, each after its own providers', () => {
  const g = globalThis as Record<PropertyKey, unknown>;
  const STATE = Symbol.for('neuralis.workspace.uiModuleLoader');
  const PROVIDED = '@x/provider/app/store';

  beforeEach(() => {
    delete g[STATE];
    delete g[SHARED_MODULE_GLOBAL_KEY];
    delete g.__neuralis_shared_module_providers__;
    g.window = globalThis;
  });

  afterEach(() => {
    delete g[STATE];
    delete g.window;
  });

  function lane(packageId: string, over: Partial<UiModuleDescriptor> = {}): UiModuleDescriptor {
    const hash = packageId.replace(/[^a-z]/g, '').padEnd(64, 'a').slice(0, 64).replace(/[^0-9a-f]/g, 'b');
    return descriptor({ packageId, hash, entryUrl: `/api/package-ui/${hash}/host.js`, ...over });
  }

  /** An importer whose per-URL answers the test controls; it records every import it was asked for. */
  function controlledImporter() {
    const requested: string[] = [];
    const installed: string[] = [];
    const gates = new Map<string, () => void>();
    const importer = (url: string): Promise<Record<string, unknown>> => {
      requested.push(url);
      return new Promise((resolveImport) => {
        gates.set(url, () =>
          resolveImport({ installXHostComponents: () => { installed.push(url); } }),
        );
      });
    };
    return { importer, requested, installed, release: (url: string) => gates.get(url)?.() };
  }

  it('a module whose entry exports no install function names that reason where its surfaces render (paired: one that exports it names nothing)', async () => {
    const none = lane('@x/none');
    const fine = lane('@x/fine');
    const importer = async (url: string): Promise<Record<string, unknown>> =>
      url === none.entryUrl ? { HostComponents: () => undefined } : { installFineHostComponents: () => undefined };
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await ensureUiModules({ modules: [none, fine], sheet: null, refused: [] }, importer);
      expect(uiModuleRefusalReason('@x/none')).toBe('no-install-export');
      expect(uiModuleRefusalReason('@x/fine')).toBeNull();
      // A later view (no server refusal for it) keeps the page's own attach verdict.
      await ensureUiModules({ modules: [], sheet: null, refused: [] }, importer);
      expect(uiModuleRefusalReason('@x/none')).toBe('no-install-export');
    } finally {
      quiet.mockRestore();
    }
  });

  it('a hung module does not block an independent one (paired: the hung one stays pending)', async () => {
    const hung = lane('@x/hung');
    const free = lane('@x/free');
    const io = controlledImporter();
    void ensureUiModules({ modules: [hung, free], sheet: null, refused: [] }, io.importer);
    await vi.waitFor(() => expect(io.requested).toContain(free.entryUrl));
    io.release(free.entryUrl);
    await vi.waitFor(() => expect(io.installed).toEqual([free.entryUrl]));
    expect(isUiModulePending('@x/free')).toBe(false);
    expect(isUiModulePending('@x/hung')).toBe(true);
    expect(io.requested).toEqual([hung.entryUrl, free.entryUrl]);
  });

  it('a dependent still waits for its provider (paired: it imports right after the provider settles)', async () => {
    const provider = lane('@x/provider', { provides: [PROVIDED] });
    const consumer = lane('@x/consumer', { sharedImports: ['react', PROVIDED] });
    const io = controlledImporter();
    // The consumer is listed FIRST: only the plan + the provider wait order it.
    const done = ensureUiModules({ modules: [consumer, provider], sheet: null, refused: [] }, io.importer);
    await vi.waitFor(() => expect(io.requested).toEqual([provider.entryUrl]));
    await new Promise((r) => setTimeout(r, 0));
    expect(io.requested).toEqual([provider.entryUrl]);
    expect(isUiModulePending('@x/consumer')).toBe(true);
    io.release(provider.entryUrl);
    await vi.waitFor(() => expect(io.requested).toEqual([provider.entryUrl, consumer.entryUrl]));
    io.release(consumer.entryUrl);
    await done;
    expect(io.installed).toEqual([provider.entryUrl, consumer.entryUrl]);
    expect(isUiModulePending('@x/consumer')).toBe(false);
  });
});
