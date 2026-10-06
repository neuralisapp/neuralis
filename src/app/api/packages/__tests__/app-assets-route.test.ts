/**
 * Identity-free package asset scope routes (CARD1 3A):
 *   - POST/PATCH/DELETE /api/packages/:slug/app-scope (mint / heartbeat / close)
 *   - GET /api/package-app/_scope/:handle/{surface|shared}/* (virtual GET)
 *
 * Covers: mint + package-ID-free URL, uniform non-enumerating mint denials,
 * virtual GET containment (sibling/ancestor/namespace/extension), the
 * B-baseline byte cap, no-store headers, verified-agent revoke, visibility/fingerprint/generation drift
 * revoke (410), wrong-user 403, own-close vs foreign-close, and the
 * runtime-id / filesystem-path non-leak floor on every error body.
 */

import { NextRequest } from 'next/server';
import { beforeEach, afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  resolveSessionContext: vi.fn<() => Promise<unknown>>(),
  getSessionUser: vi.fn<() => Promise<unknown>>(),
  resolveVerifiedAgentScope: vi.fn<() => Promise<string | undefined>>(async () => undefined),
  resolveVisiblePackageSurface: vi.fn<() => Promise<unknown>>(),
  ensureProjectPackagesLoaded: vi.fn(async () => undefined),
  getProjectPackageScanner: vi.fn<() => unknown>(),
  scannerGetPackageById: vi.fn<(id: string) => unknown>(),
  scannerGetPackage: vi.fn<(slug: string) => unknown>(),
}));

vi.mock('@/server/auth/resolveSessionContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/auth/resolveSessionContext')>()),
  resolveSessionContext: mocks.resolveSessionContext,
}));

vi.mock('@/server/auth/session', () => ({
  getSessionUser: mocks.getSessionUser,
}));

vi.mock('@/server/auth/resolveVerifiedAgentScope', () => ({
  resolveVerifiedAgentScope: mocks.resolveVerifiedAgentScope,
}));

vi.mock('@/server/packages/packageVisibility', () => ({
  resolveVisiblePackageSurface: mocks.resolveVisiblePackageSurface,
}));

vi.mock('@/server/packages/projectPackages', () => ({
  ensureProjectPackagesLoaded: mocks.ensureProjectPackagesLoaded,
}));

vi.mock('@/server/packages/ProjectPackageScanner', () => ({
  getProjectPackageScanner: mocks.getProjectPackageScanner,
}));

vi.mock('@/server/config/env', () => ({
  getEnv: () => ({ projectsRoot: '/tmp/nrs-test-projects' }),
}));

