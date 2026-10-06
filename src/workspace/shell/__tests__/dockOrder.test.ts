/**
 * The dock arrangement (`dockOrder.ts`), the edit-mode editor and the Layout
 * panel's dock controls:
 *  - reordering never crosses a group (trust tier / own vs other agents), so a
 *    separator keeps its place; fixed items never move and can never hide;
 *  - a live item the stored order does not name goes to the end of its group,
 *    and a stored key with no live item never renders;
 *  - the editor's drag/keyboard/hide handlers touch only local state — the
 *    one store write is Save;
 *  - the side cells of the position grid select the shipped default (`start`).
 */

import { describe, it, expect } from 'vitest';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentDockKey,
  applyDockPrefs,
  draftFromItems,
  dropPlacement,
  extendDraft,
  moveDockKey,
  normalizeDockPrefs,
  packageDockKey,
  setDockKeyHidden,
  stepDockKey,
  type ArrangeableItem,
} from '../dockOrder';
import { DockEditor, type DockItem } from '../Dock';
import { PositionGrid } from '../LayoutSettingsPanel';

const Glyph: ComponentType<{ className?: string }> = () => null;

/** The primary dock as `usePrimaryDockItems` builds it: header, two trust groups with a separator, Layout. */
function primaryItems(): DockItem[] {
  const pkg = (id: string, position: number, group: string): DockItem => ({
    id,
    position,
    title: id,
    icon: Glyph,
    onClick: () => undefined,
    prefKey: packageDockKey('@neuralis/x', id),
    group,
    badgeKey: packageDockKey('@neuralis/x', id),
  });
  return [
    { id: '__user-info', position: 0, title: 'User', icon: Glyph, section: 'header', onClick: () => undefined },
    pkg('calendar', 100, 'trust:first-party'),
    pkg('files', 101, 'trust:first-party'),
    pkg('admin', 102, 'trust:first-party'),
    { id: '__sep-trust-trusted', position: 1099, title: '', icon: Glyph, kind: 'separator', onClick: () => undefined },
    pkg('shop', 1100, 'trust:trusted'),
    pkg('crm', 1101, 'trust:trusted'),
    { id: '__sep-layout', position: 9998, title: '', icon: Glyph, kind: 'separator', onClick: () => undefined },
    { id: '__layout-settings', position: 9999, title: 'Layout', icon: Glyph, onClick: () => undefined },
  ];
}

const ids = (items: readonly ArrangeableItem[]): string[] => items.filter((i) => !i.hidden).map((i) => i.id);
const key = (id: string): string => packageDockKey('@neuralis/x', id);

