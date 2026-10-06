/**
 * `updateProject` / `updateUser` against a REAL `FileStore` in a temp appRoot.
 *
 * The other ProjectStore suites run on an in-memory store double, which cannot
 * observe the defect this file exists for: the double has no chain, so a
 * get→modify→put and a producer look identical there. These rows drive the
 * kernel store on disk.
 *
 * The pin is row (a): three concurrent grant revocations must all land. Its
 * PAIRED CONTROL is the object-patch form doing the same work from one stale
 * read, which deterministically leaves 2 of 3 markers standing — the shape the
 * live measurement found (`appliedPackageGrants` 6→6 instead of 6→3) and the
 * documented, accepted behaviour of the object form (the client sends the whole
 * map on `PATCH /api/projects/[id]`; that is its own, separate class).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, mkdir, readdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const appRoot = await mkdtemp(join(tmpdir(), 'nrs-projectstore-update-'));

vi.mock('../../config/env', () => ({
  getEnv: () => ({ appRoot, projectsRoot: join(appRoot, 'projects-data') }),
}));

// The tree/source/credential dirs a real create provisions are this suite's
// fixture, not its subject — the id choice is.
vi.mock('../../projects/projectInit', () => ({ initProjectDirectory: vi.fn() }));

const { updateProject, getProjectById, createProject, markProjectIdPurged, ProjectUpdateError } = await import('../ProjectStore');
const { updateUser } = await import('../UserStore');
import type { ProjectRecord } from '../projectTypes';

beforeAll(async () => {
  await mkdir(join(appRoot, 'projects'), { recursive: true });
  await mkdir(join(appRoot, 'users'), { recursive: true });
});

afterAll(async () => {
  await rm(appRoot, { recursive: true, force: true });
});

function seedRecord(id: string, over: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id,
    name: id,
    ownerId: 'u-owner',
    members: {
      'u-owner': {
        userId: 'u-owner', name: 'O', email: 'o@x.co', role: 'owner',
        position: 'Owner', tier: 1, addedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    roles: {
      owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
      member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 20 },
    },
    agentOwnership: {},
    limits: { spend: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} } },
    roleGrantVersion: 18,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as ProjectRecord;
}

async function seed(id: string, over: Partial<ProjectRecord> = {}): Promise<void> {
  await writeFile(
    join(appRoot, 'projects', `${id}.json`),
    JSON.stringify(seedRecord(id, over), null, 2),
    'utf-8',
  );
}

/** Read the record as RAW BYTES — never through the store's own cache. */
async function readOnDisk(id: string): Promise<ProjectRecord> {
  return JSON.parse(await readFile(join(appRoot, 'projects', `${id}.json`), 'utf-8')) as ProjectRecord;
}

const THREE_MARKERS = { 'pkg-a': '1.0.0', 'pkg-b': '1.0.0', 'pkg-c': '1.0.0' };

