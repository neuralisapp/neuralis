/**
 * Host-owned UNIFIED self-scope credential writer (Phase B, 2026-07-13).
 *
 * The 2→1 collapse of the two line-for-line-identical narrow writer ports
 * (`ScopedCredentialWriter` = channels, `GitCredentialWriterPort` = git) into
 * ONE `SelfScopeCredentialWriter`. `McpTokenStorePort` deliberately stays
 * SEPARATE (M2 — it carries an `McpCredentialScopeRef` scope arg + larger cap +
 * `readScoped`; folding it would reintroduce a scope-kind arg and break
 * SHAPE ≠ AUTHORITY). The two direct-store helpers (admin generic write, codex
 * binding) also do NOT fold — they are owner/admin-gated GENERIC writes.
 *
 * SHAPE ≠ AUTHORITY: `writeUserScoped(scopeClass, userId, id, value)` writes
 * ALWAYS to `users/<userId>`. `scopeClass` selects the per-class PREDICATE +
 * AUDIT TAG ONLY — it is NOT a scope selector, there is NO scope-kind arg, and
 * it NEVER changes the write target away from `users/<userId>`. A member can
 * only write their own user scope BY CONSTRUCTION.
 *
 * The class → { predicate, audit tags } registry below is HOST-OWNED CODE. NO
 * `PackageCredential` / manifest field feeds it (M1 floor — a `_packages/` drop
 * must not register or widen a self-scope predicate). The per-class predicates
 * (`isChannelSelfScopeCredentialId` / `isGitSelfScopeCredentialId` /
 * `isWorkflowSigningSecretCredentialId`) stay in the kernel, host-owned, and are
 * DISJOINT: the writer dispatches to the RIGHT predicate by `scopeClass` —
 * NEVER a merged super-predicate — so a cross-class id is rejected
 * (`writeUserScoped('channel', u, 'git.x.pat', v)` throws;
 * `writeUserScoped('git', u, 'telegram.botToken', v)` throws;
 * `writeUserScoped('workflow', u, 'telegram.botToken', v)` throws).
 */

import {
  isChannelSelfScopeCredentialId,
  isGitSelfScopeCredentialId,
  isWorkflowSigningSecretCredentialId,
  type SelfScopeClass,
  type SelfScopeCredentialWriter,
} from '@neuralis/package-system/contracts';

/** Max stored self-scope credential value length (retained from both old ports). */
const SELF_SCOPE_VALUE_MAX = 4096;

/**
 * The per-class ENFORCEMENT rule: the disjoint kernel predicate the value id
 * must satisfy + the two audit action tags emitted on write / delete. Values
 * are the EXACT audit action strings the two collapsed impls used.
 */
interface SelfScopeClassRule {
  predicate: (id: string) => boolean;
  writeAudit: string;
  deleteAudit: string;
}

/**
 * HOST-OWNED CODE registry — the ONE place a self-scope credential CLASS is
 * defined. Each class binds its OWN disjoint kernel predicate + audit tags.
 * RED LINE (M1): NO manifest / `PackageCredential` field may register or widen
 * an entry here; adding a class is a deliberate host-code change, never data.
 */
const SELF_SCOPE_CLASS_REGISTRY: Record<SelfScopeClass, SelfScopeClassRule> = {
  channel: {
    predicate: isChannelSelfScopeCredentialId,
    writeAudit: 'channels.credential_write',
    deleteAudit: 'channels.credential_delete',
  },
  git: {
    predicate: isGitSelfScopeCredentialId,
    writeAudit: 'git.credential_write',
    deleteAudit: 'git.credential_delete',
  },
  workflow: {
    predicate: isWorkflowSigningSecretCredentialId,
    writeAudit: 'workflows.signing_secret_write',
    deleteAudit: 'workflows.signing_secret_delete',
  },
};

/** The minimal `users/<id>`-scope slice of the CredentialStore the writer needs. */
export interface SelfScopeCredentialStore {
  writeUser(userId: string, credentialId: string, value: string): Promise<void>;
  deleteUser(userId: string, credentialId: string): Promise<boolean>;
}

export interface SelfScopeCredentialWriterDeps {
  store: SelfScopeCredentialStore;
  onAudit: (event: {
    action: string;
    userId: string;
    target?: string;
    details?: Record<string, unknown>;
  }) => void;
}

function credentialIdNotAllowed(credentialId: string): Error {
  return Object.assign(new Error(`credential id not allowed: ${credentialId}`), {
    code: 'credential_id_not_allowed',
  });
}

/**
 * Build the host's ONE `SelfScopeCredentialWriter`. Every op re-enforces the
 * class's disjoint predicate (defense in depth), the 4096 value cap, writes /
 * deletes `users/<userId>` ONLY, and audits id-only with the per-class tag.
 */
export function createSelfScopeCredentialWriter(
  deps: SelfScopeCredentialWriterDeps,
): SelfScopeCredentialWriter {
  return {
    async writeUserScoped(scopeClass, userId, credentialId, value): Promise<void> {
      const rule = SELF_SCOPE_CLASS_REGISTRY[scopeClass];
      // Dispatch to the RIGHT per-class predicate — cross-class ids are rejected.
      if (!rule || !rule.predicate(credentialId)) {
        throw credentialIdNotAllowed(credentialId);
      }
      if (typeof value !== 'string' || !value.trim() || value.length > SELF_SCOPE_VALUE_MAX) {
        throw Object.assign(new Error('invalid credential value'), { code: 'invalid_value' });
      }
      // Structural self-scope: `users/<userId>` ONLY — no scope-kind arg exists.
      await deps.store.writeUser(userId, credentialId, value.trim());
      deps.onAudit({
        action: rule.writeAudit,
        userId,
        target: credentialId,
        details: { scope: `users/${userId}` },
      });
    },
    async deleteUserScoped(scopeClass, userId, credentialId): Promise<boolean> {
      const rule = SELF_SCOPE_CLASS_REGISTRY[scopeClass];
      if (!rule || !rule.predicate(credentialId)) {
        throw credentialIdNotAllowed(credentialId);
      }
      const deleted = await deps.store.deleteUser(userId, credentialId);
      if (deleted) {
        deps.onAudit({
          action: rule.deleteAudit,
          userId,
          target: credentialId,
          details: { scope: `users/${userId}` },
        });
      }
      return deleted;
    },
  };
}
