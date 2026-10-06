'use client';

import React, { useCallback, useEffect, useMemo, useState, type CSSProperties, type ComponentType } from 'react';
import { Package, LayoutDashboard, Plus, BrushCleaning } from 'lucide-react';
import { useSession } from 'next-auth/react';
import { resolveAgentColor, resolveAgentIcon } from '@neuralis/package-system/client';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useAgentHasStore, useAgentsState, useDockPrefs, useDockWidgetItems, useWorkspaceSession } from '../store/selectors';
import { getCachedSnapshot, onSnapshotChange } from '../packages/runtimeClient';
import { buildPackageDockItems, type PackageDockItem } from '../packages/dockRuntime';
import {
  HOST_SLOTS,
  IDLE_AGENT_ACTIVITY,
  useHostSlot,
  type AgentActivity,
  type AgentActivitySlotProps,
} from '../packages/hostRegistryInstance';
import { listDefaultOpenWidgets } from '../widgets/registry';
import type { PackageRuntimeSnapshot, PackageTrust } from '@neuralis/package-system/contracts';
import { cn } from '@/lib/cn';
import type { DockItem } from './Dock';
import type { DockEdge } from './dockPlacement';
import { resolveDockIcon } from './dockIcons';
import { UserInfo } from './UserInfo';
import { UserAvatar } from './UserAvatar';
import { ProjectSwitcher } from './ProjectSwitcher';
import { dockSurface, useDockTransparency } from './dockSurface';
import { agentDockKey, applyDockPrefs, packageDockKey } from './dockOrder';

// ─── Primary dock items (package-contributed + UserInfo + layout) ──────────

