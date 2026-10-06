/**
 * Community package dispatch helpers.
 *
 * Handles `@neuralis/package-system` (kernel) introspection queries and
 * package-runtime commands for the community host. The kernel package id is
 * the single canonical surface.
 *
 * All package operations are project-scoped via ProjectPackageScanner.
 */

import type {
  PackageCommandRequest,
  PackageCommandResponse,
  PackageQueryRequest,
  PackageQueryResponse,
} from '@neuralis/package-system';
import { uninstallPackageFromProject } from './packageInstaller';
import { getRuntime } from '../host/bootstrap';
import { getPackageRuntimeManager } from './PackageRuntimeManager';
import { getProjectPackageScanner } from './ProjectPackageScanner';
import { getEnv } from '../config/env';
import { resolveProjectRoot } from '@neuralis/package-system/paths';

export async function handleDefaultCommunityPackageQuery(
  request: PackageQueryRequest,
): Promise<PackageQueryResponse | undefined> {
  if (request.packageId === '@neuralis/package-system') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    switch (request.operation) {
      case 'firstparty.list': {
        const runtime = await getRuntime();
        await runtime.whenReady();
        const loaded = runtime.getLoader().listLoaded();
        return {
          success: true,
          data: loaded.map((pkg) => ({
            packageId: pkg.id,
            hosts: pkg.meta?.hosts ?? [],
            source: 'first-party-catalog',
          })),
        };
      }
      case 'project.list': {
        const projectRoot = resolveProjectRoot(getEnv().projectsRoot, request.context.projectId);
        const scanner = getProjectPackageScanner(projectRoot);
        return {
          success: true,
          data: scanner.listPackages().map((r) => ({
            slug: r.slug,
            packageId: r.packageId,
            packageRoot: r.packageRoot,
            trust: r.trust,
            discoveredAt: r.discoveredAt,
          })),
        };
      }
      default:
        return undefined;
    }
  }

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
