/**
 * Phase M — host-owned MEMBER credential self-service writer (BYOK).
 *
 * Covers the floor: the reserved-exclusion (git/channel/MCP ids rejected while
 * general BYOK ids pass), the charset gate, user-scope-ONLY writes/deletes, the
 * 4096 value cap, and the id-only audit family.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import {
  createMemberCredentialWriter,
  type MemberCredentialStore,
  type MemberCredentialWriterDeps,
} from '../memberCredentialWriter';

function makeStore() {
  const backing = new Map<string, string>(); // `${userId}::${id}` → value
  const key = (u: string, id: string) => `${u}::${id}`;
  const store: MemberCredentialStore & {
    writeUser: ReturnType<typeof vi.fn>;
    deleteUser: ReturnType<typeof vi.fn>;
    listUser: ReturnType<typeof vi.fn>;
  } = {
    writeUser: vi.fn(async (u: string, id: string, v: string) => {
      backing.set(key(u, id), v);
    }),
    deleteUser: vi.fn(async (u: string, id: string) => backing.delete(key(u, id))),
    listUser: vi.fn((u: string) =>
      [...backing.keys()].filter((k) => k.startsWith(`${u}::`)).map((k) => k.slice(u.length + 2)),
    ),
  };
  return { store, backing };
}

describe('createMemberCredentialWriter', () => {
  let store: ReturnType<typeof makeStore>['store'];
  let onAudit: Mock<MemberCredentialWriterDeps['onAudit']>;
  let writer: ReturnType<typeof createMemberCredentialWriter>;

  beforeEach(() => {
    ({ store } = makeStore());
    onAudit = vi.fn<MemberCredentialWriterDeps['onAudit']>();
    writer = createMemberCredentialWriter({ store, onAudit });
  });

  // (a) EXCLUSION — reserved self-scope ids are rejected; general BYOK ids pass.
  describe('reserved-id exclusion (write + delete symmetric)', () => {
    const reserved = [
      'git.github.com.pat',
      'telegram.botToken',
      'whatsapp.accessToken.conn1', // channel per-connection derived form
      'mcp.srv.accessToken',
      'mcp.srv.env.GITHUB_TOKEN', // sidecar env class
    ];
    // The GitHub OAuth *App* creds are CANONICAL, NON-reserved (Slice 1b owner
    // pivot) ⇒ a member can BYOK them here — the OPPOSITE of the dropped MAJOR-B.
    const allowed = [
      'OPENAI_API_KEY',
      'llm.openai',
      'data.github',
      'github.oauth.clientId',
      'github.oauth.clientSecret',
    ];

    it.each(reserved)('rejects reserved id on write: %s', async (id) => {
      await expect(writer.writeUserScoped('user-a', id, 'v')).rejects.toMatchObject({
        code: 'credential_id_not_allowed',
      });
      expect(store.writeUser).not.toHaveBeenCalled();
    });

    it.each(reserved)('rejects reserved id on delete: %s', async (id) => {
      await expect(writer.deleteUserScoped('user-a', id)).rejects.toMatchObject({
        code: 'credential_id_not_allowed',
      });
      expect(store.deleteUser).not.toHaveBeenCalled();
    });

    it.each(allowed)('accepts a general BYOK id on write: %s', async (id) => {
      await expect(writer.writeUserScoped('user-a', id, 'secret')).resolves.toBeUndefined();
      expect(store.writeUser).toHaveBeenCalledWith('user-a', id, 'secret');
    });

    it.each(allowed)('accepts a general BYOK id on delete: %s', async (id) => {
      await store.writeUser('user-a', id, 'secret');
      await expect(writer.deleteUserScoped('user-a', id)).resolves.toBe(true);
    });
  });

  // (b) CHARSET — path-unsafe ids are rejected (after the reserved check).
  describe('charset gate', () => {
    it.each(['../x', 'a/b', '.x'])('rejects invalid id: %s', async (id) => {
      await expect(writer.writeUserScoped('user-a', id, 'v')).rejects.toMatchObject({
        code: 'invalid_credential_id',
      });
      await expect(writer.deleteUserScoped('user-a', id)).rejects.toMatchObject({
        code: 'invalid_credential_id',
      });
      expect(store.writeUser).not.toHaveBeenCalled();
    });
  });

  // Value validation — empty + over-cap rejected `invalid_value`.
  describe('value validation', () => {
    it('rejects an empty value', async () => {
      await expect(writer.writeUserScoped('user-a', 'llm.openai', '   ')).rejects.toMatchObject({
        code: 'invalid_value',
      });
    });
    it('rejects an over-4096 value', async () => {
      await expect(
        writer.writeUserScoped('user-a', 'llm.openai', 'x'.repeat(4097)),
      ).rejects.toMatchObject({ code: 'invalid_value' });
    });
    it('trims the stored value', async () => {
      await writer.writeUserScoped('user-a', 'llm.openai', '  sk-abc  ');
      expect(store.writeUser).toHaveBeenCalledWith('user-a', 'llm.openai', 'sk-abc');
    });
  });

  // (c) SCOPE — only users/<id> is ever written/deleted (structural).
  describe('user-scope-only (SHAPE != AUTHORITY)', () => {
    it('write goes through store.writeUser ONLY (no project/agent/global path exists)', async () => {
      await writer.writeUserScoped('user-a', 'CUSTOM_KEY', 'v');
      expect(store.writeUser).toHaveBeenCalledTimes(1);
      expect(store.writeUser).toHaveBeenCalledWith('user-a', 'CUSTOM_KEY', 'v');
      // The store slice the writer holds exposes ONLY user-scope methods.
      expect(Object.keys(store).sort()).toEqual(['deleteUser', 'listUser', 'writeUser']);
    });
    it('listUserScoped returns the member OWN stored ids only', async () => {
      await writer.writeUserScoped('user-a', 'A_KEY', 'v1');
      await writer.writeUserScoped('user-a', 'B_KEY', 'v2');
      await writer.writeUserScoped('user-b', 'C_KEY', 'v3');
      expect((await writer.listUserScoped('user-a')).sort()).toEqual(['A_KEY', 'B_KEY']);
      expect(await writer.listUserScoped('user-b')).toEqual(['C_KEY']);
    });
  });

  // Audit — id-only, dedicated family, never the value.
  describe('audit', () => {
    it('audits credential.self_write id-only (never the value)', async () => {
      await writer.writeUserScoped('user-a', 'llm.openai', 'sk-super-secret');
      expect(onAudit).toHaveBeenCalledWith({
        action: 'credential.self_write',
        userId: 'user-a',
        target: 'llm.openai',
        details: { scope: 'users/user-a' },
      });
      expect(JSON.stringify(onAudit.mock.calls)).not.toContain('sk-super-secret');
    });
    it('audits credential.self_delete only when a value existed', async () => {
      await writer.writeUserScoped('user-a', 'llm.openai', 'v');
      onAudit.mockClear();
      expect(await writer.deleteUserScoped('user-a', 'llm.openai')).toBe(true);
      expect(onAudit).toHaveBeenCalledWith({
        action: 'credential.self_delete',
        userId: 'user-a',
        target: 'llm.openai',
        details: { scope: 'users/user-a' },
      });
      onAudit.mockClear();
      expect(await writer.deleteUserScoped('user-a', 'llm.openai')).toBe(false);
      expect(onAudit).not.toHaveBeenCalled();
    });
  });
});
