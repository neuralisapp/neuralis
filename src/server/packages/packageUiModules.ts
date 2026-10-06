/**
 * packageUiModules — the server half of the first-party UI MODULE lane.
 *
 * A host-assigned first-party package may ship ONE prebuilt browser module
 * (`package.json#neuralis.app.module`, built by `neuralis-build ui` into
 * `dist/app/`). The workspace `import()`s it on the MAIN origin — that is what
 * first-party means — so the lane is NOT one of the two sandboxed package-app
 * lanes (those keep their opaque origin, `no-store` and 2 MiB cap unchanged).
 *
 * What the server owns here, built ONCE per first-party package set (never per
 * request):
 * - the MODULE TABLE: content hash of a package's `dist/app/` tree → that tree.
 *   The URL the client imports is derived HERE from the hash and the manifest;
 *   a caller never names a package, a root or a path prefix.
 * - the version pins, FAIL-CLOSED, both read from the bundle's own build
 *   record: the kernel's `UI_MODULE_HOST_API_VERSION` and the React major the
 *   bundle was built against, which must equal the host's. A module that cannot
 *   prove both is refused (listed in `refused`, never served).
 * - the ONE union stylesheet (Tailwind, compiled by the kernel's `ui-sheet`
 *   over explicit sources with no auto-detection), served under its own hash.
 *
 * The state is anchored on `globalThis`: the snapshot route and the module
 * route are separate Next route graphs, and a module-level cache would compile
 * the sheet once PER GRAPH.
 *
 * Named residual (invariant 10 precision): any signed-in member can GET any
 * first-party module by its hash. The six platform modules are public code;
 * a private package's hash is not guessable (sha256 over its built tree).
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import type {
  PackageDefinition,
  PackageUiAttachments,
  UiModuleDescriptor,
  UiModuleRefusal,
  UiSheetDescriptor,
} from '@neuralis/package-system/contracts';
import {
  UI_MODULE_HOST_API_VERSION,
  UI_MODULE_RECORD_FILE,
  checkUiModuleBuildRecord,
} from '@neuralis/package-system/client/shared-modules';
import {
  compileUnionSheetOffThread,
  kernelClientSheetSources,
  UnionSheetError,
  type UnionSheet,
  type OffThreadUnionSheet,
  type UnionSheetSource,
} from '@neuralis/package-system/runtime/ui-sheet';
import { BUILTIN_PACKAGE_IDS, HOST_ROOT, resolveBuiltinRoot } from '../host/builtinSlots';
import { getLogger } from '../logging/setup';
import { getCommunityPackageRegistry } from './runtime';

/** The lane's URL prefix: `/api/package-ui/{hash}/{path}`. */
export const PACKAGE_UI_ROUTE_PREFIX = '/api/package-ui';

/** Package-relative directory a UI module is built into and served from. */
export const PACKAGE_UI_MODULE_DIR = 'dist/app';

/**
 * Per-file cap of the module lane — first-party CODE, so its own constant; the
 * untrusted-asset 2 MiB cap (`PACKAGE_APP_ASSET_MAX_BYTES`) is a different
 * floor and stays unchanged. Checked on the open descriptor before any read.
 */
export const PACKAGE_UI_MODULE_MAX_BYTES = 8 * 1024 * 1024;

/** Served types. `.map` is deliberately absent: source maps are never served. */
export const PACKAGE_UI_MODULE_MIME_BY_EXT: Readonly<Record<string, string>> = Object.freeze({
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
});

/** The union sheet's file name under its hash. */
export const UI_SHEET_FILE = 'workspace.css';

type TableEntry =
  | { readonly kind: 'module'; readonly packageId: string; readonly dir: string }
  | { readonly kind: 'sheet'; readonly css: Buffer };

export type UiAttachments = {
  readonly modules: readonly UiModuleDescriptor[];
  readonly sheet: UiSheetDescriptor | null;
  readonly refused: readonly UiModuleRefusal[];
  /** hash → what it serves. */
  readonly table: ReadonlyMap<string, TableEntry>;
  readonly buildMs: number;
  readonly timings?: UnionSheet['timings'] & {
    readonly moduleMs: number; readonly engineResolveMs: number;
    readonly worker?: OffThreadUnionSheet['worker'];
  };
  /** Why the union sheet is absent although an engine loaded. */
  readonly sheetError?: string;
};

