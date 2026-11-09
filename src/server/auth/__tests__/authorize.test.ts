/**
 * The Credentials `authorize` path: which address it keys on, and what an
 * unknown email costs.
 *
 *  - The lockout and the audit `ip` use the RESOLVED client address (the
 *    stamped socket peer by default), never `X-Forwarded-For` — paired with the
 *    old key, which was the raw header string.
 *  - An unknown email pays one bcrypt compare against a real cost-12 hash and
 *    counts on the same axes as a wrong password, so neither the clock nor the
 *    lockout says whether the account exists. The compare is the off-thread
 *    `verifyPassword`; a compare it cannot answer refuses the login.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';

const mocks = vi.hoisted(() => ({
  findUserByEmail: vi.fn(),
  updateUser: vi.fn(async () => null),
  writeAuditLog: vi.fn(),
  verifyPassword: vi.fn(),
  realVerifyPassword: undefined as undefined | ((password: string, hash: string) => Promise<boolean>),
}));

vi.mock('../../config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config/env')>()),
  getEnv: () => ({ trustedProxies: [] }),
}));
vi.mock('../../init', () => ({
  assertSetupComplete: async () => undefined,
  SetupRequiredError: class SetupRequiredError extends Error {},
}));
vi.mock('../../store/UserStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../store/UserStore')>()),
  findUserByEmail: mocks.findUserByEmail,
  updateUser: mocks.updateUser,
}));
vi.mock('../../store/AuditStore', () => ({ writeAuditLog: mocks.writeAuditLog }));
// A spy over the REAL pool: every row runs the actual worker unless it says otherwise.
vi.mock('../passwordPolicy', async (importOriginal) => {
  const real = await importOriginal<typeof import('../passwordPolicy')>();
  mocks.realVerifyPassword = real.verifyPassword;
  return { ...real, verifyPassword: mocks.verifyPassword };
});

const { authOptions } = await import('../authOptions');
const { beginLoginAttempt, resetLoginRateLimitForTests } = await import('../rateLimit');

type Authorize = (credentials: Record<string, string>, req: { headers: Record<string, string> }) => Promise<unknown>;
const authorize = (authOptions.providers[0] as unknown as { options: { authorize: Authorize } }).options.authorize;

const PEER = '172.18.0.1';
const HASH = bcrypt.hashSync('right-password', 4);

function login(email: string, password: string, headers: Record<string, string> = {}) {
  return authorize({ email, password }, { headers: { 'x-neuralis-peer': PEER, ...headers } });
}

describe('authorize — the resolved client address and the unknown-email cost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyPassword.mockImplementation(mocks.realVerifyPassword!);
    resetLoginRateLimitForTests();
    mocks.findUserByEmail.mockImplementation(async (email: string) =>
      email === 'known@x.co'
        ? { id: 'u1', email, name: 'K', passwordHash: HASH, status: 'active', mustChangePassword: false }
        : null,
    );
  });

  it('an unknown email pays a real bcrypt compare and counts like a wrong password', async () => {
    expect(await login('ghost@x.co', 'x')).toBeNull();
    expect(mocks.verifyPassword).toHaveBeenCalledTimes(1);
    expect(String(mocks.verifyPassword.mock.calls[0]![1])).toMatch(/^\$2[aby]\$12\$/);
    for (let i = 0; i < 4; i += 1) await login('ghost@x.co', 'x');
    expect(beginLoginAttempt('ghost@x.co', PEER).kind).toBe('locked');
  }, 30_000);

  it('a wrong password is refused; a compare the pool cannot answer refuses too, never accepts, and counts nothing', async () => {
    expect(await login('known@x.co', 'wrong')).toBeNull();
    resetLoginRateLimitForTests();
    const { PasswordHasherUnavailableError } = await import('../passwordPolicy');
    mocks.verifyPassword.mockRejectedValue(new PasswordHasherUnavailableError('the worker stopped'));
    for (let i = 0; i < 6; i += 1) expect(await login('known@x.co', 'right-password')).toBeNull();
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'login.failed', details: expect.objectContaining({ reason: 'verifier_unavailable' }) }));
    expect(mocks.writeAuditLog).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'login.success' }));
    // Paired control: the server's failure locked nothing — the same pair logs in once the pool answers.
    expect(beginLoginAttempt('known@x.co', PEER).kind).toBe('proceed');
  }, 30_000);

  it('a rotated X-Forwarded-For does not mint a fresh bucket: the 6th attempt is refused', async () => {
    for (let i = 0; i < 5; i += 1) await login('known@x.co', 'wrong', { 'x-forwarded-for': `198.51.100.${i}` });
    mocks.writeAuditLog.mockClear();
    expect(await login('known@x.co', 'right-password', { 'x-forwarded-for': '198.51.100.99' })).toBeNull();
    expect(mocks.writeAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: 'login.rate_limited', ip: PEER }));
  });

  it('paired control: the audit ip is the stamped peer, not the header the old key read', async () => {
    await login('known@x.co', 'wrong', { 'x-forwarded-for': '6.6.6.6' });
    const row = mocks.writeAuditLog.mock.calls.map((c) => c[0] as { action: string; ip?: string }).find((r) => r.action === 'login.failed');
    expect(row?.ip).toBe(PEER);
    expect(row?.ip).not.toBe('6.6.6.6');
  });

  it('a correct password logs in and stamps the session epoch', async () => {
    expect(await login('known@x.co', 'right-password')).toMatchObject({ id: 'u1', sessionEpoch: 0 });
  });
});
