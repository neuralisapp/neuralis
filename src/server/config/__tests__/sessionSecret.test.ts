/**
 * The ONE session secret reader (`sessionSecret`, `hasSessionSecret`): the data
 * home's `app/config/session-secret.key` and nothing else — never
 * `NEXTAUTH_SECRET` from the environment, never a generated value (a missing
 * file is the setup-required signal), read once and cached. And the build-time
 * property it exists for: `authOptions.secret` is a GETTER, so importing the
 * auth options with no data home reads nothing. A throwaway home only.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { getEnv, hasSessionSecret, resetEnvCache, sessionSecret, SessionSecretMissingError } from '../env';

const homes: string[] = [];
afterAll(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });
afterEach(() => { resetEnvCache(); vi.unstubAllEnvs(); });

function home(secret?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'nrs-session-secret-'));
  homes.push(root);
  mkdirSync(join(root, 'app', 'config'), { recursive: true });
  if (secret !== undefined) writeFileSync(join(root, 'app', 'config', 'session-secret.key'), secret);
  vi.stubEnv('NEURALIS_HOME', root);
  return root;
}

describe('sessionSecret — the data home\'s file', () => {
  it('reads the trimmed line once, then serves it from the cache', () => {
    const root = home('  the-secret\n');
    expect(hasSessionSecret()).toBe(true);
    expect(sessionSecret()).toBe('the-secret');
    rmSync(join(root, 'app', 'config', 'session-secret.key'));
    expect(sessionSecret()).toBe('the-secret');
  });

  it('absent: a typed refusal naming the file — and nothing is generated; NEXTAUTH_SECRET in the environment is no source', () => {
    const root = home();
    vi.stubEnv('NEXTAUTH_SECRET', 'env-is-not-a-source');
    expect(hasSessionSecret()).toBe(false);
    expect(() => sessionSecret()).toThrow(SessionSecretMissingError);
    expect(() => sessionSecret()).toThrow(join(root, 'app', 'config', 'session-secret.key'));
    expect(readdirSync(join(root, 'app', 'config'))).toEqual([]);
  });

  it('a blank file counts as absent', () => {
    home(' \n');
    expect(hasSessionSecret()).toBe(false);
    expect(() => sessionSecret()).toThrow(SessionSecretMissingError);
  });

  it('getEnv() no longer needs the secret (it carries none)', () => {
    home();
    expect(getEnv()).not.toHaveProperty('auth.secret');
  });
});

describe('authOptions — the secret is read per request, never at import (`next build` has no data home)', () => {
  it('importing the options reads nothing; the getter reads the file when asked', async () => {
    const root = home();
    const { authOptions } = await import('../../auth/authOptions');
    expect(Object.getOwnPropertyDescriptor(authOptions, 'secret')?.get).toBeTypeOf('function');
    expect(() => authOptions.secret).toThrow(SessionSecretMissingError);
    writeFileSync(join(root, 'app', 'config', 'session-secret.key'), 'per-request\n');
    expect(authOptions.secret).toBe('per-request');
  });
});
