import type { ProjectMember, ProjectRecord, RoleDefinition, SpendLimitRule, SpendPeriod } from '../store/projectTypes';
import {
  BUILTIN_ROLE_PRIORITY,
  canAssignRole,
  hasFeature,
  isValidRolePriority,
  MAX_ROLE_PRIORITY,
  MIN_ROLE_PRIORITY,
  rolePriority,
  validateMemberMapWrite,
  validateRoleMapWrite,
  WEAKEST_ROLE_PRIORITY,
  type RoleDefinitionComparedKey,
} from '@neuralis/package-system/access';
import { validateProjectInvariants } from '../store/projectInvariants';
import { resolveMember } from '../auth/memberSession';
import { listProjectsForUser } from '../store/ProjectStore';
import {
  AppearanceImageError,
  AppearancePatchError,
  parseAppearancePatch,
  type AppearancePatch,
} from '../appearance/appearanceImageStore';
import type { SessionContext } from '@neuralis/package-system/contracts';

// The ONE structural-invariant body now lives in a dependency-free store module
// (this file reaches `ProjectStore` through the member resolver, so the shared
// body cannot live here without closing a cycle). Re-exported so existing importers
// of `validateProjectInvariants` from `projects/access` keep working.
export { validateProjectInvariants };

export const PACKAGE_MANAGE_FEATURE = 'packages.manage';

export type ProjectAccessContext = {
  project: ProjectRecord;
  member: ProjectMember;
  role: RoleDefinition;
  /** The caller's session in this project — the input of an agent-axis check. */
  session: SessionContext;
};

export type ProjectPatch = Partial<Pick<ProjectRecord, 'name' | 'description' | 'members' | 'roles' | 'agentOwnership' | 'limits'>>;

const PROJECT_PATCH_KEYS = new Set(['name', 'description', 'appearance', 'members', 'roles', 'agentOwnership', 'limits']);
const PRIVILEGED_PROJECT_PATCH_KEYS = new Set(['members', 'roles', 'agentOwnership', 'limits']);
const ROLE_AGENT_ACCESS = new Set(['*', 'own', 'view']);

/**
 * The project-access view of the ONE member resolver, for the package snapshot
 * and management routes (runtime/widgets/dock/commands, install/publish/build/
 * trust/access-feature/rescan/query/command) that do not pass through the
 * catch-all: an inactive user, an archived project, a removed member and an
 * unresolvable role all answer `null`.
 */
export async function resolveProjectAccess(userId: string, projectId: string): Promise<ProjectAccessContext | null> {
  const resolved = await resolveMember(userId, projectId);
  return resolved
    ? { project: resolved.project, member: resolved.member, role: resolved.roleDef, session: resolved.session }
    : null;
}

// Delegate to the ONE canonical wildcard-OR predicate from the contract kernel
// (CLAUDE.md Security Criteria — no second copy of the feature-gate logic). The
// `RoleDefinition`-shaped wrapper is kept for call-site ergonomics, mirroring
// the sanctioned `snapshot.ts hasRequiredFeatures → meetsRequires` pattern.
// Behaviour-preserving: `role.grantedFeatures` is always a defined array here.
export function hasProjectFeature(role: RoleDefinition, feature: string): boolean {
  return hasFeature({ grantedFeatures: role.grantedFeatures }, feature);
}

/**
 * C8 + D-A — host-level project GOVERNANCE (who may edit members / roles /
 * agent ownership / limits).
 *
 * This is deliberately NOT a package feature: governance must not be
 * self-grantable through a capability toggle. It used to be
 * `PRIVILEGED_ROLE_NAMES.has(member.role) || role.canManageRoles` — a hardcoded
 * `{owner, admin}` name set OR the flag. D-A deletes the name arm: the decision
 * is now the existing per-role FLAG alone, so a custom role named anything can
 * hold it and a role NAMED `admin` that an owner deliberately configured with
 * `canManageRoles: false` is honoured.
 *
 * Behaviour-preserving: `DEFAULT_ROLES.admin.canManageRoles` flipped `false` →
 * `true` (the stored flag had been lying about admin's real power) and migration
 * version 12 (P5) applies the same raise-only repair to the roles NAMED
 * `owner`/`admin` on existing projects — a one-time data translation of the old
 * name-keyed semantics, never a priority-keyed grant.
 */
