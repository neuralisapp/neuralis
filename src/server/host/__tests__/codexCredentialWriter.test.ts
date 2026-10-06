/**
 * The host `codexCredentialWriter` port — the Codex binding gate (all four
 * scopes, the own/cross/confined/unknown arms and the destination write tiers),
 * the port members that re-run it before every store touch, and the self-heal
 * `refresh` members that act on the tier the cascade RESOLVES.
 *
 * Two FACTS are stubbed (the live project record and the membership port) and
 * nothing else: the decision under test is the composition — kernel ownership
 * plus the destination tier — and stubbing the composition would test the stub.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import type { ProjectRecord, RoleDefinition } from '../../store/projectTypes';

const CALLER = 'u-caller';
const MATE = 'u-mate';
const OUTSIDER = 'u-outsider';

const mocks = vi.hoisted(() => ({
  getProjectById: vi.fn(),
  listCallerProjects: vi.fn(),
  agentBelongsToProject: vi.fn(),
}));

vi.mock('../../store/ProjectStore', () => ({
  getProjectById: mocks.getProjectById,
}));

// The member resolver checks the USER first; every caller here is active.
vi.mock('../../store/UserStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../store/UserStore')>()),
  getUserById: async (id: string) => ({ id, status: 'active' }),
}));

vi.mock('../scopeMembership', () => ({
  getScopeMembershipPort: () => ({
    listCallerProjects: mocks.listCallerProjects,
    agentBelongsToProject: mocks.agentBelongsToProject,
  }),
}));

import { CODEX_CREDENTIAL_ID, CodexBindingError, type CodexCallScope } from '@neuralis/package-system/contracts';
import {
  assertCodexBindingAccess,
  canReadCodexAgentScope,
  codexLockScope,
  createCodexCredentialWriter,
  resolvedLockScope,
  type CodexScopedStore,
} from '../codexCredentialWriter';

function role(grantedFeatures: string[]): RoleDefinition {
  return { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures, priority: 20 };
}

function project(grantedFeatures: string[], over: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: 'p1',
    name: 'p1',
    ownerId: CALLER,
    members: {
      [CALLER]: { userId: CALLER, name: CALLER, email: 'c@t.co', role: 'custom', position: '', tier: 0, addedAt: '' },
      [MATE]: { userId: MATE, name: MATE, email: 'm@t.co', role: 'custom', position: '', tier: 0, addedAt: '' },
    },
    roles: { custom: role(grantedFeatures) },
    agentOwnership: {},
    limits: { spend: {} },
    ...over,
  } as ProjectRecord;
}

const WRITE = ['project.credentials.write'];
const WRITE_AND_KEY = ['project.credentials.write', 'platform.scope'];

async function refusal(fn: Promise<void>): Promise<CodexBindingError> {
  try {
    await fn;
  } catch (err) {
    expect(err).toBeInstanceOf(CodexBindingError);
    return err as CodexBindingError;
  }
  throw new Error('expected a refusal, got an allow');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listCallerProjects.mockResolvedValue([{ id: 'p1', memberIds: [CALLER, MATE] }]);
  mocks.agentBelongsToProject.mockResolvedValue(false);
});

describe('user scope — own only, AND the member self-service gate in the named project', () => {
  const SELF = ['credentials.self'];

  it('400s by name when no project names where credentials.self is evaluated', async () => {
    const err = await refusal(
      assertCodexBindingAccess({ scope: { kind: 'user', userId: CALLER }, userId: CALLER }),
    );
    expect(err.status).toBe(400);
    expect(err.message).toContain('user-scope Codex OAuth requires the project');
    expect(mocks.getProjectById).not.toHaveBeenCalled();
  });

  it('refuses a non-member of the named project (403)', async () => {
    mocks.getProjectById.mockResolvedValue(project(SELF));
    const err = await refusal(
      assertCodexBindingAccess({ scope: { kind: 'user', userId: OUTSIDER }, userId: OUTSIDER, projectId: 'p1' }),
    );
    expect(err.status).toBe(403);
    expect(err.message).toContain('not a member');
  });

  it('refuses a member WITHOUT credentials.self (403, the feature named) — a viewer cannot store a login', async () => {
    mocks.getProjectById.mockResolvedValue(project(['core.observe']));
    const err = await refusal(
      assertCodexBindingAccess({ scope: { kind: 'user', userId: CALLER }, userId: CALLER, projectId: 'p1' }),
    );
    expect(err.status).toBe(403);
    expect(err.message).toContain('credentials.self required for user-scope Codex OAuth');
  });

  it('PAIRED CONTROL — a member WITH credentials.self stores their own login', async () => {
    mocks.getProjectById.mockResolvedValue(project(SELF));
    await expect(
      assertCodexBindingAccess({ scope: { kind: 'user', userId: CALLER }, userId: CALLER, projectId: 'p1' }),
    ).resolves.toBeUndefined();
  });

  it('refuses another user\'s scope by name even when the caller holds credentials.self', async () => {
    mocks.getProjectById.mockResolvedValue(project(SELF));
    const err = await refusal(
      assertCodexBindingAccess({ scope: { kind: 'user', userId: MATE }, userId: CALLER, projectId: 'p1' }),
    );
    expect(err.status).toBe(403);
    expect(err.message).toContain('your own user scope');
  });

  it('400s on an unknown project', async () => {
    mocks.getProjectById.mockResolvedValue(null);
    const err = await refusal(
      assertCodexBindingAccess({ scope: { kind: 'user', userId: CALLER }, userId: CALLER, projectId: 'nope' }),
    );
    expect(err.status).toBe(400);
    expect(err.message).toBe('Project not found');
  });

  it('REFUSES another user\'s scope by name, even for a platform.scope holder', async () => {
    mocks.getProjectById.mockResolvedValue(project(WRITE_AND_KEY));
    const err = await refusal(
      assertCodexBindingAccess({ scope: { kind: 'user', userId: MATE }, userId: CALLER, projectId: 'p1' }),
    );
    expect(err.message).toContain('your own user scope');
  });
});

describe('project scope — membership plus project.credentials.write', () => {
  it('allows a member who holds the write feature', async () => {
    mocks.getProjectById.mockResolvedValue(project(WRITE));
    await expect(
      assertCodexBindingAccess({ scope: { kind: 'project', projectId: 'p1' }, userId: CALLER }),
    ).resolves.toBeUndefined();
  });

  it('refuses a member WITHOUT the write feature (the paired control)', async () => {
    mocks.getProjectById.mockResolvedValue(project(['project.credentials']));
    const err = await refusal(
      assertCodexBindingAccess({ scope: { kind: 'project', projectId: 'p1' }, userId: CALLER }),
    );
    expect(err.message).toContain('project.credentials.write');
  });

  it('refuses a non-member before any feature is read', async () => {
    mocks.getProjectById.mockResolvedValue(project(WRITE));
    const err = await refusal(
      assertCodexBindingAccess({ scope: { kind: 'project', projectId: 'p1' }, userId: OUTSIDER }),
    );
    expect(err.message).toContain('not a member');
  });

  it('400s on an unknown project', async () => {
    mocks.getProjectById.mockResolvedValue(null);
    const err = await refusal(
      assertCodexBindingAccess({ scope: { kind: 'project', projectId: 'nope' }, userId: CALLER }),
    );
    expect(err.status).toBe(400);
  });
});

describe('project scope — the authority project IS the destination', () => {
  it('refuses a binding whose authority project differs from the destination', async () => {
    mocks.getProjectById.mockResolvedValue(project(WRITE_AND_KEY));
    const err = await refusal(
      assertCodexBindingAccess({
        scope: { kind: 'project', projectId: 'p1' },
        userId: CALLER,
        projectId: 'p-other',
      }),
    );
    expect(err.status).toBe(400);
    expect(err.message).toContain('p-other');
    expect(err.message).toContain('p1');
    // Refused BEFORE the wrong project's grants were ever read.
    expect(mocks.getProjectById).not.toHaveBeenCalled();
  });

  it('PAIRED CONTROL — the matching pair is allowed', async () => {
    mocks.getProjectById.mockResolvedValue(project(WRITE));
    await expect(
      assertCodexBindingAccess({
        scope: { kind: 'project', projectId: 'p1' },
        userId: CALLER,
        projectId: 'p1',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('canReadCodexAgentScope — the status READ gate is the same ownership answer', () => {
  it('refuses a traversal id BEFORE any project or store read', async () => {
    await expect(canReadCodexAgentScope(CALLER, 'p1', '../users/u-mate')).resolves.toBe(false);
    expect(mocks.getProjectById).not.toHaveBeenCalled();
    expect(mocks.listCallerProjects).not.toHaveBeenCalled();
  });

  it('refuses a well-formed id the caller neither owns nor may cross to', async () => {
    mocks.getProjectById.mockResolvedValue(project(WRITE));
    await expect(canReadCodexAgentScope(CALLER, 'p1', 'a-foreign')).resolves.toBe(false);
  });

  it('refuses a non-member of the naming project', async () => {
    mocks.getProjectById.mockResolvedValue(project(WRITE));
    await expect(canReadCodexAgentScope(OUTSIDER, 'p1', 'a-1')).resolves.toBe(false);
  });

  it('refuses when the project does not exist', async () => {
    mocks.getProjectById.mockResolvedValue(null);
    await expect(canReadCodexAgentScope(CALLER, 'nope', 'a-1')).resolves.toBe(false);
  });

  it('PAIRED CONTROL — an OWNED agent is still answered for', async () => {
    mocks.getProjectById.mockResolvedValue(
      project(WRITE, { agentOwnership: { 'a-1': { createdBy: CALLER, assignedTo: [] } } }),
    );
    await expect(canReadCodexAgentScope(CALLER, 'p1', 'a-1')).resolves.toBe(true);
  });

  it('a platform.scope holder reaches an agent inside their OWN projects, and no further', async () => {
    mocks.getProjectById.mockResolvedValue(project(WRITE_AND_KEY));
    mocks.agentBelongsToProject.mockResolvedValue(true);
    await expect(canReadCodexAgentScope(CALLER, 'p1', 'a-shared')).resolves.toBe(true);
    mocks.agentBelongsToProject.mockResolvedValue(false);
    await expect(canReadCodexAgentScope(CALLER, 'p1', 'a-elsewhere')).resolves.toBe(false);
  });
});

describe('agent scope — containment AND the project write feature', () => {
  it('allows an owned agent contained by the named project', async () => {
    mocks.getProjectById.mockResolvedValue(
      project(WRITE, { agentOwnership: { 'a-1': { createdBy: CALLER, assignedTo: [] } } }),
    );
    mocks.agentBelongsToProject.mockResolvedValue(true);
    await expect(
      assertCodexBindingAccess({ scope: { kind: 'agent', projectId: 'p1', agentId: 'a-1' }, userId: CALLER, projectId: 'p1' }),
    ).resolves.toBeUndefined();
  });

  it('refuses an owned agent that is NOT in the named project', async () => {
    mocks.getProjectById.mockResolvedValue(
      project(WRITE, { agentOwnership: { 'a-1': { createdBy: CALLER, assignedTo: [] } } }),
    );
    mocks.agentBelongsToProject.mockResolvedValue(false);
    const err = await refusal(
      assertCodexBindingAccess({ scope: { kind: 'agent', projectId: 'p1', agentId: 'a-1' }, userId: CALLER, projectId: 'p1' }),
    );
    expect(err.message).toContain('not in the named project');
  });

  it('refuses an unowned agent without platform.scope', async () => {
    mocks.getProjectById.mockResolvedValue(project(WRITE));
    mocks.agentBelongsToProject.mockResolvedValue(true);
    const err = await refusal(
      assertCodexBindingAccess({ scope: { kind: 'agent', projectId: 'p1', agentId: 'a-other' }, userId: CALLER, projectId: 'p1' }),
    );
    expect(err.message).toContain('agent scope outside your session');
  });

  it('refuses a traversal agent id', async () => {
    mocks.getProjectById.mockResolvedValue(project(WRITE_AND_KEY));
    const err = await refusal(
      assertCodexBindingAccess({ scope: { kind: 'agent', projectId: 'p1', agentId: '../../etc' }, userId: CALLER, projectId: 'p1' }),
    );
    expect(err.message).toContain('invalid path segment');
  });

  it('an absent binding project takes the agent scope\'s own project as the authority', async () => {
    mocks.getProjectById.mockResolvedValue(
      project(WRITE, { agentOwnership: { 'a-1': { createdBy: CALLER, assignedTo: [] } } }),
    );
    mocks.agentBelongsToProject.mockResolvedValue(true);
    await expect(
      assertCodexBindingAccess({ scope: { kind: 'agent', projectId: 'p1', agentId: 'a-1' }, userId: CALLER }),
    ).resolves.toBeUndefined();
    expect(mocks.getProjectById).toHaveBeenCalledWith('p1');
    expect(mocks.agentBelongsToProject).toHaveBeenCalledWith('p1', 'a-1');
  });

  it('400s BY NAME when the binding project and the agent scope\'s project disagree', async () => {
    const err = await refusal(
      assertCodexBindingAccess({ scope: { kind: 'agent', projectId: 'p2', agentId: 'a-1' }, userId: CALLER, projectId: 'p1' }),
    );
    expect(err.status).toBe(400);
    expect(err.message).toContain('agent scope evaluates its authority in the destination project');
    // Refused BEFORE either project's grants were read.
    expect(mocks.getProjectById).not.toHaveBeenCalled();
  });

  it('cross-tenant: owning `coder` in p1 grants NOTHING on p2\'s `coder`', async () => {
    // Two tenants, one slug. The caller owns p1's `coder` and is a member of p2
    // with the write tier but no ownership there and no cross-scope key.
    mocks.getProjectById.mockImplementation(async (id: string) =>
      id === 'p1'
        ? project(WRITE, { agentOwnership: { coder: { createdBy: CALLER, assignedTo: [] } } })
        : project(WRITE, { id: 'p2', name: 'p2', agentOwnership: {} }),
    );
    mocks.agentBelongsToProject.mockResolvedValue(true);
    const err = await refusal(
      assertCodexBindingAccess({ scope: { kind: 'agent', projectId: 'p2', agentId: 'coder' }, userId: CALLER }),
    );
    expect(err.message).toContain('agent scope outside your session');
    // PAIRED CONTROL — the same binding on p1's `coder` is allowed.
    await expect(
      assertCodexBindingAccess({ scope: { kind: 'agent', projectId: 'p1', agentId: 'coder' }, userId: CALLER }),
    ).resolves.toBeUndefined();
  });
});

describe('global scope — platform.scope and nothing else', () => {
  it('allows a platform.scope holder', async () => {
    mocks.getProjectById.mockResolvedValue(project(['platform.scope']));
    await expect(
      assertCodexBindingAccess({ scope: { kind: 'global' }, userId: CALLER, projectId: 'p1' }),
    ).resolves.toBeUndefined();
  });

  it('refuses a project-credential admin WITHOUT platform.scope', async () => {
    mocks.getProjectById.mockResolvedValue(project(WRITE));
    const err = await refusal(
      assertCodexBindingAccess({ scope: { kind: 'global' }, userId: CALLER, projectId: 'p1' }),
    );
    expect(err.message).toContain('platform.scope');
  });

  it('400s when no project names where platform.scope is evaluated', async () => {
    const err = await refusal(assertCodexBindingAccess({ scope: { kind: 'global' }, userId: CALLER }));
    expect(err.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// The port members
// ---------------------------------------------------------------------------

const CRED = CODEX_CREDENTIAL_ID;
const APP_ROOT = '/app';

/** A four-scope store backed by one map keyed with the store's own directories. */
function makeStore(seed: Record<string, string> = {}) {
  const disk = new Map(Object.entries(seed));
  const ids: string[] = [];
  const at = (key: string, id: string) => { ids.push(id); return `${key}/${id}`; };
  const store: CodexScopedStore = {
    read: async (scope, id) => disk.get(at(scope, id)),
    readUser: async (userId, id) => disk.get(at(`u_${userId}`, id)),
    readAgent: async (projectId, agentId, id) => disk.get(at(`a_${projectId}/${agentId}`, id)),
    readGlobal: async (id) => disk.get(at('_global', id)),
    write: async (scope, id, value) => { disk.set(at(scope, id), value); },
    writeUser: async (userId, id, value) => { disk.set(at(`u_${userId}`, id), value); },
    writeAgent: async (projectId, agentId, id, value) => { disk.set(at(`a_${projectId}/${agentId}`, id), value); },
    writeGlobal: async (id, value) => { disk.set(at('_global', id), value); },
    delete: async (scope, id) => disk.delete(at(scope, id)),
    deleteUser: async (userId, id) => disk.delete(at(`u_${userId}`, id)),
    deleteAgent: async (projectId, agentId, id) => disk.delete(at(`a_${projectId}/${agentId}`, id)),
    deleteGlobal: async (id) => disk.delete(at('_global', id)),
  };
  return { store, disk, ids };
}

