/**
 * `neuralis tunnel` — reach this host from anywhere through a Cloudflare NAMED
 * tunnel. Reachability, never identity: every request still meets the app's
 * own login and deny-by-default; a tunnel or Access in front adds nothing to
 * what a caller may do.
 *
 *   neuralis tunnel                                   status: the hostnames, whether it is on
 *   neuralis tunnel on DOMAIN [--access WHO]          app./mcp./sandbox.DOMAIN → this host
 *   neuralis tunnel off                               the origins `on` replaced back
 *
 * `DOMAIN` is a zone in the operator's Cloudflare account. `on` signs in once
 * (`cloudflared tunnel login`, in the browser), creates or reuses the tunnel
 * `neuralis-<home>`, routes the three hostnames to it, writes its `config.yml`
 * and puts the three origins into the operator `.env` (never a platform
 * setting: origins are topology, and a platform setting is grantable to a
 * project admin). A quick tunnel is refused by design: it carries no SSE.
 * Origins that were not this machine's own (a reverse proxy, a LAN name) are
 * recorded beside them (`NEURALIS_TUNNEL_RESTORE`), and `off` writes them back;
 * without a record `off` writes this machine's.
 *
 * `--access WHO` (an email, or `@company.com`) puts Cloudflare Access in front
 * of the app's browser hostname only, with `/api/` bypassed — the CLI, devices
 * and MCP clients sign in with Neuralis OAuth and could not pass an Access
 * login. It needs a Cloudflare API token (Access: Apps and Policies Write, Zone
 * Read), read from stdin once and never stored.
 *
 * Where the connector runs: the desktop app's host downloads the pinned binary
 * into the data home and `neuralis up` supervises it after the host is ready; a
 * Docker install gets a `cloudflared` compose service in the app's network
 * namespace. Both dial the app on 127.0.0.1, and the host takes a loopback
 * request carrying a forwarding header for a REMOTE one (it is never "this
 * machine").
 *
 * The tunnel's folder (`<home>/app/cloudflared`, 0700) holds the account
 * certificate, the tunnel's credentials and `config.yml` — secrets that are
 * never `.env` lines.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { authoredBaseEnv, installKindOf, nativeConfigDir, resolveNeuralisHome } from '@neuralis/package-system/paths';
import { CliExit, type CliContext } from './cli/registry.mts';
import { spell } from './cli/spelling.mts';
import { CLOUDFLARED_IMAGE, cloudflaredAsset, cloudflaredExecutable, tunnelDir } from './setup/cloudflaredVersion.mts';
import {
  carryOverEnv,
  envFilePath,
  normalizeTunnelDomain,
  parseEnvContent,
  parseTunnelRestore,
  replaceEnvFile,
  replaceEnvKey,
  replaceOriginLines,
  singleHostOrigins,
  TUNNEL_RESTORE_KEY,
  tunnelDomainOf,
  tunnelOrigins,
  tunnelRestoreValue,
  type PortTriple,
  type PublicOrigins,
} from './setup/envFile.mts';
import { authoredEnv, downloadPinned } from './setup/services.mts';

export type RunResult = { code: number; stdout: string; stderr: string };

/** Where a `cloudflared` command runs: the pinned binary, or the pinned image (a Docker install). */
export type CloudflaredRunner = (args: readonly string[], opts: { interactive: boolean }) => Promise<RunResult>;

