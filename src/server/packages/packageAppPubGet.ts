/**
 * handlePackageAppPubGet — the SESSION-FREE package subresource lane, served at
 * `GET /api/package-app/_pub/{pubToken}/{surface|shared}/*`.
 *
 * SECURITY MODEL — deliberately different from `packageAppAssetGet.ts`, which
 * is why it is a separate file:
 *
 *  - This lane NEVER reads a cookie. It does not call `resolveSessionContext`,
 *    `resolveVerifiedAgentScope` or `resolveVisiblePackageSurface`, and it can
 *    not: the request arrives from an OPAQUE-origin sandbox frame that sends no
 *    credentials at all. There is therefore no caller to gate.
 *  - Its whole error vocabulary is ONE uniform **404**. It has no 401, no 403
 *    and no 410 — every failure (unknown token, expired scope, denied
 *    extension, wrong namespace, traversal, generation drift, missing file,
 *    over-cap, over-budget) is indistinguishable from the outside, so the lane
 *    cannot be used to enumerate anything. Do not copy the authenticated lane's
 *    `gone()` / `forbidden()` helpers in here.
 *  - The `pubToken` IS a narrow capability (unlike the `handle`, which is not
 *    one). What it opens is the package's OWN non-document static files, only
 *    under the record's surface / `app/shared` roots AS RESOLVED THROUGH
 *    SYMBOLIC LINKS (both the root and the requested path are `realpath`ed, so a
 *    SYMBOLIC link planted under the root cannot reach out of it — see
 *    `openContainedAssetFile`), only in the generation bound at mint, only while
 *    the scope's idle window is alive. It carries no user, project or agent
 *    identity and reaches no API. "Bounded by construction" is the wrong phrase
 *    for it and is deliberately not used: the bound is a rule this lane
 *    ENFORCES, and it served a symbolic link's outside target until that rule
 *    grew its real-path half. The word SYMBOLIC is load-bearing rather than
 *    pedantic: a HARDLINK planted under the root IS served, here and on the
 *    entry lane, because no path-based check can see one. That is an accepted,
 *    bounded residual with a named anti-fix (`st_nlink`/same-device rejection —
 *    do NOT add either); the whole list lives in the kernel primitive
 *    `@neuralis/package-system/paths` (`containment.ts`), and
 *    is not restated here.
 *  - `.html` and `.htm` are refused: this lane must never serve a DOCUMENT that
 *    could be used as an alternative frame `src` (see
 *    `PACKAGE_APP_PUB_DENIED_EXTS`). `.svg` is allowed because the anti-
 *    navigation `Content-Security-Policy: sandbox` now arrives from this lane's
 *    own path-scoped header rule.
 *
 * REVOCATION without a caller. The record's `generation` is re-compared against
 * the CURRENT registry definition on every request (`getDefinitionGeneration` is
 * a WeakMap identity stamp — a package update / reload replaces the definition
 * object, and an uninstall drops it from the registry), plus the loader's
 * fail-closed `status: 'error'` check. That covers load-status, update and
 * uninstall immediately. It does NOT cover the per-agent `config.packages`
 * toggle — neither does the authenticated lane, so that is parity, not a
 * regression. Caller-side losses (role/feature/scope/trust) revoke the record
 * through the entry lane's heartbeat, after which this lane 404s too.
 *
 * A LEAKED TOKEN CANNOT PROLONG A SCOPE. This lane may refresh the record's idle
 * window only inside `PACKAGE_APP_PUB_TOUCH_MAX_AGE_MS` of the scope's creation —
 * long enough that a bundle cannot expire during its own initial load, and short
 * enough that the client's first heartbeat has taken over. After that the lane
 * serves without refreshing, so once the legitimate client stops heartbeating the
 * scope dies within the idle TTL regardless of token traffic. This is a bound on
 * how long a leak stays useful; it is NOT a claim that anything revokes in 60 s.
 *
 * PER-SCOPE BUDGET. A multi-file surface turns one scope into many files, so
 * beyond the per-file byte cap the record carries a distinct-path budget
 * (`PACKAGE_APP_PUB_MAX_FILES` / `PACKAGE_APP_PUB_MAX_TOTAL_BYTES`). It is
 * enforced CHECK-THEN-INSERT, synchronously, BEFORE the `readFile` await:
 * insert-then-check would let one valid token grow the map without bound on a
 * route that has no session, and two concurrent requests could both slip past
 * the cap. Charging before the read means a FAILED read would otherwise consume
 * a slot and its bytes for the scope's whole life while answering 404, so that
 * one path REFUNDS exactly what it charged — a refund keeps the ordering (and
 * therefore the anti-growth property) intact, whereas moving the check after
 * the read would not.
 *
 * Response floor: `Cache-Control: no-store` (revocation must leave no
 * executable cache window) + `Referrer-Policy: no-referrer` (the token must not
 * ride a Referer header) + `X-Content-Type-Options: nosniff` +
 * `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy:
 * cross-origin` (an opaque-origin frame's module-script / `fetch` / font loads
 * are CORS-mode and would otherwise fail). `Access-Control-Allow-Credentials`
 * is NEVER sent — the wildcard origin is safe precisely because this lane
 * carries no authentication.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getPackageAssetScopeAuthority } from './PackageAssetScopeAuthority';
import { getDefinitionGeneration } from './packageVisibility';
import { getCommunityPackageRegistry } from './runtime';
import { getPackageRuntimeManager } from './PackageRuntimeManager';
import { ensureProjectPackagesLoaded } from './projectPackages';
import {
  PACKAGE_APP_ASSET_MAX_BYTES,
  PACKAGE_APP_PUB_MAX_FILES,
  PACKAGE_APP_PUB_MAX_TOTAL_BYTES,
  PACKAGE_APP_PUB_TOUCH_MAX_AGE_MS,
} from './packageAppAssetCsp';
import {
  PACKAGE_APP_PUB_MIME_BY_EXT,
  openContainedAssetFile,
  parseAssetRequest,
  resolveContainedAssetPath,
} from './packageAppAssetFile';
import { getLogger } from '../logging/setup';

/**
 * The lane's ENTIRE error vocabulary. Every refusal is this response — there is
 * deliberately no 401/403/410 variant to add.
 *
 * `no-store` is on the 404 for a reason: a refusal here can be TRANSIENT. A
 * generation recheck that fires while `ensureProjectPackagesLoaded` is reloading
 * answers 404 for a scope that is about to be valid again, and a heuristically
 * cached transient 404 would pin a live widget's subresource dead for the rest of
 * the document's life. ONE helper, so all nine refusal paths get it.
 *
 * Nothing ELSE belongs on this response. No `Access-Control-Allow-Origin`, no
 * `Cross-Origin-Resource-Policy` — the lane's 404s stay opaque to a cross-origin
 * reader, which is measured and intended.
 */
