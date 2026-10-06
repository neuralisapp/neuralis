/**
 * Credential Store — AES-256-GCM encrypted credential storage.
 *
 * Supports four scopes:
 * - Agent:   ~/.neuralis/app/credentials/agents/{projectId}/{agentId}/{credentialId}.enc.json
 * - Project: ~/.neuralis/app/credentials/projects/{projectId}/{credentialId}.enc.json
 * - User:    ~/.neuralis/app/credentials/users/{userId}/{credentialId}.enc.json
 * - Global:  ~/.neuralis/app/credentials/global/{credentialId}.enc.json
 *
 * An agent id is a per-project slug, so the agent scope is project-qualified
 * (`agent:<projectId>/<agentId>`): two tenants' `coder` are two directories.
 * A bare `agent:<slug>` is not a location — `credentialsDir` refuses it by name.
 *
 * Key derivation: HKDF-SHA256(CREDENTIAL_MASTER_KEY, installSalt, info = the
 * scope string). ONE key per scope — every credential in a scope shares it, so
 * a blob moved to another scope's directory fails its auth tag: a layout change
 * decrypts under the old scope and re-encrypts under the new one.
 * The master key is stored in ~/.neuralis/app/config/credential-master.key (0o400).
 * A per-installation random salt is stored in ~/.neuralis/app/config/credential-salt.bin (0o400).
 *
 * Change bus: write() and delete() emit `credential:changed` events synchronously
 * after the filesystem mutation succeeds. Subscribers (registered via subscribe())
 * run before the awaited write/delete resolves, which is the invariant the
 * agent-core credential cache relies on for consistency after token rotation.
 * Listeners are isolated by per-listener try/catch so one broken subscriber
 * cannot break another. See packages/agent-core/config.ts:invalidateCredential.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { hkdf } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { isValidCredentialId } from '@neuralis/package-system/contracts';
import { assertRecordFormat, durableReplaceFile } from '@neuralis/package-system/data';
import { assertPathSegment, isSafePathSegment } from '@neuralis/package-system/paths';
import type { ScopeMembershipPort } from '@neuralis/package-system/access';
import { HOST_DATA_FORMATS } from './dataFormats';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GLOBAL_SCOPE = '_global';
export const USER_SCOPE_PREFIX = 'user:';
export const AGENT_SCOPE_PREFIX = 'agent:';
/**
 * Where a legacy bare-slug agent directory whose owning project cannot be named
 * (none, or several) is parked. Its blobs stay under the LEGACY key, and no
 * project id can spell this directory (`credentialsDir` refuses it), so nothing
 * ever resolves from here — it is a trace for the operator, not a value.
 */
export const UNRESOLVED_AGENT_DIR = '_unresolved';
const KEY_LENGTH = 32; // 256-bit
const DEFAULT_SALT = Buffer.from('neuralis-credential-v1', 'utf-8');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EncryptedPayload = {
  version: 1;
  iv: string;       // hex
  ciphertext: string; // hex
  authTag: string;   // hex
};

export type CredentialChangeEvent = {
  kind: 'write' | 'delete';
  scope: string;
  credentialId: string;
};

export type CredentialChangeListener = (event: CredentialChangeEvent) => void;

/** The envelope version this build reads and writes. */
const ENVELOPE_VERSION = 1;

/**
 * The master key is missing while encrypted credentials exist. Generating a
 * new key here would make every stored secret permanently undecryptable, so
 * the store refuses and names the recovery instead.
 */
export class CredentialMasterKeyMissingError extends Error {
  readonly code = 'credential_master_key_missing' as const;
  constructor() {
    super(
      'credential-master.key is missing but encrypted credentials exist. ' +
        'A new key would make every one of them undecryptable, so none is generated. Put the ' +
        'original key back (a backup, or a checkpoint that carries it: `pnpm neuralis:checkpoint list`, ' +
        'then `restore <id>` with the app stopped); only if the key is lost for good, delete the ' +
        '*.enc.json files under app/credentials and set every credential again.',
    );
    this.name = 'CredentialMasterKeyMissingError';
  }
}

