/**
 * The runtime package install transaction, against a mkdtemp app root and home
 * (never the live data folder). The happy path runs the REAL npm of this Node
 * on a dependency-free tarball (no network: npm installs a local tarball with
 * no dependencies offline); the refusals run a recording npm double, so each
 * row also proves npm was or was not asked.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { PackageDefinition, SessionContext } from '@neuralis/package-system/contracts';
import { discoverBuiltinRoots, readBuiltinManifests, resolveHostDependencyRoot } from '../../../host/builtinSlots';
import { BUILTIN_GRANT_CHANGES_FILE } from '../../builtinGrantChangesRecord';
import { revokeGrantsPatch } from '../../reconcileBuiltinGrantChanges';
import { imageOrigin } from '../hostPlatformPackages';
import { bundledNpmCli, createNpmRunner, type NpmRunner } from '../npm';
import { allowListAdmits, createPlatformPackages, MAX_PENDING_REQUESTS, parseRegistrySpec, PlatformPackageError, type PlatformPackageProvenance, type PlatformPackagesDeps } from '../platformPackages';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };

const owner: SessionContext = { userId: 'u-owner', projectId: 'p1', role: 'owner', grantedFeatures: ['*'] } as SessionContext;
/** Holds `platform.packages` but not `platform.packages.approve`. */
const asker: SessionContext = { userId: 'u-asker', projectId: 'p1', role: 'ops', grantedFeatures: ['platform.packages'] } as SessionContext;
const PERSON: PlatformPackageProvenance = { interactive: true };

type Pkg = { name: string; version: string; neuralis?: unknown; dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; files?: Record<string, string> };

/** A `.tgz` with the npm `package/` prefix, built with the system tar. */
function tarball(pkg: Pkg): { path: string; base64: string } {
  const dir = temp('nrs-pkg-src-');
  const root = join(dir, 'package');
  mkdirSync(root, { recursive: true });
  const { files = {}, ...manifest } = pkg;
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', ...manifest }));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  const out = join(dir, 'package.tgz');
  expect(spawnSync('tar', ['-czf', out, '-C', dir, 'package']).status).toBe(0);
  return { path: out, base64: readFileSync(out).toString('base64') };
}

const hello = (extra: Partial<Pkg> = {}): Pkg => ({
  name: '@acme/hello',
  version: '0.1.0',
  peerDependencies: { '@neuralis/package-system': '*' },
  neuralis: {
    id: '@acme/hello',
    requires: { providesFeatures: [{ id: 'hello.read', title: 'Hello', description: 'Hello.' }], defaultRoleGrants: { admin: ['hello.read'] } },
    configSettings: [{ key: 'helloGreeting', type: 'string', default: 'hi', description: 'Greeting.' }],
  },
  files: {
    'dist/src/routes/hello.js': "export const pattern = 'hello';\nexport const feature = 'hello.read';\nexport const GET = async () => ({ status: 200, body: { hello: true } });\n",
    'dist/src/probe.js': "export * as kernel from '@neuralis/package-system/contracts';\n",
    'tools/hello.json': '{}',
  },
  ...extra,
});

type Calls = { npm: string[][]; audit: string[]; details: Array<Record<string, unknown> | undefined>; log: Array<Record<string, unknown>> };
type Port = ReturnType<typeof createPlatformPackages>;
/** The port with the call provenance defaulted to a person, so a row names it only when it is the subject. */
type TestPort = Omit<Port, 'request' | 'approve' | 'restart'> & {
  request: (caller: SessionContext, ask: Parameters<Port['request']>[1], via?: PlatformPackageProvenance) => ReturnType<Port['request']>;
  approve: (caller: SessionContext, id: string, via?: PlatformPackageProvenance) => ReturnType<Port['approve']>;
  restart: (caller: SessionContext, via?: PlatformPackageProvenance) => ReturnType<Port['restart']>;
};

