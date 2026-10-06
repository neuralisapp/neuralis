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
 * runnable install tree, and the pinned dependency graph installs clean.
 * What it does NOT prove: image distribution (channel #2) — that needs a
 * published image and belongs to the release freeze.
 *
 * Nothing here touches the real npm registry: the registry URL is passed
 * per-command, and publishing uses a throwaway token on 127.0.0.1.
 *
 *   node neuralis/scripts/build/channel1-rehearsal.mjs [--keep]
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REGISTRY_PORT = 4873;
const REGISTRY = `http://127.0.0.1:${REGISTRY_PORT}`;
const KEEP = process.argv.includes('--keep');

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

const workdir = mkdtempSync(join(tmpdir(), 'neuralis-channel1-'));
const storage = join(workdir, 'verdaccio-storage');
const npmCache = join(workdir, 'npm-cache');
const scaffoldParent = join(workdir, 'clean-room');
const target = join(scaffoldParent, 'my-neuralis');
mkdirSync(storage, { recursive: true });
mkdirSync(npmCache, { recursive: true });
mkdirSync(scaffoldParent, { recursive: true });

const configPath = join(workdir, 'verdaccio.yaml');
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

let registry;
function cleanup() {
  if (registry?.pid && !registry.killed) {
    try { process.kill(-registry.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  if (!KEEP) rmSync(workdir, { recursive: true, force: true });
  else console.log(`\n${c.dim}kept: ${workdir}${c.reset}`);
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

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

  step('verifying the scaffolded tree');
  const scaffolded = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
  if (scaffolded.name !== 'neuralis') die(`scaffolded package.json is ${scaffolded.name}, expected neuralis`);
  ok(`host manifest: neuralis@${scaffolded.version}`);

  const npmrc = readFileSync(join(target, '.npmrc'), 'utf8');
  if (!npmrc.includes('save-exact=true')) die('.npmrc is missing save-exact=true (pins would erode)');
  ok('.npmrc pins exactly');

  for (const rel of ['src', 'scripts', 'skills', 'Dockerfile', 'next.config.ts']) {
    if (!existsSync(join(target, rel))) die(`scaffolded tree is missing ${rel} — check the host files whitelist`);
  }
  ok('runtime surface present (src, scripts, skills, Dockerfile, next.config.ts)');

  for (const dep of Object.keys(scaffolded.dependencies ?? {}).filter((d) => d.startsWith('@neuralis/'))) {
    const installed = join(target, 'node_modules', dep, 'package.json');
    if (!existsSync(installed)) die(`${dep} did not install into the scaffolded tree`);
  }
  ok('every @neuralis/* dependency installed from the local registry');

  const setupScript = scaffolded.scripts?.['neuralis:setup'];
  if (!setupScript) die('scaffolded host has no neuralis:setup script — the printed next step would be wrong');
  ok(`next step is runnable: npm run neuralis:setup (${setupScript})`);

  console.log(`\n${c.green}${c.bold}channel #1 rehearsal PASSED${c.reset}`);
  console.log(
    `${c.dim}Proven: publish → npm create → scaffold → pinned install → runnable setup entry point.\n` +
      `Not proven here: image distribution (channel #2) and the wizard run itself.${c.reset}\n`,
  );
}

main().catch((err) => die('rehearsal crashed', err?.stack ?? String(err)));
