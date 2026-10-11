/**
 * Offline upgrade `package-identity-v2`: every stored source/local package
 * reference becomes its canonical instance URI (agent-core's algorithm), over
 * the host's own scanner inventory and brain-core's strict source listing.
 * Discovered by `scripts/upgrade.mts`; never imported by the app.
 *
 * A flagged source's root is a CONTAINER path (`/mounts/<slug>`). Inside the
 * image it exists; on the host plane, where the documented command runs, it is
 * reached through the machine-local override's `NEURALIS_MOUNT_*` pairs — read
 * with the kernel's own pair parser and brain-core's longest-prefix derivation,
 * the same two the runtime derives a source's host root with.
 */

import type { PackageSourceRoots, SourceScope } from '@neuralis/package-system/contracts';
import type { OfflineUpgradeContext, OfflineUpgradeModule } from '@neuralis/package-system/data';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverOsMounts, resolveProjectRoot } from '@neuralis/package-system/paths';
import { AppSourceConfigStore, SOURCE_CONFIG_FORMAT, deriveHostRootFromOsMounts } from '@neuralis/brain-core';
import {
  applyPackageIdentityUpgrade,
  describePackageIdentityBlockers,
  describePackageIdentityDrops,
  describePackageIdentityMerges,
  dryRunPackageIdentityUpgrade,
  PACKAGE_IDENTITY_APPLY_REFUSAL,
  PACKAGE_IDENTITY_AGENT_CORE_KINDS,
  type PackageIdentityInstance,
  type PackageIdentityUpgradeDeps,
} from '@neuralis/agent-core/upgrade';
import { BUILTIN_PACKAGE_IDS } from '../../src/server/host/builtinSlots';
import { getProjectPackageScanner, getScannerForDir, type ProjectPackageScanner } from '../../src/server/packages/ProjectPackageScanner';
import { toResolvedRecord } from '../../src/server/packages/packageRecords';
import { selectFlaggedPackageRoots } from '../../src/server/packages/projectPackages';
// The host's own kind declarations (the upgrade command verifies modules against every loaded one).
import { HOST_DATA_FORMATS } from '../../src/server/store/dataFormats';

type ScannerEntry = { scanner: ProjectPackageScanner; ownerScope: SourceScope; uriRoot: string };

/** The `NEURALIS_MOUNT_*` environment lines of the compose override (absent file ⇒ none). */
function overrideMountEnv(overrideFile: string): NodeJS.ProcessEnv {
  // Only the override's pairs — never this process's own environment. (`NODE_ENV` is a required key of the type.)
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  if (!existsSync(overrideFile)) return env;
  for (const match of readFileSync(overrideFile, 'utf8').matchAll(/^\s*-\s*(NEURALIS_MOUNT_[A-Za-z0-9_-]+)=(.*?)\s*$/gm)) env[match[1]!] = match[2]!;
  return env;
}

/** The directory of a flagged root on THIS plane, or one refusal naming every fact the operator needs. */
function planeDirectory(projectId: string, uriRoot: string, containerRoot: string, overrideFile: string): string {
  if (existsSync(containerRoot)) return containerRoot;
  const hostRoot = deriveHostRootFromOsMounts(containerRoot, discoverOsMounts(overrideMountEnv(overrideFile)));
  if (hostRoot && existsSync(hostRoot)) return hostRoot;
  throw new Error([
    `Project ${projectId}: the package source ${uriRoot} cannot be read on this machine.`,
    `Its folder ${containerRoot} does not exist here.`,
    hostRoot ? `The mount pair in ${overrideFile} points it at ${hostRoot}, which does not exist either.` : `No NEURALIS_MOUNT_* pair in ${overrideFile} maps it to a host folder.`,
    `Make the folder reachable (\`neuralis mount add <host-folder> --slug <slug>\`), or clear "recognizes packages" on that source, then run this again.`,
  ].join(' '));
}

