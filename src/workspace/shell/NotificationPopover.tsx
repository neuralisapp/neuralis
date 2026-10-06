'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Inbox } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useWorkspaceStore } from '../store/workspaceStore';
import { getWidgetDefinition } from '../widgets/registry';
import {
  loadDockNotifications,
  navInitialState,
  requestInboxOpen,
  type NotificationRow,
} from '../notifications/notificationsClient';
import type { DockBadgeTarget } from './DockBadge';
import { NOTIFICATION_TONE } from './DockBadge';
import type { DockEdge } from './dockPlacement';

const POPOVER_WIDTH = 304;
const POPOVER_GAP = 8;

/** "now", "5m", "3h", "2d", then the date — the time beside a row. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Open what a row points at: its `nav` names a widget and an initial state the
 * host passes through uninterpreted (`openWidget`, which merges into an open
 * singleton) — but only a widget of the row's OWN package; a row whose nav
 * names another package's widget opens nothing. Opens beside the selected
 * agent, or the project's first. Returns whether something opened.
 */
export function openNotificationRow(row: Pick<NotificationRow, 'packageId' | 'nav'>): boolean {
  const nav = row.nav;
  if (!nav) return false;
  const definition = getWidgetDefinition(nav.widgetType);
  if (!definition || definition.packageId !== row.packageId) return false;
  const store = useWorkspaceStore.getState();
  const agentId = store.session.agentId ?? store.agents.ids[0] ?? null;
  if (!agentId) return false;
  if (agentId !== store.session.agentId) store.selectAgent(agentId);
  store.openWidget({
    agentId,
    type: nav.widgetType,
    title: definition.title,
    initialState: navInitialState(nav),
  });
  return true;
}

/** Where the popover sits: beside the dock item, opening away from the dock's edge. */
export function popoverPosition(
  anchor: Pick<DOMRect, 'top' | 'left' | 'right' | 'bottom'>,
  edge: DockEdge,
  viewport: { width: number; height: number },
): { top?: number; bottom?: number; left?: number; right?: number; maxHeight: number } {
  const clampLeft = (left: number): number => Math.max(POPOVER_GAP, Math.min(left, viewport.width - POPOVER_WIDTH - POPOVER_GAP));
  switch (edge) {
    case 'left': {
      const top = Math.max(POPOVER_GAP, Math.min(anchor.top, viewport.height - 200));
      return { top, left: anchor.right + POPOVER_GAP, maxHeight: viewport.height - top - POPOVER_GAP };
    }
    case 'right': {
      const top = Math.max(POPOVER_GAP, Math.min(anchor.top, viewport.height - 200));
      return { top, right: viewport.width - anchor.left + POPOVER_GAP, maxHeight: viewport.height - top - POPOVER_GAP };
    }
    case 'bottom':
      return { bottom: viewport.height - anchor.top + POPOVER_GAP, left: clampLeft(anchor.left), maxHeight: anchor.top - 2 * POPOVER_GAP };
    case 'top':
      return { top: anchor.bottom + POPOVER_GAP, left: clampLeft(anchor.left), maxHeight: viewport.height - anchor.bottom - 2 * POPOVER_GAP };
  }
}

/**
 * A dock item's new notifications, beside the item. What it shows is marked
 * read at once — the rails fade to say so — and stays listed until it closes;
 * "Open in Inbox" leads to the history, on its All tab (the rows just shown
 * are read, so Unread would come up empty).
 */
