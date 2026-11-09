/**
 * Offline upgrade `stored-device-codes-v1`: an `execute` refusal stored in a
 * conversation log takes the device vocabulary — `host_plane_denied` →
 * `device_denied`, `container_plane_denied` → `local_denied`,
 * `host_plane_disabled` → `devices_disabled` (`agent-core/conversation-messages`
 * v2 → v3). Only the stored `"code"` pair moves; a code quoted inside text is
 * history and stays. The algorithm is agent-core's; this file names it for
 * `scripts/upgrade.mts`.
 *
 * File name: sorts after `source-to-host-v1.mts` (`st` > `so`), the step before
 * it in the conversation-messages chain.
 */

import type { OfflineUpgradeModule } from '@neuralis/package-system/data';
import { DEVICE_CODES_KINDS, applyDeviceCodes, deviceCodesSummary, inspectDeviceCodes } from '@neuralis/agent-core/upgrade';

export default {
  id: 'stored-device-codes-v1',
  kinds: [...DEVICE_CODES_KINDS],
  async dryRun(ctx) {
    const census = await inspectDeviceCodes(ctx);
    return { files: census.rewrites.map((row) => row.file), summary: deviceCodesSummary(census) };
  },
  async apply(ctx) {
    const done = await applyDeviceCodes(ctx);
    ctx.log(`stored-device-codes-v1: ${done.files} conversation log(s), ${done.pairs} stored code(s) renamed`);
  },
} satisfies OfflineUpgradeModule;
