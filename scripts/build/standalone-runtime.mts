#!/usr/bin/env node
/**
 * standalone-runtime.mts — the ONE assembly of the host's runnable tree from a
 * `next build` (`output: 'standalone'`). The image build runs it into
 * `/out/neuralis` and the runner copies that tree onto `/neuralis` in one step;
 * a desktop build runs the same script for its bundled host. One layout, one
 * writer — the image and the desktop app can never ship two different trees.
 *
 *   node scripts/build/standalone-runtime.mts --app <neuralis/> \
 *     --deploy-modules <pnpm deploy node_modules> [--build-report <dir>] --out <dir>
 *
 * Plain Node runs it (type stripping, no tsx): erasable syntax only.
 *
 * The layout (`--out`):
 *
 *   <out>/_runtime/server.js        the standalone server (it `chdir`s here)
 *   <out>/_runtime/.next/           incl. `static/` (standalone omits it)
 *   <out>/_runtime/public/
 *   <out>/_runtime/package.json     the bundled chunks `require('../../package.json')`
 *   <out>/_runtime/build/           the image build's report (validate.json, …), when given
 *   <out>/node_modules/<name>       the deploy tree, the tracer's copies merged NO-CLOBBER
 *   <out>/{src,scripts,…}           everything else the tracer emitted, at the root, so a
 *                                   whole-folder `--neuralis` overlay drops in with the
 *                                   host folder's own shape
 *   <out>/{skills,bin,scripts/…}    what no import graph reaches (the operator runbook,
 *                                   the command line, the offline-upgrade closure)
 *   <out>/scripts/cli/up.mjs        `up` precompiled — the desktop app's resident
 *                                   supervisor runs it without tsx (`bundle-up.mjs`)
 *
 * `_runtime/` holds what a whole-folder overlay must not hide (an anonymous
 * volume protects a directory, never a single file); `node_modules/` stays at
 * the root because skills and tooling name `node_modules/<name>/…` paths.
 * Node walks UP from `_runtime/server.js`: `_runtime/node_modules` (absent) →
 * `<out>/node_modules`.
 *
 * Last, `reconcile-runtime-externals.mjs` retargets Turbopack's external aliases
 * at `node_modules/<name>` and proves the native addons LOAD — under the Node
 * that runs this script, which is the Node that will run the tree.
 *
 * It writes no install-kind marker: a desktop build adds its own.
 *
 * Build-only content stays out (`isBuildOnlyPath`): a copied host folder's
 * tests (`scripts/upgrades/__tests__`) and Next's per-platform compiler
 * (`@next/swc-*`, ~93 MB). Last, the tree must fit Windows' MAX_PATH under a
 * per-user install folder (`assertWindowsPathBudget`).
 *
 * It NEVER writes an operator's secrets or machine-local compose files from the
 * HOST's own tree, at any depth, whatever the input: `.env`, `.env.*` and
 * `docker-compose*.yml`. `next build` copies every env file it loaded (`.env`,
 * `.env.production`) into the standalone output, and the tracer takes compose
 * files a script reads — from a developer checkout they would land in the tree
 * and its digest. Neither belongs to a runnable tree: the image's env comes from
 * compose, the desktop host's from the data home's `.env`. A DEPENDENCY's own
 * files of those names (anything under a `node_modules/`) are package content
 * and are copied as they are.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type StandaloneInputs = {
  /** The host package folder after `next build` (holds `.next/standalone`, `.next/static`, `public`, `skills`, `bin`, `scripts`). */
  app: string;
  /** The production dependency tree (`pnpm deploy`'s `node_modules`). */
  deployModules: string;
  /** The image build's report folder, or null. */
  buildReport: string | null;
  /** The tree to write; absent or empty. */
  out: string;
};

/**
 * Host files no import graph reaches, so the Next tracer is no guarantee they
 * arrive: the operator runbook (`neuralis://` answers from it with no host
 * checkout), the command line and the offline-upgrade closure it enters.
 */
