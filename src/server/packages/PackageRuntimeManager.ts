import { providedFeatureIds, type PackageRegistry, type PackageRuntime, type SnapshotInvalidationReason } from '@neuralis/package-system';
import type { PackageDefinition, SourceScope, RuntimeLoaderPort, RuntimePackageStatus } from '@neuralis/package-system/contracts';
import { canReceivePackageGrant } from '../projects/access';
import { getRuntime } from '../host/bootstrap';
import { BUILTIN_PACKAGE_IDS } from '../host/bootstrap';
import type { ResolvedPackageRecord } from './packageRecords';
import { applyGrantsPatch, revokeGrantsPatch } from './reconcileBuiltinGrantChanges';
import { getProjectById, updateProject } from '../store/ProjectStore';

type RuntimeManagerState = {
  loader: RuntimeLoaderPort;
  registry: PackageRegistry;
  runtime: PackageRuntime;
};

type SyncOptions = {
  invalidate?: boolean;
  reason?: SnapshotInvalidationReason;
};

/** A package that failed to load/reload during a project sync. */
export type PackageLoadError = {
  packageId: string;
  error: string;
};

/** Result of {@link PackageRuntimeManager.syncProjectPackagesToRuntime}. */
export type PackageSyncResult = {
  /** Packages whose load/reload threw — surfaced so callers (e.g. the rescan
   *  route) can report the reason instead of letting the package silently
   *  vanish from every catalog. The loader records `status:'error'` for the
   *  same id (keystone-lattice BUG-1), so `getStatus(packageId)` is also
   *  queryable. */
  errors: PackageLoadError[];
};

/**
 * What a project package was (re)loaded FROM: the scanner record's definition
 * after trust overrides, plus the WASM artifact stamp. Computed from the RECORD,
 * never from the loader's stored definition — the loader builds and mutates its
 * own copy (a `lifecycle` shell), so that one never equals what went in, and a
 * rebuilt WASM module changes no manifest byte. One `JSON.stringify` per record
 * per sync.
 */
function inputKeyOf(record: ResolvedPackageRecord): string {
  return `${JSON.stringify(record.definition)}\0${record.artifactStamp ?? ''}`;
}

export class PackageRuntimeManager {
  #state: RuntimeManagerState | null = null;
  #initPromise: Promise<RuntimeManagerState> | null = null;

  /** Track which packageIds belong to which project for isolated sync. */
  readonly #projectPackageIds = new Map<string, Set<string>>();

  /**
   * R2b — owning SOURCE scope per loaded package id, per project. Parallel to
   * `#projectPackageIds` (kept a plain `Set` so membership readers + tests are
   * untouched). A package absent from this map (builtins, default `_packages/`)
   * is treated as `{ kind: 'project' }` ⇒ never scope-hidden. Consumers read it
   * via `getPackageOwnerScope` and feed `canAccessScope` for advertise isolation.
   */
  readonly #packageOwnerScope = new Map<string, Map<string, SourceScope>>();

  /**
   * Scope-namespaced loader id → RAW manifest id, per project. Parallel to
   * `#packageOwnerScope`. Read via `getPackageManifestId` so a consumer can
   * translate an admin override (keyed by the manifest id) against a namespaced
   * registry id — the host advertise resolver (Axis 2) + the client snapshot
   * base-access gate both need it. Rebuilt fresh each sync (a removed id drops out).
   */
  readonly #packageManifestId = new Map<string, Map<string, string>>();

  /**
   * Per-project serialization tail: one sync or project reload at a time —
   * two interleaved ones refused a load as "already loaded" (the second
   * activated while the first was between unload and load). A failed link
   * never blocks the next; the entry goes when its tail settles. One promise
   * per project, nothing while idle.
   */
  readonly #syncChain = new Map<string, Promise<void>>();

  /** Loader id → {@link inputKeyOf} of the record it was last (re)loaded from. */
  readonly #inputKey = new Map<string, string>();

