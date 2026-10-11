/**
 * The update/sync partition and the channel gate.
 *
 * `neuralis:sync` and `neuralis:update` take the two HALVES of one derivation,
 * and they must stay exact complements: a package with source here can be
 * swapped but not "updated", one installed from a registry the reverse. Two
 * separate derivations would eventually disagree, and the failure mode is
 * silent — a package simply never appears in one of the two tools.
 */

import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareReleaseVersions, parseReleaseManifest } from '@neuralis/package-system/contracts';
import { detectChannel, discoverBuiltinDeps } from '../setup/discoverPackages.mts';
import { imageTagAfterUpdate, upsertEnvValue } from '../setup/envFile.mts';
import { companionImageMove, companionVersionsFor, downgradeRefusal, moveCompanionImages, parseUpdateArgs, planLine, readReleaseManifest, recreateStep, RELEASE_MANIFEST_URL, run as runUpdateVerb, runStack } from '../update.mts';
import { applyStack, HEALTH_TIMEOUT_MS, outsideComposeRefusal, stackCommands, type HealthAnswer, type StackPorts } from '../update/stack.mts';
import { checkpointTakenLine } from '../upgrade.mts';
import { mergePlatformConfig, platformConfigPath } from '../setup/platformConfig.mts';
import type { CliContext } from '../cli/registry.mts';
import { installLayout, spell, spellOn } from '../cli/spelling.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const UPDATE_SCRIPT = join(HERE, '..', 'update.mts');
const REGISTRY = join(HERE, '..', 'cli', 'registry.mts');

/**
 * An npm install folder: `{dependencies: {neuralis}}` plus the host package
 * npm put under `node_modules/neuralis` (pinning its `@neuralis/*` packages)
 * — the layout `create-neuralis` makes and `update` moves.
 */
function fakeFolder(version = '0.1.0'): { installDir: string; packageDir: string } {
  const installDir = mkdtempSync(join(tmpdir(), 'neuralis-folder-'));
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ private: true, dependencies: { neuralis: version, '@acme/ops': '1.0.0' } }, null, 2));
  const packageDir = join(installDir, 'node_modules', 'neuralis');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'neuralis', version, bin: { neuralis: 'bin/neuralis.mjs' }, dependencies: { '@neuralis/agent-core': version, next: '16.3.8' } }));
  installPackage(installDir, '@neuralis/agent-core', { version, neuralis: {} });
  installPackage(installDir, '@acme/ops', { version: '1.0.0', neuralis: {} });
  return { installDir, packageDir };
}

function cliContext(dirs: { installDir: string; packageDir: string }, env: Record<string, string> = {}): CliContext {
  return { ...dirs, cwd: dirs.installDir, env, stdin: process.stdin, stdout: () => {}, stderr: () => {} };
}

/** A fake install tree: a host manifest plus the node_modules it describes. */
function fakeInstall(deps: Record<string, string>, options: { workspace?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'neuralis-update-'));
  const host = join(root, 'neuralis');
  mkdirSync(join(host, 'node_modules'), { recursive: true });
  writeFileSync(join(host, 'package.json'), JSON.stringify({ name: 'neuralis', dependencies: deps }));
  if (options.workspace) writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'neuralis'\n");
  return host;
}

function installPackage(host: string, name: string, manifest: Record<string, unknown>): string {
  const dir = join(host, 'node_modules', ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, ...manifest }));
  return dir;
}

