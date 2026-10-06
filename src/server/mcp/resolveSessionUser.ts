/**
 * Decode NextAuth session cookie from an Express-like request.
 *
 * The MCP server on port 3101 runs in the same Node process as the Next.js
 * app on port 3100 (started via instrumentation). Browsers send cookies
 * across ports on the same hostname, so the `next-auth.session-token`
 * cookie is available here.
 *
 * We decode the JWT using `next-auth/jwt` decode() with the shared
 * NEXTAUTH_SECRET — the same secret NextAuth uses to encrypt the token.
 */

import { decode } from 'next-auth/jwt';
import { getEnv } from '../config/env';
import { resolveActiveUser } from '../auth/memberSession';

export type SessionUser = {
  userId: string;
  email: string;
  name: string;
  /** The epoch the cookie was issued under — verified current here; the OAuth consent records it. */
  sessionEpoch: number;
};

type RequestLike = {
  headers: Record<string, string | string[] | undefined>;
};

/**
 * Extract and decode the NextAuth session from request cookies.
 * Returns null if no valid session is found, or if its principal may no longer
 * hold one: this raw decode bypasses the NextAuth `jwt` callback, so it runs the
 * same `resolveActiveUser` (status + issued epoch) itself. The three `:3101`
 * companions and the OAuth consent inherit the refusal through this port.
 */
export async function resolveSessionUser(req: RequestLike): Promise<SessionUser | null> {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader || typeof cookieHeader !== 'string') return null;

  const raw = extractSessionToken(cookieHeader);
  if (!raw) return null;

  const secret = getEnv().auth.secret;
  if (!secret) return null;

  try {
    const token = await decode({ token: raw, secret });
    if (!token) return null;

    const userId = (token as Record<string, unknown>).userId;
    if (!userId || typeof userId !== 'string') return null;
    if (!(await resolveActiveUser(userId, { sessionEpoch: token.sessionEpoch }))) return null;

    return {
      userId,
      email: typeof token.email === 'string' ? token.email : '',
      name: typeof token.name === 'string' ? token.name : '',
      sessionEpoch: typeof token.sessionEpoch === 'number' ? token.sessionEpoch : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Parse session token from cookie header.
 * NextAuth uses different cookie names depending on HTTPS:
 * - Dev (HTTP):  `next-auth.session-token`
 * - Prod (HTTPS): `__Secure-next-auth.session-token`
 */
function extractSessionToken(cookieHeader: string): string | null {
  const cookies = parseCookies(cookieHeader);
  // Try secure cookie first (production), then dev cookie
  return cookies['__Secure-next-auth.session-token']
    ?? cookies['next-auth.session-token']
    ?? null;
}

/**
 * Total cookie-value decode: `null` instead of a throw.
 *
 * A malformed percent-sequence in a cookie is an INVALID TOKEN, not a server
 * error — the exact wording of the upstream lead GHSA-xmf8-cvqr-rfgj (Auth.js,
 * CVSS 7.5): *"malformed percent-encoding causes the decode step to throw
 * rather than being treated as an invalid token."* We never call `getToken()`;
 * this file hand-rolled the same bug independently. `Cookie: x=%` on a `:3101`
 * upgrade used to reject out of an un-awaited async handler and leak the socket.
 *
 * Module-private on purpose: there is exactly ONE consumer. A shared "total
 * decode" helper is deliberately NOT introduced (it would have no invariant to
 * keep single-copy, and the kernel exports no wildcard subpath to host it).
 */
function decodeCookieValue(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function parseCookies(header: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of header.split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const decoded = decodeCookieValue(pair.slice(idx + 1).trim());
    // Skip only the UNDECODABLE pair and keep every other cookie. Wrapping the
    // whole parse would discard a perfectly valid session token that happened
    // to share a Cookie header with a malformed one — logging the user out.
    // That is a capability regression, not a fix.
    if (decoded === null) continue;
    result[key] = decoded;
  }
  return result;
}
