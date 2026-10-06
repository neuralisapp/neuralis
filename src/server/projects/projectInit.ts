import { mkdir } from 'fs/promises';
import { join } from 'path';
import { resolveProjectRoot } from '@neuralis/package-system/paths';
import { getEnv } from '../config/env';

type ReadyRuntime = Awaited<ReturnType<typeof import('../host/bootstrap').getRuntime>>;

/**
 * The package runtime is not up, so a project created now would get none of
 * what the packages provision (its default sources among them) — and nothing
 * repairs a project that was never provisioned. A create refuses instead.
 */
export class RuntimeNotReadyError extends Error {
  readonly code = 'runtime_not_ready';
  constructor() {
    super('runtime_not_ready');
    this.name = 'RuntimeNotReadyError';
  }
}

/**
 * The ready runtime, or {@link RuntimeNotReadyError}. A boot still in progress
 * is awaited; a failed boot refuses. On a healthy host this is the cached
 * instance — no IO.
 */
export async function requireReadyRuntime(): Promise<ReadyRuntime> {
  try {
    const { getRuntime } = await import('../host/bootstrap');
    const runtime = await getRuntime();
    await runtime.whenReady();
    return runtime;
  } catch {
    throw new RuntimeNotReadyError();
  }
}

/**
 * Ensure a project directory exists with the standard data layout:
 *
 *   {projectRoot}/
 *     data/           — source:data, all package runtime output
 *     _packages/      — source:packages, installed packages (trust-gated)
 *
 * Also provisions app-zone credential directory:
 *   {appRoot}/credentials/projects/{projectId}/
 *
 * Everything else a project starts with comes from the packages' `provisionProject`
 * hooks — its per-package data, and its default sources, which the package that
 * declares them (`sources[]` with `seed:'auto'`) seeds. The host names no source.
 * The runtime must be READY before anything is created: a not-ready runtime
 * throws {@link RuntimeNotReadyError} with nothing written.
 */
export async function initProjectDirectory(
  projectId: string,
  ownerId?: string,
): Promise<void> {
  const core = await requireReadyRuntime();
  const { projectsRoot, appRoot } = getEnv();
  const projectDir = resolveProjectRoot(projectsRoot, projectId);

  // Create project directory structure
  await Promise.all([
    mkdir(projectDir, { recursive: true, mode: 0o700 }),
    mkdir(join(projectDir, 'data'), { recursive: true, mode: 0o700 }),
    mkdir(join(projectDir, '_packages'), { recursive: true, mode: 0o700 }),
  ]);

  // Create app-zone credential directory for this project
  if (appRoot) {
    await mkdir(join(appRoot, 'credentials', 'projects', projectId), {
      recursive: true,
      mode: 0o700,
    });
  }

  // Fail-fast: a package hook failure rejects with `ProjectProvisionError`
  // naming the package, and the create is refused and rolled back by its caller.
  await core.getLoader().provisionProjectForAll(projectId, projectDir, ownerId);
}
