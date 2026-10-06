/**
 * Shared builtin package constants and utilities.
 *
 * Zero-runtime-dependency module (only node:fs/path/module) to avoid circular
 * imports. bootstrap.ts, builtinFeatures.ts and packageRecords.ts import from here.
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
 *     (`require.resolve('<id>/package.json')`) — the ONE discovery path.
 *     Monorepo dev resolves pnpm workspace symlinks; the image holds every
 *     package (any scope, any source) as a real `node_modules/<id>` directory;
 *     a `--pkg` dev mount BINDS a folder onto that same path, so it is found
 *     exactly like the installed copy it replaces.
 *   - `NEURALIS_BUILTINS` env var overrides the discovered list with FULL
 *     package ids (e.g. `@neuralis/agent-core` — bare slugs are no longer
 *     accepted), e.g. for slim images that ship fewer builtins.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import type { PackageDefinition } from '@neuralis/package-system/contracts';

/**
 * The host root holding the LIVE package.json (deps = the builtin
 * authorization surface, editable via `pnpm neuralis:pkg`).
 *
 * In dev (next dev / vitest / next build) the cwd IS the host root. In the
 * production image the standalone server chdirs into `/neuralis/_runtime`
 * (see Dockerfile CMD) — there `_runtime/package.json` is only a build-time
 * COPY inside the anon volume; reading it would make runtime deps edits
 * (host overlay + `pnpm neuralis:pkg add`) invisible, so we anchor one level
 * up at the real `/neuralis/package.json`.
 */
function resolveHostRoot(): string {
  const cwd = process.cwd();
  if (basename(cwd) === '_runtime' && existsSync(join(dirname(cwd), 'package.json'))) {
    return dirname(cwd);
  }
  return cwd;
}

export const HOST_ROOT = resolveHostRoot();

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
 * LOAD-BEARING (R2): exclusion runs BEFORE the host's first-party
 * trust-overwrite in bootstrap.ts, and that ORDER is the whole point. The
 * `examples/*` trees are VALID manifests — they pass every validator; the only
 * thing keeping them out of the runtime is their own `neuralis.referenceOnly`
 * flag. A manifest field is author-controlled, so a tree that LOSES that flag
 * (an edit, a bad merge, a fork someone adds to the deps) would be promoted to
 * `first-party` and loaded in-process. This set is the defence-in-depth that
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
 * `first-party` trust in bootstrap.ts.
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

function readResolvedDepManifest(name: string): DepManifest | undefined {
  try {
    // Throws for deps that are not installed, or whose `exports` map does not
    // expose `./package.json` — neither can be a Neuralis package (the
    // authoring spec requires a resolvable package.json), so skipping is safe.
    return JSON.parse(readFileSync(resolveDepPackageJsonPath(name), 'utf-8')) as DepManifest;
  } catch {
    return undefined;
  }
}

function discoverBuiltinPackageIds(): string[] {
  // Read the host's LIVE package.json directly (HOST_ROOT — not
  // `__dirname`-relative: the dist output is bundled into chunked .js files
  // by Next.js, so `__dirname` points somewhere inside .next/server/).
  const hostPkgPath = join(HOST_ROOT, 'package.json');
  const hostPkg = JSON.parse(readFileSync(hostPkgPath, 'utf-8')) as HostPackageJson;
  return selectBuiltinPackageIds(hostPkg.dependencies ?? {}, readResolvedDepManifest);
}

const _envOverride = process.env.NEURALIS_BUILTINS?.split(',').map(s => s.trim()).filter(Boolean);

/** Full package ids of every deps-discovered builtin (scope-agnostic). */
export const BUILTIN_PACKAGE_IDS: ReadonlySet<string> = new Set(
  _envOverride && _envOverride.length > 0 ? _envOverride : discoverBuiltinPackageIds(),
);

// ---------------------------------------------------------------------------
// Builtin root resolution + host-assigned trust
// ---------------------------------------------------------------------------

export function resolveBuiltinRoot(packageId: string): string {
  return dirname(resolveDepPackageJsonPath(packageId));
}

/**
 * Host-assigned trust for deps-sourced builtins: being in the host's
 * `package.json#dependencies` is the admin trust act, so trust is assigned by
 * SOURCE, not by self-declaration — a `@company/*` manifest forgetting to
 * declare `first-party` must not silently load as a partial `untrusted-node`
 * package. MUST only be called on ids that passed the discovery exclusions
 * (R2 ordering — never on reference-only / blockless packages).
 */
export function assignBuiltinTrust(definition: PackageDefinition): PackageDefinition {
  return {
    ...definition,
    access: { ...definition.access, trust: 'first-party' },
  };
}
