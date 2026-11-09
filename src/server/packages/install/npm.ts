/**
 * The npm, tar and private-scope pieces of the runtime package install.
 *
 * npm is the one that ships with the running Node (`npmCliFor(process.execPath)`
 * — the desktop bundle carries the Node archive's own npm, the Docker image's
 * `node:` base keeps its own; one rule, no PATH lookup, no shell), run as
 * `node <npm-cli.js>` with an AUTHORED environment: the kernel's
 * `authoredBaseEnv` (PATH and the Windows base keys — never the host's login
 * environment, so no token, key or secret of the host process reaches it) plus
 * the operator's proxy and CA settings, and a throwaway HOME, cache and
 * user/global config, so no `.npmrc` of this machine is read. The registry is
 * the one the platform config names; every run carries `--ignore-scripts
 * --no-audit --no-fund --legacy-peer-deps` (no package code runs, no peer is
 * installed — the host links its own) and the image lane's release-age floor.
 *
 * Cost per run: one Node child (npm itself, ≈ 0.3–0.6 s start) plus its
 * network; bounded by the `packageInstallTimeoutMs` setting, then killed.
 */

import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { authoredBaseEnv, npmCliFor, tarCommand } from '@neuralis/package-system/paths';

/** The image lane's floor (`OPERATOR_RELEASE_AGE_DAYS`): a registry version younger than a day is not installed. */
export const RELEASE_AGE_DAYS = 1;

/** The settings a run passes through from the host's environment: network reach, never a credential of the host. */
const PASSED_THROUGH = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'] as const;

export type NpmRun = { code: number | null; stdout: string; stderr: string; ms: number; timedOut: boolean };
export type NpmRunner = (args: readonly string[], opts: { cwd: string; registry: string; timeoutMs: number }) => Promise<NpmRun>;

/** npm's entry for this process's Node, or null when this Node ships none. */
export function bundledNpmCli(execPath: string = process.execPath): string | null {
  const cli = npmCliFor(execPath);
  return existsSync(cli) ? cli : null;
}

/** The environment every npm run gets (see the module header). */
export function npmEnv(parent: Readonly<Record<string, string | undefined>>, home: string, platform: NodeJS.Platform = process.platform, execPath: string = process.execPath): Record<string, string> {
  // This Node's own folder first: anything npm starts as `node` is the same Node.
  const env = authoredBaseEnv(platform, parent, [dirname(execPath)]);
  for (const key of PASSED_THROUGH) {
    const value = parent[key];
    if (value) env[key] = value;
  }
  env.HOME = home;
  if (platform === 'win32') env.USERPROFILE = home;
  env.npm_config_update_notifier = 'false';
  return env;
}

/** The flags every run carries. */
export function npmFlags(registry: string, sandbox: string): string[] {
  return [
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--legacy-peer-deps',
    `--min-release-age=${RELEASE_AGE_DAYS}`,
    `--registry=${registry}`,
    `--cache=${join(sandbox, 'cache')}`,
    // Two files: npm refuses one file loaded as both.
    `--userconfig=${join(sandbox, 'user.npmrc')}`,
    `--globalconfig=${join(sandbox, 'global.npmrc')}`,
    '--loglevel=warn',
  ];
}

/** The production runner: one bounded npm child per call, in a throwaway home it removes afterwards. */
export function createNpmRunner(cli: string, parent: Readonly<Record<string, string | undefined>> = process.env): NpmRunner {
  return async (args, opts) => {
    const sandbox = await mkdtemp(join(tmpdir(), 'nrs-npm-'));
    try {
      await writeFile(join(sandbox, 'user.npmrc'), '', 'utf-8');
      await writeFile(join(sandbox, 'global.npmrc'), '', 'utf-8');
      const started = performance.now();
      return await new Promise<NpmRun>((resolve) => {
        const child = nodeSpawn(process.execPath, [cli, ...args, ...npmFlags(opts.registry, sandbox)], {
          cwd: opts.cwd,
          env: npmEnv(parent, sandbox) as NodeJS.ProcessEnv,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        child.stdout?.on('data', (chunk: Buffer) => { if (stdout.length < 1_000_000) stdout += chunk.toString(); });
        child.stderr?.on('data', (chunk: Buffer) => { if (stderr.length < 200_000) stderr += chunk.toString(); });
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, opts.timeoutMs);
        const done = (code: number | null): void => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr, ms: Math.round(performance.now() - started), timedOut });
        };
        child.once('error', (err) => { stderr += String(err.message); done(null); });
        child.once('close', (code) => done(code));
      });
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  };
}

