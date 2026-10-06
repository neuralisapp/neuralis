/**
 * The per-project dock arrangement (`projectStateById[p].dock`):
 *  - every writer of a `projectStateById` entry SPREADS it, so a `lastAgentId`
 *    write (bootstrap, project switch, agent select) keeps `dock`;
 *  - `setDockPrefs` writes the ACTIVE project only, bounded, and is the one
 *    store write of an edit — the draft operations write nothing;
 *  - the persist version is unchanged and edit mode is never persisted.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WorkspaceAgentRecord } from '@neuralis/package-system/contracts';
import type { ProjectRecord } from '@/api/projects';

vi.mock('@/api/agents', () => ({
  listAgents: vi.fn(async () => []),
}));
vi.mock('@/api/projects', () => ({
  listProjects: vi.fn(async () => []),
}));
import { listAgents } from '@/api/agents';
import { listProjects } from '@/api/projects';
import { useWorkspaceStore } from '../workspaceStore';
import type { DockPrefs, ProjectWorkspaceState } from '../types';
import {
  applyDockPrefs,
  draftFromItems,
  moveDockKey,
  setDockKeyHidden,
  stepDockKey,
  DOCK_PREFS_MAX_KEYS,
  type ArrangeableItem,
} from '../../shell/dockOrder';

const s = () => useWorkspaceStore.getState();
const agent = (id: string): WorkspaceAgentRecord => ({ id, name: id, userId: 'u1' });
const project = (id: string): ProjectRecord => ({ id, name: id } as unknown as ProjectRecord);

const PRIMARY: DockPrefs = { order: ['@neuralis/brain-core:files', '@neuralis/agent-core:agent-core.calendar'], hidden: [] };
const SECONDARY: DockPrefs = { order: ['agent:b', 'agent:a'], hidden: ['agent:c'] };
const DOCK = { primary: PRIMARY, secondary: SECONDARY };

function seed(projectState: Record<string, ProjectWorkspaceState>, session: { projectId: string | null; agentId: string | null }): void {
  useWorkspaceStore.setState({
    session: { ...session, workspaceView: 'default' },
    projectStateById: projectState,
    runtimeByAgentId: {},
    projects: { byId: {}, ids: [], status: 'success', error: null },
    agents: { byId: {}, ids: [], status: 'success', error: null },
    dockEditing: { primary: false, secondary: false },
  });
}

beforeEach(() => {
  vi.mocked(listAgents).mockImplementation(async () => []);
  vi.mocked(listProjects).mockImplementation(async () => []);
});

describe('every projectStateById writer keeps the dock arrangement', () => {
  it('selectAgent', () => {
    seed({ p1: { lastAgentId: 'a', dock: DOCK } }, { projectId: 'p1', agentId: 'a' });
    s().selectAgent('b');
    expect(s().projectStateById.p1).toEqual({ lastAgentId: 'b', dock: DOCK });
  });

  it('selectProject (the post-fetch arm)', async () => {
    seed({ p1: { lastAgentId: 'a' }, p2: { lastAgentId: 'x', dock: DOCK } }, { projectId: 'p1', agentId: 'a' });
    vi.mocked(listAgents).mockImplementation(async () => [agent('y')]);
    await s().selectProject('p2');
    expect(s().projectStateById.p2).toEqual({ lastAgentId: 'y', dock: DOCK });
  });

  it('bootstrap', async () => {
    seed({ p1: { lastAgentId: 'a', dock: DOCK } }, { projectId: 'p1', agentId: 'a' });
    vi.mocked(listProjects).mockImplementation(async () => [project('p1')]);
    vi.mocked(listAgents).mockImplementation(async () => [agent('a'), agent('b')]);
    await s().bootstrap();
    expect(s().projectStateById.p1).toEqual({ lastAgentId: 'a', dock: DOCK });
  });
});

describe('setDockPrefs', () => {
  it('writes one dock of the ACTIVE project and keeps the other dock and lastAgentId', () => {
    seed({ p1: { lastAgentId: 'a', dock: { secondary: SECONDARY } }, p2: { lastAgentId: 'z' } }, { projectId: 'p1', agentId: 'a' });
    s().setDockPrefs({ dockId: 'primary', prefs: PRIMARY });
    expect(s().projectStateById.p1).toEqual({ lastAgentId: 'a', dock: { primary: PRIMARY, secondary: SECONDARY } });
    // Another project keeps the default order.
    expect(s().projectStateById.p2).toEqual({ lastAgentId: 'z' });
  });

  it('creates the entry for a project the switch store has not seen yet', () => {
    seed({}, { projectId: 'p9', agentId: 'q' });
    s().setDockPrefs({ dockId: 'secondary', prefs: SECONDARY });
    expect(s().projectStateById.p9).toEqual({ lastAgentId: 'q', dock: { secondary: SECONDARY } });
  });

  it('is bounded and de-duplicated', () => {
    seed({ p1: { lastAgentId: 'a' } }, { projectId: 'p1', agentId: 'a' });
    const many = Array.from({ length: DOCK_PREFS_MAX_KEYS + 50 }, (_, i) => `k${i}`);
    s().setDockPrefs({ dockId: 'primary', prefs: { order: [...many, 'k1', 7 as unknown as string], hidden: ['x', 'x'] } });
    const stored = s().projectStateById.p1?.dock?.primary;
    expect(stored?.order).toHaveLength(DOCK_PREFS_MAX_KEYS);
    expect(stored?.hidden).toEqual(['x']);
  });

  it('does nothing without an active project', () => {
    seed({}, { projectId: null, agentId: null });
    s().setDockPrefs({ dockId: 'primary', prefs: PRIMARY });
    expect(s().projectStateById).toEqual({});
  });
});

describe('an edit writes the store ONCE — on Save', () => {
  it('drag, step, hide and restore on the draft notify no store subscriber; Save notifies once', () => {
    seed({ p1: { lastAgentId: 'a' } }, { projectId: 'p1', agentId: 'a' });
    const writes = vi.fn();
    const stop = useWorkspaceStore.subscribe(writes);
    const items: ArrangeableItem[] = [
      { id: 'cal', position: 100, prefKey: 'pkg:cal', group: 'trust:first-party' },
      { id: 'files', position: 101, prefKey: 'pkg:files', group: 'trust:first-party' },
      { id: 'admin', position: 102, prefKey: 'pkg:admin', group: 'trust:first-party' },
    ];
    let draft = draftFromItems(items);
    draft = moveDockKey(draft, items, 'pkg:admin', 'pkg:cal', 'before');
    draft = stepDockKey(draft, items, 'pkg:files', -1);
    draft = setDockKeyHidden(draft, 'pkg:cal', true);
    draft = setDockKeyHidden(draft, 'pkg:cal', false);
    draft = setDockKeyHidden(draft, 'pkg:admin', true);
    expect(writes).not.toHaveBeenCalled();
    s().setDockPrefs({ dockId: 'primary', prefs: draft });
    expect(writes).toHaveBeenCalledTimes(1);
    stop();
    const shown = applyDockPrefs(items, s().projectStateById.p1?.dock?.primary).filter((i) => !i.hidden).map((i) => i.id);
    expect(shown).toEqual(['files', 'cal']);
  });
});

describe('persist', () => {
  it('the version stays 2 and edit mode is not persisted', () => {
    const options = useWorkspaceStore.persist.getOptions();
    expect(options.version).toBe(2);
    seed({ p1: { lastAgentId: 'a', dock: DOCK } }, { projectId: 'p1', agentId: 'a' });
    s().setDockEditing('both', true);
    const persisted = options.partialize?.(s()) as Record<string, unknown>;
    expect(Object.keys(persisted).sort()).toEqual(['projectStateById', 'runtimeByAgentId', 'session']);
    expect((persisted.projectStateById as Record<string, ProjectWorkspaceState>).p1?.dock).toEqual(DOCK);
  });

  it('setDockEditing toggles one dock or both', () => {
    seed({}, { projectId: 'p1', agentId: 'a' });
    s().setDockEditing('both', true);
    expect(s().dockEditing).toEqual({ primary: true, secondary: true });
    s().setDockEditing('primary', false);
    expect(s().dockEditing).toEqual({ primary: false, secondary: true });
  });
});
