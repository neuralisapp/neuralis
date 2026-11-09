/**
 * `neuralis update` — move an installation to a published release line.
 *
 * Commands:
 *   (no args)              show what would change; changes nothing
 *   --apply                actually move
 *   --version <x>          target version for the whole line (manual override)
 *   --manifest <url|file>  resolve versions from a release manifest (https or a
 *                          local file); without --version or --manifest the
 *                          latest published line (RELEASE_MANIFEST_URL) is used
 *   <package>              move one operator-registered registry package instead
 *                          (needs --version: a release line names only its own)
 *   --json                 machine-readable plan
 *
 * WHAT MOVES, PER LAYOUT (the install folder `ctx.installDir`):
 *   - an npm install folder (`{dependencies: {neuralis: <exact>, …}}`): ONE
 *     `npm install neuralis@<v> --save-exact`. The `@neuralis/*` packages come
 *     with it, exact-pinned by the host's own manifest; the operator's package
 *     lines are other dependencies of the folder, untouched by construction.
 *     `npm update` cannot do this: the pin is exact, so it is a no-op, and
 *     `npm install neuralis@latest` without `--save-exact` would write a range.
 *     Before that install the folder manifest's `overrides` / `allowScripts`
 *     become the TARGET release's (`releaseInstallPolicy`): npm reads both only
 *     from the folder's root manifest, never from the host package. The
 *     re-executed new code checks it again against its own manifest and installs
 *     once more when the folder lacks it (a move started by older code).
 *   - a clone of the public host repository: the code moves with
 *     `git fetch --tags && git checkout v<v>`, which this command PRINTS and
 *     never runs — a checkout is the operator's working tree.
 *   - the development checkout: refused; the update there is `git pull`.
 *   - an image-only folder: the image IS the code. The installed version is
 *     `.env` NEURALIS_IMAGE_TAG; the target image is used when present
 *     (`docker image inspect` — a version tag never changes) or pulled (a
 *     failed pull moves nothing); then the post-move steps and the stack run in
 *     a one-shot container of the TARGET image (`--host-swapped`, the manifest
 *     written into the bound folder) — or in this process when it already is
 *     that image.
 *   - the image's own tree (`container`): refused; the update runs from the
 *     install folder on the host.
 *
 * THE STACK (an npm install folder or an image-only folder, `--apply`): after the moves below the
 * command runs the rest itself — regenerate compose, stop THIS install's app
 * (compose project and service read from the folder, `update/stack.mts`),
 * `upgrade --apply` with the vector store running, recreate (`up -d -V`, or
 * `rebuild` for a derived image), wait for `/api/health` — and stops at the
 * first failing step, printing where and the way back. A clone prints those
 * steps after its own `git checkout`; without `--apply` the plan names the
 * folder, the compose project, the services and the image tag.
 *
 * THE IMAGE TAG AND THE COMPANIONS: the container runs the image `.env
 * NEURALIS_IMAGE_TAG` names, not this folder. A release run moves that tag to
 * the line's `neuralisapp/neuralis` version and every companion image the
 * install pins to the release default (`.env` NEURALIS_MACHINE_IMAGE,
 * platform.json machineImage / mcpSidecarImage), reporting — never overwriting —
 * a custom one. On a folder those moves run in the NEWLY installed code: the
 * command re-executes the installed bin with `--host-swapped` once npm install
 * succeeded, so the old module code never performs a post-install step.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { IMAGE_HOST_BIN, predatesImageKind, readImageTag, resolveNeuralisHome } from '@neuralis/package-system/paths';
import { compareReleaseVersions, MANIFEST_VERSION, parseReleaseManifest, type ReleaseManifest } from '@neuralis/package-system/contracts';
import { appPort } from './checkpoint.mts';
import { CliExit, HOST_IMAGE, imageRunCommand, upgradeDeviceBinds, type CliContext } from './cli/registry.mts';
import { installLayout, spellOn, type InstallLayout } from './cli/spelling.mts';
import { composeProjectOf } from './host-broker/helper.mts';
import { operatorDependencies } from './setup/compose.mts';
import { loadHostEnv, resolveConfigDir } from './setup/detect.mts';
import { discoverBuiltinDeps } from './setup/discoverPackages.mts';
import { dropEnvKey, imageTagAfterUpdate, readEnvFile, upsertEnvValue } from './setup/envFile.mts';
import { readSessionSecretFile } from '../src/server/config/sessionSecretFile.ts';
import { recordInstall } from './setup/installRecord.mts';
import { readPlatformConfig, writeMergedPlatformConfig } from './setup/platformConfig.mts';
import { applyStack, IMAGE_PORTS, outsideComposeRefusal, PROCESS_PORTS, stackCommands, stackOf, type ComposeStack, type StackPorts } from './update/stack.mts';

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
const warn = `${c.yellow}⚠${c.reset}`;
const dot = `${c.dim}·${c.reset}`;

const HOST_PACKAGE = 'neuralis';
const USAGE = 'usage: neuralis update [<package>] [--version <x> | --manifest <https url|file>] [--apply] [--json]';

type PlanRow = {
  name: string;
  current: string;
  target: string;
  /** No newer version resolved — nothing to do for this package. */
  unchanged: boolean;
  /** Moves with the host package (a dependency it pins), not on its own. */
  via?: typeof HOST_PACKAGE;
};

/** Where the code of this install lives and how it moves. */
function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * `npm` started without a shell: through the npm CLI that ran this command
 * (`npx` / `npm exec` set `npm_execpath` to its `npm-cli.js`), by this same
 * Node. On Windows `npm` is an `npm.cmd` shim that Node starts only through a
 * shell; outside npm the name is the program.
 */
export function npmInvocation(args: string[], env: Readonly<Record<string, string | undefined>> = process.env, platform: NodeJS.Platform = process.platform): [string, string[]] {
  const cli = env.npm_execpath;
  if (cli && basename(cli) === 'npm-cli.js') return [process.execPath, [cli, ...args]];
  // Windows outside npm (pnpm, yarn, a bare node): the npm Node ships beside itself.
  const bundled = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return platform === 'win32' && existsSync(bundled) ? [process.execPath, [bundled, ...args]] : ['npm', args];
}

/** The two host-manifest fields an npm install folder carries for its release. */
const INSTALL_POLICY_KEYS = ['overrides', 'allowScripts'] as const;
type InstallPolicy = Partial<Record<(typeof INSTALL_POLICY_KEYS)[number], Record<string, unknown>>>;

