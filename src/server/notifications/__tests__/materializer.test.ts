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
