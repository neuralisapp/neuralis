/**
 * Offline upgrade `source-to-host-v1`: the ONE folder kind is spelled `host`
 * (`brain-core/source-config` v4 → v5), and the device plane is spelled
 * `device` wherever it is stored and read back — an `execute` result in a
 * conversation log (`agent-core/conversation-messages` v1 → v2) and a
 * background shell's record (`agent-core/shell-run` v1 → v2). One upgrade, one
 * checkpoint. The algorithms are brain-core's and agent-core's; this file names
 * them for `scripts/upgrade.mts`.
 *
 * File name: sorts after `source-to-folder-v1.mts` (`h` > `f`), the step before
 * it in the source-config chain.
 */

import type { OfflineUpgradeModule } from '@neuralis/package-system/data';
import {
  SOURCE_TO_HOST_STEP,
  applySourceToHost,
  inspectSourceToHost,
  sourceToHostSummary,
} from '@neuralis/brain-core/upgrade/source-to-host';
import {
  PLANE_VOCABULARY_KINDS,
  applyPlaneVocabulary,
  inspectPlaneVocabulary,
  planeVocabularySummary,
} from '@neuralis/agent-core/upgrade';

export default {
  id: SOURCE_TO_HOST_STEP.id,
  kinds: [{ kind: SOURCE_TO_HOST_STEP.kind, to: SOURCE_TO_HOST_STEP.to }, ...PLANE_VOCABULARY_KINDS],
  async dryRun(ctx) {
    const sources = sourceToHostSummary(await inspectSourceToHost(ctx));
    const census = await inspectPlaneVocabulary(ctx);
    return {
      files: [...sources.files, ...census.rewrites.map((row) => row.file)],
      summary: [...sources.summary, ...planeVocabularySummary(census)],
    };
  },
  async apply(ctx) {
    const written = await applySourceToHost(ctx, await inspectSourceToHost(ctx));
    const planes = await applyPlaneVocabulary(ctx);
    ctx.log(`${SOURCE_TO_HOST_STEP.id}: ${written} source config(s) rewritten; ${planes.files} log/shell file(s), ${planes.pairs} plane value(s) → device`);
  },
} satisfies OfflineUpgradeModule;
