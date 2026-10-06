# Server Package Runtime

This directory contains the server-side package runtime layer for the Neuralis host. It is responsible for discovering packages, loading project package state, building runtime snapshots, and providing generic host dispatch helpers.

## Responsibilities

- Maintain the package runtime manager used by the host.
- Scan authored and installed packages.
- Build SSR and HTTP package snapshots.
- Dispatch generic package query and command fallbacks.
- Attach source package configuration to brain-core.
- Support package install, publish, trust, build, reload, and rescan flows.

## Runtime-WASM package sources

A project loads runtime-WASM packages from TWO kinds of directory, both via the
SAME `ProjectPackageScanner` + `PackageRuntimeManager.syncProjectPackagesToRuntime`
path (so every package is forced `untrusted`, reserved-id-banned, and held to the
trust-escalation guard):

1. **`_packages/`** — the default drop-zone, scanned **unconditionally** at
   activation (it loads from ~10 route entry points before brain-core source
   enumeration is guaranteed ready, so its load must never depend on a brain
   call — boot-order safety). Implicitly project-scope.
2. **Any flagged source** — any **enabled, `local`** brain-core source whose
   config carries `recognizesPackages: true` is scanned **in addition**, at ANY
   scope (project / user / agent). `projectPackages.activateProject` enumerates
   candidates via brain-core `listPackageSourceRoots(projectId)` and selects them
   in `selectFlaggedPackageRoots` (exported, unit-tested), carrying each source's
   owning `SourceScope`.

This is **additive** and orthogonal to brain-core's markdown source-package
discovery (the magpie): a flagged source still indexes + injects its markdown
contributions AND loads its WASM packages. The agent-side dedup
(`SourcePackageScanner.packageSlugFromUri`) keeps the same package from appearing
twice.

### Scope isolation (load globally, advertise per scope)

A user/agent-scoped source's WASM packages **load** for the project but are
**advertised only to the matching caller** — three orthogonal axes govern package
consumption: **uri-policy** (which paths a package may touch) · **feature** (which
roles may use a capability) · **scope** (which user/agent a loaded package is
advertised to). The scope axis is carried, never re-derived:

`selectFlaggedPackageRoots` → `ResolvedPackageRecord.ownerScope` →
`PackageRuntimeManager` records it in a parallel `#packageOwnerScope` map
(`getPackageOwnerScope(projectId, packageId)`; a package with no recorded scope —
builtins, default `_packages/` — is treated as project-scope, never hidden).

**Scope also NAMESPACES the loader code slot (distinct from advertise).** The three
axes above gate VISIBILITY; the global `PackageLoader` slot is a separate floor. A
project package's loader/registry id is **scope-namespaced** —
`toResolvedRecord(rec, projectId, ownerScope)` sets `packageId`/`definition.id` to
`namespaceProjectPackageId(projectId, scope, manifestId)` (kernel `contracts/sourceScope.ts`,
reuses `scopeKey`) so two projects/agents dropping a same-manifest-id package occupy
DISTINCT slots (coexist + can't cross-substitute another tenant's code). Builtins are
never namespaced. The **manifest id** is preserved on `ResolvedPackageRecord.manifestId`
(the scanner `ProjectPackageRecord` has none — its `.packageId` IS the manifest id) for
the admin keys + display, and `PackageRuntimeManager` keeps a parallel
`#packageManifestId` map (`getPackageManifestId(projectId, id)`). The **loader is a
second manifestId carrier** (whimsical-scott): every host load/reload site with a record
passes `record.manifestId` as `PackageLoader.load/reload`'s third arg; the loader stores
it on the slot, **preserves it across `reload()`** (the admin `package.reload` dispatch
path only has the namespaced id, so preservation must be loader-side — never
caller-supplied there), and exposes `loadedManifestSlugs()` — the ONE accessor any
`listLoaded()` consumer doing manifest-slug comparison must use (the source-package
dedup, `SourcePackageScanner` W3H); comparing `definition.id` against a bare slug never
matches a namespaced id. Admin `packageTrust`
is manifest-keyed (the trust route resolves via the scanner → `record.packageId` = manifest
id). `packageAccessFeature` is stored under **whatever id the writer sends** — the workspace
Packages panel writes the NAMESPACED snapshot id (`pkg.id`), the admin cross-project surface
the manifest id — so the **base-access Axis-2 gate is DUAL-PATH AND dual-KEY**: both
`bootstrap.ts resolveScopeHiddenIds` (stream) AND `snapshot.ts` (client snapshot) match with
`overrides[getPackageManifestId(projectId, id) ?? id] ?? overrides[id]`, so a namespaced OR a
manifest-id override both resolve. Do NOT simplify either reader to manifest-only — it would
break the real UI's namespaced write. `admin/project-packages/route.ts` namespaces its
`loader.getStatus` lookup, or the admin Packages status would stick at `loading`.

