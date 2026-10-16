/**
 * `pnpm release:version` on a fixture tree: the bump rewrites every version
 * site and nothing else, `--check` is red on any drift, `--manifest` writes
 * only a coherent line, and the exit codes are the CLI contract the release
 * workflows call (0 coherent · 1 drift · 2 usage).
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MANIFEST_VERSION, parseReleaseManifest, RELEASE_MANIFEST_SCHEMA } from '@neuralis/package-system/contracts';
import { bumpVersion, checkCoherence } from '../release-version.mts';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'release-version.mts');

const LOCAL_DEP_LINE = '    "@acme/local": "file:/somewhere/acme-local",';

function manifest(name: string, version: string, extra = ''): string {
  return `{\n  "name": "${name}",\n  "version": "${version}",\n  "private": false${extra}\n}\n`;
}

/** A minimal source checkout carrying every site the command edits, all at `version`. */
function fixtureTree(version = '0.1.0', localDep = LOCAL_DEP_LINE): string {
  const root = mkdtempSync(join(tmpdir(), 'neuralis-release-version-'));
  const write = (file: string, content: string): void => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  };
  write('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n  - 'neuralis'\n");
  write('package.json', manifest('neuralis', version));
  write('create-neuralis/package.json', manifest('create-neuralis', version));
  write(
    'neuralis/package.json',
    `{\n  "name": "neuralis",\n  "version": "${version}",\n  "dependencies": {\n${localDep}\n` +
      ['admin', 'agent-core', 'brain-core', 'machine-core', 'package-system']
        .map((name) => `    "@neuralis/${name}": "${version}",`)
        .join('\n') +
      `\n    "zod": "^4.0.0"\n  }\n}\n`,
  );
  for (const name of ['package-system', 'brain-core', 'admin', 'cli']) write(`packages/${name}/package.json`, manifest(`@neuralis/${name}`, version));
  for (const file of ['neuralis/.claude-plugin/marketplace.json', 'neuralis/.agents/plugins/marketplace.json']) {
    write(file, `{ "plugins": [{ "name": "neuralis", "source": { "source": "npm", "package": "@neuralis/cli", "version": "${version}" } }] }\n`);
  }
  write(
    'packages/agent-core/package.json',
    manifest('@neuralis/agent-core', version, `,\n  "neuralis": {\n    "configSettings": [\n      { "key": "mcpSidecarImage", "default": "neuralisapp/mcp-sidecar:${version}", "version": "nested-not-a-site" }\n    ]\n  }`),
  );
  write(
    'packages/machine-core/package.json',
    manifest('@neuralis/machine-core', version, `,\n  "neuralis": { "configSettings": [{ "key": "machineImage", "default": "neuralisapp/webtop-ubuntu-xfce:${version}" }] }`),
  );
  write('packages/machine-core/src/config.ts', `export const image = (s) => s('machineImage', 'neuralisapp/webtop-ubuntu-xfce:${version}');\n`);
  write(
    'neuralis/scripts/setup.mts',
    `const variant = { derivativeImage: 'neuralisapp/webtop-ubuntu-xfce:${version}' };\nconst image = machineEnv('NEURALIS_MACHINE_IMAGE', 'neuralisapp/webtop-ubuntu-xfce:${version}');\n`,
  );
  write('neuralis/scripts/rebuild.mts', "const SIDECAR_REPOSITORY = 'neuralisapp/mcp-sidecar';\n");
  write('neuralis/.env.example', `# Webtop image\nNEURALIS_MACHINE_IMAGE=neuralisapp/webtop-ubuntu-xfce:${version}\n`);
  write('web/docs/app/(home)/widgets.tsx', `export const install = { command: 'docker pull neuralisapp/neuralis:${version}' };\n`);
  write('neuralis/README.md', `# Neuralis\n\nThe Neuralis ${version} beta is available.\n`);
  return root;
}

function run(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  return runWith(process.env, ...args);
}

