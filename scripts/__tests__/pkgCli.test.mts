import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * `pnpm neuralis:pkg` — every check runs BEFORE the one tracked-file write, a
 * refused add leaves package.json byte-identical, and `remove` restores it
 * byte-exactly and records the package's features for the next boot.
 *
 * Hermetic: the CLI runs from a COPY of `scripts/` under a mkdtemp host folder
 * (its own package.json; node_modules linked to the real one only for the
 * kernel imports) with NEURALIS_HOME in the sandbox — the real host manifest
 * and the real home are never opened.
 */

const realHost = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sandbox = mkdtempSync(join(tmpdir(), 'neuralis-pkg-cli-'));
const host = join(sandbox, 'host');
const home = join(sandbox, 'home');
const HOST_MANIFEST = `{\n  "name": "neuralis",\n  "dependencies": {\n    "react": "19.3.0"\n  }\n}\n`;

mkdirSync(host, { recursive: true });
cpSync(join(realHost, 'scripts'), join(host, 'scripts'), { recursive: true });
symlinkSync(join(realHost, 'node_modules'), join(host, 'node_modules'), 'dir');
// pkg.mts reads the host's own config declarations from `src/` — read-only.
symlinkSync(join(realHost, 'src'), join(host, 'src'), 'dir');

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

function resetHost(): void {
  writeFileSync(join(host, 'package.json'), HOST_MANIFEST);
}

function pkg(...args: string[]) {
  return pkgWith('', ...args);
}

function pkgWith(buildNpmrc: string, ...args: string[]) {
  const res = spawnSync(process.execPath, ['--import', 'tsx', join(host, 'scripts', 'pkg.mts'), ...args], {
    cwd: host,
    encoding: 'utf8',
    env: { ...process.env, NEURALIS_HOME: home, NEURALIS_BUILD_NPMRC: buildNpmrc },
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

function folderPackage(name: string, manifest: Record<string, unknown>, dirs: string[] = ['dist']): string {
  const dir = join(sandbox, 'src', name.replace(/[@/]/g, '_'));
  mkdirSync(dir, { recursive: true });
  for (const d of dirs) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, ...manifest }));
  return dir;
}

const manifestText = (): string => readFileSync(join(host, 'package.json'), 'utf8');

describe('pkg add --path — the build contract is checked before the write', () => {
  it('refuses the escaping link: devDependency and a `files` that omits a runtime folder — nothing written', () => {
    resetHost();
    const dir = folderPackage(
      '@acme/escapes',
      { files: ['dist'], scripts: { build: 'tsc' }, neuralis: {}, devDependencies: { '@neuralis/agent-core': 'link:../Neuralis/packages/agent-core' } },
      ['dist', 'skills'],
    );
    const res = pkg('add', '@acme/escapes', '--path', dir);
    expect(res.status).toBe(1);
    expect(res.out).toContain('devDependencies["@neuralis/agent-core"] = "link:../Neuralis/packages/agent-core" points outside the package');
    expect(res.out).toContain('ships a "skills/" folder that `files` does not list');
    expect(res.out).toContain('Nothing was written.');
    expect(manifestText()).toBe(HOST_MANIFEST);
  });

  it('a folder that builds is added as file:<abs dir>, and the next step is the rebuild', () => {
    resetHost();
    const dir = folderPackage('@acme/ok', { files: ['dist'], scripts: { build: 'tsc' }, neuralis: {} });
    const res = pkg('add', '@acme/ok', '--path', dir);
    expect(res.status, res.out).toBe(0);
    expect(JSON.parse(manifestText()).dependencies['@acme/ok']).toBe(`file:${dir}`);
    expect(res.out).toMatch(/Next step:.*pnpm neuralis:rebuild/);
  });
});

