/**
 * S2c — role-grant repairs (additive) + revokes (tightening) applied by
 * `migrateProjectRecord` on existing projects, version-keyed and once-only.
 */

import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_ROLE_PRIORITY } from '@neuralis/package-system/access';
import { migrateProjectRecord, DEFAULT_ROLES } from '../ProjectStore';

function rawProject(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'p1',
    name: 'P1',
    ownerId: 'owner-1',
    members: { 'owner-1': { userId: 'owner-1', name: 'O', email: 'o@x', role: 'owner', position: 'Owner', tier: 1, addedAt: '2026-01-01' } },
    roles: {
      owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'] },
      manager: { agents: '*', canInvite: false, canManageRoles: false, grantedFeatures: ['core.agents'] },
      member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: ['core.agents'] },
      viewer: { agents: 'view', canInvite: false, canManageRoles: false, grantedFeatures: ['core.agents', 'terminal.read'] },
    },
    agentOwnership: {},
    limits: { daily: {} },
    createdAt: '2026-01-01',
    updatedAt: '2026-01-01',
    ...over,
  };
}

describe('migrateProjectRecord — role grant repairs + revokes', () => {
  it('from version 0: adds observe/web + member execute + workflow grants, revokes viewer terminal.read', () => {
    const r = migrateProjectRecord(rawProject({ roleGrantVersion: 0 }));
    expect(r.roleGrantVersion).toBe(19);
    // C1/C-mid additive repairs:
    expect(r.roles.manager.grantedFeatures).toEqual(expect.arrayContaining(['core.observe', 'core.web']));
    expect(r.roles.member.grantedFeatures).toEqual(expect.arrayContaining(['core.observe', 'core.web', 'core.execute']));
    expect(r.roles.viewer.grantedFeatures).toContain('core.observe');
    // D4 revoke:
    expect(r.roles.viewer.grantedFeatures).not.toContain('terminal.read');
    // viewer never gets execute:
    expect(r.roles.viewer.grantedFeatures).not.toContain('core.execute');
    // modular-meerkat v4 — workflow grants (M10): member r/w, no dispatch.
    expect(r.roles.manager.grantedFeatures).toEqual(
      expect.arrayContaining(['workflow.read', 'workflow.write', 'workflow.dispatch']),
    );
    expect(r.roles.member.grantedFeatures).toEqual(
      expect.arrayContaining(['workflow.read', 'workflow.write']),
    );
    expect(r.roles.member.grantedFeatures).not.toContain('workflow.dispatch');
    expect(r.roles.viewer.grantedFeatures).toContain('workflow.read');
    expect(r.roles.viewer.grantedFeatures).not.toContain('workflow.write');
    // modular-meerkat v5 — per-user channels (M12, architect F1 revised):
    // channels.connect is member-granted (user-scope connections only);
    // channels.manage is never granted by a repair row (owner holds it on the
    // wildcard, admin through its enumerated default grants).
    expect(r.roles.manager.grantedFeatures).toContain('channels.connect');
    expect(r.roles.member.grantedFeatures).toContain('channels.connect');
    expect(r.roles.viewer.grantedFeatures).not.toContain('channels.connect');
    for (const role of ['manager', 'member', 'viewer'] as const) {
      expect(r.roles[role].grantedFeatures).not.toContain('channels.manage');
    }
    // prompt-polish v6 — manager+member, viewer never.
    expect(r.roles.manager.grantedFeatures).toContain('core.prompt-polish');
    expect(r.roles.member.grantedFeatures).toContain('core.prompt-polish');
    expect(r.roles.viewer.grantedFeatures).not.toContain('core.prompt-polish');
    // mcp.connect v7 + git.connect v8 — manager+member, viewer never.
    expect(r.roles.manager.grantedFeatures).toEqual(expect.arrayContaining(['mcp.connect', 'git.connect']));
    expect(r.roles.member.grantedFeatures).toEqual(expect.arrayContaining(['mcp.connect', 'git.connect']));
    expect(r.roles.viewer.grantedFeatures).not.toContain('mcp.connect');
    expect(r.roles.viewer.grantedFeatures).not.toContain('git.connect');
    // Phase M v9 — credentials.self (BYOK): manager+member, viewer never.
    expect(r.roles.manager.grantedFeatures).toContain('credentials.self');
    expect(r.roles.member.grantedFeatures).toContain('credentials.self');
    expect(r.roles.viewer.grantedFeatures).not.toContain('credentials.self');
    // neuralweb v14 — packages.registry: admin+manager+member, viewer never
    // (advertisement control for the marketplace skill; viewer holds no shell).
    // `admin` is NAMED in the row: an existing project's enumerated admin list
    // is not re-derived from manifests after v13, so without the row an
    // existing project's admin would silently lack the id (live-tester catch).
    expect(r.roles.manager.grantedFeatures).toContain('packages.registry');
    expect(r.roles.member.grantedFeatures).toContain('packages.registry');
    expect(r.roles.viewer.grantedFeatures).not.toContain('packages.registry');
  });

  it('v4 → v9: manager+member gain channels.connect + prompt-polish + mcp/git.connect + credentials.self, viewer does not', () => {
    const r = migrateProjectRecord(rawProject({ roleGrantVersion: 4 }));
    expect(r.roleGrantVersion).toBe(19);
    expect(r.roles.manager.grantedFeatures).toContain('channels.connect');
    expect(r.roles.member.grantedFeatures).toContain('channels.connect');
    expect(r.roles.viewer.grantedFeatures).not.toContain('channels.connect');
    expect(r.roles.manager.grantedFeatures).toContain('core.prompt-polish');
    expect(r.roles.member.grantedFeatures).toContain('core.prompt-polish');
    expect(r.roles.viewer.grantedFeatures).not.toContain('core.prompt-polish');
    // v9 — credentials.self: manager+member, viewer never.
    expect(r.roles.manager.grantedFeatures).toContain('credentials.self');
    expect(r.roles.member.grantedFeatures).toContain('credentials.self');
    expect(r.roles.viewer.grantedFeatures).not.toContain('credentials.self');
    // ONLY v5..v10 apply from v4 — earlier repairs/revokes stay untouched.
    expect(r.roles.viewer.grantedFeatures).toContain('terminal.read'); // v3 revoke not re-applied
    expect(r.roles.member.grantedFeatures).not.toContain('core.execute'); // v3 repair not re-applied
    expect(r.roles.member.grantedFeatures).not.toContain('workflow.read'); // v4 repair not re-applied
  });

  it('never touches a wildcard role', () => {
    const r = migrateProjectRecord(rawProject({ roleGrantVersion: 0 }));
    expect(r.roles.owner.grantedFeatures).toEqual(['*']);
  });

  it('v14 reaches an ENUMERATED admin (post-D-C shape) — the manifest union is not re-derived after v13', () => {
    // Live-tester catch (2026-08-06): an existing project's admin holds an
    // enumerated list materialized at v13; a feature declared later reaches it
    // ONLY through a repair row naming `admin`. A wildcard admin stays skipped.
    const enumerated = rawProject({
      roleGrantVersion: 13,
      roles: {
        owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'] },
        admin: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['core.agents', 'packages.author'] },
        member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: ['core.agents'] },
      },
    });
    const r = migrateProjectRecord(enumerated);
    expect(r.roleGrantVersion).toBe(19);
    expect(r.roles.admin.grantedFeatures).toContain('packages.registry');
    expect(r.roles.member.grantedFeatures).toContain('packages.registry');
    // v16 (D2): the new `project.limits` read feature reaches the enumerated
    // admin through its repair row — and ONLY admin.
    expect(r.roles.admin.grantedFeatures).toContain('project.limits');
    expect(r.roles.member.grantedFeatures).not.toContain('project.limits');
    expect(r.roles.owner.grantedFeatures).toEqual(['*']);
  });

  it('is a no-op when already at the current version', () => {
    // The fixture version must track ROLE_GRANT_VERSION. Left at 17 after the
    // bump to 18 this row still PASSED — the migration ran a repair and the
    // assertions below happen not to look at admin — so the test's own name
    // became false while it stayed green. A version pin has two halves and this
    // is the one that fails silently.
    const before = rawProject({ roleGrantVersion: 19 });
    const r = migrateProjectRecord(structuredClone(before));
    expect(r.roleGrantVersion).toBe(19);
    expect(r.roles.viewer.grantedFeatures).toContain('terminal.read'); // unchanged
    expect(r.roles.member.grantedFeatures).not.toContain('core.execute');
    expect(r.roles.member.grantedFeatures).not.toContain('workflow.read');
    expect(r.roles.member.grantedFeatures).not.toContain('channels.connect');
    expect(r.roles.member.grantedFeatures).not.toContain('core.prompt-polish');
    expect(r.roles.member.grantedFeatures).not.toContain('credentials.self');
  });

  it('applies only the newer versions (partial upgrade from v2)', () => {
    // At v2 the viewer still has terminal.read and member lacks execute; only v3 applies.
    const r = migrateProjectRecord(rawProject({ roleGrantVersion: 2 }));
    expect(r.roles.member.grantedFeatures).toContain('core.execute'); // v3 repair
    expect(r.roles.viewer.grantedFeatures).not.toContain('terminal.read'); // v3 revoke
  });

  // -------------------------------------------------------------------------
  // native-nightjar H1' — the third migration primitive: feature RENAME.
  // -------------------------------------------------------------------------

  it('the rename CHAIN carries a BUILTIN role from core.shell.host to exec.unconfined', () => {
    const r = migrateProjectRecord(
      rawProject({
        roleGrantVersion: 9,
        roles: {
          owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'] },
          manager: { agents: '*', canInvite: false, canManageRoles: false, grantedFeatures: ['core.agents', 'core.shell.host'] },
          member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: ['core.agents'] },
          viewer: { agents: 'view', canInvite: false, canManageRoles: false, grantedFeatures: ['core.agents'] },
        },
      }),
    );
    // v10 renames it to `core.shell.container`, v19 to `exec.unconfined`. A
    // record this old passes through BOTH, so the end state is the only honest
    // assertion — and every intermediate id must be gone.
    expect(r.roles.manager.grantedFeatures).toContain('exec.unconfined');
    expect(r.roles.manager.grantedFeatures).not.toContain('core.shell.host');
    expect(r.roles.manager.grantedFeatures).not.toContain('core.shell.container');
    // Unrelated grants survive, in position.
    expect(r.roles.manager.grantedFeatures[0]).toBe('core.agents');
  });

  it('v10 renames on a CUSTOM role too — the capability is never silently lost (M6)', () => {
    // This is the whole reason renames are a separate primitive: the additive
    // repairs and subtractive revokes are keyed by ROLE NAME, so a `devops`
    // role the platform never enumerates would have kept the dead id (or lost
    // the grant outright under a repair+revoke pair).
    const r = migrateProjectRecord(
      rawProject({
        roleGrantVersion: 9,
        roles: {
          owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'] },
          manager: { agents: '*', canInvite: false, canManageRoles: false, grantedFeatures: ['core.agents'] },
          member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: ['core.agents'] },
          viewer: { agents: 'view', canInvite: false, canManageRoles: false, grantedFeatures: ['core.agents'] },
          devops: {
            agents: '*',
            canInvite: false,
            canManageRoles: false,
            grantedFeatures: ['core.agents', 'core.shell.host', 'terminal.host', 'terminal.read'],
          },
        },
      }),
    );
    const devops = r.roles.devops.grantedFeatures;
    expect(devops).toContain('exec.unconfined'); // v10 → container, v19 → exec.*
    expect(devops).toContain('terminal.container'); // the terminal ids never moved
    expect(devops).not.toContain('core.shell.host');
    expect(devops).not.toContain('core.shell.container');
    expect(devops).not.toContain('terminal.host');
    expect(devops).toContain('terminal.read');
  });

  it('the rename chain NEVER grants a host-PLANE feature to anyone', () => {
    // `exec.host` / `terminal.native` are capabilities no old id maps onto, so
    // no rename may hand them out. Keyed on the CURRENT ids: asserting the
    // retired `core.shell.native` spelling would pass vacuously, since nothing
    // in the product can produce it any more.
    const r = migrateProjectRecord(
      rawProject({
        roleGrantVersion: 0,
        roles: {
          owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'] },
          manager: { agents: '*', canInvite: false, canManageRoles: false, grantedFeatures: ['core.agents', 'core.shell.host'] },
          member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: ['core.agents'] },
          viewer: { agents: 'view', canInvite: false, canManageRoles: false, grantedFeatures: ['core.agents'] },
        },
      }),
    );
    for (const role of Object.keys(r.roles)) {
      if (r.roles[role].grantedFeatures.includes('*')) continue;
      expect(r.roles[role].grantedFeatures).not.toContain('exec.host');
      expect(r.roles[role].grantedFeatures).not.toContain('terminal.native');
    }
  });

  it('v10 de-duplicates when a role already holds BOTH the old and the new id', () => {
    const r = migrateProjectRecord(
      rawProject({
        roleGrantVersion: 9,
        roles: {
          owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'] },
          manager: {
            agents: '*',
            canInvite: false,
            canManageRoles: false,
            grantedFeatures: ['core.shell.container', 'core.shell.host'],
          },
          member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [] },
          viewer: { agents: 'view', canInvite: false, canManageRoles: false, grantedFeatures: [] },
        },
      }),
    );
    // The dedup claim is about the RENAMED id, not the whole array: later
    // versions legitimately add their own grants on top (v11 adds terminal.read).
    expect(r.roles.manager.grantedFeatures.filter((f) => f === 'exec.unconfined')).toHaveLength(1);
    expect(r.roles.manager.grantedFeatures).not.toContain('core.shell.host');
    expect(r.roles.manager.grantedFeatures).not.toContain('core.shell.container');
  });
});

