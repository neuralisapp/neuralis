import { FileStore, reportStoreIntegrity, type Logger } from './FileStore';
import { getEnv } from '../config/env';
import { ensureHostDataFormat, HOST_DATA_FORMATS } from './dataFormats';
import { assertRecordFormat } from '@neuralis/package-system/data';
import { join } from 'path';
import { stat } from 'fs/promises';
import { nowISO, projectIdFromName } from '@/lib/utils';
import {
  rolePriority,
  isBuiltinRole,
  DEFAULT_CUSTOM_ROLE_PRIORITY,
  BUILTIN_ROLE_PRIORITY,
  MIN_ROLE_PRIORITY,
  MAX_ROLE_PRIORITY,
} from '@neuralis/package-system/access';
import { isSafePathSegment, resolveProjectRoot } from '@neuralis/package-system/paths';
import { initProjectDirectory } from '../projects/projectInit';
import { validateProjectInvariants } from './projectInvariants';
import {
  DEFAULT_ROLES,
  DEFAULT_SPEND_LIMITS,
  type ProjectRecord,
  type ProjectMember,
  type RoleDefinition,
  type SpendLimits as SpendLimitsShape,
} from './projectTypes';

export type { ProjectRecord, ProjectMember } from './projectTypes';
export { DEFAULT_ROLES } from './projectTypes';

/**
 * The store is anchored on `globalThis` because "module-level singleton" is a
 * per-BUNDLE claim, not a per-process one — the `AuditStore` appender and the
 * `PlatformConfigStore` precedent, and this module needed it for a SECOND
 * reason those two do not have: a READ CACHE.
 *
 * Next compiles this module into every graph that imports it. The baked image
 * carries THREE copies (measured 2026-09-07: the instrumentation/bootstrap
 * graph, the route graph and the SSR graph each load a different chunk defining
 * `ProjectUpdateError` + the `cacheTtlMs` construction). Each copy got its own
 * `FileStore`, hence its own 2 s read cache AND its own `bust()` — so a write
 * from the bootstrap graph invalidated only the writer's cache while a route
 * handler kept serving pre-write bytes.
 *
 * State the window precisely: it runs for up to ~2 s **after the last read that
 * FILLED the reader's cache**, never as a fixed delay after the write. Measured
 * by bisection: the flip came at ~1.7 s when the preceding read was 200 ms
 * before the write, and at ~2.5 s when it was 3.2 s before.
 *
 * Live symptom (2026-09-07): an agent delete pruned `agentOwnership` through the
 * agent-lifecycle hook, which runs in the BOOTSTRAP graph. The record file on
 * disk was already pruned before the DELETE returned 200 — sampled at +0 ms —
 * while `GET /api/projects/<id>` still carried the key at +0 / +500 / +1500 ms
 * and only cleared at +2500 ms. A PATCH through the ROUTE graph was visible to
 * that same GET immediately, which is the control that isolates it to
 * cross-graph writes. The admin tab refetches once, ~100 ms after its DELETE,
 * so it baked the stale map into client state and the phantom row outlived the
 * window until a remount: the client was doing the right thing with wrong data,
 * which is why the fix belongs here and not in the tab.
 *
 * `Symbol.for` so every copy resolves the SAME slot. The 2 s TTL stays exactly
 * as it was: it is the authz-revocation staleness floor, and it was never the
 * defect — the defect was that a bust could not reach the other caches.
 */
const STORE_SLOT = Symbol.for('@neuralis/host:projectStore');
const ROLE_GRANT_VERSION = 19;

/**
 * A project-record signal, emitted after the write resolved, naming the users it
 * concerns. Two kinds are a REAL loss of project access: `members_removed`
 * (members dropped from the member map) and `project_closed` (archived or
 * deleted as a whole — it carries the member ids, since a deleted project cannot
 * be read afterwards). `record_changed` is NOT a loss: a created, restored or
 * patched record changed what its members may see (name, description, members,
 * roles), and `userIds` is the member set BEFORE ∪ AFTER, so a removed member's
 * project list drops it too. The migrate-on-read persist emits nothing.
 */
export type MembershipChangeEvent =
  | { kind: 'members_removed'; projectId: string; userIds: string[] }
  | { kind: 'project_closed'; projectId: string; cause: 'archived' | 'deleted'; userIds: string[] }
  | { kind: 'record_changed'; projectId: string; userIds: string[] };

export type MembershipChangeListener = (event: MembershipChangeEvent) => void;

/** `globalThis`-anchored for the reason `UserStore`'s listener set is. */
const LISTENERS_SLOT = Symbol.for('@neuralis/host:projectStoreListeners');

function membershipListeners(): Set<MembershipChangeListener> {
  const g = globalThis as { [LISTENERS_SLOT]?: Set<MembershipChangeListener> };
  return (g[LISTENERS_SLOT] ??= new Set());
}

export function onMembershipChange(listener: MembershipChangeListener): () => void {
  membershipListeners().add(listener);
  return () => {
    membershipListeners().delete(listener);
  };
}

/** Called AFTER the write resolved — never inside the store's per-path chain. */
function emitMembershipChange(event: MembershipChangeEvent): void {
  for (const listener of membershipListeners()) {
    try {
      listener(event);
    } catch (err) {
      console.error('[ProjectStore] membership listener threw', err);
    }
  }
}

function emitRemovedMembers(
  projectId: string,
  before: ProjectRecord['members'],
  after: ProjectRecord['members'],
): void {
  const userIds = Object.keys(before).filter((userId) => before[userId] && !after[userId]);
  if (userIds.length > 0) emitMembershipChange({ kind: 'members_removed', projectId, userIds });
}

function emitRecordChanged(projectId: string, ...memberMaps: ProjectRecord['members'][]): void {
  const userIds = [...new Set(memberMaps.flatMap((members) => Object.keys(members)))];
  if (userIds.length > 0) emitMembershipChange({ kind: 'record_changed', projectId, userIds });
}

/**
 * The workspace-facing view of `record_changed`: fires only for a record the
 * given user is (or just was) a member of, and hands over the project id ALONE —
 * no name, no member ids. The client re-reads through the projected
 * `GET /api/projects`, which applies that caller's own view.
 */
export function onProjectRecordChange(
  userId: string,
  listener: (event: { projectId: string }) => void,
): () => void {
  return onMembershipChange((event) => {
    if (event.kind !== 'record_changed' || !event.userIds.includes(userId)) return;
    listener({ projectId: event.projectId });
  });
}

export class ProjectUpdateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectUpdateError';
  }
}

/**
 * Version-keyed additive grant REPAIRS — the propagation half of a manifest
 * `defaultRoleGrants` change. Builtin defaults apply at PROJECT CREATION (an
 * added builtin once more, by its grant-change record), so a new default of an
 * installed builtin never reaches an EXISTING project without a row here.
 *
 * `'*'` holders are skipped by the applier (the wildcard already covers every
 * id). Since role-grant version 13 that means only owner-strength roles are
 * skipped: `admin` now carries an ENUMERATED list, so a newly declared
 * `defaultRoleGrants.admin` id reaches existing projects through this lane like
 * any other role's — add `<next version>: { admin: ['<new.id>'] }` alongside the
 * manifest declaration.
 */
