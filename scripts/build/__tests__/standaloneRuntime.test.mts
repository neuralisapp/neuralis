import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { assembleStandaloneRuntime, assertWindowsPathBudget, isBuildOnlyPath, isMachineLocalFile, UNTRACED_HOST_PATHS, WINDOWS_INSTALL_PREFIX, WINDOWS_MAX_PATH } from '../standalone-runtime.mts';
import { requiredNativeArtifacts } from '../reconcile-runtime-externals.mjs';

/**
 * The image's runnable tree is assembled by ONE script now. Its proof is the
 * tree the OLD Dockerfile runner steps produced: those steps, re-enacted here
 * as the shell commands Docker ran (a `COPY <dir> <dst>` is "the dir's content
 * into dst"), and the script, both on one synthetic `next build` output; the
 * two trees must digest identically. `treeDigest.mjs` is not reused: it
 * follows symlinks and hashes no modes, and the Turbopack aliases ARE
 * symlinks. Every fixture lives in a mkdtemp sandbox.
 */

const RECONCILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'reconcile-runtime-externals.mjs');
const BUNDLE_UP = join(dirname(fileURLToPath(import.meta.url)), '..', 'bundle-up.mjs');
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'standalone-runtime.mts');

const sandboxes: string[] = [];
function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'neuralis-standalone-'));
  sandboxes.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function put(path: string, content: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, mode);
}

/** A `next build` output + deploy tree + build report, shaped like the real ones. */
function fixture(root: string): { app: string; deploy: string; report: string } {
  const app = join(root, 'neuralis');
  const sa = join(app, '.next', 'standalone');
  put(join(sa, 'neuralis', 'server.js'), 'process.chdir(__dirname);\n');
  put(join(sa, 'neuralis', 'package.json'), '{"name":"neuralis","version":"0.0.0"}\n');
  put(join(sa, 'neuralis', '.next', 'server', 'app.js'), 'module.exports = 1;\n');
  put(join(sa, 'neuralis', 'src', 'server', 'x.ts'), 'export const x = 1;\n');
  // The tracer's partial scripts/ — the untraced copy must land over it.
  put(join(sa, 'neuralis', 'scripts', 'cli', 'registry.mts'), '// traced, stale\n');
  put(join(sa, 'neuralis', 'scripts', 'mcp-http.ts'), '// traced only\n');
  const aliases = join(sa, 'neuralis', '.next', 'node_modules');
  mkdirSync(join(aliases, '@neuralis'), { recursive: true });
  symlinkSync('../../../node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty', join(aliases, 'node-pty-0123456789abcdef'));
  symlinkSync('../../../../node_modules/.pnpm/k/node_modules/@neuralis/kernel', join(aliases, '@neuralis', 'kernel-fedcba9876543210'));
  // The tracer's node_modules: a package the deploy tree lacks, one it has (no-clobber), and a symlink.
  put(join(sa, 'node_modules', 'traced-only', 'index.js'), 'module.exports = "traced";\n');
  put(join(sa, 'node_modules', 'node-pty', 'lib', 'index.js'), 'module.exports = "TRACED COPY";\n');
  symlinkSync('traced-only', join(sa, 'node_modules', 'traced-link'));
  put(join(app, '.next', 'static', 'chunks', 'a.js'), 'static\n');
  put(join(app, 'public', 'logo.svg'), '<svg/>\n');
  put(join(app, 'skills', 'neuralis-operations', 'SKILL.md'), '# ops\n');
  put(join(app, 'bin', 'neuralis.mjs'), '#!/usr/bin/env node\n', 0o755);
  put(join(app, 'scripts', 'cli', 'registry.mts'), 'export async function main() { return 0; } // live registry\n');
  put(join(app, 'scripts', 'upgrade.mts'), '// upgrade\n');
  put(join(app, 'scripts', 'checkpoint.mts'), '// checkpoint\n');
  for (const f of ['detect', 'envFile', 'ownerCheck']) put(join(app, 'scripts', 'setup', `${f}.mts`), `// ${f}\n`);
  put(join(app, 'scripts', 'upgrades', 'a.mts'), '// a\n');
  const deploy = join(root, 'deploy', 'node_modules');
  put(join(deploy, 'node-pty', 'package.json'), '{"name":"node-pty","version":"1.1.0","main":"lib/index.js"}\n');
  put(join(deploy, 'node-pty', 'lib', 'index.js'), 'module.exports = "deployed";\n');
  put(join(deploy, 'node-pty', 'build', 'Release', 'pty.node'), 'native\n');
  put(join(deploy, '@neuralis', 'kernel', 'package.json'), '{"name":"@neuralis/kernel","version":"0.3.3"}\n');
  const report = join(root, 'build-report');
  put(join(report, 'validate.json'), '{"refused":[]}\n');
  return { app, deploy, report };
}

