/**
 * The ONE invite gate body (agent-governance Increment A). Pins: the floor is
 * re-derived from the LIVE record (canInvite flag + canAssignRole priority),
 * typed error codes for both callers, the member-record write shape, and that
 * tempPassword exists only when no explicit password was supplied.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProjectRecord } from '../../store/projectTypes';

const getProjectById = vi.fn();
const updateProject = vi.fn();
vi.mock('../../store/ProjectStore', () => ({
  getProjectById: (...a: unknown[]) => getProjectById(...a),
  updateProject: (...a: unknown[]) => updateProject(...a),
}));

const createUser = vi.fn();
const getUserById = vi.fn();
const deleteUser = vi.fn();
vi.mock('../../store/UserStore', () => ({
  createUser: (...a: unknown[]) => createUser(...a),
  getUserById: (...a: unknown[]) => getUserById(...a),
  deleteUser: (...a: unknown[]) => deleteUser(...a),
}));

const writeAuditLog = vi.fn();
vi.mock('../../store/AuditStore', () => ({
  writeAuditLog: (...a: unknown[]) => writeAuditLog(...a),
}));

import { inviteUserToProject } from '../inviteUserToProject';

function project(overrides?: Partial<ProjectRecord>): ProjectRecord {
  return {
    id: 'p1',
    name: 'P1',
    ownerId: 'u-owner',
    members: {
      'u-owner': { userId: 'u-owner', name: 'O', email: 'o@x.co', role: 'owner', position: '', tier: 1, addedAt: 't' },
      'u-admin': { userId: 'u-admin', name: 'A', email: 'a@x.co', role: 'admin', position: '', tier: 2, addedAt: 't' },
      'u-member': { userId: 'u-member', name: 'M', email: 'm@x.co', role: 'member', position: '', tier: 20, addedAt: 't' },
    },
    roles: {
      owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
      admin: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: [], priority: 2 },
      member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 20 },
    },
    agentOwnership: {},
    limits: { daily: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} } },
    ...overrides,
  } as ProjectRecord;
}

/**
 * The RECORDED WRITES. `updateProject` takes a PRODUCER now, so a CALL is not a
 * write — a producer that answers `null` writes nothing. The mock implements
 * that contract against the same record the service read.
 */
const writes: Array<{ id: string; patch: Record<string, unknown> }> = [];

beforeEach(() => {
  vi.clearAllMocks();
  writes.length = 0;
  getProjectById.mockResolvedValue(project());
  updateProject.mockImplementation(async (id: unknown, patch: unknown) => {
    const current = await getProjectById(id);
    const produced =
      typeof patch === 'function'
        ? (patch as (p: ProjectRecord) => Record<string, unknown> | null)(current as ProjectRecord)
        : (patch as Record<string, unknown>);
    if (produced === null) return current;
    writes.push({ id: id as string, patch: produced });
    return { ...(current as object), ...produced };
  });
  createUser.mockImplementation(async (email: string, name: string) => ({
    id: 'u-new',
    email,
    name,
    status: 'active',
  }));
  getUserById.mockResolvedValue({ id: 'u-admin', email: 'a@x.co', name: 'A' });
});

