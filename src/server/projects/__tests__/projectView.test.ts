import { describe, expect, it } from 'vitest';
import { toProjectView } from '../projectView';
import type { ProjectRecord } from '../../store/projectTypes';

const RULE = { amountUsd: 5, period: 'day' as const };

function fixture(): ProjectRecord {
  return {
    id: 'proj-1',
    name: 'Project',
    ownerId: 'owner-user',
    members: {
      'owner-user': {
        userId: 'owner-user', name: 'Owner', email: 'o@example.com', role: 'owner',
        position: 'Owner', tier: 1, addedAt: '2026-01-01T00:00:00.000Z',
      },
      'viewer-user': {
        userId: 'viewer-user', name: 'Viewer', email: 'v@example.com', role: 'viewer',
        position: 'Viewer', tier: 5, addedAt: '2026-01-01T00:00:00.000Z',
      },
      'member-user': {
        userId: 'member-user', name: 'Member', email: 'm@example.com', role: 'member',
        position: 'Member', tier: 4, addedAt: '2026-01-01T00:00:00.000Z',
      },
    },
    roles: {
      owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
      member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: ['core.agents'], priority: 20 },
      viewer: { agents: 'view', canInvite: false, canManageRoles: false, grantedFeatures: ['project.dashboard'], priority: 30 },
    },
    agentOwnership: {},
    limits: {
      spend: {
        projectTotal: RULE,
        byRole: { member: RULE },
        byUser: { 'owner-user': RULE, 'viewer-user': { amountUsd: 1, period: 'week' } },
        byAgent: { coder: RULE },
      },
      rateLimitRpm: 30,
    },
    packageTrust: { 'my-pkg': 'trusted' },
    packageAccessFeature: { 'my-pkg': 'core.agents' },
    appliedPackageGrants: { 'my-pkg': '1.0.0' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('toProjectView (D2 feature-keyed projection)', () => {
  it('bare membership: no other emails, no other grant lists, no other byUser rows, no package governance', () => {
    const view = toProjectView(fixture(), { userId: 'viewer-user', grantedFeatures: ['project.dashboard'] });

    // Other members' emails hidden; every other field of the row survives.
    expect(view.members['owner-user'].email).toBeUndefined();
    expect(view.members['member-user'].email).toBeUndefined();
    expect(view.members['owner-user'].name).toBe('Owner');
    expect(view.members['owner-user'].role).toBe('owner');

    // SELF-KNOWLEDGE: own row keeps its email.
    expect(view.members['viewer-user'].email).toBe('v@example.com');

    // Other roles lose grantedFeatures but keep name/flags/priority.
    expect(view.roles.owner.grantedFeatures).toBeUndefined();
    expect(view.roles.member.grantedFeatures).toBeUndefined();
    expect(view.roles.owner.priority).toBe(1);
    expect(view.roles.owner.canManageRoles).toBe(true);

    // SELF-KNOWLEDGE: own role keeps grantedFeatures (client widget gating).
    expect(view.roles.viewer.grantedFeatures).toEqual(['project.dashboard']);

    // Limits: projectTotal/byRole/byAgent/rateLimitRpm survive; only the OWN byUser row.
    expect(view.limits.spend.projectTotal).toEqual(RULE);
    expect(view.limits.spend.byRole).toEqual({ member: RULE });
    expect(view.limits.spend.byAgent).toEqual({ coder: RULE });
    expect(view.limits.rateLimitRpm).toBe(30);
    expect(view.limits.spend.byUser).toEqual({ 'viewer-user': { amountUsd: 1, period: 'week' } });

    // Package governance slices are `project.roles`-gated.
    expect(view.packageTrust).toBeUndefined();
    expect(view.packageAccessFeature).toBeUndefined();
    expect(view.appliedPackageGrants).toBeUndefined();
  });

  it('project.members reveals other emails but not grants or byUser rows', () => {
    const view = toProjectView(fixture(), { userId: 'viewer-user', grantedFeatures: ['project.members'] });
    expect(view.members['owner-user'].email).toBe('o@example.com');
    expect(view.roles.owner.grantedFeatures).toBeUndefined();
    expect(view.limits.spend.byUser).toEqual({ 'viewer-user': { amountUsd: 1, period: 'week' } });
  });

  it('project.roles reveals grant lists + package governance but not emails or byUser rows', () => {
    const view = toProjectView(fixture(), { userId: 'viewer-user', grantedFeatures: ['project.roles'] });
    expect(view.roles.owner.grantedFeatures).toEqual(['*']);
    expect(view.packageTrust).toEqual({ 'my-pkg': 'trusted' });
    expect(view.members['owner-user'].email).toBeUndefined();
    expect(view.limits.spend.byUser).toEqual({ 'viewer-user': { amountUsd: 1, period: 'week' } });
  });

  it('project.limits reveals every byUser row but not emails or grants', () => {
    const view = toProjectView(fixture(), { userId: 'viewer-user', grantedFeatures: ['project.limits'] });
    expect(view.limits.spend.byUser).toEqual({
      'owner-user': RULE,
      'viewer-user': { amountUsd: 1, period: 'week' },
    });
    expect(view.members['owner-user'].email).toBeUndefined();
    expect(view.roles.owner.grantedFeatures).toBeUndefined();
  });

  it('all three features held ⇒ the full record, by identity', () => {
    const project = fixture();
    const view = toProjectView(project, {
      userId: 'viewer-user',
      grantedFeatures: ['project.members', 'project.roles', 'project.limits'],
    });
    expect(view).toBe(project);
  });

  it("the owner's wildcard resolves all three features ⇒ full record", () => {
    const project = fixture();
    expect(toProjectView(project, { userId: 'owner-user', grantedFeatures: ['*'] })).toBe(project);
  });

  it('WRITE-IMPLIES-READ: a canManageRoles holder gets the full record with zero features', () => {
    const project = fixture();
    project.roles.member.canManageRoles = true;
    const view = toProjectView(project, { userId: 'member-user', grantedFeatures: [] });
    expect(view).toBe(project);
  });

  it('a non-member caller (platform.projects read) gets the feature-only projection', () => {
    const view = toProjectView(fixture(), { userId: 'outsider', grantedFeatures: ['project.members'] });
    expect(view.members['owner-user'].email).toBe('o@example.com');
    expect(view.roles.owner.grantedFeatures).toBeUndefined();
    expect(view.limits.spend.byUser).toEqual({});
  });

  it('undefined grantedFeatures behaves as none (deny-by-default)', () => {
    const view = toProjectView(fixture(), { userId: 'viewer-user', grantedFeatures: undefined });
    expect(view.members['owner-user'].email).toBeUndefined();
    expect(view.roles.viewer.grantedFeatures).toEqual(['project.dashboard']);
  });

  it('never mutates the input record', () => {
    const project = fixture();
    const before = JSON.parse(JSON.stringify(project));
    toProjectView(project, { userId: 'viewer-user', grantedFeatures: [] });
    expect(project).toEqual(before);
  });
});