Two surfaces enforce it, both reusing the ONE `canAccessScope` predicate
(`@neuralis/package-system`) — out-of-scope packages are **hidden** (absent),
never rendered `[OFF]` (no existence inference):

- **`snapshot.ts` `buildScopedSnapshot`** (defense-in-depth): `SnapshotScope`
  carries `userId/agentId/role/grantedFeatures/packageAccessFeature`; step 2
  applies `canAccessScope` (scope axis) **and** a whole-package base-access
  **feature** gate (manifest `requires.accessFeature` ∪ the project
  `packageAccessFeature` override, via the shared `hasFeature`). The four live
  callers (runtime/widgets/dock/commands routes) thread the caller identity +
  `access.project.packageAccessFeature`.
- **The stream + MCP** (authoritative): agent-core can't import the host runtime
  manager, so `bootstrap.ts` implements a **`ScopeHiddenResolver`** port (mirrors
  `sessionResolver`/`selfScopeCredentialWriter`) returning the set of package ids hidden
  for a caller by SCOPE and/or base-access FEATURE. `StreamOrchestrator` unions it
  with the S3 set for the REMOVAL surfaces (injection catalog, skill accessor,
  tool catalog, dispatch) but passes it as a SEPARATE `hiddenPackageIds` to the
  `<packages>` overview, which **OMITS** those packages entirely (never `[OFF]` —
  `[OFF]` is reserved for the caller's own S3 toggle; unioning them into the
  overview's `disabledPackageIds` leaked `[OFF]`+content). Every overview call site
  takes the split — the stream main build, the delegate children (which receive the
  parent's set as `parentScopeHidden`), the background run's scope, the agent-setup
  inspector and `prompt-polish.ts`. The MCP
  `PackageContributionHost` applies the same resolver to every advertise list.
- **The agent-core `packages/overview` route** (the 4th advertise surface, easy to
  miss): the chat-config `PackageSelector`, the Package Constellation empty-state,
  and the agent `PackagesEditor` ALL read this ONE route, which builds from the
  caller-blind `state.runtime.getSnapshot()`. It applies S2 (`meetsRequires`) + S3,
  and now also resolves `state.streamDeps.scopeHiddenResolver` to OMIT scope/
  base-access-hidden ids from `packages[]`, `sourcePackages[]`, AND the
  `diagnostics` sub-route's entries + `summary.errors` (the "N failed to load"
  count is itself an existence-inference surface). Diagnostics validates no agent,
  so it passes `agentId: undefined` — a safe under-show on a `core.observe` panel.

The **base-access feature override** (`ProjectRecord.packageAccessFeature`,
sibling of `packageTrust`) is **restrict-only** — it can only attach a required
feature to an already-loaded package (incl. a first-party builtin, for isolation),
never grant access, so it never weakens a floor or creates a trust tier. The
`PUT …/packages/:slug/access-feature` route **validates** the featureId against the
project feature catalog (`collectAllFeatures(registry) ∪ existing overrides`; unknown
→ 400, clear/null always allowed), so an override can only attach a GRANTABLE feature.
A declared/overridden access feature is grantable in the admin Roles UI because
`collectAllFeatures` includes manifest `requires.accessFeature`, AND the
`/api/admin/feature-catalog` GET is **project-aware**: it reads the `X-Project-Id`
header → `requireAdmin(projectId)` → unions each `ProjectRecord.packageAccessFeature`
override into its declaring package's group. Without that union an override-ATTACHED
feature (one the manifest never declared — the common isolate-a-first-party-package
case) lives in no manifest, so it would be ungrantable and the package whose only
gate is the override would be dropped by the empty-group filter.

**Hot-reload.** `ProjectPackageScanner.startWatching` watches each scanned dir
through the ONE shared `FsWatchHub` (chokidar, `@neuralis/package-system/data`) —
**not** Node `fs.watch({recursive})`, whose `recursive` option is unsupported on
Linux and silently never fired on the deploy platform. Every event (incl.
`overflow`) maps to one debounced full rescan → combined `syncProjectPackagesToRuntime`
over EVERY scanner of the project (the list is read when the event fires, so a
source flagged at a later re-activation is never dropped by an older watcher).
**A sync reloads a package only when its INPUT changed** — the scanner record's
definition after trust overrides, plus, for a `runtime.type: 'wasm'` package, the
`mtimeMs:size` stamp of its wasm entry and `dist/routes.json` (`artifactStamp`) — or
when it sits in `error`. The loader's stored definition is never the comparison: the
loader mutates its own copy, so comparing against it reloaded every package on every
sync. A rebuilt WASM module (a CLI `neuralis-build` in the drop included) changes the
stamp and is swapped; an unchanged rescan reloads nothing. Syncs and the build/trust
routes' `reloadProjectPackage` run ONE AT A TIME per project (a per-project promise
chain) — two interleaved ones refused a load as "already loaded". The record-less
`reloadPackage` (admin `package.reload`) drops the package's input key, so the next
sync reloads it once from disk.
`syncProjectPackagesToRuntime` returns a `PackageSyncResult` (`{ errors: [{ packageId,
error }] }`): a package whose load/reload throws (e.g. a discovery-time validation
failure) is reported by id+reason instead of vanishing
silently, and the `POST /api/packages/rescan` route forwards these as `packageErrors`
in its response (the loader also records `status:'error'` for the same id, so
`getStatus(packageId)` stays queryable). The scanner registry is keyed by the
**resolved package dir**
(`getScannerForDir`), so a project can hold multiple scanners (default + each
flagged source) without one overwriting another (`getProjectPackageScanner` is
the `<root>/_packages` shorthand).

