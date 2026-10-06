import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/server/auth/session';
import { getProjectById } from '@/server/store/ProjectStore';
import { isOwnerStrengthOf } from '@/server/projects/access';
import { restoreProject, ProjectLifecycleError } from '@/server/projects/projectDeletion';
import { writeAuditLog } from '@/server/store/AuditStore';

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/projects/[id]/restore — owner-only. Restore an archived project.
 * 409 if the project is not archived (nothing to restore).
 */
export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  let user;
  try {
    user = await requireSession();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const existing = await getProjectById(id);
  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  // D-B — owner STRENGTH (priority <= 1), not `ownerId` identity.
  if (!isOwnerStrengthOf(existing, user.id)) {
    return NextResponse.json({ error: 'Only an owner can restore a project' }, { status: 403 });
  }

  try {
    await restoreProject(id);
  } catch (err) {
    if (err instanceof ProjectLifecycleError && err.code === 'not_archived') {
      return NextResponse.json({ error: 'Project is not archived' }, { status: 409 });
    }
    if (err instanceof ProjectLifecycleError && err.code === 'not_found') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    console.error('[projects] restore failed', err);
    return NextResponse.json({ error: 'Project restore failed' }, { status: 500 });
  }

  await writeAuditLog({
    userId: user.id,
    userEmail: user.email,
    action: 'project.restore',
    target: id,
  });
  return NextResponse.json({ ok: true, restored: true });
}
