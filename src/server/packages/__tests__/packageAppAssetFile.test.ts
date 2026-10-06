/**
 * packageAppAssetFile — the Response-free primitives shared by the two
 * package-app asset lanes.
 *
 * The point of these tests is the SHAPE of the results, not a status code: the
 * authenticated lane answers 403 on a containment escape and 404 on a missing
 * root, while the session-free lane answers 404 for both. A helper that
 * returned a `Response`, or that collapsed the two containment reasons, would
 * silently change the landed lane's wire behaviour.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { constants as fsConstants, lstatSync } from 'node:fs';
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  PACKAGE_APP_ASSET_MIME_BY_EXT,
  PACKAGE_APP_PUB_DENIED_EXTS,
  PACKAGE_APP_PUB_MIME_BY_EXT,
  openContainedAssetFile,
  parseAssetRequest,
  resolveContainedAssetPath,
} from '../packageAppAssetFile';

const ROOT = `${sep}data${sep}projects${sep}p1${sep}_packages${sep}pkg${sep}app${sep}surfaces${sep}widget${sep}w`;

describe('parseAssetRequest', () => {
  it('accepts surface/* and shared/* with an allowlisted extension', () => {
    const surface = parseAssetRequest(['surface', 'index.html'], PACKAGE_APP_ASSET_MIME_BY_EXT);
    expect(surface).toEqual({
      ok: true,
      namespace: 'surface',
      rest: ['index.html'],
      mime: 'text/html; charset=utf-8',
    });
    const shared = parseAssetRequest(
      ['shared', 'css', 'theme.css'],
      PACKAGE_APP_ASSET_MIME_BY_EXT,
    );
    expect(shared).toEqual({
      ok: true,
      namespace: 'shared',
      rest: ['css', 'theme.css'],
      mime: 'text/css; charset=utf-8',
    });
  });

  // The four failure shapes, in the order the checks run.
  it('fails when there are fewer than two segments', () => {
    expect(parseAssetRequest([], PACKAGE_APP_ASSET_MIME_BY_EXT)).toEqual({ ok: false });
    expect(parseAssetRequest(['surface'], PACKAGE_APP_ASSET_MIME_BY_EXT)).toEqual({ ok: false });
  });

  it('fails on any namespace other than surface/shared', () => {
    for (const ns of ['app', 'SURFACE', '..', 'packages', '']) {
      expect(parseAssetRequest([ns, 'a.css'], PACKAGE_APP_ASSET_MIME_BY_EXT)).toEqual({
        ok: false,
      });
    }
  });

  it('fails on an extension outside the supplied allowlist (no fs touch)', () => {
    for (const name of ['handler.ts', 'view.tsx', 'package.json.bak', 'secret.env']) {
      expect(parseAssetRequest(['surface', name], PACKAGE_APP_ASSET_MIME_BY_EXT)).toEqual({
        ok: false,
      });
    }
  });

  it('fails when the last segment has no extension at all', () => {
    expect(parseAssetRequest(['surface', 'README'], PACKAGE_APP_ASSET_MIME_BY_EXT)).toEqual({
      ok: false,
    });
    expect(parseAssetRequest(['surface', ''], PACKAGE_APP_ASSET_MIME_BY_EXT)).toEqual({
      ok: false,
    });
  });

  it('matches the extension case-insensitively', () => {
    const parsed = parseAssetRequest(['surface', 'LOGO.PNG'], PACKAGE_APP_ASSET_MIME_BY_EXT);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.mime).toBe('image/png');
  });

  it('is allowlist-PARAMETRIC — the public table refuses documents the full one serves', () => {
    for (const name of ['index.html', 'page.htm']) {
      expect(parseAssetRequest(['surface', name], PACKAGE_APP_ASSET_MIME_BY_EXT).ok).toBe(true);
      expect(parseAssetRequest(['surface', name], PACKAGE_APP_PUB_MIME_BY_EXT)).toEqual({
        ok: false,
      });
    }
    expect(parseAssetRequest(['surface', 'app.js'], PACKAGE_APP_PUB_MIME_BY_EXT).ok).toBe(true);
    // `.svg` is served on BOTH lanes: the public lane's anti-navigation
    // `Content-Security-Policy: sandbox` header rule is what makes a navigated
    // SVG script-free, so the extension itself no longer has to be denied.
    expect(parseAssetRequest(['surface', 'icon.svg'], PACKAGE_APP_PUB_MIME_BY_EXT).ok).toBe(true);
  });
});

describe('the MIME allowlist tables', () => {
  /**
   * DRIFT GUARD (derive-and-verify, same pattern as `hostPortProviderMount.test.ts`).
   * The full key set is pinned to a literal list so a future extension cannot be
   * added without an explicit decision about the SESSION-FREE lane: either add
   * it to `PACKAGE_APP_PUB_DENIED_EXTS` or accept that a leaked pub token serves
   * it. Update this list in the SAME change that adds the extension.
   */
  it('pins the FULL extension key set (a new extension must be classified)', () => {
    expect(Object.keys(PACKAGE_APP_ASSET_MIME_BY_EXT).sort()).toEqual(
      [
        '.css',
        '.gif',
        '.htm',
        '.html',
        '.ico',
        '.jpeg',
        '.jpg',
        '.js',
        '.json',
        '.map',
        '.mjs',
        '.otf',
        '.png',
        '.svg',
        '.ttf',
        '.txt',
        '.webp',
        '.woff',
        '.woff2',
      ].sort(),
    );
  });

  it('never serves source-code extensions', () => {
    for (const ext of ['.ts', '.tsx', '.jsx', '.mts', '.env', '.pem', '.key']) {
      expect(PACKAGE_APP_ASSET_MIME_BY_EXT[ext]).toBeUndefined();
    }
  });

  it('DERIVES the public table by subtracting the denied documents', () => {
    expect([...PACKAGE_APP_PUB_DENIED_EXTS].sort()).toEqual(['.htm', '.html']);
    const expected = Object.keys(PACKAGE_APP_ASSET_MIME_BY_EXT).filter(
      (ext) => !PACKAGE_APP_PUB_DENIED_EXTS.has(ext),
    );
    expect(Object.keys(PACKAGE_APP_PUB_MIME_BY_EXT)).toEqual(expected);
    // Same MIME strings — one table, one source of truth.
    for (const ext of expected) {
      expect(PACKAGE_APP_PUB_MIME_BY_EXT[ext]).toBe(PACKAGE_APP_ASSET_MIME_BY_EXT[ext]);
    }
  });
});