/** The stored envelope is not one this build can decrypt. */
export class CredentialEnvelopeError extends Error {
  readonly code = 'credential_envelope_unsupported' as const;
  constructor(readonly credentialId: string, readonly version: unknown) {
    super(`Credential '${credentialId}' has an unsupported envelope version (${String(version)}); it was not read.`);
    this.name = 'CredentialEnvelopeError';
  }
}

/** True when any `*.enc.json` sits below `dir`; stops at the first hit. */
function hasEncryptedCredential(dir: string): boolean {
  if (!existsSync(dir)) return false;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.enc.json')) return true;
    if (entry.isDirectory() && hasEncryptedCredential(join(dir, entry.name))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Key Derivation
// ---------------------------------------------------------------------------

/**
 * Derive a per-credential encryption key via HKDF-SHA256.
 *
 * @param masterKey - The CREDENTIAL_MASTER_KEY (32+ bytes)
 * @param salt - Per-installation random salt (16 bytes) or fallback static salt
 * @param info - The scope string (e.g. "abc123", "user:u1", "agent:abc123/coder" or "_global")
 */
export function deriveKey(masterKey: string | Buffer, salt: Buffer, info: string): Promise<Buffer> {
  const ikm = typeof masterKey === 'string' ? Buffer.from(masterKey, 'utf-8') : masterKey;
  return new Promise((resolve, reject) => {
    hkdf('sha256', ikm, salt, info, KEY_LENGTH, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(Buffer.from(derivedKey));
    });
  });
}

// ---------------------------------------------------------------------------
// Encrypt / Decrypt
// ---------------------------------------------------------------------------

export function encrypt(plaintext: string, key: Buffer): EncryptedPayload {
  const iv = randomBytes(12); // 96-bit IV for GCM
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    version: 1,
    iv: iv.toString('hex'),
    ciphertext: encrypted.toString('hex'),
    authTag: authTag.toString('hex'),
  };
}

export function decrypt(payload: EncryptedPayload, key: Buffer): string {
  const iv = Buffer.from(payload.iv, 'hex');
  const ciphertext = Buffer.from(payload.ciphertext, 'hex');
  const authTag = Buffer.from(payload.authTag, 'hex');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf-8');
}

// ---------------------------------------------------------------------------
// Key file helpers
// ---------------------------------------------------------------------------

/** Read or generate credential-master.key. Returns the raw key bytes. */
export function ensureMasterKeyFile(configDir: string): Buffer {
  const keyPath = join(configDir, 'credential-master.key');
  if (existsSync(keyPath)) {
    return readFileSync(keyPath);
  }
  // Generate new key
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const key = randomBytes(32);
  writeFileSync(keyPath, key, { mode: 0o400 });
  return key;
}

/** Read or generate credential-salt.bin. Returns the 16-byte salt. */
export function ensureSaltFile(configDir: string): Buffer {
  const saltPath = join(configDir, 'credential-salt.bin');
  if (existsSync(saltPath)) {
    return readFileSync(saltPath);
  }
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const salt = randomBytes(16);
  writeFileSync(saltPath, salt, { mode: 0o400 });
  return salt;
}

// ---------------------------------------------------------------------------
// CredentialStore
// ---------------------------------------------------------------------------

export class CredentialStore {
  private masterKey: Buffer | null = null;
  private installSalt: Buffer | null = null;
  private readonly listeners = new Set<CredentialChangeListener>();

