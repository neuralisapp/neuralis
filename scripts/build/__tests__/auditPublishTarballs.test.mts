import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  'packages/machine-core', 'neuralis', 'create-neuralis',
];
const DEV_ROOT = '/opt/dev-machine/work';

const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One minimal tarball per publishable package; `extra` adds files to the named package. */
function tarballSet(extra: Record<string, Record<string, string>> = {}, omit: string[] = []): string {
  const out = mkdtempSync(join(tmpdir(), 'audit-tarballs-'));
  scratchDirs.push(out);
  for (const rel of PUBLISHABLE) {
    const { name } = JSON.parse(readFileSync(join(repoRoot, rel, 'package.json'), 'utf8')) as { name: string };
    if (omit.includes(name)) continue;
    const stage = mkdtempSync(join(tmpdir(), 'audit-stage-'));
    scratchDirs.push(stage);
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name, version: '0.0.0-test' }),
      'index.js': 'export {};\n',
      ...(extra[name] ?? {}),
    };
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(dirname(join(stage, 'package', file)), { recursive: true });
      writeFileSync(join(stage, 'package', file), content);
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

  it('exits 2 on a flag without a value', () => {
    expect(audit(['--tarballs', tarballSet(), '--forbid-root']).status).toBe(2);
  });
});
