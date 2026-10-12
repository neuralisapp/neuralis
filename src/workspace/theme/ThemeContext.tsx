'use client';

import React, { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Theme } from './types';
import { DEFAULT_THEME, THEMES } from './themes';

export interface ThemeContextType {
  theme: Theme;
  dockTheme: Theme;
  backgroundTheme: Theme;
  setDockThemeId: (id: string) => void;
  setBackgroundThemeId: (id: string) => void;
  setThemeId: (id: string) => void;
  availableThemes: Theme[];
  backgroundImage: string | null;
  setBackgroundImage: (file: File) => Promise<void>;
  clearBackgroundImage: () => void;
  toggleUniverse: () => void;
  /** The three theme ids and the stored universe choice (`null` = the theme's own). */
  appearance: AppearanceIds;
  /**
   * Publish an appearance whose bytes the caller ALREADY wrote (the coordinated
   * layout commit): one state update, no storage write.
   */
  applyAppearance: (next: AppearanceIds) => void;
}

export type AppearanceIds = { themeId: string; dockThemeId: string; backgroundThemeId: string; universe: boolean | null };

export const ThemeContext = createContext<ThemeContextType | null>(null);

const DOCK_THEME_KEY = 'neuralis_dock_theme_id';
const BACKGROUND_THEME_KEY = 'neuralis_background_theme_id';
const STORAGE_KEY = 'neuralis_theme_id';
const BACKGROUND_IMAGE_STORAGE_KEY = 'neuralis_workspace_background_image';
const UNIVERSE_BG_KEY = 'neuralis_universe_bg';
const MAX_BACKGROUND_FILE_BYTES = 2 * 1024 * 1024;

/** The appearance storage keys (the coordinated layout commit writes the first four, never the image). */
export const APPEARANCE_KEYS = Object.freeze({
  theme: STORAGE_KEY,
  dock: DOCK_THEME_KEY,
  background: BACKGROUND_THEME_KEY,
  universe: UNIVERSE_BG_KEY,
  image: BACKGROUND_IMAGE_STORAGE_KEY,
});

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


const scopeStyles = new WeakMap<Theme, React.CSSProperties>();

/**
 * The CSS projection every theme scope root (widget, dock, their portals)
 * wears — ONE frozen object per theme, so a render spreads it without
 * rebuilding it.
 */
export function themeScopeStyle(theme: Theme): React.CSSProperties {
  let style = scopeStyles.get(theme);
  if (!style) {
    style = Object.freeze(themeVariables(theme)) as React.CSSProperties;
    scopeStyles.set(theme, style);
  }
  return style;
}

