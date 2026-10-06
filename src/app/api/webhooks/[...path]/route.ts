/**
 * The unauthenticated webhook ingress: `GET|POST /api/webhooks/<path…>`.
 *
 * The host keeps three things and names no surface: the per-address rate
 * limit (`webhookRateLimitPerMinute` requests/minute, platform key, default 60,
 * floor 10 — never unlimited — the outer wall the provider's uniform-401
 * posture leans on against id enumeration), the raw-body read, and the 503
 * until a `channel-gateway` provider mounts. Every segment after
 * `/api/webhooks/` is forwarded verbatim with the lower-cased headers, the
 * query and the raw bytes to that provider's `handleIngress`, which owns the
 * grammar, the verification (a signature, a secret or a bearer — never a
 * session) and any parse, after the verification. The host never parses the
 * body.
 */

import { NextRequest, NextResponse } from 'next/server';
import type { ChannelGateway } from '@neuralis/package-system/contracts';
import { getPlatformConfigStore } from '../../../../server/store/PlatformConfigStore';
import { resolveClientAddress } from '../../../../server/auth/requestClient';

// ---------------------------------------------------------------------------
// In-memory rate limiter (`webhookRateLimitPerMinute` req/min per client address)
// ---------------------------------------------------------------------------

const WINDOW_MS = 60_000;

/** Per-IP request cap per window — `webhookRateLimitPerMinute` platform key,
 *  read per request (live). Declaration floor of 10 keeps the enumeration
 *  wall real at any admin setting. */
function maxRequestsPerWindow(): number {
  try {
    return Number(getPlatformConfigStore().get('webhookRateLimitPerMinute')) || 60;
  } catch {
    return 60;
  }
}

type RateEntry = { count: number; windowStart: number };
const rateLimitStore = new Map<string, RateEntry>();

function checkWebhookRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimitStore.get(ip);

  if (!entry || now - entry.windowStart > WINDOW_MS) {
    rateLimitStore.set(ip, { count: 1, windowStart: now });
    return true;
  }

  entry.count += 1;
  if (entry.count > maxRequestsPerWindow()) return false;
  return true;
}

// Evict stale entries every 5 minutes
let lastEviction = Date.now();
function evictStaleRateLimits(): void {
  const now = Date.now();
  if (now - lastEviction < 300_000) return;
  lastEviction = now;
  for (const [ip, entry] of rateLimitStore) {
    if (now - entry.windowStart > WINDOW_MS * 2) rateLimitStore.delete(ip);
  }
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  return handleWebhook(request, await params, 'GET');
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  return handleWebhook(request, await params, 'POST');
}

async function handleWebhook(
  request: NextRequest,
  params: { path: string[] },
  method: 'GET' | 'POST',
): Promise<NextResponse> {
  evictStaleRateLimits();

  // Rate limit — keyed on the RESOLVED client address (socket peer, or a
  // declared trusted proxy's forwarded hop), never on a header the caller wrote.
  const ip = resolveClientAddress(request.headers).address;

  if (!checkWebhookRateLimit(ip)) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }

  if (params.path.length === 0) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Until the gateway mounts, answer 503 with a stable code so external
  // probes (Telegram setWebhook retries, Meta verification) see
  // "temporarily unavailable", not "route missing".
  let gateway: ChannelGateway | undefined;
  try {
    const { getRuntime } = await import('../../../../server/host/bootstrap');
    const core = await getRuntime();
    await core.whenReady();
    gateway = core.services.get('channel-gateway');
  } catch {
    return NextResponse.json({ error: 'Service unavailable' }, { status: 503 });
  }
  if (!gateway) {
    return NextResponse.json(
      { error: 'Channel gateway not mounted', code: 'channel_gateway_unmounted' },
      { status: 503 },
    );
  }

  // Read raw body once (a signature verifies over the raw bytes, never
  // re-serialized JSON).
  let rawBody = '';
  if (method === 'POST') {
    rawBody = Buffer.from(await request.arrayBuffer()).toString('utf-8');
  }

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const query: Record<string, string> = {};
  request.nextUrl.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  const result = await gateway.handleIngress({
    method,
    path: params.path,
    headers,
    query,
    rawBody,
    signal: request.signal,
  });
  if (result.isText) {
    return new NextResponse(String(result.body), {
      status: result.status,
      headers: { 'content-type': 'text/plain' },
    });
  }
  return NextResponse.json(result.body, { status: result.status });
}
