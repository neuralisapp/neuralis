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
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CliExit, OPS_COMMANDS, RESERVED_VERBS, dispatch, exitCodeFor, type CliContext } from '../cli/registry.mts';

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

const OPS = ['setup', 'rebuild', 'sync', 'update', 'upgrade', 'mount', 'pkg', 'user', 'checkpoint', 'backup', 'restore', 'qdrant-upgrade', 'reset-vector', 'host-broker', 'convert'];
const RESERVED = ['login', 'logout', 'whoami', 'device', 'mcp', 'plugin', 'skill', 'fs', 'agent', 'workflow', 'shells', 'git', 'source', 'connect', 'up', 'down', 'tunnel'];

describe('the verbs', () => {
  it('dispatches exactly the operator verbs and reserves exactly the later ones — two disjoint lists', () => {
    expect(OPS_COMMANDS.map((m) => m.name)).toEqual(OPS);
    expect([...RESERVED_VERBS]).toEqual(RESERVED);
    expect(OPS.filter((v) => RESERVED.includes(v))).toEqual([]);
  });

  it('a reserved verb answers by name with the error exit, never "unknown"', async () => {
    for (const verb of RESERVED) {
      const ctx = context();
      expect(await dispatch([verb], ctx)).toBe(1);
      expect(ctx.err.join('')).toContain(`"${verb}" is reserved for a later release`);
    }
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
    expect(targets.length).toBe(14); // `backup.mts` serves backup and restore
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
    expect(aliases.length).toBe(14);
    for (const [name, command] of aliases) {
      const verb = /^node --import tsx scripts\/cli\/registry\.mts ([a-z-]+)$/.exec(command)?.[1];
      expect(verb, `${name}: ${command}`).toBeDefined();
      expect(OPS, name).toContain(verb);
    }
    expect(Object.values(manifest.scripts).filter((c) => /scripts\/(?!cli\/|build\/|release-version|mcp-http)[a-z-]+\.mts/.test(c))).toEqual([]);
  });

  it('the bin reaches the same registry: a reserved verb through `bin/neuralis.mjs` exits 1 by name', () => {
    const res = spawnSync(process.execPath, [join(hostRoot, 'bin', 'neuralis.mjs'), 'login'], { encoding: 'utf8', cwd: hostRoot });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('"login" is reserved for a later release');
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
