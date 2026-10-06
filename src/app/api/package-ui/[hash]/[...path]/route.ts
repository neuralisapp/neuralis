/**
 * GET /api/package-ui/{hash}/{path…}
 *
 * The first-party UI MODULE lane: the prebuilt browser module a host-assigned
 * first-party package ships (`app.module`), and the ONE union stylesheet. The
 * workspace `import()`s these on the main origin, so this is NOT a sandboxed
 * package-app lane — those keep their opaque origin, `no-store` and 2 MiB cap.
 *
 * Floors, in order:
 * 1. the hash is a lowercase sha256 hex — anything else is 404 before any work;
 * 2. an ACTIVE cookie session (any member; `/_next/static` is anonymous, so this
 *    is strictly stronger) — none ⇒ 401;
 * 3. the hash resolves through the server-built table only (`packageUiModules`)
 *    — the caller never names a package or a root; unknown ⇒ 404;
 * 4. the owning package is STILL a host-assigned first-party builtin in the
 *    live registry — otherwise 403;
 * 5. `.js`/`.mjs`/`.css` only — `.map`, `.json`, documents ⇒ 404 before any fs
 *    touch;
 * 6. containment through the SAME two-half primitives as the package-app lanes
 *    (lexical, then realpath + `O_NOFOLLOW|O_NONBLOCK` descriptor + fstat), with
 *    this lane's own per-file cap checked on the descriptor before the read.
 *
 * Cache: `private, max-age=31536000, immutable` with `ETag` = the hash — a new
 * build is a new URL, and a module once imported cannot be revoked from the
 * page anyway, so `no-store` would buy nothing but a re-download per load.
 */

import { NextRequest, NextResponse } from 'next/server';
import { extname } from 'node:path';
import { getSessionUser } from '@/server/auth/session';
import { ensureCommunityRuntime, getCommunityPackageRegistry } from '@/server/packages/runtime';
import {
  openContainedAssetFile,
  resolveContainedAssetPath,
} from '@/server/packages/packageAppAssetFile';
import {
  PACKAGE_UI_MODULE_MAX_BYTES,
  PACKAGE_UI_MODULE_MIME_BY_EXT,
  UI_SHEET_FILE,
  getUiAttachments,
  isFirstPartyBuiltin,
} from '@/server/packages/packageUiModules';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ hash: string; path: string[] }> };

const HASH_SHAPE = /^[0-9a-f]{64}$/;

function status(code: 401 | 403 | 404): NextResponse {
  const error = code === 401 ? 'Unauthorized' : code === 403 ? 'Forbidden' : 'Not found';
  return NextResponse.json({ error }, { status: code });
}

function servedHeaders(hash: string, mime: string, length: number): Record<string, string> {
  return {
    'Content-Type': mime,
    'Content-Length': String(length),
    'Cache-Control': 'private, max-age=31536000, immutable',
    ETag: `"${hash}"`,
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

function notModified(req: NextRequest, hash: string): boolean {
  return req.headers.get('if-none-match') === `"${hash}"`;
}

export async function GET(req: NextRequest, { params }: Params): Promise<Response> {
  const { hash, path } = await params;
  if (!HASH_SHAPE.test(hash) || !Array.isArray(path) || path.length === 0) return status(404);

  const user = await getSessionUser();
  if (!user) return status(401);

  await ensureCommunityRuntime();
  const attachments = await getUiAttachments();
  const entry = attachments.table.get(hash);
  if (!entry) return status(404);

  if (entry.kind === 'sheet') {
    if (path.length !== 1 || path[0] !== UI_SHEET_FILE) return status(404);
    if (notModified(req, hash)) return new Response(null, { status: 304, headers: { ETag: `"${hash}"` } });
    return new Response(new Uint8Array(entry.css), {
      status: 200,
      headers: servedHeaders(hash, PACKAGE_UI_MODULE_MIME_BY_EXT['.css'], entry.css.length),
    });
  }

  if (!isFirstPartyBuiltin(getCommunityPackageRegistry().getPackage(entry.packageId))) return status(403);

  const mime = PACKAGE_UI_MODULE_MIME_BY_EXT[extname(path[path.length - 1] ?? '').toLowerCase()];
  if (!mime) return status(404);

  const contained = resolveContainedAssetPath(entry.dir, path);
  if (!contained.ok) return contained.reason === 'escape' ? status(403) : status(404);
  const opened = await openContainedAssetFile(entry.dir, contained.absPath, PACKAGE_UI_MODULE_MAX_BYTES);
  if (!opened.ok) return opened.reason === 'escape' ? status(403) : status(404);

  let bytes: Buffer;
  try {
    if (notModified(req, hash)) return new Response(null, { status: 304, headers: { ETag: `"${hash}"` } });
    bytes = await opened.handle.readFile();
  } catch {
    return status(404);
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
  return new Response(new Uint8Array(bytes), { status: 200, headers: servedHeaders(hash, mime, bytes.length) });
}
