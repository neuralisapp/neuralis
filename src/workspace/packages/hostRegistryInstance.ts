/**
 * The single client-side `PackageHostRegistry` instance for the workspace.
 * Each first-party package registers its widget renderers and slot fills
 * here through its runtime module (`uiModuleLoader.ts`);
 * `WidgetRendererStrategy` resolves through it. Registrations can land after
 * the first render, so a component that renders a slot subscribes
 * (`useHostSlot`, `useWorkspaceProviders`).
 */

import { useSyncExternalStore, type ReactNode } from 'react';
import { createPackageHostRegistry, type HostComponentRegistration, type PackageHostRegistry } from '@neuralis/package-system/client';
import type { PackageRuntimeSnapshot } from '@neuralis/package-system/contracts';
import type { workspaceAssetScope } from './packageAssetScope';

let _instance: PackageHostRegistry | null = null;

export function getHostRegistry(): PackageHostRegistry {
  if (!_instance) _instance = createPackageHostRegistry();
  return _instance;
}

/**
 * Host SLOTS — extension points the HOST names and a first-party package
 * fills, keyed in this same registry instead of by a manifest
 * `component.import`. A slot is not a product name; an empty slot fails soft.
 *
 * - `workspace.emptyState`, `workspace.banner`, `dock.agentActivity` and
 *   `workspace.projectSettings` hold ONE owner: the registry's owner-collision
 *   check refuses a second package.
 * - `workspace.provider` composes several providers in registration order, so
 *   each owner registers under its OWN key `workspace.provider:<packageId>`.
 *
 * What the host renders each fill as (the props below are the whole contract):
 * - `workspace.provider` — `WorkspaceProviderSlotProps`, wrapped around the
 *   workspace: the caller-scoped snapshot the workspace applied, and the ONE
 *   asset-scope client (the card reconcile runs there);
 * - `workspace.emptyState` — `()`, the content when no agent is selected or
 *   the agent-create view is open;
 * - `workspace.banner` — `()`, above the workspace;
 * - `dock.agentActivity` — `AgentActivitySlotProps`, once per agent tile: a
 *   render-prop, so the tile's hook count never depends on whether the slot is
 *   filled yet.
 * - `workspace.projectSettings` — `ProjectSettingsSlotProps`, the project
 *   switcher's "Project settings" row: the filling package opens its own
 *   surface (the widget type and its entry state are the package's); empty ⇒
 *   no row.
 *
 * The first-party floor is the LOADER (only first-party modules ever install);
 * `hostSlotOwnerViolation` keeps a module from filling a provider slot under
 * another package's key.
 */
export const HOST_SLOTS = Object.freeze({
  provider: 'workspace.provider',
  emptyState: 'workspace.emptyState',
  banner: 'workspace.banner',
  agentActivity: 'dock.agentActivity',
  projectSettings: 'workspace.projectSettings',
} as const);

export type HostSlot = (typeof HOST_SLOTS)[keyof typeof HOST_SLOTS];

const SINGLE_OWNER_SLOTS: ReadonlySet<string> = new Set([
  HOST_SLOTS.emptyState,
  HOST_SLOTS.banner,
  HOST_SLOTS.agentActivity,
  HOST_SLOTS.projectSettings,
]);
const PROVIDER_PREFIX = `${HOST_SLOTS.provider}:`;

/** The registry key a package fills `slot` under. */
export function hostSlotKey(slot: HostSlot, packageId: string): string {
  return slot === HOST_SLOTS.provider ? `${PROVIDER_PREFIX}${packageId}` : slot;
}

/** Whether a registry key names a host slot (never a surface). */
export function isHostSlotKey(key: string): boolean {
  return SINGLE_OWNER_SLOTS.has(key) || key === HOST_SLOTS.provider || key.startsWith(PROVIDER_PREFIX);
}

