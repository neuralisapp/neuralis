/**
 * POST /api/invite/redeem — the `/invite` page's ONE server call. The token
 * travels in the JSON BODY (the page read it from the URL fragment), never in a
 * URL, so it reaches no access log and no `Referer`.
 *
 * Body `{ token, action }`:
 *   - `inspect` — what the link offers (project, role, email, create-or-join);
 *   - `create`  — `{ name, password }`: a NEW account with the invitee's own
 *     password, then the membership; the page signs in afterwards;
 *   - `join`    — the signed-in account joins, ONLY when its email equals the
 *     link's (`wrong_account` otherwise — the link is not consumed).
 *
 * Every unusable link — unknown, expired, revoked, used, its inviter no longer
 * able to back it — gets the SAME bytes ({@link invalidResponse}). Attempts ride
 * the login limiter's address axis under a per-token subject (`rateLimit.ts`),
 * so guessing tokens from one address is slowed and then refused exactly like
 * spraying passwords. A cross-site form cannot send `application/json`, and the
 * session cookie is SameSite=Lax.
 */

import { NextResponse } from 'next/server';
import { getSessionUser } from '@/server/auth/session';
import { beginLoginAttempt, recordLoginFailure, recordLoginSuccess } from '@/server/auth/rateLimit';
import { resolveClientAddress } from '@/server/auth/requestClient';
import { inviteTokenHash } from '@/server/store/InviteStore';
import {
  INVITE_INVALID,
  inspectInvite,
  redeemInviteExistingAccount,
  redeemInviteNewAccount,
} from '@/server/admin/inviteLinks';

export const dynamic = 'force-dynamic';

/** A redeem body is a token, an action, a name and a password — nothing near this. */
const MAX_BODY_BYTES = 4096;
const NO_STORE = { 'cache-control': 'no-store' } as const;

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** The ONE answer for every unusable link — byte-identical by construction. */
function invalidResponse(): NextResponse {
  return json({ error: INVITE_INVALID }, 404);
}

const STATUS: Record<string, number> = {
  account_exists: 409,
  sign_in_required: 401,
  wrong_account: 403,
  invalid_name: 400,
  password_policy: 400,
};

export async function POST(request: Request): Promise<NextResponse> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
    return json({ error: 'unsupported_media_type' }, 415);
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: 'body_too_large' }, 413);
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: 'invalid_body' }, 400);
  }
  const action = body.action;
  if (action !== 'inspect' && action !== 'create' && action !== 'join') {
    return json({ error: 'invalid_action' }, 400);
  }

  const token = typeof body.token === 'string' ? body.token.slice(0, 128) : '';
  const subject = `invite:${inviteTokenHash(token).slice(0, 32)}`;
  const address = resolveClientAddress(request.headers).address;
  const gate = beginLoginAttempt(subject, address);
  if (gate.kind !== 'proceed') {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { ...NO_STORE, 'retry-after': String(gate.retryAfter) } },
    );
  }
  if (gate.waitMs > 0) await new Promise((resolve) => setTimeout(resolve, gate.waitMs));

  const sessionUserId = (await getSessionUser())?.id ?? null;
  const result =
    action === 'inspect'
      ? await inspectInvite(token, sessionUserId)
      : action === 'create'
        ? await redeemInviteNewAccount(token, { name: body.name, password: body.password })
        : await redeemInviteExistingAccount(token, sessionUserId);

  if (!result.ok) {
    if (result.code === INVITE_INVALID) {
      recordLoginFailure(subject, address);
      return invalidResponse();
    }
    const reason = 'reason' in result && typeof result.reason === 'string' ? { reason: result.reason } : {};
    return json({ error: result.code, ...reason }, STATUS[result.code] ?? 400);
  }
  recordLoginSuccess(subject, address);
  if ('invite' in result) return json(result.invite, 200);
  if ('email' in result) return json({ ok: true, email: result.email }, 201);
  return json({ ok: true, alreadyMember: result.alreadyMember }, 200);
}