export function usePrimaryDockItems(edge: DockEdge, hasLabels: boolean, pinned: boolean, disabled: boolean): DockItem[] {
  const { agentId, projectId } = useWorkspaceSession();
  const { ids } = useAgentsState();
  const openWidget = useWorkspaceStore((s) => s.openWidget);
  const exclusiveOpenWidget = useWorkspaceStore((s) => s.exclusiveOpenWidget);
  const restoreWidget = useWorkspaceStore((s) => s.restoreWidget);
  const closeWidget = useWorkspaceStore((s) => s.closeWidget);
  const setWorkspaceView = useWorkspaceStore((s) => s.setWorkspaceView);
  // NARROW on purpose: the dock needs widget IDENTITY (type/hidden/id), never
  // geometry. `useOpenWidgets` also carries `mainSplit`/`widgetSplitsById`/
  // `freeformById`/`gridById`, and this hook runs inside `WorkspaceShell` — so
  // taking it here made every divider-drag and canvas-pan frame re-render the
  // shell and both docks. See `store/selectors.ts` for the full loop.
  const { byId: openWidgetsById } = useDockWidgetItems();
  const packageItems = usePackageDockItems(projectId, agentId);
  const prefs = useDockPrefs('primary');

  const canOpen = Boolean(agentId) && ids.length > 0;

  // Per-widget-type state for the selected agent. Drives the three dock-item
  // states: filled highlight when a VISIBLE instance exists (`active`), the
  // coloured "minimized" ring when only HIDDEN instances exist, and the
  // always-visible broom (clean) when any instance exists.
  const widgetTypeState = useMemo(() => {
    const visible = new Set<string>();
    const hidden = new Set<string>();
    const idsByType = new Map<string, string[]>();
    for (const w of Object.values(openWidgetsById)) {
      if (!w?.type) continue;
      (w.hidden ? hidden : visible).add(w.type);
      const arr = idsByType.get(w.type) ?? [];
      arr.push(w.id);
      idsByType.set(w.type, arr);
    }
    return { visible, hidden, idsByType };
  }, [openWidgetsById]);

  return useMemo<DockItem[]>(() => {
    // Shared open/restore/clean behaviour for a widget TYPE. Clicking a
    // minimized type RESTORES it (unhide, instant — the widget stayed
    // mounted); otherwise it opens normally. The broom destroys every
    // instance of the type — a client-store clean, server data untouched.
    const buildTypeBehavior = (widgetType: string, title: string) => {
      const hasVisible = widgetTypeState.visible.has(widgetType);
      const hasHidden = widgetTypeState.hidden.has(widgetType);
      const idsOfType = widgetTypeState.idsByType.get(widgetType) ?? [];
      return {
        active: hasVisible,
        minimized: !hasVisible && hasHidden,
        onClick: () => {
          if (!agentId) return;
          if (!hasVisible && hasHidden) {
            for (const id of idsOfType) {
              if (openWidgetsById[id]?.hidden) restoreWidget({ agentId, widgetInstanceId: id });
            }
          } else {
            openWidget({ agentId, type: widgetType, title });
          }
        },
        onClean: idsOfType.length > 0
          ? () => { if (!agentId) return; for (const id of idsOfType) closeWidget({ agentId, widgetInstanceId: id }); }
          : undefined,
      };
    };

    // UserInfo as header item (before mode switch separator)
    const userInfoItem: DockItem = {
      id: '__user-info',
      position: 0,
      title: 'User',
      icon: Package,
      section: 'header',
      onClick: () => {},
      renderCustom: () => (
        <UserInfo expanded={hasLabels} align="left" disabled={disabled} pinned={pinned} edge={edge} />
      ),
    };

    const toDockItem = (item: PackageDockItem): DockItem => {
      let widgetType: string | null = null;
      let widgetTitle = item.label;
      if (item.onClick.kind === 'openWidget') {
        widgetType = item.onClick.widgetType;
        widgetTitle = item.onClick.widgetTitle || item.label;
      }
      const behavior = widgetType ? buildTypeBehavior(widgetType, widgetTitle) : null;

      const key = packageDockKey(item.packageId, item.id);
      return {
        id: item.id,
        position: item.position,
        title: item.label,
        prefKey: key,
        group: `trust:${item.trust ?? 'untrusted'}`,
        badgeKey: key,
        icon: resolveDockIcon(item.icon),
        color: item.color,
        disabled: !canOpen,
        active: behavior?.active ?? false,
        minimized: behavior?.minimized ?? false,
        onClick: () => {
          if (!agentId || !canOpen) return;
          if (behavior) {
            behavior.onClick();
          } else if (item.onClick.kind === 'action' && item.onClick.actionId === 'workspace.agent-create') {
            setWorkspaceView('agent_create');
          }
        },
        onClean: behavior?.onClean,
        onDoubleClick: (() => {
          if (item.onClick.kind !== 'openWidget') return undefined;
          const { widgetType: wt, widgetTitle: wTitle } = item.onClick;
          return () => {
            if (!agentId || !canOpen) return;
            exclusiveOpenWidget({ agentId, type: wt, title: wTitle || item.label });
          };
        })(),
      };
    };

    // Group package items by trust tier (first-party / trusted / untrusted)
    // so we can render a separator between each group.
    const trustOrder: PackageTrust[] = ['first-party', 'trusted', 'untrusted'];
    const trustRank = (t: PackageTrust | undefined): number => {
      const idx = trustOrder.indexOf(t ?? 'untrusted');
      return idx === -1 ? trustOrder.length : idx;
    };

    const primaryItems = [...packageItems].filter((item) => item.dock === 'primary');
    primaryItems.sort((a, b) => {
      const ta = trustRank(a.trust);
      const tb = trustRank(b.trust);
      if (ta !== tb) return ta - tb;
      return a.position - b.position;
    });

    // Space dock items out into groups; position is used by Dock for ordering.
    // We interleave separator entries between trust tiers.
    const PKG_BASE_POS = 100;
    const PKG_GROUP_GAP = 1000;
    const pkgItemsWithSeparators: DockItem[] = [];
    let seenTrust: PackageTrust | undefined | 'none' = 'none';
    let orderWithinGroup = 0;

    primaryItems.forEach((item) => {
      const tier = item.trust ?? 'untrusted';
      if (seenTrust !== 'none' && tier !== seenTrust) {
        pkgItemsWithSeparators.push({
          id: `__sep-trust-${tier}`,
          position: PKG_BASE_POS + trustRank(tier) * PKG_GROUP_GAP - 1,
          title: '',
          icon: Package,
          onClick: () => {},
          kind: 'separator',
        });
        orderWithinGroup = 0;
      }
      pkgItemsWithSeparators.push({
        ...toDockItem(item),
        position: PKG_BASE_POS + trustRank(tier) * PKG_GROUP_GAP + orderWithinGroup,
      });
      orderWithinGroup += 1;
      seenTrust = tier;
    });

    // Separator before the Layout item, so the layout control is visually
    // detached from the widget dock items.
    const layoutSeparator: DockItem = {
      id: '__sep-layout',
      position: 9998,
      title: '',
      icon: Package,
      onClick: () => {},
      kind: 'separator',
    };

    // Layout settings item at the bottom — same minimize/restore/clean
    // behaviour as package widgets (it is a host widget type).
    const layoutBehavior = buildTypeBehavior('host:layout-settings', 'Layout');
    const layoutSettingsItem: DockItem = {
      id: '__layout-settings',
      position: 9999,
      title: 'Layout',
      icon: LayoutDashboard,
      active: layoutBehavior.active,
      minimized: layoutBehavior.minimized,
      onClick: layoutBehavior.onClick,
      onClean: layoutBehavior.onClean,
      disabled: !agentId,
    };

    const tail: DockItem[] = pkgItemsWithSeparators.length > 0
      ? [...pkgItemsWithSeparators, layoutSeparator, layoutSettingsItem]
      : [layoutSettingsItem];

    return applyDockPrefs([userInfoItem, ...tail], prefs);
  }, [agentId, canOpen, openWidget, exclusiveOpenWidget, restoreWidget, closeWidget, openWidgetsById, packageItems, widgetTypeState, setWorkspaceView, edge, hasLabels, pinned, disabled, prefs]);
}

