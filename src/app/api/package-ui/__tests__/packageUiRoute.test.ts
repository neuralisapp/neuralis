/**
 * GET /api/package-ui/{hash}/{path} — the first-party UI module lane.
 *
 * Every security negative has its paired positive on the SAME table: a module
 * file is served (200, immutable, ETag = hash) and each row then changes ONE
 * thing — no session, an unknown or malformed hash, a `.map`, a traversal, a
 * symlink out of the tree, a package no longer first-party, a file over the cap.
 * The table is built by the REAL `buildUiAttachments` over a real tmp tree; only
 * the registry, the session and the cache accessor are stubbed.
 */

import { NextRequest } from 'next/server';
import type { PackageDefinition } from '@neuralis/package-system/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUiAttachments, type UiAttachments } from '@/server/packages/packageUiModules';

const PKG = '@acme/ui';

const mocks = vi.hoisted(() => ({
  user: { id: 'u1', email: 'u@x', name: 'U' } as { id: string; email: string; name: string } | null,
  definition: undefined as unknown,
  attachments: undefined as unknown,
}));

vi.mock('@/server/auth/session', () => ({ getSessionUser: async () => mocks.user }));
vi.mock('@/server/packages/runtime', () => ({
  ensureCommunityRuntime: async () => undefined,
  getCommunityPackageRegistry: () => ({
    getPackage: (id: string) => (id === PKG ? mocks.definition : undefined),
    listPackages: () => [],
  }),
}));
vi.mock('@/server/packages/packageUiModules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/packages/packageUiModules')>();
  return {
    ...actual,
    getUiAttachments: async () => mocks.attachments,
    // The real predicate also requires deps-discovery membership; the fixture
    // id is not a host dep, so trust alone stands in for it here.
    isFirstPartyBuiltin: (def: PackageDefinition | undefined) => def?.access?.trust === 'first-party',
  };
});

const { GET } = await import('../[hash]/[...path]/route');

let root: string;
let outside: string;
let attachments: UiAttachments;
let moduleHash: string;

function firstParty(): PackageDefinition {
  return {
    id: PKG,
    name: 'ui',
    version: '1.0.0',
    access: { trust: 'first-party' },
    app: { module: { entry: 'dist/app/host.js' } },
  } as unknown as PackageDefinition;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'neuralis-package-ui-'));
  outside = await mkdtemp(join(tmpdir(), 'neuralis-package-ui-outside-'));
  await mkdir(join(root, 'dist', 'app', 'chunks'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: PKG }));
  await writeFile(join(root, 'dist', 'app', 'host.js'), 'export function installAcmeHostComponents() {}\n');
  await writeFile(join(root, 'dist', 'app', 'chunks', 'a-1.js'), 'export const a = 1;\n');
  await writeFile(join(root, 'dist', 'app', 'host.js.map'), '{"version":3}');
  await writeFile(join(root, 'dist', 'app', 'shared-imports.json'), JSON.stringify({ version: 1, reactMajor: 19, imports: ['react'] }));
  await writeFile(join(root, 'dist', 'app', 'big.js'), Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
  await writeFile(join(outside, 'secret.js'), 'export const secret = 1;\n');
  await symlink(join(outside, 'secret.js'), join(root, 'dist', 'app', 'escape.js'));

  attachments = await buildUiAttachments({
    definitions: [firstParty()],
    resolveRoot: () => root,
    hostReactMajor: 19,
    compileSheet: async () => null,
    hostSources: [],
  });
  moduleHash = attachments.modules[0]?.hash ?? '';
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

beforeEach(() => {
  mocks.user = { id: 'u1', email: 'u@x', name: 'U' };
  mocks.definition = firstParty();
  mocks.attachments = attachments;
});

function get(hash: string, path: string[], headers?: Record<string, string>) {
  const req = new NextRequest(`http://localhost/api/package-ui/${hash}/${path.join('/')}`, { headers });
  return GET(req, { params: Promise.resolve({ hash, path }) });
}

describe('GET /api/package-ui/{hash}/{path}', () => {
  it('serves a module file with the immutable cache headers and ETag = hash (the paired positive)', async () => {
    expect(moduleHash).toMatch(/^[0-9a-f]{64}$/);
    const res = await get(moduleHash, ['host.js']);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(res.headers.get('etag')).toBe(`"${moduleHash}"`);
    expect(res.headers.get('content-type')).toContain('application/javascript');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toContain('installAcmeHostComponents');
    const chunk = await get(moduleHash, ['chunks', 'a-1.js']);
    expect(chunk.status).toBe(200);
  });

  it('answers 304 to a matching If-None-Match', async () => {
    const res = await get(moduleHash, ['host.js'], { 'if-none-match': `"${moduleHash}"` });
    expect(res.status).toBe(304);
  });

  it('refuses a request without an active session — 401', async () => {
    mocks.user = null;
    expect((await get(moduleHash, ['host.js'])).status).toBe(401);
  });

  it('answers 404 for an unknown hash and for a malformed one', async () => {
    expect((await get('0'.repeat(64), ['host.js'])).status).toBe(404);
    expect((await get('not-a-hash', ['host.js'])).status).toBe(404);
    expect((await get(moduleHash.toUpperCase(), ['host.js'])).status).toBe(404);
  });

  it('never serves a source map or the shared-import record — 404', async () => {
    expect((await get(moduleHash, ['host.js.map'])).status).toBe(404);
    expect((await get(moduleHash, ['shared-imports.json'])).status).toBe(404);
  });

  it('refuses a traversal and a symlink out of the module tree — 403', async () => {
    expect((await get(moduleHash, ['..', '..', 'package.js'])).status).toBe(403);
    expect((await get(moduleHash, ['escape.js'])).status).toBe(403);
  });

  it('refuses a package that is no longer first-party — 403', async () => {
    mocks.definition = { ...firstParty(), access: { trust: 'trusted' } };
    expect((await get(moduleHash, ['host.js'])).status).toBe(403);
  });

  it("enforces the lane's OWN per-file cap on the descriptor — 404", async () => {
    expect((await get(moduleHash, ['big.js'])).status).toBe(404);
  });

  it('serves the union sheet only under its file name', async () => {
    const css = Buffer.from('.p-2{padding:.5rem}');
    const sheetHash = 'a'.repeat(64);
    mocks.attachments = { ...attachments, table: new Map([[sheetHash, { kind: 'sheet', css }]]) };
    const res = await get(sheetHash, ['workspace.css']);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
    expect(res.headers.get('etag')).toBe(`"${sheetHash}"`);
    expect(await res.text()).toBe('.p-2{padding:.5rem}');
    expect((await get(sheetHash, ['other.css'])).status).toBe(404);
  });
});
