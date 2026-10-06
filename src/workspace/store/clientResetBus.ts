/**
 * The client-state reset bus — how the dock's broom reaches a PACKAGE's client
 * store without the host importing that package.
 *
 * The 3-level clean (`closeWidget` at widget level, `cleanAgentStore`,
 * `cleanProjectStore`) drops the host runtime; a package that keeps its own
 * client store keyed on the active (project, agent) pair (brain-core's Files
 * store, persisted tabs included) subscribes here through the kernel port
 * (`WorkspaceHostPort.onClientStateReset`) and resets itself. The host stays
 * generic: it names a scope, never a package. Fan-out is fail-soft — one
 * throwing subscriber is logged and the rest still run, like `FsWatchHub`.
 *
 * The store emits AFTER its own `set()` has landed (the port's reentrancy rule:
 * a handler must not call the host back — it runs inside the action).
 */

import type { ClientStateResetScope } from '@neuralis/package-system/contracts';

type ClientStateResetHandler = (scope: ClientStateResetScope) => void;

const handlers = new Set<ClientStateResetHandler>();

export function subscribeClientStateReset(handler: ClientStateResetHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export function emitClientStateReset(scope: ClientStateResetScope): void {
  // Snapshot the set: a handler that unsubscribes itself must not disturb the walk.
  for (const handler of Array.from(handlers)) {
    try {
      handler(scope);
    } catch (e) {
      console.error('[workspace] client-state reset handler failed', scope.level, e);
    }
  }
}
