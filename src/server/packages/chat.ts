/**
 * Community Package Chat Runtime
 *
 * A community host chat-surface-e ugyanarra a package snapshot contractra épül,
 * mint a v1. Ez a wrapper későbbi server-side chat host adapter activationhöz
 * ad egyetlen olvasási pontot.
 */

import type { HostTarget } from '@neuralis/package-system/contracts';
import { getCardSnapshot, getPackageSnapshot } from './snapshot';

export function getChatRuntimeSurface(scope: { host: HostTarget }) {
  const snapshot = getPackageSnapshot(scope);
  const cards = getCardSnapshot(scope);
  const toolCardMap = new Map<string, string>();

  for (const card of cards) {
    for (const toolName of card.match?.tools ?? []) {
      toolCardMap.set(toolName, card.type);
    }
  }

  return {
    cards,
    connectors: snapshot.connectors,
    toolCardMap,
    revision: snapshot.revision,
  };
}
