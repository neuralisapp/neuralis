/**
 * Offline upgrade `source-root-pair-v1`: every `local` source's absolute root
 * gets the missing half of its pair (`root` inside the container, `hostRoot`
 * for a native host) wherever one derives, and every source config is stamped
 * `brain-core/source-config` v3. The algorithm is brain-core's; this file names
 * it for `scripts/upgrade.mts` and hands it this process's plane facts.
 *
 * The plane is the runtime stack of THIS run, over the command's data home:
 * inside the container (`docker compose run`) its environment carries
 * `NEURALIS_HOST_HOME` and the mount pairs; on the host, the data home is the
 * machine home and a Docker install's mount pairs are read from its compose
 * override (the same parser `package-identity-v2` reads them with). File name:
 * sorts after `package-identity-v2.mts`, the chain order of the kind.
 */

import { join } from 'node:path';
import type { OfflineUpgradeModule } from '@neuralis/package-system/data';
import { discoverRuntimeStack } from '@neuralis/package-system/paths';
import { createSourceRootPairUpgrade } from '@neuralis/brain-core/upgrade/source-root-pair';
import { overrideMountEnv } from './package-identity-v2.mts';

/** The step over one compose override and one environment (a test passes both). */
export function createSourceRootPairStep(overrideFile: string, env: NodeJS.ProcessEnv = process.env): OfflineUpgradeModule {
  return createSourceRootPairUpgrade((ctx) => discoverRuntimeStack(
    { ...overrideMountEnv(overrideFile), ...env },
    { home: ctx.home, appRoot: ctx.appRoot, projectsRoot: ctx.projectsRoot },
  ));
}

export default createSourceRootPairStep(join(import.meta.dirname, '..', '..', 'docker-compose.override.yml')) satisfies OfflineUpgradeModule;
