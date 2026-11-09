/**
 * The ONE `neuralis` command registry: the verbs it dispatches, the verbs it
 * reserves for a later release, the boundary that turns a thrown refusal into
 * an exit code, and the two spellings (the bin and the monorepo's
 * `pnpm neuralis:<verb>` aliases) that both enter it.
 *
 * A later release adds remote and device verbs to this same registry, so the
 * two lists are pinned as a contract: an ops verb can never squat a reserved
 * name silently, and a script can never keep a second dispatch path that
 * skips the resolvers and the boundary.
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CLIENT_VERBS, CliExit, MOVED_VERBS, OPS_COMMANDS, RESERVED_VERBS, composeRunArgs, dispatch, exitCodeFor, imageRoute, upgradeDeviceBinds, type CliContext } from '../cli/registry.mts';
import { existsSync, statSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(HERE, '..');
const hostRoot = join(scriptsDir, '..');

function context(): CliContext & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    packageDir: hostRoot,
    get installDir(): string { throw new CliExit(1, 'not inside a Neuralis install folder (test)'); },
    cwd: hostRoot,
    env: {},
    stdin: process.stdin,
    stdout: (t) => { out.push(t); },
    stderr: (t) => { err.push(t); },
    out,
    err,
  };
}

const OPS = ['setup', 'rebuild', 'sync', 'update', 'upgrade', 'mount', 'pkg', 'user', 'checkpoint', 'backup', 'restore', 'qdrant-upgrade', 'reset-vector', 'convert', 'up', 'down', 'status', 'start', 'tunnel'];
const CLIENT = ['login', 'logout', 'whoami', 'request', 'skill', 'package', 'device', 'mcp', 'plugin', 'launch'];
const RESERVED = ['fs', 'agent', 'workflow', 'shells', 'git', 'source', 'connect'];

describe('the verbs', () => {
  it('dispatches exactly the operator verbs, names the client\'s and reserves exactly the later ones — three disjoint lists', () => {
    expect(OPS_COMMANDS.map((m) => m.name)).toEqual(OPS);
    expect([...CLIENT_VERBS]).toEqual(CLIENT);
    expect([...RESERVED_VERBS]).toEqual(RESERVED);
    expect([...OPS, ...CLIENT, ...RESERVED].length).toBe(new Set([...OPS, ...CLIENT, ...RESERVED]).size);
  });

  it('a client verb (`package`, `device`, `login` …) answers that the Neuralis client runs it — never "a later release"', async () => {
    for (const verb of CLIENT) {
      const ctx = context();
      expect(await dispatch([verb], ctx)).toBe(1);
      expect(ctx.err.join('')).toContain(`"${verb}" is a command of the Neuralis client`);
      expect(ctx.err.join('')).toContain('npm install -g @neuralis/cli');
      expect(ctx.err.join('')).not.toContain('later release');
    }
  });

  it('a reserved verb answers by name with the error exit, never "unknown"', async () => {
    for (const verb of RESERVED) {
      const ctx = context();
      expect(await dispatch([verb], ctx)).toBe(1);
      expect(ctx.err.join('')).toContain(`"${verb}" is reserved for a later release`);
    }
  });

  it('a moved verb answers where the work lives now — text only, no module loads', async () => {
    const ctx = context();
    expect(await dispatch(['host-broker', 'status'], ctx)).toBe(1);
    const text = ctx.err.join('');
    expect(text).toContain('"host-broker" moved to `neuralis device` (@neuralis/cli)');
    for (const step of ['npm install -g @neuralis/cli', 'neuralis device pair', 'neuralis device install', 'neuralis device status', 'neuralis device grant', 'neuralis device run']) expect(text).toContain(step);
    expect(OPS_COMMANDS.map((m) => m.name)).not.toContain('host-broker');
    expect(readFileSync(join(scriptsDir, 'cli', 'registry.mts'), 'utf-8')).not.toMatch(/host-broker\.mts/);
  });

  it('control: an unknown verb is "unknown", help lists every verb and exits 0', async () => {
    const unknown = context();
    expect(await dispatch(['frobnicate'], unknown)).toBe(1);
    expect(unknown.err.join('')).toContain('unknown command "frobnicate"');
    const help = context();
    expect(await dispatch(['--help'], help)).toBe(0);
    for (const verb of OPS) expect(help.out.join('')).toContain(`  ${verb}`);
  });

  it('every verb module loads with no side effect at import and exports the run the adapter calls', async () => {
    const registry = readFileSync(join(scriptsDir, 'cli', 'registry.mts'), 'utf-8');
    const targets = [...new Set([...registry.matchAll(/import\('(\.\.\/[a-z-]+\.mts)'\)/g)].map((m) => m[1]!))];
    expect(targets.length).toBe(16); // `backup.mts` serves backup and restore; `up.mts` serves up, down and status
    for (const target of targets) {
      const mod = (await import(join(scriptsDir, 'cli', target))) as { run?: unknown };
      expect(typeof mod.run, target).toBe('function');
    }
  }, 30_000); // a cold transform of every verb's module graph: ~5 s on a loaded runner, not a performance bound
});

describe('the one error → exit boundary', () => {
  it('a CliExit prints its message and every detail line and returns its code; any other error is 1', async () => {
    const ctx = context();
    expect(exitCodeFor(new CliExit(4, 'restart refused', ['two detached shells', 'wait, or --force']), ctx)).toBe(4);
    expect(ctx.err.join('')).toMatch(/✗ restart refused\n {4}two detached shells\n {4}wait, or --force/);
    expect(exitCodeFor(new Error('boom'), ctx)).toBe(1);
    // The lazy install folder: a verb that reads it outside one gets the refusal through the boundary.
    const outside = context();
    expect(await dispatch(['checkpoint', 'list'], outside)).toBe(1);
    expect(outside.err.join('')).toContain('not inside a Neuralis install folder');
  });
});

describe('one dispatch path', () => {
  it('no verb script runs itself: every module is entered through the registry', () => {
    const selfRun: string[] = [];
    for (const name of readdirSync(scriptsDir).filter((n) => n.endsWith('.mts'))) {
      const source = readFileSync(join(scriptsDir, name), 'utf-8');
      // `release-version.mts` is a dev-only root script, not a verb.
      if (name === 'release-version.mts') continue;
      if (/process\.argv\[1\]|^main\(\)|^await handler\(\)|process\.argv\.slice\(2\)/m.test(source)) selfRun.push(name);
    }
    expect(selfRun).toEqual([]);
  });

  it('the monorepo aliases are `registry.mts <verb>` and nothing else; the bin is the package bin', () => {
    const manifest = JSON.parse(readFileSync(join(hostRoot, 'package.json'), 'utf-8')) as { bin: Record<string, string>; scripts: Record<string, string>; files: string[] };
    expect(manifest.bin).toEqual({ neuralis: 'bin/neuralis.mjs' });
    expect(manifest.files).toContain('bin');
    const aliases = Object.entries(manifest.scripts).filter(([name]) => name.startsWith('neuralis:') || name === 'reset:vector');
    expect(aliases.length).toBe(15);
    for (const [name, command] of aliases) {
      const verb = /^node --import tsx scripts\/cli\/registry\.mts ([a-z-]+)$/.exec(command)?.[1];
      expect(verb, `${name}: ${command}`).toBeDefined();
      // A moved verb's alias still enters the registry, which answers where the work lives now.
      expect([...OPS, ...Object.keys(MOVED_VERBS)], name).toContain(verb);
    }
    expect(Object.values(manifest.scripts).filter((c) => /scripts\/(?!cli\/|build\/|release-version|mcp-http)[a-z-]+\.mts/.test(c))).toEqual([]);
  });

  it('the bin reaches the same registry: a reserved verb through `bin/neuralis.mjs` exits 1 by name', () => {
    const res = spawnSync(process.execPath, [join(hostRoot, 'bin', 'neuralis.mjs'), 'fs'], { encoding: 'utf8', cwd: hostRoot });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('"fs" is reserved for a later release');
  });

  it('under node_modules (an npm install folder) the bin resolves the host `@/` alias for import and require alike; without its hook tsx does not', () => {
    // A host-shaped package at `<folder>/node_modules/neuralis`: the REAL bin and
    // tsconfig, a registry stand-in that imports `@/lib/a` (ESM), and `src/lib/a.ts`
    // that imports `@/b` (a CommonJS require of a directory index). tsx applies
    // tsconfig `paths` to no file under node_modules — the paired run shows it.
    const folder = mkdtempSync(join(tmpdir(), 'neuralis-bin-alias-'));
    try {
      const pkg = join(folder, 'node_modules', 'neuralis');
      for (const dir of ['bin', 'scripts/cli', 'src/lib', 'src/b', 'node_modules/dep']) mkdirSync(join(pkg, dir), { recursive: true });
      symlinkSync(realpathSync(join(hostRoot, 'node_modules', 'tsx')), join(folder, 'node_modules', 'tsx'));
      copyFileSync(join(hostRoot, 'tsconfig.json'), join(pkg, 'tsconfig.json'));
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'neuralis', version: '0.0.0', bin: { neuralis: 'bin/neuralis.mjs' } }));
      writeFileSync(join(folder, 'package.json'), JSON.stringify({ private: true, dependencies: { neuralis: '0.0.0' } }));
      writeFileSync(join(pkg, 'scripts/cli/registry.mts'), "import { a } from '@/lib/a';\nexport async function main(): Promise<number> { console.log(a); return 0; }\n");
      writeFileSync(join(pkg, 'src/lib/a.ts'), "import { b } from '@/b';\nexport const a = `a+${b}`;\n");
      writeFileSync(join(pkg, 'src/b/index.ts'), "export const b = 'b';\n");
      const bin = readFileSync(join(hostRoot, 'bin', 'neuralis.mjs'), 'utf-8');
      writeFileSync(join(pkg, 'bin', 'neuralis.mjs'), bin);
      const ok = spawnSync(process.execPath, [join(pkg, 'bin', 'neuralis.mjs')], { encoding: 'utf8', cwd: folder });
      expect(ok.stderr).toBe('');
      expect(ok.stdout.trim()).toBe('a+b');
      expect(ok.status).toBe(0);

      // A dependency of the host never has its `@/` rewritten: it keeps the bare specifier and fails as such.
      writeFileSync(join(pkg, 'node_modules/dep/package.json'), JSON.stringify({ name: 'dep', version: '0.0.0', main: 'index.js' }));
      writeFileSync(join(pkg, 'node_modules/dep/index.js'), "module.exports = require('@/b');\n");
      writeFileSync(join(pkg, 'scripts/cli/registry.mts'), "import dep from 'dep';\nexport async function main(): Promise<number> { console.log(dep); return 0; }\n");
      const foreign = spawnSync(process.execPath, [join(pkg, 'bin', 'neuralis.mjs')], { encoding: 'utf8', cwd: folder });
      expect(foreign.status).not.toBe(0);
      expect(foreign.stderr).toContain("Cannot find module '@/b'");

      const hook = /\nnodeModule\.registerHooks\(\{[\s\S]*?\n\}\);\n/;
      expect(bin).toMatch(hook);
      writeFileSync(join(pkg, 'scripts/cli/registry.mts'), "import { a } from '@/lib/a';\nexport async function main(): Promise<number> { console.log(a); return 0; }\n");
      writeFileSync(join(pkg, 'bin', 'neuralis.mjs'), bin.replace(hook, '\n'));
      const bare = spawnSync(process.execPath, [join(pkg, 'bin', 'neuralis.mjs')], { encoding: 'utf8', cwd: folder });
      expect(bare.status).not.toBe(0);
      expect(bare.stderr).toMatch(/Cannot find package '@\/lib' imported from \S+node_modules\/neuralis\/scripts\/cli\/registry\.mts/);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('the bin and both packages agree on one Node floor, and the bin refuses below it by name', () => {
    const bin = readFileSync(join(hostRoot, 'bin', 'neuralis.mjs'), 'utf-8');
    const floor = Number(/const NODE_MAJOR_FLOOR = (\d+);/.exec(bin)?.[1]);
    expect(floor).toBe(26);
    expect(bin).toContain('Neuralis needs Node.js ${NODE_MAJOR_FLOOR} or newer (found ${process.versions.node})');
    for (const manifest of [join(hostRoot, 'package.json'), join(hostRoot, '..', 'create-neuralis', 'package.json')]) {
      expect((JSON.parse(readFileSync(manifest, 'utf-8')) as { engines?: { node?: string } }).engines?.node, manifest).toBe(`>=${floor}`);
    }
    expect(readFileSync(join(hostRoot, '..', 'create-neuralis', 'index.mjs'), 'utf-8')).toContain(`const NODE_MAJOR_FLOOR = ${floor};`);
    // A clone's `npm install` refuses before it resolves or writes anything.
    expect((JSON.parse(readFileSync(join(hostRoot, 'package.json'), 'utf-8')) as { devEngines?: unknown }).devEngines).toEqual({ runtime: { name: 'node', version: `>=${floor}`, onFail: 'error' } });
  });

  it('both Node-floor refusals name the installation help anchor and the issue form', () => {
    const scaffolder = readFileSync(join(hostRoot, '..', 'create-neuralis', 'index.mjs'), 'utf-8');
    for (const text of [readFileSync(join(hostRoot, 'bin', 'neuralis.mjs'), 'utf-8'), scaffolder]) {
      expect(text).toContain("'https://docs.neuralisapp.com/getting-started/installation#if-something-fails'");
      expect(text).toContain('https://github.com/neuralisapp/neuralis/issues/new');
    }
    expect(scaffolder).toMatch(/fail\(`Neuralis needs Node\.js [^\n]*\$\{HELP_LINE\}`\)/);
  });
});

describe('the image gate — one field on each verb row', () => {
  const folder = mkdtempSync(join(tmpdir(), 'neuralis-image-gate-'));
  writeFileSync(join(folder, 'docker-compose.yml'), '# GENERATED by neuralis setup (2026-10-19, neuralis 0.3.2) — do not hand-edit.\n');
  writeFileSync(join(folder, '.env'), 'NEURALIS_IMAGE_TAG=0.3.2\n');
  const at = (installDir: string, env: Record<string, string> = {}): CliContext => ({ packageDir: hostRoot, installDir, cwd: installDir, env, stdin: process.stdin, stdout: () => {}, stderr: () => {} });
  const route = (verb: string, argv: string[], ctx: CliContext) => imageRoute(OPS_COMMANDS.find((m) => m.name === verb)!, argv, ctx);
  const INSIDE = { NEURALIS_DOCKER: 'true', NEURALIS_HOME: '/.neuralis', NEURALIS_HOST_HOME: '/home/op/.neuralis' };

  it('every verb row declares how it runs on an image-only folder', () => {
    for (const command of OPS_COMMANDS) expect(command.image?.onImage, command.name).toBeDefined();
  });

  it('build, sync, register and convert refuse by name — with what to do instead, never promising a verb that exists today', () => {
    for (const verb of ['rebuild', 'sync', 'pkg', 'convert']) {
      let refusal: unknown = null;
      try { route(verb, [], at(folder)); } catch (error) { refusal = error; }
      expect((refusal as CliExit).message, verb).toBe(`"${verb}" does not run on an image-only install folder`);
    }
    let pkg: unknown = null;
    try { route('pkg', ['add', 'x'], at(folder, INSIDE)); } catch (error) { pkg = error; }
    const detail = (pkg as CliExit).detail.join('\n');
    expect(detail).toContain('`neuralis package install <name>`');
    expect(detail).not.toContain('later release');
    expect(detail).toContain('`docker compose up -d -V`');
    expect(detail).toContain('`neuralis update --apply`');
  });

  it('on the host every other verb is handed to a container of the folder\'s image; backup and restore bind the home\'s parent', () => {
    for (const verb of ['setup', 'update', 'upgrade', 'mount', 'user', 'checkpoint', 'qdrant-upgrade', 'reset-vector']) {
      expect(route(verb, ['list'], at(folder)), verb).toEqual({ run: 'handoff', homeParent: false });
    }
    expect(route('backup', [], at(folder))).toEqual({ run: 'handoff', homeParent: true });
    expect(route('restore', ['/b'], at(folder))).toEqual({ run: 'handoff', homeParent: true });
  });

  it('inside the one-shot: oneshot verbs run here, compose verbs as the app service, checkpoint by its subcommand', () => {
    for (const verb of ['setup', 'update', 'mount', 'qdrant-upgrade']) expect(route(verb, [], at(folder, INSIDE)), verb).toEqual({ run: 'here' });
    for (const verb of ['upgrade', 'user', 'reset-vector']) expect(route(verb, [], at(folder, INSIDE)), verb).toEqual({ run: 'compose' });
    expect(route('checkpoint', ['list'], at(folder, INSIDE))).toEqual({ run: 'here' });
    expect(route('checkpoint', ['restore', 'cp-1'], at(folder, INSIDE))).toEqual({ run: 'compose' });
    // backup needs the home at its host path: handed on once more unless it already is.
    expect(route('backup', [], at(folder, INSIDE))).toEqual({ run: 'handoff', homeParent: true });
    expect(route('backup', [], at(folder, { ...INSIDE, NEURALIS_HOME: '/home/op/.neuralis' }))).toEqual({ run: 'here' });
  });

  it('PAIRED CONTROL — any other install, or none, runs every verb here', () => {
    for (const verb of OPS) {
      expect(route(verb, [], at(hostRoot, INSIDE)), verb).toEqual({ run: 'here' });
      expect(route(verb, [], context()), verb).toEqual({ run: 'here' });
    }
  });

  it('a compose verb runs as the app service: -T without a terminal, the operator\'s name passed on', () => {
    expect(composeRunArgs({ project: 'p', app: 'neuralis' }, 'user', ['list'], { tty: false, operator: 'op' })).toEqual(['compose', '-p', 'p', 'run', '--rm', '--no-deps', '-T', '-e', 'NEURALIS_OPERATOR=op', 'neuralis', 'node', 'bin/neuralis.mjs', 'user', 'list']);
    expect(composeRunArgs({ project: 'p', app: 'web' }, 'upgrade', ['--apply'], { tty: true, operator: undefined })).toEqual(['compose', '-p', 'p', 'run', '--rm', '--no-deps', 'web', 'node', 'bin/neuralis.mjs', 'upgrade', '--apply']);
    expect(composeRunArgs({ project: 'p', app: 'web' }, 'upgrade', ['--apply'], { tty: false, operator: undefined, binds: ['-v', '/h/device:/.neuralis/device'] })).toEqual(['compose', '-p', 'p', 'run', '--rm', '--no-deps', '-T', '-v', '/h/device:/.neuralis/device', 'web', 'node', 'bin/neuralis.mjs', 'upgrade', '--apply']);
  });

  it('an upgrade run of the app service binds the broker secret (read-only) and the WHOLE device folder, at their HOST paths', () => {
    const inside = { NEURALIS_DOCKER: 'true', NEURALIS_HOST_HOME: '/srv/op/.neuralis' };
    const home = mkdtempSync(join(tmpdir(), 'nrs-upgrade-binds-'));
    try {
      // Nothing there: nothing bound, and no folder made (Docker would make it root-owned).
      expect(upgradeDeviceBinds(inside, home)).toEqual([]);
      expect(existsSync(join(home, 'device'))).toBe(false);
      // A broker secret: the device folder is made (0700) so the identity the upgrade writes lands on the host.
      mkdirSync(join(home, 'host-broker'));
      expect(upgradeDeviceBinds(inside, home)).toEqual([
        '-v', '/srv/op/.neuralis/host-broker:/.neuralis/host-broker:ro',
        '-v', '/srv/op/.neuralis/device:/.neuralis/device',
      ]);
      expect(statSync(join(home, 'device')).mode & 0o777).toBe(0o700);
      // A device folder alone (the per-host identities live below it): bound whole.
      rmSync(join(home, 'host-broker'), { recursive: true });
      expect(upgradeDeviceBinds(inside, home)).toEqual(['-v', '/srv/op/.neuralis/device:/.neuralis/device']);
      // Outside the one-shot container, or with no host path: nothing.
      expect(upgradeDeviceBinds({}, home)).toEqual([]);
      expect(upgradeDeviceBinds({ NEURALIS_DOCKER: 'true' }, home)).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('--install names the install from anywhere, before or after the verb', () => {
  it('the host bin takes it off the command line in either position', () => {
    const home = mkdtempSync(join(tmpdir(), 'neuralis-install-flag-home-'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'neuralis-install-flag-cwd-'));
    for (const argv of [['--install', hostRoot, 'checkpoint', 'list'], ['checkpoint', 'list', '--install', hostRoot]]) {
      const res = spawnSync(process.execPath, ['--import', pathToFileURL(join(hostRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href, join(scriptsDir, 'cli', 'registry.mts'), ...argv], { cwd: elsewhere, encoding: 'utf-8', env: { ...process.env, NEURALIS_HOME: home } });
      expect(res.status, `${argv.join(' ')}: ${res.stdout}${res.stderr}`).toBe(0);
      expect(res.stdout).toContain('No checkpoints under');
    }
    // PAIRED CONTROL: without it, from there, the refusal names the flag.
    const lost = spawnSync(process.execPath, ['--import', pathToFileURL(join(hostRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href, join(scriptsDir, 'cli', 'registry.mts'), 'checkpoint', 'list'], { cwd: elsewhere, encoding: 'utf-8', env: { ...process.env, NEURALIS_HOME: home } });
    expect(lost.status).toBe(1);
    expect(lost.stderr).toContain('--install <folder>');
  }, 60_000);
});
