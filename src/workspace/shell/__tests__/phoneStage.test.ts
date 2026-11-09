import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeDom, click, FakeNode } from './fakeDom';
const dom = installFakeDom();
Object.defineProperty(FakeNode.prototype, 'parentElement', { get(this: FakeNode) { return this.parentNode?.nodeType === 1 ? this.parentNode : null; }, configurable: true });
Object.defineProperty(FakeNode.prototype, 'remove', { value(this: FakeNode) { this.parentNode?.removeChild(this); }, configurable: true });
Object.defineProperty(FakeNode.prototype, 'options', { get() { return this.querySelectorAll('option'); }, configurable: true });
const values = new Map<string, string>();
const writes = vi.fn((key: string, value: string) => values.set(key, value));
Object.assign(window, { innerWidth: 1024, innerHeight: 768, screen: { width: 1024, height: 768 }, localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: writes, removeItem: (key: string) => values.delete(key) } });
const dockFixture = vi.hoisted(() => ({ open: undefined as undefined | ((id: string) => void), clean: undefined as undefined | ((id: string) => void), later: false, newWindow: vi.fn() }));
vi.mock('../useDockItems', () => ({
  usePrimaryDockItems: () => [{ id: 'app-files', position: 1, title: 'Files', prefKey: 'pkg:files', group: 'trust:native', icon: () => null, onClick: () => dockFixture.open?.('files'), onDoubleClick: () => undefined, onNewWindow: () => dockFixture.newWindow(), onClean: () => dockFixture.clean?.('files') }, ...(dockFixture.later ? [{ id: 'later-app', title: 'Later app', prefKey: 'pkg:later', group: 'trust:native', position: 2, icon: () => null, onClick: () => undefined }] : [])],
  useSecondaryDockItems: () => [
    { id: '__project', position: 0, section: 'header', title: 'Project', icon: () => null, onClick: () => dockFixture.open?.('project') },
    { id: 'agent-b', position: 1, title: 'Agent B', prefKey: 'agent:b', group: 'agents:own', icon: () => null, onClick: () => dockFixture.open?.('agent-b') },
  ],
  usePackageDockItems: () => [],
  useScopedSnapshotPending: () => false,
}));
vi.mock('../AnimatedUniverseBackground', () => ({ AnimatedUniverseBackground: () => null }));
vi.mock('../../theme/useTheme', async () => { const { DEFAULT_THEME } = await import('../../theme/themes'); return { useTheme: () => ({ theme: DEFAULT_THEME, backgroundTheme: DEFAULT_THEME, dockTheme: DEFAULT_THEME }) }; });
vi.mock('../TiledStage', () => ({ TiledStage: () => null }));
vi.mock('../CanvasStage', () => ({ CanvasStage: () => null }));
const { createElement, useEffect, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { StageHost } = await import('../StageHost');
const { useWorkspaceStore, agentRuntimeKey, agentTapOpenOrder, effectiveStageMode, phoneDeviceEligible } = await import('../../store/workspaceStore');
const { registerWidget, syncPackageWidgets, listDefaultOpenWidgets } = await import('../../widgets/registry');
const { phoneForegroundId } = await import('../../store/selectors');
const { WorkspaceShell } = await import('../WorkspaceShell');
const { SHEET_DISMISS_DRAG_PX, PHONE_LAUNCHER_ROW, PHONE_SAFE_BOTTOM } = await import('../Dock');
let root: ReturnType<typeof createRoot> | null = null;
const mounts = vi.fn();
const unmounts = vi.fn();
function Viewer({ id, hidden }: { id: string; hidden?: boolean }) {
  useEffect(() => { mounts(id); return () => unmounts(id); }, [id]);
  return createElement('textarea', { 'data-viewer': id, 'data-minimized': String(Boolean(hidden)), defaultValue: 'draft' });
}
const state = () => useWorkspaceStore.getState();
const key = agentRuntimeKey('p', 'a');
const foreground = () => { const rt = state().runtimeByAgentId[key]; return phoneForegroundId(rt.widgets.openOrder, rt.widgets.byId, state().phoneForegroundByRuntimeKey[key]); };
beforeEach(() => {
  Object.assign(window, { history: historyFixture().browser.history, addEventListener: window.addEventListener ?? (() => undefined), removeEventListener: window.removeEventListener ?? (() => undefined), performance: window.performance ?? { timeOrigin: 0 } });
  state().reset(); syncPackageWidgets([]);
  registerWidget({ type: 'viewer', title: 'Viewer', render: ({ instance }) => createElement(Viewer, { id: instance.id, hidden: instance.hidden }) });
  useWorkspaceStore.setState({ session: { projectId: 'p', agentId: 'a', workspaceView: 'default' } });
  state().setResponsivePhone(false, true); Object.assign(window, { innerWidth: 1024, innerHeight: 768, screen: { width: 1024, height: 768 } });
  dockFixture.later = false;
  mounts.mockClear(); unmounts.mockClear(); writes.mockClear();
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; syncPackageWidgets([]); });
describe('Phone foreground and the existing stage outlet owner', () => {
  it('retains viewer DOM and drafts on foreground switch, with distinct actual minimize/restore', async () => {
    state().setStageMode({ agentId: 'a', mode: 'phone' });
    const first = state().openWidget({ agentId: 'a', type: 'viewer', title: 'First' })!;
    const second = state().openWidget({ agentId: 'a', type: 'viewer', title: 'Second', target: 'new' })!;
    root = createRoot(dom.container as unknown as Element);
    await act(async () => root!.render(createElement(StageHost)));
    const original = dom.container.querySelectorAll(`[data-viewer="${first}"]`)[0];
    original.value = 'retained draft';
    const home = original.parentNode?.parentNode;
    const relocation = vi.spyOn(home!, 'appendChild');
    expect(foreground()).toBe(second);
    await act(async () => state().focusWidget({ agentId: 'a', widgetInstanceId: first }));
    expect(foreground()).toBe(first);
    expect(dom.container.querySelectorAll(`[data-viewer="${first}"]`)[0]).toBe(original);
    expect(original.value).toBe('retained draft');
    expect(original.parentNode?.parentNode).toBe(home);
    expect(relocation).not.toHaveBeenCalled();
    relocation.mockRestore();
    expect(mounts).toHaveBeenCalledTimes(2); expect(unmounts).not.toHaveBeenCalled();
    for (const node of dom.container.querySelectorAll('[data-viewer]')) expect(node.getAttribute('data-minimized')).toBe('false');
    const frames = dom.container.querySelectorAll('[data-phone-window]');
    expect(frames.filter(frame => frame.style.display === 'block')).toHaveLength(1);
    expect(frames.filter(frame => frame.style.display === 'none')).toHaveLength(1);
    await act(async () => state().minimizeWidget({ agentId: 'a', widgetInstanceId: first }));
    expect(foreground()).toBe(second); expect(original.getAttribute('data-minimized')).toBe('true');
    await act(async () => state().restoreWidget({ agentId: 'a', widgetInstanceId: first }));
    expect(foreground()).toBe(first); expect(original.value).toBe('retained draft');
    await act(async () => state().closeWidget({ agentId: 'a', widgetInstanceId: first }));
    expect(foreground()).toBe(second); expect(unmounts).toHaveBeenCalledTimes(1);
  });
  it('exclusive package opens use the same effective Phone foreground path', () => {
    state().setResponsivePhone(true, true);
    const first = state().openWidget({ agentId: 'a', type: 'viewer', title: 'First' })!;
    registerWidget({ type: 'other', title: 'Other', render: ({ instance }) => createElement(Viewer, { id: instance.id }) });
    const other = state().exclusiveOpenWidget({ agentId: 'a', type: 'other', title: 'Other' })!;
    expect(foreground()).toBe(other); expect(state().runtimeByAgentId[key].widgets.byId[first].hidden).toBe(true);
    state().restoreWidget({ agentId: 'a', widgetInstanceId: first }); expect(foreground()).toBe(first);
    expect(state().exclusiveOpenWidget({ agentId: 'a', type: 'other', title: 'Other' })).toBe(other);
    expect(foreground()).toBe(other);
  });
  it('focus writes no storage and rejects hidden/missing/unregistered instances; scope/reset fences clear it', () => {
    state().setStageMode({ agentId: 'a', mode: 'phone' });
    const first = state().openWidget({ agentId: 'a', type: 'viewer', title: 'First' })!;
    const second = state().openWidget({ agentId: 'a', type: 'viewer', title: 'Second', target: 'new' })!;
    writes.mockClear(); state().focusWidget({ agentId: 'a', widgetInstanceId: first });
    expect(foreground()).toBe(first); expect(writes).not.toHaveBeenCalled();
    state().focusWidget({ agentId: 'a', widgetInstanceId: 'missing' });
    state().focusWidget({ agentId: 'other', widgetInstanceId: second });
    expect(foreground()).toBe(first);
    state().minimizeWidget({ agentId: 'a', widgetInstanceId: second });
    state().focusWidget({ agentId: 'a', widgetInstanceId: second }); expect(foreground()).toBe(first);
    syncPackageWidgets([]); state().focusWidget({ agentId: 'a', widgetInstanceId: first }); expect(foreground()).toBeNull();
    expect(Object.keys(useWorkspaceStore.persist.getOptions().partialize!(state()))).not.toContain('phoneForegroundByRuntimeKey');
    state().cleanAgentStore({ agentId: 'a' }); expect(state().phoneForegroundByRuntimeKey[key]).toBeUndefined();
    state().reset(); expect(state().phoneForegroundByRuntimeKey).toEqual({});
  });
  it('round trip preserves geometry/dock preferences/instance transparency and retains the individual cycle', async () => {
    const id = state().openWidget({ agentId: 'a', type: 'viewer', title: 'App' })!;
    state().setWidgetGeometry({ agentId: 'a', widgetInstanceId: id, slot: 'canvas', geometry: { x: 30, y: 70, w: 400, h: 500, z: 2 } });
    state().setWidgetGeometry({ agentId: 'a', widgetInstanceId: id, slot: 'grid', geometry: { x: 10, y: 20, w: 300, h: 200, z: 1 } });
    state().setWidgetTransparency({ agentId: 'a', widgetInstanceId: id, level: 'dim' });
    state().setDockPrefs({ dockId: 'primary', prefs: { order: ['pkg:one'], hidden: ['pkg:two'] } });
    state().setStageMode({ agentId: 'a', mode: 'canvas' });
    const before = JSON.stringify(useWorkspaceStore.persist.getOptions().partialize!(state()));
    state().setStageMode({ agentId: 'a', mode: 'phone' }); root = createRoot(dom.container as unknown as Element);
    await act(async () => root!.render(createElement(WorkspaceShell, { snapshotReady: true, children: createElement(StageHost) })));
    await act(async () => click(dom.container.querySelectorAll('[aria-label="Transparency: Dim"]')[0]));
    expect(state().runtimeByAgentId[key].widgets.byId[id].transparency).toBe('transparent');
    await act(async () => { state().setWidgetTransparency({ agentId: 'a', widgetInstanceId: id, level: 'dim' }); state().setStageMode({ agentId: 'a', mode: 'canvas' }); });
    expect(JSON.stringify(useWorkspaceStore.persist.getOptions().partialize!(state()))).toBe(before);
  });
});


describe('automatic presentation and scoped explicit mode', () => {
  it('classifies layout/device geometry without keyboard or pinch input', () => {
    expect(phoneDeviceEligible(600, false, 1920, 1080)).toBe(true);
    expect(phoneDeviceEligible(601, false, 1920, 1080)).toBe(false);
    expect(phoneDeviceEligible(844, true, 844, 390)).toBe(true);
    expect(phoneDeviceEligible(1024, true, 1024, 768)).toBe(false);
  });
  it('shares action-time foreground resolution, preserves saved mode and excludes transient inputs', () => {
    const first = state().openWidget({ agentId: 'a', type: 'viewer', title: 'First' })!;
    const second = state().openWidget({ agentId: 'a', type: 'viewer', title: 'Second', target: 'new' })!;
    const saved = JSON.stringify(useWorkspaceStore.persist.getOptions().partialize!(state())); writes.mockClear();
    state().setResponsivePhone(true, true); expect(effectiveStageMode(state(), key)).toBe('phone');
    state().focusWidget({ agentId: 'a', widgetInstanceId: first }); expect(foreground()).toBe(first);
    expect(writes).not.toHaveBeenCalled(); expect(JSON.stringify(useWorkspaceStore.persist.getOptions().partialize!(state()))).toBe(saved);
    state().setStageMode({ agentId: 'a', mode: 'canvas' }); expect(effectiveStageMode(state(), key)).toBe('canvas');
    writes.mockClear(); state().clearManualStageMode(); expect(effectiveStageMode(state(), key)).toBe('phone');
    state().focusWidget({ agentId: 'a', widgetInstanceId: second }); expect(foreground()).toBe(second); expect(writes).not.toHaveBeenCalled();
    state().setResponsivePhone(false, true); expect(effectiveStageMode(state(), key)).toBe('canvas');
    state().setStageMode({ agentId: 'a', mode: 'phone' }); state().setResponsivePhone(false, false); expect(effectiveStageMode(state(), key)).toBe('phone');
    // A manual Phone pick never becomes the saved mode, so "Auto" returns to it.
    expect(state().runtimeByAgentId[key].layout.stageMode).toBe('canvas');
    state().clearManualStageMode(); expect(effectiveStageMode(state(), key)).toBe('canvas');
    state().setStageMode({ agentId: 'a', mode: 'phone' });
    state().cleanAgentStore({ agentId: 'a' }); expect(state().manualModeByRuntimeKey[key]).toBeUndefined();
  });
  it('mounts one resize owner and retains outlets/draft through responsive and explicit switches', async () => {
    const id = state().openWidget({ agentId: 'a', type: 'viewer', title: 'App' })!;
    const add = vi.spyOn(window, 'addEventListener'); const remove = vi.spyOn(window, 'removeEventListener');
    root = createRoot(dom.container as unknown as Element);
    await act(async () => root!.render(createElement(WorkspaceShell, { snapshotReady: true, children: createElement(StageHost) })));
    const viewer = dom.container.querySelectorAll(`[data-viewer="${id}"]`)[0]; viewer.value = 'draft';
    writes.mockClear(); await act(async () => { window.innerWidth = 390; window.dispatchEvent(new Event('resize')); });
    expect(effectiveStageMode(state(), key)).toBe('phone'); expect(dom.container.querySelectorAll('[data-phone-window]')).toHaveLength(1);
    expect(dom.container.querySelectorAll(`[data-viewer="${id}"]`)[0]).toBe(viewer); expect(viewer.value).toBe('draft');
    // The Phone window wears the desktop chrome: the same strip, the same close.
    expect(dom.container.querySelectorAll('[data-phone-window]')[0].querySelectorAll('[aria-label="Close App"]')).toHaveLength(1);
    expect(writes).not.toHaveBeenCalled();
    const subscriptions = add.mock.calls.filter(call => call[0] === 'resize'); expect(subscriptions).toHaveLength(1);
    await act(async () => root!.unmount()); root = null;
    expect(remove.mock.calls.filter(call => call[0] === 'resize')).toHaveLength(1); add.mockRestore(); remove.mockRestore();
  });
});

describe('Phone is a stage, never a second design', () => {
  it('Phone: no edge docks, ONE launcher; its panel lists windows as compact chips and the docks as icon grids', async () => {
    const first = state().openWidget({ agentId: 'a', type: 'viewer', title: 'First' })!;
    const second = state().openWidget({ agentId: 'a', type: 'viewer', title: 'Second', target: 'new' })!;
    root = createRoot(dom.container as unknown as Element);
    await act(async () => root!.render(createElement(WorkspaceShell, { snapshotReady: true, children: createElement(StageHost) })));
    expect(dom.container.querySelectorAll('[data-dock-lane]').length).toBeGreaterThan(0);
    await act(async () => state().setStageMode({ agentId: 'a', mode: 'phone' }));
    expect(dom.container.querySelectorAll('[data-dock-lane]')).toHaveLength(0);
    const launcher = () => dom.container.querySelectorAll('[aria-label="Open Apps"]')[0];
    expect(launcher()).toBeDefined();
    await act(async () => click(launcher()));
    const sheet = () => dom.document.querySelectorAll('[aria-label="Apps"]')[0];
    expect(sheet().getAttribute('data-theme-id')).toBe('dark');
    expect(sheet().parentNode?.getAttribute('class')).not.toContain('max-w-[680px]');
    expect(sheet().style.backgroundColor).toBe('rgba(var(--w-bg-rgb), 0.72)');
    // The open sheet ends above the launcher band, so the launcher stays tappable.
    const band = `calc(${PHONE_LAUNCHER_ROW} + ${PHONE_SAFE_BOTTOM})`;
    expect(dom.document.querySelectorAll('[data-phone-sheet-scrim]')[0].style.bottom).toBe(band);
    expect(dom.container.querySelectorAll('[data-phone-launcher-row]')[0].contains(launcher())).toBe(true);
    expect(String(dom.container.querySelectorAll('[data-phone-launcher-row]')[0].parentNode?.parentNode?.style.gridTemplateRows)).toBe(`0px 1fr ${PHONE_LAUNCHER_ROW}`);
    await act(async () => click(launcher()));
    expect(dom.document.querySelectorAll('[aria-label="Apps"]')).toHaveLength(0);
    await act(async () => click(launcher()));
    expect(sheet().querySelectorAll('SELECT')).toHaveLength(0);
    expect(sheet().querySelectorAll('BUTTON').filter((n) => n.textContent.trim() === 'Close')).toHaveLength(0);
    const tiles = sheet().querySelectorAll('[aria-label="Open windows"]')[0].querySelectorAll('[aria-pressed]');
    expect(tiles.map((n) => n.textContent.trim())).toEqual(['First 1', 'Second 2']);
    expect(tiles[1].getAttribute('aria-pressed')).toBe('true');
    expect(sheet().querySelectorAll('[data-phone-dock-item]').map((n) => n.getAttribute('data-phone-dock-item'))).toEqual(['app-files']);
    // A window tile brings that window to the front and closes the sheet.
    await act(async () => click(tiles[0]));
    expect(foreground()).toBe(first);
    expect(dom.document.querySelectorAll('[aria-label="Apps"]')).toHaveLength(0);
    // × minimizes, and the sheet stays.
    await act(async () => click(launcher()));
    await act(async () => click(dom.document.querySelectorAll('[aria-label="Minimize First 1"]')[0]));
    expect(state().runtimeByAgentId[key].widgets.byId[first].hidden).toBe(true);
    expect(foreground()).toBe(second);
    expect(sheet()).toBeDefined();
  });

  it('the sheet: an app or agent tap acts and closes; account/project keep it; the broom cleans without acting; tap-outside, drag-down and the launcher close', async () => {
    const acted: string[] = []; dockFixture.open = (id) => acted.push(id); dockFixture.clean = (id) => acted.push(`clean:${id}`);
    state().setStageMode({ agentId: 'a', mode: 'phone' });
    root = createRoot(dom.container as unknown as Element);
    await act(async () => root!.render(createElement(WorkspaceShell, { snapshotReady: true, children: 'workspace' })));
    const launcher = () => dom.container.querySelectorAll('[aria-label="Open Apps"]')[0];
    const sheet = () => dom.document.querySelectorAll('[aria-label="Apps"]')[0];
    const props = (node: FakeNode) => node[Object.keys(node).find((k) => k.startsWith('__reactProps$'))!] as Record<string, (e: unknown) => void>;
    const cell = (id: string) => dom.document.querySelectorAll(`[data-phone-dock-item="${id}"]`)[0];
    const tap = async (id: string) => { await act(async () => { click(cell(id).querySelectorAll('BUTTON')[0]); props(cell(id)).onClick?.({}); }); };
    await act(async () => click(launcher()));
    await act(async () => click(dom.document.querySelectorAll('[aria-label="Clean Files"]')[0]));
    expect(acted).toEqual(['clean:files']); expect(sheet()).toBeDefined();
    await tap('app-files'); expect(acted).toEqual(['clean:files', 'files']); expect(sheet()).toBeUndefined();
    await act(async () => click(launcher())); await act(async () => click(sheet().querySelectorAll('BUTTON').find((node) => node.textContent.trim() === 'Agents'))); await tap('agent-b'); expect(acted.at(-1)).toBe('agent-b'); expect(sheet()).toBeUndefined();
    await act(async () => click(launcher()));
    const scrim = sheet().parentNode!.parentNode!;
    await act(async () => props(scrim).onPointerDown({ target: scrim, currentTarget: scrim })); expect(sheet()).toBeUndefined();
    await act(async () => click(launcher()));
    const handle = sheet().childNodes[0];
    Object.assign(handle, { setPointerCapture: () => undefined });
    await act(async () => { props(handle).onPointerDown({ pointerId: 1, clientY: 100, currentTarget: handle }); props(handle).onPointerUp({ pointerId: 1, clientY: 100 + SHEET_DISMISS_DRAG_PX + 1 }); });
    expect(sheet()).toBeUndefined();
    await act(async () => click(launcher())); await act(async () => click(launcher())); expect(sheet()).toBeUndefined();
    dockFixture.open = undefined; dockFixture.clean = undefined;
  });

  it('tapping an agent foregrounds THAT agent\'s chat, even when another app was in front', () => {
    registerWidget({ type: 'chat', title: 'Chat', defaultOpen: true, openBehavior: { singleton: true }, render: ({ instance }) => createElement(Viewer, { id: instance.id }) });
    state().setResponsivePhone(true, true);
    useWorkspaceStore.setState({ session: { projectId: 'p', agentId: 'b', workspaceView: 'default' } });
    const chat = state().openWidget({ agentId: 'b', type: 'chat', title: 'Chat' })!;
    const viewer = state().openWidget({ agentId: 'b', type: 'viewer', title: 'Viewer' })!;
    const keyB = agentRuntimeKey('p', 'b');
    const front = () => { const rt = state().runtimeByAgentId[keyB]; return phoneForegroundId(rt.widgets.openOrder, rt.widgets.byId, state().phoneForegroundByRuntimeKey[keyB]); };
    expect(front()).toBe(viewer);
    useWorkspaceStore.setState({ session: { projectId: 'p', agentId: 'a', workspaceView: 'default' } });
    // The agent dock's tap (`useSecondaryDockItems` → handleAgentSelect): select, then open the default widgets, the chat last.
    state().selectAgent('b');
    for (const def of agentTapOpenOrder()) state().openWidget({ agentId: 'b', type: def.type, title: def.title });
    expect(front()).toBe(chat);
    state().minimizeWidget({ agentId: 'b', widgetInstanceId: chat });
    state().openWidget({ agentId: 'b', type: 'chat', title: 'Chat' });
    expect(front()).toBe(chat);
    expect(state().runtimeByAgentId[keyB].widgets.byId[chat].hidden).toBe(false);
  });

  it('a retained runtime stays mounted only under the active layout\'s rule: list loaded and its agent in it (a per-agent runtime included)', async () => {
    const own = state().openWidget({ agentId: 'a', type: 'viewer', title: 'Mine' })!;
    useWorkspaceStore.setState({ session: { projectId: 'p', agentId: 'b', workspaceView: 'default' } });
    const theirs = state().openWidget({ agentId: 'b', type: 'viewer', title: 'Theirs' })!;
    useWorkspaceStore.setState({ session: { projectId: 'p', agentId: 'a', workspaceView: 'default' }, retainedRuntimeKeys: [agentRuntimeKey('p', 'b')] });
    const agents = (ids: string[]) => ({ byId: Object.fromEntries(ids.map((id) => [id, { id, name: id.toUpperCase(), userId: 'u1' }])), ids, status: 'success' as const, error: null });
    // Paired control: b is authorized — its retained window stays mounted (stashed).
    useWorkspaceStore.setState({ agents: agents(['a', 'b']) });
    root = createRoot(dom.container as unknown as Element);
    await act(async () => root!.render(createElement(StageHost)));
    expect(mounts.mock.calls.map(([id]) => id).sort()).toEqual([own, theirs].sort());
    // b leaves the list: its retained per-agent window unmounts (it stops polling); the active layout stays.
    await act(async () => { useWorkspaceStore.setState({ agents: agents(['a']) }); });
    expect(unmounts.mock.calls.map(([id]) => id)).toEqual([theirs]);
    expect(dom.container.querySelectorAll(`[data-viewer="${own}"]`)).toHaveLength(1);
  });

  it('a second default-open package widget never takes the foreground: first open and an agent tap both show the chat', () => {
    registerWidget({ type: 'chat', title: 'Chat', defaultOpen: true, openBehavior: { singleton: true }, render: ({ instance }) => createElement(Viewer, { id: instance.id }) });
    registerWidget({ type: 'pulse', title: 'Pulse', defaultOpen: true, render: ({ instance }) => createElement(Viewer, { id: instance.id }) });
    expect(listDefaultOpenWidgets().map((d) => d.type)).toEqual(['chat', 'pulse']);
    state().setResponsivePhone(true, true);
    const keyC = agentRuntimeKey('p', 'c');
    const front = () => { const rt = state().runtimeByAgentId[keyC]; return phoneForegroundId(rt.widgets.openOrder, rt.widgets.byId, state().phoneForegroundByRuntimeKey[keyC]); };
    const typeOf = (id: string | null) => (id ? state().runtimeByAgentId[keyC].widgets.byId[id].type : null);
    // First open: the fresh runtime seeds both defaults and nothing was focused yet.
    state().selectAgent('c');
    expect(state().runtimeByAgentId[keyC].widgets.openOrder.map(typeOf)).toEqual(['chat', 'pulse']);
    expect(typeOf(front())).toBe('chat');
    // An agent tap: the chat is opened last, so it is the focused window.
    useWorkspaceStore.setState({ session: { projectId: 'p', agentId: 'a', workspaceView: 'default' } });
    state().selectAgent('c');
    for (const def of agentTapOpenOrder()) state().openWidget({ agentId: 'c', type: def.type, title: def.title });
    expect(typeOf(front())).toBe('chat');
    // Paired control: the registry order (pulse last) would leave the package widget in front.
    for (const def of listDefaultOpenWidgets()) state().openWidget({ agentId: 'c', type: def.type, title: def.title });
    expect(typeOf(front())).toBe('pulse');
  });
});

describe('Phone overlay history: Android Back closes the Docks sheet / Apps', () => {
  let phoneOverlayHistory: typeof import('../AppMenu').phoneOverlayHistory;
  beforeEach(async () => { ({ phoneOverlayHistory } = await import('../AppMenu')); });
  it('one entry survives overlay handoff; Back dismisses it and the next Back navigates genuinely', () => {
    const fixture = historyFixture(); const close = vi.fn(); const owner = phoneOverlayHistory(fixture.browser, close, 'one');
    fixture.browser.history.state.__neuralisPhoneOverlay = 'previous-page'; owner.sync(false); fixture.flush(); expect(fixture.depth()).toBe(2); expect(close).not.toHaveBeenCalled();
    owner.sync(true); owner.sync(true); expect(fixture.depth()).toBe(3); expect(fixture.browser.history.state.next).toBe('workspace');
    fixture.browser.history.back(); fixture.flush(); expect(close).toHaveBeenCalledTimes(1); expect(fixture.depth()).toBe(2); expect(fixture.listeners()).toBe(0);
    fixture.browser.history.back(); fixture.flush(); expect(fixture.browser.history.state.next).toBe('project'); expect(close).toHaveBeenCalledTimes(1);
  });
  it('explicit close/reopen and stage/context disposal consume only their sentinel, with bounded listeners', () => {
    const fixture = historyFixture(); const close = vi.fn(); const owner = phoneOverlayHistory(fixture.browser, close, 'two');
    owner.sync(true); owner.sync(false); owner.sync(true); fixture.flush(); expect(fixture.depth()).toBe(3); expect(fixture.listeners()).toBe(1);
    owner.sync(false); fixture.flush(); expect(fixture.depth()).toBe(2); expect(fixture.listeners()).toBe(0);
    owner.sync(true); owner.dispose(); fixture.flush(); expect(fixture.depth()).toBe(2); expect(fixture.listeners()).toBe(0); expect(close).not.toHaveBeenCalled();
    fixture.browser.history.back(); fixture.flush(); expect(fixture.browser.history.state.next).toBe('project');
  });
});
function historyFixture() {
  const entries: Record<string, unknown>[] = [{ next: 'project' }, { next: 'workspace', tree: { route: 'unchanged' } }]; let index = 1; let pending = false;
  const listeners = new Set<() => void>();
  const browser = {
    history: { get state() { return entries[index]; }, pushState(data: Record<string, unknown>) { entries.splice(index + 1); entries.push(data); index++; }, back() { pending = true; } },
    addEventListener: (_type: 'popstate', listener: () => void) => { listeners.add(listener); }, removeEventListener: (_type: 'popstate', listener: () => void) => { listeners.delete(listener); },
  };
  return { browser, depth: () => index + 1, listeners: () => listeners.size, flush: () => { if (!pending) return; pending = false; index = Math.max(0, index - 1); for (const listener of [...listeners]) listener(); } };
}

function keyboardClick(node: FakeNode): void {
  const key = Object.keys(node).find(k => k.startsWith('__reactProps$'))!;
  const props = node[key] as { onClick: (event: { detail: number }) => void };
  props.onClick({ detail: 0 });
}

describe('Phone: swipe between the open windows, desktop Dim, visible controls', () => {
  it('a swipe needs 64 px and twice its height, steps in tile order, and never wraps', async () => {
    const { phoneSwipeTarget, PHONE_SWIPE_MIN_PX } = await import('../PhoneStage');
    const order = ['a', 'b', 'c'];
    expect(PHONE_SWIPE_MIN_PX).toBe(64);
    expect(phoneSwipeTarget(order, 'b', -64, 0)).toBe('c');
    expect(phoneSwipeTarget(order, 'b', 64, 0)).toBe('a');
    expect(phoneSwipeTarget(order, 'b', -63, 0)).toBeNull();
    expect(phoneSwipeTarget(order, 'b', -100, 51)).toBeNull();
    expect(phoneSwipeTarget(order, 'c', -100, 0)).toBeNull();
    expect(phoneSwipeTarget(order, 'a', 100, 0)).toBeNull();
  });

  it('a horizontal swipe on the stage brings the neighbour forward; an editor, a terminal, a sideways scroller or a selection keeps it', async () => {
    state().setStageMode({ agentId: 'a', mode: 'phone' });
    const first = state().openWidget({ agentId: 'a', type: 'viewer', title: 'First' })!;
    const second = state().openWidget({ agentId: 'a', type: 'viewer', title: 'Second', target: 'new' })!;
    const third = state().openWidget({ agentId: 'a', type: 'viewer', title: 'Third', target: 'new' })!;
    root = createRoot(dom.container as unknown as Element);
    await act(async () => root!.render(createElement(StageHost)));
    const stage = dom.container.querySelectorAll('[data-phone-stage]')[0];
    const listeners = (stage as unknown as { listeners: Record<string, ((event: unknown) => void)[]> }).listeners;
    expect(Object.keys(listeners).sort()).toEqual(['touchcancel', 'touchend', 'touchstart']);
    const swipe = async (target: unknown, dx: number, dy = 0) => act(async () => {
      for (const l of listeners.touchstart) l({ target, touches: [{ clientX: 200, clientY: 300 }] });
      for (const l of listeners.touchend) l({ target, touches: [], changedTouches: [{ clientX: 200 + dx, clientY: 300 + dy }] });
    });
    expect(foreground()).toBe(third);
    await swipe(stage, 100); expect(foreground()).toBe(second);
    await swipe(stage, 100); expect(foreground()).toBe(first);
    await swipe(stage, 100); expect(foreground()).toBe(first);
    await swipe(stage, -100, 40); expect(foreground()).toBe(second);
    const inside = (tag: string, attributes: Record<string, string> = {}) => {
      const node = (dom.document as unknown as { createElement: (name: string) => FakeNode }).createElement(tag); for (const [k, v] of Object.entries(attributes)) node.setAttribute(k, v);
      stage.appendChild(node); return node;
    };
    await swipe(inside('textarea'), -100); expect(foreground()).toBe(second);
    await swipe(inside('div', { contenteditable: 'true' }), -100); expect(foreground()).toBe(second);
    await swipe(inside('div', { class: 'terminal xterm' }), -100); expect(foreground()).toBe(second);
    const scroller = inside('div'); Object.assign(scroller, { scrollWidth: 800, clientWidth: 300 });
    Object.assign(window, { getComputedStyle: () => ({ overflowX: 'auto' }) });
    await swipe(scroller, -100); expect(foreground()).toBe(second);
    Object.assign(window, { getComputedStyle: undefined, getSelection: () => ({ isCollapsed: false }) });
    await swipe(stage, -100); expect(foreground()).toBe(second);
    Object.assign(window, { getSelection: undefined });
    await swipe(stage, -100); expect(foreground()).toBe(third);
  });

  it('Phone wears the desktop Dim surface, and frameless controls show without a hover there and on a touch screen', async () => {
    const { surfaceStyle, DIM_BLUR_CLASS } = await import('../widgetSurface');
    const { PanelChrome } = await import('../PanelChrome');
    state().setStageMode({ agentId: 'a', mode: 'phone' });
    state().openWidget({ agentId: 'a', type: 'viewer', title: 'Only' });
    root = createRoot(dom.container as unknown as Element);
    await act(async () => root!.render(createElement(StageHost)));
    const panel = dom.container.querySelectorAll('[aria-label="Only viewer"]')[0];
    expect(panel.style.backgroundColor).toBe(surfaceStyle('dim').backgroundColor);
    expect(String(panel.getAttribute('class'))).toContain(DIM_BLUR_CLASS);
    await act(async () => root!.render(createElement(PanelChrome, { title: 'Frameless', mode: 'frameless', onClose: () => undefined, children: 'x' })));
    const controls = String(dom.container.querySelectorAll('[data-widget-controls]')[0].getAttribute('class'));
    expect(controls).toContain('group-hover:opacity-100');
    expect(controls).toContain('[@media(hover:none)]:opacity-100');
    expect(controls).toContain('in-data-phone-window:opacity-100');
  });
});


describe('one responsive launcher with a full catalog', () => {
  it('seeds fresh and later-installed pins, independently of desktop hiding, with explicit search and persistent windows', async () => {
    useWorkspaceStore.setState({ liveUserId: 'u1', phoneDockPrefsByScope: {}, projectStateById: { p: { lastAgentId: 'a', dock: { primary: { order: ['pkg:files'], hidden: ['pkg:files'] } } } } });
    state().setStageMode({ agentId: 'a', mode: 'phone' });
    state().openWidget({ agentId: 'a', type: 'viewer', title: 'Window' });
    root = createRoot(dom.container as unknown as Element);
    const shell = () => createElement(WorkspaceShell, { snapshotReady: true, children: 'workspace' });
    await act(async () => root!.render(shell()));
    const launch = () => dom.container.querySelectorAll('[aria-label="Open Apps"]')[0];
    await act(async () => click(launch()));
    const panel = () => dom.document.querySelectorAll('[aria-label="Apps"]')[0];
    expect(panel().querySelectorAll('INPUT')).toHaveLength(0);
    expect(panel().querySelectorAll('[data-phone-dock-item="app-files"]')).toHaveLength(1);
    const desktop = JSON.stringify(state().projectStateById);
    await act(async () => click(panel().querySelectorAll('[aria-label="Actions for Files"]')[0]));
    await act(async () => click(dom.document.querySelectorAll('[aria-label="Unpin Files"]')[0]));
    const phone = Object.values(state().phoneDockPrefsByScope!)[0];
    expect(phone).toEqual({ order: ['pkg:files', 'agent:b'], hidden: ['pkg:files'] });
    expect(JSON.stringify(state().projectStateById)).toBe(desktop);
    dockFixture.later = true;
    await act(async () => root!.render(shell()));
    await act(async () => click(panel().querySelectorAll('[aria-label="Actions for Later app"]')[0]));
    await act(async () => click(dom.document.querySelectorAll('[aria-label="Unpin Later app"]')[0]));
    expect(Object.values(state().phoneDockPrefsByScope!)[0].hidden).toEqual(['pkg:files', 'pkg:later']);
    expect(panel().querySelectorAll('[data-phone-dock-item="app-files"]')).toHaveLength(1);
    await act(async () => click(panel().querySelectorAll('[aria-label="Search"]')[0]));
    expect(panel().querySelectorAll('[aria-label="Search apps"]')).toHaveLength(1);
    const windowStrip = panel().querySelectorAll('[aria-label="Open windows"]')[0];
    await act(async () => click(panel().querySelectorAll('BUTTON').find((node) => node.textContent.trim() === 'Agents')));
    expect(panel().querySelectorAll('[aria-label="Open windows"]')[0]).toBe(windowStrip);
    expect(panel().querySelectorAll('[aria-label="Search agents"]')).toHaveLength(1);
  });

  it('twenty open/close cycles balance the panel key listeners and restore the actual opener', async () => {
    state().setStageMode({ agentId: 'a', mode: 'phone' });
    root = createRoot(dom.container as unknown as Element);
    await act(async () => root!.render(createElement(WorkspaceShell, { snapshotReady: true, children: 'workspace' })));
    const add = vi.spyOn(document, 'addEventListener'); const remove = vi.spyOn(document, 'removeEventListener');
    const launcher = dom.container.querySelectorAll('[aria-label="Open Apps"]')[0];
    Object.defineProperty(launcher, 'isConnected', { value: true, configurable: true });
    const focus = vi.spyOn(launcher, 'focus').mockImplementation(() => { Object.defineProperty(document, 'activeElement', { value: launcher, writable: true, configurable: true }); });
    for (let n = 0; n < 20; n++) {
      launcher.focus(); await act(async () => click(launcher));
      Object.defineProperty(document, 'activeElement', { value: dom.document.querySelectorAll('[aria-label="Apps"]')[0], writable: true, configurable: true });
      await act(async () => click(launcher));
    }
    expect(add.mock.calls.filter(([kind]) => kind === 'keydown')).toHaveLength(20);
    expect(remove.mock.calls.filter(([kind]) => kind === 'keydown')).toHaveLength(20);
    expect(Object.is(document.activeElement, launcher)).toBe(true);
    expect(focus).toHaveBeenCalledTimes(40);
    focus.mockRestore();
    add.mockRestore(); remove.mockRestore();
  });
});


describe('shared launcher current-window projection', () => {
  it.each(['canvas', 'phone'] as const)('%s marks only the authorized live focused window', async (mode) => {
    state().setStageMode({ agentId: 'a', mode });
    const first = state().openWidget({ agentId: 'a', type: 'viewer', title: 'First' })!;
    const second = state().openWidget({ agentId: 'a', type: 'viewer', title: 'Second', target: 'new' })!;
    await act(async () => state().focusWidget({ agentId: 'a', widgetInstanceId: first }));
    root = createRoot(dom.container as unknown as Element);
    await act(async () => root!.render(createElement(WorkspaceShell, { snapshotReady: true, children: 'workspace' })));
    await act(async () => window.dispatchEvent(new Event('neuralis:apps-open')));
    const row = (title: string) => dom.document.querySelectorAll('[aria-label="Open windows"]')[0].querySelectorAll('BUTTON').find((node) => node.textContent.includes(title) && node.getAttribute('aria-pressed') !== null)!;
    expect(row('First').getAttribute('aria-pressed')).toBe('true'); expect(row('Second').getAttribute('aria-pressed')).toBe('false');
    await act(async () => state().focusWidget({ agentId: 'a', widgetInstanceId: second }));
    expect(row('First').getAttribute('aria-pressed')).toBe('false'); expect(row('Second').getAttribute('aria-pressed')).toBe('true');
    await act(async () => state().minimizeWidget({ agentId: 'a', widgetInstanceId: second }));
    expect(row('Second').getAttribute('aria-pressed')).toBe('false');
    await act(async () => state().restoreWidget({ agentId: 'a', widgetInstanceId: second }));
    expect(row('Second').getAttribute('aria-pressed')).toBe('true');
    await act(async () => useWorkspaceStore.setState({ focusOrderByRuntimeKey: { [key]: ['stale'] }, phoneForegroundByRuntimeKey: { [key]: 'stale' } }));
    expect(row('Second').getAttribute('aria-pressed')).toBe(mode === 'phone' ? 'true' : 'false');
  });
});


it('the desktop strip refuses a retained Group window after its bound agent becomes unauthorized', async () => {
  const { groupScopeKey } = await import('../../store/workspaceStore');
  useWorkspaceStore.setState({ liveUserId: 'u', agents: { byId: { a: { id: 'a', name: 'Ann', userId: 'u' } }, ids: ['a'], status: 'success', error: null }, groupStateByScope: { [groupScopeKey('u', 'p')]: { presentation: 'group', selectedGroupId: 'g', groups: [{ id: 'g', name: 'Group', memberIds: ['a'] }] } } });
  state().setStageMode({ agentId: 'a', mode: 'canvas' });
  const id = state().openWidget({ agentId: 'a', type: 'viewer', title: 'Authorized' })!;
  state().focusWidget({ agentId: 'a', widgetInstanceId: id });
  root = createRoot(dom.container as unknown as Element);
  await act(async () => root!.render(createElement(WorkspaceShell, { snapshotReady: true, children: 'workspace' })));
  await act(async () => window.dispatchEvent(new Event('neuralis:apps-open')));
  const strip = () => dom.document.querySelectorAll('[aria-label="Open windows"]')[0];
  expect(strip().querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
  await act(async () => useWorkspaceStore.setState({ agents: { byId: {}, ids: [], status: 'success', error: null } }));
  expect(strip().querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
  expect(strip().textContent).not.toContain('Authorized');
});

describe('real dock editing over responsive changes', () => {
  it('retains each dirty editor through resize, defers eligibility until finish, and dismisses only the launcher', async () => {
    useWorkspaceStore.setState({ liveUserId: 'resize-user', groupStateByScope: {}, phoneDockPrefsByScope: {}, projectStateById: {}, dockEditing: { primary: false, secondary: false, phone: false } });
    state().openWidget({ agentId: 'a', type: 'viewer', title: 'Viewer' });
    state().setStageMode({ agentId: 'a', mode: 'canvas' }); state().clearManualStageMode();
    root = createRoot(dom.container as unknown as Element);
    await act(async () => root!.render(createElement(WorkspaceShell, { snapshotReady: true, children: 'workspace' })));
    await act(async () => state().setDockEditing('primary', true));
    const desktop = dom.container.querySelectorAll('[data-dock-capsule="primary"]')[0];
    const save = desktop.querySelectorAll('[aria-label="Save dock order"]')[0];
    await act(async () => click(desktop.querySelectorAll('[aria-label="Hide Files"]')[0]));
    await act(async () => { window.innerWidth = 390; window.dispatchEvent(new Event('resize')); });
    expect(state().phoneAutoEligible).toBe(true); expect(effectiveStageMode(state(), key)).toBe('canvas');
    expect(desktop.querySelectorAll('[aria-label="Save dock order"]')[0]).toBe(save);
    expect(desktop.querySelectorAll('[aria-label="Hide Files"]')).toHaveLength(0);
    const manual = JSON.stringify(state().manualModeByRuntimeKey);
    await act(async () => { state().setStageMode({ agentId: 'a', mode: 'phone' }); state().clearManualStageMode(); });
    expect(JSON.stringify(state().manualModeByRuntimeKey)).toBe(manual);
    await act(async () => window.dispatchEvent(new Event('neuralis:apps-open')));
    await act(async () => click(dom.document.querySelectorAll('[aria-label="Close Apps"]')[0]));
    expect(state().dockEditing.primary).toBe(true); expect(desktop.querySelectorAll('[aria-label="Save dock order"]')[0]).toBe(save);
    await act(async () => click(save));
    expect(effectiveStageMode(state(), key)).toBe('phone');
    await act(async () => state().setDockEditing('phone', true));
    const phone = dom.container.querySelectorAll('[data-dock-editor="phone"]')[0];
    const phoneSave = dom.document.querySelectorAll('[data-phone-edit-bar]')[0].querySelectorAll('[aria-label="Save dock order"]')[0];
    await act(async () => click(phone.querySelectorAll('[aria-label="Hide Agent B"]')[0]));
    await act(async () => { window.innerWidth = 1024; window.dispatchEvent(new Event('resize')); });
    expect(state().phoneAutoEligible).toBe(false); expect(effectiveStageMode(state(), key)).toBe('phone');
    expect(dom.container.querySelectorAll('[data-dock-editor="phone"]')[0]).toBe(phone);
    expect(phone.querySelectorAll('[aria-label="Hide Agent B"]')).toHaveLength(0);
    await act(async () => click(phoneSave));
    expect(effectiveStageMode(state(), key)).toBe('canvas');
    expect(Object.values(state().phoneDockPrefsByScope!)[0].hidden).toContain('agent:b');
  });

  it('centers Apps between independent producer halves and balances both observer owners over20 mounts', async () => {
    const { PhoneDockBand } = await import('../Dock');
    const resizeCreated = vi.fn(), resizeClosed = vi.fn(), mutationCreated = vi.fn(), mutationClosed = vi.fn();
    vi.stubGlobal('ResizeObserver', class { constructor() { resizeCreated(); } observe() {} disconnect() { resizeClosed(); } });
    vi.stubGlobal('MutationObserver', class { constructor() { mutationCreated(); } observe() {} disconnect() { mutationClosed(); } });
    const frames = new Map<number, FrameRequestCallback>(); let frame = 0;
    const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.set(++frame, callback); return frame; });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id); });
    try {
      for (let cycle = 0; cycle < 20; cycle++) {
        root = createRoot(dom.container as unknown as Element);
        const items = [
          { id: 'user-header', title: 'User', position: 0, section: 'header' as const, phoneSection: 'apps' as const, icon: () => null, onClick: () => undefined, renderCustom: () => createElement('button', { title: 'Fixed User' }) },
          { id: 'project-header', title: 'Project', position: 0, section: 'header' as const, phoneSection: 'agents' as const, icon: () => null, onClick: () => undefined, renderCustom: () => createElement('button', { title: 'Fixed Project' }) },
          ...(cycle % 2 ? [] : [{ id: 'app', title: 'App', position: 1, phoneSection: 'apps' as const, icon: () => null, onClick: () => undefined }, { id: 'agent', title: 'Agent', position: 2, phoneSection: 'agents' as const, icon: () => null, onClick: () => undefined }]),
        ];
        await act(async () => root!.render(createElement(PhoneDockBand, { items, headers: true, launcher: createElement('button', { 'aria-label': 'Center Apps' }) })));
        const band = dom.container.querySelectorAll('[data-phone-launcher-row]')[0];
        expect(band.getAttribute('class')).toContain('grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]');
        expect(band.childNodes.map((node) => node.getAttribute?.('data-phone-center') !== null)).toEqual([false, true, false]);
        expect(dom.container.querySelectorAll('[data-phone-apps]')[0].textContent).not.toContain('Agent');
        const left = band.querySelectorAll('[data-phone-apps]')[0]; const right = band.querySelectorAll('[data-phone-agents]')[0];
        expect(left.childNodes[0].getAttribute?.('data-phone-header')).toBe('apps');
        expect(right.childNodes.at(-1)?.getAttribute?.('data-phone-header')).toBe('agents');
        expect(left.querySelectorAll('[title="Fixed Project"]')).toHaveLength(0);
        expect(right.querySelectorAll('[title="Fixed User"]')).toHaveLength(0);
        expect(dom.container.querySelectorAll('[data-phone-agents]')[0].textContent).not.toContain('App');
        await act(async () => root!.unmount()); root = null;
        expect(frames.size).toBe(0);
      }
      expect(resizeCreated).toHaveBeenCalledTimes(40); expect(resizeClosed).toHaveBeenCalledTimes(40);
      expect(mutationCreated).toHaveBeenCalledTimes(40); expect(mutationClosed).toHaveBeenCalledTimes(40);
    } finally { request.mockRestore(); cancel.mockRestore(); vi.unstubAllGlobals(); }
  });
});


