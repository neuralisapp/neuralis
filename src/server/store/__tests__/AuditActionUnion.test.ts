/**
 * SF-AC2-hooks — type-hygiene pin for the AuditAction union.
 *
 * The new builtin tool-activity audit actions (and the drift clean-up of two
 * previously emitted-but-unlisted actions) must be REAL members of the
 * `AuditAction` union, so `writeAuditLog({ action: 'tool.shell.exec', ... })`
 * compiles WITHOUT the host's `as` cast and `admin/audit.ts` filters can key on
 * them. This is a compile-time assertion: if any member is removed from the
 * union the test file fails to typecheck.
 */

import { describe, it, expect } from 'vitest';
import type { AuditAction } from '../AuditStore';

describe('AuditAction union — SF-AC2-hooks additions', () => {
  it('includes the new + drift-cleanup actions as real members (no `as` cast)', () => {
    const actions: AuditAction[] = [
      'tool.shell.exec',
      'tool.failed',
      'shell.denied.uri_policy',
      'conversation.delete',
      // native-nightjar H0 — the relocated terminal audits for the first time.
      'terminal.session',
      'terminal.blocked',
      // Self-scope workflow signing-secret writes at the host port.
      'workflows.signing_secret_write',
      'workflows.signing_secret_delete',
    ];
    expect(actions).toHaveLength(8);
  });
});