export const UNTRACED_HOST_PATHS: readonly string[] = [
  'skills',
  'bin',
  'scripts/cli',
  'scripts/upgrade.mts',
  'scripts/checkpoint.mts',
  'scripts/setup/detect.mts',
  'scripts/setup/envFile.mts',
  'scripts/setup/ownerCheck.mts',
  'scripts/upgrades',
];

const RECONCILE = join(dirname(fileURLToPath(import.meta.url)), 'reconcile-runtime-externals.mjs');
const BUNDLE_UP = join(dirname(fileURLToPath(import.meta.url)), 'bundle-up.mjs');

/** A file no runnable tree may carry: an operator's env file or a machine-local compose file. */
export function isMachineLocalFile(name: string): boolean {
  return name === '.env' || name.startsWith('.env.') || /^docker-compose.*\.ya?ml$/.test(name);
}

/**
 * Build-only content, by its path inside the copied tree: in a HOST folder a
 * test tree (`__tests__`); in a dependency tree Next's compiler binary
 * (`@next/swc-<platform>`), which `next build` loads and the standalone server
 * never does — it reads its config as JSON (`__NEXT_PRIVATE_STANDALONE_CONFIG`),
 * and the code frames that would load it are dev-only. `@tailwindcss/oxide`
 * stays: the runner compiles the union stylesheet with it.
 */
export function isBuildOnlyPath(relPath: string, hostTree: boolean): boolean {
  const parts = relPath.split(/[\\/]/);
  if (hostTree) return parts.includes('__tests__') && !parts.includes('node_modules');
  return parts.some((part, i) => part === '@next' && (parts[i + 1] ?? '').startsWith('swc-'));
}

/**
 * A copy that keeps relative symlinks verbatim and mode bits; `merge` never
 * replaces an existing entry; a machine-local file of the host is never written
 * (`hostTree: false` — a dependency tree — copies everything else), and
 * build-only content of either kind is left out.
 */
function copyTree(from: string, to: string, merge: boolean, hostTree = true): void {
  const keep = (src: string): boolean => {
    const rel = relative(from, src);
    if (isBuildOnlyPath(rel, hostTree)) return false;
    return !hostTree || !isMachineLocalFile(basename(src)) || rel.split(sep).includes('node_modules');
  };
  cpSync(from, to, { recursive: true, verbatimSymlinks: true, force: !merge, errorOnExist: false, filter: keep });
}

/** Windows' path limit (260 with the terminator) and what a per-user install folder takes of it (`C:\Users\<name>\AppData\Local\Programs\Neuralis\resources\host\`, about 70, and a margin). */
export const WINDOWS_MAX_PATH = 259;
export const WINDOWS_INSTALL_PREFIX = 80;

/**
 * The tree's longest relative path, and a refusal when it would not fit under
 * a Windows install folder: the installer (NSIS) and Explorer still honour
 * MAX_PATH where Node does not. One walk of the finished tree.
 */
export function assertWindowsPathBudget(out: string): { longest: number; path: string } {
  let longest = { longest: 0, path: '' };
  for (const rel of readdirSync(out, { recursive: true }) as string[]) {
    if (rel.length > longest.longest) longest = { longest: rel.length, path: rel };
  }
  if (longest.longest + WINDOWS_INSTALL_PREFIX > WINDOWS_MAX_PATH) {
    throw new Error(`${longest.path} is ${longest.longest} characters: with a Windows install folder (${WINDOWS_INSTALL_PREFIX}) it passes MAX_PATH (${WINDOWS_MAX_PATH}).`);
  }
  return longest;
}

/** Step 1: the standalone tree's content at the root; the tracer's `node_modules` aside, for the merge. */
export function placeStandalone(input: StandaloneInputs): void {
  const standalone = join(input.app, '.next', 'standalone');
  copyTree(join(standalone, 'neuralis'), input.out, false);
  copyTree(join(standalone, 'node_modules'), join(input.out, 'node_modules-standalone'), false, false);
}

