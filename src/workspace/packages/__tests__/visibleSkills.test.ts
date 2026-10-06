/**
 * `WorkspaceHostPort.getVisibleSkills` — the derived skill catalog
 * `<SkillLauncher>` renders from.
 *
 * Two properties are worth a test because both fail in ways that are hard to
 * read at runtime:
 *
 * 1. **Fail-closed on scope.** The catalog must be EMPTY while the cached
 *    snapshot is the unscoped SSR seed, which carries the ungated contributions
 *    of every project's packages. A regression here does not throw — it quietly
 *    advertises another project's skills during the first-paint window.
 * 2. **Identity stability.** `useVisibleSkills` feeds `useSyncExternalStore`,
 *    which compares snapshots by identity. Mapping fresh objects on every call
 *    makes React throw "The result of getSnapshot should be cached to avoid an
 *    infinite loop" — a crash whose message points nowhere near this file.
 */

import { describe, expect, it } from 'vitest';
import type { PackageRuntimeSnapshot } from '@neuralis/package-system/contracts';
import { seedSnapshotCache } from '../runtimeClient';
import { workspaceHostPort } from '../buildWorkspaceHostPort';
import { useWorkspaceStore } from '../../store/workspaceStore';

function snapshotWithSkills(): PackageRuntimeSnapshot {
  return {
    revision: 'r-skills',
    generatedAt: 0,
    packages: [
      { id: '@neuralis/admin', status: 'loaded' },
      { id: '@neuralis/broken', status: 'error' },
    ],
    tools: [],
    surfaces: [],
    commands: [],
    skills: [
      { id: 'inspect-admin', packageId: '@neuralis/admin', path: 'skills/inspect-admin/SKILL.md', category: 'skill', title: 'Inspect admin', files: ['SKILL.md', 'scripts/stats.sh'] },
      // A file whose package failed to load, and one that is opt-in by default.
      // NEITHER is filtered here: the snapshot is the server's authoritative
      // per-caller answer, and re-deciding in the client is how a second copy of
      // a predicate gets born. `defaultEnabled` in particular is the DECLARED
      // default, not the effective per-agent override.
      { id: 'ghost', packageId: '@neuralis/broken', path: 'skills/ghost/SKILL.md', category: 'skill' },
      { id: 'opt-in', packageId: '@neuralis/admin', path: 'skills/opt-in/SKILL.md', category: 'skill', defaultEnabled: false },
    ],
    instructions: [],
    rules: [],
    agents: [],
    docs: [],
    workflows: [],
    team: [],
    resources: [],
  } as unknown as PackageRuntimeSnapshot;
}

function setSession(projectId: string | null, agentId: string | null): void {
  useWorkspaceStore.setState((s) => ({
    ...s,
    session: { ...s.session, projectId, agentId },
  }));
}

describe('getVisibleSkills', () => {
  it('is EMPTY when the cache holds only the unscoped SSR seed', () => {
    seedSnapshotCache(snapshotWithSkills()); // no scope — how WorkspaceRoot seeds SSR
    setSession('p1', 'a1');
    expect(workspaceHostPort.getVisibleSkills()).toEqual([]);
  });

  it('is EMPTY in the PRE-BOOTSTRAP window (session ids still null)', () => {
    // The port asks with whatever the store holds, and both ids are null until
    // `bootstrap()` resolves — on EVERY page load. Until the scope-key sentinel
    // landed, that shape collided with the unscoped seed and this returned the
    // full cross-project catalog. Only the loading overlay hid it.
    seedSnapshotCache(snapshotWithSkills());
    setSession(null, null);
    expect(workspaceHostPort.getVisibleSkills()).toEqual([]);
  });

  it('projects the scoped snapshot verbatim, with registry ids and bundle files', () => {
    const snapshot = snapshotWithSkills();
    seedSnapshotCache(snapshot, { projectId: 'p1', agentId: 'a1' });
    setSession('p1', 'a1');

    const rows = workspaceHostPort.getVisibleSkills();
    expect(rows.map((r) => `${r.packageId}:${r.skill}`)).toEqual([
      '@neuralis/admin:inspect-admin',
      '@neuralis/broken:ghost',
      '@neuralis/admin:opt-in',
    ]);
    expect(rows[0].title).toBe('Inspect admin');
    expect(rows[0].files).toEqual(['SKILL.md', 'scripts/stats.sh']);
  });

  it('is EMPTY again for a DIFFERENT project than the snapshot was built for', () => {
    seedSnapshotCache(snapshotWithSkills(), { projectId: 'p1', agentId: 'a1' });
    setSession('p2', 'a1');
    expect(workspaceHostPort.getVisibleSkills()).toEqual([]);
  });

  it('returns an identity-stable array for the same snapshot', () => {
    seedSnapshotCache(snapshotWithSkills(), { projectId: 'p1', agentId: 'a1' });
    setSession('p1', 'a1');
    expect(workspaceHostPort.getVisibleSkills()).toBe(workspaceHostPort.getVisibleSkills());
  });

  it('returns the SAME empty array instance on the null path', () => {
    seedSnapshotCache(snapshotWithSkills()); // unscoped
    setSession('p1', 'a1');
    expect(workspaceHostPort.getVisibleSkills()).toBe(workspaceHostPort.getVisibleSkills());
  });
});
