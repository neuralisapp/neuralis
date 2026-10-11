/**
 * The materializer turns a published event into rows, and every recipient —
 * addressed or following — meets every gate a reader of the event's route
 * would: not a sentinel, an active member of THIS project (the ONE member
 * chain), the package visible to them, the declaration's features, the owning
 * package's own predicate. Following never widens; muting always wins; the
 * row carries no `data` but a title, a dock key the dock can resolve, and an
 * opaque `nav`.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NeuralisEvent, PackageEventDeclaration, SessionContext } from '@neuralis/package-system/contracts';

const root = await mkdtemp(join(tmpdir(), 'nrs-materializer-'));
const projectsRoot = join(root, 'projects');

const mocks = vi.hoisted(() => ({
  resolveMember: vi.fn(),
  isPackageDefinitionVisible: vi.fn(),
  getPackage: vi.fn(),
}));

vi.mock('../../config/env', () => ({ getEnv: () => ({ appRoot: join(root, 'app'), projectsRoot }) }));
vi.mock('../../store/PlatformConfigStore', () => ({
  getPlatformConfigStore: () => ({ get: (key: string) => (key === 'notificationsMaxRowsPerUser' ? 500 : 30) }),
}));
vi.mock('../../store/ProjectStore', () => ({ listAllProjects: vi.fn(async () => []) }));
vi.mock('../../auth/memberSession', () => ({ resolveMember: mocks.resolveMember }));
vi.mock('../../auth/session', () => ({ getSessionUser: vi.fn() }));
vi.mock('../../packages/runtime', () => ({ getCommunityPackageRegistry: () => ({ getPackage: mocks.getPackage }) }));
vi.mock('../../packages/packageVisibility', () => ({ isPackageDefinitionVisible: mocks.isPackageDefinitionVisible }));

const { materializeEvent, mayReadEvent, notificationNav, notificationTitle } = await import('../materializer');
const { writeNotificationPrefs } = await import('../notificationPrefs');
const { resetNotificationStoreForTests } = await import('../notificationStore');
const { buildPackageDockItems } = await import('../../../workspace/packages/dockRuntime');

const PACKAGE = '@neuralis/agent-core';
const DOCK = 'agent-core-calendar-dock';

function declaration(overrides: Partial<PackageEventDeclaration> = {}): PackageEventDeclaration {
  return {
    id: 'workflow.run.failed',
    title: 'Workflow run failed',
    subject: 'workflow',
    dataSchema: { type: 'object', additionalProperties: false, properties: {} },
    requires: { features: ['workflow.read'] },
    notify: { default: 'on', tone: 'error' },
    dock: DOCK,
    ...overrides,
  };
}

function event(overrides: Partial<NeuralisEvent> = {}): NeuralisEvent {
  return {
    id: 'e1',
    type: 'agent-core.workflow.run.failed',
    source: PACKAGE,
    subject: 'workflow',
    subjectId: 'wf-1',
    projectId: 'p1',
    time: '2026-10-02T00:00:00.000Z',
    data: { title: 'Daily report', failureClass: 'timeout', secret: 'ERR: /data/projects/p1/.env leaked' },
    audience: { userIds: ['alice'] },
    ...overrides,
  };
}

/** Memberships: alice + carol in p1, bob only in p2. */
const MEMBERS: Record<string, string[]> = { alice: ['p1'], carol: ['p1'], bob: ['p2'], viewer: ['p1'] };

function session(userId: string, projectId: string): SessionContext {
  return {
    userId,
    projectId,
    role: 'member',
    priority: 20,
    grantedFeatures: userId === 'viewer' ? ['core.agents'] : ['workflow.read'],
  } as SessionContext;
}

let visibleTo: Set<string>;
let decl: PackageEventDeclaration;
const events = {
  subscribe: vi.fn(),
  isVisible: vi.fn(async (_event: NeuralisEvent, s: SessionContext) => visibleTo.has(s.userId)),
  declarationOf: vi.fn((type: string) => (type === 'agent-core.workflow.run.failed' ? { packageId: PACKAGE, type, declaration: decl } : undefined)),
  declarations: vi.fn(() => []),
};

async function lines(projectId: string, userId: string): Promise<Record<string, unknown>[]> {
  const path = join(projectsRoot, projectId, 'notifications', userId, 'log.jsonl');
  if (!existsSync(path)) return [];
  return (await readFile(path, 'utf-8')).trim().split('\n').map((line) => JSON.parse(line));
}

