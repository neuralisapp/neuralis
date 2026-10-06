/**
 * Post-login navigation target validation.
 *
 * Two failure modes this closes, both real:
 *
 * 1. **The localhost bounce (owner bugreport, 2026-08-14).** NextAuth resolves
 *    the posted `callbackUrl` against `NEXTAUTH_URL` and hands back an ABSOLUTE
 *    url, so a deployment reached over a LAN IP or a domain threw the user at
 *    `http://localhost:3100` right after a successful login. The fix is to
 *    navigate to a target validated against the origin the browser is ACTUALLY
 *    on, never one derived from server configuration.
 *
 * 2. **Open redirect.** The `callbackUrl` query parameter is attacker-supplied;
 *    once it becomes a navigation target it must be constrained.
 *
 * The constraint deliberately admits SAME-HOSTNAME-CROSS-PORT, and that is
 * load-bearing, not laxity: the MCP OAuth authorize route (`agent-core`
 * mcp/server/oauthRoutes.ts) sends an unauthenticated client to
 * `/auth?callbackUrl=http://<host>:3101/oauth/authorize?…`, and the host's own
 * NextAuth redirect callback (server/auth/authOptions.ts) admits exactly the
 * same shape. An origin-strict guard here would silently kill every external
 * MCP client's onboarding.
 *
 * Rejecting `\` alone is not enough, and that gap was a real open redirect:
 * the WHATWG URL parser normalises backslashes to forward slashes AND strips
 * tab, newline and carriage return outright, at any position. So `/\evil.com`,
 * `/<TAB>/evil.com`, `/<LF>/evil.com` and `/<CR>/evil.com` all parse as the
 * protocol-relative `//evil.com` while passing a prefix check — and the query
 * parameter arrives percent-decoded, so `%09` is enough to carry one. The
 * guard therefore rejects the whole class: every C0 control plus the
 * backslash. Adding one more character to a list is the wrong fix here; the
 * class is what the parser acts on.
 */

export const DEFAULT_CALLBACK_URL = '/workspace';

export type CallbackTarget =
  | { kind: 'relative'; url: string }
  | { kind: 'absolute'; url: string };

/**
 * Validate a caller-supplied callbackUrl against the hostname the browser is
 * on. Returns the default target for anything unrecognised — never throws,
 * never returns a foreign origin.
 */
export function resolveCallbackTarget(raw: string | null | undefined, currentHostname: string): CallbackTarget {
  const value = raw?.trim();
  if (!value) return { kind: 'relative', url: DEFAULT_CALLBACK_URL };

  // The character class the URL parser rewrites or removes: backslash (→ `/`)
  // and every C0 control, which includes the tab/newline/carriage-return the
  // parser strips at any position. None appears in a legitimate target.
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return { kind: 'relative', url: DEFAULT_CALLBACK_URL };

  // Same-document relative path: the common case (`/workspace`).
  if (value.startsWith('/') && !value.startsWith('//')) {
    return { kind: 'relative', url: value };
  }

  // Absolute: admitted only on the hostname the browser is already on, which
  // keeps the MCP cross-port continuation working without trusting the origin
  // the SERVER thinks it has.
  try {
    const parsed = new URL(value);
    // Credentials in a navigation target are an address-bar spoofing surface
    // and no legitimate producer emits them.
    if (parsed.username || parsed.password) return { kind: 'relative', url: DEFAULT_CALLBACK_URL };
    // Same hostname, and never a downgrade off a secure page. The relaxation
    // this guard deliberately makes is cross-PORT (the MCP OAuth continuation
    // lives on another port of the same host); cross-PROTOCOL was never part
    // of it, and stripping TLS mid-login is exactly what an attacker wants.
    // On a plain-http deployment both sides are `http:`, so the MCP
    // continuation is unaffected.
    const secureHere = typeof window !== 'undefined' && window.location.protocol === 'https:';
    if (secureHere && parsed.protocol !== 'https:') return { kind: 'relative', url: DEFAULT_CALLBACK_URL };
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname === currentHostname) {
      return { kind: 'absolute', url: parsed.href };
    }
  } catch {
    // Not a parseable absolute URL — fall through to the default.
  }

  return { kind: 'relative', url: DEFAULT_CALLBACK_URL };
}
