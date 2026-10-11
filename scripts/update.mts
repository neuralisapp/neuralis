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
 *   - a clone of the public host repository: the code moves with
 *     `git fetch --tags && git checkout v<v>`, which this command PRINTS and
 *     never runs — a checkout is the operator's working tree.
 *   - the development checkout: refused; the update there is `git pull`.
 *   - inside the container: refused; a pulled image has no folder to move —
 *     its update is the two `.env` lines on the host.
 *
 * THE STACK (an npm install folder, `--apply`): after the moves below the
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
import { join } from 'node:path';

import { resolveNeuralisHome } from '@neuralis/package-system/paths';
import { compareReleaseVersions, MANIFEST_VERSION, parseReleaseManifest, type ReleaseManifest } from '@neuralis/package-system/contracts';
import { appPort } from './checkpoint.mts';
import { CliExit, type CliContext } from './cli/registry.mts';
import { installLayout, spellOn, type InstallLayout } from './cli/spelling.mts';
import { composeProjectOf } from './host-broker/helper.mts';
import { operatorDependencies } from './setup/compose.mts';
import { loadHostEnv, resolveConfigDir } from './setup/detect.mts';
import { discoverBuiltinDeps } from './setup/discoverPackages.mts';
import { imageTagAfterUpdate, readEnvFile, upsertEnvValue } from './setup/envFile.mts';
import { readPlatformConfig, writeMergedPlatformConfig } from './setup/platformConfig.mts';
import { applyStack, outsideComposeRefusal, PROCESS_PORTS, stackCommands, stackOf, type ComposeStack, type StackPorts } from './update/stack.mts';

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

/**
 * The line plan: the host package itself, then every `@neuralis/*` package the
 * line names that this install carries (they move WITH the host — it pins them).
 */
