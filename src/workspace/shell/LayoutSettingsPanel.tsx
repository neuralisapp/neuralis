'use client';

import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { RotateCcw, ImagePlus, Trash2, Sparkles, GripVertical, Shuffle, Undo2, Pencil, Link2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { DockLayoutConfig, DockId } from './dockPlacement';
import { DEFAULT_DOCK_LAYOUT, readDockLayoutConfig, saveDockLayoutConfig } from './dockPlacement';
import { DockPositionPicker } from './Dock';
import type { StageMode, TransparencyLevel } from '../store/types';
import { useWorkspaceStore, activeRuntimeKeyOf, effectiveStageMode, SAVED_STAGE_MODES } from '../store/workspaceStore';
import { TRANSPARENCY_LEVELS } from './widgetSurface';
import { usePresentation, useProjectGroups } from '../store/selectors';
import { hasLayoutUndo, randomizeLayout, undoLayout, type LayoutTransactionDeps } from './layoutTransaction';
import { useTheme } from '../theme/useTheme';
import type { Theme } from '../theme/types';

// ─── Primitives ────────────────────────────────────────────────────────────

/** The ONE segmented control of the Layout view (stage, chat side, materials, dock background). */
function Segmented<T extends string>({ label, value, options, onChange, disabled = false }: {
  label: string;
  value: T | null;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label={label} className={cn('inline-flex flex-wrap rounded-lg bg-white/5 p-0.5 gap-0.5', disabled && 'opacity-40')}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            'h-7 px-2.5 rounded-md text-xs transition-colors disabled:cursor-not-allowed',
            value === option.value ? 'bg-white/15 text-white font-medium' : 'text-white/55 hover:text-white hover:bg-white/8',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <h4 className="mr-auto text-[11px] font-semibold uppercase tracking-wider text-white/40">{title}</h4>
        {action}
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="w-24 shrink-0 text-xs text-white/60">{label}</span>
      {children}
    </div>
  );
}

const MATERIAL_LABEL: Record<TransparencyLevel, string> = { opaque: 'Opaque', dim: 'Dim', transparent: 'Clear' };
const MATERIALS = TRANSPARENCY_LEVELS.map((value) => ({ value, label: MATERIAL_LABEL[value] }));

// ─── Stage mode (tiled / canvas / grid / phone) ────────────────────────────

const STAGE_LABEL: Record<StageMode, string> = { tiled: 'Tiled', canvas: 'Canvas', grid: 'Grid', phone: 'Phone' };
const STAGE_MODES = [...SAVED_STAGE_MODES, 'phone' as const].map((value) => ({ value, label: STAGE_LABEL[value] }));

function StageModeRows({ autoPhone, onAutoPhone }: { autoPhone: boolean; onAutoPhone: (value: boolean) => void }) {
  const agentId = useWorkspaceStore((s) => s.session.agentId);
  const runtimeKey = useWorkspaceStore(activeRuntimeKeyOf);
  const stageMode = useWorkspaceStore((s) => (runtimeKey ? effectiveStageMode(s, runtimeKey) : 'tiled'));
  const manual = useWorkspaceStore((s) => Boolean(runtimeKey && s.manualModeByRuntimeKey[runtimeKey]));
  const setStageMode = useWorkspaceStore((s) => s.setStageMode);
  return (
    <>
      <Row label="Mode">
        <Segmented label="Stage mode" value={stageMode} options={STAGE_MODES} disabled={!agentId} onChange={(mode) => { if (agentId) setStageMode({ agentId, mode }); }} />
        {manual && autoPhone ? (
          <button type="button" className="h-7 px-2 rounded-md text-xs text-white/55 hover:text-white hover:bg-white/8" title="Follow the device again: Phone on a small screen, the saved mode elsewhere" onClick={() => useWorkspaceStore.getState().clearManualStageMode()}>
            Auto
          </button>
        ) : null}
      </Row>
      <Row label="Phone">
        <label className="flex items-center gap-2 text-xs text-white/70">
          <input type="checkbox" checked={autoPhone} onChange={(event) => { onAutoPhone(event.target.checked); if (event.target.checked) useWorkspaceStore.getState().clearManualStageMode(); }} />
          Switch to Phone automatically on a small screen
        </label>
      </Row>
    </>
  );
}

// ─── View (per agent / Group) ──────────────────────────────────────────────

/**
 * The same view choice as the project menu, through the same store actions.
 * In a Group the Group row is always there — even with one Group — with its
 * "Edit" entry: the agent dock's edit draft, which holds the Groups' names and
 * members (Save/Cancel at the dock's end).
 */
function ViewRows() {
  const { presentation, groupId, available } = usePresentation();
  const groups = useProjectGroups();
  const editingGroups = useWorkspaceStore((s) => s.dockEditing.secondary);
  if (!available) return null;
  const store = useWorkspaceStore.getState;
  return (
    <>
      <Row label="View">
        <Segmented label="Workspace view" value={presentation} options={[{ value: 'agent', label: 'Per agent' }, { value: 'group', label: 'Group' }]} onChange={(value) => store().setPresentation(value)} />
      </Row>
      {presentation === 'group' ? (
        <Row label="Group">
          <Segmented label="Group" value={groupId} options={groups.map((g) => ({ value: g.id, label: g.name }))} onChange={(id) => store().selectGroup(id)} />
          <EditGroupsButton editing={editingGroups} />
        </Row>
      ) : null}
    </>
  );
}

/** "Edit" for the Groups: opens the agent dock's edit draft (names, members, new, delete). */
export function EditGroupsButton({ editing, className }: { editing: boolean; className?: string }) {
  return (
    <button
      type="button"
      aria-pressed={editing}
      disabled={editing}
      onClick={() => useWorkspaceStore.getState().setDockEditing('secondary', true)}
      title={editing ? 'Editing the Groups at the agent dock — Save or Cancel there' : 'Rename Groups and choose their agents (at the agent dock)'}
      className={cn('h-7 px-2.5 rounded-md text-xs flex items-center gap-1.5 transition', editing ? 'bg-white/15 text-white' : 'bg-white/5 text-white/60 hover:bg-white/15 hover:text-white/80', className)}
    >
      <Pencil className="w-3 h-3" />
      {editing ? 'Editing…' : 'Edit'}
    </button>
  );
}

// ─── Edit docks ────────────────────────────────────────────────────────────

/** An armed "Discard both drafts?" disarms itself after this long. */
export const DISCARD_CONFIRM_MS = 4000;

/**
 * Puts the docks into edit mode (drag, hide, Save/Cancel at each dock's end).
 * It reads "Edit docks" while ANY dock is not editing, and a click puts the
 * non-editing dock(s) into edit mode — a dock already editing keeps its draft.
 * With both editing it reads "Editing docks…" (pressed); a click then asks
 * inline before discarding both drafts — never a silent discard. The confirm
 * disarms itself after {@link DISCARD_CONFIRM_MS} or when a dock leaves edit.
 */
export function EditDocksToggle() {
  const bothEditing = useWorkspaceStore((s) => s.dockEditing.primary && s.dockEditing.secondary);
  const setDockEditing = useWorkspaceStore((s) => s.setDockEditing);
  const projectId = useWorkspaceStore((s) => s.session.projectId);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), DISCARD_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirming]);

  useEffect(() => { if (!bothEditing) setConfirming(false); }, [bothEditing]);

  if (confirming) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-white/70">Discard both drafts?</span>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="h-7 px-2.5 rounded-md text-xs bg-white/5 text-white/60 hover:bg-white/15 hover:text-white/80 transition"
        >
          Keep editing
        </button>
        <button
          type="button"
          onClick={() => { setConfirming(false); setDockEditing('both', false); }}
          className="h-7 px-2.5 rounded-md text-xs bg-red-500/20 text-red-100 hover:bg-red-500/30 transition"
        >
          Discard
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => (bothEditing ? setConfirming(true) : setDockEditing('both', true))}
      disabled={!projectId}
      aria-pressed={bothEditing}
      className={cn(
        'h-7 px-2.5 rounded-md text-xs transition flex items-center gap-1.5',
        bothEditing ? 'bg-[#cba6f7] text-neutral-950 font-semibold' : 'bg-white/5 text-white/60 hover:bg-white/15 hover:text-white/80',
        !projectId && 'opacity-40 cursor-not-allowed',
      )}
      title={bothEditing ? 'Leave dock editing without saving' : 'Reorder and hide dock items in this project'}
    >
      <GripVertical className="w-3 h-3" />
      {bothEditing ? 'Editing docks…' : 'Edit docks'}
    </button>
  );
}

