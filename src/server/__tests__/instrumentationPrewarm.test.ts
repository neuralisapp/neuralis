import { beforeEach, describe, expect, it, vi } from 'vitest';
import { register } from '../../instrumentation';
import { getRuntime } from '../host/bootstrap';
import { ensureCommunityRuntime, getCommunityPackageRegistry } from '../packages/runtime';

const mocks = vi.hoisted(() => ({
  runtime: vi.fn<() => Promise<void>>(), ui: vi.fn<() => Promise<void>>(),
  whenReady: vi.fn<() => Promise<void>>(), registry: { listPackages: vi.fn(() => []) },
  error: vi.fn(), order: [] as string[], startMcp: vi.fn<() => Promise<void>>(),
}));
vi.mock('../upgradeWatchdog', () => ({ installUpgradeWatchdog: () => mocks.order.push('watchdog') }));
vi.mock('../requestPeerStamp', () => ({ installRequestPeerStamp: () => mocks.order.push('peer') }));
vi.mock('../host/shutdown', () => ({ installShutdownHandlers: () => mocks.order.push('shutdown'), addShutdownStep: vi.fn() }));
vi.mock('../host/bootstrap', () => ({
  getRuntime: async () => {
    await mocks.runtime();
    return { whenReady: mocks.whenReady, getLoader: () => ({}),
      getRegistry: () => mocks.registry, getRuntime: () => ({}) };
  },
  BUILTIN_PACKAGE_IDS: new Set<string>(),
}));
vi.mock('../logging/setup', () => ({ getLogger: () => ({ child: (scope: string) => ({
  error: (message: string) => mocks.error(scope, message),
}) }) }));
vi.mock('../host/principalRevocation', () => ({ startPrincipalRevocation: vi.fn() }));
vi.mock('../store/ProjectStore', () => ({ verifyProjectRecords: vi.fn() }));
vi.mock('../store/UserStore', () => ({ verifyUserRecords: vi.fn() }));
vi.mock('../logging/processMonitor', () => ({ startProcessMonitor: () => mocks.order.push('monitor'), stopProcessMonitor: vi.fn() }));
vi.mock('../mcp/startMcpServer', () => ({ startMcpServer: () => mocks.startMcp() }));
vi.mock('../packages/packageUiModules', () => ({ getUiAttachments: () => {
  getCommunityPackageRegistry();
  return mocks.ui();
} }));

beforeEach(() => {
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  vi.stubEnv('MCP_HTTP_PORT', '0');
  mocks.order.length = 0;
  Reflect.deleteProperty(globalThis, '__neuralis_package_runtime_manager__');
  mocks.runtime.mockReset();
  mocks.whenReady.mockReset().mockResolvedValue();
  mocks.ui.mockReset().mockResolvedValue();
  mocks.error.mockClear();
});

describe('runtime-ready attachment prewarm', () => {
  it('register returns before readiness or UI; watchdog/shutdown/monitor retain their order', async () => {
    let ready: () => void = () => { throw new Error('not initialized'); };
    mocks.runtime.mockReturnValue(new Promise<void>((resolve) => { ready = resolve; }));
    mocks.ui.mockImplementation(() => new Promise<void>(() => {}));
    await register();
    expect(mocks.order).toEqual(['watchdog', 'peer', 'shutdown', 'monitor']);
    expect(mocks.ui).not.toHaveBeenCalled();
    ready();
    await vi.waitFor(() => expect(mocks.ui).toHaveBeenCalledTimes(1));
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('attributes bootstrap rejection only to bootstrap and never starts UI', async () => {
    mocks.runtime.mockRejectedValue(new Error('bootstrap failed'));
    await register();
    await vi.waitFor(() => expect(mocks.error).toHaveBeenCalledWith('bootstrap-prewarm', 'Bootstrap pre-warm failed: bootstrap failed'));
    expect(mocks.ui).not.toHaveBeenCalled();
  });

  it('observes UI rejection separately and logs only its name', async () => {
    mocks.runtime.mockResolvedValue();
    mocks.ui.mockRejectedValue(new Error('/private/source/path'));
    await register();
    await vi.waitFor(() => expect(mocks.error).toHaveBeenCalledWith('package-ui-prewarm', 'UI pre-warm failed: Error'));
    expect(mocks.error).not.toHaveBeenCalledWith('bootstrap-prewarm', expect.anything());
  });
});

describe('the MCP server step', () => {
  it('a rejected bootstrap under the MCP start never rejects register() (no hook 500 on every request)', async () => {
    vi.stubEnv('MCP_HTTP_PORT', '3101');
    const refusal = Object.assign(new Error('Data format upgrade required (neuralis/credential): /srv/home'), { name: 'DataFormatClaimError' });
    mocks.runtime.mockRejectedValue(refusal);
    mocks.startMcp.mockRejectedValueOnce(refusal);
    await expect(register()).resolves.toBeUndefined();
    expect(mocks.startMcp).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(mocks.error).toHaveBeenCalledWith('bootstrap-prewarm', `Bootstrap pre-warm failed: ${refusal.message}`));
    // Logged once in full (pre-warm); the MCP line names the class only.
    expect(mocks.error).toHaveBeenCalledWith('mcp-server', expect.stringMatching(/^MCP server not started: DataFormatClaimError/));
    expect(mocks.error.mock.calls.filter(([, message]) => String(message).includes('/srv/home'))).toHaveLength(1);
  });
});

describe('real package manager readiness', () => {
  it('core readiness alone rejects the sync getter; the canonical bridge makes it usable', async () => {
    await getRuntime();
    expect(() => getCommunityPackageRegistry()).toThrow(
      'Package runtime manager not initialized. Call ensureInitialized() first.',
    );
    await ensureCommunityRuntime();
    expect(getCommunityPackageRegistry()).toBe(mocks.registry);
    expect(mocks.whenReady).toHaveBeenCalledTimes(1);
  });

  it('register stays nonblocking while real manager readiness gates the UI accessor', async () => {
    let ready: () => void = () => { throw new Error('not initialized'); };
    mocks.whenReady.mockImplementation(() => new Promise<void>((resolve) => { ready = resolve; }));
    await register();
    expect(mocks.order).toEqual(['watchdog', 'peer', 'shutdown', 'monitor']);
    await vi.waitFor(() => expect(mocks.whenReady).toHaveBeenCalledTimes(1));
    expect(mocks.ui).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
    ready();
    await vi.waitFor(() => expect(mocks.ui).toHaveBeenCalledTimes(1));
    expect(getCommunityPackageRegistry()).toBe(mocks.registry);
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('observes manager readiness refusal as UI failure without entering the accessor', async () => {
    mocks.whenReady.mockRejectedValue(new Error('/private/manager/path'));
    await register();
    await vi.waitFor(() => expect(mocks.whenReady).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mocks.error).toHaveBeenCalledWith(
      'package-ui-prewarm', 'UI pre-warm failed: Error',
    ));
    expect(mocks.ui).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalledWith('bootstrap-prewarm', expect.anything());
    expect(mocks.error.mock.calls.flat().join(' ')).not.toContain('/private/manager/path');
  });
});
