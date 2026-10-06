import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/server/auth/session';
import { getProjectById, updateProject, ProjectUpdateError } from '@/server/store/ProjectStore';
import { archiveProject } from '@/server/projects/projectDeletion';
import { writeAuditLog } from '@/server/store/AuditStore';
import {
  canManageProjectRoles,
  diffMemberMaps,
  isOwnerStrengthOf,
  parseProjectPatch,
  validateLimitsPatchPriority,
  validateMemberPatchPriority,
  validateRolesPatchPriority,
} from '@/server/projects/access';
import { toProjectView } from '@/server/projects/projectView';
import { resolveProjectRoleContext } from '@/server/auth/resolveSessionContext';
import { rolePriority } from '@neuralis/package-system/access';
import {
  AppearanceImageError,
  appearanceChanged,
  applyAppearancePatch,
  removeAppearanceImage,
  writeAppearanceImage,
  type StoredAppearanceImage,
} from '@/server/appearance/appearanceImageStore';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  let user;
  try {
    user = await requireSession();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const project = await getProjectById(id);
  if (!project) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (!project.members[user.id]) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  // D2 — the record is served through the ONE feature-keyed projection: a bare
  // membership no longer reads other members' emails, other roles' grant lists,
  // or other members' spend caps.
  const roleCtx = resolveProjectRoleContext(project, user.id);
  return NextResponse.json(
    toProjectView(project, { userId: user.id, grantedFeatures: roleCtx.grantedFeatures }),
  );
}

