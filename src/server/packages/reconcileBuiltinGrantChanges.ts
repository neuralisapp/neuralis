/**
 * A builtin the operator ADDS or REMOVES after projects exist moves their role
 * grants with it — and the pure grant computations every package grant rides.
 *
 * `pnpm neuralis:pkg add|remove <name>` changes the dependency line (the trust
 * act) and records the change in `<appRoot>/config/builtin-removals.json`
 * (written by the operator CLI, read once per boot), which holds two lists:
 *
 * - `removals[]` — written BEFORE the package leaves the image: which of its
 *   provided features its manifest grants roles by default (`defaultRoleGrants`).
 *   At the next boot the manifest is gone, so the record is the only place the
 *   set survives. For every record whose package is still absent, each
 *   project's roles lose exactly the recorded features no builtin or loaded
 *   package still provides — through `revokeGrantsPatch`, the same computation a
 *   project package's uninstall runs (an apex role is never stripped, the
 *   `appliedPackageGrants` marker is cleared). A record whose package is back in
 *   the deps is dropped unapplied: re-adding it is the operator's later word.
 * - `additions[]` — `{ packageId, addedAt }`. Manifest `defaultRoleGrants` of a
 *   builtin otherwise reach a project only at its CREATION; an added builtin's
 *   grants are applied to every project (archived included) ONCE, read off the
 *   manifest the boot already holds, through `applyGrantsPatch` with the builtin
 *   floor (`canReceiveBuiltinGrant`) and the merge-once marker. An addition
 *   whose package is NOT a builtin at this boot (the CLI wrote it, the image is
 *   not rebuilt yet) is KEPT and applied at the first boot that has it; only
 *   `pkg remove` clears a pending addition.
 *
 * Data, config values and credentials stay on removal: they are user data, and
 * the CLI printed how to delete them.
 *
 * Cost: one `stat` per boot when no record exists; with records, one read of a
 * file bounded by the operator's pending `pkg add`/`remove` count, one project
 * list and one producer write per project per applied record, once.
 */

import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { providedFeatureIds } from '@neuralis/package-system';
import type { PackageDefinition } from '@neuralis/package-system/contracts';
import { BUILTIN_ROLE_PRIORITY, rolePriority } from '@neuralis/package-system/access';
import { canReceiveBuiltinGrant } from '../projects/access';
import type { ProjectRecordPatch } from '../store/ProjectStore';
import type { ProjectRecord, RoleDefinition } from '../store/projectTypes';

/**
 * The grant-APPLY computation, as a pure function of the project record.
 *
 * Pure on purpose: it runs INSIDE `updateProject`'s producer, so it must see the
 * record as it is on disk at write time, and being pure is what lets the
 * merge-once + floor rules be pinned without the `globalThis` manager singleton.
 *
 * `canReceive` is the floor of the grant's ORIGIN — `canReceivePackageGrant` for
 * a project package (never `admin` or stronger), `canReceiveBuiltinGrant` for a
 * host-assigned builtin (never apex) — required, so no caller inherits a floor
 * it did not choose.
 *
 * Returns `null` when this package version's grants are already recorded (the
 * merge-once guard, which preserves an admin's manual revoke). Otherwise the
 * provenance marker is ALWAYS part of the patch — even when no feature was
 * added — so the guard fires on the next boot.
 */
export function applyGrantsPatch(
  project: ProjectRecord,
  packageId: string,
  version: string,
  grants: Record<string, string[]>,
  providedFeatures: ReadonlySet<string>,
  canReceive: (roleName: string, role: RoleDefinition) => boolean,
): ProjectRecordPatch | null {
  if (project.appliedPackageGrants?.[packageId] === version) return null;

  let updated = false;
  const roles = { ...project.roles };
  for (const [roleName, features] of Object.entries(grants)) {
    const role = roles[roleName];
    if (!role || !canReceive(roleName, role)) continue;
    const existing = new Set(role.grantedFeatures);
    let roleChanged = false;
    for (const feature of features) {
      if (feature === '*' || !providedFeatures.has(feature)) continue;
      if (!existing.has(feature)) {
        existing.add(feature);
        roleChanged = true;
      }
    }
    if (roleChanged) {
      roles[roleName] = { ...role, grantedFeatures: [...existing] };
      updated = true;
    }
  }

  return {
    ...(updated ? { roles } : {}),
    appliedPackageGrants: { ...project.appliedPackageGrants, [packageId]: version },
  };
}

/**
 * The grant-REVOKE computation, as a pure function of the project record.
 *
 * `revoke` is the already-resolved set of features no OTHER loaded package
 * still provides — loader state, so it stays outside. Returns `null` when there
 * is nothing to write (no role lost a feature AND there was no marker), which
 * is what keeps an uninstall of an already-clean package from touching the
 * record at all.
 */