/**
 * The install policy a release ships, read from `npm view neuralis@<exact>
 * --json` — the WHOLE version object (npm 12 wraps it in an array; a
 * field-list view loses the key when one field is absent): the dependency
 * floors its lock was fixed with and the install scripts npm may run. A release
 * that ships neither yields `{}`.
 */
export function releaseInstallPolicy(viewJson: string): InstallPolicy {
  const parsed = JSON.parse(viewJson) as unknown;
  return installPolicyOf((Array.isArray(parsed) ? parsed.at(-1) : parsed) as Record<string, unknown> | null);
}

/** The policy fields of one host manifest (a registry version object or the running code's own `package.json`). */
function installPolicyOf(release: Record<string, unknown> | null): InstallPolicy {
  const policy: InstallPolicy = {};
  for (const key of INSTALL_POLICY_KEYS) {
    const value = release?.[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) policy[key] = value as Record<string, unknown>;
  }
  return policy;
}

/**
 * The folder manifest with its policy fields replaced by `policy` (absent ones
 * removed), placed right after `dependencies` — `pkg add|remove` edits the FIRST
 * `"<name>": "<spec>"` line, and `overrides` names packages too; a manifest
 * without `dependencies` gets them at the end. Serialised the
 * way `create-neuralis` writes it (2 spaces, trailing newline); `null` when the
 * fields already match, so an unchanged folder is not rewritten.
 */
export function withInstallPolicy(manifestText: string, policy: InstallPolicy): string | null {
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;
  if (INSTALL_POLICY_KEYS.every((key) => JSON.stringify(manifest[key]) === JSON.stringify(policy[key]))) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(manifest)) {
    if ((INSTALL_POLICY_KEYS as readonly string[]).includes(key)) continue;
    out[key] = value;
    if (key === 'dependencies') Object.assign(out, policy);
  }
  if (!('dependencies' in manifest)) Object.assign(out, policy);
  return `${JSON.stringify(out, null, 2)}\n`;
}

/**
 * Write `policy` into the folder manifest and print the one `install policy`
 * line. Returns the manifest text it replaced (a failed install puts it back
 * byte for byte), or null when the fields already matched and nothing was written.
 */
function writeInstallPolicy(installDir: string, policy: InstallPolicy, release: string): string | null {
  const manifestPath = join(installDir, 'package.json');
  const before = readFileSync(manifestPath, 'utf-8');
  const after = withInstallPolicy(before, policy);
  if (after !== null) writeFileSync(manifestPath, after);
  const keys = Object.keys(policy);
  console.log(`  ${dot} install policy : ${keys.length > 0 ? keys.join(' + ') : `none — ${HOST_PACKAGE}@${release} ships no overrides or allowScripts`}${after === null ? ' (unchanged)' : ''}`);
  return after === null ? null : before;
}

/**
 * In the code of the line (after the swap, or a folder already on it): the
 * running host package IS the release, so its own manifest carries the policy —
 * no registry read. A folder the update left without it (moved by code that
 * predates the policy write, or interrupted) gets it now and installs once under
 * it; npm then runs the install scripts `allowScripts` approves, which an earlier
 * install may have blocked. Fields already matching cost nothing.
 */
function settleInstallPolicy(installDir: string, packageDir: string, layout: InstallLayout, release: string): void {
  const policy = installPolicyOf(readJson(join(packageDir, 'package.json')));
  const before = writeInstallPolicy(installDir, policy, release);
  if (before === null) return;
  const approved = Object.entries(policy.allowScripts ?? {}).filter(([, allowed]) => allowed === true).map(([name]) => name);
  for (const step of [['install'], ...(approved.length > 0 ? [['rebuild', ...approved]] : [])]) {
    const result = spawnSync(...npmInvocation(step), { cwd: installDir, stdio: 'inherit' });
    if (result.status === 0) continue;
    writeFileSync(join(installDir, 'package.json'), before);
    throw new CliExit(1, `the code moved, the install policy did not: npm ${step.join(' ')} failed (${result.error?.message ?? `exit ${result.status}`})`, [
      'The folder manifest is back as it was; the image tag, the companion images and the stack were not touched.',
      `Fix the cause, then run \`${spellOn(layout, `update --version ${release} --apply`)}\` again — it repeats this step.`,
    ]);
  }
  console.log(`  ${ok} installed under the release's install policy.`);
}

function installedVersion(installDir: string, name: string): string {
  const version = readJson(join(installDir, 'node_modules', ...name.split('/'), 'package.json'))?.version;
  return typeof version === 'string' ? version : '(not installed)';
}

function hostVersion(packageDir: string): string | null {
  const version = readJson(join(packageDir, 'package.json'))?.version;
  return typeof version === 'string' ? version : null;
}

/**
 * The latest published release line: the manifest every release attaches to
 * its public GitHub release (`pnpm release:version --manifest` writes it).
 */
export const RELEASE_MANIFEST_URL = 'https://github.com/neuralisapp/neuralis/releases/latest/download/release-manifest.json';
const MANIFEST_FETCH_TIMEOUT_MS = 15_000;
const MANIFEST_MAX_REDIRECTS = 5;
/** A manifest is a few hundred bytes; anything near this is not one. */
const MANIFEST_MAX_BYTES = 64 * 1024;

/**
 * The manifest text from a local file or an https URL. Remote reads are https
 * only (also after redirects), bounded in time and in size.
 */
