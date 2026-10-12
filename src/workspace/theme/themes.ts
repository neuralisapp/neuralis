import type { Theme } from './types';

export const DARK_THEME: Theme = {
  id: 'dark',
  name: 'Dark',
  useUniverseBackground: true,
  colors: {
    background: '#030408',
    backgroundPattern: 'none',
    backgroundOverlay: 'none',
    canvasBg: '#000000',
    canvasStar: '#ffffff',
    widgetBg: '14, 15, 18',
    composerBg: '30, 32, 38',
    widgetBorder: 'transparent',
    widgetText: 'rgba(255, 255, 255, 0.92)',
    primary: '#ffffff',
    iconAccent: 'rgba(255,255,255,0.85)',
    iconMuted: 'rgba(255,255,255,0.45)',
    folderAccent: 'rgba(165,180,252,0.85)',
    warning: 'rgba(252,211,77,0.85)',
    dockIconFilesystem: 'rgba(165,180,252,0.95)',

    dockIconBilling: 'rgba(251,191,36,0.95)',
    dockIconMedia: 'rgba(168,85,247,0.90)',
    dockIconLibrary: 'rgba(34,211,238,0.90)',
    dockIconWidgets: 'rgba(52,211,153,0.90)',
    dockIconAdd: 'rgba(244,114,182,0.90)',
    dockIconUser: 'rgba(167,139,250,0.90)',
    dockIconProject: 'rgba(52,211,153,0.90)',
    widgetOpacity: 0.96,
    backdropBlur: 'blur(10px)',
    widgetShadow: '0 24px 60px -30px rgba(0,0,0,0.88)',
    panelSurfaceImage: 'none',
    universeOpacity: 0.82,
    controlSurface: 'rgba(255,255,255,0.04)',
    controlSurfaceElevated: 'rgba(255,255,255,0.10)',
    controlBorder: 'rgba(255,255,255,0.08)',
    controlText: 'rgba(255,255,255,0.92)',
    controlPlaceholder: 'rgba(255,255,255,0.40)',
    selectionBg: 'rgba(255,255,255,0.20)',
    selectionFg: 'inherit',
  },
};

/**
 * Every theme is DARK polarity — white text on a dark surface, so apps built for
 * the dark design fit each one. They step in lightness (widget L ≈ 6 / 11 / 15 /
 * 23 %): Dark near-black, Focus a deep blue slate, Graphite charcoal, Light a
 * neutral grey at the white-text ceiling — on its widget surface and its Dim glass
 * the median body text (`text-white/55`) still reads >= 4.5:1
 * (`appearanceControls.test.ts` derives the median from the sources).
 */
export const FOCUS_THEME: Theme = {
  id: 'focus',
  name: 'Focus',
  useUniverseBackground: true,
  colors: {
    background: '#0c0e15',
    backgroundPattern: 'none',
    backgroundOverlay: 'none',
    canvasBg: '#000000',
    canvasStar: '#ffffff',
    widgetBg: '23, 25, 32',
    composerBg: '38, 41, 52',
    widgetBorder: 'rgba(255, 255, 255, 0.05)',
    widgetText: 'rgba(255, 255, 255, 0.92)',
    primary: '#93c5fd',
    iconAccent: 'rgba(147,197,253,0.95)',
    iconMuted: 'rgba(255,255,255,0.45)',
    folderAccent: 'rgba(165,180,252,0.85)',
    warning: 'rgba(252,211,77,0.85)',
    dockIconFilesystem: 'rgba(165,180,252,0.95)',

    dockIconBilling: 'rgba(251,191,36,0.95)',
    dockIconMedia: 'rgba(168,85,247,0.90)',
    dockIconLibrary: 'rgba(34,211,238,0.90)',
    dockIconWidgets: 'rgba(52,211,153,0.90)',
    dockIconAdd: 'rgba(244,114,182,0.90)',
    dockIconUser: 'rgba(167,139,250,0.90)',
    dockIconProject: 'rgba(52,211,153,0.90)',
    widgetOpacity: 0.92,
    backdropBlur: 'blur(20px)',
    widgetShadow: '0 18px 42px -28px rgba(0,0,0,0.86)',
    panelSurfaceImage: 'none',
    universeOpacity: 0.6,
    controlSurface: 'rgba(255,255,255,0.05)',
    controlSurfaceElevated: 'rgba(147,197,253,0.18)',
    controlBorder: 'rgba(255,255,255,0.10)',
    controlText: 'rgba(255,255,255,0.92)',
    controlPlaceholder: 'rgba(255,255,255,0.42)',
    selectionBg: 'rgba(147,197,253,0.28)',
    selectionFg: 'inherit',
  },
};