export function NotificationPopover({
  projectId, target, edge, anchor, onClose,
}: {
  projectId: string | null;
  target: DockBadgeTarget;
  edge: DockEdge;
  anchor: DOMRect;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<NotificationRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [seen, setSeen] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let live = true;
    loadDockNotifications(projectId, target.badgeKey)
      .then((mine) => { if (live) setRows(mine); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [projectId, target.badgeKey]);

  // After the rows have painted: the rails fade (they are read now).
  useEffect(() => {
    if (rows && rows.length > 0) setSeen(true);
    if (rows) panelRef.current?.querySelector<HTMLElement>('[data-notification-row]')?.focus();
  }, [rows]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const list = [...(panelRef.current?.querySelectorAll<HTMLElement>('[data-notification-row]') ?? [])];
    const index = list.indexOf(document.activeElement as HTMLElement);
    const next = list[index + (event.key === 'ArrowDown' ? 1 : -1)];
    if (next) { event.preventDefault(); next.focus(); }
  };

  const position = popoverPosition(anchor, edge, { width: window.innerWidth, height: window.innerHeight });
  const Icon = target.icon;

  return createPortal(
    <>
      <div className="fixed inset-0" style={{ zIndex: 9998 }} onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-label={`${target.title} notifications`}
        onKeyDown={onKeyDown}
        className="fixed flex flex-col rounded-2xl bg-black/90 backdrop-blur-xl border border-white/10 shadow-2xl shadow-black/60 overflow-hidden"
        style={{ zIndex: 9999, width: POPOVER_WIDTH, ...position, maxHeight: Math.max(160, Math.min(440, position.maxHeight)) }}
      >
        <div className="flex items-center gap-2 px-3.5 pt-3 pb-2">
          <Icon className="w-4 h-4 shrink-0" style={target.color ? { color: target.color } : undefined} />
          <span className="min-w-0 truncate text-[13px] font-semibold text-white/85">{target.title}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
          {rows === null && !failed ? (
            <div className="px-2.5 py-4 text-[12px] text-white/40">Loading…</div>
          ) : null}
          {failed ? (
            <div className="px-2.5 py-4 text-[12px] text-white/45">Couldn’t load these — try again in a moment.</div>
          ) : null}
          {rows !== null && rows.length === 0 ? (
            <div className="px-2.5 py-4 text-[12px] text-white/45">Nothing new here.</div>
          ) : null}
          {rows?.map((row) => (
            <NotificationRowButton
              key={row.id}
              row={row}
              faded={seen}
              onOpen={() => { if (openNotificationRow(row)) onClose(); }}
            />
          ))}
        </div>
        <div className="border-t border-white/10 p-1.5">
          <button
            type="button"
            onClick={() => { requestInboxOpen('all'); onClose(); }}
            className="w-full flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium text-white/60 hover:text-white hover:bg-white/[0.06] transition-colors"
          >
            <Inbox className="w-3.5 h-3.5" />
            Open in Inbox
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}

/**
 * One notification: a 3 px tone rail, the title (named after the work), the
 * time and `×N` when repeats were merged into it. The rail fades once read.
 * Shared by the popover and the inbox.
 */
export function NotificationRowButton({
  row, faded, onOpen,
}: { row: NotificationRow; faded: boolean; onOpen: () => void }) {
  const tone = NOTIFICATION_TONE[row.tone] ?? NOTIFICATION_TONE.info;
  const opens = Boolean(row.nav);
  return (
    <button
      type="button"
      data-notification-row=""
      onClick={onOpen}
      className={cn(
        'group w-full flex items-stretch gap-2.5 rounded-xl px-2 py-2 text-left transition-colors',
        'focus-visible:outline-none focus-visible:bg-white/[0.08]',
        opens ? 'hover:bg-white/[0.06] cursor-pointer' : 'cursor-default',
      )}
      title={tone.label}
    >
      <span
        className="w-[3px] shrink-0 rounded-full motion-safe:transition-opacity motion-safe:duration-700"
        style={{ backgroundColor: tone.rail, opacity: faded || row.read ? 0.28 : 1 }}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span className={cn('block line-clamp-2 text-[12.5px] leading-snug', row.read || faded ? 'text-white/70' : 'text-white/90')}>
          {row.title}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-white/40">
          <span className="sr-only">{tone.label} · </span>
          <time dateTime={row.at}>{relativeTime(row.at)}</time>
          {row.count > 1 ? <span className="rounded px-1 bg-white/[0.08] text-white/55 tabular-nums">×{row.count}</span> : null}
        </span>
      </span>
    </button>
  );
}
