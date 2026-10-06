/**
 * The setup wizard's re-run contract.
 *
 * Every rule here exists because the wizard broke it on a real install: a
 * second `pnpm neuralis:setup` used to delete 14 admin-set platform keys,
 * rotate the session secret and the MCP API key behind a default-yes prompt,
 * rewrite all three source configs over the admin's edits, and — when answered
 * with a different project name — write a whole orphan tree.
 *
 * These assert the extracted modules directly. The wizard module itself
 * exports nothing and runs `main()` at load, which is exactly why the file-IO
 * halves were extracted (F3 INC-S1).
 */

import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
import { resolveConfigDir } from '../setup/detect.mts';
import {
  buildOriginLines,
  carryOverEnv,
  codexLoopbackQuestion,
  imageTagLines,
  initialImageTag,
  isLoopbackPublicOrigin,
  normalizePublicOrigin,
  normalizeTrustedProxies,
  parseEnvContent,
  resolveImageTag,
  resolveQdrantApiKey,
  trustedProxiesLines,
} from '../setup/envFile.mts';
import { parseComposeLs, resolveComposeProject, sanitizeComposeProject } from '../setup/composeProject.mts';
import type { SetupConfig } from '../setup/types.mts';

const HERE = dirname(fileURLToPath(import.meta.url));

function scratchHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'neuralis-setup-'));
  mkdirSync(join(home, 'app', 'projects'), { recursive: true });
  mkdirSync(join(home, 'app', 'config', 'sources'), { recursive: true });
  return home;
}

describe('deployment config placement', () => {
  const env = { isClone: false, projectRoot: '/install/host', neuralisHome: '/data/neuralis' };

  it('keeps a native/npm host env beside the app for Next to load', () => {
    expect(resolveConfigDir(env, null, false)).toBe(env.projectRoot);
  });
  it('keeps a source host env beside the app', () => {
    expect(resolveConfigDir({ ...env, isClone: true }, null, false)).toBe(env.projectRoot);
  });
  it('keeps pull-only container config on its persistent data mount', () => {
    expect(resolveConfigDir(env, null, true)).toBe(env.neuralisHome);
  });
  it('preserves the source-overlay placement inside a container', () => {
    expect(resolveConfigDir({ ...env, isClone: true }, null, true)).toBe(env.projectRoot);
  });
  it('honors an explicit export directory in both environments', () => {
    expect(resolveConfigDir(env, '/export', false)).toBe('/export');
    expect(resolveConfigDir(env, '/export', true)).toBe('/export');
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

describe('compose project name', () => {
  const compose = '/home/op/neuralis/docker-compose.yml';

  it('preserves what a previous run recorded', () => {
    expect(
      resolveComposeProject({ existingName: 'neuralis-lab', composeFilePath: compose, installDir: '/home/op/.neuralis', projects: [] }),
    ).toEqual({ name: 'neuralis-lab', reason: 'preserved' });
  });

  it('keeps the plain default when nothing else claims it', () => {
    const rows = [{ name: 'other-stack', configFiles: '/srv/other/docker-compose.yml' }];
    expect(resolveComposeProject({ existingName: null, composeFilePath: compose, installDir: '/home/op/.neuralis', projects: rows }).name).toBe('neuralis');
  });

  it('does not collide with itself (same compose file = this install)', () => {
    const rows = [{ name: 'neuralis', configFiles: compose }];
    expect(resolveComposeProject({ existingName: null, composeFilePath: compose, installDir: '/home/op/.neuralis', projects: rows }).reason).toBe('default');
  });

  it('derives a distinct name when another install already answers to neuralis', () => {
    const rows = [{ name: 'neuralis', configFiles: '/other/tree/docker-compose.yml' }];
    const resolved = resolveComposeProject({ existingName: null, composeFilePath: compose, installDir: '/home/op/wintest', projects: rows });
    expect(resolved.reason).toBe('derived');
    expect(resolved.name).toBe('neuralis-wintest');
  });

  it('takes the default when Docker cannot be probed', () => {
    expect(
      resolveComposeProject({ existingName: null, composeFilePath: compose, installDir: '/x', projects: null }),
    ).toEqual({ name: 'neuralis', reason: 'unprobed' });
  });

  it('sanitises and parses defensively', () => {
    expect(sanitizeComposeProject('Neuralis Lab!')).toBe('neuralis-lab');
    expect(sanitizeComposeProject('---')).toBe('neuralis');
    expect(parseComposeLs('not json')).toBeNull();
    expect(parseComposeLs('[{"Name":"a","ConfigFiles":"/x.yml"}]')).toEqual([{ name: 'a', configFiles: '/x.yml' }]);
  });
});
