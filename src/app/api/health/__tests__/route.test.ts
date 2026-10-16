import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapStatus } from '@/server/host/bootstrap';
import type { RuntimeHealthReport } from '@neuralis/package-system/contracts';
import type { SetupState } from '@/server/init';
const mocks = vi.hoisted(() => ({
  getBootstrapStatus: vi.fn<() => BootstrapStatus>(),
  health: vi.fn<() => Promise<RuntimeHealthReport>>(), booted: true,
  getSetupState: vi.fn<() => Promise<SetupState>>(),
}));
vi.mock('@/server/init', () => ({ getSetupState: mocks.getSetupState }));
vi.mock('@/server/host/bootstrap', () => ({
  getBootstrapStatus: mocks.getBootstrapStatus,
  peekRuntime: () => mocks.booted ? { health: mocks.health } : null,
}));
import { GET } from '../route';
const base: BootstrapStatus = { phase: 'starting', error: null, errorCode: null, startedAt: Date.now() - 5_000, readyAt: null };
beforeEach(() => {
  mocks.booted = true;
  mocks.getSetupState.mockResolvedValue({ configured: true });
  mocks.getBootstrapStatus.mockReturnValue(base);
  mocks.health.mockResolvedValue({ status: 'ok', packages: [], refused: [] });
});
describe('GET /api/health', () => {
  it('reports ready only for a booted, healthy runtime', async () => {
    const readyAt = Date.now();
    mocks.getBootstrapStatus.mockReturnValue({ ...base, phase: 'ready', readyAt });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ready', health: 'ok', readyAt, refusedBuiltins: 0 });
  });
  it.each(['starting', 'degraded', 'failed'] as const)('a package health %s makes readiness unavailable', async (status) => {
    mocks.getBootstrapStatus.mockReturnValue({ ...base, phase: 'ready' });
    mocks.health.mockResolvedValue({ status, packages: [{ packageId: 'provider', status, checks: [] }], refused: [] });
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: 'degraded', health: status });
  });
  it('a builtin refused at boot keeps the container ready and names no package here (Admin health names it)', async () => {
    mocks.getBootstrapStatus.mockReturnValue({ ...base, phase: 'ready', readyAt: Date.now() });
    mocks.health.mockResolvedValue({ status: 'ok', packages: [], refused: [
      { packageId: '@acme/pair-a', reason: 'load_failed' }, { packageId: '@acme/pair-b', reason: 'conflict' },
    ] });
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ status: 'ready', refusedBuiltins: 2 });
    expect(JSON.stringify(body)).not.toMatch(/@acme|load_failed|conflict/);
  });
  it.each(['starting', 'loading'] as const)('never asks package health while %s', async (phase) => {
    mocks.getBootstrapStatus.mockReturnValue({ ...base, phase }); mocks.health.mockClear();
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'initializing', phase });
    expect(mocks.health).not.toHaveBeenCalled();
  });
  it.each(['upgrade_required', 'data_format_newer', 'bootstrap_failed'] as const)(
    'a rejected bootstrap (%s) answers 503 with its fixed code and no raw detail',
    async (errorCode) => {
      const error = 'Data format upgrade required (neuralis/credential): run `neuralis upgrade` — /private/home/checkpoints/cp-1';
      mocks.getBootstrapStatus.mockReturnValue({ ...base, phase: 'error', error, errorCode });
      const response = await GET();
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ status: 'error', error: 'bootstrap_failed', code: errorCode });
    },
  );
  it.each(['secret_missing', 'setup_incomplete'] as const)('an unconfigured instance (%s) answers 503 setup_required before the runtime is asked', async (reason) => {
    mocks.getSetupState.mockResolvedValue({ configured: false, reason });
    mocks.getBootstrapStatus.mockReturnValue({ ...base, phase: 'ready', readyAt: Date.now() });
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'setup_required', code: reason });
    expect(mocks.getBootstrapStatus).not.toHaveBeenCalled();
    expect(mocks.health).not.toHaveBeenCalled();
  });
  it('a health hook failure gives a classified failure', async () => {
    mocks.getBootstrapStatus.mockReturnValue({ ...base, phase: 'ready' });
    mocks.health.mockRejectedValueOnce(new Error('/private/token secret'));
    expect(await (await GET()).json()).toEqual({ status: 'degraded', health: 'failed' });
  });
});
