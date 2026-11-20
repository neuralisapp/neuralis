import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { UI_MODULE_RECORD_FILE } from '@neuralis/package-system/client/shared-modules';

/**
 * `audit-publish-tarballs.mjs --tarballs`: the release workflow's gate on the
 * exact bytes it publishes. Each refusal row has a clean twin in the same
 * fixture set, so a check that stopped firing turns its row red.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const script = join(repoRoot, 'neuralis', 'scripts', 'build', 'audit-publish-tarballs.mjs');
const PUBLISHABLE = [
  'packages/package-system', 'packages/agent-core', 'packages/brain-core', 'packages/admin',
  'packages/machine-core', 'neuralis', 'create-neuralis', 'packages/cli',
];
const DEV_ROOT = '/opt/dev-machine/work';

const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One minimal tarball per publishable package (the CLI with its notices); `extra` adds files to the named package, `null` removes one. */
function tarballSet(extra: Record<string, Record<string, string | null>> = {}, omit: string[] = [], modes: Record<string, Record<string, number>> = {}): string {
  const out = mkdtempSync(join(tmpdir(), 'audit-tarballs-'));
  scratchDirs.push(out);
  for (const rel of PUBLISHABLE) {
    const { name } = JSON.parse(readFileSync(join(repoRoot, rel, 'package.json'), 'utf8')) as { name: string };
    if (omit.includes(name)) continue;
    const stage = mkdtempSync(join(tmpdir(), 'audit-stage-'));
    scratchDirs.push(stage);
    const files: Record<string, string | null> = {
      'package.json': JSON.stringify({ name, version: '0.0.0-test' }),
      'index.js': 'export {};\n',
      ...(name === '@neuralis/cli' ? { 'THIRD_PARTY_NOTICES.md': '# Third-party notices\n' } : {}),
      ...(extra[name] ?? {}),
    };
    for (const [file, content] of Object.entries(files)) {
      if (content === null) continue;
      mkdirSync(dirname(join(stage, 'package', file)), { recursive: true });
      writeFileSync(join(stage, 'package', file), content);
      const mode = modes[name]?.[file];
      if (mode !== undefined) chmodSync(join(stage, 'package', file), mode);
    }
    execFileSync('tar', ['-czf', join(out, `${name.replace('@', '').replace('/', '-')}.tgz`), '-C', stage, 'package']);
  }
  return out;
}

