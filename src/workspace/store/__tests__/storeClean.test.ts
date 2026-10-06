/**
 * The 3-level workspace store clean (widget / agent / project brooms), the
 * project-level switch store (`projectStateById`) and the COMPOSITE
 * `${projectId}:${agentId}` runtime keying.
 *
 * Pins the architect-corrected floors of the 2026-08-14 plan + correction
 * round (`plans/final/workspace/store-clean-and-project-store-plan.md` §7):
 *  - runtime/file-mark keys are composite — agent ids repeat across projects
 *    (`admin`, `coder` exist in several live projects), and a bare-keyed map
 *    let a project clean delete ACROSS projects (measured live);
 *  - key composition uses the projectId that OWNS the runtime in the action's
 *    context — at the `selectProject` boundary the session still points at
 *    the DEPARTING project (architect 1a);
 *  - `cleanProjectStore` works for ANY project via `${projectId}:` prefix
 *    scan, emits the CLEANED project's scope on the reset bus (never the
 *    active one), retains `lastAgentId`;
 *  - `projectStateById` survives `reset()`/`reload()` (F4);
 *  - a STALE selectProject fetch never clobbers a newer selection (F3);
 *  - the persist v1→v2 migrate attributes bare entries via `lastAgentId`
 *    claims, active project wins ties with the ONLY copy, unclaimed drops;
 *  - the broom-predicate selectors return primitives that are stable across
 *    geometry writes (the dock re-render floor).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WorkspaceAgentRecord } from '@neuralis/package-system/contracts';
import type { ProjectRecord } from '@/api/projects';
import type { AgentRuntime } from '../types';

vi.mock('@/api/agents', () => ({
  listAgents: vi.fn(async () => []),
}));
vi.mock('@/api/projects', () => ({
  listProjects: vi.fn(async () => []),
}));
import { listAgents } from '@/api/agents';
import { listProjects } from '@/api/projects';
import { useWorkspaceStore, agentRuntimeKey } from '../workspaceStore';
import { agentHasStore, projectsWithStoreKey } from '../selectors';
// The REAL bus, not a mock — the contract under test is "the store emits on it".
import { subscribeClientStateReset } from '../clientResetBus';
import type { ClientStateResetScope } from '@neuralis/package-system/contracts';

const s = () => useWorkspaceStore.getState();
const K = agentRuntimeKey;

const agent = (id: string): WorkspaceAgentRecord => ({ id, name: id, userId: 'u1' });
const project = (id: string): ProjectRecord => ({ id, name: id } as unknown as ProjectRecord);

// Every scope the store emits on the REAL reset bus — how a package's client
// store (the chat caches included) learns about a broom; the wipe itself is
// that package's own test.
let emitted: ClientStateResetScope[] = [];
let stopCapture: () => void = () => {};

afterEach(() => stopCapture());

beforeEach(() => {
  emitted = [];
  stopCapture = subscribeClientStateReset((scope) => { emitted.push(scope); });
  s().reset();
  useWorkspaceStore.setState({
    session: { projectId: 'p1', agentId: 'a1', workspaceView: 'default' },
    projectStateById: {},
    fileMarksByAgentId: {},
    runtimeByAgentId: {},
    agents: {
      byId: { a1: agent('a1'), a2: agent('a2') },
      ids: ['a1', 'a2'],
      status: 'success',
      error: null,
    },
  });
});

describe('cleanAgentStore', () => {
  it('cleaning the ACTIVE agent reseeds a fresh runtime and drops file marks', () => {
    const w1 = s().openWidget({ agentId: 'a1', type: 'files', title: 'Files' })!;
    s().markFile({ agentId: 'a1', path: '/x', kind: 'new' });

    s().cleanAgentStore({ agentId: 'a1' });

    const rt = s().runtimeByAgentId[K('p1', 'a1')];
    expect(rt).toBeTruthy(); // reseeded, never left empty for the stage
    expect(rt.widgets.byId[w1]).toBeUndefined();
    expect(s().fileMarksByAgentId[K('p1', 'a1')]).toBeUndefined();
    expect(emitted).toEqual([{ level: 'agent', projectId: 'p1', agentId: 'a1' }]); // bare id + the OWNING project
  });

  it('cleaning a NON-active agent deletes its runtime outright (reseed on next select)', () => {
    s().openWidget({ agentId: 'a2', type: 'files', title: 'Files' });
    s().cleanAgentStore({ agentId: 'a2' });
    expect(s().runtimeByAgentId[K('p1', 'a2')]).toBeUndefined();
  });

  it('other agents runtimes survive an agent clean', () => {
    const wOther = s().openWidget({ agentId: 'a2', type: 'files', title: 'Files' })!;
    s().cleanAgentStore({ agentId: 'a1' });
    expect(s().runtimeByAgentId[K('p1', 'a2')].widgets.byId[wOther]).toBeTruthy();
  });
});

describe('cleanProjectStore', () => {
  it('ACTIVE project: clears listed agents via prefix scan, reseeds the active one, retains lastAgentId', () => {
    const w1 = s().openWidget({ agentId: 'a1', type: 'files', title: 'Files' })!;
    s().openWidget({ agentId: 'a2', type: 'files', title: 'Files' });
    useWorkspaceStore.setState({ projectStateById: { p1: { lastAgentId: 'a2' } } });

    s().cleanProjectStore({ projectId: 'p1' });

    expect(s().runtimeByAgentId[K('p1', 'a1')]).toBeTruthy(); // active → reseeded
    expect(s().runtimeByAgentId[K('p1', 'a1')].widgets.byId[w1]).toBeUndefined();
    expect(s().runtimeByAgentId[K('p1', 'a2')]).toBeUndefined(); // non-active → deleted
    // Switch memory RETAINED — lastAgentId is not store.
    expect(s().projectStateById.p1).toEqual({ lastAgentId: 'a2' });
    expect(emitted).toEqual([{ level: 'project', projectId: 'p1' }]);
  });

  it('NON-active project: cleans via the composite prefix with NO server call, the CLEANED project on the bus', () => {
    useWorkspaceStore.setState({
      runtimeByAgentId: {
        [K('p9', 'x')]: { widgets: { openOrder: [], byId: {} }, layout: {} } as AgentRuntime,
      },
    });
    const w1 = s().openWidget({ agentId: 'a1', type: 'files', title: 'Files' })!;

    s().cleanProjectStore({ projectId: 'p9' });

    expect(s().runtimeByAgentId[K('p9', 'x')]).toBeUndefined();
    expect(s().runtimeByAgentId[K('p1', 'a1')].widgets.byId[w1]).toBeTruthy(); // active untouched
    expect(emitted).toEqual([{ level: 'project', projectId: 'p9' }]); // the cleaned project, never the active one
    expect(vi.mocked(listAgents)).not.toHaveBeenCalled(); // no server call
  });

  it('REGRESSION (measured live): same-slug agents in two projects — cleaning one leaves the other byte-identical', () => {
    const foreign = { widgets: { openOrder: ['w_f'], byId: { w_f: { id: 'w_f', type: 'files', title: 'F', createdAt: 'x', state: {} } } }, layout: {} } as AgentRuntime;
    useWorkspaceStore.setState({
      runtimeByAgentId: {
        [K('p1', 'admin')]: foreign,
        [K('p2', 'admin')]: { widgets: { openOrder: [], byId: {} }, layout: {} } as AgentRuntime,
      },
    });

    s().cleanProjectStore({ projectId: 'p2' });

    expect(s().runtimeByAgentId[K('p2', 'admin')]).toBeUndefined();
    expect(s().runtimeByAgentId[K('p1', 'admin')]).toBe(foreign); // identity preserved
  });
});

describe('closeWidget geometry', () => {
  it('clears the canvas AND grid geometry slots with the instance', () => {
    const id = s().openWidget({ agentId: 'a1', type: 'files', title: 'Files' })!;
    s().setWidgetGeometry({ agentId: 'a1', widgetInstanceId: id, slot: 'canvas', geometry: { x: 1, y: 2, w: 300, h: 200, z: 3 } });
    s().setWidgetGeometry({ agentId: 'a1', widgetInstanceId: id, slot: 'grid', geometry: { x: 0, y: 0, w: 320, h: 240, z: 1 } });

    s().closeWidget({ agentId: 'a1', widgetInstanceId: id });

    const layout = s().runtimeByAgentId[K('p1', 'a1')].layout;
    expect(layout.freeformById?.[id]).toBeUndefined();
    expect(layout.gridById?.[id]).toBeUndefined();
    expect(layout.widgetSplitsById?.[id]).toBeUndefined();
  });
});

describe('projectStateById (the switch store)', () => {
  it('selectAgent records the last-used agent for the active project', () => {
    s().selectAgent('a2');
    expect(s().projectStateById.p1).toEqual({ lastAgentId: 'a2' });
    expect(s().runtimeByAgentId[K('p1', 'a2')]).toBeTruthy();
  });

  it('survives reset()/reload() — the F4 floor (reload fires on every agent create)', () => {
    s().selectAgent('a2');
    s().reset();
    expect(s().projectStateById.p1).toEqual({ lastAgentId: 'a2' });
  });

  it('selectProject fast path composes the key from the NEW project — the departing project stays untouched (architect 1a)', () => {
    // Same-slug agent in BOTH projects: the remembered p2 agent shares the
    // slug of an existing p1 runtime. A session-composed key would find the
    // OLD project's entry and skip seeding the new one.
    const p1Admin = { widgets: { openOrder: [], byId: {} }, layout: {} } as AgentRuntime;
    useWorkspaceStore.setState({
      session: { projectId: 'p1', agentId: 'admin', workspaceView: 'default' },
      runtimeByAgentId: { [K('p1', 'admin')]: p1Admin },
      projectStateById: { p2: { lastAgentId: 'admin' } },
    });
    vi.mocked(listAgents).mockImplementation(() => new Promise(() => {})); // fetch never lands

    void s().selectProject('p2');

    expect(s().session.projectId).toBe('p2');
    expect(s().session.agentId).toBe('admin'); // no agentId:null window
    expect(s().session.workspaceView).toBe('default'); // no wizard flash
    expect(s().agents.status).toBe('loading'); // merged first set()
    expect(s().runtimeByAgentId[K('p2', 'admin')]).toBeTruthy(); // seeded under the NEW project
    expect(s().runtimeByAgentId[K('p1', 'admin')]).toBe(p1Admin); // departing untouched
  });

  it('falls back to the first fetched agent when the remembered one is gone', async () => {
    useWorkspaceStore.setState({ projectStateById: { p2: { lastAgentId: 'gone' } } });
    vi.mocked(listAgents).mockResolvedValue([agent('a3')]);

    await s().selectProject('p2');

    expect(s().session.agentId).toBe('a3');
    expect(s().runtimeByAgentId[K('p2', 'a3')]).toBeTruthy();
    expect(s().projectStateById.p2).toEqual({ lastAgentId: 'a3' });
  });

  it('a STALE selectProject fetch never clobbers a newer selection (F3)', async () => {
    let resolveP2!: (v: WorkspaceAgentRecord[]) => void;
    vi.mocked(listAgents).mockImplementation((projectId?: string) =>
      projectId === 'p2'
        ? new Promise<WorkspaceAgentRecord[]>((resolve) => { resolveP2 = resolve; })
        : Promise.resolve([agent('b1')]),
    );

    const stale = s().selectProject('p2'); // slow fetch
    await s().selectProject('p3'); // newer switch wins

    expect(s().session.projectId).toBe('p3');
    expect(s().session.agentId).toBe('b1');

    resolveP2([agent('z9')]); // the stale response finally lands
    await stale;

    expect(s().session.projectId).toBe('p3'); // untouched
    expect(s().session.agentId).toBe('b1');
    expect(s().agents.ids).toEqual(['b1']);
    expect(s().projectStateById.p2).toBeUndefined(); // stale write suppressed too
  });

  it('bootstrap prunes switch-store entries for projects that no longer exist', async () => {
    vi.mocked(listProjects).mockResolvedValue([project('p1')]);
    vi.mocked(listAgents).mockResolvedValue([agent('a1')]);
    useWorkspaceStore.setState({
      projectStateById: { p1: { lastAgentId: 'a1' }, dead: { lastAgentId: 'x' } },
    });

    await s().bootstrap();

    expect(s().projectStateById.dead).toBeUndefined();
    expect(s().projectStateById.p1).toEqual({ lastAgentId: 'a1' });
    expect(s().runtimeByAgentId[K('p1', 'a1')]).toBeTruthy();
  });

  it('persist partialize carries the switch store', () => {
    const partialize = useWorkspaceStore.persist.getOptions().partialize!;
    const persisted = partialize(s());
    expect(Object.keys(persisted).sort()).toEqual(['projectStateById', 'runtimeByAgentId', 'session']);
  });
});

describe('refreshProjects (a `project` hub frame re-reads the list only)', () => {
  const named = (id: string, name: string): ProjectRecord => ({ id, name } as unknown as ProjectRecord);

  beforeEach(() => {
    // Earlier rows arm persistent implementations; restore the hoisted defaults.
    vi.mocked(listProjects).mockReset().mockImplementation(async () => []);
    vi.mocked(listAgents).mockReset().mockImplementation(async () => []);
    useWorkspaceStore.setState({
      projects: { byId: { p1: named('p1', 'Old'), p2: named('p2', 'Two') }, ids: ['p1', 'p2'], status: 'success', error: null },
      projectStateById: { p1: { lastAgentId: 'a1' }, p2: { lastAgentId: 'b1' }, gone: { lastAgentId: 'x' } },
    });
  });

  it('replaces the list, keeps the layout and the session, prunes the switch store — no agent fetch', async () => {
    const w1 = s().openWidget({ agentId: 'a1', type: 'files', title: 'Files' })!;
    const runtimeBefore = s().runtimeByAgentId;
    const sessionBefore = s().session;
    vi.mocked(listProjects).mockImplementation(async () => [named('p1', 'Renamed'), named('p2', 'Two')]);

    await s().refreshProjects();

    expect(s().projects.byId.p1?.name).toBe('Renamed');
    expect(s().projects.ids).toEqual(['p1', 'p2']);
    expect(s().projects.status).toBe('success');
    expect(s().runtimeByAgentId).toBe(runtimeBefore);
    expect(s().runtimeByAgentId[K('p1', 'a1')]?.widgets.byId[w1]).toBeTruthy();
    expect(s().session).toBe(sessionBefore);
    expect(s().projectStateById).toEqual({ p1: { lastAgentId: 'a1' }, p2: { lastAgentId: 'b1' } });
    expect(listAgents).not.toHaveBeenCalled();
    expect(listProjects).toHaveBeenCalledTimes(1);
  });

  it('the ACTIVE project vanished ⇒ the bootstrap fallback re-points the session; other layouts survive', async () => {
    s().openWidget({ agentId: 'a1', type: 'files', title: 'Files' });
    useWorkspaceStore.setState((st) => ({
      runtimeByAgentId: { ...st.runtimeByAgentId, [K('p2', 'b1')]: st.runtimeByAgentId[K('p1', 'a1')]! },
    }));
    vi.mocked(listProjects).mockImplementation(async () => [named('p2', 'Two')]);
    vi.mocked(listAgents).mockImplementation(async () => [agent('b1')]);

    await s().refreshProjects();

    expect(s().session.projectId).toBe('p2');
    expect(listAgents).toHaveBeenCalledWith('p2');
    expect(s().projects.ids).toEqual(['p2']);
    expect(s().projectStateById.p1).toBeUndefined();
    // Never `reload()`: the persisted layouts of every project are kept.
    expect(s().runtimeByAgentId[K('p1', 'a1')]).toBeTruthy();
    expect(s().runtimeByAgentId[K('p2', 'b1')]).toBeTruthy();
  });

  it('a failed re-read keeps the last good list and the session', async () => {
    vi.mocked(listProjects).mockImplementation(async () => { throw new Error('offline'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await s().refreshProjects();

    expect(s().projects.byId.p1?.name).toBe('Old');
    expect(s().projects.status).toBe('success');
    expect(s().session.projectId).toBe('p1');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('persist v1→v2 migrate', () => {
  const migrate = () => useWorkspaceStore.persist.getOptions().migrate!;
  const rt = () => ({ widgets: { openOrder: [], byId: {} }, layout: {} }) as AgentRuntime;

  it('attributes bare entries to the project claiming the agent via lastAgentId', () => {
    const out = migrate()({
      runtimeByAgentId: { a: rt(), b: rt() },
      session: { projectId: 'p1', agentId: 'a', workspaceView: 'default' },
      projectStateById: { p1: { lastAgentId: 'a' }, p2: { lastAgentId: 'b' } },
    }, 1) as { runtimeByAgentId: Record<string, AgentRuntime> };
    expect(Object.keys(out.runtimeByAgentId).sort()).toEqual([K('p1', 'a'), K('p2', 'b')].sort());
  });

  it('a tie goes to the ACTIVE project with the ONLY copy — never duplicated', () => {
    const out = migrate()({
      runtimeByAgentId: { admin: rt() },
      session: { projectId: 'p2', agentId: 'admin', workspaceView: 'default' },
      projectStateById: { p1: { lastAgentId: 'admin' }, p2: { lastAgentId: 'admin' } },
    }, 1) as { runtimeByAgentId: Record<string, AgentRuntime> };
    expect(Object.keys(out.runtimeByAgentId)).toEqual([K('p2', 'admin')]);
  });

  it('unclaimed entries are DROPPED (a bare key is unreadable post-v2), null project drops all', () => {
    const dropped = migrate()({
      runtimeByAgentId: { orphan: rt() },
      session: { projectId: 'p1', agentId: null, workspaceView: 'default' },
      projectStateById: {},
    }, 1) as { runtimeByAgentId: Record<string, AgentRuntime> };
    expect(dropped.runtimeByAgentId).toEqual({});

    const nullProject = migrate()({
      runtimeByAgentId: { a: rt() },
      session: { projectId: null, agentId: null, workspaceView: 'default' },
      projectStateById: { p1: { lastAgentId: 'a' } },
    }, 1) as { runtimeByAgentId: Record<string, AgentRuntime>; projectStateById: unknown };
    expect(nullProject.runtimeByAgentId).toEqual({});
    expect(nullProject.projectStateById).toEqual({ p1: { lastAgentId: 'a' } });
  });

  it('a v2 payload passes through unchanged', () => {
    const payload = {
      runtimeByAgentId: { [K('p1', 'a')]: rt() },
      session: { projectId: 'p1', agentId: 'a', workspaceView: 'default' as const },
      projectStateById: {},
    };
    expect(migrate()(payload, 2)).toBe(payload);
  });
});

describe('broom-predicate selectors (dock re-render floor)', () => {
  it('agentHasStore + projectsWithStoreKey return Object.is-stable primitives across a geometry write', () => {
    const id = s().openWidget({ agentId: 'a1', type: 'files', title: 'Files' })!;
    const before1 = agentHasStore(s(), 'a1');
    const before2 = projectsWithStoreKey(s());

    s().setWidgetGeometry({ agentId: 'a1', widgetInstanceId: id, slot: 'canvas', geometry: { x: 9, y: 9, w: 300, h: 200, z: 2 } });

    expect(Object.is(agentHasStore(s(), 'a1'), before1)).toBe(true);
    expect(Object.is(projectsWithStoreKey(s()), before2)).toBe(true);
    expect(before1).toBe(true);
    expect(before2).toBe('p1');
  });

  it('projectsWithStoreKey is sorted — identical for the same set regardless of insertion order', () => {
    useWorkspaceStore.setState({
      runtimeByAgentId: {
        [K('pB', 'x')]: { widgets: { openOrder: [], byId: {} }, layout: {} } as AgentRuntime,
        [K('pA', 'y')]: { widgets: { openOrder: [], byId: {} }, layout: {} } as AgentRuntime,
      },
    });
    expect(projectsWithStoreKey(s())).toBe('pA|pB');
    expect(agentHasStore(s(), 'a1')).toBe(false); // active project p1 holds nothing now
  });
});

describe('client-state reset bus (the broom reaches package stores through the kernel port)', () => {
  function capture() {
    const scopes: ClientStateResetScope[] = [];
    const seen: Array<{ scope: ClientStateResetScope; runtimeAtEmit: AgentRuntime | undefined }> = [];
    const unsubscribe = subscribeClientStateReset((scope) => {
      scopes.push(scope);
      // What the handler OBSERVES: the host set() must already have landed.
      seen.push({ scope, runtimeAtEmit: s().runtimeByAgentId[K('p1', 'a1')] });
    });
    return { scopes, seen, unsubscribe };
  }

  it('widget level carries the widget TYPE read before the delete, and emits after the set()', () => {
    const files = s().openWidget({ agentId: 'a1', type: 'filesystem', title: 'Files' })!;
    const chat = s().openWidget({ agentId: 'a1', type: 'chat', title: 'Chat' })!;
    const c = capture();

    s().closeWidget({ agentId: 'a1', widgetInstanceId: files });
    s().closeWidget({ agentId: 'a1', widgetInstanceId: chat }); // control: a different type

    expect(c.scopes).toEqual([
      { level: 'widget', projectId: 'p1', agentId: 'a1', widgetType: 'filesystem' },
      { level: 'widget', projectId: 'p1', agentId: 'a1', widgetType: 'chat' },
    ]);
    // Emitted AFTER the delete: the handler no longer sees the instance.
    expect(c.seen[0].runtimeAtEmit?.widgets.byId[files]).toBeUndefined();
    c.unsubscribe();
  });

  it('an unknown instance emits nothing', () => {
    const c = capture();
    s().closeWidget({ agentId: 'a1', widgetInstanceId: 'w_nope' });
    expect(c.scopes).toEqual([]);
    c.unsubscribe();
  });

  it('agent level emits after the reseed; project level emits ONE project scope', () => {
    const w1 = s().openWidget({ agentId: 'a1', type: 'filesystem', title: 'Files' })!;
    const c = capture();

    s().cleanAgentStore({ agentId: 'a1' });
    expect(c.scopes).toEqual([{ level: 'agent', projectId: 'p1', agentId: 'a1' }]);
    expect(c.seen[0].runtimeAtEmit).toBeTruthy(); // reseeded runtime already visible …
    expect(c.seen[0].runtimeAtEmit?.widgets.byId[w1]).toBeUndefined(); // … without the swept widget

    s().openWidget({ agentId: 'a2', type: 'filesystem', title: 'Files' });
    s().cleanProjectStore({ projectId: 'p1' });
    expect(c.scopes[1]).toEqual({ level: 'project', projectId: 'p1' });
    expect(c.scopes).toHaveLength(2);
    c.unsubscribe();
  });

  it('a project broom with NO host rows still emits the project scope (a package store may hold state)', () => {
    const c = capture();
    s().cleanProjectStore({ projectId: 'p-empty' });
    expect(c.scopes).toEqual([{ level: 'project', projectId: 'p-empty' }]);
    c.unsubscribe();
  });

  it('a throwing handler never starves the others, and unsubscribe stops delivery', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bad = subscribeClientStateReset(() => { throw new Error('boom'); });
    const c = capture();

    s().cleanAgentStore({ agentId: 'a1' });
    expect(c.scopes).toHaveLength(1);
    expect(error).toHaveBeenCalledTimes(1);

    bad();
    c.unsubscribe();
    s().cleanAgentStore({ agentId: 'a1' });
    expect(c.scopes).toHaveLength(1); // no delivery after unsubscribe
    error.mockRestore();
  });
});
