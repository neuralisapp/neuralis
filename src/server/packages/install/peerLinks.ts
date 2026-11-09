/**
 * ONE module instance for the packages of the runtime install record.
 *
 * A record package imports the platform packages it declares as PEERS
 * (`@neuralis/package-system`, `@neuralis/agent-core`, React, …) by bare name,
 * which Node resolves by walking up from the package's real path — into
 * `<record>/node_modules/`. Before the loader imports anything, each such peer
 * there is made a link (Windows: a directory junction, which needs no
 * privilege) to the REAL path of the host's own copy, so Node lands on the very
 * module records the host already loaded: one kernel, one React, one store.
 * The links are DERIVED at every start — the host's tree is `/neuralis` in the
 * image, the desktop bundle's `host/`, a clone's `neuralis/` — and never stored
 * as truth; an npm-made copy found where a link belongs is replaced. Discovery
 * itself never follows a link: it reads the record's lines (`builtinSlots.ts`).
 *
 * Cost per start: one manifest read per installed package, one lstat (+ a
 * readlink) per peer, a symlink only where one is missing or stale — no
 * watcher, nothing after the boot.
 */

import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

type Manifest = { peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> };

function readManifest(path: string): Manifest | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Manifest;
  } catch {
    return null;
  }
}

/**
 * The peers the record's packages declare that the host can provide, each with
 * the real path of the host's copy. `resolveHost(name)` answers the host's root
 * of a dependency or throws; a peer the host lacks is left out here (the
 * install refuses such a package before it is recorded).
 */
export function sharedPeers(recordRoot: string, installedIds: Iterable<string>, resolveHost: (name: string) => string): Map<string, string> {
  const peers = new Map<string, string>();
  for (const id of installedIds) {
    const manifest = readManifest(join(recordRoot, 'node_modules', id, 'package.json'));
    for (const peer of Object.keys(manifest?.peerDependencies ?? {})) {
      if (peers.has(peer)) continue;
      try {
        peers.set(peer, realpathSync(resolveHost(peer)));
      } catch {
        /* not the host's to provide */
      }
    }
  }
  return peers;
}

/** The link's current target, resolved, or null when the path is no link (absent, or a real directory). */
function linkTarget(path: string): string | null {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null;
    return resolve(dirname(path), readlinkSync(path));
  } catch {
    return null;
  }
}

/** Remove a link itself — never what it points at (a junction is removed like a directory entry on Windows). */
function removeLink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    rmdirSync(path);
  }
}

/** Make every peer a link to the host's copy. Returns what changed, by peer name. */
export function linkSharedPeers(recordRoot: string, peers: ReadonlyMap<string, string>, platform: NodeJS.Platform = process.platform): { linked: string[]; replaced: string[] } {
  const linked: string[] = [];
  const replaced: string[] = [];
  for (const [peer, target] of peers) {
    const path = join(recordRoot, 'node_modules', peer);
    const current = linkTarget(path);
    if (current !== null && resolve(current) === resolve(target)) continue;
    let entry: ReturnType<typeof lstatSync> | null = null;
    try {
      entry = lstatSync(path);
    } catch {
      /* absent */
    }
    if (entry) {
      // A stale link goes as a link; a real directory is an npm-made copy of a shared peer.
      if (entry.isSymbolicLink()) removeLink(path);
      else rmSync(path, { recursive: true, force: true });
      replaced.push(peer);
    }
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path, platform === 'win32' ? 'junction' : 'dir');
    linked.push(peer);
  }
  return { linked, replaced };
}

/** Remove the peer links before npm reshapes the tree (npm would prune them as extraneous, and must never follow one). */
export function unlinkSharedPeers(recordRoot: string, peers: Iterable<string>): void {
  for (const peer of peers) {
    const path = join(recordRoot, 'node_modules', peer);
    if (linkTarget(path) !== null) removeLink(path);
  }
}