// ---------------------------------------------------------------------------
// v19 — every shell ENTRY moves into the `exec.*` namespace, and
// `core.execute` fans out onto ITSELF plus the new container ENTRY.
//
// The derived grant is the capability-preserving half: until v19 the container
// plane had NO entry feature, so every role that could run `execute` could open
// a container shell. Without the fan-out the migration would take that away
// from every role — including the custom ones no repair row can name.
// ---------------------------------------------------------------------------

describe('v19 — the exec.* namespace + the derived container entry', () => {
  function atV18(roles: Record<string, unknown>): Record<string, unknown> {
    return rawProject({ roleGrantVersion: 18, roles });
  }
  const owner = { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'] };

  it('renames the three exec ids on a BUILTIN role and derives exec.container', () => {
    const r = migrateProjectRecord(
      atV18({
        owner,
        manager: {
          agents: '*',
          canInvite: false,
          canManageRoles: false,
          grantedFeatures: ['core.agents', 'core.execute', 'core.shell.container', 'machine.exec'],
        },
      }),
    );
    const manager = r.roles.manager.grantedFeatures;
    expect(manager).toEqual(['core.agents', 'core.execute', 'exec.container', 'exec.unconfined', 'exec.machine']);
    for (const dead of ['core.shell.container', 'core.shell.native', 'machine.exec']) {
      expect(manager).not.toContain(dead);
    }
  });

  it('carries a CUSTOM role holding all three old ids + core.execute', () => {
    const r = migrateProjectRecord(
      atV18({
        owner,
        devops: {
          agents: '*',
          canInvite: false,
          canManageRoles: false,
          grantedFeatures: [
            'core.execute',
            'core.shell.container',
            'core.shell.native',
            'machine.exec',
            'terminal.read',
          ],
        },
      }),
    );
    expect(r.roles.devops.grantedFeatures).toEqual([
      'core.execute',
      'exec.container',
      'exec.unconfined',
      'exec.host',
      'exec.machine',
      'terminal.read',
    ]);
  });

  it('a role WITHOUT core.execute does NOT gain exec.container', () => {
    // The fan-out is a DERIVED grant, never an invention: the entry follows the
    // id that already opened the door, and nothing else.
    const r = migrateProjectRecord(
      atV18({
        owner,
        viewer: {
          agents: 'view',
          canInvite: false,
          canManageRoles: false,
          grantedFeatures: ['core.agents', 'core.observe'],
        },
      }),
    );
    expect(r.roles.viewer.grantedFeatures).not.toContain('exec.container');
    expect(r.roles.viewer.grantedFeatures).toEqual(['core.agents', 'core.observe']);
  });

  it("a '*' role is untouched", () => {
    const r = migrateProjectRecord(atV18({ owner }));
    expect(r.roles.owner.grantedFeatures).toEqual(['*']);
  });

  it('reaches a record stamped BELOW 18 through the whole chain', () => {
    const r = migrateProjectRecord(
      rawProject({
        roleGrantVersion: 16,
        roles: {
          owner,
          devops: {
            agents: '*',
            canInvite: false,
            canManageRoles: false,
            grantedFeatures: ['core.execute', 'machine.exec'],
          },
        },
      }),
    );
    expect(r.roleGrantVersion).toBe(19);
    expect(r.roles.devops.grantedFeatures).toEqual(['core.execute', 'exec.container', 'exec.machine']);
  });

  it('is idempotent — a second run changes nothing', () => {
    const once = migrateProjectRecord(
      atV18({
        owner,
        manager: {
          agents: '*',
          canInvite: false,
          canManageRoles: false,
          grantedFeatures: ['core.execute', 'core.shell.container'],
        },
      }),
    );
    const snapshot = JSON.stringify(once);
    const twice = migrateProjectRecord(once as unknown as Record<string, unknown>);
    expect(JSON.stringify(twice)).toBe(snapshot);
  });

  it('never duplicates an entry a role already holds', () => {
    const r = migrateProjectRecord(
      atV18({
        owner,
        manager: {
          agents: '*',
          canInvite: false,
          canManageRoles: false,
          grantedFeatures: ['core.execute', 'exec.container', 'exec.unconfined', 'core.shell.container'],
        },
      }),
    );
    const manager = r.roles.manager.grantedFeatures;
    expect(manager.filter((f) => f === 'exec.container')).toHaveLength(1);
    expect(manager.filter((f) => f === 'exec.unconfined')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// native-nightjar H0 follow-up — the terminal.read backfill (v11).
//
// Builtin defaultRoleGrants apply at PROJECT CREATION (or a builtin's late
// `pkg add`) only, so a project made before the terminal shipped (or one whose roles were hand-edited) never
// receives a later default. Live-caught: one project's member AND manager held
// no `terminal.*` id at all, so the Terminal widget was ABSENT from the widget
// and dock listings rather than merely locked — a silently missing capability.
// ---------------------------------------------------------------------------

describe('v11 — terminal.read backfill', () => {
  function withoutTerminal(version: number) {
    return rawProject({
      roleGrantVersion: version,
      roles: {
        owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'] },
        manager: { agents: '*', canInvite: false, canManageRoles: false, grantedFeatures: ['core.agents'] },
        member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: ['core.agents'] },
        viewer: { agents: 'view', canInvite: false, canManageRoles: false, grantedFeatures: ['core.agents'] },
      },
    });
  }

  it('grants terminal.read to manager and member', () => {
    const r = migrateProjectRecord(withoutTerminal(10));
    expect(r.roles.manager.grantedFeatures).toContain('terminal.read');
    expect(r.roles.member.grantedFeatures).toContain('terminal.read');
  });

  // The v3 revoke is a deliberate tightening; a later additive repair must not
  // undo it. Scoping the repair to manager+member (matching the manifest) is
  // what keeps the two migrations from fighting.
  it('does NOT resurrect terminal.read for viewer, whose v3 revoke stands', () => {
    const r = migrateProjectRecord(withoutTerminal(0));
    expect(r.roles.viewer.grantedFeatures).not.toContain('terminal.read');
  });

  it('leaves a wildcard role untouched', () => {
    const r = migrateProjectRecord(withoutTerminal(10));
    expect(r.roles.owner.grantedFeatures).toEqual(['*']);
  });

  it('is idempotent — a project already holding it gains no duplicate', () => {
    const base = withoutTerminal(10);
    (base.roles as Record<string, { grantedFeatures: string[] }>).member.grantedFeatures = [
      'core.agents',
      'terminal.read',
    ];
    const r = migrateProjectRecord(base);
    expect(r.roles.member.grantedFeatures.filter((f) => f === 'terminal.read')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// D-F / D-A — role-grant version 12: the priority SCALE change (P0), the
// name→flag translation (P5) and the member `tier` mirror (P6).
//
// This is the highest-risk migration in the campaign: it rewrites every stored
// priority, and both role WRITE paths reject a built-in whose explicit priority
// differs from its anchor — so a project that misses P0 can never have its role
// map PATCHed again.
// ---------------------------------------------------------------------------

describe('v12 — priority re-anchor (P0), canManageRoles flag (P5), tier mirror (P6)', () => {
  /** A pre-v12 record on the OLD 1..5 scale, with the legacy stored values. */
  function legacyScaleProject(over: Record<string, unknown> = {}) {
    return rawProject({
      roleGrantVersion: 11,
      members: {
        'owner-1': { userId: 'owner-1', name: 'O', email: 'o@x', role: 'owner', position: 'Owner', tier: 1, addedAt: '2026-01-01' },
        'mgr-1': { userId: 'mgr-1', name: 'M', email: 'm@x', role: 'manager', position: '', tier: 3, addedAt: '2026-01-01' },
        'mem-1': { userId: 'mem-1', name: 'X', email: 'x@x', role: 'member', position: '', tier: 4, addedAt: '2026-01-01' },
      },
      roles: {
        owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
        admin: { agents: '*', canInvite: true, canManageRoles: false, grantedFeatures: ['*'], priority: 2 },
        manager: { agents: '*', canInvite: false, canManageRoles: false, grantedFeatures: ['core.agents'], priority: 3 },
        member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: ['core.agents'], priority: 4 },
        viewer: { agents: 'view', canInvite: false, canManageRoles: false, grantedFeatures: ['core.agents'], priority: 5 },
      },
      ...over,
    });
  }

  it('P0 re-anchors the five built-ins onto the 1/2/10/20/30 scale', () => {
    const r = migrateProjectRecord(legacyScaleProject());
    expect(r.roles.owner.priority).toBe(1);
    expect(r.roles.admin.priority).toBe(2);
    expect(r.roles.manager.priority).toBe(10);
    expect(r.roles.member.priority).toBe(20);
    expect(r.roles.viewer.priority).toBe(30);
  });

  it('P0 maps a CUSTOM role through the old→new band table, preserving relative strength', () => {
    const r = migrateProjectRecord(
      legacyScaleProject({
        roles: {
          ...(legacyScaleProject().roles as Record<string, unknown>),
          // Was exactly as strong as manager (3) and as member (4).
          lead: { agents: '*', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 3 },
          helper: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 4 },
        },
      }),
    );
    expect(r.roles.lead.priority).toBe(10);
    expect(r.roles.lead.priority).toBe(r.roles.manager.priority);
    expect(r.roles.helper.priority).toBe(20);
    expect(r.roles.helper.priority).toBe(r.roles.member.priority);
  });

  it('P0 clamps an out-of-band custom priority toward WEAKER, never stronger', () => {
    // Storable today (there was no range check). Under the OLD scale `7` was
    // weaker than viewer (5); leaving it at face value would make it STRONGER
    // than manager (10) on the new scale — a migration-granted escalation.
    const r = migrateProjectRecord(
      legacyScaleProject({
        roles: {
          ...(legacyScaleProject().roles as Record<string, unknown>),
          intern: { agents: 'view', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 7 },
          ghost: { agents: 'view', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 5000 },
        },
      }),
    );
    expect(r.roles.intern.priority).toBeGreaterThan(r.roles.viewer.priority);
    expect(r.roles.intern.priority).toBe(31);
    expect(r.roles.ghost.priority).toBe(99);
  });

  it('a custom role with NO stored priority keeps the backfill default, not the out-of-band clamp', () => {
    // The pre-existing backfill writes `DEFAULT_CUSTOM_ROLE_PRIORITY` (a
    // CURRENT-scale value). P0 must not then treat it as an old-scale number and
    // push it past `viewer` — the two passes run in the same call.
    const r = migrateProjectRecord(
      legacyScaleProject({
        roles: {
          ...(legacyScaleProject().roles as Record<string, unknown>),
          fresh: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [] },
          broken: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: Number.NaN },
        },
      }),
    );
    expect(r.roles.fresh.priority).toBe(BUILTIN_ROLE_PRIORITY.member);
    expect(r.roles.broken.priority).toBe(BUILTIN_ROLE_PRIORITY.member);
  });

  it('P0 clamps a stronger-than-owner custom priority INTO the range at the strongest legal value', () => {
    const r = migrateProjectRecord(
      legacyScaleProject({
        roles: {
          ...(legacyScaleProject().roles as Record<string, unknown>),
          god: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 0 },
        },
      }),
    );
    // It already resolved as owner-strength; clamping to 1 is the smallest
    // possible demotion and can never be an escalation.
    expect(r.roles.god.priority).toBe(1);
  });

  it('P5 raises canManageRoles for the roles NAMED owner/admin — the deleted name-set, translated to data', () => {
    const r = migrateProjectRecord(legacyScaleProject());
    expect(r.roles.owner.canManageRoles).toBe(true);
    expect(r.roles.admin.canManageRoles).toBe(true);
    // Raise-only: it never writes `false`.
    expect(r.roles.manager.canManageRoles).toBe(false);
    expect(r.roles.member.canManageRoles).toBe(false);
  });

  it('P5 does NOT escalate a CUSTOM priority-2 role whose canManageRoles is false (T15)', () => {
    // Today `PRIVILEGED_ROLE_NAMES.has('lead')` is false, so this role cannot
    // manage roles. A priority-keyed raise would hand it that power by
    // migration, against the owner's explicit configuration.
    const r = migrateProjectRecord(
      legacyScaleProject({
        roles: {
          ...(legacyScaleProject().roles as Record<string, unknown>),
          lead: { agents: '*', canInvite: true, canManageRoles: false, grantedFeatures: ['*'], priority: 2 },
        },
      }),
    );
    expect(r.roles.lead.priority).toBe(2);
    expect(r.roles.lead.canManageRoles).toBe(false);
  });

  it('P6 re-derives every member tier from the new role priorities', () => {
    const r = migrateProjectRecord(legacyScaleProject());
    expect(r.members['owner-1'].tier).toBe(1);
    expect(r.members['mgr-1'].tier).toBe(10);
    expect(r.members['mem-1'].tier).toBe(20);
  });

  it('N4 — the seeded owner is byte-unchanged by v12', () => {
    const before = legacyScaleProject();
    const ownerBefore = structuredClone((before.roles as Record<string, unknown>).owner);
    const r = migrateProjectRecord(before);
    expect(r.roles.owner).toEqual(ownerBefore);
    expect(r.roles.owner.grantedFeatures).toEqual(['*']);
    expect(r.members['owner-1'].tier).toBe(1);
  });

  it('D-C: the `admin` role loses the wildcard and receives the enumerated catalog', () => {
    const r = migrateProjectRecord(legacyScaleProject());
    expect(r.roles.admin.grantedFeatures).not.toContain('*');
    // The claim is the SET, not the order: a later rename row may re-position an
    // id (v19 inserts the derived `exec.container` beside `core.execute`, while
    // the manifest union lists it where the manifest declares it). Sorting still
    // catches a duplicate or a missing id, which is what the floor is about.
    expect([...r.roles.admin.grantedFeatures].sort()).toEqual([...DEFAULT_ROLES.admin.grantedFeatures].sort());
  });

  it('a second run is a byte-for-byte no-op (the version gate is the idempotency mechanism)', () => {
    const once = migrateProjectRecord(legacyScaleProject());
    const snapshot = JSON.stringify(once);
    const twice = migrateProjectRecord(once as unknown as Record<string, unknown>);
    expect(JSON.stringify(twice)).toBe(snapshot);
    expect(twice.roleGrantVersion).toBe(19);
  });

  it('an already-current record is byte-unchanged', () => {
    // Current SHAPE too, not just current version: the unversioned structural
    // normalizes (members array→map, limits.daily→spend) rewrite a legacy shape
    // regardless of the version gate — that is their job.
    const already = legacyScaleProject({
      roleGrantVersion: 19,
      limits: { spend: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} } },
    });
    const snapshot = JSON.stringify(already);
    const r = migrateProjectRecord(structuredClone(already));
    expect(JSON.stringify(r)).toBe(snapshot);
    // Its stale 1..5 priorities are deliberately NOT rewritten — the gate is the
    // version, not the value. Re-running a phase out of band is what would
    // corrupt a record.
    expect(r.roles.manager.priority).toBe(3);
  });

  it('M4 — never mutates the module-level DEFAULT_ROLES seed', () => {
    // A legacy record with no roles at all is seeded with a SHALLOW
    // `{ ...DEFAULT_ROLES }`, so its role objects ARE the seed objects. An
    // in-place `role.priority = …` would corrupt the seed process-wide.
    const managerBefore = DEFAULT_ROLES.manager.priority;
    const adminFlagBefore = DEFAULT_ROLES.admin.canManageRoles;
    migrateProjectRecord(rawProject({ roleGrantVersion: 0, roles: undefined }));
    expect(DEFAULT_ROLES.manager.priority).toBe(managerBefore);
    expect(DEFAULT_ROLES.admin.canManageRoles).toBe(adminFlagBefore);
    expect(DEFAULT_ROLES.manager.priority).toBe(BUILTIN_ROLE_PRIORITY.manager);
  });

  it('a legacy members ARRAY converges: no name-derived position, tier mirrors priority', () => {
    const r = migrateProjectRecord(
      rawProject({
        roleGrantVersion: 0,
        members: [
          { userId: 'owner-1', name: 'O', email: 'o@x', role: 'owner', addedAt: '2026-01-01' },
          { userId: 'ed-1', name: 'E', email: 'e@x', role: 'editor', addedAt: '2026-01-01' },
        ],
        roles: undefined,
      }),
    );
    expect(r.members['owner-1'].position).toBe('');
    expect(r.members['owner-1'].tier).toBe(1);
    // legacy `editor` maps to `admin`
    expect(r.members['ed-1'].role).toBe('admin');
    expect(r.members['ed-1'].tier).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// D-D / D-C — role-grant version 13: the `admin.*` → `project.*`/`platform.*`
// namespace REPLACEMENT (P2, 1:N) and the `'*'` de-wildcard (P4).
//
// Order is load-bearing: renames skip `'*'` holders, so a still-wildcarded
// `admin` is untouched by P2 and is then de-wildcarded by P4 with the NEW ids
// directly. Reversing them would rewrite admin twice.
// ---------------------------------------------------------------------------

describe('v13 — namespace rename (P2, 1:N) + de-wildcard (P4)', () => {
  /** A pre-v13 record carrying old-namespace grants on a CUSTOM role. */
  function preSplitProject(over: Record<string, unknown> = {}) {
    return rawProject({
      roleGrantVersion: 12,
      members: {
        'owner-1': { userId: 'owner-1', name: 'O', email: 'o@x', role: 'owner', position: 'Owner', tier: 1, addedAt: '2026-01-01' },
      },
      roles: {
        owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: BUILTIN_ROLE_PRIORITY.owner },
        admin: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: BUILTIN_ROLE_PRIORITY.admin },
        member: {
          agents: 'own', canInvite: false, canManageRoles: false,
          grantedFeatures: ['core.agents', 'admin.dashboard'],
          priority: BUILTIN_ROLE_PRIORITY.member,
        },
        // A hand-made role holding BOTH fused ids — the case a 1:1 rename cannot
        // express and a role-name-keyed repair would never reach.
        ops: {
          agents: 'own', canInvite: true, canManageRoles: false,
          grantedFeatures: ['admin.users', 'admin.config', 'admin.credentials', 'admin.vector'],
          priority: 15,
        },
      },
      ...over,
    });
  }

  it('P2 fans `admin.users` out to all five successors on a CUSTOM role', () => {
    const r = migrateProjectRecord(preSplitProject());
    expect(r.roles.ops.grantedFeatures).toEqual(
      expect.arrayContaining([
        'project.members', 'platform.projects', 'platform.users', 'platform.scope', 'platform.audit',
      ]),
    );
    expect(r.roles.ops.grantedFeatures).not.toContain('admin.users');
  });

  it('P2 fans `admin.config` out to its four successors, and renames the 1:1 ids', () => {
    const r = migrateProjectRecord(preSplitProject());
    expect(r.roles.ops.grantedFeatures).toEqual(
      expect.arrayContaining(['project.roles', 'project.sources', 'platform.config', 'platform.vector']),
    );
    expect(r.roles.ops.grantedFeatures).toContain('project.credentials');
    expect(r.roles.ops.grantedFeatures).toContain('platform.vector.reset');
    expect(r.roles.member.grantedFeatures).toContain('project.dashboard');
    expect(r.roles.member.grantedFeatures).not.toContain('admin.dashboard');
    // N3 — the rename never DROPS an unrelated grant.
    expect(r.roles.member.grantedFeatures).toContain('core.agents');
  });

  it('P2 de-duplicates when two old ids map onto a shared successor', () => {
    const r = migrateProjectRecord(preSplitProject());
    const ids = r.roles.ops.grantedFeatures;
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('P4 de-wildcards `admin` with the manifest-derived catalog, and NEVER the owner', () => {
    const r = migrateProjectRecord(preSplitProject());
    expect(r.roles.owner.grantedFeatures).toEqual(['*']);
    expect(r.roles.admin.grantedFeatures).not.toContain('*');
    // Set equality, not order — see the D-C row above.
    expect([...r.roles.admin.grantedFeatures].sort()).toEqual([...DEFAULT_ROLES.admin.grantedFeatures].sort());
    // The union is the project tier only — no platform.* id is a DEFAULT grant.
    expect(r.roles.admin.grantedFeatures.filter((f) => f.startsWith('platform.'))).toEqual([]);
  });

  it('P4 is keyed on PRIORITY, not the name: a custom priority-2 wildcard role is de-wildcarded too', () => {
    const r = migrateProjectRecord(
      preSplitProject({
        roles: {
          owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: BUILTIN_ROLE_PRIORITY.owner },
          cheffe: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: BUILTIN_ROLE_PRIORITY.admin },
        },
      }),
    );
    expect(r.roles.cheffe.grantedFeatures).not.toContain('*');
    expect(r.roles.owner.grantedFeatures).toEqual(['*']);
  });

  it('P4 keeps the wildcard on a CUSTOM owner-strength role (priority 1)', () => {
    const r = migrateProjectRecord(
      preSplitProject({
        roles: {
          owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: BUILTIN_ROLE_PRIORITY.owner },
          founder: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
        },
      }),
    );
    expect(r.roles.founder.grantedFeatures).toEqual(['*']);
  });

  it('v13 is idempotent: a second run is byte-identical', () => {
    const once = migrateProjectRecord(preSplitProject());
    const snapshot = JSON.stringify(once);
    const twice = migrateProjectRecord(once as unknown as Record<string, unknown>);
    expect(JSON.stringify(twice)).toBe(snapshot);
    expect(twice.roleGrantVersion).toBe(19);
  });

  it('N4 — the seeded owner is byte-unchanged by v13', () => {
    const before = preSplitProject();
    const ownerBefore = structuredClone((before.roles as Record<string, unknown>).owner);
    const r = migrateProjectRecord(before);
    expect(r.roles.owner).toEqual(ownerBefore);
  });

  it('T16 — a DEGENERATE builtin union skips P4, keeps the wildcard, and does not advance the version', () => {
    // `DEFAULT_ROLES.admin.grantedFeatures` is derived at module load from every
    // builtin manifest through a read that swallows ALL errors, over a set the
    // `NEURALIS_BUILTINS` env var can override. A truncated union must NOT be
    // persisted: the version gate would freeze it and every project admin would
    // silently lose the whole catalog, permanently.
    const real = [...DEFAULT_ROLES.admin.grantedFeatures];
    DEFAULT_ROLES.admin.grantedFeatures.length = 0;
    try {
      const before = preSplitProject();
      const adminBefore = structuredClone((before.roles as Record<string, unknown>).admin);
      const r = migrateProjectRecord(before);
      expect(r.roles.admin).toEqual(adminBefore);
      expect(r.roles.admin.grantedFeatures).toEqual(['*']);
      expect(r.roleGrantVersion).toBe(12);
    } finally {
      DEFAULT_ROLES.admin.grantedFeatures.push(...real);
    }
  });

  it('T16 — a SHORT-but-nonempty union (missing a liveness id) is also refused', () => {
    const real = [...DEFAULT_ROLES.admin.grantedFeatures];
    DEFAULT_ROLES.admin.grantedFeatures.length = 0;
    // Everything except `core.agents` — a plausible "agent-core manifest failed
    // to read" shape, which an emptiness-only check would happily persist.
    DEFAULT_ROLES.admin.grantedFeatures.push(...real.filter((f) => f !== 'core.agents'));
    try {
      const r = migrateProjectRecord(preSplitProject());
      expect(r.roles.admin.grantedFeatures).toEqual(['*']);
      expect(r.roleGrantVersion).toBe(12);
    } finally {
      DEFAULT_ROLES.admin.grantedFeatures.length = 0;
      DEFAULT_ROLES.admin.grantedFeatures.push(...real);
    }
  });

  it('T16 — the skipped record is repaired by a later HEALTHY run', () => {
    const real = [...DEFAULT_ROLES.admin.grantedFeatures];
    DEFAULT_ROLES.admin.grantedFeatures.length = 0;
    let halted: ReturnType<typeof migrateProjectRecord>;
    try {
      halted = migrateProjectRecord(preSplitProject());
    } finally {
      DEFAULT_ROLES.admin.grantedFeatures.push(...real);
    }
    expect(halted.roleGrantVersion).toBe(12);
    const healed = migrateProjectRecord(halted as unknown as Record<string, unknown>);
    expect(healed.roleGrantVersion).toBe(19);
    expect(healed.roles.admin.grantedFeatures).not.toContain('*');
    // The renames replayed on the retry are idempotent — no duplicate ids.
    const ids = healed.roles.ops.grantedFeatures;
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// S1 (v17) — apex-authority heal.
//
// The S1 role-map floor makes "you may only edit roles strictly weaker than
// yourself" structural, which also makes any damage already on disk permanent.
// This phase repairs the one unambiguous brick — an apex role whose grant list
// was emptied — in the SAME increment as the closure.
// ---------------------------------------------------------------------------

describe('v17 — seeded-owner authority heal (P7)', () => {
  function damaged(over: Record<string, unknown> = {}): Record<string, unknown> {
    return rawProject({
      roleGrantVersion: 16,
      roles: {
        owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: [], priority: 1 },
        admin: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['drive.read'], priority: 2 },
        member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: ['drive.read'], priority: 20 },
      },
      ...over,
    });
  }

  it('restores the wildcard when the SEEDED owner role was emptied', () => {
    const r = migrateProjectRecord(damaged());
    expect(r.roles.owner.grantedFeatures).toEqual(['*']);
    expect(r.roleGrantVersion).toBe(19);
  });

  it('NEVER promotes a custom priority-1 role — an empty apex role is a coherent design', () => {
    // `canManageRoles` is a FLAG, not a feature, so a governance-only apex role
    // with zero capabilities is something an owner could deliberately create
    // before S1. Widening it to `'*'` would be an escalation granted by a
    // migration — and `hasFeature`'s `'*'` arm reaches the `platform.*` tier, so
    // it would cross the project boundary. This is the arm that keeps P7 from
    // contradicting `seedRolesForNewProject`'s own prohibition.
    const r = migrateProjectRecord(
      damaged({
        roles: {
          owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
          board: { agents: 'view', canInvite: false, canManageRoles: true, grantedFeatures: [], priority: 1 },
          member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: ['drive.read'], priority: 20 },
        },
      }),
    );
    expect(r.roles.board.grantedFeatures).toEqual([]);
    expect(r.roles.owner.grantedFeatures).toEqual(['*']);
  });

  it('never widens a NON-apex empty role — that is a legitimate revoke, not damage', () => {
    const r = migrateProjectRecord(
      damaged({
        roles: {
          owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
          member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 20 },
        },
      }),
    );
    expect(r.roles.member.grantedFeatures).toEqual([]);
  });

  it('never widens a NARROW-but-non-empty owner role — indistinguishable from least privilege', () => {
    const r = migrateProjectRecord(
      damaged({
        roles: {
          owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['drive.read'], priority: 1 },
          member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: ['drive.read'], priority: 20 },
        },
      }),
    );
    expect(r.roles.owner.grantedFeatures).toEqual(['drive.read']);
  });

  it('the repair is AUDIBLE — a silent grant rewrite is not acceptable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      migrateProjectRecord(damaged());
      const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(said).toContain('v17 repaired project');
      expect(said).toContain('owner');
    } finally {
      warn.mockRestore();
    }
  });

  it('a second run is byte-identical (idempotence, the live two-boot control)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const once = migrateProjectRecord(damaged());
      const snapshot = JSON.stringify(once);
      const twice = migrateProjectRecord(JSON.parse(snapshot) as Record<string, unknown>);
      expect(JSON.stringify(twice)).toBe(snapshot);
      expect(twice.roleGrantVersion).toBe(19);
    } finally {
      warn.mockRestore();
    }
  });

  it('rollback leg — a record stamped by a NEWER build keeps its version and runs no phase', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const future = rawProject({
        roleGrantVersion: 99,
        roles: {
          owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: [], priority: 1 },
        },
        members: {},
      });
      const r = migrateProjectRecord(future);
      // Not healed and — the property that matters — never DOWNGRADED. The
      // structural normalizers above the version gate may still repair shape;
      // only the version-keyed phases are gated.
      expect(r.roleGrantVersion).toBe(99);
      expect(r.roles.owner.grantedFeatures).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});