export async function readReleaseManifest(source: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return readFileSync(source, 'utf-8');
  let url = new URL(source);
  const signal = AbortSignal.timeout(MANIFEST_FETCH_TIMEOUT_MS);
  // Redirects are followed by hand so every hop is checked BEFORE it is requested
  // (a release asset answers with two: the latest tag, then the storage host).
  let response: Response;
  for (let hop = 0; ; hop++) {
    if (url.protocol !== 'https:') throw new Error(`only https release manifests are read (${hop === 0 ? 'got' : 'redirected to'} ${url.protocol})`);
    response = await fetchImpl(url, { redirect: 'manual', signal });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
    if (!location) break;
    if (hop >= MANIFEST_MAX_REDIRECTS) throw new Error(`more than ${MANIFEST_MAX_REDIRECTS} redirects`);
    url = new URL(location, url);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MANIFEST_MAX_BYTES) throw new Error(`larger than ${MANIFEST_MAX_BYTES} bytes`);
  if (!response.body) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MANIFEST_MAX_BYTES) {
      await reader.cancel();
      throw new Error(`larger than ${MANIFEST_MAX_BYTES} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * The DEFAULT line is GitHub's `latest` release, which follows the release's
 * commit date — so it can name a line older than this install. Moving down is
 * never the default: the update refuses, and an explicit `--manifest <url>` is
 * how an operator chooses an older line on purpose. Null = proceed.
 */
export function downgradeRefusal(lineVersion: string, installedHostVersion: string | null, explicitSource: boolean): string | null {
  if (explicitSource || installedHostVersion === null || !MANIFEST_VERSION.test(installedHostVersion)) return null;
  return compareReleaseVersions(lineVersion, installedHostVersion) < 0
    ? `the latest published line (${lineVersion}) is older than this install (${installedHostVersion}) — nothing is moved down by default`
    : null;
}

async function resolveManifest(source: string): Promise<ReleaseManifest> {
  let raw: string;
  try {
    raw = await readReleaseManifest(source);
  } catch (err) {
    throw new CliExit(1, `could not read the release manifest at ${source}`, [err instanceof Error ? err.message : String(err)]);
  }
  try {
    return parseReleaseManifest(raw);
  } catch (err) {
    throw new CliExit(1, `${source} is not a release manifest`, [err instanceof Error ? err.message : String(err)]);
  }
}

/** The version an install runs: an npm folder's installed host, an image-only folder's `.env` tag, else the running code. */
function installedHost(layout: InstallLayout, installDir: string, packageDir: string): string | null {
  if (layout === 'folder') return installedVersion(installDir, HOST_PACKAGE);
  if (layout === 'image') return readImageTag(installDir);
  return hostVersion(packageDir);
}

/**
 * The line plan: the host package itself, then every `@neuralis/*` package the
 * line names that this install carries (they move WITH the host — it pins them).
 * An image-only folder's one row is its image tag: the packages are inside it.
 */
export function planLine(input: { target: string; manifest: ReleaseManifest | null; installDir: string; packageDir: string; layout: InstallLayout }): PlanRow[] {
  const current = installedHost(input.layout, input.installDir, input.packageDir) ?? '(unknown)';
  const rows: PlanRow[] = [{ name: input.layout === 'image' ? HOST_IMAGE : HOST_PACKAGE, current, target: input.target, unchanged: current === input.target }];
  if (input.layout === 'image') return rows;
  const pinned = (readJson(join(input.packageDir, 'package.json'))?.dependencies ?? {}) as Record<string, unknown>;
  for (const name of Object.keys(pinned).filter((n) => n.startsWith('@neuralis/')).sort()) {
    const target = input.manifest ? input.manifest.packages[name] : input.target;
    if (!target) continue;
    const now = installedVersion(input.layout === 'folder' ? input.installDir : input.packageDir, name);
    if (now === '(not installed)') continue;
    rows.push({ name, current: now, target, unchanged: now === target, via: HOST_PACKAGE });
  }
  return rows;
}

const WEBTOP_IMAGE = 'neuralisapp/webtop-ubuntu-xfce';
const SIDECAR_IMAGE = 'neuralisapp/mcp-sidecar';

/**
 * The companion-image settings an install can PIN, each with the repository
 * whose release default it holds. Setup writes the `.env` line and seeds
 * `machineImage`; `mcpSidecarImage` is pinned only by an admin edit (setup never
 * writes it). An absent setting follows the package default, which moved with
 * the packages already.
 */
const PINNED_COMPANIONS = [
  { where: 'env', key: 'NEURALIS_MACHINE_IMAGE', repository: WEBTOP_IMAGE },
  { where: 'platform', key: 'machineImage', repository: WEBTOP_IMAGE },
  { where: 'platform', key: 'mcpSidecarImage', repository: SIDECAR_IMAGE },
] as const;

export type CompanionMove =
  | { kind: 'absent' }
  | { kind: 'same'; value: string }
  | { kind: 'move'; from: string; to: string }
  | { kind: 'keep'; value: string; reason: string };

/**
 * What a release line does to one pinned image setting. ONLY the release
 * default form `<repository>:<tag>` moves; anything else — another registry,
 * a digest pin, a custom build — is the operator's image and is reported,
 * never overwritten.
 */
export function companionImageMove(current: string | undefined, repository: string, version: string | undefined): CompanionMove {
  if (current === undefined || current === '') return { kind: 'absent' };
  const tag = new RegExp(`^${repository.replace(/[/.]/g, (ch) => `\\${ch}`)}:([0-9A-Za-z][0-9A-Za-z._-]*)$`).exec(current)?.[1];
  if (tag === undefined) return { kind: 'keep', value: current, reason: `not the ${repository} release default — a custom image is never overwritten` };
  if (!version) return { kind: 'keep', value: current, reason: `the release manifest names no ${repository} version` };
  if (tag === version) return { kind: 'same', value: current };
  return { kind: 'move', from: current, to: `${repository}:${version}` };
}

export type UpdateArgs = {
  apply: boolean;
  asJson: boolean;
  targetVersion: string | null;
  /** null only with an explicit `--version`; otherwise the named manifest or the latest published line. */
  manifestSource: string | null;
  /** True when the operator named the manifest (`--manifest`), false for the default line. */
  manifestExplicit: boolean;
  /** Internal: the re-executed half after the folder's npm install (post-install steps only). */
  hostSwapped: boolean;
  positional: string[];
};

/**
 * The command line. A flag's VALUE is never a positional (it would be read as a
 * package name), and a value flag without its value is refused rather than
 * quietly falling back to the published line.
 */
export function parseUpdateArgs(argv: string[]): UpdateArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--version' || arg === '--manifest') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      values.set(arg, next);
      i++;
    } else if (arg.startsWith('--')) flags.add(arg);
    else positional.push(arg);
  }
  const unknown = [...flags].filter((f) => !['--apply', '--json', '--host-swapped'].includes(f));
  if (unknown.length > 0) throw new Error(`unknown option ${unknown[0]}`);
  const targetVersion = values.get('--version') ?? null;
  return {
    apply: flags.has('--apply'),
    asJson: flags.has('--json'),
    targetVersion,
    manifestSource: values.get('--manifest') ?? (targetVersion ? null : RELEASE_MANIFEST_URL),
    manifestExplicit: values.has('--manifest'),
    hostSwapped: flags.has('--host-swapped'),
    positional,
  };
}

/**
 * The last step after a release move: an install folder that registers
 * operator packages rebuilds its derived image over the new release image
 * (`neuralis rebuild` regenerates, builds and recreates with `-V`); every other
 * install recreates on the release image.
 */
export function recreateKind(installDir: string): 'up' | 'rebuild' {
  return Object.keys(operatorDependencies(readJson(join(installDir, 'package.json'))) ?? {}).length > 0 ? 'rebuild' : 'up';
}