export function canManageProjectRoles(access: Pick<ProjectAccessContext, 'member' | 'role'>): boolean {
  return access.role.canManageRoles;
}

/**
 * Package management: the governance flag OR the explicit `packages.manage`
 * feature. The two-arm shape is load-bearing — dropping the governance arm would
 * strip a hand-made `canManageRoles` role of package management.
 */
export function canManagePackages(access: Pick<ProjectAccessContext, 'member' | 'role'>): boolean {
  return canManageProjectRoles(access) || hasProjectFeature(access.role, PACKAGE_MANAGE_FEATURE);
}

/**
 * Authorization gate for CREATING a new project (tenant). Creating a tenant is
 * the strongest project act, so it is restricted to callers who already hold an
 * owner-strength role (priority `<= owner`) in at least one existing project —
 * there is no platform-global role, so "owner of any project" is the host
 * governance proxy (mirrors the per-project `rolePriority` derivation at
 * `PATCH /api/projects/[id]`). Admins (priority 2) are deliberately excluded.
 * Bootstrap is unaffected: the first owner is seeded directly to disk by
 * `scripts/setup.mts`, never through the HTTP route.
 */
export function isOwnerStrengthOfAnyProject(userId: string, projects: ProjectRecord[]): boolean {
  return projects.some((p) => isOwnerStrengthOf(p, userId));
}

/**
 * D-B — owner STRENGTH in THIS project: the caller holds a role whose resolved
 * priority is at or above the owner anchor (`<= 1`).
 *
 * This is the replacement for every `project.ownerId === user.id` authority
 * check. `ownerId` is provenance ("who created it") and nothing else; a custom
 * role declared at priority 1 is owner-strength and must behave exactly like the
 * built-in `owner`, while the creator who was later demoted must not keep
 * owner powers. Priority, not identity, not name.
 */
export function isOwnerStrengthOf(project: ProjectRecord, userId: string): boolean {
  const member = project.members[userId];
  if (!member) return false;
  return rolePriority(member.role, project.roles[member.role]?.priority) <= BUILTIN_ROLE_PRIORITY.owner;
}

/**
 * May `viewerId` see `userId`'s display card (name, email, appearance and its
 * picture)? Yourself always; anyone else only while you share a project. The
 * ONE gate of the profile GET and the user-picture route — a refusal there is
 * the same 404 as an unknown id, so neither is a directory of the platform.
 */
export async function canViewUserProfile(viewerId: string, userId: string): Promise<boolean> {
  if (viewerId === userId) return true;
  const shared = await listProjectsForUser(viewerId);
  return shared.some((project) => project.members[userId] !== undefined);
}

/**
 * May a PACKAGE's `defaultRoleGrants` write onto this role?
 *
 * No, for two independent reasons, either of which is sufficient:
 *
 * 1. **Wildcard.** A `'*'` role already holds every id; merging would be a
 *    no-op that only risks losing the wildcard.
 * 2. **Project-admin strength or stronger.** Until D-C, reason 1 covered admin
 *    too, because admin shipped with `'*'`. Taking the wildcard off `admin`
 *    would otherwise let an untrusted project-dropped `_packages/` package
 *    declare `defaultRoleGrants: { admin: [...] }` and grant ITSELF onto the
 *    strongest in-project role. Keyed on resolved PRIORITY, so it is name-free
 *    (D-A) and also covers a custom priority-1 or priority-2 role.
 *
 * Consequence, stated so nobody discovers it as a bug: an admin does NOT
 * automatically inherit features a project-dropped package declares. An owner
 * can still grant them by hand — the feature catalog is built from the runtime
 * registry, so a `_packages/` package's `providesFeatures` stay listed.
 */
export function canReceivePackageGrant(roleName: string, role: RoleDefinition): boolean {
  if (role.grantedFeatures.includes('*')) return false;
  return rolePriority(roleName, role.priority) > BUILTIN_ROLE_PRIORITY.admin;
}

/**
 * May a BUILTIN's `defaultRoleGrants` write onto this role, when the operator
 * adds the builtin after the project exists?
 *
 * A builtin is host-assigned first-party (deps membership is the trust act), so
 * — exactly as at project creation — its grants may reach `admin`. Never a
 * `'*'` role (already holds every id) and never an APEX role (owner priority or
 * stronger): its grant list is the owner's own, and a system write onto it has
 * no path back. Keyed on resolved PRIORITY, so it is name-free (D-A).
 */