/** Step 1b–1c: the files no import graph reaches (`UNTRACED_HOST_PATHS`), over the tracer's copies. */
export function placeUntraced(input: StandaloneInputs): void {
  for (const rel of UNTRACED_HOST_PATHS) {
    const target = join(input.out, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyTree(join(input.app, rel), target, false);
  }
}

/** Step 1d: `up` precompiled beside the registry it enters (the existing script, in its own process). */
export function placeUpBundle(input: StandaloneInputs): void {
  const result = spawnSync(process.execPath, [BUNDLE_UP, input.app, input.out], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`bundle-up failed (exit ${result.status ?? result.signal})`);
}

/** Step 2: what the overlay must not hide moves under `_runtime/`. */
export function placeRuntime(input: StandaloneInputs): void {
  const runtime = join(input.out, '_runtime');
  mkdirSync(runtime, { recursive: true });
  renameSync(join(input.out, 'server.js'), join(runtime, 'server.js'));
  renameSync(join(input.out, '.next'), join(runtime, '.next'));
  copyTree(join(input.out, 'package.json'), join(runtime, 'package.json'), false);
}

/** Step 3: the deploy tree, then the tracer's copies NO-CLOBBER (it copied from that tree, so it only adds). */
export function placeNodeModules(input: StandaloneInputs): void {
  const modules = join(input.out, 'node_modules');
  rmSync(modules, { recursive: true, force: true });
  copyTree(input.deployModules, modules, false, false);
  copyTree(join(input.out, 'node_modules-standalone'), modules, true, false);
  rmSync(join(input.out, 'node_modules-standalone'), { recursive: true, force: true });
}

/** Step 3b: the external aliases retargeted and the native addons loaded (the existing script, never a copy). */
export function reconcileExternals(input: StandaloneInputs): void {
  const result = spawnSync(process.execPath, [RECONCILE, input.out], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`reconcile-runtime-externals failed (exit ${result.status ?? result.signal})`);
}

/** Step 4–4b: the static assets and `public/` beside the server; the build report when there is one. */
export function placeAssets(input: StandaloneInputs): void {
  const runtime = join(input.out, '_runtime');
  copyTree(join(input.app, '.next', 'static'), join(runtime, '.next', 'static'), false);
  copyTree(join(input.app, 'public'), join(runtime, 'public'), false);
  if (input.buildReport) copyTree(input.buildReport, join(runtime, 'build'), false);
}

/** The whole assembly, in the order the layout depends on. */
export function assembleStandaloneRuntime(input: StandaloneInputs, reconcile: (input: StandaloneInputs) => void = reconcileExternals): void {
  if (existsSync(input.out) && readdirSync(input.out).length > 0) throw new Error(`${input.out} is not empty — the tree is written once, into a fresh folder.`);
  for (const [flag, dir] of [['--app', join(input.app, '.next', 'standalone')], ['--deploy-modules', input.deployModules]] as const) {
    if (!existsSync(dir)) throw new Error(`${flag}: ${dir} does not exist`);
  }
  mkdirSync(input.out, { recursive: true });
  placeStandalone(input);
  placeUntraced(input);
  placeUpBundle(input);
  placeRuntime(input);
  placeNodeModules(input);
  reconcile(input);
  placeAssets(input);
  // The tree is built on its target OS, and pnpm's virtual store names are
  // longer off Windows: only a Windows tree is measured against MAX_PATH.
  if (process.platform === 'win32') assertWindowsPathBudget(input.out);
}

export function parseArgs(argv: readonly string[]): StandaloneInputs {
  const value = (flag: string): string | null => {
    const at = argv.indexOf(flag);
    if (at < 0) return null;
    const next = argv[at + 1];
    if (!next || next.startsWith('--')) throw new Error(`${flag} needs a folder`);
    return resolve(next);
  };
  const app = value('--app');
  const deployModules = value('--deploy-modules');
  const out = value('--out');
  if (!app || !deployModules || !out) {
    throw new Error('Usage: node standalone-runtime.mts --app <dir> --deploy-modules <dir> [--build-report <dir>] --out <dir>');
  }
  return { app, deployModules, buildReport: value('--build-report'), out };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assembleStandaloneRuntime(parseArgs(process.argv.slice(2)));
    console.log('[standalone] runtime tree assembled');
  } catch (err) {
    console.error(`[standalone] FATAL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
