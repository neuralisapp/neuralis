import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/server/auth/session';
import { getProjectById } from '@/server/store/ProjectStore';
import { isOwnerStrengthOf } from '@/server/projects/access';
import { purgeProject, ProjectLifecycleError } from '@/server/projects/projectDeletion';
import { writeAuditLog } from '@/server/store/AuditStore';
import { ProjectDeprovisionError } from '@neuralis/package-system/contracts';

type Params = { params: Promise<{ id: string }> };

/**
 * DELETE /api/projects/[id]/permanent — owner-only, PERMANENT + irreversible.
 * Archived-only (409 if the project is still active): the project must be
 * archived via `DELETE /api/projects/[id]` first, so this can only ever fire on
 * an already-disabled tenant. Tombstones the id, has every package remove what it
 * keys by the project (desktop containers + profiles, vectors), then purges the
 * on-disk footprint (tree, record, source configs, project + agent credentials);
 * never touches mounted/external source roots or user/global credentials.
 *
 * A package that fails or times out answers 503 before any of the project's
 * files, record or credentials are removed — the project stays archived and the
 * delete can be retried — and the attempt is audited as a failed
 * `project.delete` naming the package.
 */
export async function DELETE(req: NextRequest, { params }: Params): Promise<NextResponse> {
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
  // D-B — owner STRENGTH (priority <= 1), not `ownerId` identity. The floor
  // "permanent delete is owner-only" is preserved exactly: priority 1 IS
  // owner-strength, and no weaker role reaches it.
  if (!isOwnerStrengthOf(existing, user.id)) {
    return NextResponse.json({ error: 'Only an owner can permanently delete a project' }, { status: 403 });
  }

  try {
    await purgeProject(id);
  } catch (err) {
    if (err instanceof ProjectLifecycleError && err.code === 'not_archived') {
      return NextResponse.json({ error: 'Project must be archived before permanent deletion' }, { status: 409 });
    }
    if (err instanceof ProjectLifecycleError && err.code === 'not_found') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    console.error('[projects] permanent delete failed', err);
    const deprovision = err instanceof ProjectDeprovisionError;
    await writeAuditLog({
      userId: user.id,
      userEmail: user.email,
      action: 'project.delete',
      target: id,
      details: deprovision
        ? { outcome: 'failed', step: 'deprovision', packageId: err.packageId, failure: err.failure }
        : { outcome: 'failed', step: 'purge' },
    });
    if (deprovision) {
      return NextResponse.json(
        {
          error: 'A package could not remove this project\'s resources. The project stays archived; try again.',
          code: 'deprovision_failed',
          packageId: err.packageId,
        },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: 'Project permanent deletion failed' }, { status: 500 });
  }

  await writeAuditLog({
    userId: user.id,
    userEmail: user.email,
    action: 'project.delete',
    target: id,
  });
  return NextResponse.json({ ok: true, deleted: true });
}
