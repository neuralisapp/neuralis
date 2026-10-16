/**
 * A rejected bootstrap is answered by `/api/health` with a FIXED code from a
 * closed set, through the real `getRuntime()` catch and the real route — the
 * data-format claim is the only mocked step, and it is the boot's first await.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataFormatClaimError, DataFormatNewerError } from '@neuralis/package-system/data';

const claim = vi.hoisted(() => vi.fn<() => Promise<never>>());
// A temp root, never the live home: the claim rejects before any store reads it.
vi.mock('../../config/env', () => ({ getEnv: () => ({ appRoot: '/nonexistent-neuralis-test/app', projectsRoot: '/nonexistent-neuralis-test/projects' }) }));
// A configured instance: the route's setup arm is not what this file measures.
vi.mock('../../init', () => ({ getSetupState: async () => ({ configured: true }) }));
vi.mock('../../store/dataFormats', async (original) => ({
  ...(await original<typeof import('../../store/dataFormats')>()),
  claimAllDeclaredDataFormats: claim,
}));

const { describeDataFormatRefusal } = await import('../../store/dataFormats');
const { getRuntime, getBootstrapStatus } = await import('../bootstrap');
const { GET } = await import('@/app/api/health/route');

beforeEach(() => {
  Reflect.deleteProperty(globalThis, '__neuralis_runtime_bootstrap__');
});

describe('a rejected bootstrap on /api/health', () => {
  it.each([
    ['upgrade_required', new DataFormatClaimError('upgrade_required', ['neuralis/credential'], 'run `neuralis upgrade --apply`')],
    ['data_format_newer', describeDataFormatRefusal(new DataFormatNewerError([{ kind: 'neuralis/project', stored: 7, codeVersion: 2 }], 'cp-2026-10-10'))],
    ['bootstrap_failed', new Error('EACCES: permission denied, open \'/srv/home/app/users\'')],
  ] as const)('%s → 503 with that code; the message stays in the status, never on the wire', async (code, error) => {
    claim.mockRejectedValueOnce(error);
    await expect(getRuntime()).rejects.toBe(error);
    expect(getBootstrapStatus()).toMatchObject({ phase: 'error', errorCode: code, error: (error as Error).message });
    const response = await GET();
    expect(response.status).toBe(503);
    const body: unknown = await response.json();
    expect(body).toEqual({ status: 'error', error: 'bootstrap_failed', code });
    expect(JSON.stringify(body)).not.toMatch(/neuralis\/|cp-2026|\/srv|v7/);
  });
});
