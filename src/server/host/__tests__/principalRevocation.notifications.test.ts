/**
 * A DELETED principal's notifications go with the account: the revocation
 * close sweeps them (in every project — the sweep itself is pinned in the
 * store suite), and ONLY for `deleted` — a disable, a password reset or a
 * membership removal keeps the user's inbox, as it keeps every other record.
 */

import { describe, expect, it, vi } from 'vitest';

const sweep = vi.fn(async () => 2);

vi.mock('../../notifications/notificationStore', () => ({ removeDeletedUserNotifications: sweep }));
vi.mock('../../packages/PackageAssetScopeAuthority', () => ({
  getPackageAssetScopeAuthority: () => ({ revokeForUser: () => 0 }),
}));

const { revokePrincipal } = await import('../principalRevocation');

describe('revokePrincipal — notification sweep', () => {
  it('runs for `deleted`', async () => {
    await revokePrincipal({ userId: 'u1', reason: 'deleted' }, async () => undefined);
    expect(sweep).toHaveBeenCalledWith('u1');
  });

  it.each(['disabled', 'sessions_reset', 'membership_removed', 'project_archived'] as const)(
    'paired control: does NOT run for `%s`',
    async (reason) => {
      sweep.mockClear();
      await revokePrincipal({ userId: 'u1', projectId: 'p1', reason }, async () => undefined);
      expect(sweep).not.toHaveBeenCalled();
    },
  );

  it('a failing sweep stops nothing else', async () => {
    sweep.mockRejectedValueOnce(new Error('disk'));
    const fanOut = vi.fn(async () => undefined);
    await revokePrincipal({ userId: 'u1', reason: 'deleted' }, fanOut);
    expect(fanOut).toHaveBeenCalled();
  });
});