/** The theme variables proper, shared by every scope root and the provider root. */
function themeVariables(theme: Theme): React.CSSProperties {
  return {
    '--w-bg-rgb': theme.colors.widgetBg,
    '--card-surface-rgb': '20,20,20',
    '--w-composer-bg-rgb': theme.colors.composerBg,
    '--w-opacity': String(theme.colors.widgetOpacity),
    '--w-border': theme.colors.widgetBorder,
    '--w-opaque-border': theme.colors.widgetBorder,
    '--w-dim-border': 'rgba(255,255,255,0.08)',
    '--w-clear-border': 'rgba(255,255,255,0.06)',
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
    '--scroll-track': 'rgba(var(--surface-tone-rgb), 0.05)',
    '--scroll-thumb': 'rgba(var(--surface-tone-rgb), 0.12)',
    '--scroll-thumb-hover': 'rgba(var(--surface-tone-rgb), 0.16)',
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
    '--surface-tone-rgb': '255, 255, 255',
    colorScheme: 'dark',
  } as React.CSSProperties;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [baseTheme, setBaseTheme] = useState<Theme>(DEFAULT_THEME);
  const [dockTheme, setDockTheme] = useState<Theme>(DEFAULT_THEME);
  const [backgroundBaseTheme, setBackgroundBaseTheme] = useState<Theme>(DEFAULT_THEME);
  const [universeOverride, setUniverseOverride] = useState<boolean | null>(null);
  const [backgroundImage, setBackgroundImageState] = useState<string | null>(null);

  const theme = baseTheme;
  const backgroundTheme = useMemo(() => universeOverride !== null
    ? { ...backgroundBaseTheme, useUniverseBackground: universeOverride }
    : backgroundBaseTheme, [backgroundBaseTheme, universeOverride]);
  useEffect(() => {
    const savedId = readLocalStorage(STORAGE_KEY);
    if (savedId) {
      const found = THEMES.find((t) => t.id === savedId);
      if (found) setBaseTheme(found);
    }
    setDockTheme(THEMES.find(t => t.id === (readLocalStorage(DOCK_THEME_KEY) ?? savedId)) ?? DEFAULT_THEME);
    setBackgroundBaseTheme(THEMES.find(t => t.id === (readLocalStorage(BACKGROUND_THEME_KEY) ?? savedId)) ?? DEFAULT_THEME);
    const savedUniverse = readLocalStorage(UNIVERSE_BG_KEY);
    if (savedUniverse !== null) {
      setUniverseOverride(savedUniverse === 'true');
    }
    setBackgroundImageState(readLocalStorage(BACKGROUND_IMAGE_STORAGE_KEY));
  }, []);

  // Every manual setter WRITES first and publishes only a stored value: a
  // storage failure leaves the screen showing what is actually saved.
  const persistThen = (key: string, value: string, publish: () => void): void => {
    try { writeLocalStorage(key, value); } catch { return; }
    publish();
  };
  const setThemeId = useCallback((id: string) => {
    const found = THEMES.find((t) => t.id === id);
    if (found) persistThen(STORAGE_KEY, id, () => setBaseTheme(found));
  }, []);

  const setDockThemeId = useCallback((id: string) => {
    const found = THEMES.find(t => t.id === id);
    if (found) persistThen(DOCK_THEME_KEY, id, () => setDockTheme(found));
  }, []);
  const setBackgroundThemeId = useCallback((id: string) => {
    const found = THEMES.find(t => t.id === id);
    if (found) persistThen(BACKGROUND_THEME_KEY, id, () => setBackgroundBaseTheme(found));
  }, []);

  const toggleUniverse = useCallback(() => {
    const next = !(universeOverride ?? (backgroundBaseTheme.useUniverseBackground !== false));
    persistThen(UNIVERSE_BG_KEY, String(next), () => setUniverseOverride(next));
  }, [backgroundBaseTheme, universeOverride]);

  const applyAppearance = useCallback((next: AppearanceIds) => {
    setBaseTheme(THEMES.find((t) => t.id === next.themeId) ?? DEFAULT_THEME);
    setDockTheme(THEMES.find((t) => t.id === next.dockThemeId) ?? DEFAULT_THEME);
    setBackgroundBaseTheme(THEMES.find((t) => t.id === next.backgroundThemeId) ?? DEFAULT_THEME);
    setUniverseOverride(next.universe);
  }, []);
  const appearance = useMemo<AppearanceIds>(() => ({
    themeId: baseTheme.id, dockThemeId: dockTheme.id, backgroundThemeId: backgroundBaseTheme.id, universe: universeOverride,
  }), [baseTheme, dockTheme, backgroundBaseTheme, universeOverride]);

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
      value={{ theme, dockTheme, backgroundTheme, setDockThemeId, setBackgroundThemeId, setThemeId, availableThemes: THEMES, backgroundImage, setBackgroundImage, clearBackgroundImage, toggleUniverse, appearance, applyAppearance }}
    >
      <div
        style={{
          '--bg-gradient': backgroundTheme.colors.background,
          '--bg-pattern': backgroundTheme.colors.backgroundPattern,
          '--bg-overlay': backgroundTheme.colors.backgroundOverlay,
          '--bg-image': backgroundImage ? `url("${backgroundImage}")` : 'none',
          '--bg-universe-opacity': String(backgroundTheme.useUniverseBackground !== false ? backgroundTheme.colors.universeOpacity : 0),
          ...themeVariables(baseTheme),
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
