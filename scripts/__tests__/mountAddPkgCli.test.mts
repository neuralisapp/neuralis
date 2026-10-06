import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * `pnpm neuralis:mount add <dir> --pkg <name>` — the "not discovered until
 * registered" warning appears only for a package the host does NOT depend on.
 * Hermetic like pkgCli: the CLI runs from a COPY of `scripts/` under a mkdtemp
 * host folder, so the real override and host manifest are never opened.
 */

const realHost = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sandbox = mkdtempSync(join(tmpdir(), 'neuralis-mount-cli-'));
const host = join(sandbox, 'host');

mkdirSync(host, { recursive: true });
cpSync(join(realHost, 'scripts'), join(host, 'scripts'), { recursive: true });
symlinkSync(join(realHost, 'node_modules'), join(host, 'node_modules'), 'dir');
// mount.mts reaches a few host `src/` helpers through the setup modules — read-only.
symlinkSync(join(realHost, 'src'), join(host, 'src'), 'dir');

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

function mountAddPkg(name: string, dependencies: Record<string, string>): string {
  writeFileSync(join(host, 'package.json'), JSON.stringify({ name: 'neuralis', dependencies }));
  rmSync(join(host, 'docker-compose.override.yml'), { force: true });
  const dir = join(sandbox, 'src', name.replace(/[@/]/g, '_'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }));
  const res = spawnSync(process.execPath, ['--import', 'tsx', join(host, 'scripts', 'mount.mts'), 'add', dir, '--pkg', name], {
    cwd: host,
    encoding: 'utf8',
    env: { ...process.env, NEURALIS_HOME: join(sandbox, 'home') },
  });
  expect(existsSync(join(host, 'docker-compose.override.yml')), `${res.stdout}${res.stderr}`).toBe(true);
  return `${res.stdout}${res.stderr}`;
}

describe('mount add --pkg — the registration warning', () => {
  it('says the package loads from the folder when the host already depends on it', () => {
    const out = mountAddPkg('@acme/bound', { '@acme/bound': 'file:/x' });
    expect(out).toContain('is a host dependency');
    expect(out).not.toContain('NOT discovered');
  });

  it('control: warns when the package is not a host dependency', () => {
    const out = mountAddPkg('@acme/loose', {});
    expect(out).toContain('NOT discovered');
  });
});