// ─── Theme ─────────────────────────────────────────────────────────────────

/** One theme as a colour sample: its surface, a line of its text and a control strip. */
function ThemeSwatch({ theme, pressed, onClick, surface }: { theme: Theme; pressed: boolean; onClick: () => void; surface: string }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={`${surface}: ${theme.name}`}
      title={theme.name}
      onClick={onClick}
      className={cn('flex flex-col items-center gap-1 rounded-lg p-1 transition-colors', pressed ? 'bg-white/12' : 'hover:bg-white/6')}
    >
      <span
        aria-hidden="true"
        className={cn('block w-12 h-8 rounded-md border p-1', pressed ? 'border-[#cba6f7]' : 'border-white/15')}
        style={{ backgroundColor: `rgb(${theme.colors.widgetBg})` }}
      >
        <span className="block h-1.5 w-7 rounded-full" style={{ backgroundColor: theme.colors.widgetText }} />
        <span className="mt-1 block h-2.5 w-full rounded-sm" style={{ backgroundColor: `rgb(${theme.colors.composerBg})` }} />
      </span>
      <span className={cn('text-[11px]', pressed ? 'text-white' : 'text-white/55')}>{theme.name}</span>
    </button>
  );
}

const SURFACES = ['Widgets', 'Docks', 'Background'] as const;
type Surface = (typeof SURFACES)[number];
/** Each surface's material field in the dock layout record. */
const MATERIAL_FIELD = {
  Widgets: 'defaultWidgetTransparency',
  Docks: 'defaultDockTransparency',
  Background: 'backgroundTransparency',
} as const satisfies Record<Surface, keyof DockLayoutConfig>;

