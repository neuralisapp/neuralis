import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  apkbuildSha512sums, collect, collectApk, DATA_DIR, loadPolicy, missingFrom, render,
} from '../third-party-notices.mjs';

/**
 * The notices generator, by its command line (the exit code every build hook
 * sees) and its functions. Each red row is ONE variable away from a green one.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'third-party-notices.mjs');
const REPO = join(HERE, '..', '..', '..', '..');

const sandboxes: string[] = [];
function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'neuralis-notices-'));
  sandboxes.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Pkg = { name: string; version?: string; license?: string; files?: Record<string, string>; extra?: Record<string, unknown> };
function put(root: string, pkg: Pkg): void {
  const dir = join(root, ...pkg.name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version ?? '1.0.0', ...(pkg.license ? { license: pkg.license } : {}), ...pkg.extra }));
  for (const [file, text] of Object.entries(pkg.files ?? {})) writeFileSync(join(dir, file), text);
}

/** A compliant installed tree: MIT, Apache-2.0 with a NOTICE, a scoped ISC, a first-party and a private package. */
function compliantTree(root: string): string {
  const modules = join(root, 'node_modules');
  put(modules, { name: 'left-pad', license: 'MIT', files: { LICENSE: 'MIT licence of left-pad\n' } });
  put(modules, { name: 'apache-thing', license: 'Apache-2.0', files: { LICENSE: 'Apache licence text\n', NOTICE: 'apache-thing\nCopyright 2026 The Apache Thing authors\n' } });
  put(modules, { name: '@scope/isc-lib', license: 'ISC', files: { 'LICENSE.md': 'ISC licence of isc-lib\n' } });
  put(modules, { name: '@neuralis/kernel', license: 'FSL-1.1-ALv2' });
  put(modules, { name: 'my-local-package', extra: { private: true } });
  return modules;
}

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