describe('resolveContainedAssetPath', () => {
  it('resolves inside the exact root', () => {
    expect(resolveContainedAssetPath(ROOT, ['assets', 'app.js'])).toEqual({
      ok: true,
      absPath: `${ROOT}${sep}assets${sep}app.js`,
    });
  });

  it('canonicalises equivalent spellings to ONE absolute path', () => {
    const a = resolveContainedAssetPath(ROOT, ['assets', 'app.js']);
    const b = resolveContainedAssetPath(ROOT, ['assets', '.', 'app.js']);
    const c = resolveContainedAssetPath(ROOT, ['assets', 'sub', '..', 'app.js']);
    expect(a.ok && b.ok && c.ok).toBe(true);
    expect(a.ok && b.ok && a.absPath === b.absPath).toBe(true);
    expect(a.ok && c.ok && a.absPath === c.absPath).toBe(true);
  });

  // THE distinction the helper exists for: two DIFFERENT reasons, because the
  // two lanes map them to two different statuses.
  it('reports `no_root` when the record carries no such root', () => {
    expect(resolveContainedAssetPath(undefined, ['a.css'])).toEqual({
      ok: false,
      reason: 'no_root',
    });
    expect(resolveContainedAssetPath('', ['a.css'])).toEqual({ ok: false, reason: 'no_root' });
  });

  it('reports `escape` for traversal, ancestors and sibling-prefix roots', () => {
    for (const rest of [
      ['..', 'other', 'a.css'],
      ['..', '..', '..', 'etc', 'passwd.txt'],
      ['assets', '..', '..', 'w2', 'a.css'],
    ]) {
      expect(resolveContainedAssetPath(ROOT, rest)).toEqual({ ok: false, reason: 'escape' });
    }
    // A sibling whose path merely STARTS WITH the root string is not contained.
    expect(resolveContainedAssetPath(ROOT, ['..', 'w-evil', 'a.css'])).toEqual({
      ok: false,
      reason: 'escape',
    });
  });

  it('allows the root itself (exact equality) but nothing above it', () => {
    expect(resolveContainedAssetPath(ROOT, ['.'])).toEqual({ ok: true, absPath: ROOT });
    expect(resolveContainedAssetPath(ROOT, ['..'])).toEqual({ ok: false, reason: 'escape' });
  });
});

