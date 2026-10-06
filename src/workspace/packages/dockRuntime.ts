/**
 * Dock Runtime — Package snapshot → dock item list generation.
 *
 * Generates the dock item list for the Dock component
 * from the backend snapshot dock item contributions.
 */

import type {
  DockRuntimeDefinition,
  PackageRuntimeSnapshot,
  PackageTrust,
} from '@neuralis/package-system/contracts';

/** Dock item for the workspace UI. */
export type PackageDockItem = {
  id: string;
  label: string;
  icon: string;
  color?: string;
  position: number;
  section?: 'top' | 'bottom';
  dock: 'primary' | 'secondary';
  packageId: string;
  /**
   * Trust tier of the contributing package. Used by the dock UI to group
   * items (first-party / trusted / untrusted) with visual separators.
   */
  trust?: PackageTrust;
  onClick:
    | { kind: 'openWidget'; widgetType: string; widgetTitle?: string }
    | { kind: 'action'; actionId: string };
};

/**
 * Generates a sorted dock item list from the snapshot dock item contributions.
 *
 * Each dock item is enriched with the contributing package's trust tier
 * (looked up from `snapshot.packages[].access.trust`) so the UI can render
 * grouped separators between first-party / trusted / untrusted sections.
 */
export function buildPackageDockItems(
  snapshot: PackageRuntimeSnapshot,
): PackageDockItem[] {
  const trustByPackageId = new Map<string, PackageTrust>();
  for (const pkg of snapshot.packages) {
    if (pkg.access?.trust) trustByPackageId.set(pkg.id, pkg.access.trust);
  }

  const items: PackageDockItem[] = snapshot.surfaces
    .filter((entry): entry is DockRuntimeDefinition => entry.kind === 'dock')
    .map((dock) => ({
    id: dock.id,
    label: dock.label,
    icon: dock.icon ?? 'Square',
    color: dock.color,
    position: dock.position ?? 50,
    section: dock.section,
    dock: dock.dock ?? 'primary',
    packageId: dock.packageId,
    trust: trustByPackageId.get(dock.packageId),
    onClick:
      dock.action.type === 'open-widget'
        ? {
            kind: 'openWidget',
            widgetType: dock.action.widget,
            widgetTitle: dock.action.title,
          }
        : {
            kind: 'action',
            actionId: dock.action.id,
          },
  }));

  items.sort((a, b) => a.position - b.position);

  return items;
}
