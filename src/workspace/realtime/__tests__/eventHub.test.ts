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

  it('onConnected — the recovery arm — runs on EVERY connect, the first included; a drop and a deliberate reopen run nothing', () => {
    const onChange = vi.fn();
    const onConnected = vi.fn();
    subscribeProjectRecordChanges({ projectId: 'p1', onChange, onConnected });
    // The page loaded while the host booted: the hub's first open is the host answering.
    FakeEventSource.instances[0]!.onopen?.();
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    FakeEventSource.instances[0]!.frame('meta', 'connected', {});
    expect(onConnected).toHaveBeenCalledTimes(1);

    // A late channel reopens the connection deliberately: `connected` never flips.
    subscribeHub({ projectId: 'p1', channel: 'presence', onEvent: () => {} });
    vi.advanceTimersByTime(250);
    expect(FakeEventSource.instances).toHaveLength(2);
    FakeEventSource.instances[1]!.onopen?.();
    expect(onConnected).toHaveBeenCalledTimes(1);

    // The host restarts: the drop runs nothing, the connect after it runs it once.
    FakeEventSource.instances[1]!.onerror?.();
    expect(onConnected).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    FakeEventSource.instances[2]!.onopen?.();
    expect(onConnected).toHaveBeenCalledTimes(2);
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

describe('eventHub — a channel that attaches LATE to an open connection', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('still receives the opening replay: its first listener reopens the connection once (debounced)', () => {
    const presence: unknown[] = [];
    // The shell's own channels open the ONE connection; the server replays the
    // current presence right after `connected` — to listeners that exist THEN.
    subscribeHub({ projectId: 'p1', channel: 'runtime', onEvent: () => {} });
    const first = FakeEventSource.instances[0]!;
    first.onopen?.();
    first.frame('meta', 'connected', {});
    first.frame('presence', 'snapshot', { conversationId: 'c1', status: 'streaming' });

    // A package's presence client attaches afterwards (the provider slot mounts later).
    subscribeHub({ projectId: 'p1', channel: 'presence', onEvent: (name, payload) => presence.push([name, payload]) });
    subscribeHub({ projectId: 'p1', channel: 'conversation', onEvent: () => {} });
    expect(presence).toEqual([]);

    vi.advanceTimersByTime(250);
    // ONE reopen for the burst of late channels — the server replays to the new set.
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(first.closed).toBe(true);
    const second = FakeEventSource.instances[1]!;
    second.onopen?.();
    second.frame('meta', 'connected', {});
    second.frame('presence', 'snapshot', { conversationId: 'c1', status: 'streaming' });
    expect(presence).toEqual([['snapshot', { conversationId: 'c1', status: 'streaming' }]]);
  });

  it('paired controls: no reopen for a channel that attaches BEFORE the connection is up, nor for a second listener of a live channel', () => {
    subscribeHub({ projectId: 'p1', channel: 'runtime', onEvent: () => {} });
    // Still connecting: the replay has not been sent yet, so the late listener gets it.
    subscribeHub({ projectId: 'p1', channel: 'presence', onEvent: () => {} });
    vi.advanceTimersByTime(250);
    expect(FakeEventSource.instances).toHaveLength(1);

    FakeEventSource.instances[0]!.onopen?.();
    // A second listener of a channel that already has one: that channel's replay was delivered.
    const second = subscribeHub({ projectId: 'p1', channel: 'presence', onEvent: () => {} });
    vi.advanceTimersByTime(250);
    expect(FakeEventSource.instances).toHaveLength(1);
    // Churn guard: the channel's listeners all leave and one comes back (a remount) —
    // this connection already replayed to that channel, so no reconnect.
    second();
    const firstPresence = FakeEventSource.instances[0]!;
    expect(firstPresence.closed).toBe(false);
  });

  it('churn guard: a sole listener that remounts on an open connection does not reconnect', () => {
    subscribeHub({ projectId: 'p1', channel: 'runtime', onEvent: () => {} });
    const stop = subscribeHub({ projectId: 'p1', channel: 'workflow', onEvent: () => {} });
    FakeEventSource.instances[0]!.onopen?.();
    stop();
    subscribeHub({ projectId: 'p1', channel: 'workflow', onEvent: () => {} });
    vi.advanceTimersByTime(250);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

describe('eventHub — the staleness watchdog reads the server keepalive', () => {
  // The server keepalive is a `meta` frame every 25 s (an SSE comment would
  // dispatch nothing). An idle hub that receives it must stay ONE connection;
  // one that receives nothing for > 60 s is a dead socket and is reopened.
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function openIdleHub(): { flips: number[]; source: () => FakeEventSource } {
    const flips: number[] = [];
    subscribeHub({ projectId: 'p1', channel: 'conversation', onEvent: () => {}, onConnChange: () => flips.push(Date.now()) });
    const first = FakeEventSource.instances[0]!;
    first.onopen?.();
    first.frame('meta', 'connected', {});
    return { flips, source: () => first };
  }

  it('a keepalive frame every 25 s keeps the idle hub on its first connection for 5 minutes', () => {
    const hub = openIdleHub();
    for (let t = 0; t < 300_000; t += 25_000) {
      vi.advanceTimersByTime(25_000);
      hub.source().frame('meta', 'keepalive', {});
    }
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(hub.source().closed).toBe(false);
    expect(hub.flips).toHaveLength(1); // the opening edge only
  });

  it('paired control — no frame at all: the watchdog closes it after > 60 s and reopens', () => {
    const hub = openIdleHub();
    vi.advanceTimersByTime(80_000);
    expect(hub.source().closed).toBe(true);
    expect(FakeEventSource.instances.length).toBeGreaterThanOrEqual(2);
  });
});