## Rescan & clear-cache — two callers, ONE floor

`rescanProjectPackages.ts` is the **single source of truth** for the two
host-side package-runtime mutations, so the deny-by-default floor is enforced
IDENTICALLY no matter who calls:

- **`rescanProjectPackages(userId, projectId)`** — eager: activate the project,
  re-scan EVERY scanner of the project (`_packages/` and each `recognizesPackages`
  source) from disk and re-sync the combined result (`resyncProjectPackages` in
  `projectPackages.ts`, the watcher's own collector) — a rescan of one scanner
  alone would unload every package another scanner owns; returns `{ scanned,
  packageErrors? }`, `scanned` summed over all scanners (a bad `x-neuralis` is
  reported, never silently dropped).
- **`clearProjectPackageCaches(userId, projectId)`** — the lazy counterpart:
  drop the project activation flag + each scanner's record cache (next access
  re-reads disk) and invalidate the runtime snapshot (next read recomputes). No
  eager reload.

Both **re-derive `canManagePackages` FRESH from the project store on every call**
(`resolveProjectAccess` → `canManagePackages`, never a ticket's cached
`grantedFeatures`), and throw `PackageManageForbiddenError` (stable `.code`) on
denial. `projectId` resolution is each entrypoint's own concern. Two entrypoints
reach these:

1. **The host Next route** `POST /api/packages/rescan` (cookie session) resolves
   `projectId` (request body `|| listProjectsForUser()[0]`) then delegates; a
   denial maps to 403 via `instanceof PackageManageForbiddenError`.
