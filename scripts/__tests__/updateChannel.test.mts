/**
 * The update/sync partition and the channel gate.
 *
 * `neuralis:sync` and `neuralis:update` take the two HALVES of one derivation,
 * and they must stay exact complements: a package with source here can be
 * swapped but not "updated", one installed from a registry the reverse. Two
 * separate derivations would eventually disagree, and the failure mode is
 * silent — a package simply never appears in one of the two tools.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectChannel, discoverBuiltinDeps } from '../setup/discoverPackages.mts';
import { imageTagAfterUpdate, upsertEnvValue } from '../setup/envFile.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const UPDATE_SCRIPT = join(HERE, '..', 'update.mts');

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
    expect(imageTagAfterUpdate({ targetVersion: '0.2.0', onePackage: false, manifest: false })).toEqual({ move: true, tag: '0.2.0' });
  });

  it('a single-package run leaves it, and says why', () => {
    const decision = imageTagAfterUpdate({ targetVersion: '0.2.0', onePackage: true, manifest: false });
    expect(decision.move).toBe(false);
    expect(decision.move === false && decision.reason).toMatch(/single-package/);
  });

  it('a --manifest run leaves it, and says why', () => {
    const decision = imageTagAfterUpdate({ targetVersion: null, onePackage: false, manifest: true });
    expect(decision.move).toBe(false);
    expect(decision.move === false && decision.reason).toMatch(/manifest/);
  });

  it('a version Docker cannot tag is refused before anything is installed', () => {
    expect(() => imageTagAfterUpdate({ targetVersion: '0.2.0+build.1', onePackage: false, manifest: false })).toThrow(/not an image tag/);
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

  it('the update script moves the tag only on the decision, and only AFTER npm install succeeded', () => {
    const source = readFileSync(UPDATE_SCRIPT, 'utf-8');
    const install = source.indexOf("spawnSync('npm', ['install'");
    const failed = source.indexOf('npm install failed', install);
    const write = source.indexOf("upsertEnvValue(configDir, 'NEURALIS_IMAGE_TAG'");
    expect(install).toBeGreaterThan(-1);
    expect(failed).toBeGreaterThan(install);
    expect(write).toBeGreaterThan(failed);
    expect(source.slice(write - 400, write)).toContain('if (tag.move)');
  });
});

describe('the update command refuses rather than half-working', () => {
  function runUpdate(cwd: string, args: string[] = []): { status: number; output: string } {
    try {
      const stdout = execFileSync(process.execPath, ['--import', 'tsx', UPDATE_SCRIPT, ...args], {
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
});
