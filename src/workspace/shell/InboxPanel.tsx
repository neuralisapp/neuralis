'use client';

import { useCallback, useEffect, useRef, useState, type ComponentType, type CSSProperties } from 'react';
import { Bell, CheckCheck, ChevronDown, ChevronLeft, Settings2, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useWorkspaceStore } from '../store/workspaceStore';
import {
  clearNotifications,
  fetchNotificationGroups,
  fetchNotifications,
  markNotificationsRead,
  useUnreadTotal,
  type InboxView,
  type NotificationGroup,
  type NotificationRow,
} from '../notifications/notificationsClient';
import type { PackageDockItem } from '../packages/dockRuntime';
import { resolveDockIcon } from './dockIcons';
import { packageDockKey } from './dockOrder';
import { usePackageDockItems } from './useDockItems';
import { NotificationRowButton, openNotificationRow } from './NotificationPopover';
import { NotificationPrefs } from './NotificationPrefs';

/** Rows a collapsed group shows; the chevron appears past it. */
export const GROUP_PREVIEW_ROWS = 4;
/** Rows per page of an expanded group. */
const GROUP_PAGE_SIZE = 30;
/** An armed Clear disarms itself after this long. */
export const CLEAR_CONFIRM_MS = 4000;

export type AppIdentity = {
  label: string;
  icon: ComponentType<{ className?: string; style?: CSSProperties }>;
  color?: string;
};

/**
 * How an app is shown at the head of its notifications: its OWN dock icon,
 * colour and label — the same visual key as on the dock. A package without a
 * dock item gets a bell and its bare name.
 */
export function appIdentity(
  dockKey: string | null,
  packageId: string,
  dockItems: readonly PackageDockItem[],
): AppIdentity {
  const item = dockKey ? dockItems.find((d) => packageDockKey(d.packageId, d.id) === dockKey) : undefined;
  if (item) return { label: item.label, icon: resolveDockIcon(item.icon), color: item.color };
  const bare = packageId.includes('/') ? packageId.slice(packageId.lastIndexOf('/') + 1) : packageId;
  return { label: bare, icon: Bell };
}

export function AppGroupHeader({
  identity, count, aside,
}: { identity: AppIdentity; count?: number; aside?: React.ReactNode }) {
  const Icon = identity.icon;
  return (
    <div className="flex items-center gap-2 px-2 pt-2 pb-1">
      <span
        className="w-6 h-6 rounded-lg flex items-center justify-center bg-white/[0.06] shrink-0"
        style={identity.color ? { boxShadow: `inset 0 0 0 1px ${identity.color}40` } : undefined}
      >
        <Icon className="w-3.5 h-3.5" style={identity.color ? { color: identity.color } : undefined} />
      </span>
      <span className="min-w-0 flex-1 flex items-baseline gap-1.5">
        <span className="min-w-0 truncate text-[12px] font-semibold text-white/75">{identity.label}</span>
        {count !== undefined ? (
          <span className="shrink-0 text-[10.5px] tabular-nums text-white/35" aria-label={`${count} notifications`}>{count}</span>
        ) : null}
      </span>
      {aside}
    </div>
  );
}

/** The dock key of a group, or `null` for a package without a dock. */
function groupDockKey(group: Pick<NotificationGroup, 'packageId' | 'dock'>): string | null {
  return group.dock ? packageDockKey(group.packageId, group.dock) : null;
}

/**
 * The inbox inside the account popup: this project's notifications grouped by
 * app (each under its own dock icon, with its entry count), Unread or All.
 * Each group shows its newest rows and expands to page through the rest;
 * "Mark read" and a two-click "Clear" act on one app, "Mark all read" on all;
 * the gear opens the settings.
 */
