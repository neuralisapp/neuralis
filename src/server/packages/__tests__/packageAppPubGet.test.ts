/**
 * handlePackageAppPubGet — the SESSION-FREE package subresource lane.
 *
 * The whole prohibition matrix lives here: the uniform 404 dictionary (no 401 /
 * 403 / 410 anywhere), the document-extension refusal, containment, the
 * caller-free generation recheck, the per-file byte cap, the per-scope
 * file/byte budget, the exact header set, and the proof that the lane reads no
 * session at all.
 *
 * NOTE the deliberate mock shape: the authority module is mocked so that
 * `getPackageAssetScopeAuthority()` returns an instance we construct DIRECTLY
 * with an injected clock. The real accessor is a globalThis-anchored singleton
 * that arms a live interval — using it would leak state across test files.
 */

import { NextRequest } from 'next/server';
import type { PackageDefinition } from '@neuralis/package-system/contracts';
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ID = 'p.proj-1.project.example-package';

const mocks = vi.hoisted(() => ({
  ensureProjectPackagesLoaded: vi.fn(async () => undefined),
  listPackages: vi.fn<() => unknown[]>(() => []),
  getStatus: vi.fn<() => unknown>(() => undefined),
  warn: vi.fn(),
  authority: undefined as unknown,
  /** Set to simulate an I/O failure on the already-open descriptor. */
  readFileFailure: undefined as undefined | (() => never),
  /** Descriptor bookkeeping — the fd-leak guard. */
  opened: [] as unknown[],
  closed: [] as unknown[],
}));

// `open` is wrapped, NOT replaced: the real descriptor is handed back so
// containment, the realpath resolution and the stat all stay genuine. The
// wrapper only (a) records open/close so a leaked fd is assertable, and (b) lets
// a test fail the read on an ALREADY-OPEN handle — the one remaining race the
// lane must still fold into its uniform 404.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    default: actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      mocks.opened.push(handle);
      const realClose = handle.close.bind(handle);
      const realReadFile = handle.readFile.bind(handle);
      Object.defineProperty(handle, 'close', {
        configurable: true,
        value: async () => {
          mocks.closed.push(handle);
          return realClose();
        },
      });
      Object.defineProperty(handle, 'readFile', {
        configurable: true,
        value: async (...readArgs: unknown[]) =>
          mocks.readFileFailure
            ? mocks.readFileFailure()
            : realReadFile(...(readArgs as Parameters<typeof realReadFile>)),
      });
      return handle;
    },
  };
});

vi.mock('../projectPackages', () => ({
  ensureProjectPackagesLoaded: mocks.ensureProjectPackagesLoaded,
}));

vi.mock('../runtime', () => ({
  getCommunityPackageRegistry: () => ({ listPackages: mocks.listPackages }),
  getCommunityPackageRuntime: vi.fn(),
}));

vi.mock('../PackageRuntimeManager', () => ({
  getPackageRuntimeManager: () => ({
    getLoader: () => ({ getStatus: mocks.getStatus }),
  }),
}));

vi.mock('../../host/bootstrap', () => ({
  BUILTIN_PACKAGE_IDS: new Set(['@neuralis/agent-core']),
}));

vi.mock('../../store/ProjectStore', () => ({
  getProjectById: vi.fn(async () => ({ id: 'proj-1' })),
}));

vi.mock('../../logging/setup', () => ({
  getLogger: () => ({
    child: () => ({ info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn() }),
  }),
}));

vi.mock('../PackageAssetScopeAuthority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../PackageAssetScopeAuthority')>()),
  getPackageAssetScopeAuthority: () => mocks.authority,
}));

import { handlePackageAppPubGet } from '../packageAppPubGet';
import {
  PackageAssetScopeAuthority,
  DEFAULT_IDLE_TTL_MS,
  type PackageAssetScopeInit,
  type PackageAssetScopeRecord,
} from '../PackageAssetScopeAuthority';
import { getDefinitionGeneration } from '../packageVisibility';
import {
  PACKAGE_APP_ASSET_MAX_BYTES,
  PACKAGE_APP_PUB_MAX_FILES,
  PACKAGE_APP_PUB_MAX_TOTAL_BYTES,
  PACKAGE_APP_PUB_TOUCH_MAX_AGE_MS,
} from '../packageAppAssetCsp';

