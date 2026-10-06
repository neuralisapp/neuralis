/**
 * POST /api/notifications/read — mark the caller's own rows read in the
 * `X-Project-Id` project. Body: exactly one of `{ ids: string[] }` (≤ 200),
 * `{ dock: "<packageId>:<dockId>" }` or `{ all: true }`. Answers the counts
 * after, and the caller's other open tabs get the same counts over the hub.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { markNotificationsRead, type ReadSelection } from '@/server/notifications/notificationStore';
import { resolveNotificationReader } from '@/server/notifications/notificationReader';

export const dynamic = 'force-dynamic';

const MAX_IDS = 200;

function parseSelection(body: unknown): ReadSelection | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const obj = body as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 1) return null;
  if (obj.all === true) return { all: true };
  if (typeof obj.dock === 'string' && obj.dock.length > 0 && obj.dock.length <= 300) return { dock: obj.dock };
  if (
    Array.isArray(obj.ids) &&
    obj.ids.length > 0 &&
    obj.ids.length <= MAX_IDS &&
    obj.ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 64)
  ) {
    return { ids: obj.ids as string[] };
  }
  return null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const caller = await resolveNotificationReader(req);
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });
  const selection = parseSelection(await req.json().catch(() => null));
  if (!selection) {
    return NextResponse.json(
      { error: 'Body must be exactly one of { ids: string[] }, { dock: string } or { all: true }' },
      { status: 400 },
    );
  }
  const { session } = caller.member;
  const unread = await markNotificationsRead(session.projectId, session.userId, selection);
  return NextResponse.json({ projectId: session.projectId, unread });
}
