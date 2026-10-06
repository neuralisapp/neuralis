/**
 * packageAppAssetFile — the RESPONSE-FREE primitives shared by BOTH package-app
 * asset lanes (the authenticated `_scope` entry lane and the session-free
 * `_pub` subresource lane).
 *
 * These helpers exist because the two lanes must apply the SAME extension
 * allowlist and the SAME containment rule, but answer with DIFFERENT status
 * vocabularies: the authenticated lane distinguishes a missing root (404) from
 * a containment escape (403), while the public lane's non-enumerating
 * dictionary is a uniform 404 everywhere. A helper that returned a `Response` —
 * or that collapsed the two containment failures into one — would silently
 * change the landed lane's wire behaviour, so every function here returns a
 * discriminated RESULT and the status mapping stays with the calling lane.
 *
 * CONTAINMENT IS TWO HALVES, and both are required. `resolveContainedAssetPath`
 * is the cheap LEXICAL pre-filter (string prefix, `..` collapsed); it cannot see
 * a symlink, so on its own it served a symlinked file's outside target. The
 * SECOND half is `openContainedAssetFile`, which `realpath`s BOTH the root and
 * the requested path before deciding, and is the only function here that may be
 * used to produce bytes. Never read from a path this module returned without
 * going through it.
 *
 * Nothing here reads a session, a cookie or a header; nothing logs. The byte
 * cap value itself is NOT declared here — it lives with the other serving
 * floors in `packageAppAssetCsp.ts` and is passed in.
 */

import { realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { openContainedHandle, resolveContained } from '@neuralis/package-system/paths';

/**
 * Only fully-resolved asset types. Source code extensions are intentionally
 * missing — serving .ts / .tsx would leak package internals.
 *
 * Adding an entry here is a security decision on TWO lanes: classify it as
 * public-allowed or public-denied in the same change (the drift guard in
 * `__tests__/packageAppAssetFile.test.ts` pins the full key set so a silent
 * addition fails loudly).
 */
export const PACKAGE_APP_ASSET_MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Extensions the SESSION-FREE lane refuses to serve.
 *
 * `.html`/`.htm`: the public lane must never serve a DOCUMENT — otherwise it
 * would be usable as an alternative frame `src` that bypasses the entry lane's
 * full visibility gate.
 *
 * `.svg` is NOT on this list, and the reason is a header rather than a property
 * of SVG. An SVG opened as a NAVIGATION is a document too, and its inline
 * `<script>` is permitted by the asset CSP's `'unsafe-inline'`; on the
 * authenticated lane exploiting that needs the secret handle AND the owner's live
 * cookie, but on a session-free lane a leaked token alone would be enough. What
 * closes it is the `/api/package-app/_pub/:path*` rule in
 * `src/server/config/securityHeaders.ts`, which puts
 * `Content-Security-Policy: sandbox` on every response of this lane — measured to
 * stop a navigated document's script while leaving subresource loading
 * untouched. **That rule is load-bearing: if it is ever removed or reordered
 * before the `/api/package-app/:path*` rule, `.svg` must return to this set in
 * the SAME change.**
 *
 * The ENTRY lane now carries its own `sandbox allow-scripts allow-forms` (see
 * `buildPackageAppAssetCsp`), and that is a SECOND, STRICTLY WEAKER layer — it
 * still permits script, merely in an opaque origin. It is NEVER a substitute for
 * the rule above: this lane's `sandbox` has no `allow-scripts`, so a navigated
 * `_pub` document runs nothing at all. Do not read the `_pub` rule as redundant
 * because the entry lane gained a sandbox directive.
 */
export const PACKAGE_APP_PUB_DENIED_EXTS = new Set(['.html', '.htm']);

/**
 * The public lane's allowlist — DERIVED from the full table, never a second
 * literal copy (two tables drift; one table plus a deny set cannot).
 */
export const PACKAGE_APP_PUB_MIME_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(PACKAGE_APP_ASSET_MIME_BY_EXT).filter(
    ([ext]) => !PACKAGE_APP_PUB_DENIED_EXTS.has(ext),
  ),
);

export type ParsedAssetRequest =
  | { ok: true; namespace: 'surface' | 'shared'; rest: string[]; mime: string }
  | { ok: false };

/**
 * Namespace gate + extension allowlist, BEFORE any filesystem touch (no
 * source-file leak, no fs probe on an unknown extension). The three checks run
 * in this exact order on both lanes.
 */