/** Everything `tunnel` touches outside its own files — injectable for tests. */
export interface TunnelDeps {
  /** The connector for this install; `prepare` fetches the binary first when it is missing. */
  runner(kind: InstallKind, dir: string): CloudflaredRunner;
  prepare(kind: InstallKind, home: string): Promise<void>;
  /** One Cloudflare API call (`https://api.cloudflare.com/client/v4` + `path`); the parsed `result`, or a thrown error naming the call. */
  api(token: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown>;
  /** A secret line from stdin (the API token), never echoed, never stored. */
  readSecret(prompt: string): Promise<string>;
  /** `setup --compose-only` in the install folder (a Docker install: the compose file follows `.env`). */
  regenerateCompose(ctx: CliContext): Promise<void>;
}

/** Where this install's `.env` lives and how the connector runs. */
export type InstallKind = 'native' | 'docker';

/** The tunnel's name in the account: one per data home, stable across runs. */
export function tunnelName(home: string): string {
  return `neuralis-${createHash('sha256').update(home).digest('hex').slice(0, 8)}`;
}

/** The connector's `config.yml`: the three hostnames to the app's ports on loopback, everything else 404. */
export function tunnelConfigYaml(input: { tunnelId: string; credentialsFile: string; domain: string; ports: PortTriple; appHost: string }): string {
  const o = tunnelOrigins(input.domain);
  const host = (origin: string): string => new URL(origin).hostname;
  return [
    '# Written by `neuralis tunnel on` — regenerated by it, never hand-edited.',
    `tunnel: ${input.tunnelId}`,
    `credentials-file: ${input.credentialsFile}`,
    'ingress:',
    `  - hostname: ${host(o.app)}`,
    `    service: http://${input.appHost}:${input.ports.app}`,
    `  - hostname: ${host(o.mcp)}`,
    `    service: http://${input.appHost}:${input.ports.mcp}`,
    '  # The sandbox is its own hostname: the app fences it by Host and serves it nothing but /mcp-sandbox.',
    `  - hostname: ${host(o.sandbox!)}`,
    `    service: http://${input.appHost}:${input.ports.app}`,
    '  - service: http_status:404',
    '',
  ].join('\n');
}

/** `--access WHO`: an email or `@company.com` — the Access include rule; else null. */
export function accessRule(who: string): { email: { email: string } } | { email_domain: { domain: string } } | null {
  const value = who.trim().toLowerCase();
  if (/^@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value)) return { email_domain: { domain: value.slice(1) } };
  if (/^[^\s@]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value)) return { email: { email: value } };
  return null;
}

/**
 * `setup … --tunnel DOMAIN [--access WHO]` → the `tunnel on` argv setup runs
 * once it has written `.env` (the ONE `tunnel on` path, never a second one);
 * null without the flag. Checked BEFORE setup writes anything: a bad domain or
 * access rule is refused up front, the same words `tunnel on` uses.
 */
export function setupTunnelArgs(cliArgs: readonly string[]): string[] | null {
  const at = cliArgs.indexOf('--tunnel');
  const accessAt = cliArgs.indexOf('--access');
  if (at < 0) {
    if (accessAt >= 0) throw new CliExit(1, '--access goes with --tunnel DOMAIN');
    return null;
  }
  const raw = cliArgs[at + 1] ?? '';
  const domain = normalizeTunnelDomain(raw.startsWith('--') ? '' : raw);
  if (!domain) throw new CliExit(1, `--tunnel takes a domain name — the zone, e.g. example.com (no https://, no path)${raw ? `; "${raw}" is not one` : ''}`);
  if (accessAt < 0) return ['on', domain];
  const who = cliArgs[accessAt + 1] ?? '';
  if (!accessRule(who)) throw new CliExit(1, '--access takes an email, or @company.com for everyone at that domain');
  return ['on', domain, '--access', who];
}

function installKind(ctx: CliContext): InstallKind {
  return installKindOf(ctx.packageDir) === 'native' ? 'native' : 'docker';
}

function configDirOf(kind: InstallKind, ctx: CliContext, home: string): string {
  return kind === 'native' ? nativeConfigDir(home) : ctx.installDir;
}

/** The origins with no tunnel: this machine's loopback — or its network address while the LAN switch is on. */
function localOrigins(kind: InstallKind, env: Record<string, string>, ports: PortTriple): PublicOrigins {
  if (kind === 'docker') return singleHostOrigins(`http://localhost:${ports.app}`, ports);
  const bind = env.NEURALIS_BIND_HOST?.trim() || '127.0.0.1';
  return singleHostOrigins(`http://${bind === '0.0.0.0' ? '127.0.0.1' : bind}:${ports.app}`, ports);
}

