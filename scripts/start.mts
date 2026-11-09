/**
 * `neuralis start` — a source clone's app, run natively, on the port its `.env`
 * names (`NEURALIS_APP_PORT`; the shell's own value wins, 3100 when neither
 * sets one). `npm run start` binds 3100 whatever `.env` says, so a clone whose
 * app port setup moved could not start on it. Run it after `npm run build`, in
 * the clone. A Docker install starts with `docker compose up -d`, the desktop
 * app's host with `neuralis up`.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { installKindOf } from '@neuralis/package-system/paths';
import { appPort } from './checkpoint.mts';
import { CliExit, type CliContext } from './cli/registry.mts';
import { readEnvFile } from './setup/envFile.mts';

const USAGE = 'neuralis start — start this source clone\'s app (after `npm run build`) on the port its .env names\n';

/** The `next` arguments for one app port: the same server `npm run start` runs. */
export function startArgs(port: number): string[] {
  return ['start', '-p', String(port), '--keepAliveTimeout', '55000'];
}

export type StartDeps = { spawn: typeof spawn };

export async function run(argv: string[], ctx: CliContext, deps: StartDeps = { spawn }): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    ctx.stdout(USAGE);
    return 0;
  }
  if (argv.length > 0) throw new CliExit(2, `neuralis start takes no arguments (got ${argv[0]})`);
  if (installKindOf(ctx.installDir) !== 'host') {
    throw new CliExit(1, '`neuralis start` runs a source clone\'s app, and this is not one', [
      'A Docker install starts with `docker compose up -d` in its install folder; the desktop app\'s host with `neuralis up`.',
    ]);
  }
  const file = await readEnvFile(ctx.installDir);
  const port = appPort({ NEURALIS_APP_PORT: ctx.env.NEURALIS_APP_PORT ?? file.NEURALIS_APP_PORT });
  const next = createRequire(join(ctx.packageDir, 'package.json')).resolve('next/dist/bin/next');
  ctx.stderr(`  Starting the app on port ${port}…\n`);
  const child = deps.spawn(process.execPath, [next, ...startArgs(port)], { cwd: ctx.packageDir, stdio: 'inherit' });
  return new Promise((done) => {
    child.on('error', (err) => {
      ctx.stderr(`  ✗ ${err.message}\n`);
      done(1);
    });
    child.on('close', (code) => done(code ?? 1));
  });
}