describe('pkg add --version / --tarball', () => {
  it('a range is refused (it would float past what was vetted); an exact version is written', () => {
    resetHost();
    expect(pkg('add', '@acme/reg', '--version', '^1.0.0').status).toBe(1);
    expect(manifestText()).toBe(HOST_MANIFEST);
    const res = pkg('add', '@acme/reg', '--version', '1.0.0');
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain('the image build installs FROZEN and refuses a dependency the lock does not carry');
  });

  it('with a private registry configured, a scoped package its .npmrc has no line for is refused — never a public fetch at first-party trust', () => {
    resetHost();
    const npmrc = join(sandbox, 'build.npmrc');
    writeFileSync(npmrc, '@other:registry=http://registry.example/\n//registry.example/:_authToken=x\n');
    const refused = pkgWith(npmrc, 'add', '@acme/reg', '--version', '1.0.0');
    expect(refused.status).toBe(1);
    expect(refused.out).toContain('has no "@acme:registry=" line');
    expect(manifestText()).toBe(HOST_MANIFEST);
    writeFileSync(npmrc, '@acme:registry=http://registry.example/\n//registry.example/:_authToken=x\n');
    const added = pkgWith(npmrc, 'add', '@acme/reg', '--version', '1.0.0');
    expect(added.status, added.out).toBe(0);
    expect(JSON.parse(manifestText()).dependencies['@acme/reg']).toBe('1.0.0');
  });

  it("a tarball's local spec is judged from the tarball's FOLDER, as the image build judges it", () => {
    // The build stages a tarball with its folder as the base; a spec back into
    // that folder is inside on both sides (the file itself as base would refuse it).
    resetHost();
    const pack = join(sandbox, 'pack-vendor', 'package');
    mkdirSync(pack, { recursive: true });
    writeFileSync(join(pack, 'package.json'), JSON.stringify({ name: '@acme/vendored', version: '1.0.0', dependencies: { x: 'file:../tgz-alone/vendor/x' } }));
    const tgz = join(sandbox, 'tgz-alone', 'acme-vendored-1.0.0.tgz');
    mkdirSync(dirname(tgz), { recursive: true });
    expect(spawnSync('tar', ['-czf', tgz, '-C', join(sandbox, 'pack-vendor'), 'package']).status).toBe(0);
    const res = pkg('add', '@acme/vendored', '--tarball', tgz);
    expect(res.status, res.out).toBe(0);
    expect(JSON.parse(manifestText()).dependencies['@acme/vendored']).toBe(`file:${tgz}`);
  });

  it('a tarball whose package.json names another package is refused', () => {
    resetHost();
    const pack = join(sandbox, 'pack', 'package');
    mkdirSync(pack, { recursive: true });
    writeFileSync(join(pack, 'package.json'), JSON.stringify({ name: 'not-the-name', version: '1.0.0' }));
    const tgz = join(sandbox, 'x-1.0.0.tgz');
    expect(spawnSync('tar', ['-czf', tgz, '-C', join(sandbox, 'pack'), 'package']).status).toBe(0);
    const res = pkg('add', 'the-name', '--tarball', tgz);
    expect(res.status).toBe(1);
    expect(res.out).toContain('the-name: its package.json is named "not-the-name"');
    expect(manifestText()).toBe(HOST_MANIFEST);
  });
});