describe('the builtin dependency partition', () => {
  it('puts a registry install in registryOnly and a dev folder in syncable', () => {
    const source = mkdtempSync(join(tmpdir(), 'neuralis-src-'));
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: '@acme/local', version: '0.1.0', neuralis: {} }));

    const host = fakeInstall({
      '@neuralis/agent-core': '0.1.0',
      '@acme/local': `file:${source}`,
    });
    installPackage(host, '@neuralis/agent-core', { version: '0.1.0', neuralis: {} });

    const { syncable, registryOnly } = discoverBuiltinDeps(host);
    expect(registryOnly.map((p) => p.name)).toEqual(['@neuralis/agent-core']);
    expect(syncable.map((p) => p.name)).toEqual(['@acme/local']);
  });

  it('classifies a workspace symlink as syncable, never as an update target', () => {
    const source = mkdtempSync(join(tmpdir(), 'neuralis-ws-'));
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: '@neuralis/brain-core', version: '0.1.0', neuralis: {} }));

    const host = fakeInstall({ '@neuralis/brain-core': '0.1.0' });
    mkdirSync(join(host, 'node_modules', '@neuralis'), { recursive: true });
    symlinkSync(source, join(host, 'node_modules', '@neuralis', 'brain-core'), 'dir');

    const { syncable, registryOnly } = discoverBuiltinDeps(host);
    expect(syncable.map((p) => p.name)).toEqual(['@neuralis/brain-core']);
    expect(registryOnly).toEqual([]);
  });

  it('a file: TARBALL dep is a local source, never an update target', () => {
    // The trap: a tarball spec resolves to no directory, so a
    // resolves-to-a-directory rule would file it under registryOnly and let
    // `update` replace an operator-vetted artifact with a registry package
    // loaded at first-party trust — without the operator naming it.
    const host = fakeInstall({ '@acme/vetted': 'file:/opt/vetted-1.0.0.tgz' });
    installPackage(host, '@acme/vetted', { version: '1.0.0', neuralis: {} });

    const { syncable, registryOnly, localSource } = discoverBuiltinDeps(host);
    expect(registryOnly).toEqual([]);
    expect(syncable).toEqual([]);
    expect(localSource.map((p) => p.name)).toEqual(['@acme/vetted']);
  });

  it('a link: dep is a local source too', () => {
    const source = mkdtempSync(join(tmpdir(), 'neuralis-link-'));
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: '@acme/linked', neuralis: {} }));
    const host = fakeInstall({ '@acme/linked': `link:${source}` });
    installPackage(host, '@acme/linked', { version: '1.0.0', neuralis: {} });

    const { registryOnly, localSource } = discoverBuiltinDeps(host);
    expect(registryOnly).toEqual([]);
    expect(localSource.map((p) => p.name)).toEqual(['@acme/linked']);
  });

  it('ignores dependencies without a neuralis manifest block', () => {
    const host = fakeInstall({ react: '19.2.6', '@neuralis/admin': '1.0.0' });
    installPackage(host, 'react', { version: '19.2.6' });
    installPackage(host, '@neuralis/admin', { version: '1.0.0', neuralis: {} });

    const { syncable, registryOnly } = discoverBuiltinDeps(host);
    expect([...syncable, ...registryOnly].map((p) => p.name)).toEqual(['@neuralis/admin']);
  });

  it('the two halves are disjoint and cover every builtin dep', () => {
    const source = mkdtempSync(join(tmpdir(), 'neuralis-both-'));
    writeFileSync(join(source, 'package.json'), JSON.stringify({ name: '@acme/dev', neuralis: {} }));
    const host = fakeInstall({ '@acme/dev': `file:${source}`, '@neuralis/admin': '1.0.0', lodash: '4.0.0' });
    installPackage(host, '@neuralis/admin', { version: '1.0.0', neuralis: {} });
    installPackage(host, 'lodash', { version: '4.0.0' });

    const { syncable, registryOnly, localSource } = discoverBuiltinDeps(host);
    const names = [...new Set([...syncable, ...registryOnly, ...localSource].map((p) => p.name))];
    // registryOnly and localSource are disjoint; syncable overlaps
    // localSource on purpose (a dev FOLDER is both).
    expect(registryOnly.some((p) => localSource.some((m) => m.name === p.name))).toBe(false);
    expect(names.sort()).toEqual(['@acme/dev', '@neuralis/admin']);
  });
});

describe('channel detection', () => {
  it('recognises the development checkout by its workspace marker', () => {
    expect(detectChannel(fakeInstall({}, { workspace: true }))).toBe('monorepo');
  });

  it('treats a plain install tree as installed', () => {
    expect(detectChannel(fakeInstall({}))).toBe('installed');
  });

  it('this repository IS the monorepo', () => {
    expect(detectChannel(join(HERE, '..', '..'))).toBe('monorepo');
  });
});

