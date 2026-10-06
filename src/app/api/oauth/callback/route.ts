/**
 * OAuth callback route — handles OAuth2 redirect after user authorization.
 *
 * Receives: ?code=...&state=...   OR   ?error=...&error_description=...
 *
 * State routing (prefix-based), and it is a CLOSED set: a state whose prefix
 * a loaded package declared (`oauth-callback:<prefix>`) goes to THAT
 * provider's `completeOAuthCallback`, in-process through the kernel service
 * lookup — never an HTTP hop to this host's own public origin, which fails
 * whenever the declared origin is not reachable from the server itself and puts
 * a network boundary around a single-use state. The pending flow was captured
 * at initiation from the verified session; the provider consumes it single-use
 * and writes at the CAPTURED sink only (R4). The host names no family's flow:
 *   - an IdP `?error=` or a missing `code` is FORWARDED to the provider as
 *     `error` — it alone holds the pending record that says what the refusal
 *     means (e.g. a retry with a reduced scope);
 *   - Anything else → 400 `unknown_oauth_state`. There is no catch-all: the
 *     former "any other state → POST /connectors/<state>/auth/complete" arm was
 *     dead on BOTH ends (agent-core's connector route has no `auth` arm at all,
 *     and its URL builder had zero callers), so it could only ever answer 404
 *     while looking like a live flow.
 *
 * EVERY redirect this route mints is built on `resolveTrustedAppOrigin` — the
 * declared `APP_URL`/`NEXTAUTH_URL`, never `request.url` (which Next builds
 * from the `Host` header, and which inside a container is the `0.0.0.0:3100`
 * bind address). The `missing_params` and legacy-error arms used to build their
 * banner URL from the request, so a container deployment redirected the browser
 * to an address it cannot reach.
 *
 * **A provider that answers with `workspaceQuery`** (the Codex flow, whose
 * banner lives on `/workspace`) gets a redirect to the FIXED path `/workspace`
 * on the trusted origin, its query built through `URLSearchParams`. The
 * provider supplies query VALUES only — never a path, an origin or a raw
 * string — so no provider answer can turn this route into an open redirect.
 * Success and failure ride the same field; such a provider never throws.
 *
 * **The MCP / git flows answer with a small STATIC completion PAGE**, not a
 * workspace redirect. They used to emit a bare `?oauth_success=<family>` /
 * `?oauth_error=<text>` query that nothing ever read (live-measured): the
 * workspace banner (agent-core's `workspace.banner` fill) is the CODEX flow's
 * and was never widened, so the result was carried in a URL no surface
 * rendered. The page replaces it:
 *
 *  - the visible text is FIXED and public-safe. No provider payload, caught
 *    message, token, subject, callback URL or state is interpolated into it;
 *    the real exception is logged server-side and nowhere else;
 *  - it posts ONE `{family, outcome}` message on the `connection-oauth`
 *    `BroadcastChannel`, where `family` ∈ {`mcp`,`git`} and `outcome` ∈
 *    {`success`,`error`} — both closed sets, both literals this file chooses.
 *    Success is posted ONLY after the completion usecase persisted. The
 *    connection card owns what the signal means; it is an invalidation hint,
 *    never proof that a particular connection is connected;
 *  - the channel callback's HTML is a RESPONSE-FORM precedent only. Its
 *    token-bearing `postMessage` payload must never be copied here — this page
 *    hands the opener nothing but the two literals above.
 *
 * A state with no declared prefix keeps the legacy `?oauth_error=` workspace
 * redirect for an IdP error or a missing code; with a code it is the named 400.
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTrustedAppOrigin } from '../../../../server/oauth/appOrigin';
import { getLogger } from '../../../../server/logging/setup';
import type { OAuthCallbackHandler } from '@neuralis/package-system/contracts';
import { getRuntime } from '../../../../server/host/bootstrap';
import { getSessionUser } from '../../../../server/auth/session';

/** The completion page's closed families — the ONLY value that reaches the page. */
type CompletionFamily = 'mcp' | 'git';

/** The channel the connection card listens on. */
const CONNECTION_OAUTH_CHANNEL = 'connection-oauth';

/**
 * Which completion-page family a state belongs to, from its PREFIX, or
 * `undefined` for a prefix that has no page (its provider answers with a
 * workspace query instead).
 *
 * Derived here rather than taken from the completion result so the FAILURE page
 * can name a family too — a failed completion returns nothing at all.
 */
/**
 * A channel flow completes on its OWN route (`/api/oauth/<channel>?action=callback`),
 * which supplies the session check its usecase requires. Here its state is
 * treated as not ours: it never reaches a handler, so a stray hit can neither
 * consume the single-use state nor start a token exchange.
 */
const OWN_ROUTE_STATE_PREFIX = 'channel_oauth_';

function familyOfState(state: string): CompletionFamily | undefined {
  if (state.startsWith('git_connect_')) return 'git';
  if (state.startsWith('mcp_client_')) return 'mcp';
  return undefined;
}

/** Fixed, public-safe copy. Two families × two outcomes, nothing else. */
const COMPLETION_COPY: Record<CompletionFamily, Record<'success' | 'error', string>> = {
  mcp: {
    success: 'MCP server connected. You can close this tab and return to Neuralis.',
    error: 'The MCP authorization did not complete. Close this tab and start it again from Neuralis.',
  },
  git: {
    success: 'Git host connected. You can close this tab and return to Neuralis.',
    error: 'The git authorization did not complete. Close this tab and start it again from Neuralis.',
  },
};

