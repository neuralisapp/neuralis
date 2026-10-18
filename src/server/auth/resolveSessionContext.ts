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
 * Cookie by default. With `acceptBearer: true` — passed by the `/api/events` hub
 * ONLY — a request WITHOUT a cookie session may present an external client's
 * OAuth access token instead (the `neuralis` CLI's `device list --watch`),
 * verified by the SAME `tryResolvePackageOAuth` the catch-all's third arm uses;
 * the token's user then passes every account gate below exactly as a cookie
 * user does, the project comes from the token (a supplied `projectId` may only
 * agree: 403 `project_mismatch`), and so does the agent. A present-but-invalid
 * bearer is a 401 with the API challenge — never a fall-through — and an `nrs1.`
 * session ticket is refused (401): a skill never subscribes, so the skill→host
 * auth stays ONE mechanism. `onBearer` hands the caller the grant's expiry so a
 * long-lived stream can close when the token dies. Throws
 * `SessionResolutionError` ({status, headers?}) on any deny; the caller returns
 * that status BEFORE opening any stream (the `/api/events` hub does exactly
 * this — F8).
 *
 * Relationship to the other `auth/` files (one identity type — they do NOT
 * overlap): `session.ts` is the minimal cookie→user check (`getSessionUser`/
 * `requireSession`); `sessionTicketAuth.ts` turns an `nrs1.` skill ticket into a
 * `SessionContext` (the skill→host path); this file turns a COOKIE session — or,
 * on the realtime hub, an external client's OAuth bearer through
 * `packageOAuthAuth.ts` — into the SAME canonical `SessionContext` (the
 * browser→host-route path). All three
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
import { packageApiChallenge, tryResolvePackageOAuth } from './packageOAuthAuth';
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
    /** Response headers the refusal carries (the API challenge on a bearer 401). */
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'SessionResolutionError';
  }
}

/** The verified OAuth grant a bearer-authenticated request carried (the `acceptBearer` arm). */
export type ResolvedBearerGrant = { clientId: string; scope: string; expiresAt?: number };

export type ResolveSessionOptions = {
  refuseMustChangePassword?: boolean;
  /** Admit an external client's OAuth bearer when no cookie session exists — `/api/events` only. */
  acceptBearer?: boolean;
  /** Called with the grant when the bearer arm authenticated the request. */
  onBearer?: (grant: ResolvedBearerGrant) => void;
};

/** The bearer arm: `null` = no bearer presented (the caller answers 401); a refusal throws. */
async function resolveBearerPrincipal(
  req: NextRequest,
): Promise<{ session: SessionContext; grant: ResolvedBearerGrant } | null> {
  const header = req.headers.get('authorization') ?? '';
  if (/^Bearer\s+nrs1\./i.test(header.trim())) {
    throw new SessionResolutionError(401, 'A session ticket cannot subscribe to live updates');
  }
  const resolved = await tryResolvePackageOAuth(req);
  if (!resolved) return null;
  if (resolved.kind === 'reject') {
    throw new SessionResolutionError(401, 'Access token refused', {
      'WWW-Authenticate': packageApiChallenge(resolved.code === 'insufficient_scope' ? 'insufficient_scope' : 'invalid_token'),
    });
  }
  return {
    session: resolved.session,
    grant: {
      clientId: resolved.clientId,
      scope: resolved.scope,
      ...(resolved.expiresAt !== undefined ? { expiresAt: resolved.expiresAt } : {}),
    },
  };
}

export async function resolveSessionContext(
  req: NextRequest,
  projectId: string,
  options: ResolveSessionOptions = {},
): Promise<SessionContext> {
  let user: { id: string } | null = await getSessionUser();
  let bearer: { session: SessionContext; grant: ResolvedBearerGrant } | null = null;
  if (!user && options.acceptBearer) {
    bearer = await resolveBearerPrincipal(req);
    if (!bearer) {
      throw new SessionResolutionError(401, 'Unauthorized', { 'WWW-Authenticate': packageApiChallenge() });
    }
    // The token is bound to its project: a supplied id may only agree.
    if (projectId && projectId !== bearer.session.projectId) {
      throw new SessionResolutionError(403, 'projectId mismatch with the access token');
    }
    projectId = bearer.session.projectId;
    user = { id: bearer.session.userId };
  }
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
  // A bearer is a credential held outside the browser: it meets the gate always.
  if ((options.refuseMustChangePassword || bearer) && userRecord.mustChangePassword) {
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
  // The bearer arm's agent is the token's, already access-checked by the
  // verifier; a header or query may only agree with it.
  if (bearer && requestedAgentId && requestedAgentId !== bearer.session.agentId) {
    throw new SessionResolutionError(403, 'agentId mismatch with the access token');
  }

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
  if (bearer) {
    options.onBearer?.(bearer.grant);
    return bearer.session.agentId ? { ...session, agentId: bearer.session.agentId } : session;
  }
  // A raw header is not an agent identity: a forged, unknown or inaccessible
  // id resolves to NO agent, the same answer as an absent one (non-enumerating).
  // The store read runs only when an id was named.
  const agentId = await resolveVerifiedAgentScope(session, requestedAgentId);
  return agentId ? { ...session, agentId } : session;
}
