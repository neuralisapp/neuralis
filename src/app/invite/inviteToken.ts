/**
 * The invite token comes from the URL FRAGMENT (`/invite#t=<token>`) and from
 * nowhere else: a fragment is never sent to a server, so the token reaches no
 * access log, no proxy and no `Referer`. A `?t=` query is ignored on purpose —
 * honouring it would invite links that leak the token on the first request.
 */

/** base64url of 32 bytes — the only shape the host mints. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function readInviteToken(hash: string): string | null {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  const token = new URLSearchParams(fragment).get('t');
  return token && TOKEN_PATTERN.test(token) ? token : null;
}

/**
 * The desktop app's join link for the token this page already holds:
 * `neuralis://join?host=<origin>#t=<token>` — the one form the app's strict
 * parser accepts. The token stays in the FRAGMENT; `host` is the server's
 * trusted app origin (from the inspect answer), never this page's own address.
 */
export function desktopJoinLink(appOrigin: string, token: string): string {
  return `neuralis://join?${new URLSearchParams({ host: appOrigin }).toString()}#t=${token}`;
}