export function recreateStep(installDir: string, layout: InstallLayout): string {
  if (recreateKind(installDir) === 'rebuild') {
    return `${spellOn(layout, 'rebuild')} ${c.dim}(builds this install's derived image — its operator packages over the new release image — and recreates with -V)${c.reset}`;
  }
  return `docker compose up -d -V ${c.dim}(-V is load-bearing: it renews the anonymous volumes that would otherwise mask the new image-built runtime)${c.reset}`;
}

/**
 * `ownVersion` is the running code's version: a refusal prints a real release,
 * never a placeholder a copied command would read as a redirect.
 */
export function refuseLayout(layout: InstallLayout, args: UpdateArgs, ownVersion: string): never {
  if (layout === 'monorepo') {
    throw new CliExit(1, 'this is the development checkout — there is nothing to update from a registry', [
      'The packages here are the source. Update it with `git pull`, then `pnpm install`',
      'and `pnpm neuralis:rebuild`.',
    ]);
  }
  if (layout === 'native') {
    throw new CliExit(1, 'this is the desktop app\'s own bundle — it is updated through the app, not by this command', [
      'The app checks for a new release at start (the tray: "Check for updates…"); a new build then raises the stored data formats itself (`neuralis upgrade --apply`, offline).',
    ]);
  }
  if (layout === 'container') {
    throw new CliExit(1, 'this runs in the image\'s own tree, not in an install folder', [
      `Run it on the host for the folder that holds .env and docker-compose.yml: ${spellOn('image', `update${args.targetVersion ? ` --version ${args.targetVersion}` : ''} --apply`)}`,
      '(in that folder, or from anywhere with --install <folder>).',
    ]);
  }
  throw new CliExit(1, 'this folder is the host package itself, not an npm install folder or a git clone', [
    `Move it to the npm layout once, with the app stopped: npx --yes create-neuralis@${args.targetVersion ?? ownVersion} convert .`,
  ]);
}

/** One operator-registered registry package, at an exact version. */
async function updateOnePackage(args: UpdateArgs, ctx: CliContext): Promise<number> {
  const wanted = args.positional[0]!;
  const installDir = ctx.installDir;
  const { registryOnly, localSource } = discoverBuiltinDeps(installDir);
  const match = registryOnly.find((p) => p.name === wanted || p.name.split('/').pop() === wanted);
  if (!match) {
    const local = localSource.find((p) => p.name === wanted || p.name.split('/').pop() === wanted);
    throw new CliExit(1, `"${wanted}" is not a registry-installed package of this folder`, [
      local ? `${local.name} is a local package (${local.spec}); a local package is never updated from a registry.` : `Registry packages here: ${registryOnly.map((p) => p.name).join(', ') || '(none)'}`,
      'The neuralis line itself (and the @neuralis/* packages it pins) moves without a package name.',
    ]);
  }
  if (!args.targetVersion) throw new CliExit(1, `a release line names only its own packages — give ${match.name} its version: --version <x>`);
  const current = installedVersion(installDir, match.name);
  const row: PlanRow = { name: match.name, current, target: args.targetVersion, unchanged: current === args.targetVersion };
  if (args.asJson) console.log(JSON.stringify({ layout: 'folder', plan: [row], apply: args.apply }, null, 2));
  else console.log(`\n  ${row.unchanged ? dot : ok} ${row.name} ${row.current} → ${c.bold}${row.target}${c.reset}\n`);
  if (row.unchanged || !args.apply) return 0;
  const result = spawnSync(...npmInvocation(['install', `${match.name}@${args.targetVersion}`, '--save-exact']), { cwd: installDir, stdio: 'inherit' });
  if (result.status !== 0) throw new CliExit(1, `npm install failed (${result.error?.message ?? `exit ${result.status}`})`, ['The installation is unchanged.']);
  console.log(`  ${ok} installed. ${c.dim}The container runs its image: \`npx neuralis rebuild\` carries the package into it.${c.reset}\n`);
  return 0;
}

