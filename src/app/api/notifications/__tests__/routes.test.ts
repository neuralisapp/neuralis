/**
 * The notification routes: every one resolves the caller through the ONE
 * member chain for the `X-Project-Id` project; the list RE-JUDGES every stored
 * row with the caller's CURRENT session (a revoked row is silently left out);
 * counts are numbers; the settings catalog names only what the caller could
 * receive, and a PUT cannot follow anything outside it.
 */

import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NeuralisEvent, PackageEventDeclaration, SessionContext } from '@neuralis/package-system/contracts';

const root = await mkdtemp(join(tmpdir(), 'nrs-notification-routes-'));

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  resolveMember: vi.fn(),
  resolveActiveUser: vi.fn(),
  listProjectsForUser: vi.fn(),
  isPackageDefinitionVisible: vi.fn(),
  missingPackages: new Set<string>(),
}));

vi.mock('@/server/config/env', () => ({ getEnv: () => ({ appRoot: join(root, 'app'), projectsRoot: join(root, 'projects') }) }));
vi.mock('@/server/store/PlatformConfigStore', () => ({ getPlatformConfigStore: () => ({ get: (k: string) => (k === 'notificationsMaxRowsPerUser' ? 500 : 30) }) }));
vi.mock('@/server/store/ProjectStore', () => ({ listProjectsForUser: mocks.listProjectsForUser, listAllProjects: vi.fn(async () => []) }));
vi.mock('@/server/auth/session', () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock('@/server/auth/memberSession', () => ({ resolveMember: mocks.resolveMember, resolveActiveUser: mocks.resolveActiveUser }));
vi.mock('@/server/packages/runtime', () => ({
  getCommunityPackageRegistry: () => ({ getPackage: (id: string) => (mocks.missingPackages.has(id) ? undefined : { id }) }),
}));
vi.mock('@/server/packages/packageVisibility', () => ({ isPackageDefinitionVisible: mocks.isPackageDefinitionVisible }));

const FAILED: PackageEventDeclaration = {
  id: 'workflow.run.failed',
  title: 'Workflow run failed',
  subject: 'workflow',
  dataSchema: { type: 'object' },
  requires: { features: ['workflow.read'] },
  notify: { default: 'on', tone: 'error' },
  dock: 'cal',
};
const STARTED: PackageEventDeclaration = { ...FAILED, id: 'workflow.run.started', notify: { default: 'off', tone: 'info' } };
const ADMIN_ONLY: PackageEventDeclaration = { ...FAILED, id: 'audit.thing', requires: { features: ['platform.audit'] } };
const DECLS = [
  { packageId: '@neuralis/agent-core', type: 'agent-core.workflow.run.failed', declaration: FAILED },
  { packageId: '@neuralis/agent-core', type: 'agent-core.workflow.run.started', declaration: STARTED },
  { packageId: '@neuralis/agent-core', type: 'agent-core.audit.thing', declaration: ADMIN_ONLY },
];
let hidden: Set<string>;
let throwing: Set<string>;
const events = {
  subscribe: vi.fn(),
  isVisible: vi.fn(async (e: NeuralisEvent) => {
    if (throwing.has(e.subjectId)) throw new Error('index not loaded');
    return !hidden.has(e.subjectId);
  }),
  declarationOf: (type: string) => DECLS.find((d) => d.type === type),
  declarations: () => DECLS,
};

vi.mock('@/server/host/bootstrap', () => ({ getRuntime: async () => ({ events: () => events }) }));

const { deliverNotification } = await import('@/server/notifications/notificationStore');
const listRoute = await import('../route');
const countsRoute = await import('../counts/route');
const readRoute = await import('../read/route');
const clearRoute = await import('../clear/route');
const prefsRoute = await import('../preferences/route');

const session: SessionContext = { userId: 'me', projectId: 'p1', role: 'member', priority: 20, grantedFeatures: ['workflow.read'] } as SessionContext;

function req(path: string, init?: { method?: string; body?: unknown; project?: string | null }) {
  const headers = new Headers();
  if (init?.project !== null) headers.set('x-project-id', init?.project ?? 'p1');
  return new NextRequest(`http://localhost${path}`, {
    method: init?.method ?? 'GET',
    headers,
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}

const row = (subjectId: string, type = 'agent-core.workflow.run.failed') => ({
  type,
  packageId: '@neuralis/agent-core',
  dock: 'cal',
  subjectId,
  tone: 'error' as const,
  title: 'x',
});

beforeEach(async () => {
  await rm(join(root, 'projects'), { recursive: true, force: true });
  hidden = new Set();
  throwing = new Set();
  mocks.missingPackages.clear();
  mocks.getSessionUser.mockResolvedValue({ id: 'me', email: 'me@x.co', name: 'Me' });
  mocks.resolveActiveUser.mockResolvedValue({ id: 'me', status: 'active' });
  mocks.resolveMember.mockImplementation(async (userId: string, projectId: string) =>
    projectId === 'p1' ? { project: { id: 'p1' }, session: { ...session, userId } } : null,
  );
  mocks.isPackageDefinitionVisible.mockReturnValue(true);
  mocks.listProjectsForUser.mockResolvedValue([{ id: 'p1' }, { id: 'p3' }]);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('GET /api/notifications', () => {
  it('re-judges every row on read: a revoked subject and an undeclared type are silently left out', async () => {
    await deliverNotification('p1', 'me', row('wf-visible'));
    await deliverNotification('p1', 'me', row('wf-revoked'));
    await deliverNotification('p1', 'me', row('wf-gone', 'agent-core.removed.type'));
    hidden = new Set(['wf-revoked']);
    const res = await listRoute.GET(req('/api/notifications'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ subjectId: string; read: boolean }> };
    expect(body.rows.map((r) => r.subjectId)).toEqual(['wf-visible']);
    expect(body.rows[0]!.read).toBe(false);
  });

  it('paired control: the same row is served while the predicate says yes', async () => {
    await deliverNotification('p1', 'me', row('wf-revoked'));
    const body = (await (await listRoute.GET(req('/api/notifications'))).json()) as { rows: unknown[] };
    expect(body.rows).toHaveLength(1);
  });

  it('a non-member is refused before any read; no project header is a 400', async () => {
    expect((await listRoute.GET(req('/api/notifications', { project: 'p2' }))).status).toBe(403);
    expect((await listRoute.GET(req('/api/notifications', { project: null }))).status).toBe(400);
    mocks.getSessionUser.mockResolvedValueOnce(null);
    expect((await listRoute.GET(req('/api/notifications'))).status).toBe(401);
  });

  it('a sentinel project id is refused', async () => {
    expect((await listRoute.GET(req('/api/notifications', { project: '__system__' }))).status).toBe(403);
    expect(mocks.resolveMember).not.toHaveBeenCalledWith('me', '__system__');
  });
});

describe('counts + read', () => {
  it('counts for the project, then for every membership (numbers only)', async () => {
    await deliverNotification('p1', 'me', row('a'));
    await deliverNotification('p3', 'me', row('b'));
    await deliverNotification('p3', 'me', row('c'));
    const current = await (await countsRoute.GET(req('/api/notifications/counts'))).json();
    expect(current).toEqual({ projectId: 'p1', unread: { total: 1, byDock: { '@neuralis/agent-core:cal': 1 } } });
    const all = await (await countsRoute.GET(req('/api/notifications/counts?scope=all', { project: null }))).json();
    expect(all).toEqual({ byProject: { p1: 1, p3: 2 } });
  });

  it('read by dock / all; a body that is not exactly one selector is a 400', async () => {
    await deliverNotification('p1', 'me', row('a'));
    const res = await readRoute.POST(req('/api/notifications/read', { method: 'POST', body: { dock: '@neuralis/agent-core:cal' } }));
    expect(await res.json()).toEqual({ projectId: 'p1', unread: { total: 0, byDock: {} } });
    expect((await readRoute.POST(req('/api/notifications/read', { method: 'POST', body: { all: true, dock: 'x' } }))).status).toBe(400);
    expect((await readRoute.POST(req('/api/notifications/read', { method: 'POST', body: { ids: [] } }))).status).toBe(400);
  });
});

describe('preferences', () => {
  it('the catalog names only types the caller could receive', async () => {
    const body = (await (await prefsRoute.GET(req('/api/notifications/preferences'))).json()) as {
      catalog: Array<{ type: string; defaultOn: boolean }>;
    };
    expect(body.catalog.map((entry) => entry.type)).toEqual([
      'agent-core.workflow.run.failed',
      'agent-core.workflow.run.started',
    ]);
    expect(body.catalog[1]!.defaultOn).toBe(false);
  });

  it('a hidden package\'s types are not in the catalog', async () => {
    mocks.isPackageDefinitionVisible.mockReturnValue(false);
    const body = (await (await prefsRoute.GET(req('/api/notifications/preferences'))).json()) as { catalog: unknown[] };
    expect(body.catalog).toEqual([]);
  });

  it('PUT cannot follow outside the catalog', async () => {
    const res = await prefsRoute.PUT(req('/api/notifications/preferences', {
      method: 'PUT',
      body: { mute: ['agent-core.workflow.run.failed'], follow: ['agent-core.workflow.run.started', 'agent-core.audit.thing', 'foreign.type'] },
    }));
    expect(await res.json()).toEqual({
      prefs: { mute: ['agent-core.workflow.run.failed'], follow: ['agent-core.workflow.run.started'] },
    });
  });
});

const statePath = (userId: string) => join(root, 'projects', 'p1', 'notifications', userId, 'state.json');
const unreadIds = async (userId = 'me'): Promise<string[]> =>
  Object.keys(JSON.parse(await readFile(statePath(userId), 'utf-8')).unread);
const list = async (query = '') =>
  (await (await listRoute.GET(req(`/api/notifications${query}`))).json()) as {
    rows?: Array<{ subjectId: string; read: boolean }>;
    groups?: Array<{ key: string; packageId: string; dock?: string; total: number; unread: number; rows: Array<{ subjectId: string }> }>;
  };

describe('the list re-judges; only a DEFINITIVE denial drops the unread entry', () => {
  it('the owning predicate saying no (or throwing) HIDES the row and keeps it unread', async () => {
    await deliverNotification('p1', 'me', row('wf-private'));
    await deliverNotification('p1', 'me', row('wf-loading'));
    hidden = new Set(['wf-private']);
    throwing = new Set(['wf-loading']);
    expect((await list('?unread=1')).rows).toEqual([]);
    expect(await unreadIds()).toHaveLength(2);
  });

  it('a package that is not loaded, or an undeclared type, HIDES the row and keeps it unread', async () => {
    await deliverNotification('p1', 'me', row('wf-1'));
    await deliverNotification('p1', 'me', row('wf-2', 'agent-core.removed.type'));
    mocks.missingPackages.add('@neuralis/agent-core');
    expect((await list()).rows).toEqual([]);
    expect(await unreadIds()).toHaveLength(2);
  });

  it('a revoked feature HIDES the row and drops its unread entry — the badge number heals', async () => {
    await deliverNotification('p1', 'me', row('wf-1'));
    mocks.resolveMember.mockImplementation(async (userId: string, projectId: string) =>
      projectId === 'p1' ? { project: { id: 'p1' }, session: { ...session, userId, grantedFeatures: [] } } : null,
    );
    expect((await list('?unread=1')).rows).toEqual([]);
    expect(await unreadIds()).toEqual([]);
    const counts = await (await countsRoute.GET(req('/api/notifications/counts'))).json();
    expect(counts.unread).toEqual({ total: 0, byDock: {} });
  });

  it('a package hidden from the caller HIDES the row and drops its unread entry', async () => {
    await deliverNotification('p1', 'me', row('wf-1'));
    mocks.isPackageDefinitionVisible.mockReturnValue(false);
    expect((await list()).rows).toEqual([]);
    expect(await unreadIds()).toEqual([]);
  });

  it('paired control: a visible unread row is served and STAYS unread after the read', async () => {
    await deliverNotification('p1', 'me', row('wf-1'));
    expect((await list('?unread=1')).rows?.map((r) => r.read)).toEqual([false]);
    expect(await unreadIds()).toHaveLength(1);
  });
});

describe('GET /api/notifications?groups= and ?group=', () => {
  const files = (subjectId: string) => ({ ...row(subjectId), type: 'agent-core.workflow.run.started', dock: 'files' });

  it('groups by app in the order of the newest row; total and unread count VISIBLE entries; rows ≤ n while total > n', async () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) await deliverNotification('p1', 'me', row(id));
    await deliverNotification('p1', 'me', files('s1'));
    await deliverNotification('p1', 'me', row('hidden-one'));
    hidden = new Set(['hidden-one']);
    const body = await list('?groups=4');
    expect(body.groups?.map((g) => g.key)).toEqual(['@neuralis/agent-core:files', '@neuralis/agent-core:cal']);
    const cal = body.groups![1]!;
    expect(cal).toMatchObject({ packageId: '@neuralis/agent-core', dock: 'cal', total: 6, unread: 6 });
    expect(cal.rows.map((r) => r.subjectId)).toEqual(['f', 'e', 'd', 'c']);
  });

  it('groups= with unread=1: `total` is every visible entry a clear would delete — read ones included; rows are unread; an app with nothing unread is left out', async () => {
    for (const id of ['a', 'b', 'c']) await deliverNotification('p1', 'me', row(id));
    await deliverNotification('p1', 'me', files('s1'));
    await readRoute.POST(req('/api/notifications/read', { method: 'POST', body: { dock: '@neuralis/agent-core:files' } }));
    const [first] = (await list('?group=%40neuralis%2Fagent-core%3Acal')).rows!;
    await readRoute.POST(req('/api/notifications/read', { method: 'POST', body: { ids: [(first as unknown as { id: string }).id] } }));
    const body = await list('?groups=4&unread=1');
    expect(body.groups?.map((g) => g.key)).toEqual(['@neuralis/agent-core:cal']);
    expect(body.groups![0]).toMatchObject({ total: 3, unread: 2 });
    expect(body.groups![0]!.rows.map((r) => r.subjectId)).toEqual(['b', 'a']);
  });

  it('group= lists one app; unread=1 narrows it', async () => {
    await deliverNotification('p1', 'me', row('a'));
    await deliverNotification('p1', 'me', files('s1'));
    expect((await list('?group=%40neuralis%2Fagent-core%3Afiles')).rows?.map((r) => r.subjectId)).toEqual(['s1']);
    await readRoute.POST(req('/api/notifications/read', { method: 'POST', body: { all: true } }));
    expect((await list('?group=%40neuralis%2Fagent-core%3Afiles&unread=1')).rows).toEqual([]);
  });

  it('a bad group / groups parameter is a 400', async () => {
    for (const query of ['?group=', `?group=${'x'.repeat(301)}`, '?groups=0', '?groups=31', '?groups=x', '?groups=4&group=a']) {
      expect((await listRoute.GET(req(`/api/notifications${query}`))).status).toBe(400);
    }
  });
});

describe('POST /api/notifications/clear', () => {
  const clear = (body: unknown, project?: string | null) =>
    clearRoute.POST(req('/api/notifications/clear', { method: 'POST', body, project }));

  it('deletes the caller\'s rows of one app, unread included, and answers the counts — never a removed count', async () => {
    await deliverNotification('p1', 'me', row('a'));
    await deliverNotification('p1', 'me', { ...row('s1'), dock: 'files' });
    const res = await clear({ group: '@neuralis/agent-core:cal' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ projectId: 'p1', unread: { total: 1, byDock: { '@neuralis/agent-core:files': 1 } } });
    expect((await list()).rows?.map((r) => r.subjectId)).toEqual(['s1']);
  });

  it('two users: B\'s notifications are byte-identical after A clears all', async () => {
    await deliverNotification('p1', 'me', row('a'));
    await deliverNotification('p1', 'other', row('a'));
    const dir = join(root, 'projects', 'p1', 'notifications', 'other');
    const before = [await readFile(join(dir, 'log.jsonl'), 'utf-8'), await readFile(join(dir, 'state.json'), 'utf-8')];
    expect((await clear({ all: true })).status).toBe(200);
    expect([await readFile(join(dir, 'log.jsonl'), 'utf-8'), await readFile(join(dir, 'state.json'), 'utf-8')]).toEqual(before);
    expect((await list()).rows).toEqual([]);
  });

  it('a non-member and a sentinel project are refused; a body that is not exactly one selector is a 400', async () => {
    expect((await clear({ all: true }, 'p2')).status).toBe(403);
    expect((await clear({ all: true }, '__system__')).status).toBe(403);
    expect((await clear({ all: true }, null)).status).toBe(400);
    for (const body of [{}, { all: true, group: 'x' }, { group: '' }, { group: 'x'.repeat(301) }, { all: 'yes' }, [], 'all']) {
      expect((await clear(body)).status).toBe(400);
    }
  });
});
