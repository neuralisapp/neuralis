/**
 * Widget Runtime — Package snapshot → widget registry hydration.
 *
 * Registers widget contributions from the backend snapshot
 * into the existing widget registry (widgets/registry.tsx). A first-party
 * package's widget components reach the shared `PackageHostRegistry` through
 * its runtime module (`uiModuleLoader`). A runtime registration lands AFTER the
 * snapshot was applied, so the registry and the loader both re-hydrate the last
 * snapshot — coalesced to one pass per microtask.
 */

import type {
  PackageRuntimeSnapshot,
  PackageTrust,
  WidgetRuntimeDefinition,
} from '@neuralis/package-system/contracts';
import { syncPackageWidgets } from '../widgets/registry';
import { getHostRegistry } from './hostRegistryInstance';
import { subscribeUiModules } from './uiModuleLoader';
import { resolveWidgetRenderer } from './WidgetRendererStrategy';

let lastSnapshot: PackageRuntimeSnapshot | null = null;
let rehydrateQueued = false;
let subscribed = false;

function syncWidgets(snapshot: PackageRuntimeSnapshot): void {
  const trustByPackageId = new Map<string, PackageTrust>();
  for (const pkg of snapshot.packages) {
    if (pkg.access?.trust) trustByPackageId.set(pkg.id, pkg.access.trust);
  }
  const widgets = snapshot.surfaces
    .filter((entry): entry is WidgetRuntimeDefinition => entry.kind === 'widget');
  const resolved = widgets.map((widget) =>
    resolveWidgetRenderer(widget, trustByPackageId.get(widget.packageId)),
  );
  syncPackageWidgets(resolved);
}

function queueRehydrate(): void {
  if (rehydrateQueued) return;
  rehydrateQueued = true;
  queueMicrotask(() => {
    rehydrateQueued = false;
    if (lastSnapshot) syncWidgets(lastSnapshot);
  });
}

export function hydrateWidgetRegistry(snapshot: PackageRuntimeSnapshot): void {
  lastSnapshot = snapshot;
  if (!subscribed && typeof window !== 'undefined') {
    subscribed = true;
    getHostRegistry().subscribe(queueRehydrate);
    subscribeUiModules(queueRehydrate);
  }
  syncWidgets(snapshot);
}
