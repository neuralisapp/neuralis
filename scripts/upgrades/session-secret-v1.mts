/**
 * Offline upgrade `session-secret-v1`: the host's session secret moves out of
 * the install folder's `.env` (`NEXTAUTH_SECRET`) into the data home, as
 * `app/config/session-secret.key` (`src/server/config/sessionSecretFile.ts`) —
 * so the users it signs in and the secret travel together, and a Docker stack
 * and the desktop app opening one home sign the same sessions. The host reads
 * only the file; a home whose ledger has never seen this kind refuses to boot
 * until this step ran.
 *
 * The value comes from `process.env.NEXTAUTH_SECRET`: a folder install's
 * `upgrade` loads the folder's `.env` into the process (`loadHostEnv`), and an
 * image-only folder's runs in the app service, whose `env_file: .env` passes
 * the line. The module sees no install folder (the image channel binds only the
 * home), so it never deletes the `.env` line: the `.env` writers do (a full
 * `setup`, `update --apply`), and until then the line is inert — no build reads
 * it.
 *
 * Writes once (temp + rename, 0400) and is idempotent: a file already holding
 * the secret is left alone. Blocks: a set-up home (users on record) whose
 * secret is neither in the file nor in the environment; a file whose secret
 * DIFFERS from the environment's — the file wins and is never overwritten, the
 * operator decides. A home nobody set up passes and writes nothing (setup
 * writes the file) — and so, silently, does a home with the file but no user
 * record (a setup that stopped between its two writes): the boot answers that
 * one `setup_incomplete`, and setup finishes it.
 */

import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { OfflineUpgradeContext, OfflineUpgradeModule, OfflineUpgradePlan } from '@neuralis/package-system/data';
import { readSessionSecretFile, sessionSecretPath, writeSessionSecretFile } from '../../src/server/config/sessionSecretFile';
// The host's own kind declarations (the upgrade command verifies modules against every loaded one).
import { HOST_DATA_FORMATS } from '../../src/server/store/dataFormats';
import { spell } from '../cli/spelling.mts';

const REMEDY =
  'run this where the install\'s .env is read (`neuralis upgrade --apply` in its install folder); when the .env and ' +
  'app/config/session-secret.key disagree, keep the one users last signed in with — delete the other (the file only with the app stopped)';

type Census = { rel: string; write: string | null; summary: string[]; blockers: string[] };

function hasUsers(appRoot: string): boolean {
  try {
    return readdirSync(join(appRoot, 'users')).some((name) => name.endsWith('.json'));
  } catch {
    return false;
  }
}

function census(ctx: Pick<OfflineUpgradeContext, 'home' | 'appRoot'>, env: Readonly<Record<string, string | undefined>>): Census {
  const rel = relative(ctx.home, sessionSecretPath(ctx.appRoot));
  const fromEnv = env.NEXTAUTH_SECRET?.trim() || null;
  const file = readSessionSecretFile(ctx.appRoot);
  const out: Census = { rel, write: null, summary: [], blockers: [] };
  if (file !== null) {
    if (fromEnv !== null && fromEnv !== file) {
      out.blockers.push(`${rel} · holds a different secret than NEXTAUTH_SECRET in the install's .env — the file is never overwritten`);
    } else {
      out.summary.push(`session secret: already in ${rel}`);
    }
  } else if (fromEnv !== null) {
    out.write = fromEnv;
    out.summary.push(`session secret: NEXTAUTH_SECRET → ${rel} (nobody is signed out)`);
  } else if (hasUsers(ctx.appRoot)) {
    out.blockers.push(`${rel} · missing, and NEXTAUTH_SECRET is not set for this run, while users exist — their sessions need the secret the install's .env carries`);
  } else {
    out.summary.push('session secret: none yet (no owner: setup writes it)');
  }
  if (fromEnv !== null && out.blockers.length === 0) {
    out.summary.push(
      'session secret: the install\'s .env still carries NEXTAUTH_SECRET — inert once this ran; `update --apply` or a full setup drops the line. ' +
      `By hand, run \`${spell('setup --compose-only')}\` first: a compose file an older setup wrote requires the line and stops every compose command without it.`,
    );
  }
  return out;
}

function plan(c: Census): OfflineUpgradePlan {
  return {
    files: c.write !== null ? [c.rel] : [],
    summary: c.summary,
    ...(c.blockers.length > 0 ? { blockers: { lines: c.blockers, remedy: REMEDY } } : {}),
  };
}

export default {
  id: HOST_DATA_FORMATS.sessionSecret.upgrade.id,
  kinds: [{ kind: HOST_DATA_FORMATS.sessionSecret.kind, to: HOST_DATA_FORMATS.sessionSecret.version }],
  dryRun: async (ctx) => plan(census(ctx, process.env)),
  async apply(ctx) {
    const c = census(ctx, process.env);
    if (c.blockers.length > 0) throw new Error(`session-secret-v1: ${c.blockers.join('; ')} — ${REMEDY}`);
    if (c.write === null) return; // already in the file (a resumed run), or a home nobody set up
    await writeSessionSecretFile(ctx.appRoot, c.write);
    ctx.log(`${c.rel}: the session secret, from NEXTAUTH_SECRET`);
  },
} satisfies OfflineUpgradeModule;
