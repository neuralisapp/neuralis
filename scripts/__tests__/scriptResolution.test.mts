/**
 * Resolution guard over `neuralis/scripts/**`.
 *
 * These scripts have NO type gate: the host `tsconfig.json` include pattern is
 * `**\/*.ts`, which does not match `.mts` or `.mjs`, so "tsc is clean" says
 * nothing about them. They are also the files most exposed to a silent break,
 * because several of them reach ACROSS the script/host boundary
 * (`../src/server/...`) and every one of them computes the host root by counting
 * `..` from its own location. Moving a script one directory changes both, and
 * nothing anywhere would have failed.
 *
 * Two properties are pinned:
 *   (a) every relative specifier in every script resolves to a real file;
 *   (b) each script's own idea of the host root actually IS the host root —
 *       the `..`-arithmetic is checked against a marker, not against a count.
 *
 * (b) is the half that catches a MOVE. A script relocated one level deeper keeps
 * resolving its imports (they move with it) while silently addressing
 * `scripts/package.json` instead of the host's — which is how a `mount.mts` in
 * the wrong folder would happily write a second `docker-compose.yml` nobody
 * reads.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
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

const scripts = collectScripts(scriptsDir);

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

  it("every script's `..`-arithmetic lands on the host root, not somewhere above or below it", () => {
    // The host root is identified by a marker, never by a level count: its
    // package.json is named `neuralis` AND depends on `next`. The ROOT workspace
    // package.json is also named `neuralis`, so the name alone would match one
    // level too high — the `next` dependency is what disambiguates them.
    const manifest = JSON.parse(readFileSync(join(hostRoot, 'package.json'), 'utf-8')) as {
      name?: string;
      dependencies?: Record<string, string>;
    };
    expect(manifest.name).toBe('neuralis');
    expect(manifest.dependencies?.next).toBeTruthy();

    const wrong: string[] = [];
    for (const file of scripts) {
      const source = readFileSync(file, 'utf-8');
      // `join(here, '..')`, `resolve(HERE, '..')`, `join(import.meta.dirname, '..', …)`.
      // BOTH quote styles: the first cut of this matcher accepted only `'..'`,
      // and a mutation using `".."` walked straight past it — a guard that could
      // not see half the ways the defect is spelled.
      const hops = [
        ...source.matchAll(/(?:import\.meta\.dirname|\bhere\b)\s*,\s*((?:['"]\.\.['"]\s*,?\s*)+)/gi),
      ];
      for (const hop of hops) {
        const levels = (hop[1]!.match(/['"]\.\.['"]/g) ?? []).length;
        let target = dirname(file);
        for (let i = 0; i < levels; i += 1) target = resolve(target, '..');
        // Any script may address an ANCESTOR of the host root deliberately
        // (host-broker and sync both want the repo root); what must never happen
        // is landing INSIDE scripts/, which is what a move produces.
        if (target === scriptsDir || target.startsWith(scriptsDir + sep)) {
          wrong.push(`${relative(hostRoot, file)}: ${levels} × '..' lands in ${relative(hostRoot, target)}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});