export function parseAssetRequest(
  pathSegments: string[],
  mimeByExt: Record<string, string>,
): ParsedAssetRequest {
  if (pathSegments.length < 2) return { ok: false };
  const [namespace, ...rest] = pathSegments;
  if (namespace !== 'surface' && namespace !== 'shared') return { ok: false };
  const last = rest[rest.length - 1];
  const ext = extname(last ?? '').toLowerCase();
  const mime = mimeByExt[ext];
  if (!mime) return { ok: false };
  return { ok: true, namespace, rest, mime };
}

export type ContainedAssetPath =
  | { ok: true; absPath: string }
  | { ok: false; reason: 'no_root' | 'escape' };

/**
 * LEXICAL exact-root containment: the resolved path must BE the root or live
 * strictly beneath it. Every other prefix, traversal, ancestor or sibling that
 * is visible IN THE SPELLING fails closed.
 *
 * DELIBERATELY PURE AND INCOMPLETE. This is a string computation — it never
 * touches the filesystem, so a symlink whose lexical path sits inside the root
 * while its target does not passes here. Closing that is
 * {@link openContainedAssetFile}'s job (`realpath` on both sides), and it is the
 * ONLY function in this module that may be used to produce bytes. Keep this one
 * cheap: it runs before any fs work precisely so an unknown path costs nothing.
 *
 * The two failure reasons stay DISTINCT on purpose — the authenticated lane
 * answers 404 for a missing root and 403 for an escape; the public lane
 * answers 404 for both.
 */
export function resolveContainedAssetPath(
  base: string | undefined,
  rest: string[],
): ContainedAssetPath {
  if (!base) return { ok: false, reason: 'no_root' };
  const requested = resolve(base, ...rest);
  if (requested !== base && !requested.startsWith(base + sep)) {
    return { ok: false, reason: 'escape' };
  }
  return { ok: true, absPath: requested };
}

export type OpenedAssetFile =
  | { ok: true; handle: FileHandle; size: number }
  | {
      ok: false;
      reason: 'no_root' | 'escape' | 'missing' | 'not_file' | 'too_large';
      size?: number;
    };

/**
 * WHY THE PRIMITIVE'S OPEN FLAGS ARE FLOORS — the evidence, MEASURED ON THIS
 * LANE. The flags themselves now live in the kernel primitive
 * (`@neuralis/package-system/paths`, `containment.ts`); this block is the
 * lane-specific justification that made them floors, and it stays here because
 * the numbers were taken here.
 *
 * `O_NOFOLLOW` is POSIX-only — `fs.constants.O_NOFOLLOW` is UNDEFINED on
 * Windows, and `O_RDONLY | undefined` is `NaN`, which makes every `open` fail.
 * The primitive's `?? 0` keeps the platform working at the price of the race
 * guard: the symlink-swap window is closed on Linux/macOS only. `neuralisHome.ts`
 * still carries a `win32` branch, so this is not a hypothetical platform.
 *
 * `O_NONBLOCK` is a DENIAL-OF-SERVICE floor, and the `isFile()` gate cannot
 * replace it — MEASURED, on a real tmpdir, against this exact helper.
 *
 * `open()` on a FIFO with no writer BLOCKS until one arrives. After `mkfifo
 * <root>/evil.css` the open here NEVER RETURNED (>4000 ms, still pending), and
 * NINE such pending opens starved a plain `readFile` IN THE SAME PROCESS for an
 * entire 3000 ms window. libuv's fs threadpool is PROCESS-WIDE and defaults to
 * FOUR threads, so four requests are enough to stall every fs / dns / zlib /
 * pbkdf2 operation the host performs — the auth path included.
 *
 * It is reachable: the surface root is agent-writable under the right uriPolicy
 * (the same premise the accepted TOCTOU residual rests on), so the actor that
 * can plant a symlink can plant a FIFO; and the request that opens it is the
 * widget's own legitimate subresource load on the session-free `_pub` lane —
 * the lane with no caller to rate-limit.
 *
 * ORDERING IS THE WHOLE POINT. The type gate sits AFTER the open, so it can
 * only classify a file the process already survived opening. With the flag the
 * FIFO open returns in ~1 ms, `stat()` reports `isFIFO()`, `isFile()` is false
 * and the caller gets `not_file` ⇒ 404 on both lanes. On a REGULAR file
 * `O_NONBLOCK` is a no-op — regular-file reads never return EAGAIN — so a
 * full-size asset still reads byte-complete (measured: 3 MiB, statSize ===
 * readBytes). **Do not drop either flag while tidying the primitive's flag set,
 * and do not "restore" a pre-open `stat` in its place.**
 */