describe('updateProject — the PRODUCER form is atomic per record', () => {
  it('(a) three concurrent revocations ALL land — zero markers survive', async () => {
    await seed('race-producer', { appliedPackageGrants: { ...THREE_MARKERS } });
    await Promise.all(
      ['pkg-a', 'pkg-b', 'pkg-c'].map((pkg) =>
        updateProject('race-producer', (p) => {
          const next = { ...p.appliedPackageGrants };
          delete next[pkg];
          return { appliedPackageGrants: next };
        }),
      ),
    );
    expect(await readOnDisk('race-producer').then((r) => r.appliedPackageGrants)).toEqual({});
  });

  it('(a-control) three OBJECT patches from one stale read leave 2 of 3 standing', async () => {
    // Not a defect being pinned — the documented limit of the object form, and
    // the measurement that makes row (a) non-vacuous. This is exactly what the
    // grant writers did before they moved onto the producer.
    await seed('race-object', { appliedPackageGrants: { ...THREE_MARKERS } });
    const stale = await getProjectById('race-object');
    await Promise.all(
      ['pkg-a', 'pkg-b', 'pkg-c'].map((pkg) => {
        const next = { ...stale!.appliedPackageGrants };
        delete next[pkg];
        return updateProject('race-object', { appliedPackageGrants: next });
      }),
    );
    const survivors = Object.keys((await readOnDisk('race-object')).appliedPackageGrants ?? {});
    expect(survivors).toHaveLength(2);
  });

  it('(b) a producer answering null writes NOTHING — updatedAt is untouched', async () => {
    await seed('producer-null');
    const before = await readOnDisk('producer-null');
    const result = await updateProject('producer-null', () => null);
    const after = await readOnDisk('producer-null');
    expect(after).toEqual(before);
    expect(result?.updatedAt).toBe(before.updatedAt);
  });

  it('(c) an invariant-violating patch throws ProjectUpdateError and the disk is unchanged', async () => {
    await seed('producer-invalid');
    const before = await readFile(join(appRoot, 'projects', 'producer-invalid.json'), 'utf-8');
    await expect(updateProject('producer-invalid', () => ({ roles: {} }))).rejects.toBeInstanceOf(
      ProjectUpdateError,
    );
    expect(await readFile(join(appRoot, 'projects', 'producer-invalid.json'), 'utf-8')).toBe(before);
  });

  it('(d) a name edit keeps the id — object and producer form alike, one record on disk', async () => {
    await seed('named-once');
    const viaObject = await updateProject('named-once', { name: 'Something Else' });
    expect(viaObject?.id).toBe('named-once');
    const viaProducer = await updateProject('named-once', () => ({ name: 'Ügyfél projekt' }));
    expect(viaProducer?.id).toBe('named-once');
    expect((await readOnDisk('named-once')).name).toBe('Ügyfél projekt');
    const records = await readdir(join(appRoot, 'projects'));
    expect(records.filter((f) => f.startsWith('something-else') || f.startsWith('gyfl'))).toEqual([]);
  });

  it('(d2) a name edit still runs the record invariant', async () => {
    await seed('named-invalid');
    await expect(
      updateProject('named-invalid', { name: 'Renamed', roles: {} }),
    ).rejects.toBeInstanceOf(ProjectUpdateError);
    expect((await readOnDisk('named-invalid')).name).toBe('named-invalid');
  });

  it('returns null for a project that does not exist', async () => {
    expect(await updateProject('no-such-project', () => ({ description: 'x' }))).toBeNull();
  });

  it('(e) getAndMigrate\'s put-on-READ cannot overwrite a concurrent write', async () => {
    // An OLD roleGrantVersion makes `getProjectById` persist (that is the
    // put-on-read). Before the fix it wrote the record it had read BEFORE the
    // update, so the update\'s field disappeared.
    await seed('migrate-race', { roleGrantVersion: 1 } as Partial<ProjectRecord>);
    await Promise.all([
      getProjectById('migrate-race'),
      updateProject('migrate-race', () => ({ description: 'written-during-migration' })),
    ]);
    const onDisk = await readOnDisk('migrate-race');
    expect(onDisk.description).toBe('written-during-migration');
    expect(onDisk.roleGrantVersion).toBe(19);
  });

  it('the OBJECT form still replaces a map wholesale (the client-map path is unchanged)', async () => {
    await seed('object-replace');
    await updateProject('object-replace', {
      roles: {
        owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
      },
    });
    expect(Object.keys((await readOnDisk('object-replace')).roles)).toEqual(['owner']);
  });
});

describe('getProjectById — an id that cannot name a record is no project', () => {
  it('answers null for a traversal id and a sentinel, where the store guard used to throw', async () => {
    await expect(getProjectById('../x')).resolves.toBeNull();
    await expect(getProjectById('__system__')).resolves.toBeNull();
  });

  it('control: a real record still resolves', async () => {
    await seed('p-safe-id');
    expect((await getProjectById('p-safe-id'))?.id).toBe('p-safe-id');
  });
});

