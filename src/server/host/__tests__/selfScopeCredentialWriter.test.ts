/**
 * The UNIFIED self-scope credential writer (Phase B's 2→1 collapse of the
 * channel + git writer ports, now carrying a third class: the workflow webhook
 * signing secret). The floor this test pins:
 *
 *   - CROSS-CLASS REJECTION: the writer dispatches to the RIGHT per-class DISJOINT
 *     predicate by `scopeClass`, never a merged super-predicate — so every id
 *     presented under a class that is not its own throws
 *     `credential_id_not_allowed`, in BOTH directions for every pair of classes.
 *   - EACH CLASS ACCEPTS ONLY ITS OWN IDS.
 *   - SHAPE ≠ AUTHORITY: every write/delete lands in `users/<id>` ONLY — there is
 *     no scope-kind arg — and every mutation audits ID-ONLY (never the value) with
 *     the per-class audit tag.
 *   - DELETE is symmetric with WRITE (same predicate gate, same class dispatch).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createSelfScopeCredentialWriter,
  type SelfScopeCredentialStore,
} from '../selfScopeCredentialWriter';

const SECRET = 'super-secret-value';
const WORKFLOW_SIGNING_ID = 'workflow.1f0b6a3c-0000-4000-8000-000000000001.signingSecret';

interface Written {
  userId: string;
  credentialId: string;
  value: string;
}

function makeHarness() {
  const written: Written[] = [];
  const deleted: Array<{ userId: string; credentialId: string }> = [];
  const store: SelfScopeCredentialStore = {
    async writeUser(userId, credentialId, value) {
      written.push({ userId, credentialId, value });
    },
    async deleteUser(userId, credentialId) {
      deleted.push({ userId, credentialId });
      return true;
    },
  };
  const onAudit = vi.fn();
  const writer = createSelfScopeCredentialWriter({ store, onAudit });
  return { writer, store, onAudit, written, deleted };
}

async function expectRejected(op: Promise<unknown>): Promise<void> {
  await expect(op).rejects.toMatchObject({ code: 'credential_id_not_allowed' });
}

describe('createSelfScopeCredentialWriter — cross-class rejection (Phase B floor)', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it("rejects every id under a FOREIGN class (no merged super-predicate)", async () => {
    await expectRejected(h.writer.writeUserScoped('channel', 'u1', 'git.github.com.pat', SECRET));
    await expectRejected(h.writer.writeUserScoped('git', 'u1', 'telegram.botToken', SECRET));
    // The third class is symmetric in BOTH directions: its own id is refused by
    // the other two, and the other two's ids are refused by it.
    await expectRejected(h.writer.writeUserScoped('channel', 'u1', WORKFLOW_SIGNING_ID, SECRET));
    await expectRejected(h.writer.writeUserScoped('git', 'u1', WORKFLOW_SIGNING_ID, SECRET));
    await expectRejected(h.writer.writeUserScoped('workflow', 'u1', 'telegram.botToken', SECRET));
    await expectRejected(h.writer.writeUserScoped('workflow', 'u1', 'git.github.com.pat', SECRET));
    // Nothing was written and nothing was audited for the rejected cross-class ops.
    expect(h.written).toHaveLength(0);
    expect(h.onAudit).not.toHaveBeenCalled();
  });

  it('delete mirrors the same cross-class rejection', async () => {
    await expectRejected(h.writer.deleteUserScoped('channel', 'u1', 'git.github.com.pat'));
    await expectRejected(h.writer.deleteUserScoped('git', 'u1', 'telegram.botToken'));
    await expectRejected(h.writer.deleteUserScoped('channel', 'u1', WORKFLOW_SIGNING_ID));
    await expectRejected(h.writer.deleteUserScoped('workflow', 'u1', 'telegram.botToken'));
    expect(h.deleted).toHaveLength(0);
    expect(h.onAudit).not.toHaveBeenCalled();
  });

  it("also rejects mcp / generic / arbitrary ids under EVERY class (each class accepts only its own)", async () => {
    for (const cls of ['channel', 'git', 'workflow'] as const) {
      await expectRejected(h.writer.writeUserScoped(cls, 'u1', 'mcp.srv.accessToken', SECRET));
      await expectRejected(h.writer.writeUserScoped(cls, 'u1', 'OPENAI_API_KEY', SECRET));
      await expectRejected(h.writer.writeUserScoped(cls, 'u1', 'data.github', SECRET));
      // A dotted workflow id is not a well-formed id of the workflow class, so
      // it is refused there too — the charset is what keeps the family from
      // aliasing, and this row is what keeps the charset.
      await expectRejected(h.writer.writeUserScoped(cls, 'u1', 'workflow.a.b.signingSecret', SECRET));
    }
    expect(h.written).toHaveLength(0);
  });
});

describe('createSelfScopeCredentialWriter — each class accepts only its own ids, users/<id> only, id-only audit', () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it("class 'channel' accepts a whitelisted channel id + its per-connection derivative, writes users/<id>, audits channels.credential_write id-only", async () => {
    await h.writer.writeUserScoped('channel', 'member-1', 'telegram.botToken', SECRET);
    await h.writer.writeUserScoped('channel', 'member-1', 'telegram.botToken.conn-abc', SECRET);

    expect(h.written).toEqual([
      { userId: 'member-1', credentialId: 'telegram.botToken', value: SECRET },
      { userId: 'member-1', credentialId: 'telegram.botToken.conn-abc', value: SECRET },
    ]);
    // Audit is id-only + scope users/<id>, NEVER the value.
    expect(h.onAudit).toHaveBeenCalledWith({
      action: 'channels.credential_write',
      userId: 'member-1',
      target: 'telegram.botToken',
      details: { scope: 'users/member-1' },
    });
    for (const call of h.onAudit.mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain(SECRET);
    }
  });

  it("class 'git' accepts a git.<host>.pat id, writes users/<id>, audits git.credential_write id-only", async () => {
    await h.writer.writeUserScoped('git', 'user-a', 'git.github.com.pat', SECRET);
    expect(h.written).toEqual([
      { userId: 'user-a', credentialId: 'git.github.com.pat', value: SECRET },
    ]);
    expect(h.onAudit).toHaveBeenCalledWith({
      action: 'git.credential_write',
      userId: 'user-a',
      target: 'git.github.com.pat',
      details: { scope: 'users/user-a' },
    });
    expect(JSON.stringify(h.onAudit.mock.calls[0][0])).not.toContain(SECRET);
  });

  it("class 'workflow' accepts a signing-secret id, writes users/<id>, audits workflows.signing_secret_write id-only", async () => {
    await h.writer.writeUserScoped('workflow', 'author-1', WORKFLOW_SIGNING_ID, SECRET);
    expect(h.written).toEqual([
      { userId: 'author-1', credentialId: WORKFLOW_SIGNING_ID, value: SECRET },
    ]);
    expect(h.onAudit).toHaveBeenCalledWith({
      action: 'workflows.signing_secret_write',
      userId: 'author-1',
      target: WORKFLOW_SIGNING_ID,
      details: { scope: 'users/author-1' },
    });
    expect(JSON.stringify(h.onAudit.mock.calls[0][0])).not.toContain(SECRET);
  });

  it('delete accepts each class own id, hits deleteUser(users/<id>), audits the per-class delete tag', async () => {
    const okCh = await h.writer.deleteUserScoped('channel', 'member-1', 'telegram.botToken');
    const okGit = await h.writer.deleteUserScoped('git', 'user-a', 'git.github.com.pat');
    const okWf = await h.writer.deleteUserScoped('workflow', 'author-1', WORKFLOW_SIGNING_ID);
    expect(okCh).toBe(true);
    expect(okGit).toBe(true);
    expect(okWf).toBe(true);
    expect(h.deleted).toEqual([
      { userId: 'member-1', credentialId: 'telegram.botToken' },
      { userId: 'user-a', credentialId: 'git.github.com.pat' },
      { userId: 'author-1', credentialId: WORKFLOW_SIGNING_ID },
    ]);
    expect(h.onAudit).toHaveBeenNthCalledWith(1, {
      action: 'channels.credential_delete',
      userId: 'member-1',
      target: 'telegram.botToken',
      details: { scope: 'users/member-1' },
    });
    expect(h.onAudit).toHaveBeenNthCalledWith(2, {
      action: 'git.credential_delete',
      userId: 'user-a',
      target: 'git.github.com.pat',
      details: { scope: 'users/user-a' },
    });
    expect(h.onAudit).toHaveBeenNthCalledWith(3, {
      action: 'workflows.signing_secret_delete',
      userId: 'author-1',
      target: WORKFLOW_SIGNING_ID,
      details: { scope: 'users/author-1' },
    });
  });

  it('rejects an empty / oversized value with invalid_value (both classes)', async () => {
    await expect(
      h.writer.writeUserScoped('channel', 'u', 'telegram.botToken', '   '),
    ).rejects.toMatchObject({ code: 'invalid_value' });
    await expect(
      h.writer.writeUserScoped('git', 'u', 'git.github.com.pat', 'x'.repeat(4097)),
    ).rejects.toMatchObject({ code: 'invalid_value' });
    await expect(
      h.writer.writeUserScoped('workflow', 'u', WORKFLOW_SIGNING_ID, 'x'.repeat(4097)),
    ).rejects.toMatchObject({ code: 'invalid_value' });
    expect(h.written).toHaveLength(0);
  });
});
