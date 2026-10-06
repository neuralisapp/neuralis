/**
 * The host implementation of `hostPorts.codexCredentialWriter` — WHERE a Codex
 * OAuth login is stored, and WHO may put it there.
 *
 * The Codex FLOW (pending states, the loopback listener, the token exchange,
 * the routes) belongs to the provider package; the AUTHORITY stays here. The
 * port is restricted to the single id `CODEX_CREDENTIAL_ID` by construction: no
 * member takes a credential id or a writer class, and every binding member
 * re-runs the gate below from LIVE records on each call.
 *
 * Codex is an ordinary credential: it lives at any of the four scopes the
 * rest of the credential plane uses (`agent` · `project` · `user` · `global`,
 * invariant 5) and resolves through the ONE most-specific-wins cascade.
 *
 * The authority answer is composed, never invented here:
 *  1. **Ownership** — the kernel's ONE credential-scope predicate
 *     (`assertScopeMatchesSession`, `@neuralis/package-system/access`) with the
 *     host membership port. It answers "does this session own the scope it
 *     named", including O-3 confinement for every cross arm.
 *  2. **Destination write tier** — ADDITIVE, per scope: `project` and `agent`
 *     also require `project.credentials.write` on the naming project, `global`
 *     rides the kernel's `platform.scope` arm alone, and `user` is OWN-ONLY (a
 *     Codex login is one human's ChatGPT session — writing it into someone
 *     else's scope would hand them the account, so the cross-user arm the
 *     generic predicate allows is refused here BY NAME) AND rides the member
 *     self-service gate every BYOK key rides (`credentials.self`, MN-2),
 *     evaluated in the project the caller names — the owner grants or removes
 *     a member's personal-credential writes per project, and a ChatGPT login
 *     is no exception to that.
 *
 * The authority is rebuilt from STORAGE, not from a request: every completion
 * path (app callback, relay, loopback) writes through `write`, which re-runs
 * the gate with the captured binding immediately before writing, so a grant
 * removed during the consent window does not land. The session comes from the
 * host's ONE member resolver, so this gate can never drift from the catch-all's.
 *
 * The READ side lives here too ({@link canReadCodexAgentScope}), on purpose: a
 * status bit about a scope is an answer ABOUT that scope, and the read tier and
 * the write tier must be the same ownership predicate over the same rebuilt
 * session — never two independently-maintained answers.
 *
 * The `refresh` members serve the stream's self-heal, not a human: persist,
 * purge and the cross-process lock all act on the tier the cascade RESOLVES
 * for the call — the SAME agent → project → user → global precedence
 * `buildCredentialResolver` uses. Each of them used to walk its own two-arm
 * chain; at four scopes that was three chances to persist a rotation where
 * nothing reads it, purge a live credential, or serialize two processes on
 * different locks and burn the refresh-token family.
 */

import { join } from 'node:path';
import {
  assertScopeMatchesSession,
  assertScopeSegment,
  hasFeature,
  scopeLabel,
} from '@neuralis/package-system/access';
import {
  CODEX_CREDENTIAL_ID,
  CodexBindingError,
  type CodexCallScope,
  type CodexCredentialBinding,
  type CodexCredentialStatus,
  type CodexCredentialWriterPort,
  type SessionContext,
} from '@neuralis/package-system/contracts';
import type { Logger } from '@neuralis/package-system/data';
import { getProjectById } from '../store/ProjectStore';
import { resolveMemberSession } from '../auth/memberSession';
import { getScopeMembershipPort } from './scopeMembership';
import { GLOBAL_SCOPE, USER_SCOPE_PREFIX, agentScope } from '../store/CredentialStore';

/** The feature that authorizes writing a PROJECT- or AGENT-scope credential. */
const PROJECT_CREDENTIAL_WRITE_FEATURE = 'project.credentials.write';
/** The member self-service feature that authorizes writing your OWN user-scope credential. */
const SELF_CREDENTIAL_FEATURE = 'credentials.self';

