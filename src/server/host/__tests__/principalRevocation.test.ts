/**
 * The ONE principal-revocation signal (`server/host/principalRevocation.ts`).
 *
 * - The store → event mapping, both directions: every transition that ends a
 *   principal's access produces exactly one event, and the transitions that do
 *   NOT (a re-enable, a second disable, a hard delete of a tombstone) produce
 *   none — a signal that fired on them would close a legitimate user's sockets.
 * - The close: host listeners, asset scopes and the package fan-out all run;
 *   one throwing host listener or a rejecting fan-out stops nothing else.
 * - End to end against REAL stores in a temp appRoot: a disable written through
 *   `UserStore` reaches the fan-out and the host listeners.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { PrincipalRevokedEvent } from '@neuralis/package-system/contracts';

const appRoot = await mkdtemp(join(tmpdir(), 'nrs-principal-revocation-'));

vi.mock('../../config/env', () => ({
  getEnv: () => ({ appRoot, projectsRoot: join(appRoot, 'projects-data') }),
}));

const revocation = await import('../principalRevocation');
const users = await import('../../store/UserStore');
const { getPackageAssetScopeAuthority } = await import('../../packages/PackageAssetScopeAuthority');

beforeAll(async () => {
  await mkdir(join(appRoot, 'users'), { recursive: true });
  await mkdir(join(appRoot, 'projects'), { recursive: true });
});

afterAll(async () => {
  await rm(appRoot, { recursive: true, force: true });
});

afterEach(() => {
  revocation.resetPrincipalRevocationForTests();
});

const state = (status: 'active' | 'disabled' | 'deleted', sessionEpoch = 0) => ({ status, sessionEpoch });

describe('store change → PrincipalRevokedEvent', () => {
  const cases: Array<[string, Parameters<typeof revocation.revocationsForUserChange>[0], PrincipalRevokedEvent[]]> = [
    ['active → disabled', { userId: 'u1', before: state('active'), after: state('disabled', 1) }, [{ userId: 'u1', reason: 'disabled' }]],
    ['active → tombstone', { userId: 'u1', before: state('active'), after: state('deleted') }, [{ userId: 'u1', reason: 'deleted' }]],
    ['disabled → tombstone (the offboarding order)', { userId: 'u1', before: state('disabled'), after: state('deleted') }, [{ userId: 'u1', reason: 'deleted' }]],
    ['record removed', { userId: 'u1', before: state('active'), after: null }, [{ userId: 'u1', reason: 'deleted' }]],
    ['active epoch bump (password reset)', { userId: 'u1', before: state('active', 2), after: state('active', 3) }, [{ userId: 'u1', reason: 'sessions_reset' }]],
    ['re-enable emits nothing', { userId: 'u1', before: state('disabled', 1), after: state('active', 1) }, []],
    ['a disabled user\'s epoch bump emits nothing again', { userId: 'u1', before: state('disabled', 1), after: state('disabled', 2) }, []],
    ['a tombstone removed emits nothing again', { userId: 'u1', before: state('deleted'), after: null }, []],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => {
      expect(revocation.revocationsForUserChange(input)).toEqual(expected);
    });
  }

  it('members removed / project closed → one project-scoped event per user', () => {
    expect(revocation.revocationsForMembershipChange({ kind: 'members_removed', projectId: 'p1', userIds: ['a', 'b'] })).toEqual([
      { userId: 'a', projectId: 'p1', reason: 'membership_removed' },
      { userId: 'b', projectId: 'p1', reason: 'membership_removed' },
    ]);
    expect(
      revocation.revocationsForMembershipChange({ kind: 'project_closed', projectId: 'p2', cause: 'deleted', userIds: ['a'] }),
    ).toEqual([{ userId: 'a', projectId: 'p2', reason: 'project_archived' }]);
  });

  it('a CHANGED record (rename, restore, create) revokes NOBODY — it names every member', () => {
    expect(
      revocation.revocationsForMembershipChange({ kind: 'record_changed', projectId: 'p1', userIds: ['a', 'b', 'c'] }),
    ).toEqual([]);
  });
});

describe('revokePrincipal — the close', () => {
  function mintScope(userId: string, projectId: string): string {
    return getPackageAssetScopeAuthority().mint({
      userId,
      projectId,
      packageId: 'pkg',
      surfaceKind: 'widget',
      surfaceId: 'w',
      renderer: 'iframe',
      trust: 'first-party',
      fingerprint: 'f',
      generation: 'g',
      surfaceRoot: '/tmp/x',
      entryRelPath: 'index.html',
    } as never).handle;
  }

  it('a throwing host listener and a rejecting fan-out stop nothing else; asset scopes are revoked in scope', async () => {
    const mine = mintScope('u1', 'p1');
    const otherProject = mintScope('u1', 'p2');
    const theirs = mintScope('u2', 'p1');
    const heard: string[] = [];
    revocation.onHostPrincipalRevoked(() => {
      throw new Error('listener boom');
    });
    revocation.onHostPrincipalRevoked((e) => {
      heard.push(`listener:${e.userId}:${e.projectId}`);
    });
    const fanOut = vi.fn(async () => {
      throw new Error('fan-out boom');
    });

    await revocation.revokePrincipal({ userId: 'u1', projectId: 'p1', reason: 'membership_removed' }, fanOut);

    expect(heard).toEqual(['listener:u1:p1']);
    expect(fanOut).toHaveBeenCalledWith({ userId: 'u1', projectId: 'p1', reason: 'membership_removed' });
    const authority = getPackageAssetScopeAuthority();
    expect(authority.get(mine)).toBeNull();
    expect(authority.get(otherProject)).not.toBeNull();
    expect(authority.get(theirs)).not.toBeNull();
  });
});

describe('startPrincipalRevocation — end to end through the real UserStore', () => {
  it('a disable written through the store reaches the package fan-out and every host listener', async () => {
    await writeFile(
      join(appRoot, 'users', 'u-e2e.json'),
      JSON.stringify({
        id: 'u-e2e', email: 'e2e@x.co', name: 'e2e', passwordHash: 'h', status: 'active', mustChangePassword: false,
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      'utf-8',
    );
    const fanned: PrincipalRevokedEvent[] = [];
    const listened: PrincipalRevokedEvent[] = [];
    revocation.onHostPrincipalRevoked((e) => {
      listened.push(e);
    });
    revocation.startPrincipalRevocation(async (e) => {
      fanned.push(e);
    });
    // Idempotent: a second start must not double every close.
    revocation.startPrincipalRevocation(async (e) => {
      fanned.push(e);
    });

    // A rename is not a transition — nothing closes.
    await users.updateUser('u-e2e', { name: 'renamed' });
    await users.updateUser('u-e2e', { status: 'disabled' });
    await vi.waitFor(() => expect(fanned).toHaveLength(1));

    expect(fanned).toEqual([{ userId: 'u-e2e', reason: 'disabled' }]);
    expect(listened).toEqual([{ userId: 'u-e2e', reason: 'disabled' }]);
  });

  it('a project rename written through the store closes nothing; the member removal after it closes only that member', async () => {
    const projects = await import('../../store/ProjectStore');
    const m = (userId: string, role: string) => ({
      userId, name: userId, email: `${userId}@x.co`, role, position: role, tier: role === 'owner' ? 1 : 20, addedAt: 't',
    });
    await writeFile(
      join(appRoot, 'projects', 'p-e2e.json'),
      JSON.stringify({
        id: 'p-e2e', name: 'Before', ownerId: 'u-own',
        members: { 'u-own': m('u-own', 'owner'), 'u-mem': m('u-mem', 'member') },
        roles: {
          owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
          member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 20 },
        },
        agentOwnership: {}, limits: { spend: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} } },
        roleGrantVersion: 19, createdAt: 't', updatedAt: 't',
      }),
      'utf-8',
    );
    const fanned: PrincipalRevokedEvent[] = [];
    revocation.startPrincipalRevocation(async (e) => {
      fanned.push(e);
    });

    await projects.updateProject('p-e2e', { name: 'After' });
    await projects.updateProject('p-e2e', (p) => {
      const next = { ...p.members };
      delete next['u-mem'];
      return { members: next };
    });
    await vi.waitFor(() => expect(fanned).toHaveLength(1));

    expect(fanned).toEqual([{ userId: 'u-mem', projectId: 'p-e2e', reason: 'membership_removed' }]);
  });
});
