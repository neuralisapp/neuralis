/** Enterprise project types — roles, hierarchy, limits, ownership. */
import { BUILTIN_ROLE_PRIORITY } from '@neuralis/package-system/access';
import { getDefaultRoleFeatures } from '../host/builtinFeatures';
import type { StoredAppearance } from '../appearance/appearanceImageStore';

const DEFAULT_ROLE_FEATURES = getDefaultRoleFeatures();

/**
 * A project's identity in the switcher, the same for every member: an icon
 * from the platform library, a colour, and an optional picture stored as a
 * content-addressed file under `<projectsRoot>/<id>/appearance/` (the record
 * carries only the reference — every catch-all request parses every record).
 * Owner-strength to change, like the name.
 */
export type ProjectAppearance = StoredAppearance;

export type ProjectMember = {
  userId: string;
  name: string;
  email: string;
  role: string;
  position: string;
  tier: number;
  addedAt: string;
};

export type RoleDefinition = {
  agents: '*' | 'own' | 'view';
  canInvite: boolean;
  canManageRoles: boolean;
  grantedFeatures: string[];
  /**
   * Ordinal role strength — **lower = stronger**. Anchors: owner 1, admin 2,
   * manager 10, member 20, viewer 30; the gaps let a custom role slot BETWEEN
   * two built-ins without renumbering the scale.
   *
   * **Declared range: `1 <= priority <= 99`, integers only** — enforced by the
   * ONE kernel predicate `isValidRolePriority` on BOTH write paths (the host
   * `validateRoles` / `validateRolesPatchPriority` and the admin package's
   * `patchProjectRoles`). `WEAKEST_ROLE_PRIORITY` is a runtime sentinel for an
   * unknown label and is deliberately outside the range — never a stored value.
   *
   * Gates role assignment: a caller may only assign/define a role whose
   * `priority` is `>=` their own. Built-in priorities are immutable; custom
   * roles carry their own. Backfilled and re-anchored on load by
   * `migrateProjectRecord` (role-grant version 12) for legacy records.
   */
  priority: number;
};

export type AgentOwnershipEntry = {
  createdBy: string;
  assignedTo: string[];
};

// Canonical spend-limit vocabulary is kernel-owned (periodic-pelican): per-rule
// USD caps with a day|week|month window, exactly ONE period per rule.
export type { SpendLimits, SpendLimitRule, SpendPeriod } from '@neuralis/package-system/contracts';
import type { SpendLimits as SpendLimitsShape } from '@neuralis/package-system/contracts';

export type ProjectRecord = {
  id: string;
  name: string;
  description?: string;
  appearance?: ProjectAppearance;
  ownerId: string;
  members: Record<string, ProjectMember>;
  roles: Record<string, RoleDefinition>;
  agentOwnership: Record<string, AgentOwnershipEntry>;
  limits: { spend: SpendLimitsShape; rateLimitRpm?: number | null };
  /** Owner/admin trust overrides for project packages. Default: untrusted. */
  packageTrust?: Record<string, 'trusted' | 'untrusted'>;
  /**
   * R2b (scope-guarding-magpie) — owner/admin base-access feature OVERRIDE per
   * package (packageId → feature id). RESTRICT-ONLY: it can only ATTACH a
   * required feature to an already-loaded package (e.g. isolate a first-party
   * package that declared no `requires.accessFeature`), never grant access — so
   * it never weakens a floor or creates a trust tier. The effective gate is the
   * manifest `accessFeature` ∪ this override (each independently required).
   */
  packageAccessFeature?: Record<string, string>;
  sandbox?: { landlock?: { enabled: boolean; networkAccess: boolean } };
  /**
   * happy-wondering-yeti — soft-archive marker. Set (ISO timestamp) ⇒ the project
   * is archived: excluded from `listProjectsForUser`/`listAllProjects` by default,
   * so it is HIDDEN from every list surface AND access-denied (the catch-all
   * membership gate reads the same list → 403 for package routes). Cleared by
   * restore. `getProjectById` stays unfiltered so restore/permanent-delete and the
   * catch-all limits lookup still resolve the archived record. Absent ⇒ active.
   */
  archivedAt?: string;
  roleGrantVersion?: number;
  /**
   * Provenance for non-builtin package `defaultRoleGrants` (C7a): packageId →
   * the package version whose grants were already merged into `roles`. Makes
   * grant application MERGE-ONCE — `#applyFeatureGrants` is a no-op when the
   * recorded version matches, so an admin's manual revoke of a granted feature
   * survives reboots (the add-only merge no longer re-adds it every boot). The
   * entry is cleared when the package is uninstalled (grants are revoked).
   */
  appliedPackageGrants?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

export const DEFAULT_ROLES: Record<string, RoleDefinition> = {
  owner: {
    agents: '*',
    canInvite: true,
    canManageRoles: true,
    grantedFeatures: ['*'],
    priority: BUILTIN_ROLE_PRIORITY.owner,
  },
  // D-A/A2 — `canManageProjectRoles` is now a pure FLAG check; the role-name
  // set (`PRIVILEGED_ROLE_NAMES`) that used to grant admin role management is
  // gone. This flag was previously `false` while the name set said "yes", i.e.
  // the stored flag was LYING about admin's real power. Flipping it to `true`
  // is what keeps the behaviour identical after the name set is deleted.
  // Existing projects get the same repair from migration version 12 (P5).
  //
  // D-C — `admin` no longer ships with the `'*'` wildcard. It receives the
  // manifest-declared union instead, exactly like manager/member/viewer: every
  // first-party feature MINUS the `platform.*` tier (the ids whose decision
  // crosses the project boundary). The list is never hand-typed — each package
  // declares its own `requires.defaultRoleGrants.admin`, and
  // `packages/package-system/test/adminGrantCoverage.test.ts` fails the build if
  // a non-`platform.*` feature is declared without one. Existing projects are
  // de-wildcarded by migration version 13 (P4).
  //
  // Consequence, stated: a project-dropped `_packages/` package's features are
  // NOT automatically inherited by admin (the `'*'` used to match them). They
  // stay listed in the feature catalog and an owner can grant them by hand.
  admin: {
    agents: '*',
    canInvite: true,
    canManageRoles: true,
    grantedFeatures: [...DEFAULT_ROLE_FEATURES.admin],
    priority: BUILTIN_ROLE_PRIORITY.admin,
  },
  manager: {
    agents: '*',
    canInvite: false,
    canManageRoles: false,
    grantedFeatures: [...DEFAULT_ROLE_FEATURES.manager],
    priority: BUILTIN_ROLE_PRIORITY.manager,
  },
  member: {
    agents: 'own',
    canInvite: false,
    canManageRoles: false,
    grantedFeatures: [...DEFAULT_ROLE_FEATURES.member],
    priority: BUILTIN_ROLE_PRIORITY.member,
  },
  viewer: {
    agents: 'view',
    canInvite: false,
    canManageRoles: false,
    grantedFeatures: [...DEFAULT_ROLE_FEATURES.viewer],
    priority: BUILTIN_ROLE_PRIORITY.viewer,
  },
};

export const DEFAULT_SPEND_LIMITS: SpendLimitsShape = {
  projectTotal: null,
  byRole: {},
  byUser: {},
  byAgent: {},
};
