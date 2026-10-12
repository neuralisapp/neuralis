import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFakeDom, FakeNode } from './fakeDom';
const dom = installFakeDom();
Object.assign(globalThis, { Node: { ELEMENT_NODE: 1, DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2, DOCUMENT_POSITION_DISCONNECTED: 1 }, DOMRect: class { constructor(public x: number, public y: number, public width: number, public height: number) {} get left() { return this.x; } get top() { return this.y; } get right() { return this.x + this.width; } get bottom() { return this.y + this.height; } }, getComputedStyle: () => ({ fontSize: '16px', lineHeight: '16px', display: 'flex' }) });
Object.defineProperties(FakeNode.prototype, {
  children: { get(this: FakeNode) { return this.childNodes.filter(n => n.nodeType === 1); } },
  parentElement: { get(this: FakeNode) { return this.parentNode; } },
  offsetWidth: { get(this: FakeNode) { return this.hasAttribute('data-panel') ? 400 : 12; } },
  clientWidth: { get() { return 800; } },
  clientHeight: { get() { return 600; } },
  offsetHeight: { get() { return 500; } },
  offsetLeft: { get(this: FakeNode) { return (this.parentNode?.childNodes.indexOf(this) ?? 0) * 100; } },
  compareDocumentPosition: { value(this: FakeNode, other: FakeNode) { return (this.parentNode?.childNodes.indexOf(this) ?? 0) < (other.parentNode?.childNodes.indexOf(other) ?? 0) ? 4 : 2; } },
});
vi.mock('../PanelChrome', () => ({ PanelChrome: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('react-rnd', () => ({ Rnd: ({ children }: { children: React.ReactNode }) => children }));
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { TiledStage } = await import('../TiledStage');
const { CanvasStage, canvasSpawn, canvasZoomAt, canvasRevealView } = await import('../CanvasStage');
const { StageOutletProvider } = await import('../stageOutlet');
const { useWorkspaceStore, agentRuntimeKey } = await import('../../store/workspaceStore');
const { registerWidget, syncPackageWidgets } = await import('../../widgets/registry');
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; syncPackageWidgets([]); vi.useRealTimers(); window.localStorage.removeItem('neuralis:workspace:dockLayout'); });
describe('stage geometry and retained panel order', () => {
  it('rebuilds real-library registration for reorder, not add/minimize/restore', async () => {
    const state = () => useWorkspaceStore.getState(); state().reset();
    useWorkspaceStore.setState({ session: { projectId: 'p', agentId: 'a', workspaceView: 'default' } });
    for (const type of ['chat', 'app']) registerWidget({ type, title: type, chrome: type === 'chat' ? { sortKey: -1 } : undefined, render: () => createElement('div') });
    const chat = state().openWidget({ agentId: 'a', type: 'chat', title: 'Chat' })!;
    const first = state().openWidget({ agentId: 'a', type: 'app', title: 'App' })!;
    state().setWidgetSplits({ agentId: 'a', widgetIds: [chat, first], sizes: [38.95, 61.05] });
    // The chat starts on the LEFT here (the first-run default is the right), so the first switch is a reorder.
    window.localStorage.setItem('neuralis:workspace:dockLayout', JSON.stringify({ chatPosition: 'start' }));
    root = createRoot(dom.container as unknown as Element);
    await act(async () => root!.render(createElement(StageOutletProvider, { value: () => {} }, createElement(TiledStage))));
    const group = () => dom.container.querySelectorAll('[data-group]')[0];
    const original = group();
    for (const side of ['end', 'start']) {
      await act(async () => window.dispatchEvent(new CustomEvent('neuralis:layout-changed', { detail: { chatPosition: side } })));
      expect(group()).not.toBe(original);
      expect(dom.container.querySelectorAll('[data-panel]').map(node => node.getAttribute('id'))).toEqual(side === 'end' ? [first, chat] : [chat, first]);
    }
    let stable = group(), added = '';
    for (const count of [3, 4]) {
      await act(async () => { added = state().openWidget({ agentId: 'a', type: 'app', title: String(count), target: 'new' })!; }); expect(group()).toBe(stable);
      for (const side of ['end', 'start']) await act(async () => window.dispatchEvent(new CustomEvent('neuralis:layout-changed', { detail: { chatPosition: side } })));
      expect(dom.container.querySelectorAll('[data-panel]')).toHaveLength(count); stable = group();
    }
    await act(async () => state().minimizeWidget({ agentId: 'a', widgetInstanceId: added })); expect(group()).toBe(stable);
    await act(async () => state().restoreWidget({ agentId: 'a', widgetInstanceId: added })); expect(group()).toBe(stable);
    await act(async () => { for (const id of state().runtimeByAgentId[agentRuntimeKey('p', 'a')].widgets.openOrder) if (id !== chat) state().minimizeWidget({ agentId: 'a', widgetInstanceId: id }); });
    const single = group(); await act(async () => window.dispatchEvent(new CustomEvent('neuralis:layout-changed', { detail: { chatPosition: 'end' } }))); expect(group()).toBe(single);
    const splits = state().runtimeByAgentId[agentRuntimeKey('p', 'a')].layout.widgetSplitsById;
    expect(Object.values(splits!).every(Number.isFinite)).toBe(true);
  });
  it('coalesces normalized wheel input, keeps content zoom native and cancels pending work', async () => {
    vi.useFakeTimers(); const state = () => useWorkspaceStore.getState(); state().reset();
    useWorkspaceStore.setState({ session: { projectId: 'p', agentId: 'a', workspaceView: 'default' } });
    registerWidget({ type: 'canvas-app', title: 'Canvas app', render: () => createElement('div') }); state().openWidget({ agentId: 'a', type: 'canvas-app', title: 'App' });
    const write = vi.spyOn(state(), 'setCanvasView');
    const listener = vi.spyOn(FakeNode.prototype, 'addEventListener');
    root = createRoot(dom.container as unknown as Element);
    await act(async () => root!.render(createElement(StageOutletProvider, { value: () => {} }, createElement(CanvasStage, { grid: false }))));
    const wheel = listener.mock.calls.find(([name]) => name === 'wheel')![1];
    const target = { closest: () => null }, preventDefault = vi.fn();
    const event = { target, preventDefault, ctrlKey: true, metaKey: false, clientX: 100, clientY: 150, deltaY: -1, deltaMode: 0 };
    const transform = () => dom.container.querySelectorAll('div').find(n => typeof n.style.transform === 'string')!.style.transform;
    const before = transform(); wheel({ ...event, ctrlKey: false }); expect(preventDefault).not.toHaveBeenCalled();
    wheel({ ...event, target: { closest: () => ({}) } }); expect(preventDefault).not.toHaveBeenCalled();
    await act(async () => { wheel(event); wheel(event); await vi.advanceTimersByTimeAsync(20); });
    expect(transform()).not.toBe(before); const small = transform();
    await act(async () => { wheel({ ...event, deltaMode: 1 }); await vi.advanceTimersByTimeAsync(20); });
    expect(transform()).not.toBe(small); expect(preventDefault).toHaveBeenCalledTimes(3);
    const zoom = () => Number(String(transform()).match(/scale\(([^)]+)\)/)![1]);
    expect(zoom()).toBeCloseTo(Math.exp(0.002 + 0.016));
    await act(async () => { wheel({ ...event, deltaMode: 2 }); await vi.advanceTimersByTimeAsync(20); });
    expect(zoom()).toBeCloseTo(Math.exp(0.002 + 0.016 + 0.12));
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    write.mockClear();
    const viewport = dom.container.querySelectorAll('div').find(n => n.style.cursor !== undefined)!;
    const captures = new Set<number>(); Object.assign(viewport, { setPointerCapture: (id: number) => captures.add(id), hasPointerCapture: (id: number) => captures.has(id), releasePointerCapture: (id: number) => captures.delete(id) });
    const handlers = () => viewport[Object.keys(viewport).find(key => key.startsWith('__reactProps$'))!] as Record<string, (event: unknown) => void>;
    const pointer = { currentTarget: viewport, target, button: 0, pointerId: 1, clientX: 100, clientY: 150 };
    const start = transform();
    await act(async () => { handlers().onPointerDown({ ...pointer, target: { closest: () => ({}) } }); }); expect(captures.size).toBe(0);
    await act(async () => { handlers().onPointerDown(pointer); handlers().onPointerMove({ ...pointer, clientX: 160 }); });
    expect(transform()).not.toBe(start); await act(async () => { await vi.advanceTimersByTimeAsync(500); }); expect(write).not.toHaveBeenCalled();
    await act(async () => { window.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' })); await vi.advanceTimersByTimeAsync(500); });
    expect(transform()).toBe(start); expect(captures.size).toBe(0); expect(write).not.toHaveBeenCalled();
    await act(async () => handlers().onPointerDown(pointer));
    await act(async () => handlers().onPointerDown({ ...pointer, pointerId: 2, clientX: 200 }));
    await act(async () => handlers().onPointerMove({ ...pointer, pointerId: 2, clientX: 300 })); expect(zoom()).toBe(2);
    await act(async () => handlers().onPointerCancel(pointer)); expect(transform()).toBe(start); expect(captures.size).toBe(0);
    await act(async () => { handlers().onPointerDown(pointer); handlers().onPointerMove({ ...pointer, clientY: 200 }); });
    await act(async () => { handlers().onPointerUp(pointer); }); await act(async () => { await vi.advanceTimersByTimeAsync(401); }); expect(write).toHaveBeenCalledTimes(1);
    await act(async () => handlers().onPointerDown(pointer));
    wheel({ ...event, deltaMode: 2 }); await act(async () => root!.unmount()); root = undefined;
    await vi.advanceTimersByTimeAsync(1000); expect(vi.getTimerCount()).toBe(0); expect(captures.size).toBe(0);
  });
  it('reveals restored Canvas geometry once and fences cancelled/runtime requests', async () => {
    vi.useFakeTimers(); const state = () => useWorkspaceStore.getState(); state().reset();
    useWorkspaceStore.setState({ session: { projectId: 'p', agentId: 'a', workspaceView: 'default' } });
    registerWidget({ type: 'restore-app', title: 'Restore app', render: () => createElement('div') });
    const id = state().openWidget({ agentId: 'a', type: 'restore-app', title: 'App' })!;
    state().setStageMode({ agentId: 'a', mode: 'canvas' });
    const geometry = { x: 88, y: 32, w: 640, h: 520, z: 1 };
    state().setWidgetGeometry({ agentId: 'a', widgetInstanceId: id, slot: 'canvas', geometry });
    state().setCanvasView({ agentId: 'a', view: { x: -2000, y: 0, zoom: 1 } });
    state().minimizeWidget({ agentId: 'a', widgetInstanceId: id });
    root = createRoot(dom.container as unknown as Element);
    await act(async () => root!.render(createElement(StageOutletProvider, { value: () => {} }, createElement(CanvasStage, { grid: false }))));
    const write = vi.spyOn(state(), 'setCanvasView'); write.mockClear();
    await act(async () => state().restoreWidget({ agentId: 'a', widgetInstanceId: id }));
    expect(state().canvasReveal).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(401); });
    expect(write).toHaveBeenCalledTimes(1);
    const rt = () => state().runtimeByAgentId[agentRuntimeKey('p', 'a')];
    expect(rt().layout.freeformById![id]).toEqual(geometry);
    expect(rt().layout.canvasView).toEqual({ x: -88, y: 0, zoom: 1 });
    write.mockClear();
    await act(async () => { state().minimizeWidget({ agentId: 'a', widgetInstanceId: id }); state().restoreWidget({ agentId: 'a', widgetInstanceId: id }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(401); }); expect(write).not.toHaveBeenCalled();
    await act(async () => root!.unmount()); root = undefined;
    state().focusWidget({ agentId: 'a', widgetInstanceId: id }); const pending = state().canvasReveal!;
    state().minimizeWidget({ agentId: 'a', widgetInstanceId: id }); expect(state().canvasReveal).toBeNull();
    state().restoreWidget({ agentId: 'a', widgetInstanceId: id }); state().clearCanvasReveal(pending);
    expect(state().canvasReveal).not.toBeNull(); // stale cleanup cannot clear a newer intent
    state().selectAgent('b'); expect(state().canvasReveal).toBeNull();
    state().selectAgent('a'); state().focusWidget({ agentId: 'a', widgetInstanceId: id });
    state().setStageMode({ agentId: 'a', mode: 'phone' }); expect(state().canvasReveal).toBeNull();
    state().setStageMode({ agentId: 'a', mode: 'canvas' }); state().focusWidget({ agentId: 'a', widgetInstanceId: id });
    state().reset(); expect(state().canvasReveal).toBeNull();
  });
  it('reveals oversized grips without zooming and keeps already-visible view identity', () => {
    const view = { x: 0, y: 0, zoom: 1 }, geometry = { x: 88, y: 32, w: 640, h: 520, z: 1 };
    expect(canvasRevealView(view, geometry, 800, 600)).toBe(view);
    const huge = { ...geometry, x: 3000, y: -3000, w: 1600, h: 1200 };
    const next = canvasRevealView(view, huge, 390, 600);
    expect(huge.x + huge.w / 2 + next.x).toBeGreaterThanOrEqual(24);
    expect(huge.x + huge.w / 2 + next.x).toBeLessThanOrEqual(366);
    expect(huge.y + next.y).toBeGreaterThanOrEqual(0); expect(next.zoom).toBe(1);
  });
  it('keeps pointer world coordinates fixed and existing zoom bounds', () => {
    const view = { x: -500, y: 200, zoom: 0.8 }, x = 340, y = 220;
    for (const factor of [1.002, 1.1, 100, 0.001]) {
      const next = canvasZoomAt(view, factor, x, y);
      expect((x - next.x) / next.zoom).toBeCloseTo((x - view.x) / view.zoom);
      expect((y - next.y) / next.zoom).toBeCloseTo((y - view.y) / view.zoom);
      expect(next.zoom).toBeGreaterThanOrEqual(0.4); expect(next.zoom).toBeLessThanOrEqual(2);
    }
  });
  it('spawns six distinct reachable grips in shifted/zoomed world space without mutating occupants', () => {
    for (const zoom of [0.4, 1, 2]) {
      const view = { x: -1200, y: 730, zoom };
      const occupied = [{ x: 2000, y: 9000, w: 400, h: 400, z: 1 }]; const before = JSON.stringify(occupied);
      const positions = new Set<string>();
      for (let i = 0; i < 6; i++) {
        const g = canvasSpawn(view, 390, 600, occupied, i + 2);
        const gripX = view.x + (g.x + g.w / 2) * zoom, gripY = view.y + g.y * zoom;
        expect(gripX).toBeGreaterThanOrEqual(0); expect(gripX).toBeLessThanOrEqual(390);
        expect(gripY).toBeGreaterThanOrEqual(0); expect(gripY).toBeLessThanOrEqual(600);
        positions.add(`${g.x}:${g.y}`); occupied.push(g);
      }
      expect(positions.size).toBe(6); expect(JSON.stringify(occupied.slice(0, 1))).toBe(before);
    }
  });
});