const ROLE_GRANT_REPAIRS: Record<number, Record<string, string[]>> = {
  1: {
    manager: ['core.agents'],
    member: ['core.agents'],
    viewer: ['core.agents'],
  },
  // S2c C1 — `core.execute` split into `core.observe` (read-only introspection)
  // + `core.web` (web tools). Backfill the new read-tier grants onto existing
  // projects so the reassigned routes/tools stay reachable. `'*'` roles
  // (owner/admin) are skipped by the applier. Member `core.execute` is a
  // separate, deliberate change (C-mid, D1) under its own version.
  2: {
    manager: ['core.observe', 'core.web'],
    member: ['core.observe', 'core.web'],
    viewer: ['core.observe'],
  },
  // S2c C-mid (D1) — members stream: grant `core.execute`.
  3: {
    member: ['core.execute'],
  },
  // modular-meerkat Inc 1 — workflow engine grants (M10): manager full
  // r/w/dispatch, member r/w (no dispatch), viewer read-only. The legacy
  // `orchestrator.*` ids die with the package (never granted by repair, so
  // nothing to revoke).
  4: {
    manager: ['workflow.read', 'workflow.write', 'workflow.dispatch'],
    member: ['workflow.read', 'workflow.write'],
    viewer: ['workflow.read'],
  },
  // modular-meerkat Inc 4 — per-user channels (M10 revised / M12, architect
  // F1): `channels.connect` authorizes USER-scope connections only, so it is
  // member-granted by default; project-scope ops sit behind `channels.manage`
  // (no grant below the `admin` tier — enumerated for `admin`, `'*'` for
  // `owner`, grantable per role; the C8 pattern).
  // Manifest defaultRoleGrants alone never reach EXISTING projects — this
  // repair is the propagation half.
  5: {
    manager: ['channels.connect'],
    member: ['channels.connect'],
  },
  // Composer prompt-polish — one-shot draft rewrite, manager+member default
  // (mirrors the agent-core manifest defaultRoleGrants; live-test found the
  // missing propagation half: members on existing projects got 403).
  6: {
    manager: ['core.prompt-polish'],
    member: ['core.prompt-polish'],
  },
  // MCP1 Inc2 — `mcp.connect` authorizes connecting YOUR OWN external MCP
  // servers (OAuth flow initiation + self-scope token storage). Mirrors the
  // channels.connect pattern: manager+member default; project/global MCP
  // secrets stay on the admin Credentials surface (`project.credentials.write`
  // — no grant below the `admin` tier).
  7: {
    manager: ['mcp.connect'],
    member: ['mcp.connect'],
  },
  // G4 keyring-kestrel — `git.connect` authorizes connecting YOUR OWN git
  // remotes (token/PAT self-scope storage). Mirrors mcp.connect/channels.connect:
  // manager+member default; project/agent-scope git tokens stay on the admin
  // Credentials surface (`project.credentials.write` — no grant below the
  // `admin` tier).
  8: {
    manager: ['git.connect'],
    member: ['git.connect'],
  },
  // Phase M (credentials BYOK) — `credentials.self` authorizes setting YOUR OWN
  // credentials (catalog + custom ids) in your OWN user scope from the chat
  // config panel. Mirrors git.connect/mcp.connect/channels.connect: manager+member
  // default; reserved git/channel/MCP ids stay on their own connect surfaces;
  // project/global secrets stay on the admin Credentials surface
  // (`project.credentials.write` — no grant below the `admin` tier).
  // Propagation half for existing
  // projects (manifest defaultRoleGrants alone never reach EXISTING projects).
  9: {
    manager: ['credentials.self'],
    member: ['credentials.self'],
  },
  // native-nightjar H0 follow-up (live-caught 2026-07-21) — `terminal.read` for
  // the two roles agent-core declares it for.
  //
  // Builtin `defaultRoleGrants` are applied at PROJECT CREATION (an added
  // builtin once more, through `reconcileBuiltinGrantChanges` — never a new
  // default of an installed one), so a project created before the terminal shipped — or one whose roles were
  // hand-edited — never receives a later default. The live test found exactly
  // that: one project's `member`/`manager` hold no `terminal.*` id at all, so
  // the Terminal widget is not merely locked but ABSENT from the widget and
  // dock listings, with no diagnostic anywhere. A silently missing capability
  // is worse than a denied one.
  //
  // The terminal package folding into agent-core is what makes this the right
  // moment: the feature's declaring package changed, and this is the mechanism
  // that carries a builtin's declared default onto existing projects. Scoped to
  // `manager` + `member` to match the manifest — `viewer`/`newRole` keep their
  // v3 revoke.
  11: {
    manager: ['terminal.read'],
    member: ['terminal.read'],
  },
  // neuralweb repair Inc 3 — `packages.registry` gates being SHOWN the
  // neuralweb marketplace skill (advertisement control; access stays at
  // core.execute + the shell gates). Declared by brain-core — NOT by the CLI
  // package that carries the skill — so `adminGrantCoverage.test.ts` governs
  // it (the test derives its set from `@neuralis/*` manifests only; a feature
  // declared by any other builtin reaches DEFAULT_ROLES.admin at runtime but
  // escapes the test — P3). Granted down to `member` to match the manifest;
  // `viewer` holds no shell, so advertising it there would be noise.
  //
  // `admin` MUST be named here too (live-tester catch, 2026-08-06): since the
  // D-C de-wildcard, an EXISTING project's `admin` holds an enumerated list
  // that was materialized when v13 ran — the manifest-derived union is NOT
  // re-derived on later migrations, so a new id declared after v13 reaches an
  // existing project's admin ONLY through a repair row naming it. "admin
  // arrives through the manifest union" is true at PROJECT CREATION only.
  // Only `'*'` holders (owner-strength) are skipped by the applier.
  14: {
    admin: ['packages.registry'],
    manager: ['packages.registry'],
    member: ['packages.registry'],
  },
  // agent-governance Increment A — the create-projects-and-users skill's two
  // admin-granted ids (`platform.projects.create` deliberately has NO grant:
  // its real floor is owner-strength inside the host service). Both ids ship
  // in the SAME commit as this row — a later-landing feature needs its OWN
  // version row, editing an already-stamped one is inert on deployed projects.
  15: {
    admin: ['project.members.invite', 'project.agents.assign'],
  },
  // periodic-pelican phase 2 (D2) — `project.limits` gates READING other
  // members' per-user spend caps through the new feature-keyed project
  // projection (`server/projects/projectView.ts`). Admin-tier read by default;
  // writing limits stays behind the `canManageRoles` flag (which also implies
  // the full read via the projection's write-implies-read carve-out). `admin`
  // must be named per the v14 lesson: an existing project's admin holds an
  // enumerated list, so a post-v13 id reaches it only through a repair row.
  16: {
    admin: ['project.limits'],
  },
  // partitioned-plover — `core.connectors` gates every MUTATING arm of
  // `/connectors/*`. Those seven arms previously sat behind the module's
  // `core.observe`, which is a VIEWER default, so the weakest role in the
  // product could create, repoint, disable and delete connectors. READ stays on
  // `core.observe` — the gate moves, it does not shrink.
  //
  // `admin` must be named for the same v14 reason as the two rows above: an
  // existing project's admin holds an ENUMERATED list, so a newly declared
  // `defaultRoleGrants.admin` id reaches it only through a repair row. Without
  // this, every existing project's admin would be locked out of a plane they
  // hold today.
  18: {
    admin: ['core.connectors'],
  },
};

/**
 * Version-keyed feature RENAMES — the third migration primitive
 * (native-nightjar H1', 2026-07-21).
 *
 * The additive repairs and subtractive revokes above are keyed by ROLE NAME, so
 * neither can express "this feature id was renamed" for a role the platform
 * does not enumerate. A CUSTOM role (`devops`) that explicitly holds
 * `core.shell.host` would silently LOSE the grant under a repair+revoke pair,
 * because no repair row names it. That is a capability regression, and exactly
 * the thing a rename must not do.
 *
 * So renames iterate `Object.keys(r.roles)` — every role, builtin or custom —
 * and rewrite the id in place, preserving position and de-duplicating if the
 * target id is already present. `'*'` holders are skipped: the wildcard already
 * covers both the old and the new id, so touching them would be a no-op that
 * only risks losing the wildcard.
 *
 * A value may be a single id (1:1) or an ARRAY (1:N fan-out) — a namespace SPLIT
 * cannot be expressed as a 1:1 rename, and a custom role that held the old fused
 * id must receive every successor or it silently loses capability.
 *
 * A source id MAY appear in its own fan-out (a DERIVED grant): the id is kept,
 * at its original position, and the successor is added beside it. That is the
 * only shape in which a rename may hand out an id the role did not literally
 * hold, and it is capability PRESERVATION, not invention — the successor gates
 * exactly what the retained id already reached, so leaving it out would be the
 * regression. It is idempotent by the same de-duplication as every other row.
 */
