/**
 * Community package runtime ownership.
 *
 * The host no longer mutates the registry directly. All installed package
 * lifecycle changes flow through PackageRuntimeManager -> agent-core loader.
 */

import type { PackageRegistry, PackageRuntime } from '@neuralis/package-system';
import { getPackageRuntimeManager } from './PackageRuntimeManager';

/**
 * Ensure the community runtime is initialized before using the sync getters.
 */
export async function ensureCommunityRuntime(): Promise<{
  registry: PackageRegistry;
  runtime: PackageRuntime;
}> {
  const manager = getPackageRuntimeManager();
  const state = await manager.ensureInitialized();
  return {
    registry: state.registry,
    runtime: state.runtime,
  };
}

export function getCommunityPackageRegistry(): PackageRegistry {
  return getPackageRuntimeManager().getRegistry();
}

export function getCommunityPackageRuntime(): PackageRuntime {
  return getPackageRuntimeManager().getRuntime();
}