vi.mock('@/server/logging/setup', () => ({
  getLogger: () => ({
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
}));

import { POST as mintPost, PATCH as heartbeatPatch, DELETE as closeDelete } from '../[slug]/app-scope/route';
import { handlePackageAppAssetGet } from '@/server/packages/packageAppAssetGet';
import {
  buildPackageAppAssetCsp,
  PACKAGE_APP_ASSET_MAX_BYTES,
} from '@/server/packages/packageAppAssetCsp';
import { getPackageAssetScopeAuthority } from '@/server/packages/PackageAssetScopeAuthority';

const AUTHORITY_KEY = Symbol.for('@neuralis/neuralis/package-asset-scope-authority/v1');

const SESSION = {
  userId: 'user-1',
  projectId: 'proj-1',
  role: 'member',
  grantedFeatures: ['core.chat'],
};

// REAL id semantics (BUG-A lesson): the registry (and thus `surface.packageId`
// + the client-sent URL slug) carries the scope-NAMESPACED id, while the
// project scanner records carry the RAW manifest id and cache on the dir slug.
// The stubs below answer ONLY for their own id form — an "any id matches" stub
// masked the mint-404 bug behind 19 green tests.
const NAMESPACED_ID = 'p.proj-1.project.example-package';
const MANIFEST_ID = 'example-package';
const DIR_SLUG = 'example-package';

let packageRoot = '';
let outsideDir = '';

/** Marker written OUTSIDE the package root — a response containing it is a leak. */
const OUTSIDE_SENTINEL = '{"marker":"SCOPE-LANE-OUTSIDE-SENTINEL"}';

function makeSurface(overrides: Record<string, unknown> = {}) {
  return {
    packageId: NAMESPACED_ID,
    manifestId: MANIFEST_ID,
    surfaceKind: 'widget',
    surfaceId: 'example_workspace',
    renderer: 'iframe',
    entryUrl: './app/surfaces/widget/example_workspace/index.html',
    trust: 'untrusted',
    fingerprint: 'fp-1',
    generation: 'gen-1',
    definition: { id: NAMESPACED_ID },
    ...overrides,
  };
}

function mintReq(body: Record<string, unknown>) {
  return new NextRequest(`http://localhost:3100/api/packages/${NAMESPACED_ID}/app-scope`, {
    method: 'POST',
    headers: { 'x-project-id': 'proj-1', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function bodyReq(method: string, body: Record<string, unknown>) {
  return new NextRequest('http://localhost:3100/api/packages/example-package/app-scope', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getReq() {
  // Cookie-only navigation shape: NO x-project-id header, NO query.
  return new NextRequest('http://localhost:3100/api/package-app/_scope/x/surface/index.html');
}

async function mintHandle(): Promise<{ handle: string; url: string }> {
  const res = await mintPost(
    mintReq({ surfaceKind: 'widget', surfaceId: 'example_workspace' }),
    { params: Promise.resolve({ slug: NAMESPACED_ID }) },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { handle: string; url: string };
}

/** No error surface may reflect the runtime package id or a filesystem path. */
async function expectNonLeaking(res: Response): Promise<void> {
  const text = JSON.stringify([...res.headers.entries()]) + (await res.clone().text());
  expect(text).not.toContain(MANIFEST_ID); // also a substring of NAMESPACED_ID
  expect(text).not.toContain(packageRoot);
  expect(text).not.toContain('/app/surfaces');
}

beforeAll(async () => {
  packageRoot = await mkdtemp(join(tmpdir(), 'nrs-asset-scope-'));
  const surfaceDir = join(packageRoot, 'app', 'surfaces', 'widget', 'example_workspace');
  const siblingDir = join(packageRoot, 'app', 'surfaces', 'widget', 'hidden_widget');
  const sharedDir = join(packageRoot, 'app', 'shared');
  await mkdir(join(surfaceDir, 'nested'), { recursive: true });
  await mkdir(siblingDir, { recursive: true });
  await mkdir(sharedDir, { recursive: true });
  await writeFile(join(surfaceDir, 'index.html'), '<html>WIDGET-OK</html>');
  await writeFile(join(surfaceDir, 'nested', 'style.css'), '.ok{}');
  await writeFile(join(surfaceDir, 'code.ts'), 'export const secret = 1;');
  await writeFile(join(siblingDir, 'secret.html'), '<html>SIBLING-SECRET</html>');
  await writeFile(join(sharedDir, 'example-theme.css'), '.shared{}');
  await writeFile(join(packageRoot, 'app', 'root-secret.html'), '<html>APP-ROOT-SECRET</html>');

  // Symlink escapes + their legitimate twin. The sentinel lives OUTSIDE the
  // package root, so serving it is a genuine escape and not a name collision.
  outsideDir = join(packageRoot, '..', `nrs-scope-outside-${process.pid}`);
  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(outsideDir, 'secret.json'), OUTSIDE_SENTINEL);
  await writeFile(join(outsideDir, 'sentinel.json'), OUTSIDE_SENTINEL);
  await symlink(join(outsideDir, 'secret.json'), join(surfaceDir, 'data.json'));
  await symlink(outsideDir, join(surfaceDir, 'leak'));
  await symlink(join(outsideDir, 'secret.json'), join(sharedDir, 'shared-leak.json'));
  await symlink(join(surfaceDir, 'nested', 'style.css'), join(surfaceDir, 'alias.css'));
});

afterAll(async () => {
  await rm(packageRoot, { recursive: true, force: true });
  if (outsideDir) await rm(outsideDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  delete (globalThis as Record<symbol, unknown>)[AUTHORITY_KEY];
  mocks.resolveSessionContext.mockResolvedValue({ ...SESSION });
  mocks.getSessionUser.mockResolvedValue({ id: 'user-1' });
  mocks.resolveVerifiedAgentScope.mockResolvedValue(undefined);
  mocks.resolveVisiblePackageSurface.mockResolvedValue(makeSurface());
  // Strict id semantics: a record is found ONLY via its RAW manifest id
  // (getPackageById) or its dir slug (getPackage) — never via the namespaced
  // registry id. Without the route's namespaced→manifest translation every
  // lookup here returns null and the mint 404s (the live BUG-A).
  mocks.scannerGetPackageById.mockImplementation((id: string) =>
    id === MANIFEST_ID ? { slug: DIR_SLUG, packageId: MANIFEST_ID, packageRoot, definition: { id: MANIFEST_ID } } : null,
  );
  mocks.scannerGetPackage.mockImplementation((slug: string) =>
    slug === DIR_SLUG ? { slug: DIR_SLUG, packageId: MANIFEST_ID, packageRoot, definition: { id: MANIFEST_ID } } : null,
  );
  mocks.getProjectPackageScanner.mockReturnValue({
    getPackageById: mocks.scannerGetPackageById,
    getPackage: mocks.scannerGetPackage,
  });
});

describe('POST /api/packages/:slug/app-scope (mint)', () => {
  it('BUG-A: resolves the scanner record via the RAW manifest id, never the namespaced registry id', async () => {
    // The default stubs are strict (the namespaced id matches NOTHING in the
    // scanner), so this mint succeeds ONLY through the surface.manifestId
    // translation — reverting the route to `getPackageById(surface.packageId)
    // ?? getPackage(slug)` turns this 200 into the live 404.
    const { handle } = await mintHandle();
    expect(handle).toBeTruthy();
    expect(mocks.scannerGetPackageById).toHaveBeenCalledWith(MANIFEST_ID);
    expect(mocks.scannerGetPackageById).not.toHaveBeenCalledWith(NAMESPACED_ID);
  });

  it('mints an opaque handle and a package-ID-free navigable URL', async () => {
    const { handle, url } = await mintHandle();
    expect(handle).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(url).toBe(`/api/package-app/_scope/${handle}/surface/index.html`);
    // No runtime/package/project/user/surface identity in the URL.
    for (const needle of ['example-package', 'proj-1', 'user-1', 'example_workspace', 'widget']) {
      expect(url.replace('/surface/', '/')).not.toContain(needle);
    }
  });

  it('answers ONE uniform non-enumerating 404 for every not-visible reason', async () => {
    const bodies: string[] = [];

    // (a) surface not visible
    mocks.resolveVisiblePackageSurface.mockResolvedValue(null);
    let res = await mintPost(mintReq({ surfaceKind: 'widget', surfaceId: 'example_workspace' }), {
      params: Promise.resolve({ slug: NAMESPACED_ID }),
    });
    expect(res.status).toBe(404);
    await expectNonLeaking(res);
    bodies.push(await res.text());

    // (b) bad surface kind
    mocks.resolveVisiblePackageSurface.mockResolvedValue(makeSurface());
    res = await mintPost(mintReq({ surfaceKind: 'dock', surfaceId: 'example_workspace' }), {
      params: Promise.resolve({ slug: NAMESPACED_ID }),
    });
    expect(res.status).toBe(404);
    bodies.push(await res.text());

    // (c) traversal-capable surface id
    res = await mintPost(mintReq({ surfaceKind: 'widget', surfaceId: '..' }), {
      params: Promise.resolve({ slug: NAMESPACED_ID }),
    });
    expect(res.status).toBe(404);
    bodies.push(await res.text());

    // (d) absolute entry url (no asset scope to mint)
    mocks.resolveVisiblePackageSurface.mockResolvedValue(
      makeSurface({ entryUrl: 'https://example.com/x.html', trust: 'trusted' }),
    );
    res = await mintPost(mintReq({ surfaceKind: 'widget', surfaceId: 'example_workspace' }), {
      params: Promise.resolve({ slug: NAMESPACED_ID }),
    });
    expect(res.status).toBe(404);
    bodies.push(await res.text());

    // (e) non-canonical (legacy flat) entry url
    mocks.resolveVisiblePackageSurface.mockResolvedValue(makeSurface({ entryUrl: 'widget.html' }));
    res = await mintPost(mintReq({ surfaceKind: 'widget', surfaceId: 'example_workspace' }), {
      params: Promise.resolve({ slug: NAMESPACED_ID }),
    });
    expect(res.status).toBe(404);
    bodies.push(await res.text());

    // All denial bodies are BYTE-IDENTICAL (non-enumerating).
    expect(new Set(bodies).size).toBe(1);
  });

  it('K7 — mints with the agent resolveSessionContext already VERIFIED, resolving it once', async () => {
    // resolveSessionContext verifies the raw header (its own test pins that);
    // the mint must use its answer and never pay a second agent read.
    mocks.resolveSessionContext.mockResolvedValue({ ...SESSION, agentId: 'agent-ok' });
    const { handle } = await mintHandle();
    const call = mocks.resolveVisiblePackageSurface.mock.calls[0] as unknown[];
    expect((call[0] as { agentId?: string }).agentId).toBe('agent-ok');
    expect(mocks.resolveVerifiedAgentScope).not.toHaveBeenCalled();
    expect(handle).toBeTruthy();
  });

  it('K7 — a session with no verified agent mints with none', async () => {
    mocks.resolveSessionContext.mockResolvedValue({ ...SESSION });
    await mintHandle();
    const call = mocks.resolveVisiblePackageSurface.mock.calls[0] as unknown[];
    expect((call[0] as { agentId?: string }).agentId).toBeUndefined();
  });

  it('propagates session resolution denials (401/403)', async () => {
    const { SessionResolutionError } = await vi.importActual<
      typeof import('@/server/auth/resolveSessionContext')
    >('@/server/auth/resolveSessionContext');
    mocks.resolveSessionContext.mockRejectedValue(new SessionResolutionError(403, 'Forbidden: no access to project'));
    const res = await mintPost(mintReq({ surfaceKind: 'widget', surfaceId: 'example_workspace' }), {
      params: Promise.resolve({ slug: NAMESPACED_ID }),
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/package-app/_scope/:handle (virtual asset GET)', () => {
  it('serves the surface entry with the no-store floor headers', async () => {
    const { handle } = await mintHandle();
    const res = await handlePackageAppAssetGet(getReq(), handle, ['surface', 'index.html']);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('WIDGET-OK');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('serves nested surface subresources and shared/* assets', async () => {
    const { handle } = await mintHandle();
    const css = await handlePackageAppAssetGet(getReq(), handle, ['surface', 'nested', 'style.css']);
    expect(css.status).toBe(200);
    const shared = await handlePackageAppAssetGet(getReq(), handle, ['shared', 'example-theme.css']);
    expect(shared.status).toBe(200);
    expect(await shared.text()).toContain('.shared');
  });

  it('denies sibling/ancestor traversal fail-closed (no existence signal)', async () => {
    const { handle } = await mintHandle();
    for (const segments of [
      ['surface', '..', 'hidden_widget', 'secret.html'],
      ['surface', '..', '..', '..', 'root-secret.html'],
      ['shared', '..', 'surfaces', 'widget', 'hidden_widget', 'secret.html'],
    ]) {
      const res = await handlePackageAppAssetGet(getReq(), handle, segments);
      expect(res.status, segments.join('/')).toBe(403);
      await expectNonLeaking(res);
    }
  });

  // The lexical traversal above is only half the rule. A symlink planted under
  // the surface root has a perfectly contained SPELLING, so only the real-path
  // half refuses it — and it must refuse with this lane's 403, the same status a
  // spelled traversal gets, without echoing the target anywhere.
  it('denies symlink escapes with the SAME 403, and never echoes the target', async () => {
    const { handle } = await mintHandle();
    for (const segments of [
      ['surface', 'data.json'], // a file symlink pointing outside
      ['surface', 'leak', 'sentinel.json'], // an intermediate DIRECTORY symlink
      ['shared', 'shared-leak.json'], // the shared namespace, same rule
    ]) {
      const res = await handlePackageAppAssetGet(getReq(), handle, segments);
      expect(res.status, segments.join('/')).toBe(403);
      await expectNonLeaking(res);
      const text = JSON.stringify([...res.headers.entries()]) + (await res.clone().text());
      expect(text).not.toContain('SCOPE-LANE-OUTSIDE-SENTINEL');
      expect(text).not.toContain(outsideDir);
      expect(text).not.toContain('secret.json');
    }
  });

  it('still serves a symlink whose target is INSIDE the root', async () => {
    // The non-vacuum twin. A blanket symlink refusal would 403 here, and a
    // real-path check that compared against the lexically stored root would too.
    const { handle } = await mintHandle();
    const res = await handlePackageAppAssetGet(getReq(), handle, ['surface', 'alias.css']);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('.ok{}');
  });

  it('denies non-surface/shared namespaces and bare namespaces', async () => {
    const { handle } = await mintHandle();
    for (const segments of [
      ['app', 'root-secret.html'],
      ['surface'],
      ['secret.html'],
    ]) {
      const res = await handlePackageAppAssetGet(getReq(), handle, segments);
      expect(res.status, segments.join('/')).toBe(404);
      await expectNonLeaking(res);
    }
  });

  it('extension allowlist: never serves source files', async () => {
    const { handle } = await mintHandle();
    const res = await handlePackageAppAssetGet(getReq(), handle, ['surface', 'code.ts']);
    expect(res.status).toBe(404);
  });

  it('B-baseline memory bound: an over-cap asset is refused BEFORE the read', async () => {
    // The route stats first and must not read a `_packages/`-supplied file
    // larger than the cap into memory. The refusal keeps the route's uniform,
    // non-enumerating 404 vocabulary — no 413, no size in the body.
    const { handle } = await mintHandle();
    const overCap = join(packageRoot, 'app', 'surfaces', 'widget', 'example_workspace', 'huge.html');
    await writeFile(overCap, Buffer.alloc(PACKAGE_APP_ASSET_MAX_BYTES + 1, 0x61));
    try {
      const res = await handlePackageAppAssetGet(getReq(), handle, ['surface', 'huge.html']);
      expect(res.status).toBe(404);
      await expectNonLeaking(res);
      expect(await res.text()).not.toContain(String(PACKAGE_APP_ASSET_MAX_BYTES));
    } finally {
      await rm(overCap, { force: true });
    }
  });

  it('an asset exactly AT the cap still serves', async () => {
    const { handle } = await mintHandle();
    const atCap = join(packageRoot, 'app', 'surfaces', 'widget', 'example_workspace', 'atcap.html');
    await writeFile(atCap, Buffer.alloc(PACKAGE_APP_ASSET_MAX_BYTES, 0x61));
    try {
      const res = await handlePackageAppAssetGet(getReq(), handle, ['surface', 'atcap.html']);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-length')).toBe(String(PACKAGE_APP_ASSET_MAX_BYTES));
    } finally {
      await rm(atCap, { force: true });
    }
  });

  it('unknown handle → uniform 410', async () => {
    const res = await handlePackageAppAssetGet(getReq(), 'no-such-handle', ['surface', 'index.html']);
    expect(res.status).toBe(410);
    await expectNonLeaking(res);
  });

  it('wrong user → generic 403', async () => {
    const { handle } = await mintHandle();
    mocks.resolveSessionContext.mockResolvedValue({ ...SESSION, userId: 'user-2' });
    const res = await handlePackageAppAssetGet(getReq(), handle, ['surface', 'index.html']);
    expect(res.status).toBe(403);
    await expectNonLeaking(res);
  });

  it('verified-agent loss (deleted/ownership-revoked) revokes → 410', async () => {
    mocks.resolveSessionContext.mockResolvedValue({ ...SESSION, agentId: 'agent-1' });
    mocks.resolveVerifiedAgentScope.mockResolvedValue('agent-1');
    const { handle } = await mintHandle();

    mocks.resolveVerifiedAgentScope.mockResolvedValue(undefined); // agent gone
    const res = await handlePackageAppAssetGet(getReq(), handle, ['surface', 'index.html']);
    expect(res.status).toBe(410);
    // Revoked — a later request with restored agent still 410s (fresh mint needed).
    mocks.resolveVerifiedAgentScope.mockResolvedValue('agent-1');
    const after = await handlePackageAppAssetGet(getReq(), handle, ['surface', 'index.html']);
    expect(after.status).toBe(410);
  });

  it('visibility loss / uninstall revokes → 410', async () => {
    const { handle } = await mintHandle();
    mocks.resolveVisiblePackageSurface.mockResolvedValue(null);
    const res = await handlePackageAppAssetGet(getReq(), handle, ['surface', 'index.html']);
    expect(res.status).toBe(410);
    await expectNonLeaking(res);
  });

  it('fingerprint / generation drift (package update) revokes → 410', async () => {
    const { handle } = await mintHandle();
    mocks.resolveVisiblePackageSurface.mockResolvedValue(makeSurface({ fingerprint: 'fp-2' }));
    const res = await handlePackageAppAssetGet(getReq(), handle, ['surface', 'index.html']);
    expect(res.status).toBe(410);

    const { handle: h2 } = await mintHandle();
    mocks.resolveVisiblePackageSurface.mockResolvedValue(makeSurface({ generation: 'gen-2' }));
    const res2 = await handlePackageAppAssetGet(getReq(), h2, ['surface', 'index.html']);
    expect(res2.status).toBe(410);
  });

  it('carries the strict CSP for a TRUSTED record too (trust-INDEPENDENT floor)', async () => {
    // The next.config path-scoped rule already applies this policy regardless of
    // trust; a trust-conditional copy here was the one place the two consumers
    // disagreed, which reads as if trusted assets were exempt.
    mocks.resolveVisiblePackageSurface.mockResolvedValue(makeSurface({ trust: 'trusted' }));
    const { handle } = await mintHandle();
    const res = await handlePackageAppAssetGet(getReq(), handle, ['surface', 'index.html']);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(buildPackageAppAssetCsp());
    expect(res.headers.get('content-security-policy')).toContain("base-uri 'self'");
    // The `toBe(builder)` assertion above is SELF-REFERENTIAL — it follows the
    // builder wherever it goes and cannot catch a directive being dropped. These
    // two are the literal floor on what the SERVED entry actually carries.
    expect(res.headers.get('content-security-policy')).toContain(
      'sandbox allow-scripts allow-forms',
    );
    expect(res.headers.get('content-security-policy')).not.toContain('allow-same-origin');
  });
});

/**
 * BUNDLE-mode `<base>` injection on the ENTRY document.
 *
 * These cases set the mode directly on the minted record rather than declaring
 * it in the fixture manifest, so they test the SERVING half in isolation. The
 * declaring half — manifest value → `normalizeSurfaceAssetMode` → the mint —
 * is covered by `src/server/packages/__tests__/packageVisibility.test.ts`; a
 * fixture that declared the mode would test both at once and tell you nothing
 * about which one broke.
 */
describe('GET /api/package-app/_scope/:handle — bundle-mode base injection', () => {
  async function mintWithMode(mode?: 'bundle' | 'self-contained') {
    const { handle } = await mintHandle();
    const record = getPackageAssetScopeAuthority().get(handle)!;
    expect(record).toBeTruthy();
    if (mode) record.assetMode = mode;
    return { handle, record };
  }

  /**
   * THE SILENT, ENVIRONMENT-DEPENDENT REGRESSION the real-path containment could
   * have introduced. The entry-vs-`<base>` decision compares the LEXICAL resolved
   * path against `resolve(surfaceRoot, entryRelPath)`. If the containment helper
   * ever hands its realpath back as the value this lane keys on, then on ANY
   * deployment whose roots sit under a symlink (`~/.neuralis -> /mnt/data/…`, a
   * common self-host layout) the equality fails, the `<base>` is silently NOT
   * injected, and every bundle surface degrades to self-contained with no error
   * on any surface — no status change, no log, nothing to notice.
   *
   * A plain-tmpdir fixture cannot see it. This one reaches the SAME surface root
   * through a symlink, which is the whole difference.
   */
  it('still injects the <base> when the surface root is reached THROUGH a symlink', async () => {
    const { handle, record } = await mintWithMode('bundle');
    const linkedPackageRoot = join(packageRoot, '..', `nrs-scope-linkroot-${process.pid}`);
    await rm(linkedPackageRoot, { recursive: true, force: true });
    await symlink(packageRoot, linkedPackageRoot);
    try {
      record.surfaceRoot = join(
        linkedPackageRoot,
        'app',
        'surfaces',
        'widget',
        'example_workspace',
      );
      record.sharedRoot = join(linkedPackageRoot, 'app', 'shared');

      const res = await handlePackageAppAssetGet(getReq(), handle, ['surface', 'index.html']);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain(`<base href="/api/package-app/_pub/${record.pubToken}/surface/">`);

      // …and the subresources under the symlinked root still serve, rather than
      // being read as escapes out of it.
      const css = await handlePackageAppAssetGet(getReq(), handle, [
        'surface',
        'nested',
        'style.css',
      ]);
      expect(css.status).toBe(200);
      const shared = await handlePackageAppAssetGet(getReq(), handle, [
        'shared',
        'example-theme.css',
      ]);
      expect(shared.status).toBe(200);
    } finally {
      await rm(linkedPackageRoot, { recursive: true, force: true });
    }
  });

  it('injects the <base> into the ENTRY and RECOMPUTES Content-Length', async () => {
    const { handle, record } = await mintWithMode('bundle');
    const res = await handlePackageAppAssetGet(getReq(), handle, ['surface', 'index.html']);
    expect(res.status).toBe(200);

    const body = await res.text();
    const expectedTag = `<base href="/api/package-app/_pub/${record.pubToken}/surface/">`;
    expect(body).toContain(expectedTag);
    // The original bytes survive around the injected tag.
    expect(body.replace(expectedTag, '')).toBe('<html>WIDGET-OK</html>');

    // The STAT size would now UNDERSTATE the body and truncate the response.
    expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(body, 'latin1')));
    expect(res.headers.get('content-length')).not.toBe(String('<html>WIDGET-OK</html>'.length));
  });

  it('with assetMode ABSENT the response is byte-identical to today', async () => {
    const { handle } = await mintWithMode();
    const res = await handlePackageAppAssetGet(getReq(), handle, ['surface', 'index.html']);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toBe('<html>WIDGET-OK</html>');
    expect(body).not.toContain('<base');
    expect(res.headers.get('content-length')).toBe(String(body.length));
  });

  it("explicit 'self-contained' is also never injected", async () => {
    const { handle } = await mintWithMode('self-contained');
    const res = await handlePackageAppAssetGet(getReq(), handle, ['surface', 'index.html']);
    expect(await res.text()).toBe('<html>WIDGET-OK</html>');
  });

  it('a NON-entry .html under the same surface is NEVER injected', async () => {
    const { handle } = await mintWithMode('bundle');
    const second = join(
      packageRoot,
      'app',
      'surfaces',
      'widget',
      'example_workspace',
      'second.html',
    );
    await writeFile(second, '<html>SECOND</html>');
    try {
      const res = await handlePackageAppAssetGet(getReq(), handle, ['surface', 'second.html']);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe('<html>SECOND</html>');
      expect(body).not.toContain('<base');
    } finally {
      await rm(second, { force: true });
    }
  });

  it('a shared-namespace .html is NEVER injected', async () => {
    const { handle } = await mintWithMode('bundle');
    const sharedPage = join(packageRoot, 'app', 'shared', 'page.html');
    await writeFile(sharedPage, '<html>SHARED</html>');
    try {
      const res = await handlePackageAppAssetGet(getReq(), handle, ['shared', 'page.html']);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toBe('<html>SHARED</html>');
      expect(body).not.toContain('<base');
    } finally {
      await rm(sharedPage, { force: true });
    }
  });

  it('a non-document asset is never injected either', async () => {
    const { handle } = await mintWithMode('bundle');
    const res = await handlePackageAppAssetGet(getReq(), handle, ['surface', 'nested', 'style.css']);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('.ok{}');
  });

  it('a NON-HTML declared entry is served untouched, not given an HTML tag', async () => {
    // Reachable without any contract violation: the kernel validator only WARNS
    // on a non-HTML entry and the mint route never checks, so a surface can
    // declare `index.svg` and still mint. Without the `isHtmlEntryPath` gate the
    // route would splice an HTML `<base>` string into an `image/svg+xml` body.
    const { handle, record } = await mintWithMode('bundle');
    const svg = join(
      packageRoot,
      'app',
      'surfaces',
      'widget',
      'example_workspace',
      'entry.svg',
    );
    const bytes = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    await writeFile(svg, bytes);
    record.entryRelPath = 'entry.svg';
    try {
      const res = await handlePackageAppAssetGet(getReq(), handle, ['surface', 'entry.svg']);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('image/svg+xml');
      const body = await res.text();
      expect(body).toBe(bytes);
      expect(body).not.toContain('<base');
      expect(res.headers.get('content-length')).toBe(String(bytes.length));
    } finally {
      await rm(svg, { force: true });
    }
  });

  it('a UTF-16 BOM entry is served untouched — fail-closed, never half-injected', async () => {
    // Both insertion points are unsafe in a UTF-16 document (one breaks the
    // encoding sniff, the other loses precedence silently), so the transform
    // declines. The bytes must come back EXACTLY as they went in.
    const { handle } = await mintWithMode('bundle');
    const entry = join(
      packageRoot,
      'app',
      'surfaces',
      'widget',
      'example_workspace',
      'index.html',
    );
    const original = await readFile(entry);
    const utf16 = Buffer.from([0xff, 0xfe, 0x3c, 0x00, 0x70, 0x00, 0x3e, 0x00]);
    await writeFile(entry, utf16);
    try {
      const res = await handlePackageAppAssetGet(getReq(), handle, ['surface', 'index.html']);
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(utf16);
      expect(res.headers.get('content-length')).toBe(String(utf16.length));
    } finally {
      await writeFile(entry, original);
    }
  });

  it('the injected URL carries the pub token and NO identity of any kind', async () => {
    const { handle, record } = await mintWithMode('bundle');
    const res = await handlePackageAppAssetGet(getReq(), handle, ['surface', 'index.html']);
    const body = await res.text();
    for (const needle of [MANIFEST_ID, NAMESPACED_ID, 'user-1', 'proj-1', packageRoot]) {
      expect(body).not.toContain(needle);
    }
    // The pub token is the ONLY secret in it, and it is NOT the entry handle.
    expect(body).toContain(record.pubToken);
    expect(body).not.toContain(handle);
  });
});

describe('PATCH / DELETE /api/packages/:slug/app-scope (heartbeat / close)', () => {
  it('heartbeat keeps a live, still-visible scope alive', async () => {
    const { handle } = await mintHandle();
    const res = await heartbeatPatch(bodyReq('PATCH', { handle }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('heartbeat revokes on visibility loss → 410', async () => {
    const { handle } = await mintHandle();
    mocks.resolveVisiblePackageSurface.mockResolvedValue(null);
    const res = await heartbeatPatch(bodyReq('PATCH', { handle }));
    expect(res.status).toBe(410);
    // Revoked for the GET path too.
    mocks.resolveVisiblePackageSurface.mockResolvedValue(makeSurface());
    const after = await handlePackageAppAssetGet(getReq(), handle, ['surface', 'index.html']);
    expect(after.status).toBe(410);
  });

  it('heartbeat with unknown handle → 410', async () => {
    const res = await heartbeatPatch(bodyReq('PATCH', { handle: 'nope' }));
    expect(res.status).toBe(410);
  });

  it('own close closes; a foreign user close is a silent no-op', async () => {
    const { handle } = await mintHandle();

    mocks.getSessionUser.mockResolvedValue({ id: 'user-2' });
    let res = await closeDelete(bodyReq('DELETE', { handle }));
    expect(res.status).toBe(200); // non-enumerating — no failure signal
    // Still alive:
    const alive = await handlePackageAppAssetGet(getReq(), handle, ['surface', 'index.html']);
    expect(alive.status).toBe(200);

    mocks.getSessionUser.mockResolvedValue({ id: 'user-1' });
    res = await closeDelete(bodyReq('DELETE', { handle }));
    expect(res.status).toBe(200);
    const gone = await handlePackageAppAssetGet(getReq(), handle, ['surface', 'index.html']);
    expect(gone.status).toBe(410);
  });

  it('close requires an authenticated user', async () => {
    mocks.getSessionUser.mockResolvedValue(null);
    const res = await closeDelete(bodyReq('DELETE', { handle: 'x' }));
    expect(res.status).toBe(401);
  });
});