function parseArgs(argv: string[]): { verb: 'status' | 'on' | 'off'; domain: string | null; access: string | null } {
  const [verb = 'status', ...rest] = argv;
  if (verb !== 'status' && verb !== 'on' && verb !== 'off') throw new CliExit(1, `unknown tunnel command "${verb}"`, ['neuralis tunnel · neuralis tunnel on DOMAIN [--access WHO] · neuralis tunnel off']);
  const at = rest.indexOf('--access');
  const access = at >= 0 ? (rest[at + 1] ?? '') : null;
  const positional = at < 0 ? rest : rest.filter((_, i) => i !== at && i !== at + 1);
  if (verb !== 'on' && (positional.length > 0 || access !== null)) throw new CliExit(1, `\`tunnel ${verb}\` takes no arguments`);
  if (verb === 'on' && positional.length !== 1) throw new CliExit(1, '`tunnel on` takes one DOMAIN — a zone in your Cloudflare account (e.g. example.com)');
  return { verb, domain: positional[0] ?? null, access };
}

/** The `.env` with its origin block rewritten and the restore record set or dropped — the ONE writer `on` and `off` share. */
async function writeOrigins(configDir: string, origins: PublicOrigins, tunnel: boolean, restore: string | null): Promise<void> {
  const path = envFilePath(configDir);
  const text = readFileSync(path, 'utf-8');
  await replaceEnvFile(path, replaceEnvKey(replaceOriginLines(text, origins, tunnel), TUNNEL_RESTORE_KEY, restore), 0o600);
}

/**
 * What `on` records for `off`: the origins `.env` names now when they are not
 * this machine's own (null when they are, or when it names no app and MCP
 * origin); a tunnel already on keeps the record it has.
 */
export function restoreRecordFor(kind: InstallKind, env: Record<string, string>, ports: PortTriple): string | null {
  if (tunnelDomainOf(env)) return env[TUNNEL_RESTORE_KEY]?.trim() || null;
  const app = env.APP_URL?.trim() || env.NEXTAUTH_URL?.trim();
  const mcp = env.MCP_BASE_URL?.trim();
  if (!app || !mcp) return null;
  const current: PublicOrigins = { app, mcp, sandbox: env.NEURALIS_MCP_SANDBOX_ORIGIN?.trim() || null, companion: env.NEURALIS_COMPANION_ORIGIN?.trim() || null };
  const local = localOrigins(kind, env, ports);
  const own = current.app === local.app && current.mcp === local.mcp && current.sandbox === local.sandbox && current.companion === local.companion;
  return own ? null : tunnelRestoreValue(current);
}

function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CliExit(1, `cloudflared answered ${what} with something that is not JSON`);
  }
}

async function must(runner: CloudflaredRunner, args: string[], what: string, interactive = false): Promise<RunResult> {
  const res = await runner(args, { interactive });
  if (res.code !== 0) throw new CliExit(1, `${what} failed (cloudflared exit ${res.code})`, res.stderr.trim().split('\n').slice(-3));
  return res;
}

/** Access in front of `app.DOMAIN` for browsers, `app.DOMAIN/api` bypassed; idempotent by application domain. */
async function ensureAccess(deps: TunnelDeps, token: string, domain: string, rule: NonNullable<ReturnType<typeof accessRule>>, say: (line: string) => void): Promise<void> {
  const zones = await deps.api(token, 'GET', `/zones?name=${encodeURIComponent(domain)}`) as Array<{ account?: { id?: string } }>;
  const account = zones[0]?.account?.id;
  if (!account) throw new CliExit(1, `the API token sees no zone named ${domain}`, ['It needs Zone Read on that zone, and Access: Apps and Policies Write on its account.']);
  const apps = await deps.api(token, 'GET', `/accounts/${account}/access/apps`) as Array<{ domain?: string }>;
  const has = (d: string): boolean => apps.some((a) => a.domain === d);
  const app = `app.${domain}`;
  if (!has(app)) {
    const allow = await deps.api(token, 'POST', `/accounts/${account}/access/policies`, { name: `Neuralis ${domain} — people`, decision: 'allow', include: [rule] }) as { id?: string };
    await deps.api(token, 'POST', `/accounts/${account}/access/apps`, { name: `Neuralis ${domain}`, domain: app, type: 'self_hosted', session_duration: '24h', policies: [{ id: allow.id, precedence: 1 }] });
    say(`Access protects ${app} in the browser.`);
  }
  if (!has(`${app}/api`)) {
    const bypass = await deps.api(token, 'POST', `/accounts/${account}/access/policies`, { name: `Neuralis ${domain} — API`, decision: 'bypass', include: [{ everyone: {} }] }) as { id?: string };
    await deps.api(token, 'POST', `/accounts/${account}/access/apps`, { name: `Neuralis ${domain} API`, domain: `${app}/api`, type: 'self_hosted', policies: [{ id: bypass.id, precedence: 1 }] });
    say(`${app}/api/ stays open to Neuralis sign-in (the CLI and devices), behind Neuralis's own login.`);
  }
}