let packageRoot = '';
let surfaceRoot = '';
let sharedRoot = '';
let siblingRoot = '';
let outsideDir = '';

/** Marker written OUTSIDE the package root — a response containing it is a leak. */
const OUTSIDE_SENTINEL = '{"marker":"PUB-LANE-OUTSIDE-SENTINEL"}';

let authority: PackageAssetScopeAuthority;
let clock = 1_000_000;
/** The registry definition the scope is minted against (identity = generation). */
let definition: PackageDefinition;

/** A minimal stand-in — only object IDENTITY drives the generation stamp. */
function makeDefinition(): PackageDefinition {
  return { id: PACKAGE_ID } as unknown as PackageDefinition;
}

function makeInit(overrides: Partial<PackageAssetScopeInit> = {}): PackageAssetScopeInit {
  return {
    userId: 'user-1',
    projectId: 'proj-1',
    agentId: undefined,
    packageId: PACKAGE_ID,
    surfaceKind: 'widget',
    surfaceId: 'example_workspace',
    renderer: 'iframe',
    trust: 'untrusted',
    fingerprint: 'fp-1',
    generation: getDefinitionGeneration(definition),
    surfaceRoot,
    sharedRoot,
    entryRelPath: 'index.html',
    ...overrides,
  };
}

/** A GET with NO cookie, NO authorization header, NO query — the real shape. */
function pubReq(token: string, path: string): NextRequest {
  return new NextRequest(`http://localhost:3100/api/package-app/_pub/${token}/${path}`);
}

async function get(record: PackageAssetScopeRecord, path: string): Promise<Response> {
  return handlePackageAppPubGet(pubReq(record.pubToken, path), record.pubToken, path.split('/'));
}

/** No error surface may reflect the runtime package id or a filesystem path. */
async function expectNonLeaking(res: Response): Promise<void> {
  const text = JSON.stringify([...res.headers.entries()]) + (await res.clone().text());
  expect(text).not.toContain('example-package');
  expect(text).not.toContain(packageRoot);
  expect(text).not.toContain('/app/surfaces');
  // A refusal here can be TRANSIENT (a generation recheck during a package
  // reload), and a heuristically cached transient 404 would pin a live widget's
  // subresource dead. Asserted in the ONE helper every refusal path runs through.
  expect(res.headers.get('cache-control')).toBe('no-store');
  // …and the 404s stay OPAQUE to a cross-origin reader: unlike the 200, they
  // carry no ACAO / CORP. This is measured and intended, not an oversight.
  expect(res.headers.get('access-control-allow-origin')).toBeNull();
  expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  expect(res.headers.get('cross-origin-resource-policy')).toBeNull();
}

/**
 * EVERY descriptor this lane opened has been closed.
 *
 * This is not decoration. The per-scope budget check sits BETWEEN the open and
 * the read and has an EARLY RETURN on exhaustion; leaking there would burn one
 * fd per refused request on the one lane that has no session and no caller to
 * rate-limit — a denial of service created BY the containment fix. Without this
 * assertion the `finally` in the handler is unenforced and the next refactor
 * drops it.
 */
function expectNoLeakedHandles(): void {
  expect(mocks.closed.length).toBe(mocks.opened.length);
}