/** The store surface this module needs; the host `CredentialStore` satisfies it. */
export type CodexScopedStore = {
  read(scope: string, credentialId: string): Promise<string | undefined>;
  readUser(userId: string, credentialId: string): Promise<string | undefined>;
  readAgent(projectId: string, agentId: string, credentialId: string): Promise<string | undefined>;
  readGlobal(credentialId: string): Promise<string | undefined>;
  write(scope: string, credentialId: string, value: string): Promise<void>;
  writeUser(userId: string, credentialId: string, value: string): Promise<void>;
  writeAgent(projectId: string, agentId: string, credentialId: string, value: string): Promise<void>;
  writeGlobal(credentialId: string, value: string): Promise<void>;
  delete(scope: string, credentialId: string): Promise<boolean>;
  deleteUser(userId: string, credentialId: string): Promise<boolean>;
  deleteAgent(projectId: string, agentId: string, credentialId: string): Promise<boolean>;
  deleteGlobal(credentialId: string): Promise<boolean>;
};

/** WHERE a Codex credential was found — the tier plus its id(s), when it has one. */
export type ResolvedCodexScope =
  | { tier: 'agent'; projectId: string; agentId: string }
  | { tier: 'project'; projectId: string }
  | { tier: 'user'; userId: string }
  | { tier: 'global' };

/**
 * The project the authority for this binding is evaluated in.
 *
 * For a `project` or `agent` scope the authority project IS the destination's
 * project: evaluating `project.credentials.write` in a DIFFERENT project than
 * the one being written would read the grant from the wrong place (the kernel
 * arm still demands `platform.scope` + membership of the destination, so it was
 * never open — but a feature read in the wrong project is not an authority
 * answer). An absent binding project takes the scope's; a mismatch is refused
 * BY NAME rather than silently resolved to one of the two.
 */
function authorityProjectOf(
  binding: CodexCredentialBinding,
): { ok: true; projectId?: string } | { ok: false; error: string } {
  const { scope } = binding;
  if (scope.kind === 'project' || scope.kind === 'agent') {
    if (binding.projectId && binding.projectId !== scope.projectId) {
      return {
        ok: false,
        error: `Codex OAuth at ${scope.kind} scope evaluates its authority in the destination project; ${binding.projectId} ≠ ${scope.projectId}`,
      };
    }
    return { ok: true, projectId: scope.projectId };
  }
  return { ok: true, projectId: binding.projectId };
}

/**
 * The verified `SessionContext` for `userId` INSIDE `project`, rebuilt from the
 * LIVE records through the host's ONE member resolver, or `null` when the user
 * is not active, the project is archived, the user is not a member or the role
 * is unresolvable (deny-by-default). D-A: the decision downstream belongs to
 * the credential-write feature, never to a role NAME.
 *
 * Exported because every Codex surface that asks a scope question — the write
 * gate here and the `status` read gate — must ask it with the SAME session, or
 * the read tier and the write tier drift apart.
 */
export async function resolveCodexProjectSession(
  projectId: string,
  userId: string,
): Promise<SessionContext | null> {
  return resolveMemberSession(userId, projectId);
}

/**
 * May this caller be TOLD whether `agentId` holds a Codex login, inside
 * `projectId`? The read side of the same ownership question the write gate
 * asks, and FAIL-CLOSED on every uncertainty.
 *
 * The `agentId` is a caller-supplied path segment that reaches the credential
 * store's `credentials/agents/<projectId>/<agentId>` join, so the traversal
 * guard runs BEFORE any read: without it, `../users/<someone>` answered
 * "absent" for a missing file and threw (500) for a present one — an existence oracle for any user's or
 * tenant's Codex login, readable by any authenticated member of any project.
 */
export async function canReadCodexAgentScope(
  userId: string,
  projectId: string,
  agentId: string,
): Promise<boolean> {
  if (!assertScopeSegment(agentId).ok) return false;
  const session = await resolveCodexProjectSession(projectId, userId);
  if (!session) return false;
  const guard = await assertScopeMatchesSession(
    session,
    { kind: 'agent', projectId, agentId },
    getScopeMembershipPort(),
  );
  return guard.ok;
}

