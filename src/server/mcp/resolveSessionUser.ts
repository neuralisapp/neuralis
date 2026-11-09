/**
 * Decode NextAuth session cookie from an Express-like request.
 *
 * The MCP server (`MCP_HTTP_PORT`) runs in the same Node process as the Next.js
 * app (started via instrumentation). A browser's cookie surfaces reach it
 * FORWARDED from the app origin (the consent, the terminal sockets), so the
 * cookie arrives on every shape; a same-hostname port split also sends it
 * directly (cookies ignore ports) — the desktop stream relies on that.
 *
 * We decode the JWT using `next-auth/jwt` decode() with the shared session
 * secret (`sessionSecret`, the data home's key file) — the same secret NextAuth
 * uses to encrypt the token.
 */

import { decode } from 'next-auth/jwt';
import { SessionSecretMissingError, sessionSecret } from '../config/env';
import { resolveActiveUser } from '../auth/memberSession';
import { SESSION_COOKIE_NAMES } from '../auth/sessionCookieNames';
import { resolveTrustedAppOrigin } from '../oauth/appOrigin';
import { appearanceImageUrl } from '../../lib/appearanceImageUrl';
import type { StoredAppearance } from '../appearance/appearanceImageStore';

/** A user's or project's appearance as the `:3101` consent page draws it. */
export type ConsentAppearance = {
  iconName?: string;
  color?: string;
  background?: 'filled' | 'transparent';
  /** ABSOLUTE `<app origin>/api/appearance/…` URL — the image origin the consent page's CSP names. */
  imageUrl?: string;
};

/**
 * Project a stored appearance for the consent page. The picture becomes an
 * ABSOLUTE app-origin URL: the browser loads it from the `:3100` origin with
 * its own cookie, under the same read gate the workspace uses.
 */
export function toConsentAppearance(
  kind: 'user' | 'project',
  ownerId: string,
  stored: StoredAppearance | undefined,
): ConsentAppearance | undefined {
  if (!stored) return undefined;
  return {
    ...(stored.iconName ? { iconName: stored.iconName } : {}),
    ...(stored.color ? { color: stored.color } : {}),
    ...(stored.background ? { background: stored.background } : {}),
    ...(stored.image?.hash ? { imageUrl: `${resolveTrustedAppOrigin()}${appearanceImageUrl(kind, ownerId, stored.image.hash)}` } : {}),
  };
}

export type SessionUser = {
  userId: string;
  email: string;
  name: string;
  /** The epoch the cookie was issued under — verified current here; the OAuth consent records it. */
  sessionEpoch: number;
  /** The record's forced-password-change flag — the OAuth consent refuses such a user, like the catch-all does. */
  mustChangePassword: boolean;
  /** The user's avatar on the OAuth consent page. */
  appearance?: ConsentAppearance;
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

  let secret: string;
  try {
    secret = sessionSecret();
  } catch (error) {
    // No secret on disk = not set up: no cookie can be valid.
    if (error instanceof SessionSecretMissingError) return null;
    throw error;
  }

  try {
    const token = await decode({ token: raw, secret });
    if (!token) return null;

    const userId = (token as Record<string, unknown>).userId;
    if (!userId || typeof userId !== 'string') return null;
    const record = await resolveActiveUser(userId, { sessionEpoch: token.sessionEpoch });
    if (!record) return null;

    const appearance = toConsentAppearance('user', userId, record.appearance);
    return {
      userId,
      email: typeof token.email === 'string' ? token.email : '',
      name: typeof token.name === 'string' ? token.name : '',
      sessionEpoch: typeof token.sessionEpoch === 'number' ? token.sessionEpoch : 0,
      mustChangePassword: record.mustChangePassword === true,
      ...(appearance ? { appearance } : {}),
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
  for (const name of SESSION_COOKIE_NAMES) if (cookies[name]) return cookies[name];
  return null;
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
