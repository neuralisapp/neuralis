/**
 * The Qdrant version as installation state: the pinned release table, the
 * one-minor-at-a-time chain, the gap rule setup refuses on, and the bootstrap
 * of an install that has no state file yet — which never assumes a version.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  QDRANT_RELEASES,
  QDRANT_TARGET_VERSION,
  assessQdrantGap,
  composeQdrantVersion,
  dockerInstallProbe,
  qdrantBinaryAsset,
  qdrantImageRef,
  qdrantUpgradeChain,
  readQdrantState,
  resolveQdrantState,
  type QdrantInstallProbe,
} from '../setup/qdrantVersion.mts';

const tmpDirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempState(): string {
  return join(tempDir('neuralis-qdrant-state-'), 'qdrant-version.json');
}

function probe(p: { storage: boolean | null; running?: string | null; installed?: string | null }): QdrantInstallProbe & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async storageExists() { calls.push('storage'); return p.storage; },
    async runningVersion() { calls.push('running'); return p.running ?? null; },
    async installedVersion() { calls.push('installed'); return p.installed ?? null; },
  };
}

describe('the pinned release table', () => {
  it('holds one release per minor from 1.13 to the target, each with an image digest and both binaries', () => {
    const minors = QDRANT_RELEASES.map((r) => Number(r.version.split('.')[1]));
    expect(minors).toEqual([13, 14, 15, 16, 17, 18, 19]);
    expect(QDRANT_RELEASES.at(-1)?.version).toBe(QDRANT_TARGET_VERSION);
    for (const release of QDRANT_RELEASES) {
      expect(release.imageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(release.binarySha256['x86_64-unknown-linux-gnu']).toMatch(/^[0-9a-f]{64}$/);
      expect(release.binarySha256['aarch64-unknown-linux-musl']).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('renders a digest-pinned image reference and refuses an unpinned version', () => {
    expect(qdrantImageRef('1.19.1')).toBe(
      'qdrant/qdrant:v1.19.1@sha256:12364fe851b9f17356fc88189fc06d1b521262e04659ec7345975b00c9246a10',
    );
    expect(() => qdrantImageRef('1.19.0')).toThrow(/not a pinned release/);
  });

  it('names the published asset per arch — arm64 is musl, never the gnu name that 404s', () => {
    const x64 = qdrantBinaryAsset('1.19.1', 'linux', 'x64');
    expect(x64).toEqual({
      url: 'https://github.com/qdrant/qdrant/releases/download/v1.19.1/qdrant-x86_64-unknown-linux-gnu.tar.gz',
      filename: 'qdrant-x86_64-unknown-linux-gnu.tar.gz',
      sha256: 'eef986e769d4d3e806dd2d546e1b4ecdd416211e54d34b4ed764fac7c58e1085',
    });
    const arm = qdrantBinaryAsset('1.19.1', 'linux', 'arm64');
    expect(arm?.filename).toBe('qdrant-aarch64-unknown-linux-musl.tar.gz');
    expect(arm?.url).not.toContain('aarch64-unknown-linux-gnu');
    expect(arm?.url).not.toContain('latest');
    expect(qdrantBinaryAsset('1.19.1', 'darwin', 'arm64')).toBeNull();
    expect(qdrantBinaryAsset('1.19.0', 'linux', 'x64')).toBeNull();
  });
});

describe('the upgrade chain walks every minor, in order, forward only', () => {
  it('1.13.6 → 1.19.1 is six hops, 1.16 in the middle', () => {
    expect(qdrantUpgradeChain('1.13.6', '1.19.1')).toEqual(['1.14.1', '1.15.5', '1.16.3', '1.17.1', '1.18.3', '1.19.1']);
    expect(qdrantUpgradeChain('1.19.1', '1.19.1')).toEqual([]);
  });

  it('refuses backwards and unpinned ends', () => {
    expect(() => qdrantUpgradeChain('1.19.1', '1.13.6')).toThrow(/never moves backwards/);
    expect(() => qdrantUpgradeChain('1.12.4', '1.19.1')).toThrow(/not a pinned release/);
  });
});

describe('the gap rule setup refuses on (docker AND binary)', () => {
  it('more than one minor behind is refused and names the command', () => {
    const gap = assessQdrantGap('1.13.6');
    expect(gap.kind).toBe('refuse');
    expect(gap.kind === 'refuse' && gap.message).toContain('pnpm neuralis:qdrant-upgrade');
  });

  it('one minor behind renders the recorded version; equal is current', () => {
    expect(assessQdrantGap('1.18.3')).toEqual({ kind: 'behind', hops: 1 });
    expect(assessQdrantGap(QDRANT_TARGET_VERSION)).toEqual({ kind: 'current' });
  });

  it('a newer or unpinned recorded version is refused', () => {
    expect(assessQdrantGap('1.20.0').kind).toBe('refuse');
    expect(assessQdrantGap('1.12.4').kind).toBe('refuse');
  });
});

describe('bootstrap — an install without a state file', () => {
  it('fresh (no storage) records the target, operator-only', async () => {
    const path = tempState();
    const res = await resolveQdrantState({ statePath: path, probe: probe({ storage: false }) });
    expect(res).toMatchObject({ kind: 'state', created: true, state: { version: QDRANT_TARGET_VERSION, source: 'fresh', previous: null } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect((await readQdrantState(path))?.version).toBe(QDRANT_TARGET_VERSION);
  });

  it('existing storage records the version the running server reports — never the target', async () => {
    const path = tempState();
    const res = await resolveQdrantState({ statePath: path, probe: probe({ storage: true, running: '1.13.6' }) });
    expect(res).toMatchObject({ kind: 'state', state: { version: '1.13.6', source: 'detected' } });
  });

  it('existing storage with no server falls back to the installed version (compose tag / binary)', async () => {
    const path = tempState();
    const res = await resolveQdrantState({ statePath: path, probe: probe({ storage: true, installed: '1.13.6' }) });
    expect(res.kind === 'state' && res.state.version).toBe('1.13.6');
  });

  it('existing storage whose version cannot be read is REFUSED and nothing is written', async () => {
    const path = tempState();
    const res = await resolveQdrantState({ statePath: path, probe: probe({ storage: true }) });
    expect(res.kind).toBe('refuse');
    expect(existsSync(path)).toBe(false);
  });

  it('storage the probe cannot see (null) is never read as fresh', async () => {
    const path = tempState();
    const res = await resolveQdrantState({ statePath: path, probe: probe({ storage: null }) });
    expect(res.kind).toBe('refuse');
    expect(existsSync(path)).toBe(false);
  });

  it('a recorded state wins without probing; a dry run writes nothing', async () => {
    const path = tempState();
    writeFileSync(path, JSON.stringify({ version: '1.14.1', previous: '1.13.6', source: 'upgrade', recordedAt: 'x' }));
    const p = probe({ storage: true, running: '1.19.1' });
    const res = await resolveQdrantState({ statePath: path, probe: p });
    expect(res.kind === 'state' && res.state.version).toBe('1.14.1');
    expect(p.calls).toEqual([]);

    const dry = tempState();
    const dryRes = await resolveQdrantState({ statePath: dry, probe: probe({ storage: false }), persist: false });
    expect(dryRes).toMatchObject({ kind: 'state', created: false });
    expect(existsSync(dry)).toBe(false);
  });

  it('a malformed state file is an error, not a default', async () => {
    const path = tempState();
    writeFileSync(path, JSON.stringify({ version: 'latest' }));
    await expect(resolveQdrantState({ statePath: path, probe: probe({ storage: false }) })).rejects.toThrow(/not a Qdrant version record/);
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ version: 'latest' });
  });
});

describe('the docker install probe', () => {
  it('reads the volume through the daemon and the tag through the compose file', async () => {
    const dir = tempDir('neuralis-compose-');
    const composeFilePath = join(dir, 'docker-compose.yml');
    writeFileSync(composeFilePath, 'services:\n  qdrant:\n    image: qdrant/qdrant:v1.13.6\n');
    const seen: string[][] = [];
    const run = (status: number | null, stderr = '', error?: Error) => (cmd: string, args: string[]) => {
      seen.push([cmd, ...args]);
      return { status, stdout: '', stderr, error };
    };
    const present = dockerInstallProbe({ composeProject: 'neuralis', composeFilePath, runningVersion: null, run: run(0) });
    expect(await present.storageExists()).toBe(true);
    expect(seen[0]).toEqual(['docker', 'volume', 'inspect', 'neuralis_qdrant-data']);
    expect(await present.installedVersion()).toBe('1.13.6');
    const absent = dockerInstallProbe({ composeProject: 'x', composeFilePath, runningVersion: null, run: run(1, 'Error response from daemon: get x_qdrant-data: no such volume') });
    expect(await absent.storageExists()).toBe(false);
    const blind = dockerInstallProbe({ composeProject: 'x', composeFilePath, runningVersion: null, run: run(null, '', new Error('ENOENT')) });
    expect(await blind.storageExists()).toBeNull();
  });

  it('parses the tag with and without a digest', () => {
    expect(composeQdrantVersion('    image: qdrant/qdrant:v1.19.1@sha256:' + 'a'.repeat(64) + '\n')).toBe('1.19.1');
    expect(composeQdrantVersion('    image: qdrant/qdrant:latest\n')).toBeNull();
  });
});