/** The OLD runner steps 1, 1b, 1c, 2, 3, 3b, 4, 4b of `neuralis/Dockerfile`, as Docker ran them — plus 1d, the `up` bundle (`bundle-up.mjs`). */
const OLD_STEPS = String.raw`
set -eu
APP="$1"; DEPLOY="$2"; REPORT="$3"; OUT="$4"; RECONCILE="$5"; BUNDLE_UP="$6"
mkdir -p "$OUT" && cd "$OUT"
copydir() { mkdir -p "$2" && cp -a "$1/." "$2/"; }
copydir "$APP/.next/standalone/neuralis" .
copydir "$APP/.next/standalone/node_modules" ./node_modules-standalone
copydir "$APP/skills" ./skills
copydir "$APP/bin" ./bin
copydir "$APP/scripts/cli" ./scripts/cli
cp -a "$APP/scripts/upgrade.mts" "$APP/scripts/checkpoint.mts" ./scripts/
mkdir -p ./scripts/setup && cp -a "$APP/scripts/setup/detect.mts" "$APP/scripts/setup/envFile.mts" "$APP/scripts/setup/ownerCheck.mts" ./scripts/setup/
copydir "$APP/scripts/upgrades" ./scripts/upgrades
node "$BUNDLE_UP" "$APP" "$OUT" >/dev/null
mkdir -p ./_runtime && mv ./server.js ./_runtime/server.js && mv ./.next ./_runtime/.next && cp ./package.json ./_runtime/package.json
rm -rf ./node_modules
copydir "$DEPLOY" ./node_modules
cp -rn ./node_modules-standalone/. ./node_modules/ && rm -rf ./node_modules-standalone
node "$RECONCILE" "$OUT" >/dev/null
copydir "$APP/.next/static" ./_runtime/.next/static
copydir "$APP/public" ./_runtime/public
copydir "$REPORT" ./_runtime/build
`;

/** Every entry: path, type, mode bits, and its bytes' sha256 or its symlink target — no times. */
function treeDigest(root: string): string {
  const lines: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const st = lstatSync(full);
      const rel = relative(root, full);
      const mode = (st.mode & 0o7777).toString(8);
      if (st.isSymbolicLink()) lines.push(`L ${rel} ${readlinkSync(full)}`);
      else if (st.isDirectory()) { lines.push(`D ${rel} ${mode}`); walk(full); }
      else lines.push(`F ${rel} ${mode} ${createHash('sha256').update(readFileSync(full)).digest('hex')}`);
    }
  };
  walk(root);
  return lines.join('\n');
}

function runOld(input: { app: string; deploy: string; report: string }, out: string): void {
  const r = spawnSync('bash', ['-c', OLD_STEPS, 'old', input.app, input.deploy, input.report, out, RECONCILE, BUNDLE_UP], { encoding: 'utf-8' });
  expect(r.status, r.stderr).toBe(0);
}

