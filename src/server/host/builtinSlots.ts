/**
 * Shared builtin package constants and utilities.
 *
 * Zero-runtime-dependency module (only node:fs/path/module) to avoid circular
 * imports. bootstrap.ts, builtinFeatures.ts, packageRecords.ts and the runtime
 * package install (`packages/install/`) import from here.
 *
 * Discovery model (W6 golden-sparking-seal, generalized by crystalline-lagoon):
 *   - The host's own `neuralis/package.json#dependencies` is the source of
 *     truth AND the authorization boundary: only whoever controls the deploy
 *     config / image build (admin / core team) can put a package there.
 *   - A dep is a builtin iff its own `package.json` carries a `neuralis`
 *     manifest block (scope-agnostic — `@neuralis/*` and `@company/*` alike;
 *     a plain npm dep like `zod` has no block and is auto-skipped) and is not
 *     reference-only (explicit set below, or `neuralis.referenceOnly: true`).
 *   - Roots resolve through Node's standard module resolution
 *     (`require.resolve('<id>/package.json')`) — the ONE discovery path, from
 *     the host root (and, for the record's lines below, from the record's).
 *     Monorepo dev resolves pnpm workspace symlinks; the image holds every
 *     package (any scope, any source) as a real `node_modules/<id>` directory;
 *     a `--pkg` dev mount BINDS a folder onto that same path, so it is found
 *     exactly like the installed copy it replaces.
 *   - The platform's runtime install record (`<appRoot>/packages/`, an npm
 *     project `neuralis package install` writes — the same admin trust act,
 *     taken by a person through the host's install transaction) adds its
 *     dependencies to that set, each resolved from the record's own root. A
 *     record entry the host's own dependencies already name is left out: the
 *     image's copy wins, by name (`shadowed`). Read once per process, so an
 *     install is active from the next start.
 *   - `NEURALIS_BUILTINS` env var overrides the discovered list with FULL
 *     package ids (e.g. `@neuralis/agent-core` — bare slugs are no longer
 *     accepted), e.g. for slim images that ship fewer builtins.
 */

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { PackageDefinition } from '@neuralis/package-system/contracts';
import { hostTreeRoot, resolveNeuralisHome } from '@neuralis/package-system/paths';

/**
 * The host root holding the LIVE package.json (deps = the builtin
 * authorization surface, editable via `pnpm neuralis:pkg`).
 *
 * The host package that holds this file (`<root>/src/server/host/`), so an
 * operator verb reads the code that runs, whatever folder it was typed in.
 * The one exception is the BUILT server in `_runtime/` (the image's Dockerfile
 * CMD, `neuralis up`): the standalone flatten moved its chunks, so Turbopack's
 * `import.meta.url` there names a file that is not on disk, and
 * `_runtime/package.json` is only a build-time COPY inside the anon volume —
 * reading it would make runtime dep edits (host overlay + `pnpm neuralis:pkg
 * add`) invisible. That server anchors one level up, at the real
 * `/neuralis/package.json` (`hostTreeRoot`).
 */
export function resolveHostRoot(cwd: string, moduleFile: string): string {
  const runtimeParent = hostTreeRoot(cwd);
  return runtimeParent !== cwd ? runtimeParent : resolve(dirname(moduleFile), '..', '..', '..');
}

export const HOST_ROOT = resolveHostRoot(process.cwd(), fileURLToPath(import.meta.url));

// Module resolution anchored at the host root: the resolver walks
// <hostRoot>/node_modules/<id>/ — identical for monorepo dev (pnpm workspace
// symlinks), the image (real directories) and a `--pkg` bind mount.
const require_ = createRequire(join(HOST_ROOT, 'package.json'));

function resolveDepPackageJsonPath(name: string): string {
  return require_.resolve(`${name}/package.json`);
}

