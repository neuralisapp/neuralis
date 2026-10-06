/**
 * resolveSessionContext — the ONE full-`SessionContext` resolver for host routes
 * that need role / priority / grantedFeatures / agentAccess / agentOwnership
 * beyond the bare `getSessionUser()`.
 *
 * Extracted (NOT copied) from the catch-all cookie branch
 * (`api/packages/[...path]/route.ts`) so the deny gates can never drift between
 * the two. It reproduces EVERY deny gate, deny-by-default:
 *   - unauthenticated            → 401
 *   - disabled / deleted account → 403
 *   - user record unreadable / torn → 403
 *   - missing projectId          → 400
 *   - project membership revoked → 403
 *   - role/grantedFeatures unset → 403
 *   - sentinel identity          → 403
 *
 * COOKIE-ONLY: an `EventSource` cannot carry an `Authorization: Bearer nrs1.…`
 * header, so there is no session-ticket branch here — but every gate the
 * catch-all runs for a cookie user is reproduced. Throws `SessionResolutionError`
 * ({status}) on any deny; the caller returns that status BEFORE opening any
 * stream (the `/api/events` hub does exactly this — F8).
 *
 * Relationship to the other `auth/` files (one identity type — they do NOT
 * overlap): `session.ts` is the minimal cookie→user check (`getSessionUser`/
 * `requireSession`); `sessionTicketAuth.ts` turns an `nrs1.` skill ticket into a
 * `SessionContext` (the skill→host path); this file turns a COOKIE session into
 * the SAME canonical `SessionContext` (the browser→host-route path). All three
 * produce/consume the ONE `SessionContext` — none declares a parallel identity
 * shape. The shared `resolveProjectRoleContext` below is the SINGLE source of the
 * project→role deny-gate inputs, imported by the catch-all too so the cookie
 * branch can never drift from this one (architect F4).
 */

import { NextRequest } from 'next/server';
import { getSessionUser } from './session';
import { getUserById, isActiveUser } from '@/server/store/UserStore';
import { listProjectsForUser, getProjectById, type ProjectRecord } from '@/server/store/ProjectStore';
import {
  assertNotSentinel,
  SentinelIdentityError,
  type SessionContext,
} from '@neuralis/package-system/contracts';
import { resolveProjectRoleContext, type ProjectRoleContext } from './projectRoleContext';
import { resolveVerifiedAgentScope } from './resolveVerifiedAgentScope';
import { FileStoreReadError } from '@neuralis/package-system/data';

/**
 * Re-exported, not re-implemented: the projection moved to its own module so
 * consumers that need it WITHOUT this file's NextAuth import chain can have it,
 * while every existing `from './resolveSessionContext'` import keeps working.
 */
export { resolveProjectRoleContext };
export type { ProjectRoleContext };

export class SessionResolutionError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SessionResolutionError';
  }
}

export async function resolveSessionContext(
  req: NextRequest,
  projectId: string,
  options: { refuseMustChangePassword?: boolean } = {},
): Promise<SessionContext> {
  const user = await getSessionUser();
  if (!user) throw new SessionResolutionError(401, 'Unauthorized');

  // Disabled or deleted users cannot access even with a valid JWT. A record
  // that exists but cannot be read is denied too — never read as "absent".
  let userRecord: Awaited<ReturnType<typeof getUserById>>;
  try {
    userRecord = await getUserById(user.id);
  } catch (err) {
    if (err instanceof FileStoreReadError) {
      console.error(`[session] User record ${err.kind} for ${user.id}: ${err.filePath}`);
      throw new SessionResolutionError(403, 'Account lookup failed — access denied');
    }
    throw err;
  }
  if (!userRecord || !isActiveUser(userRecord)) {
    throw new SessionResolutionError(403, 'Account disabled');
  }
  // A route that stands in for a package-catch-all route keeps the catch-all's
  // password-change gate: such a user reaches the host password route only.
  if (options.refuseMustChangePassword && userRecord.mustChangePassword) {
    throw new SessionResolutionError(403, 'Password change required');
  }

  if (!projectId) throw new SessionResolutionError(400, 'Missing projectId');

  // Membership re-verify — a mid-stream revocation is refused on reconnect.
  let userProjects;
  try {
    userProjects = await listProjectsForUser(user.id);
  } catch {
    throw new SessionResolutionError(500, 'Project access check failed');
  }
  if (!userProjects.some((p) => p.id === projectId)) {
    throw new SessionResolutionError(403, 'Forbidden: no access to project');
  }

  // Role / grantedFeatures / agentAccess / priority / ownership — deny-by-default,
  // via the ONE shared resolver (also used by the catch-all cookie branch).
  let roleCtx: ProjectRoleContext;
  try {
    roleCtx = resolveProjectRoleContext(await getProjectById(projectId), user.id);
  } catch {
    // DENY-BY-DEFAULT: if we can't resolve role, deny access.
    throw new SessionResolutionError(403, 'Role resolution failed — access denied');
  }
  if (!roleCtx.role || !roleCtx.grantedFeatures) {
    throw new SessionResolutionError(403, 'Membership role not configured — contact project admin');
  }

  const requestedAgentId =
    req.headers.get('x-agent-id') || req.nextUrl.searchParams.get('agentId') || undefined;

  // Sentinel IDs must NEVER be accepted from external input (defense-in-depth).
  try {
    assertNotSentinel({ userId: user.id, projectId, agentId: requestedAgentId });
  } catch (err) {
    if (err instanceof SentinelIdentityError) {
      throw new SessionResolutionError(403, 'Forbidden: sentinel identity is process-internal');
    }
    throw err;
  }

  const session: SessionContext = {
    userId: user.id,
    projectId,
    role: roleCtx.role,
    priority: roleCtx.priority,
    rolePriorities: roleCtx.rolePriorities,
    grantedFeatures: roleCtx.grantedFeatures,
    spendLimits: roleCtx.spendLimits,
    llmRateLimitRpm: roleCtx.llmRateLimitRpm,
    agentAccess: roleCtx.agentAccess,
    agentOwnership: roleCtx.agentOwnership,
  };
  // A raw header is not an agent identity: a forged, unknown or inaccessible
  // id resolves to NO agent, the same answer as an absent one (non-enumerating).
  // The store read runs only when an id was named.
  const agentId = await resolveVerifiedAgentScope(session, requestedAgentId);
  return agentId ? { ...session, agentId } : session;
}