export function canReceiveBuiltinGrant(roleName: string, role: RoleDefinition): boolean {
  if (role.grantedFeatures.includes('*')) return false;
  return rolePriority(roleName, role.priority) > BUILTIN_ROLE_PRIORITY.owner;
}

/**
 * Does `userId` hold `feature` in AT LEAST ONE of `projects`?
 *
 * The documented non-`SessionContext` carve-out (sibling of
 * `isOwnerStrengthOfAnyProject`): a handful of host routes are cross-project by
 * construction and therefore have no single `session.projectId` to gate on. Uses
 * the ONE `hasFeature` predicate per project — no second copy of the gate.
 */
export function hasPlatformFeatureInAnyProject(
  userId: string,
  projects: ProjectRecord[],
  feature: string,
): boolean {
  return projects.some((p) => {
    const member = p.members[userId];
    if (!member) return false;
    const role = p.roles[member.role];
    if (!role) return false;
    return hasProjectFeature(role, feature);
  });
}

/** What a member-map write changed — the audit `details` of a membership write. */
export type MemberMapDiff = {
  added: string[];
  removed: string[];
  roleChanged: Array<{ userId: string; from: string; to: string }>;
};

export function diffMemberMaps(
  before: ProjectRecord['members'],
  after: ProjectRecord['members'],
): MemberMapDiff | null {
  const diff: MemberMapDiff = { added: [], removed: [], roleChanged: [] };
  for (const [userId, member] of Object.entries(after)) {
    const previous = before[userId];
    if (!previous) diff.added.push(userId);
    else if (previous.role !== member.role) diff.roleChanged.push({ userId, from: previous.role, to: member.role });
  }
  for (const userId of Object.keys(before)) {
    if (!after[userId]) diff.removed.push(userId);
  }
  return diff.added.length + diff.removed.length + diff.roleChanged.length > 0 ? diff : null;
}

/** The five verbs that act on the platform-global USER record, not on one project. */
export type UserRecordVerb = 'reset_password' | 'disable' | 'enable' | 'rename' | 'delete';

/**
 * May `callerId` act on `targetId`'s platform-global user record?
 *
 * The record is shared by every project the target belongs to, so authority
 * from ONE project is not enough: for EVERY project that holds the target
 * (archived ones included — an archived membership revives on restore) the
 * caller must be a member there, hold `canInvite`, and pass `canAssignRole`
 * against the target's role in THAT project. `delete` additionally needs
 * `platform.users`, and a target who belongs to no project at all is reachable
 * only with `platform.users`. The caller never acts on their own record here —
 * the self-service branches own a user's own name and password.
 *
 * A caller whose role definition is missing in a project is refused there, and
 * the priority handed to `canAssignRole` is always a NUMBER (`rolePriority`
 * resolves an undeclared custom role to the WEAKEST): `canAssignRole` reads
 * `undefined` as a system session and allows everything.
 *
 * Sibling of {@link isOwnerStrengthOfAnyProject}: a cross-project question with
 * no single `SessionContext` to gate on.
 */
export function canGovernUserRecord(input: {
  callerId: string;
  targetId: string;
  /** Every project, archived included (`listAllProjects({ includeArchived: true })`). */
  projects: readonly ProjectRecord[];
  verb: UserRecordVerb;
  /** `platform.users` in the project the request names. */
  callerHoldsPlatformUsers: boolean;
}): boolean {
  const { callerId, targetId, projects, verb, callerHoldsPlatformUsers } = input;
  if (callerId === targetId) return false;
  if (verb === 'delete' && !callerHoldsPlatformUsers) return false;
  const targetProjects = projects.filter((p) => p.members[targetId] !== undefined);
  if (targetProjects.length === 0) return callerHoldsPlatformUsers;
  return targetProjects.every((p) => {
    const caller = p.members[callerId];
    const callerRole = caller ? p.roles[caller.role] : undefined;
    if (!caller || !callerRole || !callerRole.canInvite) return false;
    const target = p.members[targetId]!;
    return canAssignRole({
      callerPriority: rolePriority(caller.role, callerRole.priority),
      targetPriority: rolePriority(target.role, p.roles[target.role]?.priority),
    }).allowed;
  });
}

