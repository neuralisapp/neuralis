/**
 * The login page asks one question — is a first account still needed — and the
 * answer carries nothing else, signed in or not.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ isSetupComplete: vi.fn(), hasAnyUsers: vi.fn() }));

vi.mock('@/server/init', () => ({ isSetupComplete: mocks.isSetupComplete }));
vi.mock('@/server/store/UserStore', () => ({ hasAnyUsers: mocks.hasAnyUsers }));

import { GET } from '../route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isSetupComplete.mockResolvedValue(true);
});

describe('GET /api/auth/users', () => {
  it('answers only bootstrapRequired — no user list', async () => {
    mocks.hasAnyUsers.mockResolvedValue(true);
    expect(await (await GET()).json()).toEqual({ bootstrapRequired: false });
  });

  it('an instance without users needs bootstrap', async () => {
    mocks.hasAnyUsers.mockResolvedValue(false);
    expect(await (await GET()).json()).toEqual({ bootstrapRequired: true });
  });

  it('an unfinished setup needs bootstrap', async () => {
    mocks.isSetupComplete.mockResolvedValue(false);
    expect(await (await GET()).json()).toEqual({ bootstrapRequired: true });
  });
});
