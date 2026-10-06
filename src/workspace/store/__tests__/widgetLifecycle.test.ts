import { describe, it, expect, beforeEach } from 'vitest';
import { useWorkspaceStore } from '../workspaceStore';

const A = 'agent-lifecycle-test';
// Runtimes are keyed by the COMPOSITE `${projectId}:${agentId}` (agent ids
// repeat across projects); the session below pins projectId 'p1'.
const KEY = `p1:${A}`;
const s = () => useWorkspaceStore.getState();
const widgets = () => s().runtimeByAgentId[KEY].widgets;

beforeEach(() => {
  s().reset();
  useWorkspaceStore.setState({ session: { projectId: 'p1', agentId: A, workspaceView: 'default' } });
});

describe('workspace widget lifecycle', () => {
  it('minimize preserves the instance (hidden flag, stays in byId + openOrder)', () => {
    const id = s().openWidget({ agentId: A, type: 'files', title: 'Files' })!;
    expect(id).toBeTruthy();
    expect(widgets().byId[id].hidden).toBeFalsy();

    s().minimizeWidget({ agentId: A, widgetInstanceId: id });
    expect(widgets().byId[id].hidden).toBe(true);
    expect(widgets().openOrder).toContain(id);
  });

  it('restore clears the hidden flag', () => {
    const id = s().openWidget({ agentId: A, type: 'files', title: 'Files' })!;
    s().minimizeWidget({ agentId: A, widgetInstanceId: id });
    s().restoreWidget({ agentId: A, widgetInstanceId: id });
    expect(widgets().byId[id].hidden).toBe(false);
    expect(typeof widgets().byId[id] === 'object').toBe(true);
  });

  it('close truly destroys the instance', () => {
    const id = s().openWidget({ agentId: A, type: 'files', title: 'Files' })!;
    s().closeWidget({ agentId: A, widgetInstanceId: id });
    expect(widgets().byId[id]).toBeUndefined();
    expect(widgets().openOrder).not.toContain(id);
  });

  it('exclusiveOpenWidget minimizes other widgets instead of destroying them', () => {
    const a = s().openWidget({ agentId: A, type: 'files', title: 'Files' })!;
    const b = s().openWidget({ agentId: A, type: 'notes', title: 'Notes' })!;

    s().exclusiveOpenWidget({ agentId: A, type: 'files', title: 'Files' });

    const w = widgets();
    expect(w.byId[a].hidden).toBeFalsy();    // focused → visible
    expect(w.byId[b].hidden).toBe(true);     // other → minimized, NOT destroyed
    expect(w.openOrder).toEqual(expect.arrayContaining([a, b]));
  });

  it('MAX_WIDGETS cap minimizes the oldest VISIBLE widget rather than deleting it', () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      ids.push(s().openWidget({ agentId: A, type: `t${i}`, title: `T${i}` })!);
    }
    const w = widgets();
    const visible = w.openOrder.filter((id) => !w.byId[id].hidden);
    expect(visible.length).toBe(6);            // cap holds for visible
    expect(w.openOrder.length).toBe(7);        // nothing destroyed
    expect(w.byId[ids[0]].hidden).toBe(true);  // oldest got minimized
  });
});
