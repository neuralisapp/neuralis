/**
 * `neuralis:upgrade` — the offline upgrade command, on a throwaway home. Fake
 * modules (written as files, discovered like the real ones) pin the apply
 * ORDER: refusal while the app runs, the checkpoint before the first ledger
 * write, `state: 'upgrading'` cleared LAST, resume after an interruption with
 * no new checkpoint, and a completed run writing nothing. The real modules are
 * pinned against the kinds the loaded code declares.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  claimDeclared,
  declareDataFormats,
  createCheckpoint,
  listCheckpoints,
  listDataFormatDeclarations,
  markDataFormatUpgrade,
  readDataFormatLedger,
  resetDataFormatsForTesting,
} from '@neuralis/package-system/data';
import { checkpointKeep, loadUpgradeModules, runUpgrade, UPGRADES_DIR, type UpgradeOptions } from '../upgrade.mts';

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

type Calls = { applied: string[]; failOnce: boolean; blocked?: boolean; seen: Array<{ state?: string; checkpoints: number }> };
const CALLS = Symbol.for('neuralis-upgrade-test-calls');
const calls = (): Calls => (globalThis as unknown as Record<symbol, Calls>)[CALLS]!;

/** A home with one record and a ledger one offline kind behind, plus a module directory. */
function fixture(): { opts: UpgradeOptions; ledgerFile: string; logs: string[] } {
  const home = mkdtempSync(join(tmpdir(), 'nrs-upgrade-'));
  dirs.push(home);
  const appRoot = join(home, 'app');
  mkdirSync(join(appRoot, 'config'), { recursive: true });
  mkdirSync(join(appRoot, 'alpha'), { recursive: true });
  writeFileSync(join(appRoot, 'alpha', 'r1.json'), '{"v":1}');
  const ledgerFile = join(appRoot, 'config', 'data-formats.json');
  writeFileSync(ledgerFile, JSON.stringify({ 'test/alpha': { version: 1, raisedAt: 'x' }, 'test/plain': { version: 1, raisedAt: 'x' } }));
  const modulesDir = join(home, 'upgrades');
  mkdirSync(modulesDir);
  writeFileSync(join(modulesDir, 'alpha-v2.mts'), `
    import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
    import { join } from 'node:path';
    const calls = () => globalThis[Symbol.for('neuralis-upgrade-test-calls')];
    export default {
      id: 'alpha-v2',
      kinds: [{ kind: 'test/alpha', to: 2 }],
      async dryRun(ctx) {
        const blockers = calls().blocked ? { blockers: { lines: ['main · agent · a.json · config.packages.overrides · ghost · unresolved'], remedy: 'resolve it first' } } : {};
        return { files: ['app/alpha'], summary: ['1 record'], ...blockers };
      },
      async apply(ctx) {
        const ledger = JSON.parse(readFileSync(join(ctx.appRoot, 'config', 'data-formats.json'), 'utf8'));
        calls().seen.push({ state: ledger['test/alpha'].state, checkpoints: readdirSync(join(ctx.home, 'checkpoints')).length });
        const file = join(ctx.appRoot, 'alpha', 'r1.json');
        if (readFileSync(file, 'utf8') !== '{"v":2}') writeFileSync(file, '{"v":2}');
        if (calls().failOnce) { calls().failOnce = false; throw new Error('interrupted mid-apply'); }
        calls().applied.push('alpha-v2');
      },
    };
  `);
  const logs: string[] = [];
  return {
    ledgerFile,
    logs,
    opts: {
      apply: false,
      modulesDir,
      roots: { home, appRoot, projectsRoot: join(home, 'projects') },
      offline: async () => ({ offline: true }),
      log: (line) => logs.push(line),
    },
  };
}

