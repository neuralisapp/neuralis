#!/usr/bin/env node
/**
 * build-workspace.mjs — the image's ONE build workspace: how a registered
 * package that lives OUTSIDE this repository joins the same install, build and
 * deploy as the platform's own packages.
 *
 * THE LOCAL-SOURCE RULE (canonical statement — every other site points here):
 * a host dependency whose spec starts with `file:` or `link:` is a LOCAL SOURCE.
 * Only the operator tooling writes it (`pnpm neuralis:pkg add --path|--tarball`,
 * the git.md §4.5 carve-out). It is part of THIS machine's image — the generated
 * compose hands each one to the build as a named context, the build installs and
 * builds it like a workspace package, and `pnpm deploy` copies it into the
 * runner's `node_modules/<name>` as a real directory — but it is never part of a
 * PUBLIC artifact: never committed (lock or manifest), never in an npm tarball
 * (the host `prepack` guard refuses), never in a test universe that pins the
 * shippable set. Shipping to the public and running here are different planes.
 *
 * Shared by two sides, so the slot order can never disagree:
 * - the HOST (`scripts/setup/compose.mts` via `setup.mts --compose-only`, which
 *   `pnpm neuralis:rebuild` re-runs before every build; `pkg.mts`) plans the
 *   sources and validates them before anything is written;
 * - the BUILDER (`neuralis/Dockerfile`) runs the subcommands below with bare node.
 *
 * Layout inside the build: every directory source is a workspace MEMBER at
 * `/src/local/<dir-name>/` (the 12.x `pnpm deploy` refuses any lock path outside
 * the workspace, so a source cannot stay where the host has it); a tarball is a
 * prebuilt, registry-shaped input at `/src/local-tgz/<dir-name>.tgz` and is never
 * rebuilt. The build-side copy of the host manifest points each spec there; the
 * host file itself is never touched.
 *
 * What a context carries: the WHOLE source directory as the daemon receives it
 * (the directory's own `.dockerignore` decides, as for any named context) —
 * dependency trees, VCS folders and build outputs are dropped here before
 * anything else sees them (`DROPPED_DIRS`), and a symlink that leaves the
 * package is refused, because it would dangle inside the build.
 *
 * Subcommands (builder):
 *   stage <ws-dir> <slots-dir> <out-dir>   place the sources, rewrite the manifests
 *   scope-routes <buildlock-dir> <tracked> <ws> <npmrc>  exit 1 when a private scope the build needs (lock, manifest or the private-scope record) has no .npmrc route
 *   verify-lock <tracked> <current> <ws>   every tracked resolution survives
 *   lock-base <buildlock-dir> <tracked> <ws>  exit 0 iff the exported lock fits this tracked lock, these local packages and the staged tarballs
 *   export-lock <lock> <tracked> <out-dir> write the lock + the tracked lock's sha256
 *   build-package <kernel-root>            build ONE workspace member (cwd)
 *   ui-compat <deploy-root> <kernel-root> <out-file>
 *   validate <deploy-root> <kernel-root> <host-manifest> <lock> <out-file>
 *   release-age-excludes <npmrc>           the private scopes' minimumReleaseAge exclusions
 *   overrides <pnpm-workspace.yaml> <deploy-root>
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Named-context slots the Dockerfile declares (`localpkg0` … `localpkg7`). */
export const LOCAL_SOURCE_SLOTS = 8;

/** Where the sources sit inside the build workspace (relative to its root). */
export const LOCAL_DIR = 'local';
export const LOCAL_TGZ_DIR = 'local-tgz';

/**
 * What a folder source never brings into the build — the repository's own
 * `.dockerignore` rule for its packages: dependency trees, VCS and store
 * folders, and every build output (the build rebuilds it; a stale `dist/` or a
 * `.tsbuildinfo` would ship deleted files or make an incremental compile emit
 * nothing).
 */
const DROPPED_DIRS = new Set(['node_modules', '.git', '.pnpm-store', 'dist', '.next', '.test-dist']);
const isDropped = (name) => DROPPED_DIRS.has(name) || name.endsWith('.tsbuildinfo');

/** Dependency maps whose `file:`/`link:` specs must resolve inside the build. */
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/** First-level folders the package loader reads at runtime — each must be in `files`. */
export const RUNTIME_DIRS = [
  'dist', 'app', 'tools', 'skills', 'workflows', 'rules', 'instructions', 'agents', 'docs', 'team', 'commands',
];

export function isLocalSourceSpec(spec) {
  return typeof spec === 'string' && (spec.startsWith('file:') || spec.startsWith('link:'));
}

