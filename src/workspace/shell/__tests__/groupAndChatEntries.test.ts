/**
 * The entry points a Group and a second chat need (mounted, fake DOM, real store):
 *  - the selected agent's tile asks which of its chat windows, or a NEW one —
 *    the app chooser's language; another agent's tile still selects it, however
 *    many chat windows it has; on Phone the first tap brings the chat forward;
 *  - the Group is editable from the Layout view (always, even with one Group)
 *    and from the project menu, both through the agent dock's edit draft;
 *  - an empty Group shows ONE empty-stage hint, and its name never widens the
 *    project trigger (it rides a borrowed-width second line).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { click, installFakeDom, type FakeNode } from './fakeDom';

const dom = installFakeDom();
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: { user: { id: 'u1', name: 'Ada' } }, status: 'authenticated' }) }));
vi.mock('../UserAvatar', async (original) => ({ ...(await original<typeof import('../UserAvatar')>()), UserAvatar: () => null }));
vi.mock('../../realtime/eventHub', () => ({ subscribeHub: () => () => undefined, getHubConnected: () => true }));
Object.assign(window, { innerWidth: 1280, innerHeight: 800 });

const { createElement, act, Fragment } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useWorkspaceStore, agentRuntimeKey, groupScopeKey, runtimeKeyOf } = await import('../../store/workspaceStore');
const { registerWidget, syncPackageWidgets } = await import('../../widgets/registry');
const { useSecondaryDockItems } = await import('../useDockItems');
const { LayoutSettingsPanel } = await import('../LayoutSettingsPanel');
const { ProjectSwitcher } = await import('../ProjectSwitcher');
const { StageOutletProvider } = await import('../stageOutlet');
const { TiledStage } = await import('../TiledStage');
const { ThemeProvider } = await import('../../theme/ThemeContext');

let root: ReturnType<typeof createRoot> | null = null;
const s = () => useWorkspaceStore.getState();
async function render(element: ReturnType<typeof createElement>): Promise<void> {
  root = createRoot(dom.container as unknown as Element);
  await act(async () => { root!.render(element); });
}
const byLabel = (label: string): FakeNode[] => dom.document.querySelectorAll(`[aria-label="${label}"]`);
const agents = { byId: { a1: { id: 'a1', name: 'Ann', userId: 'u1' }, a2: { id: 'a2', name: 'Bo', userId: 'u1' } }, ids: ['a1', 'a2'], status: 'success' as const, error: null };

function AgentDock() {
  const items = useSecondaryDockItems('left', false, true, false);
  return createElement(Fragment, null, ...items.filter((i) => i.renderCustom && i.prefKey).map((i) => createElement('div', { key: i.id, 'data-agent-tile': i.id }, i.renderCustom!())));
}

beforeEach(() => {
  syncPackageWidgets([]);
  registerWidget({ type: 'chat', title: 'Chat', defaultOpen: true, render: () => createElement('div') });
  s().reset();
  useWorkspaceStore.setState({
    liveUserId: 'u1',
    session: { projectId: 'p1', agentId: 'a1', workspaceView: 'default' },
    agents,
    dockEditing: { primary: false, secondary: false },
    projects: { byId: { p1: { id: 'p1', name: 'main', members: {} } as never }, ids: ['p1'], status: 'success', error: null },
    groupStateByScope: {},
  });
  s().selectAgent('a1');
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; });

describe('a second chat window of the same agent', () => {
  it('the selected agent asks which chat window or a new one; New window opens a SECOND chat bound to it', async () => {
    const chats = () => { const rt = s().runtimeByAgentId[agentRuntimeKey('p1', 'a1')]; return rt.widgets.openOrder.filter((id) => rt.widgets.byId[id].type === 'chat'); };
    expect(chats()).toHaveLength(1);
    await render(createElement(AgentDock));
    const tile = dom.container.querySelectorAll('[data-agent-tile="a1"]')[0].querySelectorAll('[data-dock-tile-act]')[0];
    expect(tile.getAttribute('aria-haspopup')).toBe('dialog');
    await act(async () => { click(tile); });
    const chooser = byLabel('Ann · Chat windows')[0];
    expect(chooser).toBeDefined();
    expect(chooser.querySelectorAll('[data-window-choice]')).toHaveLength(1);
    const newWindow = chooser.querySelectorAll('BUTTON').find((n) => String(n.textContent).includes('New window'))!;
    await act(async () => { click(newWindow); });
    expect(chats()).toHaveLength(2);
    // Another agent's tile is not a chooser: a click selects that agent.
    const other = dom.container.querySelectorAll('[data-agent-tile="a2"]')[0].querySelectorAll('[data-dock-tile-act]')[0];
    expect(other.getAttribute('aria-haspopup')).toBeNull();
    await act(async () => { click(other); });
    expect(s().session.agentId).toBe('a2');
  });

  it('only the ACTIVE agent tile asks — an unselected agent with several chat windows is still selected by a click', async () => {
    const { opensWindowChooser } = await import('../Dock');
    const two = [{ id: 'w1' }, { id: 'w2' }] as never;
    expect(opensWindowChooser({ windows: two, chooserWhenActive: true, active: false })).toBe(false);
    expect(opensWindowChooser({ windows: two, chooserWhenActive: true, active: true })).toBe(true);
    // An app item (no agent rule) still asks from two windows on.
    expect(opensWindowChooser({ windows: two })).toBe(true);
  });

  it('on Phone the selected agent\'s tap first brings its chat to the front; with the chat in front it asks', async () => {
    registerWidget({ type: 'notes', title: 'Notes', render: () => createElement('div') });
    s().setStageMode({ agentId: 'a1', mode: 'phone' });
    s().openWidget({ agentId: 'a1', type: 'notes', title: 'Notes' });
    const key = agentRuntimeKey('p1', 'a1');
    const rt = () => s().runtimeByAgentId[key];
    const notes = rt().widgets.openOrder.find((id) => rt().widgets.byId[id].type === 'notes')!;
    s().focusWidget({ agentId: 'a1', widgetInstanceId: notes });
    expect(s().phoneForegroundByRuntimeKey[key]).toBe(notes);
    await render(createElement(AgentDock));
    const tile = () => dom.container.querySelectorAll('[data-agent-tile="a1"]')[0].querySelectorAll('[data-dock-tile-act]')[0];
    expect(tile().getAttribute('aria-haspopup')).toBeNull();
    await act(async () => { click(tile()); });
    const chat = rt().widgets.openOrder.find((id) => rt().widgets.byId[id].type === 'chat')!;
    expect(s().phoneForegroundByRuntimeKey[key]).toBe(chat);
    expect(byLabel('Ann · Chat windows')).toHaveLength(0);
    expect(tile().getAttribute('aria-haspopup')).toBe('dialog');
  });
});

describe('dock popovers stay clear of the dock and close on Escape', () => {
  it('the Group panel of a top-row horizontal dock opens BELOW it (never over the trailing Save/Cancel); a vertical dock keeps it beside', async () => {
    const { groupPanelPosition } = await import('../Dock');
    const top = groupPanelPosition({ left: 400, right: 900, top: 8, bottom: 56 }, true);
    expect(top.top).toBe(64);
    const bottom = groupPanelPosition({ left: 400, right: 900, top: 744, bottom: 792 }, true);
    expect(bottom.top).toBeUndefined();
    expect(bottom.bottom).toBe(800 - 744 + 8);
    const side = groupPanelPosition({ left: 8, right: 64, top: 100, bottom: 600 }, false);
    expect(side.left).toBe(72);
  });

  it('Escape closes the agent chooser wherever focus is', async () => {
    await render(createElement(AgentDock));
    const tile = dom.container.querySelectorAll('[data-agent-tile="a1"]')[0].querySelectorAll('[data-dock-tile-act]')[0];
    await act(async () => { click(tile); });
    expect(byLabel('Ann · Chat windows')).toHaveLength(1);
    await act(async () => { window.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' })); });
    expect(byLabel('Ann · Chat windows')).toHaveLength(0);
  });
});

describe('Group entries', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ groupStateByScope: { [groupScopeKey('u1', 'p1')]: { presentation: 'group', selectedGroupId: 'g1', groups: [{ id: 'g1', name: 'Main', memberIds: ['a1'] }] } } });
  });

  it('the Layout view shows the Group row with ONE Group and an Edit that opens the agent dock draft; so does the project menu', async () => {
    await render(createElement(ThemeProvider, null, createElement(LayoutSettingsPanel)));
    const edit = dom.container.querySelectorAll('BUTTON').find((n) => n.textContent === 'Edit')!;
    expect(edit).toBeDefined();
    await act(async () => { click(edit); });
    expect(s().dockEditing).toEqual({ primary: false, secondary: true });
    await act(async () => root!.unmount()); root = null;

    useWorkspaceStore.setState({ dockEditing: { primary: false, secondary: false } });
    await render(createElement(ProjectSwitcher, { expanded: true }));
    await act(async () => { click(byLabel('main · Main')[0]); });
    const menuEdit = dom.document.querySelectorAll('BUTTON').find((n) => String(n.textContent).includes('Edit groups'))!;
    await act(async () => { click(menuEdit); });
    expect(s().dockEditing.secondary).toBe(true);
  });

  it('the Group name rides a borrowed-width second line, so the trigger keeps its per-agent box', async () => {
    await render(createElement(ProjectSwitcher, { expanded: true }));
    const trigger = byLabel('main · Main')[0];
    const groupLine = trigger.querySelectorAll('SPAN').find((n) => n.textContent === 'Main')!;
    expect(groupLine.getAttribute('class')).toContain('w-0');
    expect(groupLine.getAttribute('class')).toContain('min-w-full');
  });

  it('an empty Group shows ONE empty-stage hint — the stage\'s own, worded for a Group', async () => {
    const key = runtimeKeyOf({ kind: 'group', userId: 'u1', projectId: 'p1', groupId: 'g1' });
    useWorkspaceStore.setState({ runtimeByAgentId: { ...s().runtimeByAgentId, [key]: { widgets: { openOrder: [], byId: {} }, layout: { widgetSplitsById: {} } } } });
    await render(createElement(StageOutletProvider, { value: () => undefined }, createElement(TiledStage)));
    expect(dom.container.textContent).toContain('this Group’s windows share one layout');
    expect(dom.container.textContent).not.toContain('Open a widget from the dock');
  });
});