async function tunnelOn(ctx: CliContext, deps: TunnelDeps, rawDomain: string, access: string | null): Promise<number> {
  const say = (line: string): void => ctx.stdout(`  ${line}\n`);
  const domain = normalizeTunnelDomain(rawDomain);
  if (!domain) throw new CliExit(1, `"${rawDomain}" is not a domain name — the zone, e.g. example.com (no https://, no path)`);
  const rule = access === null ? null : accessRule(access);
  if (access !== null && !rule) throw new CliExit(1, '--access takes an email, or @company.com for everyone at that domain');
  const kind = installKind(ctx);
  const { home } = resolveNeuralisHome(ctx.env as NodeJS.ProcessEnv);
  const configDir = configDirOf(kind, ctx, home);
  if (!existsSync(envFilePath(configDir))) throw new CliExit(1, `${envFilePath(configDir)} is missing: set this install up first (\`${spell('setup')}\`)`);
  const env = parseEnvContent(readFileSync(envFilePath(configDir), 'utf-8'));
  const ports = carryOverEnv(env).ports;
  const restore = restoreRecordFor(kind, env, ports);
  // Asked BEFORE anything is created, so a refused token leaves nothing half made.
  const token = rule ? (await deps.readSecret('Cloudflare API token (Access: Apps and Policies Write, Zone Read — used now, never stored): ')).trim() : '';
  if (rule && !token) throw new CliExit(1, '--access needs a Cloudflare API token on stdin');

  const dir = tunnelDir(home);
  mkdirSync(join(dir, '.cloudflared'), { recursive: true, mode: 0o700 });
  await deps.prepare(kind, home);
  const runner = deps.runner(kind, dir);
  const cert = (kind === 'native' ? join(dir, '.cloudflared') : '/tun/.cloudflared');
  if (!existsSync(join(dir, '.cloudflared', 'cert.pem'))) {
    say('Sign in to Cloudflare in the browser (the link below) and pick the zone — once per data home.');
    await must(runner, ['tunnel', 'login'], 'The Cloudflare sign-in', true);
  }
  const certFlag = ['--origincert', `${cert}/cert.pem`];
  const name = tunnelName(home);
  const listed = parseJson<Array<{ id?: string; name?: string }> | null>((await must(runner, ['tunnel', ...certFlag, 'list', '--output', 'json', '--name', name], 'Listing the tunnels')).stdout, 'the tunnel list') ?? [];
  let id = listed.find((t) => t.name === name)?.id;
  if (!id) {
    const created = parseJson<{ id?: string }>((await must(runner, ['tunnel', ...certFlag, 'create', '--output', 'json', name], 'Creating the tunnel')).stdout, 'the new tunnel');
    id = created.id;
  }
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new CliExit(1, 'cloudflared named no tunnel id');
  if (!existsSync(join(dir, '.cloudflared', `${id}.json`))) {
    throw new CliExit(1, `the tunnel ${name} exists, but its credentials are not in ${join(dir, '.cloudflared')}`, ['It was made on another machine or data home: delete it in the Cloudflare dashboard (Zero Trust → Networks → Tunnels), then run this again.']);
  }
  const origins = tunnelOrigins(domain);
  for (const origin of [origins.app, origins.mcp, origins.sandbox!]) {
    await must(runner, ['tunnel', ...certFlag, 'route', 'dns', '--overwrite-dns', id, new URL(origin).hostname], `Routing ${new URL(origin).hostname}`);
  }
  // Native: the binary reads it in place; Docker: the compose service mounts this folder at /etc/cloudflared.
  const credentials = kind === 'native' ? join(dir, '.cloudflared', `${id}.json`) : `/etc/cloudflared/.cloudflared/${id}.json`;
  const appHost = '127.0.0.1';
  const yaml = tunnelConfigYaml({ tunnelId: id, credentialsFile: credentials, domain, ports: kind === 'native' ? ports : { app: 3100, mcp: 3101, sandbox: 3100 }, appHost });
  const tmp = join(dir, `config.yml.${process.pid}.tmp`);
  await writeFile(tmp, yaml, { encoding: 'utf-8', mode: 0o600 });
  await rename(tmp, join(dir, 'config.yml'));
  if (rule) await ensureAccess(deps, token, domain, rule, say);
  await writeOrigins(configDir, origins, true, restore);
  if (kind === 'docker') await deps.regenerateCompose(ctx);

  say(`The tunnel is on: ${origins.app} (MCP ${origins.mcp}, apps ${origins.sandbox}).`);
  say(kind === 'native' ? `Restart the host to use it: \`${spell('down')}\` then \`${spell('up')}\` (the desktop app: quit and start it).` : 'Restart the stack to use it: `docker compose up -d` in the install folder.');
  say('Changing the address retires every sign-in made on the old one: MCP clients and the CLI sign in again,');
  say('and paired devices pair again against the new MCP address. New invite links carry the public address.');
  return 0;
}

