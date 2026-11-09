/**
 * Offline upgrade `source-to-folder-v1`: the two folder kinds (`local` on this
 * server, `host` on a paired device) become ONE `folder` kind whose stored
 * `device` picks the transport, and a source's `recognizesPackages` switch
 * becomes its `packageFolders` list — `brain-core/source-config` v3 → v4. The
 * algorithm is brain-core's; this file names it for `scripts/upgrade.mts`.
 *
 * File name: sorts after `source-root-pair-v1.mts` (the chain order of the kind)
 * and after `source-device-v1.mts`, which stamps every host record's device
 * first — a host record that still names none blocks the step.
 */

import type { OfflineUpgradeModule } from '@neuralis/package-system/data';
import { createSourceToFolderUpgrade } from '@neuralis/brain-core/upgrade/source-to-folder';

export default createSourceToFolderUpgrade() satisfies OfflineUpgradeModule;