2. **Admin's first-party maintenance port.** The scanner and runtime manager are host-owned;
   `bootstrap.ts` supplies `HostPorts.packageMaintenance.rescanProject` and
   `.clearRuntimeCaches`. Admin's `rescan` and `cache/clear` routes pass the verified session's
   user/project ids directly to those ports, require `packages.manage`, and audit
   `packages.rescan` / `packages.cache_clear`. The shared host operation rechecks current
   permission on every call; admin maps its structured forbidden code to403. A missing port
   answers503. Dashboard buttons and `manage-cache-and-rescan` reach these admin routes.

## Key Files

| File | Purpose |
|---|---|
| `PackageRuntimeManager.ts` | Owns package load/start/unload and project package activation; the per-project sync chain + input keys; applies a PROJECT-scope package's `defaultRoleGrants` once (a user/agent-scoped source's package grants nothing — it is advertised to its owner alone) |
| `reconcileBuiltinGrantChanges.ts` | The grant usecase: the pure `applyGrantsPatch` (floor chosen by the caller — `canReceivePackageGrant` for a project package, `canReceiveBuiltinGrant` for a builtin) / `revokeGrantsPatch`, and the boot step that reads `pnpm neuralis:pkg`'s record (`app/config/builtin-removals.json`): a removed builtin's grants revoked, an ADDED builtin's defaults applied to every existing project once (kept until a boot that carries the package) |
| `ProjectPackageScanner.ts` | Scans per-project installed packages under `_packages/` |
| `runtime.ts` | Runtime accessors (current loader, snapshot triggers) |
| `projectPackages.ts` | Project-level package activation list |
| `rescanProjectPackages.ts` | Shared host-side rescan + clear-cache (FRESH `canManagePackages` floor); the Next route and admin maintenance ports both delegate here |
| `snapshot.ts` | Builds host-filtered runtime snapshots (composes the shared visibility ladder) |
| `packageVisibility.ts` | The ONE shared package/surface visibility predicate — host/project/owner-scope/base-feature/surface-feature/trust ladder EXTRACTED from the snapshot; `resolveVisiblePackageSurface` runs the full ladder for one exact widget/card surface (asset mint/GET); also computes the surface fingerprint + per-load package generation revoke signals. Its untrusted-absolute mirror calls the KERNEL `isAbsoluteAssetUrl`, the same predicate `snapshot.ts` and `validateContribution.ts` use — never a re-written regex, or the mint-side drop would drift away from the snapshot-side drop |
| `PackageAssetScopeAuthority.ts` | Bounded opaque asset-scope handles (192-bit, globalThis singleton): mint/heartbeat/own-close/revoke, 5-min idle expiry, per-user cap 128, periodic sweep, restart invalidation. The handle is NOT an authorizing capability — every GET re-runs the full visibility gate. **One record, two keys**: beside the handle index the record carries a second, independently drawn `pubToken` with its own index (`getByPubToken`), and EVERY removal path (lazy expiry on either lane, close, revoke, sweep, per-user-cap eviction) goes through the single private `#forget` so both keys drop together — a half-delete would be a PERMANENT one, since the sweep and the module interval iterate the handle map only |
| `packageAppAssetGet.ts` | The identity-free virtual asset GET handler (`/api/package-app/_scope/{handle}/{surface\|shared}/*`) — fresh session + full visibility recheck + trust/generation/fingerprint compare, real-path root containment (a lexical prefix pre-filter, then root and request both resolved through symbolic links — a SYMBOLIC link under the surface root that points out of it answers 403, not bytes; a HARDLINK does not, and cannot be made to, because no path check can resolve one — see the accepted-residual list in the kernel primitive `@neuralis/package-system/paths` (`containment.ts`), including the `st_nlink`/same-device anti-fix), the `PACKAGE_APP_ASSET_MAX_BYTES` cap applied to the stat of the descriptor the read then uses, `private, no-store` + `no-referrer` + nosniff + the strict CSP floor (the CSP trust-INDEPENDENTLY, matching the next.config rule that reaches the wire), uniform non-leaking errors. It is also where a BUNDLE-mode entry gets its `<base>` injected — gated on the record's declared mode, the `surface` namespace and resolved-absolute-path equality with the entry, with `Content-Length` recomputed from the grown body (the stat size would truncate it) |
| `packageAppPubGet.ts` | The SESSION-FREE subresource GET handler (`/api/package-app/_pub/{pubToken}/{surface\|shared}/*`). A SEPARATE file because it is a separate security model: it reads no cookie, calls no session/agent/visibility resolver, and its entire error vocabulary is ONE uniform 404 (no 401/403/410 to add). It refuses HTML documents (`.html`/`.htm`), so it can never serve an alternative surface ENTRY that skips the entry lane's visibility gate; `.svg` — a document too, and a scriptable one — IS served, disarmed by the lane's `sandbox` CSP header rule rather than by the extension list, applies the same real-path root containment (lexical pre-filter, then root and request resolved through symlinks — this lane serves with no caller at all, so it is the one that must never follow a link out of the root), re-checks the package generation caller-free (registry identity stamp + fail-closed loader status) and enforces a per-scope distinct-path budget check-then-insert BEFORE the read — with the failed-read path REFUNDING exactly what that request charged (never an entry an earlier request paid for), because charging ahead of the read otherwise burns a slot and its bytes for the scope's whole life on a request that answered 404. It is reachable ONLY by a bundle-mode surface — the `pubToken` is handed out in exactly one place, the `<base href>` injected into that surface's entry — so a self-contained surface can never touch it. A served file refreshes the scope's idle window only within `PACKAGE_APP_PUB_TOUCH_MAX_AGE_MS` of creation, so a leaked token can ride a live scope but cannot keep one alive by itself — once the owning client stops heartbeating the scope dies within the idle TTL regardless of token traffic (a bound on how long a leak stays useful, NOT a claim that anything revokes in 60 s). The cap-stat and the read happen on ONE open descriptor, so the FINAL-component path race is closed rather than tolerated: a file deleted, replaced or symlinked-over after the check cannot change what is read, and the declared `Content-Length` (the stat size, parity with the entry lane) cannot disagree with the body. That is the final component only, and on POSIX only — the intermediate-directory TOCTOU and the Windows `O_NOFOLLOW` degradation stay ACCEPTED residuals, enumerated once in the kernel primitive `@neuralis/package-system/paths` (`containment.ts`) and never restated as closed. The read is still wrapped so an I/O failure answers the SAME 404 instead of escaping the vocabulary as a framework 500, and the descriptor is closed in a `finally` that also spans the budget refusal — an early return there would leak one fd per refused request on the one lane with no caller to rate-limit. Headers on a 200: `no-store` + `no-referrer` + nosniff + `ACAO: *` + `CORP: cross-origin`, and NEVER `Access-Control-Allow-Credentials`. The 404 carries `no-store` too — one `notFound()` helper for all nine refusal paths, because a refusal here can be TRANSIENT (a generation recheck during a package reload) and a cached transient 404 would pin a live widget's subresource dead — but it stays OPAQUE: no ACAO, no CORP |
| `packageAppBaseTag.ts` | The PURE (fs-free, Response-free, logger-free) `<base href>` builder + injector for a BUNDLE-mode entry document. Both halves are security, not formatting. `buildPackageAppBaseHref` percent-encodes every segment and returns `null` — meaning inject NOTHING — rather than emit an href still containing a quote, angle bracket or whitespace, because `entryRelPath` is PACKAGE DATA and the kernel's relative-url check permits those characters. `injectBaseTag` anchors at POSITION 0 — after a leading BOM only — except that a leading strict `<!doctype html>` (reachable past whitespace, complete comments and complete `<?…>` bogus-comment forms) keeps first position and the tag goes immediately after it. Position 0 is the security default; the doctype skip is purely cosmetic, since a tag inserted ahead of a doctype puts the document in quirks mode. **Never reintroduce a `<head>`/`<html>` anchor**: it is unsound BY SPEC, not merely hard to scan for — a `<base>` before `<html>`/`<head>` is hoisted into the IMPLICIT head and the package's later real `<head>` start tag is dropped, so a tag anchored after `<head` can never be first no matter how careful the scan. (It read as a scanner problem because its visible failures all were: `<head` matching `<header>`, a build banner mentioning `<head>`, a `<head>` inside a quoted attribute value.) **The scanner-shaped failure class is OPEN by construction, and the file says so** — it has bitten twice, first on that anchor and then on the COMMENT TERMINATOR SET (the tokenizer closes a comment on four constructions — `-->`, `--!>`, `<!-->`, `<!--->` — and the first version knew only `-->`, so a decoy comment walked the scan past the package's own `<base>`). Two guards therefore sit on top of the scan and neither is optional: an ANCHOR POST-CONDITION that collapses to position 0 whenever a `<base` appears anywhere in the skipped-over text, so precedence never depends on the scan being complete; and a UTF-16 BOM REFUSAL that injects NOTHING, because before the BOM breaks the encoding sniff and after the BOM loses precedence silently (the ASCII bytes decode as UTF-16 code units and never form an element). Cosmetic costs, all measured: the entry's own `<head>` attributes are lost, its own `<base>` is ignored including `target`, and a legacy/exotic doctype falls back to position 0 and therefore to quirks. There is deliberately no doctype-END finder — a `>` inside a quoted doctype identifier terminates the token, so an end-finder could splice the tag INSIDE the doctype where it is inert. Callers round-trip through `latin1` so a non-UTF-8 entry keeps its exact bytes — byte preservation, which is not the same as DECODING preservation, hence the UTF-16 refusal |
| `packageAppAssetFile.ts` | The Response-FREE primitives both lanes share: the MIME allowlist (plus the public lane's DERIVED subset — one table, never a second literal), `parseAssetRequest`, `resolveContainedAssetPath` (the cheap LEXICAL pre-filter, deliberately incomplete — a string computation cannot see a symlink) and `openContainedAssetFile`, the ONLY one of them that may be used to produce bytes. It is now a THIN LANE ADAPTER over the kernel's single containment primitive (`@neuralis/package-system/paths`, `containment.ts`): the primitive `realpath`s the request, decides containment through the kernel's one `isPathInside` predicate and hands back an already-OPEN descriptor whose stat carried the byte cap, so the check and the read are atomic. What this file still owns is the part the primitive deliberately cannot: it resolves the ROOT itself, because the shared denial enum cannot distinguish a declared-but-absent root (`no_root`) from an absent file (`missing`) and this lane must. The open flags — `O_NOFOLLOW` (a symlink raced into the final component is ELOOP) and `O_NONBLOCK`, a denial-of-service floor rather than a detail — live in the primitive, but their MEASURED justification stays in this file next to the lane it was measured on: `open()` on a FIFO blocks until a writer arrives, libuv's fs threadpool is PROCESS-WIDE with four threads by default, and the type gate runs AFTER the open, so without the flag four planted FIFOs stall every fs/dns/zlib/pbkdf2 operation in the host. CALLER CONTRACT: every non-ok return has closed what it opened; an `ok` result's descriptor is the caller's to close in a `finally` spanning every path to the response. They return discriminated RESULTS, never a `Response`, and keep `no_root` and `escape` DISTINCT — the entry lane answers 403 on an escape and the public lane 404, so a helper that returned a status would silently change the landed lane's wire behaviour |
| `packageUiModules.ts` | The first-party UI MODULE table behind `GET /api/package-ui/{hash}/{path…}` (`src/app/api/package-ui/`): for every host-assigned first-party builtin that declares `app.module` (`isFirstPartyBuiltin`), the sha256 content hash of its `dist/app/` tree → that tree, plus the server-derived module URL, the fail-closed pins (shared-import record version = `UI_MODULE_HOST_API_VERSION`; the declared React range must admit the host major) and the lane's own 8 MiB per-file cap and `.js`/`.mjs`/`.css` MIME map; and the ONE union stylesheet (`workspace.css`), compiled by the kernel `compileUnionSheetOffThread` in one emitted JS worker that loads the host-resolved `tailwindcss` + `@tailwindcss/oxide` entries over explicit sources (`packageSheetSources`, the kernel client, `hostSheetSources` — `src/` in dev, the built `.next/static/chunks` when the server runs from `_runtime`). Built once per first-party definition set (globalThis-anchored, shared by both route graphs) with a non-blocking prewarm after core readiness and the canonical `ensureCommunityRuntime()` manager-readiness bridge; core readiness alone does not make the synchronous registry getters usable. The first runtime GET shares and awaits that same promise. Definition changes rebuild once, project revisions do not. Count/timing-only build logs carry module/engine/compile/scan/build phases, transfer bytes and the actual worker compile window; a named sheet failure keeps the modules. `viewUiAttachments` narrows the `ui` view to the packages the caller's snapshot shows. The lane reuses `packageAppAssetFile.ts`'s containment primitives |
| `packageAppAssetCsp.ts` | The six asset-serving FLOORS declared once: `buildPackageAppAssetCsp()` (the strict entry-lane policy, shared byte-for-byte with the next.config path-scoped header rule — it takes NO parameters, and when the deferred path-prefix tightening is picked up the absolute origin must NOT come from the request `Host` header, which is attacker-controlled: naming an attacker origin in `base-uri` is one directive away from naming it in `script-src`; `base-uri 'self'` is what permits the injected bundle-mode `<base>` that `'none'` would have made silently inert, and it also carries `sandbox allow-scripts allow-forms` — the ENTRY lane's own anti-navigation floor, added after a `_scope` document opened as a top-level navigation was measured running its inline script on the MAIN origin. The two flags mirror the product's iframe sandbox attribute exactly, so the in-frame effective set is unchanged, while a navigated or same-origin-embedded copy is forced opaque. **Never add `allow-same-origin`** — it is the plausible-looking edit that would hand every package UI the host origin; if the frame ever breaks, re-measure the flag set. Residual, precisely: the directive GRANTS `allow-scripts`, so a navigated document still RUNS and RENDERS on the host hostname — only the origin is taken away, so `document.cookie` throws and a credentialed `fetch` is unreadable. Never write "script-neutered"), `PACKAGE_APP_PUB_CSP` (`sandbox` — the session-free lane's anti-navigation floor, and the reason `.svg` is servable there; it is STRICTLY STRONGER than the entry lane's directive, which still permits script in its opaque origin, so it is never redundant), `PACKAGE_APP_ASSET_MAX_BYTES` (2 MiB per file), the session-free lane's per-scope budget `PACKAGE_APP_PUB_MAX_FILES` (64) + `PACKAGE_APP_PUB_MAX_TOTAL_BYTES` (8 MiB), and `PACKAGE_APP_PUB_TOUCH_MAX_AGE_MS` (60 s — the absolute ceiling on that lane's ability to EXTEND a scope's life, matched to the client heartbeat period and never to be set below it). All stay CODE constants — untrusted-input caps are the documented exception to package-declared platform config. Three of them have an unavoidable twin in the shipped authoring preflight (`brain-core/skills/create-package/scripts/check-package.sh`, a standalone script that cannot import TypeScript): `ENTRY_MAX`, `PUB_MAX_FILES` and `PUB_MAX_TOTAL`. `__tests__/packageAppAssetCapDrift.test.ts` is the derive-and-verify guard — it greps each declaration back out of the script, asserts exactly one match (a RENAME must fail loud, not pass vacuously) and asserts equality with the host constant, so a one-sided edit fails loudly instead of letting an author ship a surface the lane will 404 |
| `snapshotForSSR.ts` | Snapshot helper for the workspace server component |
| `dispatch.ts` | Generic command/query fallback dispatch |
| `chat.ts` | Chat-card and tool-presentation helpers |
| `packageInstaller.ts` | Package install workflow (gated by the role's can-manage-roles flag OR `packages.manage` — never a role name) |
| `packagePublisher.ts` | Local package artifact publishing |
| `packageRecords.ts` | Persisted per-project package metadata |
| `migrateLegacyPackages.ts` | One-shot migration of pre-`_packages/` project layouts |
| `sourceDiscovery.ts` | Converts source configs into package definitions |

## Internal asset descriptor vs navigable scoped URL

The snapshot's normalized widget/card URL (`/api/packages/{packageId}/app/…`)
is a HOST-INTERNAL **logical descriptor** — resolution/fingerprint data only.
Both surface kinds are normalized by the same rule in
`snapshot.ts` (`normalizeSurfaceAssetUrl`, over the kernel's ONE
`isAbsoluteAssetUrl` predicate): a relative url becomes the descriptor, and an
ABSOLUTE url from an `untrusted` package is DROPPED from the snapshot with a
warning (trusted/first-party absolutes pass through). The card branch runs the
SAME normalization as the widget branch, so an untrusted absolute card url never
reaches the client: the snapshot-side drop is defense-in-depth over the validator
and the client renderer, which reject such a url as well.
It must never reach a DOM attribute, `window.open`, an iframe `src` or a
package payload: the runtime package id can itself carry namespaced
project/user/agent identity. The only NAVIGABLE form is the identity-free
scoped URL (`/api/package-app/_scope/{handle}/surface/…`) minted through
`POST /api/packages/{id}/app-scope`. The mint resolves the entry path
server-side from the declared manifest url under the canonical
`app/surfaces/{kind}/{surfaceId}/` root (the kernel's `resolveSurfaceAssetEntry`
— ONE rule shared with the contribution validator); `shared/*` maps to the
package-public `app/shared/`. Lifecycle is bounded end-to-end: client
refcount + 60 s heartbeat + last-release close on one side, 5-min idle
expiry + per-user cap + sweep + restart invalidation
(`PackageAssetScopeAuthority`) on the other; every GET/heartbeat re-runs the
FULL shared visibility predicate and 410s on any drift (package update ⇒ new
generation/fingerprint; agent deletion ⇒ verified-agent mismatch).

## Security Notes

Project package operations must derive project paths from verified project membership. Do not trust caller-provided project roots. Package install, build, rescan, and trust changes are privileged operations and should be gated by owner/admin roles or explicit package-management features.

### Two asset modes, and the default is the strict one

A package UI entry loads in an OPAQUE-origin sandbox, so its subresource
requests carry no session cookie. What follows from that depends on ONE declared
field, `component.assetMode` / `render.assetMode`:

- **`self-contained` — the default, and what an absent field means.** The
  platform serves the entry and nothing else. Its relative subresources are not
  "blocked"; there is simply no authenticated path for them. Such an entry must
  inline its CSS/JS and use `data:` URIs, which is an AUTHORING rule enforced by
  the shipped preflight, not a wire-level rejection. `app/shared/` is unreachable
  from one. This mode needs no declaration and works on every deployment, in
  every trust tier.
- **`bundle`.** The entry response gets a server-injected `<base href>` pointing
  at the session-free `_pub` lane, so its relative subresources — and
  `../shared/…`, with the `..` depth matching how deeply the entry sits in its
  surface root — resolve there. The declaration is honoured only after
  normalization (`normalizeSurfaceAssetMode`, `packageVisibility.ts`): exactly
  the string `bundle`, an `iframe` renderer, a RELATIVE url and an HTML entry.
  Anything else, an unknown value included, resolves to `self-contained`.

The runtime enforcement common to both is the `PACKAGE_APP_ASSET_MAX_BYTES`
memory bound — checked on the already-computed `stat` size BEFORE the read and
answered with the route's uniform 404 (never a 413) so the non-enumerating error
vocabulary holds.

**Never write "the platform serves sandbox subresources" unqualified.** It
serves the DECLARED-bundle ones. The unqualified claim advertises a capability
self-contained surfaces do not have, and an over-claim in security prose is a
defect in its own right — the mirror image of the under-claim this section
replaced.

Asset-scope specifics: the mint/GET routes answer every not-visible reason
with ONE uniform non-enumerating response (no existence-confirming 403), the
raw `x-agent-id` header is only consumed through `resolveVerifiedAgentScope`
(agent-core's deny-by-default policy), and no error text/`Location`/header
ever reflects the runtime package id or a resolved filesystem path.