function homeFiles(root: string): Map<string, string> {
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

describe('neuralis:upgrade — the offline apply order', () => {
  beforeEach(() => {
    resetDataFormatsForTesting();
    declareDataFormats([
      { kind: 'test/alpha', version: 2, files: ['app/alpha'], upgrade: { mode: 'offline', id: 'alpha-v2' } },
      { kind: 'test/plain', version: 1 },
    ]);
    (globalThis as unknown as Record<symbol, Calls>)[CALLS] = { applied: [], failOnce: false, seen: [] };
  });

  it('refuses while the app runs and a dry run writes nothing', async () => {
    const f = fixture();
    const before = homeFiles(f.opts.roots.home);
    await expect(runUpgrade({ ...f.opts, offline: async () => ({ offline: false, reason: 'the app answers on http://127.0.0.1:3100/api/health' }) }))
      .rejects.toThrow(/Refusing to upgrade: the app answers/);
    await expect(runUpgrade({ ...f.opts, apply: true, offline: async () => ({ offline: false, reason: 'x' }) })).rejects.toThrow(/Refusing/);
    const outcome = await runUpgrade(f.opts);
    expect(outcome).toEqual({ pending: ['test/alpha'], applied: false });
    expect(f.logs.join('\n')).toContain('Dry run');
    expect(homeFiles(f.opts.roots.home)).toEqual(before);
  });

  it('a failed checkpoint leaves the ledger untouched: the manifest is durable before the first ledger write', async () => {
    const f = fixture();
    writeFileSync(join(f.opts.roots.home, 'checkpoints'), 'not a directory');
    const ledger = readFileSync(f.ledgerFile, 'utf8');
    await expect(runUpgrade({ ...f.opts, apply: true })).rejects.toThrow();
    expect(readFileSync(f.ledgerFile, 'utf8')).toBe(ledger);
    expect(calls().seen).toEqual([]);
  });

  it('apply: checkpoint → upgrading → module → cleared LAST; an interruption resumes without a new checkpoint; a completed run writes nothing', async () => {
    const f = fixture();
    calls().failOnce = true;
    await expect(runUpgrade({ ...f.opts, apply: true })).rejects.toThrow('interrupted mid-apply');
    expect(calls().seen).toEqual([{ state: 'upgrading', checkpoints: 1 }]);
    expect((await readDataFormatLedger(f.opts.roots.appRoot))['test/alpha']).toMatchObject({ version: 2, state: 'upgrading' });
    // The app refuses to start over a half-done upgrade.
    await expect(claimDeclared({ home: f.opts.roots.home, appRoot: f.opts.roots.appRoot })).rejects.toMatchObject({ reason: 'upgrade_required' });

    const resumed = await runUpgrade({ ...f.opts, apply: true });
    expect(resumed.checkpoint).toBeUndefined();
    expect(calls().applied).toEqual(['alpha-v2']);
    expect(calls().seen[1]).toEqual({ state: 'upgrading', checkpoints: 1 });
    const ledger = await readDataFormatLedger(f.opts.roots.appRoot);
    expect(ledger['test/alpha']).toEqual({ version: 2, raisedAt: expect.any(String) });
    expect(ledger['test/plain']).toEqual({ version: 1, raisedAt: 'x' });
    const [checkpoint] = await listCheckpoints(f.opts.roots.home);
    expect(readFileSync(join(f.opts.roots.home, 'checkpoints', checkpoint!.id, 'app', 'alpha', 'r1.json'), 'utf8')).toBe('{"v":1}');
    expect(JSON.parse(readFileSync(join(f.opts.roots.home, 'checkpoints', checkpoint!.id, 'app', 'config', 'data-formats.json'), 'utf8'))['test/alpha'].version).toBe(1);

    const done = homeFiles(f.opts.roots.home);
    expect(await runUpgrade({ ...f.opts, apply: true })).toEqual({ pending: [], applied: false });
    expect(homeFiles(f.opts.roots.home)).toEqual(done);
    expect((await claimDeclared({ home: f.opts.roots.home, appRoot: f.opts.roots.appRoot })).unchanged.sort()).toEqual(['test/alpha', 'test/plain']);
  });

  it('a completed apply keeps dataCheckpointKeep checkpoints, newest first; without the setting nothing is pruned', async () => {
    const f = fixture();
    for (const label of ['old-a', 'old-b']) await createCheckpoint(f.opts.roots.home, { label, files: ['app/alpha'] });
    await runUpgrade({ ...f.opts, apply: true, keepCheckpoints: 2 });
    const kept = await listCheckpoints(f.opts.roots.home);
    expect(kept.map((cp) => cp.label)).toEqual(['upgrade-alpha-v2', 'old-b']);
    expect(f.logs).toContain('Pruned 1 older checkpoint(s) (dataCheckpointKeep 2).');
    // The setting's bounds and default are the host's declaration.
    expect(checkpointKeep({ dataCheckpointKeep: 3 })).toBe(3);
    expect(checkpointKeep({})).toBe(5);
    expect(checkpointKeep({ dataCheckpointKeep: 0 })).toBe(5);
    expect(checkpointKeep({ dataCheckpointKeep: '3' })).toBe(5);
  });

  it('a blocker is LISTED by the dry run (exit 1) and refuses the apply before its checkpoint — never a bare sentence', async () => {
    const f = fixture();
    calls().blocked = true;
    const before = homeFiles(f.opts.roots.home);
    for (const apply of [false, true]) {
      await expect(runUpgrade({ ...f.opts, apply })).rejects.toThrow('1 blocking item(s) above: resolve it first.');
    }
    expect(f.logs).toContain('  alpha-v2: main · agent · a.json · config.packages.overrides · ghost · unresolved');
    expect(calls().seen).toEqual([]);
    expect(homeFiles(f.opts.roots.home)).toEqual(before);
  });

  it('a ledger entry NEWER than the code is refused by name, never reported as nothing to upgrade', async () => {
    const f = fixture();
    resetDataFormatsForTesting();
    declareDataFormats([{ kind: 'test/alpha', version: 2, upgrade: { mode: 'offline', id: 'alpha-v2' } }]);
    writeFileSync(f.ledgerFile, JSON.stringify({ 'test/alpha': { version: 3, raisedAt: 'x' }, 'test/plain': { version: 1, raisedAt: 'x' } }));
    await expect(runUpgrade({ ...f.opts, apply: false })).rejects.toThrow(/test\/alpha is at v3 on disk but this build reads v2/);
    expect(calls().seen).toEqual([]);
  });

  it('a NEW offline kind absent from an EXISTING ledger is pending from v0 and runs; on a fresh install (no ledger file) nothing is pending', async () => {
    const f = fixture();
    declareDataFormats([{ kind: 'test/zone', version: 1, upgrade: { mode: 'offline', id: 'zone-v1' } }]);
    writeFileSync(join(f.opts.modulesDir, 'zone-v1.mts'), `
      const calls = () => globalThis[Symbol.for('neuralis-upgrade-test-calls')];
      export default { id: 'zone-v1', kinds: [{ kind: 'test/zone', to: 1 }],
        async dryRun() { return { files: [], summary: ['zones'] }; },
        async apply() { calls().applied.push('zone-v1'); } };
    `);
    writeFileSync(f.ledgerFile, JSON.stringify({ 'test/alpha': { version: 2, raisedAt: 'x' }, 'test/plain': { version: 1, raisedAt: 'x' } }));
    expect(await runUpgrade({ ...f.opts, apply: true })).toMatchObject({ pending: ['test/zone'], applied: true });
    expect(calls().applied).toEqual(['zone-v1']);
    expect((await readDataFormatLedger(f.opts.roots.appRoot))['test/zone']).toEqual({ version: 1, raisedAt: expect.any(String) });

    // PAIRED CONTROL — the same declarations and modules over a home with no ledger file.
    rmSync(f.ledgerFile);
    const before = homeFiles(f.opts.roots.home);
    expect(await runUpgrade({ ...f.opts, apply: true })).toEqual({ pending: [], applied: false });
    expect(calls().applied).toEqual(['zone-v1']);
    expect(homeFiles(f.opts.roots.home)).toEqual(before);
  });

  it('a module whose kind or version the loaded code does not declare is refused before anything runs', async () => {
    const f = fixture();
    resetDataFormatsForTesting();
    declareDataFormats([{ kind: 'test/alpha', version: 3, upgrade: { mode: 'offline', id: 'alpha-v2' } }]);
    await expect(runUpgrade({ ...f.opts, apply: true })).rejects.toThrow(/raises test\/alpha to v2, but this build declares v3/);
    expect(calls().seen).toEqual([]);
  });
});

// Loading the real modules evaluates the host, agent-core and brain-core module graphs.
describe('the shipped upgrade modules', { timeout: 60_000 }, () => {
  it('own exactly the offline kinds the host, agent-core and brain-core declare, at their code versions', async () => {
    resetDataFormatsForTesting();
    const modules = await loadUpgradeModules(UPGRADES_DIR);
    const declared = listDataFormatDeclarations()
      .filter((decl) => decl.upgrade)
      .map((decl) => ({ id: decl.upgrade!.id, kind: decl.kind, to: decl.version }))
      .sort((a, b) => a.kind.localeCompare(b.kind));
    const shipped = modules
      .flatMap(({ module }) => module.kinds.map((k) => ({ id: module.id, kind: k.kind, to: k.to })))
      .sort((a, b) => a.kind.localeCompare(b.kind));
    expect(shipped).toEqual(declared);
    expect(new Set(declared.map((row) => row.kind))).toEqual(new Set([
      'neuralis/project', 'agent-core/agent', 'agent-core/workflow-entry', 'agent-core/conversation-meta',
      'agent-core/pending-interactions', 'agent-core/delegate-run', 'brain-core/source-config', 'brain-core/embedding-lock',
      'agent-core/package-data-zone', 'agent-core/conversation-summary', 'brain-core/vector-proof', 'neuralis/credential',
    ]));
    // The zone module sorts AFTER the identity module: it moves the zones that one writes.
    expect(modules.map(({ file }) => file).indexOf('package-zone-v1.mts')).toBeGreaterThan(modules.map(({ file }) => file).indexOf('package-identity-v2.mts'));
  });

  it('package-identity-v2 dry-runs a stopped install read-only', async () => {
    const home = mkdtempSync(join(tmpdir(), 'nrs-upgrade-real-'));
    dirs.push(home);
    const roots = { home, appRoot: join(home, 'app'), projectsRoot: join(home, 'projects') };
    mkdirSync(join(roots.appRoot, 'projects'), { recursive: true });
    writeFileSync(join(roots.appRoot, 'projects', 'main.json'), JSON.stringify({ id: 'main', packageTrust: {} }));
    mkdirSync(join(roots.projectsRoot, 'main', '_packages'), { recursive: true });
    const module = (await loadUpgradeModules(UPGRADES_DIR)).find(({ module }) => module.id === 'package-identity-v2')!.module;
    const before = homeFiles(home);
    const plan = await module.dryRun({ ...roots, log: () => {} });
    expect(plan.files).toEqual(expect.arrayContaining(['app/projects', 'app/config/sources']));
    expect(plan.summary[0]).toContain('1 project(s)');
    expect(homeFiles(home)).toEqual(before);
  });

  // The live interruption: lock module applied (v3), every kind `upgrading`, the zone journal written, then the
  // identity module stopped before its first record write. Re-running `--apply` resumes WITHOUT a new checkpoint,
  // merges the identical bare + legacy keys, stamps the records and clears `upgrading` LAST.
  it('resumes the interrupted live state: no new checkpoint, identical colliding keys merge, upgrading cleared', async () => {
    const { createPackageIdentityUpgrade } = await import('../upgrades/package-identity-v2.mts');
    const { packageInstanceId } = await import('@neuralis/package-system/contracts');
    const home = mkdtempSync(join(tmpdir(), 'nrs-upgrade-resume-'));
    dirs.push(home);
    const roots = { home, appRoot: join(home, 'app'), projectsRoot: join(home, 'projects') };
    const legacy = 'p.main.project.sample';
    mkdirSync(join(roots.appRoot, 'projects'), { recursive: true });
    writeFileSync(join(roots.appRoot, 'projects', 'main.json'), JSON.stringify({ id: 'main', packageTrust: { sample: 'trusted', [legacy]: 'trusted' } }));
    const agentFile = join(roots.projectsRoot, 'main', 'data', 'agent-core', 'a1', 'a1.json');
    mkdirSync(dirname(agentFile), { recursive: true });
    writeFileSync(agentFile, JSON.stringify({ id: 'a1', config: { packages: { overrides: { sample: { enabled: false }, [legacy]: { enabled: false } } } } }));
    mkdirSync(join(roots.projectsRoot, 'main', '_packages', 'sample'), { recursive: true });
    writeFileSync(join(roots.projectsRoot, 'main', '_packages', 'sample', 'package.json'), JSON.stringify({ name: 'sample', version: '0.1.0', neuralis: { id: 'sample', name: 'sample', version: '0.1.0', description: 'fixture' } }));
    mkdirSync(join(roots.projectsRoot, 'main', 'data', '_installed', 'sample'), { recursive: true });
    writeFileSync(join(roots.projectsRoot, 'main', 'data', '_installed', 'sample', 'content'), 'kept');
    mkdirSync(join(roots.appRoot, 'config'), { recursive: true });
    writeFileSync(join(roots.appRoot, 'config', 'embedding-lock.json'), JSON.stringify({ version: 3, mode: 'metadata', collection: 'serving', createdAt: 'now' }));

    // No ledger reset here: the modules' graphs declared their kinds when the first row loaded them.
    const modules = await loadUpgradeModules(UPGRADES_DIR);
    const kinds = modules.flatMap(({ module }) => module.kinds);
    writeFileSync(join(roots.appRoot, 'config', 'data-formats.json'), JSON.stringify(Object.fromEntries(kinds.map(({ kind, to }) => [kind, { version: to - 1, raisedAt: 'x' }]))));
    await markDataFormatUpgrade(roots.appRoot, kinds, 'begin');
    const interrupted = createPackageIdentityUpgrade(join(home, 'no-override.yml'), { onPhase: (phase) => { if (phase === 'zones') throw new Error('stopped before the records'); } });
    await expect(interrupted.apply({ ...roots, log: () => {} })).rejects.toThrow('stopped before the records');
    expect(readdirSync(join(roots.appRoot, 'config'))).toEqual(expect.arrayContaining(['package-identity-migration.json', 'package-identity-zone-journal']));
    expect(JSON.parse(readFileSync(agentFile, 'utf8')).formatVersion).toBeUndefined();

    const logs: string[] = [];
    const outcome = await runUpgrade({ apply: true, modulesDir: UPGRADES_DIR, roots, offline: async () => ({ offline: true }), log: (line) => logs.push(line) });
    expect(outcome).toMatchObject({ applied: true });
    expect(outcome.checkpoint).toBeUndefined();
    expect(logs.join('\n')).toContain('(resuming)');
    const id = packageInstanceId({ originUri: 'packages://sample', projectId: 'main', scope: { kind: 'project' } });
    const agent = JSON.parse(readFileSync(agentFile, 'utf8'));
    expect(agent.formatVersion).toBe(2);
    expect(agent.config.packages.overrides).toEqual({ [id]: { enabled: false } });
    expect(JSON.parse(readFileSync(join(roots.appRoot, 'projects', 'main.json'), 'utf8'))).toMatchObject({ formatVersion: 2, packageTrust: { [id]: 'trusted' } });
    const ledger = await readDataFormatLedger(roots.appRoot);
    expect(kinds.map(({ kind }) => [kind, ledger[kind]?.state])).toEqual(kinds.map(({ kind }) => [kind, undefined]));
    expect(kinds.every(({ kind, to }) => ledger[kind]?.version === to)).toBe(true);
    // Resumed with BOTH pending: the zone identity-v2 had already written (hashed + marker) is moved on.
    expect(logs.join('\n')).toMatch(/zones: 1 moved to runtime\/ .*1 by identity marker.*0 left to package-identity-v2/);
    expect(readFileSync(join(roots.projectsRoot, 'main', 'data', 'runtime', 'packages', 'sample', 'content'), 'utf8')).toBe('kept');
    expect(readdirSync(join(roots.projectsRoot, 'main', 'data'))).not.toContain('_installed');
    expect(readdirSync(join(roots.projectsRoot, 'main', 'data', 'runtime', 'packages', 'sample'))).toEqual(['content']);
  });

  it('a crash in the ZONE apply after the identity apply completed resumes: identity-v2 does not re-verify zones that moved on', async () => {
    const { createPackageZoneUpgrade } = await import('../upgrades/package-zone-v1.mts');
    const home = mkdtempSync(join(tmpdir(), 'nrs-upgrade-zone-crash-'));
    dirs.push(home);
    const roots = { home, appRoot: join(home, 'app'), projectsRoot: join(home, 'projects') };
    mkdirSync(join(roots.appRoot, 'projects'), { recursive: true });
    writeFileSync(join(roots.appRoot, 'projects', 'main.json'), JSON.stringify({ id: 'main', packageTrust: {} }));
    mkdirSync(join(roots.projectsRoot, 'main', '_packages', 'sample'), { recursive: true });
    writeFileSync(join(roots.projectsRoot, 'main', '_packages', 'sample', 'package.json'), JSON.stringify({ name: 'sample', version: '0.1.0', neuralis: { id: 'sample', name: 'sample', version: '0.1.0', description: 'fixture' } }));
    mkdirSync(join(roots.projectsRoot, 'main', 'data', '_installed', 'sample'), { recursive: true });
    writeFileSync(join(roots.projectsRoot, 'main', 'data', '_installed', 'sample', 'content'), 'kept');
    mkdirSync(join(roots.appRoot, 'config'), { recursive: true });
    writeFileSync(join(roots.appRoot, 'config', 'embedding-lock.json'), JSON.stringify({ version: 3, mode: 'metadata', collection: 'serving', createdAt: 'now' }));
    const modules = await loadUpgradeModules(UPGRADES_DIR);
    const kinds = modules.flatMap(({ module }) => module.kinds);
    writeFileSync(join(roots.appRoot, 'config', 'data-formats.json'), JSON.stringify(Object.fromEntries(kinds.map(({ kind, to }) => [kind, { version: to - 1, raisedAt: 'x' }]))));

    // The real command with the zone module swapped for one that stops after its first zone.
    const crashing = join(home, 'upgrades');
    mkdirSync(crashing);
    for (const file of readdirSync(UPGRADES_DIR).filter((name) => name.endsWith('.mts') && name !== 'package-zone-v1.mts')) {
      writeFileSync(join(crashing, file), `export { default } from ${JSON.stringify(join(UPGRADES_DIR, file))};\n`);
    }
    writeFileSync(join(crashing, 'package-zone-v1.mts'), `import { createPackageZoneUpgrade } from ${JSON.stringify(join(UPGRADES_DIR, 'package-zone-v1.mts'))};\nexport default createPackageZoneUpgrade({ onPhase: (phase) => { if (phase === 'zone') throw new Error('stopped after the first zone'); } });\n`);
    void createPackageZoneUpgrade;
    const logs: string[] = [];
    const run = (modulesDir: string) => runUpgrade({ apply: true, modulesDir, roots, offline: async () => ({ offline: true }), log: (line) => logs.push(line) });
    await expect(run(crashing)).rejects.toThrow('stopped after the first zone');
    // Both pending on a pre-identity install: the zone dry run (which precedes every apply) leaves the
    // marker-less slug zone to package-identity-v2 — never an orphan, never a blocker.
    expect(logs.join('\n')).toMatch(/zones: 0 moved to runtime\/ .*1 left to package-identity-v2/);
    expect(logs.join('\n')).not.toContain('Blocking');
    expect(readdirSync(join(roots.projectsRoot, 'main', 'data', 'runtime', 'packages', 'sample'))).toEqual(['content']);

    const outcome = await run(UPGRADES_DIR);
    expect(outcome).toMatchObject({ applied: true });
    expect(readFileSync(join(roots.projectsRoot, 'main', 'data', 'runtime', 'packages', 'sample', 'content'), 'utf8')).toBe('kept');
    expect(readdirSync(join(roots.projectsRoot, 'main', 'data'))).not.toContain('_installed');
    const ledger = await readDataFormatLedger(roots.appRoot);
    expect(kinds.every(({ kind, to }) => ledger[kind]?.version === to && ledger[kind]?.state === undefined)).toBe(true);
  });

  // The documented command runs on the HOST, where a flagged source's container root
  // (`/mounts/<slug>`) does not exist: the override's mount pair names its host folder.
  it('package-identity-v2 reads a mounted flagged source through the override pair; without the pair it refuses by name', async () => {
    const { createPackageIdentityUpgrade } = await import('../upgrades/package-identity-v2.mts');
    const home = mkdtempSync(join(tmpdir(), 'nrs-upgrade-mount-'));
    dirs.push(home);
    const roots = { home, appRoot: join(home, 'app'), projectsRoot: join(home, 'projects') };
    const slug = `nrs-test-${Date.now()}`;
    const containerRoot = `/mounts/${slug}`;
    expect(statSync(containerRoot, { throwIfNoEntry: false })).toBeUndefined();
    mkdirSync(join(roots.appRoot, 'projects'), { recursive: true });
    writeFileSync(join(roots.appRoot, 'projects', 'main.json'), JSON.stringify({ id: 'main', packageTrust: { 'mounted-pkg': 'trusted' } }));
    mkdirSync(join(roots.projectsRoot, 'main', '_packages'), { recursive: true });
    mkdirSync(join(roots.appRoot, 'config', 'sources', 'main'), { recursive: true });
    writeFileSync(join(roots.appRoot, 'config', 'sources', 'main', 'tp.json'), JSON.stringify({
      source: 'tp', scope: { kind: 'project' }, connection: { kind: 'local', config: { root: containerRoot } },
      permissions: { default: { read: true, write: false, exec: false } }, recognizesPackages: true,
      createdAt: 'then', updatedAt: 'then', createdBy: 'u1',
    }));
    const hostDir = join(home, 'host-folder');
    mkdirSync(join(hostDir, 'mounted-pkg'), { recursive: true });
    writeFileSync(join(hostDir, 'mounted-pkg', 'package.json'), JSON.stringify({ name: 'mounted-pkg', version: '0.1.0', neuralis: { id: 'mounted-pkg', name: 'mounted-pkg', version: '0.1.0', description: 'fixture' } }));
    const override = join(home, 'docker-compose.override.yml');
    const ctx = { ...roots, log: () => {} };

    writeFileSync(override, 'services:\n  neuralis:\n    environment:\n');
    await expect(createPackageIdentityUpgrade(override).dryRun(ctx)).rejects.toThrow(
      new RegExp(`Project main: the package source tp:// .*${containerRoot} does not exist here\\. No NEURALIS_MOUNT_\\* pair in .* maps it`),
    );

    // PAIRED CONTROL — the same install with the pair (a hyphenated slug: the HOST name is UPPER_SNAKE).
    writeFileSync(override, `services:\n  neuralis:\n    environment:\n      - NEURALIS_MOUNT_${slug}=${containerRoot}\n      - NEURALIS_MOUNT_HOST_${slug.toUpperCase().replace(/-/g, '_')}=${hostDir}\n`);
    const before = homeFiles(home);
    const plan = await createPackageIdentityUpgrade(override).dryRun(ctx);
    expect(plan.summary[1]).toMatch(/^references: [1-9]\d* re-keyed/);
    expect(homeFiles(home)).toEqual(before);
  });
});
