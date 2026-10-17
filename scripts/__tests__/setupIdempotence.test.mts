/**
 * The setup wizard's re-run contract.
 *
 * Every rule here exists because the wizard broke it on a real install: a
 * second `pnpm neuralis:setup` used to delete 14 admin-set platform keys,
 * rotate the session secret and the MCP API key behind a default-yes prompt,
 * rewrite all three source configs over the admin's edits, and — when answered
 * with a different project name — write a whole orphan tree.
 *
 * These assert the extracted modules directly; the wizard's `run` is driven
 * in process only for the image channel's `--compose-only` and its refusals,
 * which write or refuse before any prompt.
 */

import { describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mergePlatformConfig, readPlatformConfig, writeMergedPlatformConfig } from '../setup/platformConfig.mts';
import {
  buildProjectRecord,
  buildSourceConfigSeeds,
  findOrphanSourceConfigDirs,
  listExistingProjects,
  resolveSetupProjectId,
  type ExistingProject,
  writeSourceConfigsPreserving,
} from '../setup/records.mts';
import { projectIdFromName } from '../../src/lib/utils';
import {
  answeringQdrant, bindMountOf, busyPortRefusal, detectDocker, dockerRunProbe, findBusyPorts, listenProbe, listPublishedPorts, nextFreePorts, portClaims, qdrantOwnership, resolveConfigDir, resolveHostHome, setupRefusal,
  type AsyncProgramRunner, type PortClaim, type PortProbe, type PublishedPort,
} from '../setup/detect.mts';
import { run as runSetup } from '../setup.mts';
import { imageSetupCommand } from '../cli/spelling.mts';
import { CliExit, type CliContext } from '../cli/registry.mts';
import { DOCKER_SETUP_COMMAND } from '../../src/server/setupRequiredPage';
import {
  buildOriginLines,
  carryOverEnv,
  codexLoopbackQuestion,
  hostQdrantUrl,
  imageTagLines,
  initialImageTag,
  isLoopbackPublicOrigin,
  normalizePublicOrigin,
  normalizeTrustedProxies,
  originDefault,
  parseEnvContent,
  resolveImageTag,
  resolveQdrantApiKey,
  trustedProxiesLines,
} from '../setup/envFile.mts';
import { parseComposeLs, resolveComposeProject, sanitizeComposeProject } from '../setup/composeProject.mts';
import type { SetupConfig } from '../setup/types.mts';

const HERE = dirname(fileURLToPath(import.meta.url));

// Whether `/.dockerenv` exists is the one container signal (`installLayout`,
// `resolveConfigDir`, `resolveHostHome`); a row turns it on, every other read
// passes through. In a container row the mount table carries `binds` — the
// folders the row's `docker run` would have bound from the host.
const container = vi.hoisted(() => ({ value: false, binds: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: (path: import('node:fs').PathLike) => (path === '/.dockerenv' ? container.value : actual.existsSync(path)) };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const mountinfo = () => ['1 0 0:1 / / rw - overlay overlay rw', ...container.binds.map((dir, i) => `${i + 2} 1 8:1 ${dir} ${dir} rw - ext4 /dev/sdc rw`)].join('\n');
  const readFile = ((path: unknown, ...rest: unknown[]) =>
    (path === '/proc/self/mountinfo' && container.value ? Promise.resolve(mountinfo()) : (actual.readFile as (...a: unknown[]) => unknown)(path, ...rest))) as typeof actual.readFile;
  return { ...actual, readFile, default: { ...actual, readFile } };
});

/** Ports nothing on this machine holds now: a port check must find them free wherever the suite runs. */
async function freePorts(n: number): Promise<number[]> {
  const servers = await Promise.all(Array.from({ length: n }, () => new Promise<ReturnType<typeof createServer>>((ready) => { const s = createServer(); s.listen(0, '0.0.0.0', () => ready(s)); })));
  const ports = servers.map((s) => (s.address() as AddressInfo).port);
  await Promise.all(servers.map((s) => new Promise((closed) => s.close(closed))));
  return ports;
}

function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'neuralis-setup-'));
  mkdirSync(join(home, 'app', 'projects'), { recursive: true });
  mkdirSync(join(home, 'app', 'config', 'sources'), { recursive: true });
  return home;
}

describe('deployment config placement follows the install layout', () => {
  const neuralisHome = '/data/neuralis';
  /** An install root: the image's own tree (nothing), a clone (`.git`) or an npm folder (depends on neuralis). */
  const root = (kind: 'image' | 'clone' | 'folder'): string => {
    const dir = mkdtempSync(join(tmpdir(), `neuralis-layout-${kind}-`));
    if (kind === 'clone') mkdirSync(join(dir, '.git'));
    if (kind === 'folder') writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { neuralis: '0.3.1' } }));
    return dir;
  };

  it('on the host every layout keeps .env beside the app, where `next start` loads it', () => {
    for (const kind of ['image', 'clone', 'folder'] as const) {
      const projectRoot = root(kind);
      expect(resolveConfigDir({ projectRoot, neuralisHome }, null, false), kind).toBe(projectRoot);
    }
    const checkout = join(HERE, '..', '..');
    expect(resolveConfigDir({ projectRoot: checkout, neuralisHome }, null, true)).toBe(checkout);
  });
  it('only the image\'s own tree keeps config on its persistent data mount', () => {
    expect(resolveConfigDir({ projectRoot: root('image'), neuralisHome }, null, true)).toBe(neuralisHome);
  });
  it('a clone or an npm folder inside a container (devcontainer, CI) keeps its own folder', () => {
    for (const kind of ['clone', 'folder'] as const) {
      const projectRoot = root(kind);
      expect(resolveConfigDir({ projectRoot, neuralisHome }, null, true), kind).toBe(projectRoot);
    }
  });
  it('honors an explicit export directory in both environments', () => {
    const projectRoot = root('image');
    expect(resolveConfigDir({ projectRoot, neuralisHome }, '/export', false)).toBe('/export');
    expect(resolveConfigDir({ projectRoot, neuralisHome }, '/export', true)).toBe('/export');
  });
});

