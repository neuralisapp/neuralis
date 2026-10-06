/**
 * Project-level package scanner.
 *
 * Monitors `{projectRoot}/_packages/` for installed, authored, and
 * agent-created packages.  Directory listing IS the catalog — no
 * separate `catalog.json` or app-zone storage.
 */

import * as fss from 'node:fs';
import * as fs from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { resolvePackageDefinitionFromRoot } from '@neuralis/agent-core';
import { getFsWatchHub, type FsWatchHandle } from '@neuralis/package-system/data';
import type { PackageDefinition } from '@neuralis/package-system/contracts';
import { hasPackageManifest } from './sourceDiscovery';
import { assertProjectPackageIdAllowed, sanitizeProjectPackageDefinition, type ProjectPackageRecord } from './packageRecords';

type Logger = {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  debug?: (msg: string, meta?: Record<string, unknown>) => void;
};

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

// Path segments never watched for package changes (R2 A1). NB: `dist` is NOT
// ignored — a WASM package's build output (`dist/package.wasm` / `dist/routes.json`)
// is exactly what changes on rebuild, and the loader reads it, so the watcher
// must fire on it for WASM hot-reload to work.
const IGNORED_SEGMENTS = new Set(['.git', 'node_modules', '.next']);

export class ProjectPackageScanner {
  readonly #packagesDir: string;
  readonly #cache = new Map<string, ProjectPackageRecord>();
  readonly #logger: Logger;

  #watcher: FsWatchHandle | null = null;
  #rescanTimer: NodeJS.Timeout | null = null;
  #rescanPending: Promise<number> | null = null;
  #onChangeCallback: (() => void) | null = null;

  /**
   * @param packagesDir Absolute root scanned for packages. The default
   *   `_packages/` drop-zone passes `join(projectRoot, '_packages')`; a
   *   `recognizesPackages`-flagged source (R2 C2) passes its resolved
   *   container root directly.
   */
  constructor(packagesDir: string, logger: Logger) {
    this.#packagesDir = packagesDir;
    this.#logger = logger;
  }

  get packagesDir(): string {
    return this.#packagesDir;
  }

  // ---- Scan ---------------------------------------------------------------

