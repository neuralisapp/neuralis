/**
 * Workspace dock-left icon resolver.
 *
 * Thin re-export of the kernel client's `ICON_MAP`
 * (`@neuralis/package-system/client`), so the dock and every package UI
 * consume the same icon-library name → component table. Add new icons in the
 * kernel icon library, never here.
 */

import {
  ICON_MAP,
  resolveIconWithFallback,
  type IconComponent,
} from '@neuralis/package-system/client';

export type DockIconComponent = IconComponent;

export const DOCK_ICON_MAP = ICON_MAP;

export function resolveDockIcon(iconName: string | undefined): DockIconComponent {
  return resolveIconWithFallback(iconName);
}
