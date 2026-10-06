/**
 * The host's two PURE credential-plane pieces: the most-specific-wins resolver
 * every package reaches through `ctx.credentials`, and the parser that turns a
 * store scope string back into the scope a credential-change event carries.
 *
 * Both mirror `CredentialStore`'s scope shapes, which is why they live beside
 * each other: a new scope shape there needs an arm in BOTH. The bus WIRING (the
 * ONE store subscription that fans `runtime.notifyCredentialChanged` out) stays
 * in `bootstrap.ts`.
 */

import type { CredentialResolver } from '@neuralis/package-system/contracts';
import type { SuppliedScope } from '@neuralis/package-system/access';
import { isSafePathSegment } from '@neuralis/package-system/paths';
import { AGENT_SCOPE_PREFIX, GLOBAL_SCOPE, UNRESOLVED_AGENT_DIR, USER_SCOPE_PREFIX } from '../store/CredentialStore';

/**
 * An id that names a store directory. The store REFUSES anything else by throwing
 * (its path choke point), but the resolver's contract is "never throws": an id
 * that can name no directory holds no credential, so that tier is a miss and the
 * lookup falls through to the next one.
 */
function locatable(id: string | undefined): id is string {
  return id !== undefined && id !== '' && isSafePathSegment(id);
}

/**
 * A project id the store will read AS a project. `store.read` takes a scope
 * STRING, so an id spelled like another scope (`user:<id>`, `agent:<p>/<a>`,
 * `_global`) would reach that scope's directory from the project tier — another
 * user's secret, or the global value jumping ahead of the user tier. Project ids
 * are slugified, so no real one looks like this; the refusal keeps the tier from
 * depending on that.
 */
function projectTierId(id: string | undefined): id is string {
  return (
    locatable(id) &&
    id !== GLOBAL_SCOPE &&
    !id.startsWith(USER_SCOPE_PREFIX) &&
    !id.startsWith(AGENT_SCOPE_PREFIX)
  );
}

/**
 * The single host-injected resolver the package-system forwards to every
 * package via `ctx.credentials`. Channel/connector packages MUST go through
 * this instead of `process.env.*`.
 */
export function buildCredentialResolver(): CredentialResolver {
  return {
    async resolveCredential(id, scope) {
      // Most-specific-wins precedence: agent → project → user → global.
      // Project is checked before user so the existing codex OAuth
      // project-scope override keeps beating a user-scope value. The agent tier
      // needs BOTH ids: an agent slug is per-project, so an agent id alone
      // names no directory.
      const { getCredentialStore } = await import('../store/credentialStoreInstance');
      const store = getCredentialStore();
      const projectId = projectTierId(scope?.projectId) ? scope.projectId : undefined;
      if (projectId && projectId !== UNRESOLVED_AGENT_DIR && locatable(scope?.agentId)) {
        const value = await store.readAgent(projectId, scope.agentId, id);
        if (value) return value;
      }
      if (projectId) {
        const value = await store.read(projectId, id);
        if (value) return value;
      }
      if (locatable(scope?.userId)) {
        const value = await store.readUser(scope.userId, id);
        if (value) return value;
      }
      return store.readGlobal(id);
    },
    async resolveForKind(_kind, _scope) {
      // Channel-shaped credential bundles are resolved per-connection from the
      // scoped CredentialStore + SelfScopeCredentialWriter (meerkat Inc 4), NOT
      // from process.env. This `CredentialResolver` contract method is kept for
      // type parity but has no host implementation — every channel secret flows
      // through the audited credential pipeline (CLAUDE.md principle 9).
      return {};
    },
  };
}

/**
 * Translate the store's flat scope string into the kernel's ONE credential-scope
 * vocabulary (`SuppliedScope`) — the scope a `CredentialChangedEvent` carries to
 * every package's `onCredentialChanged`. Mirrors `CredentialStore.credentialsDir`:
 * a new scope shape there needs an arm here, or package caches go stale after a
 * rotation across tenants.
 *
 * An agent scope keeps BOTH axes (`agents/<projectId>/<agentId>`) — the same
 * slug in another project is another agent.
 */
export function parseStoreScope(storeScope: string): SuppliedScope {
  if (storeScope === GLOBAL_SCOPE) return { kind: 'global' };
  if (storeScope.startsWith(USER_SCOPE_PREFIX)) {
    return { kind: 'user', userId: storeScope.slice(USER_SCOPE_PREFIX.length) };
  }
  if (storeScope.startsWith(AGENT_SCOPE_PREFIX)) {
    const rest = storeScope.slice(AGENT_SCOPE_PREFIX.length);
    const slash = rest.indexOf('/');
    return { kind: 'agent', projectId: rest.slice(0, slash), agentId: rest.slice(slash + 1) };
  }
  return { kind: 'project', projectId: storeScope };
}
