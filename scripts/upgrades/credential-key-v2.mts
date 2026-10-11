/**
 * Offline upgrade `credential-key-v2`: every encrypted credential opens under
 * the installation's own key file (`app/config/credential-master.key`) and salt
 * (`app/config/credential-salt.bin`). The credential store no longer derives a
 * key from `NEXTAUTH_SECRET` or a static salt when a file is missing — it
 * refuses by name — so this upgrade writes nothing: its dry run decrypts every
 * blob (values never leave this process, nothing is printed but the blob's
 * place) and BLOCKS on each one the key file cannot open, saying whether the
 * retired fallback opens it; the apply only records the format.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OfflineUpgradeContext, OfflineUpgradeModule, OfflineUpgradePlan } from '@neuralis/package-system/data';
import {
  CredentialStore,
  GLOBAL_SCOPE,
  agentScope,
  decrypt,
  deriveKey,
  userScope,
  type EncryptedPayload,
} from '../../src/server/store/CredentialStore';
// The host's own kind declarations (the upgrade command verifies modules against every loaded one).
import { HOST_DATA_FORMATS } from '../../src/server/store/dataFormats';
import { spell } from '../cli/spelling.mts';

/** The retired fallback's salt — read only here, to say which blob still needs the retired key. */
const RETIRED_SALT = Buffer.from('neuralis-credential-v1', 'utf-8');

type Blob = { scope: string; rel: string };

function entries(dir: string): Array<{ name: string; dir: boolean }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }));
}

const blobsIn = (dir: string): string[] => entries(dir).filter((e) => !e.dir && e.name.endsWith('.enc.json')).map((e) => e.name);

/** Every `*.enc.json` the store's four scope directories hold, with the scope its key is derived for. */
function listBlobs(appRoot: string): { blobs: Blob[]; strays: string[] } {
  const root = join(appRoot, 'credentials');
  const blobs: Blob[] = [];
  const strays: string[] = [];
  for (const file of blobsIn(join(root, 'global'))) blobs.push({ scope: GLOBAL_SCOPE, rel: `global/${file}` });
  for (const user of entries(join(root, 'users')).filter((e) => e.dir)) {
    for (const file of blobsIn(join(root, 'users', user.name))) blobs.push({ scope: userScope(user.name), rel: `users/${user.name}/${file}` });
  }
  for (const project of entries(join(root, 'projects')).filter((e) => e.dir)) {
    for (const file of blobsIn(join(root, 'projects', project.name))) blobs.push({ scope: project.name, rel: `projects/${project.name}/${file}` });
  }
  for (const project of entries(join(root, 'agents')).filter((e) => e.dir)) {
    // A blob directly under `agents/<slug>/` is the retired bare-slug layout: no scope opens it.
    for (const file of blobsIn(join(root, 'agents', project.name))) strays.push(`agents/${project.name}/${file}`);
    for (const agent of entries(join(root, 'agents', project.name)).filter((e) => e.dir)) {
      for (const file of blobsIn(join(root, 'agents', project.name, agent.name))) {
        blobs.push({ scope: agentScope(project.name, agent.name), rel: `agents/${project.name}/${agent.name}/${file}` });
      }
    }
  }
  return { blobs, strays };
}

async function opens(payload: EncryptedPayload, masterKey: Buffer, salt: Buffer, scope: string): Promise<boolean> {
  try {
    decrypt(payload, await deriveKey(masterKey, salt, scope));
    return true;
  } catch {
    return false;
  }
}

/** Why the key file cannot open this blob — the one retired key that still does, if any. */
async function retiredKeyFor(payload: EncryptedPayload, scope: string, keyFile: Buffer | undefined): Promise<string> {
  const secret = process.env.NEXTAUTH_SECRET;
  if (secret && (await opens(payload, Buffer.from(secret, 'utf-8'), RETIRED_SALT, scope))) {
    return 'opens only under NEXTAUTH_SECRET (written while credential-master.key was missing)';
  }
  if (keyFile && (await opens(payload, keyFile, RETIRED_SALT, scope))) {
    return 'opens only under the static salt (written while credential-salt.bin was missing)';
  }
  return secret ? 'opens under no key this install holds' : 'opens under no key this install holds (NEXTAUTH_SECRET was not set for this run)';
}

const REMEDY =
  `put the original app/config/credential-master.key and credential-salt.bin back (a backup, or \`${spell('checkpoint restore <id>')}\`), ` +
  'or delete each named blob and set that credential again after the upgrade';

async function check(ctx: OfflineUpgradeContext): Promise<OfflineUpgradePlan> {
  const { blobs, strays } = listBlobs(ctx.appRoot);
  const lines = strays.map((rel) => `credentials/${rel} · retired bare-slug agent layout — no scope opens it`);
  if (blobs.length === 0) {
    return { files: [], summary: [`credentials: ${strays.length === 0 ? 'none stored' : 'only retired-layout blobs'}`], ...(lines.length ? { blockers: { lines, remedy: REMEDY } } : {}) };
  }
  const configDir = join(ctx.appRoot, 'config');
  const keyPath = join(configDir, 'credential-master.key');
  const saltPath = join(configDir, 'credential-salt.bin');
  const keyFile = existsSync(keyPath) ? readFileSync(keyPath) : undefined;
  for (const [present, name] of [[keyFile !== undefined, 'credential-master.key'], [existsSync(saltPath), 'credential-salt.bin']] as const) {
    if (!present) lines.push(`app/config/${name} · missing beside ${blobs.length} encrypted credential(s)`);
  }
  // Only with BOTH files present does the store open anything; it reads them, never writes one.
  const store = keyFile && existsSync(saltPath) ? new CredentialStore(ctx.appRoot, configDir) : undefined;
  let open = 0;
  for (const blob of blobs) {
    let payload: EncryptedPayload;
    try {
      payload = JSON.parse(readFileSync(join(ctx.appRoot, 'credentials', blob.rel), 'utf-8')) as EncryptedPayload;
    } catch {
      lines.push(`credentials/${blob.rel} · unreadable JSON`);
      continue;
    }
    if (store) {
      try {
        await store.decryptPayload(blob.scope, payload);
        open += 1;
        continue;
      } catch {
        // falls through to the diagnosis below
      }
    }
    lines.push(`credentials/${blob.rel} · ${await retiredKeyFor(payload, blob.scope, keyFile)}`);
  }
  return {
    files: [],
    summary: [`credentials: ${open} of ${blobs.length} open under the key file`],
    ...(lines.length ? { blockers: { lines, remedy: REMEDY } } : {}),
  };
}

export default {
  id: HOST_DATA_FORMATS.credential.upgrade.id,
  kinds: [{ kind: HOST_DATA_FORMATS.credential.kind, to: HOST_DATA_FORMATS.credential.version }],
  dryRun: check,
  // Nothing to rewrite: the command refuses before the apply while the dry run blocks, and this re-check
  // keeps that true for a direct call too.
  async apply(ctx) {
    const plan = await check(ctx);
    if (plan.blockers?.lines.length) throw new Error(`credential-key-v2: ${plan.blockers.lines.length} credential(s) do not open under the key file; ${plan.blockers.remedy}.`);
  },
} satisfies OfflineUpgradeModule;
