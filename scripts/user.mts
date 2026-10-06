#!/usr/bin/env node
/**
 * neuralis:user — break-glass user recovery from the HOST shell.
 *
 *   pnpm neuralis:user list
 *   pnpm neuralis:user enable <email>
 *   pnpm neuralis:user reset-password <email>
 *
 * For the moment no one can do it in the app: every owner disabled, or the only
 * owner's password lost. The boundary is the host shell itself — whoever runs
 * this can already read `.env` and the storage — so it asks no credentials (the
 * person it exists for has none that work); each mutation is confirmed by typing
 * the address again and audited with the operator's OS user name.
 *
 * It writes through the same lifecycle body the admin routes use
 * (`src/server/admin/offboardUser.ts`): a reset bumps the session epoch, so the
 * account's open sessions are refused on their next request, and enable resumes
 * nothing. It never disables or deletes — those stay in the app, behind the
 * owner floor. It runs in its OWN process, so the server's in-process
 * revocation signal never hears it: cookies and OAuth tokens die by their
 * epoch at their next use, but connections already open are not closed from
 * here (the reset says so and names the restart that ends them).
 */

import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHostEnv } from './setup/detect.mts';
import { askLine } from './setup/ownerCheck.mts';
import { findUserByEmail, listUsers } from '../src/server/store/UserStore';
import { enableUser, resetUserPassword, type UserLifecycleActor } from '../src/server/admin/offboardUser';

const neuralisDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `Usage:
  pnpm neuralis:user list
  pnpm neuralis:user enable <email>
  pnpm neuralis:user reset-password <email>`;

async function confirm(email: string, action: string): Promise<boolean> {
  const typed = await askLine(`Type ${email} again to ${action}`);
  return typed.trim().toLowerCase() === email.trim().toLowerCase();
}

async function main(): Promise<void> {
  const [command, email] = process.argv.slice(2);
  // The store reads its root through the host env module, which requires the
  // session secret; on the host shell that value lives in `.env`.
  await loadHostEnv(neuralisDir);

  if (command === 'list') {
    const users = await listUsers();
    const live = users.filter((u) => u.status !== 'deleted');
    for (const u of live) {
      console.log(`  ${u.status.padEnd(8)} ${u.email}  ${u.name}  (${u.id})`);
    }
    console.log(`  ${live.length} user(s); ${users.length - live.length} deleted record(s) not shown.`);
    return;
  }

  if ((command !== 'enable' && command !== 'reset-password') || !email) {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }
  const user = await findUserByEmail(email);
  if (!user || user.status === 'deleted') throw new Error(`No user with email ${email}.`);
  const actor: UserLifecycleActor = { kind: 'cli', operator: userInfo().username };

  if (command === 'enable') {
    if (user.status === 'active') {
      console.log(`  ${user.email} is already active.`);
      return;
    }
    if (!(await confirm(user.email, 'enable the account'))) throw new Error('Not confirmed; nothing changed.');
    await enableUser(user.id, actor);
    console.log(`  Enabled ${user.email}. Work paused while it was disabled stays paused.`);
    return;
  }

  if (!(await confirm(user.email, 'reset the password'))) throw new Error('Not confirmed; nothing changed.');
  const tempPassword = await resetUserPassword(user.id, actor);
  if (tempPassword === null) throw new Error(`No user with email ${email}.`);
  console.log(`  Temporary password for ${user.email} (shown once; a new one is required at login):`);
  console.log(`  ${tempPassword}`);
  console.log('  Sign-ins and MCP client tokens issued before the reset are refused at their next use.');
  console.log('  Connections already open (live updates, terminals, desktop streams, a running turn) are not');
  console.log('  closed from this shell; they end when the app process restarts:');
  console.log('  `docker compose restart neuralis` in the host folder (a host-plane terminal ends with the broker).');
  console.log('  A reset made in the app closes them at once.');
  if (user.status === 'disabled') console.log('  The account is still disabled — run `enable` to let it sign in.');
}

main().catch((err) => {
  console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
