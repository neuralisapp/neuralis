/**
 * Host security headers — the pure value behind next.config `headers()`.
 *
 * Extracted from `next.config.ts` so the rule set is unit-testable without a
 * running server (the FINAL proof of the wire behaviour is still a live
 * wire-assert — Next's duplicate-key semantics are reproduced on the running
 * server, see the CARD1 3B note below).
 *
 * ORDERING IS LOAD-BEARING. Next applies EVERY matching `headers()` rule in
 * array order and, for a non-`set-cookie` key, the LAST write to the exact key
 * wins (`next/dist/server/lib/router-utils/resolve-routes.js`:
 * `resHeaders[key] = value`). The existing `/mcp-sandbox` rule already relies
 * on this (its `Content-Security-Policy: frame-ancestors *` overrides the
 * global CSP). So:
 *  - the global `/:path*` rule stays FIRST with its permissive values,
 *  - the more-specific `/api/package-app/:path*` rule comes AFTER it so its
 *    stricter `Referrer-Policy: no-referrer` + the locked-down CSP
 *    deterministically OVERRIDE the permissive global values on the virtual
 *    package-asset route (CARD1 3B header-override fix — the route-handler
 *    `Response` headers were being masked by the global rule on the wire), and
 *  - the `/api/package-app/_pub/:path*` rule comes AFTER **both**, because it
 *    overrides the package-app CSP in turn with the session-free lane's
 *    anti-navigation `sandbox` policy. It must stay LAST of the three: moved
 *    earlier, the package-app rule would win and a navigated `_pub` document
 *    would execute script again.
 *
 * The PACKAGE ROUTE lane (`/api/packages/*`, note `packages` ≠ `package-app`)
 * follows the same shape and is INDEPENDENT of those three — the paths are
 * disjoint, so only its own pair matters: the `/api/packages/:path*` sandbox
 * rule comes AFTER the global rule, and the two machine-core stream rules come
 * AFTER that one because they RESTORE `GLOBAL_CSP` for the one package route
 * that legitimately serves a navigable HTML document. Reorder those two before
 * the sandbox rule and the KasmVNC desktop dies silently — the shell would load
 * into an opaque origin with no script and simply never connect.
 *
 * That third rule carries the CSP key ALONE, deliberately. It does NOT re-declare
 * `X-Content-Type-Options` / `Referrer-Policy` — the identical values already
 * arrive from the two earlier rules and survive untouched — and it does NOT carry
 * `Access-Control-Allow-Origin`, because no config rule writes that key, so the
 * route's own `ACAO: *` reaches the wire (the same reason `Cache-Control`
 * survives today). Adding ACAO here would also start attaching it to the lane's
 * 404s, which must stay opaque.
 *
 * The override only holds if the key CASING matches the global rule exactly
 * (`resHeaders` is keyed by the raw string); a different casing degrades into a
 * duplicate/merged header. Keep the casing identical.
 */
import {
  buildPackageAppAssetCsp,
  PACKAGE_APP_PUB_CSP,
} from '../packages/packageAppAssetCsp';

export type SecurityHeaderRule = {
  source: string;
  headers: Array<{ key: string; value: string }>;
};

/**
 * The permissive baseline the whole app runs under. Named because the
 * machine-core stream rules below must RESTORE exactly this value — two
 * spellings of one policy would drift the moment either is edited.
 */
const GLOBAL_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: http: https:",
  // Trusted package widgets may embed remote HTTPS if the package
  // trust level allows it; untrusted absolute widget URLs are
  // rejected before snapshots reach the browser. `http:` remains
  // for local machine-core/Webtop on port 3101.
  "frame-src 'self' blob: http: https:",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ');

/**
 * Anti-navigation floor for the PACKAGE ROUTE lane (`/api/packages/*`).
 *
 * Same directive, same reasoning as the `_pub` asset lane: `sandbox` affects
 * DOCUMENT responses only — JSON bodies, SSE streams and subresource loads
 * (`<img src>` / `<video src>` against brain-core's `raw` route) are provably
 * undisturbed — while any NAVIGATED document served on the lane opens in an
 * opaque origin with no script.
 *
 * It exists because package routes may serve caller-influenced bytes. The
 * measured case: brain-core `raw` echoed a member-written file's mime with
 * `content-disposition: inline`, so an SVG carrying `<script>` executed on the
 * app origin with the READER's session. brain-core now serves the
 * active-document class as `attachment` (the primary fix, in
 * `packages/brain-core/src/domain/mime.ts`); this header is the second layer.
 *
 * **It is NOT merely a net for a forgetful first-party author — it is untrusted
 * GUEST containment, which is why it is not deletable on "no first-party route
 * needs it" grounds.** `PackageWasmRunner` returns the WASM guest's own
 * `PackageRouteResponse` — headers included — and the catch-all forwards any
 * non-JSON content-type verbatim. So an untrusted `_packages/` drop can emit
 * `content-type: text/html` and would otherwise get a live document on the app
 * origin.
 *
 * Neither layer may be described as sufficient alone: this one is host config a
 * deployment could reorder, and the brain-core one cannot see the wire.
 *
 * `Content-Disposition: attachment` responses are NOT affected by `sandbox`:
 * download blocking reads the INITIATOR document's sandbox flags, and an
 * attachment response never creates a Document, so `allow-downloads` is not
 * needed here. (A download started from inside an already-sandboxed frame WOULD
 * be blocked — so a future download affordance must not live in a `_pub` /
 * `_scope` iframe.)
 *
 * One wire shape that reads like a missing rule and is not: a trailing-slash URL
 * (`…/stream/`) answers **308** with NO CSP header at all — Next's
 * `trailingSlash` normalization runs before `headers()`, app-wide. The 308 has
 * no body and creates no Document; the redirect target matches `:path*` with
 * zero segments and carries the correct single header.
 */
