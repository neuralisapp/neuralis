#!/usr/bin/env node
/**
 * neuralis pkg — Register / unregister builtin-class packages in the host's
 * `package.json#dependencies`.
 *
 * Commands:
 *   add <name> --path <abs-host-dir>   a folder you develop (file:<abs-dir>) — built by the image build
 *   add <name> --tarball <x.tgz>       a packed package (file:<abs .tgz>) — installed as packed
 *   add <name> --version <x.y.z>       a registry package at an EXACT version (private scopes: .env NEURALIS_BUILD_NPMRC)
 *   remove <name>                      the deps entry (byte-exact restore), its --pkg mount, its role grants at the next boot
 *   list                               show builtin-class deps (neuralis-block carriers); on an
 *                                      install folder every operator line, registry ones included
 *
 * Every source arrives through the image `neuralis rebuild` builds: on the
 * development checkout the whole image, a real `node_modules/<name>` directory
 * for any scope or none; on an npm install folder its derived image — the
 * release image plus these lines (`planOperatorImage`, setup/compose.mts;
 * `operatorInstall`, scripts/build/build-workspace.mjs). Nothing here installs
 * anything.
 *
 * THE TRUST ACT. Presence in `neuralis/package.json#dependencies` is the
 * builtin-class authorization boundary: every dep whose own package.json
 * carries a `neuralis` block is discovered at boot and loaded IN-PROCESS with
 * host-assigned `first-party` trust — the same trust as the platform's own
 * packages. Only run this for packages you (the deploying admin) vet, exactly
 * as you vet any npm dependency.
 *
 * This script is the ONE sanctioned tooling write into a tracked file
 * (docs/architect/git.md §4.5 carve-out): the deps entry IS the admin trust
 * act and the git diff IS the audit/regulation surface. It edits the
 * dependencies map textually (single line in, single line out — `remove`
 * restores the file byte-exactly), validates JSON after every edit, and NEVER
 * commits anything. Every check runs BEFORE the write: a refused add changes
 * nothing.
 */

import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { resolveNeuralisHome, sanitizePackageId } from '@neuralis/package-system/paths';
import { providedFeatureIds } from '@neuralis/package-system/contracts';
import {
  LOCAL_SOURCE_SLOTS,
  PRIVATE_SCOPES_FILE,
  describeUnroutedScope,
  filesWhitelistProblems,
  insertDependencyLine,
  listLocalSources,
  npmrcProblems,
  prepareLocalManifest,
  privateScopes,
  readPrivateScopeRecord,
  readTarballManifest,
  releaseAgeExcludeFlags,
  runtimeProviderRoot,
  unpackTarball,
  unroutedPrivateScopes,
  validatePackageRoots,
} from './build/build-workspace.mjs';
import { CliExit, type CliContext } from './cli/registry.mts';
import { spell } from './cli/spelling.mts';
import { packageBindHostPath } from './mount/packageBind.mts';
import { loadHostEnv } from './setup/detect.mts';
import { operatorDependencies } from './setup/compose.mts';
import { HOST_CONFIG_SETTINGS } from '../src/server/config/hostConfigSettings.ts';

// ── ANSI Colors ───────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

const ok = `${c.green}✓${c.reset}`;
const fail = `${c.red}✗${c.reset}`;
const warn = `${c.yellow}⚠${c.reset}`;

// ── Paths ─────────────────────────────────────────────────────────
//
// `host` is the install folder (`ctx.installDir`): its `package.json` is the
// trust list, its `node_modules` what npm installed, its compose override the
// mounts. On the development checkout and a public clone that is the host
// package itself.

function hostPackageJsonPath(host: string): string {
  return join(host, 'package.json');
}

// ── package.json textual editing ─────────────────────────────────
//
// Deliberately NOT JSON.parse → mutate → JSON.stringify: a full re-serialize
// reformats the whole file and makes `remove` unable to restore the previous
// bytes. We insert / strip a single line inside the "dependencies" object and
// JSON.parse afterwards only to VALIDATE.