async function tunnelOff(ctx: CliContext, deps: TunnelDeps): Promise<number> {
  const say = (line: string): void => ctx.stdout(`  ${line}\n`);
  const kind = installKind(ctx);
  const { home } = resolveNeuralisHome(ctx.env as NodeJS.ProcessEnv);
  const configDir = configDirOf(kind, ctx, home);
  const env = parseEnvContent(readFileSync(envFilePath(configDir), 'utf-8'));
  if (!tunnelDomainOf(env)) {
    say('No tunnel is on for this install.');
    return 0;
  }
  const record = env[TUNNEL_RESTORE_KEY]?.trim() || null;
  const restored = record === null ? null : parseTunnelRestore(record);
  if (record !== null && !restored) {
    throw new CliExit(1, `${TUNNEL_RESTORE_KEY} in ${envFilePath(configDir)} is not the origins \`tunnel on\` recorded; nothing was changed`, ['Fix the line (app=<url> mcp=<url> [sandbox=<url>] [companion=<url>]) or delete it to put this machine\'s origins back.']);
  }
  const origins = restored ?? localOrigins(kind, env, carryOverEnv(env).ports);
  await writeOrigins(configDir, origins, false, null);
  if (kind === 'docker') await deps.regenerateCompose(ctx);
  say(`${restored ? 'The origins the tunnel replaced are back' : 'The origins are back on this machine'}: ${origins.app}. Restart to apply (${kind === 'native' ? `\`${spell('down')}\` then \`${spell('up')}\`` : '`docker compose up -d`'}).`);
  say('The tunnel and its DNS routes stay in your Cloudflare account; `tunnel on` with the same domain uses them again.');
  say('Sign-ins made on the public address stop matching: MCP clients and the CLI sign in again, devices pair again.');
  return 0;
}

function tunnelStatus(ctx: CliContext): number {
  const kind = installKind(ctx);
  const { home } = resolveNeuralisHome(ctx.env as NodeJS.ProcessEnv);
  const configDir = configDirOf(kind, ctx, home);
  const env = existsSync(envFilePath(configDir)) ? parseEnvContent(readFileSync(envFilePath(configDir), 'utf-8')) : {};
  const domain = tunnelDomainOf(env);
  if (!domain) {
    ctx.stdout(`  off — reached on ${env.APP_URL ?? 'this machine'}. \`${spell('tunnel')} on DOMAIN\` reaches it from anywhere.\n`);
    return 0;
  }
  const o = tunnelOrigins(domain);
  const ready = existsSync(join(tunnelDir(home), 'config.yml'));
  ctx.stdout(`  on — ${o.app} · MCP ${o.mcp} · apps ${o.sandbox}${ready ? '' : ` (its config.yml is missing: run \`${spell('tunnel')} on ${domain}\` again)`}\n`);
  // MCP never sits behind Access: on the app name, `/mcp` and the device link would meet the Access login.
  if (ready && sameOrigin(env.MCP_BASE_URL, env.APP_URL)) {
    ctx.stdout(`  warning — MCP_BASE_URL is the app address: with Access in front of it (\`--access\`) the CLI, devices and MCP clients cannot sign in. Set it back to ${o.mcp} (\`${spell('tunnel')} on ${domain}\` rewrites it).\n`);
  }
  return 0;
}

