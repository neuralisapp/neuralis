/**
 * Audit log — append-only JSONL store for security-relevant events.
 * Stored in the platform zone (~/.neuralis/app/logs/audit.jsonl).
 *
 * Nothing here ever deletes an audit record. The file is oldest-first; past
 * `auditLogMaxBytes` it is rotated by RENAME only (`audit.jsonl.1` is the
 * newest generation, every older one moves up an index and stays), and the
 * admin readers span the generations newest-first.
 */

import { JsonlAppender } from './JsonlAppender';
import { getEnv } from '../config/env';
import { getPlatformConfigStore } from './PlatformConfigStore';
import { join } from 'path';
import { containedOrThrow, type ContainedPath } from '@neuralis/package-system/paths';

export type AuditAction =
  | 'login.success'
  | 'login.failed'
  | 'login.rate_limited'
  | 'user.create'
  | 'user.invite'
  | 'user.disable'
  | 'user.enable'
  | 'user.delete'
  | 'user.password_reset'
  | 'user.password_change'
  | 'user.rename'
  | 'project.create'
  | 'project.create_failed'
  | 'project.update'
  | 'project.limits_update'
  // happy-wondering-yeti — owner-gated two-stage project delete + restore.
  | 'project.archive'
  | 'project.restore'
  | 'project.delete'
  | 'agent.create'
  | 'agent.update'
  | 'agent.delete'
  // Agent-governance port (assignAgentToUser): agentOwnership.assignedTo writes
  // made through the admin package's `agents-assign` route.
  | 'agent.assign'
  | 'agent.unassign'
  | 'package.install'
  | 'package.uninstall'
  | 'package.build'
  | 'package.publish'
  | 'package.trust.change'
  | 'package.access_feature.change'
  | 'connector.create'
  | 'connector.update'
  | 'connector.delete'
  | 'shell.blocked'
  | 'credential.read'
  | 'credential.write'
  | 'credential.delete'
  | 'credential.use_denied'
  | 'credential.use_rule_update'
  // CRED-TAIL INC 3 — the operator's Codex CLI login (`~/.codex/auth.json`) is
  // lifted off the HOST MACHINE into a caller's credential scope. Distinct from
  // `credential.write` on purpose: the value did not come from the caller, it
  // came from the server's filesystem, so it needs its own audit line.
  | 'credential.import'
  | 'config.write'
  // W4G — per-stream session-ticket lifecycle.
  | 'session_ticket_authority.ready'
  | 'skill.session_ticket_minted'
  | 'skill.session_call'
  | 'skill.session_ticket_rejected'
  // modular-meerkat Inc 4 — self-scope channel credential writes (F7).
  | 'channels.credential_write'
  | 'channels.credential_delete'
  // MCP1 Inc2/Inc5 + MCP1-S — self-scope MCP credential writes + server/sidecar
  // management (NIT-1 drift fold: all emitted-but-unlisted, previously rode the
  // host `as AuditAction` cast at bootstrap.ts / the agent-core mcp routes).
  | 'mcp.credential_write'
  | 'mcp.credential_delete'
  | 'mcp.oauth_credentials_set'
  | 'mcp.oauth_flow_started'
  | 'mcp.server_add'
  | 'mcp.server_remove'
  | 'mcp.sidecar_activate'
  // MCP5B outbound HEADER secrets — emitted since that increment, listed only
  // now (CRED-TAIL INC 8) — and the DECL-5 sidecar-ENV twin. Deliberately four
  // distinct actions, not one `mcp.secret_*` pair: the two classes have
  // different destinations (a local child's environment vs a request to a
  // caller-configured external URL), so they stay separately auditable.
  | 'mcp.header_credential_set'
  | 'mcp.header_credential_delete'
  | 'mcp.env_credential_set'
  | 'mcp.env_credential_delete'
  // G4 keyring-kestrel — git self-scope credential writes.
  | 'git.credential_write'
  | 'git.credential_delete'
  // Self-scope workflow signing-secret writes (the third SelfScopeClass).
  | 'workflows.signing_secret_write'
  | 'workflows.signing_secret_delete'
  // Slice 1b keyring-kestrel — git-remote OAuth connect flow initiation.
  | 'git.oauth_flow_started'
  // SF-AC2-hooks — builtin tool-activity audit (2026-06-18)
  | 'tool.shell.exec'      // every successful execute action=shell call
  | 'tool.failed'          // every failed (thrown) tool call (ALL tools)
  // pre-existing emitted-but-unlisted (drift clean-up, rode the host `as` cast)
  | 'shell.denied.uri_policy'
  | 'conversation.delete'
  // native-nightjar H0 — the terminal PTY moved into agent-core and audits for
  // the FIRST time (its former package-local AuditLogger was dead code, zero
  // call sites). Both land in the tamper-proof app zone via `onAuditEvent`,
  // never under `data://` where the audited agent could delete them (SF-AC2).
  | 'terminal.session'     // PTY attach / detach over the WebSocket companion
  | 'terminal.blocked'     // InputGuard blocklist rejection on a typed command
  // stalled-stint — stopping a turn from OUTSIDE the browser that is driving it.
  // The denial is audited too, unlike the delegate precedent below it: the
  // admin-strength arm is the escalation-shaped one, so the trail has to answer
  // "whose work did they stop" and "who was refused", not just "who succeeded".
  | 'conversation.stream.stop'
  | 'conversation.stream.stop_denied'
  // Emitted since the background-delegate control plane; listed only now (same
  // drift class as the MCP block above — it rode the host `as AuditAction` cast).
  | 'delegate.stop'
  | 'delegate.follow_up';

