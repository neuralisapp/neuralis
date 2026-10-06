/**
 * packageVisibility — the ONE shared package/surface visibility predicate
 * (CARD1 3A). Covers the full `resolveVisiblePackageSurface` matrix:
 * cross-user/agent source-owner scope, per-surface features, base-access
 * feature + project override, trust (untrusted absolute drop), error status,
 * uninstall, and the fingerprint/generation revocation signals.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionContext } from '@neuralis/package-system/contracts';

const mocks = vi.hoisted(() => ({
  listPackages: vi.fn<() => unknown[]>(() => []),
  getProjectPackageIds: vi.fn(() => new Set<string>()),
  getPackageOwnerScope: vi.fn<() => unknown>(() => undefined),
  getPackageManifestId: vi.fn<() => string | undefined>(() => undefined),
  getStatus: vi.fn<() => unknown>(() => undefined),
  getProjectById: vi.fn<() => Promise<unknown>>(async () => ({ id: 'proj-1' })),
}));

vi.mock('../runtime', () => ({
  getCommunityPackageRegistry: () => ({ listPackages: mocks.listPackages }),
  getCommunityPackageRuntime: vi.fn(),
}));

vi.mock('../PackageRuntimeManager', () => ({
  getPackageRuntimeManager: () => ({
    getProjectPackageIds: mocks.getProjectPackageIds,
    getPackageOwnerScope: mocks.getPackageOwnerScope,
    getPackageManifestId: mocks.getPackageManifestId,
    getLoader: () => ({ getStatus: mocks.getStatus }),
  }),
}));

vi.mock('../../host/bootstrap', () => ({
  BUILTIN_PACKAGE_IDS: new Set(['@neuralis/agent-core']),
}));

vi.mock('../../store/ProjectStore', () => ({
  getProjectById: mocks.getProjectById,
}));

import {
  resolveVisiblePackageSurface,
  isPackageDefinitionVisible,
  computeSurfaceFingerprint,
  getDefinitionGeneration,
  normalizeSurfaceAssetMode,
} from '../packageVisibility';

function makeSession(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    userId: 'user-1',
    projectId: 'proj-1',
    role: 'member',
    grantedFeatures: ['core.chat'],
    ...overrides,
  } as SessionContext;
}

function makePackage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'example-package',
    name: 'example-package',
    version: '1.0.0',
    access: { trust: 'untrusted' },
    app: {
      surfaces: [
        {
          kind: 'widget',
          id: 'example_workspace.widget',
          type: 'example_workspace',
          title: 'Example',
          component: {
            renderer: 'iframe',
            url: './app/surfaces/widget/example_workspace/index.html',
          },
        },
        {
          kind: 'card',
          id: 'example_result.card',
          type: 'example_result',
          render: {
            renderer: 'iframe',
            url: './app/surfaces/card/example_result.card/index.html',
          },
        },
      ],
    },
    ...overrides,
  };
}

describe('resolveVisiblePackageSurface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listPackages.mockReturnValue([makePackage()]);
    mocks.getProjectPackageIds.mockReturnValue(new Set(['example-package']));
    mocks.getPackageOwnerScope.mockReturnValue(undefined);
    mocks.getPackageManifestId.mockReturnValue(undefined);
    mocks.getStatus.mockReturnValue(undefined);
    mocks.getProjectById.mockResolvedValue({ id: 'proj-1' });
  });

  it('resolves a visible widget surface by its EXACT declared type (K1)', async () => {
    const result = await resolveVisiblePackageSurface(
      makeSession(), 'example-package', 'widget', 'example_workspace',
    );
    expect(result).not.toBeNull();
    expect(result?.surfaceId).toBe('example_workspace');
    expect(result?.renderer).toBe('iframe');
    expect(result?.entryUrl).toBe('./app/surfaces/widget/example_workspace/index.html');
    expect(result?.trust).toBe('untrusted');
    expect(result?.fingerprint).toBeTruthy();
    expect(result?.generation).toBeTruthy();
  });

  it('resolves a visible card surface by its EXACT declared id (K1)', async () => {
    const result = await resolveVisiblePackageSurface(
      makeSession(), 'example-package', 'card', 'example_result.card',
    );
    expect(result?.surfaceId).toBe('example_result.card');
  });

  it('BUG-A: carries the RAW manifest id (namespaced→manifest translated) for scanner lookups', async () => {
    const namespaced = 'p.proj-1.project.example-package';
    mocks.listPackages.mockReturnValue([makePackage({ id: namespaced })]);
    mocks.getProjectPackageIds.mockReturnValue(new Set([namespaced]));
    mocks.getPackageManifestId.mockReturnValue('example-package');
    const result = await resolveVisiblePackageSurface(
      makeSession(), namespaced, 'widget', 'example_workspace',
    );
    expect(result?.packageId).toBe(namespaced);
    expect(result?.manifestId).toBe('example-package');
    expect(mocks.getPackageManifestId).toHaveBeenCalledWith('proj-1', namespaced);
  });

  it('BUG-A: manifestId falls back to the registry id when no translation exists (builtins)', async () => {
    mocks.getPackageManifestId.mockReturnValue(undefined);
    const result = await resolveVisiblePackageSurface(
      makeSession(), 'example-package', 'widget', 'example_workspace',
    );
    expect(result?.manifestId).toBe('example-package');
  });

  it('does NOT resolve a card by its type (the identity is the id)', async () => {
    const result = await resolveVisiblePackageSurface(
      makeSession(), 'example-package', 'card', 'example_result',
    );
    expect(result).toBeNull();
  });

  it('returns null for an uninstalled package (project filter)', async () => {
    mocks.getProjectPackageIds.mockReturnValue(new Set<string>());
    const result = await resolveVisiblePackageSurface(
      makeSession(), 'example-package', 'widget', 'example_workspace',
    );
    expect(result).toBeNull();
  });

  it('returns null for an unknown package (registry miss = uninstall revoke)', async () => {
    mocks.listPackages.mockReturnValue([]);
    const result = await resolveVisiblePackageSurface(
      makeSession(), 'example-package', 'widget', 'example_workspace',
    );
    expect(result).toBeNull();
  });

  it('returns null for an error-status package (fail-closed)', async () => {
    mocks.getStatus.mockReturnValue({ status: 'error', error: 'boom' });
    const result = await resolveVisiblePackageSurface(
      makeSession(), 'example-package', 'widget', 'example_workspace',
    );
    expect(result).toBeNull();
  });

  it('still resolves a partial-status package (assets are static)', async () => {
    mocks.getStatus.mockReturnValue({ status: 'partial', reason: 'runtime-unavailable' });
    const result = await resolveVisiblePackageSurface(
      makeSession(), 'example-package', 'widget', 'example_workspace',
    );
    expect(result).not.toBeNull();
  });

  it('a TRUST-demoted package still serves its assets — every partial reason, not just the runtime ones', async () => {
    // `partial` means the CODE runtime is unavailable; the declarative half
    // registered, so the static assets are as valid as any other package's.
    // Enumerated rather than spot-checked: the gate is `status === 'error'`,
    // and a future reason must inherit that answer rather than acquire a new
    // one by accident.
    for (const reason of ['build-missing', 'runtime-unavailable', 'untrusted-node', 'untrusted-mcp']) {
      mocks.getStatus.mockReturnValue({ status: 'partial', reason });
      const result = await resolveVisiblePackageSurface(
        makeSession(), 'example-package', 'widget', 'example_workspace',
      );
      expect(result, `partial/${reason} lost its assets`).not.toBeNull();
    }
  });

  describe('source-owner scope (R2b cross-user / cross-agent)', () => {
    it('hides a user-scoped package from a foreign user', async () => {
      mocks.getPackageOwnerScope.mockReturnValue({ kind: 'user', userId: 'user-2' });
      const result = await resolveVisiblePackageSurface(
        makeSession(), 'example-package', 'widget', 'example_workspace',
      );
      expect(result).toBeNull();
    });

    it('shows a user-scoped package to its owning user', async () => {
      mocks.getPackageOwnerScope.mockReturnValue({ kind: 'user', userId: 'user-1' });
      const result = await resolveVisiblePackageSurface(
        makeSession(), 'example-package', 'widget', 'example_workspace',
      );
      expect(result).not.toBeNull();
    });

    it('hides an agent-scoped package when the session carries no verified agent', async () => {
      mocks.getPackageOwnerScope.mockReturnValue({ kind: 'agent', userId: 'user-1', agentId: 'agent-9' });
      const result = await resolveVisiblePackageSurface(
        makeSession({ agentId: undefined }), 'example-package', 'widget', 'example_workspace',
      );
      expect(result).toBeNull();
    });

    it('shows an agent-scoped package for the verified matching agent', async () => {
      mocks.getPackageOwnerScope.mockReturnValue({ kind: 'agent', agentId: 'agent-9', userId: 'user-1' });
      const result = await resolveVisiblePackageSurface(
        makeSession({ agentId: 'agent-9' }), 'example-package', 'widget', 'example_workspace',
      );
      expect(result).not.toBeNull();
    });
  });

  describe('base-access feature + project override', () => {
    it('hides a package whose manifest accessFeature the caller lacks', async () => {
      mocks.listPackages.mockReturnValue([
        makePackage({ requires: { accessFeature: 'special.access' } }),
      ]);
      const result = await resolveVisiblePackageSurface(
        makeSession(), 'example-package', 'widget', 'example_workspace',
      );
      expect(result).toBeNull();
    });

    it('shows it when the caller holds the accessFeature', async () => {
      mocks.listPackages.mockReturnValue([
        makePackage({ requires: { accessFeature: 'special.access' } }),
      ]);
      const result = await resolveVisiblePackageSurface(
        makeSession({ grantedFeatures: ['special.access'] }),
        'example-package', 'widget', 'example_workspace',
      );
      expect(result).not.toBeNull();
    });

    it('honors the restrict-only project override (attach-never-grant)', async () => {
      mocks.getProjectById.mockResolvedValue({
        id: 'proj-1',
        packageAccessFeature: { 'example-package': 'locked.down' },
      });
      const denied = await resolveVisiblePackageSurface(
        makeSession(), 'example-package', 'widget', 'example_workspace',
      );
      expect(denied).toBeNull();
      const granted = await resolveVisiblePackageSurface(
        makeSession({ grantedFeatures: ['locked.down'] }),
        'example-package', 'widget', 'example_workspace',
      );
      expect(granted).not.toBeNull();
    });

    it('fails closed when the project record cannot be read', async () => {
      mocks.getProjectById.mockRejectedValue(new Error('store down'));
      const result = await resolveVisiblePackageSurface(
        makeSession(), 'example-package', 'widget', 'example_workspace',
      );
      expect(result).toBeNull();
    });
  });

  it('hides a feature-gated surface from an under-privileged caller (S2 parity)', async () => {
    mocks.listPackages.mockReturnValue([
      makePackage({
        app: {
          surfaces: [{
            kind: 'widget',
            id: 'w',
            type: 'gated_widget',
            title: 'G',
            component: { renderer: 'iframe', url: './app/surfaces/widget/gated_widget/index.html' },
            requires: { features: ['platform.config'] },
          }],
        },
      }),
    ]);
    const denied = await resolveVisiblePackageSurface(
      makeSession(), 'example-package', 'widget', 'gated_widget',
    );
    expect(denied).toBeNull();
    const granted = await resolveVisiblePackageSurface(
      makeSession({ grantedFeatures: ['platform.config'] }),
      'example-package', 'widget', 'gated_widget',
    );
    expect(granted).not.toBeNull();
  });

  it('drops an untrusted absolute-url surface (snapshot parity)', async () => {
    mocks.listPackages.mockReturnValue([
      makePackage({
        app: {
          surfaces: [{
            kind: 'widget',
            id: 'w',
            type: 'remote_widget',
            title: 'R',
            component: { renderer: 'iframe', url: 'https://evil.example.com/x.html' },
          }],
        },
      }),
    ]);
    const result = await resolveVisiblePackageSurface(
      makeSession(), 'example-package', 'widget', 'remote_widget',
    );
    expect(result).toBeNull();
  });

  it('keeps a trusted absolute-url surface visible', async () => {
    mocks.listPackages.mockReturnValue([
      makePackage({
        access: { trust: 'trusted' },
        app: {
          surfaces: [{
            kind: 'widget',
            id: 'w',
            type: 'remote_widget',
            title: 'R',
            component: { renderer: 'iframe', url: 'https://embed.example.com/x.html' },
          }],
        },
      }),
    ]);
    const result = await resolveVisiblePackageSurface(
      makeSession(), 'example-package', 'widget', 'remote_widget',
    );
    expect(result).not.toBeNull();
    expect(result?.trust).toBe('trusted');
  });

  it('fingerprint changes when the surface declaration changes (revoke signal)', () => {
    const base = {
      surfaceKind: 'widget' as const,
      surfaceId: 'w',
      renderer: 'iframe',
      url: './app/surfaces/widget/w/index.html',
      bridgeEnabled: false,
      trust: 'untrusted' as const,
      assetMode: 'self-contained' as const,
    };
    const a = computeSurfaceFingerprint(base);
    expect(computeSurfaceFingerprint({ ...base })).toBe(a);
    expect(computeSurfaceFingerprint({ ...base, url: './app/surfaces/widget/w/other.html' })).not.toBe(a);
    expect(computeSurfaceFingerprint({ ...base, trust: 'trusted' as const })).not.toBe(a);
    expect(computeSurfaceFingerprint({ ...base, bridgeEnabled: true })).not.toBe(a);
    // The mode flip is the case that matters most: without it in the digest a
    // `bundle` → `self-contained` edit would leave every live scope un-revoked,
    // and its frame would keep running with a `<base>` no longer authorized.
    expect(computeSurfaceFingerprint({ ...base, assetMode: 'bundle' as const })).not.toBe(a);
  });

  describe('normalizeSurfaceAssetMode — shape is a request, never authority', () => {
    const ENTRY = 'app/surfaces/widget/w/index.html';

    it("honours 'bundle' ONLY on a relative iframe HTML entry", () => {
      expect(normalizeSurfaceAssetMode('bundle', 'iframe', ENTRY)).toBe('bundle');
      expect(normalizeSurfaceAssetMode('bundle', 'iframe', 'app/surfaces/widget/w/sub/e.htm')).toBe('bundle');
    });

    it('downgrades every other input to self-contained', () => {
      for (const [declared, renderer, url] of [
        // absent / explicit default
        [undefined, 'iframe', ENTRY],
        ['self-contained', 'iframe', ENTRY],
        // untrusted manifest input: a near-miss must not opt in
        ['Bundle', 'iframe', ENTRY],
        ['bundle ', 'iframe', ENTRY],
        [true, 'iframe', ENTRY],
        [{ mode: 'bundle' }, 'iframe', ENTRY],
        // wrong renderer — nothing to inject into
        ['bundle', 'direct', ENTRY],
        ['bundle', 'mcp', ENTRY],
        // absolute / missing url — served by someone else, no asset scope
        ['bundle', 'iframe', 'https://embed.example.com/x.html'],
        ['bundle', 'iframe', '//embed.example.com/x.html'],
        ['bundle', 'iframe', '/x.html'],
        ['bundle', 'iframe', undefined],
        // not an HTML document — a `<base>` string would be spliced into JSON
        ['bundle', 'iframe', 'app/surfaces/widget/w/index.svg'],
        ['bundle', 'iframe', 'app/surfaces/widget/w/data.json'],
      ] as ReadonlyArray<[unknown, string, string | undefined]>) {
        expect(normalizeSurfaceAssetMode(declared, renderer, url)).toBe('self-contained');
      }
    });

    it('is what resolveVisiblePackageSurface publishes, not the raw value', async () => {
      mocks.listPackages.mockReturnValue([
        makePackage({
          app: {
            surfaces: [
              {
                kind: 'widget',
                id: 'w',
                type: 'bundle_widget',
                title: 'B',
                // Declared 'bundle' but the entry is NOT an HTML document.
                component: { renderer: 'iframe', url: 'app/surfaces/widget/bundle_widget/index.svg', assetMode: 'bundle' },
              },
            ],
          },
        }),
      ]);
      const result = await resolveVisiblePackageSurface(
        makeSession(), 'example-package', 'widget', 'bundle_widget',
      );
      expect(result?.assetMode).toBe('self-contained');
    });
  });

  it('generation is stable per definition object and changes on re-register', () => {
    const defA = makePackage() as never;
    const defB = makePackage() as never;
    const genA = getDefinitionGeneration(defA);
    expect(getDefinitionGeneration(defA)).toBe(genA);
    expect(getDefinitionGeneration(defB)).not.toBe(genA);
  });

  it('isPackageDefinitionVisible skips the base-access gate without caller features (legacy unscoped)', () => {
    const def = makePackage({ requires: { accessFeature: 'special.access' } }) as never;
    const scope = { host: 'neuralis-workspace' as const, projectId: 'proj-1', userId: 'user-1' };
    mocks.getProjectPackageIds.mockReturnValue(new Set(['example-package']));
    expect(isPackageDefinitionVisible(def, scope, undefined)).toBe(true);
    expect(isPackageDefinitionVisible(def, scope, ['other'])).toBe(false);
  });
});
