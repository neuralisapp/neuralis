'use client';

import { useEffect, useState } from 'react';
import { Group, Panel, Separator, type Layout } from 'react-resizable-panels';
import { useWorkspaceStore } from '../store/workspaceStore';
import { useOpenWidgets } from '../store/selectors';
import { PanelChrome } from './PanelChrome';
import { TRANSPARENCY_CYCLE } from './WidgetControls';
import { getWidgetDefinition } from '../widgets/registry';
import type { TransparencyLevel, WidgetInstance } from '../store/types';
import type { ChatPosition } from './dockPlacement';
import { readDockLayoutConfig } from './dockPlacement';
import { resolveWidgetLevel } from './widgetSurface';
import { useStageOutlet } from './stageOutlet';

function Handle() {
  return (
    <Separator
      className="w-3 rounded-full bg-white/0 hover:bg-white/10 transition"
    />
  );
}

/**
 * The tiled stage — a horizontal row of resizable panels, one per visible
 * widget. It is a PURE LAYOUT component: the widget content lives in
 * keep-alive outlet nodes owned by `StageHost`, which this stage receives via
 * `registerPlaceholder` (the placeholder div inside each `PanelChrome`).
 * Unmounting a placeholder (minimize / stage switch) preserves the widget's
 * REACT subtree but NOT an `<iframe>` inside it — the frame is detached from
 * the document and reloads (see `widgets/README.md`).
 */
export function TiledStage() {
  const { agentId, openOrder, byId, widgetSplitsById } = useOpenWidgets();
  const minimizeWidget = useWorkspaceStore((s) => s.minimizeWidget);
  const setWidgetSplits = useWorkspaceStore((s) => s.setWidgetSplits);
  const setWidgetTransparency = useWorkspaceStore((s) => s.setWidgetTransparency);
  const registerPlaceholder = useStageOutlet();

  // Lazy-init from localStorage so the first render already matches the
  // persisted layout — prevents a mount-then-reshuffle that corrupts
  // react-resizable-panels' internal state.
  const [chatPosition, setChatPosition] = useState<ChatPosition>(() =>
    typeof window === 'undefined' ? 'start' : readDockLayoutConfig().chatPosition,
  );
  const [defaultTransparency, setDefaultTransparency] = useState<TransparencyLevel>(() =>
    typeof window === 'undefined' ? 'opaque' : (readDockLayoutConfig().defaultWidgetTransparency ?? 'opaque'),
  );
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.chatPosition) setChatPosition(detail.chatPosition);
      if (detail?.defaultWidgetTransparency) setDefaultTransparency(detail.defaultWidgetTransparency);
    };
    window.addEventListener('neuralis:layout-changed', handler);
    return () => window.removeEventListener('neuralis:layout-changed', handler);
  }, []);

  const allWidgets = openOrder.map((id) => byId[id]).filter(Boolean) as WidgetInstance[];
  const hiddenWidgets = allWidgets.filter((w) => w.hidden);

  // Manifest-driven sort key from `widget.chrome.sortKey`. Lower keys go to
  // the start by default; the user-controlled chatPosition flips end/start.
  // Widgets without a sortKey keep their open-order position relative to each
  // other.
  const widgets = [...allWidgets].filter((w) => !w.hidden).sort((a, b) => {
    const aKey = getWidgetDefinition(a.type)?.chrome?.sortKey;
    const bKey = getWidgetDefinition(b.type)?.chrome?.sortKey;
    const aHas = typeof aKey === 'number';
    const bHas = typeof bKey === 'number';
    if (!aHas && !bHas) return 0;
    if (aHas && bHas) {
      const cmp = aKey! - bKey!;
      return chatPosition === 'start' ? cmp : -cmp;
    }
    if (aHas) return chatPosition === 'start' ? -1 : 1;
    return chatPosition === 'start' ? 1 : -1;
  });

  if (widgets.length === 0) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <div className="text-sm text-white/50">
          {hiddenWidgets.length > 0 ? 'Restore a widget from the dock' : 'Open a widget from the dock'}
        </div>
      </div>
    );
  }

  // `onLayoutChanged` fires once a drag ENDS (and on mount / panel-set
  // changes), never per pointer move — the geometry write-back is one leg of
  // the dock feedback loop, so it stays at one store write per gesture. The
  // layout is a panel-id → percent map; `widgetSplitsById` persists the same
  // percents.
  const onLayoutChanged = (layout: Layout) => {
    if (!agentId) return;
    const widgetIds = widgets.map((w) => w.id);
    const sizes = widgetIds.map((id) => layout[id]);
    if (!sizes.every((size): size is number => typeof size === 'number')) return;
    const changed = widgetIds.some((id, i) => widgetSplitsById[id] !== sizes[i]);
    if (!changed) return;
    setWidgetSplits({ agentId, widgetIds, sizes });
  };

  return (
    <Group orientation="horizontal" className="h-full w-full" onLayoutChanged={onLayoutChanged}>
      {widgets.flatMap((w, idx) => {
        const savedSize = widgetSplitsById[w.id];
        const defaultSize = typeof savedSize === 'number' ? savedSize : 100 / widgets.length;
        const definition = getWidgetDefinition(w.type);
        const chrome = definition?.chrome;
        const mode = chrome?.mode ?? 'toolbar';
        const isChromeless = mode === 'frameless';

        const { level, showCycle } = resolveWidgetLevel({ instance: w, definition, defaultTransparency });
        const onCycleTransparency = showCycle && agentId
          ? () => setWidgetTransparency({ agentId, widgetInstanceId: w.id, level: TRANSPARENCY_CYCLE[level] })
          : undefined;

        // A NUMBER size means pixels; the persisted splits are percents, so
        // both sizes go in as `"<n>%"` strings.
        const panel = (
          <Panel
            key={`panel-${w.id}`}
            id={w.id}
            defaultSize={`${defaultSize}%`}
            minSize="10%"
          >
            <PanelChrome
              title={w.title}
              subtitle={!isChromeless && mode === 'toolbar' ? w.type : undefined}
              onClose={() => { if (agentId) minimizeWidget({ agentId, widgetInstanceId: w.id }); }}
              mode={mode}
              contentClassName={chrome?.contentClassName}
              level={level}
              onCycleTransparency={onCycleTransparency}
            >
              {/* Keep-alive placeholder — StageHost moves the widget's outlet
                  node here. */}
              <div ref={(el) => { registerPlaceholder(w.id, el); }} className="h-full w-full" />
            </PanelChrome>
          </Panel>
        );

        const handle = idx < widgets.length - 1
          ? <Handle key={`handle-${w.id}`} />
          : null;

        return handle ? [panel, handle] : [panel];
      })}
    </Group>
  );
}
