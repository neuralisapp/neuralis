/**
 * The host's package-runtime bootstrap (community edition).
 *
 * The host knows only the kernel: it discovers every builtin (host deps with a
 * `neuralis` block), stamps host-assigned trust, finds the ONE package that
 * provides the `runtime` contract, imports that provider natively from its own
 * package root and calls `boot`. Every later lookup goes through the returned
 * `RuntimeInstance` — by contract id, never by package name.
 *
 * Uses globalThis to survive Next.js bundler chunk boundaries: bootstrap runs
 * in the `instrumentation.ts` bundle, routes in others, and they must share ONE
 * runtime.
 */

import { access, mkdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { loadRuntimeProvider, resolveServiceProviders } from '@neuralis/package-system';
import { collectDeclaredConfigSettings } from '@neuralis/package-system/access';
import type {
  HostPorts,
  McpCredentialScopeRef,
  McpTokenStorePort,
  CredentialScope,
  GitOAuthAppConfigPort,
  GitOAuthProvider,
  PackageDefinition,
  PackageDiagnosticsPort,
  RuntimeInstance,
} from '@neuralis/package-system/contracts';
import { isMcpSelfScopeCredentialId, GIT_OAUTH_APP_CREDENTIAL_IDS } from '@neuralis/package-system/contracts';
import { type CredentialChangeEvent } from '../store/CredentialStore';
import { buildCredentialResolver, parseStoreScope } from './credentialResolver';
import { acquireFileMutex } from '../store/fileMutex';
import { getRouteLogger, routeSlowMsSource } from '../logging/hostLogger';
import { createCodexCredentialWriter } from './codexCredentialWriter';
import { resolveTrustedAppOrigin } from '../oauth/appOrigin';
import { resolveProjectRoot } from '@neuralis/package-system/paths';
import { createSelfScopeCredentialWriter } from './selfScopeCredentialWriter';
import { createMemberCredentialWriter } from './memberCredentialWriter';
import { getUserById, hasAnyUsers } from '../store/UserStore';
import { getProjectById, listAllProjects, listProjectsForUser, updateProject } from '../store/ProjectStore';
import { getScopeMembershipPort } from './scopeMembership';
import { isPrincipalActive, resolveMemberSession } from '../auth/memberSession';
import { getEnv } from '../config/env';
import { getLogger } from '../logging/setup';
import { migrateLegacyPackages } from '../packages/migrateLegacyPackages';
import { listAllActivatedPackages } from '../packages/projectPackages';
import { getPackageRuntimeManager } from '../packages/PackageRuntimeManager';
import { reconcileBuiltinGrantChanges } from '../packages/reconcileBuiltinGrantChanges';
import { peekUiModuleRefusals } from '../packages/packageUiModules';
import { clearProjectPackageCaches, rescanProjectPackages } from '../packages/rescanProjectPackages';
import { canAccessScope, hasFeature } from '@neuralis/package-system';
import { setOutboundAllowedHostsSource } from '@neuralis/package-system/web-common';
import { setKernelTunablesSource } from '@neuralis/package-system/contracts';
import { BUILTIN_PACKAGE_IDS, HOST_ROOT, resolveBuiltinRoot, assignBuiltinTrust } from './builtinSlots';
import { BUILD_VALIDATE_RECORD, admitBuiltins, readBuildRefusals } from './buildRefusals';
import { initHostIdentity } from './HostIdentity';
import { claimAllDeclaredDataFormats } from '../store/dataFormats';
import { startNotificationMaterializer } from '../notifications/materializer';

// ---------------------------------------------------------------------------
// Builtin package discovery — full package ids, scope-agnostic (builtinSlots).
// ---------------------------------------------------------------------------

export { BUILTIN_PACKAGE_IDS };

export const LEGACY_PROJECT_DIRS = ['agent-core', 'brain-core', 'terminal', '_installed'] as const; // 'terminal' stays: existing projects on disk may still carry the pre-H0 dir

const builtinRoots = new Map([...BUILTIN_PACKAGE_IDS].map(id => [id, resolveBuiltinRoot(id)]));

/** Caller identity slice the per-stream scope-hidden resolver gates on. */
export interface ScopeHiddenCaller {
  projectId: string;
  userId: string;
  agentId?: string;
  role?: string;
  grantedFeatures?: readonly string[];
}

/**
 * Resolve the set of loaded package ids HIDDEN for a per-stream agent caller,
 * across THREE axes — the single cross-tenant isolation boundary for the
 * stream/overview path (which consumes the GLOBAL, scope-blind runtime
 * snapshot and is gated ONLY by subtracting this hide-list):
 *   1. scope — a source-owned (WASM/markdown) package whose owning source is
 *      user/agent-scoped is hidden unless the caller can access that scope.
 *   2. base-access feature — a package declaring `requires.accessFeature` (or a
 *      `ProjectRecord.packageAccessFeature` override) is hidden unless the caller
 *      holds it; applies to builtins too.
 *   3. cross-project isolation (tenant-fencing-otter) — any loaded registry
 *      package that is neither a builtin nor owned by THIS project is hidden.
 *      The global snapshot carries every project's `_packages/` drops + source
 *      packages; without this axis a foreign project's packages leak into the
 *      `<packages>` overview, tools list, skills/files catalogs, and the
 *      workspace Packages panel. Canonical visibility predicate (inverse of
 *      `buildScopedSnapshot`): `BUILTIN_PACKAGE_IDS.has(id) || projectPkgIds.has(id)`.
 *
 * Extracted from the bootstrap closure so the three axes are unit-testable
 * without a live host. Deps are injected for testing.
 */
export async function resolveScopeHiddenIds(
  deps: {
    runtimeManager: ReturnType<typeof getPackageRuntimeManager>;
    getProjectById: typeof getProjectById;
    logger: { warn: (msg: string, meta?: Record<string, unknown>) => void };
  },
  input: ScopeHiddenCaller,
): Promise<Set<string>> {
  const { runtimeManager: mgr } = deps;
  const hidden = new Set<string>();
  const projectPkgIds = mgr.getProjectPackageIds(input.projectId);
  const grantedFeatures = [...(input.grantedFeatures ?? [])];

  // Axis 1 — scope (source-owned packages only; builtins exempt).
  for (const id of projectPkgIds) {
    if (BUILTIN_PACKAGE_IDS.has(id)) continue;
    const owner = mgr.getPackageOwnerScope(input.projectId, id);
    if (!owner) continue; // no owner scope ⇒ implicit project ⇒ visible
    const ok = canAccessScope(
      owner,
      { userId: input.userId, agentId: input.agentId, role: input.role, grantedFeatures },
      'read',
    );
    if (!ok) hidden.add(id);
  }

  // Axis 2 (base-access feature) + Axis 3 (cross-project isolation) — BOTH read
  // the registry, so they share ONE guarded read: `mgr.getRegistry()` throws
  // when the runtime state is not yet ready. An UNGUARDED registry read here
  // would throw uncaught and break the whole stream (the resolver is awaited at
  // the injection boundary). On a not-ready registry both axes are skipped and
  // Axis 1 (the manager's own maps) still stands — fail-soft, NOT fail-open-DoS.
  try {
    const overrides = (await deps.getProjectById(input.projectId))?.packageAccessFeature ?? {};
    const defs = new Map(mgr.getRegistry().listPackages().map((d) => [d.id, d] as const));

    // Axis 2 — base-access feature (manifest ∪ host override; builtins INCLUDED).
    const candidates = new Set<string>([...BUILTIN_PACKAGE_IDS, ...projectPkgIds]);
    for (const id of candidates) {
      if (hidden.has(id)) continue;
      const manifestFeature = defs.get(id)?.requires?.accessFeature;
      // The admin override map (`ProjectRecord.packageAccessFeature`) is keyed by
      // the RAW manifest id; the loaded id is scope-namespaced — translate.
      const manifestId = mgr.getPackageManifestId(input.projectId, id) ?? id;
      const overrideFeature = overrides[manifestId] ?? overrides[id];
      for (const feature of [manifestFeature, overrideFeature]) {
        if (feature && !hasFeature({ grantedFeatures }, feature)) {
          hidden.add(id);
          break;
        }
      }
    }

    // Axis 3 — cross-project isolation: hide every registry package that is
    // neither a builtin nor owned by THIS project (Set union ⇒ re-adds harmless).
    for (const id of defs.keys()) {
      if (BUILTIN_PACKAGE_IDS.has(id)) continue;
      if (!projectPkgIds.has(id)) hidden.add(id);
    }
  } catch (err) {
    // Registry not ready / read failure — the scope axis (from the manager's
    // own maps) still stands; log and proceed rather than break the stream.
    deps.logger.warn('scope-hidden registry axes (base-feature + cross-project) skipped', {
      projectId: input.projectId,
      error: String(err),
    });
  }

  return hidden;
}

// ---------------------------------------------------------------------------
// Bootstrap — single entry point
// ---------------------------------------------------------------------------

/**
 * Coarse lifecycle phase of the in-process runtime bootstrap.
 *
 * - `starting`     — process is up, bootstrap has not begun yet (server can
 *                    serve static/SSR + persisted store, but the live layer
 *                    is not ready).
 * - `loading`      — `getRuntime()` is in flight (discovery, the runtime
 *                    provider's `boot`: every package's init/start).
 * - `ready`        — full wiring complete; the runtime is live.
 * - `error`        — host boot or runtime readiness failed. A failed host boot
 *                    can retry; a rejected runtime keeps its failed readiness.
 */
export type BootstrapPhase = 'starting' | 'loading' | 'ready' | 'error';

/** Public, read-only snapshot of the bootstrap lifecycle for health probes. */
export type BootstrapStatus = {
  phase: BootstrapPhase;
  error: string | null;
  startedAt: number;
  readyAt: number | null;
};

type BootstrapState = {
  instance: RuntimeInstance | null;
  initializing: Promise<RuntimeInstance> | null;
  phase: BootstrapPhase;
  error: string | null;
  startedAt: number;
  readyAt: number | null;
};

const GLOBAL_KEY = '__neuralis_runtime_bootstrap__' as const;

function getState(): BootstrapState {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      instance: null,
      initializing: null,
      phase: 'starting',
      error: null,
      startedAt: Date.now(),
      readyAt: null,
    } satisfies BootstrapState;
  }
  return g[GLOBAL_KEY] as BootstrapState;
}

