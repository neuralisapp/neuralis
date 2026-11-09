/**
 * GET /api/events — the unified workspace notification stream.
 *
 * ONE multiplexed SSE connection that fans nine low-rate channels out to the
 * client over a single HTTP/1.1 connection:
 *   - `runtime`      — package-runtime invalidation (host PackageRuntime)
 *   - `presence`     — project user presence (agent-core `presenceBus`)
 *   - `workflow`     — calendar/workflow run events (agent-core, feature + M9 gated)
 *   - `conversation` — transcript-growth SIGNALS (agent-core; coordinates + seq
 *                      bounds, never message content), so a turn no browser is
 *                      driving reaches an open tab
 *   - `filesystem`   — file change / sync events (brain-core, per-agent authorized)
 *   - `devices`      — a paired device's state transition (agent-core; `{deviceId,
 *                      status}` only, for a device the caller owns, may list
 *                      platform-wide, or sees a source of in this project)
 *   - `project`      — a project record this user is (or just was) a member of
 *                      changed (host `ProjectStore`; the payload is the project id
 *                      only, the client re-reads its own projected list)
 *   - `notifications` — this user's unread notification COUNTS changed in one of
 *                      their projects (host notification service; the payload is
 *                      `{ projectId, unread: { total, byDock } }` — numbers, never
 *                      a row; the client re-reads rows through the gated
 *                      `/api/notifications` route). Host-only: not a kernel
 *                      `subscribeRealtime` channel.
 *   - `members`      — who is online changed in this project (host presence
 *                      registry; the payload is `{ projectId }` only, the client
 *                      re-reads `GET /api/presence`). Host-only, like
 *                      `notifications`.
 *
 * Every connection is also a CLIENT in the host's in-memory presence registry
 * (`server/presence/clientRegistry.ts`) from open to teardown — a browser or the
 * desktop window by its user agent (a label, never stored raw), a bearer
 * connection under its token's grant. The registry entry goes with the same
 * teardown, so a revocation that closes the connection drops it too.
 *
 * WHY: the host is served over HTTP/1.1 (no proxy), where browsers cap ~6
 * connections per origin. The workspace previously opened a SEPARATE EventSource
 * per channel (plus one per chat widget for workflow), so during a chat stream
 * the pool saturated and every other widget's fetch queued for ~15s. Collapsing
 * the feeds here leaves a streaming workspace at ≤2 long-lived connections
 * (this hub + the chat token stream). The heavy POST chat token stream stays
 * SEPARATE — its AbortController+drain lifecycle is bound to a dedicated
 * connection and must not be merged.
 *
 * SECURITY: auth runs ONCE at connect via `resolveSessionContext` (every catch-all
 * deny gate; 403 BEFORE the stream is constructed — F8): the browser's cookie,
 * or — for an external client such as `neuralis device list --watch`, and only
 * when no cookie is present — the client's OAuth access token for the host API
 * resource (`routes:call`; its project and agent are the token's, a supplied
 * `projectId` may only agree; an `nrs1.` ticket is refused). A bearer connection
 * CLOSES when its access token expires; the client renews and reconnects. And
 * EACH channel keeps
 * its own per-event authorization: presence is membership-gated at connect;
 * workflow applies BOTH halves of its route's gate — the module feature
 * (`workflow.read`) AND the M9 `isWorkflowVisibleTo` filter per event; conversation
 * pairs its module feature (`core.execute`) with the per-conversation uri-policy
 * read check, re-minted on a short TTL — both inside agent-core's adapters;
 * filesystem authorizes EACH requested agentId deny-by-default inside the brain-core
 * adapter; devices pairs its module feature (`core.agents`) with the device rule
 * per event (owner · `platform.users` · a source visible in this project) inside
 * agent-core; project is membership-gated per event inside the host store;
 * notifications reaches only the recipient user's own connections. No channel can emit an event the per-route gate would block. The
 * connection itself CLOSES when the host revokes its principal (disabled,
 * deleted, sessions reset, removed from or archived out of this project) —
 * `server/host/principalRevocation.ts`; the client's reconnect then meets the
 * refused session producer.
 * Package feeds come from the runtime channel contracts — the buses are resolved
 * through the bootstrapped package instances (the globalThis+Symbol.for anchors),
 * never re-`new`ed.
 *
 * `?channels=a,b` NARROWS the connection to those channels (an intersection —
 * it never adds one the caller's gates refuse); absent, every channel rides.
 *
 * Frame shape: every event (the `meta` keepalive too) is `event: message` with
 * JSON `{ channel, name, payload }`; the client demuxes by `channel`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getRuntime } from '@/server/host/bootstrap';
import { ensureCommunityRuntime, getCommunityPackageRuntime } from '@/server/packages/runtime';
import { ensureProjectPackagesLoaded } from '@/server/packages/projectPackages';
import { resolveSessionContext, SessionResolutionError } from '@/server/auth/resolveSessionContext';
import { getPlatformConfigStore } from '@/server/store/PlatformConfigStore';
import { onConnectionPrincipalRevoked } from '@/server/host/principalRevocation';
import { onProjectRecordChange } from '@/server/store/ProjectStore';
import { onNotificationCounts } from '@/server/notifications/notificationStore';
import { hasFeature } from '@neuralis/package-system/access';
import { cookieClientKind, onMembersPresenceChange, openHubClient } from '@/server/presence/clientRegistry';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // long-lived SSE

/** Keepalive interval — `sseHeartbeatMs` platform key, read per connection.
 *  Must stay below the client watchdog's 60s STALE_MS (max 55s enforced by
 *  the declaration bounds); the keepalive is a `meta` frame the watchdog sees. */
