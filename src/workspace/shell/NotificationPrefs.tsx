'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/cn';
import {
  fetchNotificationPrefs,
  saveNotificationPrefs,
  type NotificationCatalogEntry,
  type NotificationPrefs as Prefs,
} from '../notifications/notificationsClient';
import type { PackageDockItem } from '../packages/dockRuntime';
import { packageDockKey } from './dockOrder';
import { AppGroupHeader, appIdentity } from './InboxPanel';

export type PrefChoice = 'default' | 'follow' | 'mute';

/** Where a kind of notification stands for this user. Mute wins. */
export function prefChoice(prefs: Prefs, type: string): PrefChoice {
  if (prefs.mute.includes(type)) return 'mute';
  if (prefs.follow.includes(type)) return 'follow';
  return 'default';
}

/** The settings with one kind moved to `choice` — never in both lists. */
export function withPrefChoice(prefs: Prefs, type: string, choice: PrefChoice): Prefs {
  const mute = prefs.mute.filter((t) => t !== type);
  const follow = prefs.follow.filter((t) => t !== type);
  if (choice === 'mute') mute.push(type);
  if (choice === 'follow') follow.push(type);
  return { mute, follow };
}

/**
 * Per kind of notification: the default (your own runs, or off), every one you
 * can see, or muted. The list is the server's catalog for THIS caller — only
 * kinds they could ever receive are named.
 */
export function NotificationPrefs({
  projectId, dockItems, onBack,
}: { projectId: string; dockItems: readonly PackageDockItem[]; onBack: () => void }) {
  const [catalog, setCatalog] = useState<NotificationCatalogEntry[] | null>(null);
  const [prefs, setPrefs] = useState<Prefs>({ mute: [], follow: [] });
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetchNotificationPrefs(projectId)
      .then((body) => { if (live) { setCatalog(body.catalog); setPrefs(body.prefs); } })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [projectId]);

  const groups = useMemo(() => {
    const out = new Map<string, { dockKey: string | null; packageId: string; entries: NotificationCatalogEntry[] }>();
    for (const entry of catalog ?? []) {
      const dockKey = entry.dock ? packageDockKey(entry.packageId, entry.dock) : null;
      const key = dockKey ?? entry.packageId;
      const group = out.get(key) ?? { dockKey, packageId: entry.packageId, entries: [] };
      group.entries.push(entry);
      out.set(key, group);
    }
    return [...out.entries()];
  }, [catalog]);

  const choose = (type: string, choice: PrefChoice): void => {
    const before = prefs;
    const next = withPrefChoice(prefs, type, choice);
    setPrefs(next);
    saveNotificationPrefs(projectId, next).then(setPrefs).catch(() => setPrefs(before));
  };

  return (
    <div className="flex flex-col min-h-0 max-h-[70vh] w-[22rem]">
      <div className="flex items-center gap-1 px-2 pt-2 pb-1.5 border-b border-white/[0.06]">
        <button
          type="button"
          onClick={onBack}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-white/50 hover:text-white hover:bg-white/[0.06] transition-colors"
          aria-label="Back to the inbox"
          title="Back"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <span className="flex-1 text-[13px] font-semibold text-white/85">Notifications</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {catalog === null && !failed ? <div className="px-3 py-4 text-[12px] text-white/40">Loading…</div> : null}
        {failed ? <div className="px-3 py-4 text-[12px] text-white/45">Couldn’t load the settings — try again in a moment.</div> : null}
        {catalog !== null && catalog.length === 0 ? (
          <div className="px-3 py-6 text-[12px] text-white/45">Nothing in this project sends notifications yet.</div>
        ) : null}
        {groups.map(([key, group]) => (
          <section key={key}>
            <AppGroupHeader identity={appIdentity(group.dockKey, group.packageId, dockItems)} />
            {group.entries.map((entry) => (
              <PrefRow key={entry.type} entry={entry} choice={prefChoice(prefs, entry.type)} onChoose={(c) => choose(entry.type, c)} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

function PrefRow({
  entry, choice, onChoose,
}: { entry: NotificationCatalogEntry; choice: PrefChoice; onChoose: (choice: PrefChoice) => void }) {
  const options: { value: PrefChoice; label: string; hint: string }[] = [
    {
      value: 'default',
      label: entry.defaultOn ? 'Mine' : 'Off',
      hint: entry.defaultOn ? 'Only what concerns you — your own runs' : 'Not unless you follow it',
    },
    { value: 'follow', label: 'All', hint: 'Every one you can see in this project' },
    { value: 'mute', label: 'Mute', hint: 'Never, not even your own' },
  ];
  return (
    <div className="px-2 py-1.5 flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] text-white/80">{entry.title}</div>
        {entry.description ? <div className="line-clamp-2 text-[10.5px] leading-snug text-white/40">{entry.description}</div> : null}
      </div>
      <div className="shrink-0 grid grid-cols-3 gap-0.5 rounded-md bg-white/[0.05] p-0.5" role="radiogroup" aria-label={entry.title}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={choice === option.value}
            onClick={() => onChoose(option.value)}
            title={option.hint}
            className={cn(
              'rounded px-1.5 py-0.5 text-[10.5px] font-medium transition-colors',
              choice === option.value
                ? (option.value === 'mute' ? 'bg-rose-500/25 text-rose-100' : 'bg-white/15 text-white')
                : 'text-white/45 hover:text-white/80',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
