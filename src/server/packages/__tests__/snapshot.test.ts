/**
 * Snapshot project scoping tests.
 *
 * Tests the core filtering logic: builtins + project packages only.
 * Uses vi.mock to stub the runtime/bootstrap dependencies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the dependencies BEFORE importing snapshot
vi.mock('../runtime', () => ({
  getCommunityPackageRegistry: vi.fn(),
  getCommunityPackageRuntime: vi.fn(),
}));

vi.mock('../PackageRuntimeManager', () => ({
  getPackageRuntimeManager: vi.fn(),
}));

vi.mock('../../host/bootstrap', () => ({
  BUILTIN_PACKAGE_IDS: new Set(['@neuralis/agent-core', '@neuralis/brain-core', '@neuralis/admin']),
}));

vi.mock('@neuralis/package-system', async (importOriginal) => ({
  // Keep the REAL meetsRequires — the S2 feature filter is part of what
  // these tests assert; only the snapshot service is stubbed.
  ...(await importOriginal<typeof import('@neuralis/package-system')>()),
  PackageSnapshotService: vi.fn().mockImplementation(function () { return ({
    getFullSnapshot: () => ({
      revision: 'test-rev',
      packages: [],
      tools: [],
      surfaces: [],
      commands: [],
      files: [],
      resources: [],
      connectors: [],
    }),
    getRevision: () => 'test-rev',
    isUpToDate: () => false,
  }); }),
}));

import { getPackageSnapshot, getWidgetSnapshot, getCommandSnapshot, getDockSnapshot, getCardSnapshot } from '../snapshot';
import { getCommunityPackageRegistry } from '../runtime';
import { getPackageRuntimeManager } from '../PackageRuntimeManager';
import { PackageSnapshotService } from '@neuralis/package-system';

function makeDef(id: string, opts?: { hosts?: string[] }) {
  return {
    id,
    name: id,
    version: '1.0.0',
    meta: { hosts: opts?.hosts },
    tools: [{ name: `${id}-tool`, inputSchema: { type: 'object', properties: {} } }],
    files: [],
    surfaces: [{ kind: 'widget' as const, id: `${id}-widget`, packageId: id }],
    commands: [{ name: `${id}-cmd`, packageId: id }],
    resources: [],
    connectors: [],
    source: { kind: 'builtin' },
  };
}

describe('project-scoped snapshots', () => {
  const builtinDef = makeDef('@neuralis/agent-core');
  const projectADef = makeDef('pkg-project-a');
  const projectBDef = makeDef('pkg-project-b');

  beforeEach(() => {
    // Reset globalThis snapshot service
    delete (globalThis as any).__neuralis_snapshot_service__;
    vi.mocked(PackageSnapshotService).mockImplementation(function () { return ({
      getFullSnapshot: () => ({
        revision: 'test-rev',
        packages: [],
        tools: [],
        surfaces: [builtinDef, projectADef, projectBDef].flatMap((def) => def.surfaces),
        commands: [builtinDef, projectADef, projectBDef].flatMap((def) => def.commands),
        files: [],
        resources: [],
        connectors: [],
      }),
      getRevision: () => 'test-rev',
      isUpToDate: () => false,
    }); } as any);

    (getCommunityPackageRegistry as ReturnType<typeof vi.fn>).mockReturnValue({
      listPackages: () => [builtinDef, projectADef, projectBDef],
    });

    (getPackageRuntimeManager as ReturnType<typeof vi.fn>).mockReturnValue({
      getProjectPackageIds: (projectId: string) => {
        if (projectId === 'proj-a') return new Set(['pkg-project-a']);
        if (projectId === 'proj-b') return new Set(['pkg-project-b']);
        return new Set();
      },
      // R2b — no owning source scope ⇒ implicit project scope ⇒ never hidden.
      getPackageOwnerScope: () => undefined,
      // Loader accessor — snapshot enriches package status from here.
      getLoader: () => ({
        getStatus: () => undefined,
      }),
    });
  });

  it('returns all packages when no projectId (admin view)', () => {
    const snapshot = getPackageSnapshot({ host: 'neuralis-workspace' });
    const ids = snapshot.tools.map(t => t.packageId);
    expect(ids).toContain('@neuralis/agent-core');
    expect(ids).toContain('pkg-project-a');
    expect(ids).toContain('pkg-project-b');
  });

  it('returns only builtins + project-A packages for project-A', () => {
    const snapshot = getPackageSnapshot({ host: 'neuralis-workspace', projectId: 'proj-a' });
    const ids = snapshot.tools.map(t => t.packageId);
    expect(ids).toContain('@neuralis/agent-core');
    expect(ids).toContain('pkg-project-a');
    expect(ids).not.toContain('pkg-project-b');
  });

  it('returns only builtins + project-B packages for project-B', () => {
    const snapshot = getPackageSnapshot({ host: 'neuralis-workspace', projectId: 'proj-b' });
    const ids = snapshot.tools.map(t => t.packageId);
    expect(ids).toContain('@neuralis/agent-core');
    expect(ids).toContain('pkg-project-b');
    expect(ids).not.toContain('pkg-project-a');
  });

  it('cross-project leakage: A snapshot does NOT contain B widget', () => {
    const snapshot = getPackageSnapshot({ host: 'neuralis-workspace', projectId: 'proj-a' });
    const widgetPkgs = snapshot.surfaces.map(w => w.packageId);
    expect(widgetPkgs).not.toContain('pkg-project-b');
  });

  it('cross-project leakage: B snapshot does NOT contain A command', () => {
    const snapshot = getPackageSnapshot({ host: 'neuralis-workspace', projectId: 'proj-b' });
    const cmdPkgs = snapshot.commands.map(c => c.packageId);
    expect(cmdPkgs).not.toContain('pkg-project-a');
  });

  it('widget snapshot respects project scope', () => {
    const widgets = getWidgetSnapshot({ host: 'neuralis-workspace', projectId: 'proj-a' });
    const pkgs = widgets.map(w => w.packageId);
    expect(pkgs).not.toContain('pkg-project-b');
  });

  it('command snapshot respects project scope', () => {
    const commands = getCommandSnapshot({ host: 'neuralis-workspace', projectId: 'proj-a' });
    const pkgs = commands.map(c => c.packageId);
    expect(pkgs).not.toContain('pkg-project-b');
  });

  it('dock snapshot respects project scope', () => {
    const dock = getDockSnapshot({ host: 'neuralis-workspace', projectId: 'proj-a' });
    // No dock items in our mock, but it should not crash
    expect(Array.isArray(dock)).toBe(true);
  });
});

// The runtime route used to register an agent's MCP servers as synthetic
// `external:<host>` packages for the length of the request. That package was
// never in the scoped snapshot it was registered for — deleting the overlay
// leaves the caller's `packages[]` exactly as it was.
describe('a synthetic external MCP package never reaches a project-scoped snapshot', () => {
  it('registered in the registry, it is filtered out of the very projects snapshot it was registered for', async () => {
    const { ExternalPackageBinder } = await vi.importActual<typeof import('@neuralis/package-system')>('@neuralis/package-system');
    const external = new ExternalPackageBinder().createSyntheticPackage({
      url: 'https://api.githubcopilot.com/mcp/',
      name: 'github',
      auth: 'none',
    });
    const builtin = makeDef('@neuralis/agent-core');
    const info = (def: { id: string; name: string; version?: string }) => ({ id: def.id, name: def.name, version: def.version, status: 'active' });
    vi.mocked(PackageSnapshotService).mockImplementation(function () { return ({
      getFullSnapshot: () => ({
        revision: 'test-rev',
        packages: [info(builtin), info(external)],
        tools: [], surfaces: [], commands: [], files: [], resources: [], connectors: [],
      }),
      getRevision: () => 'test-rev',
      isUpToDate: () => false,
    }); } as any);
    delete (globalThis as any).__neuralis_snapshot_service__;

    const project = () => getPackageSnapshot(
      { host: 'neuralis-workspace', projectId: 'proj-a', userId: 'user-1' },
      ['core.agents'],
    ).packages.map((pkg) => pkg.id);
    (getCommunityPackageRegistry as ReturnType<typeof vi.fn>).mockReturnValue({ listPackages: () => [builtin] });
    const without = project();
    (getCommunityPackageRegistry as ReturnType<typeof vi.fn>).mockReturnValue({ listPackages: () => [builtin, external] });
    const withOverlay = project();

    expect(external.id).toMatch(/^external:/);
    expect(withOverlay).toEqual(without);
    expect(withOverlay).toEqual(['@neuralis/agent-core']);
  });
});

describe('base-access feature gate on the CLIENT snapshot (F1 — manifest-id override translation)', () => {
  // The registry/loader id is scope-namespaced; the admin override map is keyed by
  // the RAW manifest id. The snapshot base-access gate MUST translate namespaced→
  // manifest or it stops honoring the override (split-brain vs the stream path).
  const NS_ID = 'p.proj-a.project.securepkg'; // scope-namespaced loader id
  const MANIFEST_ID = 'securepkg';            // the admin key
  const secureDef = makeDef(NS_ID);

  beforeEach(() => {
    delete (globalThis as any).__neuralis_snapshot_service__;
    vi.mocked(PackageSnapshotService).mockImplementation(function () { return ({
      getFullSnapshot: () => ({
        revision: 'r', packages: [], tools: [],
        surfaces: secureDef.surfaces, commands: secureDef.commands,
        files: [], resources: [], connectors: [],
      }),
      getRevision: () => 'r', isUpToDate: () => false,
    }); } as any);
    (getCommunityPackageRegistry as ReturnType<typeof vi.fn>).mockReturnValue({
      listPackages: () => [secureDef],
    });
    (getPackageRuntimeManager as ReturnType<typeof vi.fn>).mockReturnValue({
      getProjectPackageIds: () => new Set([NS_ID]),
      getPackageOwnerScope: () => undefined, // project scope ⇒ not scope-hidden
      // The translation the F1 fix relies on: namespaced loader id → manifest id.
      getPackageManifestId: (_p: string, id: string) => (id === NS_ID ? MANIFEST_ID : undefined),
      getLoader: () => ({ getStatus: () => undefined }),
    });
  });

  it('HIDES a package whose MANIFEST-id-keyed override the caller lacks', () => {
    const snap = getPackageSnapshot(
      { host: 'neuralis-workspace', projectId: 'proj-a', packageAccessFeature: { [MANIFEST_ID]: 'secure.access' } },
      [], // caller holds no features
    );
    expect(snap.surfaces.map((s) => s.packageId)).not.toContain(NS_ID);
    expect(snap.commands.map((c) => c.packageId)).not.toContain(NS_ID);
  });

  it('SHOWS the same package when the caller holds the override feature', () => {
    const snap = getPackageSnapshot(
      { host: 'neuralis-workspace', projectId: 'proj-a', packageAccessFeature: { [MANIFEST_ID]: 'secure.access' } },
      ['secure.access'],
    );
    expect(snap.surfaces.map((s) => s.packageId)).toContain(NS_ID);
  });
});

describe('widget URL normalization', () => {
  type WidgetSetup = {
    packageId: string;
    trust: 'first-party' | 'trusted' | 'untrusted';
    renderer?: 'direct' | 'iframe';
    url?: string;
  };

  function setupWidget(setup: WidgetSetup) {
    delete (globalThis as any).__neuralis_snapshot_service__;

    const widget = {
      kind: 'widget' as const,
      id: `${setup.packageId}-widget`,
      type: `${setup.packageId}-type`,
      title: setup.packageId,
      packageId: setup.packageId,
      component: { renderer: setup.renderer ?? 'iframe', url: setup.url },
    };

    const def = {
      id: setup.packageId,
      name: setup.packageId,
      version: '1.0.0',
      access: { trust: setup.trust },
      meta: {},
      tools: [],
      files: [],
      surfaces: [widget],
      commands: [],
      resources: [],
      connectors: [],
      source: { kind: 'local-dir' },
    };

    (getCommunityPackageRegistry as ReturnType<typeof vi.fn>).mockReturnValue({
      listPackages: () => [def],
    });

    // Re-mock PackageSnapshotService so getFullSnapshot returns this widget in its UI list.
    // (snapshot.ts filters base.surfaces by visiblePackageIds — both data sources need the entry.)
    vi.mocked(PackageSnapshotService).mockImplementation(function () { return ({
      getFullSnapshot: () => ({
        revision: 'test-rev',
        packages: [],
        tools: [],
        surfaces: [widget],
        commands: [],
        files: [],
        resources: [],
        connectors: [],
      }),
      getRevision: () => 'test-rev',
      isUpToDate: () => false,
    }); } as any);
  }

  beforeEach(() => {
    (getPackageRuntimeManager as ReturnType<typeof vi.fn>).mockReturnValue({
      getProjectPackageIds: () => new Set(),
      getPackageOwnerScope: () => undefined,
      getLoader: () => ({ getStatus: () => undefined }),
    });
  });

  it('rewrites a relative widget URL to /api/packages/{slug}/app/{url}', () => {
    setupWidget({ packageId: 'relative-pkg', url: 'widget.html', trust: 'untrusted' });
    const widgets = getWidgetSnapshot({ host: 'neuralis-workspace' });
    expect(widgets).toHaveLength(1);
    expect(widgets[0]!.component.url).toBe('/api/packages/relative-pkg/app/widget.html');
  });

  it('strips leading "./" from relative URLs', () => {
    setupWidget({ packageId: 'relative-pkg', url: './nested/page.html', trust: 'untrusted' });
    const widgets = getWidgetSnapshot({ host: 'neuralis-workspace' });
    expect(widgets[0]!.component.url).toBe('/api/packages/relative-pkg/app/nested/page.html');
  });

  it('drops widgets with absolute URLs from untrusted packages', () => {
    setupWidget({ packageId: 'untrusted-abs-pkg', url: 'https://example.com/x.html', trust: 'untrusted' });
    const widgets = getWidgetSnapshot({ host: 'neuralis-workspace' });
    expect(widgets).toHaveLength(0);
  });

  it('keeps absolute URLs for trusted packages', () => {
    setupWidget({ packageId: 'trusted-abs-pkg', url: 'https://example.com/x.html', trust: 'trusted' });
    const widgets = getWidgetSnapshot({ host: 'neuralis-workspace' });
    expect(widgets).toHaveLength(1);
    expect(widgets[0]!.component.url).toBe('https://example.com/x.html');
  });

  it('passes widgets without a URL through unchanged', () => {
    setupWidget({ packageId: 'no-url-pkg', renderer: 'direct', trust: 'first-party' });
    const widgets = getWidgetSnapshot({ host: 'neuralis-workspace' });
    expect(widgets).toHaveLength(1);
    expect(widgets[0]!.component.url).toBeUndefined();
  });

  it('does NOT bake projectId into the URL — the client appends it on mount to avoid SSR/CSR drift', () => {
    setupWidget({ packageId: 'relative-pkg', url: 'widget.html', trust: 'untrusted' });
    (getPackageRuntimeManager as ReturnType<typeof vi.fn>).mockReturnValue({
      getProjectPackageIds: () => new Set(['relative-pkg']),
      getPackageOwnerScope: () => undefined,
      getLoader: () => ({ getStatus: () => undefined }),
    });
    const widgets = getWidgetSnapshot({ host: 'neuralis-workspace', projectId: 'main' });
    expect(widgets).toHaveLength(1);
    expect(widgets[0]!.component.url).toBe('/api/packages/relative-pkg/app/widget.html');
  });
});

describe('card URL normalization (CARD1 3C — widget parity)', () => {
  type CardSetup = {
    packageId: string;
    trust: 'first-party' | 'trusted' | 'untrusted';
    renderer?: 'direct' | 'iframe';
    url?: string;
  };

  function setupCard(setup: CardSetup) {
    delete (globalThis as any).__neuralis_snapshot_service__;

    const card = {
      kind: 'card' as const,
      id: `${setup.packageId}.card`,
      type: `${setup.packageId}-type`,
      title: setup.packageId,
      packageId: setup.packageId,
      render: { renderer: setup.renderer ?? 'iframe', url: setup.url },
    };

    const def = {
      id: setup.packageId,
      name: setup.packageId,
      version: '1.0.0',
      access: { trust: setup.trust },
      meta: {},
      tools: [],
      files: [],
      surfaces: [card],
      commands: [],
      resources: [],
      connectors: [],
      source: { kind: 'local-dir' },
    };

    (getCommunityPackageRegistry as ReturnType<typeof vi.fn>).mockReturnValue({
      listPackages: () => [def],
    });

    vi.mocked(PackageSnapshotService).mockImplementation(function () { return ({
      getFullSnapshot: () => ({
        revision: 'test-rev',
        packages: [],
        tools: [],
        surfaces: [card],
        commands: [],
        files: [],
        resources: [],
        connectors: [],
      }),
      getRevision: () => 'test-rev',
      isUpToDate: () => false,
    }); } as any);
  }

  beforeEach(() => {
    (getPackageRuntimeManager as ReturnType<typeof vi.fn>).mockReturnValue({
      getProjectPackageIds: () => new Set(),
      getPackageOwnerScope: () => undefined,
      getLoader: () => ({ getStatus: () => undefined }),
    });
  });

  it('rewrites a relative card URL to the host-internal logical descriptor', () => {
    setupCard({
      packageId: 'relative-card-pkg',
      url: './app/surfaces/card/relative-card-pkg.card/index.html',
      trust: 'untrusted',
    });
    const cards = getCardSnapshot({ host: 'neuralis-workspace' });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.render!.url).toBe(
      '/api/packages/relative-card-pkg/app/app/surfaces/card/relative-card-pkg.card/index.html',
    );
  });

  it('drops an untrusted absolute card URL fail-closed (the §5 floor)', () => {
    // Before 3C the card branch bypassed normalization entirely, so this
    // untrusted absolute survived into the client snapshot.
    setupCard({ packageId: 'untrusted-abs-card', url: 'https://evil.example/x.html', trust: 'untrusted' });
    expect(getCardSnapshot({ host: 'neuralis-workspace' })).toHaveLength(0);
  });

  it('keeps an absolute card URL for a trusted package', () => {
    setupCard({ packageId: 'trusted-abs-card', url: 'https://example.com/x.html', trust: 'trusted' });
    const cards = getCardSnapshot({ host: 'neuralis-workspace' });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.render!.url).toBe('https://example.com/x.html');
  });

  it('passes a `direct` card (no url) through unchanged', () => {
    setupCard({ packageId: 'direct-card-pkg', renderer: 'direct', trust: 'first-party' });
    const cards = getCardSnapshot({ host: 'neuralis-workspace' });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.render!.url).toBeUndefined();
  });

  it('the descriptor carries NO projectId — it is resolution data, not a navigable URL', () => {
    setupCard({
      packageId: 'relative-card-pkg',
      url: 'app/surfaces/card/relative-card-pkg.card/index.html',
      trust: 'untrusted',
    });
    (getPackageRuntimeManager as ReturnType<typeof vi.fn>).mockReturnValue({
      getProjectPackageIds: () => new Set(['relative-card-pkg']),
      getPackageOwnerScope: () => undefined,
      getLoader: () => ({ getStatus: () => undefined }),
    });
    const cards = getCardSnapshot({ host: 'neuralis-workspace', projectId: 'main' });
    expect(cards[0]!.render!.url).not.toContain('projectId');
    expect(cards[0]!.render!.url).not.toContain('?');
  });
});

describe('feature-filtered snapshots', () => {
  beforeEach(() => {
    delete (globalThis as any).__neuralis_snapshot_service__;
    const def = {
      id: 'feature-pkg',
      name: 'feature-pkg',
      version: '1.0.0',
      access: { trust: 'trusted' },
      meta: {},
      tools: [
        { name: 'secure_tool', inputSchema: { type: 'object' }, requires: { features: ['feature.secure'] } },
        { name: 'open_tool', inputSchema: { type: 'object' } },
      ],
      files: [],
      surfaces: [
        {
          kind: 'widget' as const,
          id: 'secure-widget',
          type: 'secure.widget',
          title: 'Secure',
          packageId: 'feature-pkg',
          component: { renderer: 'iframe' as const, url: 'widget.html' },
          requires: { features: ['feature.secure'] },
        },
        {
          kind: 'dock' as const,
          id: 'secure-dock',
          label: 'Secure',
          packageId: 'feature-pkg',
          action: { type: 'open-widget' as const, widget: 'secure.widget' },
        },
      ],
      commands: [
        {
          id: 'secure-command',
          name: 'Secure Command',
          kind: 'prompt' as const,
          packageId: 'feature-pkg',
          requires: { features: ['feature.secure'] },
        },
      ],
      resources: [],
      connectors: [],
      source: { kind: 'local-dir' },
    };
    (getCommunityPackageRegistry as ReturnType<typeof vi.fn>).mockReturnValue({
      listPackages: () => [def],
    });
    (getPackageRuntimeManager as ReturnType<typeof vi.fn>).mockReturnValue({
      getProjectPackageIds: () => new Set(['feature-pkg']),
      getPackageOwnerScope: () => undefined,
      getLoader: () => ({ getStatus: () => undefined }),
    });
    vi.mocked(PackageSnapshotService).mockImplementation(function () { return ({
      getFullSnapshot: () => ({
        revision: 'test-rev',
        packages: [{ id: 'feature-pkg', access: { trust: 'trusted' } }],
        tools: [],
        surfaces: def.surfaces,
        commands: def.commands,
        files: [],
        resources: [],
        connectors: [],
      }),
      getRevision: () => 'test-rev',
      isUpToDate: () => false,
    }); } as any);
  });

  it('filters runtime widgets, dock entries, and commands by granted features', () => {
    const denied = getPackageSnapshot({ host: 'neuralis-workspace', projectId: 'proj-a' }, []);
    expect(denied.surfaces).toHaveLength(0);
    expect(denied.commands).toHaveLength(0);

    const allowed = getPackageSnapshot(
      { host: 'neuralis-workspace', projectId: 'proj-a' },
      ['feature.secure'],
    );
    expect(allowed.surfaces.map((entry) => entry.id)).toEqual(['secure-widget', 'secure-dock']);
    expect(allowed.commands.map((command) => command.id)).toEqual(['secure-command']);
  });

  it('filters runtime tools by granted features (S2b — 3rd surface)', () => {
    const denied = getPackageSnapshot({ host: 'neuralis-workspace', projectId: 'proj-a' }, []);
    expect(denied.tools.map((t) => t.name)).toEqual(['open_tool']);

    const allowed = getPackageSnapshot(
      { host: 'neuralis-workspace', projectId: 'proj-a' },
      ['feature.secure'],
    );
    expect(allowed.tools.map((t) => t.name).sort()).toEqual(['open_tool', 'secure_tool']);
  });
});

describe('R2b — scope-isolated snapshots (scope-guarding-magpie)', () => {
  const builtinDef = makeDef('@neuralis/agent-core');
  const userScopedDef = makeDef('pkg-alice'); // owned by a user-scoped source
  const projectScopedDef = makeDef('pkg-shared'); // owned by a project-scope source

  beforeEach(() => {
    delete (globalThis as any).__neuralis_snapshot_service__;
    vi.mocked(PackageSnapshotService).mockImplementation(function () { return ({
      getFullSnapshot: () => ({
        revision: 'test-rev',
        packages: [],
        tools: [],
        surfaces: [builtinDef, userScopedDef, projectScopedDef].flatMap((def) => def.surfaces),
        commands: [builtinDef, userScopedDef, projectScopedDef].flatMap((def) => def.commands),
        files: [],
        resources: [],
        connectors: [],
      }),
      getRevision: () => 'test-rev',
      isUpToDate: () => false,
    }); } as any);

    (getCommunityPackageRegistry as ReturnType<typeof vi.fn>).mockReturnValue({
      listPackages: () => [builtinDef, userScopedDef, projectScopedDef],
    });

    (getPackageRuntimeManager as ReturnType<typeof vi.fn>).mockReturnValue({
      getProjectPackageIds: () => new Set(['pkg-alice', 'pkg-shared']),
      getPackageOwnerScope: (_projectId: string, packageId: string) => {
        if (packageId === 'pkg-alice') return { kind: 'user', userId: 'alice' };
        if (packageId === 'pkg-shared') return { kind: 'project' };
        return undefined;
      },
      getLoader: () => ({ getStatus: () => undefined }),
    });
  });

  it('hides a user-scoped package from another user; keeps builtins + project-scope', () => {
    const snap = getPackageSnapshot(
      { host: 'neuralis-workspace', projectId: 'proj-a', userId: 'bob', role: 'member', grantedFeatures: [] },
    );
    const ids = snap.tools.map((t) => t.packageId);
    expect(ids).toContain('@neuralis/agent-core');
    expect(ids).toContain('pkg-shared');
    expect(ids).not.toContain('pkg-alice');
  });

  it('shows a user-scoped package to its owning user', () => {
    const snap = getPackageSnapshot(
      { host: 'neuralis-workspace', projectId: 'proj-a', userId: 'alice', role: 'member', grantedFeatures: [] },
    );
    expect(snap.tools.map((t) => t.packageId)).toContain('pkg-alice');
  });

  it('shows a user-scoped package to an owner holding the wildcard grant (observeScoped)', () => {
    const snap = getPackageSnapshot(
      { host: 'neuralis-workspace', projectId: 'proj-a', userId: 'bob', role: 'owner', grantedFeatures: ['*'] },
    );
    expect(snap.tools.map((t) => t.packageId)).toContain('pkg-alice');
  });

  it('deny-by-default: a no-userId snapshot hides scoped packages but keeps builtins/project-scope', () => {
    const snap = getPackageSnapshot({ host: 'neuralis-workspace', projectId: 'proj-a' });
    const ids = snap.tools.map((t) => t.packageId);
    expect(ids).toContain('@neuralis/agent-core');
    expect(ids).toContain('pkg-shared');
    expect(ids).not.toContain('pkg-alice');
  });
});
