import { NextResponse, type NextRequest } from 'next/server';
import { getSessionUser } from '@/server/auth/session';
import { getUserById, updateUser, type UserAppearance, type UserRecord } from '@/server/store/UserStore';
import { canViewUserProfile } from '@/server/projects/access';
import {
  AppearanceImageError,
  AppearancePatchError,
  applyAppearancePatch,
  parseAppearancePatch,
  removeAppearanceImage,
  writeAppearanceImage,
  type AppearancePatch,
  type StoredAppearanceImage,
} from '@/server/appearance/appearanceImageStore';

/**
 * GET  /api/user/profile           → caller's own profile.
 * GET  /api/user/profile?userId=X  → another user's appearance + display
 *                                    fields. Used by `useUserAppearance`
 *                                    when rendering avatars for users
 *                                    other than the caller — so only for a
 *                                    user who shares a project with the
 *                                    caller; anyone else is the same 404 as
 *                                    an unknown id.
 *
 * Returns only the public-display fields (id, name, email, appearance). The
 * picture is a reference (`appearance.image.hash`); its bytes are served by
 * `GET /api/appearance/user/<id>/<hash>` behind the same gate.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getSessionUser().catch(() => null);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const userId = req.nextUrl.searchParams.get('userId') ?? session.id;
  if (!(await canViewUserProfile(session.id, userId))) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const user = await getUserById(userId);
  if (!user) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  return NextResponse.json(profileBody(user));
}

/**
 * PATCH /api/user/profile  body `{ appearance }` — the caller's own appearance.
 *
 * `appearance: null` resets everything, the picture included. An object may
 * carry `iconName` + `color` (they replace the current pair) and `image`: a
 * base64 PNG/JPEG/WebP (≤ `APPEARANCE_IMAGE_MAX_BYTES`) becomes the picture,
 * `null` removes it, absent keeps it. The bytes decide the type — an SVG, a
 * renamed executable or a lying `data:` prefix is a 400 and nothing is written.
 * A replaced or removed picture's file is deleted once the record no longer
 * names it.
 */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const session = await getSessionUser().catch(() => null);
  if (!session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('appearance' in body)) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  let patch: AppearancePatch;
  let stored: StoredAppearanceImage | undefined;
  try {
    patch = parseAppearancePatch((body as { appearance: unknown }).appearance);
    if (patch.image) stored = await writeAppearanceImage('user', session.id, patch.image);
  } catch (err) {
    if (err instanceof AppearancePatchError || err instanceof AppearanceImageError) {
      return NextResponse.json({ error: 'invalid_appearance', message: err.message }, { status: 400 });
    }
    throw err;
  }

  const seen: { previous?: StoredAppearanceImage } = {};
  const updated = await updateUser(session.id, (current) => {
    seen.previous = current.appearance?.image;
    return { appearance: applyAppearancePatch(current.appearance, patch, stored) };
  });
  if (!updated) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const previous = seen.previous;
  if (previous && previous.hash !== updated.appearance?.image?.hash) {
    await removeAppearanceImage('user', session.id, previous).catch(() => undefined);
  }
  return NextResponse.json(profileBody(updated));
}

function profileBody(user: UserRecord): {
  id: string;
  name: string;
  email: string;
  appearance: UserAppearance | null;
} {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    appearance: user.appearance ?? null,
  };
}