  async ensureInitialized(): Promise<RuntimeManagerState> {
    return this.#ensureCoreState();
  }

  async loadPackage(
    record: ResolvedPackageRecord,
    options?: { reason?: SnapshotInvalidationReason; invalidate?: boolean },
  ): Promise<void> {
    const state = await this.#ensureCoreState();
    const existing = state.loader.getStatus(record.packageId);

    if (existing) {
      await state.loader.reload(
        record.definition,
        record.packageRoot,
        record.manifestId,
        record.ownerProjectId,
      );
    } else {
      await state.loader.load(
        record.definition,
        record.packageRoot,
        record.manifestId,
        record.ownerProjectId,
      );
      this.#assertActive(state.loader.getStatus(record.packageId), record.packageId);
      await state.loader.start(record.packageId);
    }

    if (options?.invalidate !== false) {
      this.invalidateRuntime(options?.reason ?? 'package-install', [record.packageId]);
    }
  }

  async reloadPackage(
    packageId: string,
    nextDefinition?: PackageDefinition,
    nextPackageRoot?: string,
    options?: { reason?: SnapshotInvalidationReason; invalidate?: boolean },
  ): Promise<void> {
    const work = async (): Promise<void> => {
      const state = await this.#ensureCoreState();
      const current = state.loader.getStatus(packageId);
      if (!current) throw new Error(`Package not found: ${packageId}`);
      // Record-less: the loader's stored definition is NOT the input a sync
      // compares, so the key goes — the next sync reloads once from disk.
      this.#inputKey.delete(packageId);
      await state.loader.reload(nextDefinition ?? current.definition, nextPackageRoot, this.#manifestIdOf(packageId), this.#ownerProjectOf(packageId));
      if (options?.invalidate !== false) {
        this.invalidateRuntime(options?.reason ?? 'package-reload', [packageId]);
      }
    };
    const projectId = this.#ownerProjectOf(packageId);
    return projectId ? this.#serialize(projectId, work) : work();
  }

  async unloadPackage(
    packageId: string,
    options?: { reason?: SnapshotInvalidationReason; invalidate?: boolean },
  ): Promise<boolean> {
    const state = await this.#ensureCoreState();
    const unloaded = await state.loader.unload(packageId);
    if (unloaded && options?.invalidate !== false) {
      this.invalidateRuntime(options?.reason ?? 'package-uninstall', [packageId]);
    }
    return unloaded;
  }

  /**
   * Sync a project's packages — `records` is the FULL desired set, every
   * scanner of the project — into the runtime: unload what is gone, load what
   * is new, reload only what changed on disk ({@link inputKeyOf}) or sits in
   * `error`. Runs on the project's chain, one at a time. Project-isolated:
   * packages of other projects are never touched.
   */
  syncProjectPackagesToRuntime(
    projectId: string,
    records: ResolvedPackageRecord[],
    options?: SyncOptions,
  ): Promise<PackageSyncResult> {
    return this.#serialize(projectId, () => this.#syncNow(projectId, records, options));
  }

  async #syncNow(
    projectId: string,
    records: ResolvedPackageRecord[],
    options?: SyncOptions,
  ): Promise<PackageSyncResult> {
    const state = await this.#ensureCoreState();
    const previousIds = this.#projectPackageIds.get(projectId) ?? new Set<string>();
    const affected = new Set<string>();
    const errors: PackageLoadError[] = [];

    // Build the desired set keyed by the scope-NAMESPACED loader id. Two records
    // sharing a namespaced id = the SAME (project, scope, manifest) declared by two
    // sources (e.g. `_packages/foo` AND a project-scope `recognizesPackages` source
    // also named `foo`) — surface it instead of the old silent last-writer-wins drop.
    const desired = new Map<string, ResolvedPackageRecord>();
    for (const record of records) {
      if (desired.has(record.packageId)) {
        errors.push({
          packageId: record.manifestId,
          error: `Package id "${record.manifestId}" is declared by two sources in the same scope — keeping the first; rename one.`,
        });
        continue;
      }
      desired.set(record.packageId, record);
    }

    // Unload packages from THIS project that are no longer on disk
    for (const prevId of previousIds) {
      if (BUILTIN_PACKAGE_IDS.has(prevId)) continue;
      if (desired.has(prevId)) continue;
      try {
        // Capture the definition BEFORE unload so we can revoke its provided
        // features from the project's role grants (C7a — uninstall revocation).
        const removedDef = state.loader.getStatus(prevId)?.definition;
        await state.loader.unload(prevId);
        this.#inputKey.delete(prevId);
        if (removedDef) await this.#revokeFeatureGrants(state, projectId, prevId, removedDef);
        affected.add(prevId);
      } catch (err) {
        console.error(`[PackageRuntimeManager] Failed to unload project package ${prevId}:`, err);
      }
    }

    // Load / reload desired project packages
    for (const [packageId, record] of desired) {
      // Defense-in-depth: with scope-namespacing a loader id encodes (project,
      // scope) so a cross-tenant collision is unreachable — but keep this guard so a
      // future addressing change can never silently re-expose the slot to another
      // project's code.
      if (!BUILTIN_PACKAGE_IDS.has(packageId)) {
        const owner = this.#ownerProjectOf(packageId);
        if (owner && owner !== projectId) {
          errors.push({
            packageId: record.manifestId,
            error: `Package id "${packageId}" is owned by another project — refusing cross-tenant load.`,
          });
          continue;
        }
      }
      const current = state.loader.getStatus(packageId);
      if (!current) {
        try {
          await this.#activateRecord(state, record);
          this.#inputKey.set(packageId, inputKeyOf(record));
          affected.add(packageId);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[PackageRuntimeManager] Failed to load project package ${packageId}:`, err);
          errors.push({ packageId, error: message });
        }
        continue;
      }
      const key = inputKeyOf(record);
      if (current.status !== 'error' && this.#inputKey.get(packageId) === key) continue;
      // Prevent trust escalation on reload
      const currentTrust = current.definition.access?.trust ?? 'untrusted';
      const nextTrust = record.definition.access?.trust ?? 'untrusted';
      const TRUST_RANK: Record<string, number> = { untrusted: 0, trusted: 1, 'first-party': 2 };
      if ((TRUST_RANK[nextTrust] ?? 0) > (TRUST_RANK[currentTrust] ?? 0)) {
        console.warn(`[PackageRuntimeManager] Trust escalation rejected on reload`, { packageId, currentTrust, nextTrust });
        continue;
      }
      try {
        await state.loader.reload(record.definition, record.packageRoot, record.manifestId, record.ownerProjectId);
        this.#inputKey.set(packageId, key);
        affected.add(packageId);
      } catch (err) {
        this.#inputKey.delete(packageId);
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[PackageRuntimeManager] Failed to reload project package ${packageId}:`, err);
        errors.push({ packageId, error: message });
      }
    }

    // Update project→packageIds tracking
    this.#projectPackageIds.set(projectId, new Set(desired.keys()));

    // R2b — rebuild the per-project owning-scope map from the desired set. A
    // package without a recorded `ownerScope` defaults to project scope (never
    // scope-hidden). Rebuilt fresh each sync so a removed id drops out.
    const scopeMap = new Map<string, SourceScope>();
    const manifestMap = new Map<string, string>();
    for (const [packageId, record] of desired) {
      scopeMap.set(packageId, record.ownerScope ?? { kind: 'project' });
      manifestMap.set(packageId, record.manifestId);
    }
    this.#packageOwnerScope.set(projectId, scopeMap);
    this.#packageManifestId.set(projectId, manifestMap);

    if ((options?.invalidate ?? true) && affected.size > 0) {
      this.invalidateRuntime(options?.reason ?? 'package-update', [...affected]);
    }

    return { errors };
  }