beforeAll(async () => {
  packageRoot = await mkdtemp(join(tmpdir(), 'nrs-pub-lane-'));
  surfaceRoot = join(packageRoot, 'app', 'surfaces', 'widget', 'example_workspace');
  siblingRoot = join(packageRoot, 'app', 'surfaces', 'widget', 'hidden_widget');
  sharedRoot = join(packageRoot, 'app', 'shared');
  await mkdir(join(surfaceRoot, 'assets'), { recursive: true });
  await mkdir(siblingRoot, { recursive: true });
  await mkdir(sharedRoot, { recursive: true });
  await writeFile(join(surfaceRoot, 'index.html'), '<html>ENTRY</html>');
  await writeFile(join(surfaceRoot, 'icon.svg'), '<svg onload="alert(1)"></svg>');
  await writeFile(join(surfaceRoot, 'page.htm'), '<html>SECOND-PAGE</html>');
  await writeFile(join(surfaceRoot, 'code.ts'), 'export const secret = 1;');
  await writeFile(join(surfaceRoot, 'assets', 'app.css'), '.ok{color:red}');
  await writeFile(join(surfaceRoot, 'assets', 'app.js'), 'globalThis.__ok = 1;');
  await writeFile(join(sharedRoot, 'theme.css'), '.shared{}');
  await writeFile(join(siblingRoot, 'secret.css'), '.sibling-secret{}');
  await writeFile(join(packageRoot, 'app', 'root-secret.css'), '.app-root-secret{}');
  await writeFile(join(surfaceRoot, 'huge.css'), 'x'.repeat(PACKAGE_APP_ASSET_MAX_BYTES + 1));
  // A directory whose name ends in an allowlisted extension — the `not_file`
  // arm must answer the same uniform 404 as a missing file.
  await mkdir(join(surfaceRoot, 'dir.css'), { recursive: true });

  // Symlink escapes. The sentinel lives OUTSIDE the package root entirely, so a
  // row that serves it proves a real escape rather than a name collision.
  outsideDir = join(packageRoot, '..', `nrs-pub-outside-${process.pid}`);
  await mkdir(outsideDir, { recursive: true });
  await writeFile(join(outsideDir, 'secret.json'), OUTSIDE_SENTINEL);
  await writeFile(join(outsideDir, 'sentinel.json'), OUTSIDE_SENTINEL);
  await symlink(join(outsideDir, 'secret.json'), join(surfaceRoot, 'data.json'));
  await symlink(outsideDir, join(surfaceRoot, 'leak'));
  await symlink(join(outsideDir, 'secret.json'), join(sharedRoot, 'shared-leak.json'));
  // …and the legitimate counterpart: a link whose target is INSIDE the root.
  await symlink(join(surfaceRoot, 'assets', 'app.css'), join(surfaceRoot, 'alias.css'));
});