describe('pkg remove', () => {
  it('restores the manifest byte-exactly, records the default-granted features for the next boot, names the leftover zone', () => {
    resetHost();
    rmSync(join(home, 'app', 'config', 'builtin-removals.json'), { force: true });
    const dir = folderPackage('@acme/gone', {
      files: ['dist'],
      scripts: { build: 'tsc' },
      neuralis: {
        requires: {
          providesFeatures: ['acme.use', { id: 'acme.admin' }, 'acme.extra'],
          defaultRoleGrants: { member: ['acme.use'], admin: ['acme.use', 'acme.admin'], guest: ['not.provided'] },
        },
        configSettings: [{ key: 'acmeLimit' }, { key: 'logLevel' }],
      },
    });
    expect(pkg('add', '@acme/gone', '--path', dir).status).toBe(0);
    const zone = join(home, 'projects', 'p1', 'data', '_installed', 'acme-gone');
    mkdirSync(zone, { recursive: true });
    const res = pkg('remove', '@acme/gone');
    expect(res.status, res.out).toBe(0);
    expect(manifestText()).toBe(HOST_MANIFEST);
    const record = JSON.parse(readFileSync(join(home, 'app', 'config', 'builtin-removals.json'), 'utf8')) as {
      removals: Array<{ packageId: string; features: string[] }>;
    };
    expect(record.removals.map((r) => [r.packageId, r.features])).toEqual([['@acme/gone', ['acme.use', 'acme.admin']]]);
    expect(res.out).toContain(zone);
    expect(res.out).toContain('acmeLimit');
    // the host owns `logLevel` — never the package's leftover
    expect(res.out).not.toMatch(/config keys .*logLevel/);
    expect(existsSync(zone)).toBe(true);
  });

  it('a package that grants no role a feature by default leaves no removal record (nothing for the boot to revoke)', () => {
    resetHost();
    rmSync(join(home, 'app', 'config', 'builtin-removals.json'), { force: true });
    const dir = folderPackage('@acme/plain', {
      files: ['dist'],
      scripts: { build: 'tsc' },
      neuralis: { requires: { providesFeatures: ['plain.use'] } },
    });
    expect(pkg('add', '@acme/plain', '--path', dir).status).toBe(0);
    const res = pkg('remove', '@acme/plain');
    expect(res.status, res.out).toBe(0);
    expect(manifestText()).toBe(HOST_MANIFEST);
    expect(existsSync(join(home, 'app', 'config', 'builtin-removals.json'))).toBe(false);
    expect(res.out).toContain('grants no role a feature by default');
  });
});

describe('pkg add — the grant-change record for the next boot', () => {
  const recordFile = (): string => join(home, 'app', 'config', 'builtin-removals.json');
  const records = () => JSON.parse(readFileSync(recordFile(), 'utf8')) as {
    removals: Array<{ packageId: string; features: string[] }>;
    additions: Array<{ packageId: string }>;
  };
  const granting = (name: string) => folderPackage(name, {
    files: ['dist'],
    scripts: { build: 'tsc' },
    neuralis: { requires: { providesFeatures: ['g.use'], defaultRoleGrants: { member: ['g.use'] } } },
  });

  it('an add records the addition; re-running it on an existing dependency re-records it and says what it does', () => {
    resetHost();
    rmSync(recordFile(), { force: true });
    const dir = granting('@acme/late');
    expect(pkg('add', '@acme/late', '--path', dir).status).toBe(0);
    expect(records().additions.map((a) => a.packageId)).toEqual(['@acme/late']);

    rmSync(recordFile(), { force: true });
    const again = pkg('add', '@acme/late', '--path', dir);
    expect(again.status, again.out).toBe(0);
    expect(again.out).toContain('already in dependencies');
    expect(again.out).toContain('reach every existing project once at the next boot');
    expect(records()).toEqual({ removals: [], additions: [expect.objectContaining({ packageId: '@acme/late' })] });
  }, 30_000);

  it('a package without a `neuralis` block records nothing (it is no builtin)', () => {
    resetHost();
    rmSync(recordFile(), { force: true });
    const dir = folderPackage('@acme/lib', { files: ['dist'], scripts: { build: 'tsc' } });
    expect(pkg('add', '@acme/lib', '--path', dir).status).toBe(0);
    expect(existsSync(recordFile())).toBe(false);
  });

  it('a reference-only package records nothing, on add and on re-add (it is never loaded)', () => {
    resetHost();
    rmSync(recordFile(), { force: true });
    const dir = folderPackage('@acme/ref', { files: ['dist'], scripts: { build: 'tsc' }, neuralis: { referenceOnly: true } });
    expect(pkg('add', '@acme/ref', '--path', dir).status).toBe(0);
    expect(pkg('add', '@acme/ref', '--path', dir).status).toBe(0);
    expect(existsSync(recordFile())).toBe(false);
  }, 30_000);

  it('add then remove leaves only the removal; remove then add leaves only the addition', () => {
    resetHost();
    rmSync(recordFile(), { force: true });
    const dir = granting('@acme/flip');
    expect(pkg('add', '@acme/flip', '--path', dir).status).toBe(0);
    expect(pkg('remove', '@acme/flip').status).toBe(0);
    expect(records()).toEqual({ removals: [expect.objectContaining({ packageId: '@acme/flip', features: ['g.use'] })], additions: [] });

    expect(pkg('add', '@acme/flip', '--path', dir).status).toBe(0);
    expect(records()).toEqual({ removals: [], additions: [expect.objectContaining({ packageId: '@acme/flip' })] });
  }, 30_000);
});

