# Package API Routes

This directory exposes the host HTTP surface for Neuralis packages.

## Primary Route

`/api/packages/[...path]` is the preferred route for package APIs. It authenticates the user, verifies project membership, resolves the role and granted features, rejects sentinel identities, loads project packages, and dispatches to the package route handler.

Dispatch awaits the runtime’s kernel `whenReady()` contract; a startup failure
returns a service-unavailable response and never falls through to dispatch.

Authentication order (exactly two arms — there is no synthetic-owner /
platform-bearer path):

1. NextAuth cookie session (always wins when present).
2. `Authorization: Bearer nrs1.<requestId>.<secret>` — the per-stream session
   ticket, injected into the in-container shell env as `NEURALIS_SESSION_TOKEN`
   and forwarded by skill scripts. It is tried **only as a fallback when no
   cookie session resolved**. `src/server/auth/sessionTicketAuth.ts`
   (`tryResolveSessionTicket` → runtime `session-ticket-verifier` service) recovers the
   real `SessionContext` from the live stream scope — the route uses its
   `userId`/`projectId`/`role`/`grantedFeatures` directly (no caller-supplied
   identity). A successful call is audited `audit.action: 'skill.session_call'`.

Deny-by-default: a ticket that **is present but fails verification never falls
through** to the cookie/anonymous path — the route returns **401** and audits
`audit.action: 'skill.session_ticket_rejected'`. The `__system__` sentinel is
rejected at the boundary (`assertNotSentinel`; `SENTINEL_SET` holds exactly the
three `__system__` values). `__skill__` is an audit principal deliberately
OUTSIDE that set — it is refused on its own path instead, by
`executeSkillAction`'s explicit `=== SKILL_USER_ID` chain check, so a skill
cannot mint a ticket from another skill's identity.

Example:

```text
/api/packages/agent-core/agents
/api/packages/brain-core/filesystem/list
/api/packages/agent-core/workflow
```

### Response headers on this lane

A package route's `headers` are forwarded **verbatim** for any non-JSON
response, so a route that serves bytes chooses its own `content-type` and
`content-disposition`. That is deliberate — the byte route knows what it is
serving — but it means the host must not assume every package author gets it
right. Hence the path-scoped rule in `src/server/config/securityHeaders.ts`:

