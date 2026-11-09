/**
 * Community package dispatch helpers: a loaded package's definition and
 * runtime queries, and the package-runtime commands, for the community host.
 * The project's package list is `GET /api/projects/:id/packages` (the shared
 * governance body), not a query here.
 */

import type {
  PackageCommandRequest,
  PackageCommandResponse,
  PackageQueryRequest,
  PackageQueryResponse,
} from '@neuralis/package-system';
import { uninstallPackageFromProject } from './packageInstaller';
import { getPackageRuntimeManager } from './PackageRuntimeManager';
import { getEnv } from '../config/env';
import { resolveProjectRoot } from '@neuralis/package-system/paths';

export async function handleDefaultCommunityPackageQuery(
  request: PackageQueryRequest,
): Promise<PackageQueryResponse | undefined> {
  // The kernel is reference-only: it answers no query of its own.
  if (request.packageId === '@neuralis/package-system') return undefined;

  const runtimeManager = getPackageRuntimeManager();
  const registry = runtimeManager.getRegistry();
  const runtime = runtimeManager.getRuntime();
  const definition = registry.getPackage(request.packageId);

  if (!definition) {
    return {
      success: false,
      error: `Package not found: ${request.packageId}`,
    };
  }

  switch (request.operation) {
    case 'definition.identity':
      return {
        success: true,
        data: {
          id: definition.id,
          name: definition.name,
          version: definition.version,
          description: definition.description,
          authors: definition.authors,
          tags: definition.tags,
        },
      };
    case 'definition.get':
      return { success: true, data: definition };
    case 'runtime.get':
      return {
        success: true,
        data:
          runtime
            .getSnapshot()
            .packages.find((entry) => entry.id === request.packageId) ?? null,
      };
    default:
      return undefined;
  }
}

export async function handleDefaultCommunityPackageCommand(
  request: PackageCommandRequest,
): Promise<PackageCommandResponse | undefined> {
  const runtimeManager = getPackageRuntimeManager();
  const registry = runtimeManager.getRegistry();
  const payload = (request.payload ?? {}) as Record<string, unknown>;

  switch (request.operation) {
    case 'runtime.invalidate':
      runtimeManager.invalidateRuntime('manual', [request.packageId]);
      return {
        success: true,
        data: {
          packageId: request.packageId,
          revision: runtimeManager.getRuntime().getRevision(),
        },
      };
    case 'package.reload':
      if (!registry.hasPackage(request.packageId)) {
        return {
          success: false,
          error: `Package not found: ${request.packageId}`,
        };
      }
      await runtimeManager.reloadPackage(request.packageId);
      return {
        success: true,
        data: {
          packageId: request.packageId,
          revision: runtimeManager.getRuntime().getRevision(),
        },
      };
    case 'package.remove':
    case 'package.removeFromProject': {
      const slug = typeof payload.slug === 'string' ? payload.slug : request.packageId;
      const projectRoot = resolveProjectRoot(getEnv().projectsRoot, request.context.projectId);
      const removed = await uninstallPackageFromProject(slug, projectRoot);
      return {
        success: removed,
        data: { packageId: slug, removed },
        ...(removed ? {} : { error: `Package not found in project: ${slug}` }),
      };
    }
    default:
      return undefined;
  }
}