/**
 * ONE row per surface (Widgets, Docks, Background): its four theme samples and
 * its Opaque / Dim / Clear material, side by side — each choice exists once.
 * The stored keys are unchanged (three theme ids, three material fields).
 */
function SurfaceRows({ config, update }: { config: DockLayoutConfig; update: (next: DockLayoutConfig) => void }) {
  const { theme, dockTheme, backgroundTheme, setThemeId, setDockThemeId, setBackgroundThemeId, availableThemes } = useTheme();
  const current: Record<Surface, string> = { Widgets: theme.id, Docks: dockTheme.id, Background: backgroundTheme.id };
  const setters: Record<Surface, (id: string) => void> = { Widgets: setThemeId, Docks: setDockThemeId, Background: setBackgroundThemeId };
  return (
    <div className="flex flex-col gap-2">
      {SURFACES.map((surface) => (
        <Row key={surface} label={surface}>
          <div role="group" aria-label={`${surface} theme`} className="flex flex-wrap gap-0.5">
            {availableThemes.map((t) => <ThemeSwatch key={t.id} theme={t} surface={surface} pressed={current[surface] === t.id} onClick={() => setters[surface](t.id)} />)}
          </div>
          <Segmented
            label={`${surface} material`}
            value={config[MATERIAL_FIELD[surface]]}
            options={MATERIALS}
            onChange={(level) => update({ ...config, [MATERIAL_FIELD[surface]]: level })}
          />
        </Row>
      ))}
    </div>
  );
}