function heartbeatMs(): number {
  try {
    return Number(getPlatformConfigStore().get('sseHeartbeatMs')) || 25_000;
  } catch {
    return 25_000;
  }
}

function csv(value: string | null): string[] {
  return (value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** The longest delay `setTimeout` honours; a later expiry is re-armed, never fired early. */
const MAX_TIMER_MS = 2_147_483_647;

export async function GET(req: NextRequest): Promise<Response> {
  const projectId = req.nextUrl.searchParams.get('projectId') ?? '';

  // F8 — auth (every deny gate) BEFORE constructing the stream.
  let session;
  let bearerExpiresAt: number | undefined;
  let bearerGrant: { clientId: string; grantId?: string } | undefined;
  try {
    session = await resolveSessionContext(req, projectId, {
      acceptBearer: true,
      onBearer: (grant) => {
        bearerExpiresAt = grant.expiresAt;
        bearerGrant = { clientId: grant.clientId, ...(grant.grantId ? { grantId: grant.grantId } : {}) };
      },
    });
  } catch (err) {
    if (err instanceof SessionResolutionError) {
      return NextResponse.json({ error: err.message }, { status: err.status, ...(err.headers ? { headers: err.headers } : {}) });
    }
    throw err;
  }
  // The bearer arm binds the connection to the TOKEN's project.
  const boundProjectId = session.projectId;
  const wanted = req.nextUrl.searchParams.has('channels') ? new Set(csv(req.nextUrl.searchParams.get('channels'))) : null;
  const rides = (channel: string): boolean => wanted === null || wanted.has(channel);

  const agentIds = csv(req.nextUrl.searchParams.get('agentIds'));
  const types = csv(req.nextUrl.searchParams.get('types'));

  await ensureCommunityRuntime();
  await ensureProjectPackagesLoaded(boundProjectId);
  const runtime = getCommunityPackageRuntime();
  const core = await getRuntime();
  await core.whenReady();

  const encoder = new TextEncoder();
  const unsubscribers: Array<() => void> = [];
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const teardown = (): void => {
    for (const unsub of unsubscribers.splice(0)) {
      try { unsub(); } catch { /* ignore */ }
    }
    if (heartbeat) clearInterval(heartbeat);
    if (expiry) clearTimeout(expiry);
  };

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (channel: string, name: string, payload: unknown): void => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: message\ndata: ${JSON.stringify({ channel, name, payload })}\n\n`),
          );
        } catch {
          closed = true;
        }
      };

      // runtime — process-global invalidation signal (no project payload).
      if (rides('runtime')) {
        send('runtime', 'snapshot', { revision: runtime.getRevision() });
        unsubscribers.push(
          runtime.onInvalidation((event) =>
            send('runtime', 'invalidated', { revision: event.newRevision, reason: event.reason }),
          ),
        );
      }

      // Package channels retain their per-event scope gates. The declared
      // entry feature is checked before any subscription or replay runs.
      for (const channel of core.channels()) {
        if (!rides(channel.channel) || !hasFeature(session, channel.feature)) continue;
        try {
          const unsubscribe = await channel.subscribe(session, { projectId: boundProjectId, agentIds, types },
            (name, payload) => send(channel.channel, name, payload));
          unsubscribers.push(unsubscribe);
        } catch {
          // One unavailable package feed must not kill the other channels.
        }
      }

      // project — gated in the store: only records this user is a member of,
      // and the frame carries the id alone. It deliberately reaches a hub bound
      // to ANOTHER of the user's projects, so a rename refreshes the switcher.
      if (rides('project')) {
        unsubscribers.push(
          onProjectRecordChange(session.userId, ({ projectId: changed }) =>
            send('project', 'record_changed', { projectId: changed }),
          ),
        );
      }

      // notifications — the store delivers a user's counts to that user's own
      // listeners only; like `project`, it reaches a hub bound to another of
      // the user's projects (the switcher's per-row number).
      if (rides('notifications')) {
        unsubscribers.push(
          onNotificationCounts(session.userId, ({ projectId: changed, unread }) =>
            send('notifications', 'counts', { projectId: changed, unread }),
          ),
        );
      }

      // A DATA frame, never an SSE comment: an EventSource dispatches no event
      // for a `:` line, so the client's staleness watchdog would read an idle
      // hub as dead and reopen it (with a held-transcript resume) every minute.
      heartbeat = setInterval(() => send('meta', 'keepalive', {}), heartbeatMs());
      heartbeat.unref?.();

      // A server-side close — the teardown `cancel` would run is run here.
      const closeFromServer = (): void => {
        if (closed) return;
        closed = true;
        teardown();
        try { controller.close(); } catch { /* already closed */ }
      };
      // members — who is online changed in this project (content-free).
      if (rides('members')) {
        unsubscribers.push(
          onMembersPresenceChange(boundProjectId, () => send('members', 'changed', { projectId: boundProjectId })),
        );
      }

      // This connection is a client of its user while it stays open.
      const client = bearerGrant
        ? { kind: 'other' as const, label: 'External client', clientId: bearerGrant.clientId, ...(bearerGrant.grantId ? { grantId: bearerGrant.grantId } : {}) }
        : cookieClientKind(req.headers.get('user-agent'));
      unsubscribers.push(openHubClient({ userId: session.userId, projectId: boundProjectId, ...client }));

      // Principal revocation.
      unsubscribers.push(onConnectionPrincipalRevoked({ userId: session.userId, projectId: boundProjectId }, closeFromServer));
      // A bearer connection lives no longer than its access token.
      if (bearerExpiresAt !== undefined) {
        const armExpiry = (): void => {
          const left = bearerExpiresAt! - Date.now();
          if (left <= 0) { closeFromServer(); return; }
          expiry = setTimeout(armExpiry, Math.min(left, MAX_TIMER_MS));
          expiry.unref?.();
        };
        armExpiry();
      }

      send('meta', 'connected', {});
    },
    cancel() {
      teardown();
    },
  });

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
