'use client';

import { Palette, ChevronUp, ChevronDown, ImagePlus, Trash2, Sparkles } from 'lucide-react';
import { useRef, useState, type ChangeEvent } from 'react';
import { cn } from '@/lib/cn';
import { useTheme } from '../theme/useTheme';

type Props = {
  expanded?: boolean;
  align?: 'left' | 'right';
  pinned?: boolean;
};

export function ThemeSwitcher({ expanded = false, align = 'left', pinned = true }: Props) {
  const { theme, setThemeId, availableThemes, backgroundImage, setBackgroundImage, clearBackgroundImage, toggleUniverse } = useTheme();
  const universeOn = theme.useUniverseBackground !== false;
  const [isOpen, setIsOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handlePickBackground = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploadError(null);
    setIsUploading(true);
    try {
      await setBackgroundImage(file);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : 'Background image could not be applied.');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  return (
    <div className="relative">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handlePickBackground}
      />
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className={cn(
          'rounded-xl transition flex items-center shrink-0 overflow-hidden',
          pinned ? 'bg-white/12 hover:bg-white/20' : 'bg-neutral-700 hover:bg-neutral-600',
          expanded ? 'w-full h-11 px-0' : 'w-12 h-11 justify-center',
          align === 'right' ? 'flex-row-reverse' : 'flex-row',
        )}
        title="Theme"
      >
        <div className="w-12 h-full flex items-center justify-center shrink-0">
          <Palette className="w-5 h-5 text-white/75" />
        </div>
        {expanded ? (
          <div className={cn('flex-1 flex items-center min-w-0 text-white/70', align === 'right' ? 'pl-3 justify-center' : 'pr-3 justify-center')}>
            <span className="truncate text-xs font-medium mr-1">{theme.name}</span>
            <ChevronUp className="w-3 h-3 opacity-50" />
          </div>
        ) : null}
      </button>

      {isOpen ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div
            className={cn(
              'absolute bottom-full mb-2 z-50 bg-black/85 backdrop-blur-xl rounded-xl overflow-hidden',
              expanded ? 'w-full' : 'w-44',
              align === 'right' ? 'right-0' : 'left-0',
            )}
          >
            {/* Theme selection — always visible */}
            <div className="px-3 pt-2.5 pb-1 text-[10px] font-semibold text-white/40 uppercase tracking-wider">Theme</div>
            {availableThemes.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setThemeId(t.id);
                  setIsOpen(false);
                }}
                className={cn(
                  'w-full text-left px-4 py-1.5 text-sm transition-colors flex items-center gap-2',
                  theme.id === t.id ? 'bg-white/10 text-white' : 'text-white/70 hover:bg-white/5 hover:text-white',
                )}
              >
                <div className="w-2.5 h-2.5 rounded-full" style={{ background: t.colors.primary }} />
                {t.name}
              </button>
            ))}

            {/* Collapsible more section */}
            <div className="mx-3 mt-1 h-px bg-white/[0.08]" />
            <button
              type="button"
              onClick={() => setMoreOpen((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-1.5 text-[10px] font-semibold text-white/40 uppercase tracking-wider hover:text-white/55 transition"
            >
              <span>Effects & Background</span>
              {moreOpen
                ? <ChevronDown className="w-3 h-3" />
                : <ChevronUp className="w-3 h-3" />
              }
            </button>

            {moreOpen ? (
              <div className="pb-3">
                {/* Universe toggle */}
                <div className="px-3 pb-2">
                  <button
                    type="button"
                    onClick={toggleUniverse}
                    className={cn(
                      'w-full rounded-lg border px-3 py-2 text-left text-xs transition flex items-center gap-2',
                      universeOn
                        ? 'border-white/15 bg-white/[0.08] text-white/80'
                        : 'border-white/10 bg-white/[0.04] text-white/50',
                    )}
                  >
                    <Sparkles className="h-3.5 w-3.5 shrink-0" />
                    <span>Universe</span>
                    <span className={cn(
                      'ml-auto text-[10px] font-medium uppercase',
                      universeOn ? 'text-green-400/70' : 'text-white/30',
                    )}>
                      {universeOn ? 'On' : 'Off'}
                    </span>
                  </button>
                </div>

                {/* Background image */}
                <div className="px-3 space-y-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploading}
                    className="w-full rounded-lg border border-white/10 bg-white/[0.06] px-3 py-2 text-left text-xs text-white/80 transition hover:bg-white/10 disabled:opacity-60"
                  >
                    <span className="inline-flex items-center gap-2">
                      <ImagePlus className="h-3.5 w-3.5" />
                      {isUploading ? 'Uploading...' : backgroundImage ? 'Replace image' : 'Upload image'}
                    </span>
                  </button>
                  {backgroundImage ? (
                    <button
                      type="button"
                      onClick={() => {
                        clearBackgroundImage();
                        setUploadError(null);
                      }}
                      className="w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-left text-xs text-white/60 transition hover:bg-white/[0.08] hover:text-white/80"
                    >
                      <span className="inline-flex items-center gap-2">
                        <Trash2 className="h-3.5 w-3.5" />
                        Remove image
                      </span>
                    </button>
                  ) : null}
                  <div className="text-[10px] leading-4 text-white/35">
                    Dark, wide images under 2 MB work best.
                  </div>
                  {uploadError ? <div className="text-[10px] leading-4 text-red-300/90">{uploadError}</div> : null}
                </div>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}