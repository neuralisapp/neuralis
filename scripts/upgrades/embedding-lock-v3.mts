/**
 * Offline upgrade `embedding-lock-v3`: brain-core's embedding generation lock
 * to format 3. The algorithm is brain-core's; this file only names it for
 * `scripts/upgrade.mts`.
 */

import type { OfflineUpgradeModule } from '@neuralis/package-system/data';
import embeddingLockUpgrade from '@neuralis/brain-core/upgrade';

export default {
  id: 'embedding-lock-v3',
  kinds: embeddingLockUpgrade.kinds,
  dryRun: (ctx) => embeddingLockUpgrade.dryRun(ctx),
  apply: (ctx) => embeddingLockUpgrade.apply(ctx),
} satisfies OfflineUpgradeModule;