it('the same overflow supports touch, context-key, Escape, pin and New without permanent action rows', async () => {
  useWorkspaceStore.setState({ liveUserId: 'actions-user', groupStateByScope: {}, dockEditing: { primary: false, secondary: false, phone: false } });
  root = createRoot(dom.container as unknown as Element);
  await act(async () => root!.render(createElement(WorkspaceShell, { snapshotReady: true, children: 'workspace' })));
  const open = async () => { await act(async () => window.dispatchEvent(new Event('neuralis:apps-open'))); };
  const props = (node: FakeNode) => node[Object.keys(node).find((key) => key.startsWith('__reactProps$'))!] as Record<string, (event: unknown) => void>;
  await open();
  const cell = dom.document.querySelectorAll('[data-phone-dock-item="app-files"]')[0];
  expect(cell.querySelectorAll('[role="menuitem"]')).toHaveLength(0);
  const trigger = cell.querySelectorAll('[aria-label="Actions for Files"]')[0];
  await act(async () => click(trigger)); // touch/click is always visible
  let menu = dom.document.querySelectorAll('[role="menu"]')[0];
  expect(menu).toBeDefined();
  const focus = vi.spyOn(trigger, 'focus'); const prevented = vi.fn();
  await act(async () => props(menu).onKeyDown({ key: 'Escape', preventDefault: prevented, stopPropagation: () => undefined }));
  expect(prevented).toHaveBeenCalled(); expect(focus).toHaveBeenCalled();
  expect(dom.document.querySelectorAll('[role="menu"]')).toHaveLength(0);
  await act(async () => props(cell).onKeyDown({ key: 'F10', shiftKey: true, currentTarget: cell, preventDefault: () => undefined }));
  menu = dom.document.querySelectorAll('[role="menu"]')[0]; expect(menu).toBeDefined();
  const first = menu.querySelectorAll('BUTTON')[0]; const focusItem = vi.spyOn(first, 'focus');
  // The minimal DOM fixture does not parse :not; keep the browser selector's control set explicit.
  const menuButtons = menu.querySelectorAll('BUTTON');
  const query = vi.spyOn(menu, 'querySelectorAll').mockReturnValue(menuButtons);
  await act(async () => props(menu).onKeyDown({ key: 'Home', currentTarget: menu, preventDefault: () => undefined }));
  expect(focusItem).toHaveBeenCalled(); query.mockRestore();
  await act(async () => click(menu.querySelectorAll('[aria-label="New Files window"]')[0]));
  expect(dockFixture.newWindow).toHaveBeenCalled(); expect(dom.document.querySelectorAll('[aria-label="Apps"]')).toHaveLength(0);
  await open();
  const again = dom.document.querySelectorAll('[data-phone-dock-item="app-files"]')[0];
  await act(async () => props(again).onContextMenu({ currentTarget: again, preventDefault: () => undefined }));
  expect(dom.document.querySelectorAll('[role="menu"]')).toHaveLength(1);
  await act(async () => state().setLiveUserId('other-user'));
  expect(dom.document.querySelectorAll('[role="menu"]')).toHaveLength(0);
  focus.mockRestore(); focusItem.mockRestore();
});
