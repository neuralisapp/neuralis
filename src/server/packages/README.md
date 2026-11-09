# Server Package Runtime

This directory contains the server-side package runtime layer for the Neuralis host. It is responsible for discovering packages, loading project package state, building runtime snapshots, and providing generic host dispatch helpers.

## Responsibilities

- Maintain the package runtime manager used by the host.
- Scan authored and installed packages.
- Build SSR and HTTP package snapshots.
- Dispatch generic package query and command fallbacks.
- Attach source package configuration to brain-core.
- Support package install, publish, trust, build, reload, and rescan flows.

## Runtime package sources

A project loads runtime packages (any `runtime.type`) from TWO kinds of directory, both via the
SAME `ProjectPackageScanner` + `PackageRuntimeManager.syncProjectPackagesToRuntime`
path (so every package is forced `untrusted`, reserved-id-banned, and held to the
trust-escalation guard):

1. **`_packages/`** — the default drop-zone, scanned **unconditionally** at
   activation (it loads from ~10 route entry points before brain-core source
   enumeration is guaranteed ready, so its load must never depend on a brain
   call — boot-order safety). Implicitly project-scope.
2. **Any package folder of a source** — every folder an **enabled** brain-core
   `host` source lists in `packageFolders` (relative to its root, `''` = the whole
   source) is scanned **in addition**, at ANY scope (project / user / agent), when
   brain-core hands it a root THIS process opens (`containerRoot`: a folder on this
   server, or a folder on the app's own loopback device that agent-core judged a
   directory inside the owner's ceiling) OR a `device` reader factory (another
   device's folder, any device's from inside a container, or one whose device is
   offline): `selectFlaggedPackageRoots` re-checks each folder with the kernel's
   `isPackageFolderPath` and opens ONE `PackageReader` per folder, and that
   folder's scanner (keyed by the reader's identity — a device path is not this
   disk's path) reads, lists and watches only through it; nothing of it is
   written here. Every device call needs the device plane on (`hostBrokerEnabled`).
   An unreachable device keeps the scanner's LAST records, flagged
   `unavailable: 'device-offline'` (no deletion is confirmed from an offline
   device), and the runtime manager loads each as a stub — name, version, access,
   its base-access gate, the "Not available" description — with no root and no
   read (`partial` / `device-offline`); the link's return re-scans. Every source
   with package folders that loads none is logged ONCE by brain-core at info,
   `package.folder.skipped {projectId, source, reason}` with a fixed code
   (`disabled`, `device_retired`, `device_unknown`, `devices_disabled`, …),
   never a path. `projectPackages.activateProject` enumerates
   candidates via brain-core `listPackageSourceRoots(projectId)` and selects them
   in `selectFlaggedPackageRoots` (exported, unit-tested), carrying each source's
   owning `SourceScope`. The list is not fixed at activation: brain-core notifies
   the host after every committed source-config write (the `package-source-roots`
   service's `subscribePackageSourceRoots`, armed at the first activation), and an
   activated or activating project re-derives its flagged roots and applies only
   the difference — a new root is scanned and watched, a removed, unflagged or
   disabled one is dropped, an unchanged set costs one listing and no scan. Rescan
   re-derives first, too. A directory several projects scan (a source pointed at
   another project's `_packages/`) holds ONE hub watcher whose change notifies
   every one of those projects.

This is **additive** and orthogonal to brain-core's markdown source-package
discovery (the magpie): a flagged source still indexes + injects its markdown
contributions AND loads its packages. The agent-side dedup
(`SourcePackageScanner.packageSlugFromUri`) keeps the same package from appearing
twice.

### Scope isolation (load globally, advertise per scope)

A user/agent-scoped source's packages **load** for the project but are
**advertised only to the matching caller** — three orthogonal axes govern package
consumption: **uri-policy** (which paths a package may touch) · **feature** (which
roles may use a capability) · **scope** (which user/agent a loaded package is
advertised to). The scope axis is carried, never re-derived:

`selectFlaggedPackageRoots` → `ResolvedPackageRecord.ownerScope` →
`PackageRuntimeManager` records it in a parallel `#packageOwnerScope` map
(`getPackageOwnerScope(projectId, packageId)`; a package with no recorded scope —
builtins, default `_packages/` — is treated as project-scope, never hidden). The
source's PLANE rides beside it — brain-core's `PackageSourceRoot.plane` →
`ResolvedPackageRecord.ownerOrigin` → `getPackageOwnerOrigin` — and every owner-scope
check passes it as the 4th `canAccessScope` argument (snapshot ladder, the stream's
`resolveScopeHiddenIds`, the package listing and its writes), so a member's
user-scope DEVICE folder's packages serve that member alone; it is never re-derived
from the slug or from `device`/`containerRoot` (a loopback device folder opens in
process).

**The loader code slot is an exact installation identity, separate from advertise.**
`toResolvedRecord` validates the authored npm manifest before stamping a canonical
source URI with project and owning scope coordinates. `packages://folder?project=p&scope=project`
and `source://folder?project=p&scope=project` remain independent even when their
`manifestId` matches. Platform-installed packages retain their authored npm ids.
`manifestId` is display/validation metadata; mutable trust, access overrides and
applied-grant provenance belong to the exact runtime id. Both the stream and
client snapshot read that instance key, while manifest `requires.accessFeature`
remains an independent gate.

Every scanner retains its source URI root and scope. The project-scoped installed
provider and the exact-instance trust/build/reload resolver use those same records;
a request never supplies a physical path or chooses authority from URI query fields.
The resolver rejects foreign projects and management routes recheck source scope
against the real session. Source-root packages retain an empty relative path.

The identity change is never performed by the running host. The project record kind
`neuralis/project` is at format 2 and declared `upgrade: { mode: 'offline' }`: a boot over
older data stops in the kernel ledger admission (`upgrade_required`, naming
`pnpm neuralis:upgrade`) before any read, and the operator runs the offline upgrade on the
stopped app. Its host module (`neuralis/scripts/upgrades/package-identity-v2.mts`) inventories
every project through the same scanners the activation path uses (metadata only, no load, no
watcher; a mounted source's container root translated through the compose override's mount pair
on the device plane), hands the inventory to agent-core's script algorithm, and the records are
rewritten raw and durably — the dry run lists every re-key, drop, merge and blocker with file and
field; the apply refuses while anything blocks, takes one checkpoint first, and clears the
ledger's `upgrading` mark last. Older binaries refuse the raised kind by name.

A successful source-root listing can prove a child deleted. Missing mounts, I/O
errors and present-invalid manifests cannot: unhealthy packages unload, but those
states preserve mutable overrides. Watchers never create a missing flagged mount;
only the host-owned drop zone may be created. Confirmed deletion clears only the exact
instance's trust/access/grant markers, even without a loaded definition; a re-add
starts untrusted. Grant provenance records package-origin claims across sibling
providers, excluding manual-preexisting grants; an explicit role-feature removal
clears the corresponding claim, so a later manual re-add survives uninstall.
Legacy grants without provenance remain conservatively preserved.

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
feature to an already-loaded package (incl. a native builtin, for isolation),
never grant access, so it never weakens a floor or creates a trust tier. Its
write (`setProjectPackageAccessFeature`, below) checks that the package EXISTS and
sits in the caller's write reach (a native builtin of this host, or a project
package whose owning scope `canAccessScope(…, 'write')` admits — otherwise the same
404 as an unknown id), and **validates** the featureId against the project feature
catalog (`collectAllFeatures(registry) ∪ existing overrides`; unknown → 400,
clear/null always allowed), so an override can only attach a GRANTABLE feature.
A declared/overridden access feature is grantable in the admin Roles UI because
`collectAllFeatures` includes manifest `requires.accessFeature`, AND the
`/api/admin/feature-catalog` GET is **project-aware**: it reads the `X-Project-Id`
header → `requireAdmin(projectId)` → unions each `ProjectRecord.packageAccessFeature`
override into its declaring package's group. Without that union an override-ATTACHED
feature (one the manifest never declared — the common isolate-a-native-package
case) lives in no manifest, so it would be ungrantable and the package whose only
gate is the override would be dropped by the empty-group filter.

**Hot-reload.** `ProjectPackageScanner.startWatching` watches each scanned dir
through the ONE shared `FsWatchHub` (chokidar, `@neuralis/package-system/data`) —
**not** Node `fs.watch({recursive})`, whose `recursive` option is unsupported on
Linux and silently never fired on the deploy platform. Every event (incl.
`overflow`) maps to one debounced full rescan → combined `syncProjectPackagesToRuntime`
over EVERY scanner of the project (the list is read when the event fires, so a
source flagged later is never dropped by an older watcher). A scanner keeps one
change listener per project, keyed by project id (a re-activation replaces its
own, never adds a second); the last listener out releases the hub watcher.
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

## Project-package governance — two doors, ONE floor

`rescanProjectPackages.ts` is the **single source of truth** for project-package
governance — rescan, clear-cache, the package list, trust, Build and the access
feature — so the deny-by-default floor is enforced IDENTICALLY no matter who calls:

- **`rescanProjectPackages(userId, projectId)`** — eager: activate the project,
  re-derive its flagged sources, re-scan EVERY scanner of the project (`_packages/` and each package
  folder) from disk and re-sync the combined result (`resyncProjectPackages` in
  `projectPackages.ts`, the watcher's own collector) — a rescan of one scanner
  alone would unload every package another scanner owns; returns `{ scanned,
  packageErrors? }`, `scanned` summed over all scanners (a bad `x-neuralis` is
  reported, never silently dropped).
- **`clearProjectPackageCaches(userId, projectId)`** — the lazy counterpart:
  drop the project activation flag + each scanner's record cache (next access
  re-reads disk) and invalidate the runtime snapshot (next read recomputes). No
  eager reload.
- **`listProjectPackageRows(userId, projectId)`** — every package the project
  runs that the caller's scope may READ (`_packages/`, each source package folder,
  the native packages), from what is loaded now (`listAllActivatedPackages` + the
  registry's host-stamped definitions + the loader's status; no disk read): trust
  from the runtime, never the manifest; another member's or agent's package is
  absent for a caller without `files.readOthers`; no host path.