/**
 * The projects that would be left with NO active owner-strength member if
 * `targetId` stopped counting (disabled or deleted): the target is
 * owner-strength there and no OTHER owner-strength member is in `activeUserIds`.
 * Nobody could then archive, restore or purge that project, or govern its apex
 * roles. Archived projects count — a restore would bring the orphan back.
 */
export function leavesProjectWithoutActiveOwner(
  targetId: string,
  projects: readonly ProjectRecord[],
  activeUserIds: ReadonlySet<string>,
): ProjectRecord[] {
  return projects.filter((p) => {
    if (!isOwnerStrengthOf(p, targetId)) return false;
    return !Object.keys(p.members).some(
      (userId) => userId !== targetId && activeUserIds.has(userId) && isOwnerStrengthOf(p, userId),
    );
  });
}

/**
 * S1 — the caller's own strength + feature set, the required input of BOTH
 * write gates below. Resolved once at the route from the caller's membership
 * role, never defaulted.
 */
export type ProjectPatchCaller = {
  priority: number;
  grantedFeatures: readonly string[];
};

/**
 * Compile-time drift guard for the role-comparison field set.
 *
 * The kernel cannot import `RoleDefinition` (host to package is the only
 * dependency direction), so the assertion lives here, where both types are in
 * scope. Add a sixth field to `RoleDefinition` without teaching
 * `roleMapWrite.ts` how to normalize it and this line stops compiling — the
 * point being that a silently-uncompared field is how an "immutable" role
 * becomes editable again.
 *
 * It must be a construct that can FAIL: an `Exclude<...>` assigned to an empty
 * array literal compiles cleanly whatever the result and proves nothing.
 */
type AssertNever<T extends never> = T;
export type RoleDefinitionFieldDrift = AssertNever<
  Exclude<keyof RoleDefinition, RoleDefinitionComparedKey>
>;

/**
 * Role-priority gate for a `members` patch (C1 + S1/B3).
 *
 * Delegates to the ONE kernel body. The whole-map union walk is the part that
 * was missing: this used to iterate the INCOMING map only, while
 * `updateProject` replaces `members` wholesale — so omitting a stronger member
 * from the patch removed them with nothing to check (measured ALLOWED).
 */
export function validateMemberPatchPriority(
  existing: ProjectRecord,
  patch: ProjectPatch,
  caller: ProjectPatchCaller,
): string | null {
  const members = patch.members;
  if (!members) return null;
  return validateMemberMapWrite({
    existingMembers: existing.members,
    nextMembers: members,
    roleFor: (roleName) => patch.roles?.[roleName] ?? existing.roles[roleName],
    existingRoleFor: (roleName) => existing.roles[roleName],
    caller: { priority: caller.priority },
  });
}

/**
 * Role-map write gate for a `roles` patch (C2 + S1/D1/D2/D3).
 *
 * Delegates to the ONE kernel body — the same one the admin package's
 * `PATCH config/roles` calls. Before S1 this host copy carried NO feature arm
 * at all, so any `canManageRoles` holder could grant themselves `'*'` here even
 * though the admin route refused the byte-identical body.
 */
export function validateRolesPatchPriority(
  existing: ProjectRecord,
  patch: ProjectPatch,
  caller: ProjectPatchCaller,
): string | null {
  const roles = patch.roles;
  if (!roles) return null;
  return validateRoleMapWrite({
    existing: existing.roles,
    next: roles,
    caller: { priority: caller.priority, grantedFeatures: caller.grantedFeatures },
  });
}

/**
 * Spend-limit write gate for a `limits` patch (K11 / gap-30).
 *
 * TIGHTENING is free for any caller who can reach this write at all; LOOSENING
 * or REMOVING a row is a governance act gated on strength:
 *  - `byRole[r]` / `byUser[u]` rows: only a caller STRICTLY stronger than the
 *    row's target (`targetPriority > callerPriority` — `>=` would let a caller
 *    loosen their own or a peer's cap, which is half of gap-30). A `byRole` row
 *    targets that role's priority in the EXISTING record; a `byUser` row the
 *    member's ONE role's priority; an unknown role / non-member counts as the
 *    WEAKEST sentinel (anyone may govern a row that binds nobody).
 *  - `byAgent[*]` and `projectTotal` rows bind the CALLER's own runs too, so
 *    "strictly stronger than the target" cannot gate them — loosening them
 *    requires admin STRENGTH (`callerPriority <= BUILTIN_ROLE_PRIORITY.admin`,
 *    the delegate-stop pattern; never a role name).
 *
 * Looser/tighter is judged on the DAY-NORMALIZED rate (`amountUsd / {1,7,30}`)
 * so a period change can be a tightening; removing a rule (or the whole map)
 * is the loosest possible write. The store replaces `spend` WHOLESALE, so this
 * gate diffs old-vs-new row by row BEFORE `updateProject` — the same placement
 * as `validateRolesPatchPriority`.
 */