/** One click: the docks and the background take the Widgets theme. */
function SameThemeEverywhere() {
  const { theme, dockTheme, backgroundTheme, setDockThemeId, setBackgroundThemeId } = useTheme();
  const same = dockTheme.id === theme.id && backgroundTheme.id === theme.id;
  return (
    <button
      type="button"
      disabled={same}
      onClick={() => { setDockThemeId(theme.id); setBackgroundThemeId(theme.id); }}
      title={same ? 'Every surface already wears one theme' : `Give the docks and the background the Widgets theme (${theme.name})`}
      className="h-6 px-2 rounded-md text-[11px] flex items-center gap-1 text-white/55 hover:text-white hover:bg-white/10 transition disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-default"
    >
      <Link2 className="w-3 h-3" /> Same theme everywhere
    </button>
  );
}

function BackgroundRow() {
  const { backgroundTheme, backgroundImage, setBackgroundImage, clearBackgroundImage, toggleUniverse } = useTheme();
  const universeOn = backgroundTheme.useUniverseBackground !== false;
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handlePickBackground = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploadError(null);
    setIsUploading(true);
    try { await setBackgroundImage(file); }
    catch (error) { setUploadError(error instanceof Error ? error.message : 'Failed'); }
    finally { setIsUploading(false); if (fileInputRef.current) fileInputRef.current.value = ''; }
  };

  const chip = 'h-7 px-2.5 rounded-md text-xs flex items-center gap-1.5 transition-colors';
  return (
    <Row label="">
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handlePickBackground} />
      <div className="flex flex-wrap items-center gap-1">
        <button type="button" onClick={toggleUniverse} aria-pressed={universeOn} className={cn(chip, universeOn ? 'bg-white/15 text-white' : 'bg-white/5 text-white/55 hover:bg-white/10')}>
          <Sparkles className="w-3 h-3" />
          Universe
        </button>
        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={isUploading} className={cn(chip, 'bg-white/5 text-white/70 hover:bg-white/10 disabled:opacity-50')}>
          <ImagePlus className="w-3 h-3" />
          {backgroundImage ? 'Replace image' : 'Image'}
        </button>
        {backgroundImage ? (
          <button type="button" aria-label="Remove background image" onClick={() => { clearBackgroundImage(); setUploadError(null); }} className={cn(chip, 'bg-white/5 text-white/55 hover:bg-white/10')}>
            <Trash2 className="w-3 h-3" />
          </button>
        ) : null}
      </div>
      {uploadError ? <span className="text-[11px] text-red-300/90">{uploadError}</span> : null}
    </Row>
  );
}

/** A Docks-section cell: its label above its control. */
function DockMapCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <span className="text-xs text-white/60">{label}</span>
      {children}
    </div>
  );
}

// ─── Main Panel ────────────────────────────────────────────────────────────

