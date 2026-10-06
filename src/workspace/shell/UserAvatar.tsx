'use client';

import React, { useMemo } from 'react';
import { User as UserIcon } from 'lucide-react';
import { resolveLucideIcon } from '@neuralis/package-system/client';
import { cn } from '@/lib/cn';
import type { UserAppearance } from '@/server/store/UserStore';
import { useUserAppearance, useUserName } from './useUserAppearance';

/**
 * The browser URL of a stored appearance picture. Content-addressed: the hash
 * IS the cache key, so the route answers it `immutable` and a new picture is a
 * new URL. The route (`app/api/appearance/[kind]/[id]/[hash]`) gates it with
 * the record's own read gate.
 */
export function appearanceImageUrl(kind: 'user' | 'project', ownerId: string, hash: string): string {
  return `/api/appearance/${kind}/${encodeURIComponent(ownerId)}/${encodeURIComponent(hash)}`;
}

/** What {@link AppearanceAvatar} draws: an icon, a colour, an optional picture URL and the tile choice. */
export type AvatarAppearance = {
  iconName?: string | null;
  color?: string | null;
  imageUrl?: string | null;
  /** `transparent`: no tile — the icon/monogram drawn IN the colour, a picture on its own alpha. */
  background?: 'filled' | 'transparent' | null;
};

/**
 * The ONE appearance renderer — users and projects (agents keep their dock
 * tile). Render priority:
 *   1. the picture, `contain`-ed ON the chosen colour, so a transparent PNG
 *      shows the colour through it;
 *   2. the library icon on the colour;
 *   3. the monogram on the colour;
 *   4. the lucide `User` glyph on the colour.
 * With `background: 'transparent'` there is no tile: the icon, monogram or
 * glyph is drawn IN the colour, and a picture shows on its own alpha.
 * The colour falls back to a deterministic hue derived from `seed`.
 */
export function AppearanceAvatar({
  appearance,
  seed,
  monogram,
  label,
  size = 14,
  shape = 'circle',
  className,
  ringClassName,
}: {
  appearance: AvatarAppearance | null | undefined;
  /** Stable id the fallback colour is derived from. */
  seed: string;
  monogram?: string | null;
  /** Accessible name and tooltip. */
  label: string;
  size?: number;
  shape?: 'circle' | 'tile';
  className?: string;
  ringClassName?: string;
}) {
  const fallbackColor = useMemo(() => deriveAvatarColor(seed), [seed]);
  const tint = appearance?.color || fallbackColor;
  const clear = appearance?.background === 'transparent';
  const IconComp = appearance?.iconName ? resolveLucideIcon(appearance.iconName) : null;
  const glyphScale = clear ? 0.86 : 0.65;
  const glyph = { width: size * glyphScale, height: size * glyphScale };

  return (
    <span
      className={cn(
        'inline-flex items-center justify-center overflow-hidden shrink-0 select-none',
        !clear && 'text-white',
        shape === 'circle' ? 'rounded-full' : 'rounded-md',
        ringClassName,
        className,
      )}
      style={{
        ...(clear ? { color: tint } : { backgroundColor: tint }),
        width: size,
        height: size,
        fontSize: Math.round(size * (clear ? 0.75 : 0.55)),
        fontWeight: 700,
        lineHeight: 1,
      }}
      title={label}
      aria-label={label}
    >
      {appearance?.imageUrl ? (
        <img
          src={appearance.imageUrl}
          alt=""
          draggable={false}
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        />
      ) : IconComp ? (
        <IconComp style={glyph} />
      ) : (
        monogram ?? <UserIcon style={glyph} />
      )}
    </span>
  );
}

/** A stored user appearance as the avatar draws it. */
export function userAvatarAppearance(userId: string | null | undefined, appearance: UserAppearance | null | undefined): AvatarAppearance | null {
  if (!appearance) return null;
  return {
    iconName: appearance.iconName ?? null,
    color: appearance.color ?? null,
    imageUrl: userId && appearance.image?.hash ? appearanceImageUrl('user', userId, appearance.image.hash) : null,
    background: appearance.background ?? null,
  };
}

/**
 * A user's avatar — the {@link AppearanceAvatar} of their profile, fetched once
 * per user and shared by every instance (`useUserAppearance`), unless the
 * caller passes an explicit `appearance` (the profile editor's live preview).
 *
 * Used by:
 *   - `UserInfo` (workspace-dock account button).
 *   - `ConversationPicker` (user-icon stack on the conversations tab).
 *   - chat assistant turn footer (3-icon stack: avatar + spinner + check).
 */
export function UserAvatar({
  userId,
  name,
  size = 14,
  className,
  title,
  ringClassName,
  appearance: appearanceProp,
}: {
  userId: string | null | undefined;
  name?: string | null;
  size?: number;
  className?: string;
  title?: string;
  ringClassName?: string;
  /** Explicit appearance override. Skips the `useUserAppearance` lookup. */
  appearance?: AvatarAppearance | null;
}) {
  const fetched = useUserAppearance(appearanceProp === undefined ? userId : null);
  const appearance = appearanceProp === undefined ? userAvatarAppearance(userId, fetched) : appearanceProp;
  // Hover tooltip resolution: explicit `name` prop wins; otherwise look the
  // display name up via the same module-level cache `useUserAppearance` uses
  // (the GET response carries `name` alongside `appearance`). This keeps
  // hover labels stable as user-name when participantUserIds[] arrive without
  // names. Falls back to userId then 'User' when nothing is cached yet.
  const fetchedName = useUserName(name == null && userId ? userId : null);
  const resolvedName = name ?? fetchedName ?? null;
  const initial = useMemo(() => deriveInitial(resolvedName), [resolvedName]);

  return (
    <AppearanceAvatar
      appearance={appearance}
      seed={userId ?? ''}
      monogram={initial}
      label={title ?? resolvedName ?? userId ?? 'User'}
      size={size}
      className={className}
      ringClassName={ringClassName}
    />
  );
}

/**
 * Stack avatars side-by-side with a slight overlap, like GitHub's
 * "people on this PR" affordance. Used on the conversations tab head.
 */
export function UserAvatarStack({
  users,
  size = 16,
  max = 3,
}: {
  users: Array<{ userId: string; name?: string | null }>;
  size?: number;
  max?: number;
}) {
  const visible = users.slice(0, max);
  const overflow = users.length - visible.length;
  return (
    <span className="inline-flex items-center">
      {visible.map((u, i) => (
        <UserAvatar
          key={u.userId}
          userId={u.userId}
          name={u.name ?? null}
          size={size}
          ringClassName="ring-1 ring-black/40"
          className={i > 0 ? '-ml-1.5' : ''}
        />
      ))}
      {overflow > 0 ? (
        <span
          className="inline-flex items-center justify-center rounded-full bg-white/15 text-white/85 ring-1 ring-black/40 -ml-1.5"
          style={{ width: size, height: size, fontSize: Math.round(size * 0.5), fontWeight: 700 }}
          title={`+${overflow} more`}
        >
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}

// ── Internals ───────────────────────────────────────────────────────────

function deriveAvatarColor(seed: string): string {
  if (!seed) return 'hsl(220 12% 38%)';
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  // Mid-saturation, mid-light so the white text + icon contrast cleanly.
  return `hsl(${hue} 62% 48%)`;
}

export function deriveInitial(name: string | null | undefined): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  const first = trimmed[0];
  return first ? first.toUpperCase() : null;
}