- **`setProjectPackageTrust` / `buildProjectPackage` /
  `setProjectPackageAccessFeature(userId, projectId, packageId, …, via)`** — resolve
  the package from the host-stamped records (`resolveProjectPackageInstance`, never a
  caller path) and refuse it like an absent one (`PackageOpRefusal` 404
  `package_not_found`) outside the caller's WRITE reach; a native package's trust never
  moves; the write lands in the platform zone (`ProjectRecord.packageTrust` /
  `packageAccessFeature`), the audit row (`package.trust.change` / `package.build` /
  `package.access_feature.change`) carries `via` person · agent · cli, and trust and
  Build reload the package. A build's log names no host path (the failure detail goes
  to the host log). Build runs only where the server has its WASM compiler: the kernel's
  `hasWasmToolchain` (`extism-js` on `PATH`) sets a needing row's `build` (`ready` /
  `toolchain-missing`, the only state Admin offers Build on) and refuses the build itself
  with `409 toolchain-missing` before any step — one predicate for the tab, the CLI and
  the routes.

All of them **re-derive `canManagePackages` FRESH from the project store on every call**
(`resolveProjectAccess` → `canManagePackages`, never a ticket's cached
`grantedFeatures`), and throw `PackageManageForbiddenError` (stable `.code`) on
denial. `projectId` resolution is each entrypoint's own concern. Two doors
reach these:

