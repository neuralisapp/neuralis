/**
 * The image build's admission record, read once at boot.
 *
 * The build judges the WHOLE builtin set before the image exists
 * (`scripts/build/build-workspace.mjs validate` → `_runtime/build/validate.json`):
 * a registry package the runtime would refuse, or one in conflict with another
 * builtin over a singular contract, an OAuth prefix or a config key, is
 * recorded as refused while the build goes on. The boot leaves those out BEFORE
 * the host's set-level checks (`resolveServiceProviders`, config-key
 * registration) and names them in `health().refused`, so one bad package never
 * stops the platform. A package declaring a key the HOST owns — a declarer the
 * build never sees — is refused here the same way. With no record (a dev tree)
 * a conflict between two packages still stops the boot, naming both.
 *
 * Cost: one small JSON read per boot; no timer, no watcher.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectDeclaredConfigSettings } from '@neuralis/package-system/access';
import type { BuiltinRefusal, PackageDefinition } from '@neuralis/package-system/contracts';

/** Where the record sits under the host root (the runner's `_runtime/build`). */
export const BUILD_VALIDATE_RECORD = join('_runtime', 'build', 'validate.json');

/** One refused entry as the build writes it: `invalid` = the loader's admission check, `conflict` = set-level. */
export type BuildRecordRefusal = { packageId: string; reason: 'invalid' | 'conflict'; errors: string[] };

export type BuildRecordRead =
  | { kind: 'none' }
  | { kind: 'malformed' }
  | { kind: 'record'; refused: readonly BuiltinRefusal[] };

function parseRefused(value: unknown): BuiltinRefusal[] | null {
  if (!Array.isArray(value)) return null;
  const out: BuiltinRefusal[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') return null;
    const { packageId, reason } = entry as { packageId?: unknown; reason?: unknown };
    if (typeof packageId !== 'string' || packageId.length === 0) return null;
    if (reason === 'conflict') out.push({ packageId, reason: 'conflict' });
    else if (reason === 'invalid') out.push({ packageId, reason: 'load_failed' });
    else return null;
  }
  return out;
}

/** Read the record under `hostRoot`. A missing file is `none`; anything unreadable as the record is `malformed`. */
export async function readBuildRefusals(hostRoot: string): Promise<BuildRecordRead> {
  let raw: string;
  try {
    raw = await readFile(join(hostRoot, BUILD_VALIDATE_RECORD), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' };
    return { kind: 'malformed' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'malformed' };
  }
  const refused = parsed !== null && typeof parsed === 'object' ? parseRefused((parsed as { refused?: unknown }).refused) : null;
  return refused === null ? { kind: 'malformed' } : { kind: 'record', refused };
}

/** A builtin left out at boot because it declares a config key another declarer already owns. */
export type ConfigKeyCollision = { packageId: string; key: string; declaredBy: string };

/**
 * Split the builtin manifests into the admitted set the boot runs and the
 * refusals it names. A record entry for a package that is no longer a builtin
 * is dropped. Then the one set-level check the build cannot make: a config key
 * a declarer OUTSIDE this set already registered (the host's own keys,
 * registered by `getEnv()` before any package) — the colliding package is
 * refused as `conflict` instead of stopping the boot. `configOwnerOf` answers
 * the current declarer of a key; two packages of the set are left to the
 * build record and, without one, to the store's own collision throw.
 */
export function admitBuiltins(
  manifests: readonly PackageDefinition[],
  refusals: readonly BuiltinRefusal[],
  configOwnerOf: (key: string) => string | undefined,
): { admitted: PackageDefinition[]; refused: BuiltinRefusal[]; keyCollisions: ConfigKeyCollision[] } {
  const byId = new Map(refusals.map((r) => [r.packageId, r]));
  const candidates: PackageDefinition[] = [];
  const refused: BuiltinRefusal[] = [];
  for (const manifest of manifests) {
    const refusal = byId.get(manifest.id);
    if (refusal) refused.push(refusal);
    else candidates.push(manifest);
  }
  const ids = new Set(candidates.map((m) => m.id));
  const keyCollisions: ConfigKeyCollision[] = [];
  for (const { declarer, settings } of collectDeclaredConfigSettings(candidates)) {
    for (const { key } of settings) {
      const declaredBy = configOwnerOf(key);
      if (declaredBy !== undefined && !ids.has(declaredBy)) keyCollisions.push({ packageId: declarer, key, declaredBy });
    }
  }
  const colliding = new Set(keyCollisions.map((c) => c.packageId));
  for (const id of colliding) refused.push({ packageId: id, reason: 'conflict' });
  return { admitted: candidates.filter((m) => !colliding.has(m.id)), refused, keyCollisions };
}