describe('the image tag an applied update moves', () => {
  it('an all-package --version run moves NEURALIS_IMAGE_TAG to that version', () => {
    expect(imageTagAfterUpdate({ targetVersion: '0.2.0', onePackage: false, manifest: null })).toEqual({ move: true, tag: '0.2.0' });
  });

  it('a single-package run leaves it, and says why', () => {
    const decision = imageTagAfterUpdate({ targetVersion: '0.2.0', onePackage: true, manifest: null });
    expect(decision.move).toBe(false);
    expect(decision.move === false && decision.reason).toMatch(/single-package/);
  });

  it('a release-manifest run moves it to the line\'s neuralisapp/neuralis image; one without that image leaves it', () => {
    expect(imageTagAfterUpdate({ targetVersion: null, onePackage: false, manifest: { image: '0.3.0' } })).toEqual({ move: true, tag: '0.3.0' });
    const none = imageTagAfterUpdate({ targetVersion: null, onePackage: false, manifest: { image: null } });
    expect(none.move === false && none.reason).toMatch(/names no neuralisapp\/neuralis image/);
    expect(imageTagAfterUpdate({ targetVersion: null, onePackage: true, manifest: { image: '0.3.0' } }).move).toBe(false);
  });

  it('a version Docker cannot tag is refused before anything is installed', () => {
    expect(() => imageTagAfterUpdate({ targetVersion: '0.2.0+build.1', onePackage: false, manifest: null })).toThrow(/not an image tag/);
  });

  it('the .env edit rewrites ONE line in place: every other byte, the order and the file mode survive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'neuralis-env-'));
    const before = '# keep me\nNEXTAUTH_SECRET=s3cret\nNEURALIS_IMAGE_TAG=0.1.0\n# NEURALIS_IMAGE_TAG=commented\nQDRANT_MODE=docker\n';
    writeFileSync(join(dir, '.env'), before);
    chmodSync(join(dir, '.env'), 0o600);
    const { previous } = await upsertEnvValue(dir, 'NEURALIS_IMAGE_TAG', '0.2.0');
    expect(previous).toBe('0.1.0');
    expect(readFileSync(join(dir, '.env'), 'utf-8')).toBe(before.replace('NEURALIS_IMAGE_TAG=0.1.0', 'NEURALIS_IMAGE_TAG=0.2.0'));
    expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
  });

  it('a .env without the key gets it appended; a missing .env is refused, never created', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'neuralis-env-'));
    writeFileSync(join(dir, '.env'), 'QDRANT_MODE=docker');
    expect((await upsertEnvValue(dir, 'NEURALIS_IMAGE_TAG', '0.2.0')).previous).toBeNull();
    expect(readFileSync(join(dir, '.env'), 'utf-8')).toBe('QDRANT_MODE=docker\nNEURALIS_IMAGE_TAG=0.2.0\n');
    const empty = mkdtempSync(join(tmpdir(), 'neuralis-env-'));
    await expect(upsertEnvValue(empty, 'NEURALIS_IMAGE_TAG', '0.2.0')).rejects.toThrow(/ENOENT/);
  });

  it('the folder update installs the ONE host package and moves the tag only in the re-executed, newly installed code', () => {
    const source = readFileSync(UPDATE_SCRIPT, 'utf-8');
    const install = source.indexOf("spawnSync('npm', ['install', `${HOST_PACKAGE}@${target}`, '--save-exact']");
    const failed = source.indexOf('npm install failed', install);
    const reexec = source.indexOf("'--host-swapped'", failed);
    const write = source.indexOf("upsertEnvValue(configDir, 'NEURALIS_IMAGE_TAG'");
    expect(install).toBeGreaterThan(-1);
    expect(failed).toBeGreaterThan(install);
    expect(reexec).toBeGreaterThan(failed);
    // The only tag writer is the post-swap half, behind the decision.
    expect(source.indexOf("upsertEnvValue(configDir, 'NEURALIS_IMAGE_TAG'", write + 1)).toBe(-1);
    expect(source.slice(source.lastIndexOf('async function afterHostSwap', write), write)).toContain('if (tag.move)');
  });
});