describe('inviteUserToProject', () => {
  it('denies a caller whose role lacks canInvite', async () => {
    const res = await inviteUserToProject('u-member', 'p1', { email: 'n@x.co', name: 'N' });
    expect(res).toEqual({ ok: false, error: { code: 'not_invite_capable' } });
    expect(createUser).not.toHaveBeenCalled();
  });

  it('denies assigning a role stronger than the caller (admin cannot mint owner)', async () => {
    const res = await inviteUserToProject('u-admin', 'p1', { email: 'n@x.co', name: 'N', role: 'owner' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('role_too_strong');
    expect(createUser).not.toHaveBeenCalled();
  });

  it('returns role_unknown for a role absent from the live map', async () => {
    const res = await inviteUserToProject('u-admin', 'p1', { email: 'n@x.co', name: 'N', role: 'ghost' });
    expect(res).toEqual({ ok: false, error: { code: 'role_unknown', role: 'ghost' } });
  });

  it('invites with a generated temp password, forced change, and the projected member record', async () => {
    const res = await inviteUserToProject('u-admin', 'p1', { email: 'n@x.co', name: 'N' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.role).toBe('member');
      expect(res.tempPassword).toBeTruthy();
      expect(res.user).toEqual({ id: 'u-new', email: 'n@x.co', name: 'N' });
    }
    expect(createUser).toHaveBeenCalledWith(
      'n@x.co',
      'N',
      expect.any(String),
      expect.objectContaining({ mustChangePassword: true, invitedBy: 'u-admin' }),
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].id).toBe('p1');
    expect(writes[0].patch).toEqual(
      expect.objectContaining({
        members: expect.objectContaining({
          'u-new': expect.objectContaining({ role: 'member', tier: 20, position: '' }),
        }),
      }),
    );
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.invite', userId: 'u-admin', target: 'u-new' }),
    );
    // Paired control of the orphan rows below: a landed invite keeps its account.
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('with an explicit password: enforces complexity, omits tempPassword, no forced change', async () => {
    const weak = await inviteUserToProject('u-admin', 'p1', { email: 'n@x.co', name: 'N', password: 'short' });
    expect(weak.ok).toBe(false);
    if (!weak.ok) expect(weak.error.code).toBe('password_policy');

    const ok = await inviteUserToProject('u-admin', 'p1', {
      email: 'n@x.co',
      name: 'N',
      password: 'Sup3r-Str0ng-P@ss!',
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.tempPassword).toBeUndefined();
    expect(createUser).toHaveBeenLastCalledWith(
      'n@x.co',
      'N',
      expect.any(String),
      expect.objectContaining({ mustChangePassword: false }),
    );
  });

  it('whitespace-only password behaves as absent (temp password + forced change)', async () => {
    const res = await inviteUserToProject('u-admin', 'p1', { email: 'n@x.co', name: 'N', password: '   ' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.tempPassword).toBeTruthy();
    expect(createUser).toHaveBeenCalledWith(
      'n@x.co',
      'N',
      expect.any(String),
      expect.objectContaining({ mustChangePassword: true }),
    );
  });

  it('maps a duplicate email to the typed email_exists code', async () => {
    createUser.mockRejectedValue(new Error('User with email n@x.co already exists'));
    const res = await inviteUserToProject('u-admin', 'p1', { email: 'n@x.co', name: 'N' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('email_exists');
  });

  it('fails closed on an unknown project or non-member caller', async () => {
    getProjectById.mockResolvedValue(null);
    expect(await inviteUserToProject('u-admin', 'nope', { email: 'n@x.co', name: 'N' })).toEqual({
      ok: false,
      error: { code: 'project_not_found' },
    });
    getProjectById.mockResolvedValue(project());
    expect(await inviteUserToProject('u-stranger', 'p1', { email: 'n@x.co', name: 'N' })).toEqual({
      ok: false,
      error: { code: 'caller_not_member' },
    });
  });

  it('a target role that VANISHES mid-write is a typed refusal, not a generic throw', async () => {
    // The snapshot carries `member`; the record the chain hands the producer no
    // longer does. Before the producer this reached `validateProjectInvariants`
    // and threw a generic error AFTER `createUser` had already run.
    getProjectById.mockResolvedValueOnce(project()).mockResolvedValueOnce(
      project({
        roles: {
          owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
          admin: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: [], priority: 2 },
        },
      } as Partial<ProjectRecord>),
    );
    const res = await inviteUserToProject('u-admin', 'p1', { email: 'n@x.co', name: 'N' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toEqual({ code: 'role_unknown', role: 'member' });
    expect(writes).toEqual([]);
  });

  it('a target role STRENGTHENED mid-write is refused, and the tier can never go stale', async () => {
    // The window: an owner moves custom role `lead` from 10 to 1 while an admin
    // (priority 2) is inviting into it. The snapshot's `canAssignRole` allowed
    // it; the record the chain hands the producer no longer does. Before the
    // full re-derivation the member landed in a now-apex role carrying a tier
    // computed from the OLD priority.
    const withLead = (priority: number) =>
      project({
        roles: {
          ...project().roles,
          lead: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: [], priority },
        },
      } as Partial<ProjectRecord>);
    getProjectById.mockResolvedValueOnce(withLead(10)).mockResolvedValueOnce(withLead(1));
    const res = await inviteUserToProject('u-admin', 'p1', { email: 'n@x.co', name: 'N', role: 'lead' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('role_too_strong');
    expect(writes).toEqual([]);
    // The account created for the refused membership does not survive it.
    expect(deleteUser).toHaveBeenCalledWith('u-new');
  });

  it('a project that VANISHES mid-write removes the created account', async () => {
    updateProject.mockResolvedValueOnce(null);
    const res = await inviteUserToProject('u-admin', 'p1', { email: 'n@x.co', name: 'N' });
    expect(res).toEqual({ ok: false, error: { code: 'project_not_found' } });
    expect(deleteUser).toHaveBeenCalledWith('u-new');
  });

  it('a throwing member write removes the created account and rethrows', async () => {
    updateProject.mockRejectedValueOnce(new Error('Project owner must remain a member'));
    await expect(inviteUserToProject('u-admin', 'p1', { email: 'n@x.co', name: 'N' })).rejects.toThrow('Project owner');
    expect(deleteUser).toHaveBeenCalledWith('u-new');
  });

  it('a caller who LOSES canInvite mid-write is refused by the producer', async () => {
    getProjectById.mockResolvedValueOnce(project()).mockResolvedValueOnce(
      project({
        roles: {
          ...project().roles,
          admin: { agents: '*', canInvite: false, canManageRoles: true, grantedFeatures: [], priority: 2 },
        },
      } as Partial<ProjectRecord>),
    );
    const res = await inviteUserToProject('u-admin', 'p1', { email: 'n@x.co', name: 'N' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('not_invite_capable');
    expect(writes).toEqual([]);
  });

  it('the member TIER comes from the FRESH role definition, never the snapshot', async () => {
    // Same window, but WEAKENING: 20 → 40 is still assignable by the admin, so
    // the write proceeds and the tier must follow the record, not the snapshot.
    const withMember = (priority: number) =>
      project({
        roles: {
          ...project().roles,
          member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [], priority },
        },
      } as Partial<ProjectRecord>);
    getProjectById.mockResolvedValueOnce(withMember(20)).mockResolvedValueOnce(withMember(40));
    const res = await inviteUserToProject('u-admin', 'p1', { email: 'n@x.co', name: 'N' });
    expect(res.ok).toBe(true);
    const members = (writes[0].patch as { members: Record<string, { tier: number }> }).members;
    expect(members['u-new'].tier).toBe(40);
  });

  it('the member map is built from the FRESH record — a concurrent invite survives', async () => {
    getProjectById.mockResolvedValueOnce(project()).mockResolvedValueOnce(
      project({
        members: {
          ...project().members,
          'u-parallel': {
            userId: 'u-parallel', name: 'P', email: 'p@x.co', role: 'member',
            position: '', tier: 20, addedAt: 't',
          },
        },
      } as Partial<ProjectRecord>),
    );
    const res = await inviteUserToProject('u-admin', 'p1', { email: 'n@x.co', name: 'N' });
    expect(res.ok).toBe(true);
    const members = (writes[0].patch as { members: Record<string, unknown> }).members;
    expect(Object.keys(members).sort()).toEqual([
      'u-admin', 'u-member', 'u-new', 'u-owner', 'u-parallel',
    ]);
  });
});