describe('applyDockPrefs', () => {
  it('without prefs: the default order', () => {
    expect(ids(applyDockPrefs(primaryItems(), undefined))).toEqual([
      '__user-info', 'calendar', 'files', 'admin', '__sep-trust-trusted', 'shop', 'crm', '__sep-layout', '__layout-settings',
    ]);
  });

  it('reorders INSIDE each group; separators and fixed items keep their place', () => {
    const out = applyDockPrefs(primaryItems(), { order: [key('crm'), key('admin'), key('shop'), key('calendar'), key('files')], hidden: [] });
    expect(ids(out)).toEqual([
      '__user-info', 'admin', 'calendar', 'files', '__sep-trust-trusted', 'crm', 'shop', '__sep-layout', '__layout-settings',
    ]);
    // The group keeps its own position slots — the separator still sits between the tiers.
    expect(out.find((i) => i.id === 'admin')?.position).toBe(100);
    expect(out.find((i) => i.id === 'crm')?.position).toBe(1100);
  });

  it('a live item the order does not name goes to the END of its group', () => {
    const out = applyDockPrefs(primaryItems(), { order: [key('admin'), key('calendar')], hidden: [] });
    expect(ids(out).slice(1, 4)).toEqual(['admin', 'calendar', 'files']);
  });

  it('hidden = stored set ∩ live items; a stored key with no live item never renders', () => {
    const out = applyDockPrefs(primaryItems(), { order: [], hidden: [key('files'), key('gone'), 'agent:ghost'] });
    expect(out.filter((i) => i.hidden).map((i) => i.id)).toEqual(['files']);
    expect(out.some((i) => i.id === 'gone' || i.id === 'ghost')).toBe(false);
  });

  it('a FIXED item (no prefKey) can never be hidden, whatever is stored', () => {
    const out = applyDockPrefs(primaryItems(), { order: ['__layout-settings'], hidden: ['__layout-settings', '__user-info'] });
    expect(out.filter((i) => i.hidden)).toEqual([]);
    expect(ids(out)).toContain('__layout-settings');
  });

  it('malformed stored prefs read as the default', () => {
    expect(normalizeDockPrefs({ order: 'x', hidden: [1, null] })).toEqual({ order: [], hidden: [] });
    expect(ids(applyDockPrefs(primaryItems(), { order: 'nope', hidden: 5 } as unknown as never))).toEqual(
      ids(applyDockPrefs(primaryItems(), undefined)),
    );
  });

  it('agent keys: own and other agents are separate groups', () => {
    const agents: ArrangeableItem[] = [
      { id: 'a', position: 10, prefKey: agentDockKey('a'), group: 'agents:own' },
      { id: 'b', position: 20, prefKey: agentDockKey('b'), group: 'agents:own' },
      { id: '__sep-owner', position: 25 },
      { id: 'c', position: 60, prefKey: agentDockKey('c'), group: 'agents:other' },
    ];
    // `c` first in the order, but it cannot leave its group.
    expect(ids(applyDockPrefs(agents, { order: ['agent:c', 'agent:b', 'agent:a'], hidden: [] }))).toEqual(['b', 'a', '__sep-owner', 'c']);
  });
});

describe('the draft operations', () => {
  it('a move never crosses a group — the SAME draft comes back', () => {
    const items = primaryItems();
    const draft = draftFromItems(items);
    expect(moveDockKey(draft, items, key('shop'), key('calendar'), 'before')).toBe(draft);
    expect(moveDockKey(draft, items, key('files'), key('files'), 'after')).toBe(draft);
    // A no-op move (already there) is the same object too — a drag-over re-renders nothing.
    expect(moveDockKey(draft, items, key('calendar'), key('files'), 'before')).toBe(draft);
  });

  it('a move inside a group, and the arrow-key step skips hidden siblings', () => {
    const items = primaryItems();
    let draft = draftFromItems(items);
    draft = moveDockKey(draft, items, key('admin'), key('calendar'), 'before');
    expect(ids(applyDockPrefs(items, draft)).slice(1, 4)).toEqual(['admin', 'calendar', 'files']);
    draft = setDockKeyHidden(draft, key('calendar'), true);
    draft = stepDockKey(draft, items, key('files'), -1);
    expect(ids(applyDockPrefs(items, draft)).slice(1, 3)).toEqual(['files', 'admin']);
    // The first visible item cannot step earlier.
    expect(stepDockKey(draft, items, key('files'), -1)).toBe(draft);
  });

  it('an item that appears while editing joins the draft at the end', () => {
    const items = primaryItems();
    const draft = draftFromItems(items.filter((i) => i.id !== 'crm'));
    const extended = extendDraft(draft, items);
    expect(extended.order.at(-1)).toBe(key('crm'));
    expect(extendDraft(extended, items)).toBe(extended);
  });

  it('the drop side follows the dock axis', () => {
    const rect = { top: 100, left: 10, width: 48, height: 40 };
    expect(dropPlacement(rect, { x: 50, y: 110 }, false)).toBe('before');
    expect(dropPlacement(rect, { x: 12, y: 130 }, false)).toBe('after');
    expect(dropPlacement(rect, { x: 12, y: 130 }, true)).toBe('before');
    expect(dropPlacement(rect, { x: 50, y: 110 }, true)).toBe('after');
  });
});