function notFound(): NextResponse {
  return NextResponse.json(
    { error: 'Not found' },
    { status: 404, headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function handlePackageAppPubGet(
  req: NextRequest,
  token: string,
  pathSegments: string[],
): Promise<Response> {
  // 1. Token lookup FIRST — an unguessed token must cost exactly one map
  //    lookup, so the lane can never be used as a work amplifier.
  const authority = getPackageAssetScopeAuthority();
  const record = authority.getByPubToken(token);
  if (!record) return notFound();

  // 2. Namespace + extension allowlist, still before any fs or registry work.
  //    `.html` and `.htm` die here.
  const parsed = parseAssetRequest(pathSegments, PACKAGE_APP_PUB_MIME_BY_EXT);
  if (!parsed.ok) return notFound();

  // 3-5. Caller-free generation recheck: the package must still be registered
  //      AND still be the SAME definition object the scope was minted against.
  //      Drift (update / reload / uninstall) revokes the whole scope, so the
  //      entry lane 410s on its next request too.
  await ensureProjectPackagesLoaded(record.projectId);
  const definition = getCommunityPackageRegistry()
    .listPackages()
    .find((candidate) => candidate.id === record.packageId);
  if (!definition) {
    authority.revoke(record.handle);
    return notFound();
  }
  if (getDefinitionGeneration(definition) !== record.generation) {
    authority.revoke(record.handle);
    return notFound();
  }

  // 6. Fail-closed load status, mirroring the authenticated lane.
  const status = getPackageRuntimeManager().getLoader().getStatus(record.packageId);
  if (status?.status === 'error') return notFound();

  // 7. Containment, LEXICAL half: surface/* → the EXACT dedicated surface root;
  //    shared/* → the EXACT app/shared root. BOTH failure reasons answer 404
  //    here (the authenticated lane's 403-on-escape must never leak into this
  //    lane).
  const root = parsed.namespace === 'surface' ? record.surfaceRoot : record.sharedRoot;
  const contained = resolveContainedAssetPath(root, parsed.rest);
  if (!contained.ok) return notFound();

  // 8. Containment, REAL half + the per-file byte cap, on ONE descriptor.
  //    `openContainedAssetFile` realpaths the root AND the request before it
  //    opens anything, so a symlink under the surface root that points out of it
  //    is an escape rather than bytes — this lane serves without any caller at
  //    all, so it is the one that must never follow a link out. The cap is
  //    applied to the descriptor's own stat, before the read. Every reason maps
  //    to the same 404.
  const opened = await openContainedAssetFile(
    root,
    contained.absPath,
    PACKAGE_APP_ASSET_MAX_BYTES,
  );
  if (!opened.ok) {
    if (opened.reason === 'too_large') {
      getLogger()
        .child('package-app-pub')
        .warn(
          `Package app asset exceeds the ${PACKAGE_APP_ASSET_MAX_BYTES}-byte cap ` +
            `(${opened.size} bytes) for package '${record.packageId}' ` +
            `surface ${record.surfaceKind}/${record.surfaceId}; refusing to serve.`,
        );
    }
    return notFound();
  }

  // FROM HERE THE DESCRIPTOR IS OPEN — every path out of this block, including
  // the budget refusal below, MUST close it. A leaked fd per refused request on
  // a lane with no session and no caller to rate-limit is a denial of service
  // created by the security fix, which is why the close is a `finally` spanning
  // the whole block rather than a line before each `return`.
  try {
    // 9. Per-scope budget — CHECK-THEN-INSERT, synchronously, before any await.
    //    The key is the LEXICALLY resolved absolute path: canonical (so
    //    `a/./b.css` and `a/b.css` are one entry) and collision-free across
    //    namespaces (the surface and shared roots are disjoint). It must NOT
    //    become the realpath: two spellings that resolve to the same file would
    //    then share one budget entry, which is a loosening, and the landed tests
    //    pin this key. An already-served path is free.
    const budgetKey = contained.absPath;
    let chargedHere = false;
    if (!record.servedPublic.has(budgetKey)) {
      let servedBytes = 0;
      for (const bytes of record.servedPublic.values()) servedBytes += bytes;
      if (
        record.servedPublic.size + 1 > PACKAGE_APP_PUB_MAX_FILES ||
        servedBytes + opened.size > PACKAGE_APP_PUB_MAX_TOTAL_BYTES
      ) {
        getLogger()
          .child('package-app-pub')
          .warn(
            `Package app public asset budget exhausted for package ` +
              `'${record.packageId}' surface ${record.surfaceKind}/${record.surfaceId} ` +
              `(${record.servedPublic.size} files / ${servedBytes} bytes served, ` +
              `caps ${PACKAGE_APP_PUB_MAX_FILES} / ${PACKAGE_APP_PUB_MAX_TOTAL_BYTES}); ` +
              `refusing to serve.`,
          );
        return notFound();
      }
      record.servedPublic.set(budgetKey, opened.size);
      chargedHere = true;
    }

    // 10. The read happens on the SAME descriptor the cap was measured on, so
    //     the stat and the read are atomic with respect to the path: a file
    //     renamed or replaced underneath cannot make the declared
    //     `Content-Length` disagree with the body, and a symlink swapped into
    //     the final component after the check cannot be followed. What remains
    //     is an I/O failure, and this catch keeps THAT inside the lane's uniform
    //     404 instead of letting it escape as a framework 500 that would
    //     distinguish "was here" from "never existed".
    let buffer: Buffer;
    try {
      buffer = await opened.handle.readFile();
    } catch {
      // REFUND what THIS request charged. The budget is deliberately charged
      // before the read (see above), so without this a failed read would burn a
      // distinct-path slot AND its bytes for the whole life of the scope while
      // answering 404 — enough repeated I/O failures would starve a legitimate
      // widget's remaining subresources.
      //
      // It is a refund, not a re-ordering: the check-then-insert stays
      // synchronous and before the await, so the anti-growth property is
      // untouched — this can only ever SHRINK the map. `chargedHere` is what
      // keeps it honest; an already-served path was accounted by an earlier
      // request that may well have delivered its bytes, and deleting THAT entry
      // would be a loosening rather than a correction.
      if (chargedHere) record.servedPublic.delete(budgetKey);
      return notFound();
    }

    // 11. A served asset keeps the scope alive — a large bundle must not expire
    //     underneath its own load — but ONLY inside an absolute window measured
    //     from `createdAt`. Past it the lane still serves and simply stops
    //     refreshing, so a leaked token cannot keep a scope alive by itself; once
    //     the legitimate client stops heartbeating, the scope dies within the idle
    //     TTL. (This bounds LIFE-EXTENSION, not serving: hard-expiring the lookup
    //     would 404 a legitimately open widget's late-loaded chunks.) Reuses the
    //     ONE `touch` method and its ONE clock; there is no pub-lane time source.
    authority.touch(record.handle, {
      maxAgeSinceCreationMs: PACKAGE_APP_PUB_TOUCH_MAX_AGE_MS,
    });

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': parsed.mime,
        // The STAT size, deliberately not `buffer.length` — the same split the
        // authenticated lane uses. Both now come from ONE descriptor, so the
        // replacement race that used to make them divergeable is closed rather
        // than merely tolerated.
        'Content-Length': String(opened.size),
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      },
    });
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}
