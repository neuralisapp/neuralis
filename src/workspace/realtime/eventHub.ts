'use client';

/**
 * eventHub — ONE multiplexed EventSource for the whole workspace.
 *
 * Replaces the separate client EventSources (runtime, presence, workflow,
 * conversation, filesystem, project, notifications) with a single connection to the host
 * `GET /api/events` hub. On
 * HTTP/1.1 the browser caps ~6 connections per origin; the workspace used to
 * hold one always-on connection per channel PLUS one workflow connection per
 * chat widget, so during a chat stream the pool saturated and every other
 * widget's fetch queued for ~15s. With this hub a streaming workspace holds
 * ≤2 long-lived connections (this hub + the chat token stream).
 *
 * The server frames every event as `event: message` with JSON
 * `{ channel, name, payload }`; this client demuxes by `channel` and fans out to
 * the per-channel listeners the client wrappers register.
 *
 * Connection lifecycle is modeled on `projectPresenceClient` (refcounted
 * singleton, capped-backoff reconnect, staleness watchdog for WSL-resume
 * half-open sockets). The connection is keyed on `(projectId, agentId set)` —
 * filesystem subscribers register an `agentId`, and the union drives the
 * `?agentIds=` query so the server authorizes exactly the visible agents
 * (per-agent authz happens server-side). A set change reopens the connection
 * (debounced); presence/workflow/runtime/project carry no agent scope.
 */

import { createReconnectDetector } from '@neuralis/package-system/client';

/**
 * `notifications` is HOST-ONLY: the counts signal of the host notification
 * service (`{ projectId, unread: { total, byDock } }`, the recipient's own
 * connections only). It is deliberately absent from the kernel
 * `subscribeRealtime` union — no package subscribes to it; the shell does.
 */
export type HubChannel = 'runtime' | 'presence' | 'workflow' | 'filesystem' | 'conversation' | 'project' | 'notifications' | 'meta';

type ChannelListener = (name: string, payload: unknown) => void;
type ChangeListener = () => void;

interface HubFrame {
  channel: HubChannel;
  name: string;
  payload: unknown;
}

// Server keepalive is 25s; treat >60s without any event as a dead socket.
const STALE_MS = 60_000;
const WATCHDOG_MS = 15_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const AGENTSET_DEBOUNCE_MS = 250;

let activeProjectId: string | null = null;
let eventSource: EventSource | null = null;
let refCount = 0;
let connected = false;
let lastMessageAt = 0;
let reconnectDelay = RECONNECT_BASE_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let watchdog: ReturnType<typeof setInterval> | null = null;
let agentSetTimer: ReturnType<typeof setTimeout> | null = null;

// Per-channel listeners.
const channelListeners: Record<HubChannel, Set<ChannelListener>> = {
  runtime: new Set(),
  presence: new Set(),
  workflow: new Set(),
  filesystem: new Set(),
  conversation: new Set(),
  project: new Set(),
  notifications: new Set(),
  meta: new Set(),
};
const changeListeners = new Set<ChangeListener>();

// agentId → refcount (filesystem subscribers). The union of keys drives `?agentIds=`.
const agentRefs = new Map<string, number>();

function notifyChange(): void {
  for (const fn of changeListeners) {
    try { fn(); } catch { /* listener owns its errors */ }
  }
}

function setConnected(value: boolean): void {
  if (connected === value) return;
  connected = value;
  notifyChange();
}

function dispatch(frame: HubFrame): void {
  const set = channelListeners[frame.channel];
  if (!set) return;
  for (const fn of set) {
    try { fn(frame.name, frame.payload); } catch { /* listener owns its errors */ }
  }
}

function currentAgentIds(): string[] {
  return [...agentRefs.keys()].sort();
}

function buildUrl(projectId: string): string {
  const params = new URLSearchParams({ projectId });
  const agentIds = currentAgentIds();
  if (agentIds.length > 0) params.set('agentIds', agentIds.join(','));
  return `/api/events?${params.toString()}`;
}

function clearReconnectTimer(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

function scheduleReconnect(projectId: string): void {
  if (reconnectTimer || activeProjectId !== projectId) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (activeProjectId !== projectId) return;
    openSource(projectId);
  }, delay);
}

function openSource(projectId: string): void {
  if (eventSource) { eventSource.close(); eventSource = null; }
  lastMessageAt = Date.now();
  const es = new EventSource(buildUrl(projectId), { withCredentials: true });

  es.onopen = () => {
    reconnectDelay = RECONNECT_BASE_MS;
    lastMessageAt = Date.now();
    setConnected(true);
  };

  es.addEventListener('message', (raw: MessageEvent) => {
    lastMessageAt = Date.now();
    let frame: HubFrame | null = null;
    try {
      frame = JSON.parse(String(raw.data)) as HubFrame;
    } catch {
      return;
    }
    if (frame?.channel === 'meta') { setConnected(true); return; }
    if (frame) dispatch(frame);
  });

  es.onerror = () => {
    setConnected(false);
    if (activeProjectId !== projectId) return;
    if (eventSource) { eventSource.close(); eventSource = null; }
    scheduleReconnect(projectId);
  };

  eventSource = es;
}

