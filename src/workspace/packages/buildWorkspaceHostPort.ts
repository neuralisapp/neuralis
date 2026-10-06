/**
 * Implementation of `WorkspaceHostPort`. The host exposes one workspace state
 * surface; every first-party package consumes it through
 * `<NeuralisHostProvider>`.
 */

'use client';

import type {
  WorkspaceHostPort,
  WorkspaceAgentInfo,
  WorkspaceFileMark,
  PackageRuntimeSnapshot,
  VisibleSkill,
} from '@neuralis/package-system/contracts';
import { useSyncExternalStore } from 'react';
import { useSession } from 'next-auth/react';
import { rolePriority } from '@neuralis/package-system/access';
import { useWorkspaceStore, agentRuntimeKey, getDefaultChatWidgetType } from '../store/workspaceStore';
import { UserAvatar, UserAvatarStack } from '../shell/UserAvatar';
import { getHubConnected, subscribeHub } from '../realtime/eventHub';
import { subscribeClientStateReset } from '../store/clientResetBus';
import { getScopedSnapshot, onSnapshotChange } from './runtimeClient';

const EMPTY_FILE_MARKS: Record<string, WorkspaceFileMark> = {};

/**
 * Module CONSTANT, not a fresh `[]` per call — `useSyncExternalStore` compares
 * snapshot identity, so returning a new array on the "no scoped snapshot yet"
 * path would re-render forever.
 */
const NO_VISIBLE_SKILLS: readonly VisibleSkill[] = Object.freeze([]);

/**
 * Memoize the mapped rows by SNAPSHOT IDENTITY. Same reason as above: React
 * throws "The result of getSnapshot should be cached to avoid an infinite
 * loop" if the mapping runs fresh on every render. The runtime client hands
 * out the same object until a new snapshot is fetched, so a WeakMap keyed on it
 * is exactly the right lifetime.
 */
const visibleSkillsBySnapshot = new WeakMap<PackageRuntimeSnapshot, readonly VisibleSkill[]>();

/**
 * PURE PROJECTION — zero policy of its own.
 *
 * `snapshot.skills` is ALREADY the authoritative per-caller answer:
 * `snapshot.ts:320` builds it through `buildContributions`, which applies S2 via
 * `hasRequiredFeatures` → the ONE shared `meetsRequires`, over
 * `visibleDefinitions` (host targeting → project install membership → R2b
 * source-owner scope → base-access feature). Re-deciding ANY of that here would
 * be a second copy of a predicate that already exists — the exact drift class
 * this whole launcher rework deletes.
 *
 * That also means: do not "helpfully" filter here. Two such filters were
 * written and removed during this change — `status === 'error'` (dead: a
 * package whose load failed registers no contributions at all) and
 * `defaultEnabled === false`, which was outright WRONG: the snapshot carries
 * the DECLARED default, not the effective per-agent/per-conversation override,
 * so it would have hidden skills the caller had explicitly switched ON. Effective
 * per-file enablement lives in agent-core's `packages/overview` projection; a
 * surface that needs it passes `visible` to `<SkillLauncher>` explicitly.
 */
function mapVisibleSkills(snapshot: PackageRuntimeSnapshot | null): readonly VisibleSkill[] {
  if (!snapshot) return NO_VISIBLE_SKILLS;
  const cached = visibleSkillsBySnapshot.get(snapshot);
  if (cached) return cached;

  const frozen: readonly VisibleSkill[] = Object.freeze(
    snapshot.skills.map((file) => ({
      packageId: file.packageId,
      skill: file.id,
      ...(file.title ? { title: file.title } : {}),
      ...(file.files ? { files: file.files } : {}),
    })),
  );
  visibleSkillsBySnapshot.set(snapshot, frozen);
  return frozen;
}

/**
 * `useSyncExternalStore` subscribe adapter over the runtime-client listeners.
 * The server snapshot is always `null` (see the call site): SSR has no scoped
 * snapshot and must not guess one, so the server pass renders the empty catalog
 * and the client re-renders once the scoped fetch lands.
 */
function subscribeVisibleSkills(onStoreChange: () => void): () => void {
  return onSnapshotChange(() => onStoreChange());
}

const isDocker = process.env.NEXT_PUBLIC_NEURALIS_DOCKER === 'true';