/**
 * The package dock items of the scoped snapshot — the dock and the inbox
 * (which heads each app's notifications with that app's own dock icon) read
 * the same list.
 */
export function usePackageDockItems(projectId: string | null, agentId: string | null): PackageDockItem[] {
  const [packageItems, setPackageItems] = useState<PackageDockItem[]>([]);
  useEffect(() => {
    let mounted = true;
    const scope = { projectId, agentId };
    const applySnapshot = (snapshot: PackageRuntimeSnapshot) => {
      if (!mounted) return;
      setPackageItems(buildPackageDockItems(snapshot));
    };
    const cached = getCachedSnapshot(scope);
    if (cached) applySnapshot(cached);
    const unsubscribe = onSnapshotChange(applySnapshot);
    return () => { mounted = false; unsubscribe(); };
  }, [projectId, agentId]);
  return packageItems;
}

// ─── Agent activity (the `dock.agentActivity` slot) ────────────────────────

type AgentDockButtonProps = {
  id: string;
  agent: { name?: string; userId?: string; userName?: string; config?: Record<string, unknown> } | undefined;
  idx: number;
  selected: boolean;
  chatCollapsed: boolean;
  hasLabels: boolean;
  pinned: boolean;
  disabled: boolean;
  onSelect: (id: string) => void;
  currentUserId: string | null;
  currentUserName: string | null;
};

/**
 * What the tile shows besides the agent — the streaming ring, the streamer's
 * avatar, the shared-conversation stack — comes from the package that owns
 * streams and presence, through the `dock.agentActivity` slot (a render-prop,
 * so this tile's hooks never depend on the slot being filled yet). Its rules —
 * the local half keyed `${projectId}:${agentId}`, never a cross-widget bridge
 * entry; the remote half derived per CONVERSATION — are that package's.
 * Empty slot: an idle tile.
 */
function AgentDockButton(props: AgentDockButtonProps) {
  const projectId = useWorkspaceStore((s) => s.session.projectId);
  const Activity = useHostSlot(HOST_SLOTS.agentActivity) as React.ComponentType<AgentActivitySlotProps> | null;
  const render = (activity: AgentActivity): React.ReactNode => <AgentDockTile {...props} activity={activity} />;
  return Activity ? <Activity agentId={props.id} projectId={projectId}>{render}</Activity> : render(IDLE_AGENT_ACTIVITY);
}

