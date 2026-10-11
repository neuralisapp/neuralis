#!/usr/bin/env node
/**
 * Channel #1 clean-room rehearsal: `npm create neuralis` end to end.
 *
 * Publishes every shippable package to an EPHEMERAL local registry, then
 * scaffolds a fresh install from it exactly the way a stranger would — with a
 * cold npm cache, through the real `npm create` entry point, against a tree
 * that has never seen this workspace.
 *
 * What it proves: the tarballs resolve each other, the scaffolder produces a
 * runnable install folder (an npm project depending on the exact `neuralis`),
 * the pinned dependency graph installs clean, and the folder's `neuralis` bin
 * answers. The UPGRADE branch then proves the folder half of an update from the
 * previous published line: a real `<previous>` folder scaffolded from the public
 * registry (read-only), converted by the CANDIDATE scaffolder from the local
 * registry, keeps the operator's `.env`, compose override and registered package
 * line, carries the new operator scripts, and plans `update` from a release
 * manifest. What it does NOT prove: image distribution (channel #2) and the
 * data/image half of an upgrade (a previous-line data home, the candidate image,
 * `upgrade --apply`) — those need a published image and run as a live row.
 *
 * Nothing here WRITES to the real npm registry: the local registry URL is
 * passed per-command, publishing uses a throwaway token on 127.0.0.1, and the
 * upgrade branch only READS the previous line from the public registry.
 *
 *   node neuralis/scripts/build/channel1-rehearsal.mjs [--keep] [--from <previous>] [--no-upgrade]
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REGISTRY_PORT = 4873;
const REGISTRY = `http://127.0.0.1:${REGISTRY_PORT}`;
const KEEP = process.argv.includes('--keep');
const PUBLIC_REGISTRY = 'https://registry.npmjs.org';
const FROM = process.argv.includes('--from') ? process.argv[process.argv.indexOf('--from') + 1] : '0.1.0';
const UPGRADE = !process.argv.includes('--no-upgrade');

/** The publish set: 5 scoped packages + the host + the scaffolder itself.
 *  The scaffolder MUST be published too — `npm create neuralis` resolves it
 *  from the registry, so without it the rehearsal would silently test the real
 *  registry's name-stub instead of this tree. */
const PACKAGES = [
  'packages/package-system',
  'packages/agent-core',
  'packages/brain-core',
  'packages/admin',
  'packages/machine-core',
  'neuralis',
  'create-neuralis',
];

const c = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m' };
const step = (msg) => console.log(`\n${c.cyan}▸${c.reset} ${c.bold}${msg}${c.reset}`);
const ok = (msg) => console.log(`  ${c.green}✓${c.reset} ${msg}`);
const die = (msg, detail) => {
  console.error(`\n${c.red}✗${c.reset} ${msg}`);
  if (detail) console.error(`${c.dim}${detail}${c.reset}`);
  process.exit(1);
};

