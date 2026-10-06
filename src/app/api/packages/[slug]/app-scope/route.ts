/**
 * /api/packages/:slug/app-scope — identity-free package asset scope MINT /
 * HEARTBEAT / CLOSE (CARD1 3A).
 *
 * - POST   `{ projectId?, surfaceKind, surfaceId, rendererFingerprint? }` +
 *   `x-project-id` / `x-agent-id` headers → mints an opaque 192-bit handle for
 *   ONE exact, caller-visible widget/card surface and returns the identity-free
 *   navigable URL `/api/package-app/_scope/{handle}/surface/{entry}`. The
 *   entry path is resolved SERVER-SIDE from the surface's declared
 *   `component.url` / `render.url` — an arbitrary app path can never be
 *   minted. The client-supplied `rendererFingerprint` is a refcount
 *   coordinate only; it carries NO authority (the server computes its own).
 * - PATCH  `{ handle }` → heartbeat. Re-runs the FRESH canonical session +
 *   the FULL shared visibility gate + fingerprint/generation/trust compare;
 *   any loss revokes the handle (410).
 * - DELETE `{ handle }` → own close. Capability-REDUCING, so it stays allowed
 *   after project-access loss: only the cookie user must match the record.
 *
 * The handle / project id NEVER appear in a query string. Every not-visible
 * outcome answers ONE uniform, non-enumerating 404 — a probing caller cannot
 * distinguish "no such package" from "not yours" from "feature-hidden".
 *
 * Auth: the caller is the workspace BROWSER (cookie session) — this is a
 * host-only route (no session-ticket arm; skills/models have no business
 * minting asset scopes). K7: the raw `x-agent-id` header is resolved ONCE, inside
 * `resolveSessionContext`, through `resolveVerifiedAgentScope` (agent-core's
 * deny-by-default policy) before it
 * touches any predicate; a forged/foreign/deleted agent behaves exactly like
 * "no agent".
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolve, sep } from 'node:path';
import {
  isSafeSurfaceIdSegment,
  resolveSurfaceAssetEntry,
  SHARED_ASSET_DIR,
  type SurfaceAssetKind,
} from '@neuralis/package-system';
import { resolveProjectRoot } from '@neuralis/package-system/paths';
import type { SessionContext } from '@neuralis/package-system/contracts';
import {
  resolveSessionContext,
  SessionResolutionError,
} from '@/server/auth/resolveSessionContext';
import { getSessionUser } from '@/server/auth/session';
import { resolveVerifiedAgentScope } from '@/server/auth/resolveVerifiedAgentScope';
import { resolveVisiblePackageSurface } from '@/server/packages/packageVisibility';
import { getPackageAssetScopeAuthority } from '@/server/packages/PackageAssetScopeAuthority';
import { ensureProjectPackagesLoaded } from '@/server/packages/projectPackages';
import { getProjectPackageScanner } from '@/server/packages/ProjectPackageScanner';
import { getEnv } from '@/server/config/env';
import { getLogger } from '@/server/logging/setup';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ slug: string }> };

/** ONE uniform, non-enumerating not-visible response for every mint failure. */
function notVisible(): NextResponse {
  return NextResponse.json({ error: 'Surface not available' }, { status: 404 });
}

function gone(): NextResponse {
  return NextResponse.json({ error: 'Gone' }, { status: 410 });
}

