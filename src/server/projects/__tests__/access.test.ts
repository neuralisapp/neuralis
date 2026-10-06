import { describe, expect, it } from 'vitest';
import { hasFeature } from '@neuralis/package-system/access';
import {
  canManagePackages,
  canManageProjectRoles,
  hasPlatformFeatureInAnyProject,
  hasProjectFeature,
  isOwnerStrengthOf,
  isOwnerStrengthOfAnyProject,
  parseProjectPatch,
  validateLimitsPatchPriority,
  validateMemberPatchPriority,
  validateRolesPatchPriority,
  type ProjectAccessContext,
} from '../access';
import { DEFAULT_ROLES, type ProjectRecord } from '../../store/projectTypes';

function projectWithMember(id: string, userId: string, roleName: string, declaredPriority?: number): ProjectRecord {
  return {
    id,
    name: id,
    ownerId: roleName === 'owner' ? userId : 'owner-user',
    members: {
      [userId]: { userId, name: 'M', email: 'm@example.com', role: roleName, position: 'P', tier: 1, addedAt: '2026-01-01T00:00:00.000Z' },
    },
    roles: {
      [roleName]: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: declaredPriority },
    },
    agentOwnership: {},
    limits: { spend: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} } },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as ProjectRecord;
}

function access(roleName: string, overrides?: Partial<ProjectAccessContext['role']>): ProjectAccessContext {
  return {
    project: {} as ProjectAccessContext['project'],
    session: { userId: 'user-1', projectId: 'p' },
    member: {
      userId: 'user-1',
      name: 'User',
      email: 'u@example.com',
      role: roleName,
      position: 'Team Member',
      tier: 3,
      addedAt: '2026-01-01T00:00:00.000Z',
    },
    role: {
      agents: 'own',
      canInvite: false,
      canManageRoles: false,
      grantedFeatures: [],
      priority: 4,
      ...overrides,
    },
  };
}