const logger = {
  child: () => logger,
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof createCodexCredentialWriter>[0]['logger'];

function port(seed: Record<string, string> = {}) {
  const { store, disk, ids } = makeStore(seed);
  const audit: Array<{ action: string; userId: string; target?: string; details?: Record<string, unknown> }> = [];
  const lockPaths: string[] = [];
  const released: number[] = [];
  const writer = createCodexCredentialWriter({
    getStore: () => store,
    onAuditEvent: (event) => { audit.push(event); },
    appRoot: APP_ROOT,
    acquireFileMutex: async (lockPath) => {
      lockPaths.push(lockPath);
      return async () => { released.push(lockPaths.length); };
    },
    logger,
  });
  return { writer, disk, ids, audit, lockPaths, released };
}

describe('the binding members re-run the gate before every store touch', () => {
  it('a refused binding writes, reads and deletes NOTHING', async () => {
    mocks.getProjectById.mockResolvedValue(project(['project.credentials']));
    const { writer, disk, ids } = port({ [`p1/${CRED}`]: 'live' });
    const binding = { scope: { kind: 'project' as const, projectId: 'p1' }, userId: CALLER };
    await expect(writer.write(binding, 'x')).rejects.toBeInstanceOf(CodexBindingError);
    await expect(writer.read(binding)).rejects.toBeInstanceOf(CodexBindingError);
    await expect(writer.delete(binding)).rejects.toBeInstanceOf(CodexBindingError);
    expect(ids).toEqual([]);
    expect(disk.get(`p1/${CRED}`)).toBe('live');
  });

  it('PAIRED CONTROL — an allowed binding writes and deletes the EXACT scope only', async () => {
    mocks.getProjectById.mockResolvedValue(project(WRITE));
    const { writer, disk } = port({ [`u_${CALLER}/${CRED}`]: 'user-login' });
    const binding = { scope: { kind: 'project' as const, projectId: 'p1' }, userId: CALLER };
    await writer.write(binding, 'project-login');
    expect(await writer.read(binding)).toBe('project-login');
    expect(await writer.delete(binding)).toBe(true);
    expect(disk.has(`p1/${CRED}`)).toBe(false);
    expect(disk.get(`u_${CALLER}/${CRED}`)).toBe('user-login');
  });

  it('every store call names the ONE Codex credential id — the port takes no id', async () => {
    mocks.getProjectById.mockResolvedValue(project(['platform.scope', ...WRITE]));
    const { writer, ids } = port();
    await writer.write({ scope: { kind: 'global' }, userId: CALLER, projectId: 'p1' }, 'v');
    await writer.status({ userId: CALLER, projectId: 'p1' });
    await writer.refresh.persist({ userId: CALLER }, 'v');
    await writer.refresh.purge({ userId: CALLER });
    expect(ids.length).toBeGreaterThan(4);
    expect(new Set(ids)).toEqual(new Set([CRED]));
  });

  it('status answers an agent bit only for an agent scope the caller may read', async () => {
    mocks.getProjectById.mockResolvedValue(project(WRITE));
    const { writer } = port({ [`a_p1/a-foreign/${CRED}`]: 'blob', [`_global/${CRED}`]: 'g' });
    const status = await writer.status({ userId: CALLER, projectId: 'p1', agentId: 'a-foreign' });
    expect(status).toMatchObject({ agentConnected: false, globalConnected: true, effectiveTarget: 'global' });
    const traversal = await writer.status({ userId: CALLER, projectId: 'p1', agentId: '../users/u-mate' });
    expect(traversal.agentConnected).toBe(false);
    expect(status.agentId).toBeUndefined();
    expect(traversal.agentId).toBeUndefined();
  });

  it('PAIRED CONTROL — an OWNED agent\'s login is reported and wins the cascade', async () => {
    mocks.getProjectById.mockResolvedValue(
      project(WRITE, { agentOwnership: { 'a-1': { createdBy: CALLER, assignedTo: [] } } }),
    );
    const { writer } = port({ [`a_p1/a-1/${CRED}`]: 'blob', [`p1/${CRED}`]: 'p' });
    expect(await writer.status({ userId: CALLER, projectId: 'p1', agentId: 'a-1' })).toMatchObject({
      agentConnected: true,
      projectConnected: true,
      effectiveTarget: 'agent',
      agentId: 'a-1',
    });
  });
});

describe('refresh.persist writes at the tier the cascade RESOLVES', () => {
  it('an agent call whose credential lives at PROJECT scope persists to the project', async () => {
    const { writer, disk } = port({ [`p1/${CRED}`]: 'old' });
    expect(await writer.refresh.persist({ userId: 'u1', projectId: 'p1', agentId: 'a1' }, 'rotated')).toBe(true);
    expect(disk.get(`p1/${CRED}`)).toBe('rotated');
    expect(disk.has(`a_p1/a1/${CRED}`)).toBe(false);
  });

  it('the agent tier wins when it actually holds a value', async () => {
    const { writer, disk } = port({ [`a_p1/a1/${CRED}`]: 'old', [`p1/${CRED}`]: 'other' });
    await writer.refresh.persist({ userId: 'u1', projectId: 'p1', agentId: 'a1' }, 'rotated');
    expect(disk.get(`a_p1/a1/${CRED}`)).toBe('rotated');
    expect(disk.get(`p1/${CRED}`)).toBe('other');
  });

  it('a credential deleted mid-refresh is NOT resurrected (the race guard)', async () => {
    const { writer, disk } = port();
    expect(await writer.refresh.persist({ userId: 'u1', projectId: 'p1' }, 'rotated')).toBe(false);
    expect(disk.size).toBe(0);
  });
});

describe('refresh.purge deletes the resolved tier, and only that one', () => {
  const cases: Array<[string, Record<string, string>, CodexCallScope, string, string[]]> = [
    ['the AGENT blob first, every wider tier kept', { [`a_p1/a1/${CRED}`]: 'a', [`p1/${CRED}`]: 'p', [`u_u1/${CRED}`]: 'u', [`_global/${CRED}`]: 'g' }, { userId: 'u1', projectId: 'p1', agentId: 'a1' }, 'agent', [`p1/${CRED}`, `u_u1/${CRED}`, `_global/${CRED}`]],
    ['never ANOTHER tenant\'s same-slug agent', { [`a_p2/a1/${CRED}`]: 'other', [`p1/${CRED}`]: 'p' }, { userId: 'u1', projectId: 'p1', agentId: 'a1' }, 'project', [`a_p2/a1/${CRED}`]],
    ['the USER blob when the project holds none (the self-heal-never-happens bug)', { [`u_u1/${CRED}`]: 'u' }, { userId: 'u1', projectId: 'p1' }, 'user', []],
    ['all the way to GLOBAL when nothing narrower holds a value', { [`_global/${CRED}`]: 'g' }, { userId: 'u1', projectId: 'p1', agentId: 'a1' }, 'global', []],
  ];
  it.each(cases)('deletes %s', async (_label, seed, scope, tier, survivors) => {
    const { writer, disk, audit } = port(seed);
    await writer.refresh.purge(scope);
    expect([...disk.keys()].sort()).toEqual([...survivors].sort());
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'credential.delete', userId: '__system__', target: CRED });
    expect(audit[0].details).toMatchObject({ source: 'codex-purge', reason: 'refresh_permanent_failure', resolvedTarget: tier, deleted: true });
  });

  it('deletes nothing and audits resolvedTarget:none when no scope has a blob', async () => {
    const { writer, audit } = port();
    await writer.refresh.purge({ userId: 'u1', projectId: 'p1' });
    expect(audit[0].details).toMatchObject({ resolvedTarget: 'none', deleted: false });
  });
});