describe('Docker detection: ONE `docker info`, without a shell, with its cause', () => {
  const ok = (stdout: string) => ({ stdout, stderr: '', status: 0, error: null });
  const PLUGINS = '[{"Name":"buildx","Version":"v0.20.0"},{"Name":"compose","Version":"v2.40.0"}]';

  it('asks the plugins and the server version in one plain-argv call — no redirect a cmd.exe would misread', () => {
    const calls: Array<[string, string[]]> = [];
    const found = detectDocker((file, args) => { calls.push([file, args]); return ok(`${PLUGINS}|29.7.2\n`); });
    expect(found).toEqual({ available: true, version: '29.7.2', cause: null, compose: true });
    expect(calls).toEqual([['docker', ['info', '--format', '{{json .ClientInfo.Plugins}}|{{.ServerVersion}}']]]);
  });

  it('names the cause: no CLI, a daemon that does not answer, a socket this user may not open — and Compose from the client side', () => {
    const enoent = Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' });
    expect(detectDocker(() => ({ stdout: '', stderr: '', status: null, error: enoent }))).toEqual({ available: false, version: null, cause: 'missing', compose: false });
    const down = { stdout: `${PLUGINS}|\n`, stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n', status: 0, error: null };
    expect(detectDocker(() => down)).toEqual({ available: false, version: null, cause: 'daemon', compose: true });
    const denied = { stdout: '[]|\n', stderr: 'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock\n', status: 1, error: null };
    expect(detectDocker(() => denied)).toEqual({ available: false, version: null, cause: 'permission', compose: false });
    // A daemon without the Compose plugin answers; Compose is false, Docker is available.
    expect(detectDocker(() => ok('[{"Name":"buildx"},{"Name":"compose","Err":"not a valid plugin"}]|29.7.2'))).toEqual({ available: true, version: '29.7.2', cause: null, compose: false });
    // An older CLI that refuses the template outright: no daemon proven, no Compose proven.
    expect(detectDocker(() => ({ stdout: '', stderr: 'Cannot connect', status: 1, error: null }))).toEqual({ available: false, version: null, cause: 'daemon', compose: false });
  });

  it.skipIf(process.platform === 'win32')('finds a real `docker` program on PATH; a missing one and a refused socket are the paired controls', () => {
    const bin = mkdtempSync(join(tmpdir(), 'neuralis-fake-docker-'));
    const path = process.env.PATH;
    const fake = (body: string) => writeFileSync(join(bin, 'docker'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    try {
      process.env.PATH = `${bin}:${path}`;
      fake(`echo '${PLUGINS}|29.7.2'`);
      expect(detectDocker()).toEqual({ available: true, version: '29.7.2', cause: null, compose: true });
      fake(`echo '${PLUGINS}|'; echo 'permission denied while trying to connect' >&2`);
      expect(detectDocker()).toMatchObject({ available: false, cause: 'permission', compose: true });
      process.env.PATH = mkdtempSync(join(tmpdir(), 'neuralis-no-docker-'));
      expect(detectDocker()).toMatchObject({ available: false, cause: 'missing' });
    } finally {
      process.env.PATH = path;
    }
  });
});

describe('the install folder lies on a bind from the host', () => {
  const MOUNTINFO = [
    '617 548 0:52 / / rw,relatime master:303 - overlay overlay rw,lowerdir=/x',
    '620 617 8:32 /home/op/.neuralis /.neuralis rw,relatime - ext4 /dev/sdc rw',
    '621 617 8:32 /home/op/my\\040neuralis /home/op/my\\040neuralis rw,relatime - ext4 /dev/sdc rw',
    '622 617 8:32 /var/lib/docker/containers/abc/hostname /etc/hostname rw - ext4 /dev/sdc rw',
  ].join('\n');

  it('the longest mount point that covers the folder; the container root is no bind', () => {
    expect(bindMountOf('/home/op/my neuralis', MOUNTINFO)).toBe('/home/op/my neuralis');
    expect(bindMountOf('/home/op/my neuralis/sub', MOUNTINFO)).toBe('/home/op/my neuralis');
    expect(bindMountOf('/.neuralis', MOUNTINFO)).toBe('/.neuralis');
    expect(bindMountOf('/home/op/neuralis', MOUNTINFO)).toBeNull();
    expect(bindMountOf('/etc/hostnames', MOUNTINFO)).toBeNull();
    expect(bindMountOf('/anything', '')).toBeNull();
  });
});

describe('platform.json is merged, never replaced', () => {
  it('keeps every existing key and adds only what is missing', () => {
    const existing = { maxAgentSteps: 500, hostBrokerEnabled: true, packageLogLevel: 'debug' };
    const seed = { maxAgentSteps: 40, embeddingModelId: 'text-embedding-3-small' };
    const { merged, kept, added } = mergePlatformConfig(existing, seed);

    expect(merged.maxAgentSteps).toBe(500);
    expect(merged.hostBrokerEnabled).toBe(true);
    expect(merged.packageLogLevel).toBe('debug');
    expect(merged.embeddingModelId).toBe('text-embedding-3-small');
    expect(kept).toEqual(['maxAgentSteps']);
    expect(added).toEqual(['embeddingModelId']);
  });

  it('a re-run over a populated file loses nothing', async () => {
    const home = scratchHome();
    const admin = {
      hostBrokerEnabled: true,
      maxAgentSteps: 500,
      maxProjects: 3,
      summarizerTimeoutMs: 90_000,
      packageLogLevel: 'debug',
      machineImage: 'private.example/admin-desktop:v7',
      machineDesktopVariant: 'admin-special',
    };
    mkdirSync(join(home, 'app', 'config'), { recursive: true });
    writeFileSync(join(home, 'app', 'config', 'platform.json'), JSON.stringify(admin, null, 2));

    await writeMergedPlatformConfig(home, {
      embeddingModelId: 'nomic-embed-text',
      embeddingDimension: 768,
      machineDesktopVariant: 'ubuntu-xfce',
      machineImage: 'neuralisapp/webtop-ubuntu-xfce:dev',
    });

    const after = await readPlatformConfig(home);
    for (const [key, value] of Object.entries(admin)) expect(after[key], key).toEqual(value);
    expect(after.embeddingModelId).toBe('nomic-embed-text');
  });

  it('does not seed package-declared tunables (the store resolves those itself)', async () => {
    const home = scratchHome();
    await writeMergedPlatformConfig(home, { embeddingModelId: 'm', embeddingDimension: 3 });
    const written = await readPlatformConfig(home);
    // The old seed pinned maxAgentSteps: 40 — BELOW the declared default of
    // 100 — which acted as a hard ceiling on every agent of every new install.
    expect(written).not.toHaveProperty('maxAgentSteps');
    expect(written).not.toHaveProperty('defaultTemperature');
    expect(written).not.toHaveProperty('maxProjects');
  });
});

describe('source configs are preserved, and the seed matches the canonical builder', () => {
  it('never overwrites an existing config file', async () => {
    const home = scratchHome();
    const sourcesDir = join(home, 'app', 'config', 'sources', 'acme');
    mkdirSync(sourcesDir, { recursive: true });
    const edited = JSON.stringify({ source: 'packages', permissions: { default: { read: true, write: false, exec: false } } });
    writeFileSync(join(sourcesDir, 'packages.json'), edited);
    const ownData = JSON.stringify({ source: 'data', permissions: { default: { read: true, write: false, exec: false } } });
    writeFileSync(join(sourcesDir, 'data.json'), ownData);

    const result = await writeSourceConfigsPreserving(home, 'acme', 'user-1');

    expect(readFileSync(join(sourcesDir, 'packages.json'), 'utf-8')).toBe(edited);
    expect(readFileSync(join(sourcesDir, 'data.json'), 'utf-8')).toBe(ownData);
    expect(result.preserved).toEqual(['packages']);
    expect(result.written).toEqual(['brain']);
  });

  it('never seeds data:// — brain-core creates it on the first boot, with the registry-derived seed', async () => {
    // A fresh project is still never sourceless before that boot: `packages`
    // and `brain` are on disk. The first-boot half is pinned end to end in
    // brain-core `test/services/freshInstallFirstBoot.test.ts`.
    const home = scratchHome();
    const result = await writeSourceConfigsPreserving(home, 'fresh', 'user-1');
    expect(result.written.sort()).toEqual(['brain', 'packages']);
    expect(existsSync(join(home, 'app', 'config', 'sources', 'fresh', 'data.json'))).toBe(false);
    expect(buildSourceConfigSeeds({ projectId: 'fresh', createdBy: 'u', isDocker: false }).map((s) => s.source))
      .not.toContain('data');
  });

  it('matches brain-core\'s declared sources on every field except the kept path rows', () => {
    // The port exists because scripts cannot import from a package AT RUNTIME
    // (the wizard runs before any image or install). A TEST has no such
    // constraint — and a "drift test" that only checks shapes is the trap that
    // let seven fields drift in the first place, one of them the exec bit that
    // silently denied every member-agent shell. So this compares the port with
    // the declaration a new project is seeded from, field by field.
    type Decl = {
      source: string;
      kind: string;
      root?: string;
      scope: string;
      description: string;
      permissions: Record<string, unknown>;
      sync?: Record<string, unknown>;
    };
    const manifest = JSON.parse(
      readFileSync(join(HERE, '..', '..', 'node_modules', '@neuralis', 'brain-core', 'package.json'), 'utf-8'),
    ) as { neuralis: { sources: Decl[] } };
    const now = '2026-01-01T00:00:00.000Z';
    const ported = buildSourceConfigSeeds({ projectId: 'acme', createdBy: 'u', now, isDocker: false });

    expect(ported.map((s) => s.source)).toEqual(['packages', 'brain']);

    for (const port of ported) {
      const decl = manifest.neuralis.sources.find((d) => d.source === port.source) as Decl;
      const label = port.source;
      expect(decl, `${label}: declared`).toBeTruthy();
      // `permissions.paths` is the ONE deliberate divergence (`PACKAGES_PATHS`);
      // the boot-time baseline repair unions the manifest rows in either way.
      const { paths: portPaths, ...portPerms } = port.permissions as Record<string, unknown>;
      const { paths: declPaths, ...declPerms } = decl.permissions;
      expect(portPerms, `${label}: permissions (excluding paths)`).toEqual(declPerms);
      expect(Array.isArray(portPaths), `${label}: paths is an array`).toBe(true);
      expect(Array.isArray(declPaths), `${label}: declared paths is an array`).toBe(true);

      expect(port.scope, `${label}: scope`).toEqual({ kind: decl.scope });
      expect(port.connection, `${label}: connection`).toEqual(
        decl.kind === 'local' ? { kind: 'local', config: { root: decl.root } } : { kind: decl.kind, config: {} },
      );
      expect(port.description, `${label}: description`).toBe(decl.description);
      expect(port.sync, `${label}: sync`).toEqual(decl.sync);
      expect([port.createdAt, port.updatedAt, port.createdBy], `${label}: provenance`).toEqual([now, now, 'u']);
    }
  });
});

describe('the project record is minimal and heals to the canonical roles', () => {
  const config = {
    projectId: 'acme',
    projectName: 'Acme',
    owner: { email: 'o@example.com', name: 'Owner', passwordHash: 'x' },
  } as unknown as SetupConfig;

  it('writes an EMPTY role map, not a hand-copied one', () => {
    const record = buildProjectRecord(config, 'user-1', '2026-01-01T00:00:00.000Z');
    // A hand-written map drifted into granting admin the '*' wildcard the
    // platform deliberately removed. The migration seeds the canonical roles
    // from the manifests on first read; an empty map is what it expects.
    expect(record.roles).toEqual({});
    expect(record).not.toHaveProperty('roleGrantVersion');
    expect(record).not.toHaveProperty('agentOwnership');
    expect(record).not.toHaveProperty('limits');
  });

  it('keeps `roles` present so raw readers can dereference it', () => {
    const record = buildProjectRecord(config, 'user-1');
    expect(Object.prototype.hasOwnProperty.call(record, 'roles')).toBe(true);
  });

  it('records the owner as a member with the owner role', () => {
    const record = buildProjectRecord(config, 'user-1');
    expect(record.ownerId).toBe('user-1');
    expect(record.members['user-1'].role).toBe('owner');
  });

  it('ACTUALLY heals: the migration seeds the canonical roles from the minimal record', async () => {
    // The block above only asserts what setup WRITES. The property that makes
    // writing an empty map safe is what the migration DOES with it — so run the
    // real migration, not a description of it.
    const { migrateProjectRecord } = await import('../../src/server/store/ProjectStore');
    const { DEFAULT_ROLES } = await import('../../src/server/store/projectTypes');

    const written = buildProjectRecord(config, 'user-1', '2026-01-01T00:00:00.000Z');
    const healed = migrateProjectRecord(JSON.parse(JSON.stringify(written))) as any;

    expect(healed.roleGrantVersion).toBeGreaterThan(0);
    expect(Object.keys(healed.roles).sort()).toEqual(Object.keys(DEFAULT_ROLES).sort());
    // Grants heal as a SET: a 1:N rename row inserts each successor beside the
    // id it derives from (v19 puts `exec.container` next to `core.execute`),
    // while the seeded catalog is sorted — same capability, different position.
    // Sorting still catches a missing id and a duplicate, which is the claim.
    const sortGrants = (r: any) => ({ ...r, grantedFeatures: [...r.grantedFeatures].sort() });
    for (const [name, definition] of Object.entries(DEFAULT_ROLES as Record<string, any>)) {
      expect(sortGrants(healed.roles[name]), `${name} heals to the canonical definition`)
        .toEqual(sortGrants(definition));
    }
    // Replay is idempotent — a second pass must not add, remove or reorder.
    const twice = migrateProjectRecord(JSON.parse(JSON.stringify(healed)));
    expect(twice).toEqual(healed);
  });
});

describe('orphan detection reports, never deletes', () => {
  it('lists source-config dirs with no project record', async () => {
    const home = scratchHome();
    writeFileSync(
      join(home, 'app', 'projects', 'real.json'),
      JSON.stringify({ id: 'real', name: 'Real', ownerId: 'u' }),
    );
    mkdirSync(join(home, 'app', 'config', 'sources', 'real'), { recursive: true });
    mkdirSync(join(home, 'app', 'config', 'sources', 'ghost'), { recursive: true });

    expect(await findOrphanSourceConfigDirs(home)).toEqual(['ghost']);
    expect((await listExistingProjects(home)).map((p) => p.id)).toEqual(['real']);
  });
});

describe('the project a re-run maintains — never re-derived from its name', () => {
  const rec = (id: string, name: string, over: Partial<ExistingProject> = {}): ExistingProject => ({
    id, name, ownerId: `owner-of-${id}`, archivedAt: null, ...over,
  });

  it('a project renamed in the app is maintained under its STORED id and owner when its new name is answered', () => {
    const res = resolveSetupProjectId({
      existingSetup: true,
      projects: [rec('my-workspace', 'Átnevezett')],
      answer: 'Átnevezett',
    });
    // The slug of the new name is `atnevezett`; the id must stay the birth id.
    expect(res).toEqual({ ok: true, projectId: 'my-workspace', projectName: 'Átnevezett', ownerUserId: 'owner-of-my-workspace' });
  });

  it('the id answers too, and wins over a name another record carries', () => {
    const res = resolveSetupProjectId({
      existingSetup: true,
      projects: [rec('alpha', 'beta'), rec('beta', 'Beta Team')],
      answer: 'beta',
    });
    expect(res).toMatchObject({ ok: true, projectId: 'beta' });
  });

  it('a name two active records share is refused, naming both ids', () => {
    const res = resolveSetupProjectId({
      existingSetup: true,
      projects: [rec('dup', 'Same'), rec('dup-2', 'Same')],
      answer: 'Same',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('dup, dup-2');
  });

  it('an archived record is skipped — its name no longer answers, and it is never the default', () => {
    const projects = [rec('old', 'Shared', { archivedAt: '2026-09-01T00:00:00.000Z' }), rec('live', 'Shared')];
    expect(resolveSetupProjectId({ existingSetup: true, projects, answer: 'Shared' })).toMatchObject({ ok: true, projectId: 'live' });
    expect(resolveSetupProjectId({ existingSetup: true, projects, answer: 'old' }).ok).toBe(false);
  });

  it('a record with no owner is refused — never a minted owner id', () => {
    const res = resolveSetupProjectId({ existingSetup: true, projects: [rec('p', 'P', { ownerId: null })], answer: 'P' });
    expect(res.ok).toBe(false);
  });

  it('users but no active project record is refused — setup never mints a second tenant', () => {
    // Named for what it is (create the project from the app), not as a wrong answer.
    const none = resolveSetupProjectId({ existingSetup: true, projects: [], answer: 'Anything' });
    expect(none).toEqual({ ok: false, reason: expect.stringContaining('no active project record') });
    const allArchived = resolveSetupProjectId({
      existingSetup: true,
      projects: [rec('gone', 'G', { archivedAt: 't' })],
      answer: 'G',
    });
    expect(allArchived).toEqual({ ok: false, reason: expect.stringContaining('no active project record') });
  });

  it('an answer no record carries is refused', () => {
    expect(resolveSetupProjectId({ existingSetup: true, projects: [rec('p', 'P')], answer: 'Other' }).ok).toBe(false);
  });

  it('a FRESH install mints through the app\'s ONE derivation', () => {
    expect(resolveSetupProjectId({ existingSetup: false, projects: [], answer: 'Ügyfél teszt' })).toEqual({
      ok: true, projectId: 'ugyfel-teszt', projectName: 'Ügyfél teszt', ownerUserId: null,
    });
    expect(projectIdFromName('日本')).toBe('project');
    expect(resolveSetupProjectId({ existingSetup: false, projects: [], answer: '日本' })).toMatchObject({ projectId: 'project' });
  });

  it('listExistingProjects carries archivedAt and a normalized owner', async () => {
    const home = scratchHome();
    writeFileSync(
      join(home, 'app', 'projects', 'a.json'),
      JSON.stringify({ id: 'a', name: 'A', ownerId: 'u', archivedAt: '2026-09-01T00:00:00.000Z' }),
    );
    writeFileSync(join(home, 'app', 'projects', 'b.json'), JSON.stringify({ id: 'b', name: 'B', ownerId: '  ' }));
    const listed = (await listExistingProjects(home)).sort((x, y) => x.id.localeCompare(y.id));
    expect(listed).toEqual([
      { id: 'a', name: 'A', ownerId: 'u', archivedAt: '2026-09-01T00:00:00.000Z' },
      { id: 'b', name: 'B', ownerId: null, archivedAt: null },
    ]);
  });
});

describe('.env read-back', () => {
  it('carries over the origin, ports, secret and compose project', () => {
    const carried = carryOverEnv(
      parseEnvContent(
        [
          'NEXTAUTH_URL="http://192.168.1.20:3100"',
          'NEURALIS_APP_PORT=3100',
          'MCP_HTTP_PORT=3111',
          'NEXTAUTH_SECRET=keep-me',
          'NEURALIS_COMPOSE_PROJECT=neuralis-lab',
          'QDRANT_MODE=docker',
        ].join('\n'),
      ),
    );
    // Quotes stripped: two parsers existed and one kept them, which put literal
    // quote characters inside URLs.
    expect(carried.publicOrigin).toBe('http://192.168.1.20:3100');
    expect(carried.ports).toEqual({ app: 3100, mcp: 3111, sandbox: 3102 });
    expect(carried.nextAuthSecret).toBe('keep-me');
    expect(carried.composeProject).toBe('neuralis-lab');
    expect(carried.qdrantMode).toBe('docker');
  });

  it('falls back cleanly on a first install', () => {
    const carried = carryOverEnv({});
    expect(carried.publicOrigin).toBeNull();
    expect(carried.nextAuthSecret).toBeNull();
    expect(carried.qdrantApiKey).toBeNull();
    expect(carried.ports).toEqual({ app: 3100, mcp: 3101, sandbox: 3102 });
    expect(carried.codexLoopback).toBe(false);
  });

  it('carries the Codex loopback opt-in over — only an explicit `on` publishes', () => {
    expect(carryOverEnv(parseEnvContent('NEURALIS_CODEX_LOOPBACK=on\n')).codexLoopback).toBe(true);
    expect(carryOverEnv(parseEnvContent('NEURALIS_CODEX_LOOPBACK= ON \n')).codexLoopback).toBe(true);
    expect(carryOverEnv(parseEnvContent('NEURALIS_CODEX_LOOPBACK=off\n')).codexLoopback).toBe(false);
    expect(carryOverEnv(parseEnvContent('NEURALIS_CODEX_LOOPBACK=true\n')).codexLoopback).toBe(false);
  });

  it('the full setup ASKS the Codex loopback opt-in on Docker — a fresh install defaults to off', () => {
    const fresh = carryOverEnv({});
    expect(codexLoopbackQuestion({ deploymentMode: 'docker', carried: fresh.codexLoopback, publicOrigin: 'http://localhost:3100' }))
      .toEqual({ ask: true, defaultOn: false, effective: true });
  });

  it('a re-run defaults to the carried answer: an install that opted in keeps it unless the operator says no', () => {
    const carried = carryOverEnv(parseEnvContent('NEURALIS_CODEX_LOOPBACK=on\n'));
    expect(codexLoopbackQuestion({ deploymentMode: 'docker', carried: carried.codexLoopback, publicOrigin: 'http://localhost:3100' }))
      .toEqual({ ask: true, defaultOn: true, effective: true });
  });

  it('native is NOT asked — the carried value rides through unchanged, either way', () => {
    for (const carried of [false, true]) {
      expect(codexLoopbackQuestion({ deploymentMode: 'native', carried, publicOrigin: 'http://localhost:3100' }))
        .toEqual({ ask: false, value: carried });
    }
  });

  it('a non-loopback public origin is still asked (the operator\'s choice, default kept) but flagged as having no effect', () => {
    expect(codexLoopbackQuestion({ deploymentMode: 'docker', carried: false, publicOrigin: 'http://192.168.1.20:3100' }))
      .toEqual({ ask: true, defaultOn: false, effective: false });
    expect(codexLoopbackQuestion({ deploymentMode: 'docker', carried: true, publicOrigin: 'https://neuralis.example.com' }))
      .toEqual({ ask: true, defaultOn: true, effective: false });
  });

  it('DERIVE-AND-VERIFY — the setup loopback-origin copy answers exactly what the host predicate answers', async () => {
    const { isLoopbackAppOrigin } = await import('../../src/server/oauth/appOrigin');
    const origins = [
      'http://localhost:3100',
      'http://127.0.0.1:3100',
      'http://[::1]:3100',
      'https://localhost',
      'http://127.0.0.2:3100',
      'http://0.0.0.0:3100',
      'http://192.168.1.20:3100',
      'http://host.docker.internal:3100',
      'https://neuralis.example.com',
      'not a url',
    ];
    for (const origin of origins) {
      expect(isLoopbackPublicOrigin(origin), origin).toBe(isLoopbackAppOrigin(origin));
    }
    // The list is not vacuous: it holds both answers.
    expect(origins.filter(isLoopbackPublicOrigin).length).toBeGreaterThan(0);
    expect(origins.filter((o) => !isLoopbackPublicOrigin(o)).length).toBeGreaterThan(0);
  });

  it('DERIVE-AND-VERIFY — the setup trusted-proxy validator accepts exactly what the host parser accepts', async () => {
    const { parseTrustedProxies } = await import('../../src/server/config/env');
    const lists = [
      '10.0.0.5',
      '172.18.0.0/16',
      '10.0.0.5, 192.168.0.0/24',
      '::1',
      'fd00::/8',
      '::ffff:10.0.0.5',
      '10.0.0.0/33',
      '10.0.0.5/abc',
      'proxy.example.com',
      '10.0.0.5/8/1',
      '10.0.0.5, nope',
    ];
    for (const list of lists) {
      expect(normalizeTrustedProxies(list) === null, list).toBe(parseTrustedProxies(list).length === 0);
    }
    expect(lists.filter((l) => normalizeTrustedProxies(l) === null).length).toBeGreaterThan(0);
    expect(lists.filter((l) => normalizeTrustedProxies(l) !== null).length).toBeGreaterThan(0);
  });

  it('carries the trusted-proxy list over a re-run, writes it every time, and `none` clears it', () => {
    expect(carryOverEnv(parseEnvContent('NEURALIS_TRUSTED_PROXIES=172.18.0.0/16 10.0.0.5\n')).trustedProxies)
      .toBe('172.18.0.0/16,10.0.0.5');
    expect(carryOverEnv(parseEnvContent('')).trustedProxies).toBe('');
    expect(normalizeTrustedProxies('none')).toBe('');
    expect(trustedProxiesLines('')).toContain('NEURALIS_TRUSTED_PROXIES=');
  });

  it('carries over an existing Qdrant API key (NEXTAUTH_SECRET family)', () => {
    const carried = carryOverEnv(parseEnvContent('QDRANT_API_KEY=keep-this-key\n'));
    expect(carried.qdrantApiKey).toBe('keep-this-key');
  });

  it('normalises a typed origin and rejects nonsense', () => {
    expect(normalizePublicOrigin('192.168.1.20:3100')).toBe('http://192.168.1.20:3100');
    expect(normalizePublicOrigin('https://neuralis.example.com/')).toBe('https://neuralis.example.com');
    expect(normalizePublicOrigin('  ')).toBeNull();
    expect(normalizePublicOrigin('ftp://x')).toBeNull();
  });

  it('writes ONE origin into all three public-origin variables', () => {
    const lines = buildOriginLines('http://192.168.1.20:3100', { app: 3100, mcp: 3101, sandbox: 3102 });
    expect(lines).toContain('NEXTAUTH_URL=http://192.168.1.20:3100');
    expect(lines).toContain('APP_URL=http://192.168.1.20:3100');
    // MCP clients dial this one — it must follow the origin, not stay localhost.
    expect(lines).toContain('MCP_BASE_URL=http://192.168.1.20:3101');
  });
});

describe('the image tag is install state — recorded once, carried, read back, never defaulted', () => {
  it('a fresh image-channel install records the version this host ships', () => {
    expect(initialImageTag(carryOverEnv({}).imageTag, '0.1.0', false)).toBe('0.1.0');
    expect(imageTagLines('0.1.0')).toContain('NEURALIS_IMAGE_TAG=0.1.0');
  });

  it('a full-setup RE-RUN keeps the recorded tag — the scaffold version an update never moved does not step it back', () => {
    const carried = carryOverEnv(parseEnvContent('NEURALIS_IMAGE_TAG=0.3.0\n'));
    expect(carried.imageTag).toBe('0.3.0');
    expect(initialImageTag(carried.imageTag, '0.1.0', false)).toBe('0.3.0');
  });

  it('the monorepo channel builds: no tag is recorded and no line is written', () => {
    expect(initialImageTag(null, '0.1.0', true)).toBeNull();
    expect(imageTagLines(null)).toEqual([]);
    expect(resolveImageTag({}, true)).toBeNull();
  });

  it('--compose-only reads the tag back exactly as recorded', () => {
    expect(resolveImageTag(parseEnvContent('NEURALIS_IMAGE_TAG=0.0.9\n'), false)).toBe('0.0.9');
  });

  it('--compose-only REFUSES on the image channel when .env has no tag — naming the fix, never a 0.0.0 or latest default', () => {
    expect(() => resolveImageTag({}, false)).toThrow(/no NEURALIS_IMAGE_TAG[\s\S]*Nothing was written/);
    expect(() => resolveImageTag({ NEURALIS_IMAGE_TAG: '  ' }, false)).toThrow(/no NEURALIS_IMAGE_TAG/);
    expect(() => resolveImageTag({ NEURALIS_IMAGE_TAG: 'a b' }, false)).toThrow(/not an image tag/);
    expect(() => initialImageTag(null, '1.0.0+build', false)).toThrow(/not an image tag/);
  });

  it('--compose-only refuses BEFORE it writes: the read-back sits beside the QDRANT_API_KEY refusal, ahead of the one compose write', () => {
    const source = readFileSync(join(HERE, '..', 'setup.mts'), 'utf-8')
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const body = source.slice(source.indexOf('async function runComposeOnly('));
    const end = body.indexOf('\n}\n');
    expect(end).toBeGreaterThan(-1);
    const fn = body.slice(0, end);
    const refusal = fn.indexOf('resolveImageTag(envVars, input.monorepo)');
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(fn.indexOf('generateComposeFile('));
    expect(fn.match(/generateComposeFile\(/g)).toHaveLength(1);
  });
});

describe('the Qdrant API key mint is MODE-conditional', () => {
  const mint = () => 'freshly-minted';

  it('docker / binary: carried key wins; a missing one is minted', () => {
    expect(resolveQdrantApiKey('docker', 'existing', mint)).toBe('existing');
    expect(resolveQdrantApiKey('binary', 'existing', mint)).toBe('existing');
    expect(resolveQdrantApiKey('docker', null, mint)).toBe('freshly-minted');
    expect(resolveQdrantApiKey('binary', null, mint)).toBe('freshly-minted');
  });

  it('external: NEVER mints — the server belongs to someone else', () => {
    // A minted key would be a value nobody configured on the actual server:
    // every client request would start failing with 401 the moment the line
    // lands in .env. The wizard asks instead; carry-over preserves the answer.
    expect(resolveQdrantApiKey('external', null, mint)).toBeNull();
    expect(resolveQdrantApiKey('external', 'operator-typed', mint)).toBe('operator-typed');
  });

  it('skip: no server, no key', () => {
    expect(resolveQdrantApiKey('skip', 'stale', mint)).toBeNull();
  });
});

describe('host ports: every busy one named, this install\'s own never busy, a free one offered', () => {
  const claims: PortClaim[] = portClaims({ ports: { app: 3100, mcp: 3101, sandbox: 3102 }, qdrantPort: 6333, codex: true });
  const table: PublishedPort[] = [
    { port: 3100, project: 'neuralis', container: 'neuralis-neuralis-1' },
    { port: 3101, project: 'neuralis', container: 'neuralis-neuralis-1' },
    { port: 3102, project: 'neuralis', container: 'neuralis-neuralis-1' },
    { port: 6333, project: 'neuralis', container: 'neuralis-qdrant-1' },
    { port: 8080, project: null, container: 'adminer' },
  ];

  it('claims what the compose file publishes, on its bind address; the callback port is the fixed 1455', () => {
    expect(claims.map((c) => `${c.key}:${c.address}:${c.port}`)).toEqual(['app:0.0.0.0:3100', 'mcp:0.0.0.0:3101', 'sandbox:0.0.0.0:3102', 'qdrant:127.0.0.1:6333', 'codex:127.0.0.1:1455']);
    expect(portClaims({ ports: { app: 1, mcp: 2, sandbox: 3 }, qdrantPort: null, codex: false }).map((c) => c.key)).toEqual(['app', 'mcp', 'sandbox']);
  });

  it('on a host layout: the listen probe and Docker\'s table together — another stack\'s ports are busy and named, the own project\'s are not', async () => {
    let asked = 0;
    const published = async () => { asked++; return table; };
    const probe: PortProbe = async (cs) => cs.filter((c) => [3100, 3101, 3102, 6333, 1455].includes(c.port));
    const busy = await findBusyPorts(claims, { ownProject: 'other-install', published, probe, probeFirst: true });
    expect(busy.map((b) => [b.key, b.port, b.holder])).toEqual([
      ['app', 3100, 'Compose project "neuralis"'], ['mcp', 3101, 'Compose project "neuralis"'], ['sandbox', 3102, 'Compose project "neuralis"'],
      ['qdrant', 6333, 'Compose project "neuralis"'], ['codex', 1455, null],
    ]);
    // A re-run or a regeneration beside its own running stack: nothing is busy but a stranger's port.
    expect((await findBusyPorts(claims, { ownProject: 'neuralis', published, probe, probeFirst: true })).map((b) => b.key)).toEqual(['codex']);
    // Setup inside a container: the listen probe sees its own namespace only (all free),
    // yet every port another project publishes is busy and named — from ONE table read.
    asked = 0;
    const blind = await findBusyPorts(claims, { ownProject: 'other-install', published, probe: async () => [], probeFirst: true });
    expect(blind.map((b) => [b.port, b.holder])).toEqual([[3100, 'Compose project "neuralis"'], [3101, 'Compose project "neuralis"'], [3102, 'Compose project "neuralis"'], [6333, 'Compose project "neuralis"']]);
    expect(asked).toBe(1);
    // Paired controls: the own project's ports are never busy; no Docker (no table) and a free probe → nothing.
    expect(await findBusyPorts(claims, { ownProject: 'neuralis', published, probe: async () => [], probeFirst: true })).toEqual([]);
    expect(await findBusyPorts(claims, { ownProject: null, published: async () => null, probe: async () => [], probeFirst: true })).toEqual([]);
  });

  it('in the image: Docker\'s table first, the throwaway probe only for what no container claims', async () => {
    const probed: number[][] = [];
    const probe: PortProbe = async (cs) => { probed.push(cs.map((c) => c.port)); return cs.filter((c) => c.port === 1455); };
    const busy = await findBusyPorts(claims, { ownProject: null, published: async () => table, probe, probeFirst: false });
    expect(busy.map((b) => b.key)).toEqual(['app', 'mcp', 'sandbox', 'qdrant', 'codex']);
    expect(probed).toEqual([[1455]]);
    const own = await findBusyPorts(claims, { ownProject: 'neuralis', published: async () => table, probe, probeFirst: false });
    expect(own.map((b) => b.key)).toEqual(['codex']);
  });

  it('the next free port: above the busy one, never another claim\'s, a container\'s or one the probe finds taken', async () => {
    const probe: PortProbe = async (cs) => cs.filter((c) => c.port === 3104);
    const busy = claims.filter((c) => ['app', 'mcp', 'sandbox', 'qdrant'].includes(c.key));
    const free = await nextFreePorts(busy, claims.map((c) => c.port), { probe, published: [...table, { port: 6334, project: 'x', container: 'y' }] });
    expect(Object.fromEntries(free)).toEqual({ app: 3103, mcp: 3106, sandbox: 3105, qdrant: 6335 });
  });

  it('the listen probe: a held port is busy, its paired control on the same address is free', async () => {
    const [held, idle] = await freePorts(2);
    const holder = createServer();
    await new Promise<void>((ready) => holder.listen(held, '127.0.0.1', ready));
    try {
      const result = await listenProbe([{ key: 'a', port: held!, address: '127.0.0.1' }, { key: 'b', port: idle!, address: '127.0.0.1' }]);
      expect(result.map((c) => c.key)).toEqual(['a']);
    } finally {
      await new Promise((closed) => holder.close(closed));
    }
  });

  it('Docker\'s table: one `docker ps`, every published host port with its Compose project', async () => {
    const calls: string[][] = [];
    const rows = await listPublishedPorts(async (_file, args) => {
      calls.push(args);
      return { stdout: 'neuralis\tneuralis-neuralis-1\t0.0.0.0:3100->3100/tcp, [::]:3100->3100/tcp, 0.0.0.0:3101->3101/tcp\n\tadminer\t0.0.0.0:8080->8080/tcp\nx\tquiet\t\n', stderr: '', status: 0, error: null };
    });
    expect(calls).toEqual([['ps', '--format', '{{.Label "com.docker.compose.project"}}\t{{.Names}}\t{{.Ports}}']]);
    expect(rows).toEqual([
      { port: 3100, project: 'neuralis', container: 'neuralis-neuralis-1' },
      { port: 3101, project: 'neuralis', container: 'neuralis-neuralis-1' },
      { port: 8080, project: null, container: 'adminer' },
    ]);
    expect(await listPublishedPorts(async () => ({ stdout: '', stderr: 'denied', status: 1, error: null }))).toBeNull();
  });

  it('a default-port stack as `docker ps` really prints it: identity RANGES and IPv6 expand, exposed-only ports do not count', async () => {
    // Measured on a running default install (3100/3101 identity-mapped, 3102 → 3100, Qdrant on loopback).
    const table = [
      'neuralis\tneuralis-neuralis-1\t0.0.0.0:3100-3101->3100-3101/tcp, [::]:3100-3101->3100-3101/tcp, 0.0.0.0:3102->3100/tcp, [::]:3102->3100/tcp',
      'neuralis\tneuralis-qdrant-1\t127.0.0.1:6333->6333/tcp',
      '\tdetermined_robinson\t3100-3101/tcp',
      'other\tother-web-1\t:::8443->443/tcp',
    ].join('\n');
    const rows = await listPublishedPorts(async () => ({ stdout: `${table}\n`, stderr: '', status: 0, error: null }));
    expect(rows).toEqual([
      { port: 3100, project: 'neuralis', container: 'neuralis-neuralis-1' },
      { port: 3101, project: 'neuralis', container: 'neuralis-neuralis-1' },
      { port: 3102, project: 'neuralis', container: 'neuralis-neuralis-1' },
      { port: 6333, project: 'neuralis', container: 'neuralis-qdrant-1' },
      { port: 8443, project: 'other', container: 'other-web-1' },
    ]);
    // The re-run of that install sees its own ports as its own, never as busy.
    const busy = await findBusyPorts(portClaims({ ports: { app: 3100, mcp: 3101, sandbox: 3102 }, qdrantPort: 6333, codex: false }), {
      ownProject: 'neuralis', published: async () => rows, probe: async (claims) => claims, probeFirst: true,
    });
    expect(busy).toEqual([]);
    // Another install's run of that same table: both range ports busy, the holder named.
    const foreign = await findBusyPorts(portClaims({ ports: { app: 3100, mcp: 3101, sandbox: 3102 }, qdrantPort: 6333, codex: false }), {
      ownProject: 'neuralis-lab', published: async () => rows, probe: async (claims) => claims, probeFirst: true,
    });
    expect(foreign.filter((b) => b.port === 3100 || b.port === 3101).map((b) => [b.port, b.holder]))
      .toEqual([[3100, 'Compose project "neuralis"'], [3101, 'Compose project "neuralis"']]);
  });

  it('the image\'s probe: the image THIS container runs, one labelled throwaway run per port IN PARALLEL; anything but "in use" refuses', async () => {
    let inFlight = 0;
    let peak = 0;
    const runs: string[][] = [];
    const runner: AsyncProgramRunner = async (_file, args) => {
      if (args[0] === 'inspect') return { stdout: 'sha256:feed\n', stderr: '', status: 0, error: null };
      runs.push(args);
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return args.includes('0.0.0.0:3100:3100')
        ? { stdout: '', stderr: 'docker: Error response from daemon: driver failed programming external connectivity: Bind for 0.0.0.0:3100 failed: port is already allocated\n', status: 125, error: null }
        : { stdout: '', stderr: '', status: 0, error: null };
    };
    const probe = await dockerRunProbe(runner, 'abc123');
    const busy = await probe(claims.slice(0, 4));
    expect(busy.map((c) => c.key)).toEqual(['app']);
    expect(peak).toBe(4);
    expect(runs[0]).toEqual(['run', '--rm', '--label', 'neuralis.kind=probe', '--entrypoint', 'true', '-p', '0.0.0.0:3100:3100', 'sha256:feed']);
    const broken = await dockerRunProbe(async (_f, args) => (args[0] === 'inspect' ? { stdout: 'sha256:feed', stderr: '', status: 0, error: null } : { stdout: '', stderr: 'no space left on device', status: 125, error: null }), 'abc123');
    await expect(broken(claims.slice(0, 1))).rejects.toThrow(/Checking host port 3100 failed: no space left on device/);
    await expect(dockerRunProbe(async () => ({ stdout: '', stderr: 'No such object', status: 1, error: null }), 'abc123')).rejects.toThrow(/Cannot tell which image/);
  });

  it('--compose-only asks nothing: each busy port named with its holder and the .env line that moves it', () => {
    const exit = busyPortRefusal(
      [{ key: 'app', port: 3100, address: '0.0.0.0', holder: 'Compose project "neuralis"' }, { key: 'qdrant', port: 6333, address: '127.0.0.1', holder: null }, { key: 'codex', port: 1455, address: '127.0.0.1', holder: null }],
      new Map([['app', 3103], ['qdrant', 6334]]),
    );
    expect(exit.message).toBe('Ports this install publishes are in use.');
    expect(exit.detail.slice(0, 3)).toEqual([
      'Port 3100 (the app) is in use — held by Compose project "neuralis": set NEURALIS_APP_PORT=3103 in .env.',
      'Port 6333 (Qdrant) is in use: set NEURALIS_QDRANT_PORT=6334 in .env.',
      'Port 1455 (the ChatGPT sign-in callback) is in use: set NEURALIS_CODEX_LOOPBACK=off in .env.',
    ]);
    expect(exit.detail.at(-1)).toMatch(/setup --compose-only again\. Nothing was written\.$/);
  });
});

describe('a Qdrant that answers is this install\'s own only when the carried mode explains it', () => {
  const table: PublishedPort[] = [{ port: 6334, project: 'neuralis-lab', container: 'neuralis-lab-qdrant-1' }, { port: 6333, project: 'neuralis', container: 'neuralis-qdrant-1' }];
  const own = (over: Partial<Parameters<typeof qdrantOwnership>[0]>) => qdrantOwnership({ carriedMode: null, carriedUrl: null, answeringUrl: 'http://localhost:6333', ownProject: 'neuralis-lab', published: table, ...over });

  it('a fresh install never owns a running Qdrant — someone else\'s is offered, never adopted', () => {
    expect(own({})).toBe('foreign');
  });
  it('docker: own when its Compose project publishes the answering port; another project\'s is foreign', () => {
    expect(own({ carriedMode: 'docker', answeringUrl: 'http://127.0.0.1:6334' })).toBe('own');
    expect(own({ carriedMode: 'docker', answeringUrl: 'http://localhost:6333' })).toBe('foreign');
    expect(own({ carriedMode: 'docker', answeringUrl: 'http://127.0.0.1:6334', published: null })).toBe('foreign');
  });
  it('binary / external: own when the recorded URL is the one answering — a re-run keeps the mode, no question', () => {
    expect(own({ carriedMode: 'binary', carriedUrl: 'http://localhost:6333', answeringUrl: 'http://127.0.0.1:6333' })).toBe('own');
    expect(own({ carriedMode: 'external', carriedUrl: 'http://qdrant.lan:6333', answeringUrl: 'http://qdrant.lan:6333' })).toBe('own');
    expect(own({ carriedMode: 'external', carriedUrl: 'http://qdrant.lan:6333', answeringUrl: 'http://localhost:6333' })).toBe('foreign');
    expect(own({ carriedMode: 'skip', carriedUrl: null })).toBe('foreign');
  });
  it('the recorded port is carried, and every host tool reaches docker mode on it', () => {
    const carried = carryOverEnv(parseEnvContent('QDRANT_MODE=docker\nNEURALIS_QDRANT_PORT=6334\nQDRANT_URL=http://localhost:6334\n'));
    expect([carried.qdrantPort, carried.qdrantUrl]).toEqual([6334, 'http://localhost:6334']);
    expect(carryOverEnv({}).qdrantPort).toBe(6333);
    expect(hostQdrantUrl({ QDRANT_MODE: 'docker', NEURALIS_QDRANT_PORT: '6334', QDRANT_URL: 'http://localhost:6333' })).toBe('http://127.0.0.1:6334');
    expect(hostQdrantUrl({ QDRANT_MODE: 'docker' })).toBe('http://127.0.0.1:6333');
    expect(hostQdrantUrl({ QDRANT_MODE: 'external', QDRANT_URL: 'http://qdrant.lan:6333' })).toBe('http://qdrant.lan:6333');
  });
  it('an image re-run: the setup container cannot reach the host loopback, yet its own docker Qdrant is kept — no question', async () => {
    const [port] = await freePorts(1);
    const carried = carryOverEnv(parseEnvContent(`QDRANT_MODE=docker\nNEURALIS_QDRANT_PORT=${port}\n`));
    const env = { qdrant: { running: false, url: 'http://localhost:6333', version: null } };
    const published = (project: string) => async () => [{ port: port!, project, container: `${project}-qdrant-1` }];
    expect(await answeringQdrant(env, carried, 'neuralis', { published: published('neuralis') }))
      .toEqual({ url: `http://localhost:${port}`, version: null, owner: 'own' });
    // Paired controls: another project's container on that port, or no table, is not this install's — nothing answers.
    expect(await answeringQdrant(env, carried, 'neuralis', { published: published('acme') })).toBeNull();
    expect(await answeringQdrant(env, carried, 'neuralis', { published: async () => null })).toBeNull();
  });
});

describe('the public-origin default follows a moved app port', () => {
  it('fresh: localhost on the chosen port; a carried origin on the OLD app port moves with it; any other stays', () => {
    expect(originDefault(null, 3100, 3103)).toBe('http://localhost:3103');
    expect(originDefault('http://localhost:3100', 3100, 3103)).toBe('http://localhost:3103');
    expect(originDefault('http://192.168.1.20:3100', 3100, 3103)).toBe('http://192.168.1.20:3103');
    expect(originDefault('http://localhost:3100', 3100, 3100)).toBe('http://localhost:3100');
    expect(originDefault('https://neuralis.example.com', 3100, 3103)).toBe('https://neuralis.example.com');
    expect(originDefault('http://proxy.lan:8080', 3100, 3103)).toBe('http://proxy.lan:8080');
  });
});

describe('compose project name', () => {
  const compose = '/home/op/neuralis/docker-compose.yml';

  it('preserves what a previous run recorded', () => {
    expect(
      resolveComposeProject({ existingName: 'neuralis-lab', composeFilePath: compose, projects: [] }),
    ).toEqual({ name: 'neuralis-lab', reason: 'preserved' });
  });

  it('keeps the plain default when nothing else claims it', () => {
    const rows = [{ name: 'other-stack', configFiles: '/srv/other/docker-compose.yml' }];
    expect(resolveComposeProject({ existingName: null, composeFilePath: compose, projects: rows }).name).toBe('neuralis');
  });

  it('does not collide with itself (same compose file = this install)', () => {
    const rows = [{ name: 'neuralis', configFiles: compose }];
    expect(resolveComposeProject({ existingName: null, composeFilePath: compose, projects: rows }).reason).toBe('default');
  });

  it('derives a distinct name from the INSTALL folder when another install already answers to neuralis', () => {
    const rows = [{ name: 'neuralis', configFiles: '/other/tree/docker-compose.yml' }];
    expect(resolveComposeProject({ existingName: null, composeFilePath: '/home/op/wintest/docker-compose.yml', projects: rows }))
      .toEqual({ name: 'neuralis-wintest', reason: 'derived' });
    // A folder already named for it is not prefixed twice.
    expect(resolveComposeProject({ existingName: null, composeFilePath: '/srv/neuralis-lab/docker-compose.yml', projects: rows }).name).toBe('neuralis-lab');
  });

  it('two image installs sharing one data home get two names — a hash of the install folder, never a counter or the data home', () => {
    // The first image install in ~/neuralis took `neuralis`; two more folders named the same, NEITHER started yet.
    const rows = [{ name: 'neuralis', configFiles: '/home/op/neuralis/docker-compose.yml' }];
    const at = (folder: string) => resolveComposeProject({ existingName: null, composeFilePath: `${folder}/docker-compose.yml`, projects: rows }).name;
    const hash = (folder: string) => createHash('sha256').update(folder).digest('hex').slice(0, 6);
    expect(at('/srv/a/neuralis')).toBe(`neuralis-${hash('/srv/a/neuralis')}`);
    expect(at('/srv/b/neuralis')).toBe(`neuralis-${hash('/srv/b/neuralis')}`);
    // Unstarted (absent from `compose ls`) and still distinct; the same folder always gets the same name.
    expect(at('/srv/a/neuralis')).not.toBe(at('/srv/b/neuralis'));
    expect(at('/srv/a/neuralis')).toBe(at('/srv/a/neuralis'));
    expect(at('/srv/a/neuralis')).not.toContain('.neuralis');
    // A derived base nobody else answers to stays readable — no hash.
    expect(at('/srv/lab')).toBe('neuralis-lab');
  });

  it('takes the default when Docker cannot be probed', () => {
    expect(
      resolveComposeProject({ existingName: null, composeFilePath: compose, projects: null }),
    ).toEqual({ name: 'neuralis', reason: 'unprobed' });
  });

  it('sanitises and parses defensively', () => {
    expect(sanitizeComposeProject('Neuralis Lab!')).toBe('neuralis-lab');
    expect(sanitizeComposeProject('---')).toBe('neuralis');
    expect(parseComposeLs('not json')).toBeNull();
    expect(parseComposeLs('[{"Name":"a","ConfigFiles":"/x.yml"}]')).toEqual([{ name: 'a', configFiles: '/x.yml' }]);
  });
});

describe('setup run from the image writes an install folder the HOST runs', () => {
  const VERSION = '9.9.9';
  const HOST_HOME = '/home/op/.neuralis';

  it('the host path of the data home: NEURALIS_HOST_HOME inside a container, the home itself anywhere else', () => {
    expect(resolveHostHome('/.neuralis', true, HOST_HOME)).toBe(HOST_HOME);
    expect(resolveHostHome('/srv/neuralis', true, undefined)).toBe('/srv/neuralis');
    expect(resolveHostHome('/.neuralis', true, 'relative/home')).toBe('/.neuralis');
    expect(resolveHostHome('/home/op/.neuralis', false, '/elsewhere')).toBe('/home/op/.neuralis');
  });

  it('the refusal command is the documented one, byte for byte (the setup-required page carries it too)', () => {
    expect(imageSetupCommand('latest').join('\n')).toBe(DOCKER_SETUP_COMMAND);
    // A refusal pins the image's own release on the first line; nothing else moves.
    expect(imageSetupCommand(VERSION).slice(1)).toEqual(imageSetupCommand('latest').slice(1));
    expect(imageSetupCommand(VERSION)[0]).toBe(`NEURALIS_TAG=${VERSION}   # or a release tag: https://hub.docker.com/r/neuralisapp/neuralis/tags`);
    const update = imageSetupCommand(VERSION, true);
    expect(update[0]).toBe(`NEURALIS_TAG=${VERSION}   # the release in .env NEURALIS_IMAGE_TAG`);
    expect(update[1]).toBe('cd ~/neuralis   # the folder that holds docker-compose.yml');
    expect(update.at(-1)).toBe('  neuralisapp/neuralis:"$NEURALIS_TAG" node bin/neuralis.mjs setup --compose-only --output "$PWD"');
    expect(update.join('\n')).not.toContain('-it ');
    expect(imageSetupCommand(VERSION, true, '/home/op/my neuralis')[1]).toBe("cd '/home/op/my neuralis'");
    expect(imageSetupCommand(VERSION, true, "/srv/op's")[1]).toBe("cd '/srv/op'\\''s'");
    // Every form runs verbatim: no `<…>` a shell would read as a redirect.
    for (const form of [imageSetupCommand('latest'), imageSetupCommand(VERSION), update, imageSetupCommand(VERSION, true, '/f')]) {
      expect(form.join('\n')).not.toMatch(/<[^>\n]*>/);
    }
  });

  it('every documented shell block runs verbatim (no `<…>`); the first install is `imageSetupCommand(\'latest\')`, the update names this release', () => {
    const repo = join(HERE, '..', '..', '..');
    const hostVersion = (JSON.parse(readFileSync(join(repo, 'neuralis', 'package.json'), 'utf8')) as { version: string }).version;
    const files: Record<string, { install: number; update: number }> = {
      'neuralis/README.md': { install: 1, update: 0 },
      'neuralis/DOCKERHUB.md': { install: 1, update: 0 },
      'neuralis/skills/neuralis-operations/SKILL.md': { install: 1, update: 1 },
      'neuralis/skills/neuralis-operations/references/setup-and-compose.md': { install: 1, update: 0 },
      'neuralis/skills/neuralis-operations/references/mounts.md': { install: 0, update: 0 },
      'neuralis/skills/neuralis-operations/references/host-plane.md': { install: 0, update: 0 },
      'neuralis/skills/neuralis-operations/references/rebuild-and-sync.md': { install: 0, update: 0 },
      'web/docs/content/docs/getting-started/installation.mdx': { install: 1, update: 0 },
      'web/docs/content/docs/enterprise/deployment.mdx': { install: 0, update: 1 },
    };
    const install = imageSetupCommand('latest').join('\n');
    const update = imageSetupCommand(hostVersion, true).join('\n');
    for (const [file, want] of Object.entries(files)) {
      const text = readFileSync(join(repo, file), 'utf8').replace(/\r\n/g, '\n');
      const blocks = [...text.matchAll(/^```(?:bash|sh)\n([\s\S]*?)^```$/gm)].map((m) => m[1]!.replace(/\n$/, ''));
      // ANY copied command, not only the image's: a `<…>` is a redirect to bash.
      for (const block of blocks) expect(block, `${file}: a placeholder in a copied command`).not.toMatch(/<[^>\n]*>/);
      const naming = blocks.filter((block) => block.includes('neuralisapp/neuralis:'));
      expect(naming.length, `${file}: blocks naming the image`).toBe(want.install + want.update);
      expect(naming.filter((block) => block === install).length, `${file}: first-install block`).toBe(want.install);
      expect(naming.filter((block) => block.startsWith(`${update}\n`)).length, `${file}: update block`).toBe(want.update);
    }
  });

  const DOCKER_OK = { available: true, cause: null, compose: true } as const;
  const OUT = { dir: '/home/op/neuralis', bound: true, writable: true };
  const base = { layout: 'container' as const, platform: 'linux' as const, neuralisHome: '/.neuralis', hostHome: HOST_HOME, docker: DOCKER_OK, version: VERSION, composeOnly: false, output: OUT };

  it('refuses in the image without the host home, a reachable Docker or a bound install folder; a same-path bind passes', () => {
    expect(setupRefusal(base)).toBeNull();
    expect(setupRefusal({ ...base, hostHome: undefined })?.message).toMatch(/NEURALIS_HOST_HOME is not set/);
    expect(setupRefusal({ ...base, hostHome: '.neuralis' })?.message).toMatch(/must be the absolute host path/);
    const noDocker = setupRefusal({ ...base, docker: { available: false, cause: 'daemon', compose: true } });
    expect(noDocker?.message).toMatch(/Docker is not reachable from this container: the socket is not bound/);
    expect(noDocker?.detail.join('\n')).toContain('-v /var/run/docker.sock:/var/run/docker.sock');
    expect(noDocker?.detail.at(-1)).toBe('Nothing was written.');
    // The socket bound but its group not added: the other fix, named.
    expect(setupRefusal({ ...base, docker: { available: false, cause: 'permission', compose: true } })?.message).toMatch(/may not open the bound socket — add its group: --group-add/);
    // No `-v "$PWD:$PWD"`: the folder is the container's own, and every answer would be lost with it.
    const unbound = setupRefusal({ ...base, output: { ...OUT, bound: false } });
    expect(unbound?.message).toMatch(/install folder \/home\/op\/neuralis is not bound from the host/);
    expect(unbound?.detail.join('\n')).toContain('  -v "$PWD:$PWD" \\');
    expect(unbound?.detail.join('\n')).not.toContain('--user "$(id -u):$(id -g)".');
    // Bound but not writable — a run without `--user`: the --user fix, never the bind hint.
    const notWritable = setupRefusal({ ...base, output: { ...OUT, writable: false } });
    expect(notWritable?.message).toMatch(/is not writable by this user/);
    expect(notWritable?.detail[0]).toBe('The image runs as its own user unless it is given yours: --user "$(id -u):$(id -g)".');
    expect(notWritable?.detail.join('\n')).not.toContain('Bind the folder at its own path');
    // The compose-only refusal names the real folder it was given.
    expect(setupRefusal({ ...base, composeOnly: true, output: { ...OUT, bound: false } })?.detail).toContain("  cd '/home/op/neuralis'");
    // The home bound at its own host path needs no NEURALIS_HOST_HOME.
    expect(setupRefusal({ ...base, neuralisHome: '/home/op/.neuralis', hostHome: undefined })).toBeNull();
    for (const layout of ['clone', 'monorepo', 'host-tree'] as const) {
      expect(setupRefusal({ ...base, layout, hostHome: undefined, docker: { available: false, cause: 'missing', compose: false }, output: { ...OUT, bound: false } })).toBeNull();
    }
  });

  it('an npm install folder refuses a Docker it cannot run, naming the cause and this platform\'s fix; --compose-only needs only the CLI and Compose', () => {
    const folder = { ...base, layout: 'folder' as const, hostHome: undefined, neuralisHome: '/home/op/.neuralis', output: { ...OUT, bound: false } };
    const refusal = (docker: { available: boolean; cause: 'missing' | 'daemon' | 'permission' | null; compose: boolean }, platform: 'linux' | 'wsl' | 'macos' | 'windows', composeOnly = false) =>
      setupRefusal({ ...folder, docker, platform, composeOnly });
    const missing = { available: false, cause: 'missing', compose: false } as const;
    const daemon = { available: false, cause: 'daemon', compose: true } as const;
    const permission = { available: false, cause: 'permission', compose: true } as const;
    const noCompose = { available: true, cause: null, compose: false } as const;
    const rows: Array<[typeof missing | typeof daemon | typeof permission | typeof noCompose, 'linux' | 'wsl' | 'macos' | 'windows', RegExp, RegExp]> = [
      [missing, 'linux', /^Docker is not installed\./, /docs\.docker\.com\/engine\/install/],
      [missing, 'wsl', /^Docker is not installed in this WSL distro\./, /WSL integration/],
      [missing, 'macos', /^Docker is not installed\./, /Install Docker Desktop/],
      [missing, 'windows', /^Docker is not installed\./, /Install Docker Desktop/],
      [daemon, 'linux', /daemon does not answer/, /sudo systemctl start docker/],
      [daemon, 'wsl', /daemon does not answer/, /WSL integration .*sudo service docker start/],
      [daemon, 'macos', /daemon does not answer/, /^Start Docker Desktop\.$/],
      [permission, 'linux', /may not open the Docker socket/, /sudo usermod -aG docker "\$USER"/],
      [permission, 'wsl', /may not open the Docker socket/, /sudo usermod -aG docker/],
      [permission, 'windows', /may not open the Docker socket/, /Restart Docker Desktop/],
      [noCompose, 'linux', /Docker Compose v2 \(`docker compose`\) is missing/, /docker-compose-plugin/],
      [noCompose, 'macos', /Docker Compose v2 \(`docker compose`\) is missing/, /Update Docker Desktop/],
    ];
    for (const [docker, platform, message, fix] of rows) {
      const exit = refusal(docker, platform);
      expect(exit?.message, `${docker.cause ?? 'compose'} on ${platform}`).toMatch(message);
      expect(exit?.message).toContain('An npm install folder runs Neuralis with Docker Compose.');
      expect(exit?.detail[0], `${docker.cause ?? 'compose'} on ${platform}`).toMatch(fix);
      expect(exit?.detail[1]).toBe('Then run npx neuralis setup again. More: https://docs.neuralisapp.com/getting-started/installation#if-something-fails');
      expect(exit?.detail.at(-1)).toBe('Nothing was written.');
    }
    expect(refusal(DOCKER_OK, 'linux')).toBeNull();
    // Offline regeneration keeps working: a stopped daemon or a socket this user cannot open still has the CLI and its plugin.
    expect(refusal(daemon, 'linux', true)).toBeNull();
    expect(refusal(permission, 'linux', true)).toBeNull();
    expect(refusal(missing, 'linux', true)?.detail[1]).toContain('npx neuralis setup --compose-only again');
    expect(refusal(noCompose, 'linux', true)?.message).toMatch(/Compose v2/);
  });

  const FAKE_DOCKER = "#!/bin/sh\ncase \"$1\" in\n  info) echo '[{\"Name\":\"compose\"}]|29.8.2' ;;\n  inspect) echo 'sha256:feed' ;;\nesac\nexit 0\n";
  const FAKE_DOCKER_DOWN = "#!/bin/sh\necho '[{\"Name\":\"compose\"}]|'\necho 'Cannot connect to the Docker daemon' >&2\nexit 1\n";

  // The wiring, in process: a host package copy outside any workspace (the image's
  // layout), a fake `docker` on PATH, and `/.dockerenv` switched per row.
  async function imageRun(opts: { docker: boolean }) {
    const root = mkdtempSync(join(tmpdir(), 'neuralis-image-setup-'));
    const host = join(root, 'host');
    const home = join(root, 'home');
    const out = join(root, 'out');
    const bin = join(root, 'bin');
    for (const dir of [host, join(home, 'app', 'config'), out, bin]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(host, 'package.json'), JSON.stringify({ name: 'neuralis', version: VERSION, bin: { neuralis: 'bin/neuralis.mjs' } }));
    const [app, mcp, sandbox] = await freePorts(3);
    const env = `NEURALIS_IMAGE_TAG=9.9.9\nQDRANT_MODE=skip\nBRAIN_INFRA_MODE=inmemory\nNEURALIS_COMPOSE_PROJECT=neuralis\nNEXTAUTH_SECRET=x\nNEURALIS_APP_PORT=${app}\nMCP_HTTP_PORT=${mcp}\nNEURALIS_MCP_SANDBOX_PORT=${sandbox}\n`;
    writeFileSync(join(out, '.env'), env);
    writeFileSync(join(bin, 'docker'), opts.docker ? FAKE_DOCKER : FAKE_DOCKER_DOWN, { mode: 0o755 });
    const ctx = { packageDir: host, installDir: host, cwd: host, stdout: () => {}, stderr: () => {}, env: process.env, stdin: process.stdin } as CliContext;
    container.binds = [home, out];
    return { root, host, home, out, bin, env, ctx };
  }

  async function inImage<T>(fixture: Awaited<ReturnType<typeof imageRun>>, vars: Record<string, string | undefined>, fn: () => Promise<T>, inContainer = true): Promise<T> {
    const saved = new Map(Object.keys({ PATH: '', ...vars }).map((k) => [k, process.env[k]]));
    const set = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    set('PATH', `${fixture.bin}:${process.env.PATH ?? ''}`);
    for (const [k, v] of Object.entries(vars)) set(k, v);
    container.value = inContainer;
    try {
      return await fn();
    } finally {
      container.value = false;
      for (const [k, v] of saved) set(k, v);
    }
  }

  const probes = { QDRANT_URL: 'http://127.0.0.1:9', OLLAMA_URL: 'http://127.0.0.1:9' };

  it.skipIf(process.platform === 'win32')('--compose-only in the image binds the HOST home and passes it on; the data stays at the container path', async () => {
    const f = await imageRun({ docker: true });
    try {
      const code = await inImage(f, { ...probes, NEURALIS_HOME: f.home, NEURALIS_HOST_HOME: HOST_HOME }, () => runSetup(['--compose-only', '--output', f.out], f.ctx));
      expect(code).toBe(0);
      const compose = readFileSync(join(f.out, 'docker-compose.yml'), 'utf8');
      expect(compose).toContain(`      - ${HOST_HOME}/app:/.neuralis/app\n`);
      expect(compose).toContain(`      - ${HOST_HOME}/checkpoints:/.neuralis/checkpoints\n`);
      expect(compose).toContain(`      - NEURALIS_HOST_HOME=${HOST_HOME}\n`);
      expect(compose).not.toContain(f.home);
      expect(existsSync(join(f.home, 'checkpoints'))).toBe(true);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('control: on the host the same run binds the data home itself, NEURALIS_HOST_HOME notwithstanding', async () => {
    const f = await imageRun({ docker: true });
    try {
      const code = await inImage(f, { ...probes, NEURALIS_HOME: f.home, NEURALIS_HOST_HOME: HOST_HOME }, () => runSetup(['--compose-only', '--output', f.out], f.ctx), false);
      expect(code).toBe(0);
      const compose = readFileSync(join(f.out, 'docker-compose.yml'), 'utf8');
      expect(compose).toContain(`      - ${f.home}/app:/.neuralis/app\n`);
      expect(compose).toContain(`      - NEURALIS_HOST_HOME=${f.home}\n`);
      expect(compose).not.toContain(HOST_HOME);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  /** Runs `args` in the image expecting a refusal; asserts it wrote nothing. */
  async function refused(f: Awaited<ReturnType<typeof imageRun>>, args: string[], vars: Record<string, string | undefined>): Promise<CliExit> {
    const before = readdirSync(f.home, { recursive: true }).sort();
    let thrown: unknown = null;
    await inImage(f, { ...probes, ...vars }, async () => {
      try { await runSetup(args, f.ctx); } catch (error) { thrown = error; }
    });
    expect(thrown).toBeInstanceOf(CliExit);
    expect(readdirSync(f.out)).toEqual(['.env']);
    expect(readFileSync(join(f.out, '.env'), 'utf8')).toBe(f.env);
    expect(readdirSync(f.home, { recursive: true }).sort()).toEqual(before);
    return thrown as unknown as CliExit;
  }

  it.skipIf(process.platform === 'win32')('the three refusals write nothing: no host home, no Docker, a home the image user cannot write', async () => {
    const f = await imageRun({ docker: true });
    try {
      // (a) the image default home with no host path: nothing is even read from it.
      const noHome = await refused(f, ['--output', f.out], { NEURALIS_HOME: '/.neuralis', NEURALIS_HOST_HOME: undefined });
      expect(noHome.message).toMatch(/NEURALIS_HOST_HOME is not set/);
      expect(noHome.detail).toContain(`  ${imageSetupCommand(VERSION).at(-2)}`);
      expect(existsSync('/.neuralis')).toBe(false);
      // (b) no Docker answering through the socket, on --compose-only too.
      writeFileSync(join(f.bin, 'docker'), FAKE_DOCKER_DOWN, { mode: 0o755 });
      const noDocker = await refused(f, ['--compose-only', '--output', f.out], { NEURALIS_HOME: f.home, NEURALIS_HOST_HOME: HOST_HOME });
      expect(noDocker.message).toMatch(/Docker is not reachable/);
      // (c) the home not writable by this user: the --user fix, never a prompt and never a uid literal.
      if (process.getuid?.() !== 0) {
        writeFileSync(join(f.bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
        chmodSync(f.home, 0o555);
        try {
          const readOnly = await refused(f, ['--compose-only', '--output', f.out], { NEURALIS_HOME: f.home, NEURALIS_HOST_HOME: HOST_HOME });
          expect(readOnly.message).toMatch(/Data root is not writable/);
          expect(readOnly.detail[0]).toContain('--user "$(id -u):$(id -g)"');
          expect(readOnly.detail.join('\n')).not.toMatch(/\b1001\b/);
        } finally {
          chmodSync(f.home, 0o755);
        }
      }
      // (d) no `-v "$PWD:$PWD"`: the install folder is the container's own — refused, naming the bind.
      writeFileSync(join(f.bin, 'docker'), FAKE_DOCKER, { mode: 0o755 });
      container.binds = [f.home];
      const unbound = await refused(f, ['--compose-only', '--output', f.out], { NEURALIS_HOME: f.home, NEURALIS_HOST_HOME: HOST_HOME });
      expect(unbound.message).toMatch(/is not bound from the host/);
      expect(unbound.detail).toContain(`  cd '${f.out}'`);
      // (e) bound but not writable — the run without `--user`: the --user fix, never the bind hint.
      if (process.getuid?.() !== 0) {
        container.binds = [f.home, f.out];
        chmodSync(f.out, 0o555);
        try {
          const noUser = await refused(f, ['--compose-only', '--output', f.out], { NEURALIS_HOME: f.home, NEURALIS_HOST_HOME: HOST_HOME });
          expect(noUser.message).toMatch(/is not writable by this user/);
          expect(noUser.detail[0]).toContain('--user "$(id -u):$(id -g)"');
        } finally {
          chmodSync(f.out, 0o755);
        }
      }
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('--compose-only refuses a port another stack holds — named, with the .env line — and passes beside its own running stack', async () => {
    const f = await imageRun({ docker: true });
    const app = Number(parseEnvContent(f.env).NEURALIS_APP_PORT);
    const holder = createServer();
    await new Promise<void>((ready) => holder.listen(app, '0.0.0.0', ready));
    const dockerHolding = (project: string) => `#!/bin/sh\ncase "$1" in\n  info) echo '[{"Name":"compose"}]|29.8.2' ;;\n  ps) printf '${project}\\t${project}-neuralis-1\\t0.0.0.0:${app}->3100/tcp\\n' ;;\nesac\nexit 0\n`;
    try {
      writeFileSync(join(f.bin, 'docker'), dockerHolding('acme'), { mode: 0o755 });
      const exit = await inImage(f, { ...probes, NEURALIS_HOME: f.home, NEURALIS_HOST_HOME: undefined }, async () => {
        try { await runSetup(['--compose-only', '--output', f.out], f.ctx); return null; } catch (error) { return error as CliExit; }
      }, false);
      expect(exit).toBeInstanceOf(CliExit);
      expect(exit!.detail[0]).toMatch(new RegExp(`^Port ${app} \\(the app\\) is in use — held by Compose project "acme": set NEURALIS_APP_PORT=\\d+ in \\.env\\.$`));
      expect(readdirSync(f.out)).toEqual(['.env']);
      // The same port held by THIS install's own project (NEURALIS_COMPOSE_PROJECT=neuralis) is no clash.
      writeFileSync(join(f.bin, 'docker'), dockerHolding('neuralis'), { mode: 0o755 });
      const code = await inImage(f, { ...probes, NEURALIS_HOME: f.home, NEURALIS_HOST_HOME: undefined }, () => runSetup(['--compose-only', '--output', f.out], f.ctx), false);
      expect(code).toBe(0);
      expect(readFileSync(join(f.out, 'docker-compose.yml'), 'utf8')).toContain(`      - "${app}:3100"\n`);
    } finally {
      await new Promise((closed) => holder.close(closed));
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('in the image --compose-only tries an unclaimed port with a throwaway run of its own image, and refuses the one in use', async () => {
    const f = await imageRun({ docker: true });
    const mcp = Number(parseEnvContent(f.env).MCP_HTTP_PORT);
    const log = join(f.root, 'docker.log');
    writeFileSync(join(f.bin, 'docker'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\ncase "$1" in\n  info) echo '[{"Name":"compose"}]|29.8.2' ;;\n  inspect) echo 'sha256:feed' ;;\n  run) case "$*" in *":${mcp}:${mcp} "*) echo 'Bind for 0.0.0.0:${mcp} failed: port is already allocated' >&2; exit 125 ;; esac ;;\nesac\nexit 0\n`, { mode: 0o755 });
    try {
      const exit = await refused(f, ['--compose-only', '--output', f.out], { NEURALIS_HOME: f.home, NEURALIS_HOST_HOME: HOST_HOME });
      expect(exit.detail[0]).toMatch(new RegExp(`^Port ${mcp} \\(MCP\\) is in use: set MCP_HTTP_PORT=\\d+ in \\.env\\.$`));
      const calls = readFileSync(log, 'utf8').trim().split('\n');
      expect(calls.filter((c) => c.startsWith('ps '))).toHaveLength(1);
      expect(calls.filter((c) => c.startsWith('inspect '))).toHaveLength(1);
      expect(calls.filter((c) => c.startsWith('run --rm --label neuralis.kind=probe --entrypoint true -p ')).length).toBeGreaterThanOrEqual(3);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('an npm install folder with no usable Docker refuses before the first prompt and writes nothing', async () => {
    const f = await imageRun({ docker: false });
    const folder = join(f.root, 'folder');
    mkdirSync(folder);
    writeFileSync(join(folder, 'package.json'), JSON.stringify({ private: true, dependencies: { neuralis: VERSION } }));
    const ctx = { ...f.ctx, installDir: folder, cwd: folder } as CliContext;
    const before = readdirSync(f.home, { recursive: true }).sort();
    const printed: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { printed.push(parts.join(' ')); });
    try {
      for (const [script, cause] of [[null, /Docker is not installed/], [FAKE_DOCKER_DOWN, /daemon does not answer/]] as const) {
        const empty = mkdtempSync(join(tmpdir(), 'neuralis-path-'));
        if (script) writeFileSync(join(empty, 'docker'), script, { mode: 0o755 });
        let thrown: unknown = null;
        await inImage(f, { ...probes, NEURALIS_HOME: f.home, NEURALIS_HOST_HOME: undefined, PATH: empty }, async () => {
          try { await runSetup([], ctx); } catch (error) { thrown = error; }
        }, false);
        expect(thrown).toBeInstanceOf(CliExit);
        expect((thrown as CliExit).message).toMatch(cause);
        expect((thrown as CliExit).detail.at(-1)).toBe('Nothing was written.');
        expect(readdirSync(folder)).toEqual(['package.json']);
        expect(readdirSync(f.home, { recursive: true }).sort()).toEqual(before);
      }
      // The detection summary already names the cause.
      expect(printed.join('\n')).toMatch(/Docker: .*not available \(its daemon does not answer\)/);
    } finally {
      log.mockRestore();
      rmSync(f.root, { recursive: true, force: true });
    }
  });
});
