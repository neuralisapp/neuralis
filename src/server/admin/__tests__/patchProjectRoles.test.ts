/**
 * `patchProjectRoles` — the host body behind the admin package's
 * `PATCH config/roles`, on a REAL `FileStore` in a temp appRoot.
 *
 * This is where the role-map write's BEHAVIOUR lives now. The admin route used
 * to hold the gate AND write `<project>.json` raw — outside the store's chain,
 * outside `ProjectStore`, with a host-injected copy of the structural invariant
 * to make the raw write safe at all. Its suite kept the behavioural rows; they
 * are here, driving the real decision instead of a route stub, and the admin
 * side kept only the transport (body shape, projectId derivation, 503 without
 * the port, code → status mapping).
 *
 * The rows carried over: the D-A flag rows (a CUSTOM role with the flag may
 * write, a role NAMED `admin` without it may not), the GAP-3 escalation rows,
 * the D-F 1..99 priority range on this write path, and the S1 empty-map
 * refusal. New: the structural invariant reached through `updateProject`, and
 * the concurrency row that is the point of the port.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { BUILTIN_ROLE_PRIORITY } from '@neuralis/package-system/access';

const appRoot = await mkdtemp(join(tmpdir(), 'nrs-patch-roles-'));

vi.mock('../../config/env', () => ({
  // `auth.secret` is here because `resolveProjectRoleContext` lives beside the
  // NextAuth options module, which reads it at import time.
  getEnv: () => ({
    appRoot,
    projectsRoot: join(appRoot, 'projects-data'),
    auth: { secret: 'test-secret' },
  }),
}));

const { patchProjectRoles } = await import('../patchProjectRoles');
const { updateProject } = await import('../../store/ProjectStore');
import type { ProjectRecord, RoleDefinition } from '../../store/projectTypes';

beforeAll(async () => {
  await mkdir(join(appRoot, 'projects'), { recursive: true });
});
afterAll(async () => {
  await rm(appRoot, { recursive: true, force: true });
});

function role(over: Partial<RoleDefinition> = {}): RoleDefinition {
  return { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 20, ...over };
}

const OWNER_ROLE = role({
  agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1,
});

async function seed(id: string, over: Partial<ProjectRecord> = {}): Promise<void> {
  const record = {
    id,
    name: id,
    ownerId: 'u-owner',
    members: {
      'u-owner': {
        userId: 'u-owner', name: 'O', email: 'o@x.co', role: 'owner',
        position: 'Owner', tier: 1, addedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    roles: { owner: OWNER_ROLE, member: role() },
    agentOwnership: {},
    limits: { spend: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} } },
    roleGrantVersion: 18,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  } as ProjectRecord;
  await writeFile(join(appRoot, 'projects', `${id}.json`), JSON.stringify(record, null, 2), 'utf-8');
}

/** Read the record as RAW BYTES — never through the store's cache. */
async function readOnDisk(id: string): Promise<ProjectRecord> {
  return JSON.parse(await readFile(join(appRoot, 'projects', `${id}.json`), 'utf-8')) as ProjectRecord;
}

describe('patchProjectRoles — the governance gate is the FLAG on the LIVE role', () => {
  it('D-A: a member whose role lacks canManageRoles is DENIED (the module feature is not the gate)', async () => {
    await seed('flag-off', {
      members: {
        'u-owner': { userId: 'u-owner', name: 'O', email: 'o@x.co', role: 'owner', position: '', tier: 1, addedAt: 't' },
        'u-m': { userId: 'u-m', name: 'M', email: 'm@x.co', role: 'member', position: '', tier: 20, addedAt: 't' },
      },
    });
    const before = await readOnDisk('flag-off');
    const res = await patchProjectRoles('u-m', 'flag-off', { owner: OWNER_ROLE, member: role() });
    expect(res).toEqual({ ok: false, error: { code: 'denied' } });
    expect(await readOnDisk('flag-off')).toEqual(before);
  });

  it('D-A: a role NAMED `admin` with the flag OFF is refused — the name decides nothing', async () => {
    const adminRole = role({
      agents: '*', canInvite: true, canManageRoles: false,
      grantedFeatures: ['*'], priority: BUILTIN_ROLE_PRIORITY.admin,
    });
    await seed('named-admin', {
      members: {
        'u-owner': { userId: 'u-owner', name: 'O', email: 'o@x.co', role: 'owner', position: '', tier: 1, addedAt: 't' },
        'u-a': { userId: 'u-a', name: 'A', email: 'a@x.co', role: 'admin', position: '', tier: 2, addedAt: 't' },
      },
      roles: { owner: OWNER_ROLE, admin: adminRole },
    });
    const res = await patchProjectRoles('u-a', 'named-admin', { owner: OWNER_ROLE, admin: adminRole });
    expect(res).toEqual({ ok: false, error: { code: 'denied' } });
  });

  it('D-A: a CUSTOM role WITH the flag may write — the name decides nothing there either', async () => {
    const cheffe = role({ canManageRoles: true, grantedFeatures: ['project.roles'], priority: 10 });
    await seed('custom-flag', {
      members: {
        'u-owner': { userId: 'u-owner', name: 'O', email: 'o@x.co', role: 'owner', position: '', tier: 1, addedAt: 't' },
        'u-c': { userId: 'u-c', name: 'C', email: 'c@x.co', role: 'cheffe', position: '', tier: 10, addedAt: 't' },
      },
      roles: { owner: OWNER_ROLE, cheffe },
    });
    const res = await patchProjectRoles('u-c', 'custom-flag', {
      owner: OWNER_ROLE,
      cheffe,
      helper: role({ grantedFeatures: ['project.roles'], priority: 40 }),
    });
    expect(res.ok).toBe(true);
    expect(Object.keys((await readOnDisk('custom-flag')).roles).sort()).toEqual(['cheffe', 'helper', 'owner']);
  });

  it('a project that does not exist answers not_found', async () => {
    expect(await patchProjectRoles('u-owner', 'no-such', { owner: OWNER_ROLE })).toEqual({
      ok: false,
      error: { code: 'not_found' },
    });
  });
});

