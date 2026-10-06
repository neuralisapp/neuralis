/**
 * The ONE `/api/events` hub demuxes frames by `channel`. The `project` channel
 * (a project record the caller belongs to changed) is a listener set like the
 * others; a frame naming a channel the client does not know is dropped, never
 * thrown on, so a server that grows a channel first cannot break an older tab.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetEventHub, subscribeHub, subscribeProjectRecordChanges } from '../eventHub';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, Array<(ev: MessageEvent) => void>>();
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (ev: MessageEvent) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  close(): void { this.closed = true; }

  frame(channel: string, name: string, payload: unknown): void {
    const data = JSON.stringify({ channel, name, payload });
    for (const fn of this.listeners.get('message') ?? []) fn({ data } as MessageEvent);
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  _resetEventHub();
  vi.unstubAllGlobals();
});

describe('eventHub — the project channel', () => {
  it('delivers a project frame to project subscribers only, over the ONE connection', () => {
    const project: unknown[] = [];
    const runtime: unknown[] = [];
    subscribeHub({ projectId: 'p1', channel: 'project', onEvent: (name, payload) => project.push([name, payload]) });
    subscribeHub({ projectId: 'p1', channel: 'runtime', onEvent: (name) => runtime.push(name) });

    expect(FakeEventSource.instances).toHaveLength(1);
    FakeEventSource.instances[0]!.frame('project', 'record_changed', { projectId: 'p2' });

    expect(project).toEqual([['record_changed', { projectId: 'p2' }]]);
    expect(runtime).toEqual([]);
  });

  it('ignores a frame on an unknown channel without disturbing the known ones', () => {
    const project: unknown[] = [];
    subscribeHub({ projectId: 'p1', channel: 'project', onEvent: (_name, payload) => project.push(payload) });
    const es = FakeEventSource.instances[0]!;

    expect(() => es.frame('not-a-channel', 'x', { projectId: 'p1' })).not.toThrow();
    es.frame('project', 'record_changed', { projectId: 'p1' });

    expect(project).toEqual([{ projectId: 'p1' }]);
  });

  it('unsubscribe stops delivery', () => {
    const project: unknown[] = [];
    const keep = subscribeHub({ projectId: 'p1', channel: 'runtime', onEvent: () => {} });
    const stop = subscribeHub({ projectId: 'p1', channel: 'project', onEvent: (_n, payload) => project.push(payload) });
    stop();
    FakeEventSource.instances[0]!.frame('project', 'record_changed', { projectId: 'p1' });
    expect(project).toEqual([]);
    keep();
  });
});

describe('subscribeProjectRecordChanges — the workspace project feed', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a burst of frames is ONE re-read after the debounce', () => {
    const onChange = vi.fn();
    subscribeProjectRecordChanges({ projectId: 'p1', onChange });
    const es = FakeEventSource.instances[0]!;
    es.onopen?.();
    es.frame('project', 'record_changed', { projectId: 'p1' });
    es.frame('project', 'record_changed', { projectId: 'p2' });
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('the first connect re-reads nothing; the hub coming BACK after a drop re-reads once (no replay)', () => {
    const onChange = vi.fn();
    subscribeProjectRecordChanges({ projectId: 'p1', onChange });
    FakeEventSource.instances[0]!.onopen?.();
    expect(onChange).not.toHaveBeenCalled();

    // Drop: a frame sent now is lost. The hub reconnects on its backoff.
    FakeEventSource.instances[0]!.onerror?.();
    vi.advanceTimersByTime(1_000);
    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.instances[1]!.onopen?.();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe cancels a pending debounced re-read', () => {
    const onChange = vi.fn();
    const stop = subscribeProjectRecordChanges({ projectId: 'p1', onChange });
    FakeEventSource.instances[0]!.frame('project', 'record_changed', { projectId: 'p1' });
    stop();
    vi.advanceTimersByTime(1_000);
    expect(onChange).not.toHaveBeenCalled();
  });
});