export async function run(argv: string[], ctx: CliContext): Promise<number> {
  let args: UpdateArgs;
  try {
    args = parseUpdateArgs(argv);
  } catch (err) {
    throw new CliExit(1, err instanceof Error ? err.message : String(err), [USAGE]);
  }
  const packageDir = ctx.packageDir;
  const layout = installLayout(ctx.installDir, packageDir);
  if (layout !== 'folder' && layout !== 'clone' && layout !== 'image') refuseLayout(layout, args, hostVersion(packageDir) ?? 'latest');
  // The folder's `.env` (NEURALIS_HOME among it) is this command's environment, as for every other verb.
  await loadHostEnv(ctx.installDir);
  if (args.positional.length > 0) {
    if (layout !== 'folder') throw new CliExit(1, 'a single-package update needs an npm install folder (its package list is the folder\'s own package.json)');
    return updateOnePackage(args, ctx);
  }

  const installDir = ctx.installDir;
  let manifest: ReleaseManifest | null = null;
  let target: string;
  if (args.manifestSource !== null) {
    manifest = await resolveManifest(args.manifestSource);
    const named = manifest.packages[HOST_PACKAGE];
    if (!named) throw new CliExit(1, `the release manifest ${manifest.version} names no ${HOST_PACKAGE} version`);
    target = named;
  } else {
    target = args.targetVersion!;
  }
  if (!MANIFEST_VERSION.test(target)) throw new CliExit(1, `"${target}" is not a release version`);
  // Decided BEFORE anything moves, so a version Docker cannot tag fails with nothing changed.
  const tag = imageTagAfterUpdate({ targetVersion: args.targetVersion, onePackage: false, manifest: manifest ? { image: manifest.images[HOST_IMAGE] ?? null } : null });

  if (layout === 'image' && !tag.move) throw new CliExit(1, `${tag.reason} — an image-only folder moves only with its image`);
  const plan = planLine({ target: layout === 'image' && tag.move ? tag.tag : target, manifest, installDir, packageDir, layout });
  if (args.hostSwapped) return afterHostSwap({ args, ctx, layout, manifest, tag, previous: null });

  const refusal = downgradeRefusal(manifest?.version ?? target, installedHost(layout, installDir, packageDir), args.manifestExplicit || args.manifestSource === null);
  if (refusal) throw new CliExit(1, refusal, [`To move to an older line on purpose, name it: ${spellOn(layout, 'update --manifest <url|file> --apply')}`]);

  const host = plan[0]!;
  // The image the container runs is install state of its own: a folder already
  // on the line's code (a fresh `convert`, an interrupted update) still moves it.
  // On an image-only folder the tag IS the plan's one row.
  const image = layout === 'image' ? null : await imageRow(ctx.installDir, tag);
  const stack = layout === 'folder' || layout === 'image' ? await stackPlan(installDir, PROCESS_PORTS) : null;
  if (args.asJson) {
    console.log(JSON.stringify({ layout, plan, image, ...(stack ? { stack: stackJson(stack) } : {}), apply: args.apply }, null, 2));
    if (!args.apply) return 0;
  } else {
    console.log('');
    console.log(`  ${c.cyan}${c.bold}── neuralis update ${'─'.repeat(35)}${c.reset}`);
    console.log(`  ${dot} layout         : ${c.bold}${layout === 'folder' ? 'npm install folder' : layout === 'image' ? 'image-only folder' : 'git clone'}${c.reset}`);
    console.log(`  ${dot} line           : ${c.bold}${manifest ? manifest.version : target}${c.reset}${manifest ? '' : c.dim + ' (--version)' + c.reset}`);
    console.log('');
    for (const row of plan) {
      const line = row.unchanged
        ? `${c.dim}${row.name} ${row.current} (unchanged)${c.reset}`
        : `${c.bold}${row.name}${c.reset} ${row.current} → ${c.bold}${row.target}${c.reset}${row.via ? `${c.dim} (with ${row.via})${c.reset}` : ''}`;
      console.log(`    ${row.unchanged ? dot : ok} ${line}`);
    }
    if (image) console.log(`    ${image.unchanged ? dot : ok} ${c.bold}NEURALIS_IMAGE_TAG${c.reset} ${image.current} → ${c.bold}${image.target}${c.reset}`);
    console.log('');
    if (stack) printStackPlan(stack, layout);
  }
  // An image-only folder is on the line only when its stack is too: an update that stopped mid-stack
  // moved `.env` but left the compose file pinning the old tag — that run resumes, it is no no-op.
  // The compose file can already be regenerated while the container still runs the old image (a
  // stop after the regeneration), so the running app's image is read too.
  const pinned = layout === 'image' ? composeImageTag(installDir) : null;
  const running = layout === 'image' && host.unchanged && pinned === host.target && stack ? await runningImageTag(stack, PROCESS_PORTS) : undefined;
  const behind = pinned !== host.target
    ? `the compose file pins ${pinned ?? 'no release image'}`
    : running !== undefined && running !== host.target ? (running === null ? 'the app is not running' : `the app container runs ${running}`) : null;
  const resume = layout === 'image' && host.unchanged && behind !== null;
  if (resume) console.log(`  ${warn} .env is on ${host.target}, ${behind} — the stack steps run again (an earlier update may have stopped mid-stack).`);
  if (host.unchanged && (!image || image.unchanged) && !resume) {
    console.log(`  ${ok} already on ${host.target}.\n`);
    return 0;
  }
  if (!args.apply) {
    console.log(`  ${warn} dry run — nothing changed. Re-run with ${c.bold}--apply${c.reset}.\n`);
    return 0;
  }
  // Decided before anything moves: a process outside compose would keep serving the old code.
  // Not on an image-only folder: this command runs in a container whose loopback is its own, so it
  // cannot see a host process on the port — and a daemon may then start the app without publishing
  // it, `up -d` succeeding (measured on Docker Desktop). The success line says where readiness was
  // proved (inside the stack), never the host URL it could not reach.
  const outside = layout !== 'image' && stack && typeof stack.stack !== 'string' ? await outsideComposeRefusal(stack.stack, stack.appPort, PROCESS_PORTS, installDir) : null;
  if (outside) {
    throw new CliExit(1, `${outside} — nothing was changed`, [
      'Stop that process, run this update again, then start it the way you started it before.',
    ]);
  }
  if (layout === 'image') return moveImage({ args, ctx, manifest, tag, target: host.target, previous: resume ? (pinned !== host.target ? pinned : running) ?? host.current : host.current });
  // The code is already the line's: only the post-install steps remain, in this process.
  if (host.unchanged) return afterHostSwap({ args, ctx, layout, manifest, tag, previous: null });

  if (layout === 'clone') return afterHostSwap({ args, ctx, layout, manifest, tag, previous: host.current });

  console.log(`  ${dot} installing     : ${c.bold}${HOST_PACKAGE}@${target}${c.reset}`);
  // The target release's install policy goes into the folder manifest BEFORE the install that needs it.
  const view = spawnSync(...npmInvocation(['view', `${HOST_PACKAGE}@${target}`, '--json']), { cwd: installDir, encoding: 'utf-8' });
  if (view.status !== 0) throw new CliExit(1, `npm view ${HOST_PACKAGE}@${target} failed (${view.error?.message ?? `exit ${view.status}`})`, ['The installation is unchanged.']);
  let policy: InstallPolicy;
  try {
    policy = releaseInstallPolicy(view.stdout);
  } catch {
    throw new CliExit(1, `npm view ${HOST_PACKAGE}@${target} --json printed no JSON`, ['The installation is unchanged.']);
  }
  const manifestBefore = writeInstallPolicy(installDir, policy, target);
  const install = spawnSync(...npmInvocation(['install', `${HOST_PACKAGE}@${target}`, '--save-exact']), { cwd: installDir, stdio: 'inherit' });
  if (install.status !== 0) {
    if (manifestBefore !== null) writeFileSync(join(installDir, 'package.json'), manifestBefore);
    throw new CliExit(1, `npm install failed (${install.error?.message ?? `exit ${install.status}`})`, ['The installation is unchanged.']);
  }
  console.log(`\n  ${ok} installed.`);

  // The post-install steps run in the code that was just installed: re-exec its bin.
  const work = mkdtempSync(join(tmpdir(), 'neuralis-update-'));
  try {
    const swapped = ['update', '--apply', '--host-swapped', ...(args.asJson ? ['--json'] : [])];
    if (manifest) {
      writeFileSync(join(work, 'release-manifest.json'), JSON.stringify(manifest));
      swapped.push('--manifest', join(work, 'release-manifest.json'));
    } else {
      swapped.push('--version', target);
    }
    const next = spawnSync(process.execPath, [join(packageDir, 'bin', 'neuralis.mjs'), ...swapped], {
      cwd: installDir,
      stdio: 'inherit',
      env: { ...process.env, NEURALIS_UPDATE_PREVIOUS: host.current },
    });
    return next.status ?? 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * An image-only folder moves with its image: the target is used when present
 * (`docker image inspect` — a version tag never changes) or pulled, and a
 * failed pull moves nothing. The post-move steps run in the target image: in
 * this process when it already is that image, else in a one-shot container of
 * it with the same mounts — the manifest written into the bound folder (this
 * container's /tmp is invisible there) and removed once it returns.
 */
async function moveImage(input: { args: UpdateArgs; ctx: CliContext; manifest: ReleaseManifest | null; tag: ReturnType<typeof imageTagAfterUpdate>; target: string; previous: string }): Promise<number> {
  const { args, ctx, manifest, tag, target, previous } = input;
  const image = `${HOST_IMAGE}:${target}`;
  if (spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { stdio: 'ignore' }).status !== 0) {
    console.log(`  ${dot} pulling        : ${c.bold}${image}${c.reset}`);
    const pull = spawnSync('docker', ['pull', image], { stdio: 'inherit' });
    if (pull.status !== 0) throw new CliExit(1, `docker pull ${image} failed (${pull.error?.message ?? `exit ${pull.status}`})`, ['The installation is unchanged.']);
  }
  const layout: InstallLayout = 'image';
  if (hostVersion(ctx.packageDir) === target) return afterHostSwap({ args, ctx, layout, manifest, tag, previous });
  if (predatesImageKind(target)) {
    // That release's host bin cannot run in an image-only folder (it moves the line DOWN): the steps run
    // in this code, and only the compose file comes from the target — its own-tree form, as that release documents.
    const regenerate = imageRunCommand(ctx, { installDir: ctx.installDir, image, homeParent: false, env: [], workdir: null, command: ['node', 'bin/neuralis.mjs', 'setup', '--compose-only', '--output', ctx.installDir] });
    return afterHostSwap({ args, ctx, layout, manifest, tag, previous, regenerate: { file: 'docker', args: regenerate } });
  }
  const manifestFile = join(ctx.installDir, `.neuralis-update-${process.pid}.json`);
  try {
    const swapped = ['update', '--apply', '--host-swapped', ...(args.asJson ? ['--json'] : [])];
    if (manifest) {
      writeFileSync(manifestFile, JSON.stringify(manifest));
      swapped.push('--manifest', manifestFile);
    } else {
      swapped.push('--version', args.targetVersion!);
    }
    const run = imageRunCommand(ctx, { installDir: ctx.installDir, image, homeParent: false, env: [['NEURALIS_UPDATE_PREVIOUS', previous]], command: ['node', IMAGE_HOST_BIN, ...swapped] });
    const next = spawnSync('docker', run, { cwd: ctx.installDir, stdio: 'inherit' });
    return next.status ?? 1;
  } finally {
    rmSync(manifestFile, { force: true });
  }
}

/** The release tag the folder's generated compose file pins for the app image, or null (none, or a derived/custom image). */
export function composeImageTag(installDir: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(installDir, 'docker-compose.yml'), 'utf-8');
  } catch {
    return null;
  }
  return new RegExp(`^ +image: ${HOST_IMAGE.replace('/', '\\/')}:(\\S+)$`, 'm').exec(text)?.[1] ?? null;
}