/** `@scope/name` → `scope__name`: a fixed, space-free directory name inside the build. */
export function localSourceDirName(name) {
  return name.replace(/^@/, '').replace(/\//g, '__');
}

/** The local sources of a host manifest, sorted by name — the slot order on both sides. */
export function listLocalSources(hostManifest) {
  const deps = hostManifest?.dependencies ?? {};
  return Object.keys(deps)
    .filter((name) => isLocalSourceSpec(deps[name]))
    .sort()
    .map((name) => {
      const spec = deps[name];
      const path = spec.replace(/^(file|link):/, '');
      return { name, spec, path, kind: path.endsWith('.tgz') ? 'tgz' : 'dir' };
    });
}

/**
 * Plan the named contexts for the host manifest at `hostDir`: one slot per local
 * source, in `listLocalSources` order. Every problem is collected, so one run
 * names them all.
 */
export function planLocalSources(hostManifest, hostDir, fs = { existsSync, statSync, realpathSync }) {
  const sources = [];
  const errors = [];
  const listed = listLocalSources(hostManifest);
  if (listed.length > LOCAL_SOURCE_SLOTS) {
    errors.push(
      `${listed.length} local packages are registered, the build takes at most ${LOCAL_SOURCE_SLOTS} ` +
        `(neuralis/Dockerfile localpkg0…localpkg${LOCAL_SOURCE_SLOTS - 1}) — remove one with pnpm neuralis:pkg remove <name>`,
    );
  }
  const seenDirNames = new Map();
  listed.forEach((source, slot) => {
    const hostPath = resolve(hostDir, source.path);
    const dirName = localSourceDirName(source.name);
    const clash = seenDirNames.get(dirName);
    if (clash) errors.push(`${source.name} and ${clash} map to the same build directory "${dirName}" — rename one`);
    seenDirNames.set(dirName, source.name);
    if (!fs.existsSync(hostPath)) {
      errors.push(
        `${source.name}: Could not install from "${hostPath}" as it does not exist ` +
          `(${source.spec} in neuralis/package.json) — restore it, or run: pnpm neuralis:pkg remove ${source.name}`,
      );
      return;
    }
    const real = fs.realpathSync(hostPath);
    const isDir = fs.statSync(real).isDirectory();
    if (source.kind === 'tgz' && isDir) {
      errors.push(`${source.name}: ${hostPath} ends in .tgz but is a directory`);
      return;
    }
    if (source.kind === 'dir' && !isDir) {
      errors.push(`${source.name}: ${hostPath} is not a directory (a packed package must end in .tgz)`);
      return;
    }
    sources.push({
      slot,
      name: source.name,
      spec: source.spec,
      kind: source.kind,
      hostPath,
      dirName,
      contextDir: source.kind === 'dir' ? real : dirname(real),
      ...(source.kind === 'tgz' ? { fileName: basename(real) } : {}),
    });
  });
  return { sources, errors };
}

/**
 * The build-side manifest of ONE local package, and every reason it cannot be
 * built. A `file:`/`link:` spec that leaves the package is rewritten when it
 * names another registered local source and refused otherwise — pnpm itself
 * accepts it silently and links a target that does not exist in the build.
 * A directory source must carry `build`, and `build:ui` when it declares
 * `neuralis.app.module`; a tarball arrives built.
 *
 * `ctx`: { name, kind, hostPackageDir, registered: Map<host abs path, dirName> }
 */
export function prepareLocalManifest(manifest, ctx) {
  const problems = [];
  const next = JSON.parse(JSON.stringify(manifest ?? {}));
  if (next.name !== ctx.name) {
    problems.push(`${ctx.name}: its package.json is named "${next.name ?? '(none)'}"`);
  }
  for (const field of DEP_FIELDS) {
    const deps = next[field];
    if (!deps || typeof deps !== 'object') continue;
    for (const [dep, spec] of Object.entries(deps)) {
      if (!isLocalSourceSpec(spec)) continue;
      const target = resolve(ctx.hostPackageDir, spec.replace(/^(file|link):/, ''));
      const inside = target === ctx.hostPackageDir || target.startsWith(ctx.hostPackageDir + sep);
      if (inside) continue;
      const sibling = ctx.registered.get(target);
      if (sibling) {
        deps[dep] = `file:../${sibling}`;
        continue;
      }
      problems.push(
        `${ctx.name}: ${field}["${dep}"] = "${spec}" points outside the package and at no registered local ` +
          `package — the platform packages arrive as peerDependencies (the build workspace provides them); ` +
          `register a sibling with pnpm neuralis:pkg add --path, or depend on it through a registry`,
      );
    }
  }
  if (ctx.kind === 'dir') {
    const scripts = next.scripts ?? {};
    if (typeof scripts.build !== 'string') problems.push(`${ctx.name}: package.json declares no "build" script`);
    if (next.neuralis?.app?.module && typeof scripts['build:ui'] !== 'string') {
      problems.push(`${ctx.name}: declares neuralis.app.module but no "build:ui" script (neuralis-build ui)`);
    }
  }
  return { manifest: next, problems };
}

/** First-level runtime folders a package ships but its `files` whitelist omits. */
export function filesWhitelistProblems(manifest, pkgDir, fs = { existsSync }) {
  const files = Array.isArray(manifest?.files) ? manifest.files : null;
  if (!files || files.length === 0) {
    return ['declares no `files` whitelist — packing would ship the whole folder; start with "dist"'];
  }
  const roots = new Set(files.filter((f) => !f.startsWith('!')).map((f) => f.split('/')[0]));
  return RUNTIME_DIRS.filter((dir) => fs.existsSync(join(pkgDir, dir)) && !roots.has(dir)).map(
    (dir) => `ships a "${dir}/" folder that \`files\` does not list — its contributions would be missing from an install`,
  );
}

/**
 * A build `.npmrc` may carry scope lines and their auth only. A default
 * `registry=` makes pnpm 12 fetch pnpm ITSELF from that registry (the root
 * `packageManager` pin), which a private registry does not serve.
 */
export function npmrcProblems(text) {
  const problems = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith(';'));
  if (lines.some((l) => /^registry\s*=/.test(l))) {
    problems.push('carries a default `registry=` line — use `@<scope>:registry=<url>` lines only');
  }
  if (!lines.some((l) => /^@[^:\s]+:registry\s*=/.test(l))) {
    problems.push('carries no `@<scope>:registry=<url>` line');
  }
  return problems;
}

/**
 * The public registry and its mirror (`registry.yarnpkg.com` serves the same
 * fresh releases): a scope routed there keeps every supply-chain floor.
 */
const PUBLIC_REGISTRY = /^https?:\/\/registry\.(npmjs\.(org|com)|yarnpkg\.com)\/?$/;

/**
 * The scopes a build `.npmrc` routes to a PRIVATE registry, sorted. Only these
 * are the operator's own releases; a scope pointed at the public registry is
 * not one.
 */
export function privateScopes(text) {
  return [...privateScopeRoutes(text).keys()].sort();
}

/** Each scope a build `.npmrc` routes to a PRIVATE registry → that registry's origin. */
function privateScopeRoutes(text) {
  const routes = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.trim().match(/^(@[a-z0-9][a-z0-9._-]*):registry\s*=\s*(\S+)\s*$/i);
    if (m && !PUBLIC_REGISTRY.test(m[2])) routes.set(m[1], privateOrigin(m[2]) ?? m[2]);
  }
  return routes;
}

/**
 * The install-line flags that lift `minimumReleaseAge` for the given private
 * scopes ONLY — a fresh release of the operator's own package installs at once, every
 * public package keeps the one-day floor. pnpm 12 accumulates a repeated flag
 * (a comma or space list is read as ONE pattern), so it is one flag per scope.
 * Never written into the tracked `pnpm-workspace.yaml`.
 */
export function releaseAgeExcludeFlags(scopes) {
  return scopes.map((scope) => `--config.minimum-release-age-exclude=${scope}/*`);
}

/** A lock key or a dependency name without its version: `'@a/b@1.0.0(c@2)'` → `@a/b`. */
function lockKeyName(key) {
  const k = key.replace(/^'|'$/g, '');
  const at = k.indexOf('@', 1);
  return at === -1 ? k : k.slice(0, at);
}

const scopeOf = (name) => (name.startsWith('@') && name.includes('/') ? name.split('/')[0] : null);

/** A tarball URL's origin when it is NOT the public registry, else null. */
function privateOrigin(url) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  // A scheme-less value parses to the opaque origin "null" — not a registry.
  if (origin === 'null') return null;
  return PUBLIC_REGISTRY.test(origin) ? null : origin;
}

/**
 * What a lock text shows about registries: the private origin each scope was
 * served from (a tarball URL off the public registry), the snapshot graph's
 * dependency edges, and the names never asked of a registry (local folders and
 * tarballs).
 */