function sh(command, args, options = {}) {
  const r = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (r.error) die(`could not run ${command}`, r.error.message);
  if (r.status !== 0) {
    die(`${command} ${args.join(' ')} failed (exit ${r.status})`, `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim());
  }
  return r.stdout ?? '';
}

async function waitForRegistry(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${REGISTRY}/-/ping`);
      if (res.ok || res.status === 404) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  die(`local registry did not come up on ${REGISTRY} within ${timeoutMs / 1000}s`);
}

// The scratch tree, the local registry's config and the cleanup exist only
// while a rehearsal RUNS — the suite imports this module for its pure checks.
let workdir = '';
let npmCache = '';
let scaffoldParent = '';
let target = '';
let configPath = '';
let registry;

function prepareWorkdir() {
  workdir = mkdtempSync(join(tmpdir(), 'neuralis-channel1-'));
  const storage = join(workdir, 'verdaccio-storage');
  npmCache = join(workdir, 'npm-cache');
  scaffoldParent = join(workdir, 'clean-room');
  target = join(scaffoldParent, 'my-neuralis');
  mkdirSync(storage, { recursive: true });
  mkdirSync(npmCache, { recursive: true });
  mkdirSync(scaffoldParent, { recursive: true });

  configPath = join(workdir, 'verdaccio.yaml');
  writeFileSync(
    configPath,
    `storage: ${storage}
auth:
  htpasswd:
    file: ${join(workdir, 'htpasswd')}
    max_users: 1
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
    maxage: 60m
packages:
  # OUR packages are local-only: no proxy, so one this rehearsal forgot to
  # publish fails loudly instead of silently resolving from the real registry
  # (where a reserved name-stub would answer and we would test the wrong code).
  '@neuralis/*':
    access: $all
    publish: $all
    unpublish: $all
  'neuralis':
    access: $all
    publish: $all
    unpublish: $all
  'create-neuralis':
    access: $all
    publish: $all
    unpublish: $all
  # Everything else is third-party and comes from upstream, exactly as it would
  # on a stranger's machine.
  '**':
    access: $all
    proxy: npmjs
log: { type: stdout, format: pretty, level: warn }
`,
  );
  process.on('exit', cleanup);
  process.on('SIGINT', () => process.exit(130));
}

function cleanup() {
  if (registry?.pid && !registry.killed) {
    try { process.kill(-registry.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  if (!KEEP) rmSync(workdir, { recursive: true, force: true });
  else console.log(`\n${c.dim}kept: ${workdir}${c.reset}`);
}

/**
 * A publish rehearsal has to run against the SHIPPABLE tree. A machine-local
 * (`file:`/`link:`) dep line is legitimate operator state, but it is stripped
 * from every shippable artifact — and the host's prepack guard refuses to pack
 * with one present, exactly as a real publish would. Say so up front instead of
 * failing three packages in.
 */
function assertShippableTree() {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'neuralis', 'package.json'), 'utf8'));
  const machineLocal = Object.entries(manifest.dependencies ?? {}).filter(
    ([, spec]) => typeof spec === 'string' && (spec.startsWith('file:') || spec.startsWith('link:')),
  );
  if (machineLocal.length === 0) return;
  console.error(`\n${c.red}✗${c.reset} the host manifest carries machine-local dep(s):`);
  for (const [name, spec] of machineLocal) console.error(`    ${name}: ${spec}`);
  console.error(
    `${c.dim}A publish rehearsal must run against the shippable tree (a real publish runs from a\n` +
      `clean checkout). Remove them for the run and re-add afterwards:\n` +
      `  pnpm neuralis:pkg remove ${machineLocal[0][0]}\n` +
      `  node neuralis/scripts/build/channel1-rehearsal.mjs\n` +
      `  pnpm neuralis:pkg add ${machineLocal[0][0]} --path <dir>${c.reset}`,
  );
  process.exit(1);
}

async function main() {
  assertShippableTree();
  prepareWorkdir();

  step('building the package runtime and UI through the image build lifecycle');
  sh('pnpm', ['-r', '--sort', '--workspace-concurrency=1', '--filter', './packages/*',
    'exec', 'node', join(REPO_ROOT, 'neuralis/scripts/build/build-workspace.mjs'),
    'build-package', join(REPO_ROOT, 'packages/package-system')], { cwd: REPO_ROOT });

  step(`ephemeral registry on ${REGISTRY}`);
  // stderr is NOT inherited: verdaccio outlives a SIGTERM long enough to hold
  // the parent's stdout pipe open, which strands anything reading this script's
  // output through a pipe. Its log goes to the scratch dir instead.
  registry = spawn('npx', ['--yes', 'verdaccio@6', '--config', configPath, '--listen', String(REGISTRY_PORT)], {
    stdio: ['ignore', 'ignore', openSync(join(workdir, 'verdaccio.log'), 'a')],
    detached: true,
  });
  registry.unref();
  await waitForRegistry();
  ok('registry up (our packages local-only; third-party proxied upstream)');

  step('authenticating a throwaway publisher');
  const userconfig = join(workdir, '.npmrc-publisher');
  writeFileSync(userconfig, `${REGISTRY.replace('http:', '')}/:_authToken=rehearsal\nregistry=${REGISTRY}\n`);
  ok('token written (local only)');

  step(`publishing ${PACKAGES.length} packages`);
  // `pnpm publish`, NOT `npm publish`. The sibling dependencies between our
  // packages are declared with pnpm's `workspace:` protocol, and only pnpm
  // rewrites those to the resolved version as it packs. npm ships the literal
  // `workspace:*`, producing tarballs that fail to install with
  // EUNSUPPORTEDPROTOCOL — measured here before it could reach a registry.
  // The real publish workflow keeps the constraint a different way: pnpm packs,
  // and npm only uploads that finished tarball. pnpm takes its config
  // from `pnpm_config_*` env (measured on 12.6.0: `npm_config_registry` no longer
  // redirects it), and the token file is its `npmrcAuthFile` setting.
  for (const rel of PACKAGES) {
    const dir = join(REPO_ROOT, rel);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    sh(
      'pnpm',
      ['publish', '--registry', REGISTRY, '--tag', 'latest', '--no-git-checks'],
      { cwd: dir, env: { ...process.env, pnpm_config_npmrc_auth_file: userconfig, pnpm_config_registry: REGISTRY } },
    );
    ok(`${manifest.name}@${manifest.version}`);
  }

  step('clean-room scaffold: npm create neuralis');
  // Cold cache + the local registry, exactly what a stranger's machine looks
  // like — except the registry is ours.
  sh(
    'npm',
    ['create', 'neuralis', 'my-neuralis', '--yes', '--registry', REGISTRY, '--cache', npmCache],
    { cwd: scaffoldParent, stdio: 'inherit', env: { ...process.env, npm_config_registry: REGISTRY } },
  );
  ok(`scaffolded into ${target}`);

  step('verifying the install folder');
  const scaffolded = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
  const candidate = JSON.parse(readFileSync(join(REPO_ROOT, 'neuralis', 'package.json'), 'utf8')).version;
  if (scaffolded.dependencies?.neuralis !== candidate || Object.keys(scaffolded.dependencies).length !== 1 || scaffolded.private !== true) {
    die(`the install folder's package.json is ${JSON.stringify(scaffolded)}, expected { private: true, dependencies: { neuralis: "${candidate}" } }`);
  }
  ok(`install folder depends on neuralis@${candidate}, exactly`);

  const npmrc = readFileSync(join(target, '.npmrc'), 'utf8');
  if (!npmrc.includes('save-exact=true')) die('.npmrc is missing save-exact=true (pins would erode)');
  ok('.npmrc pins exactly');

  const host = join(target, 'node_modules', 'neuralis');
  for (const rel of ['bin/neuralis.mjs', 'src', 'scripts', 'skills', 'Dockerfile', 'next.config.ts']) {
    if (!existsSync(join(host, rel))) die(`node_modules/neuralis is missing ${rel} — check the host files whitelist`);
  }
  ok('the host package carries its runtime surface (bin, src, scripts, skills, Dockerfile, next.config.ts)');

  const hostManifest = JSON.parse(readFileSync(join(host, 'package.json'), 'utf8'));
  for (const dep of Object.keys(hostManifest.dependencies ?? {}).filter((d) => d.startsWith('@neuralis/'))) {
    const installed = join(target, 'node_modules', dep, 'package.json');
    if (!existsSync(installed)) die(`${dep} did not install into the install folder`);
  }
  ok('every @neuralis/* package the host pins installed from the local registry');

  const help = sh(join(target, 'node_modules', '.bin', 'neuralis'), ['--help'], { cwd: target });
  if (!help.includes('setup')) die('`npx neuralis --help` does not list the setup verb — the printed next step would be wrong');
  ok('next step is runnable: npx neuralis setup');

  const upgrade = UPGRADE ? await rehearseFolderUpgrade({ userconfig, candidate }) : 'off';

  console.log(`\n${c.green}${c.bold}channel #1 rehearsal PASSED${c.reset}`);
  console.log(`${c.dim}${summaryLines({ upgrade, from: FROM, candidate }).join('\n')}${c.reset}\n`);
}

/**
 * What the run proved — and, when the upgrade branch did not run, that it did
 * not: a SKIPPED branch is named as one, never folded into "proven".
 * @param {{ upgrade: 'ran' | 'skipped' | 'off', from: string, candidate: string }} run
 */
export function summaryLines({ upgrade, from, candidate }) {
  const proven = ['publish → npm create → install folder → pinned install → runnable bin'];
  if (upgrade === 'ran') proven.push(`${from} folder converted by the candidate, operator state kept, operator verbs load from node_modules, update planned, rolled back byte-exact`);
  const lines = [`Proven: ${proven.join(' → ')}.`];
  if (upgrade === 'skipped') lines.push(`Upgrade branch: SKIPPED — the candidate is ${candidate}, the same as --from ${from}; convert was NOT exercised (bump the candidate: pnpm release:version <next>).`);
  if (upgrade === 'off') lines.push('Upgrade branch: off (--no-upgrade); convert was NOT exercised.');
  lines.push('Not proven here: image distribution (channel #2), the data/image half of an upgrade, and the wizard run itself.');
  return lines;
}

/**
 * `npx` reads its OWN options only before the package spec; everything after it
 * goes to the package's bin (the scaffolder refuses `--registry` as unknown).
 * @param {string} spec @param {string[]} args @param {{ registry: string, cache: string }} npm
 */
export function npxArgs(spec, args, { registry, cache }) {
  return ['--yes', '--registry', registry, '--cache', cache, spec, ...args];
}

/** A port nothing listens on, so the converter's offline probe never meets this machine's running app. */
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** What `convert` must have kept and moved — exported for the suite, which runs it on a synthetic folder. */
export function convertedFolderProblems({ dir, before, candidate, sentinelDep }) {
  const problems = [];
  for (const [file, text] of Object.entries(before)) {
    const now = existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : null;
    if (now !== text) problems.push(`${file} changed or vanished`);
  }
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (manifest.dependencies?.neuralis !== candidate) problems.push(`package.json depends on neuralis@${manifest.dependencies?.neuralis}, expected ${candidate}`);
  if (manifest.dependencies?.[sentinelDep.name] !== sentinelDep.spec) problems.push(`the registered package line ${sentinelDep.name} was not carried verbatim`);
  if (manifest.name !== undefined) problems.push('package.json still names a package — the old host manifest survived');
  if (!existsSync(join(dir, 'node_modules', 'neuralis', 'scripts', 'upgrade.mts'))) problems.push('node_modules/neuralis/scripts/upgrade.mts is missing — the new operator scripts did not arrive');
  for (const gone of ['src', 'Dockerfile', '.neuralis-convert']) if (existsSync(join(dir, gone))) problems.push(`${gone} is still in the folder`);
  // One module instance per package: every @neuralis/* the host pins sits at the top level, none nested.
  const hostManifest = join(dir, 'node_modules', 'neuralis', 'package.json');
  const pinned = existsSync(hostManifest) ? Object.keys(JSON.parse(readFileSync(hostManifest, 'utf8')).dependencies ?? {}).filter((d) => d.startsWith('@neuralis/')) : [];
  for (const dep of pinned) if (!existsSync(join(dir, 'node_modules', dep, 'package.json'))) problems.push(`${dep} is not at the top level of node_modules`);
  const top = join(dir, 'node_modules', '@neuralis');
  const nestedRoots = [join(dir, 'node_modules', 'neuralis'), ...(existsSync(top) ? readdirSync(top).map((n) => join(top, n)) : [])];
  for (const root of nestedRoots) if (existsSync(join(root, 'node_modules', '@neuralis'))) problems.push(`a nested @neuralis tree under ${root.slice(dir.length + 1)}/node_modules`);
  if (!existsSync(join(dir, 'checkpoints')) || readdirSync(join(dir, 'checkpoints')).length !== 1) problems.push('no single convert checkpoint under checkpoints/');
  return problems;
}

/**
 * The folder half of an update from the previous published line, against the
 * candidate in the local registry. The previous line comes from the public
 * registry READ-ONLY; its host tarball is re-published into the local registry
 * under a non-latest tag only so the converter's `npm pack`/`npm view` of the
 * old version resolve there (the local registry proxies nothing of ours).
 */
async function rehearseFolderUpgrade({ userconfig, candidate }) {
  if (FROM === candidate) {
    console.log(`\n${c.dim}upgrade branch SKIPPED: the candidate is ${candidate} itself — it needs a bumped candidate (pnpm release:version <next>).${c.reset}`);
    return 'skipped';
  }
  const room = join(workdir, 'upgrade-room');
  const oldDir = join(room, 'previous');
  const coldCache = join(workdir, 'npm-cache-public');
  mkdirSync(room, { recursive: true });
  const publicEnv = { ...process.env, npm_config_registry: PUBLIC_REGISTRY };
  const localEnv = { ...process.env, npm_config_registry: REGISTRY };

  step(`upgrade branch: a real ${FROM} folder from the public registry (read-only)`);
  sh('npm', ['create', `neuralis@${FROM}`, 'previous', '--yes', '--registry', PUBLIC_REGISTRY, '--cache', coldCache], { cwd: room, stdio: 'inherit', env: publicEnv });
  const packed = JSON.parse(sh('npm', ['pack', `neuralis@${FROM}`, '--registry', PUBLIC_REGISTRY, '--cache', coldCache, '--pack-destination', workdir, '--json'], { cwd: workdir, env: publicEnv }));
  sh('npm', ['publish', join(workdir, packed[0].filename), '--registry', REGISTRY, '--userconfig', userconfig, '--tag', 'previous'], { cwd: workdir, env: localEnv });
  ok(`neuralis@${FROM} scaffolded; its host tarball mirrored locally under the "previous" tag`);

  step('planting operator state: .env, compose override, a registered package line');
  const sentinelSrc = join(room, 'sentinel', 'package');
  mkdirSync(sentinelSrc, { recursive: true });
  writeFileSync(join(sentinelSrc, 'package.json'), JSON.stringify({ name: '@acme/rehearsal-sentinel', version: '1.0.0' }));
  const sentinelTgz = JSON.parse(sh('npm', ['pack', sentinelSrc, '--pack-destination', room, '--json'], { cwd: room }))[0].filename;
  const sentinelDep = { name: '@acme/rehearsal-sentinel', spec: `file:${join(room, sentinelTgz)}` };
  const manifestText = readFileSync(join(oldDir, 'package.json'), 'utf8');
  const withLine = manifestText.replace(/("dependencies"\s*:\s*\{\s*\n)([ \t]*)/, (_m, open, indent) => `${open}${indent}${JSON.stringify(sentinelDep.name)}: ${JSON.stringify(sentinelDep.spec)},\n${indent}`);
  if (withLine === manifestText) die(`could not plant a dependency line in ${oldDir}/package.json`);
  writeFileSync(join(oldDir, 'package.json'), withLine);
  const before = {
    '.env': `NEURALIS_IMAGE_TAG=${FROM}\nNEURALIS_MACHINE_IMAGE=neuralisapp/webtop-ubuntu-xfce:${FROM}\nNEURALIS_REHEARSAL_SENTINEL=kept\n`,
    'docker-compose.override.yml': '# rehearsal sentinel — the override is operator state and must survive the conversion\nservices: {}\n',
  };
  for (const [file, text] of Object.entries(before)) writeFileSync(join(oldDir, file), text);
  before['.npmrc'] = readFileSync(join(oldDir, '.npmrc'), 'utf8');
  ok('sentinels planted');

  step(`convert with the candidate scaffolder: npx --yes create-neuralis@${candidate} convert`);
  const home = join(room, 'neuralis-home');
  const offlineEnv = { ...localEnv, NEURALIS_HOME: home, NEURALIS_APP_PORT: String(await freePort()) };
  sh('npx', npxArgs(`create-neuralis@${candidate}`, ['convert', oldDir], { registry: REGISTRY, cache: npmCache }), { cwd: room, stdio: 'inherit', env: offlineEnv });
  const problems = convertedFolderProblems({ dir: oldDir, before, candidate, sentinelDep });
  if (problems.length > 0) die('the converted folder is wrong', problems.join('\n'));
  ok('converted: .env, override and .npmrc byte-identical, the package line carried, the old tree gone behind one checkpoint');

  step('update plans the line from a release manifest');
  const manifestFile = join(room, 'release-manifest.json');
  sh(process.execPath, ['--import', 'tsx', join(REPO_ROOT, 'neuralis', 'scripts', 'release-version.mts'), '--manifest', manifestFile, '--root', REPO_ROOT], { cwd: join(REPO_ROOT, 'neuralis') });
  const plan = JSON.parse(sh(join(oldDir, 'node_modules', '.bin', 'neuralis'), ['update', '--manifest', manifestFile, '--json'], { cwd: oldDir, env: offlineEnv }));
  if (plan.layout !== 'folder' || plan.plan?.[0]?.target !== candidate || plan.image?.current !== FROM || plan.image?.target !== candidate) {
    die('the update plan is not the line', JSON.stringify(plan, null, 2));
  }
  ok(`update plans neuralis ${candidate} and the image tag ${FROM} → ${candidate}`);

  step('the operator verbs load from node_modules/neuralis (the host `@/` alias and its builtins)');
  const folderBin = join(oldDir, 'node_modules', '.bin', 'neuralis');
  sh(folderBin, ['upgrade'], { cwd: oldDir, env: offlineEnv, stdio: 'inherit' });
  ok('npx neuralis upgrade (dry run) exits 0 in the converted folder');

  step('convert --rollback puts the published tree back, byte for byte');
  const [checkpoint] = readdirSync(join(oldDir, 'checkpoints'));
  sh(folderBin, ['convert', '--rollback', checkpoint], { cwd: oldDir, env: offlineEnv, stdio: 'inherit' });
  const pristine = join(room, 'pristine');
  mkdirSync(pristine, { recursive: true });
  sh('tar', ['-xzf', join(workdir, packed[0].filename), '-C', pristine]);
  const drift = treeDrift(join(pristine, 'package'), oldDir, packed[0].files.map((f) => f.path).filter((p) => p !== 'package.json'));
  if (drift.length > 0) die(`the rolled-back folder differs from neuralis@${FROM} in ${drift.length} file(s)`, drift.slice(0, 10).join('\n'));
  if (readFileSync(join(oldDir, 'package.json'), 'utf8') !== withLine) die('the rolled-back package.json is not the folder\'s own 0.1.0 manifest');
  const rollbackProblems = Object.entries(before).filter(([file, text]) => readFileSync(join(oldDir, file), 'utf8') !== text).map(([file]) => file);
  if (rollbackProblems.length > 0) die('the rollback touched operator files', rollbackProblems.join('\n'));
  ok(`${packed[0].files.length - 1} files of neuralis@${FROM} (catch-all routes included) and the folder's own manifest are back; operator files untouched`);
  return 'ran';
}

/** Files of `entries` whose bytes differ between `a` and `b` (or are missing in `b`). */
export function treeDrift(a, b, entries) {
  return entries.filter((entry) => !existsSync(join(b, entry)) || !readFileSync(join(a, entry)).equals(readFileSync(join(b, entry))));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => die('rehearsal crashed', err?.stack ?? String(err)));
}
