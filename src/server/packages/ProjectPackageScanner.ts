/**
 * Project-level package scanner.
 *
 * Monitors `{projectRoot}/_packages/` (and each source package folder) for
 * installed, authored, and agent-created packages.  Directory listing IS the
 * catalog — no separate `catalog.json` or app-zone storage. Every byte comes
 * through the scanner's ONE `PackageReader`: this disk, or a paired device's
 * folder over its link (nothing of it is copied here).
 */

import * as fss from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { resolvePackageDefinitionFromRoot } from '@neuralis/agent-core';
import { getFsWatchHub, localPackageReader, type FsWatchHandle } from '@neuralis/package-system/data';
import type { PackageDefinition, PackageReader, SourceScope } from '@neuralis/package-system/contracts';
import { isPackageDirListing } from './sourceDiscovery';
import { assertProjectPackageIdAllowed, sanitizeProjectPackageDefinition, type ProjectPackageRecord } from './packageRecords';

type Logger = {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  debug?: (msg: string, meta?: Record<string, unknown>) => void;
};

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

// Trees never watched for package changes, as globs relative to the watched
// packages folder — so a dotted ANCESTOR of that folder never prunes it — and
// compiled by the kernel hub's one exclude predicate: `.git`, `node_modules`,
// `.next` and any dot-named folder or file below the root. NB: `dist` is NOT
// excluded — a WASM package's build output (`dist/package.wasm` /
// `dist/routes.json`) is exactly what changes on rebuild, and the loader reads
// it, so the watcher must fire on it for WASM hot-reload to work.
const PACKAGE_WATCH_EXCLUDE_GLOBS: readonly string[] = [
  '**/.git', '**/.git/**', '**/node_modules', '**/node_modules/**', '**/.next', '**/.next/**', '**/.*', '**/.*/**',
];

export class ProjectPackageScanner {
  readonly #packagesDir: string;
  readonly #reader: PackageReader;
  readonly #cache = new Map<string, ProjectPackageRecord>();
  readonly #logger: Logger;

  #present: Set<string> | null = null;
  #complete = false;
  #missingWithReachableParent = false;
  /** A device folder that is unreachable: the last records stay, listed as not available. */
  #unavailable = false;

