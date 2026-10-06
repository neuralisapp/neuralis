/**
 * GET /api/notifications — the caller's notification rows in the
 * `X-Project-Id` project, newest first.
 *
 * Query: `limit` (1–100, default 30), `before` (a seq — page backwards),
 * `unread=1` (unread rows only), and at most one of
 * - `group=<key>` — one app's rows (`<packageId>:<dock>`, or the bare package
 *   id for rows without a dock). A page is cut BEFORE the re-judge, so it may
 *   come back short; `nextBefore` (non-null while the stored window has more)
 *   is what says "more".
 * - `groups=<n>` (1–30) — the inbox shape: `{ groups: [{ key, packageId,
 *   dock?, total, unread, rows }] }`, one entry per app in the order of its
 *   newest row, `total`/`unread` counting the visible ENTRIES (a merged row
 *   counts once; `total` read or not — what a clear of the app deletes) and
 *   `rows` its newest `n`. With `unread=1`, `rows` are unread ones and an app
 *   with nothing unread is left out; `total` still counts every entry. Reads
 *   and judges the whole stored window (≤ `notificationsMaxRowsPerUser` rows)
 *   once.
 *
 * A stored row outlives a revocation, so every row is RE-JUDGED on read with
 * the caller's CURRENT session — package visible to them, the declaration's
 * features, the owning package's own predicate; a row that fails any of them
 * is silently left out (no 403 per row, which would announce what is hidden).
 * A row whose event type is no longer declared is left out too.
 *
 * This GET can WRITE: an unread row the re-judge DENIES (the package hidden
 * from the caller, or a feature the declaration requires revoked — never a
 * predicate that cannot judge yet) loses its unread entry, so the badge
 * numbers heal on the next list read. The order is judge → drop → group →
 * answer. Its CSRF floor is the required `X-Project-Id` header, which a
 * cross-site form cannot set.
 */

import { NextResponse, type NextRequest } from 'next/server';
import type { NeuralisEvent } from '@neuralis/package-system/contracts';
import { getRuntime } from '@/server/host/bootstrap';
import {
  groupNotificationViews,
  listNotifications,
  markNotificationsRead,
  type NotificationView,
} from '@/server/notifications/notificationStore';
import { mayReadEvent, type EventReadVerdict } from '@/server/notifications/materializer';
import { resolveNotificationReader } from '@/server/notifications/notificationReader';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;
const MAX_GROUP_ROWS = 30;
const MAX_GROUP_KEY_CHARS = 300;

function intParam(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const caller = await resolveNotificationReader(req);
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });
  const { session, project } = caller.member;

  const params = req.nextUrl.searchParams;
  const limit = Math.min(MAX_LIMIT, Math.max(1, intParam(params.get('limit')) ?? DEFAULT_LIMIT));
  const before = intParam(params.get('before'));
  const unreadOnly = params.get('unread') === '1';
  const group = params.get('group');
  const groupsParam = params.get('groups');
  if (group !== null && (group.length === 0 || group.length > MAX_GROUP_KEY_CHARS)) {
    return NextResponse.json({ error: 'group must be 1–300 characters' }, { status: 400 });
  }
  if (group !== null && groupsParam !== null) {
    return NextResponse.json({ error: 'group and groups are exclusive' }, { status: 400 });
  }
  const perGroup = groupsParam === null ? undefined : intParam(groupsParam);
  if (groupsParam !== null && (perGroup === undefined || perGroup < 1 || perGroup > MAX_GROUP_ROWS)) {
    return NextResponse.json({ error: 'groups must be 1–30' }, { status: 400 });
  }

  const rows = await listNotifications(session.projectId, session.userId, {
    ...(perGroup === undefined ? { limit } : {}),
    before,
    // The inbox shape reads the whole window on both tabs: a group's `total`
    // is every entry a clear of it deletes, never only the unread ones.
    unreadOnly: perGroup === undefined && unreadOnly,
    ...(group !== null ? { group } : {}),
  });
  const runtime = await getRuntime();
  const events = runtime.events();

  const verdicts = new Map<string, Promise<EventReadVerdict>>();
  const judge = (row: NotificationView): Promise<EventReadVerdict> => {
    const key = `${row.type}\u0000${row.subjectId}`;
    let verdict = verdicts.get(key);
    if (!verdict) {
      const resolved = events.declarationOf(row.type);
      if (!resolved) {
        verdict = Promise.resolve<EventReadVerdict>('indeterminate');
      } else {
        const event: NeuralisEvent = {
          id: row.id,
          type: row.type,
          source: resolved.packageId,
          subject: resolved.declaration.subject,
          subjectId: row.subjectId,
          projectId: session.projectId,
          time: row.at,
          data: {},
        };
        verdict = mayReadEvent(events, event, resolved.declaration, resolved.packageId, session, project);
      }
      verdicts.set(key, verdict);
    }
    return verdict;
  };

  const visible: NotificationView[] = [];
  const deniedUnread: string[] = [];
  for (const row of rows) {
    const verdict = await judge(row);
    if (verdict === 'visible') visible.push(row);
    else if (verdict === 'denied' && !row.read) deniedUnread.push(row.id);
  }
  if (deniedUnread.length > 0) {
    await markNotificationsRead(session.projectId, session.userId, { ids: deniedUnread });
  }

  if (perGroup !== undefined) {
    return NextResponse.json({ groups: groupNotificationViews(visible, perGroup, { unreadOnly }) });
  }
  const last = rows[rows.length - 1];
  return NextResponse.json({
    rows: visible,
    nextBefore: rows.length === limit && last ? last.seq : null,
  });
}