  async scan(): Promise<number> {
    let dirExists: boolean;
    try {
      const stat = await fs.stat(this.#packagesDir);
      dirExists = stat.isDirectory();
    } catch {
      dirExists = false;
    }

    if (!dirExists) {
      this.#cache.clear();
      return 0;
    }

    let entries: string[];
    try {
      entries = await fs.readdir(this.#packagesDir);
    } catch {
      this.#cache.clear();
      return 0;
    }

    const seen = new Set<string>();

    // Resolve all packages in parallel
    const results = await Promise.allSettled(
      entries.map(async (slug) => {
        const packageRoot = join(this.#packagesDir, slug);

        let isDir: boolean;
        try {
          isDir = (await fs.stat(packageRoot)).isDirectory();
        } catch {
          isDir = false;
        }
        if (!isDir) return null;
        if (!hasPackageManifest(packageRoot)) return null;

        const record = await this.#resolvePackage(slug, packageRoot);
        return { slug, record };
      }),
    );

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

  startWatching(onChange?: () => void): void {
    if (this.#watcher) return;
    this.#onChangeCallback = onChange ?? null;

    // Best-effort: a stale `recognizesPackages` source whose mount went away
    // (dir absent AND its parent unwritable, e.g. `/mounts/x` after a `-V`
    // rebuild dropped the override mounts) must NOT take down every
    // package-snapshot route. The uncaught `mkdirSync` previously threw EACCES
    // up through activation, 500-ing /api/packages/{runtime,widgets,dock,commands}
    // + the agent-core overview. Degrade: log + skip this source's watcher;
    // `scan()` already tolerates a missing dir (stat → return 0).
    try {
      if (!fss.existsSync(this.#packagesDir)) {
        fss.mkdirSync(this.#packagesDir, { recursive: true });
      }
    } catch (err) {
      this.#logger.warn('Package dir unavailable — skipping watcher (source contributes no packages)', {
        error: String(err), packagesDir: this.#packagesDir,
      });
      return;
    }

    try {
      // R2 A1 — the ONE shared chokidar substrate (D6). Node `fs.watch`'s
      // `recursive` option is unsupported on Linux, so the previous watcher
      // silently never fired on the deploy platform; the hub is Linux-reliable.
      // Every event kind (created/modified/deleted/overflow) maps to the SAME
      // debounced full rescan — `overflow` already means "reconcile everything",
      // which is exactly what rescan() does.
      this.#watcher = getFsWatchHub().acquire(
        this.#packagesDir,
        () => {
          this.rescan().then(() => {
            this.#onChangeCallback?.();
          }).catch((err) => {
            this.#logger.warn('Watch-triggered rescan failed', { error: String(err) });
          });
        },
        { ignored: (absPath) => this.#isIgnored(absPath) },
      );
    } catch (err) {
      this.#logger.warn('Failed to start package watcher', { error: String(err), packagesDir: this.#packagesDir });
    }
  }

  /**
   * Watcher ignore predicate over absolute paths — excludes noise trees so
   * they never consume OS watch descriptors. Only inspects segments BELOW the
   * watched root (a dotted ancestor of the root must not prune everything).
   */
  #isIgnored(absPath: string): boolean {
    const rel = relative(this.#packagesDir, absPath);
    if (!rel || rel.startsWith('..')) return false;
    return rel.split(sep).some(
      (segment) => IGNORED_SEGMENTS.has(segment) || (segment.startsWith('.') && segment.length > 1),
    );
  }

  async stopWatching(): Promise<void> {
    if (this.#watcher) {
      await this.#watcher.release();
      this.#watcher = null;
    }
    if (this.#rescanTimer) {
      clearTimeout(this.#rescanTimer);
      this.#rescanTimer = null;
    }
    this.#onChangeCallback = null;
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
    return [...this.#cache.values()];
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
    const manifestId = await this.#readManifestId(packageRoot) ?? slug;

    // DIST1 — `access.trust` is pinned on the SEED, not left for the on-disk
    // manifest to supply. `mergeManifestFromDisk` fills only fields the caller
    // left undefined, so without this pin a project manifest self-declaring
    // `"access": {"trust": "first-party"}` would reach discovery's trust check
    // and skip the non-first-party frontmatter sanitize (the rule→docs
    // downgrade) — even though the record is re-forced to untrusted below.
    // Trust is host-assigned; a scanned directory never speaks for itself.
    const seed: PackageDefinition = {
      id: manifestId,
      name: manifestId,
      source: { kind: 'local-dir' },
      access: { trust: 'untrusted' },
    };

    // DIST1 — metadata-only: project packages are never first-party, so their
    // dist/src/** route/tool/lifecycle modules are LISTED, never imported.
    // Importing them would run their top-level code in the host process at scan
    // and on every watcher-driven rescan, ahead of any trust gate.
    const resolved = await resolvePackageDefinitionFromRoot(packageRoot, seed, this.#logger, 'metadata-only');

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
      ? await wasmArtifactStamp(packageRoot, definition.runtime.entry?.module)
      : undefined;

    return {
      slug,
      packageId,
      definition,
      packageRoot,
      discoveredAt: Date.now(),
      trust,
      ...(artifactStamp !== undefined ? { artifactStamp } : {}),
    };
  }

  async #readManifestId(packageRoot: string): Promise<string | undefined> {
    // Try package.json#neuralis.id
    try {
      const pkgJson = join(packageRoot, 'package.json');
      const raw = await fs.readFile(pkgJson, 'utf-8');
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
      const raw = await fs.readFile(manifestPath, 'utf-8');
      const parsed = JSON.parse(raw) as { id?: string };
      if (parsed.id) return parsed.id;
    } catch { /* ignore */ }

    return undefined;
  }
}

/**
 * The build output a WASM package's module is loaded from — the entry the
 * loader reads (`runtime.entry.module`, else `dist/package.wasm`) and the
 * `dist/routes.json` route gate — as `mtimeMs:size` each, `-` when absent. Two
 * `stat`s per WASM package per scan; a scan runs on a watch event, a rescan or
 * an activation, never per request.
 */
async function wasmArtifactStamp(packageRoot: string, entryModule: string | undefined): Promise<string> {
  const stampOf = async (file: string): Promise<string> => {
    try {
      const s = await fs.stat(file);
      return `${s.mtimeMs}:${s.size}`;
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

/**
 * Scanner for an arbitrary package directory, keyed by the resolved dir
 * (R2 A2/MINOR-4). Keying by the package dir — not the project root — lets a
 * project hold multiple scanners (default `_packages/` + each
 * `recognizesPackages`-flagged source) without one overwriting another.
 */
export function getScannerForDir(packagesDir: string, logger?: Logger): ProjectPackageScanner {
  const map = getScannerMap();
  const existing = map.get(packagesDir);
  if (existing) return existing;

  const fallbackLogger: Logger = logger ?? {
    info: () => {},
    warn: () => {},
  };
  const scanner = new ProjectPackageScanner(packagesDir, fallbackLogger);
  map.set(packagesDir, scanner);
  return scanner;
}

/** Scanner for a project's default `_packages/` drop-zone. */
export function getProjectPackageScanner(projectRoot: string, logger?: Logger): ProjectPackageScanner {
  return getScannerForDir(join(projectRoot, '_packages'), logger);
}