function setup(over: Partial<PlatformPackagesDeps> = {}, npm: NpmRunner | null = null): { port: TestPort; appRoot: string; home: string; calls: Calls } {
  const home = temp('nrs-home-');
  const appRoot = join(home, 'app');
  mkdirSync(appRoot, { recursive: true });
  const calls: Calls = { npm: [], audit: [], details: [], log: [] };
  const recording: NpmRunner = async (args, opts) => {
    calls.npm.push([...args]);
    return npm ? npm(args, opts) : { code: 1, stdout: '', stderr: 'npm double: no behaviour', ms: 1, timedOut: false };
  };
  const raw = createPlatformPackages({
    appRoot,
    home,
    activeIds: new Set(['@neuralis/agent-core']),
    runtimeInstalledAtBoot: new Set(),
    bootRecordLines: {},
    hostLines: new Set(['@neuralis/agent-core', '@neuralis/package-system', 'react']),
    imageRows: () => [{ id: '@neuralis/agent-core', version: '0.3.2', slot: 'image', origin: 'core', status: 'loaded', optional: false }],
    refusedAtBoot: () => undefined,
    builtinDefinitions: () => [{ id: '@neuralis/agent-core', name: '@neuralis/agent-core', access: { trust: 'native' }, configSettings: [{ key: 'agentKey', type: 'string', default: '', description: 'x' }] } as PackageDefinition],
    configKeyOwner: (key) => (key === 'agentKey' ? '@neuralis/agent-core' : key === 'logLevel' ? 'neuralis' : undefined),
    resolveHostPeer: resolveHostDependencyRoot,
    validate: async () => ({ errors: [] }),
    registryUrl: () => 'https://registry.example.test/',
    timeoutMs: () => 120_000,
    uploadMaxBytes: () => 5 * 1024 * 1024,
    npm: recording,
    authorize: async (caller, need) => {
      if (caller.userId !== owner.userId && !(caller.userId === asker.userId && need === 'ask')) throw new PlatformPackageError(403, 'forbidden', 'no');
    },
    audit: (e) => { calls.audit.push(`${e.action}:${e.target ?? ''}`); calls.details.push(e.details); },
    log: (_message, meta) => { calls.log.push(meta); },
    restartMode: 'supervised',
    stopForRestart: () => {},
    ...over,
  });
  const port: TestPort = {
    ...raw,
    request: (caller, ask, via = PERSON) => raw.request(caller, ask, via),
    approve: (caller, id, via = PERSON) => raw.approve(caller, id, via),
    restart: (caller, via = PERSON) => raw.restart(caller, via),
  };
  return { port, appRoot, home, calls };
}

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'resolved';
  } catch (err) {
    return err instanceof PlatformPackageError ? `${err.status}:${err.code}` : `threw:${String(err)}`;
  }
};