export function LayoutSettingsPanel() {
  const [config, setConfig] = useState<DockLayoutConfig>(DEFAULT_DOCK_LAYOUT);

  useEffect(() => {
    setConfig(readDockLayoutConfig());
    const changed = (event: Event) => setConfig((event as CustomEvent<DockLayoutConfig>).detail);
    window.addEventListener('neuralis:layout-changed', changed);
    return () => window.removeEventListener('neuralis:layout-changed', changed);
  }, []);

  const update = (next: DockLayoutConfig) => {
    setConfig(next);
    saveDockLayoutConfig(next);
    window.dispatchEvent(new CustomEvent('neuralis:layout-changed', { detail: next }));
  };

  // Randomize / Undo: one coordinated commit and its one Undo (layoutTransaction.ts).
  const { appearance, applyAppearance } = useTheme();
  const [notice, setNotice] = useState<string | null>(null);
  const [canUndo, setCanUndo] = useState(() => hasLayoutUndo(useWorkspaceStore.getState()));
  const runTransaction = (run: (deps: LayoutTransactionDeps) => ReturnType<typeof randomizeLayout>) => {
    const result = run({
      storage: window.localStorage,
      random: Math.random,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      appearance,
      applyAppearance,
    });
    setNotice(result.ok ? null : result.message);
    setCanUndo(hasLayoutUndo(useWorkspaceStore.getState()));
  };

  const placeDock = (dockId: DockId) => (next: Pick<DockLayoutConfig['primary'], 'anchor' | 'orientation'>) => {
    update({ ...config, [dockId]: { dockId, ...next } });
  };

  return (
    <div className="h-full w-full overflow-y-auto px-4 py-3 flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1">
          <h3 className="mr-auto text-sm font-semibold text-white/85">Layout</h3>
          <button type="button" onClick={() => runTransaction(randomizeLayout)}
            className="h-7 flex items-center gap-1.5 px-2 rounded-md text-xs text-white/55 hover:text-white hover:bg-white/10 transition"
            title="A random valid layout: view, docks, modes, themes, materials, chat side, background and the open windows' arrangement — one Undo restores all of it">
            <Shuffle className="w-3 h-3" /> Randomize
          </button>
          {canUndo ? (
            <button type="button" onClick={() => runTransaction(undoLayout)}
              className="h-7 flex items-center gap-1.5 px-2 rounded-md text-xs text-white/75 hover:text-white hover:bg-white/10 transition"
              title="Restore everything Randomize changed">
              <Undo2 className="w-3 h-3" /> Undo
            </button>
          ) : null}
          <button type="button" onClick={() => update(DEFAULT_DOCK_LAYOUT)}
            className="h-7 flex items-center gap-1.5 px-2 rounded-md text-xs text-white/55 hover:text-white hover:bg-white/10 transition"
            title="Reset the docks, chat side and materials to the defaults">
            <RotateCcw className="w-3 h-3" /> Reset
          </button>
        </div>
        {notice ? <p role="status" className="text-[11px] leading-snug text-amber-200/90">{notice}</p> : null}
      </div>

      <Section title="Workspace">
        <ViewRows />
        <StageModeRows autoPhone={config.autoPhone} onAutoPhone={(autoPhone) => update({ ...config, autoPhone })} />
        <Row label="Chat">
          <Segmented label="Chat side" value={config.chatPosition} options={[{ value: 'start', label: 'Left' }, { value: 'end', label: 'Right' }]} onChange={(chatPosition) => update({ ...config, chatPosition })} />
        </Row>
      </Section>

      <Section title="Appearance" action={<SameThemeEverywhere />}>
        <SurfaceRows config={config} update={update} />
        <BackgroundRow />
      </Section>

      {/* Two columns: the two placement maps, then the shared dock settings beside them (one column when narrow). */}
      <Section title="Docks">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
          <div className="flex flex-col gap-3">
            <DockMapCell label="Apps dock">
              <DockPositionPicker label="Apps dock position" value={config.primary} onChange={placeDock('primary')} />
            </DockMapCell>
            <DockMapCell label="Agents dock">
              <DockPositionPicker label="Agents dock position" value={config.secondary} onChange={placeDock('secondary')} />
            </DockMapCell>
          </div>
          <div className="flex flex-col gap-3">
            <DockMapCell label="Background">
              <Segmented label="Dock background" value={config.dockBackground} options={[{ value: 'classic', label: 'Icon tiles' }, { value: 'toolbar', label: 'Toolbar' }]} onChange={(dockBackground) => update({ ...config, dockBackground })} />
            </DockMapCell>
            <DockMapCell label="Items">
              <EditDocksToggle />
            </DockMapCell>
          </div>
        </div>
      </Section>
    </div>
  );
}