/**
 * Absolute path to package-system's compiled guest PDK entry
 * (`dist/src/runtime/pdk/index.js`), resolved from the HOST ROOT at runtime.
 *
 * The WASM build aliases the bare `@neuralis/package-system/pdk-guest` specifier
 * to this path (R12). `wasmBuild` can self-resolve it from the CLI, but when it
 * runs inside the Next server it is bundled — `__dirname` becomes a synthetic
 * `/ROOT/...` and the bundle's `require.resolve` throws (the BUG-B repro). This
 * helper is bundling-immune: `require_` is a native `createRequire` anchored at
 * the real host root, exactly like builtin discovery. Host-side build callers pass the result to
 * `buildWasmPackage({ pdkGuestPath })`. Returns `undefined` if not found (the
 * builder then self-resolves and fails loud with its own message).
 */
export function resolveGuestPdkPath(): string | undefined {
  const rel = join('dist', 'src', 'runtime', 'pdk', 'index.js');
  try {
    const pkgRoot = dirname(resolveDepPackageJsonPath('@neuralis/package-system'));
    const p = join(pkgRoot, rel);
    if (existsSync(p)) return p;
  } catch {
    /* fall through to the host-root fallback */
  }
  const fallback = join(HOST_ROOT, 'node_modules', '@neuralis', 'package-system', rel);
  return existsSync(fallback) ? fallback : undefined;
}

/**
 * Reference / documentation-only packages that may appear as deps so authors
 * can read them, but must NEVER auto-load.
 *
 * LOAD-BEARING (R2): exclusion runs BEFORE the host's native
 * trust-overwrite in bootstrap.ts, and that ORDER is the whole point. The
 * `examples/*` trees are VALID manifests — they pass every validator; the only
 * thing keeping them out of the runtime is their own `neuralis.referenceOnly`
 * flag. A manifest field is author-controlled, so a tree that LOSES that flag
 * (an edit, a bad merge, a fork someone adds to the deps) would be promoted to
 * `native` and loaded in-process. This set is the defence-in-depth that
 * does not depend on the package telling the truth about itself. Do not remove
 * it as "redundant" with the `referenceOnly` signal — redundancy is the feature.
 */
const REFERENCE_ONLY_PACKAGE_IDS = new Set<string>([
  '@neuralis/package-system',
  '@neuralis/example-builtin',
  '@example/project-package',
]);

interface HostPackageJson {
  dependencies?: Record<string, string>;
}

/** The slice of a dep's package.json the discovery signal reads. */
export interface DepManifest {
  neuralis?: { referenceOnly?: boolean } & Record<string, unknown>;
}

/**
 * Pure discovery core — selects builtin package ids from a deps map.
 *
 * Exclusion order (R2, load-bearing): reference-only set → manifest
 * unreadable → no `neuralis` block → `neuralis.referenceOnly` opt-out.
 * Only ids that pass EVERY exclusion may later receive the host-assigned
 * `native` trust in bootstrap.ts.
 */
export function selectBuiltinPackageIds(
  deps: Record<string, string>,
  readDepManifest: (name: string) => DepManifest | undefined,
): string[] {
  const ids: string[] = [];
  for (const name of Object.keys(deps)) {
    if (REFERENCE_ONLY_PACKAGE_IDS.has(name)) continue;
    const manifest = readDepManifest(name);
    const block = manifest?.neuralis;
    if (!block || typeof block !== 'object') continue;
    if (block.referenceOnly === true) continue;
    ids.push(name);
  }
  return ids.sort();
}

/**
 * The dependency lines discovery reads from the manifest at `HOST_ROOT`.
 *
 * The host's own manifest is read as it is. An npm install folder — a manifest
 * that DEPENDS on the host package `neuralis` — is where an operator command
 * runs on that channel; its builtins are what the image it runs carries: the
 * host package's own lines plus the folder's other lines, the union the derived
 * image's manifest holds (`operatorInstall` in `scripts/build/build-workspace.mjs`).
 * Without it the operator CLI would see only the folder's lines and no
 * `@neuralis/*` builtin at all.
 */
export function builtinDependencyLines(
  manifest: HostPackageJson,
  readHostPackage: () => HostPackageJson,
): Record<string, string> {
  const { neuralis: hostSpec, ...lines } = manifest.dependencies ?? {};
  if (typeof hostSpec !== 'string') return manifest.dependencies ?? {};
  return { ...(readHostPackage().dependencies ?? {}), ...lines };
}

