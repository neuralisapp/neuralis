/**
 * Resolution guard over `neuralis/scripts/**` and the one CLI entry.
 *
 * These scripts have NO type gate of their own: the host `tsconfig.json`
 * include pattern is `**\/*.ts`, which does not match `.mts` or `.mjs`, so
 * "tsc is clean" says nothing about them. They are also the files most exposed
 * to a silent break, because several of them reach ACROSS the script/host
 * boundary (`../src/server/...`).
 *
 * Three properties are pinned:
 *   (a) every relative specifier in every script resolves to a real file;
 *   (b) the two folder resolvers are the ONLY place a folder is derived:
 *       `packageDir` (the code, from the registry's own location) and
 *       `installDir` (the deployment, walked up from the working directory).
 *       No operator module computes a root from its own location — on an npm
 *       install folder the code lives in `node_modules/neuralis`, so a
 *       script-relative `..` would land on the package, never on the folder
 *       that holds `.env` and the compose files;
 *   (c) the walk lands where each channel keeps its deployment — and refuses,
 *       by name, where there is none.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// `resolve` NORMALISES: `fileURLToPath(new URL('..'))` yields a trailing
// separator and `resolve()` never does, so an unnormalised `startsWith` compares
// `/x/scripts` against `/x/scripts/` and is false for the directory itself —
// which silently disabled the move check below until a mutation exposed it.
const scriptsDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const hostRoot = resolve(scriptsDir, '..');

/** Every script under `scripts/`, excluding this test folder. */
function collectScripts(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectScripts(full));
    else if (/\.(mts|mjs|ts)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Every operator script plus the one CLI entry that imports the registry. */
const scripts = [...collectScripts(scriptsDir), join(hostRoot, 'bin', 'neuralis.mjs')];

/** `from './x'`, `import('./x')` — relative specifiers only. */
function relativeSpecifiers(source: string): string[] {
  const matches = source.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g);
  return [...new Set([...matches].map((m) => m[1]!))];
}

function resolvesToAFile(fromFile: string, specifier: string): boolean {
  const base = resolve(dirname(fromFile), specifier);
  return [base, `${base}.ts`, `${base}.mts`, `${base}.mjs`, `${base}.js`, join(base, 'index.ts')].some(
    existsSync,
  );
}