/** Why `reg` may not fill the slot it names, or `null` (not a slot, or a valid fill). */
export function hostSlotOwnerViolation(reg: HostComponentRegistration): string | null {
  if (reg.componentImport === HOST_SLOTS.provider) {
    return `${reg.packageSlug} must fill ${HOST_SLOTS.provider} under its own key ${PROVIDER_PREFIX}${reg.packageSlug}`;
  }
  if (reg.componentImport.startsWith(PROVIDER_PREFIX) && reg.componentImport !== `${PROVIDER_PREFIX}${reg.packageSlug}`) {
    return `${reg.packageSlug} may not fill another package's provider slot (${reg.componentImport})`;
  }
  return null;
}

/** The value filling a single-owner slot, or `null` when it is empty. */
export function resolveHostSlot(slot: Exclude<HostSlot, typeof HOST_SLOTS.provider>): unknown | null {
  return getHostRegistry().resolve(slot);
}

/** Every `workspace.provider` fill, in registration order. */
export function listWorkspaceProviders(): readonly HostComponentRegistration[] {
  return getHostRegistry().list().filter((reg) => reg.componentImport.startsWith(PROVIDER_PREFIX));
}

/** The ONE asset-scope client the host hands package code (`packageAssetScope.ts` `workspaceAssetScope`). */
export type WorkspaceAssetScopeClient = typeof workspaceAssetScope;

export type WorkspaceProviderSlotProps = {
  readonly children: ReactNode;
  /** The caller-scoped runtime snapshot the workspace applied; `null` until the first lands. */
  readonly snapshot: PackageRuntimeSnapshot | null;
  /** Stable identity across renders — never a second refcount/heartbeat copy. */
  readonly assetScope: WorkspaceAssetScopeClient;
};

/** What an agent's dock tile shows besides the agent itself. */
export type AgentActivity = {
  /** A run of this agent is live — this browser's own stream or any member's. */
  readonly streaming: boolean;
  /** The member whose stream this tile last saw (kept a while after it ends), or `null`. */
  readonly presenceUserId: string | null;
  readonly presenceUserName: string | null;
  /** Participants of the agent's active conversation (the shared-conversation badge). */
  readonly participantUserIds: readonly string[];
};

export type AgentActivitySlotProps = {
  readonly agentId: string;
  readonly projectId: string | null;
  readonly children: (activity: AgentActivity) => ReactNode;
};

/** The project switcher's "Project settings" row; `onActivated` closes the switcher. */
export type ProjectSettingsSlotProps = {
  readonly onActivated: () => void;
};

/** The activity an empty `dock.agentActivity` slot reports. */
export const IDLE_AGENT_ACTIVITY: AgentActivity = Object.freeze({
  streaming: false,
  presenceUserId: null,
  presenceUserName: null,
  participantUserIds: Object.freeze([]) as readonly string[],
});

const subscribeRegistry = (listener: () => void): (() => void) => getHostRegistry().subscribe(listener);

/** The current fill of a single-owner slot; re-renders when a module fills it. */
export function useHostSlot(slot: Exclude<HostSlot, typeof HOST_SLOTS.provider>): unknown | null {
  return useSyncExternalStore(subscribeRegistry, () => resolveHostSlot(slot), () => null);
}

const NO_PROVIDERS: readonly unknown[] = Object.freeze([]);
let providersCache: readonly unknown[] = NO_PROVIDERS;

function providerComponents(): readonly unknown[] {
  const next = listWorkspaceProviders().map((reg) => reg.Component);
  const same = next.length === providersCache.length && next.every((c, i) => c === providersCache[i]);
  if (!same) providersCache = next.length === 0 ? NO_PROVIDERS : next;
  return providersCache;
}

/** The `workspace.provider` fills, in registration order, as a STABLE array (same fills ⇒ same array). */
export function useWorkspaceProviders(): readonly unknown[] {
  return useSyncExternalStore(subscribeRegistry, providerComponents, () => NO_PROVIDERS);
}