export const GRAPHITE_THEME: Theme = {
  id: 'light',
  name: 'Graphite',
  useUniverseBackground: true,
  colors: {
    background: '#14161c',
    backgroundPattern: 'none',
    backgroundOverlay: 'none',
    canvasBg: '#000000',
    canvasStar: '#e5e7eb',
    widgetBg: '34, 37, 44',
    composerBg: '50, 53, 62',
    widgetBorder: 'transparent',
    widgetText: 'rgba(255, 255, 255, 0.92)',
    primary: '#dbeafe',
    iconAccent: 'rgba(219,234,254,0.92)',
    iconMuted: 'rgba(219,234,254,0.50)',
    folderAccent: 'rgba(165,180,252,0.85)',
    warning: 'rgba(252,211,77,0.85)',
    dockIconFilesystem: 'rgba(165,180,252,0.95)',

    dockIconBilling: 'rgba(251,191,36,0.95)',
    dockIconMedia: 'rgba(168,85,247,0.90)',
    dockIconLibrary: 'rgba(34,211,238,0.90)',
    dockIconWidgets: 'rgba(52,211,153,0.90)',
    dockIconAdd: 'rgba(244,114,182,0.90)',
    dockIconUser: 'rgba(167,139,250,0.90)',
    dockIconProject: 'rgba(52,211,153,0.90)',
    widgetOpacity: 0.96,
    backdropBlur: 'blur(10px)',
    widgetShadow: '0 24px 60px -30px rgba(0,0,0,0.86)',
    panelSurfaceImage: 'none',
    universeOpacity: 0.72,
    controlSurface: 'rgba(255,255,255,0.06)',
    controlSurfaceElevated: 'rgba(219,234,254,0.18)',
    controlBorder: 'rgba(255,255,255,0.10)',
    controlText: 'rgba(255,255,255,0.92)',
    controlPlaceholder: 'rgba(219,234,254,0.45)',
    selectionBg: 'rgba(219,234,254,0.28)',
    selectionFg: 'inherit',
  },
};

/**
 * Light (stored id `white`): Graphite's white-ink palette on a neutral grey with
 * no blue — the lightest a white-text theme can be.
 */
export const LIGHT_THEME: Theme = {
  ...GRAPHITE_THEME,
  id: 'white', name: 'Light',
  colors: {
    ...GRAPHITE_THEME.colors,
    background: '#2a2b2f', canvasStar: '#ffffff',
    widgetBg: '56, 57, 61', composerBg: '72, 73, 78',
    primary: '#f4f4f5', iconAccent: 'rgba(244,244,245,0.92)', iconMuted: 'rgba(255,255,255,0.55)',
    universeOpacity: 0.6,
    controlSurfaceElevated: 'rgba(255,255,255,0.16)',
    controlPlaceholder: 'rgba(255,255,255,0.50)',
    selectionBg: 'rgba(255,255,255,0.24)',
  },
};

export const DEFAULT_THEME: Theme = DARK_THEME;
export const THEMES: Theme[] = [DARK_THEME, FOCUS_THEME, GRAPHITE_THEME, LIGHT_THEME];
