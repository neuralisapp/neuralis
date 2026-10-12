import { afterEach, expect, it } from 'vitest';
import type { PackageRuntimeSnapshot } from '@neuralis/package-system/contracts';
import { installFakeDom } from './fakeDom';
const dom = installFakeDom();
const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { usePackageDockItems } = await import('../useDockItems');
const { seedSnapshotCache } = await import('../../packages/runtimeClient');
let root: ReturnType<typeof createRoot> | null = null;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; });
function Catalog({ projectId, agentId }: { projectId: string | null; agentId: string | null }) {
  const items = usePackageDockItems(projectId, agentId);
  return createElement('div', null, items.map(item => item.label).join(','));
}
const snapshot = {
  revision: 'catalog', generatedAt: 0, packages: [], tools: [],
  surfaces: [{ kind: 'dock', id: 'app', packageId: 'p', label: 'Authorized App', position: 1, action: { type: 'open-widget', widget: 'p:app' } }],
} as unknown as PackageRuntimeSnapshot;
it('never advertises SSR or another project/agent catalog and updates from the existing scoped cache', async () => {
  seedSnapshotCache(snapshot);
  root = createRoot(dom.container as unknown as Element);
  await act(async () => root!.render(createElement(Catalog, { projectId: 'one', agentId: 'agent' })));
  expect(dom.container.textContent).toBe('');
  await act(async () => seedSnapshotCache(snapshot, { projectId: 'one', agentId: 'agent' }));
  expect(dom.container.textContent).toBe('Authorized App');
  await act(async () => root!.render(createElement(Catalog, { projectId: 'two', agentId: 'agent' })));
  expect(dom.container.textContent).toBe('');
  await act(async () => root!.render(createElement(Catalog, { projectId: 'one', agentId: 'other' })));
  expect(dom.container.textContent).toBe('');
  await act(async () => seedSnapshotCache({ ...snapshot, surfaces: [] }, { projectId: 'one', agentId: 'other' }));
  expect(dom.container.textContent).toBe('');
});
