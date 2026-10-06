#!/usr/bin/env node
/**
 * `pnpm neuralis:host-broker` — provision, run and maintain the host-access
 * broker (native-nightjar H2').
 *
 * ## Why this is a separate, explicit operator command
 *
 * The host plane's floor is deliberately NOT an in-app setting. `platform.config`
 * is grantable and writes the platform-global `platform.json`, so any
 * project owner is one `PATCH /config` away from flipping an in-app flag. The
 * real gate has to be something no in-app role can produce:
 *
 *   1. a running host process (this script / a systemd unit),
 *   2. a secret file only the operator's account can read,
 *   3. a compose bind-mount of the broker runtime directory into the container,
 *   4. an operator-written ceiling listing which host paths are reachable,
 *   5. a private broker-owned PTY scratch root, outside project data policy,
 *   6. the confinement helper (`nrs-sandboxer`) installed on the HOST — the
 *      broker never spawns without it.
 *
 * All six are host-side artifacts. `init` creates 1, 2, 4 and 5 and prints the
 * unit; `install` / `upgrade` create and refresh 6; re-running
 * `pnpm neuralis:setup --compose-only` emits 3.
 *
 * ## Commands
 *
 *   init      Create secret + scratch + a DENY-ALL ceiling, print the unit.
 *   install   Install the confinement helper: copy it out of the built image
 *             (or compile it), PROVE it with `--selftest`, place it atomically.
 *   upgrade   `install` + refresh the unit + restart the broker (refused while
 *             a detached host shell is running, unless --force).
 *   run       Run the broker in the foreground (what the unit executes).
 *   status    Print authenticated readiness: secret, ceiling, helper + drift,
 *             transport, confinement mode, detached runs, pending requests.
 *   grant     Widen the ceiling by one directory (`--exec|--read|--write <dir>`),
 *             atomically, and SIGHUP the broker — the operator's answer to a
 *             recorded request. The agent never writes the ceiling.
 *   attach    Write a host-plane SOURCE CONFIG for a project (operator-only).
 *
 * The ceiling starts EMPTY on purpose — a freshly provisioned broker denies
 * every command until the operator names the paths it may reach. "Not
 * configured" must never mean "unlimited".
 *
 * ## Why `install` exists (2026-09-04)
 *
 * The helper is a static binary compiled from `docker/landlock-sandboxer.c`.
 * The IMAGE rebuilds it on every build and gates the build on its selftest, so
 * the container copy can never go stale. The HOST copy could: it was a
 * hand-run `gcc` line, nothing compared it with the image, and a helper built
 * before the alternate-ABI seccomp filter (2026-08-18) kept passing every
 * probe that read only its exit code — measured on the owner's own box on
 * 2026-09-02, with a confined child reaching the Docker daemon. `install` makes
 * the host copy a COPY of the image's (byte-reproducible: musl-static, no
 * `__DATE__`), proves it through the same probe the broker uses (both PASS
 * lines required, see `host-broker/sandboxProbe.mjs`), and `status` /
 * `neuralis:rebuild` report sha256 drift between the two so a stale host helper
 * is a printed line, not a discovery.
 */

import { mkdir, writeFile, readFile, chmod, access, rename, copyFile, rm, mkdtemp } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import {
  buildUnitText,
  composeProjectFromEnv,
  decideRestart,
  isWritableDir,
  parseSha256sum,
  parseUnitSandboxerPath,
  planInstallTarget,
  resolveInstalledSandboxer,
  sha256File,
  applyGrant,
  detectToolchainRoots,
  suggestedExecRootsMissing,
  type CeilingList,
  SANDBOXER_CONTAINER_PATH,
  SANDBOXER_SYSTEM_PATH,
  UNIT_NAME,
} from './host-broker/helper.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const NEURALIS_ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(NEURALIS_ROOT, '..');
/**
 * Pinned to `host-broker/server.mjs` `BROKER_VERSION` by
 * `packages/agent-core/__tests__/hostBrokerProtocolVersion.test.ts` — the
 * three places that name the protocol move together.
 */
const EXPECTED_BROKER_VERSION = 3;
const REQUIRED_BROKER_CAPABILITIES = ['terminal.attachments', 'exec.detached'];

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};

function neuralisHome(): string {
  return process.env.NEURALIS_HOME?.trim() || join(homedir(), '.neuralis');
}

function paths() {
  const dir = join(neuralisHome(), 'host-broker');
  return {
    dir,
    secret: join(dir, 'secret'),
    ceiling: join(dir, 'ceiling.json'),
    scratch: join(dir, 'terminal-scratch'),
    socket: join(dir, 'host-broker.sock'),
    log: join(dir, 'broker.log'),
  };
}

function unitFilePath(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(base, 'systemd', 'user', `${UNIT_NAME}.service`);
}

function readUnit(): string | null {
  try {
    return readFileSync(unitFilePath(), 'utf-8');
  } catch {
    return null;
  }
}

/** `systemctl --user is-active` — false when systemd is absent (a foreground `run`, macOS). */
function unitActive(): boolean {
  const res = spawnSync('systemctl', ['--user', 'is-active', UNIT_NAME], { encoding: 'utf-8' });
  return !res.error && res.status === 0;
}

/**
 * Locate the broker entrypoint. In the monorepo it is the package source; in a
 * deployed install it is the extracted tarball under `node_modules`. Both are
 * the SAME file — `host-broker/` is in the package `files[]` whitelist
 * precisely so the deployed layout has it (drop it and the host plane silently
 * disappears from every non-monorepo install).
 */
