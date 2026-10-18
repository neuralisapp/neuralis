/**
 * Offline upgrade `platform-config-v2`: retired keys leave `platform.json`.
 *
 * The platform config store refuses to write or delete a key no package and no
 * host declaration registers, so a key a build stopped reading stays in the
 * file forever unless an offline step drops it. This module drops an EXPLICIT
 * list of retired keys — never "every unknown key": a key a package registers
 * is unknown here (the script loads no package), and dropping it would erase
 * an operator's setting. The dry run names each key it would drop, never its
 * value. Discovered by `scripts/upgrade.mts`; never imported by the app.
 */

import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { durableReplaceFile, type OfflineUpgradeContext, type OfflineUpgradeModule, type OfflineUpgradePlan } from '@neuralis/package-system/data';
import { HOST_DATA_FORMATS } from '../../src/server/store/dataFormats';

/** Keys no build reads any more: the address of the single host broker that paired devices replaced. */
export const RETIRED_PLATFORM_KEYS = ['hostBrokerSocketPath', 'hostBrokerUrl'] as const;

type Plan = { file: string; drop: string[]; next: Record<string, unknown> | null };

async function plan(ctx: OfflineUpgradeContext): Promise<Plan> {
  const path = join(ctx.appRoot, 'config', 'platform.json');
  const file = relative(ctx.home, path);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file, drop: [], next: null };
    throw error;
  }
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object; fix or remove it, then run this again`);
  }
  const record = parsed as Record<string, unknown>;
  const drop = RETIRED_PLATFORM_KEYS.filter((key) => Object.hasOwn(record, key));
  if (drop.length === 0) return { file, drop, next: null };
  const next = Object.fromEntries(Object.entries(record).filter(([key]) => !drop.includes(key as (typeof RETIRED_PLATFORM_KEYS)[number])));
  return { file, drop, next };
}

function asPlan(p: Plan): OfflineUpgradePlan {
  return {
    files: p.next ? [p.file] : [],
    summary: [p.drop.length > 0 ? `${p.file}: drops the retired key(s) ${p.drop.join(', ')}` : `${p.file}: no retired key`],
  };
}

export function createPlatformConfigUpgrade(): OfflineUpgradeModule {
  return {
    id: 'platform-config-v2',
    kinds: [{ kind: HOST_DATA_FORMATS.platformConfig.kind, to: HOST_DATA_FORMATS.platformConfig.version }],
    dryRun: async (ctx) => asPlan(await plan(ctx)),
    async apply(ctx) {
      // Re-read: the dry run's snapshot is never written back.
      const p = await plan(ctx);
      if (p.next) await durableReplaceFile(join(ctx.home, p.file), JSON.stringify(p.next, null, 2));
      ctx.log(`platform-config-v2: ${p.drop.length > 0 ? `dropped ${p.drop.join(', ')}` : 'nothing to drop'}`);
    },
  };
}

export default createPlatformConfigUpgrade() satisfies OfflineUpgradeModule;
