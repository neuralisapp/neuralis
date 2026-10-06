/**
 * Channel OAuth CALLBACK — the redirect a channel provider returns to after
 * consent, for `oauth2`-mode channel descriptors.
 *
 *   GET /api/oauth/<channel>?action=callback — completes the flow (the usecase
 *     enforces this family's HARD strictness: a session is required and must
 *     equal the initiating user AND project) and returns a tiny HTML page that
 *     postMessages the token payload to `window.opener` (the channel connect
 *     wizard) and closes. The wizard submits the token through the normal
 *     connection-create path, so the self-scope credential write port stays the
 *     ONLY secret sink — this route never persists tokens.
 *
 * The flow STARTS in the owning package (`POST channels/oauth/<kind>/start`
 * through the package catch-all, which authenticates and gates
 * `channels.connect`); this route is only the return leg. It stays a host route
 * because the callback `redirect_uri` is REGISTERED at the provider and
 * therefore constant: Meta matches the full URI exactly, `state` excepted, so
 * it can carry no per-request query — no `projectId` for the catch-all to
 * resolve. The flow's project rides the PENDING FLOW record instead, and the
 * route verifies its own session against THAT project through the
 * `verifySession` callback the completion owner invokes before the
 * app-credential read and the token POST.
 *
 * The host holds NO OAuth machinery of its own here: no PKCE, no state store,
 * no token exchange — the completion owner is the provider of the state's
 * declared `oauth-callback:<prefix>`, and it must be the same provider as the
 * kernel `channel-gateway`.
 */

import { NextRequest, NextResponse } from 'next/server';
import type { ChannelGateway, RuntimeInstance } from '@neuralis/package-system/contracts';
import { hasFeature } from '@neuralis/package-system/access';
import { getSessionUser } from '@/server/auth/session';
import { resolveSessionContext, SessionResolutionError } from '@/server/auth/resolveSessionContext';
import { getLogger } from '../../../../server/logging/setup';
import { resolveTrustedAppOrigin } from '../../../../server/oauth/appOrigin';

async function getChannelRuntime(): Promise<RuntimeInstance> {
  const { getRuntime } = await import('../../../../server/host/bootstrap');
  const runtime = await getRuntime();
  await runtime.whenReady();
  return runtime;
}

/** Whether this channel kind ships an OAuth descriptor (404 otherwise). */
function hasOAuthDescriptor(api: ChannelGateway | undefined, channel: string): boolean {
  return api?.listChannelDescriptors().some((d) => d.kind === channel && d.auth.mode === 'oauth2') ?? false;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ channel: string }> },
) {
  const { channel } = await params;
  const log = getLogger().child('oauth-channel');
  if (!/^[a-z][a-z0-9-]{0,32}$/.test(channel)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  // Only the return leg lives here; anything else is not a route. An
  // unauthenticated caller is refused next, ahead of anything that could say
  // whether this channel has a descriptor.
  if (request.nextUrl.searchParams.get('action') !== 'callback') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (!(await getSessionUser())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let runtime: RuntimeInstance;
  let api: ChannelGateway | undefined;
  try {
    runtime = await getChannelRuntime();
    api = runtime.services.get('channel-gateway');
  } catch {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
  }
  if (!hasOAuthDescriptor(api, channel) || !api) {
    return NextResponse.json({ error: 'Channel has no OAuth descriptor' }, { status: 404 });
  }

  // The opener origin is the DECLARED app origin, never the request's: inside
  // the container `request.nextUrl.origin` is the bind address (`0.0.0.0:3100`).
  const trustedOrigin = resolveTrustedAppOrigin(request.url);

  const state = request.nextUrl.searchParams.get('state') ?? '';
  const code = request.nextUrl.searchParams.get('code') ?? '';
  if (!state || !code) {
    return NextResponse.json({ error: 'Invalid or expired OAuth state' }, { status: 400 });
  }

  let accessToken: string;
  let expiresIn: number | undefined;
  try {
    // Single-use consume + HARD initiator equality happen inside the usecase
    // (this family's `requireSession`/`strictUser`/`strictProject` row), so a
    // foreign session or a replayed state never reaches the token endpoint.
    // The flow calls `verifySession` with its CAPTURED project, before the
    // app-credential read and the token POST; returning `null` refuses the
    // callback, so a caller who lost that project's grant exchanges nothing.
    const handler = runtime.services.oauthCallbackFor(state);
    const callbackPrefix = runtime.getLoader().listLoaded().flatMap((definition) =>
      (definition.provides ?? []).filter((id) => id.startsWith('oauth-callback:') && state.startsWith(id.slice('oauth-callback:'.length))),
    )[0];
    if (!handler || !callbackPrefix || runtime.services.providerOf(callbackPrefix) !== runtime.services.providerOf('channel-gateway')) {
      return NextResponse.json({ error: 'Invalid or expired OAuth state' }, { status: 400 });
    }
    const result = await handler.completeOAuthCallback({
      code,
      state,
      verifySession: async (flowProjectId) => {
        if (!flowProjectId) return null;
        let session;
        try {
          session = await resolveSessionContext(request, flowProjectId);
        } catch (error) {
          if (!(error instanceof SessionResolutionError)) {
            log.error('unexpected session resolution failure', {
              channel,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          return null;
        }
        if (!hasFeature(session, 'channels.connect')) return null;
        return { ...session, callerId: 'neuralis', callerTrust: 'first-party' };
      },
    });
    if (result.family !== 'channel' || result.subject !== channel || !result.tokens?.accessToken) {
      return NextResponse.json({ error: 'Invalid or expired OAuth state' }, { status: 400 });
    }
    accessToken = result.tokens.accessToken;
    expiresIn = result.tokens.expiresIn;
  } catch {
    // Generic on purpose: a per-reason status would let a caller probe which
    // states exist. The detail is logged package-side.
    return NextResponse.json({ error: 'Invalid or expired OAuth state' }, { status: 400 });
  }

  // Hand the token to the opener (the wizard) — same-origin only — and
  // close. This route never stores it; the wizard pushes it through the
  // connection-create path (self-scope credential writer port).
  // `<`-escape so a hostile token value can never close the <script>
  // block (provider URLs are descriptor-pinned, but defense in depth).
  const payload = JSON.stringify({
    type: 'neuralis-oauth',
    channel,
    accessToken,
    ...(typeof expiresIn === 'number' ? { expiresIn } : {}),
  }).replace(/</g, '\\u003c');
  const html = `<!doctype html><meta charset="utf-8"><title>Connected</title><body style="font-family:system-ui;background:#111;color:#ddd;display:grid;place-items:center;height:100vh"><p>Connected — you can close this window.</p><script>
try { window.opener && window.opener.postMessage(${payload}, ${JSON.stringify(trustedOrigin).replace(/</g, '\\u003c')}); } catch (e) {}
setTimeout(function(){ window.close(); }, 800);
</script></body>`;
  return new NextResponse(html, { status: 200, headers: { 'content-type': 'text/html' } });
}