describe('neuralis/scripts resolution guard', () => {
  it('type-checks — `tsconfig.scripts.json` is clean', () => {
    // Run FROM the suite, not from a separate npm script nobody remembers. The
    // gate exists because the host tsconfig's `**/*.ts` matches neither `.mts`
    // nor `.mjs`, so these files were checked by nothing; a gate that is itself
    // opt-in reproduces that failure one level up. It immediately paid for
    // itself twice: a parameter rename left a dangling identifier inside a
    // rarely-taken refusal branch (a ReferenceError where a friendly message
    // belonged), and a `Promise<typeof x>` on a null-initialised variable typed
    // the entire host-broker status readout as `never`.
    const result = spawnSync('npx', ['tsc', '-p', 'tsconfig.scripts.json'], {
      cwd: hostRoot,
      encoding: 'utf-8',
    });
    expect(`${result.stdout ?? ''}${result.stderr ?? ''}`.trim()).toBe('');
    expect(result.status).toBe(0);
  }, 180_000);

  it('finds the scripts to guard', () => {
    // A collector that silently returns nothing would make every assertion below
    // vacuously true — the failure mode this whole file exists to prevent.
    expect(scripts.length).toBeGreaterThan(10);
  });

  it('every relative specifier in every script resolves to a real file', () => {
    const broken: string[] = [];
    for (const file of scripts) {
      for (const specifier of relativeSpecifiers(readFileSync(file, 'utf-8'))) {
        if (!resolvesToAFile(file, specifier)) {
          broken.push(`${relative(hostRoot, file)} -> ${specifier}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('no operator module derives a folder from its own location — only the two resolvers do', () => {
    // Build tooling (`scripts/build/`) runs in the repository and CI, never as
    // an operator verb; the offline upgrade modules (`scripts/upgrades/`) take
    // their roots from the upgrade context (the identity upgrade's own override
    // path is the one known exception, tracked as a ledger row).
    const allowed = new Map([
      ['bin/neuralis.mjs', 'registers tsx with the host tsconfig beside it'],
      ['scripts/cli/registry.mts', 'packageDir — the one code resolver'],
      ['scripts/upgrade.mts', 'UPGRADES_DIR — the modules beside this file, part of the code'],
      ['scripts/release-version.mts', 'a dev-only root script, not a verb: it edits the checkout it lives in'],
    ]);
    const offenders: string[] = [];
    for (const file of scripts) {
      const rel = relative(hostRoot, file);
      if (rel.startsWith(`scripts${sep}build${sep}`) || rel.startsWith(`scripts${sep}upgrades${sep}`) || allowed.has(rel)) continue;
      const source = readFileSync(file, 'utf-8');
      if (/import\.meta\.(dirname|filename)|fileURLToPath\(\s*import\.meta\.url/.test(source)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
    // The allowlist is not decoration: each entry still reads its location.
    for (const rel of allowed.keys()) expect(readFileSync(join(hostRoot, rel), 'utf-8')).toMatch(/import\.meta\.url/);
  });

  it('packageDir is the host package: its manifest names `neuralis` and carries the bin', async () => {
    const { createCliContext, PACKAGE_DIR } = await import('../cli/registry.mts');
    // The registry computes packageDir from its own location; the bin, the
    // monorepo aliases and the command spelling all read that one value.
    const registrySource = readFileSync(join(scriptsDir, 'cli', 'registry.mts'), 'utf-8');
    expect(registrySource).toContain("export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')");
    expect(registrySource).toContain('packageDir: PACKAGE_DIR,');
    expect(PACKAGE_DIR).toBe(hostRoot);
    const manifest = JSON.parse(readFileSync(join(hostRoot, 'package.json'), 'utf-8')) as { name?: string; bin?: Record<string, string>; dependencies?: Record<string, string> };
    expect(manifest.name).toBe('neuralis');
    expect(manifest.bin?.neuralis).toBe('bin/neuralis.mjs');
    expect(existsSync(join(hostRoot, manifest.bin!.neuralis!))).toBe(true);
    expect(manifest.dependencies?.next).toBeTruthy();
    const ctx = createCliContext({ packageDir: hostRoot, cwd: hostRoot, installFrom: hostRoot, env: {}, stdin: process.stdin, stdout: () => {}, stderr: () => {} });
    expect(ctx.installDir).toBe(hostRoot);
  });

  it('installDir walks up to the host package or a folder depending on it, and refuses by name elsewhere', async () => {
    const { resolveInstallDir, createCliContext, CliExit } = await import('../cli/registry.mts');
    // The development checkout: from inside `neuralis/` it is `neuralis/` itself.
    expect(resolveInstallDir(join(hostRoot, 'scripts', 'cli'))).toBe(hostRoot);
    // The ROOT workspace manifest is ALSO named `neuralis` but carries no bin —
    // it is not a deployment, and the walk must not stop there.
    expect(JSON.parse(readFileSync(join(hostRoot, '..', 'package.json'), 'utf-8')).name).toBe('neuralis');
    expect(() => resolveInstallDir(join(hostRoot, '..'))).toThrow(CliExit);

    // An npm install folder, entered from a subfolder.
    const folder = mkdtempSync(join(tmpdir(), 'neuralis-install-dir-'));
    writeFileSync(join(folder, 'package.json'), JSON.stringify({ private: true, dependencies: { neuralis: '0.2.0' } }));
    mkdirSync(join(folder, 'backups', 'today'), { recursive: true });
    expect(resolveInstallDir(join(folder, 'backups', 'today'))).toBe(folder);

    // Nowhere: the refusal names the rule.
    const nowhere = mkdtempSync(join(tmpdir(), 'neuralis-no-install-'));
    expect(() => resolveInstallDir(nowhere)).toThrow(/not inside a Neuralis install folder/);

    // LAZY: a context for a folder with no install builds fine and throws only on the read.
    const ctx = createCliContext({ packageDir: hostRoot, cwd: nowhere, installFrom: nowhere, env: {}, stdin: process.stdin, stdout: () => {}, stderr: () => {} });
    expect(ctx.cwd).toBe(nowhere);
    expect(() => ctx.installDir).toThrow(/not inside a Neuralis install folder/);
  });
});