describe('pkg add — the loader\'s own admission check runs before the write', () => {
  const WITH_RUNTIME = `{\n  "name": "neuralis",\n  "dependencies": {\n    "@neuralis/agent-core": "workspace:*",\n    "react": "19.3.0"\n  }\n}\n`;
  const tool = (category: string | undefined) => JSON.stringify({
    $schema: 'http://json-schema.org/draft-07/schema#', title: 'Ping', type: 'object', description: 'p', properties: {}, additionalProperties: false,
    'x-neuralis': { family: 't', operation: 't.ping', transport: 'embedded', annotations: { title: 'Ping', ...(category ? { category } : {}) } },
  });

  it('a package the runtime would refuse (a tool without its category) is refused with the loader\'s message — nothing written', () => {
    writeFileSync(join(host, 'package.json'), WITH_RUNTIME);
    const dir = folderPackage('@acme/pair-a', { files: ['dist', 'tools'], scripts: { build: 'tsc' }, neuralis: {} }, ['dist', 'tools']);
    writeFileSync(join(dir, 'tools', 'ping.json'), tool(undefined));
    const res = pkg('add', '@acme/pair-a', '--path', dir);
    expect(res.status).toBe(1);
    expect(res.out).toContain('@acme/pair-a: the runtime would refuse it — Invalid tool JSON tools/ping.json');
    expect(res.out).toContain('category is required');
    expect(res.out).toContain('Nothing was written.');
    expect(manifestText()).toBe(WITH_RUNTIME);
  });

  it('control: the same package with its category is added', () => {
    writeFileSync(join(host, 'package.json'), WITH_RUNTIME);
    const dir = folderPackage('@acme/pair-ok', { files: ['dist', 'tools'], scripts: { build: 'tsc' }, neuralis: {} }, ['dist', 'tools']);
    writeFileSync(join(dir, 'tools', 'ping.json'), tool('read'));
    const res = pkg('add', '@acme/pair-ok', '--path', dir);
    expect(res.status, res.out).toBe(0);
    expect(res.out).not.toContain('admission check not available');
    expect(JSON.parse(manifestText()).dependencies['@acme/pair-ok']).toBe(`file:${dir}`);
  });

  it('a refused TARBALL is judged from its unpacked copy, and the copy is removed', () => {
    writeFileSync(join(host, 'package.json'), WITH_RUNTIME);
    const dir = folderPackage('@acme/tgz-bad', { version: '1.0.0', files: ['dist', 'tools'], neuralis: {} }, ['dist', 'tools']);
    writeFileSync(join(dir, 'tools', 'ping.json'), tool(undefined));
    writeFileSync(join(dir, 'dist', 'index.js'), '');
    const packed = spawnSync('npm', ['pack', '--silent', '--pack-destination', sandbox], { cwd: dir, encoding: 'utf8' });
    expect(packed.status, packed.stderr).toBe(0);
    const tgz = join(sandbox, packed.stdout.trim().split('\n').pop()!);
    const res = pkg('add', '@acme/tgz-bad', '--tarball', tgz);
    expect(res.status).toBe(1);
    expect(res.out).toContain('the runtime would refuse it');
    expect(manifestText()).toBe(WITH_RUNTIME);
  });

  it('a private scope\'s --version next step lifts minimumReleaseAge for that scope only', () => {
    resetHost();
    const npmrc = join(sandbox, 'private.npmrc');
    writeFileSync(npmrc, '@acme:registry=http://registry.example/\n//registry.example/:_authToken=x\n');
    const res = pkgWith(npmrc, 'add', '@acme/fresh', '--version', '1.0.0');
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain('pnpm install --config.minimum-release-age-exclude=@acme/*');
    expect(res.out).not.toContain('_authToken');
  });
});

