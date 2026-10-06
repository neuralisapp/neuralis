'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { BUILTIN_ROLE_PRIORITY, IconPicker, rolePriority } from '@neuralis/package-system/client';
import { updateProject, type ProjectRecord } from '@/api/projects';
import { AppearanceAvatar, appearanceImageUrl, deriveInitial } from './UserAvatar';
import {
  AppearanceBackgroundToggle,
  AppearancePopupFrame,
  useAppearanceDraft,
  type AppearanceDraft,
  type AppearancePayload,
} from './appearanceEditor';

/** Library names shown first in the project picker — data, never a second vocabulary. */
const SUGGESTED_PROJECT_ICONS = [
  'FolderKanban',
  'Briefcase',
  'Building2',
  'Rocket',
  'Layers',
  'Target',
  'Compass',
  'Boxes',
  'LayoutGrid',
  'FlaskConical',
  'Store',
  'Globe',
];

/** The ONE description bound the server enforces (`parseProjectPatch`). */
const DESCRIPTION_MAX = 2000;
const NAME_MAX = 120;

/**
 * May this user change the project's name, description and appearance? The
 * server's floor is `isOwnerStrengthOf`; this is the same predicate over the
 * client's own projected record, so the pencil shows only where the PATCH
 * would succeed. UX only — the route decides.
 */
export function canEditProjectIdentity(project: Pick<ProjectRecord, 'members' | 'roles'> | null | undefined, userId: string | null | undefined): boolean {
  if (!project || !userId) return false;
  const member = project.members[userId];
  if (!member) return false;
  return rolePriority(member.role, project.roles[member.role]?.priority) <= BUILTIN_ROLE_PRIORITY.owner;
}

/** A project's avatar: its picture, else its icon, else its initial — on its colour. */
export function ProjectAvatar({
  project,
  size = 16,
  shape = 'tile',
  className,
}: {
  project: Pick<ProjectRecord, 'id' | 'name' | 'appearance'>;
  size?: number;
  shape?: 'circle' | 'tile';
  className?: string;
}) {
  const appearance = project.appearance;
  return (
    <AppearanceAvatar
      appearance={{
        iconName: appearance?.iconName ?? null,
        color: appearance?.color ?? null,
        imageUrl: appearance?.image?.hash ? appearanceImageUrl('project', project.id, appearance.image.hash) : null,
        background: appearance?.background ?? null,
      }}
      seed={project.id}
      monogram={deriveInitial(project.name)}
      label={project.name}
      size={size}
      shape={shape}
      className={className}
    />
  );
}

/**
 * The PATCH body: ONLY the identity keys, and only those that changed. Never a
 * `members`/`roles`/`limits` map — those are wholesale replaces on the server,
 * and a stale copy sent from here would erase concurrent edits.
 */
export function projectEditBody(
  project: Pick<ProjectRecord, 'name' | 'description'>,
  edit: { name: string; description: string },
  appearance: AppearancePayload | null,
): { name?: string; description?: string; appearance?: AppearancePayload | null } {
  const body: { name?: string; description?: string; appearance?: AppearancePayload | null } = {};
  if (edit.name.trim() !== project.name) body.name = edit.name.trim();
  if (edit.description !== (project.description ?? '')) body.description = edit.description;
  body.appearance = appearance;
  return body;
}

/** The editor body — pure render over the draft, exported for the render test. */
export function ProjectEditForm({
  project,
  name,
  description,
  onName,
  onDescription,
  draft,
}: {
  project: Pick<ProjectRecord, 'id' | 'name'>;
  name: string;
  description: string;
  onName(value: string): void;
  onDescription(value: string): void;
  draft: AppearanceDraft;
}) {
  return (
    <>
      <div className="flex items-center gap-3 mb-3">
        <AppearanceAvatar
          appearance={draft.preview}
          seed={project.id}
          monogram={deriveInitial(name || project.name)}
          label={name || project.name}
          size={48}
          shape="tile"
          ringClassName="ring-2 ring-white/15"
        />
        <div className="min-w-0">
          <div className="text-sm text-white/85 font-medium truncate">{name || project.name}</div>
          <div className="text-[11px] text-white/45">Every member sees this in their project list</div>
        </div>
      </div>
      <label className="block mb-2">
        <span className="text-[10px] font-semibold text-white/40 uppercase tracking-wider">Name</span>
        <input
          value={name}
          maxLength={NAME_MAX}
          onChange={(e) => onName(e.target.value)}
          className="mt-1 w-full rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-white outline-none focus:border-white/30"
        />
      </label>
      <label className="block mb-3">
        <span className="text-[10px] font-semibold text-white/40 uppercase tracking-wider">Description</span>
        <textarea
          value={description}
          maxLength={DESCRIPTION_MAX}
          rows={2}
          onChange={(e) => onDescription(e.target.value)}
          className="mt-1 w-full resize-none rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-white outline-none focus:border-white/30"
        />
      </label>
      <IconPicker
        value={draft.value}
        onChange={draft.onChange}
        imageSlot={draft.imageSlot}
        suggested={SUGGESTED_PROJECT_ICONS}
        monogram={deriveInitial(name || project.name) ?? ''}
        shape="tile"
      />
      <AppearanceBackgroundToggle draft={draft} />
    </>
  );
}

/**
 * "Edit project" — name, description and the project's icon, colour and
 * picture, for an owner-strength member. Saving PATCHes `/api/projects/<id>`;
 * every member's switcher then re-reads the record over the live `project`
 * channel (`toProjectView` serves `appearance` to every member).
 */
export function ProjectEditPopup({
  project,
  isOpen,
  onClose,
  onSaved,
  anchor,
}: {
  project: ProjectRecord;
  isOpen: boolean;
  onClose(): void;
  onSaved(): void;
  anchor: { top: number; left: number };
}): React.ReactElement | null {
  const seed = useMemo(
    () => ({
      iconName: project.appearance?.iconName ?? null,
      color: project.appearance?.color ?? null,
      imageUrl: project.appearance?.image?.hash
        ? appearanceImageUrl('project', project.id, project.appearance.image.hash)
        : null,
      background: project.appearance?.background ?? null,
    }),
    [project.appearance, project.id],
  );
  const draft = useAppearanceDraft(seed, isOpen);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setName(project.name);
    setDescription(project.description ?? '');
    setError(null);
    // Re-seed on OPEN only, like the appearance draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const submit = useCallback(
    async (appearance: AppearancePayload | null) => {
      setSaving(true);
      setError(null);
      try {
        await updateProject(project.id, projectEditBody(project, { name, description }, appearance));
        onSaved();
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save the project.');
      } finally {
        setSaving(false);
      }
    },
    [project, name, description, onSaved, onClose],
  );

  if (!isOpen) return null;

  return (
    <AppearancePopupFrame
      anchor={anchor}
      title="Edit project"
      onClose={onClose}
      onSave={() => void draft.payload().then(submit, (err: unknown) => setError(err instanceof Error ? err.message : 'Failed to read the picture.'))}
      onReset={() => void submit(null)}
      saving={saving}
      error={error}
    >
      <ProjectEditForm
        project={project}
        name={name}
        description={description}
        onName={setName}
        onDescription={setDescription}
        draft={draft}
      />
    </AppearancePopupFrame>
  );
}