export function InboxPanel({
  projectId, onBack, onClose, initialView = 'unread',
}: {
  projectId: string;
  onBack: () => void;
  onClose: () => void;
  initialView?: InboxView;
}) {
  const [view, setView] = useState<InboxView>(initialView);
  const [groups, setGroups] = useState<NotificationGroup[]>([]);
  const [reloads, setReloads] = useState(0);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const entryRef = useRef(true);
  const agentId = useWorkspaceStore((s) => s.session.agentId);
  const dockItems = usePackageDockItems(projectId, agentId);
  const total = useUnreadTotal(projectId);
  const totalRef = useRef(total);
  totalRef.current = total;

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setFailed(false);
    try {
      const next = await fetchNotificationGroups(projectId, { perGroup: GROUP_PREVIEW_ROWS, unreadOnly: view === 'unread' });
      // Entering on Unread while the badge still counts something no row
      // shows (a row hidden but not yet dropped): show All instead of an
      // empty tab.
      const entry = entryRef.current;
      entryRef.current = false;
      if (entry && view === 'unread' && next.length === 0 && totalRef.current > 0) {
        setView('all');
        return;
      }
      setGroups(next);
      setReloads((n) => n + 1);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [projectId, view]);

  // First read on open, on a tab switch, and whenever the unread number moves
  // (a new arrival, a read or a clear elsewhere) — one read per change, no poll.
  useEffect(() => { void load(); }, [load, total]);

  const markAll = async (): Promise<void> => {
    await markNotificationsRead(projectId, { all: true }).catch(() => undefined);
  };
  const openRow = (row: NotificationRow): void => {
    if (!row.read) void markNotificationsRead(projectId, { ids: [row.id] }).catch(() => undefined);
    if (openNotificationRow(row)) onClose();
  };

  if (settingsOpen) {
    return <NotificationPrefs projectId={projectId} dockItems={dockItems} onBack={() => setSettingsOpen(false)} />;
  }

  return (
    <div className="flex flex-col min-h-0 max-h-[70vh] w-[22rem]">
      <div className="flex items-center gap-1 px-2 pt-2 pb-1.5">
        <button
          type="button"
          onClick={onBack}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-white/50 hover:text-white hover:bg-white/[0.06] transition-colors"
          aria-label="Back to account"
          title="Back"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="flex-1 text-[13px] font-semibold text-white/85">Inbox</span>
        {total > 0 ? (
          <button
            type="button"
            onClick={() => void markAll()}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-white/60 hover:text-white hover:bg-white/[0.06] transition-colors"
            title="Mark every notification in this project read"
          >
            <CheckCheck className="w-3.5 h-3.5" />
            Mark all read
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-white/50 hover:text-white hover:bg-white/[0.06] transition-colors"
          aria-label="Notification settings"
          title="Notification settings"
        >
          <Settings2 className="w-4 h-4" />
        </button>
      </div>

      <div className="px-3 pb-2">
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-white/[0.05] p-0.5" role="tablist" aria-label="Which notifications">
          {(['unread', 'all'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={view === tab}
              onClick={() => { entryRef.current = false; setView(tab); }}
              className={cn(
                'rounded-md py-1 text-[11.5px] font-medium transition-colors',
                view === tab ? 'bg-white/15 text-white' : 'text-white/50 hover:text-white/80',
              )}
            >
              {tab === 'unread' ? (total > 0 ? `Unread · ${total > 99 ? '99+' : total}` : 'Unread') : 'All'}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 border-t border-white/[0.06]">
        {groups.map((group) => (
          <InboxGroup
            key={group.key}
            projectId={projectId}
            group={group}
            unreadOnly={view === 'unread'}
            identity={appIdentity(groupDockKey(group), group.packageId, dockItems)}
            reloads={reloads}
            onOpenRow={openRow}
            onCleared={() => void load()}
          />
        ))}

        {!loading && !failed && groups.length === 0 ? (
          <div className="px-4 py-8 flex flex-col items-center text-center gap-1.5">
            <Bell className="w-5 h-5 text-white/25" />
            {view === 'unread' ? <div className="text-[12.5px] text-white/70">You’re all caught up.</div> : null}
            <div className="text-[11.5px] text-white/40 max-w-[16rem]">
              Runs and syncs that need your attention show up here.
            </div>
          </div>
        ) : null}
        {failed ? (
          <div className="px-3 py-4 text-[12px] text-white/45">Couldn’t load the inbox — try again in a moment.</div>
        ) : null}
        {loading && groups.length === 0 ? (
          <div className="px-3 py-4 text-[12px] text-white/40">Loading…</div>
        ) : null}
      </div>
    </div>
  );
}

type GroupPage = { rows: NotificationRow[]; nextBefore: number | null; loading: boolean };

/**
 * One app in the inbox: its header (icon, label, entry count, Mark read,
 * Clear, the expand chevron) and its rows. Clear is two clicks — the armed
 * "Clear N?" belongs to THIS group, disarms itself after
 * {@link CLEAR_CONFIRM_MS} and on every inbox reload, so it can never confirm
 * a group whose contents changed under it; it names `total`, every entry the
 * clear deletes, read or not, on both tabs. A done Clear that moved no unread
 * total asks the inbox to re-read (`onCleared`); one that moved it is re-read
 * by the inbox's own total-keyed effect. Expanded, the group pages its own
 * rows (unread ones on the Unread tab); a reload re-reads its first page and
 * keeps the rows on screen meanwhile.
 */
export function InboxGroup({
  projectId, group, unreadOnly, identity, reloads, onOpenRow, onCleared,
}: {
  projectId: string;
  group: NotificationGroup;
  unreadOnly: boolean;
  identity: AppIdentity;
  reloads: number;
  onOpenRow: (row: NotificationRow) => void;
  onCleared: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState<GroupPage | null>(null);
  const dockKey = groupDockKey(group);
  const expandable = (unreadOnly ? group.unread : group.total) > GROUP_PREVIEW_ROWS;

  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), CLEAR_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirming]);

  useEffect(() => { setConfirming(false); }, [reloads]);

  const loadPage = useCallback(async (before: number | null): Promise<void> => {
    setPage((prev) => ({ rows: prev?.rows ?? [], nextBefore: prev?.nextBefore ?? null, loading: true }));
    try {
      const next = await fetchNotifications(projectId, { limit: GROUP_PAGE_SIZE, before, unreadOnly, group: group.key });
      setPage((prev) => ({
        rows: before === null ? next.rows : [...(prev?.rows ?? []), ...next.rows],
        nextBefore: next.nextBefore,
        loading: false,
      }));
    } catch {
      setPage((prev) => (prev ? { ...prev, loading: false } : null));
    }
  }, [projectId, unreadOnly, group.key]);

  useEffect(() => {
    if (expanded) void loadPage(null);
  }, [expanded, reloads, loadPage]);

  const rows = expanded && page && page.rows.length > 0 ? page.rows : group.rows;

  return (
    <section aria-label={identity.label}>
      <AppGroupHeader
        identity={identity}
        count={group.total}
        aside={confirming ? (
          <span className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="w-5 h-5 rounded-md flex items-center justify-center text-white/45 hover:text-white/80 hover:bg-white/[0.06]"
              aria-label="Keep these notifications"
              title="Cancel"
            >
              <X className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                void clearNotifications(projectId, { group: group.key }).then(
                  (totalMoved) => { if (!totalMoved) onCleared(); },
                  () => undefined,
                );
              }}
              className="rounded-md px-1.5 py-0.5 text-[10.5px] font-medium bg-red-500/20 text-red-100 hover:bg-red-500/30 transition-colors"
              title={`Delete ${identity.label}'s notifications for good`}
            >
              {`Clear ${group.total}?`}
            </button>
          </span>
        ) : (
          <span className="flex items-center gap-0.5">
            {group.unread > 0 && dockKey ? (
              <button
                type="button"
                onClick={() => void markNotificationsRead(projectId, { dock: dockKey }).catch(() => undefined)}
                className="rounded-md px-1.5 py-0.5 text-[10.5px] text-white/45 hover:text-white hover:bg-white/[0.06] transition-colors"
                title={`Mark ${identity.label} read`}
              >
                Mark read
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="rounded-md px-1.5 py-0.5 text-[10.5px] text-white/45 hover:text-red-200 hover:bg-red-500/15 transition-colors"
              title={`Delete ${identity.label}'s notifications`}
            >
              Clear
            </button>
            {expandable ? (
              <button
                type="button"
                onClick={() => setExpanded((open) => !open)}
                aria-expanded={expanded}
                className="w-5 h-5 rounded-md flex items-center justify-center text-white/45 hover:text-white hover:bg-white/[0.06] transition-colors"
                aria-label={expanded ? `Show fewer from ${identity.label}` : `Show all from ${identity.label}`}
                title={expanded ? 'Show fewer' : 'Show all'}
              >
                <ChevronDown className={cn('w-3.5 h-3.5 transition-transform', expanded && 'rotate-180')} />
              </button>
            ) : null}
          </span>
        )}
      />
      {rows.map((row) => (
        <NotificationRowButton key={row.id} row={row} faded={false} onOpen={() => onOpenRow(row)} />
      ))}
      {expanded && page && page.nextBefore !== null ? (
        <button
          type="button"
          onClick={() => void loadPage(page.nextBefore)}
          disabled={page.loading}
          className="mt-0.5 w-full rounded-lg py-1 text-[11px] font-medium text-white/50 hover:text-white hover:bg-white/[0.06] disabled:opacity-50 transition-colors"
        >
          {page.loading ? 'Loading…' : 'Show more'}
        </button>
      ) : null}
    </section>
  );
}
