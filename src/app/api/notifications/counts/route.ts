/**
 * GET /api/notifications/counts — unread counts for the badge.
 *
 * - default: the `X-Project-Id` project → `{ projectId, unread: { total, byDock } }`
 *   (`byDock` keys are `<packageId>:<dockId>`, the dock item the badge sits on);
 * - `?scope=all`: every project the caller is an active member of →
 *   `{ byProject: { <projectId>: total } }` (the project switcher's per-row
 *   number; one small `state.json` read per project, only when it asks).
 *
 * Counts are a number per bucket — never a row, a title or an id.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { getSessionUser } from '@/server/auth/session';
import { listProjectsForUser } from '@/server/store/ProjectStore';
import { resolveActiveUser } from '@/server/auth/memberSession';
import { readUnreadCounts } from '@/server/notifications/notificationStore';
import { resolveNotificationReader } from '@/server/notifications/notificationReader';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (req.nextUrl.searchParams.get('scope') === 'all') {
    const user = await getSessionUser().catch(() => null);
    if (!user || !(await resolveActiveUser(user.id))) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const projects = await listProjectsForUser(user.id);
    const byProject: Record<string, number> = {};
    await Promise.all(
      projects.map(async (project) => {
        byProject[project.id] = (await readUnreadCounts(project.id, user.id)).total;
      }),
    );
    return NextResponse.json({ byProject });
  }

  const caller = await resolveNotificationReader(req);
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });
  const { session } = caller.member;
  return NextResponse.json({
    projectId: session.projectId,
    unread: await readUnreadCounts(session.projectId, session.userId),
  });
}