describe('third-party-notices — the generator', () => {
  it('a compliant tree is green: every third-party package and its NOTICE are carried, first-party and private ones are not', () => {
    const root = sandbox();
    const out = join(root, 'NOTICES.md');
    const r = run(['--title', 'fixture', '--tree', compliantTree(root), '--out', out]);
    expect(r.status, r.stderr).toBe(0);
    const text = readFileSync(out, 'utf8');
    expect(text.match(/^## /gm)).toHaveLength(3);
    for (const heading of ['## left-pad 1.0.0', '## apache-thing 1.0.0', '## @scope/isc-lib 1.0.0']) expect(text).toContain(`\n${heading}\n`);
    expect(text).toContain('    Copyright 2026 The Apache Thing authors');
    expect(text).not.toMatch(/@neuralis\/kernel|my-local-package/);
    // No source offer without a GPL-family component.
    expect(text).not.toContain('team@neuralisapp.com');
    // --check on the written file is green.
    expect(run(['--title', 'fixture', '--tree', join(root, 'node_modules'), '--out', out, '--check']).status).toBe(0);
  });

  it('minus ONE licence file (a licence with no tracked SPDX text) is red, naming that package; with the file it is green', () => {
    const root = sandbox();
    const modules = compliantTree(root);
    put(modules, { name: 'icu-tool', version: '2.1.0', license: 'ICU', files: { LICENSE: 'ICU License\n' } });
    expect(run(['--title', 'fixture', '--tree', modules, '--out', join(root, 'a.md')]).status).toBe(0);
    rmSync(join(modules, 'icu-tool', 'LICENSE'));
    const r = run(['--title', 'fixture', '--tree', modules, '--out', join(root, 'b.md')]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('npm icu-tool@2.1.0: ships no licence file and policy.json has no SPDX text for "ICU"');
  });

  it('a package with no licence file whose licence has a tracked SPDX text gets that text, marked as the reference text', () => {
    const root = sandbox();
    const modules = join(root, 'node_modules');
    put(modules, { name: 'bare-mit', license: 'MIT', extra: { author: 'Ada Example' } });
    const out = join(root, 'NOTICES.md');
    expect(run(['--title', 'fixture', '--tree', modules, '--out', out]).status).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain('MIT (SPDX reference text; copyright holder per package.json: Ada Example)');
  });

  it('an Apache NOTICE dropped from the notices file is red under --check, naming the package and the NOTICE', () => {
    const root = sandbox();
    const modules = compliantTree(root);
    const out = join(root, 'NOTICES.md');
    expect(run(['--title', 'fixture', '--tree', modules, '--out', out]).status).toBe(0);
    const policy = loadPolicy();
    const components = collect({ tree: [modules], metafile: [], apk: null, binary: [] }, policy);
    const full = readFileSync(out, 'utf8');
    expect(missingFrom(full, components, policy)).toEqual([]);
    const noticeId = /NOTICE → text ([0-9a-f]{12})/.exec(full)![1];
    const dropped = full.replace(new RegExp(`### text ${noticeId}\\n\\n[\\s\\S]*?(?=\\n### text |$)`), '');
    writeFileSync(out, dropped);
    expect(missingFrom(dropped, components, policy)).toEqual([`npm apache-thing@1.0.0: NOTICE text NOTICE (${noticeId}) not carried`]);
    const r = run(['--title', 'fixture', '--tree', modules, '--out', out, '--check']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('apache-thing@1.0.0: NOTICE text');
  });

  it('a licence outside the allow-set is red; no licence field is red; each names the package', () => {
    const root = sandbox();
    const modules = compliantTree(root);
    put(modules, { name: 'odd-licence', license: 'SSPL-1.0', files: { LICENSE: 'SSPL\n' } });
    put(modules, { name: 'no-field', files: { LICENSE: 'some text\n' } });
    const r = run(['--title', 'fixture', '--tree', modules, '--out', join(root, 'x.md')]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('npm odd-licence@1.0.0: licence "SSPL-1.0" is not in policy.json allow');
    expect(r.stderr).toContain('npm no-field@1.0.0: no licence field');
  });

  it('payload, not lockfile: a devDependency that is only in the bundle metafile is listed', () => {
    const root = sandbox();
    const modules = join(root, 'node_modules');
    put(modules, { name: 'bundled-dev-dep', license: 'MIT', files: { LICENSE: 'MIT\n' } });
    put(modules, { name: 'not-bundled', license: 'MIT', files: { LICENSE: 'MIT\n' } });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', devDependencies: { 'bundled-dev-dep': '1.0.0', 'not-bundled': '1.0.0' } }));
    mkdirSync(join(root, '.build'));
    const metafile = join(root, '.build', 'metafile-esm.json');
    // A pnpm virtual-store path resolves to the package directly under its LAST node_modules.
    mkdirSync(join(modules, '.pnpm', 'bundled-dev-dep@1.0.0', 'node_modules'), { recursive: true });
    cpSync(join(modules, 'bundled-dev-dep'), join(modules, '.pnpm', 'bundled-dev-dep@1.0.0', 'node_modules', 'bundled-dev-dep'), { recursive: true });
    writeFileSync(metafile, JSON.stringify({ base: '..', inputs: { 'node_modules/.pnpm/bundled-dev-dep@1.0.0/node_modules/bundled-dev-dep/lib/index.js': {}, 'src/main.ts': {} } }));
    const out = join(root, 'NOTICES.md');
    const r = run(['--title', 'fixture', '--metafile', metafile, '--out', out]);
    expect(r.status, r.stderr).toBe(0);
    const text = readFileSync(out, 'utf8');
    expect(text).toContain('\n## bundled-dev-dep 1.0.0\n');
    expect(text).not.toContain('not-bundled');
  });

  it('a GPL-family component carries the source offer, and a policy without one is red', () => {
    const policy = loadPolicy();
    const lgpl = { kind: 'npm', name: 'libvips-like', version: '1.0.0', license: 'LGPL-3.0-or-later', source: null, author: null, texts: [{ label: 'LICENSE', text: 'LGPL\n' }] };
    const green = render([lgpl], policy, 'fixture');
    expect(green.errors).toEqual([]);
    expect(green.text).toContain(policy.sourceOffer);
    expect(green.text).toContain('- Source code: see the offer at the top of this file');
    const red = render([lgpl], { ...policy, sourceOffer: 'TODO' }, 'fixture');
    expect(red.errors).toEqual(['npm libvips-like@1.0.0: GPL-family licence and no source offer in policy.json']);
  });

  it('apk: every installed package with its SPDX texts; a pinned binary whose apk licence changed is red', () => {
    const policy = loadPolicy();
    const db = 'P:musl\nV:1.2.6-r3\nL:MIT\no:musl\nc:abc\n\nP:github-cli\nV:2.97.0-r2\nL:MIT\no:github-cli\nc:def\n\nP:xz-libs\nV:5.8-r0\nL:GPL-2.0-or-later AND 0BSD AND Public Domain AND LGPL-2.1-or-later\no:xz\nc:123\n';
    const { errors, text } = render(collectApk(db, policy), policy, 'fixture');
    expect(errors).toEqual([]);
    expect(text).toContain('- Source: Alpine aports, origin xz, commit 123');
    expect(text).toContain('- Public-Domain: a public-domain dedication carries no licence text');
    expect(text).toContain('GitHub CLI 2.97.0: LICENSE');
    expect(() => collectApk(db.replace('L:MIT\no:github-cli', 'L:Apache-2.0\no:github-cli'), policy)).toThrow(/github-cli: the installed licence "Apache-2.0" is not the pinned "MIT"/);
  });

  it('apk "custom" passes only for a package the policy names; musl must be the pinned version; --also names the sibling files', () => {
    const policy = loadPolicy();
    const db = 'P:unzip\nV:6.0-r16\nL:custom\no:unzip\nc:a\n\nP:aom-libs\nV:3.14.1-r0\nL:BSD-2-Clause AND custom\no:aom\nc:b\n\nP:musl\nV:1.2.6-r3\nL:MIT\no:musl\nc:c\n';
    const green = render(collectApk(db, policy), policy, 'fixture', ['/x/OTHER.md']);
    expect(green.errors).toEqual([]);
    expect(green.text).toContain('custom = Info-ZIP (SPDX reference text)');
    expect(green.text).toContain('- custom: the Alliance for Open Media Patent License 1.0');
    expect(green.text).toContain('The other third-party notices of the same artifact: /x/OTHER.md.');
    const red = render(collectApk(db.replace('P:unzip', 'P:unnamed'), policy), policy, 'fixture');
    expect(red.errors).toContain('apk unnamed@6.0-r16: licence "custom" is not in policy.json allow (and has no noText row)');
    const dir = sandbox();
    writeFileSync(join(dir, 'installed'), db);
    expect(collect({ tree: [], metafile: [], apk: join(dir, 'installed'), binary: ['musl'] }, policy).at(-1)?.name).toBe('musl');
    writeFileSync(join(dir, 'installed'), db.replace('V:1.2.6-r3', 'V:1.2.7-r0'));
    expect(() => collect({ tree: [], metafile: [], apk: join(dir, 'installed'), binary: ['musl'] }, policy)).toThrow(/--binary musl: policy.json pins 1.2.6, the image's apk musl is 1.2.7-r0/);
  });

  it('a tracked text whose bytes drifted from its pinned sha256 fails the policy load', () => {
    const copy = join(sandbox(), 'third-party');
    cpSync(DATA_DIR, copy, { recursive: true });
    expect(() => loadPolicy(copy)).not.toThrow();
    writeFileSync(join(copy, 'upstream', 'musl-1.2.6', 'COPYRIGHT'), 'edited\n');
    expect(() => loadPolicy(copy)).toThrow(/binary musl: upstream\/musl-1.2.6\/COPYRIGHT does not match its pinned sha256/);
  });

  it('reads an APKBUILD sha512sums block as text (it never runs the APKBUILD)', () => {
    const h = (c: string) => c.repeat(128);
    const apkbuild = `pkgname=x\n$(touch /tmp/never)\nsha512sums="\n${h('a')}  x-1.0.tar.gz\n${h('b')}  fix.patch\n"\n`;
    expect([...apkbuildSha512sums(apkbuild)]).toEqual([['x-1.0.tar.gz', h('a')], ['fix.patch', h('b')]]);
    expect(() => apkbuildSha512sums('pkgname=x\n')).toThrow(/no sha512sums block/);
  });
});

describe('third-party-notices — the tracked pins stay the pins the artifacts use', () => {
  const policy = JSON.parse(readFileSync(join(DATA_DIR, 'policy.json'), 'utf8')) as {
    sourceOffer: string;
    spdx: Record<string, { file: string; url: string; sha256: string }>;
    binaries: Record<string, { version: string; files: Array<{ file: string; url: string; sha256: string }> }>;
  };
  const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');
  const one = (text: string, re: RegExp): string => {
    const m = re.exec(text);
    if (!m) throw new Error(`no match for ${re}`);
    return m[1];
  };

  it('each binary row names the version its artifact pins', () => {
    const dockerfile = read('neuralis/Dockerfile');
    expect(policy.binaries.qdrant.version).toBe(one(read('neuralis/scripts/setup/qdrantVersion.mts'), /QDRANT_TARGET_VERSION\s*=\s*'([^']+)'/));
    expect(policy.binaries.jq.version).toBe(one(read('apps/desktop/scripts/fetch-jq.mjs'), /JQ_VERSION\s*=\s*'([^']+)'/));
    expect(policy.binaries.node.version).toBe(one(read('apps/desktop/scripts/fetch-node.mjs'), /NODE_VERSION\s*=\s*'([^']+)'/));
    expect(policy.binaries.node.version).toBe(one(dockerfile, /the base is Node\n# (\d+\.\d+\.\d+)\)/));
    expect(policy.binaries.uv.version).toBe(one(dockerfile, /ARG UV_VERSION=(\S+)/));
    expect(policy.binaries['extism-js'].version).toBe(one(dockerfile, /ARG EXTISM_JS_VERSION=(\S+)/));
    expect(policy.binaries.binaryen.version).toBe(one(dockerfile, /ARG BINARYEN_VERSION=(\S+)/));
    expect(policy.binaries.uv.version).toBe(one(read('packages/agent-core/docker/mcp-sidecar/Dockerfile'), /COPY --from=ghcr\.io\/astral-sh\/uv:([^@\s]+)@/));
  });

  it('both companions run ONE notices script, its every text pin is a policy pin (same url, same sha256), and it carries the policy\'s source offer', () => {
    const pins = new Map([
      ...Object.values(policy.binaries).flatMap((b) => b.files.map((f) => [f.url, f.sha256] as const)),
      ...Object.values(policy.spdx).map((r) => [r.url, r.sha256] as const),
    ]);
    const scripts = ['packages/agent-core/docker/mcp-sidecar/Dockerfile', 'packages/machine-core/docker/Dockerfile']
      .map((rel) => one(read(rel), /^RUN node - \/usr\/share\/doc\/neuralis .*<<'NOTICES'\n([\s\S]*?)^NOTICES$/m));
    expect(scripts[1]).toBe(scripts[0]);
    const fetched = [...scripts[0].matchAll(/\["[^"]+","(https:[^"]+)","([0-9a-f]{64})"\]/g)];
    expect(fetched.length).toBe(12);
    for (const [, url, sha] of fetched) expect(pins.get(url), url).toBe(sha);
    expect(scripts[0]).toContain(`"${policy.sourceOffer}"`);
  });

  it('every SPDX row names the license-list-data release its text was taken from', () => {
    for (const [id, row] of Object.entries(policy.spdx)) {
      expect(row.url, id).toBe(`https://raw.githubusercontent.com/spdx/license-list-data/v3.29.0/text/${row.file.slice('spdx/'.length)}`);
    }
  });

  it('every tracked text is referenced by the policy, and every reference exists', () => {
    const referenced = new Set([...Object.values(policy.spdx).map((r) => r.file), ...Object.values(policy.binaries).flatMap((b) => b.files.map((f) => f.file))]);
    const onDisk: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        if (name.isDirectory()) walk(join(dir, name.name));
        else if (name.name !== 'policy.json') onDisk.push(relative(DATA_DIR, join(dir, name.name)).split('\\').join('/'));
      }
    };
    walk(DATA_DIR);
    expect(onDisk.sort()).toEqual([...referenced].sort());
  });
});
