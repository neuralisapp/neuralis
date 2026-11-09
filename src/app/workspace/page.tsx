import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth/session';
import { getUserById } from '@/server/store/UserStore';
import { getSSRSnapshot } from '@/server/packages/snapshotForSSR';
import { refreshSnapshot } from './actions';
import { WorkspacePageClient } from './WorkspacePageClient';
import type { PackageRuntimeSnapshot } from '@neuralis/package-system/contracts';
import { detectDocker } from '@neuralis/package-system/paths';

// Rendered per request, never prerendered: the page reads the visitor's session, and NextAuth
// reads the session secret (a file in the data home, `sessionSecret`) the moment it is asked —
// `next build` runs with no data home.
export const dynamic = 'force-dynamic';

export default async function WorkspacePage() {
  const user = await getSessionUser();
  if (!user) redirect('/auth');

  // Check mustChangePassword from UserStore (source of truth), not the JWT (may be stale)
  const userRecord = await getUserById(user.id);
  const mustChangePassword = userRecord?.mustChangePassword === true;

  // Fetch snapshot directly during SSR — embedded in the RSC payload, no HTTP/RPC needed.
  // Bootstrap completes in instrumentation hook, so getSSRSnapshot() should resolve instantly.
  // Timeout protects against first-request-before-bootstrap edge case.
  let initialSnapshot: PackageRuntimeSnapshot | null = null;
  try {
    initialSnapshot = await Promise.race([
      getSSRSnapshot(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ]);
  } catch {
    // Bootstrap not ready — client will retry via Server Action
  }

  return (
    <WorkspacePageClient
      initialSnapshot={initialSnapshot}
      refreshSnapshot={refreshSnapshot}
      isDocker={detectDocker()}
      mustChangePassword={mustChangePassword}
      userId={user.id}
    />
  );
}