/**
 * The static completion page.
 *
 * Every byte of it is authored HERE. The only inputs are two closed-set literals
 * (`family`, `outcome`), so no provider payload, caught message, token, subject,
 * callback URL or state can reach the document — there is nothing to escape
 * because nothing untrusted is interpolated. The inline script posts the same
 * two literals on the `connection-oauth` BroadcastChannel and stops; it never
 * touches `window.opener`, and it carries no payload of its own.
 *
 * The channel callback's HTML is the RESPONSE-FORM precedent only — its
 * token-bearing `postMessage` must never be copied here.
 */
function completionPage(family: CompletionFamily, outcome: 'success' | 'error'): NextResponse {
  const message = COMPLETION_COPY[family][outcome];
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<meta name="color-scheme" content="dark light"><title>Neuralis</title></head>`
    + `<body style="margin:0;font-family:system-ui,sans-serif;background:#111;color:#ddd;display:grid;place-items:center;height:100vh">`
    + `<p style="max-width:32rem;padding:0 1.5rem;text-align:center;line-height:1.6">${message}</p>`
    + `<script>try{var c=new BroadcastChannel(${JSON.stringify(CONNECTION_OAUTH_CHANNEL)});`
    + `c.postMessage({family:${JSON.stringify(family)},outcome:${JSON.stringify(outcome)}});c.close();}catch(e){}</script>`
    + `</body></html>`;
  return new NextResponse(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * The redirect for a provider that answered with a workspace query: the path is
 * FIXED and the origin is the trusted one; the provider contributes values only.
 */
function workspaceRedirect(appOrigin: string, query: Record<string, string>): NextResponse {
  const url = new URL('/workspace', appOrigin);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const log = getLogger().child('oauth-callback');
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');
  const appOrigin = resolveTrustedAppOrigin(request.url);

  log.info('callback hit', {
    hasCode: Boolean(code),
    hasState: Boolean(state),
    statePrefix: state ? state.slice(0, 12) + '…' : null,
    error,
    errorDescription,
  });

  let callback: OAuthCallbackHandler | undefined;
  if (state) {
    try {
      const runtime = await getRuntime();
      await runtime.whenReady();
      callback = runtime.services.oauthCallbackFor(state);
    } catch {
      return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
    }
  }

  if (!state || !callback || state.startsWith(OWN_ROUTE_STATE_PREFIX)) {
    if (error) {
      log.warn('IdP error → legacy banner', { error });
      return NextResponse.redirect(new URL(`/workspace?oauth_error=${encodeURIComponent(error)}`, appOrigin));
    }
    if (!code || !state) {
      log.warn('missing code/state on callback');
      return NextResponse.redirect(new URL('/workspace?oauth_error=missing_params', appOrigin));
    }
    // No catch-all. A state this host did not mint is named, not forwarded.
    log.warn('unknown oauth state prefix', { statePrefix: state.slice(0, 12) + '…' });
    return NextResponse.json(
      { error: 'unknown_oauth_state', message: 'This callback state was not issued by Neuralis.' },
      { status: 400 },
    );
  }

  // The provider refused before we ever saw a code, or the code is missing: the
  // prefix's provider still gets the call, as `error`, because only it holds
  // the pending record that says what the refusal means.
  const forwardedError = error
    ? { code: error, description: errorDescription ?? error }
    : code
      ? undefined
      : { code: 'missing_params', description: 'callback received without code or state' };
  if (forwardedError) log.warn('IdP error or missing code on a declared prefix', { error: forwardedError.code });

  // The ONE outbound-OAuth arm, completed IN-PROCESS via the typed provider
  // service (never HTTP). `subject` is the provider's own label (an MCP server
  // id, a git host); no family's token reaches this route's response.
  try {
    const sessionUser = await getSessionUser().catch(() => null);
    const result = await callback.completeOAuthCallback({
      code: code ?? '',
      state,
      sessionUserId: sessionUser?.id,
      ...(forwardedError ? { error: forwardedError } : {}),
    });
    if (result.workspaceQuery) {
      log.info('oauth completion → workspace', { family: result.family });
      return workspaceRedirect(appOrigin, result.workspaceQuery);
    }
    const completionFamily = familyOfState(state);
    if (!completionFamily || result.family !== completionFamily) throw new Error('OAuth callback family mismatch');
    if (forwardedError) throw new Error('OAuth callback refused before completion');
    log.info('outbound oauth success', { family: result.family, subject: result.subject });
    // SUCCESS IS POSTED ONLY HERE — after the usecase persisted at the
    // captured sink. The page reports the family from the state PREFIX, never
    // the usecase's `subject`, so no server id reaches the document.
    return completionPage(completionFamily, 'success');
  } catch (err) {
    // The real reason is logged and goes no further: the page's text is fixed,
    // and the broadcast carries the family and the word `error`, nothing else.
    log.warn('outbound oauth failed', { error: err instanceof Error ? err.message : String(err) });
    const completionFamily = familyOfState(state);
    if (!completionFamily) {
      return NextResponse.json({ error: 'oauth_callback_failed' }, { status: 502 });
    }
    return completionPage(completionFamily, 'error');
  }
}