/** The last lines of a failed run, for the person who asked — npm's own words, bounded. */
export function npmFailureText(run: NpmRun): string {
  if (run.timedOut) return `npm did not finish within ${Math.round(run.ms / 1000)} s`;
  const lines = `${run.stderr}\n${run.stdout}`.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  return lines.slice(-12).join('\n') || `npm exited ${run.code ?? 'without a code'}`;
}

/** The sha512 Subresource-Integrity string of a file's bytes — npm's own `integrity` format. */
export async function sha512Integrity(path: string): Promise<string> {
  return `sha512-${createHash('sha512').update(await readFile(path)).digest('base64')}`;
}

// ---------------------------------------------------------------------------
// Reading a tarball without unpacking it
// ---------------------------------------------------------------------------

/** The member names of a `.tgz` (`tar -tzf`), or null when tar cannot read it. */
export function tarballEntries(tgz: string, platform: NodeJS.Platform = process.platform, env: Readonly<Record<string, string | undefined>> = process.env): string[] | null {
  const tar = tarCommand(platform, env);
  if (!tar) return null;
  const list = spawnSync(tar, ['-tzf', tgz], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (list.status !== 0) return null;
  return list.stdout.split(/\r?\n/).filter(Boolean);
}

/** One member's text, read to stdout (`tar -xzOf`) — nothing is written to disk, so no member path can escape. */
export function tarballText(tgz: string, member: string, platform: NodeJS.Platform = process.platform, env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const tar = tarCommand(platform, env);
  if (!tar) return null;
  const read = spawnSync(tar, ['-xzOf', tgz, member], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return read.status === 0 ? read.stdout : null;
}

// ---------------------------------------------------------------------------
// The private-scope record (`<NEURALIS_HOME>/build/private-scopes.json`)
// ---------------------------------------------------------------------------

/** The record's file name — the build's `PRIVATE_SCOPES_FILE`. */
export const PRIVATE_SCOPES_FILE = 'private-scopes.json';

const SCOPE_NAME = /^@[a-z0-9][a-z0-9._-]*$/i;

/**
 * The scopes the record names, read exactly as the image build reads it
 * (`parsePrivateScopeRecord` in `scripts/build/build-workspace.mjs`, which is
 * copied alone into the image build stages and so cannot be imported here; a
 * parity test runs both over the same texts). A file that is not the record's
 * shape THROWS — an unreadable record refuses, it never reads as "no private
 * scope".
 */
export function parsePrivateScopes(text: string): string[] {
  const raw = JSON.parse(text) as { scopes?: unknown };
  const scopes = raw?.scopes;
  if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes)) throw new Error('has no "scopes" object');
  const names: string[] = [];
  for (const [scope, entry] of Object.entries(scopes as Record<string, unknown>)) {
    const origins = (entry as { origins?: unknown } | null)?.origins;
    if (!SCOPE_NAME.test(scope) || !Array.isArray(origins) || origins.length === 0 || !origins.every((o) => typeof o === 'string' && o)
      || typeof (entry as { firstSeen?: unknown }).firstSeen !== 'string') {
      throw new Error(`entry "${scope}" is not { "origins": ["<url>", …], "firstSeen": "<date>" }`);
    }
    names.push(scope);
  }
  return names.sort();
}

/** The scopes this machine has seen served privately ([] without a record). Throws when a record exists that cannot be read. */
export async function readRecordedPrivateScopes(home: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(join(home, 'build', PRIVATE_SCOPES_FILE), 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('the private-scope record cannot be read');
  }
  try {
    return parsePrivateScopes(text);
  } catch (err) {
    throw new Error(`the private-scope record cannot be read (${err instanceof Error ? err.message : String(err)})`);
  }
}
