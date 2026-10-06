/**
 * Shared test helper: the host dependency universe with the local-source
 * exclusion applied.
 *
 * Shippable-artifact derivations — the externals pin test, the UI-binding
 * drift guard, the host-port / skill-ref / icon manifest sweeps — must ignore
 * local-source (`file:`/`link:`-spec) deps. Canonical rule statement:
 * `neuralis/scripts/build/build-workspace.mjs`. Two reasons, both measured: a
 * local package may be UNINSTALLED host-side (a checkout that only ever builds
 * the image installs nothing — a bare node_modules read ENOENT-crashes the
 * whole suite), and even when installed it must not join tracked assertions,
 * or the suite goes red/green with the operator's dogfood state instead of the
 * tree.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMachineLocalDepSpec } from '../server/config/serverExternalPackages';

export const HOST_ROOT = join(__dirname, '..', '..');

function readHostDependencyMap(): Record<string, string> {
  const raw = readFileSync(join(HOST_ROOT, 'package.json'), 'utf-8');
  return (JSON.parse(raw) as { dependencies?: Record<string, string> }).dependencies ?? {};
}

let warned = false;

/** Host dependency names with machine-local (file:/link:) deps excluded. */
export function shippableHostDependencies(): string[] {
  const deps = readHostDependencyMap();
  const skipped = Object.entries(deps).filter(([, spec]) => isMachineLocalDepSpec(spec));
  if (skipped.length > 0 && !warned) {
    warned = true;
    console.warn(
      `[hostDepManifests] skipping ${skipped.length} machine-local dep(s) from shippable derivations: ` +
        skipped.map(([name]) => name).join(', '),
    );
  }
  return Object.keys(deps).filter((name) => !isMachineLocalDepSpec(deps[name]));
}

/** Machine-local dep entries present on THIS machine (may be empty). */
export function machineLocalHostDependencies(): Array<{ name: string; spec: string }> {
  return Object.entries(readHostDependencyMap())
    .filter(([, spec]) => isMachineLocalDepSpec(spec))
    .map(([name, spec]) => ({ name, spec }));
}

/** node_modules manifest read for a SHIPPABLE dep — fail-loud stays correct here. */
export function readShippableDepManifest<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(join(HOST_ROOT, 'node_modules', name, 'package.json'), 'utf-8')) as T;
}