  get scanComplete(): boolean { return this.#complete; }
  get missingWithReachableParent(): boolean { return this.#missingWithReachableParent; }
  /** True while this scanner's device is unreachable (never for this disk). */
  get unavailable(): boolean { return this.#unavailable; }

  /** Only a successfully listed source root can prove a child absent. */
  isConfirmedDeleted(packageRoot: string): boolean {
    return this.#present !== null && !this.#present.has(packageRoot);
  }

  #watcher: FsWatchHandle | null = null;
  #stopDeviceWatch: (() => void) | null = null;
  #rescanTimer: NodeJS.Timeout | null = null;
  #rescanPending: Promise<number> | null = null;
  /** One change listener per project that scans this directory; a re-registration replaces. */
  readonly #listeners = new Map<string, () => void>();

  /**
   * @param packagesDir Absolute root scanned for packages. The default
   *   `_packages/` drop-zone passes `join(projectRoot, '_packages')`; a
   *   source's package folder (R2 C2) passes its resolved root (the
   *   source root joined with the folder) directly — on a device, its path
   *   there.
   * @param reader Where the bytes are (default: this disk).
   */
  constructor(packagesDir: string, logger: Logger, reader: PackageReader = localPackageReader) {
    this.#packagesDir = packagesDir;
    this.#logger = logger;
    this.#reader = reader;
  }

  get packagesDir(): string {
    return this.#packagesDir;
  }

  get reader(): PackageReader {
    return this.#reader;
  }

  // ---- Scan ---------------------------------------------------------------

  async scan(): Promise<number> {
    this.#present = null;
    this.#complete = false;
    this.#missingWithReachableParent = false;
    const reader = this.#reader;
    // An unreachable device proves nothing absent: its last records stay (listed
    // as not available), and no deletion can be confirmed from here.
    const unreachable = (): number => {
      this.#unavailable = true;
      return this.#cache.size;
    };
    if (reader.available?.() === false) return unreachable();
    let stat: Awaited<ReturnType<PackageReader['stat']>>;
    try {
      stat = await reader.stat(this.#packagesDir);
    } catch {
      if (reader.transport === 'device') return unreachable();
      stat = null;
    }

    if (!stat?.isDirectory) {
      if (stat === null) {
        try { this.#missingWithReachableParent = (await reader.stat(dirname(this.#packagesDir)))?.isDirectory === true; }
        catch { this.#missingWithReachableParent = false; }
      }
      this.#unavailable = false;
      this.#cache.clear();
      return 0;
    }

    let entries: string[];
    try {
      entries = (await reader.list(this.#packagesDir)).map((entry) => entry.name);
    } catch {
      if (reader.transport === 'device') return unreachable();
      this.#cache.clear();
      return 0;
    }

    const present = new Set([this.#packagesDir, ...entries.map((slug) => join(this.#packagesDir, slug))]);
    if (isPackageDirListing(entries)) entries.unshift('');
    const seen = new Set<string>();

    // Resolve all packages in parallel
    const results = await Promise.allSettled(
      entries.map(async (slug) => {
        const packageRoot = join(this.#packagesDir, slug);
        if (slug !== '') {
          if (!(await reader.stat(packageRoot))?.isDirectory) return null;
          if (!isPackageDirListing((await reader.list(packageRoot)).map((entry) => entry.name))) return null;
        }

        const record = await this.#resolvePackage(slug, packageRoot);
        return { slug, record };
      }),
    );

    // A link that dropped mid-scan leaves a partial answer — keep the last one.
    if (reader.available?.() === false) return unreachable();
    this.#unavailable = false;
    this.#present = present;
    this.#complete = results.every((result) => result.status === 'fulfilled');
    let count = 0;
    for (const result of results) {
      if (result.status !== 'fulfilled' || !result.value) continue;
      const { slug, record } = result.value;
      this.#cache.set(slug, record);
      seen.add(slug);
      count++;
    }

    // Log warnings for rejected results
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'rejected') {
        this.#logger.warn('Failed to resolve project package', {
          slug: entries[i],
          error: String(r.reason),
        });
      }
    }

    // Remove packages that no longer exist on disk
    for (const key of this.#cache.keys()) {
      if (!seen.has(key)) {
        this.#cache.delete(key);
      }
    }

    if (count > 0) {
      this.#logger.debug?.('Project package scan complete', {
        packagesDir: this.#packagesDir,
        count,
      });
    }

    return count;
  }

  // ---- Debounced rescan ---------------------------------------------------

  rescan(): Promise<number> {
    if (this.#rescanPending) return this.#rescanPending;

    this.#rescanPending = new Promise<number>((resolve) => {
      if (this.#rescanTimer) clearTimeout(this.#rescanTimer);
      this.#rescanTimer = setTimeout(() => {
        this.#rescanTimer = null;
        this.#rescanPending = null;
        resolve(this.scan());
      }, 500);
    });

    return this.#rescanPending;
  }

  // ---- Watch --------------------------------------------------------------

  /**
   * Register `projectId`'s change listener and hold ONE hub watcher for the
   * directory however many projects scan it (a shared dir notifies each).
   */
  startWatching(projectId: string, onChange: () => void, options: { createRoot?: boolean } = {}): void {
    this.#listeners.set(projectId, onChange);
    if (this.#watcher || this.#stopDeviceWatch) return;
    // ONE notification per rescan, however many changes or batches fell into
    // its debounce window: every listener re-syncs the project's packages (and
    // with them the prompt's package listing), so a burst must not multiply it.
    const notifyAll = (): void => {
      const pending = this.#rescanPending;
      const scanned = this.rescan();
      if (scanned === pending) return;
      scanned.then(() => {
        for (const notify of this.#listeners.values()) notify();
      }).catch((err) => {
        this.#logger.warn('Watch-triggered rescan failed', { error: String(err) });
      });
    };

    // A device folder: the device's own watch on the folder plus its link's
    // come-and-go — each re-reads the folder (or marks it unreachable).
    if (this.#reader.watch) {
      try {
        this.#stopDeviceWatch = this.#reader.watch(notifyAll);
      } catch (err) {
        this.#logger.warn('Failed to start device package watcher', { error: String(err) });
      }
      return;
    }

    // Only the host-owned drop zone may be created. A missing source mount
    // must remain unknown rather than becoming an empty, reachable directory.
    try {
      if (options.createRoot && !fss.existsSync(this.#packagesDir)) {
        fss.mkdirSync(this.#packagesDir, { recursive: true });
      }
    } catch (err) {
      this.#logger.warn('Package dir unavailable — skipping watcher (source contributes no packages)', {
        error: String(err), packagesDir: this.#packagesDir,
      });
      return;
    }

    try {
      // The ONE shared watch substrate (D6). Every batch — whatever its event
      // kinds, `overflow` included — maps to the SAME debounced full rescan:
      // `overflow` already means "reconcile everything", which is what rescan() does.
      this.#watcher = getFsWatchHub().acquire(
        this.#packagesDir,
        () => notifyAll(),
        { excludeGlobs: PACKAGE_WATCH_EXCLUDE_GLOBS },
      );
    } catch (err) {
      this.#logger.warn('Failed to start package watcher', { error: String(err), packagesDir: this.#packagesDir });
    }
  }

  /**
   * Drop `projectId`'s listener. The last one out releases the watcher AND
   * the scanner itself: nobody scans this folder any more, so the registry
   * forgets it, and the next source on it starts from a fresh scanner.
   */
  async removeListener(projectId: string): Promise<void> {
    this.#listeners.delete(projectId);
    if (this.#listeners.size > 0) return;
    await this.stopWatching();
    releaseScanner(this);
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  async stopWatching(): Promise<void> {
    if (this.#watcher) {
      await this.#watcher.release();
      this.#watcher = null;
    }
    this.#stopDeviceWatch?.();
    this.#stopDeviceWatch = null;
    if (this.#rescanTimer) {
      clearTimeout(this.#rescanTimer);
      this.#rescanTimer = null;
    }
    this.#listeners.clear();
  }

  // ---- Accessors ----------------------------------------------------------

  /**
   * Drop the in-memory record cache without touching the watcher. Used by the
   * "Clear cache" maintenance op so the next `scan()`/`rescan()` re-reads disk
   * from scratch. `scan()`/`rescan()` already clear `#cache` implicitly; this is
   * the standalone, no-rescan clear.
   */
  clearCache(): void {
    this.#cache.clear();
  }

  listPackages(): ProjectPackageRecord[] {
    const records = [...this.#cache.values()];
    return this.#unavailable ? records.map((record) => ({ ...record, unavailable: 'device-offline' as const })) : records;
  }

  getPackage(slug: string): ProjectPackageRecord | null {
    return this.#cache.get(slug) ?? null;
  }

  getPackageById(packageId: string): ProjectPackageRecord | null {
    for (const record of this.#cache.values()) {
      if (record.packageId === packageId) return record;
    }
    return null;
  }

  // ---- Internal -----------------------------------------------------------

  async #resolvePackage(slug: string, packageRoot: string): Promise<ProjectPackageRecord> {
    // The folder that IS the package (slug '') has no child name to lend: a
    // manifest-less one (a `.claude` tree) is named after its own folder.
    const manifestId = await this.#readManifestId(packageRoot) ?? (slug || folderPackageId(packageRoot));

    // DIST1 — `access.trust` is pinned on the SEED, not left for the on-disk
    // manifest to supply. `mergeManifestFromDisk` fills only fields the caller
    // left undefined, so without this pin a project manifest self-declaring
    // `"access": {"trust": "native"}` would reach discovery's trust check
    // and skip the non-native frontmatter sanitize (the rule→docs
    // downgrade) — even though the record is re-forced to untrusted below.
    // Trust is host-assigned; a scanned directory never speaks for itself.
    const seed: PackageDefinition = {
      id: manifestId,
      name: manifestId,
      source: { kind: 'local-dir' },
      access: { trust: 'untrusted' },
    };

    // DIST1 — metadata-only: project packages are never native, so their
    // dist/src/** route/tool/lifecycle modules are LISTED, never imported.
    // Importing them would run their top-level code in the host process at scan
    // and on every watcher-driven rescan, ahead of any trust gate.
    const resolved = await resolvePackageDefinitionFromRoot(packageRoot, seed, this.#logger, 'metadata-only', this.#reader);

    const packageId = resolved.definition.id || manifestId;
    assertProjectPackageIdAllowed(packageId);

    // Project packages always default to untrusted — trust set via ProjectRecord.packageTrust override
    const trust = 'untrusted' as const;
    const definition = sanitizeProjectPackageDefinition(
      {
        ...resolved.definition,
        id: packageId,
      },
      trust,
    );

    const artifactStamp = definition.runtime?.type === 'wasm'
      ? await wasmArtifactStamp(this.#reader, packageRoot, definition.runtime.entry?.module)
      : undefined;

    return {
      slug,
      packageId,
      definition,
      packageRoot,
      discoveredAt: Date.now(),
      trust,
      ...(artifactStamp !== undefined ? { artifactStamp } : {}),
      ...(this.#reader.transport === 'device' ? { reader: this.#reader } : {}),
    };
  }

  async #readManifestId(packageRoot: string): Promise<string | undefined> {
    // Try package.json#neuralis.id
    try {
      const pkgJson = join(packageRoot, 'package.json');
      const raw = await this.#reader.readText(pkgJson);
      const parsed = JSON.parse(raw) as {
        neuralis?: { id?: string };
        name?: string;
      };
      if (parsed.neuralis?.id) return parsed.neuralis.id;
      if (parsed.name) return parsed.name;
    } catch { /* ignore */ }

    // Try neuralis.package.json
    try {
      const manifestPath = join(packageRoot, 'neuralis.package.json');
      const raw = await this.#reader.readText(manifestPath);
      const parsed = JSON.parse(raw) as { id?: string };
      if (parsed.id) return parsed.id;
    } catch { /* ignore */ }

    return undefined;
  }
}

/**
 * A manifest-less root package's id: its folder's last segment (either
 * separator — a device path may be a Windows one) in the manifest id alphabet,
 * so `.claude` is `claude`. Empty when nothing usable is left; the manifest
 * validator then names the reason.
 */
function folderPackageId(packageRoot: string): string {
  const leaf = packageRoot.split(/[\\/]/).filter(Boolean).pop() ?? '';
  return leaf.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

/**
 * The build output a WASM package's module is loaded from — the entry the
 * loader reads (`runtime.entry.module`, else `dist/package.wasm`) and the
 * `dist/routes.json` route gate — as `modifiedAt:size` each, `-` when absent.
 * Two `stat`s per WASM package per scan (over the link for a device); a scan
 * runs on a watch event, a rescan or an activation, never per request.
 */
async function wasmArtifactStamp(reader: PackageReader, packageRoot: string, entryModule: string | undefined): Promise<string> {
  const stampOf = async (file: string): Promise<string> => {
    try {
      const s = await reader.stat(file);
      return s ? `${s.modifiedAt ?? ''}:${s.size ?? ''}` : '-';
    } catch {
      return '-';
    }
  };
  const [wasm, routes] = await Promise.all([
    stampOf(entryModule ? resolve(packageRoot, entryModule) : join(packageRoot, 'dist', 'package.wasm')),
    stampOf(join(packageRoot, 'dist', 'routes.json')),
  ]);
  return `${wasm}|${routes}`;
}

// ---------------------------------------------------------------------------
// Singleton registry (one scanner per resolved package dir — A2/MINOR-4)
// ---------------------------------------------------------------------------

const GLOBAL_KEY = '__neuralis_project_package_scanners__' as const;

function getScannerMap(): Map<string, ProjectPackageScanner> {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = new Map<string, ProjectPackageScanner>();
  }
  return g[GLOBAL_KEY] as Map<string, ProjectPackageScanner>;
}

/** The source instance a device-folder scanner serves. */
export type ScannerInstance = { projectId: string; scope: SourceScope; uriRoot: string };

/**
 * Scanner for an arbitrary package directory, keyed by the resolved dir
 * (R2 A2/MINOR-4). Keying by the package dir — not the project root — lets a
 * project hold multiple scanners (default `_packages/` + each
 * source package folder) without one overwriting another. A local folder is
 * shared by every project that scans it (its records' URIs are stamped per
 * entry). A device folder is not: its reader bakes its SOURCE into every URI,
 * so its key carries the reader's identity (a path on a device is not that
 * path on this disk) AND the instance — project, scope, URI root — the
 * records belong to.
 */
export function getScannerForDir(packagesDir: string, logger?: Logger, reader?: PackageReader, instance?: ScannerInstance): ProjectPackageScanner {
  const map = getScannerMap();
  const key = reader && reader.transport !== 'local'
    ? [reader.id, instance?.projectId ?? '', JSON.stringify(instance?.scope ?? null), instance?.uriRoot ?? '', packagesDir].join('\0')
    : packagesDir;
  const existing = map.get(key);
  if (existing) return existing;

  const fallbackLogger: Logger = logger ?? {
    info: () => {},
    warn: () => {},
  };
  const scanner = new ProjectPackageScanner(packagesDir, fallbackLogger, reader);
  map.set(key, scanner);
  return scanner;
}

/** Forget a scanner nobody listens to (`removeListener`'s last-one-out). */
function releaseScanner(scanner: ProjectPackageScanner): void {
  const map = getScannerMap();
  for (const [key, held] of map) if (held === scanner) map.delete(key);
}

/** Scanner for a project's default `_packages/` drop-zone. */
export function getProjectPackageScanner(projectRoot: string, logger?: Logger): ProjectPackageScanner {
  return getScannerForDir(join(projectRoot, '_packages'), logger);
}