  constructor(
    private readonly appRoot: string,
    /**
     * Config directory where master key and salt files are stored.
     * Defaults to `{appRoot}/config`.
     */
    private readonly configDir?: string,
    /**
     * Legacy: direct secret getter for backward compat with Phase 1.
     * If provided AND no key files exist, uses this as the master secret.
     */
    private readonly legacyGetMasterSecret?: () => string,
    /**
     * Awaited before every read and write — the host singleton passes the
     * data-format claim (`dataFormats.ts`), so no envelope is touched before
     * this build has claimed the credential kind. Unset in a unit-test store.
     */
    private readonly formatGate?: () => Promise<void>,
  ) {}

  // -- Change bus -----------------------------------------------------------

  subscribe(listener: CredentialChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: CredentialChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[CredentialStore] listener threw', err);
      }
    }
  }

  // -- Key management -------------------------------------------------------

  private getMasterKey(): Buffer {
    if (this.masterKey) return this.masterKey;

    const cfgDir = this.configDir ?? join(this.appRoot, 'config');
    const keyPath = join(cfgDir, 'credential-master.key');

    if (existsSync(keyPath)) {
      this.masterKey = readFileSync(keyPath);
      return this.masterKey;
    }

    // Fallback to legacy secret (NEXTAUTH_SECRET from Phase 1)
    if (this.legacyGetMasterSecret) {
      this.masterKey = Buffer.from(this.legacyGetMasterSecret(), 'utf-8');
      return this.masterKey;
    }

    // Generate only when there is nothing a new key would orphan. This sits
    // AFTER the legacy arm on purpose: an install whose blobs were written under
    // the legacy secret keeps decrypting them, and only a store with neither a
    // key nor a legacy secret reaches this line.
    if (hasEncryptedCredential(join(this.appRoot, 'credentials'))) {
      throw new CredentialMasterKeyMissingError();
    }
    this.masterKey = ensureMasterKeyFile(cfgDir);
    return this.masterKey;
  }

  private getInstallSalt(): Buffer {
    if (this.installSalt) return this.installSalt;

    const cfgDir = this.configDir ?? join(this.appRoot, 'config');
    const saltPath = join(cfgDir, 'credential-salt.bin');

    if (existsSync(saltPath)) {
      this.installSalt = readFileSync(saltPath);
      return this.installSalt;
    }

    // Fallback to static salt (backward compat with Phase 1 credentials)
    this.installSalt = DEFAULT_SALT;
    return this.installSalt;
  }

  private async deriveKeyFor(scope: string): Promise<Buffer> {
    return deriveKey(this.getMasterKey(), this.getInstallSalt(), scope);
  }

  // -- Directory layout -----------------------------------------------------

  /**
   * The ONE scope → directory map, and the segment floor for every scope id:
   * each id that becomes a directory name passes the kernel's `assertPathSegment`
   * here, whichever caller built the scope string, so a `../` id can never
   * reach a `join`.
   */
  private credentialsDir(scope: string): string {
    const root = join(this.appRoot, 'credentials');
    if (scope === GLOBAL_SCOPE) {
      return join(root, 'global');
    }
    if (scope.startsWith(USER_SCOPE_PREFIX)) {
      const userId = scope.slice(USER_SCOPE_PREFIX.length);
      assertPathSegment(userId, 'credential user id');
      return join(root, 'users', userId);
    }
    if (scope.startsWith(AGENT_SCOPE_PREFIX)) {
      const rest = scope.slice(AGENT_SCOPE_PREFIX.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        throw new Error(
          `Bare agent credential scope "${scope}" is not a location: an agent scope names its project (agent:<projectId>/<agentId>)`,
        );
      }
      return this.agentDir(rest.slice(0, slash), rest.slice(slash + 1));
    }
    assertPathSegment(scope, 'credential project id');
    return join(root, 'projects', scope);
  }

  private agentProjectDir(projectId: string): string {
    assertPathSegment(projectId, 'credential project id');
    if (projectId === UNRESOLVED_AGENT_DIR) {
      throw new Error(`"${UNRESOLVED_AGENT_DIR}" is the quarantine for unresolvable legacy agent credentials, not a project`);
    }
    return join(this.appRoot, 'credentials', 'agents', projectId);
  }

  private agentDir(projectId: string, agentId: string): string {
    const projectDir = this.agentProjectDir(projectId);
    assertPathSegment(agentId, 'credential agent id');
    return join(projectDir, agentId);
  }

  /**
   * The ONE path-construction choke point for `write` / `read` / `delete`.
   *
   * The credential id becomes a path segment, so it is validated HERE rather
   * than at each caller: `isValidCredentialId` (the kernel single source) is
   * anchored `^[A-Za-z_][A-Za-z0-9_.-]*$`, ≤128, which rejects slashes, `..`
   * segments and a leading dot. Without this gate a caller that forwards an
   * unvalidated id (as `PUT /api/projects/[id]/credentials` did before it was
   * deleted) could write `../../global/llm.openai` — clobbering a real global
   * credential with a blob encrypted under the *project* key, i.e. rendering
   * the genuine credential permanently undecryptable.
   *
   * Throws rather than returning a sentinel: a rejected id is a caller bug or
   * an attack, never a normal miss. `list*()` is unaffected — it enumerates
   * existing directory entries and never composes an id into a path.
   */
  private filePath(scope: string, credentialId: string): string {
    if (!isValidCredentialId(credentialId)) {
      throw new Error(`Invalid credential id: ${credentialId}`);
    }
    return join(this.credentialsDir(scope), `${credentialId}.enc.json`);
  }

  // -- CRUD: scoped ---------------------------------------------------------

  async write(scope: string, credentialId: string, plaintext: string): Promise<void> {
    await this.formatGate?.();
    const path = this.filePath(scope, credentialId);
    const key = await this.deriveKeyFor(scope);
    const payload = encrypt(plaintext, key);
    // Temp + fsync + rename + directory fsync: a crash mid-write leaves the
    // previous envelope or the new one, never a torn file the key cannot open.
    await durableReplaceFile(path, JSON.stringify(payload), { mode: 0o600 });
    this.emit({ kind: 'write', scope, credentialId });
  }

  async read(scope: string, credentialId: string): Promise<string | undefined> {
    await this.formatGate?.();
    const path = this.filePath(scope, credentialId);
    if (!existsSync(path)) return undefined;

    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    // Only the envelope this build writes is decrypted: a newer one is refused
    // by name (RecordNewerError), anything else as unsupported — never fed to
    // the v1 cipher path, which would throw an auth-tag error or worse.
    assertRecordFormat(
      HOST_DATA_FORMATS.credential.kind,
      typeof parsed.version === 'number' ? parsed.version : undefined,
      ENVELOPE_VERSION,
    );
    if (parsed.version !== ENVELOPE_VERSION) throw new CredentialEnvelopeError(credentialId, parsed.version);
    const key = await this.deriveKeyFor(scope);
    return decrypt(parsed as EncryptedPayload, key);
  }

  async delete(scope: string, credentialId: string): Promise<boolean> {
    const path = this.filePath(scope, credentialId);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    this.emit({ kind: 'delete', scope, credentialId });
    return true;
  }

  list(scope: string): string[] {
    const dir = this.credentialsDir(scope);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter(f => f.endsWith('.enc.json'))
      .map(f => f.replace(/\.enc\.json$/, ''));
  }

  // -- CRUD: user shortcuts --------------------------------------------------

  async writeUser(userId: string, credentialId: string, plaintext: string): Promise<void> {
    return this.write(userScope(userId), credentialId, plaintext);
  }

  async readUser(userId: string, credentialId: string): Promise<string | undefined> {
    return this.read(userScope(userId), credentialId);
  }

  async deleteUser(userId: string, credentialId: string): Promise<boolean> {
    return this.delete(userScope(userId), credentialId);
  }

  listUser(userId: string): string[] {
    return this.list(userScope(userId));
  }

  /**
   * Remove ONE user's whole credential directory — the user is being deleted and
   * belongs to no project any more (a project purge must never touch
   * `credentials/users`: there the user still belongs elsewhere). Emits a
   * `delete` per credential so every cache keyed on that user drops. Returns how
   * many credentials were removed.
   */
  deleteUserScope(userId: string): number {
    const scope = userScope(userId);
    const removed = this.list(scope);
    rmSync(this.credentialsDir(scope), { recursive: true, force: true });
    for (const credentialId of removed) this.emit({ kind: 'delete', scope, credentialId });
    return removed.length;
  }

  // -- CRUD: agent shortcuts -------------------------------------------------

  async writeAgent(projectId: string, agentId: string, credentialId: string, plaintext: string): Promise<void> {
    return this.write(agentScope(projectId, agentId), credentialId, plaintext);
  }

  async readAgent(projectId: string, agentId: string, credentialId: string): Promise<string | undefined> {
    return this.read(agentScope(projectId, agentId), credentialId);
  }

  async deleteAgent(projectId: string, agentId: string, credentialId: string): Promise<boolean> {
    return this.delete(agentScope(projectId, agentId), credentialId);
  }

  listAgent(projectId: string, agentId: string): string[] {
    return this.list(agentScope(projectId, agentId));
  }

  /**
   * Remove ONE agent's whole credential directory — the agent was deleted, and
   * an agent re-created under the same slug must inherit nothing. Emits a
   * `delete` per credential first so every cache keyed on that agent drops.
   * Returns how many credentials were removed.
   */
  deleteAgentScope(projectId: string, agentId: string): number {
    const scope = agentScope(projectId, agentId);
    const removed = this.list(scope);
    rmSync(this.credentialsDir(scope), { recursive: true, force: true });
    for (const credentialId of removed) this.emit({ kind: 'delete', scope, credentialId });
    return removed.length;
  }

  /**
   * Remove every agent credential of ONE project — the project is being purged.
   * The directory IS the project, so no other tenant's same-slug agent is
   * touched. Returns how many credentials were removed.
   */
  deleteProjectAgentScopes(projectId: string): number {
    const dir = this.agentProjectDir(projectId);
    if (!existsSync(dir)) return 0;
    let removed = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) removed += this.deleteAgentScope(projectId, entry.name);
    }
    rmSync(dir, { recursive: true, force: true });
    return removed;
  }

  /**
   * One-time move of the legacy bare-slug layout (`agents/<slug>/*.enc.json`)
   * into `agents/<projectId>/<slug>/`. Idempotent by shape: a qualified
   * `agents/<projectId>/` holds only directories, so a second run finds nothing.
   *
   * - EXACTLY ONE project (archived included) holds an agent of that slug ⇒ each
   *   blob is decrypted under the legacy scope and RE-ENCRYPTED under the
   *   qualified one (the key is the scope string, so a moved file would not
   *   decode), then the legacy file is removed. A blob that does not decode, or
   *   whose qualified twin already exists, is quarantined instead of lost.
   * - none or several ⇒ the directory moves to `agents/_unresolved/<slug>/`:
   *   copying a shared directory to every claimant IS the leak this closes.
   * - an empty legacy directory is removed.
   *
   * "Owner" is where the agent EXISTS (`agentBelongsToProject`), never the
   * `agentOwnership` map — an unowned agent is legal and unique.
   */
  async migrateAgentCredentialLayout(
    port: Pick<ScopeMembershipPort, 'agentBelongsToProject'> & { listProjectIds(): Promise<string[]> },
  ): Promise<{ migrated: number; quarantined: number; removedEmpty: number }> {
    const result = { migrated: 0, quarantined: 0, removedEmpty: 0 };
    const agentsRoot = join(this.appRoot, 'credentials', 'agents');
    if (!existsSync(agentsRoot)) return result;
    const legacy = readdirSync(agentsRoot, { withFileTypes: true }).filter(
      (e) => e.isDirectory() && e.name !== UNRESOLVED_AGENT_DIR,
    );
    if (legacy.length === 0) return result;
    const projectIds = await port.listProjectIds();
    for (const entry of legacy) {
      const slug = entry.name;
      const dir = join(agentsRoot, slug);
      const children = readdirSync(dir, { withFileTypes: true });
      if (children.length === 0) {
        // An emptied qualified `agents/<projectId>/` (an agent delete leaves it)
        // is not legacy residue — leave it, or every boot would count it.
        if (!projectIds.includes(slug)) {
          rmdirSync(dir);
          result.removedEmpty++;
        }
        continue;
      }
      const blobs = children.filter((c) => c.isFile() && c.name.endsWith('.enc.json')).map((c) => c.name);
      if (blobs.length === 0) continue; // a qualified `agents/<projectId>/` — only directories
      const quarantine = (file: string): void => {
        const target = join(agentsRoot, UNRESOLVED_AGENT_DIR, slug);
        mkdirSync(target, { recursive: true, mode: 0o700 });
        renameSync(join(dir, file), join(target, file));
      };
      const owners: string[] = [];
      if (isSafePathSegment(slug)) {
        for (const projectId of projectIds) {
          if (projectId !== UNRESOLVED_AGENT_DIR && (await port.agentBelongsToProject(projectId, slug))) {
            owners.push(projectId);
          }
        }
      }
      if (owners.length === 1) {
        const owner = owners[0]!;
        let moved = 0;
        let kept = 0;
        for (const file of blobs) {
          const credentialId = file.replace(/\.enc\.json$/, '');
          const legacyPath = join(dir, file);
          let plaintext: string | undefined;
          try {
            const payload = JSON.parse(readFileSync(legacyPath, 'utf-8')) as EncryptedPayload;
            plaintext = await this.decryptPayload(`${AGENT_SCOPE_PREFIX}${slug}`, payload);
          } catch {
            plaintext = undefined;
          }
          const exists = existsSync(join(this.agentDir(owner, slug), file));
          if (plaintext === undefined || exists || !isValidCredentialId(credentialId)) {
            quarantine(file);
            kept++;
            continue;
          }
          await this.writeAgent(owner, slug, credentialId, plaintext);
          unlinkSync(legacyPath);
          moved++;
        }
        // Counted per directory, by what actually happened to its blobs.
        if (moved > 0) result.migrated++;
        if (kept > 0) result.quarantined++;
      } else {
        for (const file of blobs) quarantine(file);
        result.quarantined++;
      }
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    }
    return result;
  }

  // -- Raw decrypt (for host-injected callbacks) ----------------------------

  /**
   * Decrypt a raw EncryptedPayload using scope-level key derivation.
   * Used by bootstrap to provide a decrypt callback to agent-core's
   * CredentialEnvManager without duplicating key derivation logic.
   */
  async decryptPayload(scope: string, payload: EncryptedPayload): Promise<string> {
    const key = await this.deriveKeyFor(scope);
    return decrypt(payload, key);
  }

  // -- CRUD: global (platform) shortcuts ------------------------------------

  async writeGlobal(credentialId: string, plaintext: string): Promise<void> {
    return this.write(GLOBAL_SCOPE, credentialId, plaintext);
  }

  async readGlobal(credentialId: string): Promise<string | undefined> {
    return this.read(GLOBAL_SCOPE, credentialId);
  }

  async deleteGlobal(credentialId: string): Promise<boolean> {
    return this.delete(GLOBAL_SCOPE, credentialId);
  }

  listGlobal(): string[] {
    return this.list(GLOBAL_SCOPE);
  }
}

export function userScope(userId: string): string {
  return `${USER_SCOPE_PREFIX}${userId}`;
}

/** The ONE agent-scope string: project-qualified, so a slug never names two tenants' agents. */
export function agentScope(projectId: string, agentId: string): string {
  return `${AGENT_SCOPE_PREFIX}${projectId}/${agentId}`;
}