/**
 * The ONE way either lane turns a request into readable bytes: REAL-PATH
 * containment + a capped, already-open file descriptor.
 *
 * WHY REALPATH BOTH SIDES rather than refusing symlinks. Measured against the
 * shipped helpers on real tmpdirs, an `lstat`-refuse on the final component
 * (a) still SERVES an escape through an intermediate DIRECTORY symlink —
 * `lstat` follows intermediate components and reports only the last one's own
 * type — and (b) FALSE-DENIES a legitimate symlink whose target is inside the
 * root. Making it complete means `lstat`-ing every component, i.e. a hand-rolled
 * `realpath`. Resolving both sides denied all three escape shapes and served all
 * three legitimate ones, including a root that is itself reached through a
 * symlink (`~/.neuralis -> /mnt/…`, a common self-host layout). Cost: ~0.17 ms
 * per file. Do not "simplify" this back to a symlink refusal.
 *
 * WHY A FILE DESCRIPTOR rather than a stat + a path. `realpath` alone leaves a
 * winnable race: the surface root is agent-writable under the right uriPolicy,
 * so a `rename()` of a symlink over a regular file between the check and the
 * read would be followed. Opening the resolved path with `O_NOFOLLOW` (ELOOP on
 * a raced final component) and then stat-ing and reading THAT SAME descriptor
 * makes the check and the read atomic, at the same syscall count as the stat +
 * read it replaces.
 *
 * ACCEPTED RESIDUALS OF CONTAINMENT — the canonical list, the three residuals
 * and the six prohibitions, now live ONCE in the kernel primitive this function
 * delegates to: `packages/package-system/src/paths/containment.ts`. Read them
 * there before "fixing" anything here; in particular the `st_nlink === 1` and
 * same-device anti-fixes are refuted BY MEASUREMENT and must never be
 * reintroduced. What stays HERE is the lane-specific evidence — the
 * `O_NONBLOCK` DoS figures above, which were measured on THIS lane and are the
 * reason that flag is a floor rather than a nicety.
 *
 * The byte cap is enforced on the descriptor's stat size BEFORE any read, so an
 * over-cap file is never loaded into memory.
 *
 * CALLER CONTRACT — the handle is YOURS to close. Every non-ok return has
 * already closed anything it opened; on `ok` the caller MUST `close()` in a
 * `finally` that spans every path to the response, including early returns
 * between here and the read (the public lane's budget refusal is exactly such a
 * path, and leaking a descriptor there would be a fresh DoS on a lane with no
 * caller to rate-limit).
 *
 * POSITION: `handle.readFile()` reads from the descriptor's CURRENT position.
 * `handle.stat()` does not move it, so it stays at 0 — but any future read or
 * seek inserted between the two would silently truncate every served asset.
 *
 * This function never logs: the actionable server-side warning needs the
 * record's package coordinates, so it belongs to the calling lane.
 */
export async function openContainedAssetFile(
  base: string | undefined,
  absPath: string,
  maxBytes: number,
): Promise<OpenedAssetFile> {
  if (!base) return { ok: false, reason: 'no_root' };

  // The root is resolved HERE, by this lane, for one reason: the shared
  // primitive's denial enum deliberately cannot distinguish "the declared root
  // is absent" from "the requested file is absent", and this lane must — a
  // declared-but-absent root (the optional `sharedRoot` is exactly that case)
  // is `no_root`. Having resolved it, `rootIsReal` spares the primitive a
  // second `realpath` on a lane whose thread-pool budget is measured above.
  let realBase: string;
  try {
    realBase = await realpath(base);
  } catch {
    return { ok: false, reason: 'no_root' };
  }

  // `absPath` was built against the ORIGINAL `base`, so the relative portion is
  // taken from that — not from `realBase`, which differs whenever the root is
  // itself reached through a symlink (`~/.neuralis -> /mnt/…`, a supported
  // self-host layout). The primitive then resolves it against the real root.
  const resolved = await resolveContained(realBase, relative(base, absPath), { rootIsReal: true });
  if (!resolved.ok) {
    return { ok: false, reason: resolved.code === 'escape' ? 'escape' : 'missing' };
  }

  const opened = await openContainedHandle(resolved.path, maxBytes);
  if (opened.ok) return { ok: true, handle: opened.handle, size: opened.size };

  // Map the shared vocabulary onto this lane's. Everything that is not a
  // classified type refusal or the cap collapses to `missing`: ENOENT (deleted
  // since the realpath), ELOOP (a symlink raced into the final component) and
  // an EBADF-class stat failure are ONE outcome to every caller — the file is
  // not there to serve — and both lanes answer 404 for it.
  if (opened.code === 'not_file') return { ok: false, reason: 'not_file' };
  if (opened.code === 'too_large') return { ok: false, reason: 'too_large', size: opened.size };
  return { ok: false, reason: 'missing' };
}
