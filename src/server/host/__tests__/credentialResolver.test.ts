import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialStore } from '../../store/CredentialStore';

let store: CredentialStore;

vi.mock('../../store/credentialStoreInstance', () => ({ getCredentialStore: () => store }));

const { buildCredentialResolver } = await import('../credentialResolver');

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cred-resolver-'));
  const configDir = join(tempDir, 'config');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir, 'credential-master.key'), randomBytes(32), { mode: 0o400 });
  writeFileSync(join(configDir, 'credential-salt.bin'), randomBytes(16), { mode: 0o400 });
  store = new CredentialStore(tempDir, configDir);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('resolveCredential — most specific wins, and it never throws', () => {
  it('agent → project → user → global, the agent tier keyed on BOTH ids', async () => {
    await store.writeGlobal('cred-a', 'global');
    await store.writeUser('u1', 'cred-a', 'user');
    await store.write('p1', 'cred-a', 'project');
    await store.writeAgent('p1', 'coder', 'cred-a', 'agent');
    await store.writeAgent('p2', 'coder', 'cred-a', 'other-tenant');
    const { resolveCredential } = buildCredentialResolver();

    expect(await resolveCredential('cred-a', { userId: 'u1', projectId: 'p1', agentId: 'coder' })).toBe('agent');
    expect(await resolveCredential('cred-a', { userId: 'u1', projectId: 'p1', agentId: 'writer' })).toBe('project');
    expect(await resolveCredential('cred-a', { userId: 'u1', agentId: 'coder' })).toBe('user');
    expect(await resolveCredential('cred-a', {})).toBe('global');
  });

  it('an id that can name no store directory is a MISS at its tier, never a throw — the lookup falls through', async () => {
    await store.writeGlobal('cred-a', 'global');
    await store.writeUser('u1', 'cred-a', 'user');
    const { resolveCredential } = buildCredentialResolver();

    for (const bad of ['../x', 'a/b', '..', '_unresolved']) {
      await expect(resolveCredential('cred-a', { userId: 'u1', projectId: 'p1', agentId: bad })).resolves.toBe('user');
    }
    await expect(resolveCredential('cred-a', { userId: 'u1', projectId: '../x', agentId: 'coder' })).resolves.toBe('user');
    await expect(resolveCredential('cred-a', { userId: 'u1', projectId: '_unresolved', agentId: 'coder' })).resolves.toBe('user');
    await expect(resolveCredential('cred-a', { userId: '../u', projectId: 'p1' })).resolves.toBe('global');
  });

  it('a project id spelled like another scope never reads that scope from the project tier', async () => {
    await store.writeGlobal('cred-a', 'global');
    await store.writeUser('u1', 'cred-a', 'user');
    await store.writeUser('victim', 'cred-a', 'victim-secret');
    const { resolveCredential } = buildCredentialResolver();

    await expect(resolveCredential('cred-a', { userId: 'u1', projectId: 'user:victim' })).resolves.toBe('user');
    await expect(resolveCredential('cred-a', { userId: 'u1', projectId: '_global' })).resolves.toBe('user');
    // Control: the same store answers the victim's own lookup, so the refusal above is the tier, not a missing record.
    await expect(resolveCredential('cred-a', { userId: 'victim' })).resolves.toBe('victim-secret');
  });
});