/**
 * The release tag the folder's app container was created from (the image reference itself when it
 * is not a release image); null when the app is not running; undefined when Docker cannot say.
 */
async function runningImageTag(plan: StackPlan, ports: Pick<StackPorts, 'exec'>): Promise<string | null | undefined> {
  if (typeof plan.stack === 'string') return undefined;
  if (!plan.stack.running.includes(plan.stack.app)) return null;
  const ps = await ports.exec('docker', ['compose', '-p', plan.project, 'ps', '--format', '{{.Image}}', plan.stack.app], { cwd: plan.folder, tee: false }).catch(() => null);
  const image = ps?.code === 0 ? ps.stdout.trim().split('\n')[0]?.trim() ?? '' : '';
  if (!image) return undefined;
  return image.startsWith(`${HOST_IMAGE}:`) ? image.slice(HOST_IMAGE.length + 1) : image;
}

/** The `.env` image tag against the line's, when the line moves it. */
async function imageRow(installDir: string, tag: ReturnType<typeof imageTagAfterUpdate>): Promise<{ current: string; target: string; unchanged: boolean } | null> {
  if (!tag.move) return null;
  const configDir = resolveConfigDir({ projectRoot: installDir, neuralisHome: resolveNeuralisHome().home }, null);
  const current = (await readEnvFile(configDir)).NEURALIS_IMAGE_TAG?.trim() || '(none)';
  return { current, target: tag.tag, unchanged: current === tag.tag };
}

/** Image tag, companions, then the stack (a folder) or the printed steps (a clone) — in the code of the line being moved to. */
async function afterHostSwap(input: {
  args: UpdateArgs;
  ctx: CliContext;
  layout: InstallLayout;
  manifest: ReleaseManifest | null;
  tag: ReturnType<typeof imageTagAfterUpdate>;
  previous: string | null;
  /** The compose regeneration in another image (`moveImage`, a target that predates the image kind). */
  regenerate?: { file: string; args: readonly string[] };
}): Promise<number> {
  const { args, ctx, layout, manifest, tag } = input;
  /** What moved before the stack steps — a failed step reports it, never "nothing". */
  const moved: string[] = [];
  const previous = input.previous ?? ctx.env.NEURALIS_UPDATE_PREVIOUS ?? '<previous version>';
  const version = manifest ? manifest.packages[HOST_PACKAGE]! : args.targetVersion!;
  // First, so a failure here leaves the tag unmoved and a re-run comes back through this step.
  if (layout === 'folder') settleInstallPolicy(ctx.installDir, ctx.packageDir, layout, version);
  const neuralisHome = resolveNeuralisHome().home;
  const configDir = resolveConfigDir({ projectRoot: ctx.installDir, neuralisHome }, null);
  if (tag.move) {
    try {
      const { previous: was } = await upsertEnvValue(configDir, 'NEURALIS_IMAGE_TAG', tag.tag);
      if (was !== tag.tag) moved.push(`.env NEURALIS_IMAGE_TAG ${was ?? '(none)'} → ${tag.tag}`);
      console.log(`  ${ok} image tag      : ${was ?? '(none)'} → ${c.bold}${tag.tag}${c.reset} ${c.dim}(${configDir}/.env NEURALIS_IMAGE_TAG)${c.reset}`);
    } catch (err) {
      throw new CliExit(1, `the image tag in ${configDir}/.env could not be moved`, [
        err instanceof Error ? err.message : String(err),
        `Set NEURALIS_IMAGE_TAG=${tag.tag} there yourself, then`,
        `\`${spellOn(layout, 'setup --compose-only')}\` and \`docker compose up -d -V\`.`,
      ]);
    }
  } else {
    console.log(`  ${warn} image tag unchanged: ${tag.reason}`);
  }
  const images = companionVersionsFor({ manifest, targetVersion: args.targetVersion, onePackage: false });
  if (images) moved.push(...(await moveCompanionImages(images, configDir, neuralisHome)));
  if (layout === 'folder' || layout === 'image') {
    const code = await runStack({ ctx, layout, previous, moved, ...(input.regenerate ? { regenerate: input.regenerate } : {}) }, layout === 'image' ? IMAGE_PORTS : PROCESS_PORTS);
    if (code === 0) await retireEnvSessionSecret(configDir, neuralisHome);
    return code;
  }
  const steps: string[] = [
    `git fetch --tags && git checkout v${version} && npm install ${c.dim}(the code of this clone moves with the tag)${c.reset}`,
    `${spellOn(layout, 'setup --compose-only')} ${c.dim}(regenerate compose)${c.reset}`,
    'docker compose stop neuralis',
    `${spellOn(layout, 'upgrade --apply')} ${c.dim}(raises the stored data formats this release needs; nothing to do is fine)${c.reset}`,
    recreateStep(ctx.installDir, layout),
  ];
  console.log(`  ${dot} next: ${steps[0]}`);
  for (const step of steps.slice(1)) console.log(`  ${dot}       ${step}`);
  printWayBack(layout, previous, null);
  return 0;
}