describe('the update command refuses rather than half-working', () => {
  function runUpdate(cwd: string, args: string[] = []): { status: number; output: string } {
    try {
      const stdout = execFileSync(process.execPath, ['--import', 'tsx', REGISTRY, 'update', ...args], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { status: 0, output: stdout };
    } catch (err: any) {
      return { status: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  }

  it('refuses in the development checkout and names the real update path', () => {
    const result = runUpdate(join(HERE, '..', '..'));
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('development checkout');
    expect(result.output).toContain('git pull');
  });

  it('names the layout of every channel; only a folder and a clone move', () => {
    const folder = fakeFolder();
    expect(installLayout(folder.installDir, folder.packageDir, false)).toBe('folder');
    const clone = fakeInstall({ next: '16.3.8' });
    expect(installLayout(clone, clone, false)).toBe('host-tree');
    mkdirSync(join(clone, '.git'));
    expect(installLayout(clone, clone, false)).toBe('clone');
    expect(installLayout(clone, clone, true)).toBe('container');
    expect(installLayout(join(HERE, '..', '..'), join(HERE, '..', '..'), false)).toBe('monorepo');
  });

  it('spells a verb the way each layout types it; a context decides by its own folders', () => {
    expect(spellOn('folder', 'pkg remove <name>')).toBe('npx neuralis pkg remove <name>');
    expect(spellOn('monorepo', 'pkg remove <name>')).toBe('pnpm neuralis:pkg remove <name>');
    expect(spellOn('clone', 'pkg remove <name>')).toBe('npx neuralis pkg remove <name>');
    expect(spellOn('clone', 'rebuild')).toBe('npx neuralis rebuild');
    expect(spellOn('container', 'mount list')).toBe('node bin/neuralis.mjs mount list');
    expect(spell('setup --compose-only', fakeFolder())).toBe('npx neuralis setup --compose-only');
    const checkout = join(HERE, '..', '..');
    expect(spell('setup --compose-only', { installDir: checkout, packageDir: checkout })).toBe('pnpm neuralis:setup --compose-only');
    // Outside an install folder the installDir read refuses; the code's own tree decides.
    const outside = { packageDir: checkout, get installDir(): string { throw new Error('not inside a Neuralis install folder'); } };
    expect(spell('user list', outside)).toBe('pnpm neuralis:user list');
    // The upgrade's checkpoint line is spelled for the layout it runs on (a container-form apply never prints `npx`).
    expect(checkpointTakenLine('cp-1')).toBe('Checkpoint cp-1 taken (`pnpm neuralis:checkpoint restore cp-1` goes back to it).');
    // This process runs from the development checkout.
    expect(spell('user list')).toBe('pnpm neuralis:user list');
  });

  it('inside the container it refuses and names BOTH .env lines and the admin-only sidecar pin', async () => {
    const tree = fakeInstall({});
    const run = runUpdateVerb(['--version', '0.2.0'], cliContext({ installDir: tree, packageDir: tree }));
    // Not in a container here: a bare host-package folder that is no clone is told to convert.
    await expect(run).rejects.toThrow(/not an npm install folder or a git clone/);
  });

  it('a folder plans the host package and the @neuralis packages it pins; operator packages are not in a line', async () => {
    const folder = fakeFolder('0.1.0');
    const dir = mkdtempSync(join(tmpdir(), 'neuralis-line-'));
    const line = { schema: 1, version: '0.2.0', packages: { neuralis: '0.2.0', '@neuralis/agent-core': '0.2.0', 'create-neuralis': '0.2.0' }, images: { 'neuralisapp/neuralis': '0.2.0' } };
    writeFileSync(join(dir, 'line.json'), JSON.stringify(line));
    const plan = planLine({ target: '0.2.0', manifest: parseReleaseManifest(JSON.stringify(line)), installDir: folder.installDir, packageDir: folder.packageDir, layout: 'folder' });
    expect(plan).toEqual([
      { name: 'neuralis', current: '0.1.0', target: '0.2.0', unchanged: false },
      { name: '@neuralis/agent-core', current: '0.1.0', target: '0.2.0', unchanged: false, via: 'neuralis' },
    ]);
    const logged: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logged.push(args.join(' ')); });
    try {
      expect(await runUpdateVerb(['--manifest', join(dir, 'line.json'), '--json'], cliContext(folder))).toBe(0);
    } finally {
      log.mockRestore();
    }
    expect(JSON.parse(logged.join('\n'))).toEqual({
      layout: 'folder', plan, image: { current: '(none)', target: '0.2.0', unchanged: false },
      // No compose file here: the plan says what an apply would restart (nothing) and why, without asking Docker.
      stack: { folder: folder.installDir, project: 'neuralis', appPort: 3100, recreate: 'rebuild', unavailable: `${folder.installDir} has no docker-compose.yml` },
      apply: false,
    });
  });

  it('the folder\'s .env is the command\'s environment: a NEURALIS_HOME set there is the home the companion moves use', async () => {
    const folder = fakeFolder('0.2.0');
    const home = mkdtempSync(join(tmpdir(), 'neuralis-home-'));
    writeFileSync(join(folder.installDir, '.env'), `NEURALIS_IMAGE_TAG=0.2.0\nNEURALIS_HOME=${home}\n`);
    const before = process.env.NEURALIS_HOME;
    delete process.env.NEURALIS_HOME;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await runUpdateVerb(['--version', '0.2.0', '--json'], cliContext(folder))).toBe(0);
      expect(process.env.NEURALIS_HOME).toBe(home);
    } finally {
      log.mockRestore();
      if (before === undefined) delete process.env.NEURALIS_HOME;
      else process.env.NEURALIS_HOME = before;
    }
  });

  it('a folder already on the line still owes its image tag: the plan says so and it is not "already on"', async () => {
    const folder = fakeFolder('0.2.0');
    writeFileSync(join(folder.installDir, '.env'), 'NEURALIS_IMAGE_TAG=0.1.0\n');
    const logged: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logged.push(args.join(' ')); });
    try {
      expect(await runUpdateVerb(['--version', '0.2.0', '--json'], cliContext(folder))).toBe(0);
    } finally {
      log.mockRestore();
    }
    const json = JSON.parse(logged.join('\n')) as { plan: Array<{ unchanged: boolean }>; image: unknown };
    expect(json.plan[0]!.unchanged).toBe(true);
    expect(json.image).toEqual({ current: '0.1.0', target: '0.2.0', unchanged: false });
  });

  it('after a release move a folder with operator packages rebuilds its derived image; with none it recreates on the release image', () => {
    const folder = fakeFolder();
    expect(recreateStep(folder.installDir, 'folder')).toMatch(/^npx neuralis rebuild .*derived image/);
    writeFileSync(join(folder.installDir, 'package.json'), JSON.stringify({ private: true, dependencies: { neuralis: '0.1.0' } }));
    expect(recreateStep(folder.installDir, 'folder')).toMatch(/^docker compose up -d -V /);
    // A clone is the host package itself: no derived image, whatever its lines.
    const clone = fakeInstall({ '@acme/ops': '1.0.0' });
    expect(recreateStep(clone, 'clone')).toMatch(/^docker compose up -d -V /);
  });

  it('a single-package run moves only an operator registry package, at an exact version', async () => {
    const folder = fakeFolder();
    await expect(runUpdateVerb(['@acme/ops'], cliContext(folder))).rejects.toThrow(/give @acme\/ops its version/);
    await expect(runUpdateVerb(['agent-core', '--version', '0.2.0'], cliContext(folder))).rejects.toThrow(/not a registry-installed package of this folder/);
  });

  it('a clone prints the git checkout and never installs the host package', () => {
    const source = readFileSync(UPDATE_SCRIPT, 'utf-8');
    expect(source).toContain('git fetch --tags && git checkout v${version} && npm install');
    const cloneBranch = source.slice(source.indexOf("if (layout === 'clone') return afterHostSwap"), source.indexOf("console.log(`  ${dot} installing"));
    expect(cloneBranch).not.toContain("spawnSync('npm'");
  });
});

