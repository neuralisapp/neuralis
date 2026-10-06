import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '../../../../server/auth/session';
import { getProjectById, listProjectsForUser } from '../../../../server/store/ProjectStore';
import {
  PackageManageForbiddenError,
  rescanProjectPackages,
} from '../../../../server/packages/rescanProjectPackages';

export async function POST(req: NextRequest) {
  try {
    const session = await requireSession();
    const body = await req.json().catch(() => ({}));
    const requestedProjectId = typeof body?.projectId === 'string' ? body.projectId.trim() : '';
    // projectId resolution is this entrypoint's OWN concern (body || first project);
    // the shared fn re-derives access + does the actual mutation.
    const project = requestedProjectId
      ? await getProjectById(requestedProjectId)
      : (await listProjectsForUser(session.id))[0] ?? null;

    if (!project) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const result = await rescanProjectPackages(session.id, project.id);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof PackageManageForbiddenError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    console.error('[packages/rescan] failed', err);
    return NextResponse.json({ ok: false, error: 'Package rescan failed' }, { status: 500 });
  }
}