describe('the editor', () => {
  const render = (items: DockItem[], hasLabels = true): string =>
    renderToStaticMarkup(
      createElement(DockEditor, {
        dockId: 'primary',
        items,
        horizontal: false,
        hasLabels,
        pinned: true,
        cornerReverse: false,
        align: 'start',
        modeSwitch: null,
      }),
    );

  it('movable items get a handle, earlier/later and a trash; fixed items get none; Save + Cancel', () => {
    const html = render(primaryItems());
    for (const id of ['calendar', 'files', 'admin', 'shop', 'crm']) {
      expect(html).toContain(`aria-label="Move ${id}"`);
      expect(html).toContain(`aria-label="Hide ${id}"`);
      expect(html).toContain(`aria-label="Move ${id} earlier"`);
    }
    expect(html).not.toContain('aria-label="Hide Layout"');
    expect(html).not.toContain('aria-label="Move User"');
    expect(html).toContain('aria-label="Save dock order"');
    expect(html).toContain('aria-label="Cancel dock editing"');
    // The trust separator is still drawn while editing.
    expect(html.match(/h-px w-8 bg-white\/10/g)?.length).toBe(2);
  });

  it('a hidden item leaves the dock and is counted on the "+ hidden" tile', () => {
    const items = applyDockPrefs(primaryItems(), { order: [], hidden: [key('files')] });
    const html = render(items);
    expect(html).not.toContain('aria-label="Move files"');
    expect(html).toContain('1 hidden');
  });

  it('the item under edit is inert — a click never opens it while editing', () => {
    expect(render(primaryItems())).toMatch(/<div inert=""/);
  });
});

/** Comment-stripped source of `Dock.tsx` — what the editor's handlers may touch. */
function dockSource(): string {
  return readFileSync(join(__dirname, '..', 'Dock.tsx'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('edit mode writes nothing until Save (source scan)', () => {
  it('the drag/keyboard/hide handlers never reach the store or localStorage', () => {
    const src = dockSource();
    const start = src.indexOf('const startDrag =');
    const end = src.indexOf('const shown =');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const handlers = src.slice(start, end);
    expect(handlers).not.toMatch(/useWorkspaceStore|localStorage|setDockPrefs/);
    expect(handlers).toMatch(/setDraft/);
  });

  it('the editor reaches the store in exactly two places: Save (setDockPrefs) and leaving edit mode', () => {
    const src = dockSource();
    const editor = src.slice(src.indexOf('export function DockEditor('), src.indexOf('function EditableDockItem('));
    expect(editor.match(/useWorkspaceStore\.getState\(\)/g)?.length).toBe(2);
    expect(editor.match(/setDockPrefs\(/g)?.length).toBe(1);
  });
});

describe('Layout → the side cells select the shipped default', () => {
  const grid = (value: { edge: 'left' | 'right' | 'top' | 'bottom'; align: 'start' | 'center' | 'end' }): string =>
    renderToStaticMarkup(createElement(PositionGrid, { value, onChange: () => undefined, label: 'Primary', color: '#60a5fa' }));

  it('left/start (the default) shows the left cell active, and the cell carries start', () => {
    const html = grid({ edge: 'left', align: 'start' });
    expect(html).toContain('title="left / start"');
    expect(html).not.toContain('title="left / center"');
    expect(html).toMatch(/background-color:#60a5fa[^>]*title="left \/ start"/);
  });

  it('a stored left/center still lights the same cell', () => {
    expect(grid({ edge: 'left', align: 'center' })).toMatch(/background-color:#60a5fa[^>]*title="left \/ start"/);
  });
});

describe('badge key parity', () => {
  it('the client dock key is the server dockKey for the same manifest id + dock id', async () => {
    const { packageDockKey } = await import('../dockOrder');
    const { dockKey } = await import('../../../server/notifications/notificationStore');
    for (const [pkg, dock] of [['@neuralis/agent-core', 'agent-core.calendar'], ['@neuralis/brain-core', 'brain-core.filesystem']] as const) {
      expect(packageDockKey(pkg, dock)).toBe(dockKey(pkg, dock));
    }
  });
});
