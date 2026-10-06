'use client';

import { createElement, useEffect, useRef, useState, type ComponentType } from 'react';
import type { PackageRuntimeSnapshot } from '@neuralis/package-system/contracts';
import { useWorkspaceStore } from './store/workspaceStore';
import { useWorkspaceSession } from './store/selectors';
import {
  fetchPackageSnapshot,
  seedSnapshotCache,
  onSnapshotChange,
  subscribeToRuntimeEvents,
} from './packages/runtimeClient';
import { hydrateWidgetRegistry } from './packages/widgetRuntime';
import { armUiModuleHoldRelease, ensureUiModules, readUiAttachments, useUiModulesPending } from './packages/uiModuleLoader';
import { HOST_SLOTS, useHostSlot } from './packages/hostRegistryInstance';
import { ThemeProvider } from './theme/ThemeContext';
import { WorkspaceShell } from './shell/WorkspaceShell';
import { StageHost } from './shell/StageHost';
import { NeuralisHostProvider } from './NeuralisHostProvider';
import { subscribeProjectRecordChanges } from './realtime/eventHub';
import { useNotificationsFeed } from './notifications/notificationsClient';

/**
 * How long the workspace waits on its first snapshot or its UI modules before
 * it shows the shell anyway. A late snapshot still applies; a late module
 * still attaches, its surfaces showing their own "Loading…" until it lands.
 */
const LOADING_FALLBACK_MS = 6000;

type WorkspaceRootProps = {
  initialSnapshot: PackageRuntimeSnapshot | null;
  refreshSnapshot: () => Promise<PackageRuntimeSnapshot>;
};

/**
 * The SYNCHRONOUS half of applying a snapshot (CARD1 3C M3).
 *
 * `seedSnapshotCache` + `hydrateWidgetRegistry` must stay synchronous at every
 * call site: `WidgetRendererStrategy.resolveWidgetRenderer` runs at dock/stage
 * RENDER time with no subscription, so deferring it to an effect would blank
 * the first paint. The CARD registry is the opposite — an observable
 * `useSyncExternalStore` store, so a late registration re-resolves a rendered
 * row. Only the card reconcile is therefore effect-driven and
 * generation-serialized — run by the card-owning package's
 * `workspace.provider` fill, from the snapshot handed to it below.
 */
function applySnapshot(
  snapshot: PackageRuntimeSnapshot,
  scope?: { projectId: string | null; agentId: string | null },
): void {
  seedSnapshotCache(snapshot, scope ?? undefined);
  hydrateWidgetRegistry(snapshot);
}