  /**
   * Reload a single project package from disk. Used after trust flips or a build
   * completes — re-reads the manifest, re-applies trust overrides from the
   * ProjectRecord, and invokes the loader so WASM / MCP / declarative state
   * reflects the latest on-disk + config.
   */
  reloadProjectPackage(projectId: string, slug: string): Promise<void> {
    return this.#serialize(projectId, () => this.#reloadProjectPackageNow(projectId, slug));
  }

  async #reloadProjectPackageNow(projectId: string, slug: string): Promise<void> {
    const state = await this.#ensureCoreState();

    // Lazy imports to avoid circular deps.
    const [{ getProjectPackageScanner }, { resolveProjectRoot }, { getEnv }, { getLogger }, { toResolvedRecord }, { applyTrustOverrides }] = await Promise.all([
      import('./ProjectPackageScanner'),
      import('@neuralis/package-system/paths'),
      import('../config/env'),
      import('../logging/setup'),
      import('./packageRecords'),
      import('./projectPackages'),
    ]);

    const env = getEnv();
    const logger = getLogger().child('project-packages');
    const projectRoot = resolveProjectRoot(env.projectsRoot, projectId);
    const scanner = getProjectPackageScanner(projectRoot, logger);
    await scanner.scan();

    const record = scanner.getPackage(slug);
    if (!record) {
      throw new Error(`Package "${slug}" not found in project "${projectId}"`);
    }