describe('refresh.lock names the CREDENTIAL, not the caller', () => {
  const lockFor = (scopeDir: string) => join(APP_ROOT, 'credentials', '.locks', scopeDir, `${CRED}.lock`);

  it('two agents of ONE project sharing ONE project credential take ONE lock', async () => {
    const { writer, lockPaths } = port({ [`p1/${CRED}`]: 'blob' });
    await writer.refresh.lock({ userId: 'u1', projectId: 'p1', agentId: 'a1' });
    await writer.refresh.lock({ userId: 'u1', projectId: 'p1', agentId: 'a2' });
    expect(lockPaths).toEqual([lockFor('p1'), lockFor('p1')]);
  });

  it('two members sharing ONE global credential take ONE lock', async () => {
    const { writer, lockPaths } = port({ [`_global/${CRED}`]: 'blob' });
    await writer.refresh.lock({ userId: 'u1', projectId: 'p1' });
    await writer.refresh.lock({ userId: 'u2', projectId: 'p2' });
    expect(new Set(lockPaths)).toEqual(new Set([lockFor(codexLockScope(undefined))]));
  });

  it('PAIRED CONTROL — two DISTINCT credentials take two distinct locks', async () => {
    const { writer, lockPaths } = port({ [`u_u1/${CRED}`]: 'blob-1', [`u_u2/${CRED}`]: 'blob-2' });
    await writer.refresh.lock({ userId: 'u1' });
    await writer.refresh.lock({ userId: 'u2' });
    expect(new Set(lockPaths)).toEqual(
      new Set([lockFor(codexLockScope({ userId: 'u1' })), lockFor(codexLockScope({ userId: 'u2' }))]),
    );
  });

  it('two tenants\' same-slug agent logins are two credentials, so two locks', async () => {
    const { writer, lockPaths } = port({ [`a_p1/coder/${CRED}`]: 'blob-a', [`a_p2/coder/${CRED}`]: 'blob-b' });
    await writer.refresh.lock({ userId: 'u1', projectId: 'p1', agentId: 'coder' });
    await writer.refresh.lock({ userId: 'u2', projectId: 'p2', agentId: 'coder' });
    expect(lockPaths).toEqual([lockFor('agent:p1/coder'), lockFor('agent:p2/coder')]);
  });

  it('with NOTHING stored it falls back to the call scope — a named key, never everyone\'s', async () => {
    const { writer, lockPaths } = port();
    await writer.refresh.lock({ userId: 'u1', projectId: 'p1', agentId: 'a1' });
    expect(lockPaths).toEqual([lockFor(codexLockScope({ userId: 'u1', projectId: 'p1', agentId: 'a1' }))]);
  });

  it('the release is what the lock hands back', async () => {
    const { writer, released } = port({ [`p1/${CRED}`]: 'blob' });
    const release = await writer.refresh.lock({ projectId: 'p1' });
    await release();
    expect(released).toHaveLength(1);
  });

  it('the lock directory is spelled with the store\'s OWN scope constants', () => {
    expect(resolvedLockScope({ tier: 'agent', projectId: 'p1', agentId: 'a1' })).toBe(codexLockScope({ projectId: 'p1', agentId: 'a1' }));
    expect(resolvedLockScope({ tier: 'project', projectId: 'p1' })).toBe(codexLockScope({ projectId: 'p1' }));
    expect(resolvedLockScope({ tier: 'user', userId: 'u1' })).toBe(codexLockScope({ userId: 'u1' }));
    expect(resolvedLockScope({ tier: 'global' })).toBe(codexLockScope(undefined));
  });
});
