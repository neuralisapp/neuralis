export interface ThemeColors {
  background: string;
  backgroundPattern: string;
  backgroundOverlay: string;
  canvasBg: string;
  canvasStar: string;
  widgetBg: string;
  composerBg: string;
  widgetBorder: string;
  widgetText: string;
  primary: string;
  iconAccent: string;
  iconMuted: string;
  folderAccent: string;
  warning: string;
  dockIconFilesystem: string;

  dockIconBilling: string;
  dockIconMedia: string;
  dockIconLibrary: string;
  dockIconWidgets: string;
  dockIconAdd: string;
  dockIconUser: string;
  dockIconProject: string;
  widgetOpacity: number;
  backdropBlur: string;
  widgetShadow: string;
  panelSurfaceImage: string;
  universeOpacity: number;

  // Form controls + text selection — theme-scoped, consumed by globals.css
  controlSurface: string;
  controlSurfaceElevated: string;
  controlBorder: string;
  controlText: string;
  controlPlaceholder: string;
  selectionBg: string;
  selectionFg: string;
}

export interface Theme {
  id: string;
  name: string;
  colors: ThemeColors;
  useUniverseBackground?: boolean;
}
