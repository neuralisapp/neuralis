import type { ReactElement } from 'react';
import type { WidgetInstance } from '../store/types';
import type { PackageTrust, WidgetUiElement } from '@neuralis/package-system/contracts';

export type WidgetRenderContext = {
  agentId: string;
  instance: WidgetInstance;
};

export type WidgetDefinition = {
  type: string;
  title: string;
  icon?: string;
  createInitialState?: () => Record<string, unknown>;
  chrome?: WidgetUiElement['chrome'];
  openBehavior?: WidgetUiElement['open'];
  /** Manifest-driven auto-open per agent. */
  defaultOpen?: boolean;
  /** Contributing package id (omitted for host-provided widgets). */
  packageId?: string;
  /**
   * Trust tier of the contributing package, looked up from
   * `snapshot.packages[].access.trust`. The workspace uses it to gate
   * user-facing UI overrides (e.g. transparency control is hidden for
   * `untrusted` packages).
   */
  trust?: PackageTrust;
  render: (ctx: WidgetRenderContext) => ReactElement;
};
