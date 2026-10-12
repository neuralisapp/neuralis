'use client';

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { LayoutDashboard, Search, X, Pin, PinOff, Plus } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useDockPrefs, useDockWidgetItems, useNewWindowAgent, useWorkspaceSession } from '../store/selectors';
import { isRepeatableWidget } from '../widgets/registry';
import { usePackageDockItems } from './useDockItems';
import { resolveDockIcon } from './dockIcons';
import { AppGlyph } from '../packages/PackageAppIcon';
import { packageDockKey, setDockKeyHidden } from './dockOrder';
import { LayoutSettingsPanel } from './LayoutSettingsPanel';
import { CONTROL_SURFACE, CONTROL_SURFACE_THEME_ID } from './widgetSurface';

/** Authorized scoped catalog, independent of dock hiding — a portaled dialog. Each opening starts on Apps. */
export function AppMenu({ onClose }: { onClose: () => void }) {
  const { agentId: sessionAgentId, projectId } = useWorkspaceSession();
  const items = usePackageDockItems(projectId, sessionAgentId);
  // The agent a launched window binds to (in a Group: the selected member).
  const agentId = useNewWindowAgent();
  const primaryPrefs = useDockPrefs('primary');
  const secondaryPrefs = useDockPrefs('secondary');
  const widgets = useDockWidgetItems();
  const editing = useWorkspaceStore(s => s.dockEditing.primary || s.dockEditing.secondary);
  const [query, setQuery] = useState('');
  const [layout, setLayout] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const counts = useMemo(() => {
    const result = new Map<string, number>();
    for (const id of widgets.openOrder) {
      const widget = widgets.byId[id];
      if (widget) result.set(widget.type, (result.get(widget.type) ?? 0) + 1);
    }
    return result;
  }, [widgets.byId, widgets.openOrder]);
  const matches = useMemo(() => items.filter(item => item.onClick.kind === 'openWidget' && item.label.toLowerCase().includes(query.toLowerCase())), [items, query]);
  useDialogFocus(panel, onClose);
  const tab = (active: boolean) => cn('h-8 px-3 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors', active ? 'bg-white/15 text-white' : 'text-white/55 hover:text-white hover:bg-white/8');
  const content = <div ref={panel} data-theme-id={CONTROL_SURFACE_THEME_ID} data-control-surface="" tabIndex={-1} role="dialog" aria-modal aria-label="Apps" className="flex flex-col min-h-0 w-full h-full rounded-[22px] border overflow-hidden shadow-2xl shadow-black/60" style={CONTROL_SURFACE}>
    <div className="flex items-center gap-1 px-3 py-2 border-b border-white/8">
      <div className="flex items-center gap-1 rounded-lg bg-white/5 p-0.5" role="group" aria-label="Panel">
        <button type="button" className={tab(!layout)} onClick={() => setLayout(false)} aria-pressed={!layout}>Apps</button>
        <button type="button" className={tab(layout)} onClick={() => setLayout(true)} aria-pressed={layout}><LayoutDashboard className="w-3.5 h-3.5" />Layout</button>
      </div>
      <button type="button" className="ml-auto h-8 w-8 rounded-md flex items-center justify-center text-white/55 hover:text-white hover:bg-white/10" onClick={onClose} aria-label="Close Apps"><X className="w-4 h-4" /></button>
    </div>
    {layout ? <div className="flex-1 min-h-0"><LayoutSettingsPanel /></div> : <div className="flex-1 min-h-0 overflow-y-auto p-3">
      <label className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-2.5 h-9 mb-3"><Search className="w-4 h-4 text-white/45" /><input aria-label="Search apps" className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-white/35" placeholder="Search apps" value={query} onChange={event => setQuery(event.target.value)} /></label>
      {editing ? <p className="text-xs text-white/55 mb-3">Save or cancel dock editing before changing pins.</p> : null}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        {matches.map(item => {
          const Icon = resolveDockIcon(item.icon); const key = packageDockKey(item.packageId, item.id);
          const prefs = (item.dock === 'primary' ? primaryPrefs : secondaryPrefs) ?? { order: [], hidden: [] };
          const hidden = prefs.hidden.includes(key); const action = item.onClick;
          if (action.kind !== 'openWidget') return null;
          const count = counts.get(action.widgetType) ?? 0;
          const repeatable = isRepeatableWidget(action.widgetType);
          return <div key={key} className="rounded-xl border border-white/8 bg-white/[0.03] p-1 flex items-center gap-1">
            <button type="button" disabled={!agentId} className="flex items-center gap-3 min-w-0 flex-1 h-11 px-2 rounded-lg hover:bg-white/8 disabled:opacity-40" onClick={() => {
              if (!agentId) return;
              useWorkspaceStore.getState().openWidget({ agentId, type: action.widgetType, title: action.widgetTitle || item.label }); onClose();
            }}><AppGlyph image={item.image} icon={Icon} size={24} className="w-6 h-6 shrink-0" style={{ color: item.color }} /><span className="text-sm text-left min-w-0 truncate">{item.label}</span>{count ? <span className="ml-auto text-[10px] text-white/45 shrink-0">{count} open</span> : null}</button>
            {repeatable && count > 0 ? <button type="button" disabled={!agentId} aria-label={`New ${item.label} window`} title="New window" className="h-8 w-8 shrink-0 rounded-md flex items-center justify-center text-white/45 hover:text-white hover:bg-white/10 disabled:opacity-30" onClick={() => {
              if (!agentId) return;
              useWorkspaceStore.getState().openWidget({ agentId, type: action.widgetType, title: action.widgetTitle || item.label, target: 'new' }); onClose();
            }}><Plus className="w-3.5 h-3.5" /></button> : null}
            <button type="button" disabled={editing} aria-label={`${hidden ? 'Pin' : 'Unpin'} ${item.label}`} title={editing ? 'Save or cancel dock editing first' : hidden ? 'Show in the dock' : 'Hide from the dock'} className="h-8 w-8 shrink-0 rounded-md flex items-center justify-center text-white/45 hover:text-white hover:bg-white/10 disabled:opacity-30" onClick={() => useWorkspaceStore.getState().setDockPrefs({ dockId: item.dock, prefs: setDockKeyHidden(prefs, key, !hidden) })}>{hidden ? <Pin className="w-3.5 h-3.5" /> : <PinOff className="w-3.5 h-3.5" />}</button>
          </div>;
        })}
      </div>
      {!matches.length ? <p className="text-sm text-white/50 py-6 text-center">{query ? 'No matching apps' : 'No available apps'}</p> : null}
    </div>}
  </div>;
  if (typeof document === 'undefined') return null;
  return createPortal(<div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/40" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><div className="w-full max-w-xl h-[min(80dvh,36rem)]">{content}</div></div>, document.body);
}

/** The launcher's focus/Escape boundary. */
export function useDialogFocus(panel: RefObject<HTMLDivElement | null>, onClose: () => void): void {
  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab') return;
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