1. **The host Next routes** (cookie session): `POST /api/packages/rescan` resolves
   `projectId` (request body `|| listProjectsForUser()[0]`) then delegates; `GET
   /api/projects/:id/packages` and `/api/projects/:id/packages/:package/{trust,build,access-feature}`
   (Admin → Packages, project scope) delegate with the path's project. A refusal maps
   through `packageOpResponse.ts` (403 floor, the refusal's own 400/404, a fixed 500).
2. **Admin's native maintenance port.** The scanner and runtime manager are host-owned;
   `bootstrap.ts` supplies `HostPorts.packageMaintenance` (`rescanProject`,
   `clearRuntimeCaches`, `listProjectPackages`, `setPackageTrust`, `buildPackage`,
   `setPackageAccessFeature`). Admin's `rescan`, `cache/clear` and `project-packages/*`
   routes pass the verified session's user/project ids directly to those ports, require
   `packages.manage` (stricter than the host floor), and audit `packages.rescan` /
   `packages.cache_clear` (the other writes are audited by the host body). The shared host operation rechecks current
   permission on every call; admin maps its structured forbidden code to403. A missing port
   answers503. Dashboard buttons, `manage-cache-and-rescan` and the `neuralis package
   project|trust|build|access` verbs reach these admin routes.

## Runtime package install (`install/`)

A native package can be installed, updated or removed while the host runs and is active
from its next start — the Admin Packages tab, the `neuralis package` verbs and an agent's own
calls all reach ONE transaction, the host port `hostPorts.platformPackages`
(`install/platformPackages.ts`), on the desktop app's native host and on a Docker host alike.
The record is `<appRoot>/packages/package.json` in the app data folder (it survives an image
rebuild), beside the packages the image ships; discovery reads its lines (`host/builtinSlots.ts`).

- **Ask, then a holder of the approve feature approves.** `request` (open to anyone holding
  `platform.packages`) stages a registry package (`npm pack`, one tarball) or an uploaded `.tgz`
  and summarizes it WITHOUT running any of its code: version, sha512, the registry that served it,
  its build source (one `npm view <name>@<version> dist --json`: `attested` when the registry
  holds an npm provenance attestation, else `none` — shown, never a refusal), routes, tools,
  features and their default role grants, config keys, credentials, peers, and who asked (`via`
  person · agent · cli, the asking agent and its project). Pending requests are bounded and
  expire. Only `approve` changes the record; it and `restart` (which stops the host through its
  drain so its supervisor — `neuralis up`, Docker's restart policy — starts it again) need
  `platform.packages.approve` as well, re-derived fresh for a person, an agent's session and the
  CLI alike. An approval resolves its request FIRST: an unknown id is a 404 to every caller.
- **The operator's allow-list.** `<appRoot>/packages/allow-list.json` — a JSON list of scopes
  (`@acme`) and exact names, written on the machine by its operator (no setting, route or screen
  writes it) — narrows what may be asked for at all: missing or empty admits every name, a name
  it leaves out is refused (`403 not_allowed`) before any network step, at the ask and again at
  the approval; a file that is no such list refuses every install (`allow_list_unreadable`).
- **The approved bytes, and nothing else.** An uploaded tarball is matched to the approved
  sha512 before anything is written (a re-install of the same id@version with other bytes
  leaves the recorded tarball as it was); a registry request whose registry setting moved
  since the ask is refused `registry_changed` before npm runs; after npm, a registry install's
  lock integrity must equal the approved sha512 — a lock without one fails closed
  (`integrity_unverifiable`). The installed version, a shared
  platform package copied into the lock, the runtime's own admission check and a hidden
  `package.json` are refusals too; every refusal restores the record exactly.
- **A builtin, by slot.** At the next start discovery reads the record's lines beside the host's
  own (`host/builtinSlots.ts`), and `assignBuiltinProvenance` stamps every one of them
  `source.kind: 'neuralis'` + `native` — overwriting the manifest — which is the pair
  agent-core's loader requires before it imports a package's routes, tools and lifecycle
  (`isHostOwnedBuiltin`). An author declares neither. An update replaces the installed copy:
  the package being updated is never counted as its own shared peer.
- **One module instance.** Peers (`@neuralis/*`, React) are never installed: `install/peerLinks.ts`
  links each to the host's own copy at every start, before the loader imports anything.
- **npm** (`install/npm.ts`) is the one that ships with the running Node, run with an authored
  environment, a throwaway HOME/cache/config and `--ignore-scripts` (a dependency that needs an
  install script does not build — the approval screen says so); a recorded private scope
  refuses a registry install before any network step. A failed npm step answers a fixed
  `502 npm_failed` text; npm's own output (it names host paths) goes to the host log only.
- **One list.** `list` answers every package the host knows: its own installation's rows
  (`slot: 'image'`, read once from boot memory — `origin` `core` for a line the release pins,
  `operator` for one the operator added; `status` loaded, turned off or refused at this start;
  `optional` when the operator may turn it off) beside the record's (`slot: 'runtime'`, `loaded`
  or `restart`). The host wiring (`hostPlatformPackages.ts`) takes this start's refusals and the
  runtime's loaded set from the boot.
- Every act is audited (`package.request`, `package.install` / `package.update` /
  `package.uninstall`, `package.request_dismissed`, `package.restart`), the same vocabulary the
  project `_packages/` lane writes; the request, the approval and the restart rows carry `via`
  (person · agent · cli) and, for an agent, its `agentId`.

## Key Files

| File | Purpose |
|---|---|
| `PackageRuntimeManager.ts` | Owns package load/start/unload and project package activation; the per-project sync chain + input keys; applies a PROJECT-scope package's `defaultRoleGrants` once (a user/agent-scoped source's package grants nothing — it is advertised to its owner alone) |
| `reconcileBuiltinGrantChanges.ts` | The grant usecase: the pure `applyGrantsPatch` (floor chosen by the caller — `canReceivePackageGrant` for a project package, `canReceiveBuiltinGrant` for a builtin) / `revokeGrantsPatch`, and the boot step that reads `pnpm neuralis:pkg`'s record (`app/config/builtin-removals.json`): a removed builtin's grants revoked, an ADDED builtin's defaults applied to every existing project once (kept until a boot that carries the package) |
| `ProjectPackageScanner.ts` | Scans per-project installed packages under `_packages/` |
| `runtime.ts` | Runtime accessors (current loader, snapshot triggers) |
| `projectPackages.ts` | Project-level package activation list |
| `rescanProjectPackages.ts` | Shared host-side project-package governance — rescan, clear-cache, the package list, trust, Build, the access feature (FRESH `canManagePackages` floor); the Next routes and admin maintenance ports both delegate here |
| `packageOpResponse.ts` | The cookie routes' answer for a refused or failed project-package operation |
| `snapshot.ts` | Builds host-filtered runtime snapshots (composes the shared visibility ladder) |
| `packageVisibility.ts` | The ONE shared package/surface visibility predicate — host/project/owner-scope/base-feature/surface-feature/trust ladder EXTRACTED from the snapshot; `resolveVisiblePackageSurface` runs the full ladder for one exact widget/card surface (asset mint/GET), `resolveVisiblePackageDockImage` the same ladder plus the ONE dock rule `isDockEntryGranted` (the entry's own features, then an `open-widget` target's — a target no visible package declares leaves the entry visible, exactly as the snapshot, which calls the same function) for one dock entry's declared picture; also computes the surface fingerprint + per-load package generation revoke signals. Its untrusted-absolute mirror calls the KERNEL `isAbsoluteAssetUrl`, the same predicate `snapshot.ts` and `validateContribution.ts` use — never a re-written regex, or the mint-side drop would drift away from the snapshot-side drop |
| `PackageAssetScopeAuthority.ts` | Bounded opaque asset-scope handles (192-bit, globalThis singleton): mint/heartbeat/own-close/revoke, 5-min idle expiry, per-user cap 128, periodic sweep, restart invalidation. Each record carries a `purpose` — `document` (a widget/card entry) or `icon` (a dock picture, `surfaceKind: 'dock'`); both share the one cap, but an icon mint may displace only an icon (a cap full of documents answers ONE typed `{ refused: 'icon_capacity' }`, revoking nothing) and a document mint displaces the user's least-recent icon before its least-recent document. Mint walks the whole live map once (O(total live scopes), the same walk as `sweep()`), then sorts at most that user's ≤128 records, only at the cap. The handle is NOT an authorizing capability — every GET re-runs the full visibility gate. **One record, two keys**: beside the handle index the record carries a second, independently drawn `pubToken` with its own index (`getByPubToken`), and EVERY removal path (lazy expiry on either lane, close, revoke, sweep, per-user-cap eviction) goes through the single private `#forget` so both keys drop together — a half-delete would be a PERMANENT one, since the sweep and the module interval iterate the handle map only |
| `packageAppAssetGet.ts` | The identity-free virtual asset GET handler (`/api/package-app/_scope/{handle}/{surface\|shared}/*`; for an `icon` scope only its one declared picture, byte-sniffed under the 256 KiB raster floor — §below; `resolveCurrentScopeDeclaration` is the ONE purpose branch the heartbeat shares) — fresh session + full visibility recheck + trust/generation/fingerprint compare, real-path root containment (a lexical prefix pre-filter, then root and request both resolved through symbolic links — a SYMBOLIC link under the surface root that points out of it answers 403, not bytes; a HARDLINK does not, and cannot be made to, because no path check can resolve one — see the accepted-residual list in the kernel primitive `@neuralis/package-system/paths` (`containment.ts`), including the `st_nlink`/same-device anti-fix), the `PACKAGE_APP_ASSET_MAX_BYTES` cap applied to the stat of the descriptor the read then uses, `private, no-store` + `no-referrer` + nosniff + the strict CSP floor (the CSP trust-INDEPENDENTLY, matching the next.config rule that reaches the wire), uniform non-leaking errors. It is also where a BUNDLE-mode entry gets its `<base>` injected — gated on the record's declared mode, the `surface` namespace and resolved-absolute-path equality with the entry, with `Content-Length` recomputed from the grown body (the stat size would truncate it) |
| `packageAppPubGet.ts` | The SESSION-FREE subresource GET handler (`/api/package-app/_pub/{pubToken}/{surface\|shared}/*`). An `icon`-purpose record is refused first, by purpose. A SEPARATE file because it is a separate security model: it reads no cookie, calls no session/agent/visibility resolver, and its entire error vocabulary is ONE uniform 404 (no 401/403/410 to add). It refuses HTML documents (`.html`/`.htm`), so it can never serve an alternative surface ENTRY that skips the entry lane's visibility gate; `.svg` — a document too, and a scriptable one — IS served, disarmed by the lane's `sandbox` CSP header rule rather than by the extension list, applies the same real-path root containment (lexical pre-filter, then root and request resolved through symlinks — this lane serves with no caller at all, so it is the one that must never follow a link out of the root), re-checks the package generation caller-free (registry identity stamp + fail-closed loader status) and enforces a per-scope distinct-path budget check-then-insert BEFORE the read — with the failed-read path REFUNDING exactly what that request charged (never an entry an earlier request paid for), because charging ahead of the read otherwise burns a slot and its bytes for the scope's whole life on a request that answered 404. It is reachable ONLY by a bundle-mode surface — the `pubToken` is handed out in exactly one place, the `<base href>` injected into that surface's entry — so a self-contained surface can never touch it. A served file refreshes the scope's idle window only within `PACKAGE_APP_PUB_TOUCH_MAX_AGE_MS` of creation, so a leaked token can ride a live scope but cannot keep one alive by itself — once the owning client stops heartbeating the scope dies within the idle TTL regardless of token traffic (a bound on how long a leak stays useful, NOT a claim that anything revokes in 60 s). The cap-stat and the read happen on ONE open descriptor, so the FINAL-component path race is closed rather than tolerated: a file deleted, replaced or symlinked-over after the check cannot change what is read, and the declared `Content-Length` (the stat size, parity with the entry lane) cannot disagree with the body. That is the final component only, and on POSIX only — the intermediate-directory TOCTOU and the Windows `O_NOFOLLOW` degradation stay ACCEPTED residuals, enumerated once in the kernel primitive `@neuralis/package-system/paths` (`containment.ts`) and never restated as closed. The read is still wrapped so an I/O failure answers the SAME 404 instead of escaping the vocabulary as a framework 500, and the descriptor is closed in a `finally` that also spans the budget refusal — an early return there would leak one fd per refused request on the one lane with no caller to rate-limit. Headers on a 200: `no-store` + `no-referrer` + nosniff + `ACAO: *` + `CORP: cross-origin`, and NEVER `Access-Control-Allow-Credentials`. The 404 carries `no-store` too — one `notFound()` helper for all nine refusal paths, because a refusal here can be TRANSIENT (a generation recheck during a package reload) and a cached transient 404 would pin a live widget's subresource dead — but it stays OPAQUE: no ACAO, no CORP |
| `packageAppBaseTag.ts` | The PURE (fs-free, Response-free, logger-free) `<base href>` builder + injector for a BUNDLE-mode entry document. Both halves are security, not formatting. `buildPackageAppBaseHref` percent-encodes every segment and returns `null` — meaning inject NOTHING — rather than emit an href still containing a quote, angle bracket or whitespace, because `entryRelPath` is PACKAGE DATA and the kernel's relative-url check permits those characters. `injectBaseTag` anchors at POSITION 0 — after a leading BOM only — except that a leading strict `<!doctype html>` (reachable past whitespace, complete comments and complete `<?…>` bogus-comment forms) keeps first position and the tag goes immediately after it. Position 0 is the security default; the doctype skip is purely cosmetic, since a tag inserted ahead of a doctype puts the document in quirks mode. **Never reintroduce a `<head>`/`<html>` anchor**: it is unsound BY SPEC, not merely hard to scan for — a `<base>` before `<html>`/`<head>` is hoisted into the IMPLICIT head and the package's later real `<head>` start tag is dropped, so a tag anchored after `<head` can never be first no matter how careful the scan. (It read as a scanner problem because its visible failures all were: `<head` matching `<header>`, a build banner mentioning `<head>`, a `<head>` inside a quoted attribute value.) **The scanner-shaped failure class is OPEN by construction, and the file says so** — it has bitten twice, first on that anchor and then on the COMMENT TERMINATOR SET (the tokenizer closes a comment on four constructions — `-->`, `--!>`, `<!-->`, `<!--->` — and the first version knew only `-->`, so a decoy comment walked the scan past the package's own `<base>`). Two guards therefore sit on top of the scan and neither is optional: an ANCHOR POST-CONDITION that collapses to position 0 whenever a `<base` appears anywhere in the skipped-over text, so precedence never depends on the scan being complete; and a UTF-16 BOM REFUSAL that injects NOTHING, because before the BOM breaks the encoding sniff and after the BOM loses precedence silently (the ASCII bytes decode as UTF-16 code units and never form an element). Cosmetic costs, all measured: the entry's own `<head>` attributes are lost, its own `<base>` is ignored including `target`, and a legacy/exotic doctype falls back to position 0 and therefore to quirks. There is deliberately no doctype-END finder — a `>` inside a quoted doctype identifier terminates the token, so an end-finder could splice the tag INSIDE the doctype where it is inert. Callers round-trip through `latin1` so a non-UTF-8 entry keeps its exact bytes — byte preservation, which is not the same as DECODING preservation, hence the UTF-16 refusal |
| `packageAppAssetFile.ts` | The Response-FREE primitives both lanes share: the MIME allowlist (plus the public lane's DERIVED subset — one table, never a second literal), `parseAssetRequest`, `resolveContainedAssetPath` (the cheap LEXICAL pre-filter, deliberately incomplete — a string computation cannot see a symlink) and `openContainedAssetFile`, the ONLY one of them that may be used to produce bytes. It is now a THIN LANE ADAPTER over the kernel's single containment primitive (`@neuralis/package-system/paths`, `containment.ts`): the primitive `realpath`s the request, decides containment through the kernel's one `isPathInside` predicate and hands back an already-OPEN descriptor whose stat carried the byte cap, so the check and the read are atomic. What this file still owns is the part the primitive deliberately cannot: it resolves the ROOT itself, because the shared denial enum cannot distinguish a declared-but-absent root (`no_root`) from an absent file (`missing`) and this lane must. The open flags — `O_NOFOLLOW` (a symlink raced into the final component is ELOOP) and `O_NONBLOCK`, a denial-of-service floor rather than a detail — live in the primitive, but their MEASURED justification stays in this file next to the lane it was measured on: `open()` on a FIFO blocks until a writer arrives, libuv's fs threadpool is PROCESS-WIDE with four threads by default, and the type gate runs AFTER the open, so without the flag four planted FIFOs stall every fs/dns/zlib/pbkdf2 operation in the host. CALLER CONTRACT: every non-ok return has closed what it opened; an `ok` result's descriptor is the caller's to close in a `finally` spanning every path to the response. They return discriminated RESULTS, never a `Response`, and keep `no_root` and `escape` DISTINCT — the entry lane answers 403 on an escape and the public lane 404, so a helper that returned a status would silently change the landed lane's wire behaviour |
| `packageUiModules.ts` | The native UI MODULE table behind `GET /api/package-ui/{hash}/{path…}` (`src/app/api/package-ui/`): for every host-assigned native builtin that declares `app.module` (`isNativeBuiltin`), the sha256 content hash of its `dist/app/` tree → that tree, plus the server-derived module URL, the fail-closed pins (shared-import record version = `UI_MODULE_HOST_API_VERSION`; the declared React range must admit the host major) and the lane's own 8 MiB per-file cap and `.js`/`.mjs`/`.css` MIME map; and the ONE union stylesheet (`workspace.css`), compiled by the kernel `compileUnionSheetOffThread` in one emitted JS worker that loads the host-resolved `tailwindcss` + `@tailwindcss/oxide` entries over explicit sources (`packageSheetSources`, the kernel client, `hostSheetSources` — `src/` in dev, the built `.next/static/chunks` when the server runs from `_runtime`). Built once per native definition set (globalThis-anchored, shared by both route graphs) with a non-blocking prewarm after core readiness and the canonical `ensureCommunityRuntime()` manager-readiness bridge; core readiness alone does not make the synchronous registry getters usable. The first runtime GET shares and awaits that same promise. Definition changes rebuild once, project revisions do not. Count/timing-only build logs carry module/engine/compile/scan/build phases, transfer bytes and the actual worker compile window; a named sheet failure keeps the modules. `viewUiAttachments` narrows the `ui` view to the packages the caller's snapshot shows. The lane reuses `packageAppAssetFile.ts`'s containment primitives |
| `packageAppAssetCsp.ts` | The six asset-serving FLOORS declared once: `buildPackageAppAssetCsp()` (the strict entry-lane policy, shared byte-for-byte with the next.config path-scoped header rule — it takes NO parameters, and when the deferred path-prefix tightening is picked up the absolute origin must NOT come from the request `Host` header, which is attacker-controlled: naming an attacker origin in `base-uri` is one directive away from naming it in `script-src`; `base-uri 'self'` is what permits the injected bundle-mode `<base>` that `'none'` would have made silently inert, and it also carries `sandbox allow-scripts allow-forms` — the ENTRY lane's own anti-navigation floor, added after a `_scope` document opened as a top-level navigation was measured running its inline script on the MAIN origin. The two flags mirror the product's iframe sandbox attribute exactly, so the in-frame effective set is unchanged, while a navigated or same-origin-embedded copy is forced opaque. **Never add `allow-same-origin`** — it is the plausible-looking edit that would hand every package UI the host origin; if the frame ever breaks, re-measure the flag set. Residual, precisely: the directive GRANTS `allow-scripts`, so a navigated document still RUNS and RENDERS on the host hostname — only the origin is taken away, so `document.cookie` throws and a credentialed `fetch` is unreadable. Never write "script-neutered"), `PACKAGE_APP_PUB_CSP` (`sandbox` — the session-free lane's anti-navigation floor, and the reason `.svg` is servable there; it is STRICTLY STRONGER than the entry lane's directive, which still permits script in its opaque origin, so it is never redundant), `PACKAGE_APP_ASSET_MAX_BYTES` (2 MiB per file), the session-free lane's per-scope budget `PACKAGE_APP_PUB_MAX_FILES` (64) + `PACKAGE_APP_PUB_MAX_TOTAL_BYTES` (8 MiB), and `PACKAGE_APP_PUB_TOUCH_MAX_AGE_MS` (60 s — the absolute ceiling on that lane's ability to EXTEND a scope's life, matched to the client heartbeat period and never to be set below it). All stay CODE constants — untrusted-input caps are the documented exception to package-declared platform config. Three of them have an unavoidable twin in the shipped authoring preflight (`brain-core/skills/create-package/scripts/check-package.mjs`, a standalone script that cannot import TypeScript): `ENTRY_MAX`, `PUB_MAX_FILES` and `PUB_MAX_TOTAL`. `__tests__/packageAppAssetCapDrift.test.ts` is the derive-and-verify guard — it greps each declaration back out of the script, asserts exactly one match (a RENAME must fail loud, not pass vacuously) and asserts equality with the host constant, so a one-sided edit fails loudly instead of letting an author ship a surface the lane will 404 |
| `snapshotForSSR.ts` | Snapshot helper for the workspace server component |
| `dispatch.ts` | Generic command/query fallback dispatch |
| `chat.ts` | Chat-card and tool-presentation helpers |
| `packageInstaller.ts` | Package install workflow (gated by the role's can-manage-roles flag OR `packages.manage` — never a role name) |
| `packagePublisher.ts` | Local package artifact publishing |
| `packageRecords.ts` | Persisted per-project package metadata |
| `sourceDiscovery.ts` | Converts source configs into package definitions |

## Internal asset descriptor vs navigable scoped URL

The snapshot's normalized widget/card URL (`/api/packages/{packageId}/app/…`)
is a HOST-INTERNAL **logical descriptor** — resolution/fingerprint data only.
Both surface kinds are normalized by the same rule in
`snapshot.ts` (`normalizeSurfaceAssetUrl`, over the kernel's ONE
`isAbsoluteAssetUrl` predicate): a relative url becomes the descriptor, and an
ABSOLUTE url from an `untrusted` package is DROPPED from the snapshot with a
warning (trusted/native absolutes pass through). The card branch runs the
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
package-public `app/shared/`. Both document and icon mints first resolve full
caller visibility, then use the exact resolved instance's loaded package root.
Builtin visibility is not project-only install membership; do not repeat a
project-only membership filter after that shared gate or borrow a sibling's root.
An absent loaded root still refuses the mint. Lifecycle is bounded end-to-end: client
refcount + 60 s heartbeat + last-release close on one side, 5-min idle
expiry + per-user cap + sweep + restart invalidation
(`PackageAssetScopeAuthority`) on the other; every GET/heartbeat re-runs the
FULL shared visibility predicate and 410s on any drift (package update ⇒ new
generation/fingerprint; agent deletion ⇒ verified-agent mismatch).

A dock entry's optional picture (`image`, a raster under `app/shared/`) rides
the SAME mint route and the SAME authenticated lane under an `icon` purpose:
`POST … { purpose: 'icon', surfaceKind: 'dock', surfaceId: <dock id> }` — the
caller names the dock, never a path; the server derives the one file from the
declaration through `resolveVisiblePackageDockImage` and answers
`/api/package-app/_scope/{handle}/shared/{picture}`. Its fingerprint covers the
declared path, the action target, the purpose and the trust, so a changed
declaration revokes old handles. Every GET serves ONLY that exact file, caps it
at the kernel's raster floor `APPEARANCE_IMAGE_MAX_BYTES` (256 KiB) on the
descriptor's stat before the read, and serves it only if the bytes sniff as
PNG/JPEG/WebP (kernel `sniffRasterImage`), under the SNIFFED type; no `<base>`,
no document, and the `_pub` lane refuses the record outright. Neither ceiling
is a platform tunable.

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
