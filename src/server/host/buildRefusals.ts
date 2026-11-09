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
 * The operator's own choice rides the same channel: a builtin named in the
 * host config key `disabledBuiltinPackages` is left out as `disabled` — only
 * one whose manifest says the platform runs without it (`optional: true`; the
 * package stays installed, it is just not loaded).
 *
 * A package from the runtime install record (`builtinSlots.ts`) has no build
 * record: in conflict with another builtin over a contract, an OAuth prefix or
 * a config key it is refused as `conflict` instead of stopping the boot — the
 * image's own packages keep what they declare.
 *
 * Cost: one small JSON read per boot; no timer, no watcher.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectDeclaredConfigSettings } from '@neuralis/package-system/access';
import { findBuiltinSetConflicts } from '@neuralis/package-system';
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

/** The host config key naming the builtins this deployment does not load (`HOST_CONFIG_SETTINGS`). */
export const DISABLED_BUILTINS_KEY = 'disabledBuiltinPackages';

/**
 * The builtins an operator may turn off: those whose own manifest declares
 * `optional: true` (owner decision: today the virtual desktop alone). A
 * package that does not say so — admin, agents and the brain are the product —
 * is never turned off.
 */
export function optionalBuiltinIds(manifests: readonly PackageDefinition[]): Set<string> {
  return new Set(manifests.filter((m) => m.optional === true).map((m) => m.id));
}

/**
 * The key's value as the boot enforces it: the listed ids `optional` allows,
 * every other entry named in `ignored`. A value that is no array of strings
 * turns nothing off (`malformed`) — the platform loads every builtin rather
 * than guess.
 */
export function readDisabledBuiltins(value: unknown, optional: ReadonlySet<string>): { disabled: Set<string>; ignored: string[]; malformed: boolean } {
  if (value === undefined || value === null || value === '') return { disabled: new Set(), ignored: [], malformed: false };
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) return { disabled: new Set(), ignored: [], malformed: true };
  const disabled = new Set<string>();
  const ignored: string[] = [];
  for (const id of value as string[]) {
    if (optional.has(id)) disabled.add(id);
    else ignored.push(id);
  }
  return { disabled, ignored, malformed: false };
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
 * build record and, without one, to the store's own collision throw. A
 * package in `disabled` (`readDisabledBuiltins`) is left out first, as
 * `disabled`. Last, a `runtimeInstalled` package in a set conflict with any
 * other candidate is refused as `conflict` (`findBuiltinSetConflicts`).
 */
export function admitBuiltins(
  manifests: readonly PackageDefinition[],
  refusals: readonly BuiltinRefusal[],
  configOwnerOf: (key: string) => string | undefined,
  disabled: ReadonlySet<string> = new Set(),
  runtimeInstalled: ReadonlySet<string> = new Set(),
): { admitted: PackageDefinition[]; refused: BuiltinRefusal[]; keyCollisions: ConfigKeyCollision[] } {
  const byId = new Map(refusals.map((r) => [r.packageId, r]));
  const candidates: PackageDefinition[] = [];
  const refused: BuiltinRefusal[] = [];
  for (const manifest of manifests) {
    const refusal = byId.get(manifest.id);
    if (disabled.has(manifest.id)) refused.push({ packageId: manifest.id, reason: 'disabled' });
    else if (refusal) refused.push(refusal);
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
  const remaining = candidates.filter((m) => !colliding.has(m.id));
  for (const conflict of findBuiltinSetConflicts(remaining)) {
    for (const id of conflict.packages) if (runtimeInstalled.has(id)) colliding.add(id);
  }
  for (const id of colliding) refused.push({ packageId: id, reason: 'conflict' });
  return { admitted: candidates.filter((m) => !colliding.has(m.id)), refused, keyCollisions };
}