function hostDependencyLines(): Record<string, string> {
  // Read the host's LIVE package.json directly (HOST_ROOT — not
  // `__dirname`-relative: the dist output is bundled into chunked .js files
  // by Next.js, so `__dirname` points somewhere inside .next/server/).
  const hostPkgPath = join(HOST_ROOT, 'package.json');
  const hostPkg = JSON.parse(readFileSync(hostPkgPath, 'utf-8')) as HostPackageJson;
  return builtinDependencyLines(hostPkg, () => JSON.parse(readFileSync(resolveDepPackageJsonPath('neuralis'), 'utf-8')) as HostPackageJson);
}

// ---------------------------------------------------------------------------
// The runtime install record (`<appRoot>/packages/`)
// ---------------------------------------------------------------------------

/** The record's folder under the app root: an npm project whose `dependencies` are the runtime-installed packages. */
export const RUNTIME_PACKAGES_DIR = 'packages';

export function runtimePackagesRoot(appRoot: string): string {
  return join(appRoot, RUNTIME_PACKAGES_DIR);
}

// The same home resolver `getEnv()` reads, so the record is the one the
// install transaction writes.
const RECORD_MANIFEST = join(runtimePackagesRoot(resolveNeuralisHome().appRoot), 'package.json');
const recordRequire = createRequire(RECORD_MANIFEST);

/** The record's dependency lines; `unreadable` when a record exists that is no JSON object (it then contributes nothing). */
function readRecordLines(): { lines: Record<string, string>; unreadable: boolean } {
  let text: string;
  try {
    text = readFileSync(RECORD_MANIFEST, 'utf-8');
  } catch {
    return { lines: {}, unreadable: false };
  }
  try {
    const deps = (JSON.parse(text) as HostPackageJson).dependencies ?? {};
    return typeof deps === 'object' && !Array.isArray(deps) ? { lines: deps, unreadable: false } : { lines: {}, unreadable: true };
  } catch {
    return { lines: {}, unreadable: true };
  }
}

/** What discovery found: every builtin's root, which came from the record, and which record entries the host's own lines shadow. */
export type BuiltinDiscovery = {
  roots: ReadonlyMap<string, string>;
  runtimeInstalled: ReadonlySet<string>;
  shadowed: readonly string[];
};

/**
 * Pure discovery over both manifests. Each side runs the SAME exclusion order
 * (`selectBuiltinPackageIds`), resolved from its own root; a record line whose
 * name the host's lines carry is never read (the image's copy wins). An id
 * whose `package.json` path cannot be resolved has no root and is no builtin.
 */
export function discoverBuiltinRoots(input: {
  hostLines: Record<string, string>;
  recordLines: Record<string, string>;
  resolveHost: (name: string) => string;
  resolveRecord: (name: string) => string;
  readManifest: (packageJsonPath: string) => DepManifest | undefined;
}): BuiltinDiscovery {
  const roots = new Map<string, string>();
  // A dep that is not installed, or whose `exports` map does not expose
  // `./package.json`, cannot be a Neuralis package (the authoring spec requires
  // a resolvable package.json), so skipping it is safe.
  const reader = (resolve: (name: string) => string) => (name: string): DepManifest | undefined => {
    try {
      return input.readManifest(resolve(name));
    } catch {
      return undefined;
    }
  };
  for (const id of selectBuiltinPackageIds(input.hostLines, reader(input.resolveHost))) roots.set(id, dirname(input.resolveHost(id)));
  const shadowed = Object.keys(input.recordLines).filter((name) => name in input.hostLines).sort();
  const own = Object.fromEntries(Object.entries(input.recordLines).filter(([name]) => !(name in input.hostLines)));
  const runtimeInstalled = new Set<string>();
  for (const id of selectBuiltinPackageIds(own, reader(input.resolveRecord))) {
    roots.set(id, dirname(input.resolveRecord(id)));
    runtimeInstalled.add(id);
  }
  return { roots, runtimeInstalled, shadowed };
}

const _envOverride = process.env.NEURALIS_BUILTINS?.split(',').map(s => s.trim()).filter(Boolean);
const _record = readRecordLines();
const _discovery = discoverBuiltinRoots({
  hostLines: hostDependencyLines(),
  recordLines: _record.lines,
  resolveHost: resolveDepPackageJsonPath,
  resolveRecord: (name) => recordRequire.resolve(`${name}/package.json`),
  readManifest: (path) => JSON.parse(readFileSync(path, 'utf-8')) as DepManifest,
});