function openConnection(projectId: string): void {
  if (eventSource && activeProjectId === projectId) return;
  closeConnection();
  activeProjectId = projectId;
  reconnectDelay = RECONNECT_BASE_MS;
  openSource(projectId);
  if (!watchdog) {
    watchdog = setInterval(() => {
      if (!activeProjectId) return;
      if (Date.now() - lastMessageAt > STALE_MS) {
        if (eventSource) { eventSource.close(); eventSource = null; }
        setConnected(false);
        scheduleReconnect(activeProjectId);
      }
    }, WATCHDOG_MS);
  }
}

function closeConnection(): void {
  clearReconnectTimer();
  if (agentSetTimer) { clearTimeout(agentSetTimer); agentSetTimer = null; }
  if (watchdog) { clearInterval(watchdog); watchdog = null; }
  if (eventSource) { eventSource.close(); eventSource = null; }
  activeProjectId = null;
  reconnectDelay = RECONNECT_BASE_MS;
  setConnected(false);
}

/** The agent set changed — reopen (debounced) so `?agentIds=` reflects it. */
function scheduleAgentSetReopen(): void {
  if (!activeProjectId) return;
  if (agentSetTimer) clearTimeout(agentSetTimer);
  agentSetTimer = setTimeout(() => {
    agentSetTimer = null;
    if (activeProjectId) openSource(activeProjectId);
  }, AGENTSET_DEBOUNCE_MS);
}

function addAgentRef(agentId: string): void {
  const next = (agentRefs.get(agentId) ?? 0) + 1;
  agentRefs.set(agentId, next);
  if (next === 1) scheduleAgentSetReopen(); // new agent in the set
}

function removeAgentRef(agentId: string): void {
  const next = (agentRefs.get(agentId) ?? 1) - 1;
  if (next <= 0) {
    agentRefs.delete(agentId);
    scheduleAgentSetReopen(); // agent left the set
  } else {
    agentRefs.set(agentId, next);
  }
}

export interface HubSubscription {
  projectId: string | null;
  channel: HubChannel;
  /** filesystem only: register this agentId into the connection's `?agentIds=` set. */
  agentId?: string;
  onEvent: ChannelListener;
  /** Optional: notified whenever the shared connection's `connected` state flips. */
  onConnChange?: ChangeListener;
}

/**
 * Subscribe to one hub channel. Returns an unsubscribe handle. The underlying
 * EventSource lives as long as ≥1 subscriber is attached; switching projectId
 * tears down + reopens. Public hook/client wrappers call this and keep their own
 * existing signatures, so widgets don't change.
 */
export function subscribeHub(sub: HubSubscription): () => void {
  channelListeners[sub.channel].add(sub.onEvent);
  if (sub.onConnChange) changeListeners.add(sub.onConnChange);
  if (sub.agentId) addAgentRef(sub.agentId);

  if (sub.projectId && sub.projectId !== activeProjectId) {
    openConnection(sub.projectId);
  } else if (!sub.projectId && activeProjectId && refCount === 0) {
    closeConnection();
  }
  refCount += 1;

  return () => {
    channelListeners[sub.channel].delete(sub.onEvent);
    if (sub.onConnChange) changeListeners.delete(sub.onConnChange);
    if (sub.agentId) removeAgentRef(sub.agentId);
    refCount -= 1;
    if (refCount <= 0) {
      refCount = 0;
      closeConnection();
    }
  };
}

/**
 * The workspace's own `project` feed: `onChange` runs once per burst of
 * `record_changed` frames (trailing debounce — a role edit + a member add, or a
 * package install granting several roles, is ONE re-read) and once when the hub
 * comes BACK after a drop, because the hub has no replay and a frame sent while
 * it was down is gone. Never on the first connect: the caller's initial load
 * covers that.
 */
export function subscribeProjectRecordChanges(params: {
  projectId: string;
  onChange: () => void;
  debounceMs?: number;
}): () => void {
  const debounceMs = params.debounceMs ?? 250;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const reconnect = createReconnectDetector(getHubConnected, params.onChange);
  const unsubscribe = subscribeHub({
    projectId: params.projectId,
    channel: 'project',
    onEvent: () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        params.onChange();
      }, debounceMs);
    },
    onConnChange: reconnect.onConnChange,
  });
  reconnect.arm();
  return () => {
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}

/** Current shared-connection liveness (all subscribers see the same state). */
export function getHubConnected(): boolean {
  return connected;
}

/** Test-only escape hatch. */
export function _resetEventHub(): void {
  closeConnection();
  refCount = 0;
  agentRefs.clear();
  for (const set of Object.values(channelListeners)) set.clear();
  changeListeners.clear();
}