/**
 * The `.env` `NEXTAUTH_SECRET` line, once the data home's session secret file
 * holds the same value (the `session-secret-v1` upgrade this run applied wrote
 * it): no build reads the line any more, so it goes. Kept while the file is
 * missing (the upgrade reads it) or differs (the upgrade's dry run names the
 * conflict, and the operator decides).
 */
export async function retireEnvSessionSecret(configDir: string, neuralisHome: string): Promise<boolean> {
  const line = (await readEnvFile(configDir)).NEXTAUTH_SECRET?.trim();
  if (!line || readSessionSecretFile(join(neuralisHome, 'app')) !== line) return false;
  const dropped = await dropEnvKey(configDir, 'NEXTAUTH_SECRET');
  if (dropped) console.log(`  ${ok} session secret : ${c.dim}${configDir}/.env no longer carries it (the data home's app/config/session-secret.key does)${c.reset}`);
  return dropped;
}

/**
 * Data first: an older build refuses to boot on data a newer one raised, and
 * the code line restarts the app. On a folder the code + images line is the
 * update itself — an explicit `--version` may move down, it moves the images and
 * writes that release's install policy back into the folder.
 */
/** A build from before the session secret moved into the data home reads it from `.env` only. */
const SESSION_SECRET_WAY_BACK = `${c.dim}a build that predates app/config/session-secret.key reads the secret from .env: put NEXTAUTH_SECRET=<that file's line> back there first${c.reset}`;

/** `upgradeRan`: false when this run raised no data format (none ran), undefined when the steps are the operator's. */
function printWayBack(layout: InstallLayout, previous: string, checkpoint: string | null, upgradeRan?: boolean): void {
  const data = upgradeRan === false
    ? `nothing to put back — no upgrade ran this time, the data is as it was`
    : `${spellOn(layout, `checkpoint restore ${checkpoint ?? '<id>'}`)} ${c.dim}(${checkpoint ? 'the checkpoint this upgrade took' : `no new checkpoint this run — a resumed upgrade keeps its first run's; \`${spellOn(layout, 'checkpoint list')}\` names it`})${c.reset}`;
  if (layout === 'clone') {
    console.log(`  ${dot} going back (app stopped):`);
    console.log(`  ${dot}   data   : ${data}`);
    console.log(`  ${dot}   code   : git checkout v${previous} && npm install`);
    console.log(`  ${dot}   images : ${spellOn(layout, `update --manifest <the ${previous} release-manifest.json> --apply`)} ${c.dim}(or write the previous NEURALIS_IMAGE_TAG / NEURALIS_MACHINE_IMAGE back into .env)${c.reset}`);
    console.log(`  ${dot}   ${SESSION_SECRET_WAY_BACK}`);
  } else {
    console.log(`  ${dot} going back (the update stops and restarts the app itself):`);
    // `checkpoint restore` is offline-only: it refuses while the app the update restarted is running.
    console.log(`  ${dot}   data           : ${upgradeRan === false ? data : `docker compose stop neuralis && ${data}`}`);
    console.log(`  ${dot}   code + images  : ${spellOn(layout, `update --version ${previous} --apply`)}`);
    console.log(`  ${dot}   ${SESSION_SECRET_WAY_BACK}`);
  }
  console.log('');
}

type StackSettings = { folder: string; project: string; appPort: number; recreate: 'up' | 'rebuild' };
type StackPlan = StackSettings & { stack: ComposeStack | string };

/** What the stack half acts on, read from the folder's `.env` and manifest. */
async function stackSettings(installDir: string): Promise<StackSettings> {
  return {
    folder: installDir,
    project: composeProjectOf(installDir),
    appPort: appPort(await readEnvFile(installDir)),
    recreate: recreateKind(installDir),
  };
}

/** The settings plus the stack its compose file and Docker report (the dry run's view, before any regeneration). */
async function stackPlan(installDir: string, ports: Pick<StackPorts, 'exec'>): Promise<StackPlan> {
  const settings = await stackSettings(installDir);
  return { ...settings, stack: await stackOf(installDir, ports) };
}

function stackJson(plan: StackPlan): Record<string, unknown> {
  const { stack, ...rest } = plan;
  return typeof stack === 'string' ? { ...rest, unavailable: stack } : { ...rest, app: stack.app, vectorstore: stack.vectorstore, running: stack.running };
}

function printStackPlan(plan: StackPlan, layout: InstallLayout): void {
  const { stack } = plan;
  console.log(`  ${dot} folder         : ${c.bold}${plan.folder}${c.reset}`);
  if (typeof stack === 'string') {
    console.log(`  ${warn} stack          : ${stack} — an apply moves the code and the image tags and restarts nothing`);
    console.log('');
    return;
  }
  const state = (service: string): string => (stack.running.includes(service) ? 'running' : 'stopped');
  console.log(`  ${dot} compose project: ${c.bold}${stack.project}${c.reset} ${c.dim}(app service ${stack.app}: ${state(stack.app)}${stack.vectorstore ? `, vector store ${stack.vectorstore}: ${state(stack.vectorstore)}` : ''})${c.reset}`);
  console.log(`  ${dot} health         : http://127.0.0.1:${plan.appPort}/api/health`);
  console.log(`  ${dot} --apply then runs:`);
  for (const command of stackCommands({ stack, project: plan.project, recreate: plan.recreate, spellVerb: (verb) => spellOn(layout, verb) })) {
    console.log(`  ${dot}   ${command}`);
  }
  console.log('');
}

