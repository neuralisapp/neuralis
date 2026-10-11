/**
 * The release rehearsal's upgrade-branch oracle, without the network: the run
 * itself publishes to a local registry and reads the previous line from the
 * public one, so the suite pins only what the branch JUDGES — a converted
 * folder kept every piece of operator state, carries the new operator scripts
 * and lost the old tree — on a synthetic folder, with a twin for each check.
 * Importing the module must not start a rehearsal.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const before = { '.env': 'NEURALIS_IMAGE_TAG=0.1.0\n', 'docker-compose.override.yml': '# sentinel\n', '.npmrc': 'save-exact=true\n' };
const sentinelDep = { name: '@acme/rehearsal-sentinel', spec: 'file:/tmp/acme.tgz' };

const made: string[] = [];
afterAll(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

function converted(): string {
  const dir = mkdtempSync(join(tmpdir(), 'neuralis-rehearsal-oracle-'));
  made.push(dir);
  for (const [file, text] of Object.entries(before)) writeFileSync(join(dir, file), text);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, dependencies: { [sentinelDep.name]: sentinelDep.spec, neuralis: '0.2.0' } }));
  mkdirSync(join(dir, 'node_modules', 'neuralis', 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'neuralis', 'scripts', 'upgrade.mts'), '');
  mkdirSync(join(dir, 'checkpoints', '2026-10-09-convert-from-0.1.0'), { recursive: true });
  return dir;
}

describe('channel #1 rehearsal — the converted-folder oracle', () => {
  it('importing the module starts no rehearsal (no scratch tree, no registry)', async () => {
    const scratch = readdirSync(tmpdir()).filter((n) => n.startsWith('neuralis-channel1-')).length;
    await import('../channel1-rehearsal.mjs');
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('neuralis-channel1-')).length).toBe(scratch);
  });

  it('passes a correctly converted folder and names each broken piece of a wrong one', async () => {
    const { convertedFolderProblems } = (await import('../channel1-rehearsal.mjs')) as {
      convertedFolderProblems(input: { dir: string; before: Record<string, string>; candidate: string; sentinelDep: { name: string; spec: string } }): string[];
    };
    const good = converted();
    expect(convertedFolderProblems({ dir: good, before, candidate: '0.2.0', sentinelDep })).toEqual([]);

    const bad = converted();
    writeFileSync(join(bad, '.env'), 'NEURALIS_IMAGE_TAG=0.1.0\n# edited\n');
    rmSync(join(bad, 'docker-compose.override.yml'));
    writeFileSync(join(bad, 'package.json'), JSON.stringify({ name: 'neuralis', dependencies: { neuralis: '0.1.0' } }));
    rmSync(join(bad, 'node_modules', 'neuralis', 'scripts', 'upgrade.mts'));
    mkdirSync(join(bad, 'src'));
    mkdirSync(join(bad, 'node_modules', 'neuralis', 'node_modules', '@neuralis', 'package-system'), { recursive: true });
    expect(convertedFolderProblems({ dir: bad, before, candidate: '0.2.0', sentinelDep })).toEqual([
      '.env changed or vanished',
      'docker-compose.override.yml changed or vanished',
      'package.json depends on neuralis@0.1.0, expected 0.2.0',
      `the registered package line ${sentinelDep.name} was not carried verbatim`,
      'package.json still names a package — the old host manifest survived',
      'node_modules/neuralis/scripts/upgrade.mts is missing — the new operator scripts did not arrive',
      'src is still in the folder',
      'a nested @neuralis tree under node_modules/neuralis/node_modules',
    ]);
    expect(existsSync(join(bad, '.npmrc'))).toBe(true);
  });

  it('npx gets its registry and cache BEFORE the package spec — after it they reach the scaffolder, which refuses them', async () => {
    const { npxArgs } = (await import('../channel1-rehearsal.mjs')) as { npxArgs: (spec: string, args: string[], npm: { registry: string; cache: string }) => string[] };
    const argv = npxArgs('create-neuralis@0.2.0', ['convert', '/x'], { registry: 'http://127.0.0.1:4873', cache: '/c' });
    expect(argv).toEqual(['--yes', '--registry', 'http://127.0.0.1:4873', '--cache', '/c', 'create-neuralis@0.2.0', 'convert', '/x']);
    expect(argv.slice(argv.indexOf('create-neuralis@0.2.0') + 1).some((a) => a.startsWith('-'))).toBe(false);
  });

  it('the summary names a skipped upgrade branch as SKIPPED and never counts it as proven', async () => {
    const { summaryLines } = (await import('../channel1-rehearsal.mjs')) as { summaryLines: (run: { upgrade: 'ran' | 'skipped' | 'off'; from: string; candidate: string }) => string[] };
    const skipped = summaryLines({ upgrade: 'skipped', from: '0.1.0', candidate: '0.1.0' }).join('\n');
    expect(skipped).toContain('Upgrade branch: SKIPPED');
    expect(skipped).not.toMatch(/converted/);
    expect(summaryLines({ upgrade: 'off', from: '0.1.0', candidate: '0.2.0' }).join('\n')).toContain('convert was NOT exercised');
    const ran = summaryLines({ upgrade: 'ran', from: '0.1.0', candidate: '0.2.0' }).join('\n');
    expect(ran).toContain('0.1.0 folder converted by the candidate');
    expect(ran).not.toContain('SKIPPED');
  });
});
