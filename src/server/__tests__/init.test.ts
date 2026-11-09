/**
 * The setup-state predicate (`server/init.ts`): configured = the session secret
 * file (`<home>/app/config/session-secret.key`) holds a secret AND at least one
 * user record exists. The roots are the kernel's, never `getEnv()`; a positive
 * answer latches, and a negative one is reused for ~2 s before the disk is
 * asked again. The secret file is REAL, in a throwaway home.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({ readdir: vi.fn<(dir: string) => Promise<string[]>>() }));
const HOME = vi.hoisted(() => `${process.env.TMPDIR ?? '/tmp'}/nr-init-test-home-${process.pid}`);
vi.mock('fs/promises', () => ({ readdir: fsMocks.readdir }));
vi.mock('@neuralis/package-system/paths', () => ({
  resolveNeuralisHome: () => ({ home: HOME, appRoot: `${HOME}/app`, projectsRoot: `${HOME}/projects` }),
}));

import { SetupRequiredError, assertSetupComplete, getSetupState, isSetupComplete, isSetupLatched } from '../init';

const SETUP_STATE_SLOT = Symbol.for('@neuralis/host:setupState');
const secretFile = join(HOME, 'app', 'config', 'session-secret.key');
const writeSecret = (text: string): void => writeFileSync(secretFile, text);
const dropSecret = (): void => rmSync(secretFile, { force: true });

beforeEach(() => {
  delete (globalThis as { [SETUP_STATE_SLOT]?: unknown })[SETUP_STATE_SLOT];
  mkdirSync(join(HOME, 'app', 'config'), { recursive: true });
  writeSecret('test-secret\n');
  fsMocks.readdir.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { [SETUP_STATE_SLOT]?: unknown })[SETUP_STATE_SLOT];
});

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

it('the throwaway home is not the live one', () => {
  expect(HOME.startsWith(tmpdir()) || HOME.startsWith('/tmp/')).toBe(true);
});

describe('getSetupState', () => {
  it('a missing secret file with no user record is secret_missing (never set up)', async () => {
    dropSecret();
    expect(await getSetupState()).toEqual({ configured: false, reason: 'secret_missing' });
  });

  it('a missing secret file beside a user record is secret_moved — an earlier release set it up', async () => {
    dropSecret();
    fsMocks.readdir.mockResolvedValue(['owner.json']);
    expect(await getSetupState()).toEqual({ configured: false, reason: 'secret_moved' });
  });

  it('a blank secret file counts as missing; NEXTAUTH_SECRET in the environment is no source', async () => {
    writeSecret('   \n');
    vi.stubEnv('NEXTAUTH_SECRET', 'env-is-not-a-source');
    try {
      expect(await getSetupState()).toEqual({ configured: false, reason: 'secret_missing' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('the secret without a user record is setup_incomplete; non-record files do not count', async () => {
    fsMocks.readdir.mockResolvedValue(['notes.txt']);
    expect(await getSetupState()).toEqual({ configured: false, reason: 'setup_incomplete' });
    expect(fsMocks.readdir).toHaveBeenCalledWith(`${HOME}/app/users`);
  });

  it('an unreadable users directory is setup_incomplete, never a throw', async () => {
    fsMocks.readdir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(await getSetupState()).toEqual({ configured: false, reason: 'setup_incomplete' });
  });

  it('the secret plus one user record is configured — projects are not asked', async () => {
    fsMocks.readdir.mockResolvedValue(['owner.json']);
    expect(await getSetupState()).toEqual({ configured: true });
    expect(fsMocks.readdir).toHaveBeenCalledTimes(1);
    expect(fsMocks.readdir).not.toHaveBeenCalledWith(`${HOME}/app/projects`);
  });

  it('a configured answer latches: later record loss does not flip it, and no fs call follows', async () => {
    expect(isSetupLatched()).toBe(false);
    fsMocks.readdir.mockResolvedValue(['owner.json']);
    await getSetupState();
    expect(isSetupLatched()).toBe(true);
    fsMocks.readdir.mockClear();
    fsMocks.readdir.mockResolvedValue([]);
    for (let i = 0; i < 20; i += 1) expect(await getSetupState()).toEqual({ configured: true });
    expect(fsMocks.readdir).not.toHaveBeenCalled();
  });

  it('a negative answer is reused inside the 2 s window and re-read after it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-16T10:00:00Z'));
    await Promise.all([getSetupState(), getSetupState(), getSetupState()]);
    await getSetupState();
    expect(fsMocks.readdir).toHaveBeenCalledTimes(1);
    fsMocks.readdir.mockResolvedValue(['owner.json']);
    vi.setSystemTime(new Date('2026-10-16T10:00:01.500Z'));
    expect(await getSetupState()).toEqual({ configured: false, reason: 'setup_incomplete' });
    vi.setSystemTime(new Date('2026-10-16T10:00:02.100Z'));
    expect(await getSetupState()).toEqual({ configured: true });
    expect(fsMocks.readdir).toHaveBeenCalledTimes(2);
  });
});

describe('isSetupComplete / assertSetupComplete share the predicate', () => {
  it('without the secret: false, and the assert throws SetupRequiredError', async () => {
    dropSecret();
    expect(await isSetupComplete()).toBe(false);
    await expect(assertSetupComplete()).rejects.toBeInstanceOf(SetupRequiredError);
  });

  it('configured: true, and the assert resolves', async () => {
    fsMocks.readdir.mockResolvedValue(['owner.json']);
    expect(await isSetupComplete()).toBe(true);
    await expect(assertSetupComplete()).resolves.toBeUndefined();
  });
});
