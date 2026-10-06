/**
 * Generic catch-all route for package APIs.
 *
 * Routes like /api/packages/agent-core/agents/123 are dispatched to the
 * owning package's route through the runtime's `routePackage()` — after the
 * runtime's ONE generic readiness (`whenReady()`), whose wait is logged as
 * `waitMs`.
 */

import { NextRequest } from 'next/server';
import { getSessionUser } from '@/server/auth/session';
import { tryResolveSessionTicket } from '@/server/auth/sessionTicketAuth';
import { resolveProjectRoleContext } from '@/server/auth/resolveSessionContext';
import { resolveAgentAxis } from '@/server/auth/resolveVerifiedAgentScope';
import { getRuntime } from '@/server/host/bootstrap';
import { logRuntimeWait } from '@/server/logging/hostLogger';
import { listProjectsForUser, getProjectById } from '@/server/store/ProjectStore';
import { getUserById, isActiveUser } from '@/server/store/UserStore';
import { FileStoreReadError } from '@neuralis/package-system/data';
import { writeAuditLog } from '@/server/store/AuditStore';
import { ensureProjectPackagesLoaded } from '@/server/packages/projectPackages';
import {
  assertNotSentinel,
  SentinelIdentityError,
  type SessionContext,
  type SpendLimits,
} from '@neuralis/package-system/contracts';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // streams can be long-lived

