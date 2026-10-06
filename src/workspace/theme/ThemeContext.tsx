'use client';

import React, { createContext, useCallback, useEffect, useState, type ReactNode } from 'react';
import type { Theme } from './types';
import { DEFAULT_THEME, THEMES } from './themes';

export interface ThemeContextType {
  theme: Theme;
  setThemeId: (id: string) => void;
  availableThemes: Theme[];
  backgroundImage: string | null;
  setBackgroundImage: (file: File) => Promise<void>;
  clearBackgroundImage: () => void;
  toggleUniverse: () => void;
}

export const ThemeContext = createContext<ThemeContextType | null>(null);

const STORAGE_KEY = 'neuralis_theme_id';
const BACKGROUND_IMAGE_STORAGE_KEY = 'neuralis_workspace_background_image';
const UNIVERSE_BG_KEY = 'neuralis_universe_bg';
const MAX_BACKGROUND_FILE_BYTES = 2 * 1024 * 1024;

function readLocalStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    throw new Error('Background image could not be stored in the browser.');
  }
}

function removeLocalStorage(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') {
        resolve(result);
        return;
      }
      reject(new Error('Unsupported file content.'));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file.'));
    reader.readAsDataURL(file);
  });
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [baseTheme, setBaseTheme] = useState<Theme>(DEFAULT_THEME);
  const [universeOverride, setUniverseOverride] = useState<boolean | null>(null);
  const [backgroundImage, setBackgroundImageState] = useState<string | null>(null);

  // Effective theme: apply universe override
  const theme: Theme = universeOverride !== null
    ? { ...baseTheme, useUniverseBackground: universeOverride }
    : baseTheme;

  useEffect(() => {
    const savedId = readLocalStorage(STORAGE_KEY);
    if (savedId) {
      const found = THEMES.find((t) => t.id === savedId);
      if (found) setBaseTheme(found);
    }
    const savedUniverse = readLocalStorage(UNIVERSE_BG_KEY);
    if (savedUniverse !== null) {
      setUniverseOverride(savedUniverse === 'true');
    }
    setBackgroundImageState(readLocalStorage(BACKGROUND_IMAGE_STORAGE_KEY));
  }, []);

  const setThemeId = useCallback((id: string) => {
    const found = THEMES.find((t) => t.id === id);
    if (found) {
      setBaseTheme(found);
      writeLocalStorage(STORAGE_KEY, id);
    }
  }, []);

  const toggleUniverse = useCallback(() => {
    setUniverseOverride((prev) => {
      const current = prev ?? (baseTheme.useUniverseBackground !== false);
      const next = !current;
      writeLocalStorage(UNIVERSE_BG_KEY, String(next));
      return next;
    });
  }, [baseTheme]);

  const setBackgroundImage = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) {
      throw new Error('Only image files are supported.');
    }
    if (file.size > MAX_BACKGROUND_FILE_BYTES) {
      throw new Error('Image is too large. Use a file under 2 MB.');
    }

    const dataUrl = await fileToDataUrl(file);
    writeLocalStorage(BACKGROUND_IMAGE_STORAGE_KEY, dataUrl);
    setBackgroundImageState(dataUrl);
  }, []);

  const clearBackgroundImage = useCallback(() => {
    removeLocalStorage(BACKGROUND_IMAGE_STORAGE_KEY);
    setBackgroundImageState(null);
  }, []);

  return (
    <ThemeContext.Provider
      value={{ theme, setThemeId, availableThemes: THEMES, backgroundImage, setBackgroundImage, clearBackgroundImage, toggleUniverse }}
    >
      <div
        style={{
          '--bg-gradient': theme.colors.background,
          '--bg-pattern': theme.colors.backgroundPattern,
          '--bg-overlay': theme.colors.backgroundOverlay,
          '--bg-image': backgroundImage ? `url("${backgroundImage}")` : 'none',
          '--bg-image-opacity': backgroundImage ? (theme.useUniverseBackground !== false ? '0.34' : '0.7') : '0',
          '--bg-universe-opacity': String(theme.useUniverseBackground !== false ? theme.colors.universeOpacity : 0),
          '--w-bg-rgb': theme.colors.widgetBg,
          '--w-composer-bg-rgb': theme.colors.composerBg,
          '--w-opacity': String(theme.colors.widgetOpacity),
          '--w-border': theme.colors.widgetBorder,
          '--w-text': theme.colors.widgetText,
          '--w-blur': theme.colors.backdropBlur,
          '--w-shadow': theme.colors.widgetShadow,
          '--w-surface-image': theme.colors.panelSurfaceImage,
          '--icon-accent': theme.colors.iconAccent,
          '--icon-muted': theme.colors.iconMuted,
          '--dock-icon-filesystem': theme.colors.dockIconFilesystem,

          '--dock-icon-billing': theme.colors.dockIconBilling,
          '--dock-icon-media': theme.colors.dockIconMedia,
          '--dock-icon-library': theme.colors.dockIconLibrary,
          '--dock-icon-widgets': theme.colors.dockIconWidgets,
          '--dock-icon-add': theme.colors.dockIconAdd,
          '--dock-icon-user': theme.colors.dockIconUser,
          '--dock-icon-project': theme.colors.dockIconProject,
          '--scroll-track': 'rgba(255, 255, 255, 0.05)',
          '--scroll-thumb': 'rgba(255, 255, 255, 0.12)',
          '--scroll-thumb-hover': 'rgba(255, 255, 255, 0.16)',
          // Theme-scoped form-control + selection colors consumed by globals.css
          '--control-surface': theme.colors.controlSurface,
          '--control-surface-elevated': theme.colors.controlSurfaceElevated,
          '--control-border': theme.colors.controlBorder,
          '--control-text': theme.colors.controlText,
          '--control-placeholder': theme.colors.controlPlaceholder,
          '--selection-bg': theme.colors.selectionBg,
          '--selection-fg': theme.colors.selectionFg,
          // Legacy --color-* overrides so any third-party CSS still using the
          // original palette inherits the active theme instead of the indigo defaults.
          '--color-surface': theme.colors.controlSurface,
          '--color-surface-light': theme.colors.controlSurfaceElevated,
          '--color-border': theme.colors.controlBorder,
          '--color-accent': theme.colors.selectionBg,
          '--color-accent-light': theme.colors.controlSurfaceElevated,
        } as React.CSSProperties}
        className="h-full w-full"
      >
        <style jsx global>{`
          * {
            scrollbar-width: thin;
            scrollbar-color: var(--scroll-thumb) var(--scroll-track);
          }
          *::-webkit-scrollbar {
            width: 10px;
            height: 10px;
          }
          *::-webkit-scrollbar-track {
            background: var(--scroll-track);
            border-radius: 999px;
          }
          *::-webkit-scrollbar-thumb {
            background: var(--scroll-thumb);
            border-radius: 999px;
            border: 2px solid transparent;
            background-clip: padding-box;
          }
          *::-webkit-scrollbar-thumb:hover {
            background: var(--scroll-thumb-hover);
            border: 2px solid transparent;
            background-clip: padding-box;
          }
        `}</style>
        {children}
      </div>
    </ThemeContext.Provider>
  );
}
