# Workspace Package Runtime

This directory contains the client-side package runtime used by the Neuralis workspace. It converts server package snapshots into React widgets, dock entries, cards, command metadata, and host API bridges.

## Responsibilities

- Fetch and cache package runtime snapshots.
- Subscribe to runtime invalidation events.
- Register first-party direct React components by attaching each first-party package's prebuilt UI module at runtime — the host imports no package UI source.
- Render package widgets from `neuralis.app.surfaces[]` through direct, iframe, or placeholder strategies.
- Mint, refcount and heartbeat identity-free package asset scopes for every asset-backed iframe surface (no package/project/user/agent id ever appears in an iframe URL).
- Hand the applied snapshot and the asset-scope client to the `workspace.provider` fills (the card-owning package reconciles its card registrations there), and build dock items.
- Provide safe host bridges for first-party package UIs.

## Key Files

| File | Purpose |
|---|---|
| `runtimeClient.ts` | Snapshot fetch, ETag cache, and refresh helpers |
| `widgetRuntime.tsx` | Widget registration and lookup from runtime snapshots |
| `dockRuntime.ts` | Dock contribution projection |
| `hostRegistryInstance.ts` | Shared `PackageHostRegistry` singleton for direct first-party components, plus the HOST SLOTS (`HOST_SLOTS`: `workspace.provider` keyed per owner as `workspace.provider:<packageId>`, single-owner `workspace.emptyState` / `workspace.banner` / `dock.agentActivity` / `workspace.projectSettings`; `hostSlotOwnerViolation` keeps a package out of another's key), the slot prop contracts (`AgentActivitySlotProps`, `IDLE_AGENT_ACTIVITY`, `ProjectSettingsSlotProps`) and the subscribing reads the shell renders them through (`useHostSlot`, `useWorkspaceProviders`): `NeuralisHostProvider` (providers), `WorkspaceRoot` (empty state), `WorkspacePageClient` (banner), the dock's agent tile (activity), the `ProjectSwitcher` menu (project settings) |
| `uiModuleLoader.ts` | The RUNTIME lane: reads the runtime route's `ui` view, publishes the host's React ×5 + kernel client into the kernel shared-module table, checks the host-API and React-major pins fail-closed (both from the kernel / the bundle's build record), drops any descriptor whose URLs are not lane URLs under its own hash, plans modules with `planUiModuleInstall` and installs them CONCURRENTLY, each only after its own tier-2 providers (a hung `import()` holds its consumers, never an independent module), declares a provider's tier-2 ids (`provides`) BEFORE its import, `import()`s each server-derived `/api/package-ui/{hash}/…` URL and calls its `install…HostComponents({ registry, port })` exports through a guarded registry (own package id only, a slot only as itself, one error boundary per surface). Imports each package's module at most once; no poll. Holds the workspace's loading branch until the first module set settles, bounded by ONE release timer per page (`armUiModuleHoldRelease`, cleared by the settle). Also injects the union stylesheet |
| `__tests__/uiModuleLoader.test.ts` | Pins, lane-URL filter, the guarded registry's owner/slot checks, declare-before-import, the bounded hold, and the concurrent install (a hung module does not block an independent one; a consumer still waits for its provider) |
| `__tests__/hostPortProviderMount.test.ts` | Drift-guard over the real host deps: a dependency with a `direct` surface declares `app.module` (paired control), every `component.import` it names is registered in its `app/` tree, no UI source lives outside `app/` (the union sheet's scan scope), and every install entry mounts `WorkspaceHostPortProvider` |
| `buildWorkspaceHostPort.ts` | Builds the single `WorkspaceHostPort` passed to package host providers (incl. the host-owned `components` slots: UserAvatar, UserAvatarStack, and `onClientStateReset` over `../store/clientResetBus.ts` — the broom's fan-out to package client stores, emitted by the workspace store's `closeWidget` / `cleanAgentStore` / `cleanProjectStore` after their own `set()`). The two agent-list refresh verbs are a PAIR and must not be collapsed: `reload()` → the store's `reload()` = `reset()` + `bootstrap()`, which discards EVERY project's widget layouts (and persists the wipe); `reloadAgents()` → `selectProject(session.projectId)`, which re-reads the active project's agent list and re-points the session while leaving `runtimeByAgentId` intact. A package refreshing the agent list gets the narrow verb |
| `WidgetRendererStrategy.tsx` | Direct, iframe, and placeholder rendering strategy (a `direct` surface whose runtime module is still attaching renders "Loading…", not the "cannot be rendered" placeholder); decides scoped-asset vs absolute iframe source (the snapshot's `/api/packages/…/app/…` value is a host-internal descriptor, never navigated) |
| `packageAssetScope.ts` | Tab-local refcounted client of the identity-free asset scope: one scope per `(projectId, agentId, packageId, surfaceKind, surfaceId, fingerprint)` coordinate, shared in-flight mint, stable scoped URL per document generation, 60 s heartbeat, last-release best-effort close, 403/410 ⇒ revoke + fresh-generation re-mint |
| `IframeWidget.tsx` | Sandboxed iframe widget renderer — placeholder until the scope mint resolves; revocation drops to placeholder + re-acquires; no `?projectId=` or any identity ever in the iframe URL. The mint effect is keyed on the PRIMITIVE coordinate (`iframeWidgetScopeDeps`), never on the `source` object — see "Widget scope churn" below. Its sandbox comes from the kernel `externalFrameProfile`: a first-party widget whose url is a raw `https://` URL on a foreign origin gets that site's own origin (never top navigation); everything else stays opaque `allow-scripts allow-forms`. The frame is keyed on the sandbox string, so a profile change is a new browsing context |
| `__tests__/iframeWidgetScope.test.ts` | Pins that a registry re-hydrate causes zero release/re-mint while a moved `fingerprint` still re-mints, plus a drift guard that every coordinate field is a dependency |
| `packageAssetScope.ts` `workspaceAssetScope` | The ONE asset-scope client handed to every `workspace.provider` fill (with the applied snapshot) — the card reconcile (agent-core `app/chat/host/cardRuntime.ts`, run in agent-core's provider fill) mints card scopes through it; never a second refcount/heartbeat copy |

## Snapshot → card registry lifecycle

The card reconcile and its contract are agent-core's: `packages/agent-core/app/chat/host/README.md`
§Snapshot → card registry lifecycle. The host half: `seedSnapshotCache` + `hydrateWidgetRegistry`
stay SYNCHRONOUS at every `WorkspaceRoot` call site — widgets resolve at render time with no
subscription, so moving them into an effect would blank the first paint.

## The package UI entry: two asset modes, both server-side

A package UI entry loads in an OPAQUE-origin sandbox, so its subresource
requests carry no session cookie. A surface that declares nothing is
SELF-CONTAINED: it must inline `<style>`/`<script>` and use `data:` URIs,
because **the platform does not serve a self-contained entry's subresources**;
it does not "block" them, there is simply no authenticated path for them. That
is an AUTHORING rule (the shipped `check-package.sh` preflight enforces it) —
the host enforces only a byte cap on each served asset. A surface that declares
`assetMode: "bundle"` has its relative subresources (and `app/shared/`) served
on a session-free lane instead.

**Nothing in this directory changes between the two modes, and nothing here
should.** The client mints a scope and navigates the `url` it gets back,
exactly as before; the mode is decided and applied entirely on the server (the
host injects a `<base href>` into the entry response). Do not add a client-side
`assetMode` branch "for symmetry" — there is no client decision to make, and a
second place that reasons about the mode is a second place that can disagree
with the server about what a surface is.

## Widget scope churn — key the mint on primitives, never on the object

`resolveWidgetRenderer` builds a **fresh `source` object literal on every call**,
and the widget registry is re-hydrated on every runtime-hub event — including a
plain CONNECT, because `/api/events` sends a `runtime:snapshot` when the stream
opens, not only when something changed. Any consumer that keys work on the
IDENTITY of that object therefore does that work on every network blip, WSL
resume, server restart or `_packages` invalidation.

`IframeWidget` is the consumer where that was expensive: its mint effect keying
on `source` meant `handle.release()` → refCount 0 → scope `DELETE` → a fresh
`POST` → a NEW random handle → a new URL → **the frame navigated**, i.e. every
asset-backed widget reloaded and lost its in-frame state. The effect is now keyed
on the primitive projection `iframeWidgetScopeDeps(source)` (`kind`, absolute
url, `packageId`, `surfaceId`, `fingerprint`) plus `projectId` / `agentId` /
the revocation generation, so:

- a re-hydrate with identical content does nothing — no release, no re-mint, a
  byte-identical `src`, no navigation;
- a real manifest change still moves `fingerprint` and re-mints correctly;
- nothing about the security floor moves: the server re-runs the full visibility
  predicate on every scoped GET, revocation still yields 403/410, and the
  fingerprint recheck is unchanged.

The fix deliberately lives on the CONSUMER side — the renderer stays free to
build fresh objects, so the next snapshot-driven consumer inherits the property
instead of depending on someone remembering to memoize upstream. **Rule for new
work:** any field that reaches the minted URL or the scope coordinate belongs in
`iframeWidgetScopeDeps` *and* in the effect's dependency list;
`__tests__/iframeWidgetScope.test.ts` carries the drift guard.

## Security Boundary

Direct React rendering is reserved for host-assigned first-party packages, attached as a prebuilt runtime module (`app.module`) from a server-derived hash URL. Every other package renders through iframe-style rendering. The registry is intentionally explicit so package UI cannot import arbitrary host internals.

## Runtime Status

The workspace consumes the `app.surfaces[]` snapshot shape. Direct first-party components are installed by package-owned host entrypoints and resolved through the shared host registry. Package providers are composed at the workspace root by `NeuralisHostProvider` from the `workspace.provider` slot fills, so chat and filesystem UI state stay package-owned while the host supplies only generic workspace state through `WorkspaceHostPort`.

Approval support is active through `agent-core` pending interactions: reload hydration, live pending mirrors, and host-owned approve/deny chrome are wired through the chat package host surface. Trusted iframe cards can opt into the minimal bridge for `submitApproval` and `requestData` after package trust and origin checks.
