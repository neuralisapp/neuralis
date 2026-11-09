/**
 * A boot load the host did not answer is loaded again by the workspace's
 * hub-connect arm (`reloadUnavailable`), once per connect.
 *
 * Pinned: no response or a 5xx reads `unavailable` (still to come), a 4xx reads
 * `error` (a refusal, final); the project list re-runs `bootstrap()`, an agent
 * list alone the narrow `selectProject` re-read; neither runs after a success, a
 * refusal or while a load is in flight; the re-run SPREADS `projectStateById`, so
 * the dock arrangement and the remembered agent survive it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceAgentRecord } from '@neuralis/package-system/contracts';
import type { ProjectRecord } from '@/api/projects';
import { ApiError } from '@/api/http';

vi.mock('@/api/agents', () => ({ listAgents: vi.fn(async () => []) }));
vi.mock('@/api/projects', () => ({ listProjects: vi.fn(async () => []) }));
import { listAgents } from '@/api/agents';
import { listProjects } from '@/api/projects';
import { useWorkspaceStore } from '../workspaceStore';
import type { LoadStatus, ProjectWorkspaceState } from '../types';

const s = () => useWorkspaceStore.getState();
const agent = (id: string): WorkspaceAgentRecord => ({ id, name: id, userId: 'u1' });
const project = (id: string): ProjectRecord => ({ id, name: id } as unknown as ProjectRecord);
const DOCK = { primary: { order: ['@acme/apps:apps'], hidden: [] } };

function seed(projects: LoadStatus, agents: LoadStatus, projectState: Record<string, ProjectWorkspaceState> = { p1: { lastAgentId: 'a', dock: DOCK } }): void {
  useWorkspaceStore.setState({
    session: { projectId: 'p1', agentId: 'a', workspaceView: 'default' },
    projectStateById: projectState,
    runtimeByAgentId: {},
    projects: { byId: { p1: project('p1') }, ids: ['p1'], status: projects, error: null },
    agents: { byId: {}, ids: [], status: agents, error: null },
    dockEditing: { primary: false, secondary: false, phone: false },
  });
}

const down = (): never => { throw new TypeError('Failed to fetch'); };

beforeEach(() => {
  vi.mocked(listProjects).mockImplementation(async () => [project('p1')]);
  vi.mocked(listAgents).mockImplementation(async () => [agent('a'), agent('b')]);
});

describe('how a failed boot load reads', () => {
  it('no response and a 5xx are unavailable; a 4xx is a refusal', async () => {
    for (const [failure, expected] of [[down, 'unavailable'], [() => { throw new ApiError('Runtime not ready', 503); }, 'unavailable'], [() => { throw new ApiError('Forbidden', 403); }, 'error']] as const) {
      seed('success', 'idle');
      vi.mocked(listAgents).mockImplementation(async () => failure());
      await s().bootstrap();
      expect(s().agents.status, String(expected)).toBe(expected);
    }
    seed('success', 'success');
    vi.mocked(listProjects).mockImplementation(async () => down());
    await s().bootstrap();
    expect(s().projects.status).toBe('unavailable');
  });

  it('a project switch whose agent list the host did not answer is unavailable too', async () => {
    seed('success', 'success');
    vi.mocked(listAgents).mockImplementation(async () => down());
    await s().selectProject('p1');
    expect(s().agents.status).toBe('unavailable');
  });
});

describe('reloadUnavailable — the hub-connect arm\'s store half', () => {
  it('an unavailable agent list is read again alone; the dock arrangement and the remembered agent survive', async () => {
    seed('success', 'unavailable');
    await s().reloadUnavailable();
    expect(vi.mocked(listProjects)).not.toHaveBeenCalled();
    expect(vi.mocked(listAgents)).toHaveBeenCalledWith('p1');
    expect(s().agents.status).toBe('success');
    expect(s().agents.ids).toEqual(['a', 'b']);
    expect(s().session.agentId).toBe('a');
    expect(s().projectStateById.p1).toEqual({ lastAgentId: 'a', dock: DOCK });
  });

  it('an unavailable project list re-runs bootstrap, which keeps the switch store', async () => {
    seed('unavailable', 'idle');
    await s().reloadUnavailable();
    expect(vi.mocked(listProjects)).toHaveBeenCalledTimes(1);
    expect(s().projects.status).toBe('success');
    expect(s().agents.status).toBe('success');
    expect(s().projectStateById.p1).toEqual({ lastAgentId: 'a', dock: DOCK });
  });

  it('nothing runs after a success, a refusal, or while a load is in flight', async () => {
    for (const [projects, agents] of [['success', 'success'], ['success', 'error'], ['error', 'idle'], ['loading', 'idle'], ['success', 'loading']] as const) {
      seed(projects, agents);
      await s().reloadUnavailable();
    }
    expect(vi.mocked(listProjects)).not.toHaveBeenCalled();
    expect(vi.mocked(listAgents)).not.toHaveBeenCalled();
  });
});