export const workspaceHostPort: WorkspaceHostPort = {
  useProjectId: () => useWorkspaceStore((s) => s.session.projectId),
  useUserId: () => {
    const { data: authSession } = useSession();
    return ((authSession?.user as Record<string, unknown> | undefined)?.id as string | null) ?? null;
  },
  useCurrentUser: () => {
    const { data: authSession } = useSession();
    const userId = (authSession?.user as Record<string, unknown> | undefined)?.id as string | undefined;
    // R2b — resolve the caller's role + ordinal priority in the active project
    // from the same store the feature gates read, so owner/admin-only controls
    // can hide for non-owner. Select PRIMITIVES only (a selector returning a
    // fresh object loops forever under React 19 / Zustand — see the comment on
    // useAgentsById below). `priority` is a number, `role` a string.
    const role = useWorkspaceStore((s) => {
      const projectId = s.session.projectId;
      if (!projectId || !userId) return undefined;
      return s.projects.byId[projectId]?.members[userId]?.role;
    });
    const priority = useWorkspaceStore((s) => {
      const projectId = s.session.projectId;
      if (!projectId || !userId || !role) return undefined;
      const roleDef = s.projects.byId[projectId]?.roles[role];
      return rolePriority(role, roleDef?.priority);
    });
    const user = authSession?.user;
    if (!user) return null;
    return {
      name: user.name ?? undefined,
      email: user.email ?? undefined,
      ...(role !== undefined ? { role } : {}),
      ...(priority !== undefined ? { priority } : {}),
    };
  },
  useActiveAgentId: () => useWorkspaceStore((s) => s.session.agentId),
  getActiveAgentId: () => useWorkspaceStore.getState().session.agentId,
  getProjectId: () => useWorkspaceStore.getState().session.projectId,

  useAgent: (agentId) =>
    useWorkspaceStore((s): WorkspaceAgentInfo | undefined => s.agents.byId[agentId]),
  useAgentIds: () => useWorkspaceStore((s) => s.agents.ids),
  useAgentsById: () =>
    // Keep the Zustand snapshot referentially stable. Projecting each agent
    // into a fresh object here makes React 19 loop on every render.
    useWorkspaceStore((s): Record<string, WorkspaceAgentInfo> => s.agents.byId),

  useFileMarks: (agentId) =>
    useWorkspaceStore((s) =>
      agentId && s.session.projectId
        ? (s.fileMarksByAgentId[agentRuntimeKey(s.session.projectId, agentId)] ?? EMPTY_FILE_MARKS)
        : EMPTY_FILE_MARKS,
    ),
  clearFileMark: (params) => useWorkspaceStore.getState().clearFileMark(params),

  useChatCollapsed: (agentId) =>
    useWorkspaceStore((s) => {
      // The port contract stays bare-agent; the composite key is composed HERE
      // (agent ids repeat across projects — the map is (project, agent)-keyed).
      const rk = s.session.projectId ? agentRuntimeKey(s.session.projectId, agentId) : null;
      const rt = rk ? s.runtimeByAgentId[rk] : undefined;
      if (!rt) return false;
      // The slot is the manifest's `defaultOpen` widget — the type `setChatCollapsed` closes and reopens.
      const slotType = getDefaultChatWidgetType();
      return slotType !== null && !rt.widgets.openOrder.some((id) => rt.widgets.byId[id]?.type === slotType);
    }),
  setChatCollapsed: (agentId, collapsed) =>
    useWorkspaceStore.getState().setChatCollapsed({ agentId, collapsed }),

  openWidget: (params) => useWorkspaceStore.getState().openWidget(params),
  updateWidgetState: (params) => useWorkspaceStore.getState().updateWidgetState(params),

  selectAgent: (agentId) => useWorkspaceStore.getState().selectAgent(agentId),
  reload: () => useWorkspaceStore.getState().reload(),
  // The layout-preserving twin of `reload()`. `reload` is `reset()` +
  // `bootstrap()`, and `reset()` returns `initialState()` — which wipes
  // `runtimeByAgentId`, i.e. EVERY project's widget layouts, and persist then
  // erases them from localStorage too. `selectProject` re-fetches the agent
  // list and re-points the session (falling back to the first surviving agent
  // when the current one is gone) while explicitly leaving that map alone.
  reloadAgents: async () => {
    const projectId = useWorkspaceStore.getState().session.projectId;
    if (!projectId) return;
    await useWorkspaceStore.getState().selectProject(projectId);
  },

  getGrantedFeatures: (projectId, userId) => {
    // DENY BY DEFAULT. `useUserId()` is null while the NextAuth session loads
    // and `session.projectId` is null before bootstrap/rehydrate, so this path
    // runs on every page load. Returning `['*']` there made `hasFeature`
    // short-circuit true for that window — rendering EVERY feature-gated
    // surface to every caller: skill launchers for privileged skills
    // (`manage-credentials` + `manage-uri-policy`, both admin-tier;
    // `manage-platform-config`, owner-strength — `platform.config` has no
    // default grant at all),
    // the chat config panel's Credentials + Git Remotes cards, and the full
    // admin tab set. An unknown identity holds no features.
    if (!projectId || !userId) return [];
    const state = useWorkspaceStore.getState();
    const project = state.projects.byId[projectId];
    if (!project) return [];
    const member = project.members[userId];
    if (!member) return [];
    const roleDef = project.roles[member.role];
    return roleDef?.grantedFeatures ?? [];
  },

  // The DERIVED skill catalog. Read `getScopedSnapshot` — NOT
  // `getCachedSnapshot` — because membership here is a VISIBILITY PROOF: the
  // unscoped SSR seed carries every project's ungated skills, so reading it
  // would advertise a foreign project's skills during first paint.
  useVisibleSkills: () => {
    const projectId = useWorkspaceStore((s) => s.session.projectId);
    const agentId = useWorkspaceStore((s) => s.session.agentId);
    const snapshot = useSyncExternalStore(
      subscribeVisibleSkills,
      () => getScopedSnapshot({ projectId, agentId }),
      () => null,
    );
    return mapVisibleSkills(snapshot);
  },
  getVisibleSkills: () => {
    const { projectId, agentId } = useWorkspaceStore.getState().session;
    return mapVisibleSkills(getScopedSnapshot({ projectId, agentId }));
  },

  buildEventStreamUrl: ({ packageSlug, agentId, projectId, types }) =>
    `/api/packages/${packageSlug}/events?${new URLSearchParams({ agentId, projectId, types })}`,

  // ONE multiplexed connection for the whole workspace — backed by the host
  // eventHub. Package widgets subscribe here instead of opening their own
  // EventSource.
  subscribeRealtime: (params) => subscribeHub(params),
  isRealtimeConnected: () => getHubConnected(),
  // The dock broom reaches package client stores through this bus only — never
  // through a host → package import (the direct agent-core call in
  // `cleanAgentStore` is the W9 baseline this generalizes).
  onClientStateReset: (handler) => subscribeClientStateReset(handler),

  isDocker,

  components: { UserAvatar, UserAvatarStack },
};
