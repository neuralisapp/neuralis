/**
 * The ICON purpose of the identity-free asset scope: a dock entry's declared
 * picture, minted through the SAME app-scope route and served on the SAME
 * authenticated `_scope` lane, never on `_pub`.
 *
 * Paired cases: a valid raster against a disguised SVG, an HTML document, an
 * over-cap file, a symlink escape, a sibling file, a foreign principal, feature
 * loss, a changed declaration fingerprint and the public lane; the capacity
 * refusal against 128 live documents.
 */

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const mocks = vi.hoisted(() => ({
  resolveSessionContext: vi.fn<() => Promise<unknown>>(),
  getSessionUser: vi.fn<() => Promise<unknown>>(),
  resolveVerifiedAgentScope: vi.fn<() => Promise<string | undefined>>(async () => undefined),
  resolveVisiblePackageSurface: vi.fn<() => Promise<unknown>>(),
  resolveVisiblePackageDockImage: vi.fn<() => Promise<unknown>>(),
  ensureProjectPackagesLoaded: vi.fn(async () => undefined),
  loadedRoots: new Map<string, string | undefined>(),
  listPackages: vi.fn<() => unknown[]>(() => []),
}));

vi.mock('@/server/auth/resolveSessionContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/auth/resolveSessionContext')>()),
  resolveSessionContext: mocks.resolveSessionContext,
}));
vi.mock('@/server/auth/session', () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock('@/server/auth/resolveVerifiedAgentScope', () => ({
  resolveVerifiedAgentScope: mocks.resolveVerifiedAgentScope,
}));
vi.mock('@/server/packages/packageVisibility', () => ({
  resolveVisiblePackageSurface: mocks.resolveVisiblePackageSurface,
  resolveVisiblePackageDockImage: mocks.resolveVisiblePackageDockImage,
  getDefinitionGeneration: () => 'gen-1',
}));
vi.mock('@/server/packages/projectPackages', () => ({
  ensureProjectPackagesLoaded: mocks.ensureProjectPackagesLoaded,
}));
vi.mock('@/server/packages/runtime', () => ({
  getCommunityPackageRegistry: () => ({ listPackages: mocks.listPackages }),
}));
vi.mock('@/server/packages/PackageRuntimeManager', () => ({
  getPackageRuntimeManager: () => ({
    getProjectPackageIds: () => new Set(mocks.loadedRoots.keys()),
    getLoader: () => ({
      getStatus: (id: string) => (mocks.loadedRoots.has(id) ? { packageId: id, packageRoot: mocks.loadedRoots.get(id) } : undefined),
    }),
  }),
}));

import { POST as mintPost, PATCH as heartbeatPatch } from '../[slug]/app-scope/route';
import { handlePackageAppAssetGet } from '@/server/packages/packageAppAssetGet';
import { handlePackageAppPubGet } from '@/server/packages/packageAppPubGet';
import { getPackageAssetScopeAuthority } from '@/server/packages/PackageAssetScopeAuthority';

const AUTHORITY_KEY = Symbol.for('@neuralis/neuralis/package-asset-scope-authority/v1');
const PACKAGE_ID = 'example-package';
const SESSION = { userId: 'user-1', projectId: 'proj-1', role: 'member', grantedFeatures: ['core.chat'] };

/** A real 2×2 RGBA PNG (signature, IHDR, IDAT, IEND), built with the stdlib. */
function makePng(): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.from([0, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 0, 255, 255, 255, 255, 255, 255]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PNG = makePng();
let packageRoot = '';
let outsideDir = '';

function makeImage(overrides: Record<string, unknown> = {}) {
  return {
    packageId: PACKAGE_ID,
    dockId: 'example.dock',
    imagePath: 'app/shared/icon.png',
    sharedRel: 'icon.png',
    trust: 'untrusted',
    fingerprint: 'icon-fp-1',
    generation: 'gen-1',
    ...overrides,
  };
}

function mintReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost:3100/api/packages/${PACKAGE_ID}/app-scope`, {
    method: 'POST',
    headers: { 'x-project-id': 'proj-1', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ slug: PACKAGE_ID }) };
const getReq = (): NextRequest => new NextRequest('http://localhost:3100/api/package-app/_scope/x/shared/icon.png');

async function mintIcon(): Promise<{ handle: string; url: string }> {
  const res = await mintPost(mintReq({ purpose: 'icon', surfaceKind: 'dock', surfaceId: 'example.dock' }), params);
  expect(res.status).toBe(200);
  return (await res.json()) as { handle: string; url: string };
}

/** The GET for a minted url's `{namespace}/…` tail. */
function getUrl(handle: string, url: string): Promise<Response> {
  const prefix = `/api/package-app/_scope/${handle}/`;
  expect(url.startsWith(prefix)).toBe(true);
  return handlePackageAppAssetGet(getReq(), handle, url.slice(prefix.length).split('/'));
}

beforeAll(async () => {
  packageRoot = await mkdtemp(join(tmpdir(), 'nrs-icon-scope-'));
  const shared = join(packageRoot, 'app', 'shared');
  await mkdir(join(packageRoot, 'app', 'surfaces', 'widget', 'w'), { recursive: true });
  await mkdir(shared, { recursive: true });
  await writeFile(join(shared, 'icon.png'), PNG);
  await writeFile(join(shared, 'other.png'), PNG);
  await writeFile(join(shared, 'disguised.png'), '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  await writeFile(join(shared, 'document.png'), '<!doctype html><html><body>DOC</body></html>');
  await writeFile(join(shared, 'big.png'), Buffer.concat([PNG, Buffer.alloc(256 * 1024)]));
  await writeFile(join(packageRoot, 'app', 'surfaces', 'widget', 'w', 'index.html'), '<html>W</html>');
  outsideDir = join(packageRoot, '..', `nrs-icon-outside-${process.pid}`);
  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(outsideDir, 'secret.png'), PNG);
  await symlink(join(outsideDir, 'secret.png'), join(shared, 'escape.png'));
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
  mocks.resolveVisiblePackageDockImage.mockResolvedValue(makeImage());
  mocks.loadedRoots = new Map([[PACKAGE_ID, packageRoot]]);
  mocks.listPackages.mockReturnValue([{ id: PACKAGE_ID }]);
});

describe('icon mint', () => {
  it('mints for the DECLARED picture only — the url names the declared file, no identity', async () => {
    const { handle, url } = await mintIcon();
    expect(url).toBe(`/api/package-app/_scope/${handle}/shared/icon.png`);
    expect(url).not.toContain(PACKAGE_ID);
    expect(url).not.toContain('proj-1');
    const record = getPackageAssetScopeAuthority().get(handle);
    expect(record).toMatchObject({ purpose: 'icon', surfaceKind: 'dock', surfaceId: 'example.dock', entryRelPath: 'icon.png' });
    expect(mocks.resolveVisiblePackageSurface).not.toHaveBeenCalled();
  });

  it('a caller-supplied path is never read: the body names a dock id, nothing else is consulted', async () => {
    const res = await mintPost(
      mintReq({ purpose: 'icon', surfaceKind: 'dock', surfaceId: 'example.dock', path: '../../etc/passwd', entryUrl: 'x' }),
      params,
    );
    const body = (await res.json()) as { url: string };
    expect(body.url.endsWith('/shared/icon.png')).toBe(true);
  });

  it('uniform 404 for a not-visible dock, a wrong kind pairing, an unknown purpose or a missing root', async () => {
    mocks.resolveVisiblePackageDockImage.mockResolvedValueOnce(null);
    expect((await mintPost(mintReq({ purpose: 'icon', surfaceKind: 'dock', surfaceId: 'example.dock' }), params)).status).toBe(404);
    expect((await mintPost(mintReq({ purpose: 'icon', surfaceKind: 'widget', surfaceId: 'w' }), params)).status).toBe(404);
    expect((await mintPost(mintReq({ purpose: 'favicon', surfaceKind: 'widget', surfaceId: 'w' }), params)).status).toBe(404);
    mocks.loadedRoots = new Map();
    expect((await mintPost(mintReq({ purpose: 'icon', surfaceKind: 'dock', surfaceId: 'example.dock' }), params)).status).toBe(404);
  });

  it('128 live documents + an icon → ONE fixed 429; every document scope survives', async () => {
    const authority = getPackageAssetScopeAuthority();
    const documents = Array.from({ length: 128 }, (_, i) => authority.mint({
      userId: 'user-1', projectId: 'proj-1', packageId: PACKAGE_ID, purpose: 'document',
      surfaceKind: 'widget', surfaceId: `w${i}`, renderer: 'iframe', trust: 'untrusted',
      fingerprint: 'fp', generation: 'gen-1', surfaceRoot: packageRoot, entryRelPath: 'index.html',
    }));
    const res = await mintPost(mintReq({ purpose: 'icon', surfaceKind: 'dock', surfaceId: 'example.dock' }), params);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Icon unavailable', code: 'icon_capacity' });
    expect(authority.size()).toBe(128);
    expect(documents.every((document) => authority.get(document.handle) !== null)).toBe(true);
  });
});

describe('icon GET on the authenticated lane', () => {
  it('serves the valid raster with the SNIFFED type and the lane floor headers', async () => {
    const { handle, url } = await mintIcon();
    const res = await getUrl(handle, url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it.each([
    ['disguised SVG under a .png name', 'disguised.png'],
    ['HTML document under a .png name', 'document.png'],
    ['file over the 256 KiB raster floor', 'big.png'],
  ])('refuses a %s (404), its valid twin serves', async (_label, file) => {
    mocks.resolveVisiblePackageDockImage.mockResolvedValue(makeImage({ sharedRel: file, imagePath: `app/shared/${file}` }));
    const { handle, url } = await mintIcon();
    const res = await getUrl(handle, url);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('svg');
  });

  it('a symlink escaping app/shared is refused like any escape (403), never served', async () => {
    mocks.resolveVisiblePackageDockImage.mockResolvedValue(makeImage({ sharedRel: 'escape.png', imagePath: 'app/shared/escape.png' }));
    const { handle, url } = await mintIcon();
    const res = await getUrl(handle, url);
    expect(res.status).toBe(403);
  });

  it('the handle opens exactly ONE file: a sibling picture, the surface namespace and a traversal are refused', async () => {
    const { handle } = await mintIcon();
    expect((await handlePackageAppAssetGet(getReq(), handle, ['shared', 'other.png'])).status).toBe(404);
    expect((await handlePackageAppAssetGet(getReq(), handle, ['surface', 'icon.png'])).status).toBe(404);
    expect((await handlePackageAppAssetGet(getReq(), handle, ['shared', '..', 'surfaces', 'widget', 'w', 'index.html'])).status).not.toBe(200);
    // The handle still serves its own file afterwards (refusals are not revocations).
    expect((await handlePackageAppAssetGet(getReq(), handle, ['shared', 'icon.png'])).status).toBe(200);
  });

  it('a foreign principal gets 403; feature loss and a changed declaration revoke with 410', async () => {
    const { handle, url } = await mintIcon();
    mocks.resolveSessionContext.mockResolvedValueOnce({ ...SESSION, userId: 'user-2' });
    expect((await getUrl(handle, url)).status).toBe(403);

    mocks.resolveVisiblePackageDockImage.mockResolvedValueOnce(makeImage({ fingerprint: 'icon-fp-2' }));
    expect((await getUrl(handle, url)).status).toBe(410);
    expect(getPackageAssetScopeAuthority().get(handle)).toBeNull();

    const second = await mintIcon();
    mocks.resolveVisiblePackageDockImage.mockResolvedValueOnce(null);
    expect((await getUrl(second.handle, second.url)).status).toBe(410);
  });

  it('the heartbeat rechecks through the dock resolver, never the surface one', async () => {
    const { handle } = await mintIcon();
    const patch = (body: Record<string, unknown>) => new NextRequest('http://localhost:3100/api/packages/x/app-scope', {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect((await heartbeatPatch(patch({ handle }))).status).toBe(200);
    expect(mocks.resolveVisiblePackageSurface).not.toHaveBeenCalled();
    mocks.resolveVisiblePackageDockImage.mockResolvedValueOnce(makeImage({ trust: 'trusted' }));
    expect((await heartbeatPatch(patch({ handle }))).status).toBe(410);
  });
});

describe('the public lane refuses icon scopes by purpose', () => {
  it('404 on _pub for an icon record, though the file exists and is a valid raster', async () => {
    const { handle } = await mintIcon();
    const record = getPackageAssetScopeAuthority().get(handle);
    expect(record).not.toBeNull();
    const res = await handlePackageAppPubGet(
      new NextRequest('http://localhost:3100/api/package-app/_pub/t/shared/icon.png'),
      record!.pubToken,
      ['shared', 'icon.png'],
    );
    expect(res.status).toBe(404);
    expect(mocks.listPackages).not.toHaveBeenCalled();
  });
});