export type UiAttachmentDeps = {
  /** First-party builtin definitions (host-assigned trust), in any order. */
  readonly definitions: readonly PackageDefinition[];
  readonly resolveRoot: (packageId: string) => string;
  readonly hostReactMajor: number;
  /** Production compiles off-thread; tests may inject the same direct compiler oracle. */
  readonly compileSheet: (sources: readonly UnionSheetSource[]) => Promise<(UnionSheet & {
    readonly worker?: OffThreadUnionSheet['worker']; readonly engineResolveMs?: number;
  }) | null>;
  /** The host's own class-bearing sources. */
  readonly hostSources: readonly UnionSheetSource[];
};

/** Whether `definition` may use the module lane: host-assigned first-party AND a deps builtin. */
export function isFirstPartyBuiltin(definition: PackageDefinition | undefined): definition is PackageDefinition {
  return Boolean(definition && definition.access?.trust === 'first-party' && BUILTIN_PACKAGE_IDS.has(definition.id));
}

async function listServedFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    const items = await readdir(current, { withFileTypes: true });
    for (const item of items) {
      const abs = join(current, item.name);
      if (item.isDirectory()) await walk(abs);
      else if (item.isFile() && PACKAGE_UI_MODULE_MIME_BY_EXT[extname(item.name).toLowerCase()]) {
        out.push(relative(dir, abs).split(sep).join('/'));
      }
    }
  };
  await walk(dir);
  return out.sort();
}

