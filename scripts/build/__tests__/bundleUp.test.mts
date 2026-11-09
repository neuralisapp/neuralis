/**
 * `up` precompiled: the desktop app's resident supervisor runs the registry and
 * `up` as ONE ES module, never through tsx. Proven on a throwaway native tree
 * whose `node_modules` holds only the packages the bundle imports — no tsx —
 * so the supervisor verbs answer while a TypeScript verb on the same tree is
 * refused by the bin (the paired control).
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { bundleUp, UP_BUNDLE } from '../bundle-up.mjs';

const HOST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function link(target: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(realpathSync(target), path, 'junction');
}

/** A native host tree: the bin, its manifest, the marker, the `.mjs` helpers the bundle imports, and only the bundle's packages. */
function nativeTree(): string {
  const tree = mkdtempSync(join(tmpdir(), 'nrs-up-bundle-'));
  roots.push(tree);
  mkdirSync(join(tree, 'bin'));
  copyFileSync(join(HOST, 'bin', 'neuralis.mjs'), join(tree, 'bin', 'neuralis.mjs'));
  copyFileSync(join(HOST, 'package.json'), join(tree, 'package.json'));
  writeFileSync(join(tree, '.neuralis-native'), '');
  link(join(HOST, 'scripts', 'build'), join(tree, 'scripts', 'build'));
  for (const name of ['@neuralis/package-system', 'bcryptjs']) link(join(HOST, 'node_modules', name), join(tree, 'node_modules', name));
  return tree;
}

describe('bundle-up — the resident supervisor without tsx', () => {
  it('bundles the registry with `up` alone: no server module, no other verb, every package and .mjs helper external', async () => {
    const tree = nativeTree();
    const bytes = await bundleUp(HOST, tree);
    const text = readFileSync(join(tree, UP_BUNDLE), 'utf-8');
    expect(bytes).toBe(Buffer.byteLength(text));
    expect(bytes).toBeLessThan(250_000);
    // The `up` module and the registry's boundary are inside; builtin discovery and the user verb are not.
    expect(text).toContain('function exitCodeFor');
    expect(text).toContain('"--no-stdin"');
    expect(text).not.toContain('selectBuiltinPackageIds');
    expect(text).toContain('import("../user.mts")');
    expect(text).toContain('from "../build/build-workspace.mjs"');
    // Every package import stays a package import (resolved from the tree's node_modules).
    const packages = [...text.matchAll(/from "([^".][^"]*)"/g)].map((m) => m[1]!).filter((s) => !s.startsWith('node:'));
    expect(new Set(packages)).toEqual(new Set(['@neuralis/package-system/paths', '@neuralis/package-system/data', 'bcryptjs']));
  }, 60_000);

  it('on the native tree `status` answers from the bundle; PAIRED CONTROL: a TypeScript verb there needs tsx and is refused', async () => {
    const tree = nativeTree();
    await bundleUp(HOST, tree);
    const home = mkdtempSync(join(tmpdir(), 'nrs-up-home-'));
    roots.push(home);
    const run = (args: string[]) => spawnSync(process.execPath, [join(tree, 'bin', 'neuralis.mjs'), ...args], { cwd: home, encoding: 'utf-8', env: { ...process.env, NEURALIS_HOME: home }, timeout: 60_000 });
    const status = run(['status', '--json']);
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ state: 'stopped', home });
    const control = run(['user', 'list']);
    expect(control.status).toBe(1);
    expect(control.stderr).toContain('dependencies are not installed');
  }, 60_000);

  it('a native tree without the bundle refuses `up` by name — never a bare module error, never the tsx lane', () => {
    const tree = nativeTree();
    const home = mkdtempSync(join(tmpdir(), 'nrs-up-home-'));
    roots.push(home);
    const res = spawnSync(process.execPath, [join(tree, 'bin', 'neuralis.mjs'), 'status', '--json'], { cwd: home, encoding: 'utf-8', env: { ...process.env, NEURALIS_HOME: home }, timeout: 60_000 });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('no precompiled supervisor');
    expect(res.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(res.stderr).not.toContain('dependencies are not installed');
  }, 60_000);

  it('refuses a tree that does not carry a helper the bundle imports', async () => {
    const tree = mkdtempSync(join(tmpdir(), 'nrs-up-bare-'));
    roots.push(tree);
    await expect(bundleUp(HOST, tree)).rejects.toThrow(/build-workspace\.mjs, which the tree does not carry/);
  }, 60_000);
});