const SPEND_PERIOD_DAYS: Record<SpendPeriod, number> = { day: 1, week: 7, month: 30 };

function dailyRate(rule: SpendLimitRule | null | undefined): number {
  if (!rule) return Number.POSITIVE_INFINITY; // no rule = unlimited = loosest
  return rule.amountUsd / SPEND_PERIOD_DAYS[rule.period];
}

function loosens(oldRule: SpendLimitRule | null | undefined, newRule: SpendLimitRule | null | undefined): boolean {
  return dailyRate(newRule) > dailyRate(oldRule);
}

export function validateLimitsPatchPriority(
  existing: ProjectRecord,
  patch: ProjectPatch,
  caller: ProjectPatchCaller,
): string | null {
  if (!patch.limits || !('spend' in patch.limits)) return null;
  const oldSpend = existing.limits?.spend;
  const newSpend = patch.limits.spend;
  const adminStrength = caller.priority <= BUILTIN_ROLE_PRIORITY.admin;

  const targetPriorityForRow = (axis: 'byRole' | 'byUser', key: string): number => {
    if (axis === 'byRole') {
      const def = existing.roles[key];
      return def ? rolePriority(key, def.priority) : WEAKEST_ROLE_PRIORITY;
    }
    const member = existing.members[key];
    if (!member) return WEAKEST_ROLE_PRIORITY;
    const def = existing.roles[member.role];
    return rolePriority(member.role, def?.priority);
  };

  // projectTotal + byAgent: loosening needs admin strength.
  if (loosens(oldSpend?.projectTotal, newSpend?.projectTotal) && !adminStrength) {
    return 'Cannot loosen the project-total spend limit: admin strength required';
  }
  const agentKeys = new Set([...Object.keys(oldSpend?.byAgent ?? {}), ...Object.keys(newSpend?.byAgent ?? {})]);
  for (const key of agentKeys) {
    if (loosens(oldSpend?.byAgent?.[key], newSpend?.byAgent?.[key]) && !adminStrength) {
      return `Cannot loosen the spend limit for agent "${key}": admin strength required`;
    }
  }

  // byRole / byUser: loosening needs a STRICTLY stronger caller than the target.
  for (const axis of ['byRole', 'byUser'] as const) {
    const keys = new Set([...Object.keys(oldSpend?.[axis] ?? {}), ...Object.keys(newSpend?.[axis] ?? {})]);
    for (const key of keys) {
      if (!loosens(oldSpend?.[axis]?.[key], newSpend?.[axis]?.[key])) continue;
      const targetPriority = targetPriorityForRow(axis, key);
      if (!(targetPriority > caller.priority)) {
        return `Cannot loosen the spend limit for ${axis === 'byRole' ? 'role' : 'member'} "${key}": only a strictly stronger caller may loosen it`;
      }
    }
  }
  return null;
}

/**
 * Parse a `PATCH /api/projects/[id]` body. `appearance` comes back on its own
 * (`AppearancePatch`, the shared user/project rule) because the stored value is
 * merged with the record's current one inside the write chain; it is NOT a
 * privileged key — like the name it is owner-strength, gated by the route.
 */