function assertValidJson(content: string, context: string): void {
  try {
    JSON.parse(content);
  } catch (err) {
    throw new Error(`${context} would produce invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function readDependencies(content: string): Record<string, string> {
  const parsed = JSON.parse(content) as { dependencies?: Record<string, string> };
  return parsed.dependencies ?? {};
}

function removeDependencyLine(content: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^[ \\t]*"${escaped}"\\s*:\\s*"[^"]*",?\\n`, 'm');
  if (!pattern.test(content)) return null;
  return content.replace(pattern, '');
}

// ── Manifests ─────────────────────────────────────────────────────

type DepManifest = {
  name?: string;
  files?: string[];
  scripts?: Record<string, string>;
  neuralis?: {
    referenceOnly?: boolean;
    requires?: { providesFeatures?: Array<string | { id: string }>; defaultRoleGrants?: Record<string, unknown[]> };
    configSettings?: Array<{ key?: string }>;
    credentials?: Array<{ id?: string }>;
    app?: unknown;
  } & Record<string, unknown>;
} & Record<string, unknown>;

// A builtin's direct-render workspace UI attaches at RUNTIME: the package
// declares `neuralis.app.module` and ships `dist/app/` built by
// `neuralis-build ui` (the image build runs it for a folder package). This
// only reports what the manifest declares — it never prints code to add.
function printUiLaneNotice(manifest: DepManifest | null): void {
  const app = (manifest?.neuralis?.app ?? {}) as {
    module?: unknown;
    surfaces?: Array<{ component?: { renderer?: unknown } }>;
  };
  const hasDirect = (app.surfaces ?? []).some((s) => s?.component?.renderer === 'direct');
  if (!hasDirect) return;
  if (app.module && typeof app.module === 'object') {
    console.log(`${c.cyan}Workspace UI:${c.reset} attaches at runtime from its \`app.module\` — no host edit.`);
    return;
  }
  console.log(`${warn} The package declares direct-render surfaces but no \`neuralis.app.module\`:`);
  console.log(`  ${c.dim}a new package's UI renders only through one. Declare it and build dist/app/ with \`neuralis-build ui\`.${c.reset}`);
}

async function readManifest(dir: string): Promise<DepManifest | null> {
  try {
    return JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8')) as DepManifest;
  } catch {
    return null;
  }
}

/** The manifest of a dependency already in the deps: its installed copy, else its local source. */
async function readDependencyManifest(host: string, name: string, spec: string): Promise<DepManifest | null> {
  const installed = await readManifest(join(host, 'node_modules', name));
  if (installed) return installed;
  if (!spec.startsWith('file:') && !spec.startsWith('link:')) return null;
  const path = resolve(host, spec.replace(/^(file|link):/, ''));
  return path.endsWith('.tgz') ? (existsSync(path) ? readTarballManifest(path) : null) : readManifest(path);
}

function warnNeuralisBlock(name: string, manifest: DepManifest): void {
  if (!manifest.neuralis || typeof manifest.neuralis !== 'object') {
    console.log(`${warn} ${name} has NO "neuralis" block — boot discovery will SKIP this package.`);
    console.log(`  ${c.dim}Add at least ${c.reset}"neuralis": {}${c.dim} (see packages/package-system README, "Distribution shape").${c.reset}`);
  } else if (manifest.neuralis.referenceOnly === true) {
    console.log(`${warn} "${name}" declares neuralis.referenceOnly — it will be readable but never loaded.`);
  }
}

/** The trust list's name as the operator sees it: the install folder's own manifest, or the host package's in a checkout. */
function trustList(folder: boolean): string {
  return folder ? 'package.json#dependencies' : 'neuralis/package.json#dependencies';
}

function printTrustNotice(name: string, spec: string, folder: boolean): void {
  console.log('');
  console.log(`${c.yellow}${c.bold}── TRUST NOTICE ─────────────────────────────────────────────${c.reset}`);
  console.log(`${c.yellow}Added ${c.bold}"${name}": "${spec}"${c.reset}${c.yellow} to ${trustList(folder)}.${c.reset}`);
  console.log(`${c.yellow}This grants the package FIRST-PARTY IN-PROCESS trust at the next${c.reset}`);
  console.log(`${c.yellow}boot — the same trust as the platform's own packages.${c.reset}`);
  if (folder) {
    console.log(`${c.yellow}  • Remove this entry deliberately — this file is the install's trust list.${c.reset}`);
    if (spec.startsWith('file:')) {
      console.log(`${c.yellow}  • A file: dep is a LOCAL package: this install's derived image builds it from${c.reset}`);
      console.log(`${c.yellow}    that path at every rebuild, so the path must stay where it is.${c.reset}`);
    }
  } else {
    console.log(`${c.yellow}  • Commit or remove this entry deliberately (the git diff is the audit trail).${c.reset}`);
  }
  if (!folder && spec.startsWith('file:')) {
    console.log(`${c.yellow}  • A file: dep is a LOCAL package: this machine's image builds it, and it${c.reset}`);
    console.log(`${c.yellow}    must NEVER enter pnpm-lock.yaml (a machine path in a tracked file) —${c.reset}`);
    console.log(`${c.yellow}    never run a plain \`pnpm install\` here while this line exists (host dev:${c.reset}`);
    console.log(`${c.yellow}    \`pnpm install --lockfile=false\`). Recovery: git checkout -- pnpm-lock.yaml${c.reset}`);
  }
  console.log(`${c.yellow}─────────────────────────────────────────────────────────────${c.reset}`);
  console.log('');
}

/** No problems ⇒ false; otherwise the refusal, through the CLI boundary — nothing was written. */
function fails(problems: string[]): boolean {
  if (problems.length === 0) return false;
  for (const p of problems.slice(0, -1)) console.log(`${fail} ${p}`);
  throw new CliExit(1, problems.at(-1)!, ['Nothing was written.']);
}

/** An exact registry version (`1.2.3`, `1.2.3-beta.1`) — a range would float past what was vetted. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** The private-registry checks for a scoped registry package, against `.env NEURALIS_BUILD_NPMRC`. */
async function registryProblems(host: string, name: string): Promise<string[]> {
  if (!name.startsWith('@')) return [];
  const scope = name.split('/')[0];
  await loadHostEnv(host);
  const npmrc = process.env.NEURALIS_BUILD_NPMRC?.trim();
  if (!npmrc) {
    console.log(`${c.dim}  No .env NEURALIS_BUILD_NPMRC: ${scope} resolves from the public registry. For a private registry, point it at an .npmrc with${c.reset}`);
    console.log(`${c.dim}  "${scope}:registry=<url>" and its token line — the build mounts it as a secret, never a layer.${c.reset}`);
    return [];
  }
  if (!existsSync(npmrc)) return [`.env NEURALIS_BUILD_NPMRC=${npmrc} — no such file`];
  const text = await readFile(npmrc, 'utf-8');
  const problems = npmrcProblems(text).map((p) => `${npmrc} ${p}`);
  if (!new RegExp(`^\\s*${scope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:registry\\s*=`, 'm').test(text)) {
    problems.push(
      `${npmrc} has no "${scope}:registry=" line — with a private registry configured, ${name} would install at ` +
        `first-party trust from the PUBLIC registry; add "${scope}:registry=<url>" and its token line first`,
    );
  }
  return problems;
}

/**
 * The scopes this package's own dependencies need that this machine has seen
 * served by a private registry (the private-scope record, the kept and tracked
 * locks) while `.env NEURALIS_BUILD_NPMRC` routes them nowhere — the image
 * build's own check (`unroutedPrivateScopes`), run before the write. A scope
 * never seen privately here is indistinguishable from a public one.
 */
async function privateScopeProblems(host: string, name: string, manifest: object): Promise<string[]> {
  await loadHostEnv(host);
  const buildDir = join(resolveNeuralisHome().home, 'build');
  let record: ReturnType<typeof readPrivateScopeRecord>;
  try {
    record = readPrivateScopeRecord(buildDir);
  } catch (err) {
    return [`the private-scope record ${err instanceof Error ? err.message : String(err)}`];
  }
  const npmrc = process.env.NEURALIS_BUILD_NPMRC?.trim();
  const npmrcText = npmrc && existsSync(npmrc) ? await readFile(npmrc, 'utf-8') : '';
  const lockTexts: string[] = [];
  for (const lock of [join(buildDir, 'pnpm-lock.yaml'), join(host, '..', 'pnpm-lock.yaml')]) {
    if (existsSync(lock)) lockTexts.push(await readFile(lock, 'utf-8'));
  }
  const unrouted = unroutedPrivateScopes({ lockTexts, manifests: [manifest], npmrcText, record });
  const problems = unrouted.map((u) => `${name} needs a private scope with no registry route — ${describeUnroutedScope(u)}`);
  if (unrouted.some((u) => record.has(u.scope))) {
    problems.push(`a recorded scope that is public now: delete its entry from ${join(buildDir, PRIVATE_SCOPES_FILE)}`);
  }
  return problems;
}

/**
 * The loader's own admission check (the runtime provider's predicate, the one
 * the boot runs) on a package root, before the trust act is written. When it
 * cannot run here — the runtime provider is not built in this tree — that is a
 * warning, not a refusal: the image build runs the same check and fails on it.
 */
async function admissionProblems(host: string, name: string, root: string): Promise<string[]> {
  const nm = join(host, 'node_modules');
  try {
    const hostManifest = JSON.parse(await readFile(hostPackageJsonPath(host), 'utf-8')) as unknown;
    const provider = runtimeProviderRoot(hostManifest, (dep: string) => realpathSync(join(nm, dep)));
    if (!provider) throw new Error('no dependency provides the runtime contract');
    const [result] = await validatePackageRoots([root], provider, realpathSync(join(nm, '@neuralis', 'package-system')));
    return (result?.errors ?? []).map((e: string) => `${name}: the runtime would refuse it — ${e}`);
  } catch (err) {
    console.log(`${warn} admission check not available here (${err instanceof Error ? err.message : String(err)}) — the image build runs it and fails on a refused package`);
    return [];
  }
}

// ── Commands ──────────────────────────────────────────────────────

async function addPackage(
  ctx: CliContext,
  name: string,
  mode: { path?: string; tarball?: string; version?: string },
): Promise<void> {
  const host = ctx.installDir;
  const pkgJsonPath = hostPackageJsonPath(host);
  const content = await readFile(pkgJsonPath, 'utf-8');
  const deps = readDependencies(content);

  if (deps[name]) {
    console.log(`${warn} "${name}" is already in dependencies (${deps[name]}). Remove it first to change the spec.`);
    // Re-affirming an existing dependency re-records it: a builtin that arrived
    // before this record existed grants its defaults to existing projects too.
    const existing = await readDependencyManifest(host, name, deps[name]);
    if (existing === null || (existing.neuralis && existing.neuralis.referenceOnly !== true)) {
      await recordAddition(name);
      console.log(`${ok} Its default role grants reach every existing project once at the next boot ${c.dim}(a grant an owner revoked by hand comes back — revoke it again in Admin → Roles)${c.reset}.`);
    }
    return;
  }

  let spec: string;
  let manifest: DepManifest | null = null;
  if (mode.path) {
    const dir = resolve(ctx.cwd, mode.path);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      fails([`Not a directory: ${dir} (resolved from ${ctx.cwd}; pass an ABSOLUTE host path)`]);
      return;
    }
    manifest = await readManifest(dir);
    if (!manifest) {
      fails([`No readable package.json in ${dir} — create the package first (name + a "neuralis" block).`]);
      return;
    }
    spec = `file:${dir}`;
    // The same build contract the image build enforces, checked here first:
    // a `link:`/`file:` spec leaving the folder (siblings must be registered
    // too), the `build` / `build:ui` scripts, and a `files` whitelist that
    // carries every first-level runtime folder.
    const registered = new Map(
      listLocalSources({ dependencies: deps })
        .filter((s) => s.kind === 'dir')
        .map((s) => [resolve(host, s.path), s.name] as const),
    );
    const { problems } = prepareLocalManifest(manifest, { name, kind: 'dir', hostPackageDir: dir, registered });
    if (fails([...problems, ...filesWhitelistProblems(manifest, dir).map((p) => `${name}: ${p}`)])) return;
    if (fails(await privateScopeProblems(host, name, manifest))) return;
    if (fails(await admissionProblems(host, name, dir))) return;
  } else if (mode.tarball) {
    const tgz = resolve(ctx.cwd, mode.tarball);
    if (!existsSync(tgz) || !statSync(tgz).isFile() || !tgz.endsWith('.tgz')) {
      fails([`Not a .tgz file: ${tgz}`]);
      return;
    }
    manifest = readTarballManifest(tgz);
    if (!manifest) {
      fails([`${tgz} holds no readable package.json — is it a packed package (npm pack / pnpm pack)?`]);
      return;
    }
    if (fails(prepareLocalManifest(manifest, { name, kind: 'tgz', hostPackageDir: dirname(tgz), registered: new Map() }).problems)) return;
    if (fails(await privateScopeProblems(host, name, manifest))) return;
    const unpacked = unpackTarball(tgz, join(tmpdir(), 'neuralis-pkg-add'));
    try {
      if (fails(await admissionProblems(host, name, unpacked.root))) return;
    } finally {
      unpacked.cleanup();
    }
    spec = `file:${tgz}`;
  } else if (mode.version) {
    if (!EXACT_VERSION.test(mode.version)) {
      fails([`--version takes an EXACT version (e.g. 1.4.2), not "${mode.version}" — the image installs through the lock, and a range would float past what you vetted.`]);
      return;
    }
    if (fails(await privateScopeProblems(host, name, { dependencies: { [name]: mode.version } }))) return;
    if (fails(await registryProblems(host, name))) return;
    spec = mode.version;
  } else {
    fails(['One of --path <dir>, --tarball <x.tgz> or --version <x.y.z> is required.']);
    return;
  }

  if (spec.startsWith('file:') && listLocalSources({ dependencies: deps }).length >= LOCAL_SOURCE_SLOTS) {
    fails([`the image build takes at most ${LOCAL_SOURCE_SLOTS} local packages — remove one first (${spell('pkg remove <name>', ctx)}).`]);
    return;
  }

  const updated = insertDependencyLine(content, name, spec);
  assertValidJson(updated, `Adding "${name}"`);
  await writeFile(pkgJsonPath, updated, 'utf-8');

  if (manifest) warnNeuralisBlock(name, manifest);
  // A package with no `neuralis` block is no builtin, so it has no grants; an
  // unread registry manifest (`--version`) is recorded and settled at the boot.
  // A reference-only block is never loaded, so it never becomes a builtin.
  if (!manifest || (manifest.neuralis && manifest.neuralis.referenceOnly !== true)) {
    await recordAddition(name);
    console.log(`${ok} Its default role grants reach every existing project once at the next boot that carries it ${c.dim}(new projects get them at creation)${c.reset}.`);
  }
  const folder = operatorDependencies(JSON.parse(updated)) !== null;
  printTrustNotice(name, spec, folder);
  printUiLaneNotice(manifest);

  console.log(
    `${c.cyan}Next step:${c.reset} ${c.bold}${spell('rebuild', ctx)}${c.reset} ${c.dim}— ` +
      (folder ? `builds this install's own image: the release image plus its operator packages, ${name} among them` : `installs it into the image as node_modules/${name}`) +
      c.reset,
  );
  if (mode.path) {
    console.log(`  ${c.dim}Then, to edit it live: ${c.reset}${c.bold}${spell(`mount add ${mode.path} --pkg ${name}`, ctx)}${c.reset}${c.dim} (binds the folder over that`);
    console.log(`  installed copy) and ${c.reset}${c.bold}${spell(`sync ${name}`, ctx)}${c.reset}${c.dim} after each edit (builds it in its folder).${c.reset}`);
  } else if (mode.version && !folder) {
    // A private scope's fresh release is the operator's own: lift the one-day
    // `minimumReleaseAge` for that scope only, on this command line.
    const npmrc = process.env.NEURALIS_BUILD_NPMRC?.trim();
    const scope = name.split('/')[0];
    const ageFlags = npmrc && existsSync(npmrc) && privateScopes(await readFile(npmrc, 'utf-8')).includes(scope)
      ? ` ${releaseAgeExcludeFlags([scope]).join(' ')}`
      : '';
    console.log(`  ${c.dim}The tracked lock must carry it first: ${c.reset}${c.bold}pnpm install${ageFlags}${c.reset}${c.dim} here, and commit pnpm-lock.yaml with this line —`);
    console.log(`  the image build installs FROZEN and refuses a dependency the lock does not carry.${c.reset}`);
  }
}