/** Two `.env` URLs name one origin; a missing or unparseable value never does. */
function sameOrigin(a: string | undefined, b: string | undefined): boolean {
  try {
    return new URL(a ?? '').origin === new URL(b ?? '').origin;
  } catch {
    return false;
  }
}

/** The binary on this machine (desktop app), or the pinned image with this folder mounted at `/tun` (Docker). */
function processRunner(kind: InstallKind, dir: string, home: string, env: Readonly<Record<string, string | undefined>>): CloudflaredRunner {
  return (args, opts) => new Promise((resolveRun, reject) => {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    // An authored environment: the platform base and HOME — the binary's HOME is the tunnel folder, where it keeps its files.
    const base = authoredBaseEnv(process.platform, env);
    const native = kind === 'native';
    const file = native ? cloudflaredExecutable(home) : 'docker';
    const argv = native
      ? [...args]
      : ['run', '--rm', ...(opts.interactive ? ['-i'] : []), ...(uid !== undefined ? ['--user', `${uid}:${gid}`] : []), '-e', 'HOME=/tun', '-v', `${dir}:/tun`, CLOUDFLARED_IMAGE, ...args];
    const childEnv = authoredEnv({ ...base, HOME: native ? dir : (env.HOME ?? dir) });
    const child = spawn(file, argv, { env: childEnv, stdio: [opts.interactive ? 'inherit' : 'ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    // The sign-in prints its link on stderr: shown as it comes.
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); if (opts.interactive) process.stderr.write(d); });
    child.on('error', reject);
    child.on('close', (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
  });
}

async function readLine(input: NodeJS.ReadableStream, prompt: string, out: (text: string) => void): Promise<string> {
  out(prompt);
  for await (const chunk of input) return String(chunk).split(/\r?\n/, 1)[0] ?? '';
  return '';
}

export function processTunnelDeps(ctx: CliContext): TunnelDeps {
  const home = resolveNeuralisHome(ctx.env as NodeJS.ProcessEnv).home;
  return {
    runner: (kind, dir) => processRunner(kind, dir, home, ctx.env),
    async prepare(kind) {
      if (kind !== 'native' || existsSync(cloudflaredExecutable(home))) return;
      const asset = cloudflaredAsset();
      if (!asset) throw new CliExit(1, `Cloudflare publishes no cloudflared for ${process.platform}/${process.arch}`);
      const exe = cloudflaredExecutable(home);
      await downloadPinned(asset, dirname(exe), asset.unpack === 'raw' ? exe : null);
    },
    async api(token, method, path, body) {
      const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
      const parsed = (await response.json().catch(() => ({}))) as { success?: boolean; result?: unknown; errors?: Array<{ message?: string }> };
      if (!response.ok || parsed.success === false) throw new CliExit(1, `Cloudflare refused ${method} ${path.split('?')[0]} (${response.status})`, (parsed.errors ?? []).map((e) => e.message ?? '').filter(Boolean));
      return parsed.result;
    },
    readSecret: (prompt) => readLine(ctx.stdin, prompt, ctx.stderr),
    async regenerateCompose(c) {
      const setup = await import('./setup.mts');
      const code = await setup.run(['--compose-only'], c);
      if (code !== 0) throw new CliExit(code, '`setup --compose-only` did not regenerate the compose file; `.env` already carries the new origins');
    },
  };
}

export async function run(argv: string[], ctx: CliContext, deps: TunnelDeps = processTunnelDeps(ctx)): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    ctx.stdout('Usage: neuralis tunnel · neuralis tunnel on DOMAIN [--access EMAIL|@DOMAIN] · neuralis tunnel off\n');
    return 0;
  }
  const args = parseArgs(argv);
  if (args.verb === 'on') return tunnelOn(ctx, deps, args.domain!, args.access);
  if (args.verb === 'off') return tunnelOff(ctx, deps);
  return tunnelStatus(ctx);
}
