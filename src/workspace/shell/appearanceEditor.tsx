'use client';

/**
 * What the two appearance editors — the user profile and the project editor —
 * share: the editing state behind the kernel `IconPicker` (the icon/colour pair
 * plus a picture that is kept, replaced by an upload, or removed) and the
 * portaled popup frame with its Save / Cancel / Reset row.
 *
 * Nothing here talks to the server: {@link AppearanceDraft.payload} builds the
 * `appearance` body both PATCH routes accept (`{ iconName, color, background,
 * image? }`, the picture as a base64 data URL only when it changed).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  APPEARANCE_IMAGE_MAX_BYTES,
  type AppearanceValue,
  type IconPickerImageSlot,
} from '@neuralis/package-system/client';
import type { AvatarAppearance } from './UserAvatar';

export type AppearanceDraftSeed = {
  iconName?: string | null;
  color?: string | null;
  /** URL of the stored picture, when there is one. */
  imageUrl?: string | null;
  background?: AppearanceBackground | null;
};

/** The tile behind the icon: the chosen colour (default) or none. */
export type AppearanceBackground = 'filled' | 'transparent';

/** The `appearance` object of a PATCH body. */
export type AppearancePayload = {
  iconName: string | null;
  color: string | null;
  background: AppearanceBackground;
  image?: string | null;
};

export type AppearanceDraft = {
  value: AppearanceValue;
  onChange(next: AppearanceValue): void;
  background: AppearanceBackground;
  onBackground(next: AppearanceBackground): void;
  imageSlot: IconPickerImageSlot;
  /** What the avatar preview draws right now. */
  preview: AvatarAppearance;
  payload(): Promise<AppearancePayload>;
};

type Picture = { kind: 'keep' } | { kind: 'upload'; blob: Blob; url: string } | { kind: 'remove' };

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('The picture could not be read.'));
    reader.readAsDataURL(blob);
  });
}