export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
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
  const member = existing.members[user.id];
  if (!member) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const role = existing.roles[member.role];
  if (!role) {
    return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const parsed = parseProjectPatch(body);
  if (!parsed.patch) {
    return NextResponse.json({ error: parsed.error ?? 'Invalid project patch body' }, { status: 400 });
  }

  const canManageRoles = canManageProjectRoles({ member, role });
  if (parsed.privileged && !canManageRoles) {
    return NextResponse.json({ error: 'Forbidden: role management permission required' }, { status: 403 });
  }
  if (!parsed.privileged && role.agents === 'view' && !canManageRoles) {
    return NextResponse.json({ error: 'Insufficient permissions' }, { status: 403 });
  }
  // The name is the tenant's label every member sees, and the name and the
  // description both enter the `<workspace>` block of EVERY member's agents:
  // changing either is an owner-strength act, the same floor as archive /
  // restore / delete. Resending an unchanged value is not a change.
  const renamed = parsed.patch.name !== undefined && parsed.patch.name !== existing.name;
  const described =
    parsed.patch.description !== undefined && parsed.patch.description !== (existing.description ?? '');
  if ((renamed || described) && !isOwnerStrengthOf(existing, user.id)) {
    return NextResponse.json(
      { error: 'Forbidden: only a project owner can change the project name or description' },
      { status: 403 },
    );
  }
  // The appearance (icon, colour, picture) is the project's identity in every
  // member's switcher — the same owner-strength floor as the name. A picture
  // upload always counts as an edit; a resend of the same icon and colour does not.
  const appearancePatch = parsed.appearance;
  const restyled =
    appearancePatch !== undefined &&
    (appearancePatch.image instanceof Uint8Array ||
      appearanceChanged(
        existing.appearance,
        applyAppearancePatch(existing.appearance, appearancePatch, existing.appearance?.image),
      ));
  if (restyled && !isOwnerStrengthOf(existing, user.id)) {
    return NextResponse.json(
      { error: 'Forbidden: only a project owner can change the project appearance' },
      { status: 403 },
    );
  }

  // S1 — the role/member write gates. Even a `canManageRoles` holder may only
  // edit roles STRICTLY WEAKER than their own priority, may only grant and only
  // revoke features they hold themselves, and may not remove or re-role a
  // stronger member. Both bodies live in the kernel and are shared with the
  // admin package's `PATCH config/roles`; the caller object is REQUIRED, so a
  // future call site cannot silently inherit a wrong default.
  //
  // `grantedFeatures` here is the caller's own role grant list, which is exactly
  // what `resolveProjectRoleContext` would project onto a `SessionContext`.
  const caller = {
    priority: rolePriority(member.role, role.priority),
    grantedFeatures: role.grantedFeatures,
  };
  const rolesPriorityError = validateRolesPatchPriority(existing, parsed.patch, caller);
  if (rolesPriorityError) {
    return NextResponse.json({ error: rolesPriorityError }, { status: 403 });
  }
  const membersPriorityError = validateMemberPatchPriority(existing, parsed.patch, caller);
  if (membersPriorityError) {
    return NextResponse.json({ error: membersPriorityError }, { status: 403 });
  }
  // K11 — spend-limit governance: tightening is free, loosening/removing a row
  // is gated on strength (strictly-stronger for byRole/byUser targets, admin
  // strength for projectTotal/byAgent). Runs BEFORE updateProject because the
  // store replaces `spend` wholesale.
  const limitsPriorityError = validateLimitsPatchPriority(existing, parsed.patch, caller);
  if (limitsPriorityError) {
    return NextResponse.json({ error: limitsPriorityError }, { status: 403 });
  }

  let storedImage: StoredAppearanceImage | undefined;
  if (restyled && appearancePatch?.image instanceof Uint8Array) {
    try {
      storedImage = await writeAppearanceImage('project', id, appearancePatch.image);
    } catch (err) {
      if (err instanceof AppearanceImageError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
  }

  // An appearance edit merges with the record AS IT IS ON DISK (a concurrent
  // picture change must not be lost) and re-derives the owner-strength floor
  // there — the producer form. Every other field keeps the object patch.
  const seen: { previous?: StoredAppearanceImage; denied: boolean } = { denied: false };
  let updated;
  try {
    updated = !restyled || !appearancePatch
      ? await updateProject(id, parsed.patch)
      : await updateProject(id, (current) => {
          if (!isOwnerStrengthOf(current, user.id)) {
            seen.denied = true;
            return null;
          }
          seen.previous = current.appearance?.image;
          return {
            ...parsed.patch,
            appearance: applyAppearancePatch(current.appearance, appearancePatch, storedImage) ?? null,
          };
        });
  } catch (err) {
    if (err instanceof ProjectUpdateError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error('[projects] PATCH failed', err);
    return NextResponse.json({ error: 'Project update failed' }, { status: 500 });
  }
  if (seen.denied) {
    return NextResponse.json(
      { error: 'Forbidden: only a project owner can change the project appearance' },
      { status: 403 },
    );
  }
  if (!updated) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const previousImage = seen.previous;
  if (previousImage && previousImage.hash !== updated.appearance?.image?.hash) {
    await removeAppearanceImage('project', id, previousImage).catch(() => undefined);
  }
  if (parsed.patch.limits) {
    await writeAuditLog({
      userId: user.id,
      userEmail: user.email ?? undefined,
      action: 'project.limits_update',
      target: id,
    });
  }
  // The name is a label every member already sees, so it is audited as text;
  // the description and the appearance are audited as CHANGED only.
  if (renamed || described || restyled) {
    await writeAuditLog({
      userId: user.id,
      userEmail: user.email ?? undefined,
      action: 'project.update',
      target: id,
      details: {
        ...(renamed ? { name: { from: existing.name, to: updated.name } } : {}),
        ...(described ? { description: { changed: true } } : {}),
        ...(restyled ? { appearance: { changed: true } } : {}),
      },
    });
  }
  // A membership write (add / remove / re-role) is audited with what it changed.
  const memberDiff = parsed.patch.members ? diffMemberMaps(existing.members, updated.members) : null;
  if (memberDiff) {
    await writeAuditLog({
      userId: user.id,
      userEmail: user.email ?? undefined,
      action: 'project.update',
      target: id,
      details: { members: memberDiff },
    });
  }
  // Same projection on the PATCH echo — a `canManageRoles` holder gets the full
  // record by the write-implies-read carve-out inside `toProjectView`.
  const roleCtx = resolveProjectRoleContext(updated, user.id);
  return NextResponse.json(
    toProjectView(updated, { userId: user.id, grantedFeatures: roleCtx.grantedFeatures }),
  );
}

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
  // D-B — owner STRENGTH (priority <= 1), not `ownerId` identity. A custom role
  // declared at priority 1 archives exactly like the built-in `owner`; a creator
  // who was later demoted does not.
  if (!isOwnerStrengthOf(existing, user.id)) {
    return NextResponse.json({ error: 'Only an owner can delete a project' }, { status: 403 });
  }
  // happy-wondering-yeti — DELETE now ARCHIVES (soft, reversible). Permanent
  // removal is the separate owner-only `DELETE …/permanent` route.
  await archiveProject(id);
  await writeAuditLog({
    userId: user.id,
    userEmail: user.email ?? undefined,
    action: 'project.archive',
    target: id,
  });
  return NextResponse.json({ ok: true, archived: true });
}
