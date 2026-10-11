/**
 * Offline upgrade `package-data-zone-v1`: every `data/_installed/<x>/` package
 * zone moves to the mirror path the runtime provisions now
 * (`data/runtime/<scheme>/<leaf>/`, a plain npm package `data/runtime/_npm/<id>/`),
 * without its identity marker. The algorithm is agent-core's; this file wires
 * the host's facts into it — the installed host packages, the identity
 * upgrade's ledger state, the brain source-config version, and the host-owned
 * platform config whose `packageLogLevelOverrides` keys name zones.
 *
 * The FILE NAME is load-bearing: `scripts/upgrade.mts` runs modules in name
 * order, and `package-identity-v2.mts` < `package-zone-v1.mts`, so on an install
 * that needs both the identity upgrade (which writes `_installed/<sha256>` zones)
 * applies first and this one re-enumerates after it. Every dry run still runs
 * before the first apply, so while the identity upgrade is pending or in
 * progress a marker-less zone is ITS input, never an orphan here.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DATA_FORMAT_LEDGER_RELATIVE_PATH,
  durableReplaceFile,
  listDataFormatDeclarations,
  pendingOfflineKinds,
  readDataFormatLedger,
  type OfflineUpgradeContext,
  type OfflineUpgradeModule,
} from '@neuralis/package-system/data';
import { SOURCE_CONFIG_FORMAT } from '@neuralis/brain-core';
import {
  PACKAGE_DATA_ZONE_KINDS,
  createPackageDataZoneUpgrade,
  rewriteLogLevelOverrideKeys,
  type PackageDataZoneUpgradeDeps,
} from '@neuralis/agent-core/upgrade';
import { BUILTIN_PACKAGE_IDS } from '../../src/server/host/builtinSlots';
// The host's own kind declarations (the upgrade command verifies modules against every loaded one).
import { HOST_DATA_FORMATS } from '../../src/server/store/dataFormats';

/** `app/config/platform.json`, as the platform-config kind declares it (home-relative). */
const PLATFORM_CONFIG = HOST_DATA_FORMATS.platformConfig.files[0];

async function platformConfig(ctx: OfflineUpgradeContext): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try { raw = await readFile(join(ctx.home, PLATFORM_CONFIG), 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${PLATFORM_CONFIG} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

async function deps(ctx: OfflineUpgradeContext): Promise<PackageDataZoneUpgradeDeps> {
  const overrides = (await platformConfig(ctx))?.packageLogLevelOverrides;
  return {
    roots: { home: ctx.home, appRoot: ctx.appRoot, projectsRoot: ctx.projectsRoot },
    npmPackageIds: [...BUILTIN_PACKAGE_IDS],
    // Pending or in progress: any kind the identity upgrade owns is behind, absent or `upgrading`.
    // Reads the ledger and its existence bit itself (two reads per call; the kernel records the bit only on its own first read).
    async identityUpgradePending() {
      const ledger = await readDataFormatLedger(ctx.appRoot);
      const existed = existsSync(join(ctx.appRoot, DATA_FORMAT_LEDGER_RELATIVE_PATH));
      const identity = listDataFormatDeclarations().filter((decl) => decl.upgrade?.id === HOST_DATA_FORMATS.project.upgrade.id);
      return pendingOfflineKinds(ledger, existed, identity).length > 0;
    },
    sourceConfigVersion: SOURCE_CONFIG_FORMAT.version,
    extraCheckpointFiles: typeof overrides === 'string' && overrides.length > 0 ? [PLATFORM_CONFIG] : [],
    async rewriteLogLevelOverrides(prefixes) {
      const config = await platformConfig(ctx);
      const value = config?.packageLogLevelOverrides;
      if (!config || typeof value !== 'string' || value.length === 0) return;
      const next = rewriteLogLevelOverrideKeys(value, prefixes);
      // The store's own serialization (`PlatformConfigStore` writes `JSON.stringify(data, null, 2)`).
      if (next !== value) await durableReplaceFile(join(ctx.home, PLATFORM_CONFIG), JSON.stringify({ ...config, packageLogLevelOverrides: next }, null, 2));
    },
  };
}

/** The module; a test may interrupt the apply between its steps (`onPhase`) to stage a resume. */
export function createPackageZoneUpgrade(options: Pick<PackageDataZoneUpgradeDeps, 'onPhase'> = {}): OfflineUpgradeModule {
  return {
    id: 'package-data-zone-v1',
    kinds: PACKAGE_DATA_ZONE_KINDS,
    dryRun: async (ctx) => createPackageDataZoneUpgrade(await deps(ctx)).dryRun(),
    apply: async (ctx) => createPackageDataZoneUpgrade({ ...await deps(ctx), ...options }).apply(),
  };
}

export default createPackageZoneUpgrade() satisfies OfflineUpgradeModule;
