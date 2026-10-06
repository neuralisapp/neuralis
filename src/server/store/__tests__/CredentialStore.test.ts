import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  CredentialEnvelopeError,
  CredentialMasterKeyMissingError,
  CredentialStore,
  deriveKey,
  encrypt,
  decrypt,
  userScope,
} from '../CredentialStore';
import { RecordNewerError } from '@neuralis/package-system/data';

describe('CredentialStore', () => {
  let tempDir: string;
  const TEST_MASTER_KEY = Buffer.from('test-secret-for-credential-store-testing');
  const TEST_SALT = Buffer.from('test-install-salt', 'utf-8');

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'neuralis-cred-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('deriveKey', () => {
    it('produces deterministic output for same inputs', async () => {
      const key1 = await deriveKey(TEST_MASTER_KEY, TEST_SALT, 'project-a');
      const key2 = await deriveKey(TEST_MASTER_KEY, TEST_SALT, 'project-a');
      expect(key1.equals(key2)).toBe(true);
    });

    it('produces different keys for different scopes', async () => {
      const keyA = await deriveKey(TEST_MASTER_KEY, TEST_SALT, 'project-a');
      const keyB = await deriveKey(TEST_MASTER_KEY, TEST_SALT, 'project-b');
      expect(keyA.equals(keyB)).toBe(false);
    });

    it('produces 32-byte (256-bit) keys', async () => {
      const key = await deriveKey(TEST_MASTER_KEY, TEST_SALT, 'test');
      expect(key.length).toBe(32);
    });

    it('produces different keys for different salts', async () => {
      const salt2 = Buffer.from('different-salt-value', 'utf-8');
      const keyA = await deriveKey(TEST_MASTER_KEY, TEST_SALT, 'test');
      const keyB = await deriveKey(TEST_MASTER_KEY, salt2, 'test');
      expect(keyA.equals(keyB)).toBe(false);
    });
  });

  describe('encrypt / decrypt', () => {
    it('round-trips correctly', async () => {
      const key = await deriveKey(TEST_MASTER_KEY, TEST_SALT, 'test');
      const plaintext = 'sk-ant-api03-supersecret-key';
      const payload = encrypt(plaintext, key);
      const result = decrypt(payload, key);
      expect(result).toBe(plaintext);
    });

    it('produces version 1 payload', async () => {
      const key = await deriveKey(TEST_MASTER_KEY, TEST_SALT, 'test');
      const payload = encrypt('test', key);
      expect(payload.version).toBe(1);
      expect(typeof payload.iv).toBe('string');
      expect(typeof payload.ciphertext).toBe('string');
      expect(typeof payload.authTag).toBe('string');
    });

    it('throws on wrong key', async () => {
      const key1 = await deriveKey(TEST_MASTER_KEY, TEST_SALT, 'project-a');
      const key2 = await deriveKey(TEST_MASTER_KEY, TEST_SALT, 'project-b');
      const payload = encrypt('secret', key1);
      expect(() => decrypt(payload, key2)).toThrow();
    });

    it('throws on tampered ciphertext', async () => {
      const key = await deriveKey(TEST_MASTER_KEY, TEST_SALT, 'test');
      const payload = encrypt('secret', key);
      // Flip a byte in the middle of the ciphertext to ensure it's actually different
      const chars = payload.ciphertext.split('');
      const mid = Math.floor(chars.length / 2);
      chars[mid] = chars[mid] === '0' ? '1' : '0';
      const tampered = { ...payload, ciphertext: chars.join('') };
      expect(() => decrypt(tampered, key)).toThrow();
    });

    it('throws on tampered authTag', async () => {
      const key = await deriveKey(TEST_MASTER_KEY, TEST_SALT, 'test');
      const payload = encrypt('secret', key);
      const tampered = { ...payload, authTag: '0'.repeat(payload.authTag.length) };
      expect(() => decrypt(tampered, key)).toThrow();
    });
  });

  describe('CredentialStore class', () => {
    let store: CredentialStore;
    let configDir: string;

    beforeEach(() => {
      // Create config dir with master key + salt files for deterministic tests
      configDir = join(tempDir, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'credential-master.key'), randomBytes(32), { mode: 0o400 });
      writeFileSync(join(configDir, 'credential-salt.bin'), randomBytes(16), { mode: 0o400 });
      store = new CredentialStore(tempDir, configDir);
    });

    it('write + read round-trips', async () => {
      await store.write('proj-1', 'anthropic-key', 'sk-test-12345');
      const result = await store.read('proj-1', 'anthropic-key');
      expect(result).toBe('sk-test-12345');
    });

    it('file on disk is encrypted (not plaintext)', async () => {
      await store.write('proj-1', 'my-cred', 'plaintext-secret');
      const path = join(tempDir, 'credentials', 'projects', 'proj-1', 'my-cred.enc.json');
      expect(existsSync(path)).toBe(true);
      const raw = readFileSync(path, 'utf-8');
      expect(raw).not.toContain('plaintext-secret');
      const parsed = JSON.parse(raw);
      expect(parsed.version).toBe(1);
      expect(parsed.iv).toBeDefined();
      expect(parsed.ciphertext).toBeDefined();
      expect(parsed.authTag).toBeDefined();
    });

    it('read returns undefined for missing credential', async () => {
      const result = await store.read('proj-1', 'nonexistent');
      expect(result).toBeUndefined();
    });

    it('delete removes credential', async () => {
      await store.write('proj-1', 'to-delete', 'value');
      const deleted = await store.delete('proj-1', 'to-delete');
      expect(deleted).toBe(true);
      const result = await store.read('proj-1', 'to-delete');
      expect(result).toBeUndefined();
    });

    it('delete returns false for missing credential', async () => {
      const deleted = await store.delete('proj-1', 'nonexistent');
      expect(deleted).toBe(false);
    });

    it('list returns credential IDs', async () => {
      await store.write('proj-1', 'key-a', 'val-a');
      await store.write('proj-1', 'key-b', 'val-b');
      const ids = store.list('proj-1');
      expect(ids.sort()).toEqual(['key-a', 'key-b']);
    });

    it('list returns empty for unknown project', () => {
      const ids = store.list('unknown-project');
      expect(ids).toEqual([]);
    });

    it('credentials are project-isolated', async () => {
      await store.write('proj-a', 'shared-key', 'value-a');
      await store.write('proj-b', 'shared-key', 'value-b');
      expect(await store.read('proj-a', 'shared-key')).toBe('value-a');
      expect(await store.read('proj-b', 'shared-key')).toBe('value-b');
    });

    it('writeGlobal/readGlobal round-trips (global scope)', async () => {
      await store.writeGlobal('llm.anthropic', 'sk-global-key');
      const result = await store.readGlobal('llm.anthropic');
      expect(result).toBe('sk-global-key');
    });

    it('writeUser/readUser round-trips (user scope)', async () => {
      await store.writeUser('user-1', 'llm.openai-codex.oauth', '{"access":"a","refresh":"r"}');
      const result = await store.readUser('user-1', 'llm.openai-codex.oauth');
      expect(result).toBe('{"access":"a","refresh":"r"}');
    });

    it('user-scoped credentials are isolated from projects and global scope', async () => {
      await store.writeUser('user-1', 'shared-key', 'user-value');
      await store.write('proj-1', 'shared-key', 'project-value');
      await store.writeGlobal('shared-key', 'global-value');
      expect(await store.readUser('user-1', 'shared-key')).toBe('user-value');
      expect(await store.read('proj-1', 'shared-key')).toBe('project-value');
      expect(await store.readGlobal('shared-key')).toBe('global-value');
    });

    it('listUser returns user-scoped credential ids', async () => {
      await store.writeUser('user-2', 'cred-a', 'a');
      await store.writeUser('user-2', 'cred-b', 'b');
      expect(store.listUser('user-2').sort()).toEqual(['cred-a', 'cred-b']);
    });

    it('writeAgent/readAgent round-trips and is isolated from other scopes', async () => {
      await store.writeAgent('proj-1', 'agent-1', 'GITHUB_TOKEN', 'agent-secret');
      await store.write('proj-1', 'GITHUB_TOKEN', 'project-secret');
      await store.writeGlobal('GITHUB_TOKEN', 'global-secret');
      expect(await store.readAgent('proj-1', 'agent-1', 'GITHUB_TOKEN')).toBe('agent-secret');
      expect(await store.read('proj-1', 'GITHUB_TOKEN')).toBe('project-secret');
      expect(await store.readGlobal('GITHUB_TOKEN')).toBe('global-secret');
      // A different agent has no value.
      expect(await store.readAgent('proj-1', 'agent-2', 'GITHUB_TOKEN')).toBeUndefined();
    });

    it('listAgent / deleteAgent operate on agent scope', async () => {
      await store.writeAgent('proj-1', 'agent-3', 'cred-a', 'a');
      await store.writeAgent('proj-1', 'agent-3', 'cred-b', 'b');
      expect(store.listAgent('proj-1', 'agent-3').sort()).toEqual(['cred-a', 'cred-b']);
      expect(await store.deleteAgent('proj-1', 'agent-3', 'cred-a')).toBe(true);
      expect(store.listAgent('proj-1', 'agent-3')).toEqual(['cred-b']);
    });

    it('listGlobal returns global credential IDs', async () => {
      await store.writeGlobal('llm.openai', 'val-1');
      await store.writeGlobal('llm.gemini', 'val-2');
      const ids = store.listGlobal();
      expect(ids.sort()).toEqual(['llm.gemini', 'llm.openai']);
    });

    it('deleteGlobal removes global credential', async () => {
      await store.writeGlobal('llm.xai', 'to-delete');
      expect(await store.deleteGlobal('llm.xai')).toBe(true);
      expect(await store.readGlobal('llm.xai')).toBeUndefined();
    });

    it('decryptPayload decrypts raw payload for a scope', async () => {
      await store.write('proj-1', 'test-cred', 'raw-secret');
      // Read the encrypted file directly
      const encPath = join(tempDir, 'credentials', 'projects', 'proj-1', 'test-cred.enc.json');
      const rawPayload = JSON.parse(readFileSync(encPath, 'utf-8'));
      const result = await store.decryptPayload('proj-1', rawPayload);
      expect(result).toBe('raw-secret');
    });

    it('decryptPayload works for user scopes', async () => {
      await store.writeUser('user-3', 'test-cred', 'user-secret');
      const encPath = join(tempDir, 'credentials', 'users', 'user-3', 'test-cred.enc.json');
      const rawPayload = JSON.parse(readFileSync(encPath, 'utf-8'));
      const result = await store.decryptPayload(userScope('user-3'), rawPayload);
      expect(result).toBe('user-secret');
    });

    it('legacy fallback works when no key files exist', async () => {
      const legacyDir = mkdtempSync(join(tmpdir(), 'neuralis-legacy-test-'));
      const legacyStore = new CredentialStore(
        legacyDir,
        join(legacyDir, 'config'), // config dir doesn't exist, no key files
        () => 'legacy-nextauth-secret',
      );
      await legacyStore.write('proj-1', 'cred', 'legacy-value');
      expect(await legacyStore.read('proj-1', 'cred')).toBe('legacy-value');
      rmSync(legacyDir, { recursive: true, force: true });
    });
  });

  describe('change bus', () => {
    let store: CredentialStore;
    let configDir: string;

    beforeEach(() => {
      configDir = join(tempDir, 'config');
      mkdirSync(configDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(configDir, 'credential-master.key'), randomBytes(32), { mode: 0o400 });
      writeFileSync(join(configDir, 'credential-salt.bin'), randomBytes(16), { mode: 0o400 });
      store = new CredentialStore(tempDir, configDir);
    });

    it('write emits a credential:write event with the right scope and id', async () => {
      const events: Array<{ kind: string; scope: string; credentialId: string }> = [];
      store.subscribe(e => events.push({ kind: e.kind, scope: e.scope, credentialId: e.credentialId }));
      await store.write('proj-1', 'cred-x', 'value');
      expect(events).toEqual([{ kind: 'write', scope: 'proj-1', credentialId: 'cred-x' }]);
    });

    it('delete emits a credential:delete event after a successful unlink', async () => {
      const events: Array<{ kind: string; scope: string; credentialId: string }> = [];
      await store.write('proj-1', 'cred-x', 'value');
      store.subscribe(e => events.push({ kind: e.kind, scope: e.scope, credentialId: e.credentialId }));
      const deleted = await store.delete('proj-1', 'cred-x');
      expect(deleted).toBe(true);
      expect(events).toEqual([{ kind: 'delete', scope: 'proj-1', credentialId: 'cred-x' }]);
    });

    it('delete on a missing credential does NOT emit', async () => {
      const events: Array<unknown> = [];
      store.subscribe(e => events.push(e));
      const deleted = await store.delete('proj-1', 'nonexistent');
      expect(deleted).toBe(false);
      expect(events).toEqual([]);
    });

    it('writeUser encodes the user scope prefix', async () => {
      const events: Array<{ scope: string }> = [];
      store.subscribe(e => events.push({ scope: e.scope }));
      await store.writeUser('user-1', 'cred', 'v');
      expect(events[0].scope).toBe('user:user-1');
    });

    it('writeGlobal emits with _global scope', async () => {
      const events: Array<{ scope: string }> = [];
      store.subscribe(e => events.push({ scope: e.scope }));
      await store.writeGlobal('cred', 'v');
      expect(events[0].scope).toBe('_global');
    });

    it('subscribe returns a disposer that stops further events', async () => {
      const events: unknown[] = [];
      const dispose = store.subscribe(e => events.push(e));
      await store.write('proj-1', 'a', 'v');
      dispose();
      await store.write('proj-1', 'b', 'v');
      expect(events).toHaveLength(1);
    });

    it('a listener that throws does not block other listeners', async () => {
      const seen: string[] = [];
      store.subscribe(() => {
        throw new Error('boom');
      });
      store.subscribe(e => seen.push(e.credentialId));
      await store.write('proj-1', 'cred-x', 'v');
      expect(seen).toEqual(['cred-x']);
    });
  });

  // -------------------------------------------------------------------------
  // The project-qualified agent scope, the scope-segment floor and the one-time
  // move of the legacy bare-slug layout.
  // -------------------------------------------------------------------------
  describe('project-qualified agent scope', () => {
    let store: CredentialStore;
    let configDir: string;
    const agentsRoot = () => join(tempDir, 'credentials', 'agents');

    beforeEach(() => {
      configDir = join(tempDir, 'config');
      mkdirSync(configDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(configDir, 'credential-master.key'), randomBytes(32), { mode: 0o400 });
      writeFileSync(join(configDir, 'credential-salt.bin'), randomBytes(16), { mode: 0o400 });
      store = new CredentialStore(tempDir, configDir);
    });

    /** A blob exactly as the pre-qualification store wrote it: `agents/<slug>/`, keyed on `agent:<slug>`. */
    async function writeLegacy(slug: string, credentialId: string, plaintext: string): Promise<string> {
      const key = await deriveKey(
        readFileSync(join(configDir, 'credential-master.key')),
        readFileSync(join(configDir, 'credential-salt.bin')),
        `agent:${slug}`,
      );
      const dir = join(agentsRoot(), slug);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${credentialId}.enc.json`);
      writeFileSync(path, JSON.stringify(encrypt(plaintext, key)), 'utf-8');
      return path;
    }

    const port = (owners: Record<string, string[]>) => ({
      listProjectIds: async () => ['p1', 'p2'],
      agentBelongsToProject: async (projectId: string, agentId: string) => (owners[agentId] ?? []).includes(projectId),
    });

    it('two tenants\' same-slug agents are two directories, and neither resolves the other', async () => {
      await store.writeAgent('p1', 'coder', 'llm.openai-codex.oauth', 'p1-login');
      expect(existsSync(join(agentsRoot(), 'p1', 'coder', 'llm.openai-codex.oauth.enc.json'))).toBe(true);
      expect(existsSync(join(agentsRoot(), 'coder'))).toBe(false);
      expect(await store.readAgent('p2', 'coder', 'llm.openai-codex.oauth')).toBeUndefined();
      expect(await store.readAgent('p1', 'coder', 'llm.openai-codex.oauth')).toBe('p1-login');
    });

    it('a bare agent:<slug> scope is not a location — refused BY NAME on every verb', async () => {
      await expect(store.write('agent:coder', 'x', 'v')).rejects.toThrow(/Bare agent credential scope/);
      await expect(store.read('agent:coder', 'x')).rejects.toThrow(/Bare agent credential scope/);
      await expect(store.delete('agent:coder', 'x')).rejects.toThrow(/Bare agent credential scope/);
      expect(() => store.list('agent:coder')).toThrow(/Bare agent credential scope/);
    });

    it('every scope segment — project, user, agent project, agent id — refuses a traversal', async () => {
      for (const scope of ['..', '../x', 'user:..', 'user:a/b', 'user:', 'agent:../p1/coder', 'agent:p1/..', 'agent:p1/a/b', 'agent:/coder']) {
        await expect(store.write(scope, 'x', 'v'), scope).rejects.toThrow(/not a safe path segment/);
      }
      await expect(store.writeAgent('p1', '../../global', 'x', 'v')).rejects.toThrow(/not a safe path segment/);
      await expect(store.writeUser('../global', 'x', 'v')).rejects.toThrow(/not a safe path segment/);
      // The quarantine is not a project any id can name.
      await expect(store.readAgent('_unresolved', 'coder', 'x')).rejects.toThrow(/quarantine/);
      expect(existsSync(join(tempDir, 'credentials', 'global'))).toBe(false);
    });

    it('deleteAgentScope removes the agent\'s directory, emits a delete per credential, and a re-created slug inherits nothing', async () => {
      await store.writeAgent('p1', 'coder', 'cred-a', 'a');
      await store.writeAgent('p1', 'coder', 'cred-b', 'b');
      await store.writeAgent('p2', 'coder', 'cred-a', 'other-tenant');
      const events: string[] = [];
      store.subscribe((e) => events.push(`${e.kind}:${e.scope}:${e.credentialId}`));

      expect(store.deleteAgentScope('p1', 'coder')).toBe(2);

      expect(existsSync(join(agentsRoot(), 'p1', 'coder'))).toBe(false);
      expect(events.sort()).toEqual(['delete:agent:p1/coder:cred-a', 'delete:agent:p1/coder:cred-b']);
      expect(await store.readAgent('p1', 'coder', 'cred-a')).toBeUndefined();
      expect(await store.readAgent('p2', 'coder', 'cred-a')).toBe('other-tenant');
      expect(store.deleteAgentScope('p1', 'never-existed')).toBe(0);
    });

    it('deleteUserScope removes ONE user\'s directory, emits a delete per credential, and leaves other users alone', async () => {
      await store.writeUser('u1', 'llm.openai', 'a');
      await store.writeUser('u1', 'git.github.com.pat', 'b');
      await store.writeUser('u2', 'llm.openai', 'other-user');
      const events: string[] = [];
      store.subscribe((e) => events.push(`${e.kind}:${e.scope}:${e.credentialId}`));

      expect(store.deleteUserScope('u1')).toBe(2);

      expect(existsSync(join(tempDir, 'credentials', 'users', 'u1'))).toBe(false);
      expect(events.sort()).toEqual(['delete:user:u1:git.github.com.pat', 'delete:user:u1:llm.openai']);
      expect(await store.readUser('u2', 'llm.openai')).toBe('other-user');
      expect(store.deleteUserScope('u1')).toBe(0);
    });

    it('deleteUserScope refuses a traversing id before any rm', () => {
      expect(() => store.deleteUserScope('../global')).toThrow();
    });

    it('deleteProjectAgentScopes removes ONE project\'s agents and never another tenant\'s same slug', async () => {
      await store.writeAgent('p1', 'coder', 'cred-a', 'a');
      await store.writeAgent('p1', 'writer', 'cred-a', 'w');
      await store.writeAgent('p2', 'coder', 'cred-a', 'other-tenant');

      expect(store.deleteProjectAgentScopes('p1')).toBe(2);

      expect(existsSync(join(agentsRoot(), 'p1'))).toBe(false);
      expect(await store.readAgent('p2', 'coder', 'cred-a')).toBe('other-tenant');
      expect(store.deleteProjectAgentScopes('p1')).toBe(0);
    });

    it('migration: ONE owning project ⇒ re-encrypted under the qualified scope, decodes there, legacy gone', async () => {
      const legacyPath = await writeLegacy('solo', 'llm.openai-codex.oauth', 'the-login');
      const legacyBytes = readFileSync(legacyPath, 'utf-8');

      const result = await store.migrateAgentCredentialLayout(port({ solo: ['p2'] }));

      expect(result).toEqual({ migrated: 1, quarantined: 0, removedEmpty: 0 });
      expect(existsSync(join(agentsRoot(), 'solo'))).toBe(false);
      expect(await store.readAgent('p2', 'solo', 'llm.openai-codex.oauth')).toBe('the-login');
      // Re-encrypted, not moved: the new file is not the legacy ciphertext.
      const moved = readFileSync(join(agentsRoot(), 'p2', 'solo', 'llm.openai-codex.oauth.enc.json'), 'utf-8');
      expect(moved).not.toBe(legacyBytes);
      expect(await store.readAgent('p1', 'solo', 'llm.openai-codex.oauth')).toBeUndefined();
    });

    it('migration: NO owner or SEVERAL owners ⇒ quarantined under _unresolved, resolvable from nowhere', async () => {
      await writeLegacy('coder', 'cred-a', 'shared-by-two');
      await writeLegacy('orphan', 'cred-a', 'nobody');

      const result = await store.migrateAgentCredentialLayout(port({ coder: ['p1', 'p2'] }));

      expect(result).toEqual({ migrated: 0, quarantined: 2, removedEmpty: 0 });
      expect(readdirSync(join(agentsRoot(), '_unresolved')).sort()).toEqual(['coder', 'orphan']);
      expect(existsSync(join(agentsRoot(), '_unresolved', 'coder', 'cred-a.enc.json'))).toBe(true);
      for (const projectId of ['p1', 'p2']) {
        expect(await store.readAgent(projectId, 'coder', 'cred-a')).toBeUndefined();
        expect(await store.readAgent(projectId, 'orphan', 'cred-a')).toBeUndefined();
      }
    });

    it('migration: a blob that does not decode, or whose qualified twin exists, is quarantined — never lost, never overwriting', async () => {
      await writeLegacy('solo', 'cred-good', 'moves');
      await writeLegacy('solo', 'cred-twin', 'legacy-copy');
      await store.writeAgent('p1', 'solo', 'cred-twin', 'already-qualified');
      mkdirSync(join(agentsRoot(), 'solo'), { recursive: true });
      writeFileSync(join(agentsRoot(), 'solo', 'cred-bad.enc.json'), '{"not":"a payload"}', 'utf-8');

      const result = await store.migrateAgentCredentialLayout(port({ solo: ['p1'] }));

      expect(result).toEqual({ migrated: 1, quarantined: 1, removedEmpty: 0 });
      expect(await store.readAgent('p1', 'solo', 'cred-good')).toBe('moves');
      expect(await store.readAgent('p1', 'solo', 'cred-twin')).toBe('already-qualified');
      expect(readdirSync(join(agentsRoot(), '_unresolved', 'solo')).sort()).toEqual([
        'cred-bad.enc.json',
        'cred-twin.enc.json',
      ]);
      expect(existsSync(join(agentsRoot(), 'solo'))).toBe(false);
    });

    it('migration: a directory whose every blob is quarantined does not count as migrated', async () => {
      mkdirSync(join(agentsRoot(), 'solo'), { recursive: true });
      writeFileSync(join(agentsRoot(), 'solo', 'cred-bad.enc.json'), 'garbage', 'utf-8');

      expect(await store.migrateAgentCredentialLayout(port({ solo: ['p1'] }))).toEqual({
        migrated: 0,
        quarantined: 1,
        removedEmpty: 0,
      });
    });

    it('migration: an emptied qualified project directory is left alone and never counted', async () => {
      await store.writeAgent('p1', 'coder', 'cred-a', 'a');
      store.deleteAgentScope('p1', 'coder');
      expect(readdirSync(join(agentsRoot(), 'p1'))).toEqual([]);

      expect(await store.migrateAgentCredentialLayout(port({}))).toEqual({
        migrated: 0,
        quarantined: 0,
        removedEmpty: 0,
      });
    });

    it('migration: an empty legacy directory is removed, and a second run finds nothing', async () => {
      mkdirSync(join(agentsRoot(), 'empty'), { recursive: true });
      await writeLegacy('solo', 'cred-a', 'v');

      expect(await store.migrateAgentCredentialLayout(port({ solo: ['p1'] }))).toEqual({
        migrated: 1,
        quarantined: 0,
        removedEmpty: 1,
      });
      expect(existsSync(join(agentsRoot(), 'empty'))).toBe(false);

      // Idempotent by shape: qualified `agents/<projectId>/` dirs hold only directories.
      expect(await store.migrateAgentCredentialLayout(port({ solo: ['p1'] }))).toEqual({
        migrated: 0,
        quarantined: 0,
        removedEmpty: 0,
      });
      expect(await store.readAgent('p1', 'solo', 'cred-a')).toBe('v');
    });
  });

  // -------------------------------------------------------------------------
  // Credential-id path containment (CRED-TAIL INC 1 / SEC-2)
  // -------------------------------------------------------------------------
  //
  // The id becomes a path segment, so `filePath()` gates it with the kernel's
  // `isValidCredentialId`. Before this gate a caller that forwarded an
  // unvalidated id could write `../../global/<real-id>`, clobbering a genuine
  // global credential with a blob encrypted under a DIFFERENT scope key — the
  // real credential then decrypts to garbage, permanently.
  describe('credential id containment', () => {
    let store: CredentialStore;
    let configDir: string;

    beforeEach(() => {
      configDir = join(tempDir, 'config');
      mkdirSync(configDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(configDir, 'credential-master.key'), randomBytes(32), { mode: 0o400 });
      writeFileSync(join(configDir, 'credential-salt.bin'), randomBytes(16), { mode: 0o400 });
      store = new CredentialStore(tempDir, configDir);
    });

    const TRAVERSAL_IDS = [
      '../../global/llm.openai',
      '../global/llm.openai',
      '..',
      'a/b',
      'a\\b',
      '.hidden',
      'has space',
      '1leading-digit',
      '',
      'x'.repeat(129),
    ];

    for (const bad of TRAVERSAL_IDS) {
      it(`rejects ${JSON.stringify(bad)} on write / read / delete`, async () => {
        await expect(store.write('proj-1', bad, 'v')).rejects.toThrow(/Invalid credential id/);
        await expect(store.read('proj-1', bad)).rejects.toThrow(/Invalid credential id/);
        await expect(store.delete('proj-1', bad)).rejects.toThrow(/Invalid credential id/);
      });
    }

    it('the traversal write never escapes the scope directory', async () => {
      const globalDir = join(tempDir, 'credentials', 'global');
      mkdirSync(globalDir, { recursive: true });
      writeFileSync(join(globalDir, 'llm.openai.enc.json'), 'SENTINEL', 'utf-8');

      await expect(store.write('proj-1', '../../global/llm.openai', 'attacker')).rejects.toThrow();

      // The genuine global credential file is byte-identical afterwards.
      expect(readFileSync(join(globalDir, 'llm.openai.enc.json'), 'utf-8')).toBe('SENTINEL');
    });

    // Every id shape the platform actually stores must still pass. A gate that
    // rejected any of these would break a shipped flow, so they are pinned
    // explicitly rather than by a regex restatement.
    const LEGACY_IDS = [
      'llm.openai',
      'llm.openai-codex.oauth',
      'voyage.apiKey',
      'qdrant.apiKey',
      'github.oauth.clientSecret',
      'websearch.tavily',
      'mcp.communityApiKey',
      'telegram.botToken',
      'telegram.botToken.ch-9f3a1b2c-4d5e-6f70-8192-a3b4c5d6e7f8',
      'whatsapp.accessToken',
      'git.github.com.pat',
      'git.github.com.oauth.accessToken',
      'mcp.my-server.env.GITHUB_TOKEN',
      'mcp.my-server.header.X_API_KEY',
      'OPENAI_API_KEY',
      '_leading_underscore',
    ];

    for (const good of LEGACY_IDS) {
      it(`accepts the shipped id ${good}`, async () => {
        await store.write('proj-1', good, 'value');
        expect(await store.read('proj-1', good)).toBe('value');
        expect(await store.delete('proj-1', good)).toBe(true);
      });
    }
  });

  describe('at-rest integrity — envelope version, master key, durable write', () => {
    it('a NEWER envelope is refused by name, an unknown one as unsupported — never fed to the v1 cipher', async () => {
      const configDir = join(tempDir, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'credential-master.key'), randomBytes(32), { mode: 0o400 });
      const store = new CredentialStore(tempDir, configDir);
      await store.writeGlobal('llm.x', 'v1-value');
      const path = join(tempDir, 'credentials', 'global', 'llm.x.enc.json');
      const envelope = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;

      writeFileSync(path, JSON.stringify({ ...envelope, version: 2 }));
      await expect(store.readGlobal('llm.x')).rejects.toBeInstanceOf(RecordNewerError);
      writeFileSync(path, JSON.stringify({ ...envelope, version: 'x' }));
      await expect(store.readGlobal('llm.x')).rejects.toBeInstanceOf(CredentialEnvelopeError);

      // PAIRED CONTROL — the untouched v1 envelope still reads.
      writeFileSync(path, JSON.stringify(envelope));
      expect(await store.readGlobal('llm.x')).toBe('v1-value');
    });

    it('a missing master key is NOT regenerated while encrypted credentials exist', async () => {
      const configDir = join(tempDir, 'config');
      mkdirSync(join(tempDir, 'credentials', 'projects', 'p1'), { recursive: true });
      writeFileSync(join(tempDir, 'credentials', 'projects', 'p1', 'llm.x.enc.json'), '{"version":1}');
      const store = new CredentialStore(tempDir, configDir);
      await expect(store.write('p1', 'llm.y', 'v')).rejects.toBeInstanceOf(CredentialMasterKeyMissingError);
      expect(existsSync(join(configDir, 'credential-master.key'))).toBe(false);
    });

    it('PAIRED CONTROL — with no encrypted credential at all, a fresh key IS generated', async () => {
      const configDir = join(tempDir, 'config');
      const store = new CredentialStore(tempDir, configDir);
      await store.write('p1', 'llm.y', 'v');
      expect(existsSync(join(configDir, 'credential-master.key'))).toBe(true);
      expect(await store.read('p1', 'llm.y')).toBe('v');
    });

    it('the legacy secret arm runs BEFORE the refusal: a legacy install keeps decrypting', async () => {
      const configDir = join(tempDir, 'config');
      const legacy = new CredentialStore(tempDir, configDir, () => 'legacy-nextauth-secret');
      await legacy.write('p1', 'llm.y', 'legacy-value');
      // Blobs now exist and there is still no key file: the legacy arm must win.
      const again = new CredentialStore(tempDir, configDir, () => 'legacy-nextauth-secret');
      expect(await again.read('p1', 'llm.y')).toBe('legacy-value');
      expect(existsSync(join(configDir, 'credential-master.key'))).toBe(false);
    });

    it('a write leaves no temp file behind and the blob is 0600', async () => {
      const configDir = join(tempDir, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'credential-master.key'), randomBytes(32), { mode: 0o400 });
      const store = new CredentialStore(tempDir, configDir);
      await store.writeGlobal('llm.x', 'a');
      await store.writeGlobal('llm.x', 'b');
      const dir = join(tempDir, 'credentials', 'global');
      expect(readdirSync(dir)).toEqual(['llm.x.enc.json']);
      const { statSync } = await import('node:fs');
      expect(statSync(join(dir, 'llm.x.enc.json')).mode & 0o777).toBe(0o600);
      expect(await store.readGlobal('llm.x')).toBe('b');
    });

    it('the injected format gate runs before every read and write', async () => {
      const configDir = join(tempDir, 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, 'credential-master.key'), randomBytes(32), { mode: 0o400 });
      let calls = 0;
      const refusing = new CredentialStore(tempDir, configDir, undefined, async () => {
        calls += 1;
        throw new Error('stored data is newer');
      });
      await expect(refusing.writeGlobal('llm.x', 'a')).rejects.toThrow('stored data is newer');
      await expect(refusing.readGlobal('llm.x')).rejects.toThrow('stored data is newer');
      expect(calls).toBe(2);
      expect(existsSync(join(tempDir, 'credentials', 'global', 'llm.x.enc.json'))).toBe(false);
    });
  });
});
