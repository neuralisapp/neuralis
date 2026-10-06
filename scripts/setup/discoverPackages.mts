/**
 * The builtin-class dependency partition — ONE derivation, two consumers.
 *
 * `neuralis:sync` swaps a package a developer is editing into a running
 * container; `neuralis:update` pulls newer published versions. They need the
 * two HALVES of the same set, and they are exact complements:
 *
 *   syncable      — resolves to a directory here (workspace link or `file:`),
 *                   so there is source to rebuild → sync's targets; `local`
 *                   marks a `file:` folder, built in its own root
 *   registryOnly  — a published version with no source on this machine
 *                   → update's targets
 *
 * The rule matches the trust boundary the platform already uses: a dependency
 * of the host whose own manifest carries a `neuralis` block is builtin-class.
 * Keying on a `packages/` directory instead would be wrong for everyone but
 * this monorepo — on every published channel those packages arrive from a
 * registry, and what an operator actually has is their OWN first-party package
 * registered with `neuralis:pkg add`.
 *
 * A local-source spec (`file:`/`link:`) is classified on the SPEC, not on what
 * it resolves to — and that distinction is load-bearing. `pnpm neuralis:pkg add
 * --tarball` writes `file:/abs/x.tgz`, which is not a directory, so a
 * resolves-to-a-directory rule would drop it into `registryOnly` and hand it to
 * `update`, which would then replace a locally-vetted artifact with a registry
 * package installed at first-party trust — without the operator ever naming it.
 * So the partition has TWO classes — local source (`localSource`, a tarball
 * included: registry-shaped, but never updated) and registry — and a local
 * tarball is in neither tool's target set: sync cannot rebuild it, update must
 * never touch it; `pnpm neuralis:rebuild` installs it.
 */

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isLocalSourceSpec } from '../build/build-workspace.mjs';

export type SyncablePackage = { name: string; slug: string; dir: string; local: boolean };
export type RegistryOnlyPackage = { name: string; spec: string };
/** A `file:`/`link:` dep — operator-vetted, never an update target. */
export type LocalSourcePackage = { name: string; spec: string };

function readJson(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export function discoverBuiltinDeps(neuralisDir: string): {
  syncable: SyncablePackage[];
  registryOnly: RegistryOnlyPackage[];
  localSource: LocalSourcePackage[];
} {
  const hostManifest = readJson(join(neuralisDir, 'package.json'));
  const deps = (hostManifest?.dependencies ?? {}) as Record<string, string>;

  const syncable: SyncablePackage[] = [];
  const registryOnly: RegistryOnlyPackage[] = [];
  const localSource: LocalSourcePackage[] = [];

  for (const [name, spec] of Object.entries(deps)) {
    // Where the source would be, if there is any.
    let sourceDir: string | null = null;
    if (spec.startsWith('file:')) {
      const target = resolve(neuralisDir, spec.slice('file:'.length));
      // `file:` also addresses a packed tarball; only a directory can be rebuilt.
      if (existsSync(target) && statSync(target).isDirectory()) sourceDir = target;
    } else {
      const installed = join(neuralisDir, 'node_modules', name);
      // A workspace or link: dependency is a SYMLINK; a registry install is a
      // real directory. That distinction is exactly "is there source here".
      try {
        if (lstatSync(installed).isSymbolicLink()) sourceDir = realpathSync(installed);
      } catch {
        /* not installed — nothing to classify */
      }
    }

    const manifestPath = sourceDir
      ? join(sourceDir, 'package.json')
      : join(neuralisDir, 'node_modules', name, 'package.json');
    const manifest = readJson(manifestPath);
    if (!manifest?.neuralis) continue; // not builtin-class — not ours

    if (isLocalSourceSpec(spec)) {
      // Classified on the SPEC: a `file:` tarball resolves to no directory but
      // is still operator-vetted local state, and must never become an update
      // target. Sync still gets the directory form, which is what it can act on.
      localSource.push({ name, spec });
      if (sourceDir) {
        syncable.push({ name, slug: name.includes('/') ? name.split('/').pop()! : name, dir: sourceDir, local: true });
      }
      continue;
    }

    if (sourceDir) {
      syncable.push({ name, slug: name.includes('/') ? name.split('/').pop()! : name, dir: sourceDir, local: false });
    } else {
      registryOnly.push({ name, spec });
    }
  }

  return { syncable, registryOnly, localSource };
}

/**
 * Which install channel this tree is.
 *
 * `monorepo` is the private development checkout — its update path is a git
 * pull, not a registry install, and running an installer there would fight the
 * workspace. The published channels install from a registry.
 */
export function detectChannel(neuralisDir: string): 'monorepo' | 'installed' {
  const parent = resolve(neuralisDir, '..');
  const workspaceMarkers = [join(neuralisDir, 'pnpm-workspace.yaml'), join(parent, 'pnpm-workspace.yaml')];
  return workspaceMarkers.some((marker) => existsSync(marker)) ? 'monorepo' : 'installed';
}