/**
 * THE gate. Throws {@link CodexBindingError} with a named reason; returns
 * silently when the binding may be written.
 */
export async function assertCodexBindingAccess(binding: CodexCredentialBinding): Promise<void> {
  const { scope } = binding;

  // Own user: the self-scope arm. Self-only BY NAME first, then the member
  // self-service gate in the named project — the same `credentials.self` every
  // BYOK key needs, so an owner who removes it removes this write too.
  if (scope.kind === 'user') {
    if (scope.userId !== binding.userId) {
      throw new CodexBindingError(
        'Forbidden: a Codex login can only be stored in your own user scope',
      );
    }
    if (!binding.projectId) {
      throw new CodexBindingError(
        'user-scope Codex OAuth requires the project the authority is evaluated in',
        400,
      );
    }
    if (!(await getProjectById(binding.projectId))) throw new CodexBindingError('Project not found', 400);
    const self = await resolveCodexProjectSession(binding.projectId, binding.userId);
    if (!self) {
      throw new CodexBindingError('Forbidden: not a member of the project this scope is evaluated in');
    }
    if (!hasFeature(self, SELF_CREDENTIAL_FEATURE)) {
      throw new CodexBindingError(
        `Forbidden: ${SELF_CREDENTIAL_FEATURE} required for user-scope Codex OAuth`,
      );
    }
    return;
  }

  const authority = authorityProjectOf(binding);
  if (!authority.ok) throw new CodexBindingError(authority.error, 400);
  const projectId = authority.projectId;
  if (!projectId) {
    throw new CodexBindingError(
      `Codex OAuth at ${scopeLabel(scope)} scope requires the project the authority is evaluated in`,
      400,
    );
  }
  if (!(await getProjectById(projectId))) throw new CodexBindingError('Project not found', 400);

  const session = await resolveCodexProjectSession(projectId, binding.userId);
  if (!session) {
    throw new CodexBindingError('Forbidden: not a member of the project this scope is evaluated in');
  }

  const guard = await assertScopeMatchesSession(session, scope, getScopeMembershipPort());
  if (!guard.ok) throw new CodexBindingError(guard.error);

  // Destination write tier — ADDITIVE to ownership. `global` carries no second
  // feature: `platform.scope` (the kernel arm above) IS the global write gate.
  if (scope.kind === 'project' || scope.kind === 'agent') {
    if (!hasFeature(session, PROJECT_CREDENTIAL_WRITE_FEATURE)) {
      throw new CodexBindingError(
        `Forbidden: ${PROJECT_CREDENTIAL_WRITE_FEATURE} required for ${scopeLabel(scope)} Codex OAuth`,
      );
    }
  }

  // An agent scope must be CONTAINED by the project its authority came from —
  // otherwise `project.credentials.write` in project A would authorize writing
  // an agent secret that only project B resolves.
  if (scope.kind === 'agent') {
    const contained = await getScopeMembershipPort().agentBelongsToProject(projectId, scope.agentId);
    if (!contained) {
      throw new CodexBindingError('Forbidden: target agent is not in the named project');
    }
  }
}

async function writeScopedCodexCredential(
  store: CodexScopedStore,
  binding: CodexCredentialBinding,
  value: string,
): Promise<void> {
  const { scope } = binding;
  switch (scope.kind) {
    case 'global':
      return store.writeGlobal(CODEX_CREDENTIAL_ID, value);
    case 'project':
      return store.write(scope.projectId, CODEX_CREDENTIAL_ID, value);
    case 'user':
      return store.writeUser(scope.userId, CODEX_CREDENTIAL_ID, value);
    case 'agent':
      return store.writeAgent(scope.projectId, scope.agentId, CODEX_CREDENTIAL_ID, value);
  }
}