export type AuditEntry = {
  timestamp: string;
  userId: string | null;
  userEmail?: string;
  action: AuditAction;
  target?: string;
  details?: Record<string, unknown>;
  ip?: string;
};

/**
 * The appender is anchored on `globalThis` because "module-level singleton" is
 * a per-BUNDLE claim, not a per-process one: Next compiles this module into
 * every route bundle that imports it, and each copy would get its own write
 * queue — so a rotation in one copy could rename the file under another copy's
 * write (a read-modify-write writer lost half the rows this way, measured 20/40
 * in the two-copy test). The PlatformConfigStore precedent; `Symbol.for` so
 * every copy resolves the SAME slot. The file was written newest-first before
 * it became append-only, hence `legacyNewestFirst`.
 */
const APPENDER_SLOT = Symbol.for('@neuralis/host:auditAppender');

function appender(): JsonlAppender<AuditEntry> {
  const g = globalThis as { [APPENDER_SLOT]?: JsonlAppender<AuditEntry> };
  return (g[APPENDER_SLOT] ??= new JsonlAppender<AuditEntry>({ legacyNewestFirst: true }));
}

/**
 * The rotation threshold (`auditLogMaxBytes`, a host key), read per write so an
 * admin edit applies live. A read that cannot answer skips THIS rotation check
 * (0 = no rotation) — the file only grows until the next write, and the row is
 * never at stake.
 */
function auditMaxBytes(): number {
  try {
    const value = getPlatformConfigStore().get('auditLogMaxBytes');
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * The platform-global audit log, resolved PER CALL.
 *
 * Per call, not at module scope: `getEnv()` is not wired when this module is
 * first evaluated. Resolving the root in a constructor is the same class of bug
 * `PackageLogger` documents for its tunables.
 */
function auditPath(): ContainedPath {
  return containedOrThrow(join(getEnv().appRoot, 'logs'), 'audit.jsonl', 'audit log path');
}

export async function writeAuditLog(entry: Omit<AuditEntry, 'timestamp'>): Promise<void> {
  try {
    const path = auditPath();
    // Rotation renames only (no `keep`): a failed rotation never costs the row.
    await appender().rotate(path, { maxBytes: auditMaxBytes() }).catch(() => false);
    await appender().append(path, {
      timestamp: new Date().toISOString(),
      ...entry,
    });
  } catch (err) {
    // Audit logging must never break the main flow
    console.error('[audit] Failed to write audit log:', err);
  }
}