- **`/api/packages/:path*` carries `Content-Security-Policy: sandbox`**, placed
  AFTER the global `/:path*` rule so it wins the exact key by last-write. Same
  directive and the same measured reasoning as the `_pub` asset lane: `sandbox`
  affects DOCUMENT responses only, so JSON bodies, SSE streams and subresource
  loads (`<img src>` / `<video src>` against brain-core's `raw` route) are
  undisturbed, while any NAVIGATED document served here opens in an opaque
  origin with no script. It carries the CSP key alone — nosniff,
  `X-Frame-Options` and `Referrer-Policy` keep arriving from the global rule.
- **machine-core's KasmVNC proxy gets the global policy back**, in BOTH
  package-id spellings (`machine-core` and `@neuralis/machine-core` — the
  catch-all resolves both, since `splitPackagePath` rejoins a scoped id from two
  URL segments). It is the one package route that legitimately serves a
  navigable HTML document; under `sandbox` the shell would load into an opaque
  origin and never connect, i.e. a silently dead desktop. Those two rules must
  stay AFTER the sandbox rule — reordering them re-arms exactly that failure.

**The header rule is the SECOND layer, never the first.** The route that serves
caller-influenced bytes owns the primary decision: brain-core's `raw` classifies
the mime and serves the active-document class (SVG, HTML, XML) as
`attachment` — see `packages/brain-core/src/routes/README.md`. Neither layer may
be described as sufficient alone: this one is host config a deployment could
reorder, and the package cannot see the wire.

**And the rule is untrusted-GUEST containment, not just authoring hygiene — so
it is not deletable on the grounds that no first-party route needs it.**
`PackageWasmRunner` returns the WASM guest's own `PackageRouteResponse`, headers
included, and this route forwards a non-JSON content-type verbatim; an untrusted
`_packages/` drop can therefore emit `content-type: text/html`. The `sandbox`
directive is what stops that from becoming a live document on the app origin.

Two shapes worth knowing so they are not misread later: an `attachment` response
is unaffected by `sandbox` (download blocking reads the INITIATOR document's
flags, and an attachment creates no Document), and a trailing-slash URL answers
**308 with no CSP header at all** — Next's `trailingSlash` normalization runs
before `headers()`, app-wide. The 308 carries no body and creates no Document;
its redirect target gets the correct single header.

## Snapshot Routes

The workspace also uses lightweight snapshot routes:

| Route | Purpose |
|---|---|
| `/api/packages/runtime` | Full package runtime snapshot, plus a host-side `ui` view beside it (the runtime UI modules of the packages the caller's snapshot shows + the union stylesheet; a build failure drops `ui`, never the snapshot) |
| `/api/packages/widgets` | Widget contributions |
| `/api/packages/dock` | Dock contributions |
| `/api/packages/commands` | Command contributions |

These routes must apply the same project-membership expectations as the catch-all route before returning project-scoped data.

There is no dedicated package-runtime SSE route: runtime invalidation
notifications ride the shared multiplexed `/api/events` hub, on its `runtime`
channel. The workspace subscribes through `runtimeClient.subscribeToRuntimeEvents`
(a direct `subscribeHub({ channel: 'runtime' })`); package widgets reach the same
hub through the `WorkspaceHostPort.subscribeRealtime` wrapper.

## Package Management Routes

Install, publish, rescan, build, trust, query, and command routes are host-owned because they affect package lifecycle and project state. They should never trust caller-provided project roots and should be restricted to owner/admin users or explicit package-management features.

## Identity-Free Package Asset Scope

The legacy `GET /api/packages/{slug}/app/*` static asset route is **DELETED**
— it exposed the runtime package id (which can itself carry namespaced
project/user/agent identity) in every iframe URL and could not isolate one
surface's root from a feature-hidden sibling's. Asset-backed iframe
widgets/cards are served by an opaque route pair instead:

- **`POST /api/packages/{packageId}/app-scope`** — host-only mint (cookie
  session + `x-project-id`/`x-agent-id` headers; body
  `{ projectId?, surfaceKind, surfaceId, rendererFingerprint? }`). Runs the
  canonical `resolveSessionContext`, verifies the agent through
  `resolveVerifiedAgentScope` (the raw `x-agent-id` header is never an agent
  identity), resolves ONE exact caller-visible surface through the shared
  `resolveVisiblePackageSurface` predicate (the SAME ladder the snapshot
  applies), resolves the entry path SERVER-side from the declared
  `component.url`/`render.url` (an arbitrary app path can never be minted) and
  returns `{ handle, url }`. Every not-visible reason answers ONE uniform,
  non-enumerating 404. `PATCH { handle }` heartbeats (fresh full gate; loss ⇒
  revoke + 410); `DELETE { handle }` is the capability-reducing own close
  (allowed after access loss). Neither the handle nor the project ever enters
  a query string.
- **`GET /api/package-app/_scope/{handle}/{surface|shared}/*`** — the
  package-ID-free virtual asset GET (the `%5Fscope` folder is Next's escape
  for an underscore-leading URL segment; handler logic lives in
  `src/server/packages/packageAppAssetGet.ts`). Re-runs the fresh cookie
  session + the FULL shared visibility predicate + trust/generation/
  fingerprint compare on EVERY request; `surface/*` resolves only inside the
  minted surface's dedicated `app/surfaces/{kind}/{surfaceId}/` root,
  `shared/*` only inside `app/shared/`; every other prefix/traversal is
  fail-closed, and containment is decided on the REAL path (root and request
  both resolved through symbolic links) so a SYMBOLIC link planted under the
  root cannot serve its target — the lexical prefix check alone is only the
  cheap pre-filter. "Symbolic" is the precise word, not a pedantic one: a
  HARDLINK under the root **is** served, on both lanes, because a hardlink has
  no path of its own for any path check to resolve. That is an accepted,
  bounded residual, and it must NOT be "closed" with a link-count or
  same-device rejection — both anti-fixes are refuted by measurement. The
  reasoning is not restated here: the canonical residual list and its
  prohibitions live in the ONE containment primitive both lanes call,
  `@neuralis/package-system/paths` (`containment.ts`). Read it there.
  Responses carry `Cache-Control: private, no-store` +
  `Referrer-Policy: no-referrer` + nosniff + the strict CSP — the CSP
  trust-INDEPENDENTLY, matching the next.config rule that actually reaches the
  wire. That CSP now SANDBOXES every document this lane serves
  (`sandbox allow-scripts allow-forms`): a `_scope` document opened as a
  top-level navigation, or embedded same-origin by an ordinary page, was
  measured running its inline script on the MAIN origin. The two flags mirror
  the sandbox attribute the workspace frame already sets, so nothing changes
  inside the product — but a navigated copy is forced into an opaque origin,
  where `document.cookie` throws and a credentialed `fetch` is unreadable. It
  covers the whole document class (`.svg`, a non-entry `.html`, the entry
  itself). `allow-same-origin` must NEVER be added to it. Residual, stated
  plainly and NOT as "script-neutered": the directive GRANTS `allow-scripts`,
  so such a document still runs its script and still renders, on the host's own
  hostname. Only the ORIGIN is taken away. A leaked url therefore stays a
  phishing-shaped surface with a live page on it.
  Revocation (role/feature/scope/trust change, package
  disable/update/uninstall, agent deletion) answers 410; error bodies never
  reflect the runtime package id or a filesystem path.
- **`GET /api/package-app/_pub/{pubToken}/{surface|shared}/*`** — the
  SESSION-FREE subresource lane (the `%5Fpub` folder is the same underscore
  escape; handler logic lives in `src/server/packages/packageAppPubGet.ts`).
  A sandbox frame's origin is opaque, so its subresource requests carry no
  cookie at all — this lane therefore reads none: no session, no agent scope,
  no visibility predicate, and consequently **no caller to gate**. Its key is a
  SECOND, independently drawn 192-bit token on the same scope record, never the
  `handle` and never returned by the mint. What it can open is bounded by the
  rules below — bounded by ENFORCEMENT, never "by construction". The phrase is
  deliberately avoided here: every bound in this list is a check this lane
  performs, and the real-path half of the containment rule was missing long
  enough to serve a symlink's outside target. The rules:
  - **uniform 404 everywhere.** No 401, no 403, no 410 — unknown token, expired
    scope, denied extension, wrong namespace, traversal, generation drift,
    missing file, over-cap and over-budget are indistinguishable, so the lane
    cannot be used to enumerate anything;
  - **never an HTML document.** `.html` and `.htm` are refused, so the lane can
    never serve an alternative surface ENTRY that skips the entry lane's
    visibility gate. It is deliberately NOT "never a framable document": `.svg`
    IS served, an SVG opened as a navigation (or framed) is a scriptable
    document too, and what disarms it is the lane's own
    `Content-Security-Policy: sandbox` (below), not the extension list;
  - **real-path root containment**, the same rule the entry lane applies — the
    record's own surface root or `app/shared/`, with both the root and the
    requested path resolved through symbolic links before the file is opened. A
    lexical prefix check on its own is not the rule: it passes a symbolic link
    whose target sits outside the root, and this lane has no caller to fall back
    on. The same hardlink residual and the same anti-fix apply as on the entry
    lane above — it is stated once there, deliberately not restated here;
  - **caller-free revocation.** The package must still be registered AND still
    be the same definition object the scope was minted against (a package
    update/reload/uninstall drifts the generation and revokes the whole scope);
    a loader status of `error` fails closed. The per-agent package enable
    toggle revokes on neither lane — that is parity, not an exception;
  - **a leaked token cannot prolong a scope.** A served file refreshes the
    scope's idle window only within 60 s of the scope's creation — enough that a
    large asset set cannot expire during its own initial load, by which point the
    owning client's first heartbeat (also 60 s) has taken over liveness. After
    that the lane still serves but stops refreshing, so once the legitimate
    client goes quiet the scope dies within the idle TTL no matter how much
    traffic the token attracts. This bounds how long a leak stays useful; it is
    not a claim that anything revokes in 60 s;
  - **two byte floors.** The same 2 MiB per-file cap on the stat size before the
    read, plus a per-scope budget over the DISTINCT paths already served under
    that scope (64 files / 8 MiB, code constants). A repeat request for an
    already-served path is free; the budget is checked BEFORE the entry is
    recorded, so the accounting map is hard-bounded;
  - **response floor:** `Cache-Control: no-store`, `Referrer-Policy:
    no-referrer`, `X-Content-Type-Options: nosniff`,
    `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy:
    cross-origin` (an opaque-origin frame's module-script / `fetch` / font
    loads are CORS-mode). `Access-Control-Allow-Credentials` is NEVER sent —
    the wildcard origin is safe precisely because the lane carries no
    authentication. The uniform 404 carries `Cache-Control: no-store` as well,
    because a refusal here can be TRANSIENT (a generation recheck while the
    project's packages reload) and a heuristically cached transient 404 would
    pin a live widget's subresource dead; it carries nothing else, so the
    lane's 404s stay opaque to a cross-origin reader;
  - **anti-navigation CSP.** Every response on this path carries
    `Content-Security-Policy: sandbox`, delivered by its own path-scoped rule in
    `src/server/config/securityHeaders.ts`. That rule sits AFTER the
    `/api/package-app/:path*` rule so it wins the key by last-write, and it
    carries the CSP key alone (nosniff and `no-referrer` already arrive from the
    earlier rules, and no config rule writes `Access-Control-Allow-Origin`, so
    the route's own wildcard survives while the lane's 404s stay opaque). The
    `sandbox` directive affects DOCUMENT responses only, so subresource loading
    is unaffected. **It is what makes `.svg` safe to serve here — deny `.svg`
    again in the same change if that rule is ever removed or reordered.**

  **The lane is LIVE for bundle-mode surfaces only.** A token reaches a frame
  through exactly one mechanism: when a surface's record carries BUNDLE asset
  mode, the entry response gets a server-injected `<base href>` pointing here, so
  the document's relative subresources resolve on this lane instead of the
  authenticated one. The token never appears in the mint response, the snapshot
  or any client code — only inside that injected attribute, where the frame's own
  JavaScript can read it via `document.baseURI`. That is intended. The entry CSP
  blocks every channel that could carry it to a THIRD PARTY:
  `fetch`/`sendBeacon`/WebSocket (`connect-src 'self'`), images
  (`img-src 'self' data: blob:`), form submission (`form-action 'none'`, despite
  `allow-forms`), popups and top navigation (both sandbox flags absent). Read
  `'self'` correctly: in an opaque sandboxed document it resolves to the
  PRECURSOR origin, so a same-origin `fetch` IS permitted and this lane's
  `ACAO: *` responses ARE readable — by the frame's own script, which the token
  was handed to. What `'self'` denies is a foreign destination.

  **NOT closed — a sandboxed frame may always navigate ITSELF**, and no shipped
  CSP directive stops that (`navigate-to` was dropped from CSP3 and never shipped
  in any engine), so in-frame script can put the token in an outbound URL. This is
  ACCEPTED, not overlooked: what the token opens is the package's own non-document
  files, under that record's roots, in that generation, for the scope's idle
  window — which the frame's own script already reaches directly. **Do NOT "close"
  it by adding `allow-top-navigation` or by widening the CSP:** both grant strictly
  more than they take away.

  A surface with no declaration — every surface that has not opted in — is
  self-contained, gets no `<base>`, and can never reach this lane at all.

B-baseline (2026-07-26): the entry served here is the sandbox frame's
DOCUMENT, and unless the surface declares bundle asset mode it must be
SELF-CONTAINED — inline `<style>`/`<script>`, `data:` URIs for images and fonts.
The frame's origin is opaque, so ITS subresource requests carry no session
cookie: for a self-contained surface **the platform does not serve them**;
nothing is "blocked", there is simply no authenticated path for a sandbox
subresource. A surface that DECLARES bundle mode
(`component.assetMode` / `render.assetMode` = `"bundle"`, honoured only for a
relative `iframe` entry that is an HTML document) has those subresources served
on the session-free `_pub` lane instead, reached through the injected `<base>`.
Self-containment is therefore an AUTHORING rule (the shipped
`check-package.sh` preflight), NOT a wire rejection. The only runtime
enforcement added for it is a memory bound: `PACKAGE_APP_ASSET_MAX_BYTES`
(2 MiB, `src/server/packages/packageAppAssetCsp.ts`) is checked on the
already-computed `stat` size BEFORE the read and answers the route's uniform
404 — never a 413, so the non-enumerating error vocabulary is preserved and the
actionable diagnostic stays with the preflight. The `shared/*` namespace is
reachable from a BUNDLE entry (`../shared/…`, resolved against the injected
base — so the `..` depth must match how deeply the entry is nested inside its
surface root) and remains unreachable from a self-contained one, for the same
cookie reason.

Routing note: the static `app-scope` segment wins over the `[...path]`
catch-all, so a package route literally named `app-scope` would be shadowed —
accepted; do not name a package route `app-scope`. The `/api/package-app/`
top-level segment conflicts with nothing.

## First-Party UI Module Lane (`/api/package-ui/`)

`GET /api/package-ui/{hash}/{path…}` (`src/app/api/package-ui/[hash]/[...path]/route.ts`, the table
in `src/server/packages/packageUiModules.ts`) is **not** a package-app lane: it serves the prebuilt
browser module a host-assigned first-party builtin declares in `app.module` (its `dist/app/` tree)
and the ONE union stylesheet, which the workspace `import()`s on the HOST origin — nothing it serves
runs sandboxed, and it must never serve a document type. Floors, in order: a lowercase sha256-hex
hash or 404 · an ACTIVE cookie session or 401 · the hash resolves through the server-built table
only (the caller never names a package or a root) or 404 · the owner is STILL a host-assigned
first-party builtin in the live registry or 403 · `.js`/`.mjs`/`.css` only (`.map`, `.json`,
documents ⇒ 404 before any fs touch) · the same two-half containment as the asset lanes
(`packageAppAssetFile.ts`) with its OWN 8 MiB per-file cap. Responses: `Cache-Control: private,
max-age=31536000, immutable`, `ETag` = the hash (304 on `If-None-Match`), nosniff, CORP
same-origin — a new build is a new URL, and a module once imported cannot be revoked from the page,
so `no-store` would buy only a re-download per load. Named residual: any signed-in member may fetch
any first-party module by its hash; a private package's hash is not guessable and never listed.

## Route Contract

Package route handlers receive a normalized request with:

- `path`
- `method`
- `query`
- `body`
- `session.userId`
- `session.projectId`
- optional `session.agentId`
- `session.role`
- `session.grantedFeatures`
- agent access and ownership metadata when available
