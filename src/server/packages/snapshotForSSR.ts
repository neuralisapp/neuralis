import { ensureCommunityRuntime } from './runtime';
import { getPackageSnapshot } from './snapshot';
import type { PackageRuntimeSnapshot } from '@neuralis/package-system/contracts';

export async function getSSRSnapshot(): Promise<PackageRuntimeSnapshot> {
  await ensureCommunityRuntime();
  // Deny-by-default first paint (S2d-A): the SSR session (`SessionUser`) carries
  // no projectId/grantedFeatures, so there is no role context to filter against
  // here. Passing `[]` (not `undefined`) excludes every feature-gated
  // contribution from the embedded RSC payload — only ungated builtins render
  // until the client refreshes from the authoritative, per-project filtered
  // snapshot (the `/api/packages/runtime` route, which DOES pass grantedFeatures).
  // Owners see a benign "less-then-more" flicker, never "more-then-less".
  return getPackageSnapshot({ host: 'neuralis-workspace' }, []);
}