function deps(ctx: OfflineUpgradeContext, overrideFile: string): Omit<PackageIdentityUpgradeDeps, 'onPhase'> {
  const logger = { info: (): void => {}, warn: (message: string): void => ctx.log(`warn: ${message}`) };
  const configs = new AppSourceConfigStore(ctx.appRoot);
  const sourceRoots: Pick<PackageSourceRoots, 'listPackageSourceRoots'> = {
    listPackageSourceRoots: (projectId) => configs.listPackageSourceRoots(projectId, resolveProjectRoot(ctx.projectsRoot, projectId)),
  };
  return {
    roots: { home: ctx.home, appRoot: ctx.appRoot, projectsRoot: ctx.projectsRoot },
    sourceRoots,
    builtinIds: BUILTIN_PACKAGE_IDS,
    recordVersions: { project: HOST_DATA_FORMATS.project.version, sourceConfig: SOURCE_CONFIG_FORMAT.version },
    // The activation path's scanners, metadata only: no watcher, no load.
    async enumerateInstances(projectIds, roots): Promise<PackageIdentityInstance[]> {
      const result: PackageIdentityInstance[] = [];
      for (const projectId of projectIds) {
        const entries: ScannerEntry[] = [{ scanner: getProjectPackageScanner(resolveProjectRoot(ctx.projectsRoot, projectId), logger), ownerScope: { kind: 'project' }, uriRoot: 'packages://' }];
        // A disabled flagged source still owns its stored references.
        for (const source of selectFlaggedPackageRoots((await roots.listPackageSourceRoots(projectId)).map((root) => ({ ...root, enabled: true })))) {
          const dir = planeDirectory(projectId, source.uriRoot, source.dir, overrideFile);
          entries.push({ scanner: getScannerForDir(dir, logger), ownerScope: source.ownerScope, uriRoot: source.uriRoot });
        }
        await Promise.all(entries.map((entry) => entry.scanner.scan()));
        const incomplete = entries.find((entry) => !entry.scanner.scanComplete && !(entry.uriRoot === 'packages://' && entry.scanner.missingWithReachableParent));
        if (incomplete) {
          throw new Error(`Project ${projectId}: the package inventory of ${incomplete.uriRoot} (${incomplete.scanner.packagesDir}) could not be read completely.`);
        }
        for (const entry of entries) for (const record of entry.scanner.listPackages()) {
          const resolved = toResolvedRecord(record, projectId, entry.ownerScope, { directory: entry.scanner.packagesDir, uriRoot: entry.uriRoot });
          if (!resolved.originUri) throw new Error('Package instance origin missing');
          result.push({ packageId: resolved.packageId, manifestId: resolved.manifestId, originUri: resolved.originUri, projectId, ownerScope: entry.ownerScope, packageRoot: record.packageRoot });
        }
      }
      return result;
    },
  };
}

/**
 * The module over one compose override. The default export reads the install's
 * own (`<neuralis>/docker-compose.override.yml`); a test passes a fixture, and
 * may interrupt the apply between its steps (`onPhase`) to stage a resume.
 */
export function createPackageIdentityUpgrade(overrideFile: string, options: Pick<PackageIdentityUpgradeDeps, 'onPhase'> = {}): OfflineUpgradeModule {
  return {
    id: 'package-identity-v2',
    // Each kind's target is its owner's declaration — the same constants the rewrite stamps.
    kinds: [
      { kind: HOST_DATA_FORMATS.project.kind, to: HOST_DATA_FORMATS.project.version },
      ...PACKAGE_IDENTITY_AGENT_CORE_KINDS,
      { kind: SOURCE_CONFIG_FORMAT.kind, to: SOURCE_CONFIG_FORMAT.version },
    ],
    async dryRun(ctx) {
      const plan = await dryRunPackageIdentityUpgrade(deps(ctx, overrideFile));
      const count = (...actions: string[]): number => plan.decisions.filter((entry) => actions.includes(entry.decision.action)).length;
      const dropped = describePackageIdentityDrops(plan.decisions);
      const merged = describePackageIdentityMerges(plan.collisions);
      return {
        files: plan.checkpointFiles,
        summary: [
          `${plan.projects.length} project(s), ${plan.recordCount} record(s) read`,
          `references: ${count('rekey')} re-keyed to an instance URI, ${count('keep-builtin', 'keep-archival')} kept verbatim (builtin / archival), ${dropped.length} dropped, ${count('block')} blocking`,
          `data zones: ${plan.zones.length} moved, ${plan.blockers.filter((blocker) => 'zone' in blocker).length} blocking`,
          ...(dropped.length > 0 ? ['Dropped (no instance in the complete inventory) — project · kind · file · field · key:', ...dropped.map((line) => `  ${line}`)] : []),
          ...(merged.length > 0 ? ['Merged (keys of one map naming one instance, identical values) — project · kind · file · field · keys → instance · value:', ...merged.map((line) => `  ${line}`)] : []),
        ],
        blockers: { lines: describePackageIdentityBlockers(plan.blockers), remedy: PACKAGE_IDENTITY_APPLY_REFUSAL },
      };
    },
    apply: (ctx) => applyPackageIdentityUpgrade({ ...deps(ctx, overrideFile), ...options }),
  };
}

export default createPackageIdentityUpgrade(join(import.meta.dirname, '..', '..', 'docker-compose.override.yml')) satisfies OfflineUpgradeModule;