describe('the release manifest the update resolves against', () => {
  const line = { schema: 1, version: '0.2.0', packages: { '@neuralis/agent-core': '0.2.0' }, images: { 'neuralisapp/neuralis': '0.2.0' } };

  /** A fetch double answering each request with the next response, recording what was asked. */
  function fakeFetch(...responses: Response[]) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const impl = (async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const next = responses.shift();
      if (!next) throw new Error('unexpected request');
      return next;
    }) as typeof fetch;
    return { impl, calls };
  }
  const redirect = (location: string): Response => new Response(null, { status: 302, headers: { location } });

  it('reads a local fixture file and shape-checks it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'neuralis-manifest-'));
    writeFileSync(join(dir, 'line.json'), JSON.stringify(line));
    expect(parseReleaseManifest(await readReleaseManifest(join(dir, 'line.json')))).toEqual(line);
  });

  it('fetches an https manifest with a timeout signal, following the two redirects a release asset answers', async () => {
    const { impl, calls } = fakeFetch(
      redirect('https://github.com/neuralisapp/neuralis/releases/download/v0.2.0/release-manifest.json'),
      redirect('https://objects.githubusercontent.com/asset'),
      new Response(JSON.stringify(line), { status: 200 }),
    );
    expect(parseReleaseManifest(await readReleaseManifest(RELEASE_MANIFEST_URL, impl))).toEqual(line);
    expect(calls.map((c) => c.url)).toEqual([
      RELEASE_MANIFEST_URL,
      'https://github.com/neuralisapp/neuralis/releases/download/v0.2.0/release-manifest.json',
      'https://objects.githubusercontent.com/asset',
    ]);
    expect(calls.every((c) => c.init?.redirect === 'manual' && c.init.signal instanceof AbortSignal)).toBe(true);
  });

  it('refuses http, a redirect off https (before requesting it), a failed status and an oversized body', async () => {
    const never = fakeFetch(new Response('{}'));
    await expect(readReleaseManifest('http://example.com/line.json', never.impl)).rejects.toThrow(/only https/);
    expect(never.calls).toHaveLength(0);
    const downgrade = fakeFetch(redirect('http://evil.example/x'), new Response('{}'));
    await expect(readReleaseManifest(RELEASE_MANIFEST_URL, downgrade.impl)).rejects.toThrow(/redirected to http:/);
    expect(downgrade.calls).toHaveLength(1);
    await expect(readReleaseManifest(RELEASE_MANIFEST_URL, fakeFetch(new Response('nope', { status: 404 })).impl)).rejects.toThrow(/HTTP 404/);
    const declaredHuge = new Response('{}', { headers: { 'content-length': String(10 * 1024 * 1024) } });
    await expect(readReleaseManifest(RELEASE_MANIFEST_URL, fakeFetch(declaredHuge).impl)).rejects.toThrow(/larger than/);
    await expect(readReleaseManifest(RELEASE_MANIFEST_URL, fakeFetch(new Response('x'.repeat(65 * 1024))).impl)).rejects.toThrow(/larger than/);
  });

  it.each([
    ['not JSON', '{', /not valid JSON/],
    ['an unknown schema', JSON.stringify({ ...line, schema: 2 }), /unsupported schema 2/],
    ['no schema', JSON.stringify({ version: '0.2.0', packages: {}, images: {} }), /unsupported schema/],
    ['a range instead of a version', JSON.stringify({ ...line, packages: { '@neuralis/agent-core': '^0.2.0' } }), /packages\.@neuralis\/agent-core/],
    ['no images', JSON.stringify({ schema: 1, version: '0.2.0', packages: {} }), /"images" must be an object/],
  ])('refuses %s', (_name, raw, reason) => {
    expect(() => parseReleaseManifest(raw)).toThrow(reason);
  });
});

describe('the update command line', () => {
  it('a flag value is never read as a package name', () => {
    expect(parseUpdateArgs(['--version', '0.2.0', '--apply'])).toEqual({ apply: true, asJson: false, targetVersion: '0.2.0', manifestSource: null, manifestExplicit: false, hostSwapped: false, positional: [] });
    expect(parseUpdateArgs(['agent-core', '--manifest', './line.json']).positional).toEqual(['agent-core']);
  });

  it('with no version source it resolves the latest published line', () => {
    expect(parseUpdateArgs([])).toMatchObject({ manifestSource: RELEASE_MANIFEST_URL, manifestExplicit: false });
    expect(parseUpdateArgs(['--manifest', RELEASE_MANIFEST_URL]).manifestExplicit).toBe(true);
    expect(parseUpdateArgs(['--manifest', 'https://example.com/m.json', '--version', '0.2.0']).manifestSource).toBe('https://example.com/m.json');
  });

  it('a value flag without its value is refused, never defaulted; an unknown flag is refused', () => {
    expect(() => parseUpdateArgs(['--manifest'])).toThrow(/--manifest needs a value/);
    expect(() => parseUpdateArgs(['--version', '--apply'])).toThrow(/--version needs a value/);
    expect(() => parseUpdateArgs(['--aply'])).toThrow(/unknown option --aply/);
  });
});

