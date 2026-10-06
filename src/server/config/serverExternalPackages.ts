/**
 * Computed `serverExternalPackages` (featherweight-flamingo v2, D-D).
 *
 * The host must tell Next.js to leave every builtin-class dependency
 * external to the server bundle. That list is derivable: a dep belongs on
 * it iff its package.json carries a `neuralis` block. This is computed
 * CONFIG, not code generation — `next.config.ts` is build-time Node code
 * that calls this helper at config-load; nothing is written to disk.
 *
 * D-D specifics:
 * - the predicate is "has a `neuralis` block" WITHOUT a `referenceOnly`
 *   exclusion: `@neuralis/package-system` is reference-only yet must stay
 *   external (its contracts are imported server-side by every package);
 * - an unreadable/unparsable manifest for a declared dependency FAILS LOUD
 *   (a broken install must break the build, not silently shrink the list);
 * - the static non-neuralis externals (bcryptjs, express, …) stay
 *   hand-written in `next.config.ts` — they are host knowledge.
 */

export type ManifestReader = (packageName: string) => unknown;

/**
 * Local-source dependency predicate — the ONE host-src copy (canonical rule
 * statement: `scripts/build/build-workspace.mjs`). A `file:`/`link:` spec is
 * written only by `pnpm neuralis:pkg add --path/--tarball`: this machine's
 * image builds and installs it like any package, but it is never part of a
 * PUBLIC artifact, so every derivation that pins the shippable set (the
 * externals pin test, the UI-binding contract, dep-manifest sweeps) excludes it.
 */
export function isMachineLocalDepSpec(spec: string): boolean {
  return spec.startsWith('file:') || spec.startsWith('link:');
}

/**
 * Manifest reader over the host's node_modules — every dependency, local
 * sources included, is an INSTALLED package there (the image build installs a
 * local source like any other; a host-native run installs it with
 * `pnpm install --lockfile=false`). A missing manifest fails loud: a broken
 * install must break the build.
 */
export function makeHostDepManifestReader(
  hostRoot: string,
  io: { readFileSync: (path: string, encoding: 'utf-8') => string },
  joinPath: (...parts: string[]) => string,
): ManifestReader {
  return (name: string): unknown =>
    JSON.parse(io.readFileSync(joinPath(hostRoot, 'node_modules', name, 'package.json'), 'utf-8'));
}

export function computeNeuralisExternalPackages(
  dependencies: string[],
  readManifest: ManifestReader,
): string[] {
  const externals: string[] = [];
  for (const name of dependencies) {
    let manifest: unknown;
    try {
      manifest = readManifest(name);
    } catch (err) {
      throw new Error(
        `serverExternalPackages: cannot read package.json of declared dependency "${name}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (manifest === null || typeof manifest !== 'object') {
      throw new Error(
        `serverExternalPackages: package.json of declared dependency "${name}" is not an object`,
      );
    }
    const block = (manifest as { neuralis?: unknown }).neuralis;
    if (block !== undefined && block !== null && typeof block === 'object') {
      externals.push(name);
    }
  }
  return externals.sort();
}
