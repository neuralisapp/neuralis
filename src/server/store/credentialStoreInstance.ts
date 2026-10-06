/**
 * Singleton accessor for the CredentialStore.
 * Initialized lazily from getEnv().
 *
 * Uses dedicated master key file + installation salt if available,
 * falls back to NEXTAUTH_SECRET for legacy credentials.
 *
 * The singleton is anchored on globalThis so Next.js dev HMR cannot create
 * two stores with disjoint listener sets — critical for the credential
 * change bus that drives agent-core cache invalidation.
 */

import { CredentialStore } from './CredentialStore';
import { getEnv } from '../config/env';
import { ensureHostDataFormat, HOST_DATA_FORMATS } from './dataFormats';
import { join } from 'node:path';

type GlobalSlot = { __neuralis_credential_store__?: CredentialStore };
const slot = globalThis as GlobalSlot;

export function getCredentialStore(): CredentialStore {
  if (!slot.__neuralis_credential_store__) {
    const env = getEnv();
    const configDir = join(env.appRoot, 'config');
    const instance = new CredentialStore(
      env.appRoot,
      configDir,
      // Legacy fallback: use NEXTAUTH_SECRET if no credential-master.key exists yet
      () => env.auth.secret,
      () => ensureHostDataFormat(HOST_DATA_FORMATS.credential),
    );
    slot.__neuralis_credential_store__ = instance;
  }
  return slot.__neuralis_credential_store__;
}

export function resetCredentialStore(): void {
  slot.__neuralis_credential_store__ = undefined;
}
