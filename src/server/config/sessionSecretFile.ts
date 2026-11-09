/**
 * The host's session secret is a FILE in the data home —
 * `<home>/app/config/session-secret.key`, one base64 line, 0400 — beside the
 * other boot-synchronous key files (`credential-master.key`,
 * `credential-salt.bin`, `oauth/private.pem`). NextAuth encrypts the session
 * cookie with it and the `:3101` server decodes that cookie with it. Living in
 * the home, it travels with the users and projects it protects: a Docker stack
 * and the desktop app opening the same home sign the same sessions.
 *
 * The `.key` name is load-bearing: the default sync exclude list drops
 * `**\/*.key` from every index (READ floor = INDEX floor), as it does for the
 * credential master key.
 *
 * ONE owner of the path and of both halves of the access rule, shared by the
 * host (`config/env.ts` `sessionSecret`) and the operator scripts (setup, the
 * offline `session-secret-v1` step, `neuralis up`), which cannot load `env.ts`
 * (it builds the platform config store). Only setup and that offline step
 * WRITE the file; the host only reads it and never generates one — a missing
 * file is the setup-required signal.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SESSION_SECRET_FILE = 'session-secret.key';

/** `<appRoot>/config/session-secret.key` (the home-relative path is `app/config/session-secret.key`). */
export function sessionSecretPath(appRoot: string): string {
  return join(appRoot, 'config', SESSION_SECRET_FILE);
}

/** The trimmed secret; null when the file is absent or empty. Any other read error is thrown, never read as "absent". */
export function readSessionSecretFile(appRoot: string): string | null {
  try {
    return readFileSync(sessionSecretPath(appRoot), 'utf-8').trim() || null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

/** A fresh secret, the shape setup has always minted. */
export function mintSessionSecret(): string {
  return randomBytes(32).toString('base64');
}

/**
 * Write the secret once: a present file is never replaced (rotating it signs
 * every user out), so the answer says which happened. Temp file + fsync +
 * rename, 0400.
 */
export async function writeSessionSecretFile(appRoot: string, value: string): Promise<'written' | 'kept'> {
  const secret = value.trim();
  if (!secret || /[\r\n]/.test(secret)) throw new Error('Refusing to write an empty or multi-line session secret.');
  if (readSessionSecretFile(appRoot) !== null) return 'kept';
  // Loaded here, not at the top: the readers (the host, the resident `neuralis up`) never write.
  const { durableReplaceFile } = await import('@neuralis/package-system/data');
  await durableReplaceFile(sessionSecretPath(appRoot), `${secret}\n`, { mode: 0o400 });
  return 'written';
}
