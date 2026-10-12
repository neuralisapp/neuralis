import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installFakeDom, click } from './fakeDom';
const dom = installFakeDom();
const values = new Map<string, string>();
const writes = vi.fn((key: string, value: string) => values.set(key, value));
Object.assign(window, { localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: writes, removeItem: (key: string) => values.delete(key) } });
vi.stubGlobal('localStorage', window.localStorage);
vi.mock('../useDockItems', () => ({ usePackageDockItems: () => [{ id: 'allowed', packageId: 'pkg', label: 'Allowed', dock: 'primary', icon: 'Package', position: 1, onClick: { kind: 'openWidget', widgetType: 'allowed', widgetTitle: 'Allowed' } }] }));
const { createElement, useContext, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ThemeProvider, ThemeContext, themeScopeStyle } = await import('../../theme/ThemeContext');
const { LIGHT_THEME, GRAPHITE_THEME, FOCUS_THEME, THEMES } = await import('../../theme/themes');
const { PanelChrome } = await import('../PanelChrome');
const { resolveWidgetLevel, DIM_GLASS } = await import('../widgetSurface');
const { useWorkspaceStore } = await import('../../store/workspaceStore');
const { AppMenu } = await import('../AppMenu');
const { LayoutSettingsPanel } = await import('../LayoutSettingsPanel');
const { DockLayoutContext, DEFAULT_DOCK_LAYOUT } = await import('../dockPlacement');
const { DARK_THEME } = await import('../../theme/themes');
const { Dock } = await import('../Dock');
let root: ReturnType<typeof createRoot> | null = null;
let context: import('../../theme/ThemeContext').ThemeContextType;
function Probe() { context = useContext(ThemeContext)!; return null; }
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; values.clear(); writes.mockClear(); });
async function render(element: ReturnType<typeof createElement>) { root = createRoot(dom.container as unknown as Element); await act(async () => root!.render(element)); }

