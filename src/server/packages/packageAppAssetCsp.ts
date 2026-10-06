/**
 * Hard byte cap for ONE served package-app asset (CARD1 3C).
 *
 * This is a MEMORY bound, not a self-containment gate: the route serves a
 * `_packages/`-supplied file on a `no-store` path reachable by every project
 * member, and the B-baseline (self-contained entry — inline CSS/JS + `data:`
 * URIs) makes entries structurally larger. The cap is enforced on the `stat`
 * size BEFORE `readFile`, and an over-cap request answers the route's uniform
 * `404` so the non-enumerating error vocabulary is preserved; the actionable
 * diagnostic belongs to the authoring preflight, never to the wire.
 *
 * 2 MiB matches the in-repo sibling floor for the SAME artifact class (a
 * self-contained sandboxed HTML UI document): agent-core's MCP App template
 * cap (`NEURALIS_MCP_APP_TEMPLATE_MAX_KB`, default 512 KB).
 *
 * It stays a CODE constant, never a `configSettings[]` key — CLAUDE.md
 * principle 9 keeps untrusted-input caps in code (same "one floor, declared
 * once" pattern as `buildPackageAppAssetCsp` below).
 */
export const PACKAGE_APP_ASSET_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Per-scope DISTINCT-FILE budget for the session-free subresource lane.
 *
 * The 2 MiB cap above bounds ONE file. A multi-file surface turns a single
 * scope into an arbitrary number of files, so the session-free lane needs a
 * second bound: at most this many DISTINCT resolved paths may ever be served
 * under one scope. A repeat request for an already-served path is free (a
 * re-render must not consume budget); the count is checked BEFORE the entry is
 * recorded, so the map can never exceed it.
 *
 * It stays a CODE constant, never a `configSettings[]` key — CLAUDE.md
 * principle 9 keeps untrusted-input caps in code (same "one floor, declared
 * once" pattern as `PACKAGE_APP_ASSET_MAX_BYTES` above).
 */
export const PACKAGE_APP_PUB_MAX_FILES = 64;

/**
 * Per-scope TOTAL-BYTE budget for the session-free subresource lane, summed
 * over the DISTINCT paths already served under that scope.
 *
 * 64 files at the 2 MiB per-file cap would otherwise be 128 MiB of resident
 * accounting per scope; 8 MiB is the deliberate ceiling for one surface's whole
 * asset set. Over-budget answers the lane's uniform 404 with a server-side
 * warning — never a 413, so the non-enumerating error vocabulary holds.
 *
 * It stays a CODE constant, never a `configSettings[]` key — CLAUDE.md
 * principle 9 keeps untrusted-input caps in code (same "one floor, declared
 * once" pattern as `PACKAGE_APP_ASSET_MAX_BYTES` above).
 */
export const PACKAGE_APP_PUB_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

/**
 * Anti-navigation floor for the SESSION-FREE subresource lane
 * (`/api/package-app/_pub/…`), delivered by its own path-scoped `headers()` rule
 * in `securityHeaders.ts`.
 *
 * TWO facts make this one word load-bearing:
 *
 *  1. The `sandbox` directive affects DOCUMENT responses ONLY. It was measured
 *     directly (two engines) that a lane carrying `Content-Security-Policy:
 *     sandbox` serves stylesheets, classic and module scripts, images, fonts and
 *     `fetch` results field-for-field identically to the same lane without it —
 *     so it costs the bundle nothing.
 *  2. It is the ONLY thing that makes a NAVIGATED `_pub` document script-free. An
 *     SVG opened as a navigation IS a document, and the asset CSP's
 *     `'unsafe-inline'` would run its inline `<script>`. On the authenticated lane
 *     that needs the secret handle AND the owner's live cookie; on a session-free
 *     lane a leaked token alone would be enough. This is exactly why `.svg`
 *     re-admission to the public allowlist is gated on this header being OBSERVED
 *     on the wire — see `PACKAGE_APP_PUB_DENIED_EXTS` in `packageAppAssetFile.ts`.
 *
 * Never remove the `_pub` header rule without denying `.svg` again in the SAME
 * change.
 */
export const PACKAGE_APP_PUB_CSP = 'sandbox';

/**
 * Absolute, `createdAt`-anchored ceiling on the PUBLIC lane's ability to EXTEND a
 * scope's life. Past this age the lane still SERVES, but it no longer refreshes
 * `lastSeenAt`.
 *
 * The reasoning, because the number is not arbitrary: the pub-lane `touch` exists
 * for exactly ONE purpose — so that a large bundle cannot expire during its own
 * initial load. Liveness after that belongs to the client, whose FIRST heartbeat
 * lands at `ASSET_SCOPE_HEARTBEAT_MS = 60_000`
 * (`src/workspace/packages/packageAssetScope.ts`) and owns the idle window from
 * then on. 60 s is therefore exactly sufficient, and it must NEVER be set BELOW
 * the client heartbeat period — a lower value would let a bundle whose client is
 * alive and heartbeating still fall out of its own load window.
 *
 * What it buys: a leaked `pubToken` can no longer keep a scope alive by itself.
 * Once the legitimate client stops heartbeating, the record dies within the idle
 * TTL no matter how much traffic the token attracts.
 *
 * It stays a CODE constant, never a `configSettings[]` key — CLAUDE.md principle
 * 9 keeps untrusted-input caps in code.
 */
export const PACKAGE_APP_PUB_TOUCH_MAX_AGE_MS = 60_000;

/**
 * The strict Content-Security-Policy for the virtual package-app asset route
 * (`GET /api/package-app/_scope/{handle}/…`, CARD1 3A). ONE source of truth,
 * shared by:
 *  - the route handler (`packageAppAssetGet.ts`) — the floor on the `Response`,
 *    kept as defense-in-depth;
 *  - the next.config path-scoped `headers()` rule (`securityHeaders.ts`) — which
 *    applies it to EVERY package-app asset (trusted included, a documented v1
 *    hardening) so the permissive global `/:path*` CSP can never mask it on the
 *    wire (CARD1 3B header-override fix).
 *
 * Keep the two consumers in lockstep — this is the same floor, declared once. It
 * takes NO parameters: every directive is a fixed decision, and the one that was
 * briefly parameterised (`base-uri`) is discussed at the end of this comment.
 *
 * `base-uri 'self'` (it was `'none'`). `'none'` forbids the `<base>` ELEMENT
 * outright, which would make the server-injected bundle-mode `<base href>`
 * silently inert — the relative subresources would then resolve back into the
 * document directory rather than the session-free lane, with nothing thrown and
 * the document still alive. `'self'` was measured to permit it: inside an OPAQUE
 * sandboxed document `'self'` resolves to the PRECURSOR origin (the origin that
 * served the document), and the injected href is ROOT-RELATIVE, so it matches on
 * both engines. The matched one-token control (`base-uri 'none'`, byte-identical
 * otherwise) reports a `base-uri` violation and falls back to the document
 * directory, so the permission is real rather than assumed.
 *
 * `script-src` carries `'unsafe-inline'` SYMMETRICALLY with `style-src` (F-LIVE-1,
 * CARD1 3B): a package-app asset renders inside an OPAQUE-origin sandbox iframe
 * (`sandbox="allow-scripts allow-forms"`, NO `allow-same-origin`), and a
 * self-contained card/widget MUST run an inline `neuralis:card-ready` bootstrap
 * `<script>` to open the `neuralis:card-data/v1` channel. With `script-src 'self'`
 * (asymmetric) that inline script was CSP-blocked and the channel never opened on
 * the wire. The isolation boundary is the sandbox itself (opaque origin — no
 * parent DOM / cookie / network access); this CSP is defense-in-depth on the
 * package's OWN content, so `'unsafe-inline'` here does not cross a trust line. It
 * also matches the ratified MCP Apps spec default (`script-src 'self'
 * 'unsafe-inline'`). `'unsafe-eval'` and remote `connect-src` stay OUT.
 *
 * `connect-src 'self'` does NOT open the API to package code. A `fetch()` from an
 * opaque origin is CORS-MODE, and the authenticated routes send no
 * `Access-Control-Allow-Origin`, so the response is unreadable. Only the
 * session-free lane (`ACAO: *`, no authentication) can be read — which is the
 * whole point of it being session-free. This is the most likely misreading of
 * this policy; do not "tighten" `connect-src` on the theory that it grants API
 * access, and do not widen it on the theory that it does not.
 *
 * `sandbox allow-scripts allow-forms` is the ANTI-NAVIGATION floor for the ENTRY
 * lane, and it exists because of a measured live escalation: a `_scope` document
 * opened as a top-level NAVIGATION (rather than framed by the workspace) ran its
 * inline script on the MAIN origin — `origin: http://localhost:3100` — with a
 * three-way matched control on identical bytes (no CSP ⇒ runs; `CSP: sandbox` ⇒
 * blocked, origin `null`; this policy without the directive ⇒ runs). It covers the
 * WHOLE document class the lane serves — `.svg`, a non-entry `.html`, and the
 * entry itself — which is why it is one directive here rather than an
 * extension-scoped patch somewhere else.
 *
 * IT COSTS THE FRAME NOTHING. The entry is ALWAYS loaded inside
 * `sandbox="allow-scripts allow-forms"` (`IframeCard.tsx` / `IframeWidget.tsx`), so
 * it is already opaque and never had the same-origin privilege. These two flags
 * are the exact mirror of that attribute, and the effective sandbox set is the
 * INTERSECTION of the two identical sets — unchanged. What the directive removes
 * is the privilege a NAVIGATED or same-origin-EMBEDDED copy of the same document
 * would otherwise inherit: script may still run, but `document.cookie` throws and
 * `fetch('/api/*')` is uncredentialed and unreadable.
 *
 * RESIDUAL, stated honestly and NOT as "script-neutered" — the directive GRANTS
 * `allow-scripts`, so a navigated document still RUNS its script and still
 * RENDERS, on the host's own hostname. What it loses is the ORIGIN: opaque, so
 * `document.cookie` throws and a credentialed `fetch` is unreadable. A leaked url
 * therefore remains a phishing-shaped surface with a live, scripted page on it —
 * identical for `.html` and `.svg`. Closing that needs a separate origin, which is
 * the deferred second shape, not this floor.
 *
 * NEVER add `allow-same-origin` to this policy. It is the one edit that "makes the
 * entry work again" if anything in the frame ever looks broken, and it would hand
 * every package's UI the host origin — cookies, same-origin `fetch`, parent DOM.
 * If the frame breaks, re-measure the FLAG SET; do not grant same-origin. (The
 * trusted-remote bridge frame — `BRIDGE_SANDBOX`, which does carry
 * `allow-same-origin` — never loads this lane: `resolveBridgeProfile` requires
 * `source.kind === 'absolute'` with a remote HTTPS origin, verified at the call
 * site, and an asset-backed surface can never reach it.)
 *
 * The path-prefixed source form (`<origin>/api/package-app/_pub/` instead of
 * `'self'` on script/style/img/font/connect) is a deliberate DEFERRAL, not an
 * oversight: it is a tightening (`'self'` also matches the main app's own
 * same-origin files, e.g. `_next/static/**`), not a functional requirement, and
 * it needs an absolute origin this deployment cannot derive — `headers()` is
 * serialized into `routes-manifest.json` at BUILD time, and no Docker channel
 * passes a hostname build ARG, so a config-derived origin could only ever bake a
 * wrong value or none.
 *
 * WHEN THAT TIGHTENING IS PICKED UP, DO NOT DERIVE THE ORIGIN FROM THE REQUEST.
 * This function briefly carried an optional `assetOrigin` parameter with no
 * producer, and the only producer anyone would reach for is the `Host` header —
 * which is attacker-controlled. Naming an attacker's origin inside `base-uri` is
 * one directive away from naming it inside `script-src`, i.e. the same class of
 * defect as putting a foreign origin in a source list. The parameter was removed
 * rather than left as a loaded gun; the deferral itself still stands, and the
 * tightening belongs in a change that also decides where a TRUSTWORTHY absolute
 * origin comes from.
 */
export function buildPackageAppAssetCsp(): string {
  return [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "form-action 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
    'sandbox allow-scripts allow-forms',
  ].join('; ');
}