describe('project access helpers', () => {
  it('marks role/member/limit patches as privileged', () => {
    const parsed = parseProjectPatch({
      roles: {
        owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'] },
      },
      limits: { spend: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} } },
    });

    expect(parsed.error).toBeUndefined();
    expect(parsed.privileged).toBe(true);
  });

  it('allows metadata-only patches without privileged marker', () => {
    const parsed = parseProjectPatch({ name: 'Renamed', description: 'New description' });

    expect(parsed.patch).toEqual({ name: 'Renamed', description: 'New description' });
    expect(parsed.privileged).toBe(false);
  });

  it('rejects unsupported patch fields', () => {
    const parsed = parseProjectPatch({ packageTrust: {} });

    expect(parsed.patch).toBeUndefined();
    expect(parsed.error).toBe('Unsupported project patch field: packageTrust');
  });

  it('rejects loose privileged patch shapes', () => {
    const parsed = parseProjectPatch({ roles: { viewer: { agents: 'view' } } });

    expect(parsed.patch).toBeUndefined();
    expect(parsed.error).toContain('canInvite must be boolean');
  });

  it('rejects empty project names', () => {
    const parsed = parseProjectPatch({ name: '   ' });

    expect(parsed.patch).toBeUndefined();
    expect(parsed.error).toBe('Project name must not be empty');
  });

  it('allows package management for canManageRoles, wildcard, or packages.manage', () => {
    expect(canManagePackages(access('member', { canManageRoles: true }))).toBe(true);
    expect(canManagePackages(access('member', { grantedFeatures: ['*'] }))).toBe(true);
    expect(canManagePackages(access('member', { grantedFeatures: ['packages.manage'] }))).toBe(true);
    expect(canManagePackages(access('member'))).toBe(false);
  });

  it('keeps role management narrower than wildcard package grants', () => {
    expect(canManageProjectRoles(access('member', { grantedFeatures: ['packages.manage'] }))).toBe(false);
    expect(canManageProjectRoles(access('member', { canManageRoles: true }))).toBe(true);
  });

  // D-A — the governance gate is the stored FLAG alone. The `{owner, admin}`
  // name set is deleted, so the role NAME decides nothing in either direction.
  it('canManageProjectRoles is the flag ALONE — the role name decides nothing', () => {
    // A role NAMED owner/admin that the owner deliberately configured with the
    // flag off is HONOURED (it used to be silently overridden by the name set).
    expect(canManageProjectRoles(access('owner', { canManageRoles: false }))).toBe(false);
    expect(canManageProjectRoles(access('admin', { canManageRoles: false }))).toBe(false);
    // A custom role with the flag on passes, whatever it is called.
    for (const name of ['cheffe', 'devops', 'lead', 'zzz']) {
      expect(canManageProjectRoles(access(name, { canManageRoles: true, priority: 2 }))).toBe(true);
    }
    // …and the seeded shapes still behave as before, because the FLAG now says
    // what the name set used to say.
    expect(canManageProjectRoles(access('owner', { canManageRoles: true }))).toBe(true);
    expect(canManageProjectRoles(access('admin', { canManageRoles: true }))).toBe(true);
  });

  it('DEFAULT_ROLES.admin ships the honest canManageRoles flag', () => {
    expect(DEFAULT_ROLES.admin.canManageRoles).toBe(true);
    expect(DEFAULT_ROLES.owner.canManageRoles).toBe(true);
    expect(DEFAULT_ROLES.manager.canManageRoles).toBe(false);
  });

  it('isOwnerStrengthOf — owner STRENGTH in THIS project, never ownerId identity (D-B)', () => {
    const u = 'user-1';
    expect(isOwnerStrengthOf(projectWithMember('p1', u, 'owner'), u)).toBe(true);
    expect(isOwnerStrengthOf(projectWithMember('p1', u, 'admin'), u)).toBe(false);
    // A custom role declared at priority 1 IS owner-strength.
    expect(isOwnerStrengthOf(projectWithMember('p1', u, 'cheffe', 1), u)).toBe(true);
    // The provenance ownerId with no membership has no authority.
    const p = projectWithMember('p1', 'someone-else', 'member');
    p.ownerId = u;
    expect(isOwnerStrengthOf(p, u)).toBe(false);
  });

  it('hasPlatformFeatureInAnyProject — the ONE hasFeature predicate, per project', () => {
    const u = 'user-1';
    const withFeature = projectWithMember('p1', u, 'ops');
    withFeature.roles.ops!.grantedFeatures = ['platform.users'];
    const without = projectWithMember('p2', u, 'ops');
    without.roles.ops!.grantedFeatures = ['core.agents'];

    expect(hasPlatformFeatureInAnyProject(u, [without], 'platform.users')).toBe(false);
    expect(hasPlatformFeatureInAnyProject(u, [without, withFeature], 'platform.users')).toBe(true);
    // Wildcard holders still pass (same predicate, same `'*'` arm).
    expect(hasPlatformFeatureInAnyProject(u, [projectWithMember('p3', u, 'owner')], 'platform.users')).toBe(true);
    // Non-member of every project ⇒ false.
    expect(hasPlatformFeatureInAnyProject('nobody', [withFeature], 'platform.users')).toBe(false);
    expect(hasPlatformFeatureInAnyProject(u, [], 'platform.users')).toBe(false);
  });

  // D-F — the declared range is a code FLOOR, enforced through the ONE kernel
  // predicate on this write path and on the admin route's `patchProjectRoles`.
  describe('role priority range 1..99 (D-F)', () => {
    function rolesPatch(priority: unknown) {
      return {
        roles: {
          custom: {
            agents: 'own',
            canInvite: false,
            canManageRoles: false,
            grantedFeatures: [],
            priority,
          },
        },
      };
    }

    it('accepts the inclusive boundaries', () => {
      for (const ok of [1, 99, 20]) {
        expect(parseProjectPatch(rolesPatch(ok)).error).toBeUndefined();
      }
    });

    it('rejects out-of-range, non-integer and non-number priorities', () => {
      for (const bad of [0, -1, 100, 2.5, Number.NaN, Number.POSITIVE_INFINITY, '2', null, true]) {
        const parsed = parseProjectPatch(rolesPatch(bad));
        expect(parsed.error, `priority ${String(bad)} must be rejected`).toContain('priority must be an integer');
        expect(parsed.patch).toBeUndefined();
      }
    });

    it('validateRolesPatchPriority rejects the range FIRST, before the built-in immutability rule', () => {
      const existing = projectWithMember('p1', 'u', 'owner');
      // WHOLE-MAP semantics (`updateProject`: `roles: patch.roles ?? project.roles`),
      // so a legitimate patch carries every surviving role — omitting one is a
      // DELETE, which is the D2 hole this increment closes.
      const patch = parseProjectPatch({
        roles: {
          ...existing.roles,
          manager: { agents: '*', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 10 },
        },
      }).patch!;
      expect(validateRolesPatchPriority(existing, patch, { priority: 1, grantedFeatures: ['*'] })).toBeNull();
      // A 0 never reaches `validateRolesPatchPriority` from the HTTP path
      // (`parseProjectPatch` rejects it first), but the guard is total anyway.
      const raw = { roles: { custom: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 0 } } } as never;
      expect(validateRolesPatchPriority(existing, raw, { priority: 1, grantedFeatures: ['*'] })).toContain(
        'priority must be an integer',
      );
    });
  });

  // -------------------------------------------------------------------------
  // S1 — the host is the SECOND consumer of the shared write body. These prove
  // the DELEGATION is wired with a real caller object; the rule itself is
  // exercised in `packages/package-system/test/roleMapWrite.test.ts`.
  //
  // Every deny below answered 200/ALLOWED on this route before S1: the host copy
  // had no feature arm at all (D3) and neither axis walked the key UNION.
  // -------------------------------------------------------------------------
  describe('S1 — role and member write gates', () => {
    function projectWithRoles(): ProjectRecord {
      return {
        id: 'p1',
        name: 'p1',
        ownerId: 'u-owner',
        members: {
          'u-owner': { userId: 'u-owner', name: 'O', email: 'o@x', role: 'owner', position: '', tier: 1, addedAt: 'T' },
          'u-admin': { userId: 'u-admin', name: 'A', email: 'a@x', role: 'admin', position: '', tier: 2, addedAt: 'T' },
        },
        roles: {
          owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
          admin: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['drive.read'], priority: 2 },
          member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: ['drive.read'], priority: 20 },
        },
        agentOwnership: {},
        limits: { spend: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} } },
        createdAt: 'T',
        updatedAt: 'T',
      } as ProjectRecord;
    }
    const ADMIN_CALLER = { priority: 2, grantedFeatures: ['drive.read'] };

    it('D1 — an admin-strength caller cannot empty the apex role', () => {
      const existing = projectWithRoles();
      const patch = { roles: { ...existing.roles, owner: { ...existing.roles.owner, grantedFeatures: [] } } };
      expect(validateRolesPatchPriority(existing, patch, ADMIN_CALLER)).toContain('cannot modify role "owner"');
    });

    it('D3 — the HOST route now has a feature arm: no self-granting the wildcard', () => {
      const existing = projectWithRoles();
      const patch = { roles: { ...existing.roles, member: { ...existing.roles.member, grantedFeatures: ['*'] } } };
      expect(validateRolesPatchPriority(existing, patch, ADMIN_CALLER)).toContain('cannot grant feature "*"');
    });

    it('B3 — omitting a STRONGER member from the map is a removal, and is refused', () => {
      const existing = projectWithRoles();
      const patch = { members: { 'u-admin': existing.members['u-admin'] } };
      expect(validateMemberPatchPriority(existing, patch, ADMIN_CALLER)).toContain('cannot remove member "u-owner"');
    });

    it('CONTROL — an untouched whole-map round-trip is allowed on both axes', () => {
      const existing = projectWithRoles();
      const patch = { roles: { ...existing.roles }, members: { ...existing.members } };
      expect(validateRolesPatchPriority(existing, patch, ADMIN_CALLER)).toBeNull();
      expect(validateMemberPatchPriority(existing, patch, ADMIN_CALLER)).toBeNull();
    });
  });

  it('isOwnerStrengthOfAnyProject — true iff owner-strength (priority <= owner) of some project', () => {
    const u = 'user-1';
    // Owner of one project → can create.
    expect(isOwnerStrengthOfAnyProject(u, [projectWithMember('p1', u, 'owner')])).toBe(true);
    // Admin / member / viewer everywhere → cannot create (admins deliberately excluded).
    expect(isOwnerStrengthOfAnyProject(u, [projectWithMember('p1', u, 'admin')])).toBe(false);
    expect(isOwnerStrengthOfAnyProject(u, [projectWithMember('p1', u, 'member')])).toBe(false);
    // Member of none → cannot create.
    expect(isOwnerStrengthOfAnyProject(u, [projectWithMember('p1', 'other', 'owner')])).toBe(false);
    // Owner of at least one among several → can create.
    expect(
      isOwnerStrengthOfAnyProject(u, [projectWithMember('p1', u, 'member'), projectWithMember('p2', u, 'owner')]),
    ).toBe(true);
    // A custom role with declared owner-strength priority passes.
    expect(isOwnerStrengthOfAnyProject(u, [projectWithMember('p1', u, 'founder', 1)])).toBe(true);
    // Empty set → false.
    expect(isOwnerStrengthOfAnyProject(u, [])).toBe(false);
  });

  it('hasProjectFeature matches the canonical hasFeature predicate (no second copy)', () => {
    for (const granted of [[], ['packages.manage'], ['*'], ['other']]) {
      for (const feature of ['packages.manage', 'other', '*']) {
        expect(hasProjectFeature({ grantedFeatures: granted } as ProjectAccessContext['role'], feature)).toBe(
          hasFeature({ grantedFeatures: granted }, feature),
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// K11 / gap-30 — the spend-limit LOOSENING gate. Tightening is free; loosening
// or removing a row needs strength (strictly-stronger for byRole/byUser
// targets, admin strength for projectTotal/byAgent). Looser is judged on the
// DAY-NORMALIZED rate, so a period change can be a tightening.
// ---------------------------------------------------------------------------

describe('validateLimitsPatchPriority — the loosening gate', () => {
  const rule = (amountUsd: number, period: 'day' | 'week' | 'month' = 'day') => ({ amountUsd, period });
  function limitsProject(spendOver: Record<string, unknown> = {}): ProjectRecord {
    return {
      id: 'p1', name: 'p1', ownerId: 'u-owner',
      members: {
        'u-owner': { userId: 'u-owner', name: 'O', email: 'o@x', role: 'owner', position: '', tier: 1, addedAt: 'T' },
        'u-admin': { userId: 'u-admin', name: 'A', email: 'a@x', role: 'admin', position: '', tier: 2, addedAt: 'T' },
        'u-member': { userId: 'u-member', name: 'M', email: 'm@x', role: 'member', position: '', tier: 3, addedAt: 'T' },
      },
      roles: {
        owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
        admin: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 2 },
        member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 20 },
      },
      agentOwnership: {},
      limits: { spend: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {}, ...spendOver } },
      createdAt: 'T', updatedAt: 'T',
    } as ProjectRecord;
  }
  const patchSpend = (spendOver: Record<string, unknown>) => ({
    limits: { spend: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {}, ...spendOver } },
  });
  const OWNER = { priority: 1, grantedFeatures: ['*'] };
  const ADMIN = { priority: 2, grantedFeatures: ['*'] };
  const MEMBER = { priority: 20, grantedFeatures: [] as string[] };

  it('TIGHTENING is free for every caller — adding a rule and lowering one', () => {
    const p = limitsProject({ byRole: { member: rule(50) } });
    expect(validateLimitsPatchPriority(p, patchSpend({ byRole: { member: rule(10) } }), MEMBER)).toBeNull();
    expect(validateLimitsPatchPriority(p, patchSpend({ byRole: { member: rule(50) }, projectTotal: rule(100) }), MEMBER)).toBeNull();
  });

  it('LOOSENING a byRole row needs a STRICTLY stronger caller than the role', () => {
    const p = limitsProject({ byRole: { member: rule(10) } });
    const loosen = patchSpend({ byRole: { member: rule(100) } });
    expect(validateLimitsPatchPriority(p, loosen, ADMIN)).toBeNull(); // 2 < 20
    // A member (20) loosening the member-role row (20): NOT strictly stronger.
    expect(validateLimitsPatchPriority(p, loosen, MEMBER)).toMatch(/strictly stronger/);
    // An admin loosening the ADMIN role's own row (2 vs 2): refused too.
    const p2 = limitsProject({ byRole: { admin: rule(10) } });
    expect(validateLimitsPatchPriority(p2, patchSpend({ byRole: { admin: rule(100) } }), ADMIN)).toMatch(/strictly stronger/);
    expect(validateLimitsPatchPriority(p2, patchSpend({ byRole: { admin: rule(100) } }), OWNER)).toBeNull();
  });

  it('LOOSENING a byUser row resolves the member\'s role priority; own-cap loosening is refused', () => {
    const p = limitsProject({ byUser: { 'u-member': rule(10) } });
    expect(validateLimitsPatchPriority(p, patchSpend({ byUser: { 'u-member': rule(100) } }), MEMBER)).toMatch(/strictly stronger/);
    expect(validateLimitsPatchPriority(p, patchSpend({ byUser: { 'u-member': rule(100) } }), ADMIN)).toBeNull();
  });

  it('REMOVING a rule is the loosest write — gated exactly like loosening', () => {
    const p = limitsProject({ byRole: { member: rule(10) } });
    expect(validateLimitsPatchPriority(p, patchSpend({ byRole: { member: null } }), MEMBER)).toMatch(/strictly stronger/);
    expect(validateLimitsPatchPriority(p, patchSpend({ byRole: {} }), MEMBER)).toMatch(/strictly stronger/);
    expect(validateLimitsPatchPriority(p, patchSpend({ byRole: {} }), ADMIN)).toBeNull();
  });

  it('the judgement is DAY-NORMALIZED: a period change can tighten', () => {
    // month 300 = 10/day → day 10 = 10/day: equal, not looser — free.
    const p = limitsProject({ byRole: { member: rule(300, 'month') } });
    expect(validateLimitsPatchPriority(p, patchSpend({ byRole: { member: rule(10, 'day') } }), MEMBER)).toBeNull();
    // month 300 = 10/day → week 140 = 20/day: looser — gated.
    expect(validateLimitsPatchPriority(p, patchSpend({ byRole: { member: rule(140, 'week') } }), MEMBER)).toMatch(/strictly stronger/);
  });

  it('projectTotal and byAgent bind the caller too — loosening them needs ADMIN strength', () => {
    const p = limitsProject({ projectTotal: rule(100), byAgent: { helper: rule(5) } });
    expect(validateLimitsPatchPriority(p, patchSpend({ projectTotal: rule(500), byAgent: { helper: rule(5) } }), MEMBER)).toMatch(/admin strength/);
    expect(validateLimitsPatchPriority(p, patchSpend({ projectTotal: rule(500), byAgent: { helper: rule(5) } }), ADMIN)).toBeNull();
    expect(validateLimitsPatchPriority(p, patchSpend({ projectTotal: rule(100), byAgent: { helper: rule(50) } }), MEMBER)).toMatch(/admin strength/);
    expect(validateLimitsPatchPriority(p, patchSpend({ projectTotal: rule(100), byAgent: { helper: rule(50) } }), ADMIN)).toBeNull();
  });

  it('a row binding NOBODY (unknown role / non-member) counts as the weakest target — governable by any writer', () => {
    const p = limitsProject({ byRole: { ghost: rule(10) }, byUser: { 'u-gone': rule(10) } });
    expect(validateLimitsPatchPriority(p, patchSpend({ byRole: { ghost: rule(100) }, byUser: { 'u-gone': rule(10) } }), MEMBER)).toBeNull();
    expect(validateLimitsPatchPriority(p, patchSpend({ byRole: { ghost: rule(10) }, byUser: { 'u-gone': rule(100) } }), MEMBER)).toBeNull();
  });

  it('a patch without limits (or without spend) passes untouched', () => {
    const p = limitsProject();
    expect(validateLimitsPatchPriority(p, {}, MEMBER)).toBeNull();
    expect(validateLimitsPatchPriority(p, { name: 'x' }, MEMBER)).toBeNull();
    // The F5-named shape: a rateLimitRpm-only limits patch carries no spend key.
    expect(validateLimitsPatchPriority(p, { limits: { rateLimitRpm: 30 } as never }, MEMBER)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// periodic-pelican — validateLimits hardening (F3): closed key set, structural
// spend rules with per-rule period, key bounds, and a validated rateLimitRpm
// (a string used to reach disk and silently DISABLE the limiter).
// ---------------------------------------------------------------------------

describe('parseProjectPatch — limits validation (periodic-pelican)', () => {
  const spend = (over: Record<string, unknown> = {}) => ({
    projectTotal: null,
    byRole: {},
    byUser: {},
    byAgent: {},
    ...over,
  });

  it('accepts a full periodic limits payload', () => {
    const parsed = parseProjectPatch({
      limits: {
        spend: spend({
          projectTotal: { amountUsd: 200, period: 'day' },
          byUser: { u1: { amountUsd: 10, period: 'week' }, u2: null },
          byRole: { manager: { amountUsd: 5, period: 'month' } },
        }),
        rateLimitRpm: 100,
      },
    });
    expect(parsed.error).toBeUndefined();
    expect(parsed.privileged).toBe(true);
  });

  it('accepts a spend-only patch (rateLimitRpm merged field-wise by the store)', () => {
    expect(parseProjectPatch({ limits: { spend: spend() } }).error).toBeUndefined();
  });

  it('rejects unknown keys inside limits (the old validator let them reach disk)', () => {
    expect(parseProjectPatch({ limits: { daily: {} } }).error).toContain('Unsupported project limits field');
    expect(parseProjectPatch({ limits: { spend: spend(), extra: 1 } }).error).toContain('Unsupported project limits field');
  });

  it('rejects unknown keys inside spend and inside a rule', () => {
    expect(parseProjectPatch({ limits: { spend: { ...spend(), bogus: {} } } }).error).toContain('Unsupported project limits.spend field');
    expect(
      parseProjectPatch({ limits: { spend: spend({ projectTotal: { amountUsd: 1, period: 'day', extra: 1 } }) } }).error,
    ).toContain('Unsupported field');
  });

  it('rejects a bad period and a negative amount', () => {
    expect(
      parseProjectPatch({ limits: { spend: spend({ projectTotal: { amountUsd: 1, period: 'year' } }) } }).error,
    ).toContain('period must be one of');
    expect(
      parseProjectPatch({ limits: { spend: spend({ byUser: { u: { amountUsd: -5, period: 'day' } } }) } }).error,
    ).toContain('amountUsd must be a finite number');
  });

  it('rejects a bare number (the legacy shape) as a rule', () => {
    expect(
      parseProjectPatch({ limits: { spend: spend({ projectTotal: 200 }) } }).error,
    ).toContain('must be { amountUsd, period } or null');
  });

  it('rejects oversized/empty rule keys', () => {
    expect(
      parseProjectPatch({ limits: { spend: spend({ byAgent: { ['x'.repeat(129)]: null } }) } }).error,
    ).toContain('keys must be 1..128');
    expect(
      parseProjectPatch({ limits: { spend: spend({ byAgent: { '': null } }) } }).error,
    ).toContain('keys must be 1..128');
  });

  it('rejects non-numeric / zero / negative rateLimitRpm (fail-closed, F3)', () => {
    for (const bad of ['60', 0, -1, {}, []]) {
      expect(parseProjectPatch({ limits: { spend: spend(), rateLimitRpm: bad } }).error).toContain(
        'rateLimitRpm must be null or a number >= 1',
      );
    }
    expect(parseProjectPatch({ limits: { spend: spend(), rateLimitRpm: null } }).error).toBeUndefined();
    expect(parseProjectPatch({ limits: { spend: spend(), rateLimitRpm: 1 } }).error).toBeUndefined();
  });
});
