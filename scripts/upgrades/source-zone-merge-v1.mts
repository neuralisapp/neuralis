/**
 * Offline upgrade `source-zone-merge-v1` (`brain-core/source-config` v7 → v8):
 * a seed-shaped folder at the Neuralis tree's `skills/` joins the tree source
 * (`neuralis`); every other one is listed, untouched. The algorithm is
 * brain-core's; the record census it checks for package-instance references
 * is agent-core's (read only). This file names them for `scripts/upgrade.mts`.
 *
 * File name: sorts after `source-use-grants-v1.mts` (`z` > `u`), the step
 * before it in the source-config chain.
 */

import type { OfflineUpgradeContext, OfflineUpgradeModule } from '@neuralis/package-system/data';
import {
  SOURCE_ZONE_MERGE_STEP,
  applySourceZoneMerge,
  inspectSourceZoneMerge,
  sourceZoneMergeSummary,
  zoneMergeReferences,
  type ZoneMergeReferenceFile,
} from '@neuralis/brain-core/upgrade/source-zone-merge';
import { enumerateAgentIdentityFiles } from '@neuralis/agent-core/upgrade';

/** The census, or `null` when it cannot be read — the step then lists instead of merging, and never stops the chain. */
async function census(ctx: OfflineUpgradeContext): Promise<readonly ZoneMergeReferenceFile[] | null> {
  try {
    return await enumerateAgentIdentityFiles(ctx);
  } catch (error) {
    ctx.log(`${SOURCE_ZONE_MERGE_STEP.id}: record census unreadable (${error instanceof Error ? error.message : String(error)}) — every skills folder is listed, none merged`);
    return null;
  }
}

const inspect = async (ctx: OfflineUpgradeContext) => inspectSourceZoneMerge(ctx, zoneMergeReferences(ctx, await census(ctx)));

export default {
  id: SOURCE_ZONE_MERGE_STEP.id,
  kinds: [{ kind: SOURCE_ZONE_MERGE_STEP.kind, to: SOURCE_ZONE_MERGE_STEP.to }],
  async dryRun(ctx) {
    return sourceZoneMergeSummary(await inspect(ctx));
  },
  async apply(ctx) {
    const { written, removed } = await applySourceZoneMerge(ctx, await inspect(ctx));
    ctx.log(`${SOURCE_ZONE_MERGE_STEP.id}: ${written} source config(s) written, ${removed} merged or dropped skills folder(s) removed`);
  },
} satisfies OfflineUpgradeModule;
