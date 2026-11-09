'use client';

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { LayoutDashboard, Search, X, Pin, PinOff, ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/cn';
import { groupScopeKey, useWorkspaceStore } from '../store/workspaceStore';
import { useDockPrefs } from '../store/selectors';
import { usePrimaryDockItems, useSecondaryDockItems } from './useDockItems';
import { combineDockItems, extendDraft, setDockKeyHidden } from './dockOrder';
import { LauncherGrid, LauncherViewChoices, LauncherWindows, PHONE_LAUNCHER_ROW, PHONE_SAFE_BOTTOM, SHEET_DISMISS_DRAG_PX, type DockItem, type PhoneWindow } from './Dock';
import { LayoutSettingsPanel } from './LayoutSettingsPanel';
import { CONTROL_SURFACE, CONTROL_SURFACE_THEME_ID, surfaceStyle, surfaceBlurClass } from './widgetSurface';

/** One responsive launcher; catalogs are authorized live items before pin preferences. */
export function AppMenu({ onClose, phone = false, windows = [], onWindow = () => {}, onMinimize = () => {} }: {
  onClose: () => void; phone?: boolean; windows?: PhoneWindow[]; onWindow?: (id: string) => void; onMinimize?: (id: string) => void;
}) {
  const primary = usePrimaryDockItems(phone ? 'bottom' : 'top', false, true, false, true, true);
  const secondary = useSecondaryDockItems(phone ? 'bottom' : 'top', false, true, false, true);
  const primaryPrefs = useDockPrefs('primary');
  const secondaryPrefs = useDockPrefs('secondary');
  const phonePrefs = useDockPrefs('phone');
  const editing = useWorkspaceStore((s) => s.dockEditing);
  const scope = useWorkspaceStore((s) => s.liveUserId && s.session.projectId ? groupScopeKey(s.liveUserId, s.session.projectId) : '');
  const previousEditing = useRef(editing);
  const [actions, setActions] = useState<string | null>(null);
  const [actionAt, setActionAt] = useState({ left: 8, top: 8 });
  const openActions = (item: DockItem, anchor: HTMLElement) => { const rect = anchor.getBoundingClientRect(); setActionAt({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 152)), top: Math.max(8, Math.min(rect.bottom, window.innerHeight - 120)) }); setActions(item.id); };
  const actionTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const old = previousEditing.current; previousEditing.current = editing;
    if ((!old.primary && editing.primary) || (!old.secondary && editing.secondary) || (!old.phone && editing.phone)) onClose();
  }, [editing, onClose]);
  useEffect(() => { setActions(null); }, [scope]);

  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [page, setPage] = useState<'apps' | 'agents' | 'layout'>('apps');
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const drag = useRef<{ pointerId: number; y: number } | null>(null);
  const combined = useMemo(() => combineDockItems(primary, secondary), [primary, secondary]);
  useEffect(() => { if (actions) actionTrigger.current = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((button) => button.getAttribute('data-launcher-actions') === actions) ?? null; }, [actions]);
  const anyEditing = Boolean(editing.primary || editing.secondary || editing.phone);
  const apps = primary.filter((item) => item.section !== 'header' && item.section !== 'footer' && item.kind !== 'separator');
  const agents = secondary.filter((item) => item.section !== 'header' && item.kind !== 'separator');
  const matches = (page === 'agents' ? agents : apps).filter((item) => item.title.toLowerCase().includes(query.toLowerCase()));
  useDialogFocus(panel, onClose);
  useEffect(() => { if (actions && (page === 'layout' || !matches.some((item) => item.id === actions))) setActions(null); }, [actions, primary, secondary, page, query]);
  useEffect(() => { if (searchOpen) search.current?.focus(); }, [searchOpen]);
  const pin = (item: DockItem) => {
    if (!item.prefKey) return null;
    const dockId = phone ? 'phone' : item.prefsId ?? (item.group?.startsWith('agents:') ? 'secondary' : 'primary');
    const prefs = (dockId === 'phone' ? phonePrefs : dockId === 'primary' ? primaryPrefs : secondaryPrefs) ?? { order: [], hidden: [] };
    const hidden = prefs.hidden.includes(item.prefKey);
    return <button type="button" role="menuitem" disabled={anyEditing} aria-label={`${hidden ? 'Pin' : 'Unpin'} ${item.title}`} className="flex h-9 w-full items-center gap-2 px-3 text-xs hover:bg-white/10 disabled:opacity-30" onClick={(event) => {
      event.stopPropagation();
      useWorkspaceStore.getState().setDockPrefs({ dockId, prefs: setDockKeyHidden(extendDraft(prefs, dockId === 'phone' ? combined : dockId === 'primary' ? primary.filter((candidate) => candidate.prefsId !== 'secondary') : [...primary.filter((candidate) => candidate.prefsId === 'secondary'), ...secondary]), item.prefKey!, !hidden) });
      setActions(null); actionTrigger.current?.focus();
    }}>{hidden ? <Pin className="h-3 w-3" /> : <PinOff className="h-3 w-3" />}{hidden ? 'Pin' : 'Unpin'}</button>;
  };
  const tab = (active: boolean) => cn('h-8 px-3 rounded-md text-xs font-medium flex items-center gap-1.5', active ? 'bg-white/15 text-white' : 'text-white/55 hover:text-white hover:bg-white/8');
  const resetDrag = () => { drag.current = null; if (panel.current) panel.current.style.transform = ''; };
  const content = <div ref={panel} data-theme-id={CONTROL_SURFACE_THEME_ID} data-control-surface="" tabIndex={-1} role="dialog" aria-modal aria-label="Apps" className={cn(surfaceBlurClass('dim'), 'flex flex-col min-h-0 w-full border overflow-hidden shadow-2xl shadow-black/60 outline-none', phone ? 'max-h-full rounded-t-[24px]' : 'rounded-[22px] max-h-[min(85dvh,42rem)]')} style={{ ...CONTROL_SURFACE, ...surfaceStyle('dim'), ...(phone ? { maxHeight: `calc(100dvh - ${PHONE_LAUNCHER_ROW} - ${PHONE_SAFE_BOTTOM})` } : {}) }}>
    {phone ? <div aria-hidden="true" className="flex h-5 shrink-0 cursor-grab touch-none items-center justify-center"
      onPointerDown={(event) => { drag.current = { pointerId: event.pointerId, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={(event) => { const start = drag.current; if (start?.pointerId === event.pointerId && panel.current) panel.current.style.transform = `translateY(${Math.max(0, event.clientY - start.y)}px)`; }}
      onPointerUp={(event) => { const start = drag.current; resetDrag(); if (start && event.clientY - start.y > SHEET_DISMISS_DRAG_PX) onClose(); }} onPointerCancel={resetDrag}><span className="h-1 w-10 rounded-full bg-white/25" /></div> : null}
    <div className="flex shrink-0 items-center gap-1 px-2 py-1 border-b border-white/8">
      <div className="flex items-center shrink-0">{[...primary, ...secondary].filter((item) => item.section === 'header').map((item) => <div key={item.id} className="w-11">{item.renderCustom?.()}</div>)}</div>
      <button type="button" aria-label="Search" aria-expanded={searchOpen} className="ml-auto h-9 w-9 shrink-0 flex items-center justify-center rounded-lg hover:bg-white/10" onClick={() => { setSearchOpen((open) => !open); setQuery(''); }}><Search className="h-4 w-4" /></button>
      <button type="button" className={tab(page === 'layout')} onClick={() => { setPage(page === 'layout' ? 'apps' : 'layout'); setQuery(''); }} aria-label={page === 'layout' ? 'Back to Apps' : 'Layout'}>{page === 'layout' ? <ArrowLeft className="w-4 h-4" /> : <LayoutDashboard className="w-4 h-4" />}<span>Layout</span></button>
      <button type="button" className="h-9 w-9 shrink-0 rounded-lg flex items-center justify-center hover:bg-white/10" onClick={onClose} aria-label="Close Apps"><X className="w-4 h-4" /></button>
    </div>
    {page === 'layout' ? <div className="min-h-0 h-[min(65dvh,32rem)]"><LayoutSettingsPanel phone={phone} onEdit={onClose} /></div> : <>
      <div className="shrink-0 flex items-center gap-1 px-3 py-2"><button type="button" className={tab(page === 'apps')} onClick={() => { setPage('apps'); setQuery(''); }} aria-pressed={page === 'apps'}>Apps</button><button type="button" className={tab(page === 'agents')} onClick={() => { setPage('agents'); setQuery(''); }} aria-pressed={page === 'agents'}>Agents</button><div className="ml-auto min-w-0"><LauncherViewChoices /></div></div>
      <LauncherWindows windows={windows} onWindow={onWindow} onMinimize={onMinimize} onClose={onClose} />
      {searchOpen ? <label className="mx-3 mb-2 flex shrink-0 rounded-lg border border-white/10 bg-white/5 px-2.5 h-9"><input ref={search} aria-label={`Search ${page}`} className="w-full min-w-0 bg-transparent text-sm outline-none" placeholder={`Search ${page}`} value={query} onChange={(event) => setQuery(event.target.value)} /></label> : null}
      <div className="min-h-0 overflow-y-auto px-3 pb-4"><LauncherGrid label={page === 'agents' ? 'Agents' : 'Apps'} items={matches} onAct={onClose} phone={phone} onActions={openActions} actions={(item) => <div className="relative" onClick={(event) => event.stopPropagation()}><button type="button" data-launcher-actions={item.id} aria-label={`Actions for ${item.title}`} aria-haspopup="menu" aria-expanded={actions === item.id} className="flex h-7 w-7 items-center justify-center rounded-full text-white/60 hover:bg-white/10" onClick={(event) => { actionTrigger.current = event.currentTarget; if (actions === item.id) setActions(null); else openActions(item, event.currentTarget); }}>⋯</button>{actions === item.id ? createPortal(<div role="menu" aria-label={`${item.title} actions`} data-launcher-popover="" className="fixed z-[120] w-36 rounded-lg border py-1 shadow-xl" style={{ ...CONTROL_SURFACE, ...actionAt }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setActions(null); }} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setActions(null); actionTrigger.current?.focus(); } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')); const index = buttons.indexOf(document.activeElement as HTMLButtonElement); const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length; buttons[next]?.focus(); } }} ref={(node) => { node?.querySelector<HTMLElement>('button:not(:disabled)')?.focus(); }}>{pin(item)}{item.onNewWindow ? <button type="button" role="menuitem" aria-label={`New ${item.title} window`} className="h-9 w-full px-3 text-left text-xs hover:bg-white/10" onClick={() => { item.onNewWindow?.(); onClose(); }}>New window</button> : null}</div>, document.body) : null}</div>} />{!matches.length ? <p className="text-sm text-white/50 py-6 text-center">{query ? 'No matches' : 'No available items'}</p> : null}</div>
    </>}
  </div>;
  if (typeof document === 'undefined') return null;
  return createPortal(<div data-phone-sheet-scrim={phone ? '' : undefined} className={cn('fixed inset-x-0 top-0 z-[100] flex', phone ? 'items-end justify-center' : 'bottom-0 items-center justify-center p-4')} style={phone ? { bottom: `calc(${PHONE_LAUNCHER_ROW} + ${PHONE_SAFE_BOTTOM})` } : undefined} onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className={cn('w-full min-h-0 max-h-full flex flex-col', !phone && 'max-w-[680px]')}>{content}</div></div>, document.body);
}

/** The launcher's focus/Escape boundary. */
export function useDialogFocus(panel: RefObject<HTMLDivElement | null>, onClose: () => void): void {
  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.focus();
    const key = (event: KeyboardEvent) => {
      const targetDialog = event.target instanceof HTMLElement ? event.target.closest('[role="dialog"]') : null;
      if (targetDialog && targetDialog !== panel.current) return;
      if (event.key === 'Escape' && !event.defaultPrevented) {
        if (document.querySelector('[data-launcher-popover]')) return;
        event.preventDefault(); onClose();
      }
      if (event.key !== 'Tab' || (document.activeElement instanceof HTMLElement && document.activeElement.closest('[data-launcher-popover]'))) return;
      const controls = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, [tabindex="0"]');
      if (!controls?.length) return;
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [onClose, panel]);
}

/** A single history entry for the Phone overlay, including immediate handoff/reopen. */
export function phoneOverlayHistory(browser: { history: Pick<History, 'state' | 'pushState' | 'back'>; addEventListener: (type: 'popstate', listener: () => void) => void; removeEventListener: (type: 'popstate', listener: () => void) => void }, close: () => void, token: string): { sync: (open: boolean) => void; dispose: () => void } {
  const marker = '__neuralisPhoneOverlay';
  let wanted = false; let pending = false; let listening = false; let disposed = false;
  const owned = () => browser.history.state?.[marker] === token;
  const stop = () => { if (listening) browser.removeEventListener('popstate', pop); listening = false; };
  const push = () => {
    if (!listening) { browser.addEventListener('popstate', pop); listening = true; }
    browser.history.pushState({ ...browser.history.state, [marker]: token }, '');
  };
  const pop = () => {
    if (pending) { pending = false; if (wanted && !disposed) push(); else stop(); return; }
    if (!owned()) { wanted = false; stop(); if (!disposed) close(); }
  };
  const sync = (open: boolean) => {
    wanted = open && !disposed;
    if (pending) return;
    if (wanted) { if (!owned()) push(); }
    else if (owned()) { pending = true; browser.history.back(); }
    else stop();
  };
  return { sync, dispose: () => { disposed = true; sync(false); } };
}
