'use client';

import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { RotateCcw, Palette, ImagePlus, Trash2, Sparkles, GripVertical } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { DockEdge, DockAlign, DockLayoutConfig, DockId, ChatPosition } from './dockPlacement';
import { DEFAULT_DOCK_LAYOUT, readDockLayoutConfig, saveDockLayoutConfig } from './dockPlacement';
import type { StageMode, TransparencyLevel } from '../store/types';
import { useWorkspaceStore, agentRuntimeKey } from '../store/workspaceStore';
import { useTheme } from '../theme/useTheme';

// ─── 9-position grid selector (edge + align combined) ─────────────────────

type GridPos = { edge: DockEdge; align: DockAlign; row: number; col: number; label: string };

// A side dock fills its edge, so `start` and `center` render alike there; the
// side cells carry `start` — the shipped default (`DEFAULT_DOCK_LAYOUT`) — and
// count a stored `center` as the same cell.
const GRID_POSITIONS: GridPos[] = [
  { edge: 'top', align: 'start', row: 0, col: 0, label: '↖' },
  { edge: 'top', align: 'center', row: 0, col: 1, label: '↑' },
  { edge: 'top', align: 'end', row: 0, col: 2, label: '↗' },
  { edge: 'left', align: 'start', row: 1, col: 0, label: '←' },
  // center cell (1,1) is empty / preview
  { edge: 'right', align: 'start', row: 1, col: 2, label: '→' },
  { edge: 'bottom', align: 'start', row: 2, col: 0, label: '↙' },
  { edge: 'bottom', align: 'center', row: 2, col: 1, label: '↓' },
  { edge: 'bottom', align: 'end', row: 2, col: 2, label: '↘' },
];

