/**
 * Host-owned MEMBER credential self-service writer (Phase M, 2026-07-13 — BYOK).
 *
 * The impl behind the `MemberCredentialWriter` port: a `credentials.self` holder
 * stores / removes / lists THEIR OWN credentials in THEIR OWN `users/<userId>`
 * scope, from the chat config panel's Credentials card. The ONE deliberately-BROAD
 * member writer — it accepts arbitrary custom ids, gated by a DENY-list:
 *
 *   - `isReservedSelfScopeCredentialId` EXCLUSION (host-owned kernel composition
 *     of the dedicated git / channel / MCP / workflow-signing predicates, each
 *     listed explicitly so the set stays auditable) — the reserved structural
 *     self-scope classes are managed by their OWN dedicated cards + routes +
 *     whitelists + audit, so a general member writer must NEVER bypass them
 *     (`credential_id_not_allowed`). Gates BOTH write AND delete (symmetric).
 *   - `isValidCredentialId` charset — the id becomes an `<id>.enc.json` path
 *     segment, so leading-dot / slash / `..` are refused (`invalid_credential_id`).
 *
 * SHAPE ≠ AUTHORITY: every method is `userId`-only. The write / delete ALWAYS
 * lands in `users/<userId>`; there is NO scope-kind arg. The single call site
 * (the `self-credentials/*` route) HARDCODES `req.session.userId`. Kept a
 * SEPARATE dedicated port from the narrow allow-list `SelfScopeCredentialWriter`
 * (RULING 2): mixing a broad deny-list writer and a narrow allow-list writer in
 * one class-dispatched port would need a polarity switch = floor-bug fuel.
 *
 * Values capped at 4096; every mutation audits id-only (NEVER the value) with the
 * dedicated `credential.self_write` / `credential.self_delete` family.
 */

import {
  isReservedSelfScopeCredentialId,
  isValidCredentialId,
  type MemberCredentialWriter,
} from '@neuralis/package-system/contracts';

/** Max stored member self-service credential value length (matches the self-scope ports). */
const MEMBER_CREDENTIAL_VALUE_MAX = 4096;

/** The minimal `users/<id>`-scope slice of the CredentialStore the writer needs. */
export interface MemberCredentialStore {
  writeUser(userId: string, credentialId: string, value: string): Promise<void>;
  deleteUser(userId: string, credentialId: string): Promise<boolean>;
  listUser(userId: string): string[];
}

export interface MemberCredentialWriterDeps {
  store: MemberCredentialStore;
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

function invalidCredentialId(credentialId: string): Error {
  return Object.assign(new Error(`invalid credential id: ${credentialId}`), {
    code: 'invalid_credential_id',
  });
}

/**
 * The host-owned gate shared by write + delete (defense in depth — the route
 * re-checks too): reserved-exclusion FIRST (a reserved id is never a member BYOK
 * concern), then charset. Order is deliberate — a reserved id is rejected with
 * `credential_id_not_allowed` even if it also fails the charset.
 */
function assertMemberCredentialId(credentialId: string): void {
  if (isReservedSelfScopeCredentialId(credentialId)) {
    throw credentialIdNotAllowed(credentialId);
  }
  if (!isValidCredentialId(credentialId)) {
    throw invalidCredentialId(credentialId);
  }
}

/**
 * Build the host's ONE `MemberCredentialWriter`. Every write re-enforces the
 * reserved-exclusion + charset gate (defense in depth), the 4096 cap, writes /
 * deletes `users/<userId>` ONLY, and audits id-only with the member self family.
 */
export function createMemberCredentialWriter(
  deps: MemberCredentialWriterDeps,
): MemberCredentialWriter {
  return {
    async writeUserScoped(userId, credentialId, value): Promise<void> {
      assertMemberCredentialId(credentialId);
      if (typeof value !== 'string' || !value.trim() || value.length > MEMBER_CREDENTIAL_VALUE_MAX) {
        throw Object.assign(new Error('invalid credential value'), { code: 'invalid_value' });
      }
      // Structural self-scope: `users/<userId>` ONLY — no scope-kind arg exists.
      await deps.store.writeUser(userId, credentialId, value.trim());
      deps.onAudit({
        action: 'credential.self_write',
        userId,
        target: credentialId,
        details: { scope: `users/${userId}` },
      });
    },
    async deleteUserScoped(userId, credentialId): Promise<boolean> {
      assertMemberCredentialId(credentialId);
      const deleted = await deps.store.deleteUser(userId, credentialId);
      if (deleted) {
        deps.onAudit({
          action: 'credential.self_delete',
          userId,
          target: credentialId,
          details: { scope: `users/${userId}` },
        });
      }
      return deleted;
    },
    async listUserScoped(userId): Promise<string[]> {
      // Ids only, never values — the member's OWN user scope.
      return deps.store.listUser(userId);
    },
  };
}