// ─── Agent button (custom render for secondary dock) ───────────────────────

function AgentDockTile({
  id, agent, idx, selected, chatCollapsed, hasLabels, pinned, disabled, onSelect, currentUserId, currentUserName, activity,
}: AgentDockButtonProps & { activity: AgentActivity }) {
  const cleanAgentStore = useWorkspaceStore((s) => s.cleanAgentStore);
  // Boolean-returning selector on purpose: geometry writes replace the runtime
  // OBJECT every frame, but key existence is stable, so this tile re-renders
  // only when the agent's store appears/disappears.
  const hasStore = useAgentHasStore(id);
  // Project-presence (cross-user) wins over the local user for the AVATAR (so
  // other members' icons appear on every dock while they stream).
  const { presenceUserId, presenceUserName, streaming } = activity;
  // "done" UX = tile remains tagged with the last presence user so a
  // teammate's avatar lingers after their stream ends. Falls back to
  // the local user if no remote presence has ever fired.
  const avatarUserId = presenceUserId ?? currentUserId;
  const avatarUserName = presenceUserId ? presenceUserName : currentUserName;
  // Multi-user (#17): build the dock avatar stack from
  //   (the presence user)  ∪  (the active conversation's participants)
  // The presence user ALWAYS leads (ring only while streaming) so a teammate's
  // icon appears on the agent tile both DURING their stream and AFTER it ends:
  // the PresenceBus keeps the idle event (with userId) for IDLE_TTL_MS (5 min),
  // so the lingering teammate must not be gated on `streaming` — that
  // gate let the viewer's own active-conv participants shadow the idle teammate
  // and made the icon vanish at stream-end. Idle vs. streaming ring is decided
  // per-avatar below via `isStreamer`, not by whether we add the id here.
  const stackSet: string[] = [];
  if (presenceUserId) stackSet.push(presenceUserId);
  for (const uid of activity.participantUserIds) {
    if (uid && !stackSet.includes(uid)) stackSet.push(uid);
  }
  if (stackSet.length === 0 && avatarUserId) stackSet.push(avatarUserId);
  const avatarStack = stackSet.slice(0, 2);
  const isShared = stackSet.length > 1;
  const showAvatar = avatarStack.length > 0
    // The lingering post-stream avatar no longer needs a local 'done' marker:
    // the stream's own `idle` presence event lands here too (the hub delivers
    // every project member's events, the viewer's included) and keeps
    // `presenceUserId` set for IDLE_TTL_MS.
    && (streaming || Boolean(presenceUserId) || isShared)
    && Boolean(currentUserId);
  const appearance = agent?.config?.appearance as { color?: string; icon?: string } | undefined;
  const color = resolveAgentColor(appearance?.color, idx);
  const AgentIcon = resolveAgentIcon(appearance?.icon);
  const showCollapsedHint = selected && chatCollapsed;
  const dockLevel = useDockTransparency();
  const dockSurf = dockSurface(dockLevel, selected ? 'active' : 'default');
  // In a transparent (Clear) dock the selected agent loses its filled
  // background, so mirror the open-widget affordance: make its icon glow in the
  // agent's OWN colour — clearly visible, unlike the near-invisible
  // `currentColor` drop-shadow on the thin-stroke icon. Opaque/dim keep their
  // fill (a visible active state already), matching the package dock items.
  const iconGlow = dockLevel === 'transparent' && selected ? color : null;
  const opaqueBg = selected
    ? (pinned ? 'bg-white/20' : 'bg-neutral-700')
    : (pinned ? 'bg-white/12 hover:bg-white/20' : 'bg-neutral-800 hover:bg-neutral-700');

  return (
    <div
      className={cn('relative', streaming && 'streaming-ring')}
      style={streaming ? { '--agent-color': color } as React.CSSProperties : undefined}
    >
      {/* The ring is a real element, not a pseudo-element, because the spinning
          conic gradient must be CLIPPED by the donut mask and a pseudo-element
          cannot clip another one. See `globals.css` — the whole point is that
          nothing here repaints per frame. */}
      {streaming ? <span className="streaming-ring__frame" aria-hidden="true" /> : null}
      <button
        type="button"
        onClick={() => onSelect(id)}
        disabled={disabled}
        className={cn(
          'w-full h-10 rounded-xl flex flex-row-reverse items-center transition shrink-0',
          hasLabels ? 'px-0' : 'justify-center',
          dockSurf ? dockSurf.bg : opaqueBg,
          selected ? 'text-white' : 'text-white/70',
          showCollapsedHint && 'ring-2 ring-white/30 animate-pulse',
          'disabled:opacity-40 disabled:cursor-not-allowed',
        )}
        title={showCollapsedHint ? `Open ${agent?.name || 'Agent'} chat` : (agent?.name || 'Agent')}
      >
        <div
          className="w-12 h-full flex items-center justify-center shrink-0 relative"
          style={{ color, filter: iconGlow ? `drop-shadow(0 0 7px ${iconGlow})` : undefined }}
        >
          <AgentIcon size={18} />
          {showAvatar ? (
            <span className="absolute -bottom-0.5 -right-0.5 flex items-center">
              {avatarStack.map((uid, i) => {
                // The currently-streaming user (presence) keeps the white ring;
                // the rest get the idle emerald ring.
                const isStreamer = streaming && uid === presenceUserId;
                return (
                  <span
                    key={uid}
                    className={cn(
                      'rounded-full overflow-hidden bg-black/60 flex items-center justify-center',
                      isStreamer ? 'ring-1 ring-white/30' : 'ring-1 ring-emerald-400/50',
                    )}
                    style={{ width: 14, height: 14, marginLeft: i > 0 ? -5 : 0, zIndex: avatarStack.length - i }}
                  >
                    <UserAvatar userId={uid} name={uid === avatarUserId ? avatarUserName : null} size={14} />
                  </span>
                );
              })}
            </span>
          ) : null}
        </div>
        {hasLabels ? (
          <div className={cn('flex-1 min-w-0 text-center pl-3 line-clamp-2 leading-tight break-words text-[13px] font-semibold tracking-tight', selected ? 'text-white/90' : 'text-white/70')}>
            {agent?.name || 'Agent'}
          </div>
        ) : null}
      </button>
      {/* ALWAYS-VISIBLE free broom, rendered ONLY when this agent holds a
          store — its presence is the "open store" indicator. Cleans the
          agent's whole CLIENT store (widget runtime + file marks + chat
          caches; server data untouched). Sibling button — never nested inside
          the tile button; inset from the minimized ring line. */}
      {hasStore ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); cleanAgentStore({ agentId: id }); }}
          className="absolute top-0.5 right-0.5 z-10 w-4 h-4 flex items-center justify-center text-white/60 hover:text-white transition-colors [filter:drop-shadow(0_0_2px_rgba(0,0,0,0.85))]"
          title={`Clean ${agent?.name || 'Agent'} workspace`}
          aria-label={`Clean ${agent?.name || 'Agent'} workspace`}
        >
          <BrushCleaning className="w-3 h-3" />
        </button>
      ) : null}
    </div>
  );
}