async function readBody(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const body = (await req.json()) as unknown;
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function POST(req: NextRequest, { params }: Params): Promise<Response> {
  const { slug } = await params;
  const body = await readBody(req);

  const projectId =
    req.headers.get('x-project-id') ||
    (typeof body.projectId === 'string' ? body.projectId : '') ||
    '';

  let session: SessionContext;
  try {
    session = await resolveSessionContext(req, projectId);
  } catch (err) {
    if (err instanceof SessionResolutionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }

  // K7 — `resolveSessionContext` already verified the raw `x-agent-id` through
  // `resolveVerifiedAgentScope`: a failed verification left NO agent, externally
  // identical to "no agent". Never re-resolve it here.
  const verifiedAgentId = session.agentId;
  const effectiveSession: SessionContext = session;

  const surfaceKind = body.surfaceKind;
  const surfaceId = body.surfaceId;
  if (surfaceKind !== 'widget' && surfaceKind !== 'card') return notVisible();
  if (typeof surfaceId !== 'string' || !isSafeSurfaceIdSegment(surfaceId)) return notVisible();

  await ensureProjectPackagesLoaded(session.projectId);

  const surface = await resolveVisiblePackageSurface(
    effectiveSession,
    slug,
    surfaceKind as SurfaceAssetKind,
    surfaceId,
  );
  if (!surface) return notVisible();

  // Server-side entry resolution from the DECLARED url — only an asset-backed
  // (relative, canonical-layout) surface can mint; absolute-url surfaces have
  // no host asset scope.
  if (!surface.entryUrl) return notVisible();
  const entry = resolveSurfaceAssetEntry(
    surfaceKind as SurfaceAssetKind,
    surfaceId,
    surface.entryUrl,
  );
  if (!entry.ok) return notVisible();

  // Resolve the on-disk roots from the project scanner record (asset-backed
  // surfaces are project-scanner packages; the root is server-derived, never
  // caller-supplied). BUG-A: scanner records carry the RAW manifest id and
  // cache on the dir slug — the namespaced registry id (`surface.packageId`)
  // matches NEITHER, so the lookup goes through the ONE canonical translation
  // (`surface.manifestId`, resolved by `resolveVisiblePackageSurface`). No
  // slug fallback: the URL slug is the namespaced id, and a directory
  // literally named like it would resolve the WRONG package's roots.
  const env = getEnv();
  const logger = getLogger().child('asset-scope');
  const projectRoot = resolveProjectRoot(env.projectsRoot, session.projectId);
  const scanner = getProjectPackageScanner(projectRoot, logger);
  const record = scanner.getPackageById(surface.manifestId);
  if (!record) return notVisible();

  const appRoot = resolve(record.packageRoot, 'app');
  const surfaceRoot = resolve(record.packageRoot, entry.root);
  if (surfaceRoot !== appRoot && !surfaceRoot.startsWith(appRoot + sep)) return notVisible();
  const sharedRoot = resolve(record.packageRoot, SHARED_ASSET_DIR);

  const minted = getPackageAssetScopeAuthority().mint({
    userId: session.userId,
    projectId: session.projectId,
    agentId: verifiedAgentId,
    packageId: surface.packageId,
    surfaceKind: surfaceKind as SurfaceAssetKind,
    surfaceId,
    renderer: surface.renderer,
    trust: surface.trust,
    fingerprint: surface.fingerprint,
    generation: surface.generation,
    surfaceRoot,
    sharedRoot,
    entryRelPath: entry.entryRel,
    // The NORMALIZED mode from the visibility resolution — never the raw
    // manifest value, and never re-derived here. This is the only producer of
    // `record.assetMode`, and it is why bundle mode reaches the wire at all.
    assetMode: surface.assetMode,
  });

  return NextResponse.json({
    handle: minted.handle,
    url: `/api/package-app/_scope/${minted.handle}/surface/${entry.entryRel}`,
  });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const body = await readBody(req);
  const handle = typeof body.handle === 'string' ? body.handle : '';
  if (!handle) return gone();

  const authority = getPackageAssetScopeAuthority();
  const record = authority.get(handle);
  if (!record) return gone();

  let session: SessionContext;
  try {
    session = await resolveSessionContext(req, record.projectId);
  } catch (err) {
    if (err instanceof SessionResolutionError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
  if (session.userId !== record.userId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Re-resolve the handle's bound agent candidate with the FRESH session — no
  // caller header is consulted. Deleted agent / ownership revoke → 410.
  if (record.agentId) {
    const verified = await resolveVerifiedAgentScope(session, record.agentId);
    if (verified !== record.agentId) {
      authority.revoke(handle);
      return gone();
    }
  }

  const surface = await resolveVisiblePackageSurface(
    { ...session, agentId: record.agentId },
    record.packageId,
    record.surfaceKind,
    record.surfaceId,
  );
  if (
    !surface ||
    surface.fingerprint !== record.fingerprint ||
    surface.generation !== record.generation ||
    surface.trust !== record.trust
  ) {
    authority.revoke(handle);
    return gone();
  }

  authority.touch(handle);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const body = await readBody(req);
  const handle = typeof body.handle === 'string' ? body.handle : '';

  // Own close is capability-REDUCING: it must keep working after project
  // access loss, so only the cookie user is authenticated — the authority
  // itself enforces the record-user match. Idempotent, non-enumerating.
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (handle) getPackageAssetScopeAuthority().close(handle, user.id);
  return NextResponse.json({ ok: true });
}
