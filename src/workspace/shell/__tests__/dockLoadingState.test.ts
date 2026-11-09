/**
 * The primary dock shows its loading state while the project's packages load.
 * The SSR seed releases `snapshotReady`, but it is UNSCOPED, and the package
 * tiles read only the SCOPED snapshot — so without the scoped-pending term the
 * dock sat empty with no loading state until the scoped fetch landed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PackageRuntimeSnapshot } from '@neuralis/package-system/contracts';
import { installFakeDom } from './fakeDom';

const dom = installFakeDom();
Object.defineProperty(window, 'screen', { configurable: true, value: { width: 1280, height: 800 } });
Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });

const probe = vi.hoisted(() => ({ loading: {} as Record<string, boolean | undefined> }));

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }));
vi.mock('../Dock', () => {
  // A witness in place of the real dock: it records the `loading` prop per dock.
  function Dock({ dockId, loading }: { dockId: string; loading?: boolean }) {
    probe.loading[dockId] = loading;
    return null;
  }
  function DockCluster({ children }: { children: (open: boolean) => unknown }) { return children(false); }
  return { Dock, DockCluster };
});
vi.mock('../useDockItems', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../useDockItems')>()),
  usePrimaryDockItems: () => [],
  useSecondaryDockItems: () => [],
}));
vi.mock('../AnimatedUniverseBackground', () => ({ AnimatedUniverseBackground: () => null }));
vi.mock('../../theme/useTheme', () => ({ useTheme: () => ({ backgroundTheme: { useUniverseBackground: false }, dockTheme: { id: 'dark', colors: {} } }) }));

const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { WorkspaceShell } = await import('../WorkspaceShell');
const { useWorkspaceStore } = await import('../../store/workspaceStore');
const { loadScopedSnapshot, seedSnapshotCache } = await import('../../packages/runtimeClient');

const RETRY_MS = 6000;
const snapshot = { revision: 'r', generatedAt: 0, packages: [], tools: [], surfaces: [] } as unknown as PackageRuntimeSnapshot;
let root: ReturnType<typeof createRoot> | null = null;
let cancel: (() => void) | null = null;

async function renderShell(): Promise<void> {
  root ??= createRoot(dom.container as unknown as Element);
  await act(async () => { root!.render(createElement(WorkspaceShell, { snapshotReady: true, children: null })); });
}

function inScope(projectId: string): { projectId: string; agentId: string } {
  const scope = { projectId, agentId: 'a1' };
  useWorkspaceStore.setState((s) => ({ session: { ...s.session, ...scope } }));
  return scope;
}

beforeEach(() => {
  probe.loading = {};
  // The SSR seed: unscoped, which is what released `snapshotReady`.
  seedSnapshotCache(snapshot);
});

afterEach(async () => {
  cancel?.();
  cancel = null;
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the primary dock loading state follows the scoped snapshot', () => {
  it('a null scoped snapshot keeps the primary dock loading after the unscoped seed; the scoped one clears it', async () => {
    const scope = inScope('dock-pending');
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    cancel = loadScopedSnapshot(scope, RETRY_MS, () => undefined);
    await renderShell();
    expect(probe.loading).toEqual({ primary: true, secondary: false });
    await act(async () => { seedSnapshotCache(snapshot, scope); });
    expect(probe.loading).toEqual({ primary: false, secondary: false });
  });

  it('a rejected fetch retries once, then no timer is left and the dock keeps loading until a snapshot lands', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => { throw new Error('offline'); });
    vi.stubGlobal('fetch', fetchMock);
    const scope = inScope('dock-rejected');
    cancel = loadScopedSnapshot(scope, RETRY_MS, () => undefined);
    await renderShell();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(probe.loading.primary).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(RETRY_MS); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Never an empty dock presented as final: the hub's connect refetch delivers it.
    expect(probe.loading.primary).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('no project yet (pre-bootstrap) and no load in flight: the dock is not loading', async () => {
    useWorkspaceStore.setState((s) => ({ session: { ...s.session, projectId: null, agentId: null } }));
    await renderShell();
    expect(probe.loading.primary).toBe(false);
  });
});