/**
 * Delete the EXACT selected scope's value — never an effective cascade hit. A
 * caller who asks to disconnect `project/p1` must not silently lose the
 * user-scope login that would have resolved next.
 */
async function deleteScopedCodexCredential(
  store: CodexScopedStore,
  binding: CodexCredentialBinding,
): Promise<boolean> {
  const { scope } = binding;
  switch (scope.kind) {
    case 'global':
      return store.deleteGlobal(CODEX_CREDENTIAL_ID);
    case 'project':
      return store.delete(scope.projectId, CODEX_CREDENTIAL_ID);
    case 'user':
      return store.deleteUser(scope.userId, CODEX_CREDENTIAL_ID);
    case 'agent':
      return store.deleteAgent(scope.projectId, scope.agentId, CODEX_CREDENTIAL_ID);
  }
}

/** Read the EXACT selected scope's stored value (no cascade). */
async function readScopedCodexCredential(
  store: CodexScopedStore,
  binding: CodexCredentialBinding,
): Promise<string | undefined> {
  const { scope } = binding;
  switch (scope.kind) {
    case 'global':
      return store.readGlobal(CODEX_CREDENTIAL_ID);
    case 'project':
      return store.read(scope.projectId, CODEX_CREDENTIAL_ID);
    case 'user':
      return store.readUser(scope.userId, CODEX_CREDENTIAL_ID);
    case 'agent':
      return store.readAgent(scope.projectId, scope.agentId, CODEX_CREDENTIAL_ID);
  }
}

/**
 * Status for the scopes a caller can name: always their own user scope and the
 * global tier, plus the named project and — inside it — the named agent. The
 * precedence mirrors the resolver exactly — a status that ordered them differently would
 * tell an operator the project override is live while the agent one is serving.
 */
async function getCodexCredentialStatus(
  store: CodexScopedStore,
  userId: string,
  projectId?: string,
  agentId?: string,
): Promise<CodexCredentialStatus> {
  const userConnected = Boolean(await store.readUser(userId, CODEX_CREDENTIAL_ID));
  const projectConnected = Boolean(projectId && (await store.read(projectId, CODEX_CREDENTIAL_ID)));
  const agentConnected = Boolean(
    projectId && agentId && (await store.readAgent(projectId, agentId, CODEX_CREDENTIAL_ID)),
  );
  const globalConnected = Boolean(await store.readGlobal(CODEX_CREDENTIAL_ID));
  return {
    userConnected,
    projectConnected,
    agentConnected,
    globalConnected,
    effectiveTarget: agentConnected
      ? 'agent'
      : projectConnected
        ? 'project'
        : userConnected
          ? 'user'
          : globalConnected
            ? 'global'
            : null,
  };
}

/**
 * Which scope the cascade resolves for this call, or `null` when no scope holds
 * a value (already disconnected / purged). Reads in resolver order and stops at
 * the first hit. The agent tier needs the project too — an agent slug is
 * per-project, exactly as the resolver reads it.
 */
export async function resolveCodexCredentialScope(
  store: CodexScopedStore,
  scope?: CodexCallScope,
): Promise<ResolvedCodexScope | null> {
  if (
    scope?.projectId &&
    scope.agentId &&
    (await store.readAgent(scope.projectId, scope.agentId, CODEX_CREDENTIAL_ID))
  ) {
    return { tier: 'agent', projectId: scope.projectId, agentId: scope.agentId };
  }
  if (scope?.projectId && (await store.read(scope.projectId, CODEX_CREDENTIAL_ID))) {
    return { tier: 'project', projectId: scope.projectId };
  }
  if (scope?.userId && (await store.readUser(scope.userId, CODEX_CREDENTIAL_ID))) {
    return { tier: 'user', userId: scope.userId };
  }
  if (await store.readGlobal(CODEX_CREDENTIAL_ID)) {
    return { tier: 'global' };
  }
  return null;
}