export function PositionGrid({ value, onChange, label, color }: {
  value: { edge: DockEdge; align: DockAlign };
  onChange: (edge: DockEdge, align: DockAlign) => void;
  label: string;
  color: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <span className="text-xs font-medium text-white/60">{label}</span>
      <div className="grid grid-cols-3 grid-rows-3 gap-1 w-[5.5rem] h-[5.5rem]">
        {Array.from({ length: 9 }, (_, i) => {
          const row = Math.floor(i / 3);
          const col = i % 3;
          // Center cell = mini preview
          if (row === 1 && col === 1) {
            return (
              <div key="center" className="rounded-md border border-white/10 bg-white/5 flex items-center justify-center">
                <div className="w-1.5 h-1.5 rounded-sm" style={{ backgroundColor: color, opacity: 0.6 }} />
              </div>
            );
          }
          const pos = GRID_POSITIONS.find((p) => p.row === row && p.col === col);
          if (!pos) return <div key={i} />;
          const sideEdge = pos.edge === 'left' || pos.edge === 'right';
          const active = value.edge === pos.edge
            && (value.align === pos.align || (sideEdge && value.align === 'center'));
          return (
            <button
              key={`${pos.edge}-${pos.align}`}
              type="button"
              onClick={() => onChange(pos.edge, pos.align)}
              className={cn(
                'rounded-md transition-all text-[11px] flex items-center justify-center',
                active ? 'text-white shadow-lg scale-105' : 'bg-white/8 text-white/35 hover:bg-white/15 hover:text-white/55',
              )}
              style={active ? { backgroundColor: color } : undefined}
              title={`${pos.edge} / ${pos.align}`}
            >
              {pos.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Chat position toggle ──────────────────────────────────────────────────

function ChatPositionToggle({ value, onChange }: { value: ChatPosition; onChange: (v: ChatPosition) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-white/50">Chat:</span>
      <div className="flex gap-1">
        {(['start', 'end'] as const).map((pos) => (
          <button
            key={pos}
            type="button"
            onClick={() => onChange(pos)}
            className={cn(
              'px-2.5 py-1 rounded-md text-xs transition',
              value === pos ? 'bg-white/20 text-white' : 'bg-white/5 text-white/40 hover:bg-white/15',
            )}
          >
            {pos === 'start' ? '← Left' : 'Right →'}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Default widget transparency ───────────────────────────────────────────

const TRANSPARENCY_OPTIONS: { value: TransparencyLevel; label: string }[] = [
  { value: 'opaque', label: 'Opaque' },
  { value: 'dim', label: 'Dim' },
  { value: 'transparent', label: 'Clear' },
];

function TransparencyDefaultToggle({ value, onChange, label }: { value: TransparencyLevel; onChange: (v: TransparencyLevel) => void; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-white/50">{label}</span>
      <div className="flex gap-1">
        {TRANSPARENCY_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={cn(
              'px-2.5 py-1 rounded-md text-xs transition flex items-center gap-1.5',
              value === opt.value ? 'bg-white/20 text-white' : 'bg-white/5 text-white/40 hover:bg-white/15',
            )}
            title={`Default transparency: ${opt.label}`}
          >
            <span
              aria-hidden
              className={cn(
                'w-2.5 h-2.5 rounded-[3px] border border-white/40',
                opt.value === 'opaque' && 'bg-white/85',
                opt.value === 'dim' && 'bg-white/35',
                opt.value === 'transparent' && 'bg-transparent',
              )}
            />
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Stage mode (tiled / canvas / grid) ────────────────────────────────────

const STAGE_MODE_OPTIONS: { value: StageMode; label: string }[] = [
  { value: 'tiled', label: 'Tiled' },
  { value: 'canvas', label: 'Canvas' },
  { value: 'grid', label: 'Grid' },
];

function StageModeToggle() {
  const agentId = useWorkspaceStore((s) => s.session.agentId);
  const stageMode = useWorkspaceStore((s) =>
    (agentId && s.session.projectId
      ? (s.runtimeByAgentId[agentRuntimeKey(s.session.projectId, agentId)]?.layout.stageMode ?? 'tiled')
      : 'tiled'),
  );
  const setStageMode = useWorkspaceStore((s) => s.setStageMode);

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-white/50">Mode:</span>
      <div className="flex gap-1">
        {STAGE_MODE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => { if (agentId) setStageMode({ agentId, mode: opt.value }); }}
            disabled={!agentId}
            className={cn(
              'px-2.5 py-1 rounded-md text-xs transition',
              stageMode === opt.value ? 'bg-white/20 text-white' : 'bg-white/5 text-white/40 hover:bg-white/15',
              !agentId && 'opacity-40 cursor-not-allowed',
            )}
            title={`Layout mode: ${opt.label}`}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </div>
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
      <div className="flex items-center gap-2">
        <span className="text-xs text-white/50">Docks:</span>
        <span className="text-xs text-white/70">Discard both drafts?</span>
        <button
          type="button"
          onClick={() => setConfirming(false)}
          className="px-2 py-1 rounded-md text-xs bg-white/5 text-white/60 hover:bg-white/15 hover:text-white/80 transition"
        >
          Keep editing
        </button>
        <button
          type="button"
          onClick={() => { setConfirming(false); setDockEditing('both', false); }}
          className="px-2 py-1 rounded-md text-xs bg-red-500/20 text-red-100 hover:bg-red-500/30 transition"
        >
          Discard
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-white/50">Docks:</span>
      <button
        type="button"
        onClick={() => (bothEditing ? setConfirming(true) : setDockEditing('both', true))}
        disabled={!projectId}
        aria-pressed={bothEditing}
        className={cn(
          'px-2.5 py-1 rounded-md text-xs transition flex items-center gap-1.5',
          bothEditing ? 'bg-[#cba6f7] text-neutral-950 font-semibold' : 'bg-white/5 text-white/60 hover:bg-white/15 hover:text-white/80',
          !projectId && 'opacity-40 cursor-not-allowed',
        )}
        title={bothEditing ? 'Leave dock editing without saving' : 'Reorder and hide dock items in this project'}
      >
        <GripVertical className="w-3 h-3" />
        {bothEditing ? 'Editing docks…' : 'Edit docks'}
      </button>
    </div>
  );
}

// ─── Theme controls (moved from ThemeSwitcher) ─────────────────────────────

function ThemeSection() {
  const { theme, setThemeId, availableThemes, backgroundImage, setBackgroundImage, clearBackgroundImage, toggleUniverse } = useTheme();
  const universeOn = theme.useUniverseBackground !== false;
  const [moreOpen, setMoreOpen] = useState(false);
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

  return (
    <div className="flex flex-col gap-2">
      <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handlePickBackground} />
      <div className="flex items-center gap-2">
        <Palette className="w-3.5 h-3.5 text-white/40" />
        <span className="text-xs font-medium text-white/60">Theme</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {availableThemes.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setThemeId(t.id)}
            className={cn(
              'px-2 py-1 rounded-md text-[11px] transition flex items-center gap-1.5',
              theme.id === t.id ? 'bg-white/15 text-white' : 'bg-white/5 text-white/50 hover:bg-white/10',
            )}
          >
            <div className="w-2 h-2 rounded-full shrink-0" style={{ background: t.colors.primary }} />
            {t.name}
          </button>
        ))}
      </div>

      <div className="flex gap-1.5">
        <button type="button" onClick={toggleUniverse}
          className={cn('flex-1 px-2 py-1.5 rounded-md text-[11px] flex items-center gap-1.5 transition border',
            universeOn ? 'border-white/15 bg-white/8 text-white/70' : 'border-white/8 bg-white/3 text-white/40',
          )}>
          <Sparkles className="w-3 h-3" />
          Universe {universeOn ? 'On' : 'Off'}
        </button>
        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={isUploading}
          className="flex-1 px-2 py-1.5 rounded-md text-[11px] border border-white/8 bg-white/3 text-white/40 hover:bg-white/8 flex items-center gap-1.5 transition disabled:opacity-50">
          <ImagePlus className="w-3 h-3" />
          {backgroundImage ? 'Replace' : 'Image'}
        </button>
        {backgroundImage ? (
          <button type="button" onClick={() => { clearBackgroundImage(); setUploadError(null); }}
            className="px-2 py-1.5 rounded-md text-[11px] border border-white/8 bg-white/3 text-white/40 hover:bg-white/8 transition">
            <Trash2 className="w-3 h-3" />
          </button>
        ) : null}
      </div>
      {uploadError ? <div className="text-[10px] text-red-300/80">{uploadError}</div> : null}
    </div>
  );
}

// ─── Live preview ──────────────────────────────────────────────────────────

function LayoutPreview({ config }: { config: DockLayoutConfig }) {
  const dockStyle = (edge: DockEdge, color: string): string => {
    const base = `absolute rounded-sm ${color}`;
    switch (edge) {
      case 'left': return `${base} left-0 top-0 bottom-0 w-2`;
      case 'right': return `${base} right-0 top-0 bottom-0 w-2`;
      case 'top': return `${base} top-0 left-0 right-0 h-2`;
      case 'bottom': return `${base} bottom-0 left-0 right-0 h-2`;
    }
  };

  return (
    <div className="w-24 h-16 rounded-lg border border-white/10 bg-white/5 relative overflow-hidden">
      <div className={dockStyle(config.primary.edge, 'bg-blue-400/60')} />
      <div className={dockStyle(config.secondary.edge, 'bg-purple-400/60')} />
      <div className="absolute inset-3 rounded-sm bg-white/10" />
    </div>
  );
}

// ─── Main Panel ────────────────────────────────────────────────────────────

export function LayoutSettingsPanel() {
  const [config, setConfig] = useState<DockLayoutConfig>(DEFAULT_DOCK_LAYOUT);

  useEffect(() => {
    setConfig(readDockLayoutConfig());
  }, []);

  const update = (next: DockLayoutConfig) => {
    setConfig(next);
    saveDockLayoutConfig(next);
    window.dispatchEvent(new CustomEvent('neuralis:layout-changed', { detail: next }));
  };

  const updateDock = (dockId: DockId, edge: DockEdge, align: DockAlign) => {
    update({ ...config, [dockId]: { ...config[dockId], edge, align } });
  };

  return (
    <div className="h-full w-full overflow-y-auto p-4 flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white/80">Layout</h3>
        <button type="button" onClick={() => update(DEFAULT_DOCK_LAYOUT)}
          className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs text-white/50 hover:text-white/80 hover:bg-white/10 transition"
          title="Reset to default">
          <RotateCcw className="w-3 h-3" /> Reset
        </button>
      </div>

      <div className="flex justify-center">
        <LayoutPreview config={config} />
      </div>

      {/* 9-position dock selectors */}
      <div className="flex flex-wrap gap-5 justify-center">
        <PositionGrid
          value={config.primary}
          onChange={(edge, align) => updateDock('primary', edge, align)}
          label="Primary"
          color="#60a5fa"
        />
        <PositionGrid
          value={config.secondary}
          onChange={(edge, align) => updateDock('secondary', edge, align)}
          label="Secondary"
          color="#a78bfa"
        />
      </div>

      {/* Dock order + hidden items (per project) */}
      <EditDocksToggle />

      {/* Stage mode (tiled / canvas / grid) */}
      <StageModeToggle />

      {/* Chat position */}
      <ChatPositionToggle
        value={config.chatPosition}
        onChange={(chatPosition) => update({ ...config, chatPosition })}
      />

      {/* Default widget transparency */}
      <TransparencyDefaultToggle
        label="Widgets:"
        value={config.defaultWidgetTransparency}
        onChange={(defaultWidgetTransparency) => update({ ...config, defaultWidgetTransparency })}
      />

      {/* Default dock transparency */}
      <TransparencyDefaultToggle
        label="Dock:"
        value={config.defaultDockTransparency}
        onChange={(defaultDockTransparency) => update({ ...config, defaultDockTransparency })}
      />

      {/* Theme (moved from ThemeSwitcher dock item) */}
      <div className="border-t border-white/8 pt-4">
        <ThemeSection />
      </div>

      <p className="text-[10px] text-white/25 text-center">
        Primary = tools &amp; files &bull; Secondary = agents
      </p>
    </div>
  );
}