    // Default `_packages/` scanner ⇒ project scope; namespace the loader id so
    // getStatus/reload/load and the maps all key on the SAME namespaced id. The
    // admin trust override rides the ONE `applyTrustOverrides`.
    const [resolved] = await applyTrustOverrides(projectId, [toResolvedRecord(record, projectId, { kind: 'project' })]);
    const runtimeId = resolved.packageId;
    const nextDefinition = resolved.definition;

    // `trusted` is the CEILING here — an admin override can never reach
    // `first-party`, which is host-assigned by source. That is what keeps the
    // first-party-only code runtimes (`node`, `mcp`) out of reach of a project
    // drop no matter how far an admin promotes it. The reload path itself is
    // also the teardown: `loader.reload` unloads first, and `stopPackage`
    // closes a live MCP child even when the package never started.
    const current = state.loader.getStatus(runtimeId);
    if (current) {
      await state.loader.reload(
        nextDefinition,
        record.packageRoot,
        resolved.manifestId,
        resolved.ownerProjectId,
      );
    } else {
      await state.loader.load(
        nextDefinition,
        record.packageRoot,
        resolved.manifestId,
        resolved.ownerProjectId,
      );
      await state.loader.start(runtimeId);
    }
    // The same input a sync compares — the next one skips this package.
    this.#inputKey.set(runtimeId, inputKeyOf(resolved));

    // Track project ownership of the NAMESPACED id.
    const ids = this.#projectPackageIds.get(projectId) ?? new Set<string>();
    ids.add(runtimeId);
    this.#projectPackageIds.set(projectId, ids);

    // R2b — project-scope owning scope + the manifest map, keyed by the namespaced id.
    const scopeMap = this.#packageOwnerScope.get(projectId) ?? new Map<string, SourceScope>();
    scopeMap.set(runtimeId, { kind: 'project' });
    this.#packageOwnerScope.set(projectId, scopeMap);
    const manifestMap = this.#packageManifestId.get(projectId) ?? new Map<string, string>();
    manifestMap.set(runtimeId, resolved.manifestId);
    this.#packageManifestId.set(projectId, manifestMap);