type GrantChanges = {
  removals: Array<{ packageId: string; features: string[]; removedAt: string }>;
  additions: Array<{ packageId: string; addedAt: string }>;
};

/**
 * Where `add` / `remove` record a builtin's grant change for the next boot —
 * the host's `reconcileBuiltinGrantChanges` applies an addition's default
 * grants to every existing project once, and revokes a removal's features no
 * loaded package still provides.
 */
function grantChangesPath(): string {
  return join(resolveNeuralisHome().home, 'app', 'config', 'builtin-removals.json');
}

/** Read-modify-write the record; written through a rename, deleted when empty. */
async function updateGrantChanges(change: (records: GrantChanges) => GrantChanges): Promise<void> {
  const file = grantChangesPath();
  let records: GrantChanges = { removals: [], additions: [] };
  try {
    const raw = JSON.parse(await readFile(file, 'utf-8')) as Partial<GrantChanges>;
    records = {
      removals: Array.isArray(raw.removals) ? raw.removals : [],
      additions: Array.isArray(raw.additions) ? raw.additions : [],
    };
  } catch {
    /* no record yet */
  }
  const next = change(records);
  if (next.removals.length === 0 && next.additions.length === 0) {
    await rm(file, { force: true });
    return;
  }
  const text = `${JSON.stringify(next, null, 2)}\n`;
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(`${file}.tmp`, text, 'utf-8');
  await rename(`${file}.tmp`, file);
}