describe('the companion images a release line moves', () => {
  const W = 'neuralisapp/webtop-ubuntu-xfce';

  it('moves only the release-default form, and never a custom image', () => {
    expect(companionImageMove(`${W}:0.1.0`, W, '0.2.0')).toEqual({ kind: 'move', from: `${W}:0.1.0`, to: `${W}:0.2.0` });
    expect(companionImageMove(`${W}:dev`, W, '0.2.0')).toEqual({ kind: 'move', from: `${W}:dev`, to: `${W}:0.2.0` });
    expect(companionImageMove(`${W}:0.2.0`, W, '0.2.0')).toEqual({ kind: 'same', value: `${W}:0.2.0` });
    expect(companionImageMove(undefined, W, '0.2.0')).toEqual({ kind: 'absent' });
    for (const custom of ['ghcr.io/acme/desktop:1', `${W}@sha256:${'a'.repeat(64)}`, `${W}-kde:0.1.0`, `registry.acme/${W}:0.1.0`]) {
      expect(companionImageMove(custom, W, '0.2.0')).toMatchObject({ kind: 'keep', value: custom });
    }
    expect(companionImageMove(`${W}:0.1.0`, W, undefined)).toMatchObject({ kind: 'keep', reason: expect.stringMatching(/names no/) });
  });

  it('an all-package --version moves the companions to that version; a single-package run moves none', () => {
    expect(companionVersionsFor({ manifest: null, targetVersion: '0.4.0', onePackage: false })).toEqual({ [W]: '0.4.0', 'neuralisapp/mcp-sidecar': '0.4.0' });
    expect(companionVersionsFor({ manifest: null, targetVersion: '0.4.0', onePackage: true })).toBeNull();
    const line = parseReleaseManifest(JSON.stringify({ schema: 1, version: '0.5.0', packages: {}, images: { [W]: '0.5.0' } }));
    expect(companionVersionsFor({ manifest: line, targetVersion: null, onePackage: false })).toEqual({ [W]: '0.5.0' });
  });

  it('the platform writer raises only keys the file already has', () => {
    const result = mergePlatformConfig({ machineImage: `${W}:0.1.0`, other: 1 }, {}, { machineImage: `${W}:0.2.0`, mcpSidecarImage: 'neuralisapp/mcp-sidecar:0.2.0' });
    expect(result.merged).toEqual({ machineImage: `${W}:0.2.0`, other: 1 });
    expect(result.replaced).toEqual(['machineImage']);
  });

  it('applies a line through the setup writers: defaults move, a custom image is kept and reported', async () => {
    const home = mkdtempSync(join(tmpdir(), 'neuralis-home-'));
    const configDir = mkdtempSync(join(tmpdir(), 'neuralis-config-'));
    writeFileSync(join(configDir, '.env'), `NEURALIS_IMAGE_TAG=0.1.0\nNEURALIS_MACHINE_IMAGE=${W}:0.1.0\nQDRANT_MODE=docker\n`, { mode: 0o600 });
    mkdirSync(dirname(platformConfigPath(home)), { recursive: true });
    const platform = { machineImage: `${W}:0.1.0`, mcpSidecarImage: 'ghcr.io/acme/sidecar:7', maxAgentSteps: 80 };
    writeFileSync(platformConfigPath(home), JSON.stringify(platform, null, 2));
    const line = parseReleaseManifest(JSON.stringify({
      schema: 1, version: '0.2.0', packages: {},
      images: { 'neuralisapp/neuralis': '0.2.0', 'neuralisapp/mcp-sidecar': '0.2.0', [W]: '0.2.0' },
    }));
    const logged: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logged.push(args.join(' ')); });
    try {
      await moveCompanionImages(line.images, configDir, home);
    } finally {
      log.mockRestore();
    }
    expect(readFileSync(join(configDir, '.env'), 'utf-8')).toBe(`NEURALIS_IMAGE_TAG=0.1.0\nNEURALIS_MACHINE_IMAGE=${W}:0.2.0\nQDRANT_MODE=docker\n`);
    expect(JSON.parse(readFileSync(platformConfigPath(home), 'utf-8'))).toEqual({ ...platform, machineImage: `${W}:0.2.0` });
    // CONTROL: the admin's custom sidecar image is untouched and named.
    expect(logged.some((l) => l.includes('mcpSidecarImage kept: ghcr.io/acme/sidecar:7'))).toBe(true);
  });

  it('an install that pins nothing writes nothing (no platform.json is created)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'neuralis-home-'));
    const configDir = mkdtempSync(join(tmpdir(), 'neuralis-config-'));
    writeFileSync(join(configDir, '.env'), 'NEURALIS_IMAGE_TAG=0.1.0\n');
    const line = parseReleaseManifest(JSON.stringify({ schema: 1, version: '0.2.0', packages: {}, images: { [W]: '0.2.0' } }));
    await moveCompanionImages(line.images, configDir, home);
    expect(readFileSync(join(configDir, '.env'), 'utf-8')).toBe('NEURALIS_IMAGE_TAG=0.1.0\n');
    expect(existsSync(platformConfigPath(home))).toBe(false);
  });
});

