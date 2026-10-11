/**
 * Offline upgrade `conversation-summary-v2`: a conversation whose `summary` is
 * the v1 shape is rewritten to the v2 record the runtime reads. The algorithm
 * is agent-core's; this file only names it for `scripts/upgrade.mts`.
 */

import type { OfflineUpgradeModule } from '@neuralis/package-system/data';
import {
  CONVERSATION_SUMMARY_KINDS,
  applyConversationSummaryUpgrade,
  dryRunConversationSummaryUpgrade,
} from '@neuralis/agent-core/upgrade';

export default {
  id: 'conversation-summary-v2',
  kinds: CONVERSATION_SUMMARY_KINDS,
  dryRun: (ctx) => dryRunConversationSummaryUpgrade(ctx),
  apply: (ctx) => applyConversationSummaryUpgrade(ctx),
} satisfies OfflineUpgradeModule;