/** Re-seeded every time `open` turns true, so a cancelled edit never leaks into the next one. */
export function useAppearanceDraft(seed: AppearanceDraftSeed, open: boolean): AppearanceDraft {
  const [iconName, setIconName] = useState<string | null>(seed.iconName ?? null);
  const [color, setColor] = useState<string | null>(seed.color ?? null);
  const [background, setBackground] = useState<AppearanceBackground>(seed.background ?? 'filled');
  const [picture, setPicture] = useState<Picture>({ kind: 'keep' });
  const objectUrl = useRef<string | null>(null);

  const revoke = useCallback(() => {
    if (objectUrl.current) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
  }, []);

  useEffect(() => {
    if (!open) return;
    setIconName(seed.iconName ?? null);
    setColor(seed.color ?? null);
    setBackground(seed.background ?? 'filled');
    setPicture({ kind: 'keep' });
    revoke();
    // Re-seed on OPEN only — a background refresh of the stored value must not
    // overwrite an edit in progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => revoke, [revoke]);

  const imageUrl =
    picture.kind === 'upload' ? picture.url : picture.kind === 'remove' ? null : seed.imageUrl ?? null;

  const value = useMemo<AppearanceValue>(
    () => ({ iconName, color, image: imageUrl ? { url: imageUrl } : null }),
    [iconName, color, imageUrl],
  );

  const onChange = useCallback((next: AppearanceValue) => {
    setIconName(next.iconName);
    setColor(next.color);
  }, []);

  const imageSlot = useMemo<IconPickerImageSlot>(
    () => ({
      maxBytes: APPEARANCE_IMAGE_MAX_BYTES,
      onUpload(blob) {
        revoke();
        const url = URL.createObjectURL(blob);
        objectUrl.current = url;
        setPicture({ kind: 'upload', blob, url });
      },
      onClear() {
        revoke();
        setPicture({ kind: 'remove' });
      },
    }),
    [revoke],
  );

  const preview = useMemo<AvatarAppearance>(
    () => ({ iconName, color, imageUrl, background }),
    [iconName, color, imageUrl, background],
  );

  const payload = useCallback(async (): Promise<AppearancePayload> => {
    const body: AppearancePayload = { iconName, color, background };
    if (picture.kind === 'upload') body.image = await blobToDataUrl(picture.blob);
    else if (picture.kind === 'remove') body.image = null;
    return body;
  }, [iconName, color, background, picture]);

  return { value, onChange, background, onBackground: setBackground, imageSlot, preview, payload };
}

/**
 * Beside the picker: the icon on a tile of its colour, or on nothing (the icon
 * drawn in the colour; a picture keeps its own alpha). The preview above the
 * picker follows at once.
 */
export function AppearanceBackgroundToggle({ draft }: { draft: Pick<AppearanceDraft, 'background' | 'onBackground'> }) {
  const options: { value: AppearanceBackground; label: string; hint: string }[] = [
    { value: 'filled', label: 'Tile', hint: 'The icon on a tile of its colour' },
    { value: 'transparent', label: 'Transparent', hint: 'No tile — the icon drawn in its colour' },
  ];
  return (
    <div className="mt-3 flex items-center gap-2">
      <span className="text-[10px] font-semibold text-white/40 uppercase tracking-wider">Background</span>
      <div className="grid grid-cols-2 gap-0.5 rounded-lg bg-white/[0.05] p-0.5" role="radiogroup" aria-label="Background">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={draft.background === option.value}
            onClick={() => draft.onBackground(option.value)}
            title={option.hint}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors',
              draft.background === option.value ? 'bg-white/15 text-white' : 'text-white/50 hover:text-white/80',
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'w-2.5 h-2.5 rounded-[3px]',
                option.value === 'filled' ? 'bg-white/70' : 'border border-dashed border-white/60',
              )}
            />
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The portaled popup frame: a click-away scrim, the panel at `anchor`, an
 * optional error line and the action row. `fixed` overlays portal to
 * `document.body` (a dock or widget ancestor may create a containing block).
 */
export function AppearancePopupFrame({
  anchor,
  title,
  onClose,
  onSave,
  onReset,
  saving,
  error,
  children,
}: {
  anchor: { top: number; left: number };
  title: string;
  onClose(): void;
  onSave(): void;
  onReset?: () => void;
  saving: boolean;
  error: string | null;
  children: ReactNode;
}) {
  if (typeof document === 'undefined') return null;
  return createPortal(
    <>
      <div className="fixed inset-0" style={{ zIndex: 9998 }} onClick={onClose} />
      <div
        role="dialog"
        aria-label={title}
        className="fixed bg-black/95 backdrop-blur-xl rounded-xl border border-white/10 p-4 shadow-2xl"
        style={{
          zIndex: 9999,
          top: Math.max(8, Math.min(anchor.top, window.innerHeight - 560)),
          left: Math.max(8, Math.min(anchor.left, window.innerWidth - 392)),
          width: 380,
          maxHeight: 'calc(100vh - 16px)',
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <div className="max-h-[calc(100vh-120px)] overflow-y-auto pr-1">{children}</div>
        {error ? (
          <div role="alert" className="mt-3 px-2.5 py-1.5 rounded-lg bg-rose-500/10 border border-rose-500/30 text-[11px] text-rose-300">
            {error}
          </div>
        ) : null}
        <div className="mt-3 flex items-center justify-between pt-2 border-t border-white/[0.08]">
          {onReset ? (
            <button
              type="button"
              onClick={onReset}
              disabled={saving}
              className="px-2.5 py-1.5 rounded-lg text-[11px] text-white/55 hover:text-white/85 disabled:opacity-50"
            >
              Reset to default
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-3 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] border border-white/10 text-[11px] text-white/70"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={saving}
              className="px-3 py-1.5 rounded-lg bg-white/[0.12] hover:bg-white/[0.16] border border-white/15 text-[11px] text-white/85 font-medium flex items-center gap-1.5"
            >
              {saving ? <Loader2 className="w-3 h-3 motion-safe:animate-spin" /> : null}
              Save
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}

/** A failed PATCH's message, or the fallback. */
export async function responseError(res: Response, fallback: string): Promise<string> {
  const body: unknown = await res.json().catch(() => null);
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message;
    if (typeof record.error === 'string' && res.status !== 500) return record.error;
  }
  return fallback;
}
