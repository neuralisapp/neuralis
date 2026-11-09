/**
 * `source-device-v1` on a throwaway home: the operator device is registered in
 * the shape the app's own registry reads (and authenticates with the secret the
 * server already holds), every host source and host shell names it, the CLI's
 * own reader adopts the identity file, the builtin roles the manifests grant
 * `device.own` gain exactly that id — and the owner is one real user or the
 * module stops and asks. Never the live home: every root is a temp dir.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSourceDeviceUpgrade, DEVICE_OWNER_ENV } from '../source-device-v1.mts';
import { runUpgrade, UPGRADES_DIR } from '../../upgrade.mts';
// The app's registry reader and the CLI's identity reader — the two consumers this module writes for.
import { DeviceRegistry } from '../../../../packages/agent-core/src/hostBroker/devices/registry.ts';
import { devicePaths, moveLegacyLayout, moveSingleHostLayout, readPairedHosts } from '../../../../packages/cli/src/device/paths.ts';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const SECRET = 'a'.repeat(20) + 'operator-broker-secret-0123456789';

type Fixture = { home: string; appRoot: string; projectsRoot: string; log: (line: string) => void };

function write(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function role(grantedFeatures: string[], priority: number): Record<string, unknown> {
  return { agents: 'own', canInvite: false, canManageRoles: false, grantedFeatures, priority };
}

/** One project at role-grant revision 19, one unseeded, users u1 (epoch 3) and u2, a host source, a running host shell. */
function home(opts: { secret?: boolean; creators?: string[] } = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'nrs-source-device-'));
  dirs.push(root);
  const appRoot = join(root, 'app');
  const projectsRoot = join(root, 'projects');
  write(join(appRoot, 'users', 'u1.json'), { id: 'u1', email: 'a@x', status: 'active', sessionEpoch: 3 });
  write(join(appRoot, 'users', 'u2.json'), { id: 'u2', email: 'b@x', status: 'active' });
  write(join(appRoot, 'projects', 'main.json'), {
    id: 'main',
    roleGrantVersion: 19,
    formatVersion: 2,
    roles: {
      owner: role(['*'], 1),
      admin: role(['core.agents', 'exec.host'], 2),
      manager: role(['core.agents'], 10),
      member: role(['core.agents'], 20),
      viewer: role(['core.agents'], 30),
      'ops-reviewer': role(['core.agents'], 15),
    },
  });
  write(join(appRoot, 'projects', 'fresh.json'), { id: 'fresh', roles: {} });
  for (const [i, creator] of (opts.creators ?? ['u1']).entries()) {
    write(join(appRoot, 'config', 'sources', 'main', `host-${i}.json`), {
      source: `host-${i}`, scope: { kind: 'project' }, connection: { kind: 'host', config: { root: '/home/op' } },
      permissions: { default: { read: true, write: false, exec: false } }, createdBy: creator, formatVersion: 2,
    });
  }
  write(join(appRoot, 'config', 'sources', 'main', 'notes.json'), {
    source: 'notes', scope: { kind: 'project' }, connection: { kind: 'local', config: { root: '/mounts/notes' } }, createdBy: 'u1',
  });
  write(join(projectsRoot, 'main', 'data', 'agent-core', 'a1', 'conversations', 'c1', 'shells', 's1', 'meta.json'), {
    id: 's1', shellId: 's1', plane: 'host', status: 'running', remoteRunId: 'r1',
  });
  write(join(projectsRoot, 'main', 'data', 'agent-core', 'a1', 'conversations', 'c1', 'shells', 's2', 'meta.json'), {
    id: 's2', shellId: 's2', status: 'exited',
  });
  if (opts.secret !== false) write(join(root, 'host-broker', 'secret'), `${SECRET}\n`);
  return { home: root, appRoot, projectsRoot, log: () => {} };
}

function files(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full); else out.set(full, readFileSync(full, 'utf8'));
    }
  };
  walk(root);
  return out;
}

const json = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

