/**
 * `scripts/host-broker/helper.mts` — the decisions `install` / `upgrade` /
 * `status` share. Each row names the misplacement it prevents.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildUnitText,
  composeProjectFromEnv,
  decideRestart,
  parseSha256sum,
  parseUnitSandboxerPath,
  planInstallTarget,
  sha256File,
  SANDBOXER_SYSTEM_PATH,
  applyGrant,
  detectToolchainRoots,
  suggestedExecRootsMissing,
} from '../host-broker/helper.mts';

describe('the install target follows the UNIT, never the first existing path', () => {
  const unit = buildUnitText({
    execPath: '/usr/bin/node',
    entry: '/opt/n/server.mjs',
    socket: '/h/.neuralis/host-broker/host-broker.sock',
    secret: '/h/.neuralis/host-broker/secret',
    ceiling: '/h/.neuralis/host-broker/ceiling.json',
    scratch: '/h/.neuralis/host-broker/terminal-scratch',
    sandboxer: '/h/.local/bin/nrs-sandboxer',
  });

  it('round-trips the sandboxer line through the ONE unit builder', () => {
    expect(parseUnitSandboxerPath(unit)).toBe('/h/.local/bin/nrs-sandboxer');
    expect(parseUnitSandboxerPath('[Unit]\nDescription=x\n')).toBeNull();
    expect(parseUnitSandboxerPath('Environment=NEURALIS_HOST_BROKER_SANDBOXER="/q/nrs-sandboxer"\n')).toBe('/q/nrs-sandboxer');
  });

  it('unit path wins over the env override and the system default', () => {
    expect(planInstallTarget({ explicit: undefined, unitSandboxer: '/h/.local/bin/nrs-sandboxer', envSandboxer: '/e/nrs' }))
      .toEqual({ path: '/h/.local/bin/nrs-sandboxer', source: 'unit' });
  });

  it('an explicit --target wins over everything', () => {
    expect(planInstallTarget({ explicit: '/t/nrs', unitSandboxer: '/u/nrs', envSandboxer: '/e/nrs' }).source).toBe('flag');
  });

  it('no unit ⇒ env override, else the RECOMMENDED root-owned system path (never ~/.local/bin by default)', () => {
    expect(planInstallTarget({ explicit: undefined, unitSandboxer: null, envSandboxer: '/e/nrs' }))
      .toEqual({ path: '/e/nrs', source: 'env' });
    expect(planInstallTarget({ explicit: undefined, unitSandboxer: null, envSandboxer: '  ' }))
      .toEqual({ path: SANDBOXER_SYSTEM_PATH, source: 'system' });
  });
});

describe('upgrade restarts the unit only when nothing detached is running', () => {
  const base = { mode: 'upgrade' as const, noRestart: false, unitActive: true, detachedRunning: 0, force: false };
  it('control: active unit, nothing running ⇒ restart', () => {
    expect(decideRestart(base)).toEqual({ restart: true });
  });
  it('a running detached host shell REFUSES the restart without --force', () => {
    expect(decideRestart({ ...base, detachedRunning: 1 })).toEqual({ restart: false, reason: 'detached_running' });
    expect(decideRestart({ ...base, detachedRunning: 1, force: true })).toEqual({ restart: true });
  });
  it('install never restarts; --no-restart and an inactive unit never restart', () => {
    expect(decideRestart({ ...base, mode: 'install' })).toEqual({ restart: false, reason: 'install_mode' });
    expect(decideRestart({ ...base, noRestart: true })).toEqual({ restart: false, reason: 'no_restart_flag' });
    expect(decideRestart({ ...base, unitActive: false })).toEqual({ restart: false, reason: 'unit_inactive' });
  });
});

describe('small parsers', () => {
  it('compose project comes from .env, default otherwise', () => {
    expect(composeProjectFromEnv('NEURALIS_COMPOSE_PROJECT=neuralis-test\nOTHER=1\n')).toBe('neuralis-test');
    expect(composeProjectFromEnv('OTHER=1\n')).toBe('neuralis');
    expect(composeProjectFromEnv(null)).toBe('neuralis');
  });
  it('sha256sum output and file digest agree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nrs-helper-'));
    try {
      const f = join(dir, 'bin');
      writeFileSync(f, 'abc');
      const hex = sha256File(f);
      expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
      expect(parseSha256sum(`${hex}  /usr/local/bin/nrs-sandboxer\n`)).toBe(hex);
      expect(parseSha256sum('sha256sum: no such file\n')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('grant — the operator writes the ceiling, the agent only asks', () => {
  const ceiling = JSON.stringify({
    $comment: ['keep me'], read: ['/home/op'], write: [], exec: ['/usr'],
    $suggestedExecRoots: ['/home/op/.nvm'], confinement: 'sandboxed', maxDetachedLifetimeMs: 600000, trustedSingleOperator: true,
  }, null, 2);
  it('adds to ONE list and preserves every other key verbatim', () => {
    const res = applyGrant(ceiling, 'exec', ['/home/op/.nvm']);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const parsed = JSON.parse(res.text);
    expect(parsed.exec).toEqual(['/usr', '/home/op/.nvm']);
    expect(parsed.$comment).toEqual(['keep me']);
    expect(parsed.$suggestedExecRoots).toEqual(['/home/op/.nvm']);
    expect(parsed.confinement).toBe('sandboxed');
    expect(parsed.maxDetachedLifetimeMs).toBe(600000);
    expect(parsed.trustedSingleOperator).toBe(true);
    expect(res.added).toEqual(['/home/op/.nvm']);
  });
  it('an already-listed dir is reported, not duplicated', () => {
    const res = applyGrant(ceiling, 'read', ['/home/op']);
    expect(res.ok && res.already).toEqual(['/home/op']);
    expect(res.ok && JSON.parse(res.text).read).toEqual(['/home/op']);
  });
  it('refuses a malformed ceiling instead of replacing it (the broker reads a malformed file as deny-all)', () => {
    expect(applyGrant('{ "read": [', 'read', ['/x']).ok).toBe(false);
    expect(applyGrant('[]', 'read', ['/x']).ok).toBe(false);
  });
});

describe('D-G — toolchain roots are SUGGESTED, never granted', () => {
  it('detects only what exists, in a fixed order', () => {
    const present = new Set(['/h/.nvm', '/h/.local/bin', '/usr/local']);
    expect(detectToolchainRoots('/h', (p) => present.has(p))).toEqual(['/h/.nvm', '/h/.local/bin', '/usr/local']);
    expect(detectToolchainRoots('/h', () => false)).toEqual([]);
  });
  it('reports the suggestions the exec list does not cover yet (prefix-aware)', () => {
    expect(suggestedExecRootsMissing(['/h/.nvm', '/h/.local/bin', '/usr/local'], ['/usr', '/h/.local'])).toEqual(['/h/.nvm']);
    expect(suggestedExecRootsMissing(['/h/.nvm'], ['/h/.nvm'])).toEqual([]);
  });
});
