'use client';

import { useEffect, useRef, useState, type ComponentType, type CSSProperties } from 'react';
import type { PackageEventTone } from '@neuralis/package-system/contracts';
import { cn } from '@/lib/cn';
import { ensureProjectCounts, useDockArrival, useDockUnread, useProjectUnread } from '../notifications/notificationsClient';
import { useWorkspaceStore } from '../store/workspaceStore';
import type { DockEdge } from './dockPlacement';
import { NotificationPopover } from './NotificationPopover';

/**
 * The tone of a notification — the popover/inbox row RAIL and its screen-reader
 * label. Error rose, success mint, warning amber, info sky. The unread pills
 * never take a tone (see {@link UNREAD_PILL_STYLE}).
 */
export const NOTIFICATION_TONE: Record<PackageEventTone, { rail: string; label: string }> = {
  error: { rail: '#fb7185', label: 'Failed' },
  warning: { rail: '#fbbf24', label: 'Needs attention' },
  success: { rail: '#34d399', label: 'Done' },
  info: { rail: '#38bdf8', label: 'Update' },
};

/**
 * The ONE look of every unread number — the dock badge, the account popup's
 * Inbox count, the project switcher's per-row number, and the avatar dot's
 * colour: lavender, dark digits. One style, never a per-tone colour.
 */
export const UNREAD_PILL_STYLE = { backgroundColor: '#cba6f7', color: '#0a0a0a' } as const;

/**
 * The number-less unread mark — the account avatar ("something here is
 * unread") and the project switcher button ("something in ANOTHER project is
 * unread"). Lavender, cut out of its icon by a workspace-background ring;
 * `className` places it.
 */
export function UnreadDot({ className }: { className?: string }) {
  return (
    <span
      className={cn('w-2.5 h-2.5 rounded-full', className)}
      style={{ backgroundColor: UNREAD_PILL_STYLE.backgroundColor, boxShadow: '0 0 0 2px rgb(var(--w-bg-rgb, 14, 15, 18))' }}
      aria-hidden="true"
    />
  );
}

/** The workspace background — the ring that cuts the badge out of the icon. */
const WORKSPACE_BG = 'rgb(var(--w-bg-rgb, 14, 15, 18))';

/** 1–99, then "99+". */
export function badgeLabel(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/**
 * The pop and the one-shot ring — keyframes travel with the component (never
 * `globals.css`), and only exist for a user who has not asked for less motion.
 * React hoists and de-duplicates the tag by its `href`.
 */
const BADGE_CSS = `
@media (prefers-reduced-motion: no-preference) {
  @keyframes nrs-dock-badge-pop {
    0% { transform: scale(0.35); }
    55% { transform: scale(1.18); }
    78% { transform: scale(0.94); }
    100% { transform: scale(1); }
  }
  @keyframes nrs-dock-badge-ring {
    0% { transform: scale(1); opacity: 0.65; }
    100% { transform: scale(2.1); opacity: 0; }
  }
  .nrs-dock-badge-pop { animation: nrs-dock-badge-pop 460ms cubic-bezier(0.2, 0.9, 0.3, 1.25) both; }
  .nrs-dock-badge-ring { animation: nrs-dock-badge-ring 900ms ease-out 1 both; }
}
`;

export type DockBadgeTarget = {
  /** `<packageId>:<dockId>` — the counts' `byDock` key. */
  badgeKey: string;
  title: string;
  icon: ComponentType<{ className?: string; style?: CSSProperties }>;
  color?: string;
};

/**
 * The unread pill on a dock item's top-right corner, like a moon on its
 * planet: a small lavender pill ({@link UNREAD_PILL_STYLE}, whatever the
 * notifications' tones) with small dark digits, cut out of the icon by a ring
 * in the workspace background, 1–99 then "99+". It moves only when a frame RAISES its number —
 * a spring pop and one fading ring — never on mount and never in a loop.
 * Clicking it opens the item's notifications beside the dock.
 */
export function DockBadge({ target, edge }: { target: DockBadgeTarget; edge: DockEdge }) {
  const projectId = useWorkspaceStore((s) => s.session.projectId);
  const count = useDockUnread(projectId, target.badgeKey);
  const arrival = useDockArrival(projectId, target.badgeKey);
  const mountArrival = useRef(arrival);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  const animate = arrival !== mountArrival.current;
  const label = badgeLabel(count);

  const open = (): void => {
    const item = buttonRef.current?.closest('[data-dock-item]') ?? buttonRef.current;
    if (item) setAnchor(item.getBoundingClientRect());
  };

  return (
    <>
      {count > 0 ? (
        <button
          ref={buttonRef}
          type="button"
          onClick={(event) => { event.stopPropagation(); open(); }}
          className="absolute -top-1 -right-1 z-20 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
          aria-label={`${count} new in ${target.title} — show`}
          aria-haspopup="dialog"
          aria-expanded={anchor !== null}
          title={`${count} new in ${target.title}`}
        >
          {animate ? (
            <span
              key={`ring-${arrival}`}
              className="nrs-dock-badge-ring absolute inset-0 rounded-full pointer-events-none"
              style={{ boxShadow: `0 0 0 2px ${UNREAD_PILL_STYLE.backgroundColor}` }}
              aria-hidden="true"
            />
          ) : null}
          <span
            key={animate ? `pop-${arrival}` : 'still'}
            className={cn(
              'relative flex items-center justify-center h-[14px] min-w-[14px] px-[3px] rounded-full',
              'text-[9px] font-semibold leading-none tabular-nums tracking-tight',
              animate && 'nrs-dock-badge-pop',
            )}
            style={{
              ...UNREAD_PILL_STYLE,
              boxShadow: `0 0 0 2px ${WORKSPACE_BG}, 0 2px 6px rgba(0, 0, 0, 0.45)`,
            }}
          >
            {label}
          </span>
        </button>
      ) : null}
      {anchor ? (
        <NotificationPopover
          projectId={projectId}
          target={target}
          edge={edge}
          anchor={anchor}
          onClose={() => setAnchor(null)}
        />
      ) : null}
      <style href="nrs-dock-badge" precedence="default">{BADGE_CSS}</style>
    </>
  );
}

/**
 * A project switcher row's unread number. The rows of an opening switcher ask
 * together and share ONE `scope=all` read; live frames keep it current.
 */
export function ProjectUnreadCount({ projectId }: { projectId: string }) {
  const count = useProjectUnread(projectId);
  useEffect(() => { void ensureProjectCounts(); }, []);
  if (!count) return null;
  return (
    <span
      className="shrink-0 rounded-full px-1.5 text-[10px] font-bold leading-4 tabular-nums"
      style={UNREAD_PILL_STYLE}
      aria-label={`${count} unread`}
      title={`${count} unread`}
    >
      {badgeLabel(count)}
    </span>
  );
}
