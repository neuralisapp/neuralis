/**
 * POST /api/notifications/clear — permanently delete the caller's OWN rows in
 * the `X-Project-Id` project, unread ones included. Body: exactly one of
 * `{ group: "<packageId>:<dock>" | "<packageId>" }` (one app's rows, the key
 * `GET /api/notifications?groups=` answers) or `{ all: true }`. Nobody else's
 * notifications change. Answers the counts after — never how many rows went,
 * which would count rows the re-judge hides — and the caller's other open
 * tabs get the same counts over the hub when the unread numbers moved.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { clearNotifications, type ClearSelection } from '@/server/notifications/notificationStore';
import { resolveNotificationReader } from '@/server/notifications/notificationReader';

export const dynamic = 'force-dynamic';

function parseSelection(body: unknown): ClearSelection | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const obj = body as Record<string, unknown>;
  if (Object.keys(obj).length !== 1) return null;
  if (obj.all === true) return { all: true };
  if (typeof obj.group === 'string' && obj.group.length > 0 && obj.group.length <= 300) return { group: obj.group };
  return null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const caller = await resolveNotificationReader(req);
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });
  const selection = parseSelection(await req.json().catch(() => null));
  if (!selection) {
    return NextResponse.json({ error: 'Body must be exactly one of { group: string } or { all: true }' }, { status: 400 });
  }
  const { session } = caller.member;
  const unread = await clearNotifications(session.projectId, session.userId, selection);
  return NextResponse.json({ projectId: session.projectId, unread });
}