const ROLE_GRANT_RENAMES: Record<number, Record<string, string | string[]>> = {
  // native-nightjar H1' — the exec/terminal features split into two PLANES.
  // The old ids said "host" but only ever meant "unrestricted INSIDE the
  // container"; the genuinely host-plane features were that round's NEW
  // `core.shell.native` / `terminal.native` (no grant below the admin tier,
  // gated behind operator-provisioned broker artifacts) — `core.shell.native`
  // is `exec.host` since v19. Renaming keeps every existing grant's real-world
  // meaning byte-identical.
  10: {
    'core.shell.host': 'core.shell.container',
    'terminal.host': 'terminal.container',
  },
  // D-D — the `admin.*` namespace is REPLACED by `project.*` (the decision acts
  // inside `session.projectId`) and `platform.*` (the decision crosses the
  // project boundary: another tenant, a platform-global file, cross-user PII,
  // the `global` credential scope).
  //
  // Two of the old ids each fused several independent powers onto one grantable
  // thing — `admin.users` was simultaneously the Users tab, the cross-project
  // list, the platform audit log and the whole `assertScopeMatchesSession`
  // bypass. Those fan out 1:N so an existing custom holder keeps every power it
  // had; the SPLIT is what makes the new ids individually grantable.
  13: {
    'admin.dashboard': 'project.dashboard',
    'admin.audit': 'project.audit',
    'admin.canvas': 'project.canvas',
    'admin.credentials': 'project.credentials',
    'admin.credentials.write': 'project.credentials.write',
    'admin.vector': 'platform.vector.reset',
    'admin.users': [
      'project.members',
      'platform.projects',
      'platform.users',
      'platform.scope',
      'platform.audit',
    ],
    'admin.config': ['project.roles', 'project.sources', 'platform.config', 'platform.vector'],
  },
  // v19 — every shell ENTRY moves into the `exec.*` namespace, so the
  // id names the PLANE a shell opens on: `exec.unconfined` (the container
  // bypass, formerly `core.shell.container`), `exec.host` (the host plane,
  // formerly `core.shell.native`), `exec.machine` (machine-core's Webtop,
  // formerly `machine.exec`). The terminal ids are deliberately untouched.
  //
  // `core.execute` fans out onto ITSELF plus the NEW container ENTRY: until now
  // the container plane had no entry feature at all, so every role that could
  // run the `execute` tool could open a container shell. `exec.container` is
  // that door, and a role holding `core.execute` already walked through it —
  // without the derived grant the migration would silently take a working
  // capability away from every custom role.
  19: {
    'core.shell.container': 'exec.unconfined',
    'core.shell.native': 'exec.host',
    'machine.exec': 'exec.machine',
    'core.execute': ['core.execute', 'exec.container'],
  },
};

// Version-keyed grant REVOCATIONS (the additive repairs above cannot remove).
// Used for deliberate grant tightenings on existing projects. `'*'` roles are
// skipped (they hold everything by wildcard, nothing to remove).
const ROLE_GRANT_REVOKES: Record<number, Record<string, string[]>> = {
  // S2c C-mid (D4) — viewer/newRole lose terminal.read (a viewer must not reach
  // terminal routes/widget; the Container Root tab is gated by terminal.container).
  3: {
    viewer: ['terminal.read'],
    newRole: ['terminal.read'],
  },
};

// ---------------------------------------------------------------------------
// D-F (role-grant version 12) — the priority SCALE change.
//
// The five built-in anchors moved from 1/2/3/4/5 to 1/2/10/20/30 so a custom
// role can slot BETWEEN two built-ins without renumbering, and the declared
// range became 1..99 (`isValidRolePriority`, the ONE kernel predicate). Three
// version-keyed phases carry that onto existing records.
//
// Every phase REPLACES the role/member object (`{ ...role, … }`) and never
// mutates it in place: `migrateProjectRecord` seeds a role-less legacy record
// with `r.roles = { ...DEFAULT_ROLES }`, a SHALLOW spread, so the role objects
// are the very `DEFAULT_ROLES` entries — an in-place write would corrupt the
// module-level seed for every project handled later in the same process.
//
// These phases fire only while the loop is at version 12, which is what makes a
// second boot a no-op. The priority re-anchor is deliberately NOT self-
// idempotent (it rewrites a 1..5 scale onto a 1..30 scale, and 10/20/30 are
// themselves legal inputs on the old scale), so the version gate is load-bearing
// here in a way it is not for repairs/renames/revokes. Do not call these
// helpers outside the version loop.
// ---------------------------------------------------------------------------

/** P0 — re-anchor every role's priority onto the 1..99 scale. */
const ROLE_PRIORITY_REANCHOR_VERSIONS = new Set([12]);
/** P5 — translate the deleted `PRIVILEGED_ROLE_NAMES` set into the stored flag. */
const ROLE_MANAGE_FLAG_VERSIONS = new Set([12]);
/** P6 — re-derive the `ProjectMember.tier` mirror from the new priorities. */
const MEMBER_TIER_REDERIVE_VERSIONS = new Set([12]);

// ---------------------------------------------------------------------------
// D-C (role-grant version 13) — take the `'*'` wildcard off every role that is
// not owner-STRENGTH and hand it the enumerated, manifest-derived catalog
// instead. Runs AFTER the v13 renames, which skip `'*'` roles: an admin still
// holding the wildcard at that point is untouched by the rename pass and is
// de-wildcarded here directly with the NEW ids.
// ---------------------------------------------------------------------------

/** P4 — replace `'*'` with the enumerated project-tier catalog. */
const ROLE_DEWILDCARD_VERSIONS = new Set([13]);

// ---------------------------------------------------------------------------
// S1 (role-grant version 17) — SEEDED-OWNER AUTHORITY HEAL.
//
// The S1 role-map floor makes "you may only edit roles strictly weaker than
// yourself" structural. That closes the hole that let a priority-2 caller empty
// a priority-1 role's grant list — but it also makes any damage ALREADY on disk
// permanent: the role's own holders cannot restore what they no longer hold, and
// nobody weaker may reach up to it. So the repair ships in the SAME increment as
// the closure, unconditionally.
//
// Fingerprint: ONE key — the seeded `owner` role — carrying an EMPTY grant list.
//
// It is deliberately NOT "any apex role with an empty list", and the difference
// matters. `canManageRoles` is a FLAG, not a feature, so a custom priority-1 role
// with `grantedFeatures: []` is a coherent operator design: a governance-only
// apex role that holds no capability at all. Pre-S1 an owner could mint exactly
// that (CREATE compared with `<`, and `validateRoles` accepts an empty list), and
// promoting it to `'*'` would be a privilege ESCALATION granted by a migration —
// against the operator's explicit configuration, and across the project boundary,
// because `hasFeature`'s `'*'` arm matches `platform.*` too. That is precisely
// the ambiguity `seedRolesForNewProject`'s docblock below refuses to guess at,
// and this phase must not contradict it.
//
// `roles.owner` is the one key where the fingerprint is NOT ambiguous, and the
// reason is structural rather than name-based: `validateProjectInvariants`
// REQUIRES it to exist and requires the project's provenance owner to hold it,
// and the seed defines its value as `['*']`. A project whose seeded owner role
// holds nothing has no functioning owner — that is broken, not configured.
//
// Name-keyed, therefore, exactly like `LEGACY_ROLE_MANAGE_NAMES` (P5) two phases
// up: a one-time DATA translation, never an authorization path. D-A forbids a
// role NAME on a decision path; the S1 write floor it repairs is keyed on the
// priority NUMBER and stays that way.
//
// RAISE-ONLY, idempotent (after the first pass the list is `['*']`), and it WARNS
// — a silent repair of a security-relevant field is not acceptable, and P4 one
// phase up sets the precedent.
// ---------------------------------------------------------------------------

/** P7 — restore `'*'` on the seeded owner role when its grant list was emptied. */
const APEX_AUTHORITY_HEAL_VERSIONS = new Set([17]);

/**
 * The role key `validateProjectInvariants` pins (it must exist, and the project's
 * provenance owner must hold it). Seed data / migration data only — never a
 * decision path (D-A).
 */
const SEEDED_OWNER_ROLE_NAME = 'owner';

