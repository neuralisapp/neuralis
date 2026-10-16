/**
 * The setup-state predicate (`server/init.ts`): configured = the session secret
 * is set AND at least one user record exists. The answer never needs `getEnv()`
 * (which throws without the secret), a positive answer latches, and a negative
 * one is reused for ~2 s before the disk is asked again.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsMocks = vi.hoisted(() => ({ readdir: vi.fn<(dir: string) => Promise<string[]>>() }));
vi.mock('fs/promises', () => ({ readdir: fsMocks.readdir }));
vi.mock('@neuralis/package-system/paths', () => ({
  resolveNeuralisHome: () => ({ home: '/nr-init-test-home', appRoot: '/nr-init-test-home/app', projectsRoot: '/nr-init-test-home/projects' }),
}));

import { SetupRequiredError, assertSetupComplete, getSetupState, isSetupComplete, isSetupLatched } from '../init';

const SETUP_STATE_SLOT = Symbol.for('@neuralis/host:setupState');
const savedSecret = process.env.NEXTAUTH_SECRET;

beforeEach(() => {
  delete (globalThis as { [SETUP_STATE_SLOT]?: unknown })[SETUP_STATE_SLOT];
  process.env.NEXTAUTH_SECRET = 'test-secret';
  fsMocks.readdir.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { [SETUP_STATE_SLOT]?: unknown })[SETUP_STATE_SLOT];
  if (savedSecret === undefined) delete process.env.NEXTAUTH_SECRET;
  else process.env.NEXTAUTH_SECRET = savedSecret;
});

describe('getSetupState', () => {
  it('a missing secret is secret_missing, answered without touching the disk', async () => {
    delete process.env.NEXTAUTH_SECRET;
    expect(await getSetupState()).toEqual({ configured: false, reason: 'secret_missing' });
    expect(fsMocks.readdir).not.toHaveBeenCalled();
  });

  it('a blank secret counts as missing', async () => {
    process.env.NEXTAUTH_SECRET = '   ';
    expect(await getSetupState()).toEqual({ configured: false, reason: 'secret_missing' });
  });

  it('the secret without a user record is setup_incomplete; non-record files do not count', async () => {
    fsMocks.readdir.mockResolvedValue(['notes.txt']);
    expect(await getSetupState()).toEqual({ configured: false, reason: 'setup_incomplete' });
    expect(fsMocks.readdir).toHaveBeenCalledWith('/nr-init-test-home/app/users');
  });

  it('an unreadable users directory is setup_incomplete, never a throw', async () => {
    fsMocks.readdir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(await getSetupState()).toEqual({ configured: false, reason: 'setup_incomplete' });
  });

  it('the secret plus one user record is configured — projects are not asked', async () => {
    fsMocks.readdir.mockResolvedValue(['owner.json']);
    expect(await getSetupState()).toEqual({ configured: true });
    expect(fsMocks.readdir).toHaveBeenCalledTimes(1);
    expect(fsMocks.readdir).not.toHaveBeenCalledWith('/nr-init-test-home/app/projects');
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
    delete process.env.NEXTAUTH_SECRET;
    expect(await isSetupComplete()).toBe(false);
    await expect(assertSetupComplete()).rejects.toBeInstanceOf(SetupRequiredError);
  });

  it('configured: true, and the assert resolves', async () => {
    fsMocks.readdir.mockResolvedValue(['owner.json']);
    expect(await isSetupComplete()).toBe(true);
    await expect(assertSetupComplete()).resolves.toBeUndefined();
  });
});
