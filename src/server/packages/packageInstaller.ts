/**
 * Community package installer — project-scoped.
 *
 * Packages are installed into {projectRoot}/_packages/{slug}/.
 * The ProjectPackageScanner detects changes and syncs to runtime.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { PackageDefinition, PackageSourceKind } from '@neuralis/package-system/contracts';
import {
  discoverPackageSource,
  type DiscoveredPackageSource,
} from './sourceDiscovery';
import { getProjectPackageScanner } from './ProjectPackageScanner';
import type { ProjectPackageRecord } from './packageRecords';
import { resyncProjectPackages } from './projectPackages';
import { getEnv, resolveProjectPackagesDir } from '../config/env';

export type InstallPackageInput = {
  definition?: PackageDefinition;
  definitionPath?: string;
  sourceRoot?: string;
  installMode?: 'reference' | 'copy';
  source?: Extract<PackageSourceKind, 'local-dir' | 'mounted-dir' | 'git' | 'mcp-server'>;
  gitRepository?: string;
  gitRef?: string;
  mcpServerUrl?: string;
  mcpServerName?: string;
  mcpServerAuth?: 'none' | 'api-key' | 'oauth2';
  scope?: {
    userId: string;
    projectId: string;
    agentId?: string;
  };
};

import { basename } from 'node:path';

function packageSlug(packageId: string): string {
  return packageId.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

/** Extract projectId from projectRoot path (last segment). */
function deriveProjectId(projectRoot: string): string {
  return basename(projectRoot);
}

export function inspectInstallablePackage(input: InstallPackageInput): DiscoveredPackageSource {
  return discoverPackageSource(input);
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function realOrResolved(path: string): string {
  const resolved = resolve(path);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

export function assertInstallSourceAllowed(input: InstallPackageInput, projectRoot: string): void {
  const env = getEnv();
  const appRoot = realOrResolved(env.appRoot);
  const targetPackagesDir = realOrResolved(resolveProjectPackagesDir(projectRoot));
  const candidates = [
    input.sourceRoot,
    input.definitionPath ? dirname(input.definitionPath) : undefined,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

  for (const candidate of candidates) {
    const resolved = realOrResolved(candidate);
    if (isInside(appRoot, resolved)) {
      throw new Error('Package install source cannot be inside the Neuralis app data directory');
    }
    if (isInside(targetPackagesDir, resolved)) {
      throw new Error('Package install source cannot be inside the target project package directory');
    }
  }
}

/**
 * Install a package into the project's `_packages/` directory.
 * Copies content from source, triggers scanner rescan, and syncs to runtime.
 */
export async function installPackageToProject(
  input: InstallPackageInput,
  projectRoot: string,
  projectId?: string,
): Promise<ProjectPackageRecord> {
  assertInstallSourceAllowed(input, projectRoot);
  const resolved = inspectInstallablePackage(input);
  const slug = packageSlug(resolved.definition.id);
  const packagesDir = resolveProjectPackagesDir(projectRoot);
  const targetDir = join(packagesDir, slug);

  // Copy package content to _packages/{slug}/
  const sourceDir = input.sourceRoot
    ? resolve(input.sourceRoot)
    : resolved.sourceRoot
      ? resolve(resolved.sourceRoot)
      : undefined;

  if (sourceDir && existsSync(sourceDir)) {
    mkdirSync(targetDir, { recursive: true });
    cpSync(sourceDir, targetDir, { recursive: true, force: true });
  } else if (input.definition) {
    // Inline definition only — write manifest
    mkdirSync(targetDir, { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(targetDir, 'package.json'),
      JSON.stringify({ name: slug, neuralis: input.definition }, null, 2),
      'utf-8',
    );
  } else {
    throw new Error('installPackageToProject requires sourceRoot or definition');
  }

  // Auto-build WASM if package requires it
  try {
    const manifestPath = join(targetDir, 'package.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const runtimeType = manifest?.neuralis?.runtime?.type;

      // A project drop declaring `mcp` (or `node`) is skipped here because
      // there is nothing to BUILD, not because it is exempt from anything.
      // Both are first-party-only code runtimes and a `_packages/` drop is
      // pinned to `untrusted` by `ProjectPackageScanner`, so the loader will
      // demote it (`untrusted-mcp` / `untrusted-node`) and run no code. Say so
      // at install time: the operator otherwise sees a package install cleanly
      // and then quietly do nothing, with the reason only in the host log.
      if (runtimeType === 'mcp' || runtimeType === 'node') {
        console.warn(
          `[packageInstaller] ${slug} declares runtime.type "${runtimeType}", which requires ` +
          `first-party trust — a project drop loads its declarative contributions only. ` +
          `Declare "wasm" to run code.`,
        );
      }

      if (runtimeType === 'wasm' || (runtimeType !== 'mcp' && runtimeType !== 'node')) {
        const { hasSourceCode, buildWasmPackage } = await import('@neuralis/package-system/runtime/wasm-build');
        const { resolveGuestPdkPath } = await import('@/server/host/builtinSlots');
        if (hasSourceCode(targetDir)) {
          // Host-resolved PDK path (bundling-immune) — see the build route / BUG B.
          await buildWasmPackage(targetDir, { pdkGuestPath: resolveGuestPdkPath() });
        }
      }
    }
  } catch (err) {
    console.warn(`[packageInstaller] WASM build failed for ${slug} — declarative contributions still loaded`, String(err));
  }

  // One sync over EVERY scanner of the project: a sync fed only the drop-zone
  // would unload the project's source packages and drop their trust overrides.
  await resyncProjectPackages(projectId ?? deriveProjectId(projectRoot));
  const record = getProjectPackageScanner(projectRoot).getPackage(slug);
  if (!record) {
    throw new Error(`Package installed but scanner failed to resolve: ${slug}`);
  }

  return record;
}

/**
 * Remove a package from the project's `_packages/` directory.
 */
export async function uninstallPackageFromProject(
  slugOrPackageId: string,
  projectRoot: string,
  projectId?: string,
): Promise<boolean> {
  const scanner = getProjectPackageScanner(projectRoot);
  const record = scanner.getPackage(slugOrPackageId)
    ?? scanner.getPackageById(slugOrPackageId);

  if (!record) return false;

  const targetDir = join(resolveProjectPackagesDir(projectRoot), record.slug);
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
  }

  await resyncProjectPackages(projectId ?? deriveProjectId(projectRoot));

  return true;
}
