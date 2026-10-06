import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Tarball audit for the host `files` whitelist (F2 wave-1 INC-D).
 *
 * Before the whitelist, `npm pack` shipped the operator's machine-local
 * `docker-compose.override.yml` (host mount paths!) and the whole
 * `neuralis/docs/` tree — and nothing failed, because a packlist has no
 * runtime reader. This suite IS the reader: it asks npm itself what the
 * tarball would contain and asserts both directions — the runtime surface
 * ships, the operator/private surface never does. `--dry-run` writes
 * nothing; the host has no prepack/prepare scripts to side-effect.
 */

const hostRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function packlist(): string[] {
  // NEURALIS_PACK_AUDIT=1: the prepack guard refuses to pack while a
  // machine-local (file:/link:) dep line exists — correct for publishes, but
  // this AUDIT needs the real byte content on a dev machine too.
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: hostRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NEURALIS_PACK_AUDIT: '1' },
  });
  const parsed = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
  return parsed[0].files.map((f) => f.path);
}

describe('host npm packlist', () => {
  const files = packlist();

  it('ships the runtime surface channel #1 needs to build and run', () => {
    for (const exact of [
      'package.json',
      'README.md',
      'next.config.ts',
      // Tailwind v4 rides @tailwindcss/postcss — without this file the
      // installed tree cannot `next build` at all.
      'postcss.config.mjs',
      'tsconfig.json',
      'tsconfig.scripts.json',
      'vitest.config.mts',
      'Dockerfile',
      '.env.example',
      // How to report a vulnerability, and the maturity labels the README repeats.
      'SECURITY.md',
      'DOCKERHUB.md',
      'maturity.json',
    ]) {
      expect(files, `missing from packlist: ${exact}`).toContain(exact);
    }
    for (const prefix of [
      'src/',
      'scripts/',
      // The operator command vocabulary is a shipped source package.
      'skills/neuralis-operations/',
      'public/',
      // landlock-sandboxer.c — the in-tree Docker build compiles it.
      'docker/',
    ]) {
      expect(
        files.some((f) => f.startsWith(prefix)),
        `nothing under ${prefix} in packlist`,
      ).toBe(true);
    }
  });

  it('never ships operator-local, generated, or private files', () => {
    const forbidden = files.filter(
      (f) =>
        f.startsWith('docs/') ||
        f.startsWith('data/') ||
        f.startsWith('.neuralis/') ||
        f.startsWith('.next/') ||
        f.startsWith('docker-compose') ||
        f === '.env' ||
        (f.startsWith('.env.') && f !== '.env.example') ||
        f.endsWith('.pem') ||
        f.endsWith('.key') ||
        f.includes('node_modules/'),
    );
    expect(forbidden, 'publish-unsafe paths in the tarball').toEqual([]);
  });
});