describe('createProject — the id is chosen once, never over a surviving trace', () => {
  it.each([
    ['project data tree', (id: string) => join(appRoot, 'projects-data', id)],
    ['source-config dir', (id: string) => join(appRoot, 'config', 'sources', id)],
    ['project-credential dir', (id: string) => join(appRoot, 'credentials', 'projects', id)],
  ])('an orphan %s with no record makes the slug taken', async (_label, dirOf) => {
    const base = `orphan-${_label.split(' ')[0]}`;
    await mkdir(dirOf(base), { recursive: true });
    const created = await createProject(base, 'u-owner');
    expect(created.id).toBe(`${base}-2`);
  });

  it('a PURGED id — its tombstone the only trace left — is never minted again', async () => {
    await markProjectIdPurged('purged-space');
    const created = await createProject('Purged Space', 'u-owner');
    expect(created.id).toBe('purged-space-2');
    // The tombstone sits BESIDE the record directory: four readers parse every
    // `*.json` in `app/projects/` as a project.
    expect(await readdir(join(appRoot, 'projects'))).not.toContain('purged-space.json');
    expect(await readdir(join(appRoot, 'projects-purged'))).toContain('purged-space.json');
    // A retried purge rewrites the same tombstone.
    await expect(markProjectIdPurged('purged-space')).resolves.toBeUndefined();
  });

  it('an unreadable trace refuses the create instead of looping', async () => {
    // A mode-000 parent makes `stat` of the candidate's source-config dir answer
    // EACCES — the real error, not a mocked one.
    const sources = join(appRoot, 'config', 'sources');
    await mkdir(sources, { recursive: true });
    await chmod(sources, 0o000);
    try {
      await expect(createProject('Locked Out', 'u-owner')).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      await chmod(sources, 0o755);
    }
    await expect(readFile(join(appRoot, 'projects', 'locked-out.json'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('two concurrent creates of one name claim two ids — neither record is overwritten', async () => {
    const [first, second] = await Promise.all([
      createProject('Race Room', 'u-owner'),
      createProject('Race Room', 'u-other'),
    ]);
    expect(new Set([first.id, second.id])).toEqual(new Set(['race-room', 'race-room-2']));
    for (const p of [first, second]) {
      expect((await readOnDisk(p.id)).ownerId).toBe(p.ownerId);
    }
  });

  it('control: with no trace the slug itself is used', async () => {
    const created = await createProject('Fresh Space', 'u-owner');
    expect(created.id).toBe('fresh-space');
  });

  it('accented letters are transliterated, not dropped', async () => {
    const created = await createProject('Ügyfél teszt', 'u-owner');
    expect(created.id).toBe('ugyfel-teszt');
    expect(created.name).toBe('Ügyfél teszt');
  });

  it('a name the slug cannot keep any character of still gets an id', async () => {
    const created = await createProject('日本', 'u-owner');
    expect(created.id).toBe('project');
    const second = await createProject('東京', 'u-owner');
    expect(second.id).toBe('project-2');
  });
});

describe('updateUser — concurrent field writes both land', () => {
  it('(f) a rename and a lastLoginAt stamp in one tick keep both fields', async () => {
    await writeFile(
      join(appRoot, 'users', 'u-1.json'),
      JSON.stringify({
        id: 'u-1', email: 'u@x.co', name: 'Old', passwordHash: 'h',
        status: 'active', mustChangePassword: false,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      'utf-8',
    );
    await Promise.all([
      updateUser('u-1', { name: 'Renamed' }),
      updateUser('u-1', { lastLoginAt: '2026-09-06T00:00:00.000Z' }),
    ]);
    const onDisk = JSON.parse(await readFile(join(appRoot, 'users', 'u-1.json'), 'utf-8')) as {
      name: string;
      lastLoginAt?: string;
    };
    expect(onDisk.name).toBe('Renamed');
    expect(onDisk.lastLoginAt).toBe('2026-09-06T00:00:00.000Z');
  });

  it('returns null for a user that does not exist', async () => {
    expect(await updateUser('no-such-user', { name: 'X' })).toBeNull();
  });
});

describe('a record from a NEWER build, and limits keys this build does not know', () => {
  it('a limits patch keeps the stored limits keys it does not name', async () => {
    await seed('p-limits', { limits: { spend: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} }, futureCap: 9 } as never });
    await updateProject('p-limits', { limits: { spend: { projectTotal: { amountUsd: 5, period: 'day' }, byRole: {}, byUser: {}, byAgent: {} } } as never });
    const onDisk = (await readOnDisk('p-limits')) as unknown as { limits: Record<string, unknown> };
    expect(onDisk.limits.futureCap).toBe(9);
    expect(onDisk.limits.spend).toMatchObject({ projectTotal: { amountUsd: 5, period: 'day' } });
  });

  it('a record stamped by a newer build is READ, never migrated back and never written', async () => {
    // A legacy `limits.daily` shape is exactly what the migrate-on-read would persist.
    await seed('p-newer', { roleGrantVersion: 99, limits: { daily: { projectTotal: 3 } } as never });
    const before = await readFile(join(appRoot, 'projects', 'p-newer.json'), 'utf-8');

    const read = await getProjectById('p-newer');
    expect(read?.id).toBe('p-newer');
    expect(await readFile(join(appRoot, 'projects', 'p-newer.json'), 'utf-8')).toBe(before);

    await expect(updateProject('p-newer', { name: 'renamed' })).rejects.toMatchObject({ code: 'record_newer' });
    expect(await readFile(join(appRoot, 'projects', 'p-newer.json'), 'utf-8')).toBe(before);
    expect((await readOnDisk('p-newer')).roleGrantVersion).toBe(99);
  });

  it('PAIRED CONTROL — the same legacy record at this build\'s version IS migrated and writable', async () => {
    await seed('p-current', { roleGrantVersion: 18, limits: { daily: { projectTotal: 3 } } as never });
    await getProjectById('p-current');
    const migrated = (await readOnDisk('p-current')) as unknown as { limits: Record<string, unknown>; roleGrantVersion: number };
    expect(migrated.limits.daily).toBeUndefined();
    expect(migrated.roleGrantVersion).toBeGreaterThan(18);
    await expect(updateProject('p-current', { name: 'renamed' })).resolves.toMatchObject({ name: 'renamed' });
  });
});