/** An added package: drop its pending removal, (re)record the addition. */
async function recordAddition(name: string): Promise<void> {
  await updateGrantChanges(({ removals, additions }) => ({
    removals: removals.filter((r) => r.packageId !== name),
    additions: [...additions.filter((a) => a.packageId !== name), { packageId: name, addedAt: new Date().toISOString() }],
  }));
}

/**
 * A removed package: drop its pending addition, and record its default-granted
 * features (none → no removal record) — an earlier record for it is replaced.
 */
async function recordRemoval(name: string, features: string[]): Promise<void> {
  await updateGrantChanges(({ removals, additions }) => ({
    removals: [
      ...removals.filter((r) => r.packageId !== name),
      ...(features.length > 0 ? [{ packageId: name, features, removedAt: new Date().toISOString() }] : []),
    ],
    additions: additions.filter((a) => a.packageId !== name),
  }));
}

/** What the package leaves behind as user data, with how to delete each. */
function printLeftovers(name: string, manifest: DepManifest | null): void {
  const home = resolveNeuralisHome().home;
  const slug = sanitizePackageId(name);
  const zones: string[] = [];
  const global = join(home, 'app', 'data', slug);
  if (existsSync(global)) zones.push(global);
  const projectsRoot = join(home, 'projects');
  if (existsSync(projectsRoot)) {
    for (const pid of readdirSync(projectsRoot)) {
      const zone = join(projectsRoot, pid, 'data', slug);
      if (existsSync(zone)) zones.push(zone);
    }
  }
  // A key the HOST owns was never the package's (the boot refuses such a
  // declarer) — it is no leftover of this package.
  const hostKeys = new Set(HOST_CONFIG_SETTINGS.map((s) => s.key));
  const configKeys = (manifest?.neuralis?.configSettings ?? [])
    .map((s) => s.key)
    .filter((k): k is string => typeof k === 'string' && !hostKeys.has(k));
  const credentials = (manifest?.neuralis?.credentials ?? []).map((s) => s.id).filter((k): k is string => typeof k === 'string');

  console.log('');
  console.log(`${c.cyan}Left in place (user data — the package's, not the platform's):${c.reset}`);
  if (zones.length === 0 && configKeys.length === 0 && credentials.length === 0) {
    console.log(`  ${c.dim}nothing found${c.reset}`);
    return;
  }
  for (const zone of zones) console.log(`  data zone   ${zone}\n              ${c.dim}delete:${c.reset} rm -rf ${JSON.stringify(zone)}`);
  if (configKeys.length > 0) {
    console.log(`  config keys ${configKeys.join(', ')}`);
    console.log(`              ${c.dim}delete: remove them from ${join(home, 'app', 'config', 'platform.json')} (Admin → Config shows a stored value)${c.reset}`);
  }
  if (credentials.length > 0) {
    console.log(`  credentials ${credentials.join(', ')}`);
    console.log(`              ${c.dim}delete: Admin → Credentials, at every scope that holds one${c.reset}`);
  }
}

