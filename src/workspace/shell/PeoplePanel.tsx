'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { createReconnectDetector } from '@neuralis/package-system/client';
import type { PresenceClientKind, PresenceUserView } from '@neuralis/package-system/access';
import { useWorkspaceStore } from '../store/workspaceStore';
import { getHubConnected, subscribeHub } from '../realtime/eventHub';
import { UserAvatar } from './UserAvatar';

const KIND_LABELS: Record<PresenceClientKind, string> = {
  web: 'Browser',
  desktop: 'Desktop app',
  cli: 'CLI',
  mcp: 'MCP client',
  device: 'Device',
  other: 'Other client',
};

/** A burst of `members` frames is one re-read. */
const REREAD_DEBOUNCE_MS = 400;

async function fetchPresence(projectId: string): Promise<PresenceUserView[]> {
  const res = await fetch('/api/presence', { headers: { 'X-Project-Id': projectId } });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  const body = (await res.json()) as { users?: unknown };
  return Array.isArray(body.users) ? (body.users as PresenceUserView[]) : [];
}

/** `Browser · CLI ×2` — the kinds the answer carried, with a count where it carried one. */
export function presenceSummary(view: PresenceUserView): string {
  return view.kinds
    .map((kind) => {
      const count = view.counts?.[kind];
      return count && count > 1 ? `${KIND_LABELS[kind]} ×${count}` : KIND_LABELS[kind];
    })
    .join(' · ');
}

/**
 * People in the account popup: this project's members, online first, each
 * with the clients they are on — as far as the caller's features reach (the
 * server projects every user through the kernel's ONE presence predicate; this
 * view renders exactly what came back). ONE read on open, one debounced
 * re-read per burst of `members` frames and one when the hub reconnects — no
 * poll.
 */
export function PeoplePanel({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const members = useWorkspaceStore((s) => s.projects.byId[projectId]?.members);
  const [users, setUsers] = useState<PresenceUserView[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const mine = ++generation.current;
    try {
      const next = await fetchPresence(projectId);
      if (mine !== generation.current) return;
      setUsers(next);
      setFailed(false);
    } catch {
      if (mine === generation.current) setFailed(true);
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const reconnect = createReconnectDetector(getHubConnected, () => { void load(); });
    const unsubscribe = subscribeHub({
      projectId,
      channel: 'members',
      onEvent: () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; void load(); }, REREAD_DEBOUNCE_MS);
      },
      onConnChange: reconnect.onConnChange,
    });
    reconnect.arm();
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [projectId, load]);

  const rows = [...users].sort((a, b) => Number(b.online) - Number(a.online));
  const onlineCount = users.filter((u) => u.online).length;

  return (
    <div className="w-72 max-w-[calc(100vw-16px)]">
      <div className="flex items-center gap-1 px-2 pt-2 pb-1">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to account"
          className="p-1 rounded-lg text-white/50 hover:text-white hover:bg-white/5 transition"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
        <span className="flex-1 text-[10px] font-semibold text-white/40 uppercase tracking-wider">People</span>
        {!loading && !failed ? (
          <span className="pr-2 text-[10.5px] tabular-nums text-white/35">{onlineCount} online</span>
        ) : null}
      </div>
      <div className="max-h-80 overflow-y-auto px-1 pb-2">
        {failed ? (
          <div className="px-3 py-4 text-[11px] text-red-300/80">Could not load who is online.</div>
        ) : loading ? (
          <div className="px-3 py-4 text-[11px] text-white/35">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="px-3 py-4 text-[11px] text-white/35">Nobody to show here.</div>
        ) : (
          rows.map((user) => {
            const name = members?.[user.userId]?.name ?? user.userId;
            const summary = user.online ? presenceSummary(user) : 'Offline';
            return (
              <div key={user.userId} className="flex items-center gap-2 px-2 py-1.5 rounded-lg" title={user.clients?.map((c) => c.label).join('\n')}>
                <span className="relative shrink-0">
                  <UserAvatar userId={user.userId} name={name} size={24} />
                  <span
                    aria-label={user.online ? 'online' : 'offline'}
                    className="absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-black/60"
                    style={{ background: user.online ? '#6ee7b7' : 'rgba(255,255,255,0.25)' }}
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] text-white/80">{name}</span>
                  <span className="block truncate text-[10.5px] text-white/40">{summary || 'Online'}</span>
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