export function WorkspaceRoot({ initialSnapshot, refreshSnapshot }: WorkspaceRootProps) {
  const bootstrap = useWorkspaceStore((s) => s.bootstrap);
  const projectsStatus = useWorkspaceStore((s) => s.projects.status);
  const agentsStatus = useWorkspaceStore((s) => s.agents.status);
  const { projectId, agentId, workspaceView } = useWorkspaceSession();

  // Apply SSR snapshot immediately on first render (before effects run).
  // useState initializer runs once — perfect for one-time side effects on mount.
  const [snapshotReady] = useState(() => {
    if (initialSnapshot && initialSnapshot.surfaces?.length > 0) {
      applySnapshot(initialSnapshot);
      return true;
    }
    return false;
  });
  const [ready, setReady] = useState(snapshotReady);
  // The DESIRED card-registry state. Held in state (never applied during
  // render) so the reconcile runs from an effect, generation-serialized.
  const [cardSnapshot, setCardSnapshot] = useState<PackageRuntimeSnapshot | null>(
    snapshotReady ? initialSnapshot : null,
  );

  useEffect(() => { bootstrap(); }, [bootstrap]);

  // The notification badges' feed has ONE holder, here, ABOVE
  // `NeuralisHostProvider`: every package provider that attaches at runtime
  // wraps the tree in a new element, so everything below it — the shell and
  // both docks — remounts; a holder there would release to zero and re-read
  // the counts on each attach.
  useNotificationsFeed(projectId);

  const refreshRef = useRef(refreshSnapshot);
  refreshRef.current = refreshSnapshot;

  useEffect(() => {
    let mounted = true;
    if (!projectId) return;
    let resolved = ready;

    const safeApply = (snapshot: PackageRuntimeSnapshot) => {
      if (!mounted || resolved) return;
      resolved = true;
      applySnapshot(snapshot);
      setCardSnapshot(snapshot);
      setReady(true);
    };

    const scope = { projectId, agentId };

    const stopListening = onSnapshotChange((snapshot) => {
      if (!mounted) return;
      // Re-apply on runtime invalidation (package install/update) — but the
      // CACHE half is deliberately NOT repeated here.
      //
      // A notify only ever fires from inside `seedSnapshotCache`, i.e. AFTER
      // whoever produced this snapshot already wrote it under ITS OWN key
      // (`fetchPackageSnapshot` writes the scoped key; the SSR/Server-Action
      // seeds write the unscoped one). Re-seeding from here would stamp the
      // effect's scope onto whatever payload arrived — and on the cold-boot
      // path the Server-Action fallback delivers the UNSCOPED payload, so the
      // cache would end up labelled `p1:a1` while holding every project's
      // packages. The `_notifying` guard does not help: it blocks the nested
      // NOTIFY, not the cache WRITE that precedes it.
      hydrateWidgetRegistry(snapshot);
      setCardSnapshot(snapshot);
      void ensureUiModules(readUiAttachments(snapshot));
      if (!resolved) {
        resolved = true;
        setReady(true);
      }
    });
    const stopStreaming = subscribeToRuntimeEvents({ projectId, agentId });

    // ALWAYS fetch the project-scoped snapshot once a project is known — even
    // when the SSR seed already released the loading overlay. The seed is built
    // with no projectId (`getSSRSnapshot`), so it carries the ungated
    // contributions of EVERY project's packages; skipping this fetch left the
    // whole session running on that unscoped payload until an unrelated runtime
    // invalidation happened to arrive. Surfaces that treat snapshot membership
    // as a visibility PROOF (the derived skill launcher, via `getScopedSnapshot`)
    // stay empty until this lands — fail-closed, and it lands on every load.
    void fetchPackageSnapshot(scope)
      .then((snapshot) => {
        // Only the runtime ROUTE attaches `ui`; the unscoped seeds carry none.
        if (mounted) void ensureUiModules(readUiAttachments(snapshot));
        if (!mounted || !snapshot?.surfaces?.length) return;
        applySnapshot(snapshot, scope);
        setCardSnapshot(snapshot);
        if (!resolved) {
          resolved = true;
          setReady(true);
        }
      })
      .catch(() => { /* ignore — the seed/Server-Action paths still apply */ });

    // If SSR snapshot was already applied, skip the remaining fallbacks
    if (!resolved) {
      // Fallback 1: Server Action. NOTE it returns `getSSRSnapshot()` — the
      // same UNSCOPED payload as the seed — so it must apply WITHOUT a scope.
      void refreshRef.current()
        .then((snapshot) => {
          if (snapshot?.surfaces?.length) safeApply(snapshot);
        })
        .catch(() => { /* ignore */ });

      // (The scoped HTTP fetch above is unconditional and covers this case.)

      // Fallback 2: Timeout — release the loading overlay.
      const timeout = window.setTimeout(() => {
        if (!mounted || resolved) return;
        setReady(true);
      }, LOADING_FALLBACK_MS);

      return () => {
        mounted = false;
        window.clearTimeout(timeout);
        stopListening();
        stopStreaming();
      };
    }

    return () => {
      mounted = false;
      stopListening();
      stopStreaming();
    };
  }, [projectId, agentId, ready]);

  // Agents not resolved yet for the active project (idle covers the first
  // paint before selectProject's merged set() lands; loading covers the fetch
  // window). 'error' deliberately falls through to today's behavior.
  const agentsPending = agentsStatus === 'idle' || agentsStatus === 'loading';
  const isBootstrapping = !projectId || projectsStatus === 'idle' || projectsStatus === 'loading';
  const hasAgent = Boolean(agentId);
  // First-party UI modules attach behind the loading branch, so a later
  // registration has no rendered shell to disturb. Once the shell has shown, a
  // module attaching later (another project's snapshot) never flips it back.
  // The wait is bounded by the same fallback as the snapshot: a module whose
  // import never settles releases the shell, never holds it.
  const uiModulesPending = useUiModulesPending();
  const shellShownRef = useRef(false);
  useEffect(() => armUiModuleHoldRelease(LOADING_FALLBACK_MS), []);
  const holdForModules = uiModulesPending && !shellShownRef.current;
  const EmptyState = useHostSlot(HOST_SLOTS.emptyState);

  // A project record the user belongs to changed (renamed, re-described,
  // members/roles edited, restored) — the frame reaches this hub whichever
  // project it is keyed on — or the hub came back after a drop. Re-read the
  // LIST only: `refreshProjects` keeps the layout and session, where
  // `reload()` would wipe them.
  const refreshProjects = useWorkspaceStore((s) => s.refreshProjects);
  useEffect(() => {
    if (!projectId) return;
    return subscribeProjectRecordChanges({ projectId, onChange: () => { void refreshProjects(); } });
  }, [projectId, refreshProjects]);

  const loading = (
    <div className="h-full flex items-center justify-center">
      <div className="text-white/50 text-sm animate-pulse">Loading workspace...</div>
    </div>
  );
  let content: React.ReactNode;

  if (isBootstrapping || (!hasAgent && agentsPending) || holdForModules) {
    // The second arm kills the agent-create wizard FLASH during a project
    // switch with no remembered agent: while the agent list is still
    // resolving, show loading — the wizard is the DESIGNED empty state only
    // AFTER the list confirms the project has zero agents.
    content = loading;
  } else if (workspaceView === 'agent_create' || !hasAgent) {
    // The empty state is a package's slot fill (the agent studio). Until a
    // module fills it — a module still attaching past the gate — it shows the
    // loading line rather than an empty pane.
    shellShownRef.current = true;
    content = EmptyState ? createElement(EmptyState as ComponentType) : loading;
  } else {
    shellShownRef.current = true;
    content = <StageHost />;
  }

  return (
    <ThemeProvider>
      <NeuralisHostProvider snapshot={cardSnapshot}>
        <WorkspaceShell snapshotReady={ready}>{content}</WorkspaceShell>
      </NeuralisHostProvider>
    </ThemeProvider>
  );
}
