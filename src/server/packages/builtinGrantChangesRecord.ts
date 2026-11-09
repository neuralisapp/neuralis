/**
 * The builtin grant-change record (`<appRoot>/config/builtin-removals.json`) —
 * its ONE reader and ONE writer. Two writers add rows: the operator command
 * `neuralis pkg add|remove` (the image lane) and the runtime install
 * transaction (`install/platformPackages.ts`); the boot applies them once
 * (`reconcileBuiltinGrantChanges.ts`). No import beyond `node:` and the
 * kernel, so the operator CLI loads it under tsx without the host's stores.
 *
 * Cost: one read and at most one rename-write of a file bounded by the
 * pending add/remove count, per recorded change.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { providedFeatureIds } from '@neuralis/package-system/contracts';
import type { PackageDefinition } from '@neuralis/package-system/contracts';

/** The record file, relative to the app root (`~/.neuralis/app`). */
export const BUILTIN_GRANT_CHANGES_FILE = join('config', 'builtin-removals.json');

export type BuiltinRemovalRecord = { packageId: string; features: string[]; removedAt: string };
export type BuiltinAdditionRecord = { packageId: string; addedAt: string };
export type BuiltinGrantChanges = { removals: BuiltinRemovalRecord[]; additions: BuiltinAdditionRecord[] };

/** Parse the record's text; well-formed rows only. Throws on text that is no JSON. */
export function parseGrantChangeRecords(text: string): BuiltinGrantChanges {
  const raw = JSON.parse(text) as { removals?: unknown; additions?: unknown };
  const removals = Array.isArray(raw.removals)
    ? raw.removals.filter(
        (r): r is BuiltinRemovalRecord =>
          Boolean(r) &&
          typeof (r as BuiltinRemovalRecord).packageId === 'string' &&
          Array.isArray((r as BuiltinRemovalRecord).features) &&
          (r as BuiltinRemovalRecord).features.every((f) => typeof f === 'string'),
      )
    : [];
  const additions = Array.isArray(raw.additions)
    ? raw.additions.filter(
        (r): r is BuiltinAdditionRecord =>
          Boolean(r) &&
          typeof (r as BuiltinAdditionRecord).packageId === 'string' &&
          typeof (r as BuiltinAdditionRecord).addedAt === 'string',
      )
    : [];
  return { removals, additions };
}

/** Read-modify-write the record; written through a rename, deleted when empty. */
async function updateGrantChanges(appRoot: string, change: (records: BuiltinGrantChanges) => BuiltinGrantChanges): Promise<void> {
  const file = join(appRoot, BUILTIN_GRANT_CHANGES_FILE);
  let records: BuiltinGrantChanges = { removals: [], additions: [] };
  try {
    records = parseGrantChangeRecords(await readFile(file, 'utf-8'));
  } catch {
    /* no record yet */
  }
  const next = change(records);
  if (next.removals.length === 0 && next.additions.length === 0) {
    await rm(file, { force: true });
    return;
  }
  const text = `${JSON.stringify(next, null, 2)}\n`;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, text, 'utf-8');
  await rename(`${file}.tmp`, file);
}

/** An added package: drop its pending removal, (re)record the addition. */
export async function recordBuiltinAddition(appRoot: string, packageId: string, now: Date = new Date()): Promise<void> {
  await updateGrantChanges(appRoot, ({ removals, additions }) => ({
    removals: removals.filter((r) => r.packageId !== packageId),
    additions: [...additions.filter((a) => a.packageId !== packageId), { packageId, addedAt: now.toISOString() }],
  }));
}

/**
 * A removed package: drop its pending addition, and record its default-granted
 * features (none → no removal record) — an earlier record for it is replaced.
 */
export async function recordBuiltinRemoval(appRoot: string, packageId: string, features: readonly string[], now: Date = new Date()): Promise<void> {
  await updateGrantChanges(appRoot, ({ removals, additions }) => ({
    removals: [
      ...removals.filter((r) => r.packageId !== packageId),
      ...(features.length > 0 ? [{ packageId, features: [...features], removedAt: now.toISOString() }] : []),
    ],
    additions: additions.filter((a) => a.packageId !== packageId),
  }));
}

/** The provided features a manifest's `defaultRoleGrants` grant — what a removal takes back. */
export function defaultGrantedFeatures(requires: PackageDefinition['requires'] | undefined): string[] {
  const provided = new Set(providedFeatureIds(requires?.providesFeatures));
  return [...new Set(Object.values(requires?.defaultRoleGrants ?? {}).flat())].filter(
    (f): f is string => typeof f === 'string' && provided.has(f),
  );
}