/**
 * Liveness probe for the enumerated admin union — the SHARED floor of BOTH
 * writers that can persist it.
 *
 * `DEFAULT_ROLES.admin.grantedFeatures` is derived at module load from every
 * builtin manifest through `readPackageRequires`, whose body swallows ALL read
 * errors (`catch { return undefined }`), over a builtin set the `NEURALIS_BUILTINS`
 * env var can override (documented for slim images). A missing, unreadable or
 * deliberately-narrowed manifest therefore yields a SHORT or EMPTY union with no
 * throw and no log — and either writer would persist it at
 * `roleGrantVersion: ROLE_GRANT_VERSION`, after which the version gate makes it
 * unrepeatable. Every project admin would lose the dashboard, credentials,
 * config, canvas, logs, terminal, workflows, MCP and every `core.*` id, silently
 * and permanently.
 *
 * So both writers fail CLOSED on the same input — one id from each of the three
 * packages that must be present in a healthy union — but they fail closed
 * DIFFERENTLY, because the record they act on is different:
 *
 *  - `migrateProjectRecord` P4 (EXISTING records) HALTS: the record keeps the
 *    `'*'` it already held, its `roleGrantVersion` stops one BELOW the
 *    de-wildcard row (12), and the next healthy boot replays P4 — the v13
 *    renames that already ran are idempotent. Keeping a wildcard a record
 *    ALREADY carries is status quo, not a widening.
 *  - `createProject` (NEW records) REFUSES — it throws
 *    `ROLE_SEED_UNION_DEGENERATE` and persists nothing. A record born after D-C
 *    never had a pre-de-wildcard state, so seeding `'*'` on it would be a real
 *    widening: `hasFeature`'s `'*'` arm matches `platform.*` too, so that
 *    project's `admin` would hold PLATFORM-tier power (foreign projects, the
 *    `global` credential scope, the platform audit log) until the next healthy
 *    boot. And the three non-admin builtins would be seeded from the same
 *    degenerate module-load lists with NO later repair at all — there is no
 *    `ROLE_GRANT_REPAIRS` row at 12 or 13 — so `manager`/`member`/`viewer`
 *    would stay permanently empty.
 *
 * A missed tightening is deferrable; a bricked admin is an outage; a
 * platform-tier admin on a brand-new project is neither — it is a hole, and the
 * deny-by-default answer is to write nothing.
 */
const DEWILDCARD_LIVENESS_IDS = ['project.dashboard', 'drive.read', 'core.agents'] as const;

let warnedDegenerateAdminGrants = false;

/**
 * `true` when the manifest-derived union is safe to persist as `admin`'s
 * enumerated grant list. Exported because it is the ONE predicate both writers
 * share — do not re-implement it at a third write site.
 */
export function adminGrantUnionIsLive(nextAdminGrants: readonly string[]): boolean {
  if (nextAdminGrants.length === 0) return false;
  return DEWILDCARD_LIVENESS_IDS.every((id) => nextAdminGrants.includes(id));
}

/** Old built-in scale → new anchors. Applied to CUSTOM roles only (built-ins take their anchor directly). */
const LEGACY_PRIORITY_BANDS: Record<number, number> = { 1: 1, 2: 2, 3: 10, 4: 20, 5: 30 };

/**
 * Roles whose name USED to imply `canManageRoles` through the deleted
 * `PRIVILEGED_ROLE_NAMES` set in `projects/access.ts`.
 *
 * This is a one-time DATA translation of the old name-keyed semantics into the
 * stored flag — the same class as `ROLE_GRANT_RENAMES`, and exactly what D-A
 * preserves ("`DEFAULT_ROLES` stays seed data; the hardcode to kill is on the
 * decision PATHS"). It is deliberately NOT priority-keyed: a CUSTOM role at
 * priority 2 named e.g. `lead` with `canManageRoles: false` cannot manage roles
 * today (its name is not in the set), so raising it by priority would be a
 * privilege ESCALATION granted by a migration, against the owner's explicit
 * configuration.
 */
const LEGACY_ROLE_MANAGE_NAMES = ['owner', 'admin'] as const;

/**
 * Map a CUSTOM role's stored priority from the old 1..5 scale onto the new
 * 1..99 scale, **never toward stronger**.
 *
 * - unparseable / non-finite ⇒ `MAX_ROLE_PRIORITY` (weakest — fail safe);
 * - `<= 0` (storable today: there was no range check) ⇒ `MIN_ROLE_PRIORITY`.
 *   It already resolved as "stronger than owner", so clamping it INTO the range
 *   at the strongest legal value is the smallest possible demotion and can never
 *   be an escalation;
 * - `1..5` ⇒ the band table, preserving relative strength against the built-ins;
 * - `>= 6` ⇒ clamped into `viewer+1 .. MAX`. Under the old scale such a role was
 *   WEAKER than `viewer` (5); leaving it at its face value would silently make it
 *   STRONGER than `manager` (10) on the new scale — a migration-granted
 *   escalation. Ordering among these roles is preserved.
 */
function remapLegacyCustomPriority(value: number): number {
  if (!Number.isFinite(value)) return MAX_ROLE_PRIORITY;
  const rounded = Math.round(value);
  if (rounded <= 0) return MIN_ROLE_PRIORITY;
  const banded = LEGACY_PRIORITY_BANDS[rounded];
  if (banded !== undefined) return banded;
  const weakestBuiltin = BUILTIN_ROLE_PRIORITY.viewer;
  return Math.min(Math.max(rounded, weakestBuiltin + 1), MAX_ROLE_PRIORITY);
}

function getStore(): FileStore<ProjectRecord> {
  const g = globalThis as { [STORE_SLOT]?: FileStore<ProjectRecord> };
  // Short read-cache: the catch-all reads every project from disk on EVERY
  // request (membership/role/disabled gates), which contends with stream disk
  // I/O. A 2s TTL collapses request-burst reads to one disk hit while bounding
  // authz-revocation staleness to the TTL even across an out-of-band writer.
  // ONE instance per PROCESS (see STORE_SLOT) — never per bundle, or a write in
  // one graph leaves the other graphs' caches serving stale bytes.
  return (g[STORE_SLOT] ??= new FileStore<ProjectRecord>(
    join(getEnv().appRoot, 'projects'),
    { cacheTtlMs: 2_000 },
  ));
}

/**
 * The store behind every operation: the host data-format claim runs first, so
 * no project record is read — and migrated-on-read — by a build older than the
 * data (one resolved promise + a Map lookup after the first call).
 */
async function claimedStore(): Promise<FileStore<ProjectRecord>> {
  await ensureHostDataFormat(HOST_DATA_FORMATS.project);
  return getStore();
}

/**
 * THE per-record write floor. `roleGrantVersion` is the project record's format
 * marker: a record stamped by a NEWER build stays readable, but this build
 * refuses to write it (`RecordNewerError`) — every write here would run this
 * build's normalizers over fields it does not know.
 */
function assertProjectRecordWritable(raw: unknown): void {
  assertRecordFormat(HOST_DATA_FORMATS.project.kind, storedRoleGrantVersion(raw), ROLE_GRANT_VERSION);
}

function isNewerProjectRecord(raw: unknown): boolean {
  const stored = storedRoleGrantVersion(raw);
  return stored !== undefined && stored > ROLE_GRANT_VERSION;
}

function storedRoleGrantVersion(raw: unknown): number | undefined {
  const stored = (raw as { roleGrantVersion?: unknown } | null)?.roleGrantVersion;
  return typeof stored === 'number' ? stored : undefined;
}

/**
 * The purged-id tombstones, beside (never inside) `app/projects/`: four readers
 * parse every `*.json` in that directory as a project record. No read cache — a
 * tombstone is consulted only when an id is minted.
 */
function purgedIdsDir(): string {
  return join(getEnv().appRoot, 'projects-purged');
}

/**
 * Record that `id` was permanently deleted, so it is never minted again. Written
 * as the FIRST step of a purge: a purge that fails half-way still blocks the id,
 * and a retry rewrites the same tombstone. Anything a package keyed by the id and
 * failed to remove (vectors, desktop profiles, tokens) can never be inherited by
 * a later project of the same name. Restoring a record that is tombstoned but was
 * never purged (the purge failed before the record went) stays legal; the
 * tombstone is then inert, since the record itself already holds the id.
 */
