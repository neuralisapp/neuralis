/**
 * The workspace's provider root: the generic `WorkspaceHostPortProvider`, then
 * every `workspace.provider` slot fill in registration order (first registered
 * = outermost). A package puts its own React context around the workspace by
 * filling that slot from its install entry — the host names no package. Every
 * fill receives the same props (`WorkspaceProviderSlotProps`): the snapshot the
 * workspace applied and the ONE asset-scope client; anything else a package
 * needs from the host it reads from the port (`useUserId`,
 * `components.UserAvatar`, `subscribeRealtime`).
 *
 * A provider that attaches after the shell has shown re-parents the workspace
 * tree once (React remounts below a new wrapper). The loading gate in
 * `WorkspaceRoot` waits for the modules, so that happens only when a module
 * outlives the gate's bounded release.
 */

'use client';

import { createElement, type ComponentType, type ReactNode } from 'react';
import type { PackageRuntimeSnapshot } from '@neuralis/package-system/contracts';
import { WorkspaceHostPortProvider } from '@neuralis/package-system/client';
import { workspaceHostPort } from './packages/buildWorkspaceHostPort';
import { useWorkspaceProviders, type WorkspaceProviderSlotProps } from './packages/hostRegistryInstance';
import { workspaceAssetScope } from './packages/packageAssetScope';

export type NeuralisHostProviderProps = {
  children: ReactNode;
  /** The caller-scoped runtime snapshot the workspace applied (`null` before the first). */
  snapshot: PackageRuntimeSnapshot | null;
};

/** Wrap `tree` in the provider fills, outermost first, each with the same slot props. */
export function wrapInWorkspaceProviders(
  fills: readonly unknown[],
  snapshot: PackageRuntimeSnapshot | null,
  tree: ReactNode,
): ReactNode {
  let wrapped = tree;
  for (let i = fills.length - 1; i >= 0; i -= 1) {
    const props: WorkspaceProviderSlotProps = { snapshot, assetScope: workspaceAssetScope, children: wrapped };
    wrapped = createElement(fills[i] as ComponentType<WorkspaceProviderSlotProps>, props);
  }
  return wrapped;
}

export function NeuralisHostProvider({ children, snapshot }: NeuralisHostProviderProps) {
  const providers = useWorkspaceProviders();
  const tree = wrapInWorkspaceProviders(providers, snapshot, children);
  // `WorkspaceHostPortProvider` is GENERIC kernel plumbing: a package component
  // the host renders outside any install entry (a slot fill) resolves the port
  // through it, or a `<SkillLauncher>` inside it renders null silently.
  return <WorkspaceHostPortProvider port={workspaceHostPort}>{tree}</WorkspaceHostPortProvider>;
}