describe('independent appearance and retained instance controls', () => {
  it('changes each appearance scope alone, persists distinct keys; the stored ids stay', async () => {
    await render(createElement(ThemeProvider, null, createElement(Probe)));
    await act(async () => context.setDockThemeId('white'));
    expect([context.theme.id, context.dockTheme.id, context.backgroundTheme.id]).toEqual(['dark', 'white', 'dark']);
    await act(async () => context.setBackgroundThemeId('focus'));
    expect([context.theme.id, context.dockTheme.id, context.backgroundTheme.id]).toEqual(['dark', 'white', 'focus']);
    await act(async () => context.setThemeId('light'));
    expect([context.theme.id, context.dockTheme.id, context.backgroundTheme.id]).toEqual(['light', 'white', 'focus']);
    expect(values.get('neuralis_theme_id')).toBe('light');
    expect(values.get('neuralis_dock_theme_id')).toBe('white');
    expect(values.get('neuralis_background_theme_id')).toBe('focus');
    // Light keeps the stored id `white` (and Graphite the id `light`): labels changed, persisted values did not.
    expect([LIGHT_THEME.id, LIGHT_THEME.name]).toEqual(['white', 'Light']);
    expect([GRAPHITE_THEME.id, GRAPHITE_THEME.name]).toEqual(['light', 'Graphite']);
  });
  it('existing individual cycle stays clickable independently of layout defaults and theme; locks hide it', async () => {
    const cycle = vi.fn();
    await render(createElement(ThemeProvider, null, createElement(Probe), createElement(PanelChrome, { title: 'App', level: 'dim', onCycleTransparency: cycle, children: 'Content' })));
    await act(async () => context.setThemeId('white'));
    const button = dom.container.querySelectorAll('[aria-label="Transparency: Dim"]')[0];
    await act(async () => click(button));
    expect(cycle).toHaveBeenCalledTimes(1);
    const instance = { id: 'w', type: 'allowed', title: 'A', state: {}, createdAt: '2026-10-11T00:00:00Z', transparency: 'dim' as const };
    for (const defaultTransparency of ['opaque', 'dim', 'transparent'] as const) {
      expect(resolveWidgetLevel({ instance, definition: undefined, defaultTransparency }).level).toBe('dim');
    }
    const locked = { type: 'allowed', title: 'A', render: () => createElement('div'), trust: 'untrusted' as const };
    expect(resolveWidgetLevel({ instance, definition: locked, defaultTransparency: 'opaque' }).showCycle).toBe(false);
    expect(resolveWidgetLevel({ instance, definition: { ...locked, trust: 'first-party', chrome: { userTransparency: false } }, defaultTransparency: 'opaque' }).showCycle).toBe(false);
  });
  it('dock editing and cancel write no storage; Save stores once and exits in the same update', async () => {
    useWorkspaceStore.setState({ session: { projectId: 'p', agentId: null, workspaceView: 'default' }, dockEditing: { primary: false, secondary: false } });
    writes.mockClear();
    useWorkspaceStore.getState().setDockEditing('primary', true);
    useWorkspaceStore.getState().setDockEditing('primary', false);
    expect(writes).not.toHaveBeenCalled();
    useWorkspaceStore.getState().setDockEditing('primary', true);
    useWorkspaceStore.getState().setDockPrefs({ dockId: 'primary', prefs: { order: ['pkg:allowed'], hidden: [] } });
    expect(writes).toHaveBeenCalledTimes(1);
    expect(useWorkspaceStore.getState().dockEditing.primary).toBe(false);
  });
  it('placement drag settles once, cancellation/Escape persist nothing, and the keyboard picker reaches every anchor', async () => {
    const place = vi.fn();
    Object.assign(window, { innerWidth: 1000, innerHeight: 800 });
    await render(createElement(Dock, { dockId: 'primary', placement: { dockId: 'primary', anchor: 'top-left', orientation: 'vertical' }, mode: 'labelHoverHidden', onChangeMode: () => undefined, items: [], onPlacement: place }));
    const grip = dom.container.querySelectorAll('[aria-label="Move primary dock"]')[0];
    Object.assign(grip, { setPointerCapture: () => undefined, hasPointerCapture: () => true, releasePointerCapture: () => undefined });
    const propKey = Object.keys(grip).find(key => key.startsWith('__reactProps$'))!;
    const handlers = grip[propKey] as Record<string, (event: Record<string, unknown>) => void>;
    const event = { button: 0, pointerId: 1, clientX: 0, clientY: 0, currentTarget: grip, stopPropagation: () => undefined };
    await act(async () => { handlers.onPointerDown(event); handlers.onPointerMove({ ...event, clientX: 500 }); handlers.onPointerCancel(event); handlers.onPointerUp({ ...event, clientX: 500 }); });
    expect(place).not.toHaveBeenCalled();
    await act(async () => { handlers.onPointerDown(event); handlers.onKeyDown({ ...event, key: 'Escape' }); handlers.onPointerUp({ ...event, clientX: 500 }); });
    expect(place).not.toHaveBeenCalled();
    await act(async () => { handlers.onPointerDown(event); handlers.onPointerUp({ ...event, clientX: 1000, clientY: 800 }); });
    expect(place).toHaveBeenCalledTimes(1);
    // A corner takes the drag's dominant direction (here a diagonal, x wins the tie); a drop says so.
    expect(place.mock.calls[0]).toEqual([{ dockId: 'primary', anchor: 'bottom-right', orientation: 'horizontal' }, 'drag']);
    // An edge midpoint takes its edge's direction; R during the drag flips it (a vertical top-centre dock).
    await act(async () => { handlers.onPointerDown(event); handlers.onPointerMove({ ...event, clientX: 500, clientY: 0 }); handlers.onPointerUp({ ...event, clientX: 500, clientY: 0 }); });
    expect(place.mock.calls.at(-1)?.[0]).toEqual({ dockId: 'primary', anchor: 'top', orientation: 'horizontal' });
    await act(async () => { handlers.onPointerDown(event); handlers.onPointerMove({ ...event, clientX: 500, clientY: 0 }); window.dispatchEvent(Object.assign(new Event('keydown'), { key: 'r' })); handlers.onPointerUp({ ...event, clientX: 500, clientY: 0 }); });
    expect(place.mock.calls.at(-1)?.[0]).toEqual({ dockId: 'primary', anchor: 'top', orientation: 'vertical' });
    // The rotate control beside the grip flips the placed dock in place, through the same save.
    place.mockClear();
    await act(async () => click(dom.container.querySelectorAll('[aria-label="Rotate primary dock to horizontal"]')[0]));
    expect(place.mock.calls[0]).toEqual([{ dockId: 'primary', anchor: 'top-left', orientation: 'horizontal' }]);
    place.mockClear();
    await act(async () => handlers.onClick({ ...event, detail: 0 }));
    await act(async () => click(dom.container.querySelectorAll('[aria-label="Anchor left"]')[0]));
    expect(place.mock.calls[0][0]).toEqual({ dockId: 'primary', anchor: 'left', orientation: 'vertical' });
  });
  it('previews one whole capsule, bounds frames, and clears preview on resize and unmount without saving', async () => {
    const frames = new Map<number, FrameRequestCallback>(); let sequence = 0;
    const request = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++sequence, callback); return sequence; });
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(handle => { frames.delete(handle); });
    const place = vi.fn(); const preview = vi.fn();
    Object.assign(window, { innerWidth: 1000, innerHeight: 800 });
    useWorkspaceStore.setState({ dockEditing: { primary: false, secondary: false } });
    try {
      await render(createElement(Dock, { dockId: 'primary', placement: { dockId: 'primary', anchor: 'top-left', orientation: 'vertical' }, mode: 'iconPinned', onChangeMode: () => undefined, items: [], onPlacement: place, onPreview: preview }));
      const body = dom.container.querySelectorAll('[data-dock-capsule="primary"]')[0];
      Object.assign(body, { setPointerCapture: () => undefined, hasPointerCapture: () => true, releasePointerCapture: () => undefined });
      const handlers = body[Object.keys(body).find(key => key.startsWith('__reactProps$'))!] as Record<string, (event: Record<string, unknown>) => void>;
      const event = { button: 0, pointerId: 1, clientX: 0, clientY: 0, currentTarget: body, target: { closest: () => null } };
      // A touch swipe on the capsule scrolls it; it never starts a dock drag.
      const touch = { ...event, pointerType: 'touch' };
      await act(async () => { handlers.onPointerDown(touch); handlers.onPointerMove({ ...touch, clientX: 120 }); handlers.onPointerUp({ ...touch, clientX: 120 }); });
      expect(frames.size).toBe(0); expect(preview).not.toHaveBeenCalled(); expect(place).not.toHaveBeenCalled();
      await act(async () => { handlers.onPointerDown(event); handlers.onPointerMove({ ...event, clientX: 80 }); handlers.onPointerMove({ ...event, clientX: 120 }); });
      expect(frames.size).toBe(1);
      await act(async () => { const entry = [...frames.entries()][0]; frames.delete(entry[0]); entry[1](0); });
      expect(String(body.style.transform).trim()).toBe('translate(120px, 0px)');
      expect(preview.mock.calls.at(-1)?.[0]).toEqual({ dockId: 'primary', anchor: 'top-left', orientation: 'vertical' });
      // R flips the landing orientation in the next frame.
      await act(async () => { window.dispatchEvent(Object.assign(new Event('keydown'), { key: 'R' })); const entry = [...frames.entries()][0]; frames.delete(entry[0]); entry[1](0); });
      expect(preview.mock.calls.at(-1)?.[0]).toEqual({ dockId: 'primary', anchor: 'top-left', orientation: 'horizontal' });
      await act(async () => window.dispatchEvent(new Event('resize')));
      expect(body.style.transform).toBe(''); expect(preview.mock.calls.at(-1)?.[0]).toBeNull(); expect(place).not.toHaveBeenCalled();
      await act(async () => { handlers.onPointerDown(event); handlers.onPointerMove({ ...event, clientX: 200 }); root!.unmount(); }); root = null;
      expect(frames.size).toBe(0); expect(place).not.toHaveBeenCalled(); expect(preview.mock.calls.at(-1)?.[0]).toBeNull();
    } finally { request.mockRestore(); cancel.mockRestore(); }
  });
  it('Apps shows authorized dock-hidden entries, starts on Apps, and preserves an active edit draft', async () => {
    useWorkspaceStore.setState({ session: { projectId: 'p', agentId: 'a', workspaceView: 'default' }, projectStateById: { p: { lastAgentId: 'a', dock: { primary: { order: [], hidden: ['pkg:allowed'] } } } }, dockEditing: { primary: true, secondary: false } });
    await render(createElement(AppMenu, { onClose: () => undefined }));
    const apps = dom.document.querySelectorAll('[aria-label="Apps"]')[0];
    expect(apps.getAttribute('role')).toBe('dialog');
    expect(apps.textContent).toContain('Allowed');
    expect(apps.textContent).not.toContain('Unauthorized');
    const pin = apps.querySelectorAll('[aria-label="Pin Allowed"]')[0];
    expect(pin.getAttribute('disabled')).not.toBeNull();
    expect(useWorkspaceStore.getState().projectStateById.p.dock?.primary?.hidden).toEqual(['pkg:allowed']);
    expect(apps.querySelectorAll('[aria-pressed="true"]')[0].textContent).toBe('Apps');
  });
});

