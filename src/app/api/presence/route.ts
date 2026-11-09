/**
 * GET /api/presence — who is online in the `X-Project-Id` project, for the
 * workspace dock's People view.
 *
 * Query: `userId` (optional) narrows the answer to one user.
 *
 * The caller is the cookie user as an ACTIVE MEMBER of that project (the ONE
 * member chain). Every member is projected through the kernel's ONE presence
 * predicate (`presenceTierFor` + `projectPresence`, in `listPresence`): their
 * own clients in full, co-members as far as the caller's features reach, and
 * nobody else. A user id that is not a member here answers `{ users: [] }` —
 * the same body an unknown id gets, so the route confirms no account.
 *
 * Its CSRF floor is the required `X-Project-Id` header, which a cross-site
 * request cannot set. The agent path is the admin `presence` route (through
 * `hostPorts.presence`) and its skill script.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { resolveNotificationReader } from '@/server/notifications/notificationReader';
import { listPresence } from '@/server/presence/clientRegistry';

export const dynamic = 'force-dynamic';

const MAX_USER_ID_CHARS = 200;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const caller = await resolveNotificationReader(req);
  if (!caller.ok) return NextResponse.json({ error: caller.error }, { status: caller.status });
  const { session, project } = caller.member;
  const userId = req.nextUrl.searchParams.get('userId') ?? undefined;
  if (userId !== undefined && (userId.length === 0 || userId.length > MAX_USER_ID_CHARS)) {
    return NextResponse.json({ error: 'userId must be 1–200 characters' }, { status: 400 });
  }
  const users = listPresence(session, {
    scope: 'project',
    memberIds: new Set(Object.keys(project.members)),
    ...(userId !== undefined ? { userId } : {}),
  });
  return NextResponse.json({ users });
}