export async function markProjectIdPurged(id: string): Promise<void> {
  await ensureHostDataFormat(HOST_DATA_FORMATS.projectPurged);
  await new FileStore<{ id: string; purgedAt: string }>(purgedIdsDir()).put(id, { id, purgedAt: nowISO() });
}

/**
 * An id is taken while ANY tenant-keyed trace of it exists, not only a record:
 * `initProjectDirectory` creates INTO an existing tree, the source-config and
 * project-credential dirs are keyed by the same id (so a surviving credential blob
 * would decrypt for the new tenant), and a purged id keeps its tombstone. Any stat
 * error other than ENOENT is RETHROWN: the create is refused. Answering "taken"
 * instead would spin `resolveUniqueId` forever on an unreadable root.
 */
async function isProjectIdTaken(candidate: string): Promise<boolean> {
  if (await (await claimedStore()).get(candidate)) return true;
  const { projectsRoot, appRoot } = getEnv();
  const traces = [
    () => resolveProjectRoot(projectsRoot, candidate),
    () => join(appRoot, 'config', 'sources', candidate),
    () => join(appRoot, 'credentials', 'projects', candidate),
    () => join(purgedIdsDir(), `${candidate}.json`),
  ];
  for (const trace of traces) {
    try {
      await stat(trace());
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return false;
}

async function resolveUniqueId(baseId: string): Promise<string> {
  let candidate = baseId;
  let n = 2;
  while (await isProjectIdTaken(candidate)) {
    candidate = `${baseId}-${n}`;
    n += 1;
  }
  return candidate;
}

/** Exported for tests — applies role-grant repairs + revokes by version. */
export function migrateProjectRecord(raw: Record<string, unknown>): ProjectRecord {
  const r = raw as ProjectRecord;

  // Migrate legacy members array → map
  if (Array.isArray(r.members)) {
    const legacy = r.members as unknown as Array<{
      userId: string;
      name?: string;
      email?: string;
      role?: string;
      addedAt?: string;
    }>;
    const membersMap: Record<string, ProjectMember> = {};
    for (const m of legacy) {
      const roleName = m.role === 'editor' ? 'admin' : (m.role ?? 'member');
      membersMap[m.userId] = {
        userId: m.userId,
        name: m.name ?? '',
        email: m.email ?? '',
        role: roleName,
        // D-A — `position` is a free-text label an admin edits in the Users tab.
        // Synthesizing "Owner"/"Team Member" FROM the role name is exactly the
        // name-coupling D-A removes, and it made a custom priority-1 role read
        // as a plain team member. Empty = "not set", the same as an invite.
        position: '',
        // `tier` mirrors the role's priority. P6 re-derives it below once
        // `r.roles` is populated; this seeds it from the anchors so the record
        // is never internally inconsistent between the two statements.
        tier: rolePriority(roleName),
        addedAt: m.addedAt ?? r.createdAt ?? nowISO(),
      };
    }
    r.members = membersMap;
  }

  if (!r.roles || Object.keys(r.roles).length === 0) {
    r.roles = { ...DEFAULT_ROLES };
  }
  // Backfill role priority on legacy records (added with the role-priority gate).
  // Built-in names get their anchored priority; pre-existing custom roles get a
  // gated mid-tier default. New/edited roles must carry an explicit priority.
  //
  // The backfill writes values on the CURRENT scale, so the v12 re-anchor below
  // must not then re-map them as if they were old-scale numbers: a custom role
  // with no stored priority is backfilled to `DEFAULT_CUSTOM_ROLE_PRIORITY` (20)
  // and must STAY there, not be pushed past `viewer` by the out-of-band clamp.
  const backfilledRoleNames = new Set<string>();
  for (const [roleName, role] of Object.entries(r.roles)) {
    if (typeof role.priority !== 'number' || !Number.isFinite(role.priority)) {
      backfilledRoleNames.add(roleName);
      r.roles[roleName] = {
        ...role,
        priority: isBuiltinRole(roleName) ? rolePriority(roleName) : DEFAULT_CUSTOM_ROLE_PRIORITY,
      };
    }
  }
  if (!r.agentOwnership) {
    r.agentOwnership = {};
  }
  if (!r.limits) {
    r.limits = { spend: structuredClone(DEFAULT_SPEND_LIMITS) };
  }
  // periodic-pelican — legacy `limits.daily` (plain USD/day numbers) becomes
  // `limits.spend` (per-rule { amountUsd, period }). Structural + idempotent:
  // an already-converted record has no `daily` key and is untouched. Persisted
  // by the snapshot-compare write-back on first read, like every normalize here.
  const legacyLimits = r.limits as unknown as {
    daily?: { projectTotal?: unknown; byRole?: Record<string, unknown>; byUser?: Record<string, unknown>; byAgent?: Record<string, unknown> };
    spend?: SpendLimitsShape;
    rateLimitRpm?: number | null;
  };
  if (legacyLimits.daily) {
    const toRule = (v: unknown): { amountUsd: number; period: 'day' } | null =>
      typeof v === 'number' && Number.isFinite(v) ? { amountUsd: v, period: 'day' } : null;
    const mapRules = (m: Record<string, unknown> | undefined): Record<string, { amountUsd: number; period: 'day' } | null> => {
      const out: Record<string, { amountUsd: number; period: 'day' } | null> = {};
      for (const [k, v] of Object.entries(m ?? {})) out[k] = toRule(v);
      return out;
    };
    legacyLimits.spend = {
      projectTotal: toRule(legacyLimits.daily.projectTotal),
      byRole: mapRules(legacyLimits.daily.byRole),
      byUser: mapRules(legacyLimits.daily.byUser),
      byAgent: mapRules(legacyLimits.daily.byAgent),
    };
    delete legacyLimits.daily;
  }
  if (!legacyLimits.spend) {
    legacyLimits.spend = structuredClone(DEFAULT_SPEND_LIMITS);
  }

  const currentVersion = typeof r.roleGrantVersion === 'number' ? r.roleGrantVersion : 0;
  // Rollback leg: a record stamped by a NEWER binary must never be dragged
  // BACKWARDS. What the `<` gate guarantees, exactly: no version-keyed phase
  // runs, and `roleGrantVersion` is never reassigned (it is only written inside
  // that branch), so the stored version can never be lowered.
  //
  // The structural normalizers ABOVE this line still run on such a record, in
  // memory; this function never writes. The WRITE side is the floor:
  // `getAndMigrate` persists nothing for a newer record and every mutation
  // refuses it (`assertProjectRecordWritable`, `RecordNewerError`), so a newer
  // build's record is served as read and never rewritten by this one.
  if (currentVersion < ROLE_GRANT_VERSION) {
    // Set by a phase that must NOT be recorded as applied (today: P4's
    // fail-closed liveness guard). The stored version then stops one short so a
    // later, healthy boot retries that version instead of freezing the record.
    let haltedAtVersion: number | null = null;
    for (let version = currentVersion + 1; version <= ROLE_GRANT_VERSION; version += 1) {
      // P0 — priority re-anchor. Runs FIRST in its version because P6 (tier)
      // mirrors the result, and because both role write paths reject a built-in
      // whose EXPLICIT priority differs from its anchor: without this, no admin
      // could ever PATCH a legacy project's role map again.
      if (ROLE_PRIORITY_REANCHOR_VERSIONS.has(version)) {
        for (const roleName of Object.keys(r.roles)) {
          const role = r.roles[roleName];
          if (!role) continue;
          // Just backfilled ⇒ already on the current scale, nothing to re-map.
          if (!isBuiltinRole(roleName) && backfilledRoleNames.has(roleName)) continue;
          const next = isBuiltinRole(roleName)
            ? BUILTIN_ROLE_PRIORITY[roleName]
            : remapLegacyCustomPriority(role.priority);
          if (role.priority !== next) r.roles[roleName] = { ...role, priority: next };
        }
      }
      const repairs = ROLE_GRANT_REPAIRS[version];
      if (repairs) {
        for (const [roleName, features] of Object.entries(repairs)) {
          const role = r.roles[roleName];
          if (!role || role.grantedFeatures.includes('*')) continue;
          const next = new Set(role.grantedFeatures);
          for (const feature of features) next.add(feature);
          r.roles[roleName] = { ...role, grantedFeatures: [...next] };
        }
      }
      // Renames run BETWEEN repairs and revokes: a repair may have just added
      // the old id (it never does today, but the ordering keeps the primitive
      // total), and a revoke in the same version must see the NEW id.
      const renames = ROLE_GRANT_RENAMES[version];
      if (renames) {
        for (const roleName of Object.keys(r.roles)) {
          const role = r.roles[roleName];
          if (!role || role.grantedFeatures.includes('*')) continue;
          let changed = false;
          const next: string[] = [];
          for (const feature of role.grantedFeatures) {
            const renamed = renames[feature];
            if (renamed === undefined) {
              if (!next.includes(feature)) next.push(feature);
              continue;
            }
            changed = true;
            // 1:1 or 1:N — a namespace split hands the holder every successor.
            for (const id of Array.isArray(renamed) ? renamed : [renamed]) {
              if (!next.includes(id)) next.push(id);
            }
          }
          if (changed) r.roles[roleName] = { ...role, grantedFeatures: next };
        }
      }
      const revokes = ROLE_GRANT_REVOKES[version];
      if (revokes) {
        for (const [roleName, features] of Object.entries(revokes)) {
          const role = r.roles[roleName];
          if (!role || role.grantedFeatures.includes('*')) continue;
          const remove = new Set(features);
          r.roles[roleName] = {
            ...role,
            grantedFeatures: role.grantedFeatures.filter((f) => !remove.has(f)),
          };
        }
      }
      // P4 — de-wildcard. Any role holding `'*'` that is NOT owner-strength
      // (priority > the owner anchor) exchanges the wildcard for the enumerated
      // manifest-derived catalog. Keyed on PRIORITY, so it is name-free (D-A)
      // and covers a custom priority-2 role exactly like the built-in `admin`.
      if (ROLE_DEWILDCARD_VERSIONS.has(version)) {
        const nextAdminGrants = DEFAULT_ROLES.admin.grantedFeatures;
        if (!adminGrantUnionIsLive(nextAdminGrants)) {
          if (!warnedDegenerateAdminGrants) {
            warnedDegenerateAdminGrants = true;
            console.warn(
              '[ProjectStore] role-grant migration v13 SKIPPED: the builtin feature union is ' +
                `degenerate (${nextAdminGrants.length} ids; expected ${DEWILDCARD_LIVENESS_IDS.join(', ')}). ` +
                "Roles keep the '*' wildcard and roleGrantVersion stays at 12; " +
                'a boot with all builtin manifests readable will retry.',
            );
          }
          // Stop BEFORE advancing the stored version. The v13 renames that ran
          // earlier in this iteration are idempotent (their lookups miss on
          // already-new ids), so replaying v13 on the next boot is safe.
          haltedAtVersion = version - 1;
          break;
        }
        for (const roleName of Object.keys(r.roles)) {
          const role = r.roles[roleName];
          if (!role || !role.grantedFeatures.includes('*')) continue;
          if (rolePriority(roleName, role.priority) <= BUILTIN_ROLE_PRIORITY.owner) continue;
          r.roles[roleName] = { ...role, grantedFeatures: [...nextAdminGrants] };
        }
      }
      // P5 — the name→flag translation. RAISE-ONLY: never writes `false`, so it
      // cannot take role management away from anyone.
      if (ROLE_MANAGE_FLAG_VERSIONS.has(version)) {
        for (const roleName of LEGACY_ROLE_MANAGE_NAMES) {
          const role = r.roles[roleName];
          if (!role || role.canManageRoles === true) continue;
          r.roles[roleName] = { ...role, canManageRoles: true };
        }
      }
      // P6 — `ProjectMember.tier` is a stored MIRROR of the role's priority
      // (`admin/users/route.ts` already writes it that way). Re-derive it, or
      // every existing member keeps a 1..5 tier while the roles carry 1..30.
      if (MEMBER_TIER_REDERIVE_VERSIONS.has(version)) {
        for (const [userId, member] of Object.entries(r.members)) {
          const next = rolePriority(member.role, r.roles[member.role]?.priority);
          if (member.tier !== next) r.members[userId] = { ...member, tier: next };
        }
      }
      // P7 — seeded-owner authority heal (S1). One key, and it LOGS.
      if (APEX_AUTHORITY_HEAL_VERSIONS.has(version)) {
        const seededOwner = r.roles[SEEDED_OWNER_ROLE_NAME];
        if (seededOwner && seededOwner.grantedFeatures.length === 0) {
          console.warn(
            `[ProjectStore] role-grant migration v17 repaired project "${String(r.id ?? '<unknown>')}": ` +
              `the seeded "${SEEDED_OWNER_ROLE_NAME}" role carried an EMPTY grant list and was restored to ['*']. ` +
              'This is the one-time repair for damage a pre-S1 role write could inflict.',
          );
          r.roles[SEEDED_OWNER_ROLE_NAME] = { ...seededOwner, grantedFeatures: ['*'] };
        }
      }
    }
    if (haltedAtVersion !== null) {
      // Never move BACKWARDS: a record already past the halt point keeps its
      // version (nothing was undone, only a later phase deferred).
      r.roleGrantVersion = Math.max(currentVersion, haltedAtVersion);
    } else {
      r.roleGrantVersion = ROLE_GRANT_VERSION;
    }
  }

  return r;
}

async function getAndMigrate(id: string): Promise<ProjectRecord | null> {
  const store = await claimedStore();
  const raw = await store.get(id);
  if (!raw) return null;
  // A newer build's record is served as read, never migrated back to disk.
  if (isNewerProjectRecord(raw)) return migrateProjectRecord(raw as unknown as Record<string, unknown>);
  // Snapshot BEFORE migrating: migrateProjectRecord mutates `raw` in place,
  // so comparing raw to its own return value was a self-comparison and the
  // persist branch was dead — roleGrantVersion/repairs never landed on disk
  // (re-applied in memory on every read; MCP1 Inc2 live-test finding).
  const before = JSON.stringify(raw);
  const migrated = migrateProjectRecord(raw as unknown as Record<string, unknown>);
  if (before === JSON.stringify(migrated)) return migrated;
  // This is a put-on-READ: a plain `getProjectById` writes. Doing it with the
  // record read OUTSIDE the store's chain is how a read could overwrite a write
  // that landed in between, so the persist re-reads and re-migrates INSIDE the
  // chain — and writes nothing when another writer already migrated it.
  const persisted = await store.update(id, (current) => {
    if (!current || isNewerProjectRecord(current)) return undefined;
    const currentRaw = JSON.stringify(current);
    // Mutates `current` in place, which is exactly what we want to hand back on
    // the no-write branch: `update` returns the record it read.
    const currentMigrated = migrateProjectRecord(current as unknown as Record<string, unknown>);
    return currentRaw === JSON.stringify(currentMigrated) ? undefined : currentMigrated;
  });
  // A record deleted between the read and the persist leaves the in-memory
  // migration as the honest answer for this READ.
  return persisted ?? migrated;
}

/**
 * Patch shape for {@link updateProject} — the fields a general project write may
 * touch. `archivedAt` / `packageTrust` / `packageAccessFeature` are deliberately
 * absent: they have their own narrow setters so a member/role/limits patch can
 * never archive a project or move a trust override.
 */
export type ProjectRecordPatch = Partial<
  Pick<
    ProjectRecord,
    'name' | 'description' | 'members' | 'roles' | 'agentOwnership' | 'limits' | 'appliedPackageGrants'
  >
> & {
  /** `null` clears the appearance; absent keeps it. */
  appearance?: ProjectRecord['appearance'] | null;
};

/**
 * The PRODUCER form of a project patch: it is handed the record as it is ON DISK
 * inside the store's per-path chain and returns the patch to apply, or `null` to
 * write nothing.
 *
 * This is the shape every writer that computes its patch FROM the record must
 * use. The object form reads the record once, computes, and writes — so two
 * concurrent writers compute from the same base and the second erases the
 * first's fields (measured live: three concurrent package-grant revocations left
 * 2 of 3 markers standing). A producer's map is built from the record the chain
 * just read, so the merge is atomic.
 *
 * A producer re-derives its own AUTHORIZATION floor from the record it is handed
 * too — never from the snapshot its caller read earlier. A mismatch returns
 * `null` (no write) and the caller answers its own denial code.
 */
export type ProjectPatchProducer = (current: ProjectRecord) => ProjectRecordPatch | null;

/**
 * Read-modify-write a project record INSIDE the store's per-path chain.
 *
 * Module-private on purpose: it is the ONE place the migrate → mutate → write
 * sequence lives, shared by `updateProject` and the three narrow setters. `fn`
 * sees a MIGRATED record; returning `undefined` writes nothing. `null` comes
 * back only when the record does not exist.
 */
async function mutateProject(
  id: string,
  fn: (current: ProjectRecord) => ProjectRecord | undefined,
): Promise<ProjectRecord | null> {
  // A mutable holder rather than a plain `let`: TypeScript does not track an
  // assignment made inside a callback, so a narrowed local would read as `null`.
  const captured: { migrated: ProjectRecord | null; next: ProjectRecord | undefined } = {
    migrated: null,
    next: undefined,
  };
  const stored = await (await claimedStore()).update(id, (raw) => {
    if (!raw) return undefined;
    assertProjectRecordWritable(raw);
    captured.migrated = migrateProjectRecord(raw as unknown as Record<string, unknown>);
    captured.next = fn(captured.migrated);
    return captured.next;
  });
  if (stored === null) return null;
  return captured.next ?? captured.migrated;
}

/** Apply a patch with the field rules every project write shares. */
function applyProjectPatch(project: ProjectRecord, patch: ProjectRecordPatch): ProjectRecord {
  return {
    ...project,
    name: patch.name ?? project.name,
    description: patch.description !== undefined ? patch.description : project.description,
    appearance: patch.appearance !== undefined ? patch.appearance ?? undefined : project.appearance,
    members: patch.members ?? project.members,
    roles: patch.roles ?? project.roles,
    agentOwnership: patch.agentOwnership ?? project.agentOwnership,
    // Field-wise merge (periodic-pelican, F4): a spend-only patch must not
    // silently erase `rateLimitRpm` (and vice versa). The old whole-object
    // replace was the `{"roles":{}}`-wipe class in a shape the historical fix
    // did not cover.
    // The stored limits are the BASE, so a key this build does not know (one a
    // newer build added) survives a limits patch instead of being dropped.
    limits: patch.limits
      ? {
          ...project.limits,
          spend: patch.limits.spend ?? project.limits.spend,
          rateLimitRpm:
            'rateLimitRpm' in patch.limits ? patch.limits.rateLimitRpm : project.limits.rateLimitRpm,
        }
      : project.limits,
    appliedPackageGrants: patch.appliedPackageGrants ?? project.appliedPackageGrants,
    updatedAt: nowISO(),
  };
}

/**
 * Seed a new project's role map, fail-closed on the admin union.
 *
 * `DEFAULT_ROLES.admin.grantedFeatures` is the manifest-derived list read at
 * module load (see `adminGrantUnionIsLive`). When it is degenerate the system
 * cannot compute what a new project's roles should CONTAIN, so it persists
 * nothing: R-4 measured that the alternative leaves permanent damage.
 *
 * Why not the migration's halt-and-retry shape here — measured, not assumed:
 *
 *  - the halt version is 12 (one below the de-wildcard row) and
 *    `ROLE_GRANT_REPAIRS` has no
 *    row at 12 or 13, so the ONLY thing a later healthy boot repairs is the
 *    `'*'` on `admin` (P4 looks at wildcard holders and nothing else).
 *    `manager` / `member` / `viewer` are seeded from the SAME degenerate
 *    module-load lists and are never revisited — measured `0/33`, `0/19`,
 *    `0/7`, permanently.
 *  - `hasFeature`'s `'*'` arm matches `platform.*` as well, so the interim
 *    wildcard on a record that never had a pre-D-C state is a genuine
 *    platform-tier widening, not the status quo it is for an existing record.
 *
 * A "refill empty builtin roles" repair phase is deliberately NOT the answer:
 * an empty `grantedFeatures` list is also what a deliberate revoke leaves
 * behind (`PATCH /config/roles` accepts truncating a surviving role), so the
 * fingerprint is ambiguous and the repair would silently undo an operator's
 * intent.
 *
 * NARROWED, not lifted, by S1 (2026-08-22): the prohibition still stands for
 * every role in general — including a custom priority-1 role, where an empty
 * list is a coherent governance-only design. The ONE exception is the seeded
 * `owner` key, and only because `validateProjectInvariants` makes it structural:
 * it must exist, the provenance owner must hold it, and the seed defines its
 * value. See the P7 docblock above for the full reasoning. Do not widen P7 back
 * to a priority test — that is the escalation this paragraph exists to prevent.
 *
 * The single server-side caller (`POST /api/projects`) already runs inside a
 * try/catch that answers `409 {error}`, and first boot does NOT come through
 * here — `scripts/setup.mts` writes the first project record directly — so this
 * throw is a handled response, never an unhandled 500 and never boot-fatal.
 */
function seedRolesForNewProject(projectName: string): {
  roles: Record<string, RoleDefinition>;
  roleGrantVersion: number;
} {
  if (adminGrantUnionIsLive(DEFAULT_ROLES.admin.grantedFeatures)) {
    return { roles: { ...DEFAULT_ROLES }, roleGrantVersion: ROLE_GRANT_VERSION };
  }
  throw new Error(
    `ROLE_SEED_UNION_DEGENERATE: createProject("${projectName}") refused — the builtin feature ` +
      `union is degenerate (${DEFAULT_ROLES.admin.grantedFeatures.length} ids; expected at least ` +
      `${DEWILDCARD_LIVENESS_IDS.join(', ')}). Nothing was written. A boot with every builtin ` +
      'manifest readable (check NEURALIS_BUILTINS and the node_modules/@neuralis/* tree) seeds ' +
      'the project correctly; seeding it now would leave manager/member/viewer permanently ' +
      "empty and hand admin a '*' that also matches platform.* ids.",
  );
}

export async function createProject(
  name: string,
  ownerId: string,
  description?: string,
  ownerProfile?: { name: string; email: string },
): Promise<ProjectRecord> {
  const store = await claimedStore();
  const baseId = projectIdFromName(name);
  const now = nowISO();

  // The SECOND writer of the manifest-derived admin union (the first is
  // `migrateProjectRecord` P4). It runs the SAME liveness floor, because
  // stamping `ROLE_GRANT_VERSION` on a record whose `admin` carries a degenerate
  // union would freeze it: the version gate never revisits it, and P4 — the only
  // code that could repair it — never runs for this project.
  const seededRoles = seedRolesForNewProject(name);

  const seed: Omit<ProjectRecord, 'id'> = {
    name,
    description,
    ownerId,
    members: {
      [ownerId]: {
        userId: ownerId,
        name: ownerProfile?.name ?? '',
        email: ownerProfile?.email ?? '',
        role: 'owner',
        position: 'Owner',
        // Mirror of the role's priority — derived from the anchor, never a
        // literal, so the scale can move without a silent drift here.
        tier: BUILTIN_ROLE_PRIORITY.owner,
        addedAt: now,
      },
    },
    roles: seededRoles.roles,
    agentOwnership: {},
    limits: { spend: structuredClone(DEFAULT_SPEND_LIMITS) },
    roleGrantVersion: seededRoles.roleGrantVersion,
    createdAt: now,
    updatedAt: now,
  };
  // The free-id check reads outside any chain; the CLAIM does not. Two creates
  // of one name can both see the id free — only the first claim writes it, the
  // other moves on to the next free id instead of overwriting that record.
  let project: ProjectRecord;
  for (;;) {
    const candidate: ProjectRecord = { id: await resolveUniqueId(baseId), ...seed };
    const claimed = await store.update(candidate.id, (current) => (current ? undefined : candidate));
    if (claimed === candidate) {
      project = candidate;
      break;
    }
  }
  const { id } = project;

  try {
    await initProjectDirectory(id, ownerId);
  } catch (err) {
    // A project some package never provisioned is broken with no self-heal, so
    // the claimed record does not survive its failed init: the purge path
    // removes whatever was already provisioned, the tree and the record (the id
    // is tombstoned, never re-minted). The original error is what the caller sees.
    await rollBackFailedCreate(id);
    throw err;
  }
  emitRecordChanged(id, project.members);
  return project;
}

async function rollBackFailedCreate(id: string): Promise<void> {
  try {
    const { archiveProject, purgeProject } = await import('../projects/projectDeletion');
    await archiveProject(id);
    await purgeProject(id);
  } catch (err) {
    // eslint-disable-next-line no-console -- host project-lifecycle diagnostic, the sibling idiom (projectDeletion)
    console.error(
      `[ProjectStore] rollback of failed create "${id}" did not complete (${err instanceof Error ? err.name : typeof err}); an owner can purge it`,
    );
  }
}

export async function getProjectById(id: string): Promise<ProjectRecord | null> {
  // An id that cannot name a record file cannot be a project: it answers the
  // same "no such project" every caller already handles, never the store's
  // path-guard throw (an unhandled 500 at every route that looks a project up).
  if (!isSafePathSegment(id)) return null;
  return getAndMigrate(id);
}

export async function listProjectsForUser(
  userId: string,
  { includeArchived = false }: { includeArchived?: boolean } = {},
): Promise<ProjectRecord[]> {
  const all = await (await claimedStore()).list();
  const results: ProjectRecord[] = [];
  for (const raw of all) {
    const migrated = migrateProjectRecord(raw as unknown as Record<string, unknown>);
    if (!includeArchived && migrated.archivedAt != null) continue;
    const isMember = migrated.members[userId] !== undefined;
    if (isMember) results.push(migrated);
  }
  return results;
}

/**
 * The ONE general project write, in two forms.
 *
 * OBJECT patch — the caller already holds the whole map it wants persisted (the
 * client sends `members`/`roles` wholesale on `PATCH /api/projects/[id]`). The
 * map REPLACES rather than merges, deliberately: an omitted key is a delete, and
 * the role-map write floor is built on that.
 *
 * PRODUCER patch — the caller computes its patch FROM the record. Everything
 * that does must use this form; see {@link ProjectPatchProducer} for why.
 *
 * Both run migrate → patch → merge → `validateProjectInvariants` (throwing
 * `ProjectUpdateError`) inside the store's per-path chain. `name` is a display
 * label like any other field: the id is fixed at creation and NEVER re-derived
 * from a name — every tenant-keyed store (data tree, vectors, source configs,
 * credentials, webtop volumes, OAuth tokens) hangs off it.
 */
export async function updateProject(
  id: string,
  patch: ProjectRecordPatch | ProjectPatchProducer,
): Promise<ProjectRecord | null> {
  const seen: { before: ProjectRecord['members'] | null; after: ProjectRecord['members'] | null } = {
    before: null,
    after: null,
  };
  const result = await mutateProject(id, (project) => {
    const produced = typeof patch === 'function' ? patch(project) : patch;
    if (produced === null) return undefined;
    const updated = applyProjectPatch(project, produced);
    // ONE invariant body, shared with the HTTP patch path (`projects/access.ts`).
    // Note the deliberate tightening: this also validates `agentOwnership`,
    // which the local copy did not. Every entry that ever reached disk went
    // through `validateAgentOwnership` (a superset check) on the PATCH route, so
    // no existing record can start failing.
    const invariantError = validateProjectInvariants(updated);
    if (invariantError) throw new ProjectUpdateError(invariantError);
    seen.before = project.members;
    seen.after = updated.members;
    return updated;
  });
  if (seen.before && seen.after) {
    emitRemovedMembers(id, seen.before, seen.after);
    emitRecordChanged(id, seen.before, seen.after);
  }
  return result;
}

export async function listAllProjects(
  { includeArchived = false }: { includeArchived?: boolean } = {},
): Promise<ProjectRecord[]> {
  const all = await (await claimedStore()).list();
  const migrated = (all as unknown as Record<string, unknown>[]).map(migrateProjectRecord);
  return includeArchived ? migrated : migrated.filter((p) => p.archivedAt == null);
}

export async function deleteProject(id: string): Promise<boolean> {
  // The members are read BEFORE the delete: a deleted project cannot be read
  // afterwards, and the listeners must know whose access just ended.
  const store = await claimedStore();
  const userIds = Object.keys((await store.get(id))?.members ?? {});
  const deleted = await store.delete(id);
  if (deleted) emitMembershipChange({ kind: 'project_closed', projectId: id, cause: 'deleted', userIds });
  return deleted;
}

/**
 * happy-wondering-yeti — set or clear the soft-archive marker. Narrow setter
 * mirroring `setPackageTrust`/`setPackageAccessFeature`: deliberately NOT part of
 * `updateProject`'s Pick, so a general member/role/limits patch can never
 * archive/restore a project. `archivedAt = ISO string` archives; `null` restores.
 */
export async function setProjectArchived(
  id: string,
  archivedAt: string | null,
): Promise<ProjectRecord | null> {
  const seen = { archived: false, restored: false, userIds: [] as string[] };
  const result = await mutateProject(id, (project) => {
    seen.archived = archivedAt != null && project.archivedAt == null;
    seen.restored = archivedAt == null && project.archivedAt != null;
    seen.userIds = Object.keys(project.members);
    return {
      ...project,
      archivedAt: archivedAt ?? undefined,
      updatedAt: nowISO(),
    };
  });
  if (result && seen.archived) {
    emitMembershipChange({ kind: 'project_closed', projectId: id, cause: 'archived', userIds: seen.userIds });
  }
  if (result && seen.restored && seen.userIds.length > 0) {
    emitMembershipChange({ kind: 'record_changed', projectId: id, userIds: seen.userIds });
  }
  return result;
}

/**
 * Set or clear the trust override for a specific package within a project.
 * `null` removes the override, reverting the package to its manifest-declared
 * default trust (typically `untrusted`). Narrower than `updateProject` to avoid
 * inadvertent overwrites from admin routes that patch unrelated fields.
 */
export async function setPackageTrust(
  projectId: string,
  packageId: string,
  trust: 'trusted' | 'untrusted' | null,
): Promise<ProjectRecord | null> {
  return mutateProject(projectId, (project) => {
    const nextTrust: Record<string, 'trusted' | 'untrusted'> = { ...(project.packageTrust ?? {}) };
    if (trust === null) {
      delete nextTrust[packageId];
    } else {
      nextTrust[packageId] = trust;
    }
    return {
      ...project,
      packageTrust: Object.keys(nextTrust).length > 0 ? nextTrust : undefined,
      updatedAt: nowISO(),
    };
  });
}

/**
 * R2b (scope-guarding-magpie) — set or clear the owner/admin base-access feature
 * OVERRIDE for a package within a project. `null` removes the override. Exact
 * sibling of `setPackageTrust`: narrower than `updateProject` to avoid
 * inadvertent overwrites. RESTRICT-ONLY by construction — it only attaches a
 * required feature, there is no grant path, so it can never weaken a floor.
 */
export async function setPackageAccessFeature(
  projectId: string,
  packageId: string,
  featureId: string | null,
): Promise<ProjectRecord | null> {
  return mutateProject(projectId, (project) => {
    const next: Record<string, string> = { ...(project.packageAccessFeature ?? {}) };
    if (featureId === null) {
      delete next[packageId];
    } else {
      next[packageId] = featureId;
    }
    return {
      ...project,
      packageAccessFeature: Object.keys(next).length > 0 ? next : undefined,
      updatedAt: nowISO(),
    };
  });
}

export async function ensureDefaultProject(
  userId: string,
  profile?: { name: string; email: string },
): Promise<ProjectRecord> {
  const userProjects = await listProjectsForUser(userId);
  if (userProjects.length > 0) return userProjects[0]!;
  throw new Error(
    profile
      ? `No project exists for user ${profile.email}. Run setup or create a project explicitly.`
      : 'No project exists for this user. Run setup or create a project explicitly.',
  );
}

/**
 * Boot integrity check: logs every project record that exists but cannot be read
 * or parsed (`list` skips those silently), by relative path, plus the scan time.
 * Reads disk once, outside the data-format claim — it migrates and writes nothing.
 */
export function verifyProjectRecords(logger: Logger): Promise<number> {
  return reportStoreIntegrity(getStore(), 'app/projects', logger);
}
