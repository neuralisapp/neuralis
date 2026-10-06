/**
 * createProjectForUser — the ONE project-create gate body, two callers
 * (cookie `POST /api/projects` + the admin package's `projects-create` route
 * via the `hostPorts.governance` port).
 *
 * Gate ORDER is load-bearing: owner-strength FIRST, capacity second — an
 * unauthorized caller never learns the instance project count (non-inference).
 * The real floor stays owner-strength here; the package route's
 * `platform.projects.create` feature is reachability only and never
 * sufficient on its own.
 */

import {
  listAllProjects,
  createProject,
  type ProjectRecord,
} from '../store/ProjectStore';
import { isOwnerStrengthOfAnyProject, validateProjectName } from '../projects/access';
import { ProjectProvisionError } from '@neuralis/package-system/contracts';
import { requireReadyRuntime, RuntimeNotReadyError } from '../projects/projectInit';
import { getPlatformConfigStore } from '../store/PlatformConfigStore';
import { getUserById } from '../store/UserStore';
import { writeAuditLog } from '../store/AuditStore';

export type CreateProjectInput = { name: string; description?: string };

export type CreateProjectError =
  | { code: 'invalid_name'; message: string }
  | { code: 'caller_unknown' }
  | { code: 'not_owner_strength' }
  | { code: 'project_limit'; max: number }
  | { code: 'runtime_not_ready' }
  | { code: 'provisioning_failed'; message: string }
  | { code: 'seed_failed'; message: string };

export type CreateProjectResult =
  | { ok: true; project: ProjectRecord }
  | { ok: false; error: CreateProjectError };

/**
 * Creates run ONE AT A TIME per process: the capacity gate counts the list and
 * the create adds to it, so two concurrent creates would both pass a cap of N at
 * N-1. The queue lives on `globalThis` because the two callers sit in different
 * module graphs (a module-level `let` would give each graph its own queue).
 */
const CREATE_QUEUE = Symbol.for('neuralis.host.projectCreateQueue');

function enqueueCreate<T>(work: () => Promise<T>): Promise<T> {
  const g = globalThis as { [CREATE_QUEUE]?: Promise<unknown> };
  const run = (g[CREATE_QUEUE] ?? Promise.resolve()).then(work, work);
  g[CREATE_QUEUE] = run.catch(() => undefined);
  return run;
}

export function createProjectForUser(
  callerUserId: string,
  input: CreateProjectInput,
): Promise<CreateProjectResult> {
  return enqueueCreate(() => createProjectForUserNow(callerUserId, input));
}

async function createProjectForUserNow(
  callerUserId: string,
  input: CreateProjectInput,
): Promise<CreateProjectResult> {
  // The SAME name rule as a rename (`PATCH /api/projects/[id]`), stored trimmed.
  const nameError = validateProjectName(input.name);
  if (nameError) return { ok: false, error: { code: 'invalid_name', message: nameError } };
  const name = input.name.trim();

  const caller = await getUserById(callerUserId);
  if (!caller) return { ok: false, error: { code: 'caller_unknown' } };

  // ONE list of all projects drives both gates below.
  const all = await listAllProjects();

  // (A) Authorization: creating a tenant is owner-strength only (priority <= 1
  // in at least one existing project; there is no platform-global role).
  if (!isOwnerStrengthOfAnyProject(callerUserId, all)) {
    return { ok: false, error: { code: 'not_owner_strength' } };
  }

  // (B) Capacity: enterprise instance-wide cap.
  const maxProjects = getPlatformConfigStore().get('maxProjects');
  if (maxProjects > 0 && all.length >= maxProjects) {
    return { ok: false, error: { code: 'project_limit', max: maxProjects } };
  }

  // (C) Readiness, BEFORE anything is written: a project created while the
  // package runtime is down would never be provisioned (no default sources, and
  // nothing repairs it later). Refused with no record and no directory.
  try {
    await requireReadyRuntime();
  } catch {
    return { ok: false, error: { code: 'runtime_not_ready' } };
  }

  try {
    const project = await createProject(name, callerUserId, input.description, {
      name: caller.name,
      email: caller.email,
    });
    await writeAuditLog({
      action: 'project.create',
      userId: callerUserId,
      userEmail: caller.email,
      target: project.id,
      details: { maxProjects, total: all.length + 1 },
    });
    return { ok: true, project };
  } catch (err) {
    if (err instanceof RuntimeNotReadyError) return { ok: false, error: { code: 'runtime_not_ready' } };
    // The hook's message can carry an on-disk path: only the package id leaves.
    if (err instanceof ProjectProvisionError) {
      // The claimed id was tombstoned by the rollback; this row is its trace.
      await writeAuditLog({
        action: 'project.create_failed',
        userId: callerUserId,
        userEmail: caller.email,
        target: name,
        details: { packageId: err.packageId },
      });
      const message = `Package "${err.packageId}" could not set up the new project — nothing was created`;
      return { ok: false, error: { code: 'provisioning_failed', message } };
    }
    // `createProject` throws on a degenerate role seed (persists nothing) —
    // callers map this to their historical 409.
    return { ok: false, error: { code: 'seed_failed', message: String(err) } };
  }
}