export function parseProjectPatch(body: unknown): {
  patch?: ProjectPatch;
  appearance?: AppearancePatch;
  error?: string;
  privileged: boolean;
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Invalid project patch body', privileged: false };
  }

  const patch: ProjectPatch = {};
  let appearance: AppearancePatch | undefined;
  let privileged = false;
  for (const [key, value] of Object.entries(body)) {
    if (!PROJECT_PATCH_KEYS.has(key)) {
      return { error: `Unsupported project patch field: ${key}`, privileged: false };
    }
    if (PRIVILEGED_PROJECT_PATCH_KEYS.has(key)) {
      privileged = true;
    }
    if (key === 'appearance') {
      try {
        appearance = parseAppearancePatch(value);
      } catch (err) {
        if (err instanceof AppearancePatchError || err instanceof AppearanceImageError) {
          return { error: err.message, privileged: false };
        }
        throw err;
      }
      continue;
    }
    const validationError = validateProjectPatchField(key, value);
    if (validationError) {
      return { error: validationError, privileged: false };
    }
    // The stored name is the trimmed one: `"X "` against a stored `"X"` is not a rename.
    (patch as Record<string, unknown>)[key] = key === 'name' ? (value as string).trim() : value;
  }

  return { patch, ...(appearance ? { appearance } : {}), privileged };
}

function validateProjectPatchField(key: string, value: unknown): string | null {
  switch (key) {
    case 'name':
      return validateProjectName(value);
    case 'description':
      return value === undefined || (typeof value === 'string' && value.length <= 2000)
        ? null
        : 'Project description must be a string up to 2000 characters';
    case 'members':
      return validateMembers(value);
    case 'roles':
      return validateRoles(value);
    case 'agentOwnership':
      return validateAgentOwnership(value);
    case 'limits':
      return validateLimits(value);
    default:
      return `Unsupported project patch field: ${key}`;
  }
}

/** The ONE project-name rule — the PATCH and both create routes call it. */
export function validateProjectName(value: unknown): string | null {
  if (typeof value !== 'string') return 'Project name must be a string';
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'Project name must not be empty';
  if (trimmed.length > 120) return 'Project name must be at most 120 characters';
  return null;
}

function validateMembers(value: unknown): string | null {
  if (!isPlainRecord(value)) return 'Project members must be an object';
  for (const [userId, member] of Object.entries(value)) {
    if (!isPlainRecord(member)) return `Project member "${userId}" must be an object`;
    const candidate = member as unknown as ProjectMember;
    for (const field of ['userId', 'name', 'email', 'role', 'position', 'addedAt'] as const) {
      if (typeof candidate[field] !== 'string') return `Project member "${userId}" field "${field}" must be a string`;
    }
    if (candidate.userId !== userId) return `Project member key must match userId: ${userId}`;
    if (!Number.isFinite(candidate.tier)) return `Project member "${userId}" tier must be a number`;
  }
  return null;
}

/**
 * STRUCTURAL shape floor for a role map. Exported because it has TWO callers:
 * the host `PATCH /api/projects/[id]` (through `validateProjectPatchField`) and
 * `admin/patchProjectRoles.ts`, the body behind the admin package's
 * `PATCH config/roles`. Neither the kernel write floor nor the record invariant
 * covers this — `validateRoleMapWrite`'s `normalizedGrants` maps a non-array to
 * `[]` rather than rejecting it, and `validateProjectInvariants` inspects no role
 * SHAPE at all — so without this call the second path persisted
 * `{"grantedFeatures":"x"}` while the first refused the byte-identical body.
 */
export function validateRoles(value: unknown): string | null {
  if (!isPlainRecord(value)) return 'Project roles must be an object';
  for (const [roleName, role] of Object.entries(value)) {
    if (!isPlainRecord(role)) return `Project role "${roleName}" must be an object`;
    const candidate = role as unknown as RoleDefinition;
    if (!ROLE_AGENT_ACCESS.has(candidate.agents)) {
      return `Project role "${roleName}" agents must be "*", "own", or "view"`;
    }
    if (typeof candidate.canInvite !== 'boolean') return `Project role "${roleName}" canInvite must be boolean`;
    if (typeof candidate.canManageRoles !== 'boolean') return `Project role "${roleName}" canManageRoles must be boolean`;
    if (!Array.isArray(candidate.grantedFeatures) || !candidate.grantedFeatures.every((feature) => typeof feature === 'string')) {
      return `Project role "${roleName}" grantedFeatures must be a string array`;
    }
    // D-F — the same ONE kernel predicate as `validateRolesPatchPriority` and
    // the admin route's `patchProjectRoles`: an integer in 1..99. Replaces a
    // finite-number-only check that accepted `0`, `-1`, `2.5` and `1e9`.
    if (candidate.priority !== undefined && !isValidRolePriority(candidate.priority)) {
      return `Project role "${roleName}" priority must be an integer between ${MIN_ROLE_PRIORITY} and ${MAX_ROLE_PRIORITY}`;
    }
  }
  return null;
}