/**
 * Read-only bootstrap status for health/readiness probes. Reads the live
 * flags only — never triggers or awaits `getRuntime()`, so it is safe to
 * call from an unauthenticated `/api/health` route on every probe tick.
 */
export function getBootstrapStatus(): BootstrapStatus {
  const s = getState();
  return {
    phase: s.phase,
    error: s.error,
    startedAt: s.startedAt,
    readyAt: s.readyAt,
  };
}

/**
 * The booted runtime, or `null` if it has not finished booting.
 *
 * Deliberately does NOT trigger or await `getRuntime()`. The shutdown path
 * needs "is there something to tear down?" — awaiting a bootstrap while the
 * process is dying would hold the grace window open to build state nobody will
 * use. A process killed mid-bootstrap therefore skips runtime teardown, which
 * is correct: nothing it owns is running yet.
 */
export function peekRuntime(): RuntimeInstance | null {
  return getState().instance;
}

/**
 * Every builtin as its RAW manifest (`package.json#neuralis`), id set from the
 * discovered dep name and trust stamped by SOURCE (`assignBuiltinTrust`). The
 * runtime provider resolves each one's files from its root; the host needs the
 * manifest alone — `provides`, `configSettings[]` and `credentials[]` are
 * manifest fields. An unreadable manifest fails the boot: every id here already
 * passed discovery, which read the same file.
 */