    this.invalidateRuntime('package-reload', [runtimeId]);
  }

  invalidateRuntime(reason: SnapshotInvalidationReason, packageIds?: string[]): void {
    this.#requireState().runtime.invalidate(reason, packageIds);
  }

  getRegistry(): PackageRegistry {
    return this.#requireState().registry;
  }

  getRuntime(): PackageRuntime {
    return this.#requireState().runtime;
  }

  getLoader(): RuntimeLoaderPort {
    return this.#requireState().loader;
  }

  /** Get the set of package IDs loaded for a specific project. */
  getProjectPackageIds(projectId: string): ReadonlySet<string> {
    return this.#projectPackageIds.get(projectId) ?? new Set();
  }

  /**
   * R2b — owning SOURCE scope of a loaded package id within a project, or
   * `undefined` when the package has no recorded scope (builtins, default
   * `_packages/` drop-zone) ⇒ the caller treats it as project-scope (visible).
   */
  getPackageOwnerScope(projectId: string, packageId: string): SourceScope | undefined {
    return this.#packageOwnerScope.get(projectId)?.get(packageId);
  }

  /** The project that currently owns a namespaced loader id, or undefined. */
  #ownerProjectOf(packageId: string): string | undefined {
    for (const [pid, ids] of this.#projectPackageIds) if (ids.has(packageId)) return pid;
    return undefined;
  }

  /**
   * The RAW manifest id for a namespaced loader id within a project, or
   * `undefined` (builtins / not loaded). Consumers translate an admin override
   * (keyed by manifest id) against a namespaced registry id via this.
   */
  getPackageManifestId(projectId: string, packageId: string): string | undefined {
    return this.#packageManifestId.get(projectId)?.get(packageId);
  }

  async #ensureCoreState(): Promise<RuntimeManagerState> {
    if (this.#state) return this.#state;
    if (this.#initPromise) return this.#initPromise;

    this.#initPromise = (async () => {
      const core = await getRuntime();
      await core.whenReady();
      this.#state = {
        loader: core.getLoader(),
        registry: core.getRegistry(),
        runtime: core.getRuntime(),
      };
      return this.#state;
    })();

    try {
      return await this.#initPromise;
    } finally {
      this.#initPromise = null;
    }
  }

  async #activateRecord(state: RuntimeManagerState, record: ResolvedPackageRecord): Promise<void> {
    await state.loader.load(
      record.definition,
      record.packageRoot,
      record.manifestId,
      record.ownerProjectId,
    );
    this.#assertActive(state.loader.getStatus(record.packageId), record.packageId);
    await state.loader.start(record.packageId);
    // Feature-gate inheritance: merge package's defaultRoleGrants into project roles
    await this.#applyFeatureGrants(record);
  }

  /**
   * When a package is installed, merge its defaultRoleGrants into the project's
   * role configuration — ONCE per package version (C7a). The provenance marker
   * `project.appliedPackageGrants[packageId]` records the version already
   * merged; on a subsequent boot/activation with the same version this is a
   * no-op, so an admin's manual revoke of a granted feature is NOT silently
   * re-added every boot. Project-level overrides always win.
   *
   * Only a PROJECT-scope package grants — a `_packages/` drop or a project-scope
   * `recognizesPackages` source. A user- or agent-scoped source's package is
   * advertised to its owner alone; writing its grants onto the project's roles
   * would hand it to every member. Builtins grant at project creation and
   * through the operator's grant-change record (`reconcileBuiltinGrantChanges`).
   *
   * **A project-dropped package may never grant itself onto a project-admin-or-
   * stronger role.** The `'*'` skip alone used to cover owner AND admin, because
   * both shipped with the wildcard. D-C takes the wildcard off `admin`, which
   * would open exactly the escalation the skip existed to prevent: an untrusted
   * `_packages/` drop declaring `defaultRoleGrants: { admin: [...] }` writing
   * itself onto the strongest in-project role. The floor is therefore keyed on
   * resolved PRIORITY (name-free, D-A — it also covers a custom priority-1 or
   * priority-2 role), with the `'*'` skip kept as well.
   *
   * Consequence, stated: an admin does NOT automatically inherit features a
   * project-dropped package declares. An owner can still grant them by hand —
   * `GET /api/admin/feature-catalog` builds from the runtime registry, so a
   * `_packages/` package's `providesFeatures` remain listed and grantable.
   */
  async #applyFeatureGrants(record: ResolvedPackageRecord): Promise<void> {
    const grants = record.definition.requires?.defaultRoleGrants;
    if (!grants) return;
    if (BUILTIN_PACKAGE_IDS.has(record.packageId)) return;
    const projectId = record.ownerProjectId;
    if (!projectId || record.ownerScope?.kind !== 'project') return;
    const providedFeatures = new Set(providedFeatureIds(record.definition.requires?.providesFeatures));
    const version = record.definition.version ?? '0.0.0';

    try {
      // Cheap snapshot pre-check: the common case is "already applied at this
      // version", and answering it here avoids taking the record's write chain.
      // It is NOT the decision — `applyGrantsPatch` asks the same question again
      // on the record the chain hands it.
      const project = await getProjectById(projectId);
      if (!project) return;
      if (project.appliedPackageGrants?.[record.packageId] === version) return;

      await updateProject(projectId, (p) =>
        applyGrantsPatch(p, record.packageId, version, grants, providedFeatures, canReceivePackageGrant),
      );
    } catch {
      // Non-critical: log and continue
      console.warn(`[PackageRuntimeManager] Failed to apply feature grants for ${record.packageId}`);
    }
  }

  /**
   * On uninstall, revoke the package's provided features from every non-`'*'`
   * role — but only features no OTHER currently-loaded package still provides
   * (namespaced ids rarely collide, but this avoids stripping a shared feature).
   * Clears the provenance marker so a later reinstall re-applies grants.
   */
  async #revokeFeatureGrants(
    state: RuntimeManagerState,
    projectId: string,
    packageId: string,
    definition: PackageDefinition,
  ): Promise<void> {
    try {
      const provided = providedFeatureIds(definition.requires?.providesFeatures);
      if (provided.length === 0 && !(await getProjectById(projectId))?.appliedPackageGrants?.[packageId]) return;
      // Features still backed by another loaded package must not be revoked.
      const stillProvided = new Set<string>();
      for (const def of state.loader.listLoaded()) {
        if (def.id === packageId) continue;
        for (const f of providedFeatureIds(def.requires?.providesFeatures)) stillProvided.add(f);
      }
      const revoke = new Set(provided.filter((f) => !stillProvided.has(f)));

      await updateProject(projectId, (p) => revokeGrantsPatch(p, packageId, revoke));
    } catch {
      console.warn(`[PackageRuntimeManager] Failed to revoke feature grants for ${packageId}`);
    }
  }

  /** Preserve the raw identity when reloading a scope-namespaced package. */
  #manifestIdOf(packageId: string): string | undefined {
    const projectId = this.#ownerProjectOf(packageId);
    return projectId ? this.#packageManifestId.get(projectId)?.get(packageId) : undefined;
  }

  /**
   * Run `work` after every earlier sync/reload of `projectId` settles. A
   * rejected link still resolves the tail (its error reaches its own caller);
   * the map entry is deleted once the newest tail settles.
   */
  #serialize<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const run = (this.#syncChain.get(projectId) ?? Promise.resolve()).then(work);
    const tail = run.then(() => undefined, () => undefined);
    this.#syncChain.set(projectId, tail);
    void tail.then(() => {
      if (this.#syncChain.get(projectId) === tail) this.#syncChain.delete(projectId);
    });
    return run;
  }

  #assertActive(status: RuntimePackageStatus | undefined, packageId: string): void {
    if (!status) {
      throw new Error(`Package did not enter runtime: ${packageId}`);
    }
    if (status.status === 'error') {
      throw new Error(status.error ?? `Package failed to load: ${packageId}`);
    }
  }

  #requireState(): RuntimeManagerState {
    if (!this.#state) {
      throw new Error('Package runtime manager not initialized. Call ensureInitialized() first.');
    }
    return this.#state;
  }
}

const GLOBAL_KEY = '__neuralis_package_runtime_manager__' as const;

export function getPackageRuntimeManager(): PackageRuntimeManager {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new PackageRuntimeManager();
  }
  return g[GLOBAL_KEY] as PackageRuntimeManager;
}