afterAll(async () => {
  await rm(packageRoot, { recursive: true, force: true });
  if (outsideDir) await rm(outsideDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readFileFailure = undefined;
  mocks.opened.length = 0;
  mocks.closed.length = 0;
  clock = 1_000_000;
  authority = new PackageAssetScopeAuthority({ now: () => clock });
  mocks.authority = authority;
  // A NEW object each run ⇒ a fresh WeakMap generation stamp per test.
  definition = makeDefinition();
  mocks.listPackages.mockReturnValue([definition]);
  mocks.getStatus.mockReturnValue(undefined);
  mocks.ensureProjectPackagesLoaded.mockResolvedValue(undefined);
});

describe('handlePackageAppPubGet — the happy path', () => {
  it('serves an allowlisted surface subresource with NO session of any kind', async () => {
    const record = authority.mint(makeInit());
    const res = await get(record, 'surface/assets/app.css');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('.ok{color:red}');
    // Nothing in this file mocks a session resolver, a cookie or an agent
    // scope — a 200 here IS the proof that the lane reads none of them.
  });

  it('serves the shared namespace too', async () => {
    const record = authority.mint(makeInit());
    const res = await get(record, 'shared/theme.css');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('.shared{}');
  });

  it('a served file TOUCHES the scope so a big bundle cannot expire mid-load', async () => {
    const record = authority.mint(makeInit());
    // Inside the pub-touch window the lane refreshes the idle clock, so a load
    // that spans the idle TTL cannot expire underneath itself.
    clock += PACKAGE_APP_PUB_TOUCH_MAX_AGE_MS - 1;
    expect((await get(record, 'surface/assets/app.css')).status).toBe(200);
    expect(record.lastSeenAt).toBe(clock);
  });

  it('serves .svg — the lane CSP rule, not the extension, is the anti-navigation floor', async () => {
    const record = authority.mint(makeInit());
    const res = await get(record, 'surface/icon.svg');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8');
  });

  it('PAST the pub-touch window it still SERVES but stops extending the scope', async () => {
    const record = authority.mint(makeInit());
    const mintedAt = record.lastSeenAt;
    clock += PACKAGE_APP_PUB_TOUCH_MAX_AGE_MS + 1;
    expect((await get(record, 'surface/assets/app.css')).status).toBe(200);
    // The bound is on LIFE-EXTENSION, not on serving: a legitimately open
    // widget's late-loaded chunks must still arrive.
    expect(record.lastSeenAt).toBe(mintedAt);
  });

  it('a leaked token alone cannot keep a scope alive past the idle TTL', async () => {
    const record = authority.mint(makeInit());
    // Traffic on the public lane ONLY (the client is gone — no heartbeat).
    for (let i = 0; i < 6; i += 1) {
      clock += DEFAULT_IDLE_TTL_MS / 2;
      await get(record, 'surface/assets/app.css');
    }
    expect((await get(record, 'surface/assets/app.css')).status).toBe(404);
    expect(authority.getByPubToken(record.pubToken)).toBeNull();
  });
});

describe('handlePackageAppPubGet — the uniform 404 dictionary', () => {
  it('an unknown token → 404 and NO registry work at all (no work amplifier)', async () => {
    const res = await handlePackageAppPubGet(
      pubReq('does-not-exist', 'surface/assets/app.css'),
      'does-not-exist',
      ['surface', 'assets', 'app.css'],
    );
    expect(res.status).toBe(404);
    await expectNonLeaking(res);
    expect(mocks.ensureProjectPackagesLoaded).not.toHaveBeenCalled();
    expect(mocks.listPackages).not.toHaveBeenCalled();
  });

  it('an EXPIRED scope → 404, never a 410', async () => {
    const record = authority.mint(makeInit());
    clock += DEFAULT_IDLE_TTL_MS + 1;
    const res = await get(record, 'surface/assets/app.css');
    expect(res.status).toBe(404);
    await expectNonLeaking(res);
  });

  it('the entry-lane HANDLE is not a pub token → 404', async () => {
    const record = authority.mint(makeInit());
    const res = await handlePackageAppPubGet(
      pubReq(record.handle, 'surface/assets/app.css'),
      record.handle,
      ['surface', 'assets', 'app.css'],
    );
    expect(res.status).toBe(404);
  });

  it('.html and .htm → 404 (the lane never serves a framable DOCUMENT)', async () => {
    const record = authority.mint(makeInit());
    for (const rel of ['surface/index.html', 'surface/page.htm']) {
      const res = await get(record, rel);
      expect(res.status).toBe(404);
      await expectNonLeaking(res);
    }
    // The extension gate runs BEFORE any fs or registry work.
    expect(mocks.listPackages).not.toHaveBeenCalled();
  });

  it('source-code extensions → 404', async () => {
    const record = authority.mint(makeInit());
    expect((await get(record, 'surface/code.ts')).status).toBe(404);
  });

  it('a failed read on the OPEN descriptor answers the SAME uniform 404, never a framework 500', async () => {
    const record = authority.mint(makeInit());
    const ok = await get(record, 'surface/assets/app.css');
    expect(ok.status).toBe(200);
    const okBody = await ok.text();

    // The cap-stat and the read now share ONE descriptor, so the PATH races
    // (deleted, replaced, symlinked-over between the two) are closed rather than
    // caught. What is left is an I/O failure on an open file, and it must still
    // land inside this lane's single-404 vocabulary instead of escaping as a
    // framework 500 that would distinguish "was here" from "never existed".
    mocks.readFileFailure = () => {
      throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    };
    const raced = await get(record, 'surface/assets/app.js');
    expect(raced.status).toBe(404);
    await expectNonLeaking(raced);

    // Indistinguishable from a never-existed path: same body, and none of the
    // success-path headers (which would themselves be a liveness signal).
    const missing = await get(record, 'surface/never-existed.css');
    expect(missing.status).toBe(404);
    expect(await raced.clone().text()).toBe(await missing.clone().text());
    expect(raced.headers.get('content-length')).toBe(missing.headers.get('content-length'));
    expect(raced.headers.has('access-control-allow-origin')).toBe(false);
    expect(await raced.clone().text()).not.toBe(okBody);
  });

  it('a wrong namespace → 404', async () => {
    const record = authority.mint(makeInit());
    for (const rel of ['app/root-secret.css', 'assets/app.css', 'SURFACE/assets/app.css']) {
      expect((await get(record, rel)).status).toBe(404);
    }
  });

  it('a bare namespace with no file → 404', async () => {
    const record = authority.mint(makeInit());
    expect((await get(record, 'surface')).status).toBe(404);
  });

  it('path traversal → 404, and it is NOT the auth lane 403', async () => {
    const record = authority.mint(makeInit());
    for (const rel of [
      'surface/../hidden_widget/secret.css',
      'surface/assets/../../hidden_widget/secret.css',
      'surface/../../../root-secret.css',
    ]) {
      const res = await get(record, rel);
      // The authenticated lane answers 403 on a containment escape. That
      // existence-confirming status must NEVER leak into this lane.
      expect(res.status).toBe(404);
      expect(res.status).not.toBe(403);
      await expectNonLeaking(res);
    }
  });

  it('a missing shared root → 404 (same status as an escape — non-enumerating)', async () => {
    const record = authority.mint(makeInit({ sharedRoot: undefined }));
    const res = await get(record, 'shared/theme.css');
    expect(res.status).toBe(404);
  });

  it("another package's surface cannot be guessed through this record → 404", async () => {
    const record = authority.mint(makeInit());
    // Even a well-formed relative path under a SIBLING surface is outside the
    // record's exact root, and the record's roots are server-derived at mint.
    expect((await get(record, 'surface/../hidden_widget/secret.css')).status).toBe(404);
    // A missing file inside the correct root is the same uniform 404.
    expect((await get(record, 'surface/assets/nope.css')).status).toBe(404);
  });

  it('a DIRECTORY that happens to end in an allowlisted extension → 404', async () => {
    const record = authority.mint(makeInit());
    expect((await get(record, 'surface/dir.css')).status).toBe(404);
  });

  it('every refusal body is byte-identical (the dictionary has ONE word)', async () => {
    const record = authority.mint(makeInit());
    const bodies: string[] = [];
    for (const rel of [
      'surface/index.html',
      'surface/code.ts',
      'surface/../hidden_widget/secret.css',
      'surface/assets/nope.css',
      'surface/huge.css',
    ]) {
      const res = await get(record, rel);
      expect(res.status).toBe(404);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
  });
});

/**
 * SYMLINK CONTAINMENT — the lane's real-path half.
 *
 * This is the session-free lane: there is no caller to fall back on, so a link
 * planted under the surface root is the whole attack. Each escape row is paired
 * with the legitimate shape it must NOT break, and each response is checked for
 * the outside sentinel as well as for the status.
 */
describe('handlePackageAppPubGet — symlink containment', () => {
  async function expectNoSentinel(res: Response): Promise<void> {
    const text = JSON.stringify([...res.headers.entries()]) + (await res.clone().text());
    expect(text).not.toContain('PUB-LANE-OUTSIDE-SENTINEL');
    expect(text).not.toContain(outsideDir);
    expect(text).not.toContain('secret.json');
  }

  it('a FILE symlink pointing outside the surface root → 404, no sentinel', async () => {
    const record = authority.mint(makeInit());
    const res = await get(record, 'surface/data.json');
    expect(res.status).toBe(404);
    await expectNonLeaking(res);
    await expectNoSentinel(res);
    expectNoLeakedHandles();
  });

  it('an escape through an intermediate DIRECTORY symlink → 404, no sentinel', async () => {
    // The row that proves an lstat of the FINAL component is not enough: the
    // last segment here is a plain file, and only resolving the whole path
    // catches it.
    const record = authority.mint(makeInit());
    const res = await get(record, 'surface/leak/sentinel.json');
    expect(res.status).toBe(404);
    await expectNoSentinel(res);
    expectNoLeakedHandles();
  });

  it('the SHARED namespace is clamped the same way', async () => {
    const record = authority.mint(makeInit());
    const res = await get(record, 'shared/shared-leak.json');
    expect(res.status).toBe(404);
    await expectNoSentinel(res);
  });

  it('an escaping symlink consumes NO budget (it never reaches the insert)', async () => {
    const record = authority.mint(makeInit());
    expect((await get(record, 'surface/data.json')).status).toBe(404);
    expect((await get(record, 'surface/leak/sentinel.json')).status).toBe(404);
    expect(record.servedPublic.size).toBe(0);
  });

  it('a symlink whose target is INSIDE the root is still served', async () => {
    // The non-vacuum twin: a blanket symlink refusal would fail here, and so
    // would a real-path check that compared against a lexically-stored root.
    const record = authority.mint(makeInit());
    const res = await get(record, 'surface/alias.css');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('.ok{color:red}');
    expectNoLeakedHandles();
  });
});

describe('handlePackageAppPubGet — the descriptor is never leaked', () => {
  it('closes the handle on the BUDGET-EXHAUSTED early return', async () => {
    // The budget check sits BETWEEN the open and the read, and it returns early.
    // One leaked fd per refused request, on a lane with no session and no caller
    // to rate-limit, would be a DoS introduced by the containment fix itself.
    const record = authority.mint(makeInit());
    for (let i = 0; i < PACKAGE_APP_PUB_MAX_FILES; i += 1) {
      record.servedPublic.set(`/seeded/file-${i}.css`, 1);
    }
    const res = await get(record, 'surface/assets/app.css');
    expect(res.status).toBe(404);
    expect(mocks.opened.length).toBe(1);
    expectNoLeakedHandles();
  });

  it('closes the handle on the byte-budget refusal too', async () => {
    const record = authority.mint(makeInit());
    record.servedPublic.set('/seeded/big.css', PACKAGE_APP_PUB_MAX_TOTAL_BYTES - 13);
    expect((await get(record, 'surface/assets/app.css')).status).toBe(404);
    expect(mocks.opened.length).toBe(1);
    expectNoLeakedHandles();
  });

  it('closes the handle on the success path AND on a read failure', async () => {
    const record = authority.mint(makeInit());
    expect((await get(record, 'surface/assets/app.css')).status).toBe(200);
    expectNoLeakedHandles();

    mocks.readFileFailure = () => {
      throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    };
    const res = await get(record, 'surface/assets/app.js');
    expect(res.status).toBe(404);
    expectNoLeakedHandles();
  });

  it('opens NOTHING for a request refused before containment', async () => {
    const record = authority.mint(makeInit());
    for (const rel of ['surface/index.html', 'surface/code.ts', 'surface/../hidden_widget/secret.css']) {
      expect((await get(record, rel)).status).toBe(404);
    }
    expect(mocks.opened.length).toBe(0);
  });
});

describe('handlePackageAppPubGet — the caller-free generation recheck', () => {
  it('generation drift → 404 AND the whole scope is revoked (the entry lane 410s next)', async () => {
    const record = authority.mint(makeInit());
    // A package update/reload replaces the definition OBJECT ⇒ new stamp.
    mocks.listPackages.mockReturnValue([makeDefinition()]);
    const res = await get(record, 'surface/assets/app.css');
    expect(res.status).toBe(404);
    await expectNonLeaking(res);
    expect(authority.getByPubToken(record.pubToken)).toBeNull();
    // The handle index is dropped too — the entry lane answers 410 afterwards.
    expect(authority.get(record.handle)).toBeNull();
  });

  it('the package gone from the registry (uninstall) → 404 + revoke', async () => {
    const record = authority.mint(makeInit());
    mocks.listPackages.mockReturnValue([]);
    expect((await get(record, 'surface/assets/app.css')).status).toBe(404);
    expect(authority.getByPubToken(record.pubToken)).toBeNull();
    expect(authority.get(record.handle)).toBeNull();
  });

  it("a loader status of 'error' → 404 (fail-closed, mirroring the entry lane)", async () => {
    const record = authority.mint(makeInit());
    mocks.getStatus.mockReturnValue({ status: 'error' });
    expect((await get(record, 'surface/assets/app.css')).status).toBe(404);
    // A transient load failure does NOT revoke — only package-side drift does.
    expect(authority.getByPubToken(record.pubToken)).not.toBeNull();
  });

  it("a status of 'partial' still serves (runtime-unavailable ≠ invalid assets)", async () => {
    const record = authority.mint(makeInit());
    mocks.getStatus.mockReturnValue({ status: 'partial' });
    expect((await get(record, 'surface/assets/app.css')).status).toBe(200);
  });
});

describe('handlePackageAppPubGet — the caps', () => {
  it('a file over the per-file byte cap → 404 (checked on the stat, before the read)', async () => {
    const record = authority.mint(makeInit());
    const res = await get(record, 'surface/huge.css');
    expect(res.status).toBe(404);
    await expectNonLeaking(res);
    expect(mocks.warn).toHaveBeenCalled();
    // An over-cap file must not consume budget either.
    expect(record.servedPublic.size).toBe(0);
  });

  it('accumulates DISTINCT resolved paths with their stat sizes', async () => {
    const record = authority.mint(makeInit());
    expect((await get(record, 'surface/assets/app.css')).status).toBe(200);
    expect((await get(record, 'surface/assets/app.js')).status).toBe(200);
    expect(record.servedPublic.size).toBe(2);
    expect([...record.servedPublic.values()]).toEqual([14, 20]);
  });

  it('a REPEAT request for an already-served path consumes NO budget', async () => {
    const record = authority.mint(makeInit());
    expect((await get(record, 'surface/assets/app.css')).status).toBe(200);
    expect(record.servedPublic.size).toBe(1);
    // Same file, three more times, including an equivalent spelling — the key
    // is the RESOLVED absolute path, so `a/./b` and `a/b` are ONE entry.
    expect((await get(record, 'surface/assets/app.css')).status).toBe(200);
    expect((await get(record, 'surface/./assets/app.css')).status).toBe(200);
    expect((await get(record, 'surface/assets/sub/../app.css')).status).toBe(200);
    expect(record.servedPublic.size).toBe(1);
  });

  /**
   * The charge is deliberately synchronous and BEFORE the read (that ordering is
   * what stops two concurrent requests from both slipping past the cap), so the
   * failed-read path has to give back exactly what it took. Both directions are
   * asserted, because only one of them is a tightening: refunding a charge this
   * request made is a correction, while touching an entry an EARLIER request
   * paid for — and possibly delivered — would be a loosening.
   */
  it('REFUNDS its own charge on a read failure, but never an earlier one', async () => {
    const record = authority.mint(makeInit());
    expect((await get(record, 'surface/assets/app.css')).status).toBe(200);
    expect(record.servedPublic.size).toBe(1);

    const fail = () => {
      throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    };

    // (a) a NEW path whose read fails: charged, then refunded — the map is back
    //     to just the one entry that was actually delivered.
    mocks.readFileFailure = fail;
    expect((await get(record, 'surface/assets/app.js')).status).toBe(404);
    expect(record.servedPublic.size).toBe(1);
    expect([...record.servedPublic.values()]).toEqual([14]);

    // (b) an ALREADY-SERVED path whose read fails: this request charged
    //     nothing, so it must refund nothing.
    expect((await get(record, 'surface/assets/app.css')).status).toBe(404);
    expect(record.servedPublic.size).toBe(1);
    expect([...record.servedPublic.values()]).toEqual([14]);

    // The refund is an accounting correction, not a way to re-serve for free:
    // once the read succeeds again the path is still the same single entry.
    mocks.readFileFailure = undefined;
    expect((await get(record, 'surface/assets/app.css')).status).toBe(200);
    expect(record.servedPublic.size).toBe(1);
    expectNoLeakedHandles();
  });

  it('the 65th DISTINCT file → 404, and the map never exceeds the cap', async () => {
    const record = authority.mint(makeInit());
    // Seed the budget to exactly the cap (check-then-insert: the map is only
    // ever grown after the check, so it can never hold more than the cap).
    for (let i = 0; i < PACKAGE_APP_PUB_MAX_FILES; i += 1) {
      record.servedPublic.set(`/seeded/file-${i}.css`, 1);
    }
    expect(record.servedPublic.size).toBe(PACKAGE_APP_PUB_MAX_FILES);
    const res = await get(record, 'surface/assets/app.css');
    expect(res.status).toBe(404);
    await expectNonLeaking(res);
    expect(mocks.warn).toHaveBeenCalled();
    expect(record.servedPublic.size).toBe(PACKAGE_APP_PUB_MAX_FILES);
    expect(record.servedPublic.size).toBeLessThanOrEqual(PACKAGE_APP_PUB_MAX_FILES);
  });

  it('an already-served path still serves once the file cap is reached', async () => {
    const record = authority.mint(makeInit());
    expect((await get(record, 'surface/assets/app.css')).status).toBe(200);
    for (let i = 0; i < PACKAGE_APP_PUB_MAX_FILES - 1; i += 1) {
      record.servedPublic.set(`/seeded/file-${i}.css`, 1);
    }
    expect(record.servedPublic.size).toBe(PACKAGE_APP_PUB_MAX_FILES);
    // A re-render of the SAME bundle must not start failing at the cap.
    expect((await get(record, 'surface/assets/app.css')).status).toBe(200);
    // …but a new distinct path does.
    expect((await get(record, 'surface/assets/app.js')).status).toBe(404);
  });

  it('crossing the TOTAL byte budget → 404 without inserting', async () => {
    const record = authority.mint(makeInit());
    // 14 bytes of app.css would push the total past the ceiling.
    record.servedPublic.set('/seeded/big.css', PACKAGE_APP_PUB_MAX_TOTAL_BYTES - 13);
    const res = await get(record, 'surface/assets/app.css');
    expect(res.status).toBe(404);
    expect(mocks.warn).toHaveBeenCalled();
    expect(record.servedPublic.size).toBe(1);
  });

  it('a file that exactly FITS the remaining byte budget is served', async () => {
    const record = authority.mint(makeInit());
    record.servedPublic.set('/seeded/big.css', PACKAGE_APP_PUB_MAX_TOTAL_BYTES - 14);
    expect((await get(record, 'surface/assets/app.css')).status).toBe(200);
    expect(record.servedPublic.size).toBe(2);
  });
});

describe('handlePackageAppPubGet — the response floor', () => {
  it('carries EXACTLY the declared header set, with ACAO and no credentials', async () => {
    const record = authority.mint(makeInit());
    const res = await get(record, 'surface/assets/app.css');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8');
    // From the STAT size, not the buffer length.
    expect(res.headers.get('content-length')).toBe('14');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    // `ACAO: *` is only safe because the lane carries NO authentication —
    // pairing it with credentials would be the exact prohibited combination.
    expect(res.headers.has('access-control-allow-credentials')).toBe(false);
    // The pub token must never be echoed back in a header.
    expect(JSON.stringify([...res.headers.entries()])).not.toContain(record.pubToken);
  });

  it('serves the right MIME per extension', async () => {
    const record = authority.mint(makeInit());
    const js = await get(record, 'surface/assets/app.js');
    expect(js.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
  });

  it('touches through the ONE bounded method — never an unbounded refresh', async () => {
    const record = authority.mint(makeInit());
    const touch = vi.spyOn(authority, 'touch');
    await get(record, 'surface/assets/app.css');
    expect(touch).toHaveBeenCalledWith(record.handle, {
      maxAgeSinceCreationMs: PACKAGE_APP_PUB_TOUCH_MAX_AGE_MS,
    });
  });
});

describe('the pub token never leaves the server', () => {
  it('the mint/heartbeat response shape does not carry it', () => {
    // Derive-and-verify (same pattern as the cap-drift guard): the mint route
    // builds its JSON from an explicit field list. If a future edit spreads the
    // record instead, this fails loudly — the token may ONLY reach the frame
    // through a server-injected asset URL, never the host's own JavaScript.
    const routePath = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      'app',
      'api',
      'packages',
      '[slug]',
      'app-scope',
      'route.ts',
    );
    const source = readFileSync(routePath, 'utf-8');
    expect(source).not.toContain('pubToken');
    expect(source).toContain('handle: minted.handle');
  });
});