/** sha256 over the served tree AND the shared-import record (both change what the client runs). */
async function hashModuleTree(dir: string, files: readonly string[], record: Buffer): Promise<string> {
  const hash = createHash('sha256');
  hash.update(`record\0${record.length}\0`);
  hash.update(record);
  for (const rel of files) {
    const bytes = await readFile(join(dir, rel));
    hash.update(`\0file\0${rel}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

/** `dist/app/<rel>` → `<rel>`, or `null` for anything outside the module dir. */
function moduleRelative(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  const prefix = `${PACKAGE_UI_MODULE_DIR}/`;
  if (!path.startsWith(prefix)) return null;
  const rel = path.slice(prefix.length);
  if (rel === '' || rel.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
  return rel;
}

type ModuleBuild = { descriptor: UiModuleDescriptor; dir: string } | { refused: string };

async function buildModule(
  definition: PackageDefinition,
  deps: UiAttachmentDeps,
): Promise<ModuleBuild> {
  const decl = definition.app?.module;
  if (!decl) return { refused: 'no-module' };
  const entryRel = moduleRelative(decl.entry);
  if (!entryRel || !PACKAGE_UI_MODULE_MIME_BY_EXT[extname(entryRel)]) return { refused: 'entry-outside-module-dir' };
  const cssRel = decl.css === undefined ? undefined : moduleRelative(decl.css);
  if (cssRel === null || (cssRel !== undefined && extname(cssRel) !== '.css')) return { refused: 'css-outside-module-dir' };

  const root = deps.resolveRoot(definition.id);
  const dir = join(root, PACKAGE_UI_MODULE_DIR);
  let record: Buffer;
  try {
    record = await readFile(join(dir, UI_MODULE_RECORD_FILE));
  } catch (err) {
    return { refused: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'not-built' : 'shared-imports-unreadable' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(record.toString('utf8'));
  } catch {
    return { refused: 'shared-imports-unreadable' };
  }
  const verdict = checkUiModuleBuildRecord(raw, deps.hostReactMajor);
  if ('reason' in verdict) return { refused: verdict.reason };
  const { record: parsed, reactMajor } = verdict;
  const provides = decl.provides ?? [];

  const files = await listServedFiles(dir);
  if (!files.includes(entryRel)) return { refused: 'entry-missing' };
  if (cssRel !== undefined && !files.includes(cssRel)) return { refused: 'css-missing' };

  const hash = await hashModuleTree(dir, files, record);
  const base = `${PACKAGE_UI_ROUTE_PREFIX}/${hash}`;
  return {
    dir,
    descriptor: {
      packageId: definition.id,
      hash,
      entryUrl: `${base}/${entryRel}`,
      ...(cssRel !== undefined ? { cssUrl: `${base}/${cssRel}` } : {}),
      sharedImports: [...parsed.imports].sort(),
      ...(provides.length > 0 ? { provides: [...provides] } : {}),
      hostApiVersion: UI_MODULE_HOST_API_VERSION,
      reactMajor,
    },
  };
}

const TEST_FILES: readonly string[] = ['**/__tests__/**', '**/*.test.ts', '**/*.test.tsx'];

/**
 * The union sheet's sources for one first-party package: its `app/` source
 * tree when it ships one, else its built module tree. Tests never count.
 */
export function packageSheetSources(root: string, hasModule: boolean): UnionSheetSource[] {
  const app = join(root, 'app');
  if (existsSync(app)) {
    return [
      { base: app, pattern: '**/*.{ts,tsx}' },
      ...TEST_FILES.map((pattern) => ({ base: app, pattern, negated: true })),
    ];
  }
  const built = join(root, PACKAGE_UI_MODULE_DIR);
  return hasModule && existsSync(built) ? [{ base: built, pattern: '**/*.{js,mjs}' }] : [];
}

/**
 * The host's own class-bearing sources. The union must include the host's
 * classes, or a package's bare `.p-2` loaded in the later sheet beats the
 * host's own `md:p-4` — the separate-sheet bug.
 *
 * In the image shape (the server runs from `_runtime/`) the BUILT client chunks
 * are the source, and `src/` is ignored: the image's `/neuralis/src` is the
 * standalone tracer's server-reachable SUBSET, so scanning it would silently
 * drop host utilities. A dev tree scans its full `src/`.
 */
export function hostSheetSources(hostRoot: string, serverCwd: string): UnionSheetSource[] {
  const chunks = join(serverCwd, '.next', 'static', 'chunks');
  if (basename(serverCwd) === '_runtime') {
    return existsSync(chunks) ? [{ base: chunks, pattern: '**/*.js' }] : [];
  }
  const src = join(hostRoot, 'src');
  if (existsSync(src)) {
    return [
      { base: src, pattern: '**/*.{ts,tsx}' },
      ...TEST_FILES.map((pattern) => ({ base: src, pattern, negated: true })),
    ];
  }
  return existsSync(chunks) ? [{ base: chunks, pattern: '**/*.js' }] : [];
}

/** Build the table, the descriptors and the sheet for ONE first-party package set. */
export async function buildUiAttachments(deps: UiAttachmentDeps): Promise<UiAttachments> {
  const started = performance.now();
  const table = new Map<string, TableEntry>();
  const modules: UiModuleDescriptor[] = [];
  const refused: UiModuleRefusal[] = [];
  const sheetSources: UnionSheetSource[] = [...deps.hostSources, ...kernelClientSheetSources()];

  const definitions = [...deps.definitions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const definition of definitions) {
    let root: string;
    try {
      root = deps.resolveRoot(definition.id);
    } catch {
      if (definition.app?.module) refused.push({ packageId: definition.id, reason: 'root-unresolvable' });
      continue;
    }
    sheetSources.push(...packageSheetSources(root, Boolean(definition.app?.module)));
    if (!definition.app?.module) continue;
    try {
      const built = await buildModule(definition, deps);
      if ('refused' in built) {
        refused.push({ packageId: definition.id, reason: built.refused });
        continue;
      }
      table.set(built.descriptor.hash, { kind: 'module', packageId: definition.id, dir: built.dir });
      modules.push(built.descriptor);
    } catch {
      refused.push({ packageId: definition.id, reason: 'unreadable' });
    }
  }

  // A sheet failure never costs the modules: they attach, styled by the build
  // sheet alone, and the failure is named.
  let sheet: UiSheetDescriptor | null = null;
  let sheetError: string | undefined;
  let timings: UiAttachments['timings'];
  const moduleMs = performance.now() - started;
  try {
    const compiled = await deps.compileSheet(sheetSources);
    if (compiled) {
      const css = Buffer.from(compiled.css, 'utf8');
      table.set(compiled.hash, { kind: 'sheet', css });
      sheet = { hash: compiled.hash, url: `${PACKAGE_UI_ROUTE_PREFIX}/${compiled.hash}/${UI_SHEET_FILE}`, bytes: css.length };
      timings = { ...compiled.timings, moduleMs, engineResolveMs: compiled.engineResolveMs ?? 0,
        ...(compiled.worker ? { worker: compiled.worker } : {}) };
    }
  } catch (error: unknown) {
    sheetError = error instanceof UnionSheetError ? `UnionSheetError:${error.code}`
      : error instanceof Error && /^[A-Z][A-Za-z_]{0,63}$/.test(error.message) ? error.message : 'UnionSheetCompileFailed';
  }

  return {
    modules,
    sheet,
    refused,
    table,
    buildMs: performance.now() - started,
    ...(timings ? { timings } : {}),
    ...(sheetError !== undefined ? { sheetError } : {}),
  };
}

// ---------------------------------------------------------------------------
// The live accessor — one build per first-party definition set
// ---------------------------------------------------------------------------

function hostRequire(): NodeJS.Require {
  return createRequire(join(HOST_ROOT, 'package.json'));
}

/**
 * Resolve the host-owned engine entries without loading native compile/scan
 * code on the main thread. The emitted kernel worker loads them once.
 */
async function compileHostSheet(sources: readonly UnionSheetSource[]): Promise<OffThreadUnionSheet & { engineResolveMs: number }> {
  const ids = ['tailwindcss', '@tailwindcss/oxide'] as const;
  const started = performance.now();
  let engine: Parameters<typeof compileUnionSheetOffThread>[0]['engine'];
  try {
    const req = hostRequire();
    engine = {
      tailwindEntry: req.resolve(ids[0]), oxideEntry: req.resolve(ids[1]),
      stylesheetRoot: dirname(req.resolve(`${ids[0]}/package.json`)),
    };
  } catch {
    throw new Error('UnionSheetEngineUnavailable');
  }
  const engineResolveMs = performance.now() - started;
  return { ...await compileUnionSheetOffThread({ sources, engine }), engineResolveMs };
}

function readHostReactMajor(): number {
  const id = 'react/package.json';
  const version = (hostRequire()(id) as { version?: unknown }).version;
  const major = typeof version === 'string' ? Number.parseInt(version, 10) : Number.NaN;
  if (!Number.isInteger(major)) throw new Error('package-ui: cannot read the host React version');
  return major;
}

type Cached = { key: readonly PackageDefinition[]; promise: Promise<UiAttachments>; built?: UiAttachments };

const CACHE_KEY = Symbol.for('neuralis.packageUi.attachments');

function cacheSlot(): { current?: Cached } {
  const g = globalThis as unknown as Record<symbol, { current?: Cached } | undefined>;
  let slot = g[CACHE_KEY];
  if (!slot) {
    slot = {};
    g[CACHE_KEY] = slot;
  }
  return slot;
}

function sameDefinitions(a: readonly PackageDefinition[], b: readonly PackageDefinition[]): boolean {
  return a.length === b.length && a.every((def, i) => def === b[i]);
}

/**
 * The attachments for the CURRENT first-party set. Rebuilt only when a
 * first-party definition object changes (load / reload / uninstall) — a
 * project package loading, which moves the runtime revision, rebuilds nothing.
 * Concurrent callers share one build.
 */
export async function getUiAttachments(): Promise<UiAttachments> {
  const definitions = getCommunityPackageRegistry()
    .listPackages()
    .filter(isFirstPartyBuiltin)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const slot = cacheSlot();
  if (slot.current && sameDefinitions(slot.current.key, definitions)) return slot.current.promise;

  const promise = buildUiAttachments({
    definitions,
    resolveRoot: resolveBuiltinRoot,
    hostReactMajor: readHostReactMajor(),
    compileSheet: compileHostSheet,
    hostSources: hostSheetSources(HOST_ROOT, process.cwd()),
  }).then((built) => {
    const log = getLogger().child('package-ui');
    log.info(
      `UI attachments built in ${Math.round(built.buildMs)} ms: ${built.modules.length} module(s), ` +
        `sheet ${built.sheet ? `${built.sheet.bytes} B` : 'none'}`,
      built.timings ? { ...built.timings, totalMs: built.buildMs } : undefined,
    );
    for (const r of built.refused) log.warn(`UI module of '${r.packageId}' refused: ${r.reason}`);
    if (built.sheetError) log.warn(`Union stylesheet not compiled: ${built.sheetError}`);
    if (slot.current?.promise === promise) slot.current.built = built;
    return built;
  });
  slot.current = { key: definitions, promise };
  // A failed build must not pin the failure: the next caller retries.
  promise.catch(() => {
    if (slot.current?.promise === promise) slot.current = undefined;
  });
  return promise;
}

/**
 * The refusals of the LAST completed build — a read of the cached table, never
 * a build (the admin health poll calls it). `null` until the first build.
 */
export function peekUiModuleRefusals(): readonly UiModuleRefusal[] | null {
  return cacheSlot().current?.built?.refused ?? null;
}

/**
 * The client view, narrowed to the packages the caller's snapshot shows: their
 * modules, the union sheet, and the refusals — so a refused package's surface
 * names its reason in place instead of a bare placeholder.
 */
export function viewUiAttachments(attachments: UiAttachments, visiblePackageIds: ReadonlySet<string>): PackageUiAttachments {
  return {
    modules: attachments.modules.filter((m) => visiblePackageIds.has(m.packageId)),
    sheet: attachments.sheet,
    refused: attachments.refused.filter((r) => visiblePackageIds.has(r.packageId)),
  };
}
