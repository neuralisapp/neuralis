/**
 * Every `workspace.provider` fill receives the snapshot the workspace applied
 * and the ONE asset-scope client — the card reconcile runs inside the
 * card-owning package's fill and needs both. Paired: the client is the very
 * object the widgets use (never a second copy), and its identity is stable
 * across renders (it is an effect dependency there).
 */

import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { PackageRuntimeSnapshot } from '@neuralis/package-system/contracts';

vi.mock('../packages/buildWorkspaceHostPort', () => ({ workspaceHostPort: {} }));

const { wrapInWorkspaceProviders } = await import('../NeuralisHostProvider');
const { workspaceAssetScope, acquirePackageAssetScope, isAssetBackedSurfaceUrl } = await import('../packages/packageAssetScope');

const Outer = (): null => null;
const Inner = (): null => null;
const snapshot = { revision: 'r1' } as unknown as PackageRuntimeSnapshot;

type Wrapped = ReactElement<{ snapshot: unknown; assetScope: unknown; children: unknown }>;

describe('workspace.provider fills receive { snapshot, assetScope }', () => {
  it('each fill, outermost first, gets the applied snapshot and the ONE asset-scope client', () => {
    const tree = wrapInWorkspaceProviders([Outer, Inner], snapshot, 'workspace') as Wrapped;
    expect(tree.type).toBe(Outer);
    expect(tree.props.snapshot).toBe(snapshot);
    expect(tree.props.assetScope).toBe(workspaceAssetScope);
    const inner = tree.props.children as Wrapped;
    expect(inner.type).toBe(Inner);
    expect(inner.props.snapshot).toBe(snapshot);
    expect(inner.props.assetScope).toBe(workspaceAssetScope);
    expect(inner.props.children).toBe('workspace');
  });

  it('the client is the widgets\' own module state and keeps its identity across renders (paired control)', () => {
    expect(workspaceAssetScope.acquire).toBe(acquirePackageAssetScope);
    expect(workspaceAssetScope.isAssetBacked).toBe(isAssetBackedSurfaceUrl);
    const a = wrapInWorkspaceProviders([Outer], null, null) as Wrapped;
    const b = wrapInWorkspaceProviders([Outer], snapshot, null) as Wrapped;
    expect(a.props.assetScope).toBe(b.props.assetScope);
    expect(a.props.snapshot).toBeNull();
  });

  it('no fills: the tree is returned unwrapped', () => {
    expect(wrapInWorkspaceProviders([], snapshot, 'workspace')).toBe('workspace');
  });
});
