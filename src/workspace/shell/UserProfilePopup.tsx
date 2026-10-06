'use client';

import React, { useCallback, useMemo, useState } from 'react';
import { IconPicker } from '@neuralis/package-system/client';
import type { UserAppearance } from '@/server/store/UserStore';
import { setUserAppearance, useUserAppearance } from './useUserAppearance';
import { UserAvatar, appearanceImageUrl, deriveInitial } from './UserAvatar';
import { AppearanceBackgroundToggle, AppearancePopupFrame, responseError, useAppearanceDraft, type AppearanceDraft } from './appearanceEditor';

/** Library names shown first in the profile picker — data, never a second vocabulary. */
const SUGGESTED_USER_ICONS = [
  'User',
  'Smile',
  'Sparkles',
  'Rocket',
  'Brain',
  'Heart',
  'Star',
  'Shield',
  'Coffee',
  'Music',
  'Globe',
  'Leaf',
];

type Props = {
  userId: string;
  userName: string;
  isOpen: boolean;
  onClose: () => void;
  /** Anchor coordinates (page-relative); the popup positions itself nearby. */
  anchor: { top: number; left: number };
};

/**
 * The profile body: the live avatar preview over the kernel `IconPicker`
 * (search, categories, colour, a picture slot that downscales in the browser).
 * Pure render over a draft — exported for the render test.
 */
export function UserProfileEditor({
  userId,
  userName,
  draft,
}: {
  userId: string;
  userName: string;
  draft: AppearanceDraft;
}) {
  return (
    <>
      <div className="flex items-center gap-3 mb-3">
        <UserAvatar userId={userId} name={userName} size={48} appearance={draft.preview} ringClassName="ring-2 ring-white/15" />
        <div className="min-w-0">
          <div className="text-sm text-white/85 font-medium truncate">{userName}</div>
          <div className="text-[11px] text-white/45">How you appear to your teammates</div>
        </div>
      </div>
      <IconPicker
        value={draft.value}
        onChange={draft.onChange}
        imageSlot={draft.imageSlot}
        suggested={SUGGESTED_USER_ICONS}
        monogram={deriveInitial(userName) ?? ''}
        shape="circle"
      />
      <AppearanceBackgroundToggle draft={draft} />
    </>
  );
}

/**
 * In-place editor for `UserAppearance`. On Save it PATCHes
 * `/api/user/profile` with `{ appearance }` and updates the shared avatar cache
 * so every avatar refreshes; a picture travels only when it changed.
 */
export function UserProfilePopup({ userId, userName, isOpen, onClose, anchor }: Props): React.ReactElement | null {
  const live = useUserAppearance(userId);
  const seed = useMemo(
    () => ({
      iconName: live?.iconName ?? null,
      color: live?.color ?? null,
      imageUrl: live?.image?.hash ? appearanceImageUrl('user', userId, live.image.hash) : null,
      background: live?.background ?? null,
    }),
    [live, userId],
  );
  const draft = useAppearanceDraft(seed, isOpen);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useCallback(
    async (appearance: unknown) => {
      setSaving(true);
      setError(null);
      try {
        const res = await fetch('/api/user/profile', {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ appearance }),
        });
        if (!res.ok) {
          setError(await responseError(res, 'Failed to save profile.'));
          return;
        }
        const body = (await res.json()) as { appearance?: UserAppearance | null };
        setUserAppearance(userId, body.appearance ?? null);
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save profile.');
      } finally {
        setSaving(false);
      }
    },
    [userId, onClose],
  );

  if (!isOpen) return null;

  return (
    <AppearancePopupFrame
      anchor={anchor}
      title="Edit profile"
      onClose={onClose}
      onSave={() => void draft.payload().then(save, (err: unknown) => setError(err instanceof Error ? err.message : 'Failed to read the picture.'))}
      onReset={() => void save(null)}
      saving={saving}
      error={error}
    >
      <UserProfileEditor userId={userId} userName={userName} draft={draft} />
    </AppearancePopupFrame>
  );
}