// ─── Secondary dock items (ProjectSwitcher + agents + create) ──────────────

export function useSecondaryDockItems(edge: DockEdge, hasLabels: boolean, pinned: boolean, disabled: boolean): DockItem[] {
  const { agentId } = useWorkspaceSession();
  const { byId, ids } = useAgentsState();
  const prefs = useDockPrefs('secondary');
  const selectAgent = useWorkspaceStore((s) => s.selectAgent);
  const setWorkspaceView = useWorkspaceStore((s) => s.setWorkspaceView);
  const openWidget = useWorkspaceStore((s) => s.openWidget);
  const { data: nextAuthSession } = useSession();
  const currentUserId = (nextAuthSession?.user as { id?: string } | undefined)?.id ?? null;
  const currentUserName = (nextAuthSession?.user as { name?: string | null } | undefined)?.name ?? null;

  const handleAgentSelect = useCallback((id: string) => {
    selectAgent(id);
    // Open every package-declared default widget for the newly selected agent.
    for (const def of listDefaultOpenWidgets()) {
      openWidget({ agentId: id, type: def.type, title: def.title });
    }
  }, [selectAgent, openWidget]);

  return useMemo<DockItem[]>(() => {
    // ProjectSwitcher as header item (before mode switch separator)
    const projectItem: DockItem = {
      id: '__project-switcher',
      position: 0,
      title: 'Project',
      icon: Package,
      section: 'header',
      onClick: () => {},
      renderCustom: () => (
        <ProjectSwitcher expanded={hasLabels} align="right" disabled={disabled} pinned={pinned} edge={edge} />
      ),
    };

    // W3C — group agents by ownership: own agents first, then a
    // separator, then other-user agents. Same separator pattern as
    // the primary dock's trust-tier grouping. We treat
    // `agent.userId` (the kernel `WorkspaceAgentRecord` creator,
    // as `GET /api/agents` returns it) as the ownerId.
    type AgentEntry = { id: string; ownedByMe: boolean; idx: number };
    const ownEntries: AgentEntry[] = [];
    const otherEntries: AgentEntry[] = [];
    ids.forEach((id, idx) => {
      const ownerId = byId[id]?.userId ?? null;
      const ownedByMe = currentUserId === null
        // No session id resolved → fall back to "everything is mine" so
        // the dock keeps working without a separator instead of stranding
        // users behind a collapsed group.
        ? true
        : ownerId === null
          ? true
          : ownerId === currentUserId;
      (ownedByMe ? ownEntries : otherEntries).push({ id, ownedByMe, idx });
    });

    const appearanceOf = (id: string) =>
      (byId[id] as { config?: { appearance?: { icon?: string; color?: string } } } | undefined)?.config?.appearance;
    const renderAgent = (entry: AgentEntry, position: number): DockItem => ({
      id: entry.id,
      position,
      title: byId[entry.id]?.name || 'Agent',
      prefKey: agentDockKey(entry.id),
      group: entry.ownedByMe ? 'agents:own' : 'agents:other',
      // The tile renders itself; icon + colour are what the edit-mode tray shows.
      icon: resolveAgentIcon(appearanceOf(entry.id)?.icon),
      color: resolveAgentColor(appearanceOf(entry.id)?.color, entry.idx),
      onClick: () => handleAgentSelect(entry.id),
      renderCustom: () => (
        <AgentDockButton
          key={entry.id}
          id={entry.id}
          agent={byId[entry.id]}
          idx={entry.idx}
          selected={entry.id === agentId}
          chatCollapsed={false}
          hasLabels={hasLabels}
          pinned={pinned}
          disabled={disabled}
          onSelect={handleAgentSelect}
          currentUserId={currentUserId}
          currentUserName={currentUserName}
        />
      ),
    });

    const agentDockItems: DockItem[] = [];
    ownEntries.forEach((e, i) => agentDockItems.push(renderAgent(e, (i + 1) * 10)));
    if (ownEntries.length > 0 && otherEntries.length > 0) {
      // Same separator style as the primary dock's trust-tier divider.
      agentDockItems.push({
        id: '__sep-owner',
        position: ownEntries.length * 10 + 5,
        title: '',
        icon: Package,
        onClick: () => {},
        kind: 'separator',
      });
    }
    otherEntries.forEach((e, i) =>
      agentDockItems.push(renderAgent(e, (ownEntries.length + i + 1) * 10 + 50)),
    );

    // Create agent — icon trails the label so it lines up with the agent
    // tiles above (those use AgentDockButton's flex-row-reverse layout).
    const createItem: DockItem = {
      id: '__create-agent',
      position: 9998,
      title: 'Create agent',
      icon: Plus,
      color: undefined,
      iconAlign: 'right',
      onClick: () => setWorkspaceView('agent_create'),
      disabled,
    };

    return applyDockPrefs([projectItem, ...agentDockItems, createItem], prefs);
  }, [agentId, byId, currentUserId, currentUserName, disabled, edge, handleAgentSelect, hasLabels, ids, pinned, setWorkspaceView, prefs]);
}