describe('every theme is dark polarity and the four step apart', () => {
  it('the Universe is visible on every theme it can be switched on for, and never dims the background image', async () => {
    await render(createElement(ThemeProvider, null, createElement(Probe)));
    const root = () => dom.container.querySelectorAll('DIV')[0];
    for (const id of ['dark', 'focus', 'light', 'white']) {
      await act(async () => context.setBackgroundThemeId(id));
      if (context.backgroundTheme.useUniverseBackground === false) await act(async () => context.toggleUniverse());
      expect([id, Number(root().style['--bg-universe-opacity']) >= 0.5]).toEqual([id, true]);
      expect(root().style['--bg-image-opacity']).toBeUndefined();
    }
  });
  it('widget lightness rises Dark < Focus < Graphite < Light, steps apart; white ink, a dark colour scheme and median body text >= 4.5:1 on each widget and Dim glass', async () => {
    const channel = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    const luminance = (c: number[]) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
    const ratio = (a: number[], b: number[]) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    const over = (fg: number[], alpha: number, bg: number[]) => bg.map((v, i) => v + alpha * (fg[i] - v));
    const rgb = (value: string) => value.startsWith('#') ? [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16)) : value.split(',').map(Number);
    const lightness = (c: number[]) => (Math.max(...c) + Math.min(...c)) / 2 / 255;
    const themes = [DARK_THEME, FOCUS_THEME, GRAPHITE_THEME, LIGHT_THEME];
    expect(THEMES).toEqual(themes);
    // Graphite is fixed and white text tops out near L .24, so four dark themes fit only ~4.5-point steps.
    const order = themes.map((theme) => lightness(rgb(theme.colors.widgetBg)));
    for (let i = 1; i < order.length; i++) expect(order[i] - order[i - 1]).toBeGreaterThan(0.04);
    // Light is a neutral grey: no channel leans blue.
    const light = rgb(LIGHT_THEME.colors.widgetBg);
    expect(Math.max(...light) - Math.min(...light)).toBeLessThanOrEqual(6);
    // The median body text: the median alpha of the `text-white/NN` (NN >= 40) uses in the union-sheet sources.
    const { BUILTIN_PACKAGE_IDS, HOST_ROOT, resolveBuiltinRoot } = await import('../../../server/host/builtinSlots');
    const { hostSheetSources, packageSheetSources } = await import('../../../server/packages/packageUiModules');
    const { kernelClientSheetSources } = await import('@neuralis/package-system/runtime/ui-sheet');
    const roots = [...hostSheetSources(HOST_ROOT, process.cwd()), ...kernelClientSheetSources(), ...[...BUILTIN_PACKAGE_IDS].flatMap((id) => packageSheetSources(resolveBuiltinRoot(id), true))]
      .filter((source) => !source.negated).map((source) => source.base);
    expect(roots.length).toBeGreaterThan(3);
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return ['__tests__', 'node_modules'].includes(entry.name) ? [] : walk(path);
      return /\.(ts|tsx|js|mjs)$/.test(entry.name) && !/\.test\.|\.d\.ts$/.test(entry.name) ? [path] : [];
    });
    const alphas: number[] = [];
    for (const file of roots.flatMap(walk)) for (const m of readFileSync(file, 'utf-8').matchAll(/(?<![\w:-])text-white(?:\/(\d+))?(?![\w[/-])/g)) {
      const alpha = m[1] ? Number(m[1]) : 100;
      if (alpha >= 40) alphas.push(alpha);
    }
    alphas.sort((x, y) => x - y);
    const median = alphas[Math.floor(alphas.length / 2)];
    expect(median).toBeGreaterThanOrEqual(40);
    const results: Record<string, number> = {};
    for (const theme of themes) {
      const scope = themeScopeStyle(theme);
      expect([theme.id, scope.colorScheme, theme.colors.widgetText]).toEqual([theme.id, 'dark', 'rgba(255, 255, 255, 0.92)']);
      const widget = rgb(theme.colors.widgetBg);
      const surfaces = [widget, over(widget, DIM_GLASS.alpha, rgb(theme.colors.background))];
      results[theme.id] = Math.min(...surfaces.map((surface) => ratio(over([255, 255, 255], median / 100, surface), surface)));
    }
    for (const [id, contrast] of Object.entries(results)) expect([id, contrast >= 4.5]).toEqual([id, true]);
  }, 60_000);
});

