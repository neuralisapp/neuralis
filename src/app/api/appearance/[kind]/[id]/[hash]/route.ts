/**
 * GET /api/appearance/{user|project}/{id}/{hash} — a stored appearance picture.
 *
 * The byte lane for pictures a member uploaded, so the browser must never be
 * asked to RENDER anything but an image: the stored file was accepted by its
 * BYTES (PNG, JPEG or WebP — never SVG), the response type is the one stored
 * with it, and `nosniff` keeps the browser from guessing another. The stored
 * type is trusted on read, without a re-sniff: the record is server-written
 * only (`parseAppearancePatch` accepts an upload, never a `{hash, mimeType}`
 * object), and the files live under `users-assets/` and
 * `projects/<id>/appearance/`, outside every member-writable source zone.
 *
 * Gate = the read gate of the record the picture belongs to:
 * - `user`    — yourself, or a user you share a project with (the profile GET's
 *               gate, `canViewUserProfile`);
 * - `project` — a member, through the ONE member resolver (an archived project
 *               or a removed member is refused).
 * The hash must be the record's CURRENT picture.
 *
 * EVERY refusal — no session, a stranger, an unknown id, a stale hash, a
 * missing file — is the same 404, so the route is no existence oracle. The URL
 * is content-addressed, so a hit is cached immutably by the browser.
 * Named residual: a browser that already cached the bytes keeps them after its
 * user loses access.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { getSessionUser } from '@/server/auth/session';
import { getUserById } from '@/server/store/UserStore';
import { canViewUserProfile, resolveProjectAccess } from '@/server/projects/access';
import {
  isAppearanceImageHash,
  readAppearanceImage,
  type AppearanceImageKind,
  type StoredAppearanceImage,
} from '@/server/appearance/appearanceImageStore';

type Params = { params: Promise<{ kind: string; id: string; hash: string }> };

function notFound(): NextResponse {
  return NextResponse.json({ error: 'not_found' }, { status: 404 });
}

/** The record's current picture, when the viewer may read the record — `null` otherwise. */
async function visibleImage(
  viewerId: string,
  kind: AppearanceImageKind,
  id: string,
): Promise<StoredAppearanceImage | null> {
  if (kind === 'user') {
    if (!(await canViewUserProfile(viewerId, id))) return null;
    return (await getUserById(id))?.appearance?.image ?? null;
  }
  const access = await resolveProjectAccess(viewerId, id);
  return access?.project.appearance?.image ?? null;
}

export async function GET(_req: NextRequest, { params }: Params): Promise<NextResponse> {
  try {
    const session = await getSessionUser().catch(() => null);
    if (!session) return notFound();
    const { kind, id, hash } = await params;
    if ((kind !== 'user' && kind !== 'project') || !isAppearanceImageHash(hash)) return notFound();

    const image = await visibleImage(session.id, kind, id);
    if (!image || image.hash !== hash) return notFound();
    const bytes = await readAppearanceImage(kind, id, image);
    if (!bytes) return notFound();

    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': image.mimeType,
        'Content-Length': String(bytes.byteLength),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    });
  } catch (err) {
    console.error('[appearance] picture read failed', err instanceof Error ? err.name : 'unknown');
    return notFound();
  }
}