async function readBuiltinManifests(): Promise<PackageDefinition[]> {
  return Promise.all(
    [...BUILTIN_PACKAGE_IDS].map(async (id) => {
      const raw = await readFile(join(builtinRoots.get(id)!, 'package.json'), 'utf-8');
      const manifest = (JSON.parse(raw) as { neuralis?: Partial<PackageDefinition> }).neuralis;
      if (!manifest) throw new Error(`builtin "${id}" has no neuralis manifest block`);
      // A builtin is NAMED by its package id (`@neuralis/admin`): every surface
      // that lists packages shows builtins under one uniform name. The manifest
      // `name` is a label for project/installed packages only.
      return assignBuiltinTrust({ ...manifest, id, name: id } as PackageDefinition);
    }),
  );
}

export async function getRuntime(): Promise<RuntimeInstance> {
  const state = getState();
  if (state.instance) return state.instance;
  if (state.initializing) return state.initializing;

  state.phase = 'loading';
  state.initializing = (async () => {
    const env = getEnv();
    const logger = getLogger().child('runtime');

    // The data-format claim precedes every store's first read (ProjectStore
    // migrates on read): data a NEWER build wrote stops the boot here, naming
    // the kind, both versions, the newest checkpoint and the restore command.
    // It claims every kind declared so far — the host's own — even when a
    // request already ran the host-only claim.
    const earlyFormats = await claimAllDeclaredDataFormats();
    if (earlyFormats.checkpoint) {
      logger.info('Data formats raised — checkpoint taken first', {
        checkpoint: earlyFormats.checkpoint,
        raised: earlyFormats.raised,
      });
    }

    const usersExist = await hasAnyUsers();

    // Pre-identity projectRoot: the runtime needs a concrete dir to init its
    // package data manager. If setup has run we use the system project;
    // otherwise a neutral "bootstrap" sentinel that holds no data.
    const bootstrapProjectId = await resolveBootstrapProjectId(usersExist);
    const projectRoot = resolveProjectRoot(env.projectsRoot, bootstrapProjectId);

    if (usersExist) {
      await repairLegacyProjectLayout(env.projectsRoot, projectRoot, logger);
    } else {
      logger.info('Fresh install detected — bootstrap will not create project state before setup');
    }

    // Every builtin — the runtime provider included — in ONE list, trust
    // stamped by SOURCE (crystalline-lagoon §3). R2 ordering: these ids already
    // passed the discovery exclusions in builtinSlots (reference-only /
    // no-neuralis-block packages never reach this line).
    const builtinManifests = await readBuiltinManifests();
    const packageRoots = new Map(builtinRoots);

    // The image build's record leaves out every builtin it refused (invalid, or
    // in conflict with another over a contract or a config key) BEFORE the
    // set-level checks below, so one bad package never stops the boot; a
    // package declaring a config key the HOST registered (`getEnv()`) is left
    // out the same way. No record (a dev tree): a conflict between two
    // packages still throws below, naming both.
    const buildRecord = await readBuildRefusals(HOST_ROOT);
    if (buildRecord.kind === 'malformed') {
      logger.error('build admission record unreadable — every builtin is admitted', { record: BUILD_VALIDATE_RECORD });
    }
    const { getPlatformConfigStore } = await import('../store/PlatformConfigStore');
    const platformConfig = getPlatformConfigStore(env.appRoot);
    const { admitted: builtinPackages, refused: refusedBuiltins, keyCollisions } = admitBuiltins(
      builtinManifests,
      buildRecord.kind === 'record' ? buildRecord.refused : [],
      (key) => platformConfig.getRegisteredSetting(key)?.declaredBy,
    );
    for (const collision of keyCollisions) {
      logger.error('builtin package refused — it declares a config key another declarer owns', { ...collision });
    }
    for (const refusal of refusedBuiltins) {
      logger.error('builtin package refused — the platform runs without it', { ...refusal });
    }

    // Contract providers by id, over the builtin set: exactly one `runtime`
    // and one `session-ticket-verifier`, else the boot fails loud here.
    const providers = resolveServiceProviders(builtinPackages);
    const runtimeProviderId = providers.providerOf('runtime')!;

    // Package-declared config registration (tunable-tanager Inc 1) — BEFORE
    // `boot`, so a package `init` can read `ctx.config` on its first line.
    // First-party-only (the collector trust-gates); boot-frozen (rescans do not
    // re-register); a collision between two packages (no build record) throws
    // loud here at boot.
    for (const { declarer, settings } of collectDeclaredConfigSettings(builtinPackages, (skipped) =>
      logger.warn('config declaration skipped', { ...skipped }),
    )) {
      platformConfig.registerSettings(declarer, settings);
    }

    // Kernel outbound-allowlist source (tunable-tanager Inc 2) — the ONE
    // host-injected value hook into package-system web-common, so the
    // `webToolsAllowedHosts` admin setting applies LIVE to the safeFetch stack.
    // May throw on an unregistered key by store philosophy — reachable only
    // through web tools, which exist only if their declarer loaded.
    setOutboundAllowedHostsSource(() => String(platformConfig.get('webToolsAllowedHosts') ?? ''));

    // Kernel tunables source (tunable-tanager Inc 5) — TYPED named fields
    // (the kernel never learns platform key names); a first-party package
    // DECLARES the backing keys, the kernel reads them via this source with
    // hardcoded fallbacks (null/throwing source ⇒ defaults). Wrapped per-field
    // so one unregistered key can never break the whole tunables read.
    const tunableNum = (key: string): number | undefined => {
      try {
        const v = Number(platformConfig.get(key));
        return Number.isFinite(v) ? v : undefined;
      } catch {
        return undefined;
      }
    };
    // String sibling — an EMPTY value must read as "unset" so the kernel's
    // hardcoded default still applies; an empty User-Agent is not a valid
    // override, it is an admin who cleared the field.
    const tunableStr = (key: string): string | undefined => {
      try {
        const v = platformConfig.get(key);
        const s = typeof v === 'string' ? v.trim() : '';
        return s.length > 0 ? s : undefined;
      } catch {
        return undefined;
      }
    };
    setKernelTunablesSource(() => ({
      webFetchTimeoutMs: tunableNum('webFetchTimeoutMs'),
      webFetchMaxResponseBytes: tunableNum('webFetchMaxResponseBytes'),
      webFetchMaxRedirects: tunableNum('webFetchMaxRedirects'),
      webFetchNetworkRetries: tunableNum('webFetchNetworkRetries'),
      webToolsUserAgent: tunableStr('webToolsUserAgent'),
      packageLogLevel: tunableStr('packageLogLevel'),
      packageLogLevelOverrides: tunableStr('packageLogLevelOverrides'),
      packageLogMaxBytes: tunableNum('packageLogMaxBytes'),
      packageLogMaxFiles: tunableNum('packageLogMaxFiles'),
      packageLogMaxAgeDays: tunableNum('packageLogMaxAgeDays'),
      mcpStdioRpcTimeoutMs: tunableNum('mcpStdioRpcTimeoutMs'),
    }));

    const { getCredentialStore: getCredStore } = await import('../store/credentialStoreInstance');
    const rawCredentialResolver = buildCredentialResolver();
    const { writeAuditLog } = await import('../store/AuditStore');
    const onAuditEvent = (event: { action: string; userId: string; target?: string; details?: Record<string, unknown> }) => {
      writeAuditLog({
        userId: event.userId,
        action: event.action as Parameters<typeof writeAuditLog>[0]['action'],
        target: event.target,
        details: event.details,
      });
    };
    // The admin package needs a REAL `audit.jsonl` line for credential
    // mutations: its `ctx.logger` writes a package data log with no actor
    // attribution, so without this sink the audit trail could not answer "who
    // set this credential". It rides `ctx.hostPorts.audit`.

    // -----------------------------------------------------------------------
    // Credential-use limits v1 (periodic-pelican phase 2, Increment D).
    //
    // ONE gate body — rule check (deny ⇒ audit `credential.use_denied` +
    // return undefined) and use recording on every VALUE-RETURNING resolve (a
    // miss is not a use) — applied at the resolve choke points below: the
    // package `ctx.credentials` resolver and `mcpTokenStore.readScoped`
    // (sidecar env/token reads never traverse the resolver). Every credential
    // in the DYNAMIC catalog is therefore counted and cappable with zero
    // package cooperation.
    //
    // LLM provider keys are EXCLUDED in v1 (owner decision): the exclusion set
    // is DERIVED from FIRST-PARTY manifest `credentials[]` declarations with
    // `category === 'llm'` — never hand-typed, and never trusted from a
    // non-first-party manifest (`category` is display metadata any package can
    // set; an untrusted drop must not exempt an id from counting).
    // The gate itself must never hard-break a resolve: store errors read as
    // zero usage and a failed record is logged, not thrown.
    // -----------------------------------------------------------------------
    const { CredentialUsageStore } = await import('../store/CredentialUsageStore');
    const { CredentialUseRules } = await import('../store/CredentialUseRules');
    const { buildCredentialUseGate, deriveLlmExcludedIds } = await import('./credentialUseGate');
    const credentialUsageStore = new CredentialUsageStore(env.appRoot);
    const credentialUseRules = new CredentialUseRules(env.appRoot);
    // The exclusion input is the WHOLE builtin list, the runtime provider
    // included — it is the manifest that declares the `category:'llm'`
    // provider keys. Deriving from a list without it shipped an EMPTY set
    // (live-caught D-1, 2026-08-15): LLM keys were counted, rule-settable, and
    // a rule on `llm.openai` would have denied the provider-key resolve
    // platform-wide.
    const llmExcludedIds = deriveLlmExcludedIds(builtinPackages);
    if (llmExcludedIds.size === 0) {
      // Structurally impossible on a healthy first-party set — an empty set
      // re-opens D-1: LLM keys become countable AND deniable, and an exhausted
      // rule on a provider key kills chat platform-wide. Loud, not silent.
      logger.error('[credential-use] derived LLM exclusion set is EMPTY — provider keys are NOT exempt from use rules');
    }
    const credentialUseGate = buildCredentialUseGate({
      usage: credentialUsageStore,
      rules: credentialUseRules,
      excludedIds: llmExcludedIds,
      onAudit: onAuditEvent,
      warn: (message, details) => logger.warn(message, details),
    });
    const gatedCredentialRead = credentialUseGate.gatedRead;
    const credentialUsePort = credentialUseGate.port;
    const credentialScopeKey = (scope?: { userId?: string; projectId?: string }): string =>
      scope?.projectId ? `projects/${scope.projectId}` : scope?.userId ? `users/${scope.userId}` : 'global';
    // The wrapped resolver every consumer sees (gitOAuthAppConfig and every
    // package's `ctx.credentials`).
    const credentialResolver: typeof rawCredentialResolver = {
      resolveCredential: (id, scope) =>
        gatedCredentialRead(
          id,
          { scopeKey: credentialScopeKey(scope), userId: scope?.userId },
          () => rawCredentialResolver.resolveCredential(id, scope),
        ),
      resolveForKind: (kind, scope) => rawCredentialResolver.resolveForKind(kind, scope),
    };
    // Agent-governance port (agent-governance Increment A): the ONE gate body
    // each for invite / project-create / agent-assign / role-map write, shared
    // by the host cookie routes and the admin package's members-invite /
    // projects-create / agents-assign / config-roles routes. The port shape is
    // SCALAR caller identity only (callerUserId, projectId) — the services
    // re-derive the floor from the LIVE record; never add role/grants/scope
    // params here. Built BEFORE `boot` so every `init()` sees it; the admin
    // routes fail CLOSED (503) when it is absent. A package route never writes
    // a host record directly — this port (`ctx.hostPorts.governance`) is the
    // only path.
    const { inviteUserToProject } = await import('../admin/inviteUserToProject');
    const { createProjectForUser } = await import('../admin/createProjectForUser');
    const { assignAgentToUser, pruneAgentOwnership } = await import('../admin/assignAgentToUser');
    const { patchProjectRoles } = await import('../admin/patchProjectRoles');
    const governance = {
      inviteUser: inviteUserToProject,
      createProject: createProjectForUser,
      assignAgent: assignAgentToUser,
      patchRoles: patchProjectRoles,
      // EXACTLY four keys — every one a gated CALLER ACT that re-derives its
      // own floor from the live record. `pruneAgentOwnership` is deliberately
      // NOT here: it is a consequence of an already-passed gate and carries no
      // floor of its own, so on this port it would be an unguarded ownership
      // write. Pinned by `governancePort.test.ts`.
    };

    const identity = initHostIdentity();

    // Phase B (2026-07-13) — the ONE unified self-scope credential WRITER for
    // the member-facing channel connection route (class `'channel'`) + the
    // git-connect route (class `'git'`). Self-scope (`users/<id>` ONLY,
    // structural — no scope-kind arg ⇒ SHAPE≠AUTHORITY) + the per-class
    // DISJOINT predicate + the 4096 cap are re-enforced HERE at the port
    // (defense in depth); every mutation audits id-only with the per-class
    // tag. The class → { predicate, audit tags } registry is HOST-OWNED CODE in
    // `selfScopeCredentialWriter.ts` — NO manifest field feeds it (M1).
    // `mcpTokenStore` stays SEPARATE (M2 — it carries a scope-kind arg).
    const selfScopeCredentialWriter = createSelfScopeCredentialWriter({
      store: getCredStore(),
      onAudit: onAuditEvent,
    });

    // Phase M (2026-07-13) — the host-owned MEMBER credential self-service WRITER
    // (BYOK). A `credentials.self` holder stores/removes/lists THEIR OWN
    // credentials in THEIR OWN `users/<id>` scope from the chat config panel.
    // The ONE deliberately-BROAD member writer: it accepts arbitrary custom ids,
    // DENY-gated by `isReservedSelfScopeCredentialId` (the reserved git/channel/MCP
    // classes stay on their dedicated cards) + `isValidCredentialId` charset,
    // re-enforced HERE at the port (defense in depth). Self-scope (`users/<id>`
    // ONLY); 4096 cap; audits id-only (`credential.self_write` /
    // `credential.self_delete`, NEVER the value). Kept SEPARATE from the narrow
    // allow-list `selfScopeCredentialWriter` (RULING 2 — mixing broad-deny +
    // narrow-allow polarities in one port is floor-bug fuel).
    const memberCredentialWriter = createMemberCredentialWriter({
      store: getCredStore(),
      onAudit: onAuditEvent,
    });

    // MCP1 Inc2 — scope-EXACT token store for the outbound MCP OAuth client.
    // The port enforces the hardened `mcp.<serverId>.<field>` id shape (R3 —
    // its OWN predicate, never the channel one) on every operation and audits
    // every mutation; there is NO cascade (R2: owning-scope only). Scope
    // AUTHORITY is established at the single feature-gated flow-initiation
    // call site + the captured-flow callback (R4) — never widen the call
    // surface.
    const mcpScopeAddress = (scope: McpCredentialScopeRef): string =>
      scope.kind === 'user' ? `users/${scope.userId}` : scope.kind === 'project' ? `projects/${scope.projectId}` : 'global';
    const assertMcpCredentialId = (credentialId: string): void => {
      if (!isMcpSelfScopeCredentialId(credentialId)) {
        throw Object.assign(new Error(`mcp credential id not allowed: ${credentialId}`), {
          code: 'credential_id_not_allowed',
        });
      }
    };
    const mcpTokenStore: McpTokenStorePort = {
      async readScoped(scope, credentialId) {
        assertMcpCredentialId(credentialId);
        // Use-limit gate: sidecar env/token reads never traverse the resolver,
        // so this is their (grant-time) counting point — without it the
        // "MCP-sidecar secrets count at grant time" statement would be false.
        return gatedCredentialRead(
          credentialId,
          {
            scopeKey: mcpScopeAddress(scope),
            userId: scope.kind === 'user' ? scope.userId : undefined,
          },
          async () => {
            const store = getCredStore();
            if (scope.kind === 'user') return store.readUser(scope.userId, credentialId);
            if (scope.kind === 'project') return store.read(scope.projectId, credentialId);
            return store.readGlobal(credentialId);
          },
        );
      },
      async writeScoped(scope, credentialId, value, actorUserId) {
        assertMcpCredentialId(credentialId);
        if (typeof value !== 'string' || !value.trim() || value.length > 16384) {
          throw Object.assign(new Error('invalid credential value'), { code: 'invalid_value' });
        }
        const store = getCredStore();
        if (scope.kind === 'user') await store.writeUser(scope.userId, credentialId, value.trim());
        else if (scope.kind === 'project') await store.write(scope.projectId, credentialId, value.trim());
        else await store.writeGlobal(credentialId, value.trim());
        onAuditEvent({
          action: 'mcp.credential_write',
          userId: actorUserId,
          target: credentialId,
          details: { scope: mcpScopeAddress(scope) },
        });
      },
      async deleteScoped(scope, credentialId, actorUserId) {
        assertMcpCredentialId(credentialId);
        const store = getCredStore();
        const deleted =
          scope.kind === 'user'
            ? await store.deleteUser(scope.userId, credentialId)
            : scope.kind === 'project'
              ? await store.delete(scope.projectId, credentialId)
              : await store.deleteGlobal(credentialId);
        if (deleted) {
          onAuditEvent({
            action: 'mcp.credential_delete',
            userId: actorUserId,
            target: credentialId,
            details: { scope: mcpScopeAddress(scope) },
          });
        }
        return deleted;
      },
    };

    // R2b (scope-guarding-magpie) — the host-side resolver that answers, per
    // stream, "which loaded package ids are HIDDEN for this caller?". The
    // three-axis cross-tenant isolation boundary lives in the exported
    // `resolveScopeHiddenIds` (module scope, unit-tested); the closure only
    // binds the live host deps. The manager is fetched per call (created
    // lazily). Hidden ≠ [OFF]: the caller never learns the package exists.
    const scopeHiddenResolver = (input: ScopeHiddenCaller): Promise<Set<string>> =>
      resolveScopeHiddenIds(
        { runtimeManager: getPackageRuntimeManager(), getProjectById, logger },
        input,
      );

    // Slice 1b (keyring-kestrel) — the git OAuth App-credential port for the
    // git-remote connect flow. `<provider>.oauth.clientId` / `.clientSecret` are
    // NORMAL cascade-resolved catalog credentials (NOT reserved, NOT global-exact
    // `readGlobal` like MCP): the flow reads clientId at the SESSION-derived scope on
    // start and clientSecret at the flow's CAPTURED scope on callback (NEW-MAJOR-E).
    // A CLOSED TABLE SELECTOR, never a generic id reader — the caller names a
    // `GitOAuthProvider` and the kernel table picks the pair, so no descriptor,
    // route or model input can name the credential this port reads.
    const gitOAuthAppConfig: GitOAuthAppConfigPort = {
      // The row lookup is guarded, not asserted: `GitOAuthProvider` is a closed
      // union TODAY, so a miss is unreachable — but a future provider string
      // reaching a bare `.clientId` would be a TypeError, i.e. a 500 where the
      // contract's answer is "no App credential configured" (null).
      async readClientId(provider: GitOAuthProvider, scope: CredentialScope): Promise<string | null> {
        const id = GIT_OAUTH_APP_CREDENTIAL_IDS[provider]?.clientId;
        if (!id) return null;
        return (await credentialResolver.resolveCredential(id, scope)) ?? null;
      },
      async readClientSecret(provider: GitOAuthProvider, scope: CredentialScope): Promise<string | null> {
        const id = GIT_OAUTH_APP_CREDENTIAL_IDS[provider]?.clientSecret;
        if (!id) return null;
        return (await credentialResolver.resolveCredential(id, scope)) ?? null;
      },
    };

    // The host ports every host-assigned first-party `ctx.hostPorts` carries
    // (the kernel hands them to first-party contexts only).
    const hostPorts: HostPorts = {
      members: { getUserById, getProjectById, listProjectsForUser, isPrincipalActive },
      audit: onAuditEvent,
      // The SessionResolverPort every unattended fire/wake re-resolves its
      // principal through (workflow runs, background delegates, inbox drains) —
      // the ONE member resolver. `null` (user not active, project archived, not
      // a member, role unresolvable) fails the run `creator_unavailable` and
      // auto-pauses the workflow; the scheduler bypasses the catch-all, so this
      // is the in-process fire choke point.
      sessionResolver: { resolveProjectMember: resolveMemberSession },
      scopeHidden: scopeHiddenResolver,
      // quickened-vane (HEALTH1) — host-runtime package mutations the admin
      // dashboard "Rescan packages"/"Clear cache" buttons + the
      // `manage-cache-and-rescan` skill reach. Each re-derives
      // `canManagePackages` FRESH inside the shared host fn.
      packageMaintenance: {
        rescanProject: (userId, projectId) => rescanProjectPackages(userId, projectId),
        clearRuntimeCaches: (userId, projectId) => clearProjectPackageCaches(userId, projectId),
      },
      // Consequences of an agent create/delete whose `canAccessAgent` gate has
      // already passed. `agentOwnership` lives on the PROJECT record, which no
      // package store can reach, so without these a deleted agent's entry
      // survives forever and an id re-created under the same slug inherits a
      // stranger's assignment (and locks out its own creator).
      agentLifecycle: {
        onAgentDeleted: async ({ projectId, agentId, actorUserId }) => {
          // The agent's credentials go with it — a slug re-created later inherits nothing.
          try {
            getCredStore().deleteAgentScope(projectId, agentId);
          } catch (err) {
            logger.warn(`agent credential purge failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          await pruneAgentOwnership({
            projectId,
            agentId,
            ...(actorUserId ? { actorUserId } : {}),
            reason: 'agent_deleted',
          });
        },
        onAgentCreated: async ({ projectId, agentId, actorUserId }) => {
          await pruneAgentOwnership({
            projectId,
            agentId,
            ...(actorUserId ? { actorUserId } : {}),
            reason: 'agent_created',
          });
        },
      },
      selfScopeCredentialWriter,
      memberCredentialWriter,
      // The Codex OAuth credential port: the four-tier gate and the self-heal
      // persist/purge/lock stay HERE, restricted to the one Codex id; the
      // provider package owns the flow and never reaches the generic store.
      codexCredentialWriter: createCodexCredentialWriter({
        getStore: () => getCredStore(),
        onAuditEvent,
        appRoot: env.appRoot,
        acquireFileMutex,
        logger: getLogger(),
      }),
      // The ONE trusted app origin every package-built OAuth redirect reads —
      // request-independent; a request header never becomes a redirect target.
      appOrigin: () => resolveTrustedAppOrigin(),
      mcpTokenStore,
      gitOAuth: gitOAuthAppConfig,
      credentialStore: getCredStore(),
      credentialUseAdmin: { rules: credentialUseRules, usage: credentialUsageStore, excludedIds: credentialUseGate.excludedIds },
      packageDiagnostics: getPackageDiagnosticsPort(),
      governance,
      platformConfig,
    };

    // Register raw manifest keys before importing any provider module.
    const runtimeProvider = await loadRuntimeProvider(packageRoots.get(runtimeProviderId)!);
    const instance = await runtimeProvider.boot({
      appRoot: env.appRoot,
      projectsRoot: env.projectsRoot,
      projectRoot,
      hostId: 'neuralis',
      builtinPackages,
      refusedBuiltins,
      packageRoots,
      logger,
      config: { get: (key: string) => platformConfig.get(key) },
      hostPorts,
      hostIdentity: identity,
      credentialResolver,
      credentialUsePort,
      routeLogger: getRouteLogger(),
      routeSlowMsSource,
      installedPackagesProvider: listAllActivatedPackages,
    });
    state.instance = instance;
    // The provider answers before init/start; post-load format claims and
    // credential-layout migration need its evaluated package definitions.
    await instance.whenReady();

    // Every package the loader evaluated has declared its record kinds: claim
    // them all (checkpoint + raise, or stop on newer data) and fail the boot on
    // a declared kind nobody claimed. The host names no package kind here. A
    // package whose `init` reads a store before this line relies on its own
    // per-store `claimDataFormat` (the kernel's second line).
    const packageFormats = await claimAllDeclaredDataFormats();
    if (packageFormats.checkpoint) {
      logger.info('Data formats raised — checkpoint taken first', {
        checkpoint: packageFormats.checkpoint,
        raised: packageFormats.raised,
      });
    }

    // Record that the session-ticket verifier is online (the audit trace a
    // `skill.session_call` line is read against).
    onAuditEvent({
      action: 'session_ticket_authority.ready',
      userId: '__system__',
      target: instance.services.providerOf('session-ticket-verifier'),
      details: { mode: 'stream-scope-ticket' },
    });

    await migrateLegacyPackages(projectRoot, join(env.appRoot, 'packages'), logger);

    // A builtin `pnpm neuralis:pkg add|remove` moved in or out of the deps
    // brings or takes its default role grants in every existing project (the
    // usecase owns the rule). A builtin the runtime REFUSED at this boot is
    // still a dependency: its manifest keeps its features provided.
    await reconcileBuiltinGrantChanges({
      appRoot: env.appRoot,
      builtinIds: BUILTIN_PACKAGE_IDS,
      providers: [...builtinManifests, ...instance.getLoader().listLoaded()],
      listProjectIds: async () => (await listAllProjects({ includeArchived: true })).map((p) => p.id),
      updateProject,
      logger,
    });

    // ---- Credential change bus → every package's `onCredentialChanged` -----
    //
    // Every CredentialStore write/delete emits a synchronous event. The host
    // translates the store's flat scope string into the kernel scope and fans
    // the VALUE-FREE event out through the runtime (bounded per package); each
    // package drops its own caches (provider keys, endpoint discovery, the
    // embedder). This is the single chokepoint that keeps package caches
    // consistent with on-disk credential state after OAuth reconnects, token
    // rotations and manual disconnects — without nuking unrelated tenants.
    const credentialCacheLogger = getLogger().child('credential-cache');
    getCredStore().subscribe((event: CredentialChangeEvent) => {
      try {
        void instance
          .notifyCredentialChanged({
            credentialId: event.credentialId,
            scope: parseStoreScope(event.scope),
            change: event.kind === 'write' ? 'set' : 'deleted',
          })
          .catch((err: unknown) => {
            credentialCacheLogger.warn('credential change fan-out failed', {
              credentialId: event.credentialId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        onAuditEvent({
          action: event.kind === 'write' ? 'credential.write' : 'credential.delete',
          userId: '__system__',
          target: event.credentialId,
          details: { scope: event.scope, eventKind: event.kind, source: 'bus' },
        });
      } catch (err) {
        credentialCacheLogger.warn('subscription handler failed', {
          credentialId: event.credentialId,
          scope: event.scope,
          kind: event.kind,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // Legacy bare-slug agent credentials → `agents/<projectId>/<agentId>`. Here,
    // not at store init: which project holds an agent is the agent directory's
    // answer. Until it runs a legacy directory simply does not resolve
    // (fail-closed).
    try {
      const membership = getScopeMembershipPort();
      const layout = await getCredStore().migrateAgentCredentialLayout({
        listProjectIds: async () => (await listAllProjects({ includeArchived: true })).map((p) => p.id),
        agentBelongsToProject: (projectId, agentId) => membership.agentBelongsToProject(projectId, agentId),
      });
      credentialCacheLogger.info('agent credential layout', layout);
    } catch (err) {
      credentialCacheLogger.warn('agent credential layout migration failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Readiness succeeded and host wiring is complete. Package background
    // work keeps its own health and deprovision fences.
    state.phase = 'ready';
    state.readyAt = Date.now();
    state.error = null;
    // The notification service consumes the provider's published events from
    // here on — after readiness, so no event is judged against a half-loaded runtime.
    startNotificationMaterializer(instance);

    return instance;
  })();

  try {
    return await state.initializing;
  } catch (err) {
    state.phase = 'error';
    state.error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    state.initializing = null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read-only diagnostics over the live, successfully booted host runtime. */
export function getPackageDiagnosticsPort(): PackageDiagnosticsPort {
  const state = getState();
  const requireReady = (): RuntimeInstance => {
    if (state.phase !== 'ready' || !state.instance) {
      throw Object.assign(new Error('Runtime diagnostics not ready'), {
        code: 'runtime_not_ready', status: 503,
      });
    }
    return state.instance;
  };
  return {
    listDefinitions: () => requireReady().getLoader().listLoaded(),
    health: async () => requireReady().health(),
    uiModuleRefusals: () => peekUiModuleRefusals(),
  };
}

async function repairLegacyProjectLayout(
  projectsRoot: string,
  projectRoot: string,
  logger: ReturnType<typeof getLogger>,
): Promise<void> {
  await mkdir(projectRoot, { recursive: true });
  for (const dirName of LEGACY_PROJECT_DIRS) {
    const legacyPath = join(projectsRoot, dirName);
    const projectPath = join(projectRoot, dirName);
    if (!await pathExists(legacyPath)) continue;
    if (await pathExists(projectPath)) {
      logger.warn('Legacy project data directory left in projects root because target already exists', { legacyPath, projectPath });
      continue;
    }
    await rename(legacyPath, projectPath);
    logger.info('Moved legacy project data directory into project root', { from: legacyPath, to: projectPath });
  }
}

/**
 * Resolve a projectRoot to feed into agent-core bootstrap.
 *
 * Before setup runs, there's no real project yet, so agent-core gets a neutral
 * "bootstrap" directory that holds no user data. After setup, we use the first
 * project as seen by ProjectStore. HostIdentity re-resolves this properly after
 * bootstrap completes.
 */
async function resolveBootstrapProjectId(usersExist: boolean): Promise<string> {
  if (!usersExist) return 'bootstrap';
  try {
    const { listAllProjects } = await import('../store/ProjectStore');
    const projects = await listAllProjects();
    if (projects.length > 0) return projects[0].id;
  } catch { /* ProjectStore not ready */ }
  return 'bootstrap';
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

