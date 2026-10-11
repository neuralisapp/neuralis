/**
 * Offline upgrade `vector-proof-v1`: every vector point gets its embedding
 * proof — adopted when its stored vector and inline text match the active
 * generation, otherwise marked for the embedding catch-up. Needs the app
 * STOPPED and Qdrant UP (`docker compose up -d qdrant`); it reads QDRANT_URL /
 * QDRANT_API_KEY the way the runtime does. The algorithm is brain-core's; this
 * file only names it for `scripts/upgrade.mts`.
 */

import type { OfflineUpgradeModule } from '@neuralis/package-system/data';
import vectorProofUpgrade from '@neuralis/brain-core/upgrade/vector-proof';

export default {
  id: 'vector-proof-v1',
  kinds: vectorProofUpgrade.kinds,
  dryRun: (ctx) => vectorProofUpgrade.dryRun(ctx),
  apply: (ctx) => vectorProofUpgrade.apply(ctx),
} satisfies OfflineUpgradeModule;