describe("source-device-v1 — the server's host access onto paired devices", () => {
  it('dry run names every file and writes nothing; apply registers, stamps, raises; a re-run writes nothing', async () => {
    const f = home();
    const upgrade = createSourceDeviceUpgrade({});
    const before = files(f.home);
    const plan = await upgrade.dryRun(f);
    expect(plan.blockers).toBeUndefined();
    expect([...plan.files].sort()).toEqual([
      'app/config/sources/main/host-0.json',
      'app/data/agent-core/devices',
      'app/projects/main.json',
      'device/device.json',
      'projects/main/data/agent-core/a1/conversations/c1/shells/s1/meta.json',
    ]);
    expect(files(f.home)).toEqual(before);

    await upgrade.apply(f);
    const registry = new DeviceRegistry(join(f.appRoot, 'data', 'agent-core'));
    expect(await registry.load()).toEqual({ count: 1, skipped: 0 });
    const [device] = registry.all();
    // The app's own handshake accepts the secret the server's broker already holds.
    expect(registry.authenticate(device!.id, SECRET)).toMatchObject({ id: device!.id, ownerUserId: 'u1', pairedEpoch: 3 });
    expect(JSON.stringify(device)).not.toContain(SECRET);
    expect((json(join(f.appRoot, 'config', 'sources', 'main', 'host-0.json')).connection as { config: unknown }).config).toEqual({ root: '/home/op', device: device!.id });
    expect(json(join(f.appRoot, 'config', 'sources', 'main', 'notes.json')).connection).toEqual({ kind: 'local', config: { root: '/mounts/notes' } });
    expect(json(join(f.projectsRoot, 'main', 'data', 'agent-core', 'a1', 'conversations', 'c1', 'shells', 's1', 'meta.json')).device).toBe(device!.id);
    expect(json(join(f.projectsRoot, 'main', 'data', 'agent-core', 'a1', 'conversations', 'c1', 'shells', 's2', 'meta.json')).device).toBeUndefined();

    // The CLI adopts the identity — `neuralis device install`'s two moves, then its reader: it links without pairing.
    const paths = devicePaths({ NEURALIS_HOME: f.home }, '/nowhere', 'linux');
    moveLegacyLayout(paths);
    moveSingleHostLayout(paths, 'linux');
    expect(readPairedHosts(paths).hosts.map((h) => h.device)).toEqual([{ host: expect.any(String), link: 'ws://127.0.0.1:3101/ws/device-link', deviceId: device!.id, name: 'Neuralis server' }]);

    const project = json(join(f.appRoot, 'projects', 'main.json'));
    expect(project).toMatchObject({ roleGrantVersion: 20, formatVersion: 3 });
    const roles = project.roles as Record<string, { grantedFeatures: string[] }>;
    for (const name of ['admin', 'manager', 'member']) expect(roles[name]!.grantedFeatures, name).toContain('device.own');
    // Only the builtin roles the manifests grant it; '*' already holds it; nothing else is re-added.
    expect(roles.viewer!.grantedFeatures).toEqual(['core.agents']);
    expect(roles['ops-reviewer']!.grantedFeatures).toEqual(['core.agents']);
    expect(roles.owner!.grantedFeatures).toEqual(['*']);
    expect(roles.admin!.grantedFeatures).toEqual(['core.agents', 'exec.host', 'device.own']);
    expect(json(join(f.appRoot, 'projects', 'fresh.json'))).toEqual({ id: 'fresh', roles: {} });

    const done = files(f.home);
    expect((await upgrade.dryRun(f)).files).toEqual([]);
    await upgrade.apply(f);
    expect(files(f.home)).toEqual(done);
  });

  it('the owner is the ONE real user the host sources name — several, none or the `operator` literal stop and ask', async () => {
    const two = home({ creators: ['u1', 'u2'] });
    const plan = await createSourceDeviceUpgrade({}).dryRun(two);
    expect(plan.blockers?.lines.join('\n')).toMatch(/name 2 users \(u1, u2\).*NEURALIS_DEVICE_OWNER=<userId>/);
    await expect(createSourceDeviceUpgrade({}).apply(two)).rejects.toThrow(/name 2 users/);
    expect(readdirSync(two.appRoot)).not.toContain('data');

    const literal = home({ creators: ['operator'] });
    expect((await createSourceDeviceUpgrade({}).dryRun(literal)).blockers?.lines.join('\n'))
      .toMatch(/no user of this install and the `operator` literal, which is never an owner/);
    expect((await createSourceDeviceUpgrade({ [DEVICE_OWNER_ENV]: 'operator' }).dryRun(literal)).blockers?.lines.join('\n'))
      .toMatch(/NEURALIS_DEVICE_OWNER=operator · owner · names no user/);

    // PAIRED CONTROL — the same installs with the owner named.
    const named = createSourceDeviceUpgrade({ [DEVICE_OWNER_ENV]: 'u2' });
    expect((await named.dryRun(two)).blockers).toBeUndefined();
    await named.apply(two);
    const registry = new DeviceRegistry(join(two.appRoot, 'data', 'agent-core'));
    await registry.load();
    expect(registry.all().map((d) => [d.ownerUserId, (d as { pairedEpoch?: number }).pairedEpoch])).toEqual([['u2', 0]]);
  });

  it('no broker secret: no registry row, no identity file; a host source that needs the device blocks by name', async () => {
    const bare = home({ secret: false, creators: [] });
    rmSync(join(bare.projectsRoot, 'main', 'data', 'agent-core', 'a1', 'conversations', 'c1', 'shells', 's1'), { recursive: true });
    const plan = await createSourceDeviceUpgrade({}).dryRun(bare);
    expect(plan.blockers).toBeUndefined();
    await createSourceDeviceUpgrade({}).apply(bare);
    expect(readdirSync(bare.appRoot)).not.toContain('data');
    expect(readdirSync(bare.home)).not.toContain('device');

    const stranded = home({ secret: false });
    expect((await createSourceDeviceUpgrade({}).dryRun(stranded)).blockers?.lines).toEqual([
      expect.stringMatching(/^main · host source · app\/config\/sources\/main\/host-0\.json · connection\.config\.device · no operator device/),
      expect.stringMatching(/^main · host shell · .*shells\/s1\/meta\.json · device · no operator device/),
    ]);
  });

  it('a running app refuses before any module runs', async () => {
    const f = home();
    const before = files(f.home);
    await expect(runUpgrade({ apply: true, modulesDir: UPGRADES_DIR, roots: f, offline: async () => ({ offline: false, reason: 'the app answers' }), log: () => {}, appRuns: 'docker' }))
      .rejects.toThrow(/Refusing to upgrade: the app answers/);
    expect(files(f.home)).toEqual(before);
  });
});