describe('complete material projection through same mounted chrome', () => {
  it('reuses the panel and instance controls through Light and back at every material', async () => {
    await render(createElement(ThemeProvider, null, createElement(Probe), createElement(PanelChrome, { title: 'Surface', level: 'opaque', children: 'draft' })));
    for (const level of ['opaque', 'dim', 'transparent'] as const) {
      await act(async () => root!.render(createElement(ThemeProvider, null, createElement(Probe), createElement(PanelChrome, { title: 'Surface', level, children: 'draft' }))));
      const panel = dom.container.querySelectorAll('[aria-label="Surface"]')[0];
      for (const id of ['white', 'dark', 'white', 'light', 'white', 'focus']) {
        await act(async () => context.setThemeId(id));
        expect(dom.container.querySelectorAll('[aria-label="Surface"]')[0]).toBe(panel);
        expect(panel.style.border).toBe(`1px solid var(--w-${level === 'transparent' ? 'clear' : level}-border)`);
        expect(panel.style.borderColor).toBeUndefined(); expect(panel.textContent).toContain('draft');
      }
    }
  });
});

describe('the Apps/Layout panel surface is fixed', () => {
  it('Dark, fully opaque, no backdrop filter — the same in all 4 themes × 3 materials', async () => {
    const seen = new Set<string>();
    for (const material of ['opaque', 'dim', 'transparent'] as const) {
      await render(createElement(ThemeProvider, null, createElement(Probe),
        createElement(DockLayoutContext.Provider, { value: { ...DEFAULT_DOCK_LAYOUT, defaultWidgetTransparency: material, defaultDockTransparency: material } }, createElement(AppMenu, { onClose: () => undefined }))));
      for (const id of ['dark', 'light', 'focus', 'white']) {
        await act(async () => { context.setThemeId(id); context.setDockThemeId(id); context.setBackgroundThemeId(id); });
        const panel = dom.document.querySelectorAll('[aria-label="Apps"]')[0];
        expect(panel.getAttribute('data-theme-id')).toBe('dark');
        expect(String(panel.getAttribute('class'))).not.toContain('backdrop');
        seen.add(`${panel.style.backgroundColor}|${panel.style['--w-bg-rgb']}|${panel.style.colorScheme}`);
      }
      await act(async () => root!.unmount()); root = null;
    }
    expect([...seen]).toEqual([`rgb(var(--w-bg-rgb))|${DARK_THEME.colors.widgetBg}|dark`]);
  });

  it('each surface row sets its own theme; "Same theme everywhere" copies the Widgets theme, on the same stored keys', async () => {
    await render(createElement(ThemeProvider, null, createElement(Probe), createElement(LayoutSettingsPanel)));
    const button = (label: string) => dom.container.querySelectorAll(`[aria-label="${label}"]`)[0];
    await act(async () => click(button('Widgets: Light')));
    expect([values.get('neuralis_theme_id'), values.get('neuralis_dock_theme_id'), values.get('neuralis_background_theme_id')]).toEqual(['white', undefined, undefined]);
    // "Same theme everywhere" gives the docks and the background the Widgets theme, on the same keys.
    const same = dom.container.querySelectorAll('BUTTON').find((n) => String(n.textContent).includes('Same theme everywhere'))!;
    await act(async () => click(same));
    expect([values.get('neuralis_theme_id'), values.get('neuralis_dock_theme_id'), values.get('neuralis_background_theme_id')]).toEqual(['white', 'white', 'white']);
    await act(async () => click(button('Docks: Focus')));
    expect([values.get('neuralis_theme_id'), values.get('neuralis_dock_theme_id'), values.get('neuralis_background_theme_id')]).toEqual(['white', 'focus', 'white']);
    expect(button('Docks: Focus').getAttribute('aria-pressed')).toBe('true');
    expect(button('Widgets: Light').getAttribute('aria-pressed')).toBe('true');
  });

  it('each surface row carries its own Opaque / Dim / Clear — once, beside its theme samples; Background has one too', async () => {
    await render(createElement(ThemeProvider, null, createElement(Probe), createElement(LayoutSettingsPanel)));
    const material = (surface: string) => dom.container.querySelectorAll(`[aria-label="${surface} material"]`);
    for (const surface of ['Widgets', 'Docks', 'Background']) {
      expect(material(surface)).toHaveLength(1);
      // The material sits in the SAME row as that surface's samples.
      expect(material(surface)[0].parentNode).toBe(dom.container.querySelectorAll(`[aria-label="${surface} theme"]`)[0].parentNode);
    }
    // No separate material rows and no per-surface checkbox any more.
    expect(dom.container.querySelectorAll('[aria-label="Widget material"]')).toHaveLength(0);
    expect(dom.container.querySelectorAll('INPUT').filter((n) => n.getAttribute('type') === 'checkbox' && String(n.parentNode?.textContent).includes('per surface'))).toHaveLength(0);
    await act(async () => click(material('Background')[0].querySelectorAll('BUTTON').find((n) => n.textContent === 'Opaque')!));
    expect(JSON.parse(values.get('neuralis:workspace:dockLayout')!)).toMatchObject({ backgroundTransparency: 'opaque' });
    await act(async () => click(material('Widgets')[0].querySelectorAll('BUTTON').find((n) => n.textContent === 'Clear')!));
    expect(JSON.parse(values.get('neuralis:workspace:dockLayout')!)).toMatchObject({ backgroundTransparency: 'opaque', defaultWidgetTransparency: 'transparent' });
  });

  it('the Phone control is visible without a disclosure, and every Layout section has content', async () => {
    await render(createElement(ThemeProvider, null, createElement(LayoutSettingsPanel)));
    expect(dom.container.querySelectorAll('DETAILS')).toHaveLength(0);
    for (const section of ['Workspace', 'Appearance', 'Docks']) {
      const node = dom.container.querySelectorAll(`[aria-label="${section}"]`)[0];
      expect(node.querySelectorAll('BUTTON').length + node.querySelectorAll('INPUT').length).toBeGreaterThan(0);
    }
    expect(dom.container.querySelectorAll('[aria-label="Stage mode"]')[0].textContent).toContain('Phone');
  });
});