describe('request — staged and summarized, nothing of the package runs, nothing is recorded', () => {
  it('an uploaded tarball becomes one pending request naming what it brings, by its sha512', async () => {
    const { port, appRoot } = setup();
    const tgz = tarball(hello());
    const request = await port.request(owner, { tarball: { filename: 'hello.tgz', base64: tgz.base64 } });
    expect(request.action).toBe('install');
    expect(request.summary).toMatchObject({
      id: '@acme/hello', version: '0.1.0', source: 'tarball', routes: ['hello'], tools: ['hello'],
      features: ['hello.read'], defaultRoleGrants: { admin: ['hello.read'] }, configKeys: ['helloGreeting'], peers: ['@neuralis/package-system'], dependencies: [],
    });
    expect(request.summary.integrity).toMatch(/^sha512-/);
    expect(existsSync(join(appRoot, 'packages', 'package.json'))).toBe(false);
    expect((await port.list(owner)).requests.map((r) => r.id)).toEqual([request.id]);
  });

  it('every refusal is named and keeps nothing staged', async () => {
    const { port, appRoot } = setup();
    const cases: Array<[Pkg, string]> = [
      [{ name: '@acme/plain', version: '1.0.0' }, '422:not_a_package'],
      [hello({ neuralis: { referenceOnly: true } }), '422:not_a_package'],
      [hello({ name: '@neuralis/agent-core' }), '409:shipped_with_host'],
      [hello({ dependencies: { '@neuralis/package-system': '^1' } }), '422:brings_own_peer'],
      [hello({ peerDependencies: { '@neuralis/not-in-this-host': '*' } }), '422:peer_unavailable'],
      [hello({ neuralis: { configSettings: [{ key: 'agentKey', type: 'string', default: '', description: 'x' }] } }), '409:conflict'],
      [hello({ neuralis: { configSettings: [{ key: 'logLevel', type: 'string', default: '', description: 'x' }] } }), '409:conflict'],
    ];
    for (const [pkg, expected] of cases) {
      expect(await code(port.request(owner, { tarball: { filename: 'x.tgz', base64: tarball(pkg).base64 } })), pkg.name).toBe(expected);
    }
    expect((await port.list(owner)).requests).toEqual([]);
    expect(existsSync(join(appRoot, 'package-requests')) ? readdirSync(join(appRoot, 'package-requests')) : []).toEqual([]);
  });

  it('a registry name is refused BEFORE any network step while the private-scope record names a scope', async () => {
    const { port, home, calls } = setup();
    mkdirSync(join(home, 'build'), { recursive: true });
    writeFileSync(join(home, 'build', 'private-scopes.json'), JSON.stringify({ scopes: { '@acme': { origins: ['https://npm.acme.test/'], firstSeen: '2026-10-01T00:00:00Z' } } }));
    expect(await code(port.request(owner, { install: '@acme/hello@1.0.0' }))).toBe('409:private_scope_recorded');
    writeFileSync(join(home, 'build', 'private-scopes.json'), '{"scopes": []}');
    expect(await code(port.request(owner, { install: 'left-pad' }))).toBe('409:private_scope_record_unreadable');
    expect(calls.npm).toEqual([]);
  });

  it('only a registry NAME is a spec: no URL, git ref, path or alias reaches npm', async () => {
    for (const spec of ['https://evil.test/x.tgz', 'git+ssh://x', '../x', 'file:x', 'npm:left-pad@1', 'x@github:a/b', '']) {
      expect(parseRegistrySpec(spec), spec).toBeNull();
    }
    expect(parseRegistrySpec('@acme/hello@^1.2')).toEqual({ name: '@acme/hello', range: '^1.2' });
    expect(parseRegistrySpec('left-pad')).toEqual({ name: 'left-pad', range: 'latest' });
    const { port, calls } = setup();
    expect(await code(port.request(owner, { install: 'https://evil.test/x.tgz' }))).toBe('400:bad_spec');
    expect(await code(port.request(owner, { install: 'react' }))).toBe('409:shipped_with_host');
    expect(calls.npm).toEqual([]);
  });

  it('pending requests are bounded and expire', async () => {
    let clock = new Date('2026-10-24T08:00:00Z');
    const { port } = setup({ now: () => clock });
    const base64 = tarball(hello()).base64;
    for (let i = 0; i < MAX_PENDING_REQUESTS; i++) await port.request(owner, { tarball: { filename: 'h.tgz', base64 } });
    expect(await code(port.request(owner, { tarball: { filename: 'h.tgz', base64 } }))).toBe('429:too_many_requests');
    clock = new Date('2026-10-25T08:00:01Z');
    expect((await port.list(owner)).requests).toEqual([]);
    expect(await code(port.request(owner, { tarball: { filename: 'h.tgz', base64 } }))).toBe('resolved');
  });

  it('a caller without platform.packages is refused before anything is read or written', async () => {
    const { port, appRoot, calls } = setup();
    const member = { ...owner, userId: 'u-member', grantedFeatures: [] } as SessionContext;
    for (const call of [port.list(member), port.request(member, { install: 'left-pad' }), port.approve(member, '00000000-0000-4000-8000-000000000000'), port.dismiss(member, 'x'), port.restart(member)]) {
      expect(await code(call)).toBe('403:forbidden');
    }
    expect(calls.npm).toEqual([]);
    expect(existsSync(join(appRoot, 'package-requests'))).toBe(false);
  });
});