/** The stack half on a folder, in the code just installed. Exit 1 at the first failed step. */
export async function runStack(input: { ctx: CliContext; layout: InstallLayout; previous: string; moved?: readonly string[]; regenerate?: { file: string; args: readonly string[] } }, ports: StackPorts): Promise<number> {
  const { ctx, layout, previous } = input;
  const plan = await stackSettings(ctx.installDir);
  if (!existsSync(join(ctx.installDir, 'docker-compose.yml'))) {
    console.log(`  ${dot} no docker-compose.yml in this folder: nothing runs yet. ${spellOn(layout, 'setup')} writes it on the new code.`);
    printWayBack(layout, previous, null, false);
    return 0;
  }
  const outcome = await applyStack({
    installDir: ctx.installDir, packageDir: ctx.packageDir, project: plan.project, appPort: plan.appPort, recreate: plan.recreate,
    plane: layout === 'image' ? 'image' : 'host', ...(input.regenerate ? { regenerate: input.regenerate } : {}),
    ...(layout === 'image' ? { upgradeBinds: upgradeDeviceBinds(ctx.env, resolveNeuralisHome(ctx.env as NodeJS.ProcessEnv).home) } : {}),
  }, ports);
  console.log('');
  if (outcome.ok) {
    // A regeneration by another release's setup wrote no install record: this code writes it.
    if (input.regenerate) await recordInstall(resolveNeuralisHome().home, ctx.installDir);
    // Readiness is named where it was proved: an image-only folder's probe ran inside the stack.
    const where = layout === 'image'
      ? `the app answers ready inside the stack (service ${outcome.app}); this command ran in a container and did not reach http://127.0.0.1:${plan.appPort} — open it on the host to confirm`
      : `the app answers ready on http://127.0.0.1:${plan.appPort}`;
    console.log(`  ${ok} ${c.bold}updated${c.reset}: ${where} (${outcome.seconds} s after the recreate)`);
    if (outcome.checkpoint) console.log(`  ${dot} checkpoint     : ${outcome.checkpoint} ${c.dim}(the data before this upgrade)${c.reset}`);
    printWayBack(layout, previous, outcome.checkpoint, outcome.upgradeRan);
    return 0;
  }
  console.log(`  ${c.red}✗${c.reset} ${c.bold}stopped at ${outcome.step}${c.reset}: ${outcome.reason}`);
  const before = [...(input.moved ?? []), ...(outcome.regenerated && !outcome.done.includes('compose') ? ['docker-compose.yml regenerated'] : []), ...outcome.done];
  console.log(`  ${dot} done before it : ${before.length > 0 ? before.join(', ') : 'nothing'} — nothing after it ran`);
  const stack = outcome.stack;
  const commands = stackCommands({ stack, project: plan.project, recreate: plan.recreate, spellVerb: (verb) => spellOn(layout, verb) });
  const remaining = commands.slice(commandIndexOf(outcome.step, stack));
  console.log(`  ${dot} to continue by hand once the cause is fixed: ${remaining.join(' → ')}`);
  printWayBack(layout, previous, outcome.checkpoint, outcome.upgradeRan);
  return 1;
}

/** Where a failed step's command sits in `stackCommands` (the vector-store line is present only with a vector store). */
function commandIndexOf(step: string, stack: ComposeStack | null): number {
  const order = ['compose', 'stop', ...(stack?.vectorstore ? ['vector store'] : []), 'upgrade', 'recreate', 'health'];
  return Math.max(0, order.indexOf(step));
}

/**
 * The companion versions an applied update moves to: a manifest names them; an
 * all-package `--version` IS them (one release, one version across every
 * artifact); a single-package run moves none.
 */
export function companionVersionsFor(input: { manifest: ReleaseManifest | null; targetVersion: string | null; onePackage: boolean }): Readonly<Record<string, string>> | null {
  if (input.onePackage) return null;
  if (input.manifest) return input.manifest.images;
  return input.targetVersion ? { [WEBTOP_IMAGE]: input.targetVersion, [SIDECAR_IMAGE]: input.targetVersion } : null;
}

/**
 * Move every companion image the install pins to the release default onto the
 * line's version, through the two writers setup owns (`upsertEnvValue` for
 * `.env`, `writeMergedPlatformConfig` for platform.json). A custom image is
 * reported and left. The packages are already installed when this runs, so a
 * failed write names the exact manual edit.
 */
export async function moveCompanionImages(images: Readonly<Record<string, string>>, configDir: string, neuralisHome: string): Promise<string[]> {
  const env = await readEnvFile(configDir);
  const platform = await readPlatformConfig(neuralisHome);
  const platformMoves: Record<string, string> = {};
  const moved: string[] = [];
  for (const setting of PINNED_COMPANIONS) {
    const raw = setting.where === 'env' ? env[setting.key] : platform[setting.key];
    const where = setting.where === 'env' ? `${configDir}/.env ${setting.key}` : `platform.json ${setting.key}`;
    const move = companionImageMove(typeof raw === 'string' ? raw : raw === undefined ? undefined : JSON.stringify(raw), setting.repository, images[setting.repository]);
    if (move.kind === 'absent' || move.kind === 'same') continue;
    if (move.kind === 'keep') {
      console.log(`  ${warn} ${where} kept: ${move.value} — ${move.reason}`);
      continue;
    }
    if (setting.where === 'platform') {
      platformMoves[setting.key] = move.to;
      console.log(`  ${ok} ${where}: ${move.from} → ${c.bold}${move.to}${c.reset}`);
      moved.push(`platform.json ${setting.key} → ${move.to}`);
      continue;
    }
    try {
      await upsertEnvValue(configDir, setting.key, move.to);
      console.log(`  ${ok} ${where}: ${move.from} → ${c.bold}${move.to}${c.reset}`);
      moved.push(`.env ${setting.key} → ${move.to}`);
    } catch (err) {
      throw new CliExit(1, `the packages are installed, but ${where} could not be moved`, [err instanceof Error ? err.message : String(err), `Set ${setting.key}=${move.to} there yourself.`]);
    }
  }
  if (Object.keys(platformMoves).length === 0) return moved;
  try {
    await writeMergedPlatformConfig(neuralisHome, {}, platformMoves);
  } catch (err) {
    throw new CliExit(1, 'the packages are installed, but platform.json could not be updated', [err instanceof Error ? err.message : String(err), `Set ${Object.entries(platformMoves).map(([k, v]) => `${k}=${v}`).join(', ')} through Admin → Config yourself.`]);
  }
  return moved;
}