/** Full package ids of every deps-discovered builtin (scope-agnostic): the host's lines, then the record's. */
export const BUILTIN_PACKAGE_IDS: ReadonlySet<string> = new Set(
  _envOverride && _envOverride.length > 0 ? _envOverride : [..._discovery.roots.keys()].sort(),
);

/** The record as this process read it: its lines, the builtins discovered from it, the entries the host shadows, and whether it was unreadable. */
export const RUNTIME_INSTALL_DISCOVERY: Readonly<{ lines: Readonly<Record<string, string>>; installed: ReadonlySet<string>; shadowed: readonly string[]; unreadable: boolean }> = {
  lines: _record.lines,
  installed: _discovery.runtimeInstalled,
  shadowed: _discovery.shadowed,
  unreadable: _record.unreadable,
};

/** Every dependency name the host's own manifest carries (an image copy wins over the record by name). */
export function hostDependencyNames(): ReadonlySet<string> {
  return new Set(Object.keys(hostDependencyLines()));
}

/** The root of one of the host's own dependencies (a peer the record links to); throws when the host has none. */
export function resolveHostDependencyRoot(name: string): string {
  return dirname(resolveDepPackageJsonPath(name));
}

// ---------------------------------------------------------------------------
// Builtin root resolution + host-assigned trust
// ---------------------------------------------------------------------------

/** A builtin's root: discovery's answer, else (an env-override id) the host root's resolver. */
export function resolveBuiltinRoot(packageId: string): string {
  return _discovery.roots.get(packageId) ?? dirname(resolveDepPackageJsonPath(packageId));
}

/** Every builtin's root, by id (the runtime provider's `packageRoots`). */
export const BUILTIN_ROOTS: ReadonlyMap<string, string> = new Map([...BUILTIN_PACKAGE_IDS].map((id) => [id, resolveBuiltinRoot(id)]));

/**
 * Every builtin as its RAW manifest (`package.json#neuralis`), id set from the
 * discovered dep name and trust stamped by SOURCE (`assignBuiltinProvenance`). The
 * runtime provider resolves each one's files from its root; the host needs the
 * manifest alone — `provides`, `configSettings[]` and `credentials[]` are
 * manifest fields. An unreadable manifest fails the boot: every id here already
 * passed discovery, which read the same file.
 */
export async function readBuiltinManifests(roots: ReadonlyMap<string, string> = BUILTIN_ROOTS): Promise<PackageDefinition[]> {
  return Promise.all(
    [...roots].map(async ([id, root]) => {
      const raw = await readFile(join(root, 'package.json'), 'utf-8');
      const manifest = (JSON.parse(raw) as { neuralis?: Partial<PackageDefinition> }).neuralis;
      if (!manifest) throw new Error(`builtin "${id}" has no neuralis manifest block`);
      // A builtin is NAMED by its package id (`@neuralis/admin`): every surface
      // that lists packages shows builtins under one uniform name. The manifest
      // `name` is a label for project/installed packages only.
      return assignBuiltinProvenance({ ...manifest, id, name: id } as PackageDefinition);
    }),
  );
}

/**
 * Host-assigned PROVENANCE for a builtin of either install slot (the host's
 * `package.json#dependencies` and the runtime install record): being listed
 * there is the admin trust act, so the host stamps BOTH halves of the code-import
 * gate (`isHostOwnedBuiltin` in agent-core's loader) — `source.kind: 'neuralis'`
 * and `access.trust: 'native'` — overwriting whatever the manifest says.
 * A manifest neither needs nor can claim either: one forgetting them must not
 * load as a partial `untrusted-node` package, one declaring them is ignored.
 * MUST only be called on ids that passed the discovery exclusions (R2 ordering
 * — never on reference-only / blockless packages).
 */
export function assignBuiltinProvenance(definition: PackageDefinition): PackageDefinition {
  return {
    ...definition,
    source: { kind: 'neuralis' },
    access: { ...definition.access, trust: 'native' },
  };
}
