/** The port's openWidget: per agent, a window for another agent brings the view to that agent; a Group never switches. */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createElement } from 'react';

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }));
vi.mock('@/api/agents', () => ({ listAgents: vi.fn(async () => []) }));
vi.mock('@/api/projects', () => ({ listProjects: vi.fn(async () => []) }));

import { workspaceHostPort } from '../buildWorkspaceHostPort';
import { useWorkspaceStore, activeRuntimeKeyOf, agentRuntimeKey, groupScopeKey } from '../../store/workspaceStore';
import { registerWidget, syncPackageWidgets } from '../../widgets/registry';

const s = () => useWorkspaceStore.getState();

beforeEach(() => {
  syncPackageWidgets([]);
  registerWidget({ type: 'chat', title: 'Chat', openBehavior: { singleton: false }, render: () => createElement('div') });
  s().reset();
  useWorkspaceStore.setState({
    liveUserId: 'u1', groupStateByScope: {}, runtimeByAgentId: {},
    session: { projectId: 'p1', agentId: 'a1', workspaceView: 'default' },
    agents: { byId: { a1: { id: 'a1', userId: 'u1' }, a2: { id: 'a2', userId: 'u1' } }, ids: ['a1', 'a2'], status: 'success', error: null },
  });
});

describe('port openWidget', () => {
  it('per agent: a window for another agent opens in that agent\'s layout, which comes into view', () => {
    const id = workspaceHostPort.openWidget({ agentId: 'a2', type: 'chat', title: 'Chat' })!;
    expect(s().session.agentId).toBe('a2');
    expect(s().runtimeByAgentId[agentRuntimeKey('p1', 'a2')].widgets.byId[id]).toBeDefined();
    // An agent outside the fetched list never becomes the view.
    workspaceHostPort.openWidget({ agentId: 'ghost', type: 'chat', title: 'Chat' });
    expect(s().session.agentId).toBe('a2');
  });

  it('Group: the window joins the shared layout bound to its agent; the selected agent does not change', () => {
    useWorkspaceStore.setState({ groupStateByScope: { [groupScopeKey('u1', 'p1')]: { presentation: 'group', selectedGroupId: 'g', groups: [{ id: 'g', name: 'G', memberIds: ['a1', 'a2'] }] } } });
    const key = activeRuntimeKeyOf(s())!;
    const id = workspaceHostPort.openWidget({ agentId: 'a2', type: 'chat', title: 'Chat' })!;
    expect(s().session.agentId).toBe('a1');
    expect(s().runtimeByAgentId[key].widgets.byId[id].agentId).toBe('a2');
  });
});
