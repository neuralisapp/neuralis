import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
// `describe`/`it` come from VITEST, not `node:test`. Importing them from
// `node:test` made node's own runner execute the suite inside the vitest worker
// and print a passing TAP summary (`# pass 9`) while vitest collected ZERO tests
// and failed the file — a suite that looked green in its own output and red in
// the runner's. Read the exit code, never the TAP tail.
import { describe, it } from 'vitest';
import { sha256Dir } from '../build/treeDigest.mjs';

type Scenario = {
  buildCode?: number;
  volumeCode?: number;
  boundedCode?: number;
  hardCode?: number;
  measurements?: Array<string | null>;
  /** When set, the sandbox gets a provisioned host plane and the fake image reports this helper sha. */
  hostPlane?: { imageSha: string; installedContent: string };
  /** The sidecar image's source-hash label: undefined = matches the tree (default), null = no image, string = that label. */
  sidecarLabel?: string | null;
  sidecarBuildCode?: number;
  /** Run a scratch copy of `scripts/` with no `packages/` beside it — an installed tree. */
  installedTree?: boolean;
  /** Exit code of the compose regeneration (`pnpm run neuralis:setup --compose-only`). */
  composeCode?: number;
  /** The container answers `compose ps` and `docker cp` hands back this build report. */
  report?: { uiCompat?: unknown; lock?: string; trackedSha?: string };
};

const SIDECAR_LABEL = 'io.neuralis.sidecar.source-hash';
const sidecarDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'agent-core', 'docker', 'mcp-sidecar');


const neuralisDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function runScenario(scenario: Scenario, args: string[] = []) {
  const sandbox = mkdtempSync(join(tmpdir(), 'neuralis-rebuild-test-'));
  const binDir = join(sandbox, 'bin');
  const dockerPath = join(binDir, 'docker');
  const logPath = join(sandbox, 'commands.jsonl');
  const statePath = join(sandbox, 'state.json');

  try {
    mkdirSync(binDir);
    writeFileSync(
      dockerPath,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const scenario = JSON.parse(process.env.FAKE_DOCKER_SCENARIO);
const logPath = process.env.FAKE_DOCKER_LOG;
const statePath = process.env.FAKE_DOCKER_STATE;
fs.appendFileSync(logPath, JSON.stringify(args) + '\\n');

function finish(code, out = '', err = '') {
  if (out) process.stdout.write(out);
  if (err) process.stderr.write(err);
  process.exit(code);
}

if (args[0] === 'compose' && args[1] === 'up') {
  finish(scenario.buildCode ?? 0);
}
if (args[0] === 'volume' && args[1] === 'prune') {
  finish(scenario.volumeCode ?? 0, 'Total reclaimed space: 1GB\\n', 'volume prune failed');
}
if (args[0] === 'builder' && args[1] === 'prune' && args.includes('--max-used-space')) {
  finish(scenario.boundedCode ?? 0, 'Total reclaimed space: 2GB\\n', 'bounded prune failed');
}
if (args[0] === 'builder' && args[1] === 'prune') {
  finish(scenario.hardCode ?? 0, 'Total reclaimed space: 3GB\\n', 'hard prune failed');
}
if (args[0] === 'compose' && args[1] === '-p' && args[3] === 'ps') {
  finish(0, scenario.hostPlane || scenario.report ? 'ctr-fake-1\\n' : '');
}
if (args[0] === 'cp') {
  if (!scenario.report) finish(1, '', 'no such path');
  const dest = args[2];
  if (scenario.report.uiCompat) fs.writeFileSync(dest + '/ui-compat.json', JSON.stringify(scenario.report.uiCompat));
  if (scenario.report.lock) fs.writeFileSync(dest + '/pnpm-lock.yaml', scenario.report.lock);
  if (scenario.report.trackedSha) fs.writeFileSync(dest + '/tracked-lock.sha256', scenario.report.trackedSha + '\\n');
  finish(0);
}
if (args[0] === 'exec' && args[2] === 'sha256sum') {
  finish(0, (scenario.hostPlane ? scenario.hostPlane.imageSha : '0'.repeat(64)) + '  /usr/local/bin/nrs-sandboxer\\n');
}
if (args[0] === 'image' && args[1] === 'inspect') {
  const label = 'sidecarLabel' in scenario ? scenario.sidecarLabel : process.env.FAKE_SIDECAR_TREE_HASH;
  if (label === null) finish(1, '', 'Error: No such image: ' + args[args.length - 1]);
  finish(0, label + '\\n');
}
if (args[0] === 'build') {
  finish(scenario.sidecarBuildCode ?? 0, '', scenario.sidecarBuildCode ? 'sidecar build failed' : '');
}
if (args[0] === 'system' && args[1] === 'df') {
  let state = { measurement: 0 };
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
  const value = (scenario.measurements ?? [])[state.measurement] ?? null;
  state.measurement += 1;
  fs.writeFileSync(statePath, JSON.stringify(state));
  if (value !== null) {
    finish(0, JSON.stringify({ Type: 'Build Cache', Size: value }) + '\\n');
  }
  finish(0, JSON.stringify({ Type: 'Images', Size: '1GB' }) + '\\n');
}

finish(98, '', 'unexpected fake docker command: ' + args.join(' '));
`,
      { mode: 0o755 },
    );
    chmodSync(dockerPath, 0o755);
    // The compose regeneration runs through `pnpm` — faked on the same PATH, so a
    // test never reads the live .env nor rewrites the live docker-compose.yml.
    const pnpmLogPath = join(sandbox, 'pnpm.jsonl');
    writeFileSync(
      join(binDir, 'pnpm'),
      `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(pnpmLogPath)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.exit(${scenario.composeCode ?? 0});
`,
      { mode: 0o755 },
    );

    // Hermetic host plane: NEURALIS_HOME points into the sandbox, so the real
    // machine's provisioned broker never leaks into the command log. When the
    // scenario asks for one, provision a secret + a unit naming a helper file.
    const home = join(sandbox, 'neuralis-home');
    const configHome = join(sandbox, 'config');
    if (scenario.hostPlane) {
      mkdirSync(join(home, 'host-broker'), { recursive: true });
      writeFileSync(join(home, 'host-broker', 'secret'), 'x'.repeat(64));
      const helperPath = join(sandbox, 'nrs-sandboxer');
      writeFileSync(helperPath, scenario.hostPlane.installedContent);
      mkdirSync(join(configHome, 'systemd', 'user'), { recursive: true });
      writeFileSync(
        join(configHome, 'systemd', 'user', 'neuralis-host-broker.service'),
        `[Service]\nEnvironment=NEURALIS_HOST_BROKER_SANDBOXER=${helperPath}\n`,
      );
    }

    let cwd = neuralisDir;
    if (scenario.installedTree) {
      cwd = join(sandbox, 'installed', 'neuralis');
      cpSync(join(neuralisDir, 'scripts'), join(cwd, 'scripts'), { recursive: true });
    }
    const result = spawnSync(
      process.execPath,
      ['scripts/rebuild.mts', ...args],
      {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          NEURALIS_HOME: home,
          XDG_CONFIG_HOME: configHome,
          FAKE_DOCKER_SCENARIO: JSON.stringify(scenario),
          FAKE_DOCKER_LOG: logPath,
          FAKE_DOCKER_STATE: statePath,
          FAKE_SIDECAR_TREE_HASH: sha256Dir(sidecarDir),
        },
      },
    );
    const readLog = (path: string): string[][] => {
      let text = '';
      try { text = readFileSync(path, 'utf8'); } catch { /* never written */ }
      return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
    };
    const commands = readLog(logPath);
    const pnpmCommands = readLog(pnpmLogPath);
    let exportedLock: string | null = null;
    let exportedSha: string | null = null;
    try {
      exportedLock = readFileSync(join(home, 'build', 'pnpm-lock.yaml'), 'utf8');
      exportedSha = readFileSync(join(home, 'build', 'tracked-lock.sha256'), 'utf8');
    } catch { /* nothing exported */ }

    for (const command of commands) {
      assert.notDeepEqual(command, ['volume', 'prune', '--all']);
      assert.notDeepEqual(command.slice(0, 2), ['image', 'prune']);
      assert.notDeepEqual(command.slice(0, 2), ['system', 'prune']);
      if (command.slice(0, 2).join(' ') === 'compose up') {
        assert.ok(!command.includes('-f'));
      }
    }

    return { ...result, commands, pnpmCommands, exportedLock, exportedSha };
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

/** The post-build report read (`compose -p <project> ps`, `cp`) — its project name comes from the live `.env`. */
const isReportProbe = (c: string[]): boolean => (c[0] === 'compose' && c[1] === '-p') || c[0] === 'cp';

describe('neuralis:rebuild — the compose file is regenerated before the build', () => {
  it('regenerates through `pnpm run neuralis:setup --compose-only` BEFORE compose up', () => {
    const result = runScenario({}, ['--no-prune', '--no-sidecar']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(result.pnpmCommands, [['run', '--silent', 'neuralis:setup', '--compose-only']]);
    assert.ok(result.commands.some((c) => c[0] === 'compose' && c[1] === 'up'));
  });

  it('a failed regeneration stops before Docker builds anything, with its exit code', () => {
    const result = runScenario({ composeCode: 3 });
    assert.equal(result.status, 3);
    assert.deepEqual(result.commands, []);
    assert.match(result.stdout, /compose regeneration failed \(exit 3\) — nothing was built/);
  });
});

describe('neuralis:rebuild — the build report after a green build', () => {
  it('names every UI module the build refused for this host', () => {
    const result = runScenario({
      report: { uiCompat: { checked: 3, refused: [{ packageId: '@acme/probe', reason: 'react-major' }] } },
    }, ['--no-prune', '--no-sidecar']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /UI module refused: .*@acme\/probe.* \(react-major\)/);
    assert.equal(result.exportedLock, null);
  });

  it('keeps the local packages\' build lock (and the tracked-lock hash) in <NEURALIS_HOME>/build/', () => {
    const result = runScenario({
      report: { uiCompat: { checked: 1, refused: [] }, lock: 'lockfileVersion: 9.0\n', trackedSha: 'a'.repeat(64) },
    }, ['--no-prune', '--no-sidecar']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.exportedLock, 'lockfileVersion: 9.0\n');
    assert.equal(result.exportedSha, `${'a'.repeat(64)}\n`);
    assert.match(result.stdout, /1 checked, none refused/);
  });

  it('control: a container without a report is a warning, never a failed rebuild', () => {
    const result = runScenario({ hostPlane: { imageSha: 'b'.repeat(64), installedContent: 'x' } }, ['--no-prune', '--no-sidecar']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /build report\s+: not readable/);
  });
});

describe('neuralis:rebuild cache guard', () => {
  it('returns the exact build failure and runs no cleanup', () => {
    const result = runScenario({ buildCode: 23 });

    assert.equal(result.status, 23);
    assert.deepEqual(result.commands, [
      ['compose', 'up', '-d', '--build', '-V'],
    ]);
  });

  it('honors the explicit --no-prune opt-out after a green build', () => {
    const result = runScenario({}, ['--no-prune']);

    assert.equal(
      result.status,
      0,
      `${result.stdout}\n${result.stderr}\n${result.error?.message ?? ''}\nsignal=${result.signal}`,
    );
    assert.deepEqual(result.commands.filter((c) => !isReportProbe(c)), [
      ['compose', 'up', '-d', '--build', '-V'],
      ['image', 'inspect', '--format', `{{ index .Config.Labels "${SIDECAR_LABEL}" }}`, 'neuralisapp/mcp-sidecar:dev'],
    ]);
  });

  it('accepts a measurable cache below the hard limit without a hard prune', () => {
    const result = runScenario({ measurements: ['37.49GB'] });

    assert.equal(
      result.status,
      0,
      `${result.stdout}\n${result.stderr}\n${result.error?.message ?? ''}\nsignal=${result.signal}`,
    );
    assert.ok(
      result.commands.some(
        (command) =>
          JSON.stringify(command) ===
          JSON.stringify([
            'builder',
            'prune',
            '--all',
            '-f',
            '--max-used-space',
            '35GB',
          ]),
      ),
    );
    assert.equal(
      result.commands.filter(
        (command) =>
          command[0] === 'builder' &&
          command[1] === 'prune' &&
          !command.includes('--max-used-space'),
      ).length,
      0,
    );
  });

  it('hard-prunes an oversized cache and verifies the result', () => {
    const result = runScenario({ measurements: ['63.3GB', '12GB'] });

    assert.equal(result.status, 0);
    assert.ok(
      result.commands.some(
        (command) =>
          JSON.stringify(command) ===
          JSON.stringify(['builder', 'prune', '--all', '-f']),
      ),
    );
    assert.match(result.stdout, /verified/);
  });

  it('hard-prunes when the first measurement is unavailable', () => {
    const result = runScenario({ measurements: [null, '8GB'] });

    assert.equal(result.status, 0);
    assert.ok(
      result.commands.some(
        (command) =>
          JSON.stringify(command) ===
          JSON.stringify(['builder', 'prune', '--all', '-f']),
      ),
    );
  });

  it('fails when the hard prune command fails', () => {
    const result = runScenario({
      measurements: ['63.3GB'],
      hardCode: 9,
    });

    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout, /done\./);
  });

  for (const { name, after } of [
    { name: 'unmeasurable', after: null },
    { name: 'still above 40GB', after: '41GB' },
  ]) {
    it(`fails when the post-hard-prune cache is ${name}`, () => {
      const result = runScenario({ measurements: ['63.3GB', after] });

      assert.equal(result.status, 1);
      assert.doesNotMatch(result.stdout, /done\./);
    });
  }

  it('accepts the exact 40GB boundary', () => {
    const result = runScenario({ measurements: ['40GB'] });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /at\/below hard guard 40GB/);
  });

  it('after a green rebuild a provisioned host plane gets a MEASURED helper-drift line naming `upgrade`', () => {
    const installed = 'stale-helper-bytes';
    const result = runScenario({
      measurements: ['1GB'],
      hostPlane: { imageSha: createHash('sha256').update('fresh-helper-bytes').digest('hex'), installedContent: installed },
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /host helper\s+: .*differs from the new image/);
    assert.match(result.stdout, /pnpm neuralis:host-broker upgrade/);
    assert.ok(result.commands.some((cmd) => cmd[0] === 'exec' && cmd[2] === 'sha256sum'));
  });

  it('control: a host helper that matches the new image reports so, no upgrade hint', () => {
    const installed = 'fresh-helper-bytes';
    const result = runScenario({
      measurements: ['1GB'],
      hostPlane: { imageSha: createHash('sha256').update(installed).digest('hex'), installedContent: installed },
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /host helper\s+: .*matches the new image/);
    assert.doesNotMatch(result.stdout, /host-broker upgrade/);
  });

  it('control: no host plane provisioned ⇒ no docker exec, no helper line', () => {
    const result = runScenario({ measurements: ['1GB'] });
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /host helper/);
    assert.ok(!result.commands.some((cmd) => cmd[0] === 'exec'));
  });
});


describe('neuralis:rebuild sidecar image — built only when there is a reason', () => {
  const inspect = (cmd: string[]) => cmd[0] === 'image' && cmd[1] === 'inspect';
  const build = (cmd: string[]) => cmd[0] === 'build';

  it('a MISSING image is built once, labelled with the tree hash, after the app build', () => {
    const result = runScenario({ sidecarLabel: null }, ['--no-prune']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const builds = result.commands.filter(build);
    assert.equal(builds.length, 1);
    assert.deepEqual(builds[0].slice(0, 5), ['build', '-f', join(sidecarDir, 'Dockerfile'), '-t', 'neuralisapp/mcp-sidecar:dev']);
    assert.equal(builds[0][6], `${SIDECAR_LABEL}=${sha256Dir(sidecarDir)}`);
    assert.equal(builds[0][7], sidecarDir);
    assert.ok(result.commands.findIndex(build) > result.commands.findIndex((c) => c[0] === 'compose' && c[1] === 'up'));
    assert.match(result.stdout, /sidecar image\s+: .*missing — building/);
  });

  it('a label that MATCHES the tree is one line and no build (the D7 rule)', () => {
    const result = runScenario({}, ['--no-prune']);
    assert.equal(result.status, 0);
    assert.equal(result.commands.filter(inspect).length, 1);
    assert.equal(result.commands.filter(build).length, 0);
    assert.match(result.stdout, /up to date .* — not rebuilt/);
  });

  it('a label that DIFFERS from the tree rebuilds', () => {
    const result = runScenario({ sidecarLabel: 'f'.repeat(64) }, ['--no-prune']);
    assert.equal(result.status, 0);
    assert.equal(result.commands.filter(build).length, 1);
    assert.match(result.stdout, /source changed .* — building/);
  });

  it('--no-sidecar skips the step entirely and is NOT forwarded to compose', () => {
    const result = runScenario({ sidecarLabel: null }, ['--no-prune', '--no-sidecar']);
    assert.equal(result.status, 0);
    assert.deepEqual(result.commands.filter((c) => !isReportProbe(c)), [['compose', 'up', '-d', '--build', '-V']]);
    assert.match(result.stdout, /skipped \(--no-sidecar\)/);
  });

  it('a failed sidecar build is NOT fatal — the rebuild still exits 0 and cleanup still runs', () => {
    const result = runScenario({ sidecarLabel: null, sidecarBuildCode: 7, measurements: ['1GB'] });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /sidecar image build failed \(exit 7\)/);
    assert.ok(result.commands.some((c) => c[0] === 'volume' && c[1] === 'prune'));
  });

  it('an INSTALLED tree (no packages/ beside scripts/) skips the step by name — never an ENOENT after the app is up', () => {
    const result = runScenario({ installedTree: true, sidecarLabel: null, measurements: ['1GB'] });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.commands.filter((c) => c[0] === 'image' || c[0] === 'build').length, 0);
    assert.match(result.stdout, /skipped — no .* \(installed tree; the sidecar image is not distributed there yet\)/);
    assert.ok(result.commands.some((c) => c[0] === 'volume' && c[1] === 'prune'));
  });

  it('a failed APP build never reaches the sidecar step', () => {
    const result = runScenario({ buildCode: 23, sidecarLabel: null });
    assert.equal(result.status, 23);
    assert.equal(result.commands.filter(inspect).length, 0);
  });
});