describe('pkg add — a package\'s OWN private-scope dependencies are checked before the write', () => {
  const RECORD = `${JSON.stringify({ scopes: { '@acme': { origins: ['http://host.docker.internal:4873'], firstSeen: 'x' } } })}\n`;
  const record = (text: string | null): void => {
    mkdirSync(join(home, 'build'), { recursive: true });
    if (text === null) rmSync(join(home, 'build', 'private-scopes.json'), { force: true });
    else writeFileSync(join(home, 'build', 'private-scopes.json'), text);
  };

  it('a folder whose own dependency is in a recorded private scope, with no .npmrc route: refused, naming the scope and the record — nothing written', () => {
    resetHost();
    record(RECORD);
    try {
      const dir = folderPackage('@acme/needs-private', { files: ['dist'], scripts: { build: 'tsc' }, neuralis: {}, dependencies: { '@acme/reg-probe': '1.0.1' } });
      const res = pkg('add', '@acme/needs-private', '--path', dir);
      expect(res.status).toBe(1);
      expect(res.out).toContain('@acme (@acme/reg-probe) is served by http://host.docker.internal:4873');
      expect(res.out).toContain(`delete its entry from ${join(home, 'build', 'private-scopes.json')}`);
      expect(manifestText()).toBe(HOST_MANIFEST);
      // Routed: the same folder is added.
      const npmrc = join(sandbox, 'routes.npmrc');
      writeFileSync(npmrc, '@acme:registry=http://host.docker.internal:4873/\n//host.docker.internal:4873/:_authToken=x\n');
      const added = pkgWith(npmrc, 'add', '@acme/needs-private', '--path', dir);
      expect(added.status, added.out).toBe(0);
      // Control: no record — the scope is indistinguishable from a public one.
      resetHost();
      record(null);
      expect(pkg('add', '@acme/needs-private', '--path', dir).status).toBe(0);
    } finally {
      record(null);
    }
  });

  it('a tarball is read from inside the archive, and a --version name in a recorded scope is refused the same way', () => {
    resetHost();
    record(RECORD);
    try {
      const pack = join(sandbox, 'pack-private', 'package');
      mkdirSync(pack, { recursive: true });
      writeFileSync(join(pack, 'package.json'), JSON.stringify({ name: '@acme/tgz-private', version: '1.0.0', dependencies: { '@acme/reg-probe': '1.0.1' } }));
      const tgz = join(sandbox, 'acme-tgz-private-1.0.0.tgz');
      expect(spawnSync('tar', ['-czf', tgz, '-C', join(sandbox, 'pack-private'), 'package']).status).toBe(0);
      const tarball = pkg('add', '@acme/tgz-private', '--tarball', tgz);
      expect(tarball.status).toBe(1);
      expect(tarball.out).toContain('@acme (@acme/reg-probe) is served by');
      const version = pkg('add', '@acme/reg-probe', '--version', '1.0.1');
      expect(version.status).toBe(1);
      expect(version.out).toContain('@acme (@acme/reg-probe) is served by');
      expect(manifestText()).toBe(HOST_MANIFEST);
    } finally {
      record(null);
    }
  });
});
