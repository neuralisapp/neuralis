/**
 * happy-wondering-yeti — project (tenant) lifecycle: owner-gated two-stage delete.
 *
 * Three operations, all called by the owner-only routes under
 * `/api/projects/[id]/…`:
 *
 *  - `archiveProject`  — soft-archive (set `archivedAt`). The project drops out of
 *    every list surface AND is access-denied (the catch-all membership gate reads
 *    the same list). Reversible.
 *  - `restoreProject`  — clear `archivedAt`. Archived-only (throws otherwise).
 *  - `purgeProject`    — PERMANENT, archived-only. In a FIXED order: the id's
 *    tombstone (so the id is never minted again, whatever a later step leaves) →
 *    every package's `deprovisionProject` (desktop containers and profiles,
 *    vector points — through the loader, never a direct package call) → project
 *    tree → record → source configs → project credentials → the project's
 *    agent-scoped credentials (the one step the credential store performs, over
 *    its segment-guarded ids), with a realpath containment guard on every path it
 *    removes itself. It NEVER follows a source-config's root — mounted /
 *    `--neuralis`-overlay / external source content is untouched (only the
 *    config-JSON pointer under the app zone is removed). User-scoped and global
 *    credentials are NEVER touched.
 *
 * The package step runs BEFORE any fs `rm` and is MUST-HAVE: a package that
 * fails or times out stops the purge with every file still in place — the
 * project stays archived and tombstoned, and the purge can be retried. It also
 * has to precede the tree `rm` because resolving the project's brain infra can
 * re-materialize `{projectsRoot}/<id>/` (MINOR-5).
 */
import { existsSync, realpathSync } from 'fs';
import { rm } from 'fs/promises';
import { join, resolve } from 'path';
import { isPathInside, resolveProjectRoot } from '@neuralis/package-system/paths';
import { getEnv } from '../config/env';
import { getRuntime } from '../host/bootstrap';
import {
  deleteProject,
  getProjectById,
  markProjectIdPurged,
  setProjectArchived,
} from '../store/ProjectStore';
import { getCredentialStore } from '../store/credentialStoreInstance';

/** Thrown when restore/permanent-delete is attempted on a wrong-state project. */
export class ProjectLifecycleError extends Error {
  readonly code: 'not_found' | 'not_archived';
  constructor(code: 'not_found' | 'not_archived', message: string) {
    super(message);
    this.name = 'ProjectLifecycleError';
    this.code = code;
  }
}

/** Soft-archive: hide from lists + deny access. Reversible via `restoreProject`. */
export async function archiveProject(id: string): Promise<void> {
  const existing = await getProjectById(id);
  if (!existing) throw new ProjectLifecycleError('not_found', `Project "${id}" not found`);
  await setProjectArchived(id, new Date().toISOString());
}

/** Restore an archived project. Refuses a project that is not archived. */
export async function restoreProject(id: string): Promise<void> {
  const existing = await getProjectById(id);
  if (!existing) throw new ProjectLifecycleError('not_found', `Project "${id}" not found`);
  if (existing.archivedAt == null) {
    throw new ProjectLifecycleError('not_archived', `Project "${id}" is not archived`);
  }
  await setProjectArchived(id, null);
}

/**
 * PERMANENT purge. Archived-only. Every step is must-have: the package step
 * rejects with the kernel's `ProjectDeprovisionError` (naming the package) before
 * any file is removed. Every rm path here passes the realpath containment guard
 * and fails closed if it resolves outside its zone.
 */
export async function purgeProject(id: string): Promise<void> {
  const existing = await getProjectById(id);
  if (!existing) throw new ProjectLifecycleError('not_found', `Project "${id}" not found`);
  if (existing.archivedAt == null) {
    throw new ProjectLifecycleError('not_archived', `Project "${id}" must be archived before permanent deletion`);
  }

  const { appRoot, projectsRoot } = getEnv();

  // (1) Tombstone — before anything is removed, so a purge that stops half-way
  // still keeps the id from being minted for a new tenant.
  await markProjectIdPurged(id);

  // (2) Every package's project-keyed resources. Throws (nothing removed yet).
  // The package-owned deprovision hook fences its own background boot work.
  // Its rejection propagates as ProjectDeprovisionError before any removal.
  const runtime = await getRuntime();
  await runtime.getLoader().deprovisionProjectForAll(id);

  // (3) Project tree. `resolveProjectRoot` validates the id as a safe segment.
  await safeRemove(resolveProjectRoot(projectsRoot, id), projectsRoot);

  // (4) Record.
  await deleteProject(id);

  // (5) Source config pointers (NOT the source roots they point at).
  await safeRemove(join(appRoot, 'config', 'sources', id), appRoot);

  // (6) Project-scoped credentials.
  await safeRemove(join(appRoot, 'credentials', 'projects', id), appRoot);

  // (7) The project's agent-scoped credentials — `agents/<id>/` IS this
  // project, so a same-slug agent of another tenant is never touched.
  getCredentialStore().deleteProjectAgentScopes(id);
}

/**
 * `rm -rf` a target only after realpath-resolving it and asserting it is inside
 * `allowedParent` (also realpath-resolved). Fails closed on an out-of-zone /
 * symlink-escaping path — the id is a stored, owner-confirmed value, so
 * this is defense-in-depth, but it is the guard the destructive op leans on.
 */
async function safeRemove(target: string, allowedParent: string): Promise<void> {
  const realTarget = existsSync(target) ? realpathSync(target) : resolve(target);
  const realParent = existsSync(allowedParent) ? realpathSync(allowedParent) : resolve(allowedParent);
  if (realTarget === realParent || !isPathInside(realParent, realTarget)) {
    throw new Error(`Refusing to remove path outside its zone: "${target}" not contained in "${allowedParent}"`);
  }
  await rm(realTarget, { recursive: true, force: true });
}
