/**
 * handlePackageAppAssetGet — the identity-free virtual asset GET
 * (CARD1 3A), served at `GET /api/package-app/_scope/{handle}/{surface|shared}/*`.
 *
 * The URL carries NO package/project/user/agent/surface identity — only the
 * opaque handle. The handle is NOT an authorizing capability: every request
 * re-runs the fresh canonical cookie session + the FULL shared
 * package/surface visibility predicate (`resolveVisiblePackageSurface`), then
 * compares the handle's bound trust / generation / fingerprint against the
 * CURRENT declaration. Any drift (role/feature/project-override/source-owner/
 * agent-scope/trust change, package disable/update/uninstall, surface
 * disappearance) revokes the handle and answers 410.
 *
 * Containment: `surface/*` resolves ONLY inside the record's dedicated surface
 * root, `shared/*` ONLY inside the `app/shared/` root; every other prefix,
 * traversal, ancestor or sibling is fail-closed. Containment is decided in TWO
 * halves and the second one is load-bearing: a cheap LEXICAL prefix check, then
 * a REAL-PATH check that resolves the root and the request through symlinks
 * before opening anything. Without that second half a symlink planted under the
 * surface root served its target from anywhere on the host — never state the
 * containment rule without it. Extension allowlist runs BEFORE any filesystem
 * touch (no source-file leak). Both rules come from the shared, Response-free
 * `packageAppAssetFile.ts` primitives — the SAME rule the session-free
 * subresource lane applies. The STATUS mapping stays here, because it is
 * lane-specific: a containment escape answers 403 on THIS lane (see below) and
 * 404 on the session-free one, whether it was spelled as a traversal or hidden
 * behind a link.
 *
 * Response floor: `Cache-Control: private, no-store` +
 * `Referrer-Policy: no-referrer` + `X-Content-Type-Options: nosniff` + the
 * strict CSP on EVERY served asset — trust-INDEPENDENTLY, matching the
 * next.config rule that actually reaches the wire — so a revoked scope leaves no
 * executable cache window. No ETag/304 (pointless under no-store, and a
 * revalidation path could leak liveness).
 *
 * Memory bound: `PACKAGE_APP_ASSET_MAX_BYTES` is checked on the stat size
 * BEFORE the read (CARD1 3C). It is NOT a self-containment gate. Subresource
 * serving has TWO branches: a surface that DECLARES bundle asset mode has its
 * non-document subresources served on the session-free lane, reached through the
 * `<base href>` injected into its entry document below; a SELF-CONTAINED surface
 * never does — an opaque-origin frame sends no session cookie, so a relative
 * subresource of a self-contained entry is simply not served, and
 * self-containment remains an AUTHORING rule enforced by the shipped preflight,
 * never on the wire. A surface that declares nothing is self-contained, which is
 * every surface that has not opted in.
 *
 * Never write "the platform now serves subresources" unqualified — only the
 * declared-bundle ones, and that over-claim is a defect in its own right.
 *
 * WIRE AUTHORITY (CARD1 3B): the global next.config `/:path*` `headers()` rule
 * OVERRIDES the same-key headers on this Response on the wire (Next applies
 * matching `headers()` rules by last-write on the exact key). The `Referrer-
 * Policy` + CSP floor is therefore ALSO declared as a more-specific
 * `/api/package-app/:path*` `headers()` rule in `securityHeaders.ts` — the
 * headers set here are kept as defense-in-depth. `Cache-Control` survives
 * (absent from the global set).
 *
 * Error bodies are uniform constants — no error text, `Location` or header
 * ever reflects the runtime package id or a resolved filesystem path.
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolve } from 'node:path';
import type { SessionContext } from '@neuralis/package-system/contracts';
import { isHtmlEntryPath } from '@neuralis/package-system';
import {
  resolveSessionContext,
  SessionResolutionError,
} from '../auth/resolveSessionContext';
import { resolveVerifiedAgentScope } from '../auth/resolveVerifiedAgentScope';
import { resolveVisiblePackageSurface } from './packageVisibility';
import { getPackageAssetScopeAuthority } from './PackageAssetScopeAuthority';
import { ensureProjectPackagesLoaded } from './projectPackages';
import { buildPackageAppAssetCsp, PACKAGE_APP_ASSET_MAX_BYTES } from './packageAppAssetCsp';
import {
  PACKAGE_APP_ASSET_MIME_BY_EXT,
  openContainedAssetFile,
  parseAssetRequest,
  resolveContainedAssetPath,
} from './packageAppAssetFile';
import { buildPackageAppBaseHref, injectBaseTag } from './packageAppBaseTag';
import { getLogger } from '../logging/setup';

function gone(): NextResponse {
  return NextResponse.json({ error: 'Gone' }, { status: 410 });
}

function notFound(): NextResponse {
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

function forbidden(): NextResponse {
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}

export async function handlePackageAppAssetGet(
  req: NextRequest,
  handle: string,
  pathSegments: string[],
): Promise<Response> {
  const authority = getPackageAssetScopeAuthority();
  const record = authority.get(handle);
  if (!record) return gone();

  // Namespace gate + extension allowlist BEFORE any fs work: surface/* or
  // shared/* only, fully-resolved asset types only (shared with the public
  // subresource lane — ONE rule, two lanes, no second copy to drift).
  const parsed = parseAssetRequest(pathSegments, PACKAGE_APP_ASSET_MIME_BY_EXT);
  if (!parsed.ok) return notFound();
  const { namespace, rest, mime } = parsed;

  // Fresh canonical cookie session — the iframe navigation carries cookies
  // only (no headers, no query). The project comes from the RECORD, never
  // from caller input.
  let session: SessionContext;
  try {
    session = await resolveSessionContext(req, record.projectId);
  } catch (err) {
    if (err instanceof SessionResolutionError) {
      // Uniform: membership/role loss reads as a plain Forbidden.
      return err.status === 401
        ? NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        : forbidden();
    }
    throw err;
  }
  if (session.userId !== record.userId) return forbidden();

  // Re-resolve the handle's bound agent candidate with the FRESH session —
  // no caller header is consulted. Deleted agent / ownership revoke → 410.
  if (record.agentId) {
    const verified = await resolveVerifiedAgentScope(session, record.agentId);
    if (verified !== record.agentId) {
      authority.revoke(handle);
      return gone();
    }
  }

  // FULL shared visibility recheck + drift compare (trust / generation /
  // fingerprint). Any loss or drift revokes.
  await ensureProjectPackagesLoaded(record.projectId);
  const surface = await resolveVisiblePackageSurface(
    { ...session, agentId: record.agentId },
    record.packageId,
    record.surfaceKind,
    record.surfaceId,
  );
  if (
    !surface ||
    surface.fingerprint !== record.fingerprint ||
    surface.generation !== record.generation ||
    surface.trust !== record.trust
  ) {
    authority.revoke(handle);
    return gone();
  }

  // Containment, LEXICAL half: surface/* → the EXACT dedicated surface root;
  // shared/* → the EXACT app/shared root. Everything visible in the spelling
  // fails closed here. The two failure reasons keep their DISTINCT statuses
  // (missing root → 404, escape → 403); the public lane maps both to 404.
  const root = namespace === 'surface' ? record.surfaceRoot : record.sharedRoot;
  const contained = resolveContainedAssetPath(root, rest);
  if (!contained.ok) return contained.reason === 'escape' ? forbidden() : notFound();

  // Containment, REAL half + the B-baseline memory bound (CARD1 3C), in ONE
  // helper because they must be decided on the SAME file: `openContainedAssetFile`
  // realpaths the root AND the request (a symlink under the surface root pointing
  // out of it is an `escape`, not bytes), then caps on the stat of the descriptor
  // it hands back — an unbounded `readFile` of a `_packages/`-supplied file is
  // the "post-read cap ≠ byte cap" class. Uniform 404 (never 413) for the cap
  // keeps the route non-enumerating; the actionable diagnostic is the authoring
  // preflight's, and the package id is logged server-side only, never in a
  // response. A symlink escape maps to the SAME 403 as a lexical one — the
  // status split is a property of the lane, not of how the escape was spelled.
  const opened = await openContainedAssetFile(
    root,
    contained.absPath,
    PACKAGE_APP_ASSET_MAX_BYTES,
  );
  if (!opened.ok) {
    if (opened.reason === 'too_large') {
      getLogger()
        .child('package-app-asset')
        .warn(
          `Package app asset exceeds the ${PACKAGE_APP_ASSET_MAX_BYTES}-byte cap ` +
            `(${opened.size} bytes) for package '${record.packageId}' ` +
            `surface ${record.surfaceKind}/${record.surfaceId}; refusing to serve.`,
        );
    }
    return opened.reason === 'escape' ? forbidden() : notFound();
  }

  // The descriptor is ours to close, on every path out. The read used to be a
  // bare `readFile` with no catch, so an I/O failure escaped as a framework 500
  // and distinguished itself from every other refusal; it now answers the same
  // 404, which is what this lane's uniform-error claim already promised.
  let buffer: Buffer;
  try {
    buffer = await opened.handle.readFile();
  } catch {
    return notFound();
  } finally {
    await opened.handle.close().catch(() => undefined);
  }

  // A served asset keeps the scope alive (same idle window as heartbeat). The
  // entry lane never bounds this — a live, gated caller may extend its own scope
  // for as long as it keeps passing the full visibility recheck above.
  authority.touch(handle);

  // BUNDLE MODE: rewrite the ENTRY DOCUMENT so its relative subresources resolve
  // onto the session-free lane. All five conditions must hold; any failure serves
  // the bytes unchanged, which is exactly today's behaviour.
  //
  //  1. the surface DECLARED bundle mode (absent ⇒ self-contained, the
  //     import-unchanged floor);
  //  2. the `surface` namespace — a `shared/*` document is never an entry;
  //  3. this exact file IS the entry, compared as LEXICALLY resolved absolute
  //     paths (the same canonical key the public lane's budget uses), so
  //     `./`-spellings match and a non-entry `.html` under the same surface does
  //     not. It MUST stay the lexical `contained.absPath`, never the realpath
  //     `openContainedAssetFile` used internally: on any deployment whose roots
  //     sit under a symlink (`~/.neuralis -> /mnt/…`) the two differ, this
  //     equality would silently fail, and every bundle surface would degrade to
  //     self-contained with no error on any surface;
  //  4. the entry is an HTML DOCUMENT. An `<base>` string only means anything in
  //     one, and nothing upstream guarantees it: the kernel validator only WARNS
  //     on a non-HTML entry (`validateContribution`) and the mint route does not
  //     look at all, so without this a surface declaring `index.svg` or
  //     `index.json` would get HTML spliced into an `image/svg+xml` /
  //     `application/json` body. The ONE kernel predicate is used — never a second
  //     extension test spelled out here;
  //  5. the href built cleanly — `buildPackageAppBaseHref` returns null rather
  //     than emit anything that could break out of the attribute.
  //
  // `injectBaseTag` adds a sixth, INTERNAL refusal (a UTF-16 BOM), which returns
  // the document untouched; that one is not restated here because it is a
  // property of the transform, not of the record.
  //
  // The absolute/bridge branch needs no check of its own: the mint route refuses
  // to create a record for a surface without a RELATIVE entry url, so no record
  // reaches this code for one. Do not add a redundant second gate for it.
  let bytes = new Uint8Array(buffer);
  let contentLength = String(opened.size);
  if (
    record.assetMode === 'bundle' &&
    namespace === 'surface' &&
    contained.absPath === resolve(record.surfaceRoot, record.entryRelPath) &&
    isHtmlEntryPath(record.entryRelPath)
  ) {
    const baseHref = buildPackageAppBaseHref(record.pubToken, record.entryRelPath);
    if (baseHref) {
      // `latin1` both ways: a lossless byte↔char map, so a non-UTF-8 entry keeps
      // its exact bytes (a UTF-8 round-trip would corrupt it).
      const injected = injectBaseTag(buffer.toString('latin1'), baseHref);
      bytes = new Uint8Array(Buffer.from(injected, 'latin1'));
      // The body GREW — the stat size would now understate it and truncate or
      // error the response.
      contentLength = String(bytes.byteLength);
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': mime,
    'Content-Length': contentLength,
    // Revoke must leave NO executable cache window.
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    // Defense-in-depth floor on the Response, UNCONDITIONALLY. The next.config
    // path-scoped rule (`securityHeaders.ts`) is what actually reaches the wire
    // and it is already trust-INDEPENDENT; making this copy trust-conditional
    // was the one place the two consumers disagreed.
    'Content-Security-Policy': buildPackageAppAssetCsp(),
  };

  return new Response(bytes, { status: 200, headers });
}