/** Write at an already-resolved scope. */
export async function writeCodexCredentialAt(
  store: CodexScopedStore,
  resolved: ResolvedCodexScope,
  value: string,
): Promise<void> {
  switch (resolved.tier) {
    case 'agent':
      return store.writeAgent(resolved.projectId, resolved.agentId, CODEX_CREDENTIAL_ID, value);
    case 'project':
      return store.write(resolved.projectId, CODEX_CREDENTIAL_ID, value);
    case 'user':
      return store.writeUser(resolved.userId, CODEX_CREDENTIAL_ID, value);
    case 'global':
      return store.writeGlobal(CODEX_CREDENTIAL_ID, value);
  }
}

/** Delete at an already-resolved scope. */
export async function deleteCodexCredentialAt(
  store: CodexScopedStore,
  resolved: ResolvedCodexScope,
): Promise<boolean> {
  switch (resolved.tier) {
    case 'agent':
      return store.deleteAgent(resolved.projectId, resolved.agentId, CODEX_CREDENTIAL_ID);
    case 'project':
      return store.delete(resolved.projectId, CODEX_CREDENTIAL_ID);
    case 'user':
      return store.deleteUser(resolved.userId, CODEX_CREDENTIAL_ID);
    case 'global':
      return store.deleteGlobal(CODEX_CREDENTIAL_ID);
  }
}

/**
 * The lock directory for the tier a credential actually RESOLVED at — the one
 * the refresh will read and persist, so every caller resolving the same blob
 * takes the same lock. This is the form the mutex callback uses.
 *
 * Both this and {@link codexLockScope} spell the directory with
 * `CredentialStore`'s OWN scope constants and `agentScope` helper: the lock must be named after the
 * same directory the write lands in, so a new scope shape there is a
 * compile-visible change here, not a silent second spelling.
 */
export function resolvedLockScope(resolved: ResolvedCodexScope): string {
  switch (resolved.tier) {
    case 'agent': return agentScope(resolved.projectId, resolved.agentId);
    case 'project': return resolved.projectId;
    case 'user': return `${USER_SCOPE_PREFIX}${resolved.userId}`;
    case 'global': return GLOBAL_SCOPE;
  }
}

/**
 * The lock directory for a CALL's scope — the fallback used only when nothing
 * resolved, i.e. when there is no credential to protect yet. Never the primary
 * key: a call scope names the caller, and a shared login has many callers.
 */
export function codexLockScope(scope: CodexCallScope | undefined): string {
  if (scope?.projectId && scope.agentId) return agentScope(scope.projectId, scope.agentId);
  if (scope?.projectId) return scope.projectId;
  if (scope?.userId) return `${USER_SCOPE_PREFIX}${scope.userId}`;
  return GLOBAL_SCOPE;
}

/** The audit sink the purge writes its reason-tagged row through. */
export type CodexPurgeAudit = (event: {
  action: string;
  userId: string;
  target?: string;
  details?: Record<string, unknown>;
}) => void;

export type CodexCredentialWriterDeps = {
  /** Read fresh on every call — the host wires the store lazily. */
  getStore: () => CodexScopedStore;
  onAuditEvent: CodexPurgeAudit;
  /** `<appRoot>/credentials/.locks/<scope>/…` — the cross-process lock root. */
  appRoot: string;
  acquireFileMutex: (lockPath: string) => Promise<() => Promise<void>>;
  logger: Logger;
};

