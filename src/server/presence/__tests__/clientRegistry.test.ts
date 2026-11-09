/**
 * The host's in-memory client registry (`server/presence/clientRegistry.ts`).
 *
 * - a hub connection is a client from open to close; a bearer grant stays
 *   "recently active" for the window, and its touches are throttled;
 * - the SAME revocation signal that closes the hub drops the entries — user-wide
 *   or in the revoked project only;
 * - the read projects through the kernel predicate: a non-member's id and an
 *   unknown id get the same empty answer, `platform` needs `platform.users`;
 * - the `members` signal fires on a first-online / last-offline flip only, at
 *   most once per cooldown plus one trailing frame.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SessionContext } from '@neuralis/package-system/contracts';

const appRoot = await mkdtemp(join(tmpdir(), 'nrs-presence-registry-'));
const config: Record<string, unknown> = { presenceActiveWindowMs: 300_000, presenceSignalCooldownMs: 5_000 };

vi.mock('../../config/env', () => ({
  getEnv: () => ({ appRoot, projectsRoot: join(appRoot, 'projects-data') }),
}));
vi.mock('../../store/PlatformConfigStore', () => ({
  getPlatformConfigStore: () => ({ get: (key: string) => config[key] }),
}));

const registry = await import('../clientRegistry');
const revocation = await import('../../host/principalRevocation');

afterAll(async () => {
  await rm(appRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse('2026-10-24T10:00:00.000Z'));
});

afterEach(() => {
  registry.resetPresenceRegistryForTests();
  revocation.resetPrincipalRevocationForTests();
  vi.useRealTimers();
});

function viewer(over: Partial<SessionContext> = {}): SessionContext {
  return { userId: 'u1', projectId: 'p1', agentId: 'a1', grantedFeatures: ['core.agents'], ...over };
}

const members = new Set(['u1', 'u2']);

describe('writers', () => {
  it('a hub connection is online from open to close; a cookie entry leaves with its socket', () => {
    const close = registry.openHubClient({ userId: 'u2', projectId: 'p1', ...registry.cookieClientKind('Mozilla/5.0 Electron/38.0') });
    expect(registry.listPresence(viewer(), { scope: 'project', memberIds: members, userId: 'u2' }))
      .toEqual([{ userId: 'u2', online: true, kinds: ['desktop'] }]);
    close();
    close(); // idempotent
    expect(registry.listPresence(viewer(), { scope: 'project', memberIds: members, userId: 'u2' }))
      .toEqual([{ userId: 'u2', online: false, kinds: [] }]);
  });

  it('the user agent becomes a LABEL only — never stored', () => {
    expect(registry.cookieClientKind('Mozilla/5.0 Chrome/140')).toEqual({ kind: 'web', label: 'Browser' });
    expect(registry.cookieClientKind(null)).toEqual({ kind: 'web', label: 'Browser' });
    registry.openHubClient({ userId: 'u1', projectId: 'p1', ...registry.cookieClientKind('Mozilla/5.0 Chrome/140') });
    const own = registry.listPresence(viewer(), { scope: 'project', memberIds: members, userId: 'u1' })[0];
    expect(JSON.stringify(own)).not.toContain('Chrome');
  });

  it('a bearer touch is active for the window, then ages out; touches inside the throttle write nothing', () => {
    const touch = { userId: 'u2', projectId: 'p1', grantId: 'g1', clientId: 'neuralis-cli', kind: 'cli' as const, label: 'Neuralis CLI' };
    registry.touchClient(touch);
    const self = viewer({ userId: 'u2' });
    const first = registry.listPresence(self, { scope: 'project', memberIds: members, userId: 'u2' })[0]?.clients?.[0];
    vi.advanceTimersByTime(10_000);
    registry.touchClient(touch); // inside the 30 s throttle
    const second = registry.listPresence(self, { scope: 'project', memberIds: members, userId: 'u2' })[0]?.clients?.[0];
    expect(second?.lastActiveAt).toBe(first?.lastActiveAt);
    vi.advanceTimersByTime(25_000);
    registry.touchClient(touch);
    const third = registry.listPresence(self, { scope: 'project', memberIds: members, userId: 'u2' })[0]?.clients?.[0];
    expect(Date.parse(third!.lastActiveAt)).toBeGreaterThan(Date.parse(first!.lastActiveAt));
    vi.advanceTimersByTime(300_001);
    expect(registry.listPresence(self, { scope: 'project', memberIds: members, userId: 'u2' })[0]).toMatchObject({ online: false, kinds: [] });
  });

  it('a bearer hub connection merges with its grant: one client, live while open', () => {
    registry.touchClient({ userId: 'u2', projectId: 'p1', grantId: 'g1', clientId: 'neuralis-cli', kind: 'cli', label: 'Neuralis CLI' });
    const close = registry.openHubClient({ userId: 'u2', projectId: 'p1', kind: 'other', label: 'External client', grantId: 'g1', clientId: 'neuralis-cli' });
    const self = viewer({ userId: 'u2' });
    expect(registry.listPresence(self, { scope: 'project', memberIds: members, userId: 'u2' })[0]?.clients).toEqual([
      expect.objectContaining({ kind: 'cli', label: 'Neuralis CLI', live: true }),
    ]);
    close();
    expect(registry.listPresence(self, { scope: 'project', memberIds: members, userId: 'u2' })[0]?.clients).toEqual([
      expect.objectContaining({ kind: 'cli', live: false }),
    ]);
  });
});

describe('revocation — the same signal that closes the hub', () => {
  it('a project-scoped revocation drops that project only; a user-wide one drops all', async () => {
    registry.openHubClient({ userId: 'u2', projectId: 'p1', kind: 'web', label: 'Browser' });
    registry.touchClient({ userId: 'u2', projectId: 'p2', grantId: 'g2', clientId: 'x', kind: 'mcp', label: 'Unverified client' });
    const admin = viewer({ grantedFeatures: ['platform.users'] });
    await revocation.revokePrincipal({ userId: 'u2', projectId: 'p1', reason: 'membership_removed' }, async () => {});
    expect(registry.listPresence(admin, { scope: 'platform', memberIds: members })[0]?.clients?.map((c) => c.projectId)).toEqual(['p2']);
    await revocation.revokePrincipal({ userId: 'u2', reason: 'disabled' }, async () => {});
    expect(registry.listPresence(admin, { scope: 'platform', memberIds: members })).toEqual([]);
  });
});

describe('read — no existence oracle', () => {
  beforeEach(() => {
    registry.openHubClient({ userId: 'u2', projectId: 'p1', kind: 'web', label: 'Browser' });
    registry.openHubClient({ userId: 'u9', projectId: 'p9', kind: 'web', label: 'Browser' });
  });

  it('a non-member id answers exactly what an unknown id answers', () => {
    const nonMember = registry.listPresence(viewer(), { scope: 'project', memberIds: members, userId: 'u9' });
    const unknown = registry.listPresence(viewer(), { scope: 'project', memberIds: members, userId: 'nobody' });
    expect(nonMember).toEqual([]);
    expect(unknown).toEqual(nonMember);
  });

  it('platform scope without platform.users is empty; with it, every user with a client', () => {
    expect(registry.listPresence(viewer({ grantedFeatures: ['project.members'] }), { scope: 'platform', memberIds: members })).toEqual([]);
    const all = registry.listPresence(viewer({ grantedFeatures: ['platform.users'] }), { scope: 'platform', memberIds: members });
    expect(all.map((u) => u.userId)).toEqual(['u2', 'u9']);
  });

  it('a viewer with no presence feature sees only themselves', () => {
    const rows = registry.listPresence(viewer({ grantedFeatures: ['project.dashboard'] }), { scope: 'project', memberIds: members });
    expect(rows.map((u) => u.userId)).toEqual(['u1']);
  });
});

describe('the members signal', () => {
  it('fires on the first-online and last-offline flip only, at most once per cooldown plus one trailing frame', () => {
    const frames: number[] = [];
    const off = registry.onMembersPresenceChange('p1', () => frames.push(Date.now()));
    const a = registry.openHubClient({ userId: 'u2', projectId: 'p1', kind: 'web', label: 'Browser' });
    expect(frames).toHaveLength(1); // leading edge
    const b = registry.openHubClient({ userId: 'u2', projectId: 'p1', kind: 'web', label: 'Browser' });
    a();
    expect(frames).toHaveLength(1); // a second tab and its close flip nothing
    b();
    expect(frames).toHaveLength(1); // the last close flips — held by the cooldown
    vi.advanceTimersByTime(5_000);
    expect(frames).toHaveLength(2); // one trailing frame
    vi.advanceTimersByTime(5_000);
    expect(frames).toHaveLength(2); // and the cooldown ends without a timer left
    off();
  });
});
