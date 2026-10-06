import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const guard = fileURLToPath(new URL('../build/check-server-chunk-split-brain.mjs', import.meta.url));
const bootstrap = fileURLToPath(new URL('../../../packages/agent-core/packages/AgentCoreBootstrap.ts', import.meta.url));
const fixtures: string[] = [];
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });

function runFixture(content: string, workspaceLinked = false) {
  const root = mkdtempSync(join(tmpdir(), 'neuralis-runtime-split-'));
  fixtures.push(root);
  mkdirSync(join(root, 'scripts', 'build'), { recursive: true });
  const script = join(root, 'scripts', 'build', 'guard.mjs');
  copyFileSync(guard, script);
  mkdirSync(join(root, '.next', 'server'), { recursive: true });
  writeFileSync(join(root, '.next', 'server', 'fixture.js'), content);
  mkdirSync(join(root, 'node_modules', '@neuralis'), { recursive: true });
  const packageRoot = join(root, 'node_modules', '@neuralis', 'agent-core');
  if (workspaceLinked) {
    mkdirSync(join(root, 'workspace'));
    symlinkSync(join(root, 'workspace'), packageRoot, 'dir');
  } else mkdirSync(packageRoot);
  return spawnSync(process.execPath, [script], {
    encoding: 'utf-8', env: { ...process.env, SPLIT_BRAIN_ALLOW_BUNDLED: '0' },
  });
}

describe('runtime provider bootstrap split-brain guard', () => {
  it('requires zero bootstrap copies in a production tree, with a clean paired control', () => {
    const sentinel = readFileSync(bootstrap, 'utf-8').match(/logger\.info\('([^']*Bootstrapping agent-core[^']*)'/)?.[1];
    expect(sentinel).toBe('Bootstrapping agent-core');
    const contaminated = runFixture(`console.log(${JSON.stringify(sentinel)});`);
    expect(contaminated.status).toBe(1);
    expect(contaminated.stderr).toContain('AgentCoreBootstrap.ts is BUNDLED into 1 server chunk');
    const clean = runFixture('export const clean = true;');
    expect(clean.status).toBe(0);
    expect(clean.stdout).toContain('AgentCoreBootstrap.ts: 0 bundled copies');
  });

  it('retains the existing workspace symlink exemption for an anchored-free boot module', () => {
    const workspace = runFixture('console.log("Bootstrapping agent-core");', true);
    expect(workspace.status).toBe(0);
    expect(workspace.stdout).toContain('workspace checkout');
  });
});
