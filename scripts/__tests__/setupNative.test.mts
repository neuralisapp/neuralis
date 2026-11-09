/**
 * The desktop app's first run — `setup --native --yes` — and the native install
 * kind's consumer arms (spelling, where `.env` lives, `update`, `mount`), on a
 * throwaway bundle and data home. Nothing is asked; the password arrives on
 * stdin and never in argv. And the adopt — `setup --native --yes` with no owner
 * flags on a home a Docker install set up — with its named refusals.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { installKindOf, NATIVE_MARKER, readInstallRecords } from '@neuralis/package-system/paths';
import { CliExit, type CliContext } from '../cli/registry.mts';
import { installLayout, spellOn } from '../cli/spelling.mts';
import { resolveConfigDir } from '../setup/detect.mts';
import { parseEnvContent } from '../setup/envFile.mts';
import { QDRANT_TARGET_VERSION } from '../setup/qdrantVersion.mts';

// Docker is the test's answer, never this machine's: `setup --native` asks it only for a new home's defaults.
// `loopback.free` answers every listen probe "free", so a port moves only for a reason the code itself holds.
const docker = vi.hoisted(() => ({ available: false }));
const loopback = vi.hoisted(() => ({ free: false }));
vi.mock('../setup/detect.mts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../setup/detect.mts')>();
  return {
    ...original,
    detectDocker: () => ({ available: docker.available, version: docker.available ? '28.0.0' : null, cause: docker.available ? null : 'missing', compose: docker.available }),
    settleLoopbackPorts: (claims: Parameters<typeof original.settleLoopbackPorts>[0], probe?: Parameters<typeof original.settleLoopbackPorts>[1], reserved?: number[]) =>
      original.settleLoopbackPorts(claims, loopback.free ? async () => [] : probe, reserved),
  };
});
// A new desktop volume does not exist yet: the probe answers that without asking Docker.
vi.mock('../setup/qdrantVersion.mts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../setup/qdrantVersion.mts')>();
  return {
    ...original,
    dockerInstallProbe: () => ({ storageExists: async () => false, runningVersion: async () => null, installedVersion: async () => null }),
  };
});

// `--lan on` names this computer's network address: the test's own, never the machine's.
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:os')>();
  return { ...original, networkInterfaces: () => ({ eth0: [{ address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: '192.168.1.20/24' }] }) };
});

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function bundle(opts: { qdrant?: boolean } = {}): { resources: string; packageDir: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'nrs-native-setup-'));
  roots.push(root);
  const resources = join(root, 'resources');
  const packageDir = join(resources, 'host');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'neuralis', version: '0.3.3', bin: { neuralis: 'bin/neuralis.mjs' } }));
  writeFileSync(join(packageDir, NATIVE_MARKER), '');
  if (opts.qdrant !== false) {
    mkdirSync(join(resources, 'qdrant'), { recursive: true });
    writeFileSync(join(resources, 'qdrant', 'qdrant'), `#!/bin/sh\necho "qdrant ${QDRANT_TARGET_VERSION}"\n`);
    chmodSync(join(resources, 'qdrant', 'qdrant'), 0o755);
  }
  return { resources, packageDir, home: join(root, 'home') };
}

function ctxFor(b: { packageDir: string; home: string }, password: string): CliContext {
  const stdin = new PassThrough();
  stdin.end(`${password}\n`);
  return {
    packageDir: b.packageDir,
    get installDir(): string { throw new CliExit(1, 'setup --native never reads the install folder'); },
    cwd: b.packageDir,
    env: process.env,
    stdin,
    stdout: () => {},
    stderr: () => {},
  };
}

describe('setup --native --yes', () => {
  it('writes the owner, the project and a native .env in <home>/app/config — no Docker-only line, loopback everywhere, the install recorded', async () => {
    const b = bundle();
    vi.stubEnv('NEURALIS_HOME', b.home);
    const argv = ['--native', '--yes', '--owner-email', 'Owner@Example.com', '--project', 'Desk Top'];
    const { run } = await import('../setup.mts');
    expect(await run(argv, ctxFor(b, 'correct horse battery'))).toBe(0);
    // The password is in no argument and in no file but as its bcrypt hash.
    expect(argv.join(' ')).not.toContain('correct horse');
    const users = readdirSync(join(b.home, 'app', 'users'));
    expect(users).toHaveLength(1);
    const user = JSON.parse(readFileSync(join(b.home, 'app', 'users', users[0]!), 'utf-8')) as { email: string; passwordHash: string };
    expect(user.email).toBe('owner@example.com');
    expect(user.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    const project = JSON.parse(readFileSync(join(b.home, 'app', 'projects', readdirSync(join(b.home, 'app', 'projects'))[0]!), 'utf-8')) as { name: string };
    expect(project.name).toBe('Desk Top');
    // A new home has nothing to raise: its ledger starts at the final versions, so a first
    // boot that fails part-way leaves no pending upgrade (`up` would refuse with 12).
    const { UPGRADES_DIR, pendingUpgrades } = await import('../upgrade.mts');
    expect(existsSync(join(b.home, 'app', 'config', 'data-formats.json'))).toBe(true);
    expect(await pendingUpgrades(UPGRADES_DIR, join(b.home, 'app'))).toEqual([]);

    const envText = readFileSync(join(b.home, 'app', 'config', '.env'), 'utf-8');
    expect(envText).not.toContain('correct horse');
    // The session secret is the home's own file, 0400 — never a `.env` line.
    expect(envText).not.toContain('NEXTAUTH_SECRET');
    const secretFile = join(b.home, 'app', 'config', 'session-secret.key');
    expect(readFileSync(secretFile, 'utf-8')).toMatch(/^[A-Za-z0-9+/]{43}=\n$/);
    expect(statSync(secretFile).mode & 0o777).toBe(0o400);
    const env = parseEnvContent(envText);
    expect(env.NEURALIS_BIND_HOST).toBe('127.0.0.1');
    expect(env.APP_URL).toBe(`http://127.0.0.1:${env.NEURALIS_APP_PORT}`);
    expect(env.MCP_BASE_URL).toBe(`http://127.0.0.1:${env.MCP_HTTP_PORT}`);
    expect(env).toMatchObject({ QDRANT_MODE: 'binary', BRAIN_INFRA_MODE: 'local', QDRANT_URL: `http://127.0.0.1:${env.NEURALIS_QDRANT_PORT}` });
    expect(env.QDRANT_API_KEY).toMatch(/^[0-9a-f]{64}$/);
    for (const key of ['LOCAL_UID', 'LOCAL_GID', 'DOCKER_GID', 'NEURALIS_COMPOSE_PROJECT', 'NEURALIS_IMAGE_TAG', 'NEURALIS_MACHINE_IMAGE', 'NEURALIS_CODEX_LOOPBACK', 'NEURALIS_DOCKER', 'NEURALIS_HOST_HOME']) {
      expect(env[key], key).toBeUndefined();
    }
    expect(new Set([env.NEURALIS_APP_PORT, env.MCP_HTTP_PORT, env.NEURALIS_MCP_SANDBOX_PORT, env.NEURALIS_QDRANT_PORT, env.NEURALIS_QDRANT_GRPC_PORT]).size).toBe(5);
    expect(existsSync(join(b.packageDir, 'docker-compose.yml'))).toBe(false);
    expect(existsSync(join(b.packageDir, '.env'))).toBe(false);
    expect(existsSync(join(b.home, 'app', 'config', 'docker-compose.yml'))).toBe(false);
    expect(readInstallRecords(b.home)).toEqual([{ kind: 'native', dir: b.packageDir, configDir: join(b.home, 'app', 'config') }]);
    // No Docker here: the virtual desktop is off by default — named in the home's platform config.
    expect(JSON.parse(readFileSync(join(b.home, 'app', 'config', 'platform.json'), 'utf-8'))).toMatchObject({ disabledBuiltinPackages: ['@neuralis/machine-core'] });
    // The desktop host pairs this computer as the owner's device: its host-access plane is on.
    expect(JSON.parse(readFileSync(join(b.home, 'app', 'config', 'platform.json'), 'utf-8'))).toMatchObject({ hostBrokerEnabled: true });

    // A set-up home refuses a second first run.
    await expect(run(argv, ctxFor(b, 'correct horse battery'))).rejects.toThrow(/is already set up/);
  }, 30_000);

  it('writes the session secret BEFORE the owner record — a crash between them never reads as a home an earlier release set up', async () => {
    const b = bundle();
    vi.stubEnv('NEURALIS_HOME', b.home);
    const secretFile = join(b.home, 'app', 'config', 'session-secret.key');
    const seen: boolean[] = [];
    vi.resetModules();
    vi.doMock('../setup/records.mts', async (importOriginal) => {
      const records = await importOriginal<typeof import('../setup/records.mts')>();
      return { ...records, writeOwnerRecord: (...args: Parameters<typeof records.writeOwnerRecord>) => { seen.push(existsSync(secretFile)); return records.writeOwnerRecord(...args); } };
    });
    try {
      const { run } = await import('../setup.mts');
      expect(await run(['--native', '--yes', '--owner-email', 'order@example.com', '--project', 'Order'], ctxFor(b, 'correct horse battery'))).toBe(0);
    } finally {
      vi.doUnmock('../setup/records.mts');
      vi.resetModules();
    }
    expect(seen).toEqual([true]);
  }, 30_000);

  it('refuses without --yes, without an email, with a short password, or outside the desktop bundle — writing nothing', async () => {
    const { run } = await import('../setup.mts');
    const b = bundle({ qdrant: false });
    vi.stubEnv('NEURALIS_HOME', b.home);
    await expect(run(['--native', '--owner-email', 'a@b.c'], ctxFor(b, 'longenough'))).rejects.toThrow(/add --yes/);
    await expect(run(['--native', '--yes'], ctxFor(b, 'longenough'))).rejects.toThrow(/--owner-email <email> is required/);
    await expect(run(['--native', '--yes', '--owner-email', 'a@b.c'], ctxFor(b, 'short'))).rejects.toThrow(/at least 8 characters/);
    rmSync(join(b.packageDir, NATIVE_MARKER));
    await expect(run(['--native', '--yes', '--owner-email', 'a@b.c'], ctxFor(b, 'longenough'))).rejects.toThrow(/desktop app's own host bundle/);
    expect(existsSync(b.home)).toBe(false);
  });

  it('without a Qdrant binary in the bundle: in-memory vectors, no Qdrant lines', async () => {
    const { run } = await import('../setup.mts');
    const b = bundle({ qdrant: false });
    vi.stubEnv('NEURALIS_HOME', b.home);
    expect(await run(['--native', '--yes', '--owner-email', 'a@b.c'], ctxFor(b, 'longenough'))).toBe(0);
    const env = parseEnvContent(readFileSync(join(b.home, 'app', 'config', '.env'), 'utf-8'));
    expect(env).toMatchObject({ QDRANT_MODE: 'skip', BRAIN_INFRA_MODE: 'inmemory' });
    expect(env.QDRANT_API_KEY).toBeUndefined();
  }, 30_000);

  it('the host-access plane seed is the desktop host\'s alone: the Docker setup\'s seed carries no `hostBrokerEnabled` (source pin)', () => {
    const src = readFileSync(join(__dirname, '..', 'setup.mts'), 'utf-8');
    expect(src.match(/\.\.\.NATIVE_HOST_PLANE_SEED/g)).toHaveLength(1);
    const native = src.slice(src.indexOf('async function runNativeSetup('), src.indexOf('export async function run('));
    expect(native).toContain('...NATIVE_HOST_PLANE_SEED');
    const dockerSeed = src.slice(src.indexOf('const platformSeed: Record<string, unknown> = {'), src.indexOf('if (config.vector.ollamaUrl)'));
    expect(dockerSeed.length).toBeGreaterThan(50);
    expect(dockerSeed).not.toMatch(/hostBrokerEnabled|NATIVE_HOST_PLANE_SEED/);
  });

  it('--ollama: an existing Ollama costs no program download; switching to none hands its model back to the unasked answer, and back again turns it on', async () => {
    const { run } = await import('../setup.mts');
    const b = bundle();
    vi.stubEnv('NEURALIS_HOME', b.home);
    const said: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...line: unknown[]) => { said.push(line.join(' ')); });
    const platform = () => JSON.parse(readFileSync(join(b.home, 'app', 'config', 'platform.json'), 'utf-8')) as Record<string, unknown>;
    try {
      expect(await run(['--native', '--yes', '--owner-email', 'a@b.c', '--ollama', 'existing'], ctxFor(b, 'longenough'))).toBe(0);
      expect(said.join('\n')).toContain('for the embedding model');
      expect(said.join('\n')).not.toContain('download for the program');
      expect(platform()).toMatchObject({ ollamaUrl: 'http://127.0.0.1:11434', embeddingModelId: 'ollama:qwen3-embedding', embeddingEnabled: true });

      expect(await run(['--native', '--yes', '--ollama', 'none'], ctxFor(b, ''))).toBe(0);
      const off = platform();
      expect(off.embeddingModelId).not.toBe('ollama:qwen3-embedding');
      expect(off).toMatchObject({ embeddingEnabled: false });

      said.length = 0;
      expect(await run(['--native', '--yes', '--ollama', 'binary'], ctxFor(b, ''))).toBe(0);
      expect(platform()).toMatchObject({ ollamaUrl: 'http://127.0.0.1:11435', embeddingModelId: 'ollama:qwen3-embedding', embeddingEnabled: true });
    } finally {
      spy.mockRestore();
    }
  }, 30_000);

  it('the host-access plane seed is merged: an operator\'s `hostBrokerEnabled: false` already in the home stays false', async () => {
    const { run } = await import('../setup.mts');
    const b = bundle({ qdrant: false });
    vi.stubEnv('NEURALIS_HOME', b.home);
    mkdirSync(join(b.home, 'app', 'config'), { recursive: true });
    writeFileSync(join(b.home, 'app', 'config', 'platform.json'), JSON.stringify({ hostBrokerEnabled: false }));
    expect(await run(['--native', '--yes', '--owner-email', 'a@b.c'], ctxFor(b, 'longenough'))).toBe(0);
    expect(JSON.parse(readFileSync(join(b.home, 'app', 'config', 'platform.json'), 'utf-8'))).toMatchObject({ hostBrokerEnabled: false });
  }, 30_000);
});

describe('setup --native --yes (no owner flags) — adopting a home a Docker install set up', () => {
  /** A home Docker set up: an owner, a project, the session secret file, a recorded Qdrant version — no native .env. */
  function dockerHome(b: { home: string }, opts: { secret?: boolean } = {}): void {
    mkdirSync(join(b.home, 'app', 'users'), { recursive: true });
    mkdirSync(join(b.home, 'app', 'projects'), { recursive: true });
    mkdirSync(join(b.home, 'app', 'config'), { recursive: true });
    writeFileSync(join(b.home, 'app', 'users', 'u1.json'), JSON.stringify({ id: 'u1', email: 'owner@example.com' }));
    writeFileSync(join(b.home, 'app', 'projects', 'main.json'), JSON.stringify({ id: 'main' }));
    if (opts.secret !== false) writeFileSync(join(b.home, 'app', 'config', 'session-secret.key'), 'docker-secret\n', { mode: 0o400 });
    writeFileSync(join(b.home, 'qdrant-version.json'), '{"version":"1.18.0","previous":null,"source":"detected","recordedAt":"x"}');
  }
  const snapshot = (home: string): string => ['app/users/u1.json', 'app/projects/main.json', 'app/config/session-secret.key', 'qdrant-version.json']
    .map((rel) => (existsSync(join(home, rel)) ? readFileSync(join(home, rel), 'utf-8') : '-')).join('|');

  /** The Docker install the home records (a host-kind folder) with its own `.env`. */
  function dockerInstall(b: { home: string }, envLines: string[], name = 'docker-install'): string {
    const dir = join(b.home, '..', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'neuralis', bin: { neuralis: 'bin/neuralis.mjs' } }));
    writeFileSync(join(dir, '.env'), `${envLines.join('\n')}\n`);
    const path = join(b.home, 'app', 'config', 'installs.json');
    const rows = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf-8')) as { installs: unknown[] }).installs : [];
    writeFileSync(path, JSON.stringify({ version: 1, installs: [...rows, { kind: 'host', dir, composeProject: 'neuralis' }] }));
    return dir;
  }
  const DOCKER_ENV = ['QDRANT_MODE=docker', 'QDRANT_API_KEY=dkey', 'NEURALIS_QDRANT_PORT=6444', 'NEURALIS_COMPOSE_PROJECT=neuralis'];

  it('uses the recorded Docker install\'s Qdrant: its loopback port and key, its folder for `up` — only this host\'s .env and the install record are written, the Docker .env is only read', async () => {
    const { run } = await import('../setup.mts');
    const b = bundle();
    dockerHome(b);
    const dir = dockerInstall(b, DOCKER_ENV);
    vi.stubEnv('NEURALIS_HOME', b.home);
    const before = snapshot(b.home);
    const dockerEnv = readFileSync(join(dir, '.env'), 'utf-8');
    expect(await run(['--native', '--yes'], ctxFor(b, ''))).toBe(0);
    expect(snapshot(b.home)).toBe(before);
    expect(readFileSync(join(dir, '.env'), 'utf-8')).toBe(dockerEnv);
    const env = parseEnvContent(readFileSync(join(b.home, 'app', 'config', '.env'), 'utf-8'));
    expect(env).toMatchObject({
      NEURALIS_BIND_HOST: '127.0.0.1', BRAIN_INFRA_MODE: 'local', QDRANT_MODE: 'external',
      QDRANT_URL: 'http://127.0.0.1:6444', QDRANT_API_KEY: 'dkey', NEURALIS_QDRANT_COMPOSE_DIR: dir,
    });
    for (const key of ['NEURALIS_QDRANT_PORT', 'NEURALIS_QDRANT_GRPC_PORT', 'NEURALIS_COMPOSE_PROJECT', 'NEXTAUTH_SECRET']) expect(env[key], key).toBeUndefined();
    expect(existsSync(join(b.home, 'app', 'config', 'docker-compose.yml'))).toBe(false);
    expect(readInstallRecords(b.home)).toEqual([
      { kind: 'host', dir, composeProject: 'neuralis' },
      { kind: 'native', dir: b.packageDir, configDir: join(b.home, 'app', 'config') },
    ]);
    // Adopted once: the next run is the ordinary "already set up".
    await expect(run(['--native', '--yes'], ctxFor(b, ''))).rejects.toThrow(/is already set up — start it with `neuralis up`/);
  }, 30_000);

  it('the mode table: external copies URL and key, skip is in-memory; a binary install, several installs, none, a keyless docker one are refused by name — writing nothing', async () => {
    const { run } = await import('../setup.mts');
    const adopt = async (envLines: string[] | null, extra?: string[]): Promise<{ b: ReturnType<typeof bundle>; result: Promise<number> }> => {
      const b = bundle();
      dockerHome(b);
      if (envLines) dockerInstall(b, envLines);
      if (extra) dockerInstall(b, extra, 'second-install');
      vi.stubEnv('NEURALIS_HOME', b.home);
      return { b, result: run(['--native', '--yes'], ctxFor(b, '')) };
    };
    const external = await adopt(['QDRANT_MODE=external', 'QDRANT_URL=https://vectors.example:6333', 'QDRANT_API_KEY=ext']);
    expect(await external.result).toBe(0);
    const extEnv = parseEnvContent(readFileSync(join(external.b.home, 'app', 'config', '.env'), 'utf-8'));
    expect(extEnv).toMatchObject({ QDRANT_MODE: 'external', QDRANT_URL: 'https://vectors.example:6333', QDRANT_API_KEY: 'ext', BRAIN_INFRA_MODE: 'local' });
    expect(extEnv.NEURALIS_QDRANT_COMPOSE_DIR).toBeUndefined();

    const skip = await adopt(['QDRANT_MODE=skip']);
    expect(await skip.result).toBe(0);
    expect(parseEnvContent(readFileSync(join(skip.b.home, 'app', 'config', '.env'), 'utf-8'))).toMatchObject({ QDRANT_MODE: 'skip', BRAIN_INFRA_MODE: 'inmemory' });

    const refusals: Array<[string[] | null, string[] | undefined, RegExp]> = [
      [['QDRANT_MODE=binary'], undefined, /runs Qdrant from its binary on .*qdrant-storage — the files this app's own Qdrant would open/],
      [DOCKER_ENV, ['QDRANT_MODE=skip'], /records several installs of this data home/],
      [null, undefined, /records no Docker install of this data home: run `neuralis setup --compose-only` once/],
      [['QDRANT_MODE=docker'], undefined, /runs Qdrant in Docker but carries no QDRANT_API_KEY/],
      [['QDRANT_MODE=sideways'], undefined, /names no Qdrant mode this app knows/],
    ];
    for (const [envLines, extra, reason] of refusals) {
      const { b, result } = await adopt(envLines, extra);
      await expect(result).rejects.toThrow(reason);
      expect(existsSync(join(b.home, 'app', 'config', '.env'))).toBe(false);
    }
  }, 60_000);

  it('--qdrant binary gives this app its own store instead (the earlier default); --qdrant docker on an adopt and --copy-vectors without binary are refused', async () => {
    const { run } = await import('../setup.mts');
    const b = bundle();
    dockerHome(b);
    dockerInstall(b, DOCKER_ENV);
    vi.stubEnv('NEURALIS_HOME', b.home);
    const before = snapshot(b.home);
    await expect(run(['--native', '--yes', '--qdrant', 'docker'], ctxFor(b, ''))).rejects.toThrow(/uses its Docker install's Qdrant by default/);
    await expect(run(['--native', '--yes', '--copy-vectors'], ctxFor(b, ''))).rejects.toThrow(/go with --qdrant binary/);
    expect(existsSync(join(b.home, 'app', 'config', '.env'))).toBe(false);
    expect(await run(['--native', '--yes', '--qdrant', 'binary'], ctxFor(b, ''))).toBe(0);
    expect(snapshot(b.home)).toBe(before);
    const env = parseEnvContent(readFileSync(join(b.home, 'app', 'config', '.env'), 'utf-8'));
    expect(env).toMatchObject({ QDRANT_MODE: 'binary', BRAIN_INFRA_MODE: 'local', QDRANT_URL: `http://127.0.0.1:${env.NEURALIS_QDRANT_PORT}` });
    expect(env.QDRANT_API_KEY).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);

  it('--qdrant binary never takes the port the Docker install publishes its Qdrant on, even while that Qdrant is stopped (nothing listens there)', async () => {
    const { run } = await import('../setup.mts');
    const b = bundle();
    dockerHome(b);
    dockerInstall(b, ['QDRANT_MODE=docker', 'QDRANT_API_KEY=dkey', 'NEURALIS_QDRANT_PORT=6333', 'NEURALIS_COMPOSE_PROJECT=neuralis']);
    vi.stubEnv('NEURALIS_HOME', b.home);
    loopback.free = true;
    try {
      expect(await run(['--native', '--yes', '--qdrant', 'binary'], ctxFor(b, ''))).toBe(0);
    } finally {
      loopback.free = false;
    }
    const env = parseEnvContent(readFileSync(join(b.home, 'app', 'config', '.env'), 'utf-8'));
    expect(env).toMatchObject({ QDRANT_MODE: 'binary', NEURALIS_QDRANT_PORT: '6335', NEURALIS_QDRANT_GRPC_PORT: '6334', QDRANT_URL: 'http://127.0.0.1:6335' });
  }, 30_000);

  it('--lan on|off moves the derived origins and keeps an MCP and sandbox origin the operator declared', async () => {
    const { run } = await import('../setup.mts');
    const b = bundle();
    vi.stubEnv('NEURALIS_HOME', b.home);
    expect(await run(['--native', '--yes', '--owner-email', 'lan@example.com'], ctxFor(b, 'correct horse battery'))).toBe(0);
    const envPath = join(b.home, 'app', 'config', '.env');
    const read = () => parseEnvContent(readFileSync(envPath, 'utf-8'));
    const { NEURALIS_APP_PORT: app, MCP_HTTP_PORT: mcp } = read();
    // Paired control: a derived MCP origin follows the switch.
    expect(await run(['--native', '--yes', '--lan', 'on'], ctxFor(b, ''))).toBe(0);
    expect(read()).toMatchObject({ APP_URL: `http://192.168.1.20:${app}`, MCP_BASE_URL: `http://192.168.1.20:${mcp}`, NEURALIS_BIND_HOST: '0.0.0.0' });
    appendFileSync(envPath, 'MCP_BASE_URL=https://mcp.corp\nNEURALIS_MCP_SANDBOX_ORIGIN=https://sandbox.corp\n');
    writeFileSync(envPath, readFileSync(envPath, 'utf-8').replace(`MCP_BASE_URL=http://192.168.1.20:${mcp}\n`, ''));
    for (const [lan, host] of [['off', '127.0.0.1'], ['on', '192.168.1.20']] as const) {
      expect(await run(['--native', '--yes', '--lan', lan], ctxFor(b, ''))).toBe(0);
      expect(read()).toMatchObject({ APP_URL: `http://${host}:${app}`, MCP_BASE_URL: 'https://mcp.corp', NEURALIS_MCP_SANDBOX_ORIGIN: 'https://sandbox.corp' });
    }
    expect(readFileSync(envPath, 'utf-8').match(/^MCP_BASE_URL=/gm)).toHaveLength(1);
  }, 30_000);

  it('--refresh-qdrant rewrites ONLY the Qdrant lines from the Docker install again (a rotated key); every other line stays byte for byte', async () => {
    const { run } = await import('../setup.mts');
    const b = bundle();
    dockerHome(b);
    const dir = dockerInstall(b, DOCKER_ENV);
    vi.stubEnv('NEURALIS_HOME', b.home);
    await expect(run(['--native', '--yes', '--refresh-qdrant'], ctxFor(b, ''))).rejects.toThrow(/is not set up for this app yet/);
    expect(await run(['--native', '--yes'], ctxFor(b, ''))).toBe(0);
    const envPath = join(b.home, 'app', 'config', '.env');
    appendFileSync(envPath, 'NEURALIS_TRUSTED_PROXIES_NOTE=kept\n');
    const nonQdrant = (text: string): string[] => text.split('\n').filter((l) => l && !/^(BRAIN_INFRA_MODE|QDRANT_|NEURALIS_QDRANT_|NEURALIS_COMPOSE_PROJECT)/.test(l) && !l.startsWith('# Qdrant'));
    const before = readFileSync(envPath, 'utf-8');
    writeFileSync(join(dir, '.env'), [...DOCKER_ENV.filter((l) => !l.startsWith('QDRANT_API_KEY')), 'QDRANT_API_KEY=rotated'].join('\n'));
    expect(await run(['--native', '--yes', '--refresh-qdrant'], ctxFor(b, ''))).toBe(0);
    const after = readFileSync(envPath, 'utf-8');
    expect(nonQdrant(after)).toEqual(nonQdrant(before));
    expect(parseEnvContent(after)).toMatchObject({ QDRANT_API_KEY: 'rotated', QDRANT_MODE: 'external', NEURALIS_QDRANT_COMPOSE_DIR: dir, NEURALIS_TRUSTED_PROXIES_NOTE: 'kept' });
    expect(after.match(/^QDRANT_API_KEY=/gm)).toHaveLength(1);
  }, 30_000);

  it('refuses by name — owner flags on a set-up home, a home whose secret is still in the Docker .env, a package choice on an adopt — writing nothing', async () => {
    const { run } = await import('../setup.mts');
    const b = bundle();
    dockerHome(b);
    dockerInstall(b, DOCKER_ENV);
    vi.stubEnv('NEURALIS_HOME', b.home);
    await expect(run(['--native', '--yes', '--owner-email', 'a@b.c'], ctxFor(b, 'longenough'))).rejects.toThrow(/already set up — adopt it with `neuralis setup --native --yes` \(no owner flags\)/);
    await expect(run(['--native', '--yes', '--no-desktop'], ctxFor(b, ''))).rejects.toThrow(/choose a NEW data home's packages/);
    const older = bundle();
    dockerHome(older, { secret: false });
    vi.stubEnv('NEURALIS_HOME', older.home);
    await expect(run(['--native', '--yes'], ctxFor(older, ''))).rejects.toThrow(/no session secret file yet: run `neuralis upgrade --apply` from the Docker install first/);
    for (const home of [b.home, older.home]) expect(existsSync(join(home, 'app', 'config', '.env'))).toBe(false);
  });
});

describe('setup --native --yes — a new data home with Docker', () => {
  it('Qdrant in Docker by default: a compose file of its own beside .env (named volume, loopback port, the key interpolated), one project per home, the desktop on', async () => {
    docker.available = true;
    try {
      const { run } = await import('../setup.mts');
      const b = bundle();
      vi.stubEnv('NEURALIS_HOME', b.home);
      expect(await run(['--native', '--yes', '--owner-email', 'a@b.c'], ctxFor(b, 'longenough'))).toBe(0);
      const configDir = join(b.home, 'app', 'config');
      const env = parseEnvContent(readFileSync(join(configDir, '.env'), 'utf-8'));
      expect(env).toMatchObject({ QDRANT_MODE: 'docker', BRAIN_INFRA_MODE: 'local', QDRANT_URL: `http://127.0.0.1:${env.NEURALIS_QDRANT_PORT}` });
      expect(env.NEURALIS_COMPOSE_PROJECT).toMatch(/^neuralis-desktop-[0-9a-f]{8}$/);
      expect(env.QDRANT_API_KEY).toMatch(/^[0-9a-f]{64}$/);
      expect(env.NEURALIS_QDRANT_GRPC_PORT).toBeUndefined();
      const compose = readFileSync(join(configDir, 'docker-compose.yml'), 'utf-8');
      expect(compose).toContain(`name: ${env.NEURALIS_COMPOSE_PROJECT}\n`);
      expect(compose).toContain('      - qdrant-data:/qdrant/storage\n');
      expect(compose).toContain(`      - "127.0.0.1:${env.NEURALIS_QDRANT_PORT}:6333"\n`);
      expect(compose).toContain('${QDRANT_API_KEY:?');
      expect(compose).not.toContain(env.QDRANT_API_KEY!);
      expect(compose).not.toMatch(/^  neuralis:/m);
      expect(compose).toContain(`image: qdrant/qdrant:v${QDRANT_TARGET_VERSION}@sha256:`);
      expect(compose.startsWith('# GENERATED by neuralis setup')).toBe(false);
      expect(installKindOf(configDir)).toBeNull();
      expect(statSync(join(configDir, 'docker-compose.yml')).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(join(b.home, 'qdrant-version.json'), 'utf-8'))).toMatchObject({ version: QDRANT_TARGET_VERSION, source: 'fresh' });
      expect(JSON.parse(readFileSync(join(configDir, 'platform.json'), 'utf-8'))).not.toHaveProperty('disabledBuiltinPackages');
      // Another home, another project: two homes never share a volume.
      const other = bundle();
      vi.stubEnv('NEURALIS_HOME', other.home);
      expect(await run(['--native', '--yes', '--owner-email', 'a@b.c', '--no-desktop'], ctxFor(other, 'longenough'))).toBe(0);
      const otherEnv = parseEnvContent(readFileSync(join(other.home, 'app', 'config', '.env'), 'utf-8'));
      expect(otherEnv.NEURALIS_COMPOSE_PROJECT).not.toBe(env.NEURALIS_COMPOSE_PROJECT);
      expect(JSON.parse(readFileSync(join(other.home, 'app', 'config', 'platform.json'), 'utf-8'))).toMatchObject({ disabledBuiltinPackages: ['@neuralis/machine-core'] });
    } finally {
      docker.available = false;
    }
  }, 60_000);

  it('the choices: --qdrant binary with Docker keeps the bundle binary; --qdrant docker without Docker is refused, writing nothing; --desktop without Docker leaves it on', async () => {
    const { run } = await import('../setup.mts');
    const noDocker = bundle();
    vi.stubEnv('NEURALIS_HOME', noDocker.home);
    await expect(run(['--native', '--yes', '--owner-email', 'a@b.c', '--qdrant', 'docker'], ctxFor(noDocker, 'longenough'))).rejects.toThrow(/Docker \(with Compose\) does not answer on this computer/);
    expect(existsSync(noDocker.home)).toBe(false);
    await expect(run(['--native', '--yes', '--owner-email', 'a@b.c', '--qdrant', 'cloud'], ctxFor(noDocker, 'longenough'))).rejects.toThrow(/--qdrant takes docker or binary/);
    expect(await run(['--native', '--yes', '--owner-email', 'a@b.c', '--desktop'], ctxFor(noDocker, 'longenough'))).toBe(0);
    expect(JSON.parse(readFileSync(join(noDocker.home, 'app', 'config', 'platform.json'), 'utf-8'))).not.toHaveProperty('disabledBuiltinPackages');

    docker.available = true;
    try {
      const b = bundle();
      vi.stubEnv('NEURALIS_HOME', b.home);
      expect(await run(['--native', '--yes', '--owner-email', 'a@b.c', '--qdrant', 'binary'], ctxFor(b, 'longenough'))).toBe(0);
      expect(parseEnvContent(readFileSync(join(b.home, 'app', 'config', '.env'), 'utf-8'))).toMatchObject({ QDRANT_MODE: 'binary' });
      expect(existsSync(join(b.home, 'app', 'config', 'docker-compose.yml'))).toBe(false);
      expect(JSON.parse(readFileSync(join(b.home, 'app', 'config', 'platform.json'), 'utf-8'))).not.toHaveProperty('disabledBuiltinPackages');
    } finally {
      docker.available = false;
    }
  }, 60_000);
});

describe('the native kind\'s consumer arms', () => {
  it('spells `neuralis <verb>`, keeps .env in <home>/app/config, and update and mount refuse by name', async () => {
    const b = bundle({ qdrant: false });
    expect(installLayout(b.packageDir, b.packageDir, false)).toBe('native');
    expect(spellOn('native', 'status')).toBe('neuralis status');
    expect(resolveConfigDir({ projectRoot: b.packageDir, neuralisHome: b.home }, null, false)).toBe(join(b.home, 'app', 'config'));
    const ctx: CliContext = { packageDir: b.packageDir, installDir: b.packageDir, cwd: b.packageDir, env: process.env, stdin: new PassThrough(), stdout: () => {}, stderr: () => {} };
    const update = await import('../update.mts');
    await expect(update.run([], ctx)).rejects.toThrow(/updated through the app/);
    const mount = await import('../mount.mts');
    await expect(mount.run(['list'], ctx)).rejects.toThrow(/no container to bind a folder into/);
  });
});