export function planLine(input: { target: string; manifest: ReleaseManifest | null; installDir: string; packageDir: string; layout: InstallLayout }): PlanRow[] {
  const current = input.layout === 'folder' ? installedVersion(input.installDir, HOST_PACKAGE) : hostVersion(input.packageDir) ?? '(unknown)';
  const rows: PlanRow[] = [{ name: HOST_PACKAGE, current, target: input.target, unchanged: current === input.target }];
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

const HOST_IMAGE = 'neuralisapp/neuralis';
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

function refuseLayout(layout: InstallLayout, args: UpdateArgs): never {
  if (layout === 'monorepo') {
    throw new CliExit(1, 'this is the development checkout — there is nothing to update from a registry', [
      'The packages here are the source. Update it with `git pull`, then `pnpm install`',
      'and `pnpm neuralis:rebuild`.',
    ]);
  }
  if (layout === 'container') {
    throw new CliExit(1, 'this runs inside the container — a pulled image has no install folder to move', [
      'On the host, in the folder that holds .env and docker-compose.yml: set NEURALIS_IMAGE_TAG=<version>',
      'and NEURALIS_MACHINE_IMAGE=neuralisapp/webtop-ubuntu-xfce:<version> in .env (a pinned',
      'mcpSidecarImage is an Admin → Config edit), then `docker compose stop neuralis`,',
      '`docker compose run --rm --no-deps neuralis node bin/neuralis.mjs upgrade --apply`, `docker compose up -d -V`.',
    ]);
  }
  throw new CliExit(1, 'this folder is the host package itself, not an npm install folder or a git clone', [
    `Move it to the npm layout once, with the app stopped: npx --yes create-neuralis@${args.targetVersion ?? '<version>'} convert .`,
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
  const result = spawnSync('npm', ['install', `${match.name}@${args.targetVersion}`, '--save-exact'], { cwd: installDir, stdio: 'inherit' });
  if (result.status !== 0) throw new CliExit(1, `npm install failed (exit ${result.status})`, ['The installation is unchanged.']);
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
  if (layout !== 'folder' && layout !== 'clone') refuseLayout(layout, args);
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

  const plan = planLine({ target, manifest, installDir, packageDir, layout });
  if (args.hostSwapped) return afterHostSwap({ args, ctx, layout, manifest, tag, previous: null });

  const refusal = downgradeRefusal(manifest?.version ?? target, hostVersion(packageDir), args.manifestExplicit || args.manifestSource === null);
  if (refusal) throw new CliExit(1, refusal, [`To move to an older line on purpose, name it: ${spellOn(layout, 'update --manifest <url|file> --apply')}`]);

  const host = plan[0]!;
  // The image the container runs is install state of its own: a folder already
  // on the line's code (a fresh `convert`, an interrupted update) still moves it.
  const image = await imageRow(ctx.installDir, tag);
  const stack = layout === 'folder' ? await stackPlan(installDir, PROCESS_PORTS) : null;
  if (args.asJson) {
    console.log(JSON.stringify({ layout, plan, image, ...(stack ? { stack: stackJson(stack) } : {}), apply: args.apply }, null, 2));
    if (!args.apply) return 0;
  } else {
    console.log('');
    console.log(`  ${c.cyan}${c.bold}── neuralis update ${'─'.repeat(35)}${c.reset}`);
    console.log(`  ${dot} layout         : ${c.bold}${layout === 'folder' ? 'npm install folder' : 'git clone'}${c.reset}`);
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
  if (host.unchanged && (!image || image.unchanged)) {
    console.log(`  ${ok} already on ${host.target}.\n`);
    return 0;
  }
  if (!args.apply) {
    console.log(`  ${warn} dry run — nothing changed. Re-run with ${c.bold}--apply${c.reset}.\n`);
    return 0;
  }
  // Decided before anything moves: a process outside compose would keep serving the old code.
  const outside = stack && typeof stack.stack !== 'string' ? await outsideComposeRefusal(stack.stack, stack.appPort, PROCESS_PORTS) : null;
  if (outside) {
    throw new CliExit(1, `${outside} — nothing was changed`, [
      'Stop that process, run this update again, then start it the way you started it before.',
    ]);
  }
  // The code is already the line's: only the post-install steps remain, in this process.
  if (host.unchanged) return afterHostSwap({ args, ctx, layout, manifest, tag, previous: null });

  if (layout === 'clone') return afterHostSwap({ args, ctx, layout, manifest, tag, previous: host.current });

  console.log(`  ${dot} installing     : ${c.bold}${HOST_PACKAGE}@${target}${c.reset}`);
  const install = spawnSync('npm', ['install', `${HOST_PACKAGE}@${target}`, '--save-exact'], { cwd: installDir, stdio: 'inherit' });
  if (install.status !== 0) throw new CliExit(1, `npm install failed (exit ${install.status})`, ['The installation is unchanged.']);
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

/** The `.env` image tag against the line's, when the line moves it. */
async function imageRow(installDir: string, tag: ReturnType<typeof imageTagAfterUpdate>): Promise<{ current: string; target: string; unchanged: boolean } | null> {
  if (!tag.move) return null;
  const configDir = resolveConfigDir({ isClone: false, projectRoot: installDir, neuralisHome: resolveNeuralisHome().home }, null);
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
}): Promise<number> {
  const { args, ctx, layout, manifest, tag } = input;
  const previous = input.previous ?? ctx.env.NEURALIS_UPDATE_PREVIOUS ?? '<previous version>';
  const neuralisHome = resolveNeuralisHome().home;
  const configDir = resolveConfigDir({ isClone: false, projectRoot: ctx.installDir, neuralisHome }, null);
  if (tag.move) {
    try {
      const { previous: was } = await upsertEnvValue(configDir, 'NEURALIS_IMAGE_TAG', tag.tag);
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
  if (images) await moveCompanionImages(images, configDir, neuralisHome);
  const version = manifest ? manifest.packages[HOST_PACKAGE]! : args.targetVersion!;
  if (layout === 'folder') return runStack({ ctx, layout, previous }, PROCESS_PORTS);
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

function printWayBack(layout: InstallLayout, previous: string, checkpoint: string | null): void {
  console.log(`  ${dot} going back (app stopped):`);
  console.log(`  ${dot}   code   : ${layout === 'clone' ? `git checkout v${previous} && npm install` : `npm install ${HOST_PACKAGE}@${previous} --save-exact`}`);
  console.log(`  ${dot}   images : ${spellOn(layout, `update --manifest <the ${previous} release-manifest.json> --apply`)} ${c.dim}(or write the previous NEURALIS_IMAGE_TAG / NEURALIS_MACHINE_IMAGE back into .env)${c.reset}`);
  console.log(`  ${dot}   data   : ${spellOn(layout, `checkpoint restore ${checkpoint ?? '<id>'}`)} ${c.dim}(${checkpoint ? 'the checkpoint this upgrade took' : `no new checkpoint this run — a resumed upgrade keeps its first run's; \`${spellOn(layout, 'checkpoint list')}\` names it`})${c.reset}`);
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
export async function runStack(input: { ctx: CliContext; layout: InstallLayout; previous: string }, ports: StackPorts): Promise<number> {
  const { ctx, layout, previous } = input;
  const plan = await stackSettings(ctx.installDir);
  if (!existsSync(join(ctx.installDir, 'docker-compose.yml'))) {
    console.log(`  ${dot} no docker-compose.yml in this folder: nothing runs yet. ${spellOn(layout, 'setup')} writes it on the new code.`);
    printWayBack(layout, previous, null);
    return 0;
  }
  const outcome = await applyStack({ installDir: ctx.installDir, packageDir: ctx.packageDir, project: plan.project, appPort: plan.appPort, recreate: plan.recreate }, ports);
  console.log('');
  if (outcome.ok) {
    console.log(`  ${ok} ${c.bold}updated${c.reset}: the app answers ready on http://127.0.0.1:${plan.appPort} (${outcome.seconds} s after the recreate)`);
    if (outcome.checkpoint) console.log(`  ${dot} checkpoint     : ${outcome.checkpoint} ${c.dim}(the data before this upgrade)${c.reset}`);
    printWayBack(layout, previous, outcome.checkpoint);
    return 0;
  }
  console.log(`  ${c.red}✗${c.reset} ${c.bold}stopped at ${outcome.step}${c.reset}: ${outcome.reason}`);
  console.log(`  ${dot} done before it : ${outcome.done.length > 0 ? outcome.done.join(', ') : 'nothing'} — nothing after it ran`);
  const stack = outcome.stack;
  const commands = stackCommands({ stack, project: plan.project, recreate: plan.recreate, spellVerb: (verb) => spellOn(layout, verb) });
  const remaining = commands.slice(commandIndexOf(outcome.step, stack));
  console.log(`  ${dot} to continue by hand once the cause is fixed: ${remaining.join(' → ')}`);
  printWayBack(layout, previous, outcome.checkpoint);
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
export async function moveCompanionImages(images: Readonly<Record<string, string>>, configDir: string, neuralisHome: string): Promise<void> {
  const env = await readEnvFile(configDir);
  const platform = await readPlatformConfig(neuralisHome);
  const platformMoves: Record<string, string> = {};
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
      continue;
    }
    try {
      await upsertEnvValue(configDir, setting.key, move.to);
      console.log(`  ${ok} ${where}: ${move.from} → ${c.bold}${move.to}${c.reset}`);
    } catch (err) {
      throw new CliExit(1, `the packages are installed, but ${where} could not be moved`, [err instanceof Error ? err.message : String(err), `Set ${setting.key}=${move.to} there yourself.`]);
    }
  }
  if (Object.keys(platformMoves).length === 0) return;
  try {
    await writeMergedPlatformConfig(neuralisHome, {}, platformMoves);
  } catch (err) {
    throw new CliExit(1, 'the packages are installed, but platform.json could not be updated', [err instanceof Error ? err.message : String(err), `Set ${Object.entries(platformMoves).map(([k, v]) => `${k}=${v}`).join(', ')} through Admin → Config yourself.`]);
  }
}
