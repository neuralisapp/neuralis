import { describe, it, expect } from 'vitest';
import { stripWidgetNavs } from '../workspaceStore';
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