describe('approve — the record changes, the restart applies it', () => {
  const realNpm = bundledNpmCli();

  it.skipIf(!realNpm)('installs a tarball with the real npm: exact record line, host-written lock, one kernel instance, discovered at the next start', async () => {
    const { port, appRoot, calls } = setup({}, createNpmRunner(realNpm!));
    const request = await port.request(owner, { tarball: { filename: 'hello.tgz', base64: tarball(hello()).base64 } });
    const started = performance.now();
    const done = await port.approve(owner, request.id);
    const installMs = Math.round(performance.now() - started);
    expect(done).toEqual({ action: 'install', packageId: '@acme/hello', version: '0.1.0', restartRequired: true });
    const root = join(appRoot, 'packages');
    const record = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(record.dependencies).toEqual({ '@acme/hello': 'file:tarballs/acme-hello-0.1.0.tgz' });
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as { packages: Record<string, { integrity?: string }> };
    expect(lock.packages['node_modules/@acme/hello']?.integrity).toBe(request.summary.integrity);
    expect(calls.npm[0]?.slice(0, 3)).toEqual(['install', './tarballs/acme-hello-0.1.0.tgz', '--save-exact']);

    // The peer is a LINK to the host's own kernel — and Node lands on the same module record.
    const peer = join(root, 'node_modules', '@neuralis', 'package-system');
    expect(lstatSync(peer).isSymbolicLink()).toBe(true);
    expect(realpathSync(peer)).toBe(realpathSync(resolveHostDependencyRoot('@neuralis/package-system')));
    const probe = spawnSync(process.execPath, ['--input-type=module', '-e', [
      `const a = await import(${JSON.stringify(pathToFileURL(join(root, 'node_modules', '@acme', 'hello', 'dist', 'src', 'probe.js')).href)});`,
      `const b = await import(${JSON.stringify(pathToFileURL(join(realpathSync(resolveHostDependencyRoot('@neuralis/package-system')), 'dist', 'src', 'contracts', 'index.js')).href)});`,
      'process.stdout.write(String(a.kernel.providedFeatureIds === b.providedFeatureIds));',
    ].join('\n')], { encoding: 'utf8' });
    expect(probe.stdout).toBe('true');

    // The next start's discovery: the record entry is a builtin with its own root.
    const recordRequire = (name: string): string => join(root, 'node_modules', name, 'package.json');
    const next = discoverBuiltinRoots({
      hostLines: { '@neuralis/agent-core': '*' },
      recordLines: record.dependencies,
      resolveHost: () => { throw new Error('not in this fixture'); },
      resolveRecord: recordRequire,
      readManifest: (path) => JSON.parse(readFileSync(path, 'utf8')),
    });
    expect([...next.runtimeInstalled]).toEqual(['@acme/hello']);
    expect(realpathSync(next.roots.get('@acme/hello')!)).toBe(realpathSync(join(root, 'node_modules', '@acme', 'hello')));
    // The definition the loader gets carries BOTH host-stamped halves of the
    // code-import gate, though the tarball's manifest declares no `source`.
    const [definition] = await readBuiltinManifests(new Map([['@acme/hello', next.roots.get('@acme/hello')!]]));
    expect(definition).toMatchObject({ id: '@acme/hello', source: { kind: 'neuralis' }, access: { trust: 'native' } });

    // The grant record carries the addition for the next boot; the view says a restart applies it.
    const changes = JSON.parse(readFileSync(join(appRoot, BUILTIN_GRANT_CHANGES_FILE), 'utf8')) as { additions: Array<{ packageId: string }> };
    expect(changes.additions.map((a) => a.packageId)).toEqual(['@acme/hello']);
    const view = await port.list(owner);
    expect(view).toMatchObject({ restartRequired: true, requests: [] });
    expect(view.installed.find((r) => r.id === '@acme/hello')).toMatchObject({ version: '0.1.0', slot: 'runtime', source: 'tarball', status: 'restart' });
    expect(installMs).toBeLessThan(30_000);
  }, 60_000);

  it.skipIf(!realNpm)('remove: the line goes now, the files at the next npm run, and the next boot revokes its default grants', async () => {
    const { port, appRoot } = setup({}, createNpmRunner(realNpm!));
    await port.approve(owner, (await port.request(owner, { tarball: { filename: 'hello.tgz', base64: tarball(hello()).base64 } })).id);
    rmSync(join(appRoot, BUILTIN_GRANT_CHANGES_FILE));
    const removal = await port.request(owner, { remove: '@acme/hello' });
    expect(removal).toMatchObject({ action: 'remove', summary: { id: '@acme/hello', features: ['hello.read'] } });
    expect(await port.approve(owner, removal.id)).toMatchObject({ action: 'remove', packageId: '@acme/hello' });
    const root = join(appRoot, 'packages');
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies).toEqual({});
    expect(existsSync(join(root, 'tarballs', 'acme-hello-0.1.0.tgz'))).toBe(false);
    const changes = JSON.parse(readFileSync(join(appRoot, BUILTIN_GRANT_CHANGES_FILE), 'utf8')) as { removals: Array<{ packageId: string; features: string[] }> };
    expect(changes.removals).toEqual([expect.objectContaining({ packageId: '@acme/hello', features: ['hello.read'] })]);
    // What the next boot does with that row: the admin role loses the feature nobody else provides.
    const patch = revokeGrantsPatch({ id: 'p1', roles: { admin: { grantedFeatures: ['hello.read', 'project.members'], priority: 2 } } } as never, '@acme/hello', new Set(changes.removals[0]!.features));
    expect(patch?.roles?.admin?.grantedFeatures).toEqual(['project.members']);
  }, 60_000);

  it('npm installing other bytes, a shared-peer copy in the lock, or a validator refusal restores the record exactly', async () => {
    for (const [behaviour, expected] of [['other-version', '409:integrity_mismatch'], ['own-react', '422:brings_own_peer'], ['validator', '422:refused_by_validator'], ['npm-fails', '502:npm_failed'], ['hidden-manifest', '422:not_discoverable']] as const) {
      const fakeNpm: NpmRunner = async (args, opts) => {
        if (args[0] !== 'install' || args.length === 2) return { code: 0, stdout: '', stderr: '', ms: 1, timedOut: false };
        if (behaviour === 'npm-fails') return { code: 1, stdout: '', stderr: 'npm error E404\nnpm error A complete log of this run can be found in: /tmp/nrs-npm-x/_logs/debug.log', ms: 1, timedOut: false };
        const dir = join(opts.cwd, 'node_modules', '@acme', 'hello');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/hello', version: behaviour === 'other-version' ? '6.6.6' : '0.1.0', ...(behaviour === 'hidden-manifest' ? { exports: { '.': './index.js' } } : {}) }));
        writeFileSync(join(opts.cwd, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@acme/hello': {}, ...(behaviour === 'own-react' ? { 'node_modules/@acme/hello/node_modules/react': {} } : {}) } }));
        writeFileSync(join(opts.cwd, 'package.json'), JSON.stringify({ dependencies: { '@acme/hello': 'file:tarballs/x.tgz' } }));
        return { code: 0, stdout: '', stderr: '', ms: 1, timedOut: false };
      };
      const { port, appRoot, calls } = setup(behaviour === 'validator' ? { validate: async () => ({ errors: ['tools/hello.json: category is required'] }) } : {}, fakeNpm);
      const request = await port.request(owner, { tarball: { filename: 'h.tgz', base64: tarball(hello({ peerDependencies: { '@neuralis/package-system': '*', react: '*' } })).base64 } });
      expect(await code(port.approve(owner, request.id)), behaviour).toBe(expected);
      if (behaviour === 'npm-fails') {
        // npm's output names host paths: it goes to the host log, the answer says where to look.
        const message = await port.approve(owner, request.id).catch((err: Error) => err.message);
        expect(message).toBe("npm could not install @acme/hello. The host log has npm's output.");
        expect(JSON.stringify(calls.log)).toContain('/tmp/nrs-npm-x/_logs/debug.log');
      }
      // The first install made the record; its refusal leaves the folder as it found it — without one.
      expect(existsSync(join(appRoot, 'packages', 'package.json')), behaviour).toBe(false);
      expect(existsSync(join(appRoot, 'packages', 'package-lock.json')), behaviour).toBe(false);
      expect(existsSync(join(appRoot, BUILTIN_GRANT_CHANGES_FILE)), behaviour).toBe(false);
      expect(calls.audit.filter((a) => a.startsWith('package.install')), behaviour).toEqual([]);
      // The request survives a failed approval: the person may retry or dismiss it.
      expect((await port.list(owner)).requests.map((r) => r.id), behaviour).toEqual([request.id]);
    }
  });

  it('the approved bytes are proved or nothing is installed: a registry lock without integrity and a changed staged tarball both refuse', async () => {
    const tgz = tarball(hello());
    const fakeNpm = (lockEntry: Record<string, unknown>): NpmRunner => async (args, opts) => {
      if (args[0] === 'pack') {
        writeFileSync(join(opts.cwd, 'acme-hello-0.1.0.tgz'), readFileSync(tgz.path));
        return { code: 0, stdout: JSON.stringify([{ filename: 'acme-hello-0.1.0.tgz' }]), stderr: '', ms: 1, timedOut: false };
      }
      if (args[0] !== 'install' || args.length === 2) return { code: 0, stdout: '', stderr: '', ms: 1, timedOut: false };
      const dir = join(opts.cwd, 'node_modules', '@acme', 'hello');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/hello', version: '0.1.0' }));
      writeFileSync(join(opts.cwd, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@acme/hello': lockEntry } }));
      return { code: 0, stdout: '', stderr: '', ms: 1, timedOut: false };
    };

    // Registry: the summary names the registry that served it; npm writing no integrity fails closed.
    const registry = setup({}, fakeNpm({}));
    const asked = await registry.port.request(owner, { install: '@acme/hello@0.1.0' });
    expect(asked.summary).toMatchObject({ source: 'registry', registry: 'https://registry.example.test/' });
    expect(await code(registry.port.approve(owner, asked.id))).toBe('409:integrity_unverifiable');

    // The registry setting moved between the ask and the approval: named as such, before npm runs.
    let current = 'https://registry.example.test/';
    const moved = setup({ registryUrl: () => current }, fakeNpm({}));
    const pending = await moved.port.request(owner, { install: '@acme/hello@0.1.0' });
    current = 'https://other.example.test/';
    const installsBefore = moved.calls.npm.filter((a) => a[0] === 'install').length;
    expect(await code(moved.port.approve(owner, pending.id))).toBe('409:registry_changed');
    expect(moved.calls.npm.filter((a) => a[0] === 'install').length).toBe(installsBefore);
    expect(existsSync(join(registry.appRoot, 'packages', 'package.json'))).toBe(false);
    expect(existsSync(join(registry.appRoot, BUILTIN_GRANT_CHANGES_FILE))).toBe(false);

    // Tarball: the staged copy is the approved bytes, or npm is never asked.
    const upload = setup({}, fakeNpm({}));
    const staged = await upload.port.request(owner, { tarball: { filename: 'hello.tgz', base64: tgz.base64 } });
    expect(staged.summary.registry).toBeUndefined();
    writeFileSync(join(upload.appRoot, 'package-requests', staged.id, 'package.tgz'), readFileSync(tarball(hello({ files: { 'README.md': 'other bytes' } })).path));
    expect(await code(upload.port.approve(owner, staged.id))).toBe('409:integrity_mismatch');
    expect(upload.calls.npm.filter((a) => a[0] === 'install' && a.length > 2)).toEqual([]);
    expect(existsSync(join(upload.appRoot, 'packages', 'tarballs', 'acme-hello-0.1.0.tgz'))).toBe(false);

    // A re-install of the same id@version with other bytes leaves the recorded tarball as it was.
    const recorded = join(upload.appRoot, 'packages', 'tarballs', 'acme-hello-0.1.0.tgz');
    mkdirSync(join(upload.appRoot, 'packages', 'tarballs'), { recursive: true });
    writeFileSync(recorded, 'the recorded bytes');
    expect(await code(upload.port.approve(owner, staged.id))).toBe('409:integrity_mismatch');
    expect(readFileSync(recorded, 'utf8')).toBe('the recorded bytes');
  });

  it('an UPDATE of an active package is not its own shared peer; a package listing ITSELF still is refused', async () => {
    const fakeNpm: NpmRunner = async (args, opts) => {
      if (args[0] !== 'install' || args.length === 2) return { code: 0, stdout: '', stderr: '', ms: 1, timedOut: false };
      const dir = join(opts.cwd, 'node_modules', '@acme', 'hello');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/hello', version: '0.1.0' }));
      writeFileSync(join(opts.cwd, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@acme/hello': {} } }));
      return { code: 0, stdout: '', stderr: '', ms: 1, timedOut: false };
    };
    // `@acme/hello` is loaded right now (an earlier install, active since the last start).
    const { port } = setup({ activeIds: new Set(['@neuralis/agent-core', '@acme/hello']) }, fakeNpm);
    const request = await port.request(owner, { tarball: { filename: 'h.tgz', base64: tarball(hello()).base64 } });
    expect(await code(port.approve(owner, request.id))).toBe('resolved');

    const self = setup({}, fakeNpm);
    const listsItself = tarball(hello({ dependencies: { '@acme/hello': '0.1.0' } })).base64;
    expect(await code(self.port.request(owner, { tarball: { filename: 'h.tgz', base64: listsItself } }))).toBe('422:brings_own_peer');
  });

  it('restart: refused where nothing would start the host again; otherwise the host stops itself after answering', async () => {
    expect(await code(setup({ restartMode: 'manual' }).port.restart(owner))).toBe('409:restart_unsupervised');
    let stopped = 0;
    const { port } = setup({ restartMode: 'docker', stopForRestart: () => { stopped += 1; } });
    expect(await port.restart(owner)).toEqual({ restart: 'docker' });
    expect(stopped).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(stopped).toBe(1);
  });
});

describe('who approves — the feature, never the channel', () => {
  const quietNpm: NpmRunner = async (args, opts) => {
    if (args[0] !== 'install' || args.length === 2) return { code: 0, stdout: '', stderr: '', ms: 1, timedOut: false };
    const dir = join(opts.cwd, 'node_modules', '@acme', 'hello');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/hello', version: '0.1.0' }));
    writeFileSync(join(opts.cwd, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@acme/hello': {} } }));
    return { code: 0, stdout: '', stderr: '', ms: 1, timedOut: false };
  };

  it('without platform.packages.approve: an unknown id is a 404 BEFORE the 403, a real one a 403, and restart a 403 — npm never runs', async () => {
    const { port, calls } = setup({}, quietNpm);
    const request = await port.request(asker, { tarball: { filename: 'h.tgz', base64: tarball(hello()).base64 } });
    expect(await code(port.approve(asker, '00000000-0000-4000-8000-000000000000'))).toBe('404:request_not_found');
    expect(await code(port.approve(asker, request.id))).toBe('403:forbidden');
    expect(await code(port.restart(asker))).toBe('403:forbidden');
    expect(calls.npm.filter((a) => a[0] === 'install')).toEqual([]);
    // Dismissing stays the asker's: closing an ask is a revoke.
    expect(await port.dismiss(asker, request.id)).toBe(true);
  });

  it('an agent holding the feature approves; the request and every audit row carry the channel and the agent', async () => {
    const { port, calls } = setup({}, quietNpm);
    const agent: PlatformPackageProvenance = { interactive: false, agentId: 'agent-7' };
    const request = await port.request(owner, { tarball: { filename: 'h.tgz', base64: tarball(hello()).base64 } }, agent);
    expect(request).toMatchObject({ via: 'agent', agent: { id: 'agent-7', projectId: 'p1' }, requestedBy: 'u-owner' });
    expect(await port.approve(owner, request.id, agent)).toMatchObject({ action: 'install', packageId: '@acme/hello' });
    await port.restart(owner, { interactive: false });
    const byAction = (action: string): Record<string, unknown> | undefined => calls.details[calls.audit.findIndex((a) => a.startsWith(action))];
    expect(byAction('package.request')).toMatchObject({ via: 'agent', agentId: 'agent-7' });
    expect(byAction('package.install')).toMatchObject({ via: 'agent', agentId: 'agent-7' });
    expect(byAction('package.restart')).toEqual({ restart: 'supervised', via: 'cli' });
    // A person's call names no agent, whatever the session carries.
    const person = await port.request(owner, { tarball: { filename: 'h.tgz', base64: tarball(hello()).base64 } }, { interactive: true });
    expect(person.via).toBe('person');
    expect(person.agent).toBeUndefined();
  });
});

describe('the operator allow-list and the build source', () => {
  const packing = (tgz: string, view: { code: number; stdout: string }): NpmRunner => async (args, opts) => {
    if (args[0] === 'pack') {
      writeFileSync(join(opts.cwd, 'acme-hello-0.1.0.tgz'), readFileSync(tgz));
      return { code: 0, stdout: JSON.stringify([{ filename: 'acme-hello-0.1.0.tgz' }]), stderr: '', ms: 1, timedOut: false };
    }
    if (args[0] === 'view') return { ...view, stderr: '', ms: 1, timedOut: false };
    return { code: 1, stdout: '', stderr: 'unexpected', ms: 1, timedOut: false };
  };
  const allowList = (appRoot: string, text: string): void => {
    mkdirSync(join(appRoot, 'packages'), { recursive: true });
    writeFileSync(join(appRoot, 'packages', 'allow-list.json'), text);
  };

  it('a name the allow-list leaves out is refused BEFORE any network step — registry name and uploaded tarball alike', async () => {
    const tgz = tarball(hello());
    const { port, appRoot, calls } = setup({}, packing(tgz.path, { code: 0, stdout: '{}' }));
    allowList(appRoot, '["@other", "left-pad"]');
    expect(await code(port.request(owner, { install: '@acme/hello@0.1.0' }))).toBe('403:not_allowed');
    expect(await code(port.request(owner, { tarball: { filename: 'h.tgz', base64: tgz.base64 } }))).toBe('403:not_allowed');
    expect(calls.npm).toEqual([]);
    allowList(appRoot, '{"packages": "@acme"}');
    expect(await code(port.request(owner, { install: '@acme/hello@0.1.0' }))).toBe('409:allow_list_unreadable');
    expect(calls.npm).toEqual([]);
    // The paired control: the same ask with the scope listed reaches npm.
    allowList(appRoot, '["@acme"]');
    expect(await code(port.request(owner, { install: '@acme/hello@0.1.0' }))).toBe('resolved');
    expect(calls.npm.map((a) => a[0])).toEqual(['pack', 'view']);
  });

  it('an approval is judged against the allow-list again before npm runs', async () => {
    const { port, appRoot, calls } = setup({}, async () => ({ code: 0, stdout: '', stderr: '', ms: 1, timedOut: false }));
    const request = await port.request(owner, { tarball: { filename: 'h.tgz', base64: tarball(hello()).base64 } });
    allowList(appRoot, '["@other"]');
    expect(await code(port.approve(owner, request.id))).toBe('403:not_allowed');
    expect(calls.npm.filter((a) => a[0] === 'install')).toEqual([]);
  });

  it('allowListAdmits: a scope, an exact name, nothing else; an empty list admits every name', () => {
    expect(allowListAdmits(['@acme'], '@acme/hello')).toBe(true);
    expect(allowListAdmits(['@acme'], '@acmex/hello')).toBe(false);
    expect(allowListAdmits(['@acme/hello'], '@acme/other')).toBe(false);
    expect(allowListAdmits(['left-pad'], 'left-pad')).toBe(true);
    expect(allowListAdmits(['left'], 'left-pad')).toBe(false);
    expect(allowListAdmits([], 'anything')).toBe(true);
  });

  it('the summary says whether the registry attests the build; no attestation is a label, never a refusal', async () => {
    const tgz = tarball(hello());
    const attested = setup({}, packing(tgz.path, { code: 0, stdout: JSON.stringify({ integrity: 'x', attestations: { url: 'https://registry.example.test/-/npm/v1/attestations/@acme/hello@0.1.0', provenance: { predicateType: 'https://slsa.dev/provenance/v1' } } }) }));
    expect((await attested.port.request(owner, { install: '@acme/hello@0.1.0' })).summary.provenance).toBe('attested');
    expect(attested.calls.npm[1]).toEqual(['view', '@acme/hello@0.1.0', 'dist', '--json']);
    const none = setup({}, packing(tgz.path, { code: 0, stdout: JSON.stringify({ integrity: 'x' }) }));
    expect((await none.port.request(owner, { install: '@acme/hello@0.1.0' })).summary.provenance).toBe('none');
    const unreachable = setup({}, packing(tgz.path, { code: 1, stdout: '' }));
    expect((await unreachable.port.request(owner, { install: '@acme/hello@0.1.0' })).summary.provenance).toBe('none');
    const upload = setup();
    expect((await upload.port.request(owner, { tarball: { filename: 'h.tgz', base64: tgz.base64 } })).summary.provenance).toBe('none');
    expect(upload.calls.npm).toEqual([]);
  });
});

describe('list — every package the host knows, in one list', () => {
  it('the host\'s own rows from boot memory beside the record\'s, each with its slot and this start\'s status', async () => {
    const quiet: NpmRunner = async (args, opts) => {
      if (args[0] !== 'install' || args.length === 2) return { code: 0, stdout: '', stderr: '', ms: 1, timedOut: false };
      const dir = join(opts.cwd, 'node_modules', '@acme', 'hello');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@acme/hello', version: '0.1.0' }));
      writeFileSync(join(opts.cwd, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@acme/hello': {} } }));
      writeFileSync(join(opts.cwd, 'package.json'), JSON.stringify({ dependencies: { '@acme/hello': 'file:tarballs/acme-hello-0.1.0.tgz' } }));
      return { code: 0, stdout: '', stderr: '', ms: 1, timedOut: false };
    };
    const { port } = setup({}, quiet);
    await port.approve(owner, (await port.request(owner, { tarball: { filename: 'h.tgz', base64: tarball(hello()).base64 } })).id);
    const view = await port.list(owner);
    expect(view.installed.map((r) => [r.id, r.slot, r.origin, r.status])).toEqual([
      ['@acme/hello', 'runtime', undefined, 'restart'],
      ['@neuralis/agent-core', 'image', 'core', 'loaded'],
    ]);
  });
});

describe('imageOrigin — core ships with the release, operator was added to this install', () => {
  it('reads the release pin, the workspace link and the operator root', () => {
    const none = new Set<string>();
    expect(imageOrigin('@neuralis/admin', '0.3.2', '0.3.2', none)).toBe('core');
    expect(imageOrigin('@neuralis/admin', 'workspace:*', '0.3.2', none)).toBe('core');
    // A local folder or tarball line, a registry `pkg add` line, another scope at the release version.
    expect(imageOrigin('@neuralis/extra', 'file:/srv/extra', '0.3.2', none)).toBe('operator');
    expect(imageOrigin('@acme/tool', '1.4.0', '0.3.2', none)).toBe('operator');
    expect(imageOrigin('@acme/tool', '0.3.2', '0.3.2', none)).toBe('operator');
    // The npm install folder's derived image lists its own under `_operator/`.
    expect(imageOrigin('@neuralis/admin', '0.3.2', '0.3.2', new Set(['@neuralis/admin']))).toBe('operator');
  });
});
