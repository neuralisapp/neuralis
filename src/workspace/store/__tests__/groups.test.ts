/**
 * Group view and repeated windows: the per-agent layouts stay as they were,
 * a Group is ONE shared layout under the LIVE user, every window carries the
 * agent it is bound to, and the open targets pick the window.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement } from 'react';
import type { ClientStateResetScope, WorkspaceAgentRecord } from '@neuralis/package-system/contracts';

vi.mock('@/api/agents', () => ({ listAgents: vi.fn(async () => []) }));
vi.mock('@/api/projects', () => ({ listProjects: vi.fn(async () => []) }));

import {
  useWorkspaceStore, agentRuntimeKey, runtimeKeyOf, activeRuntimeKeyOf, groupScopeKey, newWindowAgentOf,
  parsePersistedWorkspace, authorizedWindowOrder, DEFAULT_GROUP_NAME,
} from '../workspaceStore';
import { registerWidget, syncPackageWidgets } from '../../widgets/registry';
import { subscribeClientStateReset } from '../clientResetBus';

const s = () => useWorkspaceStore.getState();
const agent = (id: string): WorkspaceAgentRecord => ({ id, name: `Agent ${id}`, userId: 'u1' });
const groupKey = (groupId: string, userId = 'u1') => runtimeKeyOf({ kind: 'group', userId, projectId: 'p1', groupId });
const scope = () => s().groupStateByScope[groupScopeKey('u1', 'p1')];

let emitted: ClientStateResetScope[] = [];
let stop: () => void = () => {};
afterEach(() => stop());

beforeEach(() => {
  emitted = [];
  stop = subscribeClientStateReset((sc) => { emitted.push(sc); });
  syncPackageWidgets([]);
  registerWidget({ type: 'chat', title: 'Chat', defaultOpen: true, openBehavior: { singleton: true }, render: () => createElement('div') });
  registerWidget({ type: 'files', title: 'Files', openBehavior: { singleton: false }, render: () => createElement('div') });
  registerWidget({ type: 'admin', title: 'Admin', openBehavior: { singleton: true }, render: () => createElement('div') });
  s().reset();
  useWorkspaceStore.setState({
    liveUserId: 'u1',
    groupStateByScope: {},
    session: { projectId: 'p1', agentId: 'a1', workspaceView: 'default' },
    projectStateById: {},
    runtimeByAgentId: {},
    agents: { byId: { a1: agent('a1'), a2: agent('a2') }, ids: ['a1', 'a2'], status: 'success', error: null },
  });
});

describe('open targets (zero → create, one/more → most recent, explicit New)', () => {
  it('default reuses the window; "new" adds one only for a repeatable type; a named window wins', () => {
    const f1 = s().openWidget({ agentId: 'a1', type: 'files', title: 'Files' })!;
    expect(s().openWidget({ agentId: 'a1', type: 'files', title: 'Files' })).toBe(f1);
    const f2 = s().openWidget({ agentId: 'a1', type: 'files', title: 'Files', target: 'new' })!;
    expect(f2).not.toBe(f1);
    // f2 is now the most recently focused: the default goes there.
    expect(s().openWidget({ agentId: 'a1', type: 'files', title: 'Files' })).toBe(f2);
    expect(s().openWidget({ agentId: 'a1', type: 'files', title: 'Files', target: { instanceId: f1 } })).toBe(f1);
    // A singleton never gets a second window, whatever the target.
    const a = s().openWidget({ agentId: 'a1', type: 'admin', title: 'Admin' })!;
    expect(s().openWidget({ agentId: 'a1', type: 'admin', title: 'Admin', target: 'new' })).toBe(a);
    // A minimized window is restored by the default open.
    s().minimizeWidget({ agentId: 'a1', widgetInstanceId: f1 });
    expect(s().openWidget({ agentId: 'a1', type: 'files', title: 'Files', target: { instanceId: f1 } })).toBe(f1);
    expect(s().runtimeByAgentId[agentRuntimeKey('p1', 'a1')].widgets.byId[f1].hidden).toBe(false);
  });

  it('closing a window emits the widget scope with its instance; "Clean window" emits the instance scope and keeps it open', () => {
    const f1 = s().openWidget({ agentId: 'a1', type: 'files', title: 'Files' })!;
    const f2 = s().openWidget({ agentId: 'a1', type: 'files', title: 'Files', target: 'new' })!;
    s().cleanWindow({ widgetInstanceId: f2 });
    expect(emitted).toEqual([{ level: 'instance', projectId: 'p1', agentId: 'a1', widgetType: 'files', instanceId: f2 }]);
    expect(s().runtimeByAgentId[agentRuntimeKey('p1', 'a1')].widgets.byId[f2]).toBeDefined();
    s().closeWidget({ agentId: 'a1', widgetInstanceId: f1 });
    expect(emitted[1]).toEqual({ level: 'widget', projectId: 'p1', agentId: 'a1', widgetType: 'files', instanceId: f1 });
  });
});

describe('Group view', () => {
  it('the first Group is created from the authorized agent list only, never before it is fetched', () => {
    useWorkspaceStore.setState({ agents: { byId: {}, ids: [], status: 'loading', error: null } });
    s().setPresentation('group');
    expect(scope()).toBeUndefined();
    useWorkspaceStore.setState({ agents: { byId: { a1: agent('a1'), a2: agent('a2') }, ids: ['a1', 'a2'], status: 'success', error: null } });
    s().setPresentation('group');
    expect(scope()?.presentation).toBe('group');
    expect(scope()?.groups).toEqual([{ id: scope()!.selectedGroupId, name: DEFAULT_GROUP_NAME, memberIds: ['a1', 'a2'] }]);
  });

  it('Group windows of several agents share one layout; the per-agent layouts stay byte-identical and come back', () => {
    const own = s().openWidget({ agentId: 'a1', type: 'files', title: 'Files' })!;
    const before = JSON.stringify(s().runtimeByAgentId[agentRuntimeKey('p1', 'a1')]);
    s().setPresentation('group');
    const gid = scope()!.selectedGroupId!;
    expect(activeRuntimeKeyOf(s())).toBe(groupKey(gid));
    const c1 = s().openWidget({ agentId: 'a1', type: 'chat', title: 'Chat' })!;
    const c2 = s().openWidget({ agentId: 'a2', type: 'chat', title: 'Chat' })!;
    expect(c2).not.toBe(c1); // singleton per (type, bound agent)
    const group = s().runtimeByAgentId[groupKey(gid)];
    expect(group.widgets.openOrder).toEqual([c1, c2]);
    expect([group.widgets.byId[c1].agentId, group.widgets.byId[c2].agentId]).toEqual(['a1', 'a2']);
    // Picking an agent is the agent for NEW windows only: the layout stays.
    s().selectAgent('a2');
    expect(activeRuntimeKeyOf(s())).toBe(groupKey(gid));
    expect(newWindowAgentOf(s())).toBe('a2');
    // The per-agent layout was neither copied nor touched, and is retained mounted.
    expect(JSON.stringify(s().runtimeByAgentId[agentRuntimeKey('p1', 'a1')])).toBe(before);
    expect(s().retainedRuntimeKeys).toContain(agentRuntimeKey('p1', 'a1'));
    s().setPresentation('agent');
    s().selectAgent('a1');
    expect(activeRuntimeKeyOf(s())).toBe(agentRuntimeKey('p1', 'a1'));
    expect(s().runtimeByAgentId[agentRuntimeKey('p1', 'a1')].widgets.byId[own]).toBeDefined();
    expect(s().retainedRuntimeKeys).toContain(groupKey(gid));
  });

  it('two Groups keep separate layouts; deleting one drops only its own layout', () => {
    s().setPresentation('group');
    const g1 = scope()!.selectedGroupId!;
    const w1 = s().openWidget({ agentId: 'a1', type: 'files', title: 'Files' })!;
    const g2 = 'g_second';
    s().saveGroups({ groups: [...scope()!.groups, { id: g2, name: 'Work', memberIds: ['a2'] }], selectedGroupId: g2 });
    expect(activeRuntimeKeyOf(s())).toBe(groupKey(g2));
    expect(s().runtimeByAgentId[groupKey(g2)].widgets.openOrder).toEqual([]);
    s().saveGroups({ groups: scope()!.groups.filter((g) => g.id !== g2), selectedGroupId: g1 });
    expect(s().runtimeByAgentId[groupKey(g2)]).toBeUndefined();
    expect(s().runtimeByAgentId[groupKey(g1)].widgets.byId[w1]).toBeDefined();
  });

  it('an empty Group opens nothing: no identity is manufactured', () => {
    s().saveGroups({ groups: [{ id: 'g_empty', name: 'Empty', memberIds: [] }], selectedGroupId: 'g_empty' });
    s().setPresentation('group');
    expect(newWindowAgentOf(s())).toBeNull();
  });

  it('a window whose agent leaves the authorized list is withheld from the Group layout (fresh access first)', () => {
    s().setPresentation('group');
    const gid = scope()!.selectedGroupId!;
    const c1 = s().openWidget({ agentId: 'a1', type: 'chat', title: 'Chat' })!;
    const c2 = s().openWidget({ agentId: 'a2', type: 'chat', title: 'Chat' })!;
    const rt = s().runtimeByAgentId[groupKey(gid)];
    expect(authorizedWindowOrder(groupKey(gid), rt.widgets.openOrder, rt.widgets.byId, s().agents)).toEqual([c1, c2]);
    const revoked = { byId: { a1: agent('a1') }, ids: ['a1'], status: 'success' as const, error: null };
    expect(authorizedWindowOrder(groupKey(gid), rt.widgets.openOrder, rt.widgets.byId, revoked)).toEqual([c1]);
    const loading = { byId: {}, ids: [], status: 'loading' as const, error: null };
    expect(authorizedWindowOrder(groupKey(gid), rt.widgets.openOrder, rt.widgets.byId, loading)).toEqual([]);
    // Identity-stable when nothing is withheld (no selector churn).
    expect(authorizedWindowOrder(groupKey(gid), rt.widgets.openOrder, rt.widgets.byId, s().agents)).toBe(rt.widgets.openOrder);
  });

  it("another user on the same browser never sees this user's Groups, and the retained windows are dropped", () => {
    s().openWidget({ agentId: 'a1', type: 'files', title: 'Files' });
    s().setPresentation('group');
    expect(s().retainedRuntimeKeys.length).toBeGreaterThan(0);
    s().setLiveUserId('u2');
    expect(activeRuntimeKeyOf(s())).toBe(agentRuntimeKey('p1', 'a1'));
    expect(s().retainedRuntimeKeys).toEqual([]);
    s().setLiveUserId(null);
    s().setPresentation('group');
    expect(scope()?.presentation).toBe('group'); // nothing written without a live user
  });

  it('the persisted Group records are read field by field; an unreadable one is dropped alone', () => {
    const parsed = parsePersistedWorkspace({
      groupStateByScope: {
        good: { presentation: 'group', selectedGroupId: 'g1', groups: [{ id: 'g1', name: '  Team  ', memberIds: ['a1', 'a1', 3] }] },
        bad: 'x',
        none: { presentation: 'group', groups: [] },
      },
    });
    expect(parsed.groupStateByScope).toEqual({
      good: { presentation: 'group', selectedGroupId: 'g1', groups: [{ id: 'g1', name: 'Team', memberIds: ['a1'] }] },
      none: { presentation: 'agent', selectedGroupId: null, groups: [] },
    });
  });
});