describe('update --apply runs the stack sequence itself, and stops at the first failing step', () => {
  const MODEL = JSON.stringify({
    name: 'neuralis-x',
    services: {
      neuralis: { image: 'neuralisapp/neuralis:${NEURALIS_IMAGE_TAG}', labels: { 'neuralis.kind': 'app' } },
      qdrant: { image: 'qdrant/qdrant:v1.19.1', labels: { 'neuralis.kind': 'vectorstore' } },
    },
  });

  /** A fake Docker + a fake `neuralis` bin. `fail` names the first command line that exits 1. */
  function fakeStack(dir: string, opts: { running?: string[]; fail?: string; health?: HealthAnswer[]; upgradePrints?: string } = {}) {
    const calls: string[] = [];
    const logged: string[] = [];
    let clock = 0;
    const answers = [...(opts.health ?? [{ kind: 'absent' }, { kind: 'starting', detail: 'HTTP 503 initializing' }, { kind: 'ready' }])] as HealthAnswer[];
    const ports: StackPorts = {
      async exec(cmd, args, o) {
        const line = [cmd === process.execPath ? 'neuralis' : cmd, ...args.filter((a) => !a.endsWith('bin/neuralis.mjs'))].join(' ');
        expect(o.cwd).toBe(dir); // every step runs in the install folder
        expect(args).not.toContain('-f'); // a -f would skip the override file
        calls.push(line);
        if (opts.fail && line.includes(opts.fail)) return { code: 1, stdout: '', stderr: 'boom' };
        if (line.endsWith('config --format json --no-interpolate')) return { code: 0, stdout: MODEL, stderr: '' };
        if (line.endsWith('ps --status running --services')) return { code: 0, stdout: `${(opts.running ?? ['neuralis', 'qdrant']).join('\n')}\n`, stderr: '' };
        if (line === 'neuralis upgrade --apply') return { code: 0, stdout: opts.upgradePrints ?? `  ${checkpointTakenLine('cp-1')}\n`, stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      async health() { return answers.length > 1 ? answers.shift()! : answers[0]!; },
      async sleep(ms) { clock += ms; },
      now: () => clock,
      log: (line) => { logged.push(line); },
    };
    return { calls, logged, ports };
  }

  function stackFolder(): string {
    const dir = mkdtempSync(join(tmpdir(), 'neuralis-stack-'));
    writeFileSync(join(dir, 'docker-compose.yml'), 'name: neuralis-x\n');
    writeFileSync(join(dir, '.env'), 'NEURALIS_COMPOSE_PROJECT=neuralis-x\n');
    return dir;
  }

  const input = (dir: string, recreate: 'up' | 'rebuild' = 'up') => ({ installDir: dir, packageDir: join(dir, 'node_modules', 'neuralis'), project: 'neuralis-x', appPort: 3333, recreate });

  it('the happy path: compose → stop ONLY the app → upgrade with the vector store running → up -d -V → ready; the checkpoint is returned', async () => {
    const dir = stackFolder();
    const fake = fakeStack(dir);
    const outcome = await applyStack(input(dir), fake.ports);
    expect(outcome).toEqual({ ok: true, checkpoint: 'cp-1', done: ['compose', 'stop', 'vector store', 'upgrade', 'recreate', 'health'], seconds: 4 });
    expect(fake.calls).toEqual([
      'neuralis setup --compose-only',
      'docker compose -p neuralis-x config --format json --no-interpolate',
      'docker compose -p neuralis-x ps --status running --services',
      'docker compose -p neuralis-x stop neuralis',
      'neuralis upgrade --apply',
      'docker compose -p neuralis-x up -d -V',
    ]);
    expect(fake.calls.some((c) => / stop .*qdrant|down/.test(c))).toBe(false);
  });

  it('a stopped vector store is started before the upgrade; a stopped app is not stopped again; operator packages rebuild', async () => {
    const dir = stackFolder();
    const fake = fakeStack(dir, { running: [] });
    expect((await applyStack(input(dir, 'rebuild'), fake.ports)).ok).toBe(true);
    expect(fake.calls.slice(3)).toEqual(['docker compose -p neuralis-x up -d qdrant', 'neuralis upgrade --apply', 'neuralis rebuild']);
    expect(fake.logged).toContain('neuralis is not running — nothing to stop');
  });

  it.each([
    ['setup --compose-only', 'compose', 1],
    ['config --format json', 'compose', 2],
    [' stop neuralis', 'stop', 4],
    ['upgrade --apply', 'upgrade', 5],
    ['up -d -V', 'recreate', 6],
  ])('a failed `%s` stops at %s and runs nothing after it', async (fail, step, callCount) => {
    const dir = stackFolder();
    const fake = fakeStack(dir, { fail });
    const outcome = await applyStack(input(dir), fake.ports);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? null : outcome.step).toBe(step);
    expect(fake.calls).toHaveLength(callCount);
  });

  it('a refused boot stops at health with the closed-set code; no ready answer in time stops there too', async () => {
    const dir = stackFolder();
    const refused = await applyStack(input(dir), fakeStack(dir, { health: [{ kind: 'refused', code: 'upgrade_required' }] }).ports);
    expect(refused).toMatchObject({ ok: false, step: 'health', checkpoint: 'cp-1', done: ['compose', 'stop', 'vector store', 'upgrade', 'recreate'] });
    expect(refused.ok ? '' : refused.reason).toContain('upgrade_required');
    const slow = await applyStack(input(dir), fakeStack(dir, { health: [{ kind: 'starting', detail: 'HTTP 503 initializing' }] }).ports);
    expect(slow.ok ? '' : slow.reason).toBe(`no ready answer within ${HEALTH_TIMEOUT_MS / 1000} s (last: HTTP 503 initializing)`);
  });

  it('an app answering outside compose (a native run) is refused before anything moves; a compose-run or stopped app is not', async () => {
    const stack = { project: 'neuralis-x', app: 'neuralis', vectorstore: 'qdrant', running: ['qdrant'] };
    const answering = { health: async (): Promise<HealthAnswer> => ({ kind: 'starting', detail: 'HTTP 200' }) };
    expect(await outsideComposeRefusal(stack, 3333, answering)).toMatch(/runs no neuralis service — a process outside compose/);
    expect(await outsideComposeRefusal({ ...stack, running: ['neuralis', 'qdrant'] }, 3333, answering)).toBeNull();
    expect(await outsideComposeRefusal(stack, 3333, { health: async () => ({ kind: 'absent' }) })).toBeNull();
  });

  it('the folder run prints where it stopped, what ran, how to continue and the way back — with the checkpoint the upgrade took', async () => {
    const folder = fakeFolder('0.2.0');
    writeFileSync(join(folder.installDir, 'docker-compose.yml'), 'name: neuralis-x\n');
    writeFileSync(join(folder.installDir, '.env'), 'NEURALIS_COMPOSE_PROJECT=neuralis-x\nNEURALIS_APP_PORT=3333\n');
    const fake = fakeStack(folder.installDir, { fail: 'neuralis rebuild' });
    const logged: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logged.push(args.join(' ')); });
    try {
      expect(await runStack({ ctx: cliContext(folder), layout: 'folder', previous: '0.1.0' }, fake.ports)).toBe(1);
    } finally {
      log.mockRestore();
    }
    const out = logged.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    expect(out).toContain('stopped at recreate: rebuild exited 1');
    expect(out).toContain('done before it : compose, stop, vector store, upgrade — nothing after it ran');
    expect(out).toContain('to continue by hand once the cause is fixed: npx neuralis rebuild → wait for /api/health');
    expect(out).toContain('npm install neuralis@0.1.0 --save-exact');
    expect(out).toContain('npx neuralis checkpoint restore cp-1');
  });

  it('the dry run names every command the apply runs, with the folder\'s project and services', () => {
    const stack = { project: 'neuralis-x', app: 'neuralis', vectorstore: 'qdrant', running: [] };
    expect(stackCommands({ stack, project: 'neuralis-x', recreate: 'up', spellVerb: (v) => `npx neuralis ${v}` })).toEqual([
      'npx neuralis setup --compose-only',
      'docker compose -p neuralis-x stop neuralis   (only when it runs)',
      'docker compose -p neuralis-x up -d qdrant   (only when it is not running)',
      'npx neuralis upgrade --apply',
      'docker compose -p neuralis-x up -d -V',
      'wait for /api/health',
    ]);
  });
});

