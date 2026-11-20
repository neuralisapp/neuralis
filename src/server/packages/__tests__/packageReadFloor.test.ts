/**
 * The host's read floor: the snapshot surfaces a loaded source package reaches
 * only a caller who may read it, a project-less snapshot carries no candidate,
 * no client file descriptor carries a machine path, and the verdict is asked
 * ONCE per request through the existing `package-source-roots` contract —
 * failing closed when it cannot be read.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { packageInstanceId } from '@neuralis/package-system/contracts';
import { contributionFileKey, manifestFileKey } from '@neuralis/package-system/access';

const services = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../runtime', () => ({
  getCommunityPackageRegistry: vi.fn(),
  getCommunityPackageRuntime: vi.fn(),
}));
vi.mock('../PackageRuntimeManager', () => ({ getPackageRuntimeManager: vi.fn() }));
vi.mock('../../host/bootstrap', () => ({
  BUILTIN_PACKAGE_IDS: new Set(['@neuralis/agent-core']),
  getRuntime: async () => ({ services }),
}));
vi.mock('../../store/ProjectStore', () => ({ getProjectById: async () => ({ id: 'p1' }) }));
vi.mock('../../logging/setup', () => ({ getLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));

const SRC = packageInstanceId({ originUri: 'repo://tools', projectId: 'p1', scope: { kind: 'project' } });

const full = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('@neuralis/package-system', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@neuralis/package-system')>()),
  PackageSnapshotService: vi.fn().mockImplementation(function () {
    return { getFullSnapshot: () => full.value, getRevision: () => 'rev', isUpToDate: () => false };
  }),
}));

import { getPackageSnapshot, getWidgetSnapshot, getDockSnapshot, getCommandSnapshot } from '../snapshot';
import { getCommunityPackageRegistry, getCommunityPackageRuntime } from '../runtime';
import { getPackageRuntimeManager } from '../PackageRuntimeManager';
import { loadPackageReadVerdict, loadReadHiddenView, loadVisibleDisabledPackageIds } from '../packageReadFloor';
import { resolveVisiblePackageSurface } from '../packageVisibility';
import { isEventPackageVisible } from '../../notifications/materializer';

function skill(id: string, body: string) {
  return { id, category: 'skill', path: `skills/${id}/SKILL.md`, title: `${id}-TITLE`, content: body, mimeType: 'text/markdown', osUri: `/home/bob/tools/skills/${id}/SKILL.md` };
}

const definition = {
  id: SRC,
  name: 'SECRET-PACKAGE',
  version: '1',
  source: { kind: 'source' },
  tools: [],
  skills: [skill('alpha', 'ALPHA-BODY'), skill('bravo', 'BRAVO-BODY')],
  resources: [],
  app: { surfaces: [{ kind: 'widget', type: 'SECRET-WIDGET', title: 'w', component: { renderer: 'iframe', url: 'ui/index.html' } }] },
};

const NOTHING = { hiddenPackageIds: new Set<string>(), hiddenFileKeys: new Set<string>() };
const WHOLE = { hiddenPackageIds: new Set([SRC]), hiddenFileKeys: new Set<string>() };

beforeEach(() => {
  delete (globalThis as Record<string, unknown>).__neuralis_snapshot_service__;
  full.value = {
    revision: 'rev',
    packages: [{ id: SRC, name: 'SECRET-PACKAGE', description: 'SECRET-DESC', version: '1', status: 'active', registeredAt: 0 }],
    tools: [],
    surfaces: [
      { kind: 'widget', id: 'w', type: 'SECRET-WIDGET', packageId: SRC },
      { kind: 'dock', id: 'd', label: 'SECRET-DOCK', packageId: SRC, action: { type: 'command', command: 'deploy' } },
    ],
    commands: [{ packageId: SRC, id: 'deploy', name: 'SECRET-COMMAND' }],
    skills: [], instructions: [], rules: [], agents: [], docs: [], workflows: [], team: [], resources: [], connectors: [],
  };
  vi.mocked(getCommunityPackageRegistry).mockReturnValue({ listPackages: () => [definition], getPackage: (id: string) => (id === SRC ? definition : undefined) } as never);
  vi.mocked(getPackageRuntimeManager).mockReturnValue({
    getProjectPackageIds: (projectId: string) => new Set(projectId === 'p1' ? [SRC] : []),
    getPackageOwnerScope: () => undefined,
    getPackageOwnerOrigin: () => undefined,
    getPackageManifestId: () => undefined,
    getLoader: () => ({ getStatus: () => undefined }),
  } as never);
  vi.mocked(getCommunityPackageRuntime).mockReturnValue({ getSnapshot: () => getPackageSnapshot({ host: 'neuralis-workspace', projectId: 'p1', readHidden: NOTHING }) } as never);
  services.get.mockReset();
});

const scope = (readHidden: typeof NOTHING) => ({ host: 'neuralis-workspace' as const, projectId: 'p1', userId: 'u', readHidden });

describe('buildScopedSnapshot under the read floor', () => {
  it('the reader gets the package, its skill content, widget, dock and command — the non-reader none of it', () => {
    const reader = JSON.stringify([getPackageSnapshot(scope(NOTHING)), getWidgetSnapshot(scope(NOTHING)), getDockSnapshot(scope(NOTHING)), getCommandSnapshot(scope(NOTHING))]);
    const other = JSON.stringify([getPackageSnapshot(scope(WHOLE)), getWidgetSnapshot(scope(WHOLE)), getDockSnapshot(scope(WHOLE)), getCommandSnapshot(scope(WHOLE))]);
    for (const s of ['SECRET-PACKAGE', 'BRAVO-BODY', 'SECRET-WIDGET', 'SECRET-DOCK', 'SECRET-COMMAND']) {
      expect(reader, s).toContain(s);
      expect(other, s).not.toContain(s);
    }
  });

  it('partial: a hidden skill file is gone, its sibling and the manifest surfaces stay', () => {
    const view = { hiddenPackageIds: new Set<string>(), hiddenFileKeys: new Set([contributionFileKey(SRC, 'skill', 'bravo')]) };
    const text = JSON.stringify(getPackageSnapshot(scope(view)));
    expect(text).toContain('ALPHA-BODY');
    expect(text).toContain('SECRET-WIDGET');
    expect(text).not.toContain('BRAVO-BODY');
  });

  it('a hidden manifest takes the widget, dock and command, and the package lists under its folder name', () => {
    const view = { hiddenPackageIds: new Set<string>(), hiddenFileKeys: new Set([manifestFileKey(SRC)]) };
    const text = JSON.stringify([getPackageSnapshot(scope(view)), getWidgetSnapshot(scope(view)), getDockSnapshot(scope(view))]);
    expect(text).toContain('ALPHA-BODY');
    for (const s of ['SECRET-PACKAGE', 'SECRET-DESC', 'SECRET-WIDGET', 'SECRET-DOCK', 'SECRET-COMMAND']) expect(text, s).not.toContain(s);
  });

  it('a project-less snapshot (first paint) carries no source package, whatever the view says', () => {
    const text = JSON.stringify(getPackageSnapshot({ host: 'neuralis-workspace', readHidden: NOTHING }, []));
    expect(text).not.toContain(SRC);
    expect(text).not.toContain('SECRET');
  });

  it('a project-less snapshot carries no project-owned package at all — a drop neither — and keeps builtins', () => {
    const DROP = packageInstanceId({ originUri: 'packages://dropped', projectId: 'p1', scope: { kind: 'project' } });
    const drop = { ...definition, id: DROP, name: 'DROP-PACKAGE', skills: [skill('drop', 'DROP-BODY')], app: undefined };
    const builtin = { ...definition, id: '@neuralis/agent-core', name: 'BUILTIN-PACKAGE', skills: [skill('core', 'CORE-BODY')], app: undefined };
    const all = [definition, drop, builtin];
    vi.mocked(getCommunityPackageRegistry).mockReturnValue({ listPackages: () => all, getPackage: (id: string) => all.find((d) => d.id === id) } as never);
    const manager = getPackageRuntimeManager();
    vi.mocked(getPackageRuntimeManager).mockReturnValue({ ...manager, getProjectPackageIds: (projectId: string) => new Set(projectId === 'p1' ? [SRC, DROP] : []) } as never);
    (full.value as { packages: unknown[] }).packages.push(
      { id: DROP, name: 'DROP-PACKAGE', version: '1', status: 'active', registeredAt: 0 },
      { id: '@neuralis/agent-core', name: 'BUILTIN-PACKAGE', version: '1', status: 'active', registeredAt: 0 },
    );
    const firstPaint = JSON.stringify(getPackageSnapshot({ host: 'neuralis-workspace', readHidden: NOTHING }, []));
    const member = JSON.stringify(getPackageSnapshot(scope(NOTHING)));
    expect(member).toContain('DROP-PACKAGE');
    expect(firstPaint).toContain('BUILTIN-PACKAGE');
    for (const s of ['DROP-PACKAGE', 'drop-TITLE', DROP]) expect(firstPaint, s).not.toContain(s);
  });

  it('no client file descriptor carries a machine path — for every caller', () => {
    const snap = getPackageSnapshot(scope(NOTHING));
    expect(snap.skills.length).toBe(2);
    expect(JSON.stringify(snap)).not.toContain('/home/bob');
    expect(snap.skills.every((file) => !('osUri' in file))).toBe(true);
  });
});

describe('loadReadHiddenView — one verdict per request, fail closed', () => {
  it('asks the source-roots service ONCE with the caller\'s strength keys and every planned uri', async () => {
    const readablePackageUris = vi.fn(async (_caller: unknown, uris: readonly string[]) => new Set(uris.filter((u) => !u.includes('bravo'))));
    services.get.mockReturnValue({ readablePackageUris });
    const view = await loadReadHiddenView({ userId: 'u', role: 'member', priority: 1, rolePriorities: { member: 3 }, grantedFeatures: [] }, 'p1');
    expect(readablePackageUris).toHaveBeenCalledTimes(1);
    expect(readablePackageUris.mock.calls[0]![0]).toMatchObject({ userId: 'u', projectId: 'p1', priority: 1, rolePriorities: { member: 3 } });
    expect(readablePackageUris.mock.calls[0]![1]).toEqual(expect.arrayContaining(['repo://tools/package.json', 'repo://tools/skills/bravo/SKILL.md']));
    expect([...view.hiddenFileKeys]).toEqual([contributionFileKey(SRC, 'skill', 'bravo')]);
  });

  it('no service or a throwing one hides the package; the single-package verdict says it was not judged', async () => {
    services.get.mockReturnValue(undefined);
    expect((await loadReadHiddenView({ userId: 'u', role: 'member', priority: 3, rolePriorities: undefined, grantedFeatures: [] }, 'p1')).hiddenPackageIds).toEqual(new Set([SRC]));
    services.get.mockReturnValue({ readablePackageUris: async () => { throw new Error('down'); } });
    expect(await loadPackageReadVerdict({ userId: 'u', role: 'member', priority: 3, rolePriorities: undefined, grantedFeatures: [] }, 'p1', SRC)).toBe('unjudged');
    services.get.mockReturnValue({ readablePackageUris: async () => new Set<string>() });
    expect(await loadPackageReadVerdict({ userId: 'u', role: 'member', priority: 3, rolePriorities: undefined, grantedFeatures: [] }, 'p1', SRC)).toBe('hidden');
  });

  it('a project with no candidate asks nothing', async () => {
    const readablePackageUris = vi.fn();
    services.get.mockReturnValue({ readablePackageUris });
    const view = await loadReadHiddenView({ userId: 'u', role: 'member', priority: 3, rolePriorities: undefined, grantedFeatures: [] }, 'p2');
    expect(readablePackageUris).not.toHaveBeenCalled();
    expect(view.hiddenPackageIds.size + view.hiddenFileKeys.size).toBe(0);
  });
});

describe('loadVisibleDisabledPackageIds — a switched-off source\'s folders: source-level read AND the manifest\'s path verdict, fail closed', () => {
  const member = { userId: 'u', agentId: 'a1', role: 'member', priority: 3, rolePriorities: { member: 3 }, grantedFeatures: ['files.read'] };
  const caller = { userId: 'u', projectId: 'p1', agentId: 'a1', role: 'member', priority: 3, rolePriorities: { member: 3 }, grantedFeatures: ['files.read'] };
  const row = (originUri: string, sourceSlug: string) => ({ packageId: packageInstanceId({ originUri, projectId: 'p1', scope: { kind: 'project' } }), sourceSlug, originUri });
  const OPEN = row('off://pkgs/open', 'off');
  const DENIED = row('off://pkgs/denied', 'off');
  const PRIVATE = row('mine://pkgs/secret', 'mine');
  const DROP = row('packages://drop-a', 'packages');

  it('a member the path axis denies a folder\'s manifest does not see it, though the source is admitted (paired: the readable sibling)', async () => {
    const listDisabledSourceSlugs = vi.fn(async () => ['off', 'packages']);
    const readablePackageUris = vi.fn(async (_c: unknown, uris: readonly string[]) => new Set(uris.filter((u) => !u.includes('denied'))));
    services.get.mockReturnValue({ listDisabledSourceSlugs, readablePackageUris });
    expect(await loadVisibleDisabledPackageIds(member, 'p1', [OPEN, DENIED, PRIVATE, DROP])).toEqual(new Set([OPEN.packageId, DROP.packageId]));
    expect(listDisabledSourceSlugs).toHaveBeenCalledWith(caller);
    // One path question, only for admitted non-drop folders: the drop is exempt, as a loaded drop is.
    expect(readablePackageUris).toHaveBeenCalledTimes(1);
    expect(readablePackageUris).toHaveBeenCalledWith(caller, ['off://pkgs/open/package.json', 'off://pkgs/denied/package.json']);
  });

  it('no service or a throwing one admits none; no row asks nothing', async () => {
    services.get.mockReturnValue(undefined);
    expect(await loadVisibleDisabledPackageIds(member, 'p1', [OPEN, DROP])).toEqual(new Set());
    services.get.mockReturnValue({ listDisabledSourceSlugs: async () => ['off'], readablePackageUris: async () => { throw new Error('down'); } });
    expect(await loadVisibleDisabledPackageIds(member, 'p1', [OPEN])).toEqual(new Set());
    const get = vi.fn();
    services.get.mockImplementation(get);
    expect(await loadVisibleDisabledPackageIds(member, 'p1', [])).toEqual(new Set());
    expect(get).not.toHaveBeenCalled();
  });
});

describe('the single-package gates ask the same verdict', () => {
  const session = { userId: 'u', projectId: 'p1', role: 'member', priority: 3, rolePriorities: undefined, grantedFeatures: ['*'] } as never;
  const answer = (readable: boolean) => services.get.mockReturnValue({ readablePackageUris: async (_c: unknown, uris: readonly string[]) => new Set(readable ? uris : []) });

  it('the widget asset / app-scope gate serves the reader and refuses the non-reader like an unknown package', async () => {
    answer(true);
    expect(await resolveVisiblePackageSurface(session, SRC, 'widget', 'SECRET-WIDGET')).not.toBeNull();
    answer(false);
    expect(await resolveVisiblePackageSurface(session, SRC, 'widget', 'SECRET-WIDGET')).toBeNull();
    expect(await resolveVisiblePackageSurface(session, 'no-such-package', 'widget', 'SECRET-WIDGET')).toBeNull();
  });

  it('a notification from the package reaches the reader, not the non-reader', async () => {
    answer(true);
    expect(await isEventPackageVisible(SRC, session, {})).toBe(true);
    answer(false);
    expect(await isEventPackageVisible(SRC, session, {})).toBe(false);
  });
});