function scanLockGraph(lockTexts) {
  const origins = new Map();
  const edges = new Map();
  const local = new Set();
  for (const text of lockTexts) {
    let section = null;
    let current = null;
    let inDeps = false;
    for (const line of text.split('\n')) {
      let m;
      if (/^\S/.test(line)) {
        section = line.replace(/:.*$/, '');
        current = null;
      } else if ((m = line.match(/^ {2}(\S.*?):(\s+\{\})?\s*$/))) {
        current = lockKeyName(m[1]);
        inDeps = false;
      } else if (current && section === 'packages' && (m = line.match(/^ {4}resolution: \{.*\btarball: (https?:\/\/[^,}\s]+)/))) {
        noteOrigin(origins, scopeOf(current), privateOrigin(m[1]));
      } else if (current && section === 'packages' && /^ {4}resolution: \{(directory: |.*\btarball: file:)/.test(line)) {
        local.add(current);
      } else if (current && section === 'snapshots' && (m = line.match(/^ {4}(\S+):\s*$/))) {
        inDeps = m[1] === 'dependencies' || m[1] === 'optionalDependencies';
      } else if (current && section === 'snapshots' && inDeps && (m = line.match(/^ {6}('[^']+'|[^\s:]+):\s/))) {
        edges.set(current, (edges.get(current) ?? new Set()).add(m[1].replace(/^'|'$/g, '')));
      }
    }
  }
  return { origins, edges, local };
}

function noteOrigin(origins, scope, origin) {
  if (scope && origin) origins.set(scope, (origins.get(scope) ?? new Set()).add(origin));
}

/**
 * The scopes this build would resolve from the PUBLIC registry although a lock
 * (the kept build lock, the tracked one), a manifest spec or the private-scope
 * record shows them served by a private one — and no build `.npmrc` scope line
 * routes them there. pnpm would ask the public registry for those names
 * (metadata, the release-age check): a private scope's name leaks, and whoever
 * publishes it there is installed at first-party trust. Only names this build
 * REACHES count — the current host and local manifests' dependencies, walked
 * through the locks' snapshots — so a package removed since leaves no refusal
 * behind.
 *
 * @param {{ lockTexts: string[]; manifests: object[]; npmrcText: string; record?: Map<string, { origins: string[] }> }} input
 * @returns {Array<{ scope: string; origins: string[]; packages: string[] }>}
 */
export function unroutedPrivateScopes({ lockTexts, manifests, npmrcText, record = new Map() }) {
  const { origins, edges, local } = scanLockGraph(lockTexts);
  for (const [scope, entry] of record) for (const origin of entry.origins) noteOrigin(origins, scope, origin);
  const reach = [];
  for (const manifest of manifests) {
    for (const field of DEP_FIELDS) {
      for (const [dep, spec] of Object.entries(manifest?.[field] ?? {})) {
        reach.push(dep);
        if (typeof spec === 'string' && /^https?:\/\//.test(spec)) noteOrigin(origins, scopeOf(dep), privateOrigin(spec));
        if (isLocalSourceSpec(spec) || (typeof spec === 'string' && spec.startsWith('workspace:'))) local.add(dep);
      }
    }
  }
  const reached = new Set();
  while (reach.length > 0) {
    const name = reach.pop();
    if (reached.has(name)) continue;
    reached.add(name);
    for (const dep of edges.get(name) ?? []) reach.push(dep);
  }
  const routed = new Set(privateScopes(npmrcText));
  const out = [];
  for (const [scope, from] of origins) {
    if (routed.has(scope)) continue;
    const packages = [...reached].filter((n) => scopeOf(n) === scope && !local.has(n)).sort();
    if (packages.length > 0) out.push({ scope, origins: [...from].sort(), packages });
  }
  return out.sort((a, b) => a.scope.localeCompare(b.scope));
}

/** One refusal line for an `unroutedPrivateScopes` entry — the build and `pkg add` print the same. */
export function describeUnroutedScope(u) {
  return (
    `${u.scope} (${u.packages.join(', ')}) is served by ${u.origins.join(', ')}: add "${u.scope}:registry=${u.origins[0]}/" ` +
    'and its token line to the .npmrc that .env NEURALIS_BUILD_NPMRC names'
  );
}

/**
 * THE PRIVATE-SCOPE RECORD (`<NEURALIS_HOME>/build/private-scopes.json`, beside
 * the kept build lock, so it reaches the build in the same named context): every
 * scope this machine has ever seen served by a private registry — a build
 * `.npmrc` route, or a kept lock's tarball off the public registry — with its
 * origins and when it was first seen. The lock is pruned when the package that
 * needed the scope goes, and the operator may unset the `.npmrc`; the record
 * outlives both, so a later package depending on that scope is refused instead
 * of being asked of the public registry. It is fed before every build
 * (`resolveBuildInputs`, before the kept lock can be replaced) and never pruned
 * automatically: a scope that is public now is forgotten by deleting its entry
 * from the file.
 *
 * The boundary: a scope this machine never saw served privately is
 * indistinguishable from a public scope — its first resolve depends on the
 * operator's `.npmrc`.
 */
export const PRIVATE_SCOPES_FILE = 'private-scopes.json';

const SCOPE_NAME = /^@[a-z0-9][a-z0-9._-]*$/i;

/**
 * The record's text → `scope → { origins, firstSeen }`. Throws on any shape it
 * does not know: an unreadable record must refuse, never read as "no private
 * scope".
 *
 * @returns {Map<string, { origins: string[]; firstSeen: string }>}
 */
export function parsePrivateScopeRecord(text) {
  const raw = JSON.parse(text);
  const scopes = raw?.scopes;
  if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes)) throw new Error('has no "scopes" object');
  const record = new Map();
  for (const [scope, entry] of Object.entries(scopes)) {
    const origins = entry?.origins;
    if (!SCOPE_NAME.test(scope) || !Array.isArray(origins) || origins.length === 0 || !origins.every((o) => typeof o === 'string' && o) ||
        typeof entry.firstSeen !== 'string') {
      throw new Error(`entry "${scope}" is not { "origins": ["<url>", …], "firstSeen": "<date>" }`);
    }
    record.set(scope, { origins: [...origins], firstSeen: entry.firstSeen });
  }
  return record;
}

/** The record in `dir` (empty when there is none). Throws, naming the file, when it cannot be read. */
export function readPrivateScopeRecord(dir) {
  const file = join(dir, PRIVATE_SCOPES_FILE);
  if (!existsSync(file)) return new Map();
  try {
    return parsePrivateScopeRecord(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} cannot be read (${err instanceof Error ? err.message : String(err)}) — fix or delete it`);
  }
}

/**
 * Merge what a build `.npmrc` routes privately and what the given locks show
 * served privately into the record in `dir`, and write it (through a rename,
 * sorted, so the same scopes give the same bytes) only when it changed. Nothing
 * is ever removed. Returns the record.
 */
export function feedPrivateScopeRecord(dir, { npmrcText, lockTexts }, now = new Date()) {
  const record = readPrivateScopeRecord(dir);
  const seen = scanLockGraph(lockTexts).origins;
  for (const [scope, origin] of privateScopeRoutes(npmrcText)) noteOrigin(seen, scope, origin);
  let changed = false;
  for (const [scope, from] of seen) {
    const entry = record.get(scope) ?? { origins: [], firstSeen: now.toISOString() };
    const origins = [...new Set([...entry.origins, ...from])].sort();
    if (!record.has(scope) || origins.length !== entry.origins.length) changed = true;
    record.set(scope, { origins, firstSeen: entry.firstSeen });
  }
  if (!changed) return record;
  const scopes = Object.fromEntries([...record.keys()].sort().map((s) => [s, record.get(s)]));
  const text = `${JSON.stringify({ scopes }, null, 2)}\n`;
  if (record.size === 0 || text.length < 20) throw new Error('refusing to write an empty private-scope record');
  mkdirSync(dir, { recursive: true });
  const staged = join(dir, `.${PRIVATE_SCOPES_FILE}.tmp`);
  writeFileSync(staged, text);
  renameSync(staged, join(dir, PRIVATE_SCOPES_FILE));
  return record;
}

/** A packed package's manifest, read from the archive without unpacking it to disk; null when unreadable. */
export function readTarballManifest(tgz) {
  const list = spawnSync('tar', ['-tzf', tgz], { encoding: 'utf8' });
  if (list.status !== 0) return null;
  const top = list.stdout.split('\n').find(Boolean)?.split('/')[0];
  if (!top) return null;
  const read = spawnSync('tar', ['-xzOf', tgz, `${top}/package.json`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (read.status !== 0) return null;
  try {
    return JSON.parse(read.stdout);
  } catch {
    return null;
  }
}

/**
 * The root of the host dependency that provides the `runtime` contract — the
 * package whose loader decides admission — or `null`. `rootOf` maps a
 * dependency name to its installed root.
 */
export function runtimeProviderRoot(hostManifest, rootOf) {
  for (const name of Object.keys(hostManifest?.dependencies ?? {}).sort()) {
    let root;
    try {
      root = rootOf(name);
    } catch {
      continue;
    }
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    if (Array.isArray(manifest?.neuralis?.provides) && manifest.neuralis.provides.includes('runtime')) return root;
  }
  return null;
}

/**
 * Ask the runtime provider's admission predicate (the loader's own check, no
 * package code imported) about each package root. Throws when the predicate
 * cannot be loaded — the caller decides what an unavailable check means.
 *
 * @returns {Promise<Array<{ root: string; packageId: string | null; errors: string[] }>>}
 */
export async function validatePackageRoots(roots, providerRoot, kernelRoot) {
  const kernel = await import(pathToFileURL(join(kernelRoot, 'dist', 'src', 'runtime', 'serviceRegistry.js')).href);
  const validator = await kernel.loadPackageValidator(providerRoot);
  const out = [];
  for (const root of roots) out.push({ root, ...(await validator.validate(root)) });
  return out;
}

/** A lock line without its peer-context suffixes: `5.0.3(vite@8.3.1(esbuild@0.28.2))` → `5.0.3`. */
function withoutPeerContext(line) {
  let out = line;
  for (let prev = ''; prev !== out; ) {
    prev = out;
    out = out.replace(/\([^()]*\)/g, '');
  }
  return out;
}

/** A lock text without its `importers:` sections (every document) — those are compared per entry. */
function withoutImporters(text) {
  const out = [];
  let inImporters = false;
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) inImporters = line === 'importers:';
    if (!inImporters) out.push(line);
  }
  return out.join('\n');
}

/**
 * Tracked `packages:`/`snapshots:` lines a resolved lock lost (multiset): empty
 * = every tracked resolution survived. Compared VERSION-wise — a local package
 * can widen the peer context of a shared dependency (an optional peer it brings
 * into the graph lands in the suffix), which moves no version. The importers
 * are not part of this multiset: a context-free `version:` line from one
 * importer could stand in for another's, so `importerLockDrift` compares them
 * entry by entry.
 *
 * @param {string} trackedText
 * @param {string} currentText
 * @returns {string[]}
 */
export function lostLockLines(trackedText, currentText) {
  const count = new Map();
  for (const line of withoutImporters(currentText).split('\n').map(withoutPeerContext)) count.set(line, (count.get(line) ?? 0) + 1);
  const lost = [];
  for (const line of withoutImporters(trackedText).split('\n').map(withoutPeerContext)) {
    const left = count.get(line) ?? 0;
    if (left === 0) lost.push(line);
    else count.set(line, left - 1);
  }
  return lost;
}

/** Add the `local/*` member glob to a pnpm-workspace.yaml text (only when sources exist). */
export function withLocalMemberGlob(yamlText) {
  const marker = /^packages:\n/m;
  if (!marker.test(yamlText)) throw new Error('pnpm-workspace.yaml has no top-level `packages:` list');
  const next = yamlText.replace(marker, `packages:\n  - '${LOCAL_DIR}/*'\n`);
  if (next.split(`- '${LOCAL_DIR}/*'`).length !== 2) throw new Error('local member glob not inserted exactly once');
  return next;
}

export function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

// ---------------------------------------------------------------------------
// Builder subcommands
// ---------------------------------------------------------------------------

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (text.length < 3) throw new Error(`refusing to write an empty manifest to ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Symlinks under `root` whose target leaves `root` (they would dangle in the build). */
function escapingSymlinks(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(abs);
        const resolved = isAbsolute(target) ? target : resolve(dir, target);
        if (resolved !== root && !resolved.startsWith(root + sep)) out.push(relative(root, abs));
      } else if (entry.isDirectory()) {
        walk(abs);
      }
    }
  };
  walk(root);
  return out;
}

/** The single top-level directory npm/pnpm pack writes (`package/` by convention). */
export function unpackTarball(file, into) {
  const tmp = mkdtempSync(join(dirname(into), '.unpack-'));
  const res = spawnSync('tar', ['-xzf', file, '-C', tmp], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`cannot unpack ${basename(file)}: ${(res.stderr || '').trim()}`);
  const tops = readdirSync(tmp);
  if (tops.length !== 1) throw new Error(`${basename(file)} holds ${tops.length} top-level entries, a packed package holds one`);
  return { root: join(tmp, tops[0]), cleanup: () => rmSync(tmp, { recursive: true, force: true }) };
}

function stage(wsDir, slotsDir, outDir) {
  const hostManifest = readJson(join(wsDir, 'neuralis', 'package.json'));
  const listed = listLocalSources(hostManifest);
  const workspaceYaml = readFileSync(join(wsDir, 'pnpm-workspace.yaml'), 'utf8');
  mkdirSync(join(outDir, 'neuralis'), { recursive: true });
  mkdirSync(join(outDir, LOCAL_DIR), { recursive: true });
  mkdirSync(join(outDir, LOCAL_TGZ_DIR), { recursive: true });
  mkdirSync(join(outDir, 'local-manifests', LOCAL_DIR), { recursive: true });

  if (listed.length === 0) {
    writeJson(join(outDir, 'neuralis', 'package.json'), hostManifest);
    writeFileSync(join(outDir, 'pnpm-workspace.yaml'), workspaceYaml);
    console.log('[build-workspace] no local packages');
    return;
  }

  const problems = [];
  if (listed.length > LOCAL_SOURCE_SLOTS) {
    problems.push(`${listed.length} local packages, the build takes at most ${LOCAL_SOURCE_SLOTS}`);
  }
  // Host paths are compared, never read: a relative spec resolves against a
  // fixed stand-in for the host's neuralis/ folder, consistently on both sides.
  const hostDir = '/host/neuralis';
  const registered = new Map(listed.map((s) => [resolve(hostDir, s.path), localSourceDirName(s.name)]));
  const nextHost = JSON.parse(JSON.stringify(hostManifest));
  let members = 0;

  listed.slice(0, LOCAL_SOURCE_SLOTS).forEach((source, slot) => {
    const dirName = localSourceDirName(source.name);
    const slotDir = join(slotsDir, String(slot));
    const hasContext = existsSync(slotDir) && readdirSync(slotDir).length > 0;
    if (!hasContext) {
      problems.push(
        `${source.name}: the build received no context for ${source.spec} — run pnpm neuralis:rebuild ` +
          '(it regenerates the compose build contexts before building)',
      );
      return;
    }
    if (source.kind === 'tgz') {
      const file = join(slotDir, basename(source.path));
      if (!existsSync(file)) {
        problems.push(`${source.name}: ${basename(source.path)} is not in its build context`);
        return;
      }
      const unpacked = unpackTarball(file, join(outDir, LOCAL_TGZ_DIR, dirName));
      try {
        const { problems: own } = prepareLocalManifest(readJson(join(unpacked.root, 'package.json')), {
          name: source.name, kind: 'tgz', hostPackageDir: resolve(hostDir, dirname(source.path)), registered,
        });
        problems.push(...own);
      } finally {
        unpacked.cleanup();
      }
      cpSync(file, join(outDir, LOCAL_TGZ_DIR, `${dirName}.tgz`));
      nextHost.dependencies[source.name] = `file:../${LOCAL_TGZ_DIR}/${dirName}.tgz`;
      return;
    }
    const target = join(outDir, LOCAL_DIR, dirName);
    cpSync(slotDir, target, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (src) => src === slotDir || !isDropped(basename(src)),
    });
    const escaping = escapingSymlinks(target);
    if (escaping.length > 0) {
      problems.push(`${source.name}: symlink(s) leave the package and would dangle in the build: ${escaping.join(', ')}`);
    }
    const prepared = prepareLocalManifest(readJson(join(target, 'package.json')), {
      name: source.name, kind: 'dir', hostPackageDir: resolve(hostDir, source.path), registered,
    });
    problems.push(...prepared.problems);
    writeJson(join(target, 'package.json'), prepared.manifest);
    writeJson(join(outDir, 'local-manifests', LOCAL_DIR, dirName, 'package.json'), prepared.manifest);
    nextHost.dependencies[source.name] = `file:../${LOCAL_DIR}/${dirName}`;
    members += 1;
  });

  if (problems.length > 0) {
    console.error('[build-workspace] the local packages cannot be built:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  writeJson(join(outDir, 'neuralis', 'package.json'), nextHost);
  writeFileSync(join(outDir, 'pnpm-workspace.yaml'), members > 0 ? withLocalMemberGlob(workspaceYaml) : workspaceYaml);
  console.log(`[build-workspace] ${listed.length} local package(s): ${listed.map((s) => s.name).join(', ')}`);
}

/**
 * Every importer dependency of a lock, keyed `importer › field › name`, with its
 * specifier and its version without the peer context.
 */
function importerEntries(lockText) {
  const entries = new Map();
  let inImporters = false;
  let importer = null;
  let field = null;
  let dep = null;
  let specifier = null;
  const unquote = (s) => s.replace(/^'|'$/g, '');
  for (const line of lockText.split('\n')) {
    if (/^\S/.test(line)) {
      inImporters = line === 'importers:';
      importer = null;
      continue;
    }
    if (!inImporters) continue;
    let m;
    if (/^ {2}\S/.test(line)) {
      importer = unquote(line.trim().replace(/:.*$/, ''));
      field = null;
      dep = null;
    } else if ((m = line.match(/^ {4}(\S+):\s*$/))) {
      field = m[1];
      dep = null;
    } else if ((m = line.match(/^ {6}(\S.*?):\s*$/))) {
      dep = unquote(m[1]);
      specifier = null;
    } else if ((m = line.match(/^ {8}specifier:\s*(.*)$/))) {
      specifier = m[1];
    } else if ((m = line.match(/^ {8}version:\s*(.*)$/)) && importer !== null && field !== null && dep !== null) {
      entries.set(`${importer} › ${field} › ${dep}`, { importer, name: dep, specifier, version: withoutPeerContext(m[1]) });
    }
  }
  return entries;
}

/**
 * How a resolve departs from the tracked lock's importers, entry by entry over
 * every importer this build workspace holds: `moved` = a tracked
 * `(dependency, specifier, version)` that changed or vanished; `unlocked` = a
 * dependency the tracked lock does not carry, in ANY importer but a local
 * package's own (`local/*`, resolved in-build by design) — a registry
 * dependency enters through the tracked lock (the zero-local build refuses it
 * frozen), never floats in here. The host's lines for the local packages
 * themselves carry build-side specs and are skipped on both sides.
 *
 * @param {string} trackedText
 * @param {string} currentText
 * @param {Set<string>} localNames
 * @param {(importer: string) => boolean} [importerPresent]
 * @returns {{ moved: string[]; unlocked: string[] }}
 */
export function importerLockDrift(trackedText, currentText, localNames, importerPresent = (_importer) => true) {
  const tracked = importerEntries(trackedText);
  const current = importerEntries(currentText);
  const moved = [];
  const unlocked = [];
  for (const [key, t] of tracked) {
    if (!importerPresent(t.importer) || localNames.has(t.name)) continue;
    const c = current.get(key);
    if (!c) moved.push(`${key}: ${t.specifier} ${t.version} → (gone)`);
    else if (c.specifier !== t.specifier || c.version !== t.version) {
      moved.push(`${key}: ${t.specifier} ${t.version} → ${c.specifier} ${c.version}`);
    }
  }
  for (const [key, c] of current) {
    if (tracked.has(key) || localNames.has(c.name)) continue;
    if (c.importer.startsWith(`${LOCAL_DIR}/`)) continue;
    unlocked.push(key);
  }
  return { moved: moved.sort(), unlocked: unlocked.sort() };
}

function verifyLock(trackedPath, currentPath, wsRoot) {
  const present = (importer) => existsSync(join(wsRoot, importer === '.' ? '' : importer, 'package.json'));
  const trackedText = readFileSync(trackedPath, 'utf8');
  const currentText = readFileSync(currentPath, 'utf8');
  const localNames = new Set(listLocalSources(readJson(join(wsRoot, 'neuralis', 'package.json'))).map((s) => s.name));
  const { moved, unlocked } = importerLockDrift(trackedText, currentText, localNames, present);
  if (unlocked.length > 0) {
    console.error(`[build-workspace] dependency not in the tracked lock (${unlocked.length}) — run pnpm install on the host and commit pnpm-lock.yaml:`);
    for (const entry of unlocked.slice(0, 20)) console.error(`  - ${entry}`);
    process.exit(1);
  }
  const lost = [...moved, ...lostLockLines(trackedText, currentText)];
  if (lost.length > 0) {
    console.error(`[build-workspace] the local packages' resolve changed ${lost.length} tracked lock entr(ies):`);
    for (const line of lost.slice(0, 20)) console.error(`  - ${line}`);
    console.error('  Their own dependencies must not move a version the tracked pnpm-lock.yaml pins.');
    process.exit(1);
  }
  console.log('[build-workspace] every tracked lock entry survived the local resolve');
}

/**
 * The tarballs a kept build lock pins whose staged bytes no longer match. A
 * tarball is staged at a version-free path (`local-tgz/<dir>.tgz`), so a
 * repacked package lands on the SAME path; the kept lock still carries the old
 * sha512, and pnpm fails `ERR_PNPM_TARBALL_INTEGRITY` instead of re-resolving.
 * A folder member needs no such check: its entry is a directory resolution with
 * no integrity, and a changed `package.json` is re-read by the non-frozen
 * install (measured on pnpm 12.6.0).
 *
 * @returns {string[]} one line per stale tarball, naming it
 */
export function staleLockedTarballs(lockText, wsRoot) {
  const stale = [];
  const re = /resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+), tarball: file:(local-tgz\/[^,}\s]+)\}/g;
  for (const m of lockText.matchAll(re)) {
    const [, integrity, rel] = m;
    const file = join(wsRoot, rel);
    if (!existsSync(file)) continue;
    const actual = `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`;
    if (actual !== integrity) stale.push(`${rel}: the kept lock pins ${integrity.slice(0, 19)}…, the staged tarball is ${actual.slice(0, 19)}…`);
  }
  return stale;
}

/** The importer keys of a lock, every document (`.`, `neuralis`, `local/<dir>`, …). */
function lockImporters(lockText) {
  const out = new Set();
  let inImporters = false;
  for (const line of lockText.split('\n')) {
    if (/^\S/.test(line)) {
      inImporters = line === 'importers:';
      continue;
    }
    const m = inImporters ? line.match(/^ {2}(\S.*?):(\s.*)?$/) : null;
    if (m) out.add(m[1].replace(/^'|'$/g, ''));
  }
  return out;
}

/**
 * Why a kept build lock does not describe THIS build's workspace, or [] when it
 * does. It fits only when its importers are exactly the ones the build holds (the
 * tracked importers present here, plus every `local/<dir>` member) and its host
 * importer names exactly the local packages the host manifest registers. A
 * removed local package otherwise stays in the lock with its own dependencies,
 * which a non-frozen install keeps resolving — a private one included.
 *
 * @returns {string[]}
 */
export function lockImporterMismatch(keptText, trackedText, wsRoot) {
  const present = (importer) => existsSync(join(wsRoot, importer === '.' ? '' : importer, 'package.json'));
  const current = new Set([...lockImporters(trackedText)].filter(present));
  const localRoot = join(wsRoot, LOCAL_DIR);
  if (existsSync(localRoot)) {
    for (const dir of readdirSync(localRoot)) {
      if (existsSync(join(localRoot, dir, 'package.json'))) current.add(`${LOCAL_DIR}/${dir}`);
    }
  }
  const kept = lockImporters(keptText);
  const problems = [];
  const gone = [...kept].filter((i) => !current.has(i)).sort();
  const added = [...current].filter((i) => !kept.has(i)).sort();
  if (gone.length > 0) problems.push(`it holds importer(s) this build does not: ${gone.join(', ')}`);
  if (added.length > 0) problems.push(`this build holds importer(s) it does not: ${added.join(', ')}`);
  const hostManifest = join(wsRoot, 'neuralis', 'package.json');
  const registered = existsSync(hostManifest) ? listLocalSources(readJson(hostManifest)).map((s) => s.name).sort() : [];
  const locked = [...importerEntries(keptText).values()]
    .filter((e) => e.importer === 'neuralis' && e.version.startsWith('file:'))
    .map((e) => e.name)
    .sort();
  if (registered.join('\n') !== locked.join('\n')) {
    problems.push(`its host importer names the local package(s) [${locked.join(', ')}], the host registers [${registered.join(', ')}]`);
  }
  return problems;
}

function lockBase(buildlockDir, trackedPath, wsRoot = process.cwd()) {
  const lock = join(buildlockDir, 'pnpm-lock.yaml');
  const recorded = join(buildlockDir, 'tracked-lock.sha256');
  if (!existsSync(lock) || !existsSync(recorded)) process.exit(1);
  const trackedText = readFileSync(trackedPath, 'utf8');
  if (readFileSync(recorded, 'utf8').trim() !== sha256Text(trackedText)) {
    console.log('[build-workspace] exported build lock is for another tracked lock — resolving fresh');
    process.exit(1);
  }
  const mismatch = lockImporterMismatch(readFileSync(lock, 'utf8'), trackedText, wsRoot);
  if (mismatch.length > 0) {
    console.log('[build-workspace] exported build lock is for another set of local packages — resolving fresh:');
    for (const line of mismatch) console.log(`  - ${line}`);
    process.exit(1);
  }
  const stale = staleLockedTarballs(readFileSync(lock, 'utf8'), wsRoot);
  if (stale.length > 0) {
    console.log(`[build-workspace] exported build lock pins ${stale.length} tarball(s) that changed since — resolving fresh:`);
    for (const line of stale) console.log(`  - ${line}`);
    process.exit(1);
  }
  console.log('[build-workspace] exported build lock fits — the local packages resolve from it');
  process.exit(0);
}

/**
 * Refuse before pnpm touches the network when a private scope this build needs
 * has no route in the build `.npmrc` (`unroutedPrivateScopes`): the evidence is
 * the tracked and kept locks, the host and local manifests (a tarball's from
 * inside it) and the private-scope record that arrives beside the kept lock.
 */
function scopeRoutes(buildlockDir, trackedPath, wsRoot, npmrcPath) {
  let record;
  try {
    record = readPrivateScopeRecord(buildlockDir);
  } catch (err) {
    console.error(`[build-workspace] the private-scope record ${err instanceof Error ? err.message : String(err)} (<NEURALIS_HOME>/build/${PRIVATE_SCOPES_FILE})`);
    process.exit(1);
  }
  const lockTexts = [trackedPath, join(buildlockDir, 'pnpm-lock.yaml')].filter((p) => existsSync(p)).map((p) => readFileSync(p, 'utf8'));
  const localRoot = join(wsRoot, LOCAL_DIR);
  const tgzRoot = join(wsRoot, LOCAL_TGZ_DIR);
  const manifestPaths = [
    join(wsRoot, 'neuralis', 'package.json'),
    ...(existsSync(localRoot) ? readdirSync(localRoot).map((dir) => join(localRoot, dir, 'package.json')) : []),
  ];
  const manifests = [
    ...manifestPaths.filter((p) => existsSync(p)).map(readJson),
    ...(existsSync(tgzRoot) ? readdirSync(tgzRoot).filter((f) => f.endsWith('.tgz')).map((f) => readTarballManifest(join(tgzRoot, f))) : []),
  ].filter(Boolean);
  const npmrcText = npmrcPath && existsSync(npmrcPath) ? readFileSync(npmrcPath, 'utf8') : '';
  const unrouted = unroutedPrivateScopes({ lockTexts, manifests, npmrcText, record });
  if (unrouted.length === 0) return;
  console.error('[build-workspace] a private scope has no registry route — pnpm would ask the PUBLIC registry for it, so nothing is resolved:');
  for (const u of unrouted) console.error(`  - ${describeUnroutedScope(u)}`);
  console.error('  Or remove the package that needs it: pnpm neuralis:pkg remove <name>');
  if (unrouted.some((u) => record.has(u.scope))) console.error(`  A recorded scope that is public now: delete its entry from <NEURALIS_HOME>/build/${PRIVATE_SCOPES_FILE} (the record never forgets one by itself).`);
  process.exit(1);
}

function exportLock(lockPath, trackedPath, outDir) {
  mkdirSync(outDir, { recursive: true });
  cpSync(lockPath, join(outDir, 'pnpm-lock.yaml'));
  writeFileSync(join(outDir, 'tracked-lock.sha256'), `${sha256Text(readFileSync(trackedPath, 'utf8'))}\n`);
}

function run(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: 'inherit' });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

/**
 * Build the workspace member in cwd: its `build` script, then — when it declares
 * `neuralis.app.module` — its UI module through the kernel CLI by NODE PATH. The
 * `neuralis-build` bin link is created at install time, before the kernel's
 * dist exists, so it is never there to call.
 */
function buildPackage(kernelRoot) {
  const manifest = readJson('package.json');
  if (typeof manifest.scripts?.build === 'string') run('pnpm', ['run', 'build']);
  if (manifest.neuralis?.app?.module) {
    if (typeof manifest.scripts?.['build:ui'] !== 'string') {
      console.error(`[build-workspace] ${manifest.name} declares neuralis.app.module but no "build:ui" script`);
      process.exit(1);
    }
    run('node', [join(kernelRoot, 'dist', 'src', 'cli', 'neuralis-build.js'), 'ui', '.']);
  }
}

/**
 * Every installed package's UI module against THIS build's host API and React,
 * and its entry for the install export the host attaches through (read off the
 * built file, prebuilt modules included — no package code runs).
 */
async function uiCompat(deployRoot, kernelRoot, outFile) {
  const kernel = await import(pathToFileURL(join(kernelRoot, 'dist', 'src', 'client', 'sharedModules.js')).href);
  const uiBuild = await import(pathToFileURL(join(kernelRoot, 'dist', 'src', 'runtime', 'uiBuild.js')).href);
  const nm = join(deployRoot, 'node_modules');
  const hostReactMajor = Number.parseInt(readJson(join(nm, 'react', 'package.json')).version, 10);
  const names = [];
  for (const entry of readdirSync(nm)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) for (const sub of readdirSync(join(nm, entry))) names.push(`${entry}/${sub}`);
    else names.push(entry);
  }
  const refused = [];
  let checked = 0;
  for (const name of names.sort()) {
    let manifest;
    try {
      manifest = readJson(join(nm, name, 'package.json'));
    } catch {
      continue;
    }
    if (!manifest?.neuralis?.app?.module) continue;
    checked += 1;
    let raw = null;
    try {
      raw = readJson(join(nm, name, 'dist', 'app', kernel.UI_MODULE_RECORD_FILE));
    } catch (err) {
      refused.push({ packageId: name, reason: err?.code === 'ENOENT' ? 'not-built' : 'shared-imports-unreadable' });
      continue;
    }
    const verdict = kernel.checkUiModuleBuildRecord(raw, hostReactMajor);
    if ('reason' in verdict) {
      refused.push({ packageId: name, reason: verdict.reason });
      continue;
    }
    let exports = [];
    try {
      exports = await uiBuild.readUiModuleEntryExports(join(nm, name, manifest.neuralis.app.module.entry));
    } catch {
      /* an unreadable entry exports nothing the host can call */
    }
    if (!exports.some((e) => kernel.UI_MODULE_INSTALL_EXPORT.test(e))) refused.push({ packageId: name, reason: 'no-install-export' });
  }
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify({ hostReactMajor, hostApiVersion: kernel.UI_MODULE_HOST_API_VERSION, checked, refused }, null, 2)}\n`);
  for (const r of refused) {
    console.log(`[ui-compat] ${r.packageId}: UI module refused (${r.reason}) — its owner rebuilds it with neuralis-build ui against this host`);
  }
  console.log(`[ui-compat] ${checked} UI module(s) checked, ${refused.length} refused`);
}

/**
 * Where each host dependency comes from, read off the host importer of the
 * build's resolved lock: `member` = a workspace package (`link:`), `local` = a
 * local folder or tarball this build staged (`file:` — the local-source rule),
 * `registry` = anything else.
 *
 * @returns {Map<string, 'member' | 'local' | 'registry'>}
 */
export function hostDependencyLanes(hostManifest, lockText, importer = 'neuralis') {
  const entries = importerEntries(lockText);
  const deps = hostManifest?.dependencies ?? {};
  const lanes = new Map();
  for (const name of Object.keys(deps)) {
    const version = entries.get(`${importer} › dependencies › ${name}`)?.version ?? '';
    lanes.set(
      name,
      version.startsWith('link:') ? 'member' : isLocalSourceSpec(deps[name]) || version.startsWith('file:') ? 'local' : 'registry',
    );
  }
  return lanes;
}

/**
 * Decide every set-level conflict (two packages claiming one singular contract,
 * overlapping OAuth prefixes, one config key) by SOURCE, never by name:
 * - a workspace member against any other package: the other is the newcomer —
 *   a local one FAILS the build, a registry one is REFUSED;
 * - what remains is judged again over the set without those refusals: two
 *   members, or any local contender, FAIL the build (every local one named);
 *   two registry packages are both REFUSED — except a package that provides a
 *   REQUIRED contract (the platform's runtime), which is never the one left
 *   out; when BOTH provide one, no source decides and the build FAILS.
 * Every message names both packages and the contract or key.
 *
 * @param {string[]} names the builtin set, in host order
 * @param {(names: string[]) => Array<{ packages: [string, string]; message: string }>} findConflicts
 * @param {Map<string, 'member' | 'local' | 'registry'>} lanes
 * @param {Set<string>} platformRoots packages that provide a required contract
 * @returns {{ refused: Map<string, string[]>; failed: Map<string, string[]> }}
 */
export function decideSetConflicts(names, findConflicts, lanes, platformRoots) {
  const refused = new Map();
  const failed = new Map();
  const note = (map, id, message) => {
    const list = map.get(id) ?? [];
    if (!list.includes(message)) list.push(message);
    map.set(id, list);
  };
  const live = () => names.filter((n) => !refused.has(n));
  const isMember = (id) => lanes.get(id) === 'member';
  for (const { packages: [a, b], message } of findConflicts(live())) {
    if (isMember(a) === isMember(b)) continue;
    const newcomer = isMember(a) ? b : a;
    note(lanes.get(newcomer) === 'local' ? failed : refused, newcomer, message);
  }
  for (const { packages: [a, b], message } of findConflicts(live())) {
    if (isMember(a) !== isMember(b)) continue;
    if (isMember(a)) {
      note(failed, a, message);
      note(failed, b, message);
      continue;
    }
    const locals = [a, b].filter((id) => lanes.get(id) === 'local');
    if (locals.length > 0) {
      for (const id of locals) note(failed, id, message);
      continue;
    }
    const kept = [a, b].filter((id) => platformRoots.has(id));
    if (kept.length === 2) {
      note(failed, a, message);
      note(failed, b, message);
      continue;
    }
    for (const id of [a, b]) if (kept[0] !== id) note(refused, id, message);
  }
  return { refused, failed };
}

/**
 * Every installed builtin-class dependency against the runtime provider's
 * admission predicate — the check the loader runs at boot, here before the
 * image exists — and then the whole set against the set-level conflicts no
 * per-package check can see (`decideSetConflicts`). A package THIS build built
 * (a workspace member or a local source, by the lock) that fails FAILS the
 * build, every one named with its messages; a REGISTRY package is
 * refused-and-named (printed, kept in the record) and the build goes on —
 * unless it provides a REQUIRED contract, which no boot can run without, so it
 * fails the build like a package built here. The boot reads the record
 * (`_runtime/build/validate.json`) and leaves every refused package out before
 * its own set-level checks.
 */
async function validateInstalled(deployRoot, kernelRoot, hostManifestPath, lockPath, outFile) {
  const hostManifest = readJson(hostManifestPath);
  const deps = hostManifest.dependencies ?? {};
  const nm = join(deployRoot, 'node_modules');
  const lanes = hostDependencyLanes(hostManifest, readFileSync(lockPath, 'utf8'));
  const providerRoot = runtimeProviderRoot(hostManifest, (name) => join(nm, name));
  if (!providerRoot) {
    console.error('[validate] no dependency provides the runtime contract — nothing can judge the packages');
    process.exit(1);
  }
  const roots = [];
  for (const name of Object.keys(deps).sort()) {
    try {
      const block = readJson(join(nm, name, 'package.json'))?.neuralis;
      // `referenceOnly` = the contract kernel: never loaded, so never judged.
      if (block && block.referenceOnly !== true) roots.push({ name, root: join(nm, name), block });
    } catch {
      /* not installed in the runner tree — not builtin-class */
    }
  }
  const failed = [];
  const refused = [];
  // Two runtime providers: no source decides which one judges the rest, and
  // no boot could start either way.
  const runtimes = roots.filter(({ block }) => Array.isArray(block.provides) && block.provides.includes('runtime')).map((r) => r.name);
  if (runtimes.length > 1) {
    const message = `contract "runtime" is provided by ${runtimes.map((n) => `"${n}"`).join(' and ')} — exactly one provider is allowed`;
    for (const packageId of runtimes) failed.push({ packageId, errors: [message] });
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, `${JSON.stringify({ checked: roots.length, failed, refused }, null, 2)}\n`);
    console.error(`[validate] ${message}`);
    process.exit(1);
  }
  const registry = await import(pathToFileURL(join(kernelRoot, 'dist', 'src', 'runtime', 'serviceRegistry.js')).href);
  const services = await import(pathToFileURL(join(kernelRoot, 'dist', 'src', 'contracts', 'services.js')).href);
  const platformRoots = new Set(roots
    .filter(({ block }) => Array.isArray(block.provides) && block.provides.some((c) => services.REQUIRED_SERVICE_CONTRACTS.includes(c)))
    .map(({ name }) => name));
  const results = await validatePackageRoots(roots.map((r) => r.root), providerRoot, kernelRoot);
  results.forEach((res, i) => {
    if (res.errors.length === 0) return;
    const { name } = roots[i];
    if (lanes.get(name) === 'registry' && !platformRoots.has(name)) refused.push({ packageId: name, reason: 'invalid', errors: res.errors });
    else failed.push({ packageId: name, errors: res.errors });
  });

  const definitions = new Map(roots.map(({ name, block }) => [
    name,
    { id: name, provides: block.provides, configSettings: block.configSettings, access: { trust: 'first-party' } },
  ]));
  const judged = roots.map((r) => r.name).filter((name) => !refused.some((r) => r.packageId === name));
  const decided = decideSetConflicts(
    judged,
    (names) => registry.findBuiltinSetConflicts(names.map((n) => definitions.get(n))),
    lanes,
    platformRoots,
  );
  for (const [packageId, errors] of decided.refused) refused.push({ packageId, reason: 'conflict', errors });
  for (const [packageId, errors] of decided.failed) failed.push({ packageId, errors });

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify({ checked: roots.length, failed, refused }, null, 2)}\n`);
  for (const r of refused) {
    console.log(`[validate] ${r.packageId}: refused (${r.reason}) — the boot will not load it: ${r.errors.join('; ')}`);
  }
  for (const f of failed) {
    console.error(`[validate] ${f.packageId} (built here): ${f.errors.join('; ')}`);
  }
  console.log(`[validate] ${roots.length} package(s) checked, ${refused.length} refused, ${failed.length} package(s) built here failing`);
  if (failed.length > 0) {
    console.error('[validate] fix the package(s) above and rebuild — the platform would refuse them at every boot');
    process.exit(1);
  }
}

