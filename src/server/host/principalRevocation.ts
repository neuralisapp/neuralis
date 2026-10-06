/**
 * The ONE principal-revocation signal.
 *
 * A principal that may no longer hold a session is already DENIED — no
 * producer builds its `SessionContext` (`server/auth/memberSession.ts`). What
 * that leaves open is the LIVE state it opened before: sockets, running turns,
 * detached runs, refresh tokens. This module turns the two store signals into
 * ONE `PrincipalRevokedEvent` per affected user and closes that state through
 * each owner's EXISTING stop:
 *
 * 1. host-owned state — package asset scopes (the authority, directly), a
 *    DELETED user's notification directories in every project (archived ones
 *    included), and every host listener registered with
 *    {@link onHostPrincipalRevoked}: the `/api/events` hub connections (through
 *    {@link onConnectionPrincipalRevoked});
 * 2. package-owned state — the LOADER's `revokePrincipalForAll`, which calls
 *    every package's `onPrincipalRevoked` hook, each bounded by a timeout (the
 *    `:3101` MCP sessions and OAuth refresh tokens close there, in the package
 *    that owns the MCP companion). This module never walks packages itself.
 *
 * It decides no access and never re-checks a status: a failure here leaves a
 * live connection open until its own clock ends it, never a principal
 * admitted. Nothing runs between transitions (zero standing cost).
 *
 * Mapping: a user deleted (record gone or tombstoned) ⇒ `deleted`; active →
 * disabled ⇒ `disabled`; an ACTIVE user's epoch moved (a password reset) ⇒
 * `sessions_reset` — live sessions close, nothing is swept; a re-enable emits
 * nothing. Members removed ⇒ `membership_removed` per user; a project archived
 * or deleted ⇒ `project_archived` per member. Both project-scoped reasons carry
 * the `projectId`. A changed record (`record_changed` — a rename, a restore)
 * revokes nobody.
 */

import type { PrincipalRevokedEvent } from '@neuralis/package-system/contracts';
import { onUserChange, type UserChangeEvent } from '../store/UserStore';
import { onMembershipChange, type MembershipChangeEvent } from '../store/ProjectStore';
import { getPackageAssetScopeAuthority } from '../packages/PackageAssetScopeAuthority';
import { removeDeletedUserNotifications } from '../notifications/notificationStore';
import { getLogger } from '../logging/setup';

export type HostRevocationListener = (event: PrincipalRevokedEvent) => void | Promise<void>;

/** The package fan-out — the agent-core LOADER's, reached through the bootstrapped instance. */
export type PackageRevocationFanOut = (event: PrincipalRevokedEvent) => Promise<void>;

type RevocationSlot = {
  listeners: Set<HostRevocationListener>;
  stop?: () => void;
};

/**
 * `globalThis`-anchored: the hub route lives in the ROUTE module graph and the
 * store subscription in the INSTRUMENTATION graph; a module-level set would be
 * one set per graph and the close would never arrive.
 */
const SLOT = Symbol.for('@neuralis/host:principalRevocation');

function slot(): RevocationSlot {
  const g = globalThis as { [SLOT]?: RevocationSlot };
  return (g[SLOT] ??= { listeners: new Set() });
}

/** Register a host-owned live-state close. Returns the unregister function. */
export function onHostPrincipalRevoked(listener: HostRevocationListener): () => void {
  slot().listeners.add(listener);
  return () => {
    slot().listeners.delete(listener);
  };
}

/**
 * Close ONE principal-bound connection when the host revokes its principal —
 * user-wide, or in the connection's own project; a revocation in another
 * project leaves it open. Returns the unregister function.
 */
export function onConnectionPrincipalRevoked(
  principal: { userId: string; projectId: string },
  close: () => void,
): () => void {
  return onHostPrincipalRevoked((event) => {
    if (event.userId !== principal.userId) return;
    if (event.projectId !== undefined && event.projectId !== principal.projectId) return;
    close();
  });
}

export function revocationsForUserChange(event: UserChangeEvent): PrincipalRevokedEvent[] {
  const { userId, before, after } = event;
  if (before?.status === 'deleted') return [];
  if (!after || after.status === 'deleted') return before ? [{ userId, reason: 'deleted' }] : [];
  if (!before) return [];
  if (after.status === 'disabled' && before.status === 'active') return [{ userId, reason: 'disabled' }];
  if (after.status === 'active' && before.status === 'active' && after.sessionEpoch !== before.sessionEpoch) {
    return [{ userId, reason: 'sessions_reset' }];
  }
  return [];
}

/**
 * Exhaustive by construction: a new store signal kind must be classified here,
 * never fall into a revoking arm — `record_changed` names EVERY member of a
 * renamed project, and revoking them would close their hubs, streams and tokens.
 */
export function revocationsForMembershipChange(event: MembershipChangeEvent): PrincipalRevokedEvent[] {
  let reason: PrincipalRevokedEvent['reason'];
  switch (event.kind) {
    case 'members_removed':
      reason = 'membership_removed';
      break;
    case 'project_closed':
      reason = 'project_archived';
      break;
    case 'record_changed':
      return [];
    default: {
      const unclassified: never = event;
      throw new Error(`unclassified project signal: ${JSON.stringify(unclassified)}`);
    }
  }
  return event.userIds.map((userId) => ({ userId, projectId: event.projectId, reason }));
}

/**
 * Close one revoked principal's live state: host listeners and asset scopes,
 * then the package fan-out, concurrently. Every failure is logged; none stops
 * another close.
 */
export async function revokePrincipal(
  event: PrincipalRevokedEvent,
  fanOut: PackageRevocationFanOut,
): Promise<void> {
  const log = getLogger().child('principal-revocation');
  const assetScopes = getPackageAssetScopeAuthority().revokeForUser(event.userId, event.projectId);
  const closes = [...slot().listeners].map(async (listener) => listener(event));
  const sweeps = event.reason === 'deleted' ? [removeDeletedUserNotifications(event.userId)] : [];
  const results = await Promise.allSettled([...closes, ...sweeps, fanOut(event)]);
  const failed = results.filter((r) => r.status === 'rejected').length;
  log.info('principal revoked — live state closed', {
    userId: event.userId,
    reason: event.reason,
    ...(event.projectId ? { projectId: event.projectId } : {}),
    assetScopes,
    hostListeners: closes.length,
    failed,
  });
  for (const result of results) {
    if (result.status === 'rejected') {
      log.error('principal revocation close failed', {
        userId: event.userId,
        reason: event.reason,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }
}

/**
 * Subscribe the store signals — idempotent (one subscription per process).
 * `fanOut` resolves the bootstrapped loader lazily, so subscribing BEFORE the
 * bootstrap resolves loses no event.
 */
export function startPrincipalRevocation(fanOut: PackageRevocationFanOut): void {
  const s = slot();
  if (s.stop) return;
  const run = (events: PrincipalRevokedEvent[]): void => {
    for (const event of events) {
      void revokePrincipal(event, fanOut).catch((err) => {
        console.error('[principal-revocation] close failed', err);
      });
    }
  };
  const offUser = onUserChange((e) => run(revocationsForUserChange(e)));
  const offMembership = onMembershipChange((e) => run(revocationsForMembershipChange(e)));
  s.stop = () => {
    offUser();
    offMembership();
    s.stop = undefined;
  };
}

/** Test-only: drop the subscription and every host listener. */
export function resetPrincipalRevocationForTests(): void {
  const s = slot();
  s.stop?.();
  s.listeners.clear();
}
