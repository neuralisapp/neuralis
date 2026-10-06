/**
 * `resolveSessionContext` is the ONE place a cookie route's raw `x-agent-id`
 * becomes an agent identity: it goes through `resolveVerifiedAgentScope`, and a
 * forged / unknown / inaccessible id yields a session with NO agent — the same
 * answer as an absent header. Routes built on it (app-scope mint, `/api/events`)
 * use `session.agentId` as-is and never re-resolve it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getUserById: vi.fn(),
  listProjectsForUser: vi.fn(),
  getProjectById: vi.fn(),
  resolveVerifiedAgentScope: vi.fn(),
}));

vi.mock('../session', () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock('@/server/store/UserStore', () => ({
  getUserById: mocks.getUserById,
  isActiveUser: (u: { status?: string } | null) => !!u && (u.status ?? 'active') === 'active',
}));
vi.mock('@/server/store/ProjectStore', () => ({
  listProjectsForUser: mocks.listProjectsForUser,
  getProjectById: mocks.getProjectById,
}));
vi.mock('../projectRoleContext', () => ({
  resolveProjectRoleContext: () => ({
    role: 'member',
    priority: 3,
    rolePriorities: { member: 3 },
    grantedFeatures: ['core.execute'],
    agentAccess: 'own',
  }),
}));
vi.mock('../resolveVerifiedAgentScope', () => ({ resolveVerifiedAgentScope: mocks.resolveVerifiedAgentScope }));

import { resolveSessionContext, SessionResolutionError } from '../resolveSessionContext';
import { FileStoreReadError } from '@neuralis/package-system/data';

function req(agentId?: string): NextRequest {
  const headers: Record<string, string> = { 'x-project-id': 'p1' };
  if (agentId) headers['x-agent-id'] = agentId;
  return new NextRequest('http://localhost:3100/api/x', { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionUser.mockResolvedValue({ id: 'u1' });
  mocks.getUserById.mockResolvedValue({ id: 'u1', status: 'active' });
  mocks.listProjectsForUser.mockResolvedValue([{ id: 'p1' }]);
  mocks.getProjectById.mockResolvedValue({ id: 'p1' });
});

describe('resolveSessionContext — the raw agent header is verified once', () => {
  it('a verified header becomes session.agentId', async () => {
    mocks.resolveVerifiedAgentScope.mockResolvedValue('agent-ok');
    const s = await resolveSessionContext(req('agent-ok'), 'p1');
    expect(mocks.resolveVerifiedAgentScope).toHaveBeenCalledTimes(1);
    expect(mocks.resolveVerifiedAgentScope).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1' }), 'agent-ok');
    expect(s.agentId).toBe('agent-ok');
  });

  it('a forged header yields NO agent — identical to an absent one', async () => {
    mocks.resolveVerifiedAgentScope.mockResolvedValue(undefined);
    const forged = await resolveSessionContext(req('agent-forged'), 'p1');
    const absent = await resolveSessionContext(req(), 'p1');
    expect(forged).not.toHaveProperty('agentId');
    expect(forged).toEqual(absent);
  });
});

describe('resolveSessionContext — a user record that cannot be read', () => {
  it('a typed read error answers 403 with a message that carries no path', async () => {
    mocks.getUserById.mockRejectedValueOnce(new FileStoreReadError('unreadable', 'u1', '/home/secret/app/users/u1.json'));
    const err = await resolveSessionContext(req(), 'p1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionResolutionError);
    expect((err as SessionResolutionError).status).toBe(403);
    expect((err as Error).message).not.toContain('/');
  });

  it('PAIRED CONTROL: an unclassified error is not turned into a policy answer — it propagates', async () => {
    const boom = new Error('boom');
    mocks.getUserById.mockRejectedValueOnce(boom);
    await expect(resolveSessionContext(req(), 'p1')).rejects.toBe(boom);
  });
});