describe('standalone-runtime — the one runnable-tree layout', () => {
  it('produces the same tree as the old Dockerfile runner steps, byte for byte', () => {
    const root = sandbox();
    const input = fixture(root);
    const oldOut = join(root, 'old');
    const newOut = join(root, 'new');
    runOld(input, oldOut);
    const r = spawnSync(process.execPath, [SCRIPT, '--app', input.app, '--deploy-modules', input.deploy, '--build-report', input.report, '--out', newOut], { encoding: 'utf-8' });
    expect(r.status, r.stderr).toBe(0);
    const digest = treeDigest(newOut);
    expect(digest).toBe(treeDigest(oldOut));
    // The layout's load-bearing facts, read off the tree itself.
    expect(readFileSync(join(newOut, '_runtime', 'server.js'), 'utf-8')).toContain('chdir');
    expect(readFileSync(join(newOut, 'node_modules', 'node-pty', 'lib', 'index.js'), 'utf-8')).toContain('deployed');
    expect(readlinkSync(join(newOut, '_runtime', '.next', 'node_modules', 'node-pty-0123456789abcdef'))).toBe('../../../node_modules/node-pty');
    expect(readFileSync(join(newOut, 'scripts', 'cli', 'registry.mts'), 'utf-8')).toBe('export async function main() { return 0; } // live registry\n');
    expect(digest).not.toMatch(/\.neuralis-native/);
  });

  it('the comparison sees a one-file difference (paired control)', () => {
    const root = sandbox();
    const input = fixture(root);
    const a = join(root, 'a');
    const b = join(root, 'b');
    assembleStandaloneRuntime({ app: input.app, deployModules: input.deploy, buildReport: input.report, out: a });
    assembleStandaloneRuntime({ app: input.app, deployModules: input.deploy, buildReport: input.report, out: b });
    expect(treeDigest(b)).toBe(treeDigest(a));
    writeFileSync(join(b, '_runtime', 'public', 'logo.svg'), '<svg changed/>\n');
    expect(treeDigest(b)).not.toBe(treeDigest(a));
  });

  it('refuses a non-empty --out and a missing standalone output, and a failed reconcile fails the assembly', () => {
    const root = sandbox();
    const input = fixture(root);
    const out = join(root, 'out');
    put(join(out, 'stray'), 'x');
    expect(() => assembleStandaloneRuntime({ app: input.app, deployModules: input.deploy, buildReport: null, out })).toThrow(/not empty/);
    expect(() => assembleStandaloneRuntime({ app: join(root, 'nope'), deployModules: input.deploy, buildReport: null, out: join(root, 'o2') })).toThrow(/--app/);
    rmSync(join(input.deploy, 'node-pty', 'build'), { recursive: true });
    const r = spawnSync(process.execPath, [SCRIPT, '--app', input.app, '--deploy-modules', input.deploy, '--out', join(root, 'o3')], { encoding: 'utf-8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/required native artifact build\/Release\/pty\.node is missing/);
  });

  it('never writes an env file or a compose file of the HOST (its root, _runtime/, its own folders) — a dependency\'s own are kept byte for byte', () => {
    const root = sandbox();
    const clean = fixture(join(root, 'clean'));
    const planted = fixture(join(root, 'planted'));
    const secrets = [
      join(planted.app, '.next', 'standalone', 'neuralis', '.env'),
      join(planted.app, '.next', 'standalone', 'neuralis', '.env.production'),
      join(planted.app, '.next', 'standalone', 'neuralis', '.env.example'),
      join(planted.app, '.next', 'standalone', 'neuralis', 'docker-compose.yml'),
      join(planted.app, '.next', 'standalone', 'neuralis', 'docker-compose.override.yml'),
      join(planted.app, '.next', 'standalone', 'neuralis', 'src', 'server', '.env.local'),
      join(planted.app, 'skills', '.env'),
      join(planted.app, 'public', '.env.production'),
    ];
    for (const s of secrets) put(s, 'NEXTAUTH_SECRET=do-not-ship\n');
    // A dependency's own files are its package content, not an operator's: the
    // old image copied them, so the tree keeps them (in both fixtures, for the
    // byte-equal comparison below).
    for (const f of [clean, planted]) {
      put(join(f.app, '.next', 'standalone', 'node_modules', 'traced-only', '.env.production'), 'PKG_DEFAULT=1\n');
      put(join(f.deploy, 'node-pty', 'docker-compose.yaml'), 'services: {}\n');
    }
    const outClean = join(root, 'out-clean');
    const outPlanted = join(root, 'out-planted');
    assembleStandaloneRuntime({ app: clean.app, deployModules: clean.deploy, buildReport: clean.report, out: outClean });
    assembleStandaloneRuntime({ app: planted.app, deployModules: planted.deploy, buildReport: planted.report, out: outPlanted });
    const digest = treeDigest(outPlanted);
    const hostSide = digest.split('\n').filter((line) => !/^[FDL] node_modules\//.test(line)).join('\n');
    expect(hostSide).not.toMatch(/(^[FDL] |\/)(\.env(\.[^ /]*)?|docker-compose[^ /]*\.ya?ml) /m);
    expect(readFileSync(join(outPlanted, 'node_modules', 'traced-only', '.env.production'), 'utf-8')).toBe('PKG_DEFAULT=1\n');
    expect(readFileSync(join(outPlanted, 'node_modules', 'node-pty', 'docker-compose.yaml'), 'utf-8')).toBe('services: {}\n');
    // PAIRED CONTROL: everything else arrived — the planted tree equals the clean one, entry for entry.
    expect(digest).toBe(treeDigest(outClean));
    // And the comparison can see one: a planted file in the OUTPUT is a difference.
    put(join(outPlanted, '_runtime', '.env'), 'x');
    expect(treeDigest(outPlanted)).not.toBe(treeDigest(outClean));
    for (const name of ['.env', '.env.local', '.env.example', 'docker-compose.yml', 'docker-compose.override.yml', 'docker-compose.dev.yaml']) expect(isMachineLocalFile(name), name).toBe(true);
    for (const name of ['env', '.envrc', 'x.env', 'docker-compose.ts', 'compose.yml', '.environment']) expect(isMachineLocalFile(name), name).toBe(false);
  });

  it('carries every untraced host path the image runner copied', () => {
    expect(UNTRACED_HOST_PATHS).toEqual([
      'skills', 'bin', 'scripts/cli', 'scripts/upgrade.mts', 'scripts/checkpoint.mts',
      'scripts/setup/detect.mts', 'scripts/setup/envFile.mts', 'scripts/setup/ownerCheck.mts', 'scripts/upgrades',
    ]);
  });

  it('leaves build-only content out — a host folder\'s tests, Next\'s compiler binary — and keeps a dependency\'s own tests and the runtime oxide', () => {
    const root = sandbox();
    const input = fixture(root);
    put(join(input.app, 'scripts', 'upgrades', '__tests__', 'a.test.mts'), '// a test\n');
    put(join(input.deploy, '@next', 'swc-linux-x64-gnu', 'next-swc.linux-x64-gnu.node'), 'compiler\n');
    put(join(input.deploy, '@next', 'env', 'index.js'), 'module.exports = {};\n');
    put(join(input.deploy, '@tailwindcss', 'oxide-linux-x64-gnu', 'tailwindcss-oxide.node'), 'oxide\n');
    put(join(input.deploy, 'some-dep', '__tests__', 'own.js'), 'dep test\n');
    const out = join(root, 'out');
    assembleStandaloneRuntime({ app: input.app, deployModules: input.deploy, buildReport: null, out });
    const digest = treeDigest(out);
    expect(digest).not.toMatch(/scripts\/upgrades\/__tests__/);
    expect(digest).not.toMatch(/@next\/swc-/);
    // Paired controls: the rest of each folder arrived.
    expect(digest).toMatch(/F scripts\/upgrades\/a\.mts /);
    expect(digest).toMatch(/F node_modules\/@next\/env\/index\.js /);
    expect(digest).toMatch(/F node_modules\/@tailwindcss\/oxide-linux-x64-gnu\/tailwindcss-oxide\.node /);
    expect(digest).toMatch(/F node_modules\/some-dep\/__tests__\/own\.js /);
    expect(isBuildOnlyPath('scripts/upgrades/__tests__/x.test.mts', true)).toBe(true);
    expect(isBuildOnlyPath('@next/swc-win32-x64-msvc/next-swc.node', false)).toBe(true);
    expect(isBuildOnlyPath('@next/swc-helpers/index.js', false)).toBe(true);
    expect(isBuildOnlyPath('@next/env/index.js', false)).toBe(false);
    expect(isBuildOnlyPath('scripts/upgrades/a.mts', true)).toBe(false);
  });

  it('refuses a tree whose longest path would pass MAX_PATH under a Windows install folder; the fixture fits', () => {
    const root = sandbox();
    const input = fixture(root);
    const out = join(root, 'out');
    assembleStandaloneRuntime({ app: input.app, deployModules: input.deploy, buildReport: null, out });
    expect(assertWindowsPathBudget(out).longest + WINDOWS_INSTALL_PREFIX).toBeLessThanOrEqual(WINDOWS_MAX_PATH);
    const budget = WINDOWS_MAX_PATH - WINDOWS_INSTALL_PREFIX;
    const prefix = 'node_modules/deep/';
    put(join(out, prefix, 'x'.repeat(budget - prefix.length)), 'fits\n');
    expect(assertWindowsPathBudget(out).longest).toBe(budget);
    put(join(out, prefix, 'y'.repeat(budget - prefix.length + 1)), 'one too many\n');
    expect(() => assertWindowsPathBudget(out)).toThrow(/passes MAX_PATH \(259\)/);
  });

  it('node-pty: its compiled build/Release OR its own prebuilds for this platform; neither is a refusal', () => {
    expect(requiredNativeArtifacts('linux', 'x64')['node-pty']).toEqual([['build/Release/pty.node'], ['prebuilds/linux-x64/pty.node']]);
    expect(requiredNativeArtifacts('darwin', 'arm64')['node-pty']![1]).toEqual(['prebuilds/darwin-arm64/pty.node', 'prebuilds/darwin-arm64/spawn-helper']);
    expect(requiredNativeArtifacts('win32', 'x64')['node-pty']![1]).toEqual([
      'prebuilds/win32-x64/pty.node', 'prebuilds/win32-x64/conpty.node', 'prebuilds/win32-x64/conpty_console_list.node',
      'prebuilds/win32-x64/winpty-agent.exe', 'prebuilds/win32-x64/winpty.dll',
    ]);
    const root = sandbox();
    const input = fixture(root);
    rmSync(join(input.deploy, 'node-pty', 'build'), { recursive: true });
    put(join(input.deploy, 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'pty.node'), 'prebuilt\n');
    if (process.platform === 'darwin') put(join(input.deploy, 'node-pty', 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'), 'helper\n');
    const ok = spawnSync(process.execPath, [SCRIPT, '--app', input.app, '--deploy-modules', input.deploy, '--out', join(root, 'prebuilt')], { encoding: 'utf-8' });
    expect(ok.status, ok.stderr).toBe(0);
    // Paired control: another platform's prebuilds are not this one's.
    rmSync(join(input.deploy, 'node-pty', 'prebuilds'), { recursive: true });
    put(join(input.deploy, 'node-pty', 'prebuilds', 'sunos-sparc', 'pty.node'), 'foreign\n');
    const refused = spawnSync(process.execPath, [SCRIPT, '--app', input.app, '--deploy-modules', input.deploy, '--out', join(root, 'foreign')], { encoding: 'utf-8' });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(new RegExp(`nor is prebuilds/${process.platform}-${process.arch}/pty\\.node`));
  });
});