beforeEach(async () => {
  await rm(projectsRoot, { recursive: true, force: true });
  resetNotificationStoreForTests();
  visibleTo = new Set(['alice', 'carol', 'bob', 'viewer']);
  decl = declaration();
  mocks.getPackage.mockReturnValue({ id: PACKAGE });
  mocks.isPackageDefinitionVisible.mockReturnValue(true);
  mocks.resolveMember.mockImplementation(async (userId: string, projectId: string) =>
    MEMBERS[userId]?.includes(projectId) ? { project: { id: projectId }, session: session(userId, projectId) } : null,
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('recipients and gates', () => {
  it('the addressed member gets ONE row; the row never carries the event data', async () => {
    expect(await materializeEvent(events, event())).toBe(1);
    const [row] = await lines('p1', 'alice');
    expect(row).toMatchObject({ type: 'agent-core.workflow.run.failed', packageId: PACKAGE, dock: DOCK, tone: 'error', subjectId: 'wf-1' });
    expect(row!.title).toBe('Daily report — Workflow run failed');
    expect(JSON.stringify(row)).not.toMatch(/leaked|timeout|\/data\//);
  });

  it('two tenants: an addressed user who is not a member of THIS project gets nothing, anywhere', async () => {
    await materializeEvent(events, event({ audience: { userIds: ['alice', 'bob'] } }));
    expect(await lines('p1', 'alice')).toHaveLength(1);
    expect(existsSync(join(projectsRoot, 'p1', 'notifications', 'bob'))).toBe(false);
    expect(existsSync(join(projectsRoot, 'p2', 'notifications'))).toBe(false);
  });

  it('a sentinel is never a recipient — not even resolved', async () => {
    await materializeEvent(events, event({ audience: { userIds: ['__system__'] } }));
    expect(mocks.resolveMember).not.toHaveBeenCalled();
  });

  it('the package predicate saying no ⇒ no row', async () => {
    visibleTo = new Set();
    expect(await materializeEvent(events, event())).toBe(0);
    expect(await lines('p1', 'alice')).toHaveLength(0);
  });

  it('missing the declaration\'s features ⇒ no row, and the predicate is not even asked', async () => {
    expect(await materializeEvent(events, event({ audience: { userIds: ['viewer'] } }))).toBe(0);
    expect(events.isVisible).not.toHaveBeenCalled();
  });

  it('a package hidden from the member (base-access) ⇒ no row', async () => {
    mocks.isPackageDefinitionVisible.mockReturnValue(false);
    expect(await materializeEvent(events, event())).toBe(0);
  });

  it('an undeclared type is dropped', async () => {
    expect(await materializeEvent(events, event({ type: 'agent-core.nope' }))).toBe(0);
  });
});

describe('the verdict: only the session can DENY; what cannot be judged now is indeterminate', () => {
  const verdict = (s: SessionContext = session('alice', 'p1')) =>
    mayReadEvent(events, event(), decl, PACKAGE, s, { packageAccessFeature: undefined } as never);

  it('visible when every gate says yes', async () => {
    expect(await verdict()).toBe('visible');
  });

  it('denied: the package is loaded and hidden from them, or a required feature is missing', async () => {
    expect(await verdict(session('viewer', 'p1'))).toBe('denied');
    mocks.isPackageDefinitionVisible.mockReturnValue(false);
    expect(await verdict()).toBe('denied');
  });

  it('indeterminate: the package is not loaded, the predicate says no, or it throws — and none of them delivers', async () => {
    mocks.getPackage.mockReturnValue(undefined);
    expect(await verdict()).toBe('indeterminate');
    expect(await materializeEvent(events, event())).toBe(0);
    mocks.getPackage.mockReturnValue({ id: PACKAGE });
    visibleTo = new Set();
    expect(await verdict()).toBe('indeterminate');
    events.isVisible.mockImplementationOnce(async () => { throw new Error('index not loaded'); });
    expect(await verdict()).toBe('indeterminate');
  });
});

describe('settings', () => {
  it('a default-OFF event reaches only a follower', async () => {
    decl = declaration({ notify: { default: 'off', tone: 'info' } });
    expect(await materializeEvent(events, event())).toBe(0);
    await writeNotificationPrefs('p1', 'carol', { mute: [], follow: ['agent-core.workflow.run.failed'] });
    expect(await materializeEvent(events, event())).toBe(1);
    expect(await lines('p1', 'carol')).toHaveLength(1);
    expect(await lines('p1', 'alice')).toHaveLength(0);
  });

  it('following never widens: a follower the predicate refuses gets nothing', async () => {
    await writeNotificationPrefs('p1', 'carol', { mute: [], follow: ['agent-core.workflow.run.failed'] });
    visibleTo = new Set(['alice']);
    await materializeEvent(events, event());
    expect(await lines('p1', 'carol')).toHaveLength(0);
    expect(await lines('p1', 'alice')).toHaveLength(1);
  });

  it('muting wins over the default', async () => {
    await writeNotificationPrefs('p1', 'alice', { mute: ['agent-core.workflow.run.failed'], follow: [] });
    expect(await materializeEvent(events, event())).toBe(0);
  });
});

describe('the dock key resolves to a dock item', () => {
  it('`<manifest packageId>:<dock>` equals the key of the dock item the snapshot builds', async () => {
    await materializeEvent(events, event());
    const state = JSON.parse(await readFile(join(projectsRoot, 'p1', 'notifications', 'alice', 'state.json'), 'utf-8'));
    const [key] = Object.values(state.unread as Record<string, { dock: string }>).map((entry) => entry.dock);
    const items = buildPackageDockItems({
      packages: [],
      surfaces: [
        { kind: 'dock', id: DOCK, label: 'Calendar', packageId: PACKAGE, action: { type: 'open-widget', widget: 'calendar' } },
      ],
    } as never);
    expect(items.map((item) => `${item.packageId}:${item.id}`)).toContain(key);
    // Paired control: the wire-type prefix is NOT the dock's package id.
    expect(items.map((item) => `${item.packageId}:${item.id}`)).not.toContain(`agent-core:${DOCK}`);
  });
});

describe('title and nav', () => {
  it('compose from the declaration and an optional string data.title; nav is carried opaque', () => {
    expect(notificationTitle(declaration(), {})).toBe('Workflow run failed');
    expect(notificationTitle(declaration(), { title: 'x'.repeat(300) }).length).toBe(120);
    expect(notificationNav({ nav: { widgetType: 'calendar', initialState: { runId: 'r' } } })).toEqual({
      widgetType: 'calendar',
      initialState: { runId: 'r' },
    });
    expect(notificationNav({ nav: { widgetType: 7 } })).toBeUndefined();
    expect(notificationNav({ nav: 'calendar' })).toBeUndefined();
  });
});

describe('one subject in order; a recovery resolves the failure it clears', () => {
  const FAILED = 'agent-core.workflow.run.failed';
  const RECOVERED = 'agent-core.workflow.run.recovered';
  let recoveredDecl: PackageEventDeclaration;
  beforeEach(() => {
    recoveredDecl = declaration({ id: 'workflow.run.recovered', title: 'Workflow recovered',
      notify: { default: 'off', tone: 'success', clears: ['workflow.run.failed'] } });
    events.declarationOf.mockImplementation((type: string) =>
      type === FAILED ? { packageId: PACKAGE, type, declaration: decl }
        : type === RECOVERED ? { packageId: PACKAGE, type, declaration: recoveredDecl } : undefined);
  });
  const unread = async (userId: string) => {
    const path = join(projectsRoot, 'p1', 'notifications', userId, 'state.json');
    if (!existsSync(path)) return [] as string[];
    return Object.values(JSON.parse(await readFile(path, 'utf-8')).unread as Record<string, { key: string }>).map((e) => e.key);
  };

  it('failure → recovery → failure lands in publish order even when the first predicate is slow', async () => {
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
    events.isVisible.mockImplementationOnce(async (_e: NeuralisEvent, s: SessionContext) => { await slow; return visibleTo.has(s.userId); });
    const first = materializeEvent(events, event({ id: 'f1' }));
    const recovery = materializeEvent(events, event({ id: 'r1', type: RECOVERED }));
    const again = materializeEvent(events, event({ id: 'f2' }));
    // Another subject never waits behind the slow one.
    expect(await materializeEvent(events, event({ id: 'other', subjectId: 'wf-2' }))).toBe(1);
    releaseSlow();
    await Promise.all([first, recovery, again]);
    const rows = await lines('p1', 'alice');
    expect(rows.filter((row) => row.subjectId === 'wf-1').map((row) => row.type)).toEqual([FAILED, FAILED]);
    // The recovery resolved the first failure; the later failure is a NEW unread row.
    expect((await unread('alice')).filter((key) => key.endsWith('\u0000wf-1'))).toHaveLength(1);
  });

  it('reaches a former recipient who neither follows nor is addressed — and one who muted it — writing them no recovery row', async () => {
    await materializeEvent(events, event({ audience: { userIds: ['alice', 'carol'] } }));
    await writeNotificationPrefs('p1', 'carol', { mute: [RECOVERED], follow: [] });
    await materializeEvent(events, event({ type: RECOVERED, audience: { userIds: [] } }));
    expect(await unread('alice')).toEqual([]);
    expect(await unread('carol')).toEqual([]);
    expect((await lines('p1', 'alice')).map((row) => row.type)).toEqual([FAILED]);
    expect((await lines('p1', 'carol')).map((row) => row.type)).toEqual([FAILED]);
  });

  it('clears nothing on an undecided verdict, for a revoked member, or about another subject', async () => {
    await materializeEvent(events, event({ audience: { userIds: ['alice', 'carol'] } }));
    await materializeEvent(events, event({ subjectId: 'wf-2' }));
    visibleTo = new Set(['carol']);
    MEMBERS.carol = [];
    try {
      await materializeEvent(events, event({ type: RECOVERED, audience: { userIds: [] } }));
    } finally { MEMBERS.carol = ['p1']; }
    expect(await unread('alice')).toHaveLength(2);
    expect(await unread('carol')).toHaveLength(1);
  });
});
