import { describe, it, expect } from 'vitest';
import { parsePersistedWorkspace, stripWidgetNavs } from '../workspaceStore';
import type { AgentRuntime } from '../types';

/**
 * The widget-state `nav` handoff is a one-shot message (consumed by its
 * applier); the persist partialize must never write a live nav to storage,
 * and must not allocate when there is nothing to strip.
 */

function runtimeWith(state: Record<string, unknown>): AgentRuntime {
  return {
    widgets: {
      openOrder: ['w1'],
      byId: {
        w1: { id: 'w1', type: 'chat', title: 'Chat', createdAt: 'now', state },
      },
    },
    layout: {},
  } as unknown as AgentRuntime;
}

describe('stripWidgetNavs (persist partialize)', () => {
  it('strips a live nav, keeps sibling state keys intact', () => {
    const input = { 'p1:a1': runtimeWith({ nav: { kind: 'chat', action: 'compose-skill', _ts: 1 }, other: 'kept' }) };
    const out = stripWidgetNavs(input);
    const state = out['p1:a1'].widgets.byId['w1'].state;
    expect('nav' in state).toBe(false);
    expect(state.other).toBe('kept');
    // Input is untouched (pure).
    expect((input['p1:a1'].widgets.byId['w1'].state as { nav?: unknown }).nav).toBeDefined();
  });

  it('no-nav fast path returns the IDENTICAL object refs (no per-write allocation)', () => {
    const input = {
      'p1:a1': runtimeWith({ other: 'kept' }),
      'p2:a1': runtimeWith({}),
    };
    const out = stripWidgetNavs(input);
    expect(out).toBe(input);
    expect(out['p1:a1']).toBe(input['p1:a1']);
  });

  it('leaves an undefined-valued nav (post-consume residue) alone — JSON drops it natively', () => {
    const input = { 'p1:a1': runtimeWith({ nav: undefined }) };
    const out = stripWidgetNavs(input);
    expect(out).toBe(input);
    expect(JSON.parse(JSON.stringify(out['p1:a1'].widgets.byId['w1'].state))).toEqual({});
  });

  it('only the nav-carrying widget is copied; untouched runtimes keep their refs', () => {
    const clean = runtimeWith({ other: 1 });
    const dirty = runtimeWith({ nav: { kind: 'chat', _ts: 2 } });
    const input = { 'p1:clean': clean, 'p1:dirty': dirty };
    const out = stripWidgetNavs(input);
    expect(out).not.toBe(input);
    expect(out['p1:clean']).toBe(clean);
    expect(out['p1:dirty']).not.toBe(dirty);
    expect('nav' in out['p1:dirty'].widgets.byId['w1'].state).toBe(false);
  });
});

describe('parsePersistedWorkspace (the persisted-state reader)', () => {
  it('drops ONLY the unreadable runtime; the readable one, the session and the project memory survive', () => {
    const good = runtimeWith({ draft: 'kept' });
    const parsed = parsePersistedWorkspace({
      runtimeByAgentId: { 'p1:a1': good, 'p1:broken': { layout: {} }, 'p1:nolayout': { widgets: { openOrder: [], byId: {} } } },
      session: { projectId: 'p1', agentId: 'a1', workspaceView: 'agent_create' },
      projectStateById: { p1: { lastAgentId: 'a1', dock: { primary: { order: ['x'], hidden: [] } } }, p2: 'garbage' },
    });
    expect(Object.keys(parsed.runtimeByAgentId)).toEqual(['p1:a1']);
    expect(parsed.runtimeByAgentId['p1:a1'].widgets.byId.w1.state).toEqual({ draft: 'kept' });
    expect(parsed.session).toEqual({ projectId: 'p1', agentId: 'a1', workspaceView: 'default' });
    expect(parsed.projectStateById).toEqual({ p1: { lastAgentId: 'a1', dock: { primary: { order: ['x'], hidden: [] } } } });
  });

  it('drops an unreadable widget and its order entry, keeping the rest of the runtime', () => {
    const rt = runtimeWith({});
    const parsed = parsePersistedWorkspace({ runtimeByAgentId: { k: { ...rt, widgets: { openOrder: ['w1', 'ghost', 7], byId: { ...rt.widgets.byId, bad: { id: 'bad' } } } } } });
    expect(parsed.runtimeByAgentId.k.widgets.openOrder).toEqual(['w1']);
    expect(Object.keys(parsed.runtimeByAgentId.k.widgets.byId)).toEqual(['w1']);
  });

  it('a payload that is not an object reads as an empty workspace, never a crash', () => {
    for (const raw of [undefined, null, 'x', 7, []]) {
      expect(parsePersistedWorkspace(raw)).toEqual({ runtimeByAgentId: {}, session: { projectId: null, agentId: null, workspaceView: 'default' }, projectStateById: {}, groupStateByScope: {} });
    }
  });
});
