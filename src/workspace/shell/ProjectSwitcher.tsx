'use client';

import { FolderOpen, ChevronDown, Check, BrushCleaning, Pencil } from 'lucide-react';
import { useContext, useCallback, useMemo, useRef, useState, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { useSession } from 'next-auth/react';
import { cn } from '@/lib/cn';
import { useWorkspaceStore } from '../store/workspaceStore';
import { usePresentation, useProjectGroups, useProjectsState, useProjectsWithStore, useWorkspaceSession } from '../store/selectors';
import { dockSurface, useDockTransparency } from './dockSurface';
import { ProjectUnreadCount, UnreadDot } from './DockBadge';
import { useOtherProjectsUnread } from '../notifications/notificationsClient';
import { ProjectAvatar, ProjectEditPopup, canEditProjectIdentity } from './ProjectEditPopup';
import { HOST_SLOTS, useHostSlot, type ProjectSettingsSlotProps } from '../packages/hostRegistryInstance';

import type { DockEdge } from './dockPlacement';
import { ThemeContext, themeScopeStyle } from '../theme/ThemeContext';
import { DEFAULT_THEME } from '../theme/themes';

type Props = {
  expanded?: boolean;
  align?: 'left' | 'right';
  disabled?: boolean;
  pinned?: boolean;
  edge?: DockEdge;
};

export function ProjectSwitcher({ expanded = false, align = 'right', disabled = false, pinned = true, edge = 'right' }: Props) {
  const dockTheme = useContext(ThemeContext)?.dockTheme ?? DEFAULT_THEME;
  const { projectId } = useWorkspaceSession();
  const elsewhereUnread = useOtherProjectsUnread(projectId);
  const { byId, ids } = useProjectsState();
  const selectProject = useWorkspaceStore((s) => s.selectProject);
  const cleanProjectStore = useWorkspaceStore((s) => s.cleanProjectStore);
  const refreshProjects = useWorkspaceStore((s) => s.refreshProjects);
  const setPresentation = useWorkspaceStore((s) => s.setPresentation);
  const selectGroup = useWorkspaceStore((s) => s.selectGroup);
  const { presentation, groupId, groupName, available: groupsAvailable } = usePresentation();
  const groups = useProjectGroups();
  // "Project settings" is a slot: the package that owns the settings surface
  // fills it and opens its own widget. Empty slot ⇒ no row.
  const ProjectSettings = useHostSlot(HOST_SLOTS.projectSettings) as ComponentType<ProjectSettingsSlotProps> | null;
  const { data: authSession } = useSession();
  const userId = (authSession?.user as Record<string, unknown> | undefined)?.id as string | undefined;

  const [isOpen, setIsOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editPos, setEditPos] = useState<{ top: number; left: number }>({ top: 64, left: 64 });
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  // Sorted '|'-joined project ids that hold at least one runtime store — a
  // primitive, so geometry writes never re-render the switcher (dock floor).
  const projectsWithStore = useProjectsWithStore();
  const storeSet = useMemo(
    () => new Set(projectsWithStore ? projectsWithStore.split('|') : []),
    [projectsWithStore],
  );

  const activeProject = projectId ? byId[projectId] : null;
  const canEditProject = canEditProjectIdentity(activeProject, userId);
  const dockLevel = useDockTransparency();
  const dockSurf = dockSurface(dockLevel, 'default');

  const close = useCallback(() => { setIsOpen(false); }, []);
  // In a Group the same trigger names `project · Group` (the full text in the
  // accessible name); the Group's line never widens its box.
  const triggerName = `${activeProject?.name ?? 'Projects'}${groupName ? ` · ${groupName}` : ''}`;

  const toggle = useCallback(() => {
    if (disabled) return;
    setIsOpen((prev) => {
      if (!prev && btnRef.current) {
        const rect = btnRef.current.getBoundingClientRect();
        if (edge === 'left') setPos({ top: rect.top, left: rect.right + 6 });
        else if (edge === 'right') setPos({ top: rect.top, left: rect.left - 6 });
        else if (edge === 'bottom') setPos({ top: rect.top - 6, left: rect.left });
        else setPos({ top: rect.bottom + 6, left: rect.left });
      }
      return !prev;
    });
  }, [disabled, edge]);

  const popup = isOpen ? createPortal(
    <>
      <div className="fixed inset-0" style={{ zIndex: 9998 }} onClick={close} />
      <div
        data-theme-id={dockTheme.id}
        className="fixed backdrop-blur-xl rounded-xl overflow-hidden min-w-[11rem]"
        style={{
          ...themeScopeStyle(dockTheme), backgroundColor: 'rgba(var(--w-bg-rgb), 0.96)',
          zIndex: 9999,
          ...(edge === 'bottom'
            ? { bottom: window.innerHeight - pos.top, left: pos.left }
            : edge === 'right'
              ? { top: pos.top, right: window.innerWidth - pos.left }
              : { top: pos.top, left: pos.left }),
        }}
      >
        <div className="px-3 pt-2.5 pb-1 text-[10px] font-semibold text-white/40 uppercase tracking-wider">
          Projects
        </div>

        <div className="max-h-52 overflow-y-auto">
          {ids.map((id) => {
            const project = byId[id];
            const active = id === projectId;
            const hasStore = storeSet.has(id);
            // The row is a <button>, so the broom must be a SIBLING inside a
            // wrapper (interactive-in-interactive is invalid HTML) — the same
            // pattern as the dock item's broom.
            return (
              <div key={id} className="relative">
                <button
                  type="button"
                  onClick={() => { selectProject(id); setIsOpen(false); }}
                  // Two projects may share a display name; the id never repeats.
                  title={`${project?.name ?? 'Unnamed'} (${id})`}
                  className={cn(
                    'w-full text-left px-4 py-1.5 text-sm transition-colors flex items-center gap-2',
                    active ? 'bg-white/10 text-white' : 'text-white/70 hover:bg-white/5 hover:text-white',
                    hasStore && 'pr-9',
                  )}
                >
                  <Check className={cn('w-3 h-3 shrink-0', active ? 'opacity-100' : 'opacity-0')} />
                  {project ? <ProjectAvatar project={project} size={18} /> : null}
                  <span className="truncate min-w-0 flex-1">{project?.name ?? 'Unnamed'}</span>
                  <span className="truncate max-w-[45%] font-mono text-[10px] text-white/35">{id}</span>
                  <ProjectUnreadCount projectId={id} />
                </button>
                {hasStore ? (
                  // ALWAYS-VISIBLE free broom on EVERY project row that holds a
                  // store — active or not ("we precisely want to clean the one
                  // we are NOT in"). The composite runtime keys record the
                  // project, so a non-active clean needs no server call. The
                  // popup stays open: on a non-active row the broom vanishing
                  // IS the feedback (the store is gone); the active row reseeds
                  // its default runtime, so its broom legitimately remains.
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      cleanProjectStore({ projectId: id });
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 z-10 w-4 h-4 flex items-center justify-center text-white/50 hover:text-white transition-colors"
                    title={`Clean ${project?.name ?? 'project'} workspace`}
                    aria-label={`Clean ${project?.name ?? 'project'} workspace`}
                  >
                    <BrushCleaning className="w-3 h-3" />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>

        {projectId && groupsAvailable ? (
          <div className="border-t border-white/10 px-2 pt-2 pb-1">
            <div className="px-1 pb-1 text-[10px] font-semibold text-white/40 uppercase tracking-wider">View</div>
            <div role="radiogroup" aria-label="Workspace view" className="grid grid-cols-2 gap-1">
              {([['agent', 'Per agent'], ['group', 'Group']] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={presentation === value}
                  onClick={() => setPresentation(value)}
                  className={cn(
                    'rounded-lg px-2 py-1 text-xs font-medium transition',
                    presentation === value ? 'bg-white/15 text-white' : 'text-white/60 hover:bg-white/5 hover:text-white',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {presentation === 'group' && groups.length > 0 ? (
              <div className="mt-1 max-h-40 overflow-y-auto" role="radiogroup" aria-label="Groups">
                {groups.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    role="radio"
                    aria-checked={g.id === groupId}
                    onClick={() => selectGroup(g.id)}
                    title={g.name}
                    className={cn(
                      'w-full text-left px-3 py-1 text-sm transition-colors flex items-center gap-2 rounded-lg',
                      g.id === groupId ? 'bg-white/10 text-white' : 'text-white/70 hover:bg-white/5 hover:text-white',
                    )}
                  >
                    <Check className={cn('w-3 h-3 shrink-0', g.id === groupId ? 'opacity-100' : 'opacity-0')} />
                    <span className="truncate min-w-0 flex-1">{g.name}</span>
                    <span className="text-[10px] text-white/35">{g.memberIds.length}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {presentation === 'group' ? (
              // The Groups are edited in the agent dock's edit draft (names, members, new, delete).
              <button
                type="button"
                onClick={() => { useWorkspaceStore.getState().setDockEditing('secondary', true); setIsOpen(false); }}
                className="mt-1 w-full text-left px-3 py-1 text-xs flex items-center gap-2 text-white/55 hover:text-white hover:bg-white/5 rounded-lg transition"
              >
                <Pencil className="w-3 h-3 shrink-0" />
                Edit groups…
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="border-t border-white/10 p-2 space-y-1">
          {projectId && ProjectSettings ? <ProjectSettings onActivated={close} /> : null}
          {activeProject && canEditProject ? (
            <button
              type="button"
              onClick={() => {
                setEditPos(editAnchor(btnRef.current, edge));
                setIsOpen(false);
                setEditOpen(true);
              }}
              className="w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 text-white/50 hover:text-white/70 hover:bg-white/5 rounded-lg transition"
            >
              <Pencil className="w-3.5 h-3.5 shrink-0" />
              <span className="text-xs font-medium">Edit project</span>
            </button>
          ) : null}
        </div>
      </div>
    </>,
    document.body,
  ) : null;

  return (
    <div className="relative w-full">
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        disabled={disabled}
        className={cn(
          'rounded-xl transition flex items-center shrink-0 overflow-hidden w-full',
          dockSurf.bg,
          expanded ? 'h-11 px-0' : 'w-12 h-11 justify-center',
          align === 'right' ? 'flex-row-reverse' : 'flex-row',
          'disabled:opacity-40 disabled:cursor-not-allowed',
        )}
        title={elsewhereUnread ? `${triggerName} — unread in another project` : triggerName}
        aria-label={triggerName}
      >
        <div className="relative w-12 h-full flex items-center justify-center shrink-0">
          {elsewhereUnread ? <UnreadDot className="absolute top-2 right-2.5" /> : null}
          {activeProject?.appearance ? (
            <ProjectAvatar project={activeProject} size={30} />
          ) : (
            <FolderOpen className="w-7 h-7" style={{ color: 'var(--dock-icon-project, #34d399)' }} />
          )}
        </div>
        {expanded ? (
          <div
            className={cn(
              'flex-1 flex items-center min-w-0 text-white/70',
              align === 'right' ? 'pl-3 justify-center' : 'pr-3 justify-center',
            )}
          >
            {groupName ? (
              // The Group rides a second line whose width is borrowed (`w-0 min-w-full`):
              // it contributes nothing to the box, so the trigger keeps its per-agent size.
              <span className="min-w-0 flex flex-col items-center leading-tight text-center text-xs font-medium mr-1">
                <span className="max-w-full truncate">{activeProject?.name ?? 'No project'}</span>
                <span className="block w-0 min-w-full truncate text-white/45">{groupName}</span>
              </span>
            ) : (
              <span className="min-w-0 line-clamp-2 leading-tight break-words text-center text-xs font-medium mr-1">
                {activeProject?.name ?? 'No project'}
              </span>
            )}
            <ChevronDown className="w-3 h-3 opacity-50 shrink-0" />
          </div>
        ) : null}
      </button>
      {popup}
      {activeProject && canEditProject ? (
        <ProjectEditPopup
          project={activeProject}
          isOpen={editOpen}
          onClose={() => setEditOpen(false)}
          onSaved={() => void refreshProjects()}
          anchor={editPos}
        />
      ) : null}
    </div>
  );
}

/** Where the editor opens: beside the switcher, toward the stage. */
function editAnchor(button: HTMLButtonElement | null, edge: DockEdge): { top: number; left: number } {
  if (!button) return { top: 64, left: 64 };
  const rect = button.getBoundingClientRect();
  if (edge === 'right') return { top: rect.top, left: rect.left - 392 };
  if (edge === 'bottom') return { top: rect.top - 560, left: rect.left };
  if (edge === 'top') return { top: rect.bottom + 6, left: rect.left };
  return { top: rect.top, left: rect.right + 6 };
}