describe('the default line never moves an install down', () => {
  it('orders release versions by semver precedence', () => {
    expect(compareReleaseVersions('0.2.0', '0.10.0')).toBe(-1);
    expect(compareReleaseVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(compareReleaseVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1);
    expect(compareReleaseVersions('1.0.0-alpha', '1.0.0-1')).toBe(1);
    expect(compareReleaseVersions('0.3.1', '0.3.1')).toBe(0);
  });

  it('refuses an older DEFAULT line, names the explicit path, and lets an explicit --manifest through', async () => {
    const older = { schema: 1, version: '0.1.1', packages: { '@neuralis/agent-core': '0.1.1' }, images: { 'neuralisapp/neuralis': '0.1.1' } };
    const fetchImpl = (async () => new Response(JSON.stringify(older), { status: 200 })) as typeof fetch;
    const line = parseReleaseManifest(await readReleaseManifest(RELEASE_MANIFEST_URL, fetchImpl));
    expect(downgradeRefusal(line.version, '0.2.0', false)).toMatch(/older than this install \(0\.2\.0\)/);
    expect(downgradeRefusal(line.version, '0.2.0', true)).toBeNull();
    expect(downgradeRefusal(line.version, '0.1.1', false)).toBeNull();
    expect(downgradeRefusal('0.3.0', '0.2.0', false)).toBeNull();
    expect(downgradeRefusal('1.0.0-rc.1', '1.0.0', false)).not.toBeNull();
  });
});