function brokerEntry(): string | null {
  const candidates = [
    join(REPO_ROOT, 'packages', 'agent-core', 'host-broker', 'server.mjs'),
    join(NEURALIS_ROOT, 'node_modules', '@neuralis', 'agent-core', 'host-broker', 'server.mjs'),
    join(REPO_ROOT, 'node_modules', '@neuralis', 'agent-core', 'host-broker', 'server.mjs'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * The helper path the BROKER executes. The unit's own line is the truth once a
 * unit exists; before that, the caller's env override, then the system path if
 * it is already installed there, then the per-user fallback. `run` is the one
 * caller that lets its env override win over the unit (the operator set it on
 * that invocation, for that process).
 */
function resolveSandboxer(opts: { preferEnv?: boolean } = {}): { path: string; source: 'unit' | 'env' | 'system' | 'home' } {
  return resolveInstalledSandboxer({
    unitText: readUnit(),
    envSandboxer: process.env.NEURALIS_HOST_BROKER_SANDBOXER,
    systemExists: existsSync(SANDBOXER_SYSTEM_PATH),
    homeDir: homedir(),
    preferEnv: opts.preferEnv,
  });
}

type SandboxProbe = { helper: boolean; abi: number; seccomp: boolean; reason: string | null };
type ProbeModule = {
  probeSandboxHelper: (bin: string) => SandboxProbe;
  describeSandboxProbe: (reason: string | null) => string;
};

/**
 * ONE probe implementation, imported from the broker package — a status screen
 * that disagrees with the broker's own readiness is worse than none.
 */
async function probeModule(): Promise<ProbeModule | null> {
  const entry = brokerEntry();
  if (!entry) return null;
  return (await import(new URL('sandboxProbe.mjs', pathToFileURL(entry)).href)) as ProbeModule;
}

async function probeSandbox(bin: string): Promise<SandboxProbe & { describe: string }> {
  const mod = await probeModule();
  if (!mod) return { helper: false, abi: 0, seccomp: false, reason: 'helper_missing', describe: 'broker package not found' };
  const res = mod.probeSandboxHelper(bin);
  return { ...res, describe: mod.describeSandboxProbe(res.reason) };
}

const CEILING_TEMPLATE = {
  $comment: [
    'Operator ceiling for the Neuralis host broker.',
    'Every host command resolves to `effective = requested ∩ ceiling`. An empty',
    'intersection is a DENY, and the intersection never widens: a request for a',
    'directory that CONTAINS a ceiling entry narrows down to the ceiling entry.',
    '',
    'This file is the trust boundary. The container computes what it WANTS from',
    'the host source uri-policy — but the container half is what a project owner',
    'controls, so the broker must keep its own list.',
    '',
    'It ships EMPTY: a freshly provisioned broker denies everything until you',
    'name the paths it may reach. Send SIGHUP to reload without a restart.',
    '',
    'THE THREE LISTS ANSWER DIFFERENT QUESTIONS:',
    '  read / write : the CLAMP — they bound what the caller ASKED for. A path',
    '                 listed here does NOT appear unless the caller requested it.',
    '  exec         : the ALWAYS-PRESENT set — toolchain and runtime roots added',
    '                 read-only to EVERY spawn regardless of the request.',
    '',
    'So a CLI you want agents to run goes in `exec`, together with everything it',
    'needs to start. Verified working for the `claude` CLI:',
    '  exec : ~/.local/bin (the launcher), ~/.local/share/claude (the binary),',
    '         /proc, and for a node-shim install the node prefix (e.g. ~/.nvm)',
    '  write: ~/.claude (session state)',
    '',
    'BUT KNOW WHAT THAT LAST LINE COSTS. Every `write` root is folded into the',
    'readable set (a writable-but-unreadable directory is not a usable grant),',
    'and the host filesystem data plane (fs/list, fs/read, writes and scans)',
    'then reaches it. `~/.claude`',
    'holds .credentials.json — the Claude Code OAuth token store. Naming it here',
    'makes that file readable from inside the container. If that is not what you',
    'want, narrow the write root to the specific state subdirectories the CLI',
    'actually needs, and re-check after a CLI upgrade.',
    '',
    'The reverse does NOT hold: `exec` roots are NOT readable through fs/*.',
    'Reachability so a program can start is a different grant from readability,',
    'which is why /proc in `exec` does not expose /proc/<pid>/environ.',
    '',
    'Two failure modes worth recognising, because neither names the missing path:',
    '  exit 126 + "Permission denied"  -> the binary or its symlink target is not',
    '                                    under an `exec` root.',
    '  a core dump and a timeout       -> a native binary probed the wider /proc.',
    '                                    The sandbox baseline grants only',
    '                                    /proc/self; add /proc to `exec`.',
  ],
  read: [] as string[],
  write: [] as string[],
  exec: [] as string[],
  // Toolchain roots detected on this host at `init` — a SUGGESTION for `exec`,
  // never a grant (the broker ignores every `$`-prefixed key). Move a line into
  // `exec` yourself, or `pnpm neuralis:host-broker grant --exec <dir>`.
  $suggestedExecRoots: [] as string[],
  maxTimeoutMs: 600_000,
  //
  // confinement — "sandboxed" (default; the only value on a multi-tenant deploy)
  // or "unconfined": every host spawn runs WITHOUT the sandbox helper, as the
  // broker's OS user, with that user's login environment. The agent then
  // reaches everything installed for that user (docker, node, gh, claude) —
  // root-equivalent on the host, as the operator. Loads ONLY beside
  // trustedSingleOperator: true; otherwise the broker falls back to sandboxed
  // and `status` says why. In this mode the read/write/exec lists say WHERE a
  // shell may start, not what it may reach.
  confinement: 'sandboxed' as 'sandboxed' | 'unconfined',
  //
  // Background host shells (execute background:true on a host source) — the
  // longest one may live, in ms. 0 or absent = DENIED. Set it above a rebuild's
  // duration if agents run `pnpm neuralis:rebuild` from chat (10 min is ~600000).
  maxDetachedLifetimeMs: 0,
  maxDetachedRuns: 8,
  //
  // trustedSingleOperator — the first of the two operator relaxations on this
  // plane (the other is `confinement`, above, which needs this one). Leave it false.
  //
  // Landlock is a FILESYSTEM LSM. It does not govern connect() on a pathname
  // AF_UNIX socket, and no deployable kernel has the right that would (it lands
  // in Landlock ABI 9 / ~7.1). Measured with /run granted nowhere and the path
  // built from character codes: open("/run/docker.sock") DENIED, connect() to
  // the same path ALLOWED. Docker is the least of it — the systemd USER BUS is
  // reachable the same way, and StartTransientUnit on it spawns an unconfined
  // process as you, on any Linux host.
  //
  // The broker therefore self-checks at boot and refuses to serve when a
  // confined child can still reach a host-control socket. The real fix is to
  // run it as a dedicated, session-less, group-less service account under a
  // SYSTEM unit (`pnpm neuralis:host-broker init --system`) — nothing a process
  // can do to itself at runtime.
  //
  // Setting this to true accepts that risk on a single-operator development
  // box. It lives in THIS FILE rather than platform config on purpose: platform
  // config is writable behind a grantable feature, and a grantable switch is
  // not a floor. Never set it on a multi-tenant deploy. Since 2026-09-04 the
  // broker still REPORTS a failed isolation check while this flag waives it
  // (`accepted[]` on /readyz, a yellow line in `status`) — the flag accepts the
  // residual; it does not hide it.
  trustedSingleOperator: false,
};

async function cmdInit(): Promise<void> {
  const p = paths();
  await mkdir(p.dir, { recursive: true, mode: 0o700 });
  await chmod(p.dir, 0o700);
  await mkdir(p.scratch, { recursive: true, mode: 0o700 });
  await chmod(p.scratch, 0o700);

  let created = false;
  try {
    await access(p.secret);
    console.log(`  ${c.dim}secret exists, keeping it:${c.reset} ${p.secret}`);
  } catch {
    await writeFile(p.secret, randomBytes(32).toString('hex'), { mode: 0o600 });
    await chmod(p.secret, 0o600);
    created = true;
    console.log(`  ${c.green}✓${c.reset} secret written: ${p.secret} ${c.dim}(0600)${c.reset}`);
  }

  const suggested = detectToolchainRoots(homedir(), existsSync);
  try {
    await access(p.ceiling);
    console.log(`  ${c.dim}ceiling exists, keeping it:${c.reset} ${p.ceiling}`);
  } catch {
    await writeFile(p.ceiling, JSON.stringify({ ...CEILING_TEMPLATE, $suggestedExecRoots: suggested }, null, 2), { mode: 0o600 });
    console.log(`  ${c.green}✓${c.reset} ceiling written: ${p.ceiling} ${c.dim}(DENY-ALL — edit it)${c.reset}`);
  }
  if (suggested.length) {
    console.log(`  ${c.dim}· toolchain roots detected (suggested for \`exec\`, NOT granted): ${suggested.join(', ')}${c.reset}`);
  }

  const helper = resolveSandboxer();
  const sandbox = await probeSandbox(helper.path);
  if (!sandbox.helper) {
    console.log(
      `\n  ${c.yellow}!${c.reset} the confinement helper is not usable at ${helper.path}\n` +
      `    (${sandbox.describe}).\n` +
      `    The host plane FAILS CLOSED without it — every host command is denied,\n` +
      `    for owners too. Install the image's own verified copy with:\n\n` +
      `      ${c.cyan}pnpm neuralis:host-broker install${c.reset}\n`,
    );
  } else {
    console.log(`  ${c.green}✓${c.reset} confinement helper present (ABI ${sandbox.abi}, seccomp proven) at ${helper.path}`);
  }

  console.log(`\n${c.bold}Next steps${c.reset}`);
  console.log(`  1. Edit ${c.cyan}${p.ceiling}${c.reset} — it currently denies everything.`);
  console.log(`  2. Start the broker:   ${c.cyan}pnpm neuralis:host-broker run${c.reset}`);
  console.log(`     …or install the unit printed below.`);
  console.log(`  3. Regenerate compose: ${c.cyan}pnpm neuralis:setup --compose-only${c.reset}`);
  console.log(`     (adds the read-only runtime-directory bind — ${c.bold}this bind is the real gate${c.reset})`);
  console.log(`  4. In the admin Config tab turn ON ${c.cyan}hostBrokerEnabled${c.reset} (the kill-switch)`);
  console.log(`     and grant ${c.cyan}exec.host${c.reset} / ${c.cyan}terminal.native${c.reset} to the roles that should reach the host.`);

  if (created || process.argv.includes('--print-unit')) printUnit();
}

function unitText(sandboxer: string): string {
  const p = paths();
  return buildUnitText({
    execPath: process.execPath,
    entry: brokerEntry() ?? '<agent-core>/host-broker/server.mjs',
    socket: p.socket,
    secret: p.secret,
    ceiling: p.ceiling,
    scratch: p.scratch,
    sandboxer,
  });
}

function printUnit(): void {
  console.log(`\n${c.bold}systemd user unit${c.reset} ${c.dim}(${unitFilePath()})${c.reset}\n`);
  console.log(`${c.dim}${unitText(resolveSandboxer().path)}${c.reset}`);
  console.log(`  ${c.cyan}systemctl --user daemon-reload && systemctl --user enable --now ${UNIT_NAME}${c.reset}\n`);
}

async function cmdRun(): Promise<void> {
  const p = paths();
  const entry = brokerEntry();
  if (!entry) {
    console.error(`${c.red}✗${c.reset} broker entrypoint not found — is @neuralis/agent-core installed?`);
    process.exit(2);
  }
  if (!existsSync(p.secret)) {
    console.error(`${c.red}✗${c.reset} no secret at ${p.secret} — run \`pnpm neuralis:host-broker init\` first.`);
    process.exit(2);
  }
  const child = spawn(process.execPath, [entry], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NEURALIS_HOST_BROKER_SOCKET: p.socket,
      NEURALIS_HOST_BROKER_SECRET_FILE: p.secret,
      NEURALIS_HOST_BROKER_CEILING_FILE: p.ceiling,
      NEURALIS_HOST_BROKER_SCRATCH_ROOT: p.scratch,
      NEURALIS_HOST_BROKER_SANDBOXER: resolveSandboxer({ preferEnv: true }).path,
    },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

// NAMED, not `typeof brokerHealth`. At the Promise type argument below the
// variable has only ever been assigned `null`, so `typeof` narrows to `null`
// and the whole readout downstream types as `never` — every `.ready`,
// `.version` and `.capabilities` read here was unchecked. tsx strips types, so
// it ran correctly and silently; only the new scripts type gate surfaced it.
type BrokerHealth = {
  ready?: boolean;
  version?: number;
  capabilities?: string[];
  reasons?: string[];
  accepted?: string[];
  confinement?: 'sandboxed' | 'unconfined';
  pid?: number;
  ceiling?: { roots?: number; writeRoots?: number; maxTimeoutMs?: number; maxDetachedLifetimeMs?: number; maxDetachedRuns?: number; warnings?: string[] };
  sandbox?: { helper?: boolean; abi?: number; seccomp?: boolean; reason?: string | null; socketIsolation?: boolean; isolationReasons?: string[]; trustedSingleOperator?: boolean };
  detached?: { running?: number; max?: number };
};

/** Authenticated `/readyz` over the socket, or null (no secret, no socket, stale inode, timeout). */
async function readyz(timeoutMs = 1_500): Promise<BrokerHealth | null> {
  const p = paths();
  try {
    const secret = (await readFile(p.secret, 'utf-8')).trim();
    return await new Promise<BrokerHealth | null>((resolveReady) => {
      const req = httpRequest({
        socketPath: p.socket,
        path: '/readyz',
        method: 'GET',
        headers: { authorization: `Bearer ${secret}` },
        timeout: timeoutMs,
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) { resolveReady(null); return; }
          try {
            resolveReady(JSON.parse(Buffer.concat(chunks).toString('utf8')) as BrokerHealth);
          } catch {
            resolveReady(null);
          }
        });
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolveReady(null));
      req.end();
    });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The image's helper — the reference copy for install/upgrade and for drift
// ---------------------------------------------------------------------------

function composeProject(): string {
  try {
    return composeProjectFromEnv(readFileSync(join(NEURALIS_ROOT, '.env'), 'utf-8'));
  } catch {
    return composeProjectFromEnv(null);
  }
}

/** The running app container's id (compose service `neuralis`), or null. */
function runningContainerId(): string | null {
  const res = spawnSync('docker', ['compose', '-p', composeProject(), 'ps', '-q', 'neuralis'], {
    cwd: NEURALIS_ROOT, encoding: 'utf-8', timeout: 15_000,
  });
  if (res.error || res.status !== 0) return null;
  const id = res.stdout.trim().split('\n')[0]?.trim();
  return id || null;
}

/** sha256 of the helper inside the running image, or null when no container runs / no docker. */
function imageHelperSha(): string | null {
  const id = runningContainerId();
  if (!id) return null;
  const res = spawnSync('docker', ['exec', id, 'sha256sum', SANDBOXER_CONTAINER_PATH], { encoding: 'utf-8', timeout: 15_000 });
  if (res.error || res.status !== 0) return null;
  return parseSha256sum(res.stdout);
}

type Candidate = { path: string; origin: 'file' | 'image' | 'gcc' };

/**
 * Obtain a candidate helper into `dir`: an explicit `--from` file, else a copy
 * of the running image's binary, else a fresh `gcc` build from the source the
 * image builds from. Every path lands in the same selftest gate afterwards.
 */
function obtainCandidate(dir: string, from: string | undefined): Candidate | { error: string } {
  const out = join(dir, 'nrs-sandboxer');
  if (from) {
    if (!existsSync(from)) return { error: `--from ${from}: no such file` };
    const cp = spawnSync('cp', ['-f', from, out]);
    return cp.status === 0 ? { path: out, origin: 'file' } : { error: `could not copy ${from}` };
  }
  const id = runningContainerId();
  if (id) {
    const cp = spawnSync('docker', ['cp', `${id}:${SANDBOXER_CONTAINER_PATH}`, out], { encoding: 'utf-8', timeout: 30_000 });
    if (!cp.error && cp.status === 0 && existsSync(out)) return { path: out, origin: 'image' };
  }
  const source = join(NEURALIS_ROOT, 'docker', 'landlock-sandboxer.c');
  if (existsSync(source)) {
    const gcc = spawnSync('gcc', ['-static', '-O2', '-Wall', '-Wextra', '-o', out, source], { encoding: 'utf-8', timeout: 120_000 });
    if (!gcc.error && gcc.status === 0 && existsSync(out)) return { path: out, origin: 'gcc' };
    if (!gcc.error) return { error: `gcc failed:\n${gcc.stderr.trim()}` };
  }
  return {
    error:
      'no running app container to copy the helper from (start the stack, or `pnpm neuralis:rebuild`), ' +
      'no `gcc` to compile it, and no --from <file> given',
  };
}

/**
 * `install` / `upgrade` — the ONE pipeline:
 *   obtain → PROVE (`--selftest` through the broker's own probe: both PASS
 *   lines required) → place atomically (`<target>.new` + rename) → [upgrade]
 *   refresh the unit → [upgrade] restart, refused while a detached host shell
 *   is running unless --force.
 *
 * A candidate that does not prove both layers is DELETED and nothing else
 * happens — no rename, no restart, exit ≠ 0. The old helper stays in place,
 * which the broker already reports as unusable if it is stale.
 */
async function cmdInstallOrUpgrade(mode: 'install' | 'upgrade'): Promise<void> {
  const args = process.argv.slice(3);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const force = args.includes('--force');
  const noRestart = args.includes('--no-restart');
  const explicitTarget = args.includes('--user-local') ? join(homedir(), '.local', 'bin', 'nrs-sandboxer') : flag('target');

  const unit = readUnit();
  const target = planInstallTarget({
    explicit: explicitTarget,
    unitSandboxer: unit ? parseUnitSandboxerPath(unit) : null,
    envSandboxer: process.env.NEURALIS_HOST_BROKER_SANDBOXER,
  });
  console.log(`\n${c.bold}Neuralis host broker — ${mode}${c.reset}\n`);
  console.log(`  target ${c.cyan}${target.path}${c.reset} ${c.dim}(from ${target.source})${c.reset}`);

  const work = await mkdtemp(join(tmpdir(), 'nrs-sandboxer-'));
  let keepWork = false;
  try {
    const candidate = obtainCandidate(work, flag('from'));
    if ('error' in candidate) {
      console.error(`  ${c.red}✗${c.reset} ${candidate.error}`);
      process.exit(2);
    }
    await chmod(candidate.path, 0o755);
    console.log(`  ${c.green}✓${c.reset} helper obtained ${c.dim}(${candidate.origin === 'image' ? 'copied from the running image' : candidate.origin === 'gcc' ? 'compiled from docker/landlock-sandboxer.c' : `from ${flag('from')}`})${c.reset}`);

    // The gate. Same probe the broker's readiness uses — a helper that passes
    // here is one the broker will accept, and vice versa.
    const proof = await probeSandbox(candidate.path);
    if (!proof.helper) {
      console.error(`  ${c.red}✗${c.reset} candidate REJECTED: ${proof.describe}`);
      console.error(`    nothing was installed and the broker was not restarted.`);
      process.exit(2);
    }
    console.log(`  ${c.green}✓${c.reset} --selftest proves Landlock (ABI ${proof.abi}) AND the seccomp AF_UNIX/alt-ABI filter`);

    const candidateSha = sha256File(candidate.path);
    const installedSha = existsSync(target.path) ? sha256File(target.path) : null;
    if (installedSha === candidateSha) {
      console.log(`  ${c.dim}installed helper already matches (sha256 ${candidateSha.slice(0, 12)}…)${c.reset}`);
    } else {
      const dir = dirname(target.path);
      if (!isWritableDir(dir) && !(existsSync(dir) === false && isWritableDir(dirname(dir)))) {
        // Root-owned target (the recommended /usr/local/bin): we do not sudo on
        // the operator's behalf. Leave the VERIFIED binary where they can
        // install it in one line, and stop.
        keepWork = true;
        console.log(`\n  ${c.yellow}!${c.reset} ${dir} is not writable by this account. The verified helper is at:`);
        console.log(`      ${candidate.path}`);
        console.log(`    Install it with:\n`);
        console.log(`      ${c.cyan}sudo install -m 0755 ${candidate.path} ${target.path}${c.reset}\n`);
        console.log(`    then re-run ${c.cyan}pnpm neuralis:host-broker ${mode}${c.reset} to refresh the unit${mode === 'upgrade' ? ' and restart the broker' : ''}.`);
        console.log(`    ${c.dim}(A per-user copy instead: --user-local, which targets ~/.local/bin — note that a write ceiling covering your home then covers the helper too.)${c.reset}`);
        process.exit(3);
      }
      await mkdir(dir, { recursive: true });
      const staged = `${target.path}.new`;
      await copyFile(candidate.path, staged);
      await chmod(staged, 0o755);
      await rename(staged, target.path);
      console.log(`  ${c.green}✓${c.reset} installed ${target.path} ${c.dim}(sha256 ${candidateSha.slice(0, 12)}…${installedSha ? `, was ${installedSha.slice(0, 12)}…` : ''})${c.reset}`);
    }
    if (target.source === 'system' && !unit) {
      console.log(`  ${c.dim}no unit yet — \`pnpm neuralis:host-broker init\` prints one naming this path.${c.reset}`);
    }

    // Unit refresh (upgrade only): the sandboxer line, the entry path and the
    // node binary may all have moved since the unit was written.
    let unitChanged = false;
    if (mode === 'upgrade' && unit && unit.includes('Description=Neuralis host broker')) {
      const fresh = unitText(target.path);
      if (fresh !== unit) {
        await writeFile(unitFilePath(), fresh, 'utf-8');
        spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
        unitChanged = true;
        console.log(`  ${c.green}✓${c.reset} unit refreshed ${c.dim}${unitFilePath()}${c.reset}`);
      }
    }

    const before = await readyz();
    const decision = decideRestart({
      mode, noRestart, force,
      unitActive: unitActive(),
      detachedRunning: before?.detached?.running ?? 0,
    });
    if (!decision.restart) {
      switch (decision.reason) {
        case 'install_mode':
          if (unitActive()) console.log(`\n  ${c.yellow}!${c.reset} the broker unit is running the OLD helper until restarted: ${c.cyan}pnpm neuralis:host-broker upgrade${c.reset}`);
          break;
        case 'no_restart_flag':
          console.log(`\n  ${c.dim}--no-restart: the running broker keeps its current helper${unitChanged ? ' and unit' : ''} until you restart it.${c.reset}`);
          break;
        case 'unit_inactive':
          console.log(`\n  ${c.dim}no active ${UNIT_NAME} unit — if you run the broker in the foreground, restart that process now.${c.reset}`);
          break;
        case 'detached_running':
          console.error(`\n  ${c.red}✗${c.reset} restart REFUSED: ${before?.detached?.running} detached host shell(s) still running — a restart kills them`);
          console.error(`    (and a rebuild running as one would die mid-way). Wait, or re-run with ${c.cyan}--force${c.reset}.`);
          process.exit(4);
      }
      return;
    }

    console.log(`\n  ${c.yellow}!${c.reset} restarting ${UNIT_NAME} — every host terminal tab and detached host shell it owns ends now.`);
    const rs = spawnSync('systemctl', ['--user', 'restart', UNIT_NAME], { encoding: 'utf-8' });
    if (rs.error || rs.status !== 0) {
      console.error(`  ${c.red}✗${c.reset} systemctl restart failed: ${rs.stderr?.trim() || rs.error?.message}`);
      process.exit(5);
    }
    let after: BrokerHealth | null = null;
    for (let i = 0; i < 20 && !after; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      after = await readyz();
    }
    if (!after) {
      console.error(`  ${c.red}✗${c.reset} broker did not answer /readyz within 10 s after the restart — check \`journalctl --user -u ${UNIT_NAME}\``);
      process.exit(5);
    }
    const ok = after.ready === true && after.sandbox?.helper === true;
    console.log(`  ${ok ? `${c.green}✓` : `${c.red}✗`}${c.reset} broker restarted: protocol v${after.version ?? '?'}, ready=${after.ready}, helper=${after.sandbox?.helper}${after.reasons?.length ? ` (${after.reasons.join(', ')})` : ''}`);
    if (!ok) process.exit(5);
  } finally {
    if (!keepWork) await rm(work, { recursive: true, force: true });
  }
}

type RequestsModule = {
  requestsFileFor: (secretFile: string) => string;
  readCeilingRequests: (file: string) => Array<{
    requestedRoots: { read: string[]; write: string[] }; cwd: string; list: CeilingList;
    reason: string | null; agentId: string | null; projectId: string | null; count: number;
  }>;
  pruneSatisfiedRequests: (file: string, lists: { read: string[]; write: string[]; exec: string[] }) => number;
};

/** The broker's own request module — ONE reader/writer for `requests.jsonl`. */
async function requestsModule(): Promise<RequestsModule | null> {
  const entry = brokerEntry();
  if (!entry) return null;
  return (await import(new URL('requests.mjs', pathToFileURL(entry)).href)) as RequestsModule;
}

async function pendingRequests(): Promise<ReturnType<RequestsModule['readCeilingRequests']>> {
  const mod = await requestsModule();
  if (!mod) return [];
  return mod.readCeilingRequests(mod.requestsFileFor(paths().secret));
}

async function ceilingLists(): Promise<{ read: string[]; write: string[]; exec: string[] }> {
  try {
    const parsed = JSON.parse(await readFile(paths().ceiling, 'utf-8')) as Record<string, unknown>;
    const list = (k: string) => (Array.isArray(parsed[k]) ? (parsed[k] as unknown[]).filter((v): v is string => typeof v === 'string') : []);
    return { read: list('read'), write: list('write'), exec: list('exec') };
  } catch {
    return { read: [], write: [], exec: [] };
  }
}
async function ceilingExec(): Promise<string[]> {
  return (await ceilingLists()).exec;
}

/**
 * `grant --exec|--read|--write <dir> [...]` — widen the ceiling by whole
 * directories, atomically (temp + rename, 0600: a torn write would reload as
 * DENY-ALL), then SIGHUP the running broker so it takes effect without a
 * restart, then drop the requests the grant satisfied. The ONLY writer of the
 * ceiling besides the operator's editor; the agent's side is the request.
 */
async function cmdGrant(): Promise<void> {
  const args = process.argv.slice(3);
  const grants: Array<{ list: CeilingList; dir: string }> = [];
  for (let i = 0; i < args.length; i += 1) {
    const m = /^--(exec|read|write)$/.exec(args[i] ?? '');
    if (!m) continue;
    const dir = args[i + 1];
    if (!dir || dir.startsWith('--')) {
      console.error(`${c.red}✗${c.reset} --${m[1]} needs a directory`);
      process.exit(1);
    }
    grants.push({ list: m[1] as CeilingList, dir: resolve(dir) });
    i += 1;
  }
  if (grants.length === 0) {
    console.error(
      `usage: pnpm neuralis:host-broker grant --exec <dir> | --read <dir> | --write <dir>  (repeatable)\n` +
      `  exec  : toolchain/runtime roots folded read-only into EVERY host spawn (e.g. ~/.nvm)\n` +
      `  read  : a directory the caller may READ when it asks for it (the clamp)\n` +
      `  write : a directory the caller may WRITE when it asks for it (also readable)\n` +
      `  Pending requests: \`pnpm neuralis:host-broker status\`. This never grants by itself.`,
    );
    process.exit(1);
  }
  for (const g of grants) {
    if (!existsSync(g.dir)) {
      console.error(`${c.red}✗${c.reset} ${g.dir} does not exist on this host`);
      process.exit(2);
    }
  }
  const p = paths();
  let text: string;
  try {
    text = await readFile(p.ceiling, 'utf-8');
  } catch {
    console.error(`${c.red}✗${c.reset} no ceiling at ${p.ceiling} — run \`pnpm neuralis:host-broker init\` first`);
    process.exit(2);
  }
  for (const g of grants) {
    const res = applyGrant(text, g.list, [g.dir]);
    if (!res.ok) {
      console.error(`${c.red}✗${c.reset} ${res.reason}`);
      process.exit(2);
    }
    text = res.text;
    console.log(res.added.length
      ? `  ${c.green}✓${c.reset} ${g.list.padEnd(5)} + ${g.dir}`
      : `  ${c.dim}· ${g.list.padEnd(5)}   ${g.dir} (already listed)${c.reset}`);
  }
  // Atomic: the broker reloads a torn file as deny-all, never as the previous one.
  const tmp = `${p.ceiling}.${process.pid}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, p.ceiling);
  console.log(`  ${c.green}✓${c.reset} ceiling written atomically: ${c.dim}${p.ceiling}${c.reset}`);

  const health = await readyz();
  if (health?.pid) {
    try {
      process.kill(health.pid, 'SIGHUP');
      console.log(`  ${c.green}✓${c.reset} broker reloaded (SIGHUP → pid ${health.pid}); host PTYs kept`);
    } catch (err) {
      console.log(`  ${c.yellow}!${c.reset} could not signal the broker (${err instanceof Error ? err.message : String(err)}) — send SIGHUP yourself or restart the unit`);
    }
  } else {
    console.log(`  ${c.dim}· broker not reachable — the new ceiling loads at its next start (or SIGHUP)${c.reset}`);
  }
  const mod = await requestsModule();
  if (mod) {
    const pruned = mod.pruneSatisfiedRequests(mod.requestsFileFor(p.secret), await ceilingLists());
    if (pruned) console.log(`  ${c.dim}· ${pruned} pending request(s) satisfied and cleared${c.reset}`);
  }
}

async function cmdStatus(): Promise<void> {
  const p = paths();
  const helper = resolveSandboxer();
  const sandbox = await probeSandbox(helper.path);
  const mark = (ok: boolean) => (ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`);

  let ceilingRoots = 0;
  try {
    const parsed = JSON.parse(await readFile(p.ceiling, 'utf-8')) as { read?: string[]; exec?: string[] };
    ceilingRoots = (parsed.read?.length ?? 0) + (parsed.exec?.length ?? 0);
  } catch { /* absent or malformed → 0, which means deny-all */ }

  console.log(`\n${c.bold}Neuralis host plane${c.reset}\n`);
  console.log(`  ${mark(existsSync(p.secret))} secret          ${c.dim}${p.secret}${c.reset}`);
  console.log(`  ${mark(ceilingRoots > 0)} ceiling         ${c.dim}${p.ceiling} (${ceilingRoots} root(s))${c.reset}`);
  console.log(`  ${mark(existsSync(p.scratch))} PTY scratch      ${c.dim}${p.scratch}${c.reset}`);
  console.log(
    `  ${mark(sandbox.helper)} sandbox helper  ${c.dim}${helper.path} (${helper.source})` +
      `${sandbox.helper ? ` (ABI ${sandbox.abi}, seccomp proven)` : ''}${c.reset}`,
  );
  if (!sandbox.helper) console.log(`      ${c.yellow}${sandbox.describe}${c.reset}`);

  // Drift: the image rebuilds the helper on every build; the host copy is
  // whatever `install`/`upgrade` last placed. Different bytes = run `upgrade`.
  const imageSha = imageHelperSha();
  const installedSha = existsSync(helper.path) ? sha256File(helper.path) : null;
  if (imageSha && installedSha) {
    if (imageSha === installedSha) {
      console.log(`  ${c.dim}· helper drift    none — host copy matches the running image (sha256 ${imageSha.slice(0, 12)}…)${c.reset}`);
    } else {
      console.log(`  ${c.yellow}!${c.reset} helper drift    ${c.yellow}host copy differs from the running image — run \`pnpm neuralis:host-broker upgrade\`${c.reset}`);
    }
  } else {
    console.log(`  ${c.dim}· helper drift    unknown (${imageSha ? 'no host copy' : 'no running app container to compare with'})${c.reset}`);
  }

  const brokerHealth = await readyz();
  const brokerReady = brokerHealth?.ready === true;
  const brokerProtocolCurrent =
    brokerReady
    && (brokerHealth?.version ?? 0) >= EXPECTED_BROKER_VERSION
    && REQUIRED_BROKER_CAPABILITIES.every((cap) => brokerHealth?.capabilities?.includes(cap) === true);
  console.log(`  ${mark(brokerReady)} broker ready    ${c.dim}${p.socket}${existsSync(p.socket) && !brokerReady ? ' (stale or unreachable)' : ''}${brokerHealth?.reasons?.length ? ` — ${brokerHealth.reasons.join(', ')}` : ''}${c.reset}`);
  if (brokerHealth && brokerHealth.sandbox && brokerHealth.sandbox.helper !== sandbox.helper) {
    console.log(`      ${c.yellow}the RUNNING broker's helper verdict (${brokerHealth.sandbox.helper ? 'usable' : 'unusable'}) differs from this probe — it restarts on \`upgrade\`${c.reset}`);
  }
  if (brokerHealth?.accepted?.length) {
    // D-E (2026-09-04): a waived floor is stated, never hidden. On a
    // trustedSingleOperator box this is the socket-isolation residual.
    console.log(`  ${c.yellow}!${c.reset} accepted        ${c.yellow}${brokerHealth.accepted.join(', ')} — waived by trustedSingleOperator; a residual, not a pass${c.reset}` +
      `${brokerHealth.sandbox?.isolationReasons?.length ? ` ${c.dim}(${brokerHealth.sandbox.isolationReasons.join(', ')})${c.reset}` : ''}`);
  }
  console.log(
    `  ${mark(brokerProtocolCurrent)} broker protocol ${c.dim}` +
      `${brokerHealth ? `v${brokerHealth.version ?? '?'}`
        : 'unavailable'}` +
      `${brokerReady && !brokerProtocolCurrent ? ' (restart required)' : ''}${c.reset}`,
  );
  if (brokerHealth) {
    const mode = brokerHealth.confinement ?? 'sandboxed';
    console.log(
      mode === 'unconfined'
        ? `  ${c.yellow}!${c.reset} confinement     ${c.yellow}UNCONFINED — every host spawn runs bare as this OS user (root-equivalent on the host, as the operator); single-operator machines only${c.reset}`
        : `  ${c.dim}· confinement     sandboxed (nrs-sandboxer on every host spawn)${c.reset}`,
    );
    for (const w of brokerHealth.ceiling?.warnings ?? []) {
      console.log(`  ${c.yellow}!${c.reset} ceiling         ${c.yellow}${w === 'confinement_requires_trusted_single_operator'
        ? '"confinement": "unconfined" ignored — it needs "trustedSingleOperator": true in the same file; running sandboxed'
        : w}${c.reset}`);
    }
    const lifetime = brokerHealth.ceiling?.maxDetachedLifetimeMs ?? 0;
    console.log(lifetime > 0
      ? `  ${c.dim}· detached shells ${brokerHealth.detached?.running ?? 0} running (max ${brokerHealth.detached?.max ?? '?'}; lifetime ceiling ${Math.round(lifetime / 60_000)} min)${c.reset}`
      : `  ${c.dim}· detached shells DENIED — set "maxDetachedLifetimeMs" in the ceiling to allow background host shells${c.reset}`);
  }
  // Pending ceiling-widening requests — the agent's asks, waiting for `grant`.
  const pending = await pendingRequests();
  if (pending.length) {
    console.log(`  ${c.yellow}!${c.reset} requests        ${c.yellow}${pending.length} pending widening request(s) — answer with \`pnpm neuralis:host-broker grant --exec|--read|--write <dir>\`${c.reset}`);
    for (const r of pending.slice(0, 8)) {
      const roots = [...new Set([r.cwd, ...r.requestedRoots.read, ...r.requestedRoots.write])];
      console.log(`      ${c.dim}${r.list.padEnd(5)} ${roots.join(', ')}  ×${r.count}${r.reason ? `  — "${r.reason}"` : ''}${r.agentId ? `  [${r.projectId ?? '?'}/${r.agentId}]` : ''}${c.reset}`);
    }
    if (pending.length > 8) console.log(`      ${c.dim}… ${pending.length - 8} more${c.reset}`);
  }
  if ((brokerHealth?.confinement ?? 'sandboxed') === 'sandboxed') {
    const missing = suggestedExecRootsMissing(detectToolchainRoots(homedir(), existsSync), await ceilingExec());
    if (missing.length) {
      console.log(`  ${c.dim}· suggested exec  toolchain roots not in the ceiling's exec (a host node/pnpm/cargo/CLI cannot start without them): ${missing.join(', ')}${c.reset}`);
    }
  }
  console.log(`  ${mark(brokerEntry() !== null)} broker entry    ${c.dim}${brokerEntry() ?? 'not found'}${c.reset}`);
  console.log(
    `\n  ${c.dim}All seven ✓ rows must be green AND the compose binds must be present\n` +
    `  (\`pnpm neuralis:setup --compose-only\`) before the host plane serves.\n` +
    `  An app/image rebuild does not restart this host-resident process — and it\n` +
    `  rebuilds the helper, so after a rebuild check the drift line and run \`upgrade\`.\n` +
    `  A ceiling with 0 roots denies every command by design.${c.reset}\n`,
  );
}

/**
 * `attach` — write a host-plane source config for one project.
 *
 * Deliberately an OPERATOR command rather than a UI action, and not a
 * convenience shortcut: attaching the host plane is exactly the act the design
 * says no in-app role may perform. It matches the other three artifacts (unit,
 * secret, socket bind) — all host-side, all outside anything a project owner
 * can reach.
 *
 * The written policy is READ + EXEC by default, WRITE only where you say so.
 * That is the useful default for "let an agent work on my machine": it can look
 * and run, and it can only change what you named. The broker ceiling clamps the
 * result again regardless, so a generous policy here is still bounded.
 *
 * ## Why the SCOPE defaults to one user
 *
 * `drive.read` is a default grant for members AND viewers. A project-scoped
 * host source is therefore readable by every member of that project the moment
 * it exists — the operator's own filesystem, through the Files UI and `fs_read`,
 * with no host-plane feature anywhere on the READ path (the host-plane features
 * gate attaching and executing, not reading an already-attached source).
 *
 * So the default is `user` scope: the source belongs to the operator who
 * attached it. `--project-scope` is the deliberate, warned opt-in for the
 * "shared build machine" case. Same reasoning as the platform's own
 * host-root discovery suggestion, which is user-scoped for exactly this
 * blast radius.
 */
async function cmdAttach(): Promise<void> {
  const args = process.argv.slice(3);
  const arg = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const projectId = arg('project');
  const root = arg('root');
  const slug = arg('slug') ?? 'hostfs';
  const writable = arg('writable');
  const user = arg('user');
  const projectScope = args.includes('--project-scope');

  if (!projectId || !root || (!user && !projectScope)) {
    console.error(
      `usage: pnpm neuralis:host-broker attach --project <id> --root <host-path> --user <your-user-id>\n` +
      `                                        [--slug <name>] [--writable <sub-path>] [--project-scope]\n` +
      `  --root           absolute HOST path the source is anchored at\n` +
      `  --user           the user this source belongs to (DEFAULT scope — only they see it)\n` +
      `  --slug           source name (default "hostfs"); the agent addresses it as "<slug>://"\n` +
      `  --writable       repo-relative sub-path to grant write on (default: read+exec only)\n` +
      `  --project-scope  share with the WHOLE project instead — see the warning it prints`,
    );
    process.exit(1);
  }
  if (!root.startsWith('/')) {
    console.error(`${c.red}✗${c.reset} --root must be an absolute host path.`);
    process.exit(2);
  }

  const dir = join(neuralisHome(), 'app', 'config', 'sources', projectId);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${slug}.json`);
  const config = {
    source: slug,
    scope: projectScope ? { kind: 'project' } : { kind: 'user', userId: user },
    // `host` is what makes every plane-aware consumer treat this as off-container:
    // the shell gate, the privileged-mount gate, and the broker routing all key
    // on the connector KIND, never on the slug text.
    connection: { kind: 'host', config: { root } },
    permissions: {
      default: { read: true, write: false, exec: true },
      ...(writable
        ? { paths: [{ pattern: `${slug}://${writable.replace(/^\/+/, '')}/**`, permissions: { write: true } }] }
        : { paths: [] }),
    },
    createdBy: arg('created-by') ?? user ?? 'operator',
    enabled: true,
  };
  await writeFile(file, JSON.stringify(config, null, 2), 'utf-8');

  console.log(`  ${c.green}✓${c.reset} host source written: ${c.bold}${file}${c.reset}`);
  console.log(`    slug ${c.cyan}${slug}://${c.reset} → ${root}  ${c.dim}(read+exec${writable ? `, write under ${writable}` : ', no write'})${c.reset}`);
  console.log(`    scope ${c.cyan}${projectScope ? 'project' : `user:${user}`}${c.reset}`);
  if (projectScope) {
    console.log(
      `\n  ${c.red}⚠  PROJECT SCOPE${c.reset}${c.dim} — every member AND viewer of "${projectId}" can now READ\n` +
      `     ${root} through the Files UI and fs_read. The host-plane features gate\n` +
      `     ATTACHING and EXECUTING, not reading a source that is already attached,\n` +
      `     and drive.read is granted to members and viewers by default.\n` +
      `     Use --user <id> instead unless this really is a shared machine.${c.reset}`,
    );
  }
  console.log(
    `\n  ${c.dim}Restart the app container to pick it up. The agent still needs\n` +
    `  ${c.cyan}exec.host${c.reset}${c.dim} to run commands there and ${c.reset}${c.cyan}terminal.native${c.reset}${c.dim} for the host tab,\n` +
    `  and the broker ceiling still clamps every path — widen it in\n` +
    `  ${paths().ceiling} if a legitimate path is refused.${c.reset}\n`,
  );
}

const cmd = process.argv[2] ?? 'status';
const handlers: Record<string, () => Promise<void>> = {
  init: cmdInit,
  install: () => cmdInstallOrUpgrade('install'),
  upgrade: () => cmdInstallOrUpgrade('upgrade'),
  run: cmdRun,
  status: cmdStatus,
  grant: cmdGrant,
  attach: cmdAttach,
};
const handler = handlers[cmd];
if (!handler) {
  console.error(
    `usage: pnpm neuralis:host-broker <init|install|upgrade|run|status|grant|attach>\n` +
    `  install|upgrade [--from <file>] [--target <path>|--user-local] [--no-restart] [--force]\n` +
    `  grant --exec <dir> | --read <dir> | --write <dir>   (repeatable; atomic write + SIGHUP)`,
  );
  process.exit(1);
}
await handler();