function runWith(env: NodeJS.ProcessEnv, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function read(root: string, file: string): string {
  return readFileSync(join(root, file), 'utf8');
}

describe('release:version --check', () => {
  it('exits 0 on a coherent tree and lists the prose that names the version', () => {
    const root = fixtureTree();
    const result = run('--check', '--root', root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('23 site(s) coherent');
    expect(result.stdout).toContain('neuralis/README.md:3');
  });

  it('exits 1 with one stdout line per mismatching site', () => {
    const root = fixtureTree();
    const host = read(root, 'neuralis/package.json');
    writeFileSync(join(root, 'neuralis/package.json'), host.replace('"@neuralis/brain-core": "0.1.0"', '"@neuralis/brain-core": "0.0.9"'));
    writeFileSync(join(root, 'packages/machine-core/src/config.ts'), read(root, 'packages/machine-core/src/config.ts').replace(':0.1.0', ':dev'));
    const result = run('--check', '--root', root);
    expect(result.status).toBe(1);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^neuralis\/package\.json:\d+ pin @neuralis\/brain-core = 0\.0\.9 \(expected 0\.1\.0\)$/);
    expect(lines[1]).toMatch(/^packages\/machine-core\/src\/config\.ts:1 default neuralisapp\/webtop-ubuntu-xfce = dev \(expected 0\.1\.0\)$/);
  });

  it('is red when the shipped .env.example template drifts from the release', () => {
    const root = fixtureTree();
    writeFileSync(join(root, 'neuralis/.env.example'), '# Webtop image\nNEURALIS_MACHINE_IMAGE=neuralisapp/webtop-ubuntu-xfce:dev\n');
    expect(checkCoherence(root).drift).toEqual(['neuralis/.env.example:2 template neuralisapp/webtop-ubuntu-xfce = dev (expected 0.1.0)']);
    expect(run('--check', '--root', root).status).toBe(1);
  });

  it('is red when a derived site grows a literal or a written site vanishes', () => {
    const root = fixtureTree();
    writeFileSync(join(root, 'neuralis/scripts/rebuild.mts'), "const SIDECAR_IMAGE = 'neuralisapp/mcp-sidecar:0.1.0';\n");
    writeFileSync(join(root, 'neuralis/scripts/setup.mts'), "const image = 'neuralisapp/webtop-ubuntu-xfce:0.1.0';\n");
    const { drift } = checkCoherence(root);
    expect(drift).toEqual([
      'neuralis/scripts/setup.mts: default neuralisapp/webtop-ubuntu-xfce expected 2 occurrence(s), found 1 (neuralis/scripts/setup.mts:1)',
      'neuralis/scripts/rebuild.mts: derived neuralisapp/mcp-sidecar expected 0 occurrence(s), found 1 (neuralis/scripts/rebuild.mts:1)',
    ]);
    expect(run('--check', '--root', root).status).toBe(1);
  });
});

describe('release:version <semver>', () => {
  it('rewrites every site to the new version, leaves every other byte alone', () => {
    const root = fixtureTree();
    const before = new Map(['neuralis/package.json', 'packages/agent-core/package.json', 'neuralis/scripts/setup.mts', 'neuralis/scripts/rebuild.mts', 'neuralis/README.md', 'neuralis/.env.example', 'web/docs/app/(home)/widgets.tsx'].map((f) => [f, read(root, f)]));
    const { written, problems } = bumpVersion(root, '0.2.0-rc.1');
    expect(problems).toEqual([]);
    expect(written).toHaveLength(15); // 9 manifests + 2 marketplaces + config.ts + setup.mts + .env.example + widgets.tsx; rebuild.mts is derived
    expect(checkCoherence(root)).toMatchObject({ version: '0.2.0-rc.1', drift: [] });
    // Exactly the version literals moved: the `file:` line, the nested key, the
    // derived site and the prose are byte-identical once the old version is mapped.
    for (const [file, text] of before) {
      expect(read(root, file)).toBe(file === 'neuralis/README.md' || file === 'neuralis/scripts/rebuild.mts' ? text : text.replaceAll('0.1.0', '0.2.0-rc.1'));
    }
    expect(read(root, 'neuralis/package.json')).toContain(LOCAL_DEP_LINE);
    expect(read(root, 'packages/agent-core/package.json')).toContain('"version": "nested-not-a-site"');
  });

  it('the command bumps, then runs ONE lockfile-only install at the root and lists the old version\'s prose', () => {
    const root = fixtureTree('0.1.0', '    "@acme/local": "file:../acme-local",');
    const bin = mkdtempSync(join(tmpdir(), 'neuralis-fake-pnpm-'));
    const log = join(bin, 'calls.log');
    writeFileSync(join(bin, 'pnpm'), `#!/bin/sh\necho "$PWD $*" >> ${JSON.stringify(log)}\n`, { mode: 0o755 });
    const result = runWith({ ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }, '0.2.0', '--root', root);
    expect(result.status, result.stderr).toBe(0);
    expect(read(bin, 'calls.log').trim().split('\n')).toEqual([`${root} install --lockfile-only`]);
    expect(checkCoherence(root)).toMatchObject({ version: '0.2.0', drift: [] });
    expect(result.stdout).toContain('neuralis/README.md:3');
  });

  it('the command refuses a tree with a machine-local file: dependency, before writing anything', () => {
    const root = fixtureTree();
    const host = read(root, 'neuralis/package.json');
    const result = run('0.2.0', '--root', root);
    expect(result.status).toBe(1);
    expect(result.stdout.trim()).toMatch(/^neuralis\/package\.json:5 @acme\/local$/);
    expect(result.stderr).toContain('machine-local file: dependency');
    expect(read(root, 'neuralis/package.json')).toBe(host);
  });

  it('writes NOTHING when the tree lacks a site', () => {
    const root = fixtureTree();
    writeFileSync(join(root, 'packages/machine-core/src/config.ts'), 'export const image = null;\n');
    const host = read(root, 'neuralis/package.json');
    const { written, problems } = bumpVersion(root, '0.2.0');
    expect(written).toEqual([]);
    expect(problems).toEqual(['packages/machine-core/src/config.ts: default neuralisapp/webtop-ubuntu-xfce expected 1 occurrence(s), found 0']);
    expect(read(root, 'neuralis/package.json')).toBe(host);
  });
});

describe('release:version --manifest', () => {
  it('writes the release manifest of a coherent tree', () => {
    const root = fixtureTree('0.3.0');
    const out = join(root, 'release-manifest.json');
    const result = run('--manifest', out, '--root', root);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(read(root, 'release-manifest.json'))).toEqual({
      schema: 1,
      version: '0.3.0',
      packages: {
        neuralis: '0.3.0',
        'create-neuralis': '0.3.0',
        '@neuralis/package-system': '0.3.0',
        '@neuralis/agent-core': '0.3.0',
        '@neuralis/brain-core': '0.3.0',
        '@neuralis/admin': '0.3.0',
        '@neuralis/machine-core': '0.3.0',
        '@neuralis/cli': '0.3.0',
      },
      images: {
        'neuralisapp/neuralis': '0.3.0',
        'neuralisapp/mcp-sidecar': '0.3.0',
        'neuralisapp/webtop-ubuntu-xfce': '0.3.0',
      },
    });
    // The writer and every reader share ONE shape: the kernel parser reads it back unchanged.
    expect(parseReleaseManifest(read(root, 'release-manifest.json'))).toEqual(JSON.parse(read(root, 'release-manifest.json')));
  });

  it('the version pattern and schema this pre-build script spells are the kernel\'s (it may only type-import the kernel)', () => {
    const source = readFileSync(SCRIPT, 'utf-8');
    expect(source).toContain(`const SEMVER = /${MANIFEST_VERSION.source}/;`);
    expect(source).toContain(`schema: ${RELEASE_MANIFEST_SCHEMA},`);
    expect(source).toContain("import type { ReleaseManifest } from '@neuralis/package-system/contracts';");
    expect(source).not.toMatch(/^import \{[^}]*\} from '@neuralis\/package-system/m);
  });

  it('refuses a drifted tree with exit 1 and writes no file', () => {
    const root = fixtureTree();
    writeFileSync(join(root, 'create-neuralis/package.json'), manifest('create-neuralis', '0.0.1'));
    const out = join(root, 'release-manifest.json');
    expect(run('--manifest', out, '--root', root).status).toBe(1);
    expect(existsSync(out)).toBe(false);
  });
});

describe('release:version usage — exit 2', () => {
  it.each([
    ['no arguments', []],
    ['build metadata (not a Docker tag)', ['1.2.3+build.5']],
    ['a non-semver version', ['v1.2']],
    ['an unknown flag', ['--force']],
    ['a bump combined with --check', ['1.2.3', '--check']],
    ['--manifest without a path', ['--manifest']],
  ])('%s', (_name, args) => {
    const root = fixtureTree();
    const result = run(...args, '--root', root);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('usage: pnpm release:version');
  });

  it('a tree that is not the source checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'neuralis-release-installed-'));
    expect(run('--check', '--root', root).status).toBe(2);
  });
});
