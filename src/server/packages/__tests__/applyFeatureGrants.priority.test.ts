/**
 * §3.4 — the security regression D-C would otherwise create.
 *
 * `#applyFeatureGrants` merges a NON-BUILTIN package's `defaultRoleGrants` into
 * the project's roles. Its only floor used to be "skip `'*'` roles", which
 * covered owner AND admin because both shipped with the wildcard. The moment
 * D-C takes `'*'` off `admin`, a project-dropped `_packages/` package could
 * declare `defaultRoleGrants: { admin: [...] }` and grant ITSELF onto the
 * strongest in-project role.
 *
 * The floor is now the ONE `canReceivePackageGrant` predicate, keyed on resolved
 * PRIORITY so it is name-free (D-A) and covers custom strong roles too.
 */

import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLE_PRIORITY } from '@neuralis/package-system/access';
import { canReceivePackageGrant } from '../../projects/access';
import type { RoleDefinition } from '../../store/projectTypes';

function role(over: Partial<RoleDefinition> = {}): RoleDefinition {
  return {
    agents: 'own',
    canInvite: false,
    canManageRoles: false,
    grantedFeatures: [],
    priority: BUILTIN_ROLE_PRIORITY.member,
    ...over,
  };
}

describe('canReceivePackageGrant — a dropped package may not grant itself upward', () => {
  it('refuses a wildcard role (the pre-existing arm)', () => {
    expect(canReceivePackageGrant('owner', role({ grantedFeatures: ['*'], priority: 1 }))).toBe(false);
    expect(canReceivePackageGrant('someone', role({ grantedFeatures: ['*'], priority: 50 }))).toBe(false);
  });

  it('refuses owner and admin strength even WITHOUT the wildcard (the D-C arm)', () => {
    expect(canReceivePackageGrant('owner', role({ priority: BUILTIN_ROLE_PRIORITY.owner }))).toBe(false);
    expect(canReceivePackageGrant('admin', role({ priority: BUILTIN_ROLE_PRIORITY.admin }))).toBe(false);
  });

  it('refuses a CUSTOM role at owner/admin strength — the name decides nothing (D-A)', () => {
    expect(canReceivePackageGrant('cheffe', role({ priority: 1 }))).toBe(false);
    expect(canReceivePackageGrant('lead', role({ priority: 2 }))).toBe(false);
  });

  it('allows every role weaker than the project-admin anchor', () => {
    expect(canReceivePackageGrant('manager', role({ priority: BUILTIN_ROLE_PRIORITY.manager }))).toBe(true);
    expect(canReceivePackageGrant('member', role({ priority: BUILTIN_ROLE_PRIORITY.member }))).toBe(true);
    expect(canReceivePackageGrant('viewer', role({ priority: BUILTIN_ROLE_PRIORITY.viewer }))).toBe(true);
    expect(canReceivePackageGrant('intern', role({ priority: 99 }))).toBe(true);
    // Priority 3 sits between the admin (2) and manager (10) anchors — the gap
    // the 1..99 range exists to make usable.
    expect(canReceivePackageGrant('deputy', role({ priority: 3 }))).toBe(true);
  });

  it('an unknown role name with no declared priority resolves to the weakest sentinel and is allowed', () => {
    const noPriority = { ...role(), priority: undefined } as unknown as RoleDefinition;
    expect(canReceivePackageGrant('mystery', noPriority)).toBe(true);
  });
});