async function handleRequest(
  req: NextRequest,
  params: { path: string[] },
  method: string,
) {
  // Auth precedence (one identity type — the canonical SessionContext):
  //   1. Cookie session — normal logged-in user.
  //   2. `nrs1.` session-ticket (W4G) — real identity carried by a skill
  //      script's child-shell curl. The verifier looks up the live stream
  //      scope; project-id-bind + membership re-verify happen below. This is
  //      the SINGLE auth path for every internal skill (admin/system skills
  //      included) — there is no separate platform-bearer route.
  let user = await getSessionUser();
  // W4G — verified session-ticket callers carry the canonical SessionContext
  // recovered from the live stream scope. `ticketSkillId` is audit-only.
  let ticketSession: SessionContext | null = null;
  let ticketSkillId: string | undefined;

  if (!user) {
    const ticketResolve = await tryResolveSessionTicket(req);
    if (ticketResolve?.kind === 'reject') {
      writeAuditLog({
        userId: '__skill__',
        action: 'skill.session_ticket_rejected',
        details: {
          code: ticketResolve.code,
          message: ticketResolve.message,
          method,
          path: params.path.join('/'),
        },
      });
      return Response.json(
        { error: ticketResolve.message, code: ticketResolve.code },
        { status: 401 },
      );
    }
    if (ticketResolve?.kind === 'match') {
      ticketSession = ticketResolve.session;
      ticketSkillId = ticketResolve.skillId;
      user = { id: ticketSession.userId, email: '', name: 'skill-session' };
    } else {
      return new Response('Unauthorized', { status: 401 });
    }
  }

  // Check user account is active (a disabled or deleted user cannot access even
  // with a valid JWT or session ticket). Session-ticket callers face the same
  // freshness check as cookie users — a disabled mid-stream account is
  // refused on the next callback.
  // A user record that exists but cannot be read is DENIED, never "absent":
  // fail-closed like the project lookups below, the path only in the server log.
  let userRecord: Awaited<ReturnType<typeof getUserById>>;
  try {
    userRecord = await getUserById(user.id);
  } catch (err) {
    if (!(err instanceof FileStoreReadError)) throw err;
    console.error(`[catch-all] User record ${err.kind} for ${user.id}: ${err.filePath}`);
    return Response.json({ error: 'Account lookup failed — access denied' }, { status: 403 });
  }
  if (!userRecord || !isActiveUser(userRecord)) {
    return Response.json({ error: 'Account disabled' }, { status: 403 });
  }
  if (!ticketSession && userRecord.mustChangePassword) {
    // The password change rides the host route `/api/admin/users/[id]`, never
    // this catch-all. Skill-session calls bypass this gate — the user is
    // operating via an in-progress agent stream, not a fresh login.
    return Response.json(
      { error: 'Password change required', code: 'PASSWORD_CHANGE_REQUIRED' },
      { status: 403 },
    );
  }

  // Wait for the runtime's readiness — the ONE generic gate; a package's own
  // later readiness (a boot walk) is that package's routes' business. A failed
  // boot rejects here and answers 503, never a half-booted dispatch.
  const waitStart = Date.now();
  let core;
  try {
    core = await getRuntime();
    await core.whenReady();
  } catch {
    return Response.json({ error: 'Runtime not ready', code: 'runtime_not_ready' }, { status: 503 });
  }
  logRuntimeWait(method, params.path, Date.now() - waitStart);
  const query = Object.fromEntries(req.nextUrl.searchParams);

  // H-1/H-2: Unified projectId extraction and membership check.
  //
  // machine-core exception: the KasmVNC stream path is
  // `machine-core/session/<sessionKey>/stream/*`. The iframe loads JS/CSS
  // with relative URLs that cannot carry a query string, so projectId is
  // parsed out of the session key. Key format:
  //   `<projectId>__<sourceSlug>`   (split on the first `__`)
  // The machine-core stream route then re-runs the shared
  // `authorizeStreamAccess` predicate — project membership + the `machine.read`
  // feature + session-owner + ready — before proxying, so this does not weaken
  // the security posture.
  let projectId = req.headers.get('x-project-id') || query.projectId || '';
  if (!projectId && params.path[0] === 'machine-core' && params.path[1] === 'session') {
    const key = params.path[2];
    if (key) {
      const sep = key.indexOf('__');
      projectId = sep < 0 ? key : key.slice(0, sep);
    }
  }
  // Whatever the caller (or the machine-core key) supplied, captured before
  // the session-ticket fallback fills it in. Used for the cross-project guard.
  const suppliedProjectId = projectId;

  // W4G — session tickets are project-bound: the verified scope already
  // carries the stream's projectId. When the caller supplies none, that's the
  // authoritative source — a skill script's curl no longer has to pass
  // `?projectId=` at all.
  if (!projectId && ticketSession) {
    projectId = ticketSession.projectId;
  }

  if (!projectId) {
    const debugPath = params.path.join('/');
    console.warn(`[catch-all] Missing projectId for ${method} /${debugPath} (user: ${user.id}, headers: x-project-id=${req.headers.get('x-project-id')}, query.projectId=${query.projectId})`);
    return new Response(JSON.stringify({ error: 'Missing projectId' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // W4G — cross-project guard. A session ticket MUST NOT reach a project
  // other than its stream's. Only fires when the caller explicitly supplied a
  // projectId that disagrees with the ticket; a ticket-derived projectId can
  // never mismatch itself.
  if (ticketSession && suppliedProjectId && ticketSession.projectId !== suppliedProjectId) {
    writeAuditLog({
      userId: ticketSession.userId,
      action: 'skill.session_ticket_rejected',
      details: {
        code: 'project_mismatch',
        ticketProjectId: ticketSession.projectId,
        requestProjectId: suppliedProjectId,
        method,
        path: params.path.join('/'),
        skillId: ticketSkillId,
      },
    });
    return Response.json(
      { error: 'projectId mismatch with session-ticket', code: 'project_mismatch' },
      { status: 403 },
    );
  }

  // Verify user→project membership. Cookie users and session-ticket (skill)
  // callers alike carry REAL identity — re-verify membership so a mid-stream
  // revocation is refused on the next callback.
  try {
    const userProjects = await listProjectsForUser(user.id);
    const hasAccess = userProjects.some(p => p.id === projectId);
    if (!hasAccess) {
      if (ticketSession) {
        writeAuditLog({
          userId: ticketSession.userId,
          action: 'skill.session_ticket_rejected',
          details: {
            code: 'membership_revoked',
            projectId,
            method,
            path: params.path.join('/'),
            skillId: ticketSkillId,
          },
        });
      }
      return Response.json({ error: 'Forbidden: no access to project' }, { status: 403 });
    }
  } catch {
    return Response.json({ error: 'Project access check failed' }, { status: 500 });
  }

  // Lazily activate project packages (scan + load + watch) on first access
  await ensureProjectPackagesLoaded(projectId);

  const contentType = req.headers.get('content-type') ?? '';
  const isMultipart = contentType.startsWith('multipart/form-data');

  let body: unknown;
  if (!isMultipart && method !== 'GET' && method !== 'DELETE') {
    try {
      body = await req.json();
    } catch {
      // no body or invalid JSON — that's OK for some endpoints
    }
  }

  // Resolve user role, granted features, and spend limits from project membership
  let role: string | undefined;
  let priority: number | undefined;
  // The project's role → priority map. It travels with `priority` because the
  // uri-policy role layer needs BOTH: the caller's own strength, and the strength
  // of the role NAMES a `byRole` map is keyed on. Without it only the five
  // built-in anchors resolve, so an operator-authored key on a CUSTOM role name
  // silently stops participating — which is most of what the Admin PolicyEditor
  // writes. This catch-all is the highest-traffic session builder; omitting it
  // here makes the whole layer inert for custom roles no matter how correctly
  // every downstream consumer forwards it.
  let rolePriorities: Record<string, number> | undefined;
  let grantedFeatures: string[] | undefined;
  let spendLimits: SpendLimits | undefined;
  let llmRateLimitRpm: number | null | undefined;
  let agentAccess: '*' | 'own' | 'view' | undefined;
  let agentOwnership: Record<string, { createdBy: string; assignedTo: string[] }> | undefined;

  if (ticketSession) {
    // W4G — session-ticket caller. Role/features come from the stream
    // scope snapshot (frozen at stream start). We still load the live
    // project record so the spend limits + agent ownership map reflect
    // any changes made mid-stream.
    role = ticketSession.role;
    priority = ticketSession.priority;
    rolePriorities = ticketSession.rolePriorities;
    grantedFeatures = [...(ticketSession.grantedFeatures ?? [])];
    agentAccess = ticketSession.agentAccess;
    try {
      const project = await getProjectById(projectId);
      if (project?.limits?.spend) spendLimits = project.limits.spend;
      if (project?.limits?.rateLimitRpm != null) llmRateLimitRpm = project.limits.rateLimitRpm;
      if (project?.agentOwnership) agentOwnership = project.agentOwnership;
    } catch (err) {
      console.error(`[catch-all] Project lookup failed for session-ticket caller ${user.id} project ${projectId}:`, err);
      return Response.json(
        { error: 'Project lookup failed — access denied' },
        { status: 403 },
      );
    }
  } else {
    try {
      // ONE shared resolver with `/api/events`/resolveSessionContext (F4 — no drift).
      const roleCtx = resolveProjectRoleContext(await getProjectById(projectId), user.id);
      role = roleCtx.role;
      priority = roleCtx.priority;
      rolePriorities = roleCtx.rolePriorities;
      grantedFeatures = roleCtx.grantedFeatures;
      agentAccess = roleCtx.agentAccess;
      agentOwnership = roleCtx.agentOwnership;
      spendLimits = roleCtx.spendLimits;
      llmRateLimitRpm = roleCtx.llmRateLimitRpm;
    } catch (err) {
      // DENY-BY-DEFAULT: if we can't resolve role, deny access
      console.error(`[catch-all] Role resolution failed for user ${user.id} project ${projectId}:`, err);
      return Response.json(
        { error: 'Role resolution failed — access denied' },
        { status: 403 },
      );
    }

    // Enforce required session fields — deny if role/features not resolved
    if (!role || !grantedFeatures) {
      return Response.json(
        { error: 'Membership role not configured — contact project admin' },
        { status: 403 },
      );
    }
  }

  // Extract optional agentId (agent name — not UUID). Like projectId, a
  // session-ticket caller inherits the stream's agent when the script's curl
  // doesn't pass one explicitly — the ticket already carries the real agentId.
  const requestedAgentId = req.headers.get('x-agent-id') || query.agentId || undefined;
  let agentId = requestedAgentId || ticketSession?.agentId || undefined;

  // SystemSession sentinel IDs must NEVER be accepted from external input.
  // Reject any caller that somehow presents one (defense-in-depth; normal
  // stores already refuse to emit them).
  try {
    assertNotSentinel({ userId: user.id, projectId, agentId });
  } catch (err) {
    if (err instanceof SentinelIdentityError) {
      console.warn('[catch-all] Rejecting sentinel identity in external request', {
        userId: user.id,
        projectId,
        agentId,
      });
      return Response.json({ error: 'Forbidden: sentinel identity is process-internal' }, { status: 403 });
    }
    throw err;
  }

  // COOKIE plane: a named agent is a POLICY input for the routes below
  // (uri-policy `byAgent`, `$self`, the shells kill gate), so an id the caller
  // may not use is refused with the same 404 as a missing route — resolving it
  // away to "no agent" would serve the request against a different object set
  // than the one asked for. The store is read only when an id was named. The
  // TICKET plane keeps its header-over-ticket order (a separate contract).
  if (!ticketSession && requestedAgentId) {
    const axis = await resolveAgentAxis(
      { userId: user.id, projectId, role, grantedFeatures, agentAccess, agentOwnership },
      requestedAgentId,
    );
    if (axis.denied || !axis.agentId) return Response.json({ error: 'Not found' }, { status: 404 });
    agentId = axis.agentId;
  }

  if (ticketSession) {
    // W4G — session-ticket call: REAL identity carried by the ticket. The
    // ACTOR row is the ticket's own agent — the resolved `agentId` above lets
    // a header/query name a TARGET agent, and logging that as the actor masks
    // who acted. The target still lands, in its own field, when it differs.
    writeAuditLog({
      userId: ticketSession.userId,
      action: 'skill.session_call',
      target: `${method} /${params.path.join('/')}`,
      details: {
        projectId,
        // Actor ONLY from the ticket — an agent-less ticket logs no actor
        // agent rather than borrowing the request's TARGET as if it acted.
        ...(ticketSession.agentId ? { agentId: ticketSession.agentId } : {}),
        ...(agentId && agentId !== ticketSession.agentId ? { targetAgentId: agentId } : {}),
        role: ticketSession.role,
        skillId: ticketSkillId,
        requestId: ticketSession.requestId,
      },
    });
  }

  // routePackage extracts packageId from path[0] and passes the rest to handleRoute
  let result;
  try {
    result = await core.routePackage(params.path, {
      path: [], // routePackage overrides this with path.slice(1)
      method: method as 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
      query,
      body,
      session: {
        userId: user.id,
        projectId,
        agentId,
        // W4G — the ticket plane also carries the STREAM's conversation (a
        // delegate child's is its spawning parent's: the scope is per request).
        // The conversation inbox reads the SENDER's conversation from here and
        // nowhere else — never from a body or a query. The cookie plane has none.
        ...(ticketSession?.conversationId ? { conversationId: ticketSession.conversationId } : {}),
        role,
        priority,
        rolePriorities,
        grantedFeatures,
        spendLimits,
        llmRateLimitRpm,
        agentAccess,
        agentOwnership,
      },
      rawRequest: req,
      // Auth-CHANNEL marker (NOT identity): a browser cookie session is
      // interactive (a human), a skill session ticket is an agent. Lets a package
      // route grant a human an immediate committed structural op while an agent's
      // identical call stays governed (`pending_review`). `!ticketSession` — cookie
      // ⇒ true, ticket ⇒ false. Never forgeable by the request body.
      interactive: !ticketSession,
    });
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if (status) {
      const message = err instanceof Error ? err.message : 'Package route error';
      return Response.json({ error: message }, { status });
    }
    throw err;
  }

  // SSE stream response
  if (result.headers?.['content-type'] === 'text/event-stream') {
    // Strip the route's lowercase content-type before spreading — `Headers`
    // merges case-insensitively, so spreading it alongside the canonical
    // 'Content-Type' doubled the value ("text/event-stream, text/event-stream").
    const { 'content-type': _routeContentType, ...extraSseHeaders } = result.headers;
    return new Response(result.body as ReadableStream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...extraSseHeaders,
      },
    });
  }

  // Binary response (images, raw files, etc.)
  const resultContentType = result.headers?.['content-type'];
  if (resultContentType && resultContentType !== 'application/json') {
    return new Response(result.body as BodyInit, {
      status: result.status,
      headers: result.headers,
    });
  }

  return Response.json(result.body ?? null, { status: result.status });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  return handleRequest(req, await params, 'GET');
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  return handleRequest(req, await params, 'POST');
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  return handleRequest(req, await params, 'PATCH');
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  return handleRequest(req, await params, 'PUT');
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  return handleRequest(req, await params, 'DELETE');
}