describe('patchProjectRoles — the kernel write floor (forbidden)', () => {
  async function seedMember(id: string): Promise<void> {
    await seed(id, {
      members: {
        'u-owner': { userId: 'u-owner', name: 'O', email: 'o@x.co', role: 'owner', position: '', tier: 1, addedAt: 't' },
        'u-m': { userId: 'u-m', name: 'M', email: 'm@x.co', role: 'member', position: '', tier: 20, addedAt: 't' },
      },
      roles: {
        owner: OWNER_ROLE,
        member: role({ canManageRoles: true, grantedFeatures: ['project.roles'] }),
      },
    });
  }

  it('GAP-3: a member self-granting a role wildcard is refused, and nothing is written', async () => {
    await seedMember('self-grant');
    const before = await readOnDisk('self-grant');
    const res = await patchProjectRoles('u-m', 'self-grant', {
      owner: OWNER_ROLE,
      member: role({ canManageRoles: true, grantedFeatures: ['project.roles'] }),
      hacked: role({ grantedFeatures: ['*'], priority: 40 }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('forbidden');
    expect(await readOnDisk('self-grant')).toEqual(before);
  });

  it('GAP-3: a member defining a role STRONGER than themselves is refused', async () => {
    await seedMember('stronger');
    const res = await patchProjectRoles('u-m', 'stronger', {
      owner: OWNER_ROLE,
      member: role({ canManageRoles: true, grantedFeatures: ['project.roles'] }),
      boss: role({ grantedFeatures: ['project.roles'], priority: 1 }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('forbidden');
  });

  it('S1: `{"roles":{}}` is refused by the WRITE gate, and the record is untouched', async () => {
    // Historically this answered 200 and erased every role of a real project.
    // Strictly stronger than the 400 that first fixed it: emptying the map
    // deletes the caller's OWN apex role, which the write floor refuses before
    // any record is built.
    await seed('empty-map');
    const before = await readOnDisk('empty-map');
    const res = await patchProjectRoles('u-owner', 'empty-map', {});
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('forbidden');
      expect(res.error.reason).toContain('cannot delete role "owner"');
    }
    expect(await readOnDisk('empty-map')).toEqual(before);
  });

  it('D-F: a priority outside 1..99 is refused on this write path too', async () => {
    await seed('range');
    for (const bad of [0, 100, -1, 2.5, NaN, Infinity, '2', null, true]) {
      const res = await patchProjectRoles('u-owner', 'range', {
        owner: OWNER_ROLE,
        member: role(),
        helper: { grantedFeatures: [], canInvite: false, canManageRoles: false, priority: bad } as never,
      });
      expect(res.ok, `priority ${String(bad)} must be refused`).toBe(false);
    }
  });

  it('D-F: the range boundaries are accepted', async () => {
    for (const good of [1, 99, BUILTIN_ROLE_PRIORITY.member]) {
      await seed(`range-ok-${good}`);
      const res = await patchProjectRoles('u-owner', `range-ok-${good}`, {
        owner: OWNER_ROLE,
        member: role(),
        helper: role({ priority: good }),
      });
      expect(res.ok, `priority ${good} must be accepted`).toBe(true);
    }
  });
});

describe('patchProjectRoles — the SHAPE floor (invalid)', () => {
  it('a non-array `grantedFeatures` is refused, and the disk is unchanged', async () => {
    // Pre-existing divergence, closed here: the kernel write floor normalizes a
    // non-array to `[]` rather than rejecting it and the record invariant checks
    // no role shape, so this path used to PERSIST what the host
    // `PATCH /api/projects/[id]` refused for the byte-identical body.
    await seed('shape-grants');
    const before = await readOnDisk('shape-grants');
    const res = await patchProjectRoles('u-owner', 'shape-grants', {
      owner: OWNER_ROLE,
      member: role(),
      helper: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: 'x', priority: 40 } as never,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('invalid');
      expect(res.error.reason).toContain('grantedFeatures must be a string array');
    }
    expect(await readOnDisk('shape-grants')).toEqual(before);
  });

  it('an off-enum `agents`, a non-boolean flag and a non-object role are all refused', async () => {
    await seed('shape-misc');
    const bad: Array<[string, unknown]> = [
      ['agents', { ...role(), agents: 'everything' }],
      ['canInvite', { ...role(), canInvite: 'yes' }],
      ['canManageRoles', { ...role(), canManageRoles: 1 }],
      ['not-an-object', 'helper'],
    ];
    for (const [label, def] of bad) {
      const res = await patchProjectRoles('u-owner', 'shape-misc', {
        owner: OWNER_ROLE,
        member: role(),
        helper: def as never,
      });
      expect(res.ok, `${label} must be refused`).toBe(false);
      if (!res.ok) expect(res.error.code, label).toBe('invalid');
    }
  });

  it('the shape floor runs AFTER the governance gate — a denied caller learns nothing about shape', async () => {
    // Deny-by-default ordering: a caller who may not write must not be able to
    // probe role shapes through the error code.
    await seed('shape-order', {
      members: {
        'u-owner': { userId: 'u-owner', name: 'O', email: 'o@x.co', role: 'owner', position: '', tier: 1, addedAt: 't' },
        'u-m': { userId: 'u-m', name: 'M', email: 'm@x.co', role: 'member', position: '', tier: 20, addedAt: 't' },
      },
    });
    const res = await patchProjectRoles('u-m', 'shape-order', {
      owner: OWNER_ROLE,
      helper: { grantedFeatures: 'x' } as never,
    });
    expect(res).toEqual({ ok: false, error: { code: 'denied' } });
  });
});

describe('patchProjectRoles — the structural invariant (invalid)', () => {
  it('deleting a role a MEMBER still holds is 400-class, and the disk is unchanged', async () => {
    // The write floor permits it (the role is weaker than the caller); the
    // record's own invariant does not, and it runs INSIDE `updateProject`.
    await seed('orphan', {
      members: {
        'u-owner': { userId: 'u-owner', name: 'O', email: 'o@x.co', role: 'owner', position: '', tier: 1, addedAt: 't' },
        'u-m': { userId: 'u-m', name: 'M', email: 'm@x.co', role: 'member', position: '', tier: 20, addedAt: 't' },
      },
    });
    const before = await readOnDisk('orphan');
    const res = await patchProjectRoles('u-owner', 'orphan', { owner: OWNER_ROLE });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('invalid');
      expect(res.error.reason).toContain('unknown role');
    }
    expect(await readOnDisk('orphan')).toEqual(before);
  });
});

describe('patchProjectRoles — on the store chain', () => {
  it('a role write concurrent with a package-grant revoke: BOTH land', async () => {
    // The whole point of the port. The raw writer this replaced read the file,
    // mutated it and renamed a temp over it, so one of these two erased the
    // other — in either direction, and it could tear the record besides.
    await seed('concurrent', { appliedPackageGrants: { 'pkg-a': '1.0.0', 'pkg-b': '1.0.0' } });
    await Promise.all([
      patchProjectRoles('u-owner', 'concurrent', {
        owner: OWNER_ROLE,
        member: role(),
        helper: role({ grantedFeatures: [], priority: 40 }),
      }),
      updateProject('concurrent', (p) => {
        const next = { ...p.appliedPackageGrants };
        delete next['pkg-a'];
        return { appliedPackageGrants: next };
      }),
    ]);
    const onDisk = await readOnDisk('concurrent');
    expect(Object.keys(onDisk.roles).sort()).toEqual(['helper', 'member', 'owner']);
    expect(onDisk.appliedPackageGrants).toEqual({ 'pkg-b': '1.0.0' });
  });

  it('a WHOLE-MAP write deletes an omitted role (the write floor is built on that)', async () => {
    await seed('whole-map', { roles: { owner: OWNER_ROLE, member: role(), spare: role({ priority: 40 }) } });
    const res = await patchProjectRoles('u-owner', 'whole-map', { owner: OWNER_ROLE, member: role() });
    expect(res.ok).toBe(true);
    expect(Object.keys((await readOnDisk('whole-map')).roles).sort()).toEqual(['member', 'owner']);
  });
});