/** The resolved version of every `overrides` key in the deploy tree (printed, the pins' evidence). */
function overrides(workspaceYamlPath, deployRoot) {
  const lines = readFileSync(workspaceYamlPath, 'utf8').split('\n');
  const start = lines.findIndex((l) => /^overrides:\s*$/.test(l));
  if (start === -1) return;
  const nm = join(deployRoot, 'node_modules');
  const versionAt = (dir) => {
    try {
      return readJson(join(dir, 'package.json')).version;
    } catch {
      return null;
    }
  };
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(line)) break;
    const m = line.trim().match(/^'?([^':]+(?:>[^':]+)?)'?\s*:\s*(.+)$/);
    if (!m) continue;
    const [key, range] = [m[1], m[2]];
    const [parent, child] = key.includes('>') ? key.split('>') : [null, key];
    const found = parent
      ? versionAt(join(nm, parent, 'node_modules', child)) ?? versionAt(join(nm, child))
      : versionAt(join(nm, child));
    console.log(`[overrides] ${key} (${range}) → ${found ?? 'not in the deploy tree'}`);
  }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case 'stage': stage(args[0], args[1], args[2]); break;
    case 'verify-lock': verifyLock(args[0], args[1], args[2]); break;
    case 'lock-base': lockBase(args[0], args[1], args[2]); break;
    case 'scope-routes': scopeRoutes(args[0], args[1], args[2], args[3]); break;
    case 'export-lock': exportLock(args[0], args[1], args[2]); break;
    case 'build-package': buildPackage(args[0]); break;
    case 'ui-compat': await uiCompat(args[0], args[1], args[2]); break;
    case 'overrides': overrides(args[0], args[1]); break;
    case 'validate': await validateInstalled(args[0], args[1], args[2], args[3], args[4]); break;
    case 'release-age-excludes':
      if (args[0] && existsSync(args[0])) process.stdout.write(releaseAgeExcludeFlags(privateScopes(readFileSync(args[0], 'utf8'))).join(' '));
      break;
    default:
      console.error(`usage: build-workspace.mjs <stage|scope-routes|verify-lock|lock-base|export-lock|build-package|ui-compat|validate|overrides|release-age-excludes> …`);
      process.exit(2);
  }
}