function validateAgentOwnership(value: unknown): string | null {
  if (!isPlainRecord(value)) return 'Project agentOwnership must be an object';
  for (const [agentId, ownership] of Object.entries(value)) {
    if (!isPlainRecord(ownership)) return `Agent ownership "${agentId}" must be an object`;
    const candidate = ownership as { createdBy?: unknown; assignedTo?: unknown };
    if (typeof candidate.createdBy !== 'string' || candidate.createdBy.trim().length === 0) {
      return `Agent ownership "${agentId}" createdBy must be a non-empty string`;
    }
    if (!Array.isArray(candidate.assignedTo) || !candidate.assignedTo.every((userId) => typeof userId === 'string')) {
      return `Agent ownership "${agentId}" assignedTo must be a string array`;
    }
  }
  return null;
}

const SPEND_PERIODS = new Set(['day', 'week', 'month']);
const SPEND_MAP_KEYS = new Set(['byRole', 'byUser', 'byAgent']);
/** Bounds only — no referential checks against members/roles, so a stale key never bricks a save. */
const MAX_SPEND_RULE_KEY_LENGTH = 128;
const MAX_SPEND_RULES_PER_MAP = 500;

function validateSpendRule(path: string, value: unknown): string | null {
  if (value === null) return null;
  if (!isPlainRecord(value)) return `${path} must be { amountUsd, period } or null`;
  for (const key of Object.keys(value)) {
    if (key !== 'amountUsd' && key !== 'period') return `Unsupported field ${path}.${key}`;
  }
  const { amountUsd, period } = value as { amountUsd?: unknown; period?: unknown };
  if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd) || amountUsd < 0) {
    return `${path}.amountUsd must be a finite number >= 0`;
  }
  if (typeof period !== 'string' || !SPEND_PERIODS.has(period)) {
    return `${path}.period must be one of day | week | month`;
  }
  return null;
}

function validateLimits(value: unknown): string | null {
  if (!isPlainRecord(value)) return 'Project limits must be an object';
  // Closed key set — an unknown key used to pass straight to disk (F3).
  for (const key of Object.keys(value)) {
    if (key !== 'spend' && key !== 'rateLimitRpm') return `Unsupported project limits field: ${key}`;
  }
  const spend = value.spend;
  if (spend !== undefined) {
    if (!isPlainRecord(spend)) return 'Project limits.spend must be an object';
    for (const key of Object.keys(spend)) {
      if (key !== 'projectTotal' && !SPEND_MAP_KEYS.has(key)) {
        return `Unsupported project limits.spend field: ${key}`;
      }
    }
    const totalError = validateSpendRule('Project limits.spend.projectTotal', (spend as { projectTotal?: unknown }).projectTotal ?? null);
    if (totalError) return totalError;
    for (const key of ['byRole', 'byUser', 'byAgent'] as const) {
      const map = (spend as Record<string, unknown>)[key];
      if (!isPlainRecord(map)) return `Project limits.spend.${key} must be an object`;
      const entries = Object.entries(map);
      if (entries.length > MAX_SPEND_RULES_PER_MAP) {
        return `Project limits.spend.${key} must hold at most ${MAX_SPEND_RULES_PER_MAP} rules`;
      }
      for (const [entryKey, rule] of entries) {
        if (entryKey.length === 0 || entryKey.length > MAX_SPEND_RULE_KEY_LENGTH) {
          return `Project limits.spend.${key} keys must be 1..${MAX_SPEND_RULE_KEY_LENGTH} characters`;
        }
        const ruleError = validateSpendRule(`Project limits.spend.${key}.${entryKey}`, rule);
        if (ruleError) return ruleError;
      }
    }
  }
  // A string here used to reach disk and silently DISABLE the rate limit at the
  // limiter's non-finite check while the admin UI still showed it configured (F3).
  const rpm = (value as { rateLimitRpm?: unknown }).rateLimitRpm;
  if (rpm !== undefined && rpm !== null) {
    if (typeof rpm !== 'number' || !Number.isFinite(rpm) || rpm < 1) {
      return 'Project limits.rateLimitRpm must be null or a number >= 1';
    }
  }
  return null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