const PACKAGE_ROUTE_CSP = 'sandbox';

export function buildSecurityHeaders(): SecurityHeaderRule[] {
  return [
    {
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Content-Security-Policy', value: GLOBAL_CSP },
      ],
    },
    {
      // The package-route anti-navigation floor. AFTER the global rule so it
      // wins the exact key by last-write; it carries the CSP key ALONE, so
      // nosniff / X-Frame-Options / Referrer-Policy still arrive from the
      // global rule untouched.
      source: '/api/packages/:path*',
      headers: [{ key: 'Content-Security-Policy', value: PACKAGE_ROUTE_CSP }],
    },
    // machine-core's KasmVNC proxy is the ONE package route that legitimately
    // serves a navigable HTML DOCUMENT (`StreamProxy` emits `text/html`), so it
    // gets the global policy back. Both package-id spellings are restored
    // because the catch-all resolves both (`splitPackagePath` rejoins a scoped
    // `@neuralis/machine-core` from two URL segments, and the shipped skills use
    // the scoped form) — restoring only one would leave the other lane serving
    // the desktop shell under `sandbox`, i.e. a silently dead desktop.
    //
    // The LIVE widget iframe rides the `:3101` companion server, which
    // `next.config` headers never touch; these rules keep the catch-all lane
    // working for whichever spelling a deployment serves.
    {
      source: '/api/packages/machine-core/session/:key/stream/:path*',
      headers: [{ key: 'Content-Security-Policy', value: GLOBAL_CSP }],
    },
    {
      source: '/api/packages/@neuralis/machine-core/session/:key/stream/:path*',
      headers: [{ key: 'Content-Security-Policy', value: GLOBAL_CSP }],
    },
    {
      // CARD1 3B header-override. The virtual package-app asset route
      // (`/api/package-app/_scope/{handle}/…`) must carry the STRICT untrusted
      // floor on the wire — `no-referrer` + the locked-down CSP — for EVERY
      // package-app asset (trusted included; documented v1 hardening). This
      // rule sits AFTER the global `/:path*` rule so it overrides the
      // permissive `Referrer-Policy` + CSP by last-write on the exact key. The
      // route handler still sets `Cache-Control: private, no-store` (absent
      // from the global set, so it survives) + its own untrusted CSP as
      // defense-in-depth. The strict CSP is defined ONCE in
      // `packageAppAssetCsp.ts`.
      source: '/api/package-app/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'Content-Security-Policy', value: buildPackageAppAssetCsp() },
      ],
    },
    {
      // The SESSION-FREE subresource lane's anti-navigation floor. `sandbox`
      // affects DOCUMENT responses only — subresource loading is provably
      // undisturbed — so this costs a bundle nothing while making any NAVIGATED
      // `_pub` response (an SVG, a stray document type) open in an opaque origin
      // with no script. It is the header that lets `.svg` stay in the public
      // allowlist; deny `.svg` again in the SAME change if this rule ever goes.
      //
      // MUST remain AFTER `/api/package-app/:path*` (last-write-wins on the exact
      // key) and carries the CSP key ALONE — see the module docstring.
      source: '/api/package-app/_pub/:path*',
      headers: [{ key: 'Content-Security-Policy', value: PACKAGE_APP_PUB_CSP }],
    },
    {
      // MCP Apps sandbox shell (MCP1-C). The shell is framed by the MAIN
      // origin from a DIFFERENT PORT (the sandbox origin), so the global
      // `X-Frame-Options: SAMEORIGIN` would refuse it (XFO compares the
      // full origin incl. port). `frame-ancestors` supersedes XFO in every
      // modern browser; static config cannot derive the request hostname,
      // so the header is permissive and the ENFORCEMENT is the shell's
      // message-level bootstrap hostname pin (a foreign embedder gets an
      // inert page — it can never seed HTML onto the sandbox origin).
      // The CSP carries ONLY frame-ancestors: the inner written document
      // inherits the shell's CSP, and the app template must be governed
      // SOLELY by its own server-injected <meta> CSP.
      source: '/mcp-sandbox',
      headers: [
        { key: 'X-Frame-Options', value: 'ALLOWALL' },
        { key: 'Content-Security-Policy', value: 'frame-ancestors *' },
      ],
    },
    {
      // KasmVNC (the JS inside the machine-core iframe) asks for
      // screen-wake-lock + fullscreen + autoplay. Granting these on the
      // /machine/* path only keeps the rest of the app locked down.
      source: '/machine/:path*',
      headers: [
        {
          key: 'Permissions-Policy',
          value: [
            'fullscreen=(self)',
            'screen-wake-lock=(self)',
            'clipboard-read=(self)',
            'clipboard-write=(self)',
            'autoplay=(self)',
          ].join(', '),
        },
      ],
    },
  ];
}
