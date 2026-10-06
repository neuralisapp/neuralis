'use client';

import { LogOut, Shield, ChevronDown, Pencil, Inbox } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSession, signOut } from 'next-auth/react';
import { cn } from '@/lib/cn';
import { useWorkspaceStore } from '../store/workspaceStore';
import { UserAvatar } from './UserAvatar';
import { UserProfilePopup } from './UserProfilePopup';
import { dockSurface, useDockTransparency } from './dockSurface';
import { InboxPanel } from './InboxPanel';
import { UNREAD_PILL_STYLE, UnreadDot, badgeLabel } from './DockBadge';
import { inboxRequestView, useInboxRequest, useUnreadTotal, type InboxView } from '../notifications/notificationsClient';

type DockEdge = 'left' | 'right' | 'top' | 'bottom';

type Props = {
  expanded?: boolean;
  align?: 'left' | 'right';
  disabled?: boolean;
  pinned?: boolean;
  edge?: DockEdge;
};

export function UserInfo({ expanded = false, align = 'left', disabled = false, pinned = true, edge = 'left' }: Props) {
  const { data: session } = useSession();
  const [isOpen, setIsOpen] = useState(false);
  const [view, setView] = useState<'account' | 'inbox'>('account');
  // Each entry into the inbox remounts it on the tab it was asked for.
  const [inboxEntry, setInboxEntry] = useState<{ n: number; view: InboxView }>({ n: 0, view: 'unread' });
  const [profileOpen, setProfileOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [profileAnchor, setProfileAnchor] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const dockLevel = useDockTransparency();
  const dockSurf = dockSurface(dockLevel, 'default');

  const name = session?.user?.name ?? session?.user?.email ?? 'User';
  const email = session?.user?.email ?? '';

  const projectId = useWorkspaceStore((s) => s.session.projectId);
  const projectsById = useWorkspaceStore((s) => s.projects.byId);
  const activeProject = projectId ? projectsById[projectId] : null;

  const userId = (session?.user as Record<string, unknown> | undefined)?.id as string | undefined;
  const member = userId && activeProject?.members ? activeProject.members[userId] : null;
  // D-B/A8 — no `ownerId === userId ? 'owner'` fallback. It was a default-ALLOW:
  // a NON-member of the active project was handed the owner role's
  // `grantedFeatures` for client-side widget gating. A non-member has no role
  // and therefore no features (deny-by-default). `GET /api/projects` returns
  // full records including `members`, and the seeded owner is always a member by
  // record invariant, so nothing legitimate depended on the fallback.
  const role = member?.role ?? null;

  const roleDef = role && activeProject?.roles ? activeProject.roles[role] : null;
  const grantedFeatures = roleDef?.grantedFeatures ?? [];

  const unread = useUnreadTotal(projectId);

  const placePopup = useCallback(() => {
    if (!btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    // Position popup inward based on dock edge
    if (edge === 'left') setPos({ top: rect.top, left: rect.right + 6 });
    else if (edge === 'right') setPos({ top: rect.top, left: rect.left - 6 });
    else if (edge === 'bottom') setPos({ top: rect.top - 6, left: rect.left });
    else setPos({ top: rect.bottom + 6, left: rect.left }); // top or default
  }, [edge]);

  const toggle = useCallback(() => {
    if (disabled) return;
    setIsOpen((prev) => {
      if (!prev) { placePopup(); setView('account'); }
      return !prev;
    });
  }, [disabled, placePopup]);

  const openInbox = useCallback((inboxView: InboxView) => {
    setInboxEntry((entry) => ({ n: entry.n + 1, view: inboxView }));
    setView('inbox');
  }, []);

  // "Open in Inbox" from a dock item's notifications opens this popup on its
  // inbox view, on the tab it asked for (a counter, so only a NEW request
  // opens it — never the mount).
  const inboxRequest = useInboxRequest();
  const seenInboxRequest = useRef(inboxRequest);
  useEffect(() => {
    if (inboxRequest === seenInboxRequest.current) return;
    seenInboxRequest.current = inboxRequest;
    placePopup();
    openInbox(inboxRequestView());
    setIsOpen(true);
  }, [inboxRequest, placePopup, openInbox]);

  const popup = isOpen ? createPortal(
    <>
      <div className="fixed inset-0" style={{ zIndex: 9998 }} onClick={() => setIsOpen(false)} />
      <div
        className="fixed bg-black/90 backdrop-blur-xl rounded-xl overflow-hidden"
        style={{
          zIndex: 9999, minWidth: '12rem',
          ...(edge === 'bottom'
            ? { bottom: window.innerHeight - pos.top, left: pos.left }
            : edge === 'right'
              ? { top: pos.top, right: window.innerWidth - pos.left }
              : { top: pos.top, left: pos.left }),
        }}
      >
        {view === 'inbox' && projectId ? (
          <InboxPanel
            key={inboxEntry.n}
            projectId={projectId}
            initialView={inboxEntry.view}
            onBack={() => setView('account')}
            onClose={() => setIsOpen(false)}
          />
        ) : (
        <>
        <div className="px-3 pt-2.5 pb-1 text-[10px] font-semibold text-white/40 uppercase tracking-wider">
          Account
        </div>

        <div className="px-4 py-2 flex items-center gap-2">
          <UserAvatar userId={userId ?? null} name={name} size={32} ringClassName="ring-1 ring-white/15" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm text-white/85 font-medium">{name}</div>
            {email && email !== name ? (
              <div className="truncate text-[11px] text-white/40">{email}</div>
            ) : null}
          </div>
        </div>

        {role ? (
          <>
            <div className="mx-3 h-px bg-white/[0.08]" />
            <div className="px-4 py-2 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Shield className="w-3 h-3 text-white/40 shrink-0" />
                <span className="text-[11px] text-white/50">Role:</span>
                <span className="text-[11px] text-white/80 font-medium capitalize">{role}</span>
              </div>
              {roleDef ? (
                <div className="text-[10px] text-white/35 space-y-0.5">
                  <div>Agents: <span className="text-white/50">{roleDef.agents === '*' ? 'All' : roleDef.agents}</span></div>
                  {grantedFeatures.length > 0 ? (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {grantedFeatures.map((f) => (
                        <span key={f} className="px-1.5 py-0.5 rounded bg-white/[0.06] text-[9px] text-white/45">{f}</span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </>
        ) : null}

        <div className="border-t border-white/10 p-2 space-y-1">
          {projectId ? (
            <button
              type="button"
              onClick={() => openInbox(unread > 0 ? 'unread' : 'all')}
              className="w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 text-white/80 hover:text-white hover:bg-white/5 rounded-lg transition"
            >
              <Inbox className="w-3.5 h-3.5 shrink-0" />
              <span className="flex-1 text-xs font-medium">Inbox</span>
              {unread > 0 ? (
                <span className="rounded-full px-1.5 text-[10px] font-bold leading-4 tabular-nums" style={UNREAD_PILL_STYLE}>
                  {badgeLabel(unread)}
                </span>
              ) : null}
            </button>
          ) : null}
          {userId ? (
            <button
              type="button"
              onClick={() => {
                if (btnRef.current) {
                  const rect = btnRef.current.getBoundingClientRect();
                  setProfileAnchor({ top: rect.top, left: rect.right + 6 });
                }
                setIsOpen(false);
                setProfileOpen(true);
              }}
              className="w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 text-white/80 hover:text-white hover:bg-white/5 rounded-lg transition"
            >
              <Pencil className="w-3.5 h-3.5 shrink-0" />
              <span className="text-xs font-medium">Edit profile</span>
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setIsOpen(false);
              // Drop the persisted workspace layout before sign-out so a shared
              // browser does not carry one user's open/minimized widgets (and
              // their nav-uri hints) into the next user's session.
              useWorkspaceStore.getState().reset();
              // Navigate client-side, not through next-auth's redirect: with
              // `redirect: true` it resolves the callback against NEXTAUTH_URL
              // server-side, which throws the browser at localhost on every
              // deployment reached by any other name — the same bounce the
              // sign-IN path fixes in ./app/auth/callbackUrl.ts.
              void signOut({ redirect: false }).then(() => {
                window.location.assign('/auth');
              });
            }}
            className="w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 text-red-400/80 hover:text-red-400 hover:bg-white/5 rounded-lg transition"
          >
            <LogOut className="w-3.5 h-3.5 shrink-0" />
            <span className="text-xs font-medium">Sign out</span>
          </button>
        </div>
        </>
        )}
      </div>
    </>,
    document.body,
  ) : null;

  return (
    <div className="relative w-full">
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        disabled={disabled}
        className={cn(
          'rounded-xl transition flex items-center shrink-0 overflow-hidden',
          dockSurf ? dockSurf.bg : (pinned ? 'bg-white/12 hover:bg-white/20' : 'bg-neutral-700 hover:bg-neutral-600'),
          expanded ? 'w-full h-11 px-0' : 'w-12 h-11 justify-center',
          align === 'right' ? 'flex-row-reverse' : 'flex-row',
          'disabled:opacity-40 disabled:cursor-not-allowed',
        )}
        title={unread > 0 ? `${name} — ${unread} unread` : name}
      >
        <div className="relative w-12 h-full flex items-center justify-center shrink-0">
          <UserAvatar userId={userId ?? null} name={name} size={20} />
          {unread > 0 ? <UnreadDot className="absolute top-2 right-2.5" /> : null}
        </div>
        {expanded ? (
          <div className={cn(
            'flex-1 flex items-center min-w-0 text-white/70',
            align === 'right' ? 'pl-3 justify-center' : 'pr-3 justify-center',
          )}>
            <span className="min-w-0 line-clamp-2 leading-tight break-words text-center text-xs font-medium mr-1">{name}</span>
            <ChevronDown className="w-3 h-3 opacity-50 shrink-0" />
          </div>
        ) : null}
      </button>
      {popup}
      {userId ? (
        <UserProfilePopup
          userId={userId}
          userName={name}
          isOpen={profileOpen}
          anchor={profileAnchor}
          onClose={() => setProfileOpen(false)}
        />
      ) : null}
    </div>
  );
}