/** Build the port. Every member is restricted to {@link CODEX_CREDENTIAL_ID}. */
export function createCodexCredentialWriter(deps: CodexCredentialWriterDeps): CodexCredentialWriterPort {
  const persistLogger = deps.logger.child('codex-persist');
  return {
    authorize: (binding) => assertCodexBindingAccess(binding),
    async write(binding, value) {
      await assertCodexBindingAccess(binding);
      await writeScopedCodexCredential(deps.getStore(), binding, value);
    },
    async delete(binding) {
      await assertCodexBindingAccess(binding);
      return deleteScopedCodexCredential(deps.getStore(), binding);
    },
    async read(binding) {
      await assertCodexBindingAccess(binding);
      return readScopedCodexCredential(deps.getStore(), binding);
    },
    async status({ userId, projectId, agentId }) {
      // An agent's connected-bit is answered ONLY for an agent scope this
      // caller may read (`canReadCodexAgentScope`: the kernel segment guard,
      // then the write gate's ownership predicate) — a refused or malformed id
      // reads `false`, never a 500 and never a different shape.
      const scopedAgentId =
        projectId && agentId && (await canReadCodexAgentScope(userId, projectId, agentId))
          ? agentId
          : undefined;
      const status = await getCodexCredentialStatus(deps.getStore(), userId, projectId, scopedAgentId);
      return scopedAgentId ? { ...status, agentId: scopedAgentId } : status;
    },
    refresh: {
      async persist(scope, value) {
        // A rotation must be written back to the scope the token RESOLVED from.
        // Writing it anywhere else leaves the burned refresh_token in place and
        // re-triggers `refresh_token_reused` on the next stream.
        const store = deps.getStore();
        const resolved = await resolveCodexCredentialScope(store, scope);
        // Disconnect-during-refresh race guard: if the user disconnected while
        // a refresh was in flight, do NOT resurrect the credential. The next
        // request fails cleanly with "OpenAI Codex not connected".
        if (!resolved) {
          persistLogger.warn('skipping persist — credential concurrently deleted', {
            agentId: scope?.agentId,
            projectId: scope?.projectId,
            userId: scope?.userId,
          });
          return false;
        }
        await writeCodexCredentialAt(store, resolved, value);
        return true;
      },
      async purge(scope) {
        // On a permanent refresh failure (`refresh_token_reused` /
        // `refresh_token_expired` / `refresh_token_invalidated`) the dead
        // credential is deleted at the RESOLVED tier so self-heal takes effect.
        // A blind `projectId`-if-present delete is how this broke the first
        // time: with only a user blob it deleted NOTHING and the burned
        // credential looped forever.
        const store = deps.getStore();
        const resolved = await resolveCodexCredentialScope(store, scope);
        const deleted = resolved ? await deleteCodexCredentialAt(store, resolved) : false;
        // The credential-change bus already audits the delete with source:'bus'.
        // Emit a second, reason-tagged row so forensic queries can find purges
        // driven by permanent OAuth failures specifically, plus which scope resolved.
        deps.onAuditEvent({
          action: 'credential.delete',
          userId: '__system__',
          target: CODEX_CREDENTIAL_ID,
          details: {
            source: 'codex-purge',
            reason: 'refresh_permanent_failure',
            agentId: scope?.agentId,
            projectId: scope?.projectId,
            userId: scope?.userId,
            resolvedTarget: resolved?.tier ?? 'none',
            deleted,
          },
        });
      },
      async lock(scope) {
        // The cross-process lock names the CREDENTIAL, never the caller. The
        // call scope is the caller's (`{userId, projectId, agentId}` of whoever
        // is streaming); the credential it will read and persist lives at the
        // tier the cascade RESOLVES. Locking on the call scope split one shared
        // project / user / global login into N locks — two agents of one
        // project serialized on `agent:a1` and `agent:a2`, submitted the same
        // refresh_token in parallel, and the permanent `refresh_token_reused`
        // purged the credential for every member. Resolve first, then lock.
        //
        // Nothing resolved ⇒ there is no credential to protect; fall back to
        // the call scope so the lock is still named rather than global (a
        // concurrent first write lands under its own key, not everyone's).
        const store = deps.getStore();
        const resolved = await resolveCodexCredentialScope(store, scope).catch(() => null);
        const lockScope = resolved ? resolvedLockScope(resolved) : codexLockScope(scope);
        return deps.acquireFileMutex(
          join(deps.appRoot, 'credentials', '.locks', lockScope, `${CODEX_CREDENTIAL_ID}.lock`),
        );
      },
    },
  };
}