function audit(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

describe('audit-publish-tarballs --tarballs', () => {
  it('passes a clean set of all seven tarballs', () => {
    const r = audit(['--tarballs', tarballSet(), '--forbid-root', DEV_ROOT, '--forbid-text', 'private-owner/monorepo']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it.each([null, 'dist/app/host.js', 'dist/app/host.css', `dist/app/${UI_MODULE_RECORD_FILE}`])(
    'requires each declared packed UI asset and the kernel build record (missing %s)', (missing) => {
      const files: Record<string, string> = {
        'package.json': JSON.stringify({ name: '@neuralis/admin', version: '0.0.0-test',
          neuralis: { app: { module: { entry: 'dist/app/host.js', css: 'dist/app/host.css' } } } }),
        'dist/app/host.js': 'export function install() {}',
        'dist/app/host.css': 'body {}',
        [`dist/app/${UI_MODULE_RECORD_FILE}`]: '{}',
      };
      if (missing) delete files[missing];
      const result = audit(['--tarballs', tarballSet({ '@neuralis/admin': files })]);
      expect(result.status).toBe(missing ? 1 : 0);
      if (missing) expect(result.stderr).toContain(`missing declared UI artifact ${missing}`);
    },
  );

  it('refuses a developer-machine root only when the release names it', () => {
    const dir = tarballSet({ '@neuralis/admin': { 'dist/a.js': `// built in ${DEV_ROOT}/packages/admin\n` } });
    expect(audit(['--tarballs', dir]).status).toBe(0);
    const r = audit(['--tarballs', dir, '--forbid-root', DEV_ROOT]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`dist/a.js: contains the machine-absolute path ${DEV_ROOT}`);
  });

  it('refuses the home directory of the machine that runs it without any flag', () => {
    const home = process.env.HOME ?? '';
    expect(home.split('/').filter(Boolean).length).toBeGreaterThanOrEqual(2);
    const r = audit(['--tarballs', tarballSet({ 'create-neuralis': { 'index.mjs': `const cache = '${home}/.cache';\n` } })]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('index.mjs: contains the machine-absolute path');
  });

  it('refuses a private identifier case-insensitively', () => {
    const dir = tarballSet({ '@neuralis/brain-core': { 'dist/git.js': '// e.g. https://github.com/Private-Owner/Monorepo\n' } });
    expect(audit(['--tarballs', dir]).status).toBe(0);
    const r = audit(['--tarballs', dir, '--forbid-text', 'private-owner/monorepo']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('dist/git.js: contains the private identifier "private-owner/monorepo"');
  });

  it('refuses a private native package name by its hash with no flag at all, and every marker consumer gets it', async () => {
    // The real name is never spelled in a shipped file: the fixture name's hash is injected the same way.
    const { privateMarkers, PRIVATE_PACKAGE_NAME_SHA256 } = (await import(script)) as {
      privateMarkers(input: { roots: string[]; texts?: string[]; nameHashes?: string[] }): Array<{ what: string; pattern: { test(text: string): boolean } }>;
      PRIVATE_PACKAGE_NAME_SHA256: string[];
    };
    expect(PRIVATE_PACKAGE_NAME_SHA256.length).toBeGreaterThan(0);
    for (const hash of PRIVATE_PACKAGE_NAME_SHA256) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const fixtureHash = createHash('sha256').update('@neuralis/zz-private-fixture').digest('hex');
    const markers = privateMarkers({ roots: [], texts: [], nameHashes: [fixtureHash] });
    expect(markers.some((m) => m.pattern.test('Notes: shipped with @neuralis/ZZ-Private-Fixture support'))).toBe(true);
    // Control: a longer or shorter name on the same stem, and the stem in prose, never match.
    expect(markers.some((m) => m.pattern.test('Notes: @neuralis/zz-private-fixture-kit and @neuralis/zz-private'))).toBe(false);
    expect(markers.some((m) => m.pattern.test('the zz-private-fixture package'))).toBe(false);
    // The CLI applies the built-in list with no flag: a built-in hash is reported without its name.
    const dir = tarballSet({ '@neuralis/brain-core': { 'dist/kinds.js': '// the snapshot kinds of @neuralis/admin\n' } });
    expect(audit(['--tarballs', dir]).status).toBe(0);
  });

  it('refuses a workspace: specifier, a forbidden path and a missing tarball', () => {
    const dir = tarballSet(
      {
        '@neuralis/admin': { 'package.json': JSON.stringify({ name: '@neuralis/admin', version: '0.0.0-test', dependencies: { '@neuralis/brain-core': 'workspace:*' } }) },
        'create-neuralis': { '.env': 'TOKEN=x\n' },
      },
      ['@neuralis/machine-core'],
    );
    const r = audit(['--tarballs', dir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('dependencies.@neuralis/brain-core is "workspace:*"');
    expect(r.stderr).toContain('forbidden path in tarball — .env');
    expect(r.stderr).toContain('@neuralis/machine-core: no tarball');
  });

  it('refuses a native helper the CLI manifest marks executable when the tarball lost its exec bit (pnpm pack keeps it only on `bin`)', () => {
    const helper = 'native/nrs-sandboxer/linux-x64/nrs-sandboxer';
    const files = {
      'native/manifest.json': JSON.stringify({ version: 1, nodePty: '1.1.0', files: { 'nrs-sandboxer/linux-x64/nrs-sandboxer': { sha256: null, source: 'ci:x', executable: true }, 'node-pty/LICENSE': { sha256: null, source: 'npm:x' } } }),
      [helper]: '\x7fELF',
      'native/node-pty/LICENSE': 'MIT',
    };
    const lost = audit(['--tarballs', tarballSet({ '@neuralis/cli': files }, [], { '@neuralis/cli': { [helper]: 0o644 } })]);
    expect(lost.status).toBe(1);
    expect(lost.stderr).toContain(`@neuralis/cli: ${helper} is not executable in the tarball`);
    expect(lost.stderr).not.toContain('node-pty/LICENSE');
    // PAIRED CONTROL: the same tarball with the bit (what npm pack writes) is clean.
    expect(audit(['--tarballs', tarballSet({ '@neuralis/cli': files }, [], { '@neuralis/cli': { [helper]: 0o755 } })]).status).toBe(0);
  });

  it('the CLI tarball must carry THIRD_PARTY_NOTICES.md naming every package its build metafile inlined', async () => {
    const { writeNotices } = (await import(join(repoRoot, 'neuralis', 'scripts', 'build', 'third-party-notices.mjs'))) as {
      writeNotices(args: { title: string; tree: string[]; metafile: string[]; apk: string | null; binary: string[]; out: string }): unknown;
    };
    const work = mkdtempSync(join(tmpdir(), 'audit-notices-'));
    scratchDirs.push(work);
    for (const [pkg, licence] of [['left-pad', 'MIT'], ['right-pad', 'ISC']]) {
      mkdirSync(join(work, 'node_modules', pkg), { recursive: true });
      writeFileSync(join(work, 'node_modules', pkg, 'package.json'), JSON.stringify({ name: pkg, version: '1.0.0', license: licence }));
      writeFileSync(join(work, 'node_modules', pkg, 'LICENSE'), `${licence} licence of ${pkg}\n`);
    }
    const metafile = join(work, '.build', 'metafile-esm.json');
    mkdirSync(dirname(metafile), { recursive: true });
    writeFileSync(metafile, JSON.stringify({ base: '..', inputs: { 'node_modules/left-pad/index.js': {}, 'node_modules/right-pad/index.js': {}, 'src/index.ts': {} } }));
    writeNotices({ title: 'fixture CLI', tree: [], metafile: [metafile], apk: null, binary: [], out: join(work, 'NOTICES.md') });
    const notices = readFileSync(join(work, 'NOTICES.md'), 'utf8');
    const flag = ['--notices-metafile', `@neuralis/cli=${metafile}`];
    expect(audit(['--tarballs', tarballSet({ '@neuralis/cli': { 'THIRD_PARTY_NOTICES.md': notices } }), ...flag]).status).toBe(0);
    // One variable each: a package's section removed; the file left out of the tarball.
    const gap = audit(['--tarballs', tarballSet({ '@neuralis/cli': { 'THIRD_PARTY_NOTICES.md': notices.replace('## right-pad 1.0.0\n', '## other 0\n') } }), ...flag]);
    expect(gap.status).toBe(1);
    expect(gap.stderr).toContain('THIRD_PARTY_NOTICES.md — npm right-pad@1.0.0: no section');
    const missing = audit(['--tarballs', tarballSet({ '@neuralis/cli': { 'THIRD_PARTY_NOTICES.md': null } })]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('THIRD_PARTY_NOTICES.md is missing');
  });

  it('the per-push workspace audit checks the same notices: present and naming every inlined package', async () => {
    const mod = (await import(join(repoRoot, 'neuralis', 'scripts', 'build', 'audit-publish-tarballs.mjs'))) as {
      auditWorkspaceTrees(findings: string[], opts: unknown, at: { root: string; packages: string[] }): number;
      privateMarkers(args: { roots: string[] }): unknown;
    };
    const { writeNotices } = (await import(join(repoRoot, 'neuralis', 'scripts', 'build', 'third-party-notices.mjs'))) as {
      writeNotices(args: { title: string; tree: string[]; metafile: string[]; apk: string | null; binary: string[]; out: string }): unknown;
    };
    const root = mkdtempSync(join(tmpdir(), 'audit-workspace-'));
    scratchDirs.push(root);
    const cli = join(root, 'cli');
    mkdirSync(join(cli, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(cli, 'package.json'), JSON.stringify({ name: '@neuralis/cli', version: '0.0.0-test', files: ['index.js', 'THIRD_PARTY_NOTICES.md'] }));
    writeFileSync(join(cli, 'index.js'), 'export {};\n');
    writeFileSync(join(cli, 'node_modules', 'left-pad', 'package.json'), JSON.stringify({ name: 'left-pad', version: '1.0.0', license: 'MIT' }));
    writeFileSync(join(cli, 'node_modules', 'left-pad', 'LICENSE'), 'MIT licence of left-pad\n');
    const metafile = join(cli, '.build', 'metafile-esm.json');
    mkdirSync(dirname(metafile), { recursive: true });
    writeFileSync(metafile, JSON.stringify({ base: '..', inputs: { 'node_modules/left-pad/index.js': {} } }));
    const notices = join(cli, 'THIRD_PARTY_NOTICES.md');
    writeNotices({ title: 'fixture CLI', tree: [], metafile: [metafile], apk: null, binary: [], out: notices });
    const findingsOf = (): string[] => {
      const findings: string[] = [];
      mod.auditWorkspaceTrees(findings, { strict: false, markers: mod.privateMarkers({ roots: [] }), metafiles: { '@neuralis/cli': metafile } }, { root, packages: ['cli'] });
      return findings;
    };
    expect(findingsOf()).toEqual([]);
    // One variable each: a package's section removed; the file removed.
    writeFileSync(notices, readFileSync(notices, 'utf8').replace('## left-pad 1.0.0\n', '## other 0\n'));
    expect(findingsOf()).toEqual(['cli: THIRD_PARTY_NOTICES.md — npm left-pad@1.0.0: no section']);
    rmSync(notices);
    expect(findingsOf()).toEqual(['cli: THIRD_PARTY_NOTICES.md is missing — the package bundles third-party code']);
  });

  it('exits 2 on a flag without a value', () => {
    expect(audit(['--tarballs', tarballSet(), '--forbid-root']).status).toBe(2);
  });
});
