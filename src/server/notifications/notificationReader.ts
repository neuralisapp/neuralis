/**
 * The caller of a notification route — kept out of `materializer.ts` because
 * the materializer is loaded by the host bootstrap, which must not pull in the
 * NextAuth session module.
 */

import { isSentinelId } from '@neuralis/package-system/contracts';
import { resolveMember, type ResolvedMember } from '../auth/memberSession';
import { getSessionUser } from '../auth/session';
import { resolveRequestProjectId } from '../auth/requestProject';

/**
 * The caller of a notification route: the cookie user as an ACTIVE MEMBER of
 * the `X-Project-Id` project, through the ONE member chain — or the refusal.
 */
export async function resolveNotificationReader(
  req: Request,
): Promise<{ ok: true; member: ResolvedMember } | { ok: false; status: number; error: string }> {
  const user = await getSessionUser().catch(() => null);
  if (!user) return { ok: false, status: 401, error: 'Unauthorized' };
  const project = resolveRequestProjectId(req);
  if (!project.ok) return { ok: false, status: project.status, error: project.error };
  if (isSentinelId(project.projectId)) return { ok: false, status: 403, error: 'Forbidden' };
  const member = await resolveMember(user.id, project.projectId);
  if (!member) return { ok: false, status: 403, error: 'Forbidden: no access to project' };
  return { ok: true, member };
}
