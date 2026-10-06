/**
 * `/api/events` — the `project` channel.
 *
 * Driven by REAL `ProjectStore` writes in a temp appRoot, so the gate under test
 * is the store's own (`onProjectRecordChange`), not a double. The rows: a write
 * to a project the hub's user belongs to reaches it as EXACTLY
 * `{channel:'project', name:'record_changed', payload:{projectId}}` — no member
 * ids, no kind, no name — including a project OTHER than the one the hub is
 * bound to (a rename there must refresh the switcher); a write to a project the
 * user is not a member of sends nothing (paired control).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const appRoot = await mkdtemp(join(tmpdir(), 'nrs-events-project-'));

vi.mock('@/server/config/env', () => ({
  getEnv: () => ({ appRoot, projectsRoot: join(appRoot, 'projects-data') }),
}));
vi.mock('@/server/auth/resolveSessionContext', () => ({
  SessionResolutionError: class extends Error {
    status = 401;
  },
  resolveSessionContext: vi.fn(async () => ({
    userId: 'u1', projectId: 'p1', role: 'member', priority: 20, grantedFeatures: [],
  })),
}));
vi.mock('@/server/host/bootstrap', () => ({
  getRuntime: async () => ({ whenReady: async () => {}, channels: () => [] }),
}));
vi.mock('@/server/packages/runtime', () => ({
  ensureCommunityRuntime: async () => {},
  getCommunityPackageRuntime: () => ({ getRevision: () => 1, onInvalidation: () => () => {} }),
}));
vi.mock('@/server/packages/projectPackages', () => ({ ensureProjectPackagesLoaded: async () => {} }));
vi.mock('@/server/store/PlatformConfigStore', () => ({
  getPlatformConfigStore: () => ({ get: () => 25_000, getRegisteredSetting: () => undefined }),
}));


import { GET } from '../route';
import { updateProject } from '@/server/store/ProjectStore';

const member = (userId: string, role: string) => ({
  userId, name: userId, email: `${userId}@x.co`, role, position: role, tier: role === 'owner' ? 1 : 20, addedAt: 't',
});

async function seed(id: string, memberIds: string[]): Promise<void> {
  const members = Object.fromEntries(
    ['u-owner', ...memberIds].map((u) => [u, member(u, u === 'u-owner' ? 'owner' : 'member')]),
  );
  await writeFile(
    join(appRoot, 'projects', `${id}.json`),
    JSON.stringify({
      id, name: id, ownerId: 'u-owner', members,
      roles: {
        owner: { agents: '*', canInvite: true, canManageRoles: true, grantedFeatures: ['*'], priority: 1 },
        member: { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures: [], priority: 20 },
      },
      agentOwnership: {}, limits: { spend: { projectTotal: null, byRole: {}, byUser: {}, byAgent: {} } },
      roleGrantVersion: 19, createdAt: 't', updatedAt: 't',
    }),
    'utf-8',
  );
}

beforeAll(async () => {
  await mkdir(join(appRoot, 'projects'), { recursive: true });
  await seed('p1', ['u1']);
  await seed('p2', ['u1']);
  await seed('p-foreign', ['u9']);
});

afterAll(async () => {
  await rm(appRoot, { recursive: true, force: true });
});

const cancels: Array<() => void> = [];
afterEach(() => {
  for (const cancel of cancels.splice(0)) cancel();
});

type Frame = { channel: string; name: string; payload: unknown };

async function openHub(): Promise<{ frames: Frame[] }> {
  const res = await GET(new NextRequest('http://localhost/api/events?projectId=p1'));
  const reader = res.body!.getReader();
  cancels.push(() => void reader.cancel());
  const frames: Frame[] = [];
  const decoder = new TextDecoder();
  let buffer = '';
  void (async () => {
    for (;;) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (chunk.done) return;
      buffer += decoder.decode(chunk.value as Uint8Array);
      let cut: number;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const data = block.split('\n').find((line) => line.startsWith('data: '));
        if (data) frames.push(JSON.parse(data.slice(6)) as Frame);
      }
    }
  })();
  await new Promise((r) => setTimeout(r, 10));
  return { frames };
}

const projectFrames = (frames: Frame[]) => frames.filter((f) => f.channel === 'project');

describe('/api/events — the `project` channel', () => {
  it('a write to the bound project reaches the member as exactly the id — nothing else', async () => {
    const hub = await openHub();
    await updateProject('p1', { name: 'Renamed once' });
    await vi.waitFor(() => expect(projectFrames(hub.frames)).toHaveLength(1));
    expect(projectFrames(hub.frames)[0]).toEqual({
      channel: 'project',
      name: 'record_changed',
      payload: { projectId: 'p1' },
    });
  });

  it("a write to ANOTHER of the user's projects reaches the same hub", async () => {
    const hub = await openHub();
    await updateProject('p2', { name: 'Elsewhere' });
    await vi.waitFor(() => expect(projectFrames(hub.frames)).toEqual([
      { channel: 'project', name: 'record_changed', payload: { projectId: 'p2' } },
    ]));
  });

  it('paired control: a write to a project the user is not a member of sends 0 frames', async () => {
    const hub = await openHub();
    await updateProject('p-foreign', { name: 'Not yours' });
    // A member write right after proves the pipe is live, so the 0 is not vacuous.
    await updateProject('p1', { name: 'Proof of life' });
    await vi.waitFor(() => expect(projectFrames(hub.frames)).toHaveLength(1));
    expect(projectFrames(hub.frames).map((f) => (f.payload as { projectId: string }).projectId)).toEqual(['p1']);
  });
});


describe('/api/events — discovered channel coverage', () => {
  it('the client channel union covers the package channel files and host arms exactly', () => {
    const repository = fileURLToPath(new URL('../../../../../..', import.meta.url));
    const packagesRoot = join(repository, 'packages');
    const discovered = readdirSync(packagesRoot).flatMap((directory) => {
      const manifestPath = join(packagesRoot, directory, 'package.json');
      const channelRoot = join(packagesRoot, directory, 'src', 'channels');
      if (!existsSync(manifestPath) || !existsSync(channelRoot)) return [];
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { neuralis?: { referenceOnly?: boolean } };
      if (!manifest.neuralis || manifest.neuralis.referenceOnly) return [];
      return readdirSync(channelRoot).filter((file) => file.endsWith('.ts')).map((file) => file.slice(0, -3));
    });
    expect(discovered).toHaveLength(4);
    const route = readFileSync(join(repository, 'neuralis/src/app/api/events/route.ts'), 'utf-8');
    const hostArms = [...route.matchAll(/send\('([^']+)'/g)].map((match) => match[1]);
    expect(new Set(hostArms).size).toBe(4);
    const client = readFileSync(join(repository, 'neuralis/src/workspace/realtime/eventHub.ts'), 'utf-8');
    const union = client.match(/export type HubChannel = ([^;]+);/)?.[1];
    expect(union).toBeDefined();
    const clientChannels = [...union!.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect([...new Set([...discovered, ...hostArms])].sort()).toEqual(clientChannels.sort());
  });
});