async function removePackage(ctx: CliContext, name: string): Promise<void> {
  const host = ctx.installDir;
  const pkgJsonPath = hostPackageJsonPath(host);
  const content = await readFile(pkgJsonPath, 'utf-8');
  const spec = readDependencies(content)[name];

  const updated = removeDependencyLine(content, name);
  if (updated === null || spec === undefined) {
    console.log(`${warn} "${name}" is not in ${trustList(operatorDependencies(JSON.parse(content)) !== null)}.`);
    return;
  }
  // Read BEFORE the line goes: the next image no longer carries the package, so
  // this is the last moment its provided features are knowable.
  const manifest = await readDependencyManifest(host, name, spec);
  assertValidJson(updated, `Removing "${name}"`);
  await writeFile(pkgJsonPath, updated, 'utf-8');
  console.log(`${ok} Removed "${name}" from ${trustList(operatorDependencies(JSON.parse(updated)) !== null)}.`);

  // Only what the package's own manifest GRANTS by default is revoked — the
  // grants the platform wrote for it; a package with none leaves no record.
  const requires = manifest?.neuralis?.requires;
  const provided = new Set(providedFeatureIds(requires?.providesFeatures as Parameters<typeof providedFeatureIds>[0]));
  const features = [...new Set(Object.values(requires?.defaultRoleGrants ?? {}).flat())].filter(
    (f): f is string => typeof f === 'string' && provided.has(f),
  );
  await recordRemoval(name, features);
  if (manifest?.neuralis && features.length > 0) {
    console.log(
      `${ok} Its default role grants go at the next boot: ${features.join(', ')}` +
        ` ${c.dim}(a feature another loaded package provides stays)${c.reset}`,
    );
    console.log(`${ok} A grant an owner gave by hand stays on its role (inert while nothing provides it) — revoke it in Admin → Roles.`);
  } else if (manifest?.neuralis) {
    console.log(`${ok} It grants no role a feature by default — nothing to revoke at the next boot.`);
  } else {
    console.log(`${warn} Its manifest is not readable here, so no role grant can be revoked automatically — an owner revokes them in Admin → Roles.`);
  }

  const override = join(host, 'docker-compose.override.yml');
  const overrideText = existsSync(override) ? await readFile(override, 'utf-8') : '';
  if (packageBindHostPath(overrideText, name) !== null) {
    // The mount verb, in-process through the same boundary — never a second CLI run.
    const { run: mount } = await import('./mount.mts');
    const status = await mount(['remove', '--pkg', name], ctx).catch((err: unknown) => {
      console.log(`${warn} ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    });
    if (status !== 0) console.log(`${warn} The --pkg mount could not be removed — run: ${spell(`mount remove --pkg ${name}`, ctx)}`);
  }

  printLeftovers(name, manifest);
  console.log('');
  console.log(`${c.cyan}Next step:${c.reset} ${c.bold}${spell('rebuild', ctx)}${c.reset} ${c.dim}— the image without it; the grant revocation runs at that boot.${c.reset}`);
}

async function listPackages(host: string): Promise<void> {
  const content = await readFile(hostPackageJsonPath(host), 'utf-8');
  const deps = readDependencies(content);

  // An install folder's every line but `neuralis` is the operator's own: a
  // registry one is installed only in the derived image, so its manifest is
  // not readable here and it is listed as registered, never dropped.
  const operator = operatorDependencies(JSON.parse(content));
  const rows: Array<{ name: string; spec: string; status: string }> = [];
  for (const [name, spec] of Object.entries(operator ?? deps)) {
    const manifest = await readDependencyManifest(host, name, spec);
    if (!manifest?.neuralis) {
      if (operator) rows.push({ name, spec, status: manifest ? `${c.yellow}no neuralis block${c.reset}` : `${c.dim}registered (read at the image build)${c.reset}` });
      continue;
    }
    const status = manifest.neuralis.referenceOnly === true ? `${c.dim}reference-only${c.reset}` : `${c.green}builtin-class${c.reset}`;
    rows.push({ name, spec, status });
  }

  if (rows.length === 0) {
    console.log(`${warn} No builtin-class (neuralis-block) dependencies found.`);
    return;
  }
  console.log(`${c.bold}${operator ? 'Operator packages (package.json):' : 'Builtin-class dependencies (neuralis/package.json):'}${c.reset}`);
  for (const r of rows) {
    console.log(`  ${r.status}  ${c.cyan}${r.name}${c.reset} ${c.dim}${r.spec}${c.reset}`);
  }
}

// ── CLI ───────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`${c.bold}neuralis pkg — builtin-class package registration (the admin trust act)${c.reset}

Usage:
  ${spell('pkg add <name> --path <abs-host-dir>')}   a folder you develop (file: dep; ABSOLUTE path)
  ${spell('pkg add <name> --tarball <x.tgz>')}       a packed package (file: dep)
  ${spell('pkg add <name> --version <x.y.z>')}       a registry package, exact version
  ${spell('pkg remove <name>')}
  ${spell('pkg list')}

Then rebuild: ${spell('rebuild')}
`);
}

export async function run(argv: string[], ctx: CliContext): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      path: { type: 'string' },
      tarball: { type: 'string' },
      version: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const [command, name] = positionals;
  if (values.help || !command) {
    printUsage();
    return 0;
  }

  if (command === 'list') {
    await listPackages(ctx.installDir);
    return 0;
  }
  if (!name) throw new CliExit(1, 'Package name required (e.g. @acme/demo).');
  const modes = [values.path, values.tarball, values.version].filter(v => v !== undefined);
  if (command === 'add' && modes.length > 1) throw new CliExit(1, '--path, --tarball and --version are mutually exclusive.');

  if (command === 'add') {
    await addPackage(ctx, name, { path: values.path, tarball: values.tarball, version: values.version });
  } else if (command === 'remove') {
    await removePackage(ctx, name);
  } else {
    printUsage();
    return 1;
  }
  return 0;
}
