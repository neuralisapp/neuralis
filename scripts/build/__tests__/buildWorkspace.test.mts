import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LOCAL_SOURCE_SLOTS,
  PRIVATE_SCOPES_FILE,
  decideSetConflicts,
  feedPrivateScopeRecord,
  filesWhitelistProblems,
  importerLockDrift,
  listLocalSources,
  localSourceDirName,
  lostLockLines,
  npmrcProblems,
  parsePrivateScopeRecord,
  planLocalSources,
  prepareLocalManifest,
  privateScopes,
  releaseAgeExcludeFlags,
  lockImporterMismatch,
  staleLockedTarballs,
  unroutedPrivateScopes,
  withLocalMemberGlob,
} from '../build-workspace.mjs';

/**
 * The build workspace adapter — the half the Dockerfile runs (`stage`) and the
 * half the host runs (`planLocalSources`, `prepareLocalManifest`) share ONE
 * module, so the slot order and the refusals cannot disagree. Every fixture
 * lives in a mkdtemp sandbox; nothing here touches the repository or a home.
 */

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'build-workspace.mjs');

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), 'neuralis-build-ws-'));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** A build stage fixture: ws/ (manifests), slots/<n>/ (the named contexts), out/. */
function stageFixture(root: string, deps: Record<string, string>): { ws: string; slots: string; out: string } {
  const ws = join(root, 'ws');
  writeJson(join(ws, 'neuralis', 'package.json'), { name: 'neuralis', dependencies: { react: '19.3.0', ...deps } });
  writeJson(join(ws, 'packages', 'package-system', 'package.json'), { name: '@neuralis/package-system' });
  writeFileSync(join(ws, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n  - 'neuralis'\n\noverrides:\n  react: 19.3.0\n");
  return { ws, slots: join(root, 'slots'), out: join(root, 'out') };
}

function runStage(f: { ws: string; slots: string; out: string }) {
  return spawnSync(process.execPath, [SCRIPT, 'stage', f.ws, f.slots, f.out], { encoding: 'utf8' });
}

describe('slot order and directory names — one derivation for host and builder', () => {
  it('lists only file:/link: deps, sorted by name, tarballs told apart by extension', () => {
    expect(
      listLocalSources({ dependencies: { zod: '^4', '@zed/b': 'file:/x/b', '@acme/a': 'link:/x/a', c: 'file:/t/c-1.0.0.tgz' } }),
    ).toEqual([
      { name: '@acme/a', spec: 'link:/x/a', path: '/x/a', kind: 'dir' },
      { name: '@zed/b', spec: 'file:/x/b', path: '/x/b', kind: 'dir' },
      { name: 'c', spec: 'file:/t/c-1.0.0.tgz', path: '/t/c-1.0.0.tgz', kind: 'tgz' },
    ]);
  });

  it('a scoped name becomes a space-free directory name', () => {
    expect(localSourceDirName('@acme/widget')).toBe('acme__widget');
    expect(localSourceDirName('plain')).toBe('plain');
  });

  it('refuses more sources than the Dockerfile has slots, naming the bound', () => {
    const root = sandbox();
    try {
      const deps: Record<string, string> = {};
      for (let i = 0; i <= LOCAL_SOURCE_SLOTS; i += 1) {
        mkdirSync(join(root, `p${i}`));
        deps[`p${i}`] = `file:${join(root, `p${i}`)}`;
      }
      const plan = planLocalSources({ dependencies: deps }, root);
      expect(plan.errors.join('\n')).toMatch(new RegExp(`at most ${LOCAL_SOURCE_SLOTS}`));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a tarball context is its folder (the file is picked by name); a folder context is its realpath', () => {
    const root = sandbox();
    try {
      mkdirSync(join(root, 'real pkg'));
      symlinkSync(join(root, 'real pkg'), join(root, 'linked'));
      writeFileSync(join(root, 'x-1.0.0.tgz'), '');
      const plan = planLocalSources(
        { dependencies: { a: `file:${join(root, 'linked')}`, b: `file:${join(root, 'x-1.0.0.tgz')}` } },
        root,
      );
      expect(plan.errors).toEqual([]);
      expect(plan.sources.map((s) => [s.name, s.contextDir, s.fileName ?? null])).toEqual([
        ['a', join(root, 'real pkg'), null],
        ['b', root, 'x-1.0.0.tgz'],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('prepareLocalManifest — the local package build contract', () => {
  const registered = new Map([['/host/pair-b', 'acme__pair-b']]);

  it('rewrites a spec that names ANOTHER registered local package to its build sibling', () => {
    const { manifest, problems } = prepareLocalManifest(
      { name: '@acme/pair-a', scripts: { build: 'tsc' }, dependencies: { '@acme/pair-b': 'file:../pair-b' } },
      { name: '@acme/pair-a', kind: 'dir', hostPackageDir: '/host/pair-a', registered },
    );
    expect(problems).toEqual([]);
    expect(manifest.dependencies['@acme/pair-b']).toBe('file:../acme__pair-b');
  });

  it('refuses the escaping link: devDependency (the shape pnpm accepts silently), naming package, field and spec', () => {
    const { problems } = prepareLocalManifest(
      {
        name: '@acme/widget',
        scripts: { build: 'tsc' },
        devDependencies: { '@neuralis/agent-core': 'link:../Neuralis/packages/agent-core' },
      },
      { name: '@acme/widget', kind: 'dir', hostPackageDir: '/host/acme-widget', registered },
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('@acme/widget: devDependencies["@neuralis/agent-core"] = "link:../Neuralis/packages/agent-core" points outside the package');
  });

  it('a spec INSIDE the package is left alone', () => {
    const { problems } = prepareLocalManifest(
      { name: 'p', scripts: { build: 'x' }, dependencies: { inner: 'file:./vendor/inner' } },
      { name: 'p', kind: 'dir', hostPackageDir: '/host/p', registered },
    );
    expect(problems).toEqual([]);
  });

  it('a folder needs `build`, and `build:ui` when it declares app.module; a tarball arrives built', () => {
    const app = { neuralis: { app: { module: { entry: 'dist/app/host.js' } } } };
    expect(prepareLocalManifest({ name: 'p', ...app }, { name: 'p', kind: 'dir', hostPackageDir: '/h/p', registered }).problems)
      .toEqual(['p: package.json declares no "build" script', 'p: declares neuralis.app.module but no "build:ui" script (neuralis-build ui)']);
    expect(prepareLocalManifest({ name: 'p', ...app }, { name: 'p', kind: 'tgz', hostPackageDir: '/h', registered }).problems).toEqual([]);
  });

  it('a name mismatch is named', () => {
    expect(prepareLocalManifest({ name: 'other' }, { name: 'p', kind: 'tgz', hostPackageDir: '/h', registered }).problems)
      .toEqual(['p: its package.json is named "other"']);
  });
});

describe('host-side checks pkg add runs', () => {
  it('names every first-level runtime folder `files` does not list', () => {
    const root = sandbox();
    try {
      for (const d of ['dist', 'skills', 'app', 'src']) mkdirSync(join(root, d));
      expect(filesWhitelistProblems({ files: ['dist'] }, root)).toEqual([
        'ships a "app/" folder that `files` does not list — its contributions would be missing from an install',
        'ships a "skills/" folder that `files` does not list — its contributions would be missing from an install',
      ]);
      expect(filesWhitelistProblems({ files: ['dist', 'app', 'skills/**'] }, root)).toEqual([]);
      expect(filesWhitelistProblems({}, root)[0]).toMatch(/no `files` whitelist/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('an .npmrc carries scope lines only', () => {
    expect(npmrcProblems('@acme:registry=http://r/\n//r/:_authToken=x\n')).toEqual([]);
    expect(npmrcProblems('registry=http://r/\n@acme:registry=http://r/\n')).toEqual([
      'carries a default `registry=` line — use `@<scope>:registry=<url>` lines only',
    ]);
    expect(npmrcProblems('//r/:_authToken=x\n')).toEqual(['carries no `@<scope>:registry=<url>` line']);
  });
});

describe('the lock check and the workspace glob', () => {
  it('every tracked packages/snapshots line must survive the local resolve (a moved version is a lost line)', () => {
    const tracked = 'packages:\n  a@1.0.0:\n    resolution: x\n  b@2.0.0:\n';
    expect(lostLockLines(tracked, `${tracked}  c@3.0.0:\n`)).toEqual([]);
    expect(lostLockLines(tracked, 'packages:\n  a@1.0.1:\n    resolution: x\n  b@2.0.0:\n')).toEqual(['  a@1.0.0:']);
  });

  /** A lock text with one importer block per entry: [importer, [dep, specifier, version][]]. */
  function lock(importers: Array<[string, Array<[string, string, string]>]>, tail = 'packages: {}\n'): string {
    let out = 'importers:\n';
    for (const [importer, deps] of importers) {
      if (deps.length === 0) {
        out += `  ${importer}: {}\n`;
        continue;
      }
      out += `  ${importer}:\n    dependencies:\n`;
      for (const [dep, specifier, version] of deps) {
        out += `      ${dep.startsWith('@') ? `'${dep}'` : dep}:\n        specifier: ${specifier}\n        version: ${version}\n`;
      }
    }
    return out + tail;
  }

  it('compares importer entries on versions, not peer contexts: a widened suffix passes, a moved version inside one does not', () => {
    // Measured on the real graph: a local package bringing jiti/tsx into the
    // graph widens vite's peer suffix in tracked importers — no version moves.
    const tracked = lock([['packages/a', [['vitest', '^5.0.1', '5.0.3(vite@8.3.1(esbuild@0.28.2))']]]]);
    const widened = tracked.replace('(esbuild@0.28.2))', '(esbuild@0.28.2)(jiti@2.7.0))');
    expect(importerLockDrift(tracked, widened, new Set())).toEqual({ moved: [], unlocked: [] });
    expect(importerLockDrift(tracked, tracked.replace('version: 5.0.3(', 'version: 5.0.4('), new Set()).moved).toEqual([
      'packages/a › dependencies › vitest: ^5.0.1 5.0.3 → ^5.0.1 5.0.4',
    ]);
  });

  it('a version moved in one importer is not masked by the same line added in another (per-entry, not a multiset)', () => {
    const tracked = lock([
      ['neuralis', [['foo', '^1.0.0', '1.0.0']]],
      ['packages/a', [['bar', '^1.0.0', '1.0.0']]],
    ]);
    const current = lock([
      ['local/acme__x', [['baz', '^1.0.0', '1.0.0']]],
      ['neuralis', [['foo', '^1.0.0', '1.1.0']]],
      ['packages/a', [['bar', '^1.0.0', '1.0.0']]],
    ]);
    expect(importerLockDrift(tracked, current, new Set())).toEqual({
      moved: ['neuralis › dependencies › foo: ^1.0.0 1.0.0 → ^1.0.0 1.1.0'],
      unlocked: [],
    });
  });

  it('a registry dependency the tracked lock does not carry is named in EVERY importer the build holds, never in a local package', () => {
    const tracked = lock([
      ['neuralis', [['react', '19.3.0', '19.3.0']]],
      ['packages/a', []],
      ['packages/b', [['zod', '^4.0.0', '4.6.5']]],
    ]);
    const current = lock([
      ['local/acme__local', [['left-pad', '1.3.0', '1.3.0']]],
      ['neuralis', [['@acme/local', 'file:../local/acme__local', 'file:local/acme__local'], ['@acme/unlocked', '1.0.0', '1.0.0'], ['react', '19.3.0', '19.3.0']]],
      ['packages/a', [['@acme/added-to-a', '^2.0.0', '2.0.0']]],
      ['packages/b', [['is-odd', '^3.0.0', '3.0.1'], ['zod', '^4.0.0', '4.6.5']]],
    ]);
    expect(importerLockDrift(tracked, current, new Set(['@acme/local']))).toEqual({
      moved: [],
      unlocked: [
        'neuralis › dependencies › @acme/unlocked',
        'packages/a › dependencies › @acme/added-to-a',
        'packages/b › dependencies › is-odd',
      ],
    });
    expect(importerLockDrift(tracked, tracked, new Set())).toEqual({ moved: [], unlocked: [] });
  });

  it('an importer the build workspace does not hold is not compared (any non-frozen install prunes it)', () => {
    const tracked = lock([
      ['create-neuralis', [['vitest', '^5.0.1', '5.0.3']]],
      ['packages/a', [['zod', '^4.0.0', '4.6.5']]],
    ]);
    const current = lock([['packages/a', [['zod', '^4.0.0', '4.6.5']]]]);
    expect(importerLockDrift(tracked, current, new Set(), (importer) => importer !== 'create-neuralis')).toEqual({ moved: [], unlocked: [] });
    expect(importerLockDrift(tracked, current, new Set()).moved).toEqual(['create-neuralis › dependencies › vitest: ^5.0.1 5.0.3 → (gone)']);
  });

  it('adds the local/* member glob exactly once, first in the list', () => {
    const next = withLocalMemberGlob("packages:\n  - 'packages/*'\n");
    expect(next).toBe("packages:\n  - 'local/*'\n  - 'packages/*'\n");
    expect(() => withLocalMemberGlob('overrides:\n  a: 1\n')).toThrow(/no top-level `packages:`/);
  });
});

describe('stage — what the Dockerfile runs over the named contexts', () => {
  it('no local package: the host manifest and the workspace file pass through untouched', () => {
    const root = sandbox();
    try {
      const f = stageFixture(root, {});
      const res = runStage(f);
      expect(res.status, res.stderr).toBe(0);
      expect(readFileSync(join(f.out, 'pnpm-workspace.yaml'), 'utf8')).toBe(readFileSync(join(f.ws, 'pnpm-workspace.yaml'), 'utf8'));
      expect(JSON.parse(readFileSync(join(f.out, 'neuralis', 'package.json'), 'utf8')).dependencies).toEqual({ react: '19.3.0' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a folder joins as a member at local/<dir>, its node_modules/.git/build output dropped; the host spec points there', () => {
    const root = sandbox();
    try {
      const f = stageFixture(root, { '@acme/probe': 'file:/home/op/acme probe' });
      const slot = join(f.slots, '0');
      writeJson(join(slot, 'package.json'), { name: '@acme/probe', scripts: { build: 'tsc' } });
      writeFileSync(join(slot, 'index.ts'), 'export {}');
      mkdirSync(join(slot, 'node_modules', 'x'), { recursive: true });
      mkdirSync(join(slot, '.git'), { recursive: true });
      mkdirSync(join(slot, 'dist'), { recursive: true });
      writeFileSync(join(slot, 'dist', 'deleted-source.js'), 'stale');
      writeFileSync(join(slot, 'tsconfig.tsbuildinfo'), '{}');
      const res = runStage(f);
      expect(res.status, res.stderr).toBe(0);
      const member = join(f.out, 'local', 'acme__probe');
      expect(existsSync(join(member, 'index.ts'))).toBe(true);
      expect(existsSync(join(member, 'node_modules'))).toBe(false);
      expect(existsSync(join(member, '.git'))).toBe(false);
      expect(existsSync(join(member, 'dist'))).toBe(false);
      expect(existsSync(join(member, 'tsconfig.tsbuildinfo'))).toBe(false);
      expect(existsSync(join(f.out, 'local-manifests', 'local', 'acme__probe', 'package.json'))).toBe(true);
      expect(JSON.parse(readFileSync(join(f.out, 'neuralis', 'package.json'), 'utf8')).dependencies['@acme/probe']).toBe(
        'file:../local/acme__probe',
      );
      expect(readFileSync(join(f.out, 'pnpm-workspace.yaml'), 'utf8')).toMatch(/^packages:\n {2}- 'local\/\*'\n/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a tarball is kept as local-tgz/<dir>.tgz (prebuilt, never a member) after its name is checked', () => {
    const root = sandbox();
    try {
      const f = stageFixture(root, { 'plain-probe': 'file:/home/op/dl/plain-probe-1.0.0.tgz' });
      const pack = join(root, 'pack', 'package');
      writeJson(join(pack, 'package.json'), { name: 'plain-probe', version: '1.0.0' });
      mkdirSync(join(f.slots, '0'), { recursive: true });
      const tar = spawnSync('tar', ['-czf', join(f.slots, '0', 'plain-probe-1.0.0.tgz'), '-C', join(root, 'pack'), 'package']);
      expect(tar.status).toBe(0);
      const res = runStage(f);
      expect(res.status, res.stderr).toBe(0);
      expect(existsSync(join(f.out, 'local-tgz', 'plain-probe.tgz'))).toBe(true);
      expect(JSON.parse(readFileSync(join(f.out, 'neuralis', 'package.json'), 'utf8')).dependencies['plain-probe']).toBe(
        'file:../local-tgz/plain-probe.tgz',
      );
      // No member was added, so the workspace file is the tracked one.
      expect(readFileSync(join(f.out, 'pnpm-workspace.yaml'), 'utf8')).not.toContain("'local/*'");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses — exit 1, every package and spec named — an escaping link, a missing context, an escaping symlink', () => {
    const root = sandbox();
    try {
      const f = stageFixture(root, {
        '@acme/escapes': 'file:/home/op/escapes',
        '@acme/missing': 'file:/home/op/missing',
        '@acme/symlinked': 'file:/home/op/symlinked',
      });
      writeJson(join(f.slots, '0', 'package.json'), {
        name: '@acme/escapes',
        scripts: { build: 'tsc' },
        devDependencies: { '@neuralis/agent-core': 'link:../Neuralis/packages/agent-core' },
      });
      writeJson(join(f.slots, '2', 'package.json'), { name: '@acme/symlinked', scripts: { build: 'tsc' } });
      symlinkSync('/etc/hostname', join(f.slots, '2', 'outside'));
      const res = runStage(f);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('devDependencies["@neuralis/agent-core"] = "link:../Neuralis/packages/agent-core" points outside the package');
      expect(res.stderr).toContain('@acme/missing: the build received no context for file:/home/op/missing — run pnpm neuralis:rebuild');
      expect(res.stderr).toContain('@acme/symlinked: symlink(s) leave the package and would dangle in the build: outside');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ui-compat — the after-deploy check speaks the host table\'s vocabulary', () => {
  it('a missing record is not-built, an unreadable one is shared-imports-unreadable, an entry without the install export is no-install-export, a current one passes', () => {
    const root = sandbox();
    try {
      const nm = join(root, 'deploy', 'node_modules');
      writeJson(join(nm, 'react', 'package.json'), { name: 'react', version: '19.3.0' });
      const ui = { neuralis: { app: { module: { entry: 'dist/app/host.js' } } } };
      writeJson(join(nm, '@acme', 'unbuilt', 'package.json'), { name: '@acme/unbuilt', ...ui });
      writeJson(join(nm, '@acme', 'garbled', 'package.json'), { name: '@acme/garbled', ...ui });
      mkdirSync(join(nm, '@acme', 'garbled', 'dist', 'app'), { recursive: true });
      writeFileSync(join(nm, '@acme', 'garbled', 'dist', 'app', 'shared-imports.json'), '{ not json');
      writeJson(join(nm, '@acme', 'current', 'package.json'), { name: '@acme/current', ...ui });
      writeJson(join(nm, '@acme', 'current', 'dist', 'app', 'shared-imports.json'), { version: 1, reactMajor: 19, imports: ['react'] });
      writeFileSync(join(nm, '@acme', 'current', 'dist', 'app', 'host.js'), 'function i(){}\nexport { i as installCurrentHostComponents };\n');
      // A current record over an entry the host cannot attach (paired with @acme/current).
      writeJson(join(nm, '@acme', 'noinstall', 'package.json'), { name: '@acme/noinstall', ...ui });
      writeJson(join(nm, '@acme', 'noinstall', 'dist', 'app', 'shared-imports.json'), { version: 1, reactMajor: 19, imports: ['react'] });
      writeFileSync(join(nm, '@acme', 'noinstall', 'dist', 'app', 'host.js'), 'export function HostComponents() {}\n');
      const kernelRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'packages', 'package-system');
      const out = join(root, 'report', 'ui-compat.json');
      const res = spawnSync(process.execPath, [SCRIPT, 'ui-compat', join(root, 'deploy'), kernelRoot, out], { encoding: 'utf8' });
      expect(res.status, res.stderr).toBe(0);
      const report = JSON.parse(readFileSync(out, 'utf8')) as { checked: number; refused: Array<{ packageId: string; reason: string }> };
      expect(report.checked).toBe(4);
      expect(report.refused).toEqual([
        { packageId: '@acme/garbled', reason: 'shared-imports-unreadable' },
        { packageId: '@acme/noinstall', reason: 'no-install-export' },
        { packageId: '@acme/unbuilt', reason: 'not-built' },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the kept build lock — refused when a tarball it pins changed under the same staged path', () => {
  const sha512 = (bytes: Buffer | string): string => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const lockWith = (integrity: string): string =>
    "lockfileVersion: '9.0'\n\npackages:\n\n" +
    `  '@acme/probe-tgz@file:local-tgz/acme__probe-tgz.tgz':\n    resolution: {integrity: ${integrity}, tarball: file:local-tgz/acme__probe-tgz.tgz}\n    version: 1.0.0\n\n` +
    "  '@acme/probe@file:local/acme__probe':\n    resolution: {directory: local/acme__probe, type: directory}\n";

  function fixture(staged: string, pinned: string) {
    const root = sandbox();
    const ws = join(root, 'ws');
    mkdirSync(join(ws, 'local-tgz'), { recursive: true });
    writeFileSync(join(ws, 'local-tgz', 'acme__probe-tgz.tgz'), staged);
    const tracked = join(root, 'tracked.yaml');
    writeFileSync(tracked, 'lockfileVersion: 9.0\n');
    const buildlock = join(root, 'buildlock');
    mkdirSync(buildlock, { recursive: true });
    writeFileSync(join(buildlock, 'pnpm-lock.yaml'), lockWith(sha512(pinned)));
    writeFileSync(join(buildlock, 'tracked-lock.sha256'), `${createHash('sha256').update('lockfileVersion: 9.0\n').digest('hex')}\n`);
    return { root, ws, tracked, buildlock };
  }

  it('the same bytes: the lock fits (exit 0)', () => {
    const f = fixture('v1-bytes', 'v1-bytes');
    try {
      expect(staleLockedTarballs(lockWith(sha512('v1-bytes')), f.ws)).toEqual([]);
      const res = spawnSync(process.execPath, [SCRIPT, 'lock-base', f.buildlock, f.tracked, f.ws], { encoding: 'utf8' });
      expect(res.status, res.stdout + res.stderr).toBe(0);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('a repacked tarball on the same path: the lock does NOT fit (exit 1, the tarball named) — a fresh resolve, never ERR_PNPM_TARBALL_INTEGRITY', () => {
    const f = fixture('v2-bytes', 'v1-bytes');
    try {
      const stale = staleLockedTarballs(readFileSync(join(f.buildlock, 'pnpm-lock.yaml'), 'utf8'), f.ws);
      expect(stale).toHaveLength(1);
      expect(stale[0]).toMatch(/^local-tgz\/acme__probe-tgz\.tgz: /);
      const res = spawnSync(process.execPath, [SCRIPT, 'lock-base', f.buildlock, f.tracked, f.ws], { encoding: 'utf8' });
      expect(res.status).toBe(1);
      expect(res.stdout).toContain('local-tgz/acme__probe-tgz.tgz');
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it('a folder member is never judged here: a directory resolution carries no integrity (the install re-reads its package.json)', () => {
    const f = fixture('v1-bytes', 'v1-bytes');
    try {
      mkdirSync(join(f.ws, 'local', 'acme__probe'), { recursive: true });
      writeJson(join(f.ws, 'local', 'acme__probe', 'package.json'), { name: '@acme/probe', dependencies: { changed: '2.0.0' } });
      expect(staleLockedTarballs(readFileSync(join(f.buildlock, 'pnpm-lock.yaml'), 'utf8'), f.ws)).toEqual([]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});

describe('the kept build lock — refused when it was resolved for another set of local packages', () => {
  /** A kept lock in the real importer shape (the live kept lock: members `link:`, locals `file:local/…`). */
  const keptLock = (locals: string[]): string => {
    const lines = ["lockfileVersion: '9.0'", '', 'importers:', '', '  .: {}', '', '  neuralis:', '    dependencies:'];
    for (const dir of locals) lines.push(`      '@acme/${dir}':`, `        specifier: file:../local/${dir}`, `        version: file:local/${dir}(react@19.3.0)`);
    for (const dir of locals) lines.push('', `  local/${dir}:`, '    dependencies:', "      '@acme/reg-probe':", '        specifier: 1.0.1', '        version: 1.0.1');
    return `${lines.join('\n')}\n`;
  };
  const tracked = "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  neuralis: {}\n\n  create-neuralis: {}\n";

  function ws(locals: string[]): string {
    const root = sandbox();
    writeJson(join(root, 'package.json'), { name: 'root' });
    writeJson(join(root, 'neuralis', 'package.json'), {
      name: 'neuralis', dependencies: Object.fromEntries(locals.map((d) => [`@acme/${d}`, `file:../local/${d}`])),
    });
    for (const d of locals) writeJson(join(root, 'local', d, 'package.json'), { name: `@acme/${d}` });
    return root;
  }

  it('a local package removed since: its importer is still in the lock — does NOT fit (exit 1, the importer named), a fresh resolve drops it', () => {
    const root = ws(['company']);
    try {
      expect(lockImporterMismatch(keptLock(['company', 'probe']), tracked, root)).toEqual([
        'it holds importer(s) this build does not: local/probe',
        'its host importer names the local package(s) [@acme/company, @acme/probe], the host registers [@acme/company]',
      ]);
      const buildlock = join(root, 'buildlock');
      mkdirSync(buildlock);
      writeFileSync(join(buildlock, 'pnpm-lock.yaml'), keptLock(['company', 'probe']));
      writeFileSync(join(root, 'tracked.yaml'), tracked);
      writeFileSync(join(buildlock, 'tracked-lock.sha256'), `${createHash('sha256').update(tracked).digest('hex')}\n`);
      const res = spawnSync(process.execPath, [SCRIPT, 'lock-base', buildlock, join(root, 'tracked.yaml'), root], { encoding: 'utf8' });
      expect(res.status).toBe(1);
      expect(res.stdout).toContain('local/probe');
      // control: the same lock over the workspace it was resolved for fits
      writeFileSync(join(buildlock, 'pnpm-lock.yaml'), keptLock(['company']));
      const fits = spawnSync(process.execPath, [SCRIPT, 'lock-base', buildlock, join(root, 'tracked.yaml'), root], { encoding: 'utf8' });
      expect(fits.status, fits.stdout + fits.stderr).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a local package added since does not fit either; a tracked importer the build does not hold is not expected', () => {
    const root = ws(['company', 'probe']);
    try {
      expect(lockImporterMismatch(keptLock(['company']), tracked, root)).toEqual([
        'this build holds importer(s) it does not: local/probe',
        'its host importer names the local package(s) [@acme/company], the host registers [@acme/company, @acme/probe]',
      ]);
      expect(lockImporterMismatch(keptLock(['company', 'probe']), tracked, root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a private scope is never asked of the public registry', () => {
  const lock = [
    "lockfileVersion: '9.0'", '', 'packages:', '',
    "  '@acme/probe@file:local/acme__probe':", '    resolution: {directory: local/acme__probe, type: directory}', '',
    "  '@acme/reg-probe@1.0.1':", '    resolution: {integrity: sha512-x, tarball: http://host.docker.internal:4873/@acme/reg-probe/-/reg-probe-1.0.1.tgz}', '',
    "  'left-pad@1.3.0':", '    resolution: {integrity: sha512-y}', '',
    'snapshots:', '',
    "  '@acme/probe@file:local/acme__probe(react@19.3.0)':", '    dependencies:', "      '@acme/reg-probe': 1.0.1", '      left-pad: 1.3.0', '',
    "  '@acme/reg-probe@1.0.1': {}", '',
    "  'left-pad@1.3.0': {}", '',
  ].join('\n');
  const host = { dependencies: { '@acme/probe': 'file:../local/acme__probe', react: '19.3.0' } };

  it('a scope the lock shows served privately, reached by the build, with no .npmrc route: refused, naming the scope, the package and the host', () => {
    expect(unroutedPrivateScopes({ lockTexts: [lock], manifests: [host], npmrcText: '' })).toEqual([
      { scope: '@acme', origins: ['http://host.docker.internal:4873'], packages: ['@acme/reg-probe'] },
    ]);
  });

  it('control: routed in the .npmrc, or no longer reached (the package that needed it was removed) — nothing refused', () => {
    const routed = '@acme:registry=http://host.docker.internal:4873/\n//host.docker.internal:4873/:_authToken=t\n';
    expect(unroutedPrivateScopes({ lockTexts: [lock], manifests: [host], npmrcText: routed })).toEqual([]);
    expect(unroutedPrivateScopes({ lockTexts: [lock], manifests: [{ dependencies: { react: '19.3.0' } }], npmrcText: '' })).toEqual([]);
  });

  it('a route to the PUBLIC registry is no route; a manifest URL spec on a private host marks its scope too', () => {
    const pub = '@acme:registry=https://registry.npmjs.org/\n';
    expect(unroutedPrivateScopes({ lockTexts: [lock], manifests: [host], npmrcText: pub })).toHaveLength(1);
    const urlSpec = { dependencies: { '@corp/a': 'http://npm.corp.internal/@corp/a/-/a-1.0.0.tgz', '@corp/b': '1.0.0' } };
    expect(unroutedPrivateScopes({ lockTexts: [], manifests: [urlSpec], npmrcText: '' })).toEqual([
      { scope: '@corp', origins: ['http://npm.corp.internal'], packages: ['@corp/a', '@corp/b'] },
    ]);
  });

  it('the builder subcommand exits 1 before pnpm runs, naming the scope and NEURALIS_BUILD_NPMRC; the token is never printed', () => {
    const root = sandbox();
    try {
      writeJson(join(root, 'ws', 'neuralis', 'package.json'), host);
      mkdirSync(join(root, 'buildlock'));
      writeFileSync(join(root, 'buildlock', 'pnpm-lock.yaml'), lock);
      writeFileSync(join(root, 'tracked.yaml'), "lockfileVersion: '9.0'\n");
      const args = [SCRIPT, 'scope-routes', join(root, 'buildlock'), join(root, 'tracked.yaml'), join(root, 'ws')];
      const refused = spawnSync(process.execPath, [...args, join(root, 'absent-npmrc')], { encoding: 'utf8' });
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('@acme (@acme/reg-probe) is served by http://host.docker.internal:4873');
      expect(refused.stderr).toContain('NEURALIS_BUILD_NPMRC');
      writeFileSync(join(root, 'npmrc'), '@acme:registry=http://host.docker.internal:4873/\n//host.docker.internal:4873/:_authToken=s3cret\n');
      const ok = spawnSync(process.execPath, [...args, join(root, 'npmrc')], { encoding: 'utf8' });
      expect([ok.status, ok.stdout + ok.stderr]).toEqual([0, '']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the private-scope record — a scope once seen private stays private after its evidence is pruned', () => {
  const privateLock = [
    "lockfileVersion: '9.0'", '', 'packages:', '',
    "  '@acme/reg-probe@1.0.1':", '    resolution: {integrity: sha512-x, tarball: http://host.docker.internal:4873/@acme/reg-probe/-/reg-probe-1.0.1.tgz}', '',
    "  'left-pad@1.3.0':", '    resolution: {integrity: sha512-y}', '',
  ].join('\n');
  // The clean-up bake's lock: the package that needed @acme is gone, so is every private entry.
  const prunedLock = ["lockfileVersion: '9.0'", '', 'packages:', '', "  'left-pad@1.3.0':", '    resolution: {integrity: sha512-y}', ''].join('\n');
  const probe = { name: '@acme/probe', dependencies: { '@acme/reg-probe': '1.0.1', 'left-pad': '1.3.0' } };
  const host = { dependencies: { '@acme/probe': 'file:../local/acme__probe', react: '19.3.0' } };
  const routed = '@acme:registry=http://host.docker.internal:4873/\n//host.docker.internal:4873/:_authToken=s3cret\n';
  const NOW = new Date('2026-10-03T18:00:00.000Z');

  it('is fed from the .npmrc routes and the kept lock, sorted, written only when it changes — and never forgets a scope', () => {
    const dir = sandbox();
    try {
      const first = feedPrivateScopeRecord(dir, { npmrcText: '@zed:registry=https://npm.zed.example/\n@pub:registry=https://registry.npmjs.org/\n', lockTexts: [privateLock] }, NOW);
      expect([...first.keys()]).toEqual(['@acme', '@zed']);
      const file = join(dir, PRIVATE_SCOPES_FILE);
      const text = readFileSync(file, 'utf8');
      expect(JSON.parse(text)).toEqual({
        scopes: {
          '@acme': { origins: ['http://host.docker.internal:4873'], firstSeen: '2026-10-03T18:00:00.000Z' },
          '@zed': { origins: ['https://npm.zed.example'], firstSeen: '2026-10-03T18:00:00.000Z' },
        },
      });
      // The .npmrc unset and the lock pruned: nothing new, nothing removed, nothing written.
      const again = feedPrivateScopeRecord(dir, { npmrcText: '', lockTexts: [prunedLock] }, new Date('2026-10-04T00:00:00.000Z'));
      expect([...again.keys()]).toEqual(['@acme', '@zed']);
      expect(readFileSync(file, 'utf8')).toBe(text);
      expect(readdirSync(dir)).toEqual([PRIVATE_SCOPES_FILE]);
      // Nothing private seen and no record: no file at all.
      const empty = sandbox();
      expect(feedPrivateScopeRecord(empty, { npmrcText: '', lockTexts: [prunedLock] }).size).toBe(0);
      expect(readdirSync(empty)).toEqual([]);
      rmSync(empty, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a record the parser does not know refuses — it never reads as "no private scope"', () => {
    expect(() => parsePrivateScopeRecord('{}')).toThrow(/no "scopes" object/);
    expect(() => parsePrivateScopeRecord('{"scopes":{"@acme":{"origins":[]}}}')).toThrow(/entry "@acme"/);
    expect(() => parsePrivateScopeRecord('{"scopes":{"acme":{"origins":["http://r"],"firstSeen":"x"}}}')).toThrow(/entry "acme"/);
    expect(() => parsePrivateScopeRecord('not json')).toThrow();
  });

  it('a recorded scope reached by the build with no route is refused although no lock or manifest shows it private; routed or unreached is not', () => {
    const record = new Map([['@acme', { origins: ['http://host.docker.internal:4873'], firstSeen: 'x' }]]);
    const input = { lockTexts: [prunedLock], manifests: [host, probe], npmrcText: '' };
    expect(unroutedPrivateScopes({ ...input, record })).toEqual([
      { scope: '@acme', origins: ['http://host.docker.internal:4873'], packages: ['@acme/reg-probe'] },
    ]);
    // Paired control — the live failure: without the record nothing shows the scope private.
    expect(unroutedPrivateScopes(input)).toEqual([]);
    expect(unroutedPrivateScopes({ ...input, record, npmrcText: routed })).toEqual([]);
    expect(unroutedPrivateScopes({ ...input, record, manifests: [{ dependencies: { react: '19.3.0' } }] })).toEqual([]);
  });

  function scopeFixture(root: string, opts: { record?: string; tgz?: boolean }): string[] {
    writeJson(join(root, 'ws', 'neuralis', 'package.json'), opts.tgz
      ? { dependencies: { '@acme/probe-tgz': 'file:../local-tgz/acme__probe-tgz.tgz', react: '19.3.0' } }
      : host);
    if (opts.tgz) {
      writeJson(join(root, 'pack', 'package', 'package.json'), { ...probe, name: '@acme/probe-tgz' });
      mkdirSync(join(root, 'ws', 'local-tgz'), { recursive: true });
      expect(spawnSync('tar', ['-czf', join(root, 'ws', 'local-tgz', 'acme__probe-tgz.tgz'), '-C', join(root, 'pack'), 'package']).status).toBe(0);
    } else {
      writeJson(join(root, 'ws', 'local', 'acme__probe', 'package.json'), probe);
    }
    mkdirSync(join(root, 'buildlock'));
    writeFileSync(join(root, 'buildlock', 'pnpm-lock.yaml'), prunedLock);
    if (opts.record !== undefined) writeFileSync(join(root, 'buildlock', PRIVATE_SCOPES_FILE), opts.record);
    writeFileSync(join(root, 'tracked.yaml'), "lockfileVersion: '9.0'\n");
    return [SCRIPT, 'scope-routes', join(root, 'buildlock'), join(root, 'tracked.yaml'), join(root, 'ws')];
  }
  const RECORD = `${JSON.stringify({ scopes: { '@acme': { origins: ['http://host.docker.internal:4873'], firstSeen: 'x' } } })}\n`;

  it('the builder subcommand: a folder re-registered after the clean-up bake is refused before pnpm runs (record beside the pruned lock); routed, it passes', () => {
    const root = sandbox();
    try {
      const args = scopeFixture(root, { record: RECORD });
      const refused = spawnSync(process.execPath, [...args, join(root, 'absent-npmrc')], { encoding: 'utf8' });
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('@acme (@acme/reg-probe) is served by http://host.docker.internal:4873');
      expect(refused.stderr).toContain(`delete its entry from <NEURALIS_HOME>/build/${PRIVATE_SCOPES_FILE}`);
      writeFileSync(join(root, 'npmrc'), routed);
      const ok = spawnSync(process.execPath, [...args, join(root, 'npmrc')], { encoding: 'utf8' });
      expect([ok.status, ok.stdout + ok.stderr]).toEqual([0, '']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('control: the same tree without the record passes — the live failure this record closes', () => {
    const root = sandbox();
    try {
      const args = scopeFixture(root, {});
      const res = spawnSync(process.execPath, [...args, join(root, 'absent-npmrc')], { encoding: 'utf8' });
      expect(res.status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a TARBALL's own dependencies are read from inside it; an unreadable record refuses the build, naming the file", () => {
    const root = sandbox();
    try {
      const args = scopeFixture(root, { record: RECORD, tgz: true });
      const refused = spawnSync(process.execPath, [...args, join(root, 'absent-npmrc')], { encoding: 'utf8' });
      expect(refused.status).toBe(1);
      expect(refused.stderr).toContain('@acme (@acme/reg-probe) is served by');
      writeFileSync(join(root, 'buildlock', PRIVATE_SCOPES_FILE), '{"scopes": [');
      const broken = spawnSync(process.execPath, [...args, join(root, 'absent-npmrc')], { encoding: 'utf8' });
      expect(broken.status).toBe(1);
      expect(broken.stderr).toContain(`private-scope record ${join(root, 'buildlock', PRIVATE_SCOPES_FILE)} cannot be read`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('minimumReleaseAge — lifted for the private scopes only, on the command line', () => {
  it('names each scope routed to a non-public registry; a scope on the public registry or its yarnpkg mirror keeps the floor', () => {
    const npmrc = [
      '@acme:registry=http://host.docker.internal:4873/',
      '//host.docker.internal:4873/:_authToken=secret',
      '@pub:registry=https://registry.npmjs.org/',
      '@mirror:registry=https://registry.yarnpkg.com/',
      '# @commented:registry=http://x/',
      '@b:registry=https://npm.example.com/',
    ].join('\n');
    expect(privateScopes(npmrc)).toEqual(['@acme', '@b']);
    // pnpm 12.6.0 reads a comma/space list as ONE pattern; a repeated flag accumulates (measured).
    expect(releaseAgeExcludeFlags(privateScopes(npmrc))).toEqual([
      '--config.minimum-release-age-exclude=@acme/*',
      '--config.minimum-release-age-exclude=@b/*',
    ]);
  });

  it('the builder subcommand prints the flags, and nothing (exit 0) without a secret', () => {
    const root = sandbox();
    try {
      writeFileSync(join(root, 'npmrc'), '@acme:registry=http://r/\n//r/:_authToken=x\n');
      const res = spawnSync(process.execPath, [SCRIPT, 'release-age-excludes', join(root, 'npmrc')], { encoding: 'utf8' });
      expect(res.status).toBe(0);
      expect(res.stdout).toBe('--config.minimum-release-age-exclude=@acme/*');
      expect(res.stdout).not.toContain('_authToken');
      const none = spawnSync(process.execPath, [SCRIPT, 'release-age-excludes', join(root, 'absent')], { encoding: 'utf8' });
      expect([none.status, none.stdout]).toEqual([0, '']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('decideSetConflicts — every conflict decided by SOURCE', () => {
  const conflict = (a: string, b: string) => ({ packages: [a, b] as [string, string], message: `"${a}" vs "${b}"` });
  const decide = (pairs: Array<[string, string]>, lanes: Record<string, 'member' | 'local' | 'registry'>, roots: string[] = []) => {
    const names = Object.keys(lanes);
    const out = decideSetConflicts(names, (live: string[]) => pairs.filter(([a, b]) => live.includes(a) && live.includes(b)).map(([a, b]) => conflict(a, b)), new Map(Object.entries(lanes)), new Set(roots));
    return { refused: [...out.refused.keys()].sort(), failed: [...out.failed.keys()].sort() };
  };
  it('two workspace members: our own platform conflicts — the build fails for both', () => {
    expect(decide([['@x/a', '@x/b']], { '@x/a': 'member', '@x/b': 'member' })).toEqual({ refused: [], failed: ['@x/a', '@x/b'] });
  });
  it('a local and a registry package: the local one fails the build, the registry one is not refused', () => {
    expect(decide([['@l/a', '@r/b']], { '@l/a': 'local', '@r/b': 'registry' })).toEqual({ refused: [], failed: ['@l/a'] });
  });
  it('two registry packages that both provide a required contract: no source decides — both fail the build', () => {
    expect(decide([['@r/a', '@r/b']], { '@r/a': 'registry', '@r/b': 'registry' }, ['@r/a', '@r/b'])).toEqual({ refused: [], failed: ['@r/a', '@r/b'] });
  });
  it('a registry newcomer refused against a member is gone before the second pass: its other conflict refuses no one else', () => {
    expect(decide([['@m/a', '@r/x'], ['@r/x', '@r/y']], { '@m/a': 'member', '@r/x': 'registry', '@r/y': 'registry' }))
      .toEqual({ refused: ['@r/x'], failed: [] });
  });
});

describe('validate — the runtime provider\'s admission predicate after deploy', () => {
  const kernelRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'packages', 'package-system');

  type Neuralis = { provides?: readonly string[]; configSettings?: ReadonlyArray<Record<string, unknown>> };
  const key = (k: string) => ({ key: k, type: 'number', default: 1, description: 'x' });

  /**
   * A deploy tree with a stub runtime provider whose predicate refuses every
   * package named `*bad*`, plus `extra` builtin-class packages.
   */
  function deployFixture(root: string, extra: Record<string, Neuralis> = {}, runtime: Neuralis = { provides: ['runtime'] }): string {
    const nm = join(root, 'deploy', 'node_modules');
    writeJson(join(nm, '@x', 'runtime', 'package.json'), { name: '@x/runtime', neuralis: runtime });
    mkdirSync(join(nm, '@x', 'runtime', 'dist', 'packages'), { recursive: true });
    writeFileSync(
      join(nm, '@x', 'runtime', 'dist', 'packages', 'packageValidator.js'),
      "import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\n" +
        "export const packageValidator = { async validate(root) { const name = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name;" +
        " return { packageId: name, errors: name.includes('bad') ? ['tools/ping.json: category is required'] : [] }; } };\n",
    );
    for (const name of ['@acme/local-bad', '@acme/reg-bad', '@acme/good']) writeJson(join(nm, name, 'package.json'), { name, neuralis: {} });
    for (const [name, block] of Object.entries(extra)) writeJson(join(nm, name, 'package.json'), { name, neuralis: block });
    writeJson(join(nm, '@x', 'kernel', 'package.json'), { name: '@x/kernel', neuralis: { referenceOnly: true } });
    writeJson(join(nm, 'plain', 'package.json'), { name: 'plain' });
    return join(root, 'deploy');
  }

  /** The host manifest + the resolved lock's host importer: `link:` = member, `file:` = local, a semver = registry. */
  function hostFixture(root: string, deps: Record<string, string>): { host: string; lock: string } {
    const spec = (v: string) => (v.startsWith('link:') ? '1.0.0' : v.startsWith('file:') ? `file:../${v.slice(5)}` : v);
    writeJson(join(root, 'host.json'), { dependencies: Object.fromEntries(Object.entries(deps).map(([n, v]) => [n, spec(v)])) });
    const lines = ['lockfileVersion: \'9.0\'', '', 'importers:', '', '  neuralis:', '    dependencies:'];
    for (const [name, version] of Object.entries(deps)) lines.push(`      '${name}':`, `        specifier: ${spec(version)}`, `        version: ${version}`);
    writeFileSync(join(root, 'lock.yaml'), `${lines.join('\n')}\n`);
    return { host: join(root, 'host.json'), lock: join(root, 'lock.yaml') };
  }

  function runValidate(root: string, deploy: string, files: { host: string; lock: string }) {
    const out = join(root, 'out', 'validate.json');
    const res = spawnSync(process.execPath, [SCRIPT, 'validate', deploy, kernelRoot, files.host, files.lock, out], { encoding: 'utf8' });
    return { res, report: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null, out };
  }

  it('a LOCAL package the loader would refuse fails the build, named with its messages', () => {
    const root = sandbox();
    try {
      const deploy = deployFixture(root);
      const files = hostFixture(root, {
        '@x/runtime': 'link:../packages/runtime', '@x/kernel': 'link:../packages/kernel', '@acme/local-bad': 'file:local/acme__local-bad',
        '@acme/good': '1.0.0', plain: '1.0.0',
      });
      const { res, report } = runValidate(root, deploy, files);
      expect(res.status).toBe(1);
      expect(res.stderr).toContain('@acme/local-bad (built here): tools/ping.json: category is required');
      expect(report).toEqual({ checked: 3, failed: [{ packageId: '@acme/local-bad', errors: ['tools/ping.json: category is required'] }], refused: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a REGISTRY package is refused-and-named, and the build goes on (the boot leaves it out alone)', () => {
    const root = sandbox();
    try {
      const deploy = deployFixture(root);
      const { res, report } = runValidate(root, deploy, hostFixture(root, { '@x/runtime': 'link:../packages/runtime', '@acme/reg-bad': '1.0.0', '@acme/good': '1.0.0' }));
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain('@acme/reg-bad: refused (invalid)');
      expect(report.refused).toEqual([{ packageId: '@acme/reg-bad', reason: 'invalid', errors: ['tools/ping.json: category is required'] }]);
      expect(report.failed).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a REGISTRY package that provides a REQUIRED contract and fails is never refused: the build fails (the boot could not run without it)', () => {
    const root = sandbox();
    try {
      const deploy = deployFixture(root, { '@acme/bad-verifier': { provides: ['session-ticket-verifier'] } });
      const { res, report } = runValidate(root, deploy, hostFixture(root, { '@x/runtime': '1.0.0', '@acme/bad-verifier': '1.0.0' }));
      expect(res.status).toBe(1);
      expect(report.failed).toEqual([{ packageId: '@acme/bad-verifier', errors: ['tools/ping.json: category is required'] }]);
      expect(report.refused).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a platform package in the WORKSPACE that fails is built here: the build fails (the lane is the lock, not the spec)', () => {
    const root = sandbox();
    try {
      const deploy = deployFixture(root, { '@x/core-bad': {} });
      const { res, report } = runValidate(root, deploy, hostFixture(root, { '@x/runtime': 'link:../packages/runtime', '@x/core-bad': 'link:../packages/core-bad' }));
      expect(res.status).toBe(1);
      expect(report.failed.map((f: { packageId: string }) => f.packageId)).toEqual(['@x/core-bad']);
      expect(report.refused).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['a singular contract', { provides: ['runtime', 'agent-directory'] }, { provides: ['agent-directory'] }, 'contract "agent-directory" is provided by both "@acme/clash" and "@x/runtime"'],
    ['a config key', { provides: ['runtime'], configSettings: [key('maxThings')] }, { configSettings: [key('maxThings')] }, 'config key "maxThings" is declared by both "@acme/clash" and "@x/runtime"'],
  ] as const)('a LOCAL package colliding with a workspace package on %s fails the build, naming both and the subject', (_label, runtime, clash, message) => {
    const root = sandbox();
    try {
      const deploy = deployFixture(root, { '@acme/clash': clash }, runtime);
      const { res, report } = runValidate(root, deploy, hostFixture(root, { '@x/runtime': 'link:../packages/runtime', '@acme/clash': 'file:local/acme__clash' }));
      expect(res.status).toBe(1);
      expect(res.stderr).toContain(message);
      expect(report.failed).toEqual([{ packageId: '@acme/clash', errors: [expect.stringContaining(message)] }]);
      expect(report.refused).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a REGISTRY package colliding with a workspace package is refused (conflict), the build goes on, and the boot reads that record', async () => {
    const root = sandbox();
    try {
      const deploy = deployFixture(root, { '@acme/clash': { provides: ['agent-directory'], configSettings: [key('maxThings')] } }, {
        provides: ['runtime', 'agent-directory'], configSettings: [key('maxThings')],
      });
      const { res, report, out } = runValidate(root, deploy, hostFixture(root, { '@x/runtime': 'link:../packages/runtime', '@acme/clash': '2.0.0' }));
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).toContain('@acme/clash: refused (conflict)');
      expect(report.failed).toEqual([]);
      expect(report.refused).toEqual([{ packageId: '@acme/clash', reason: 'conflict', errors: [
        expect.stringContaining('contract "agent-directory"'), expect.stringContaining('config key "maxThings"'),
      ] }]);
      // The host reader takes the record the build wrote, byte for byte.
      const { readBuildRefusals, BUILD_VALIDATE_RECORD } = await import('../../../src/server/host/buildRefusals.ts');
      writeJson(join(root, 'host-root', BUILD_VALIDATE_RECORD), JSON.parse(readFileSync(out, 'utf8')));
      expect(await readBuildRefusals(join(root, 'host-root'))).toEqual({ kind: 'record', refused: [{ packageId: '@acme/clash', reason: 'conflict' }] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('two REGISTRY packages: the one providing the platform\'s required contract stays, the other is refused; two plain ones are both refused', () => {
    const root = sandbox();
    try {
      const deploy = deployFixture(
        root,
        { '@acme/dir': { provides: ['agent-directory'] }, '@acme/k1': { configSettings: [key('k')] }, '@acme/k2': { configSettings: [key('k')] } },
        { provides: ['runtime', 'session-ticket-verifier', 'agent-directory'] },
      );
      const { res, report } = runValidate(root, deploy, hostFixture(root, {
        '@x/runtime': '1.0.0', '@acme/dir': '1.0.0', '@acme/k1': '1.0.0', '@acme/k2': '1.0.0',
      }));
      expect(res.status, res.stderr).toBe(0);
      expect(report.refused.map((r: { packageId: string; reason: string }) => [r.packageId, r.reason]).sort()).toEqual([
        ['@acme/dir', 'conflict'], ['@acme/k1', 'conflict'], ['@acme/k2', 'conflict'],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('two REGISTRY packages both providing a required contract: no source decides, the build fails naming both', () => {
    const root = sandbox();
    try {
      const deploy = deployFixture(root, { '@acme/rt': { provides: ['runtime'] } });
      const { res, report } = runValidate(root, deploy, hostFixture(root, { '@x/runtime': '1.0.0', '@acme/rt': '1.0.0' }));
      expect(res.status).toBe(1);
      expect(report.failed.map((f: { packageId: string }) => f.packageId).sort()).toEqual(['@acme/rt', '@x/runtime']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('control: a set without a conflict refuses nothing', () => {
    const root = sandbox();
    try {
      const deploy = deployFixture(root, { '@acme/fine': { provides: ['channel-gateway'], configSettings: [key('own')] } }, {
        provides: ['runtime'], configSettings: [key('mine')],
      });
      const { res, report } = runValidate(root, deploy, hostFixture(root, { '@x/runtime': 'link:../packages/runtime', '@acme/fine': '1.0.0' }));
      expect(res.status, res.stderr).toBe(0);
      expect(report).toEqual({ checked: 2, failed: [], refused: [] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
