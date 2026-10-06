/**
 * W4G — stream-scope session-ticket resolver for `/api/packages/*`.
 *
 * This is the SINGLE auth path for every internal skill (admin/system skills
 * included). The skill protocol mints a per-stream opaque ticket
 * (`nrs1.<requestId>.<secret>`) at every activation and projects it into the
 * child shell env as `NEURALIS_SESSION_TOKEN`. Scripts forward it via
 * `Authorization: Bearer nrs1.…`; this module hands the token to the
 * package that provides the `session-ticket-verifier` contract (looked up by
 * contract id, never by package name), which checks the live stream scope.
 *
 * Security contract:
 *  - The verifier returns the REAL session-context (member-user role,
 *    actual granted features, agentAccess) — there is no synthetic owner
 *    upgrade anywhere. Every route gates on the caller's real role/features
 *    via the package `RouteDispatcher` (`requireFeature`), deny-by-default.
 *  - Sentinel identities (`__skill__`, `__system__`) inside the scope are
 *    refused upstream by the authority's `verify` (skill-from-skill
 *    chain attempts).
 *  - The route handler is responsible for project-id binding, membership
 *    re-verification, and audit emission — this module only does the
 *    cryptographic comparison and identity extraction.
 */

import { NextRequest } from 'next/server';
import {
  SESSION_TOKEN_PREFIX,
  type SessionContext,
  type SessionTicketVerifier,
  type SessionTicketVerifyErrorCode,
} from '@neuralis/package-system/contracts';
import { getRuntime } from '@/server/host/bootstrap';

/** The verifier's own codes, plus `core_not_ready` while no verifier can answer. */
export type SessionTicketRejectCode = SessionTicketVerifyErrorCode | 'core_not_ready';

/**
 * Successful resolution hands back the canonical {@link SessionContext} the
 * verifier recovered from the live stream scope — the route uses its
 * `userId`/`projectId`/`role`/… directly (no bespoke caller shape). `skillId`
 * is the active skill id for audit enrichment, kept separate from identity.
 */
export type SessionTicketResolveResult =
  | { kind: 'match'; session: SessionContext; skillId?: string }
  | { kind: 'reject'; code: SessionTicketRejectCode; message: string }
  | null;

/**
 * Parse the `Authorization: Bearer nrs1.…` header (if any) and ask the
 * verifier to check it. Returns:
 *  - `null` when the header is absent or doesn't carry the `nrs1.` prefix;
 *  - `{ kind: 'match', ... }` on a successful verify;
 *  - `{ kind: 'reject', code, message }` when the header IS a session
 *    ticket but verification failed, OR the runtime is not ready / failed to
 *    boot / exposes no verifier (`core_not_ready`) — never `null` for a present
 *    ticket, so the caller can never fall through to another arm (401).
 */
export async function tryResolveSessionTicket(
  req: NextRequest,
): Promise<SessionTicketResolveResult> {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return null;
  const presented = match[1];
  if (!presented || !presented.startsWith(SESSION_TOKEN_PREFIX)) return null;

  let verifier: SessionTicketVerifier | undefined;
  try {
    const runtime = await getRuntime();
    await runtime.whenReady();
    verifier = runtime.services.get('session-ticket-verifier');
  } catch {
    return { kind: 'reject', code: 'core_not_ready', message: 'Runtime not ready.' };
  }
  if (!verifier) {
    return { kind: 'reject', code: 'core_not_ready', message: 'Verifier not exposed.' };
  }

  const result = verifier.verifySessionTicket(presented);
  if (!result.ok) {
    return {
      kind: 'reject',
      code: result.code,
      message: result.message,
    };
  }
  return {
    kind: 'match',
    session: result.session,
    ...(result.skillId ? { skillId: result.skillId } : {}),
  };
}
