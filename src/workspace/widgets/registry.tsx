import React from 'react';
import type { WidgetDefinition, WidgetRenderContext } from './types';

const PACKAGE_REGISTRY = new Map<string, WidgetDefinition>();

export function getWidgetDefinition(type: string): WidgetDefinition | undefined {
  return PACKAGE_REGISTRY.get(type);
}

export function renderWidget(ctx: WidgetRenderContext): React.ReactElement {
  const def = getWidgetDefinition(ctx.instance.type);
  if (!def) {
    return <div className="p-4 text-white/50 text-sm">Unknown widget: {ctx.instance.type}</div>;
  }
  return def.render(ctx);
}

/**
 * Whether a widget type may have several windows bound to one agent: every
 * type except a manifest `open.singleton: true`. The ONE predicate the store's
 * open targets, the dock's "New window" and the launcher share.
 */
export function isRepeatableWidget(type: string): boolean {
  return getWidgetDefinition(type)?.openBehavior?.singleton !== true;
}

export function registerWidget(def: WidgetDefinition): void {
  PACKAGE_REGISTRY.set(def.type, def);
}

export function syncPackageWidgets(definitions: WidgetDefinition[]): void {
  PACKAGE_REGISTRY.clear();
  for (const definition of definitions) {
    PACKAGE_REGISTRY.set(definition.type, definition);
  }
}

/**
 * Manifest-driven default-open widgets. Returns every
 * package-contributed widget that declared `defaultOpen: true` in its
 * manifest. The workspace store auto-injects these on every agent runtime
 * mount.
 */
export function listDefaultOpenWidgets(): WidgetDefinition[] {
  return Array.from(PACKAGE_REGISTRY.values()).filter((def) => def.defaultOpen === true);
}
