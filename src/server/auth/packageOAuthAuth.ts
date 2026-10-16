/**
 * The package catch-all's THIRD identity arm: an OAuth access token an external
 * client (the `neuralis` CLI) presents as `Authorization: Bearer <jwt>`.
 *
 * Precedence in the catch-all stays cookie → `nrs1.` ticket → this arm, and a
 * PRESENT-but-invalid ticket never reaches it. This module does only the token
 * half: it asks the package that provides the kernel `route-token-verifier`
 * contract (looked up by contract id, never by package name) to verify the
 * token for the host API resource — `<trusted app origin>/api` — and returns
 * the verifier's LIVE `SessionContext` (member resolver + agent check). The
 * catch-all then applies the COOKIE arm's account gates on top (active user,
 * `mustChangePassword`, membership, live role), pins the project and agent to
 * the token's (a header may only agree), and dispatches with
 * `interactive: false` — an external client is never the human-only channel.
 *
 * It is not a platform bearer and not a synthetic owner: the token names one
 * real user, project and agent, minted by that user's own consent.
 */

import type { NextRequest } from 'next/server';
import {
  SESSION_TOKEN_PREFIX,
  type RouteTokenVerifier,
  type RouteTokenVerifyErrorCode,
  type SessionContext,
} from '@neuralis/package-system/contracts';
import { getRuntime } from '@/server/host/bootstrap';
import { resolveTrustedAppOrigin } from '@/server/oauth/appOrigin';
import { resolveMcpBaseUrl } from '@/server/mcp/mcpBaseUrl';

/** The RFC 8707 resource this surface answers for — the catch-all and the realtime hub alike. */
export function packageApiResource(): string {
  return `${resolveTrustedAppOrigin()}/api`;
}

/**
 * RFC 6750 / RFC 9728 challenge: where a client finds the authorization server
 * for this resource. A secret-free, fixed shape; `error` only on a presented
 * token that was refused.
 */
export function packageApiChallenge(error?: 'invalid_token' | 'insufficient_scope'): string {
  const metadata = `${resolveMcpBaseUrl().replace(/\/+$/, '')}/.well-known/oauth-protected-resource/api`;
  return `Bearer realm="neuralis", resource_metadata="${metadata}", scope="routes:call"${error ? `, error="${error}"` : ''}`;
}

export type PackageOAuthResolveResult =
  | { kind: 'match'; session: SessionContext; clientId: string; scope: string }
  | { kind: 'reject'; code: RouteTokenVerifyErrorCode }
  | null;

/**
 * `null` when no bearer is present (or it is an `nrs1.` ticket — the ticket
 * arm's). A present non-ticket bearer is ALWAYS answered: `match`, or `reject`
 * with the verifier's code — never `null`, so the caller cannot fall through.
 */
export async function tryResolvePackageOAuth(req: NextRequest): Promise<PackageOAuthResolveResult> {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return null;
  const presented = match[1];
  if (!presented || presented.startsWith(SESSION_TOKEN_PREFIX)) return null;

  let verifier: RouteTokenVerifier | undefined;
  try {
    const runtime = await getRuntime();
    await runtime.whenReady();
    verifier = runtime.services.get('route-token-verifier');
  } catch {
    return { kind: 'reject', code: 'not_ready' };
  }
  if (!verifier) return { kind: 'reject', code: 'not_ready' };

  const result = await verifier.verifyRouteToken(presented, packageApiResource()).catch(
    (): { ok: false; code: RouteTokenVerifyErrorCode } => ({ ok: false, code: 'not_ready' }),
  );
  if (!result.ok) return { kind: 'reject', code: result.code };
  return { kind: 'match', session: result.session, clientId: result.clientId, scope: result.scope };
}