/**
 * `openContainedAssetFile` — the REAL-PATH half of containment plus the cap, on
 * real tmpdirs with real symlinks. No fs mock: the whole point is that the
 * kernel resolves the links, and a mock would only re-assert the code's own
 * assumptions.
 */
describe('openContainedAssetFile', () => {
  let dir: string;
  let plainRoot: string;
  let linkedRoot: string;
  let realRoot: string;
  let outsideDir: string;
  let filePath: string;
  const BODY = 'x'.repeat(100);
  const SENTINEL = 'OUTSIDE-SENTINEL-do-not-serve';

  /** Every ok result owns a descriptor; a test that forgets to close leaks it. */
  async function closing<T>(
    result: { ok: true; handle: FileHandle; size: number } | { ok: false },
    use: (handle: FileHandle) => Promise<T>,
  ): Promise<T> {
    if (!result.ok) throw new Error('expected an ok result');
    try {
      return await use(result.handle);
    } finally {
      await result.handle.close();
    }
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nrs-asset-file-'));

    outsideDir = join(dir, 'outside');
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, 'secret.json'), SENTINEL, 'utf-8');
    await writeFile(join(outsideDir, 'sentinel.json'), SENTINEL, 'utf-8');

    // A plain, non-symlinked surface root.
    plainRoot = join(dir, 'surface');
    await mkdir(plainRoot, { recursive: true });
    filePath = join(plainRoot, 'app.css');
    await writeFile(filePath, BODY, 'utf-8');
    await writeFile(join(plainRoot, 'real.css'), '.inside{}', 'utf-8');
    // (B) a FILE symlink pointing at an outside file.
    await symlink(join(outsideDir, 'secret.json'), join(plainRoot, 'data.json'));
    // (C) a DIRECTORY symlink pointing at an outside directory.
    await symlink(outsideDir, join(plainRoot, 'leak'));
    // (D) a symlink whose target is INSIDE the root — legitimate.
    await symlink(join(plainRoot, 'real.css'), join(plainRoot, 'alias.css'));

    // (E/F) the same root reached THROUGH a symlink — the legit-install shape.
    realRoot = join(dir, 'realsurface');
    await mkdir(realRoot, { recursive: true });
    await writeFile(join(realRoot, 'app.css'), BODY, 'utf-8');
    await symlink(join(outsideDir, 'secret.json'), join(realRoot, 'data.json'));
    linkedRoot = join(dir, 'linked');
    await symlink(realRoot, linkedRoot);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // ---- the six measured containment rows -----------------------------------
  // Rows B, C and F ALL served the outside sentinel before the real-path half
  // existed. Row C is the one that proves an `lstat`-refuse on the final
  // component was rejected FOR CAUSE: `lstat` follows intermediate components
  // and reports only the last one's own type, so it serves this escape. Row D
  // is the one it would FALSELY deny. Do not "simplify" this back.

  it('(A) serves a plain file inside a plain root', async () => {
    const opened = await openContainedAssetFile(plainRoot, filePath, 1024 * 1024);
    expect(opened.ok).toBe(true);
    expect(opened.ok && opened.size).toBe(BODY.length);
    await closing(opened, async (handle) => {
      expect((await handle.readFile()).toString('utf-8')).toBe(BODY);
    });
  });

  it('(B) DENIES a file symlink whose target is outside the root', async () => {
    const opened = await openContainedAssetFile(
      plainRoot,
      join(plainRoot, 'data.json'),
      1024 * 1024,
    );
    expect(opened).toEqual({ ok: false, reason: 'escape' });
  });

  it('(C) DENIES an escape through an intermediate DIRECTORY symlink', async () => {
    // The lexical pre-filter passes this — `surface/leak/sentinel.json` is a
    // string strictly under the root — and so would an lstat of the final
    // component, which is a plain file.
    const lexical = resolveContainedAssetPath(plainRoot, ['leak', 'sentinel.json']);
    expect(lexical.ok).toBe(true);
    const opened = await openContainedAssetFile(
      plainRoot,
      lexical.ok ? lexical.absPath : '',
      1024 * 1024,
    );
    expect(opened).toEqual({ ok: false, reason: 'escape' });
  });

  it('(D) SERVES a symlink whose target is inside the root', async () => {
    const opened = await openContainedAssetFile(
      plainRoot,
      join(plainRoot, 'alias.css'),
      1024 * 1024,
    );
    expect(opened.ok).toBe(true);
    await closing(opened, async (handle) => {
      expect((await handle.readFile()).toString('utf-8')).toBe('.inside{}');
    });
  });

  it('(E) SERVES a plain file when the ROOT ITSELF is reached through a symlink', async () => {
    // The legit-install regression: an operator whose data root is a symlink
    // (`~/.neuralis -> /mnt/data/…`). A lexical-only comparison of the real path
    // against the stored root would deny this and break every bundle surface.
    const opened = await openContainedAssetFile(
      linkedRoot,
      join(linkedRoot, 'app.css'),
      1024 * 1024,
    );
    expect(opened.ok).toBe(true);
    await closing(opened, async (handle) => {
      expect((await handle.readFile()).toString('utf-8')).toBe(BODY);
    });
  });

  it('(F) DENIES an escaping symlink under a root that is itself symlinked', async () => {
    const opened = await openContainedAssetFile(
      linkedRoot,
      join(linkedRoot, 'data.json'),
      1024 * 1024,
    );
    expect(opened).toEqual({ ok: false, reason: 'escape' });
  });

  it('never yields the outside sentinel on ANY of the three escape rows', async () => {
    for (const [base, abs] of [
      [plainRoot, join(plainRoot, 'data.json')],
      [plainRoot, join(plainRoot, 'leak', 'sentinel.json')],
      [linkedRoot, join(linkedRoot, 'data.json')],
    ] as const) {
      const opened = await openContainedAssetFile(base, abs, 1024 * 1024);
      expect(opened.ok).toBe(false);
      if (opened.ok) await opened.handle.close();
    }
  });

  // ---- root / existence vocabulary ----------------------------------------

  it('(G) a root that is DECLARED but absent on disk is `no_root`, never a throw', async () => {
    const ghost = join(dir, 'no-such-shared-root');
    const opened = await openContainedAssetFile(ghost, join(ghost, 'a.css'), 1024);
    expect(opened).toEqual({ ok: false, reason: 'no_root' });
  });

  it('reports `no_root` when the record carries no such root at all', async () => {
    expect(await openContainedAssetFile(undefined, join(dir, 'a.css'), 1024)).toEqual({
      ok: false,
      reason: 'no_root',
    });
    expect(await openContainedAssetFile('', join(dir, 'a.css'), 1024)).toEqual({
      ok: false,
      reason: 'no_root',
    });
  });

  it('reports `missing` for a path that does not exist', async () => {
    expect(await openContainedAssetFile(plainRoot, join(plainRoot, 'nope.css'), 1024)).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it('reports `not_file` for a directory (never EISDIR from a read)', async () => {
    const sub = join(plainRoot, 'nested');
    await mkdir(sub, { recursive: true });
    const opened = await openContainedAssetFile(plainRoot, sub, 1024 * 1024 * 1024);
    // On Linux `open(dir, O_RDONLY)` succeeds and the isFile check is what
    // refuses; where the open itself fails it is `missing`. Both are 404 on both
    // lanes, so either is correct — what must NOT happen is an ok result.
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(['not_file', 'missing']).toContain(opened.reason);
  });

  // ---- the cap -------------------------------------------------------------

  it('reports `too_large` WITH the size, from the stat (never a read)', async () => {
    const opened = await openContainedAssetFile(plainRoot, filePath, BODY.length - 1);
    expect(opened).toEqual({ ok: false, reason: 'too_large', size: BODY.length });
  });

  it('returns the exact stat size when under the cap (boundary is inclusive)', async () => {
    for (const cap of [BODY.length, 1024 * 1024]) {
      const opened = await openContainedAssetFile(plainRoot, filePath, cap);
      expect(opened.ok).toBe(true);
      expect(opened.ok && opened.size).toBe(BODY.length);
      if (opened.ok) await opened.handle.close();
    }
  });

  // ---- the descriptor contract --------------------------------------------

  it('CLOSES the descriptor itself on every non-ok return', async () => {
    // A leak here would be invisible to a status assertion, so it is asserted
    // structurally: no non-ok result carries a handle to close.
    const results = [
      await openContainedAssetFile(plainRoot, join(plainRoot, 'data.json'), 1024 * 1024),
      await openContainedAssetFile(plainRoot, join(plainRoot, 'nope.css'), 1024 * 1024),
      await openContainedAssetFile(plainRoot, filePath, 1),
      await openContainedAssetFile(undefined, filePath, 1024),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty('handle');
    }
  });

  // ---- the FIFO process-wedge floor (`O_NONBLOCK`) -------------------------

  /**
   * `open()` on a FIFO with no writer BLOCKS until one arrives, and libuv's fs
   * threadpool is PROCESS-WIDE with FOUR threads by default — so four such
   * requests stall every fs / dns / zlib / pbkdf2 operation the host performs,
   * the auth path included. Measured on this exact helper before `O_NONBLOCK`
   * landed: the open NEVER returned (>4000 ms, still pending), nine of them
   * starved a plain `readFile` in the same process for a full 3000 ms window,
   * and the process could not complete its own `process.exit(0)`.
   *
   * The `isFile()` gate CANNOT stand in for the flag: containment became
   * descriptor-based, so that gate runs AFTER the open — it classifies a file
   * the process already survived opening.
   *
   * Both halves of the assertion are load-bearing. Without the timing half a
   * future `isFile()`-only implementation passes; without the `not_file` half a
   * helper that merely returned fast (say, by serving the FIFO) passes.
   */
  it.skipIf(process.platform === 'win32')(
    'does not BLOCK on a FIFO planted in the root, and classifies it `not_file`',
    async () => {
      const BLOCK_BUDGET_MS = 1500;
      const fifoPath = join(plainRoot, 'evil.css');
      execFileSync('mkfifo', [fifoPath]);
      try {
        // Non-vacuum control: the fixture really is a FIFO. A `missing` path
        // would also answer fast, and would prove nothing.
        expect(lstatSync(fifoPath).isFIFO()).toBe(true);

        const started = performance.now();
        const outcome = await Promise.race([
          openContainedAssetFile(plainRoot, fifoPath, 1024 * 1024),
          new Promise<'__wedged__'>((resolve) => {
            setTimeout(() => resolve('__wedged__'), BLOCK_BUDGET_MS).unref();
          }),
        ]);
        const elapsedMs = performance.now() - started;

        expect(outcome).not.toBe('__wedged__');
        expect(elapsedMs).toBeLessThan(BLOCK_BUDGET_MS);
        expect(outcome).toEqual({ ok: false, reason: 'not_file' });

        // MATCHED CONTROL: the flag must not have changed how a REGULAR file
        // reads — `O_NONBLOCK` is a no-op there, and a truncated or EAGAIN-ing
        // read would be a far worse regression than the one being closed.
        const plain = await openContainedAssetFile(plainRoot, filePath, 1024 * 1024);
        expect(plain.ok).toBe(true);
        expect(plain.ok && plain.size).toBe(BODY.length);
        await closing(plain, async (handle) => {
          expect((await handle.readFile()).toString('utf-8')).toBe(BODY);
        });
      } finally {
        // SELF-UNWEDGING cleanup. If the flag is ever removed, the open above is
        // still pending on a threadpool thread and would hold it for the life of
        // the worker — a failing test that also poisons the rest of the run.
        // Opening the WRITE end releases a blocked reader; ENXIO means nothing
        // was blocked, which is the passing case.
        try {
          const writer = await open(fifoPath, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK);
          await writer.close();
        } catch {
          /* ENXIO — no reader was waiting, i.e. the flag did its job. */
        }
        await rm(fifoPath, { force: true });
      }
    },
  );

  it('hands back a descriptor positioned at 0 — stat does not consume it', async () => {
    // `handle.readFile()` reads from the CURRENT position. If a future change
    // inserted a read or a seek between the stat and the caller's read, every
    // served asset would silently truncate.
    const opened = await openContainedAssetFile(plainRoot, filePath, 1024 * 1024);
    await closing(opened, async (handle) => {
      const bytes = await handle.readFile();
      expect(bytes.byteLength).toBe(BODY.length);
    });
  });
});