export function revokeGrantsPatch(
  project: ProjectRecord,
  packageId: string,
  revoke: ReadonlySet<string>,
): ProjectRecordPatch | null {
  let updated = false;
  const roles = { ...project.roles };
  for (const [roleName, role] of Object.entries(roles)) {
    if (role.grantedFeatures.includes('*')) continue;
    // S1 — never strip an APEX role. This is the one uninstall-triggered
    // writer that reaches `roles.grantedFeatures` without the role-map write
    // floor (it runs as the system, from a package lifecycle, not a caller),
    // and the S1 heal deliberately repairs only the seeded owner key — so an
    // apex role carrying an ENUMERATED list could be emptied here with no
    // path back. Keyed on resolved PRIORITY, mirroring the migration's own
    // apex skip (P4), so it is name-free and covers a custom priority-1 role.
    if (rolePriority(roleName, role.priority) <= BUILTIN_ROLE_PRIORITY.owner) continue;
    const next = role.grantedFeatures.filter((f) => !revoke.has(f));
    if (next.length !== role.grantedFeatures.length) {
      roles[roleName] = { ...role, grantedFeatures: next };
      updated = true;
    }
  }

  const appliedPackageGrants = { ...project.appliedPackageGrants };
  const hadMarker = packageId in appliedPackageGrants;
  delete appliedPackageGrants[packageId];

  if (!updated && !hadMarker) return null;
  return { ...(updated ? { roles } : {}), appliedPackageGrants };
}

/** The record file, relative to the app root (`~/.neuralis/app`). */
export const BUILTIN_GRANT_CHANGES_FILE = join('config', 'builtin-removals.json');

export type BuiltinRemovalRecord = { packageId: string; features: string[]; removedAt: string };
export type BuiltinAdditionRecord = { packageId: string; addedAt: string };

type Deps = {
  appRoot: string;
  /** The builtin ids discovered at THIS boot. */
  builtinIds: ReadonlySet<string>;
  /**
   * Every definition whose features count as still provided: each builtin
   * discovered at this boot (a refused one included — it is still a
   * dependency) and every package the loader holds. An addition's grants are
   * read off the first entry with its id (the builtin's manifest).
   */
  providers: readonly Pick<PackageDefinition, 'id' | 'version' | 'requires'>[];
  listProjectIds: () => Promise<string[]>;
  updateProject: (id: string, producer: (current: ProjectRecord) => ProjectRecordPatch | null) => Promise<unknown>;
  logger: { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string, meta?: Record<string, unknown>) => void };
};

function parseRecords(text: string): { removals: BuiltinRemovalRecord[]; additions: BuiltinAdditionRecord[] } {
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

export async function reconcileBuiltinGrantChanges(deps: Deps): Promise<void> {
  const file = join(deps.appRoot, BUILTIN_GRANT_CHANGES_FILE);
  let records: ReturnType<typeof parseRecords>;
  try {
    records = parseRecords(await readFile(file, 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    deps.logger.warn('builtin grant-change record unreadable — no grant moved', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  const { removals, additions } = records;

  const stillProvided = new Set<string>();
  for (const def of deps.providers) for (const f of providedFeatureIds(def.requires?.providesFeatures)) stillProvided.add(f);

  const needsProjects =
    removals.some((r) => !deps.builtinIds.has(r.packageId)) || additions.some((a) => deps.builtinIds.has(a.packageId));
  const projectIds = needsProjects ? await deps.listProjectIds() : [];

  for (const record of removals) {
    if (deps.builtinIds.has(record.packageId)) {
      deps.logger.info('builtin removal record dropped — the package is a dependency again', { packageId: record.packageId });
      continue;
    }
    const revoke = new Set(record.features.filter((f) => !stillProvided.has(f)));
    for (const projectId of projectIds) {
      await deps.updateProject(projectId, (current) => revokeGrantsPatch(current, record.packageId, revoke));
    }
    deps.logger.info('removed builtin: role grants revoked', {
      packageId: record.packageId,
      revoked: [...revoke],
      keptBecauseStillProvided: record.features.filter((f) => stillProvided.has(f)),
      projects: projectIds.length,
    });
  }

  const pending: BuiltinAdditionRecord[] = [];
  for (const record of additions) {
    if (!deps.builtinIds.has(record.packageId)) {
      pending.push(record);
      deps.logger.info('builtin addition record kept — the package is not in this image yet', { packageId: record.packageId });
      continue;
    }
    // A builtin's `id` is its dep name, stamped by `readBuiltinManifests` (bootstrap.ts).
    const manifest = deps.providers.find((def) => def.id === record.packageId);
    const grants = manifest?.requires?.defaultRoleGrants ?? {};
    const provided = new Set(providedFeatureIds(manifest?.requires?.providesFeatures));
    const version = manifest?.version ?? '0.0.0';
    if (Object.keys(grants).length > 0) {
      for (const projectId of projectIds) {
        await deps.updateProject(projectId, (current) =>
          applyGrantsPatch(current, record.packageId, version, grants, provided, canReceiveBuiltinGrant),
        );
      }
    }
    deps.logger.info('added builtin: default role grants applied', {
      packageId: record.packageId,
      roles: Object.keys(grants),
      projects: Object.keys(grants).length > 0 ? projectIds.length : 0,
    });
  }

  // Nothing applied ⇒ the file stays byte-for-byte. Otherwise the survivors
  // (pending additions) are written back, or the file goes. A crash before
  // this replays the applied records at the next boot, which is harmless: a
  // revocation already applied computes no patch, and an applied addition
  // meets its own marker.
  if (pending.length > 0 && pending.length === removals.length + additions.length) return;
  if (pending.length === 0) {
    await rm(file, { force: true });
    return;
  }
  const text = `${JSON.stringify({ removals: [], additions: pending }, null, 2)}\n`;
  await writeFile(`${file}.tmp`, text, 'utf-8');
  await rename(`${file}.tmp`, file);
}
