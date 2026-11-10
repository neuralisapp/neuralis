#!/usr/bin/env node
/**
 * neuralis setup — Interactive CLI setup for Neuralis.
 *
 * Auto-detects Docker, Qdrant, Ollama, and platform.
 * Only asks the user what truly requires human input.
 *
 * Flags:
 *   --compose-only   Regenerate docker-compose.yml from the existing .env +
 *                    platform.json + re-detected UID/GID/DOCKER_GID. No
 *                    questions, overwrites in place. Use after editing .env
 *                    or after an update (see docs/architect/setup-and-update.md).
 *   --output <dir>   Write .env + docker-compose.yml into <dir> instead of the
 *                    channel-derived location (monorepo: neuralis/, otherwise
 *                    ~/.neuralis). Lets the wizard run inside a one-shot
 *                    container and emit onto a host bind.
 *   --uid <n>        Override the user, group and docker-socket group the
 *   --gid <n>        generated compose runs with. Detection reads the running
 *   --docker-gid <n> process and the socket, so in the image — started with
 *                    `--user "$(id -u):$(id -g)"` and the socket bound, as
 *                    `imageSetupCommand` prints — it already sees the host's.
 *   --no-desktop     Leave the virtual desktop (machine-core) off.
 *   --native --yes --owner-email <e> [--project <name>] [--qdrant docker|binary] [--desktop|--no-desktop]
 *                    The desktop app's first run (its own host bundle only):
 *                    asks nothing, the password on stdin, `.env` in
 *                    <NEURALIS_HOME>/app/config (and, Qdrant in Docker, its
 *                    compose file beside it).
 *   --native --yes [--qdrant binary [--copy-vectors|--estimate-copy]]
 *                    The same app adopting a home another install (Docker)
 *                    set up: only its own `.env` and the install record.
 *   --native --yes --refresh-qdrant   Its Qdrant lines again.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { mkdir, writeFile, access, stat, readFile, statfs } from 'node:fs/promises';
import { constants as fsConstants, existsSync, readFileSync } from 'node:fs';
import { randomBytes, randomUUID, createCipheriv, createHash, hkdf } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import bcrypt from 'bcryptjs';
// The app's own slug + project-id derivation (`src/lib/utils.ts`, dependency-free).
import { slugify } from '../src/lib/utils';
// Source config seeding is a drift-tested port of the canonical builder in
// `./setup/records.mts`.

import { CliExit, type CliContext } from './cli/registry.mts';
import { insideImage, installLayout, spell, spellOn, type InstallLayout } from './cli/spelling.mts';
import {
  PORT_ROLES, answeringQdrant, bindMountOf, busyPortRefusal, detectEnvironment, detectQdrant, findBusyPorts, imageFix, nextFreePorts, portCheck, portClaims,
  UPGRADE_DOCKER_FIRST, detectDocker, detectExistingSetup, recordedDockerQdrant, resolveConfigDir, resolveHostHome, settleLoopbackPorts, setupRefusal,
  type DetectedEnv, type Platform, type PortCheck, type PortClaim, type QdrantAnswer, type RecordedQdrant,
} from './setup/detect.mts';
import { recordInstall } from './setup/installRecord.mts';
import { askHidden } from './setup/ownerCheck.mts';
import { readPlatformConfig, writeMergedPlatformConfig } from './setup/platformConfig.mts';
import {
  OLLAMA_DEFAULT_PORT,
  OLLAMA_EMBEDDING_DIMENSION,
  OLLAMA_EMBEDDING_MODEL_ID,
  OLLAMA_EMBEDDING_TAG,
  OLLAMA_ENV_KEYS,
  OLLAMA_MODES,
  OLLAMA_OWN_PORT,
  ollamaCostLine,
  ollamaEnvLines,
  ollamaPlatformChange,
  parseOllamaMode,
  type OllamaMode,
} from './setup/ollamaVersion.mts';
import {
  createDirectorySkeleton,
  findOrphanSourceConfigDirs,
  listExistingProjects,
  resolveSetupProjectId,
  type SetupProjectResolution,
  readOwnerRecord,
  writeOwnerRecord,
  stampFreshHomeDataFormats,
  writeProjectRecord,
  writeSourceConfigsPreserving,
} from './setup/records.mts';
import {
  buildOriginLines,
  carriedOrigins,
  carryOverEnv,
  replaceOriginLines,
  singleHostOrigins,
  tunnelDomainOf,
  tunnelOrigins,
  tlsPortOrigins,
  codexLoopbackOptIn, codexLoopbackQuestion,
  normalizeTrustedProxies, trustedProxiesLines, buildNpmrcLines,
  imageTagLines, initialImageTag, resolveImageTag,
  DEFAULT_QDRANT_GRPC_PORT, DEFAULT_QDRANT_PORT, hostQdrantUrl, nativeEnvLines, nativeQdrantLines, originDefault, qdrantBinaryPorts, qdrantHostPort, replaceNativeQdrantLines,
  isLoopbackPublicOrigin, normalizePublicOrigin,
  readEnvFile, replaceEnvFile, replaceEnvKey,
  resolveQdrantApiKey, dockerIdentityLines,
  parseEnvContent as parseEnvContentShared,
  type CarriedOverEnv, type NativeQdrant, type PortTriple,
} from './setup/envFile.mts';
import { parseComposeLs, resolveComposeProject, type ComposeProjectRow } from './setup/composeProject.mts';
import type {
  CodexScopeModeSetup,
  CodexTokenBlobSetup,
  LocalLLMEntry,
  MachineChoice,
  MachineVariant,
  SetupConfig,
  VectorChoice,
} from './setup/types.mts';
import {
  waitForQdrant,
  downloadQdrantBinary,
  startQdrantBinary,
  pullOllamaModel,
} from './setup/services.mts';
import {
  NO_BUILD_INPUTS,
  OPERATOR_IMAGE_DIR,
  buildComposeContent,
  writeDesktopCompanionCompose,
  hostReachableUrl,
  operatorDependencies,
  planOperatorImage,
  resolveBuildInputs,
  type BuildInputs,
  type ComposeEmitInput,
  type OperatorImage,
} from './setup/compose.mts';
import { listLocalSources } from './build/build-workspace.mjs';
import {
  assessQdrantGap,
  binaryInstallProbe,
  dockerInstallProbe,
  qdrantBinaryName, qdrantImageRef,
  qdrantStatePath,
  readQdrantState,
  resolveQdrantState,
  QDRANT_TARGET_VERSION,
  QDRANT_UPGRADE_COMMAND,
  type QdrantInstallProbe,
} from './setup/qdrantVersion.mts';
import {
  EMBEDDING_MODELS,
  findEmbeddingModel,
  enumerateSupportedDimensions,
  type EmbeddingModelInfo,
  type EmbeddingTier,
} from '@neuralis/brain-core';
import {
  EMBEDDING_ENDPOINT_SHAPE,
  embeddingEndpointCredentialId,
  parseOperatorEndpoints,
} from '@neuralis/package-system/contracts';
import { bundleLayout, installKindOf, nativeConfigDir, resolveNeuralisHome } from '@neuralis/package-system/paths';
import { mintSessionSecret, readSessionSecretFile, sessionSecretPath, writeSessionSecretFile } from '../src/server/config/sessionSecretFile.ts';
import { DISABLED_BUILTINS_KEY } from '../src/server/host/buildRefusals.ts';
import { processExec } from './qdrant-upgrade/upgrade.mts';
import { setupTunnelArgs } from './tunnel.mts';
import { planTransfer, processTransferPorts, runTransfer, type TransferInput } from './qdrant-upgrade/transfer.mts';

// ── ANSI Colors & Symbols ──────────────────────────────────────

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  bgCyan: '\x1b[46m',
  bgGreen: '\x1b[42m',
};

const sym = {
  ok: `${c.green}✓${c.reset}`,
  warn: `${c.yellow}⚠${c.reset}`,
  fail: `${c.red}✗${c.reset}`,
  arrow: `${c.dim}→${c.reset}`,
  dot: `${c.dim}·${c.reset}`,
  bar: `${c.cyan}│${c.reset}`,
};

function heading(text: string) {
  console.log();
  console.log(`  ${c.cyan}${c.bold}── ${text} ${'─'.repeat(Math.max(0, 48 - text.length))}${c.reset}`);
  console.log();
}

function info(text: string) { console.log(`  ${sym.ok} ${text}`); }
function warn(text: string) { console.log(`  ${sym.warn} ${text}`); }
function fail(text: string) { console.log(`  ${sym.fail} ${text}`); }
function step(text: string) { console.log(`  ${sym.dot} ${text}`); }
function blank() { console.log(); }

// ── Readline helpers ───────────────────────────────────────────

let rl: ReturnType<typeof createInterface>;

function initReadline() {
  rl = createInterface({ input: stdin, output: stdout });
}

async function ask(prompt: string, defaultVal?: string): Promise<string> {
  const suffix = defaultVal ? ` ${c.dim}[${defaultVal}]${c.reset}` : '';
  const answer = await rl.question(`  ${c.white}${prompt}${suffix}: ${c.reset}`);
  return answer.trim() || defaultVal || '';
}

/**
 * Hidden input through the ONE hidden prompt (`askHidden`). The wizard's readline
 * interface is closed while it reads — an interface left open on stdin echoes every
 * keystroke into the terminal stream — and reopened for the next visible question.
 */
async function askSensitive(prompt: string): Promise<string> {
  rl.close();
  try {
    return await askHidden(`${c.white}${prompt}${c.reset}`);
  } finally {
    initReadline();
  }
}

async function askPassword(prompt: string): Promise<string> {
  return askSensitive(prompt);
}

async function askChoice(prompt: string, options: string[], defaultIdx = 0): Promise<number> {
  for (let i = 0; i < options.length; i++) {
    const marker = i === defaultIdx ? `${c.green}*${c.reset}` : ' ';
    console.log(`  ${marker} ${c.bold}[${i + 1}]${c.reset} ${options[i]}`);
  }
  const answer = await ask(prompt, String(defaultIdx + 1));
  const idx = parseInt(answer, 10) - 1;
  return idx >= 0 && idx < options.length ? idx : defaultIdx;
}

// ── Types ──────────────────────────────────────────────────────

const DEFAULT_MACHINE_VARIANT: MachineVariant = {
  key: 'ubuntu-xfce', label: 'Ubuntu + XFCE', derivativeImage: 'neuralisapp/webtop-ubuntu-xfce:0.4.1',
};

// ── Inline crypto for CredentialStore writes ──────────────────
// A port of `src/server/store/CredentialStore.ts`'s at-rest format
// (AES-256-GCM + HKDF-SHA256), not an import of it.

const GLOBAL_SCOPE = '_global';
const USER_SCOPE_PREFIX = 'user:';

function inlineDeriveKey(masterKey: Buffer, salt: Buffer, info: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    hkdf('sha256', masterKey, salt, info, 32, (err, dk) => {
      if (err) reject(err);
      else resolve(Buffer.from(dk));
    });
  });
}

function inlineEncrypt(plaintext: string, key: Buffer): { version: 1; iv: string; ciphertext: string; authTag: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return { version: 1, iv: iv.toString('hex'), ciphertext: encrypted.toString('hex'), authTag: authTag.toString('hex') };
}

function credentialScopeInfo(target: { kind: 'global' } | { kind: 'user'; userId: string }): string {
  return target.kind === 'global' ? GLOBAL_SCOPE : `${USER_SCOPE_PREFIX}${target.userId}`;
}

function credentialDir(neuralisHome: string, target: { kind: 'global' } | { kind: 'user'; userId: string }): string {
  if (target.kind === 'global') return join(neuralisHome, 'app', 'credentials', 'global');
  return join(neuralisHome, 'app', 'credentials', 'users', target.userId);
}

async function writeCredentialFile(
  neuralisHome: string,
  masterKey: Buffer,
  salt: Buffer,
  credentialId: string,
  value: string,
  target: { kind: 'global' } | { kind: 'user'; userId: string } = { kind: 'global' },
): Promise<void> {
  const dir = credentialDir(neuralisHome, target);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const key = await inlineDeriveKey(masterKey, salt, credentialScopeInfo(target));
  const payload = inlineEncrypt(value.trim(), key);
  const filePath = join(dir, `${credentialId}.enc.json`);
  await writeFile(filePath, JSON.stringify(payload), { encoding: 'utf-8', mode: 0o600 });
}

// Credential ID mapping for LLM env vars
const LLM_CREDENTIAL_MAP: Record<string, string> = {
  ANTHROPIC_API_KEY: 'llm.anthropic',
  OPENAI_API_KEY: 'llm.openai',
  GEMINI_API_KEY: 'llm.gemini',
  DEEPSEEK_API_KEY: 'llm.deepseek',
  MINIMAX_API_KEY: 'llm.minimax',
  KIMI_API_KEY: 'llm.kimi',
  QWEN_API_KEY: 'llm.qwen',
  XAI_API_KEY: 'llm.xai',
};

// ── Banner ─────────────────────────────────────────────────────

function printBanner() {
  console.log();
  console.log(`  ${c.cyan}${c.bold}╔═══════════════════════════════════════════════════╗${c.reset}`);
  console.log(`  ${c.cyan}${c.bold}║${c.reset}                                                   ${c.cyan}${c.bold}║${c.reset}`);
  console.log(`  ${c.cyan}${c.bold}║${c.reset}   ${c.white}${c.bold}Neuralis Setup${c.reset}                                 ${c.cyan}${c.bold}║${c.reset}`);
  console.log(`  ${c.cyan}${c.bold}║${c.reset}   ${c.dim}Open-source AI agent platform${c.reset}                  ${c.cyan}${c.bold}║${c.reset}`);
  console.log(`  ${c.cyan}${c.bold}║${c.reset}                                                   ${c.cyan}${c.bold}║${c.reset}`);
  console.log(`  ${c.cyan}${c.bold}╚═══════════════════════════════════════════════════╝${c.reset}`);
  console.log();
}

// ── Detection Phase ────────────────────────────────────────────

/** How each install layout reads in the detection summary. */
const LAYOUT_LABEL: Record<InstallLayout, string> = {
  monorepo: 'git clone (development)',
  folder: 'npm install folder',
  clone: 'public host clone',
  container: 'Docker image',
  'host-tree': 'host package',
  image: 'image-only folder',
  native: 'desktop app',
};

function printDetection(env: DetectedEnv, layout: InstallLayout) {
  heading('Detecting environment');

  const platformNames: Record<string, string> = {
    linux: 'Linux', macos: 'macOS', windows: 'Windows', wsl: 'Linux (WSL2)',
  };
  info(`Platform: ${c.bold}${platformNames[env.platform] ?? env.platform}${c.reset}`);

  if (env.docker) {
    info(`Docker: ${c.bold}available${c.reset} ${c.dim}(${env.dockerVersion}${env.dockerCompose ? '' : ', no Compose v2'})${c.reset}`);
  } else {
    const why = { missing: 'not installed', daemon: 'its daemon does not answer', permission: 'this user may not open its socket' }[env.dockerCause ?? 'daemon'];
    step(`Docker: ${c.dim}not available (${why})${env.dockerCompose ? '' : ', no Compose v2'}${c.reset}`);
  }

  if (env.qdrant.running) {
    info(`Qdrant: ${c.bold}running${c.reset} on ${c.dim}${env.qdrant.url}${c.reset}${env.qdrant.version ? ` ${c.dim}(v${env.qdrant.version})${c.reset}` : ''}`);
  } else {
    step(`Qdrant: ${c.dim}not running${c.reset}`);
  }

  if (env.ollama.running) {
    const models = env.ollama.models.length > 0
      ? env.ollama.models.slice(0, 3).join(', ')
      : 'no models pulled';
    info(`Ollama: ${c.bold}running${c.reset} ${c.dim}(${models})${c.reset}`);
  } else {
    step(`Ollama: ${c.dim}not available${c.reset}`);
  }

  info(`Data dir: ${c.bold}${env.neuralisHome}${c.reset}${env.existingSetup ? ` ${c.dim}(existing setup found)${c.reset}` : ''}`);
  info(`Mode: ${c.bold}${LAYOUT_LABEL[layout]}${c.reset}`);
}

/** The image channel's half of a data-root refusal: the host path and the command, never a prompt. */
type ImageRun = { hostHome: string; fix: string[] };

function ownershipFixCommand(root: string, platform: import('./setup/detect.mts').Platform): string {
  if (platform === 'windows') {
    return `icacls "${root}" /grant "%USERNAME%":F /T`;
  }
  // linux, macos, wsl
  return `sudo chown -R "$(id -u)":"$(id -g)" "${root}"`;
}

/**
 * Returns true if `target` is owned by root but we are NOT root.
 * On Windows stat().uid is always 0 and getuid() doesn't exist — skip check.
 */
function isRootOwned(details: import('node:fs').Stats, platform: import('./setup/detect.mts').Platform): boolean {
  if (platform === 'windows') return false; // uid meaningless on Windows
  return details.uid === 0 && process.getuid?.() !== 0;
}

async function tryAutoFixOwnership(root: string, platform: import('./setup/detect.mts').Platform, image: ImageRun | null): Promise<void> {
  if (image) {
    // A sudo inside the image cannot reach the host folder Docker created.
    throw new CliExit(1, `Data root ${image.hostHome} is owned by root: Docker created it because it did not exist before \`docker run\`.`, [
      `On the host: ${ownershipFixCommand(image.hostHome, platform)}`,
      ...image.fix,
    ]);
  }
  const fixCmd = ownershipFixCommand(root, platform);
  fail(`Data root ${root} is owned by root (Docker likely created it).`);
  console.log(`  ${sym.arrow} Fix: ${c.bold}${fixCmd}${c.reset}`);
  blank();

  const answer = await ask('Attempt auto-fix with sudo?', 'y');
  if (answer.toLowerCase() === 'n') {
    throw new Error(`Fix ownership first, then re-run setup:\n  ${fixCmd}`);
  }

  const { execSync } = await import('node:child_process');
  try {
    execSync(fixCmd, { stdio: 'inherit' });
    info('Ownership fixed');
  } catch {
    throw new Error(`Could not fix ownership. Run manually:\n  ${fixCmd}`);
  }
}

async function ensureWritableOrExplain(
  target: string,
  root: string,
  platform: import('./setup/detect.mts').Platform,
  image: ImageRun | null,
): Promise<void> {
  const details = await stat(target).catch(() => null);

  // Check root ownership first — offer auto-fix
  if (details && isRootOwned(details, platform)) {
    await tryAutoFixOwnership(root, platform, image);
    return; // Re-check not needed — chown -R covers everything
  }

  try {
    await access(target, fsConstants.W_OK);
  } catch {
    const owner = details ? `${details.uid}:${details.gid}` : 'unknown';
    if (image) {
      // Never a uid test: the image user's id can be the host user's own.
      throw new CliExit(1, `Data root is not writable: ${target} (owner ${owner}).`, [
        'The image runs as its own user unless it is given yours: --user "$(id -u):$(id -g)".',
        ...image.fix,
      ]);
    }
    throw new Error(
      `Data root is not writable: ${target} (owner ${owner}). ` +
      `Fix ownership first, then re-run setup:\n  ${ownershipFixCommand(root, platform)}`,
    );
  }
}

async function preflightDataRoot(env: DetectedEnv, image: ImageRun | null): Promise<void> {
  const root = env.neuralisHome;

  try {
    await access(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      await ensureWritableOrExplain(root, root, env.platform, image);
      return;
    }
    try {
      await access(dirname(root), fsConstants.W_OK);
      return;
    } catch {
      throw new Error(
        `Cannot create data root at ${root}. Parent directory is not writable. ` +
        `Check permissions for ${dirname(root)} and re-run setup.`,
      );
    }
  }

  // Root exists — check ownership on the root dir itself first
  const rootStats = await stat(root).catch(() => null);
  if (rootStats && isRootOwned(rootStats, env.platform)) {
    await tryAutoFixOwnership(root, env.platform, image);
    // After fix, all children are fixed too — skip per-path checks
    return;
  }

  const criticalPaths = [
    root,
    join(root, 'app'),
    join(root, 'projects'),
    join(root, 'app', 'users'),
    join(root, 'app', 'projects'),
    join(root, 'app', 'config'),
  ];

  for (const path of criticalPaths) {
    try {
      await access(path);
      await ensureWritableOrExplain(path, root, env.platform, image);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
  }
}

// ── Owner Account ──────────────────────────────────────────────

async function askOwner(): Promise<{ email: string; name: string; passwordHash: string }> {
  heading('Owner Account');
  console.log(`  ${c.dim}This will be the admin user with full access.${c.reset}`);
  blank();

  const email = await ask('Email');
  if (!email || !email.includes('@')) throw new CliExit(1, 'A valid email is required.');

  // Typed twice: a hidden typo would lock the only owner out of a fresh install.
  let password = '';
  while (!password) {
    const first = await askPassword('Password (min 8 chars, hidden)');
    if (first.length < 8) {
      warn('Password must be at least 8 characters.');
      continue;
    }
    if (await askPassword('Confirm password (hidden)') !== first) {
      warn('The passwords do not match — enter it again.');
      continue;
    }
    password = first;
  }

  const name = await ask('Name', email.split('@')[0] ?? 'admin');
  const passwordHash = await bcrypt.hash(password, 12);

  blank();
  info(`Owner: ${c.bold}${name}${c.reset} <${email}>`);

  return { email: email.toLowerCase().trim(), name, passwordHash };
}

// ── LLM API Keys ───────────────────────────────────────────────

async function askLlmKeys(): Promise<Record<string, string>> {
  heading('AI Providers');
  console.log(`  ${c.dim}Each provider key unlocks that provider's available models in Neuralis.${c.reset}`);
  console.log(`  ${c.dim}Press Enter to skip any provider. OpenAI is configured separately below.${c.reset}`);
  blank();

  const keys: Record<string, string> = {};

  const providers = [
    { env: 'ANTHROPIC_API_KEY', name: 'Anthropic (Claude)', hint: 'recommended' },
    { env: 'GEMINI_API_KEY', name: 'Google Gemini', hint: '' },
    { env: 'DEEPSEEK_API_KEY', name: 'DeepSeek', hint: '' },
  ];

  for (const p of providers) {
    const label = p.hint ? `${p.name} API key ${c.dim}(${p.hint})${c.reset}` : `${p.name} API key`;
    const val = await askSensitive(label);
    if (val) keys[p.env] = val;
  }

  const hasMore = await ask(`Configure more providers? ${c.dim}(minimax, kimi, qwen, xai)${c.reset}`, 'n');
  if (hasMore.toLowerCase() === 'y') {
    const extra = [
      { env: 'MINIMAX_API_KEY', name: 'MiniMax' },
      { env: 'KIMI_API_KEY', name: 'Kimi' },
      { env: 'QWEN_API_KEY', name: 'Qwen' },
      { env: 'XAI_API_KEY', name: 'xAI Grok' },
    ];
    for (const p of extra) {
      const val = await askSensitive(`${p.name} API key`);
      if (val) keys[p.env] = val;
    }
  }

  blank();
  const count = Object.keys(keys).length;
  if (count === 0) {
    warn('No API keys configured. Add keys via Admin panel or re-run setup.');
  } else {
    info(`${count} provider${count > 1 ? 's' : ''} configured`);
  }

  return keys;
}

// ── OpenAI: API key + Sign in with ChatGPT (Codex OAuth) ────────

// Inlined Codex OAuth constants — duplicated from agent-core's
// `providers/openai-codex/oauth/*` to keep setup.mts self-contained
// (the file already follows this precedent for CredentialStore crypto).
const CODEX_CLIENT_ID_SETUP = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_AUTHORIZE_URL_SETUP = 'https://auth.openai.com/oauth/authorize';
const CODEX_TOKEN_URL_SETUP = 'https://auth.openai.com/oauth/token';
const CODEX_AUTH_CLAIM_KEY_SETUP = 'https://api.openai.com/auth';
const CODEX_STATE_PREFIX_SETUP = 'codex_';
const CODEX_SCOPES_SETUP = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'api.connectors.read',
  'api.connectors.invoke',
];
const CODEX_REDUCED_SCOPES_SETUP = ['openid', 'profile', 'email', 'offline_access'];
type OpenAIAuth = { apiKey?: string; codexBlob?: CodexTokenBlobSetup };

function base64UrlEncode(bytes: Buffer): string {
  return bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecodeSetup(segment: string): string {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  const padded = pad === 0 ? normalized : normalized + '='.repeat(4 - pad);
  return Buffer.from(padded, 'base64').toString('utf-8');
}

function parseIdTokenSetup(jwt: string): { accountId?: string; planType?: string; isFedramp?: boolean } | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(base64UrlDecodeSetup(parts[1])) as Record<string, unknown>;
    const auth = (payload[CODEX_AUTH_CLAIM_KEY_SETUP] ?? {}) as Record<string, unknown>;
    return {
      accountId: typeof auth.chatgpt_account_id === 'string' ? (auth.chatgpt_account_id as string) : undefined,
      planType: typeof auth.chatgpt_plan_type === 'string' ? (auth.chatgpt_plan_type as string) : undefined,
      isFedramp: typeof auth.chatgpt_account_is_fedramp === 'boolean'
        ? (auth.chatgpt_account_is_fedramp as boolean)
        : undefined,
    };
  } catch {
    return null;
  }
}

function parseJwtExpSetup(jwt: string): number | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(base64UrlDecodeSetup(parts[1])) as Record<string, unknown>;
    return typeof payload.exp === 'number' ? (payload.exp as number) : null;
  } catch {
    return null;
  }
}

function generatePkcePairSetup(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(64));
  const challenge = base64UrlEncode(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function buildCodexAuthorizeUrlSetup(params: {
  redirectUri: string;
  state: string;
  codeChallenge: string;
  scopeMode?: CodexScopeModeSetup;
}): string {
  const url = new URL(CODEX_AUTHORIZE_URL_SETUP);
  const scopes = (params.scopeMode ?? 'reduced') === 'full'
    ? CODEX_SCOPES_SETUP
    : CODEX_REDUCED_SCOPES_SETUP;
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CODEX_CLIENT_ID_SETUP);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', params.state);
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  // OpenAI's backend whitelists originators for the api.connectors.* scopes;
  // custom values fail with a generic `unknown_error`. Match the Codex Rust CLI.
  url.searchParams.set('originator', 'codex_cli_rs');
  return url.toString();
}

async function exchangeCodeForTokenSetup(
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<CodexTokenBlobSetup> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: CODEX_CLIENT_ID_SETUP,
    code_verifier: verifier,
  }).toString();
  const res = await fetch(CODEX_TOKEN_URL_SETUP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const raw = await res.text();
    throw new Error(`Code exchange failed: HTTP ${res.status} — ${raw.slice(0, 400)}`);
  }
  const data = (await res.json()) as {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!data.access_token || !data.refresh_token) {
    throw new Error('Code exchange response missing access_token or refresh_token');
  }
  const claims = data.id_token ? parseIdTokenSetup(data.id_token) : null;
  if (!claims?.accountId) {
    throw new Error(
      'id_token is missing chatgpt_account_id claim — the authorize URL must include id_token_add_organizations=true',
    );
  }
  const expSeconds = parseJwtExpSetup(data.access_token);
  const expires = expSeconds ?? Math.floor(Date.now() / 1000) + (data.expires_in ?? 28800);
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires,
    accountId: claims.accountId,
    planType: claims.planType,
    isFedramp: claims.isFedramp === true,
    lastRefresh: Date.now(),
  };
}

async function importCodexAuthFromCli(): Promise<CodexTokenBlobSetup> {
  const { readCodexCliAuth } = await import('./setup/codexCliAuth.mts');
  const imported = await readCodexCliAuth();
  if (!imported) {
    throw new Error('No official Codex auth cache found at ~/.codex/auth.json');
  }
  return {
    access: imported.blob.access,
    refresh: imported.blob.refresh,
    expires: imported.blob.expires,
    accountId: imported.blob.accountId,
    planType: imported.blob.planType,
    isFedramp: imported.blob.isFedramp,
    lastRefresh: imported.blob.lastRefresh,
  };
}

/** Spin up a one-shot loopback HTTP server on the first free port in [1455, 1475]. */
async function bindCallbackServer(
  onRequest: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ port: number; close: () => void }> {
  for (let port = 1455; port <= 1475; port++) {
    try {
      const server = createServer(onRequest);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      return { port, close: () => server.close() };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw err;
    }
  }
  throw new Error('No free loopback port in 1455–1475 — close other OAuth-listening tools and retry.');
}

/** Best-effort browser launcher. Returns true if a child process was spawned. */
function openBrowser(url: string): boolean {
  const openers: Array<[string, string[]]> = [
    ['xdg-open', [url]],
    ['open', [url]],
    ['cmd.exe', ['/c', 'start', '', url]],
    ['powershell.exe', ['-NoProfile', '-Command', `Start-Process "${url}"`]],
  ];
  for (const [cmd, args] of openers) {
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function runCodexOAuthInline(scopeMode: CodexScopeModeSetup): Promise<CodexTokenBlobSetup> {
  const { verifier, challenge } = generatePkcePairSetup();
  const state = `${CODEX_STATE_PREFIX_SETUP}${base64UrlEncode(randomBytes(32))}`;

  // Capture the callback params on the first request to the loopback server.
  let resolveCallback: (params: { code: string; state: string }) => void = () => {};
  let rejectCallback: (err: Error) => void = () => {};
  const callbackPromise = new Promise<{ code: string; state: string }>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  const { port, close } = await bindCallbackServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1`);
    if (url.pathname !== '/auth/callback') {
      res.statusCode = 404;
      res.end();
      return;
    }
    const code = url.searchParams.get('code');
    const st = url.searchParams.get('state');
    const err = url.searchParams.get('error');
    if (err) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<h1>Neuralis OAuth error</h1><p>${escapeHtml(err)}</p><p>You can close this tab.</p>`);
      rejectCallback(new Error(`OAuth error: ${err}`));
      return;
    }
    if (!code || !st) {
      res.statusCode = 400;
      res.end('Missing code or state');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      `<h1>Neuralis is signed in to ChatGPT.</h1><p>You can close this tab and return to the setup terminal.</p>`,
    );
    resolveCallback({ code, state: st });
  });

  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
  const authorizeUrl = buildCodexAuthorizeUrlSetup({
    redirectUri,
    state,
    codeChallenge: challenge,
    scopeMode,
  });

  console.log();
  console.log(`  ${c.cyan}Opening ChatGPT in your browser…${c.reset}`);
  console.log(`  ${c.dim}Scope mode: ${scopeMode === 'full' ? 'full (includes api.connectors.*)' : 'reduced (no api.connectors.*)'}${c.reset}`);
  const opened = openBrowser(authorizeUrl);
  if (!opened) {
    warn('Could not auto-open a browser. Open this URL manually:');
  } else {
    console.log(`  ${c.dim}If no browser opened, copy this URL:${c.reset}`);
  }
  console.log(`  ${c.bold}${authorizeUrl}${c.reset}`);
  console.log();
  console.log(`  ${c.dim}Listening on ${redirectUri} — waiting for the redirect (5 min)…${c.reset}`);

  const timeoutMs = 5 * 60 * 1000;
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('OAuth timed out after 5 minutes')), timeoutMs),
  );

  try {
    const { code, state: returnedState } = await Promise.race([callbackPromise, timeout]);
    if (returnedState !== state) {
      throw new Error('OAuth state mismatch — possible CSRF, aborting.');
    }
    const blob = await exchangeCodeForTokenSetup(code, verifier, redirectUri);
    info(`Signed in as ${c.bold}${blob.accountId}${c.reset}${blob.planType ? ` · plan: ${blob.planType}` : ''}`);
    return blob;
  } finally {
    close();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );
}

async function askOpenAIAuth(): Promise<OpenAIAuth> {
  heading('OpenAI');
  console.log(`  ${c.dim}OpenAI can be wired two ways:${c.reset}`);
  console.log(`  ${c.dim}  · API key → per-token billing (gpt-5.x, o3 …)${c.reset}`);
  console.log(`  ${c.dim}  · Sign in with ChatGPT → ChatGPT Plus/Pro subscription (Codex models)${c.reset}`);
  console.log(`  ${c.dim}Preflight: OpenAI workspace controls / RBAC may still block Codex, and GitHub is required for some Codex cloud surfaces.${c.reset}`);
  console.log(`  ${c.dim}If browser OAuth keeps failing, import the official Codex login from ~/.codex/auth.json.${c.reset}`);
  blank();

  const idx = await askChoice('How do you want to connect OpenAI?', [
    'Enter an API key',
    'Sign in with ChatGPT (OAuth, subscription)',
    'Import existing official Codex login (~/.codex/auth.json)',
    'Both (API key now, then sign in/import)',
    'Skip — configure later',
  ], 0);

  const result: OpenAIAuth = {};

  if (idx === 0 || idx === 3) {
    const val = await askSensitive('OpenAI API key');
    if (val) result.apiKey = val;
  }

  if (idx === 1 || idx === 2 || idx === 3) {
    const authMode = idx === 2
      ? 'import'
      : await askChoice('Codex auth source', [
          `Neuralis-managed OAuth ${c.dim}(browser PKCE flow)${c.reset}`,
          `Import existing official Codex login ${c.dim}(recommended fallback from ~/.codex/auth.json)${c.reset}`,
        ], 0);
    if (authMode === 'import' || authMode === 1) {
      try {
        result.codexBlob = await importCodexAuthFromCli();
        info(`Imported official Codex login for ${c.bold}${result.codexBlob.accountId}${c.reset}`);
      } catch (err) {
        fail(`Codex auth import failed: ${(err as Error).message}`);
        warn('Continuing without a Codex OAuth credential. You can import or connect later in the Admin panel.');
      }
    } else {
      blank();
      const scopeIdx = await askChoice('ChatGPT OAuth scopes', [
        `Reduced scopes ${c.dim}(recommended, avoids api.connectors.* entitlement failures)${c.reset}`,
        `Full scopes ${c.dim}(official Codex CLI parity, includes api.connectors.read/invoke)${c.reset}`,
      ], 0);
      const scopeMode: CodexScopeModeSetup = scopeIdx === 1 ? 'full' : 'reduced';
      try {
        result.codexBlob = await runCodexOAuthInline(scopeMode);
      } catch (err) {
        fail(`ChatGPT sign-in failed: ${(err as Error).message}`);
        if (scopeMode === 'full') {
          warn('If OpenAI showed unknown_error, retry with reduced scopes. That usually means the account lacks api.connectors.* entitlement.');
        }
        warn('Continuing without a Codex OAuth credential. You can connect later in the Admin panel.');
      }
    }
  }

  if (idx === 4) {
    warn('OpenAI skipped. Add later in the Admin panel.');
  }

  return result;
}

// ── Deployment mode + docker-aware URL rewriting ────────────────

async function askDeploymentMode(env: DetectedEnv): Promise<'native' | 'docker'> {
  heading('Deployment mode');
  console.log(`  ${c.dim}Where will neuralis run? This decides how platform.json records${c.reset}`);
  console.log(`  ${c.dim}local service URLs (Ollama, LM Studio, …).${c.reset}`);
  blank();

  const defaultIdx = env.docker ? 0 : 1;
  const idx = await askChoice('Pick a deployment mode', [
    `Docker stack ${c.dim}(docker compose up — host.docker.internal rewrite)${c.reset}`,
    `Native ${c.dim}(pnpm dev:app / pnpm start on this shell — raw 127.0.0.1)${c.reset}`,
  ], defaultIdx);
  const mode: 'native' | 'docker' = idx === 0 ? 'docker' : 'native';
  info(`Deployment mode: ${c.bold}${mode}${c.reset}`);
  return mode;
}

// ── Qdrant Setup ───────────────────────────────────────────────

/**
 * External mode never MINTS a key (the server belongs to someone else — a
 * minted value would be one nobody configured). The wizard asks; empty means
 * the server is unauthenticated. The carry-over preserves a typed key.
 *
 * Masked entry, and the carried value is never rendered (a plain `ask` prints
 * its default verbatim and echoes the typed key — both leak to the terminal
 * and any transcript of it). Enter keeps a carried key; `-` clears it.
 */
async function askExternalQdrantKey(carriedKey: string | null): Promise<string | null> {
  step(`${c.dim}If the server enforces an API key, enter it; leave empty for an unauthenticated one.${c.reset}`);
  if (carriedKey) {
    const answered = (await askSensitive("Qdrant API key [set — Enter keeps it, '-' clears]")).trim();
    if (!answered) return carriedKey;
    return answered === '-' ? null : answered;
  }
  const answered = (await askSensitive('Qdrant API key')).trim();
  return answered || null;
}

/**
 * The Qdrant version this install's storage is on — recorded, or bootstrapped
 * from what the probe observes — checked against the gap rule. Throws when
 * setup must refuse; the caller has written no Qdrant artifact at that point.
 */
async function resolveInstallQdrantVersion(probe: QdrantInstallProbe, neuralisHome: string): Promise<string> {
  const resolution = await resolveQdrantState({ statePath: qdrantStatePath(neuralisHome), probe });
  if (resolution.kind === 'refuse') throw new Error(resolution.message);
  const { state } = resolution;
  if (resolution.created) {
    info(`Qdrant version recorded: ${c.bold}${state.version}${c.reset} ${c.dim}(${state.source}, ${qdrantStatePath(neuralisHome)})${c.reset}`);
  }
  const gap = assessQdrantGap(state.version);
  if (gap.kind === 'refuse') throw new Error(`${gap.message}\n  No compose file or Qdrant binary was written.`);
  if (gap.kind === 'behind') {
    warn(`Qdrant ${state.version} runs here; this host ships ${QDRANT_TARGET_VERSION}. Move it with \`${QDRANT_UPGRADE_COMMAND}\`.`);
  }
  return state.version;
}

async function ensureQdrant(
  env: DetectedEnv,
  carried: CarriedOverEnv,
  answer: QdrantAnswer,
  freePortAbove: (port: number) => Promise<number>,
  advanced: boolean,
  noDocker: NoDockerChoice | null,
): Promise<SetupConfig['qdrant'] & { runningVersion: string | null }> {
  heading('Vector Search (Qdrant)');
  const carriedKey = carried.qdrantApiKey;
  const port = carried.qdrantPort;

  // The self-provisioned modes resolve carry ?? mint; the mint is hex on
  // purpose (an HTTP header value — no `+`/`=` surprises). Never printed.
  const mintKey = () => randomBytes(32).toString('hex');
  const reportKey = (apiKey: string | null): void => {
    if (apiKey && apiKey === carriedKey) {
      step('Qdrant API key preserved from the existing .env.');
    } else if (apiKey) {
      info(`Qdrant API key: ${c.dim}generated (stored in .env, value never printed)${c.reset}`);
    }
  };

  // This install's own server answers: a re-run keeps its mode and never asks again.
  if (answer?.owner === 'own') {
    info(`Qdrant: this install's own (${carried.qdrantMode}) answers on ${c.bold}${answer.url}${c.reset}`);
    if (carried.qdrantMode === 'docker') {
      const apiKey = resolveQdrantApiKey('docker', carriedKey, mintKey);
      reportKey(apiKey);
      return { url: `http://localhost:${port}`, mode: 'docker', apiKey, port, runningVersion: answer.version };
    }
    // A running binary serves with the key it was started with — never a new one.
    if (carried.qdrantMode === 'binary') return { url: answer.url, mode: 'binary', apiKey: carriedKey, port, runningVersion: answer.version };
    return { url: answer.url, mode: 'external', apiKey: await askExternalQdrantKey(carriedKey), port, runningVersion: null };
  }
  // Someone else's server: offered, never adopted.
  if (answer) {
    warn(`A Qdrant this install did not set up answers on ${c.bold}${answer.url}${c.reset}.`);
    const free = env.docker ? await freePortAbove(Number(new URL(answer.url).port || 80)) : null;
    const idx = await askChoice('Which Qdrant should this install use?', [
      ...(free !== null ? [`Its own, started with the stack on port ${free} ${c.dim}(recommended)${c.reset}`] : []),
      `The one at ${answer.url}, as an external server`,
      ...(free === null ? ['None for now (in-memory only)'] : []),
    ], 0);
    if (free !== null && idx === 0) {
      const apiKey = resolveQdrantApiKey('docker', carriedKey, mintKey);
      reportKey(apiKey);
      info(`Qdrant will be managed by the ${c.bold}app stack${c.reset} on port ${c.bold}${free}${c.reset}.`);
      return { url: `http://localhost:${free}`, mode: 'docker', apiKey, port: free, runningVersion: null };
    }
    if (free === null && idx === 1) {
      warn('Qdrant skipped. Using in-memory mode (data lost on restart).');
      return { url: '', mode: 'skip', apiKey: null, port, runningVersion: null };
    }
    return { url: answer.url, mode: 'external', apiKey: await askExternalQdrantKey(carriedKey), port, runningVersion: null };
  }

  console.log(`  ${c.dim}Qdrant provides persistent memory and semantic search.${c.reset}`);
  console.log(`  ${c.dim}Without it: keyword search only, no persistent memory.${c.reset}`);
  blank();

  // Docker available → prefer compose-managed stack, no separate setup container.
  // Unasked, it is the default answer; `--advanced` offers the other two.
  if (env.docker) {
    const choice = advanced
      ? await askChoice('How to run Qdrant?', [
        `Docker stack ${c.dim}(recommended, starts with the app stack)${c.reset}`,
        'Use an external Qdrant URL',
        'Skip for now (in-memory only)',
      ])
      : 0;

    if (choice === 1) {
      const url = await ask('Qdrant URL', `http://localhost:${DEFAULT_QDRANT_PORT}`);
      step('Testing connection...');
      const healthy = await waitForQdrant(url, 3, 1000);
      if (healthy) {
        info(`Qdrant reachable at ${c.bold}${url}${c.reset}`);
      } else {
        warn('Could not reach Qdrant right now. Neuralis will try that URL at runtime.');
      }
      const apiKey = await askExternalQdrantKey(carriedKey);
      return { url, mode: 'external', apiKey, port, runningVersion: null };
    }

    if (choice === 2) {
      warn('Qdrant skipped. Using in-memory mode (data lost on restart).');
      return { url: '', mode: 'skip', apiKey: null, port, runningVersion: null };
    }

    info(`Qdrant will be managed by the ${c.bold}app stack${c.reset}, not by setup.`);
    if (env.isClone) {
      step('Start it later with: cd neuralis && docker compose up -d');
    } else {
      step('Start it later with: docker compose up -d');
    }
    const apiKey = resolveQdrantApiKey('docker', carriedKey, mintKey);
    reportKey(apiKey);
    return { url: `http://localhost:${port}`, mode: 'docker', apiKey, port, runningVersion: null };
  }

  // No Docker → the operator's early answer (`askNoDocker`) decides: the native binary or
  // in-memory. `--advanced` still offers the full set (an external URL too), defaulting to it.
  const early = noDocker === 'native' ? 0 : 2;
  const choice = advanced
    ? await askChoice('Qdrant is not running. Options:', [
      `Download Qdrant binary ${c.dim}(script handles everything)${c.reset}`,
      'Enter external Qdrant URL',
      'Skip (in-memory only, not recommended)',
    ], early)
    : early;

  if (choice === 0) {
    const binDir = join(env.neuralisHome, 'bin');
    const version = await resolveInstallQdrantVersion(
      binaryInstallProbe({
        storageDir: join(env.neuralisHome, 'qdrant-storage'),
        binaryPath: join(binDir, qdrantBinaryName()),
        runningVersion: null,
      }),
      env.neuralisHome,
    );
    step(`Downloading Qdrant ${version}...`);
    // A failed download (network, a checksum mismatch) is named and leaves the install
    // in-memory: nothing was unpacked, and a re-run tries again.
    let binaryPath: string | null;
    try {
      binaryPath = await downloadQdrantBinary(binDir, version);
    } catch (err) {
      fail(`Qdrant download failed: ${err instanceof Error ? err.message : String(err)}`);
      warn('Qdrant skipped. Using in-memory mode (data lost on restart) — re-run setup to try again.');
      return { url: '', mode: 'skip', apiKey: null, port, runningVersion: null };
    }
    if (!binaryPath) {
      fail(`No Qdrant binary is published for ${process.platform}/${process.arch}.`);
      warn('Install Qdrant manually or use Docker.');
      return { url: '', mode: 'skip', apiKey: null, port, runningVersion: null };
    }
    info('Qdrant binary installed');

    // Resolved BEFORE the spawn: a keyless native server with keyed clients
    // is an outage, not a fallback — the spawn env carries the same key the
    // clients will send.
    const apiKey = resolveQdrantApiKey('binary', carriedKey, mintKey);
    reportKey(apiKey);

    // Its own two loopback ports: the recorded ones, or the next free ones when another program holds them.
    const settled = await settleLoopbackPorts([
      { key: 'qdrant', port, address: '127.0.0.1' },
      { key: 'qdrantGrpc', port: carried.qdrantGrpcPort, address: '127.0.0.1' },
    ]);
    const ports = { http: settled.get('qdrant')!, grpc: settled.get('qdrantGrpc')! };
    const url = `http://localhost:${ports.http}`;
    step('Starting Qdrant...');
    const storageDir = join(env.neuralisHome, 'qdrant-storage');
    await startQdrantBinary(binDir, storageDir, apiKey ?? undefined, ports);

    step('Waiting for Qdrant...');
    const healthy = await waitForQdrant(url);
    if (healthy) {
      info(`Qdrant running on ${c.bold}${url}${c.reset}`);
    } else {
      warn('Qdrant started but health check timed out.');
    }
    return { url, mode: 'binary', apiKey, port: ports.http, grpcPort: ports.grpc, runningVersion: null };
  }

  if (choice === 1) {
    const url = await ask('Qdrant URL', `http://localhost:${DEFAULT_QDRANT_PORT}`);
    step('Testing connection...');
    const healthy = await waitForQdrant(url, 3, 1000);
    if (healthy) {
      info(`Qdrant reachable at ${c.bold}${url}${c.reset}`);
    } else {
      warn('Could not reach Qdrant. Verify the URL and try again.');
    }
    const apiKey = await askExternalQdrantKey(carriedKey);
    return { url, mode: 'external', apiKey, port, runningVersion: null };
  }

  warn('Qdrant skipped. Using in-memory mode (data lost on restart).');
  return { url: '', mode: 'skip', apiKey: null, port, runningVersion: null };
}

type NoDockerChoice = 'native' | 'memory';

/**
 * A checkout with no reachable Docker: ONE question before anything is written, because the
 * vector store and the virtual desktop both run in Docker. Nothing is chosen for the operator —
 * Enter is "install Docker first", which writes nothing.
 */
async function askNoDocker(): Promise<NoDockerChoice | 'install'> {
  blank();
  console.log(`  ${c.yellow}Docker is not installed or not reachable. The vector store (Qdrant) and the virtual desktop need it.${c.reset}`);
  console.log('    [1] Install Docker first (recommended) — prints the link, writes nothing, re-run setup after');
  console.log('    [2] Continue natively — native Qdrant binary, no virtual desktop');
  console.log('    [3] Continue in-memory only — memory is lost on restart');
  for (;;) {
    const answer = await ask('How do you want to continue?', '1');
    if (answer === '1') return 'install';
    if (answer === '2') return 'native';
    if (answer === '3') return 'memory';
    fail('Answer 1, 2 or 3.');
  }
}

// ── Host ports ─────────────────────────────────────────────────

/**
 * Every busy port named with its holder, the next free one offered — Enter
 * accepts, another answer is checked too. The callback port cannot move: its
 * holder is handed to the callback question instead.
 */
async function settlePorts(claims: PortClaim[], check: PortCheck, ownProject: string): Promise<{ ports: PortTriple; qdrantPort: number | null; codexHolder: string | null | undefined }> {
  const busy = await findBusyPorts(claims, { ownProject, ...check });
  const chosen = new Map(claims.map((claim) => [claim.key, claim.port]));
  const movable = busy.filter((b) => b.key !== 'codex');
  if (movable.length > 0) {
    heading('Ports');
    const offered = await nextFreePorts(movable, claims.map((claim) => claim.port), { probe: check.probe, published: await check.published() });
    for (const b of movable) {
      const role = PORT_ROLES[b.key]!;
      warn(`Port ${b.port} (${role.label}) is in use${b.holder ? ` — held by ${b.holder}` : ''}.`);
      for (;;) {
        const port = Number(await ask(`Use port for ${role.label}`, String(offered.get(b.key))));
        const clash = [...chosen].some(([key, other]) => key !== b.key && other === port);
        if (!Number.isInteger(port) || port < 1 || port > 65535 || clash) { fail('Not a free port number for this install.'); continue; }
        if (port !== offered.get(b.key) && (await check.probe([{ ...b, port }])).length > 0) { fail(`Port ${port} is in use too.`); continue; }
        chosen.set(b.key, port);
        info(`${role.label}: port ${c.bold}${port}${c.reset}`);
        break;
      }
    }
  }
  const codex = busy.find((b) => b.key === 'codex');
  return {
    ports: { app: chosen.get('app')!, mcp: chosen.get('mcp')!, sandbox: chosen.get('sandbox')! },
    qdrantPort: chosen.get('qdrant') ?? null,
    codexHolder: codex ? codex.holder : undefined,
  };
}

// ── Vector (embeddings) Interactive Choice ─────────────────────

function tierIcon(tier: EmbeddingTier): string {
  switch (tier) {
    case 'free-local': return `${c.green}🟢${c.reset}`;
    case 'budget':     return `${c.yellow}🟡${c.reset}`;
    case 'flagship':   return `${c.magenta}🟠${c.reset}`;
    case 'multimodal': return `${c.cyan}✨${c.reset}`;
    case 'dev':        return `${c.dim}⚪${c.reset}`;
    case 'custom':     return `${c.white}◆${c.reset}`;
  }
}

function tierLabel(tier: EmbeddingTier): string {
  switch (tier) {
    case 'free-local': return 'Local, free';
    case 'budget':     return 'Budget cloud';
    case 'flagship':   return 'Flagship';
    case 'multimodal': return 'Multimodal';
    case 'dev':        return 'Dev / Deterministic';
    case 'custom':     return 'Custom endpoint';
  }
}

function priceLabel(m: EmbeddingModelInfo): string {
  if (m.pricePer1M === undefined) return m.tier === 'free-local' ? '$0' : '';
  return `$${m.pricePer1M.toFixed(2)}/1M`;
}

type MenuEntry = {
  label: string;
  models: EmbeddingModelInfo[];
  /** The custom-endpoint row: no catalog models, the operator describes one. */
  custom?: true;
  /** The no-embedding row: nothing is embedded, the data index and text search work. */
  none?: true;
};

/** The recommendation for a NEW install: Gemini Embedding 2 at its full 3072 dimensions. */
function recommendedEmbeddingModel(): EmbeddingModelInfo | undefined {
  return EMBEDDING_MODELS.find((m) => m.provider === 'gemini' && m.apiModelId === 'gemini-embedding-2');
}

/**
 * Every cloud provider is selectable: embedding runs on its OWN credential
 * (`embedding.<provider>`), asked for right after the model, so a chat key
 * entered above never decides what is available here.
 */
function buildMenu(env: DetectedEnv): MenuEntry[] {
  const byProvider = (p: string) => EMBEDDING_MODELS.filter((m) => m.provider === p);

  return [
    {
      // Ollama is always selectable: if the auto-probe missed it (custom port,
      // remote host, Docker), we prompt for a manual URL in chooseVectorConfig.
      label: env.ollama.running
        ? 'Ollama — local, free'
        : 'Ollama — local (enter URL manually if auto-detect missed it)',
      models: byProvider('ollama'),
    },
    { label: 'OpenAI — budget/flagship', models: byProvider('openai') },
    { label: 'Gemini — recommended: Gemini Embedding 2, multimodal (paid key)', models: byProvider('gemini') },
    { label: 'Qwen — flagship', models: byProvider('qwen') },
    { label: 'Voyage — Anthropic partner', models: byProvider('voyage') },
    { label: 'Custom endpoint — any OpenAI-compatible /v1/embeddings server', models: [], custom: true },
    { label: 'No embedding model — text and field search only (add one later in Admin → Vector)', models: [], none: true },
    {
      label: 'Deterministic — dev/test only (zero semantic quality)',
      models: byProvider('deterministic'),
    },
  ];
}

/**
 * Ask for the model's own embedding credential. `EMBEDDING_<PROVIDER>_API_KEY`
 * in the shell and the chat key entered above are offered as the Enter-default
 * — a prompt convenience, never a runtime fallback: the value is stored under
 * the embedding id, metered and capped apart from chat. Empty with no key
 * already stored = no embedding (`embeddingEnabled=false`, the model stays the
 * target); empty with a stored key keeps that key.
 */
async function askEmbeddingCredential(
  model: EmbeddingModelInfo,
  credentialId: string,
  llmKeys: Record<string, string>,
  hasStoredKey: boolean,
): Promise<{ id: string; value: string } | 'stored' | undefined> {
  blank();
  console.log(`  ${c.dim}Embedding uses its own key (${credentialId}) — counted and capped apart from chat.${c.reset}`);
  const envName = `EMBEDDING_${model.provider.toUpperCase()}_API_KEY`;
  const fromEnv = process.env[envName]?.trim();
  // The chat key for the same provider, if the wizard asked for one above.
  const chatEnv = Object.entries(LLM_CREDENTIAL_MAP).find(([, id]) => id === `llm.${model.provider}`)?.[0];
  const fromChat = chatEnv ? llmKeys[chatEnv]?.trim() : undefined;
  let value: string;
  if (fromEnv) {
    const use = (await ask(`Use ${c.bold}$${envName}${c.reset} from this shell? (Y/n)`, 'y')).toLowerCase();
    value = use === 'n' ? (await askSensitive(`${model.provider} embedding API key`)).trim() : fromEnv;
  } else if (fromChat) {
    const use = (await ask(`Use the ${model.provider} key you entered above, stored separately as ${credentialId}? (Y/n)`, 'y')).toLowerCase();
    value = use === 'n' ? (await askSensitive(`${model.provider} embedding API key`)).trim() : fromChat;
  } else {
    value = (await askSensitive(`${model.provider} embedding API key`)).trim();
  }
  if (!value) {
    if (hasStoredKey) {
      info(`No key entered — keeping the stored ${c.bold}${credentialId}${c.reset}.`);
      return 'stored';
    }
    warn(`No key entered — embedding is OFF (text and field search only). Set ${c.bold}${credentialId}${c.reset} in Admin → Credentials and turn embedding on to activate ${model.id}.`);
    return undefined;
  }
  info(`${credentialId} captured ${c.dim}(written to the credential store)${c.reset}`);
  return { id: credentialId, value };
}

/**
 * The custom-endpoint row: one OpenAI-compatible `/v1/embeddings` server,
 * validated by the kernel's own parser (the admin route's `write` mode) before
 * it is seeded. The address check the admin route runs happens at connect time
 * for every path; the wizard states it rather than implying it ran here.
 */
async function askEmbeddingEndpoint(
  deploymentMode: 'native' | 'docker',
): Promise<Pick<VectorChoice, 'modelId' | 'dimension' | 'endpoint' | 'credential'>> {
  for (;;) {
    blank();
    const label = (await ask('Label', 'My embedding server')).trim() || 'My embedding server';
    const id = slugify(label) || 'embedding';
    const baseUrl = (await ask('Base URL (the client appends /v1/embeddings)', 'http://127.0.0.1:8080')).trim();
    const modelName = (await ask('Model name (the request `model` field)', '')).trim();
    const dimension = Number((await ask('Vector dimension this model returns', '1024')).trim());
    const auth = await askEndpointAuth();
    const network = await askEndpointNetwork(baseUrl);
    const parsed = parseOperatorEndpoints(
      [{
        id,
        label,
        baseUrl: hostReachableUrl(baseUrl, deploymentMode),
        kind: 'openai-compat',
        enabled: true,
        auth: auth.auth,
        network,
        models: [{ id: modelName, dimension, modalities: ['text'] }],
      }],
      'write',
      EMBEDDING_ENDPOINT_SHAPE,
    );
    if (!parsed.ok) {
      warn(`Not a valid endpoint: ${parsed.error}`);
      continue;
    }
    const endpoint = parsed.entries[0]!;
    info(`Endpoint ${c.bold}${endpoint.id}${c.reset} → ${endpoint.baseUrl}`);
    return {
      modelId: `endpoint:${endpoint.id}:${modelName}`,
      dimension,
      endpoint,
      ...(auth.key ? { credential: { id: embeddingEndpointCredentialId(endpoint.id), value: auth.key } } : {}),
    };
  }
}

async function pickDimension(info: EmbeddingModelInfo): Promise<number> {
  const options = enumerateSupportedDimensions(info);
  if (options.length <= 1) return info.defaultDimension;

  const defaultIdx = Math.max(0, options.indexOf(info.defaultDimension));
  console.log(`  ${c.dim}Available dimensions for ${info.apiModelId}:${c.reset}`);
  const labels = options.map((d) => `${d}${d === info.defaultDimension ? ` ${c.dim}(default)${c.reset}` : ''}`);
  const idx = await askChoice('Pick a dimension', labels, defaultIdx);
  return options[idx] ?? info.defaultDimension;
}

async function chooseVectorConfig(
  env: DetectedEnv,
  llmKeys: Record<string, string>,
  qdrantMode: string,
  deploymentMode: 'native' | 'docker',
  localLLMs: LocalLLMEntry[],
  advanced: boolean,
  ollamaChoice: OllamaMode | null,
): Promise<VectorChoice> {
  heading('Vector (embeddings)');

  if (qdrantMode === 'skip') {
    info(`Qdrant skipped — no embedding (text and field search only)`);
    return { enabled: false };
  }

  // An Ollama the operator CHOSE (`--ollama existing|docker`) embeds locally from the start: the
  // pinned model, enabled, no key needed. Without the choice the Gemini default below stands.
  const chosenOllama = ollamaChoice === 'existing' || ollamaChoice === 'docker'
    ? localLLMs.find((e) => e.kind === 'ollama-native' && e.enabled)
    : undefined;
  if (chosenOllama) {
    info(`Embedding: ${c.bold}${OLLAMA_EMBEDDING_MODEL_ID}${c.reset} ${c.dim}(${OLLAMA_EMBEDDING_TAG}, local — no key)${c.reset}`);
    if (ollamaChoice === 'existing' && env.ollama.running && !env.ollama.models.includes(OLLAMA_EMBEDDING_TAG)) {
      step(`Pulling ${OLLAMA_EMBEDDING_TAG} into ${env.ollama.url}…`);
      if (await pullOllamaModel(OLLAMA_EMBEDDING_TAG, env.ollama.url)) info(`Pulled ${c.bold}${OLLAMA_EMBEDDING_TAG}${c.reset}`);
      else warn(`Could not pull ${OLLAMA_EMBEDDING_TAG}: run \`ollama pull ${OLLAMA_EMBEDDING_TAG}\`; indexing waits for it.`);
    } else if (ollamaChoice === 'docker') {
      console.log(`  ${c.dim}After \`docker compose up -d\`: docker compose exec ollama ollama pull ${OLLAMA_EMBEDDING_TAG} (indexing waits for it).${c.reset}`);
    }
    return { enabled: true, modelId: OLLAMA_EMBEDDING_MODEL_ID, dimension: OLLAMA_EMBEDDING_DIMENSION, ollamaUrl: chosenOllama.baseUrl };
  }

  const recommended = recommendedEmbeddingModel();
  // Unasked, the target is the recommended model and embedding stays off until its key is in
  // the app: no provider is called, indexing and text/field search work meanwhile.
  if (!advanced) {
    if (!recommended) return { enabled: false };
    info(`Embedding target: ${c.bold}${recommended.id}${c.reset} ${c.dim}@${recommended.defaultDimension} — off until its key is added in the app${c.reset}`);
    return { enabled: false, modelId: recommended.id, dimension: recommended.defaultDimension };
  }

  const menu = buildMenu(env);
  console.log(`  ${c.dim}Pick an embedding provider. Recommended for a new install: ${recommended ? `${recommended.apiModelId} @${recommended.defaultDimension}` : 'a cloud model'}.${c.reset}`);
  console.log(`  ${c.dim}An existing install keeps the model it has; changing it later rebuilds the index from the Vector section.${c.reset}`);
  blank();

  const defaultProvider = Math.max(0, menu.findIndex((m) => recommended !== undefined && m.models.includes(recommended)));
  const chosen = await askChoice('Which provider?', menu.map((m) => m.label), defaultProvider);

  if (menu[chosen].custom) {
    return { enabled: true, ...await askEmbeddingEndpoint(deploymentMode) };
  }
  if (menu[chosen].none) {
    info(`No embedding — indexing, text and field search work; no provider is called.`);
    return { enabled: false };
  }

  const providerModels = menu[chosen].models;
  let model: EmbeddingModelInfo;
  if (providerModels.length === 1) {
    model = providerModels[0];
  } else {
    blank();
    const modelLabels = providerModels.map(
      (m) => `${tierIcon(m.tier)} ${c.bold}${m.apiModelId}${c.reset} — ${m.label} ${c.dim}${priceLabel(m)}${c.reset}${m.preview ? ` ${c.yellow}(preview)${c.reset}` : ''}`,
    );
    const defaultModel = Math.max(0, recommended ? providerModels.indexOf(recommended) : 0);
    const idx = await askChoice('Pick a model', modelLabels, defaultModel);
    model = providerModels[idx] ?? providerModels[0];
  }

  info(`Selected: ${c.bold}${model.id}${c.reset} ${c.dim}${tierLabel(model.tier)} · ${priceLabel(model)}${c.reset}`);
  if (model.provider === 'gemini') {
    warn('Use a PAID Gemini key: on the free tier Google may use the content you embed to improve its products.');
  }

  // Ollama model pull: ensure the chosen model is installed locally.
  if (model.provider === 'ollama') {
    // If auto-detect missed Ollama, let the user enter the URL now.
    if (!env.ollama.running) {
      blank();
      console.log(`  ${c.dim}Ollama was not auto-detected at ${env.ollama.url}.${c.reset}`);
      const manual = (await ask('Ollama URL (leave blank to skip pull)', env.ollama.url)).trim();
      if (manual) {
        env.ollama.url = manual;
        try {
          // Re-probe once at the provided URL so subsequent platform.json is correct.
          const probe = await fetch(`${manual.replace(/\/$/, '')}/api/tags`);
          if (probe.ok) {
            const parsed = (await probe.json()) as { models?: Array<{ name: string }> };
            env.ollama.running = true;
            env.ollama.models = (parsed.models ?? []).map((m) => m.name);
            info(`Ollama reachable at ${c.bold}${manual}${c.reset}`);
          } else {
            warn(`Ollama at ${manual} returned HTTP ${probe.status}`);
          }
        } catch (err) {
          warn(`Could not reach ${manual}: ${String((err as Error)?.message ?? err)}`);
        }
      }
    }
    const installed = env.ollama.models.includes(model.apiModelId);
    if (!installed && env.ollama.running) {
      step(`Pulling Ollama model ${model.apiModelId}...`);
      const ok = await pullOllamaModel(model.apiModelId, env.ollama.url);
      if (ok) {
        info(`Pulled ${c.bold}${model.apiModelId}${c.reset}`);
      } else {
        warn(`Could not auto-pull ${model.apiModelId}. Run 'ollama pull ${model.apiModelId}' later.`);
      }
    }
  }

  const storedKey = model.credentialId !== undefined
    && existsSync(join(credentialDir(env.neuralisHome, { kind: 'global' }), `${model.credentialId}.enc.json`));
  const credential = model.credentialId ? await askEmbeddingCredential(model, model.credentialId, llmKeys, storedKey) : undefined;

  blank();
  const dimension = await pickDimension(model);

  // A model that needs a key and got none embeds nothing: say so in the config.
  const choice: VectorChoice = { enabled: !model.credentialId || credential !== undefined, modelId: model.id, dimension };
  if (model.provider === 'ollama') {
    // Schema split (already in PlatformConfigStore): chat models live in
    // `localLLMs[]`, embeddings live in `ollamaUrl`. We let the user reuse
    // the chat Ollama URL (the common case) or override with a different
    // host — useful when the user runs a dedicated embedding instance to
    // avoid VRAM contention with `OLLAMA_MAX_LOADED_MODELS=1` on tiny GPUs.
    const chatOllama = localLLMs.find((e) => e.kind === 'ollama-native' && e.enabled);
    let embeddingUrl: string | undefined;
    if (chatOllama) {
      blank();
      const reuse = (await ask(
        `Use the same Ollama instance for embeddings? (Y/n) ${c.dim}[chat: ${chatOllama.baseUrl}]${c.reset}`,
        'y',
      )).toLowerCase();
      if (reuse !== 'n') {
        embeddingUrl = chatOllama.baseUrl;
        info(`Embeddings will use ${c.bold}${chatOllama.baseUrl}${c.reset} (shared with chat)`);
      }
    }
    if (!embeddingUrl) {
      const fallback = env.ollama.running ? env.ollama.url : 'http://127.0.0.1:11434';
      const raw = (await ask('Embedding Ollama URL', fallback)).trim();
      if (raw) {
        try {
          const probe = await fetch(`${raw.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(2000) });
          if (probe.ok) {
            info(`Embedding Ollama reachable at ${c.bold}${raw}${c.reset}`);
          } else {
            warn(`Embedding Ollama at ${raw} returned HTTP ${probe.status} — saving URL anyway`);
          }
        } catch (err) {
          warn(`Could not reach ${raw}: ${String((err as Error)?.message ?? err)} — saving URL anyway`);
        }
        embeddingUrl = hostReachableUrl(raw, deploymentMode);
      }
    }
    if (embeddingUrl) {
      choice.ollamaUrl = embeddingUrl;
    } else if (env.ollama.running) {
      choice.ollamaUrl = hostReachableUrl(env.ollama.url, deploymentMode);
    }
  }
  if (credential && credential !== 'stored') choice.credential = credential;
  return choice;
}

// ── Custom LLM endpoints (Ollama / LM Studio / vLLM / llama.cpp / LocalAI, or a keyed gateway) ──

type LocalProbe = { id: string; label: string; url: string; kind: 'ollama-native' | 'openai-compat'; probePath: string };

const LOCAL_PROBES: LocalProbe[] = [
  { id: 'ollama', label: 'Ollama', url: 'http://127.0.0.1:11434', kind: 'ollama-native', probePath: '/api/tags' },
  { id: 'lmstudio', label: 'LM Studio', url: 'http://127.0.0.1:1234', kind: 'openai-compat', probePath: '/v1/models' },
  { id: 'vllm', label: 'vLLM', url: 'http://127.0.0.1:8000', kind: 'openai-compat', probePath: '/v1/models' },
  { id: 'llamacpp', label: 'llama.cpp server', url: 'http://127.0.0.1:8080', kind: 'openai-compat', probePath: '/v1/models' },
  { id: 'localai', label: 'LocalAI', url: 'http://127.0.0.1:8081', kind: 'openai-compat', probePath: '/v1/models' },
];

/**
 * Three-way Ollama deployment question. Asked at the start of the endpoint
 * section so the user gets a clear choice between connecting to an existing
 * native daemon, starting a fresh container under docker-compose, or pointing
 * at a custom URL. Returns the entry to push into `localLLMs[]` (or null).
 */
async function askOllamaDeployment(
  env: DetectedEnv,
  deploymentMode: 'native' | 'docker',
): Promise<LocalLLMEntry | null> {
  const detected = env.ollama.running;
  const detectedLabel = detected
    ? `Already running — connect to detected URL (${env.ollama.url})`
    : 'Already running — enter URL of an existing Ollama I should connect to';
  const idx = await askChoice(
    'Where is Ollama (your local LLM runtime) running?',
    [
      `${detectedLabel} ${c.dim}(recommended)${c.reset}`,
      `Run a fresh Ollama container under docker-compose ${c.dim}(service emitted into the generated docker-compose.yml)${c.reset}`,
      'Custom URL — I\'ll enter the endpoint',
      'Skip — no Ollama right now',
    ],
    detected ? 0 : 3,
  );

  if (idx === 3) return null;

  if (idx === 1) {
    // Compose-managed Ollama: container is reachable from neuralis at the
    // bridge name `ollama` regardless of host deployment mode.
    return composeOllamaEntry();
  }

  if (idx === 2) {
    const url = (await ask('Ollama URL', env.ollama.url || 'http://127.0.0.1:11434')).trim();
    if (!url) return null;
    try {
      const probe = await fetch(`${url.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(2000) });
      if (probe.ok) {
        info(`Custom Ollama reachable at ${c.bold}${url}${c.reset}`);
      } else {
        warn(`Custom Ollama returned HTTP ${probe.status} — saving URL anyway`);
      }
    } catch (err) {
      warn(`Could not reach ${url}: ${String((err as Error)?.message ?? err)} — saving URL anyway`);
    }
    const stored = hostReachableUrl(url, deploymentMode);
    return { id: 'ollama', label: 'Ollama (custom)', baseUrl: stored, kind: 'ollama-native', enabled: true };
  }

  // idx === 0: connect to detected (or prompt if not detected).
  let url = env.ollama.url;
  if (!detected) {
    url = (await ask('Ollama URL', url || 'http://127.0.0.1:11434')).trim();
    if (!url) return null;
    try {
      const probe = await fetch(`${url.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(2000) });
      if (probe.ok) {
        const parsed = (await probe.json()) as { models?: Array<{ name: string }> };
        env.ollama.running = true;
        env.ollama.url = url;
        env.ollama.models = (parsed.models ?? []).map((m) => m.name);
        info(`Ollama reachable at ${c.bold}${url}${c.reset}`);
      } else {
        warn(`Ollama at ${url} returned HTTP ${probe.status} — saving URL anyway`);
      }
    } catch (err) {
      warn(`Could not reach ${url}: ${String((err as Error)?.message ?? err)} — saving URL anyway`);
    }
  }
  return detectedOllamaEntry(url, deploymentMode);
}

/**
 * `--ollama <mode>`: one of the words `allowed` (the Docker wizard has no
 * `binary` — that one is the desktop app's own host), else a refusal; absent ⇒
 * null (the question keeps its default answer).
 */
function parseOllamaFlag(cliArgs: string[], flagValue: (flag: string) => string | null, allowed: readonly OllamaMode[]): OllamaMode | null {
  if (!cliArgs.includes('--ollama')) return null;
  const mode = parseOllamaMode(flagValue('--ollama'));
  if (!mode || !allowed.includes(mode)) throw new CliExit(1, `--ollama takes ${allowed.join(', ')}${allowed.includes('binary') ? '' : ' (the downloaded binary runs only on the desktop app\'s own host)'}`);
  return mode;
}

/** The `.env` `OLLAMA_MODE` of a Docker install: what its endpoints say — the compose service, another Ollama, or none. */
function dockerOllamaMode(localLLMs: readonly LocalLLMEntry[]): OllamaMode {
  const ollama = localLLMs.find((e) => e.kind === 'ollama-native' && e.enabled);
  if (!ollama) return 'none';
  return ollama.baseUrl.startsWith('http://ollama:') ? 'docker' : 'existing';
}

/** The compose-managed Ollama: reachable from the app at the bridge name `ollama`, whatever the host mode. */
function composeOllamaEntry(): LocalLLMEntry {
  info(`Selected: ${c.bold}docker-compose Ollama${c.reset} → http://ollama:11434`);
  console.log(`  ${c.dim}The generated docker-compose.yml will include the ollama service (loopback only) — \`docker compose up -d\` starts it.${c.reset}`);
  console.log(`  ${c.dim}${ollamaCostLine('docker')}${c.reset}`);
  return { id: 'ollama', label: 'Ollama (compose)', baseUrl: 'http://ollama:11434', kind: 'ollama-native', enabled: true };
}

/** The Ollama at `url` as a chat endpoint — the default answer when one was detected. */
function detectedOllamaEntry(url: string, deploymentMode: 'native' | 'docker'): LocalLLMEntry {
  return { id: 'ollama', label: 'Ollama', baseUrl: hostReachableUrl(url, deploymentMode), kind: 'ollama-native', enabled: true };
}

/**
 * Unasked (without `--advanced`) every question takes its default answer: a detected
 * Ollama or local server is added, nothing else — more endpoints are added in the app.
 */
async function configureLocalLLMs(
  env: DetectedEnv,
  deploymentMode: 'native' | 'docker',
  advanced: boolean,
  ollamaChoice: OllamaMode | null,
): Promise<{ entries: LocalLLMEntry[]; keys: Record<string, string> }> {
  heading('Custom LLM endpoints');
  console.log(`  ${c.dim}Point Neuralis at an OpenAI-compatible or Ollama-native LLM server.${c.reset}`);
  console.log(`  ${c.dim}On your own hardware (Ollama, LM Studio, vLLM, llama.cpp, LocalAI) it needs no key;${c.reset}`);
  console.log(`  ${c.dim}a remote gateway can be added here too, with its key and address class.${c.reset}`);
  if (deploymentMode === 'docker') {
    console.log(`  ${c.dim}Docker mode: loopback URLs are rewritten to host.docker.internal when stored.${c.reset}`);
  }
  blank();

  const entries: LocalLLMEntry[] = [];
  const keys: Record<string, string> = {};

  // Ollama gets the dedicated 3-way prompt because it's the most common path
  // (and the only one with a viable docker-compose service today).
  // `--ollama <mode>` answers this question without asking it (`binary` is the desktop app's alone).
  const ollamaEntry = ollamaChoice === 'docker'
    ? composeOllamaEntry()
    : ollamaChoice === 'existing'
      ? detectedOllamaEntry(env.ollama.url, deploymentMode)
      : ollamaChoice === 'none'
        ? null
        : advanced
          ? await askOllamaDeployment(env, deploymentMode)
          : env.ollama.running ? detectedOllamaEntry(env.ollama.url, deploymentMode) : null;
  if (ollamaEntry) {
    entries.push(ollamaEntry);
    info(`Added ${c.bold}${ollamaEntry.label}${c.reset} → ${ollamaEntry.baseUrl}`);
  }

  // The other engines stay on auto-probe-then-confirm; they have no compose
  // service and fewer deployment knobs worth a dedicated menu.
  for (const probe of LOCAL_PROBES) {
    if (probe.id === 'ollama') continue;
    let reachable = false;
    try {
      const res = await fetch(`${probe.url}${probe.probePath}`, { signal: AbortSignal.timeout(1500) });
      reachable = res.ok;
    } catch {
      reachable = false;
    }
    if (!reachable) continue;
    const confirm = advanced ? (await ask(`Detected ${c.bold}${probe.label}${c.reset} at ${probe.url} — add? (Y/n)`, 'y')).toLowerCase() : 'y';
    if (confirm !== 'n') {
      const stored = hostReachableUrl(probe.url, deploymentMode);
      entries.push({ id: probe.id, label: probe.label, baseUrl: stored, kind: probe.kind, enabled: true });
      info(`Added ${c.bold}${probe.label}${c.reset} → ${stored}`);
    }
  }

  // Manual add loop — lets the user point at custom hosts/ports.
  while (advanced) {
    const more = (await ask('Add a custom LLM endpoint? (y/N)', 'n')).toLowerCase();
    if (more !== 'y') break;
    const label = (await ask('Label', 'My endpoint')).trim() || 'My endpoint';
    const id = slugify(label) || 'endpoint';
    const baseUrl = (await ask('Base URL (e.g. http://localhost:11434)', 'http://127.0.0.1:11434')).trim();
    if (!baseUrl) continue;
    const kindChoice = await askChoice('Framing', [
      'ollama-native (Ollama /api/chat NDJSON — recommended for Ollama)',
      'openai-compat (LM Studio / vLLM / llama.cpp / LocalAI / any /v1/chat/completions)',
    ], baseUrl.includes('11434') ? 0 : 1);

    const auth = await askEndpointAuth();
    entries.push({
      id,
      label,
      baseUrl: hostReachableUrl(baseUrl, deploymentMode),
      kind: kindChoice === 0 ? 'ollama-native' : 'openai-compat',
      enabled: true,
      auth: auth.auth,
      network: await askEndpointNetwork(baseUrl),
    });
    if (auth.key) keys[id] = auth.key;
    info(`Added ${c.bold}${label}${c.reset}`);
  }

  if (entries.length === 0) {
    warn('No custom LLM endpoints configured. Add them later in the admin Credentials tab.');
  }
  return { entries, keys };
}

/**
 * Authentication for an operator endpoint (LLM or embedding). The key goes to
 * the CREDENTIAL STORE (`llm.endpoint.<id>` / `embedding.endpoint.<id>`, global
 * scope) — never into .env (readable with `docker inspect`) and never into
 * platform.json (admin-visible plaintext).
 */
async function askEndpointAuth(): Promise<{ auth: 'none' | 'bearer'; key: string }> {
  const authChoice = await askChoice('Authentication', [
    'None — the server is open on my own network',
    'Bearer API key — a gateway or hosted endpoint',
  ], 0);
  if (authChoice !== 1) return { auth: 'none', key: '' };
  const key = (await askSensitive('API key (stored encrypted, never echoed)')).trim();
  if (!key) warn('No key entered — add it later in the admin Credentials tab.');
  return { auth: 'bearer', key };
}

/**
 * Address class of an operator endpoint. This is what decides whether the SSRF
 * floor applies, and it is an OPERATOR DECLARATION: `private` says "this
 * address is deliberately inside my own network", which is exactly what a
 * local runtime is. Anything reachable over the internet must be `public` so
 * the address is validated and the connection IP-pinned.
 *
 * The wizard INFERS a default from the URL's shape and validates no address:
 * the admin write route does, and the connect-time check — the one that
 * matters — runs on every path. Say this plainly rather than letting the
 * prompt imply a check the wizard does not perform.
 */
async function askEndpointNetwork(baseUrl: string): Promise<'private' | 'public'> {
  const loopbackish = /^(https?:\/\/)?(localhost|127\.|0\.0\.0\.0|host\.docker\.internal|\[::1\]|192\.168\.|10\.)/i.test(baseUrl);
  const networkChoice = await askChoice('Where does this endpoint live?', [
    'On my own machine or private network (no address validation)',
    'On the public internet (validated + IP-pinned on every connection)',
  ], loopbackish ? 0 : 1);
  return networkChoice === 1 ? 'public' : 'private';
}

// ── Machine-core desktop variant + image prefetch ──────────────

/** The core packages every install loads, and the one it may leave off (`disabledBuiltinPackages`). */
function printCorePackages(): void {
  heading('Core packages');
  info(`${c.bold}@neuralis/admin${c.reset} · ${c.bold}@neuralis/agent-core${c.reset} · ${c.bold}@neuralis/brain-core${c.reset} ${c.dim}— always on${c.reset}`);
  step(`${c.bold}@neuralis/machine-core${c.reset} ${c.dim}— the virtual desktop (needs Docker); also runs sidecar MCP servers${c.reset}`);
}

async function chooseMachineVariant(env: DetectedEnv, layout: InstallLayout, advanced: boolean, noDesktop: boolean): Promise<MachineChoice> {
  printCorePackages();
  heading('Machine (virtual desktop)');
  console.log(`  ${c.dim}The first beta bundles Ubuntu + XFCE with Neuralis control and authentication.${c.reset}`);
  console.log(`  ${c.dim}machine-core streams the Webtop desktop into the workspace over Selkies.${c.reset}`);
  console.log(`  ${c.dim}The image is ~3 GB uncompressed — first pull takes ~3 min on 100 Mbps.${c.reset}`);
  blank();

  if (!env.docker) {
    warn('Docker not available — the virtual desktop stays off (Admin → Config, disabledBuiltinPackages, turns it on).');
    return { variant: DEFAULT_MACHINE_VARIANT, skipPrefetch: true, pullOnHost: false, enabled: false };
  }
  const enabled = !noDesktop && (!advanced || !(await ask('Turn on the virtual desktop (machine-core)?', 'y')).toLowerCase().startsWith('n'));
  if (!enabled) {
    step('Virtual desktop off: machine-core stays installed and is not loaded (Admin → Config, disabledBuiltinPackages).');
    return { variant: DEFAULT_MACHINE_VARIANT, skipPrefetch: true, pullOnHost: false, enabled: false };
  }

  const variant = DEFAULT_MACHINE_VARIANT;
  info(`Bundled desktop: ${c.bold}${variant.label}${c.reset} ${c.dim}(${variant.derivativeImage})${c.reset}`);

  // A pull started in the image's one-shot container dies with it: there the host pulls it
  // (the installer does; the summary names the command).
  if (insideImage(layout)) {
    step(`Pull it on the host before the first desktop start: ${c.bold}docker pull ${variant.derivativeImage}${c.reset}`);
    return { variant, skipPrefetch: true, pullOnHost: true, enabled: true };
  }

  const prefetch = advanced ? await ask('Pre-pull the Neuralis desktop image now (background)?', 'y') : 'y';
  const skipPrefetch = prefetch.toLowerCase() === 'n';

  if (!skipPrefetch) {
    step(`Starting background pull of ${c.bold}${variant.derivativeImage}${c.reset}…`);
    try {
      const pid = await backgroundPullMachineImage(variant.derivativeImage, env.neuralisHome);
      info(`Background pull kicked off (pid ${pid}) — the first desktop open may still wait for the download or need a retry.`);
    } catch (err) {
      warn(`Background pull failed (continuing anyway): ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    step(`Image prefetch skipped — the first desktop start needs it: docker pull ${variant.derivativeImage}`);
  }

  return { variant, skipPrefetch, pullOnHost: false, enabled: true };
}

async function backgroundPullMachineImage(image: string, dataHome: string): Promise<number | undefined> {
  // Spawn an independent `docker pull` process and detach so the setup CLI
  // exits without waiting. Errors become log output — we don't block setup
  // on a slow/failed pull.
  const { spawn } = await import('node:child_process');
  const logDir = join(dataHome, 'app', 'logs');
  await mkdir(logDir, { recursive: true, mode: 0o700 }).catch(() => { /* ignore — best-effort */ });
  const logPath = join(logDir, 'machine-image-prefetch.log');
  const { openSync } = await import('node:fs');
  const logFd = openSync(logPath, 'a');

  const child = spawn('docker', ['pull', image], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  child.on('error', (err) => {
    warn(`docker pull ${image} failed to spawn: ${err.message}`);
  });
  return child.pid;
}

// ── File generation ────────────────────────────────────────────

/**
 * Ask Docker which Compose projects exist, so a name collision can be detected
 * rather than discovered when the second `up` adopts the first install's
 * containers. Returns null when Docker cannot answer — an unprobed collision
 * surfaces immediately on the next `up`, which is better than inventing a name.
 */
async function probeComposeProjects(): Promise<ComposeProjectRow[] | null> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['compose', 'ls', '-a', '--format', 'json'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += String(chunk); });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? parseComposeLs(out) : null));
  });
}

// ── Three-store write: .env + platform.json + CredentialStore ─

async function generateKeyFiles(neuralisHome: string): Promise<{ masterKey: Buffer; salt: Buffer }> {
  const configDir = join(neuralisHome, 'app', 'config');
  await mkdir(configDir, { recursive: true, mode: 0o700 });

  const keyPath = join(configDir, 'credential-master.key');
  const saltPath = join(configDir, 'credential-salt.bin');

  let masterKey: Buffer;
  let salt: Buffer;

  try {
    await access(keyPath);
    masterKey = (await readFile(keyPath)) as unknown as Buffer;
  } catch {
    masterKey = randomBytes(32);
    await writeFile(keyPath, masterKey, { mode: 0o400 });
  }

  try {
    await access(saltPath);
    salt = (await readFile(saltPath)) as unknown as Buffer;
  } catch {
    salt = randomBytes(16);
    await writeFile(saltPath, salt, { mode: 0o400 });
  }

  return { masterKey, salt };
}

/**
 * The session secret file (`<home>/app/config/session-secret.key`): kept when
 * present — rotating it signs every user out; otherwise the secret an older
 * `.env` still carries (a re-run on an install set up before the file
 * existed), else a new one. The `.env` this run writes no longer carries it.
 */
async function ensureSessionSecret(neuralisHome: string, carried: string | null): Promise<void> {
  const appRoot = join(neuralisHome, 'app');
  const outcome = await writeSessionSecretFile(appRoot, carried ?? mintSessionSecret());
  if (outcome === 'kept') step('Session secret preserved — nobody gets logged out. (To rotate it, delete app/config/session-secret.key with the app stopped, then re-run setup.)');
  else info(`Session secret: ${c.dim}${carried ? 'moved from .env into' : 'generated'} ${sessionSecretPath(appRoot)}${c.reset}`);
}

async function writeCredentials(
  config: SetupConfig,
  masterKey: Buffer,
  salt: Buffer,
): Promise<number> {
  let count = 0;

  // Write LLM API keys
  for (const [envVar, value] of Object.entries(config.llmKeys)) {
    const credId = LLM_CREDENTIAL_MAP[envVar];
    if (!credId || !value.trim()) continue;
    await writeCredentialFile(config.neuralisHome, masterKey, salt, credId, value);
    count++;
  }

  // Custom-endpoint bearers — one per `auth:'bearer'` endpoint, at GLOBAL
  // scope. Global is the right default and the only one a first-run CLI can
  // write: it is also the scope model DISCOVERY resolves at, so a globally-set
  // key is what makes an endpoint's model list appear at all.
  for (const [endpointId, value] of Object.entries(config.endpointKeys)) {
    if (!value.trim()) continue;
    // The one legitimately independent spelling of this family: the kernel owns
    // `llmEndpointCredentialId`, but this is a first-run CLI that executes
    // before any package is built and so cannot import it — the same reason the
    // AES/HKDF envelope above is reproduced inline rather than imported.
    await writeCredentialFile(config.neuralisHome, masterKey, salt, `llm.endpoint.${endpointId}`, value);
    count++;
  }

  // The embedding model's own credential (`embedding.<provider>` or
  // `embedding.endpoint.<id>`), captured in chooseVectorConfig — never the chat key's id.
  if (config.vector.credential) {
    await writeCredentialFile(config.neuralisHome, masterKey, salt, config.vector.credential.id, config.vector.credential.value);
    count++;
  }

  // OpenAI Codex OAuth blob — JSON-stringified into the same encrypted-file
  // format as any other credential. Agent-core's `resolveOAuthToken()` reads
  // and JSON-parses it back.
  if (config.codexBlob) {
    await writeCredentialFile(
      config.neuralisHome,
      masterKey,
      salt,
      'llm.openai-codex.oauth',
      JSON.stringify(config.codexBlob),
      { kind: 'user', userId: config.ownerUserId },
    );
    count++;
  }

  return count;
}

async function generateEnvFile(config: SetupConfig, env: DetectedEnv, configDir: string): Promise<void> {
  heading('Generating configuration');

  const infraMode = config.qdrant.mode === 'skip' ? 'inmemory' : 'local';

  // Minimal .env — only infra topology, ports, paths. The session secret is a
  // file in the data home (`sessionSecretFile.ts`), never a line here.
  const lines: string[] = [
    `# Generated by: neuralis setup (${new Date().toISOString().split('T')[0]})`,
    `# Do not commit this file to version control.`,
    '#',
    '# Three-tier configuration model:',
    '#   .env           — infrastructure topology (this file)',
    '#   platform.json  — runtime settings (~/.neuralis/app/config/platform.json)',
    '#   credentials/   — encrypted secrets (~/.neuralis/app/credentials/)',
    '#   The session secret is app/config/session-secret.key in the data home.',
    '',
    ...buildOriginLines(config.origins, config.ports, config.tunnelDomain !== null, config.tunnelRestore),
    '',
    '# Compose project name. It prefixes the named volumes, the network and',
    '# every container name, so a re-run preserves it: renaming would orphan',
    '# qdrant-data and break tooling that addresses containers by name.',
    `NEURALIS_COMPOSE_PROJECT=${config.composeProject}`,
    ...imageTagLines(config.imageTag),
    '',
    '# ── Infrastructure Services ──────────────────────────',
    `BRAIN_INFRA_MODE=${infraMode}`,
  ];

  if (config.qdrant.mode !== 'skip') {
    lines.push(`QDRANT_URL=${config.qdrant.url || `http://localhost:${DEFAULT_QDRANT_PORT}`}`);
  } else {
    lines.push('# QDRANT_URL=http://localhost:6333');
  }
  lines.push(
    '# How Qdrant is provisioned (docker | binary | external | skip). Read back',
    '# by `neuralis setup --compose-only` so the compose regen emits the',
    '# right qdrant service / QDRANT_URL shape without re-asking.',
    `QDRANT_MODE=${config.qdrant.mode}`,
  );
  if (config.qdrant.apiKey) {
    lines.push(
      '# Qdrant API key — every Qdrant request must carry it. In docker mode the',
      '# compose file hands it to the server via ${QDRANT_API_KEY:?} interpolation;',
      '# the clients (app, admin probes, reset:vector) read this same line. It is',
      '# .env-resident by decision: the boot-synchronous Qdrant client, the compose',
      '# interpolation and the host tooling cannot read the async credential store.',
      '# Preserved across re-runs; delete the line to rotate (then recreate the stack).',
      `QDRANT_API_KEY=${config.qdrant.apiKey}`,
    );
  } else if (config.qdrant.mode === 'external') {
    lines.push(
      '# External Qdrant with no API key configured. If the server enforces one,',
      '# add: QDRANT_API_KEY=<key>  (then `neuralis setup --compose-only`',
      '# and `docker compose up -d`).',
      '# QDRANT_API_KEY=',
    );
  }
  if (config.qdrant.mode === 'binary') {
    lines.push(
      '# The loopback ports the native Qdrant listens on (REST, gRPC). `neuralis up` and',
      '# `neuralis qdrant-upgrade` start it on them; QDRANT_URL names the REST one.',
      `NEURALIS_QDRANT_PORT=${config.qdrant.port}`,
      `NEURALIS_QDRANT_GRPC_PORT=${config.qdrant.grpcPort ?? DEFAULT_QDRANT_GRPC_PORT}`,
    );
  }
  if (config.qdrant.mode === 'docker') {
    lines.push(
      '# The host loopback port the bundled Qdrant is published on (its container',
      '# side stays 6333). Change it, then `neuralis setup --compose-only && docker compose up -d`.',
      `NEURALIS_QDRANT_PORT=${config.qdrant.port}`,
      `# Qdrant web dashboard (static SPA at 127.0.0.1:${config.qdrant.port}/dashboard). Set to`,
      "# 'off' to disable the static UI entirely, then regenerate + recreate:",
      '# `neuralis setup --compose-only && docker compose up -d`.',
      'QDRANT_DASHBOARD=on',
    );
  }
  lines.push(
    '# Codex (ChatGPT) sign-in loopback on the Docker shape. `on` publishes the',
    '# callback port on this host\'s 127.0.0.1:1455 so a browser on THIS machine',
    '# can finish the sign-in; Docker then holds that port while the stack runs',
    '# (a native `codex login` here cannot use it, and the stack will not start',
    '# if something else holds it). `off`: paste the final URL into the',
    '# "Finish callback URL" field instead. Change it, then',
    '# `neuralis setup --compose-only && docker compose up -d`.',
    `NEURALIS_CODEX_LOOPBACK=${config.codexLoopback ? 'on' : 'off'}`,
    ...trustedProxiesLines(config.trustedProxies),
    ...buildNpmrcLines(config.buildNpmrc),
  );

  lines.push('', ...ollamaEnvLines(dockerOllamaMode(config.localLLMs)));

  if (config.qdrant.mode === 'docker') {
    lines.push('# Docker note: Qdrant starts with the app stack.');
  }

  lines.push(...dockerIdentityLines(config));

  lines.push(
    '',
    '# ── Machine-core (per-user Webtop + Selkies + Playwright-over-CDP) ──',
    '# The desktop variant and idle timeout are platform settings (Admin → Config).',
    `NEURALIS_MACHINE_IMAGE=${config.machine.variant.derivativeImage}`,
    'NEURALIS_MACHINE_SCREEN=1920x1080',
    'NEURALIS_MACHINE_SIDECAR_PORT=9400',
    'NEURALIS_MACHINE_CDP_PORT=9222',
    '# Set true on WSL2 dev only — default Linux hosts leave this false.',
    `NEURALIS_MACHINE_SECCOMP_UNCONFINED=${env.platform === 'wsl' ? 'true' : 'false'}`,
    '',
    '# LLM API keys are stored encrypted in ~/.neuralis/app/credentials/',
    '# Runtime settings are in ~/.neuralis/app/config/platform.json',
    '# Manage both via the Admin panel or re-run setup.',
  );

  const envPath = join(configDir, '.env');

  let shouldWrite = true;
  try {
    await access(envPath);
    blank();
    warn(`.env already exists at ${c.dim}${envPath}${c.reset}`);
    const action = await ask('Overwrite?', 'y');
    shouldWrite = action.toLowerCase() !== 'n';
  } catch {
    // doesn't exist — write
  }

  if (shouldWrite) {
    await writeFile(envPath, lines.join('\n') + '\n', 'utf-8');
    info(`.env written to ${c.bold}${envPath}${c.reset}`);
  } else {
    step('.env kept unchanged');
  }
}

// ── docker-compose.yml generation moved to setup/compose.mts (S3) ──

/** The version this host package ships — the compose stamp and a fresh install's image tag; never defaulted. */
async function readNeuralisVersion(packageDir: string): Promise<string> {
  const pkgPath = join(packageDir, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as { version?: unknown };
  if (typeof pkg.version !== 'string' || !pkg.version.trim()) throw new Error(`${pkgPath} names no version.`);
  return pkg.version.trim();
}

async function generateComposeFile(
  base: ComposeEmitInput,
  configDir: string,
  opts: { askOverwrite: boolean; version: string; installDir: string; packageDir: string; dataHome: string },
): Promise<void> {
  const input: ComposeEmitInput = { ...base, operatorImage: operatorImageFor(base, configDir, opts) };
  const composePath = join(configDir, 'docker-compose.yml');
  const content = buildComposeContent(input, {
    date: new Date().toISOString().split('T')[0],
    version: opts.version,
  });

  let shouldWrite = true;
  if (opts.askOverwrite) {
    try {
      await access(composePath);
      blank();
      warn(`docker-compose.yml already exists at ${c.dim}${composePath}${c.reset}`);
      const action = await ask('Overwrite?', 'y');
      shouldWrite = action.toLowerCase() !== 'n';
    } catch {
      // doesn't exist — write
    }
  }

  if (shouldWrite) {
    // The compose file binds `<home>/checkpoints`; created here, by the setup
    // user, so Docker never creates the bind source root-owned.
    await mkdir(join(opts.dataHome, 'checkpoints'), { recursive: true, mode: 0o700 });
    await writeFile(composePath, content, 'utf-8');
    info(`docker-compose.yml written to ${c.bold}${composePath}${c.reset}`);
    if (input.operatorImage) {
      await mkdir(input.operatorImage.contextDir, { recursive: true });
      for (const [name, text] of Object.entries(input.operatorImage.files)) {
        await writeFile(join(input.operatorImage.contextDir, name), text, 'utf-8');
      }
      info(`derived image ${c.bold}${input.operatorImage.name}${c.reset} — its build context in ${c.dim}${input.operatorImage.contextDir}${c.reset}`);
    }
  } else {
    step('docker-compose.yml kept unchanged');
  }
}

/**
 * An npm install folder's derived image: its operator packages over the release
 * image (`planOperatorImage`). The monorepo builds the whole image, and an
 * install with no operator package runs the release image as is.
 */
function operatorImageFor(input: ComposeEmitInput, configDir: string, dirs: { installDir: string; packageDir: string }): OperatorImage | null {
  // An image-only folder has no package list: it runs the release image as is.
  if (input.monorepo || !input.imageTag || installKindOf(dirs.installDir) === 'image') return null;
  return planOperatorImage({
    installManifest: JSON.parse(readFileSync(join(dirs.installDir, 'package.json'), 'utf-8')) as unknown,
    contextDir: join(configDir, OPERATOR_IMAGE_DIR),
    composeProject: input.composeProject,
    imageTag: input.imageTag,
    build: input.build,
    readBuildHelper: () => readFileSync(join(dirs.packageDir, 'scripts', 'build', 'build-workspace.mjs'), 'utf-8'),
  });
}

function composeInputFromSetup(config: SetupConfig, env: DetectedEnv, qdrantImage: string | null): ComposeEmitInput {
  const hostHome = resolveHostHome(config.neuralisHome);
  return {
    uid: config.uid,
    gid: config.gid,
    dockerGid: config.dockerGid,
    appPort: config.ports.app,
    mcpPort: config.ports.mcp,
    sandboxPort: config.ports.sandbox,
    composeProject: config.composeProject,
    brainInfraMode: config.qdrant.mode === 'skip' ? 'inmemory' : 'local',
    qdrantMode: config.qdrant.mode,
    qdrantUrl: config.qdrant.url,
    qdrantPort: config.qdrant.port,
    qdrantImage,
    // A full setup writes QDRANT_DASHBOARD=on into .env; the off-switch is an
    // operator .env edit picked up by the --compose-only read-back.
    qdrantDashboard: true,
    codexLoopbackPublish: config.codexLoopback,
    composeOllama: config.localLLMs.some((e) => e.baseUrl.startsWith('http://ollama:')),
    tunnel: config.tunnelDomain !== null,
    neuralisHome: hostHome,
    machine: {
      image: config.machine.variant.derivativeImage,
      screen: '1920x1080',
      sidecarPort: 9400,
      cdpPort: 9222,
      seccompUnconfined: env.platform === 'wsl',
      dockerSocket: '/var/run/docker.sock',
    },
    // env.isClone = pnpm-workspace.yaml present at projectRoot or its parent —
    // exactly the "monorepo dev" channel where `build: context: ..` resolves.
    monorepo: env.isClone,
    imageTag: config.imageTag,
    build: buildInputsFor(env, config.buildNpmrc ?? undefined),
    // Decided at generation, from the install folder's package.json (`operatorImageFor`).
    operatorImage: null,
  };
}

/**
 * The build's inputs (local package contexts, the build-state folder, the
 * `.npmrc` secret), read from the install folder's package.json — the
 * dependency set the build installs: the monorepo's whole image, or an npm
 * install folder's derived image. Any other image channel never builds, so a
 * local package registered there is named rather than silently left out of a
 * pulled image.
 */
function buildInputsFor(env: DetectedEnv, npmrcPath: string | undefined): BuildInputs {
  // An image-only folder pulls a prebuilt image and has no package list to read.
  if (installKindOf(env.projectRoot) === 'image') return NO_BUILD_INPUTS;
  const manifest = JSON.parse(readFileSync(join(env.projectRoot, 'package.json'), 'utf-8')) as unknown;
  if (!env.isClone && operatorDependencies(manifest) !== null) {
    return resolveBuildInputs({ hostDir: env.projectRoot, repoRoot: env.projectRoot, neuralisHome: env.neuralisHome, npmrcPath });
  }
  if (!env.isClone) {
    for (const source of listLocalSources(manifest)) {
      warn(`${source.name} (${source.spec}) is a local package, and this channel pulls a prebuilt image — it is not in it.`);
    }
    return NO_BUILD_INPUTS;
  }
  return resolveBuildInputs({
    hostDir: env.projectRoot,
    repoRoot: join(env.projectRoot, '..'),
    neuralisHome: env.neuralisHome,
    npmrcPath,
  });
}

/**
 * Rebuilds the compose emit input from an existing .env + platform.json —
 * the `--compose-only` fast path. UID/GID/DOCKER_GID come from fresh
 * detection (they are host facts, not stored config).
 */
function composeInputFromExisting(
  envVars: Record<string, string>,
  platformConfig: Record<string, unknown>,
  env: DetectedEnv,
  hostIdentity: HostIdentityOverrides = { uid: null, gid: null, dockerGid: null },
): ComposeEmitInput {
  const brainInfraMode = envVars.BRAIN_INFRA_MODE === 'inmemory' ? 'inmemory' : 'local';

  const validModes = ['docker', 'binary', 'external', 'skip'] as const;
  let qdrantMode = validModes.find((mode) => mode === envVars.QDRANT_MODE);
  if (!qdrantMode) {
    // Pre-QDRANT_MODE .env (written before C6). Derive: inmemory → skip;
    // the compose-managed default URL → docker; anything else → external.
    if (brainInfraMode === 'inmemory') {
      qdrantMode = 'skip';
    } else if (/^http:\/\/(localhost|127\.0\.0\.1):6333\/?$/.test(envVars.QDRANT_URL ?? '')) {
      qdrantMode = 'docker';
    } else {
      qdrantMode = 'external';
    }
    warn(`.env has no QDRANT_MODE — assuming '${qdrantMode}'. Re-run the full setup (or add QDRANT_MODE=) to make it explicit.`);
  }

  const localLLMs = Array.isArray(platformConfig.localLLMs)
    ? (platformConfig.localLLMs as Array<{ baseUrl?: unknown }>)
    : [];
  const composeOllama = localLLMs.some(
    (entry) => typeof entry.baseUrl === 'string' && entry.baseUrl.startsWith('http://ollama:'),
  );

  const machineEnv = (key: string, fallback: string): string => envVars[key] ?? fallback;
  const hostHome = resolveHostHome(env.neuralisHome);

  return {
    // Read back, never re-decided: --compose-only must regenerate the SAME
    // project name, or the regenerated file points at different volumes.
    composeProject: envVars.NEURALIS_COMPOSE_PROJECT?.trim() || 'neuralis',
    // Host facts, detected; the flags win when given.
    uid: hostIdentity.uid ?? env.uid,
    gid: hostIdentity.gid ?? env.gid,
    dockerGid: hostIdentity.dockerGid ?? env.dockerGid,
    appPort: Number(envVars.NEURALIS_APP_PORT) || 3100,
    mcpPort: Number(envVars.MCP_HTTP_PORT) || 3101,
    sandboxPort: Number(envVars.NEURALIS_MCP_SANDBOX_PORT) || 3102,
    brainInfraMode,
    qdrantMode,
    qdrantUrl: envVars.QDRANT_URL ?? '',
    qdrantPort: qdrantHostPort(envVars),
    // Resolved by the caller from the recorded state (docker mode only).
    qdrantImage: null,
    // Anything but an explicit 'off' keeps the dashboard (default-on switch).
    qdrantDashboard: envVars.QDRANT_DASHBOARD?.trim().toLowerCase() !== 'off',
    codexLoopbackPublish: codexLoopbackOptIn(envVars.NEURALIS_CODEX_LOOPBACK),
    composeOllama,
    tunnel: tunnelDomainOf(envVars) !== null,
    neuralisHome: hostHome,
    machine: {
      image: machineEnv('NEURALIS_MACHINE_IMAGE', 'neuralisapp/webtop-ubuntu-xfce:0.4.1'),
      screen: machineEnv('NEURALIS_MACHINE_SCREEN', '1920x1080'),
      sidecarPort: Number(envVars.NEURALIS_MACHINE_SIDECAR_PORT) || 9400,
      cdpPort: Number(envVars.NEURALIS_MACHINE_CDP_PORT) || 9222,
      seccompUnconfined: envVars.NEURALIS_MACHINE_SECCOMP_UNCONFINED === 'true',
      dockerSocket: machineEnv('NEURALIS_MACHINE_DOCKER_SOCKET', '/var/run/docker.sock'),
    },
    monorepo: env.isClone,
    // Resolved by the caller from the .env read-back (image channels only).
    imageTag: null,
    build: buildInputsFor(env, envVars.NEURALIS_BUILD_NPMRC),
    operatorImage: null,
  };
}

function parseEnvContent(content: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    let value = trimmed.slice(eq + 1).trim();
    // Hand-edited .env values may be quoted — strip matching quotes so the
    // compose emit never carries literal quote characters.
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    parsed[trimmed.slice(0, eq).trim()] = value;
  }
  return parsed;
}

/**
 * The refusals a layout can see before any prompt or write (`setupRefusal`);
 * on the image its data-root context, elsewhere null.
 */
async function setupPreflight(ctx: CliContext, env: DetectedEnv, version: string, composeOnly: boolean, outputOverride: string | null): Promise<ImageRun | null> {
  const layout = installLayout(ctx.installDir, ctx.packageDir);
  const dir = resolveConfigDir(env, outputOverride);
  const container = insideImage(layout);
  const refusal = setupRefusal({
    layout,
    platform: env.platform,
    neuralisHome: env.neuralisHome,
    hostHome: process.env.NEURALIS_HOST_HOME,
    docker: { available: env.docker, cause: env.dockerCause, compose: env.dockerCompose },
    version,
    composeOnly,
    output: {
      dir,
      // One read of the mount table, in the image only.
      bound: container && bindMountOf(dir, await readFile('/proc/self/mountinfo', 'utf-8').catch(() => '')) !== null,
      writable: container && await access(dir, fsConstants.W_OK).then(() => true, () => false),
    },
  });
  if (refusal) throw refusal;
  return container ? { hostHome: resolveHostHome(env.neuralisHome), fix: imageFix(version, composeOnly, composeOnly ? dir : null) } : null;
}

/** Host identity overrides for the generated compose (`--uid`, `--gid`, `--docker-gid`). */
type HostIdentityOverrides = { uid: number | null; gid: number | null; dockerGid: number | null };

async function runComposeOnly(
  ctx: CliContext,
  outputOverride: string | null,
  hostIdentity: HostIdentityOverrides = { uid: null, gid: null, dockerGid: null },
): Promise<void> {
  const env = await detectEnvironment(ctx.installDir);
  const version = await readNeuralisVersion(ctx.packageDir);
  const image = await setupPreflight(ctx, env, version, true, outputOverride);
  if (image) await ensureWritableOrExplain(env.neuralisHome, env.neuralisHome, env.platform, image);
  const configDir = resolveConfigDir(env, outputOverride);
  const envPath = join(configDir, '.env');

  let envVars: Record<string, string>;
  try {
    envVars = parseEnvContent(await readFile(envPath, 'utf-8'));
  } catch {
    throw new Error(`--compose-only needs an existing .env at ${envPath} — run the full setup first.`);
  }

  let platformConfig: Record<string, unknown> = {};
  try {
    platformConfig = JSON.parse(
      await readFile(join(env.neuralisHome, 'app', 'config', 'platform.json'), 'utf-8'),
    ) as Record<string, unknown>;
  } catch {
    warn('platform.json not readable — assuming no compose-managed Ollama.');
  }

  const input = composeInputFromExisting(envVars, platformConfig, env, hostIdentity);

  // Fail LOUD before writing anything: in docker mode the emitted compose
  // interpolates ${QDRANT_API_KEY:?}, so with the .env line missing EVERY
  // compose command — `down` included — would die on the interpolation. An
  // early refusal that writes nothing and names the fix beats a generated
  // file that bricks the stack's own tooling.
  if (input.qdrantMode === 'docker' && !envVars.QDRANT_API_KEY?.trim()) {
    throw new Error(
      '.env has no QDRANT_API_KEY, but qdrant runs in docker mode and the compose file requires it.\n' +
      `  Fix: re-run the full \`${spell('setup')}\` (it mints and preserves the key),\n` +
      '  or add a QDRANT_API_KEY=<random> line to .env yourself, then re-run --compose-only.\n' +
      '  Nothing was written.',
    );
  }
  // The image tag is install state, read back like the project name: a missing
  // line is refused (writing nothing), never re-derived or defaulted.
  input.imageTag = resolveImageTag(envVars, input.monorepo);

  // Every port the file publishes is free or this install's own (a regeneration
  // beside the running stack is the normal case); a busy one is refused, named.
  const check = portCheck(installLayout(ctx.installDir, ctx.packageDir), env.docker);
  const claims = portClaims({
    ports: { app: input.appPort, mcp: input.mcpPort, sandbox: input.sandboxPort },
    qdrantPort: input.qdrantMode === 'docker' ? input.qdrantPort : null,
    codex: input.codexLoopbackPublish,
  });
  const busy = await findBusyPorts(claims, { ownProject: input.composeProject, ...check });
  if (busy.length > 0) {
    const movable = busy.filter((b) => b.key !== 'codex');
    throw busyPortRefusal(busy, await nextFreePorts(movable, claims.map((claim) => claim.port), { probe: check.probe, published: await check.published() }));
  }

  if (input.qdrantMode === 'docker') {
    // The recorded port, not detection's default one: a moved Qdrant still reports its version.
    const live = await detectQdrant(hostQdrantUrl(envVars));
    input.qdrantImage = qdrantImageRef(await resolveInstallQdrantVersion(
      dockerInstallProbe({
        composeProject: input.composeProject,
        composeFilePath: join(configDir, 'docker-compose.yml'),
        runningVersion: live.running ? live.version : null,
      }),
      env.neuralisHome,
    ));
  }

  await generateComposeFile(input, configDir, { askOverwrite: false, version, installDir: ctx.installDir, packageDir: ctx.packageDir, dataHome: env.neuralisHome });
  // A folder set up before the record existed gets its row at its first regeneration.
  await recordInstall(env.neuralisHome, configDir);
}

// ── Existing Setup Check ───────────────────────────────────────

async function handleExistingSetup(env: DetectedEnv): Promise<boolean> {
  if (!env.existingSetup) return true; // proceed

  blank();
  warn(`Existing Neuralis setup found at ${c.bold}${env.neuralisHome}${c.reset}`);
  // One honest option. There used to be a second, "Fresh setup (overwrite
  // everything)", which reached the identical code path: nothing in this
  // script has ever deleted a user or a project record, so the label was a
  // lie. A real fresh install is a fresh data directory — say that instead of
  // offering a destructive-sounding button that does nothing destructive.
  step(`${c.dim}Existing users, projects and settings are kept. For a clean install, move${c.reset}`);
  step(`${c.dim}${env.neuralisHome} aside (or point NEURALIS_HOME elsewhere) and re-run.${c.reset}`);
  const action = await askChoice('What would you like to do?', [
    'Update this installation',
    'Cancel',
  ]);

  if (action === 1) {
    blank();
    step('Setup cancelled.');
    return false;
  }

  return true;
}

// ── Summary ────────────────────────────────────────────────────

function printUsage(ctx: CliContext): void {
  console.log(`Usage: ${spell('setup', ctx)} [options]

Writes the data home, .env, the first owner and project, and docker-compose.yml.
Asks the owner account, the public origin and a free port for a busy one; every
other question takes its default answer, changed later in the app.

  --advanced          ask every question: provider keys, OpenAI, Qdrant, local LLM
                      servers, embedding, desktop prefetch, project name, ChatGPT
                      sign-in callback, trusted proxies
  --compose-only      regenerate docker-compose.yml from .env; asks nothing
  --output DIR        write .env and the compose files into DIR
  --uid N, --gid N    the user and group the stack runs as (default: detected)
  --docker-gid N      the Docker socket's group (default: detected)
  --no-desktop        leave the virtual desktop (machine-core) off; it is off
                      anyway without Docker (Admin → Config turns it on)
  --ollama existing|docker|none   local models, unasked: the Ollama that runs, a
                      compose service (loopback only), or none; existing/docker
                      also make its embedding model the target, enabled
  --tunnel DOMAIN [--access EMAIL|@DOMAIN]   then \`tunnel on DOMAIN\`: reach it
                      from anywhere (app., mcp., sandbox.DOMAIN; Cloudflare)
  --native --yes --owner-email EMAIL [--project NAME]
                      the desktop app's first run: no questions, the password on
                      stdin, .env in the data home's app/config
    --qdrant docker|binary   where its vectors live (default: docker when Docker
                      answers — a compose file of its own beside .env — else the
                      app's own binary)
    --desktop | --no-desktop the virtual desktop (default: on with Docker)
    --ollama existing|docker|binary|none   local models (default: none);
                      binary fetches Ollama into the data home when up starts
    --tunnel DOMAIN [--access EMAIL|@DOMAIN]   then \`tunnel on DOMAIN\`
  --native --yes      the desktop app adopting a home a Docker install set up:
                      only its own .env, using that install's Qdrant; users and
                      projects stay as they are
    --qdrant binary [--copy-vectors]   its own Qdrant instead, the Docker vectors
                      copied in (cold, the Docker Qdrant stopped meanwhile)
  --native --yes --refresh-qdrant [--qdrant binary [--copy-vectors]]
                      a home the app already runs: its Qdrant lines again (after
                      the Docker install's key or port changed)
  --native --yes --lan on|off   a home the app runs: listen on every address of
                      this network (Qdrant and Ollama stay on loopback), or back
  --native --yes --ollama MODE  a home the app runs: change its local models
  Reach it from anywhere: ${spell('tunnel', ctx)} on DOMAIN (a Cloudflare named tunnel).
  -h, --help          this text`);
}

function printSummary(config: SetupConfig, env: DetectedEnv, layout: InstallLayout, advanced: boolean) {
  heading('Setup Complete');

  info(`Owner: ${c.bold}${config.owner.name}${c.reset} <${config.owner.email}>`);
  info(`Project: ${c.bold}${config.projectName}${c.reset} ${c.dim}(${config.projectId})${c.reset}`);
  info(`Data: ${c.bold}${config.neuralisHome}${c.reset}`);

  const keyCount = Object.keys(config.llmKeys).length;
  const keyNames = Object.keys(config.llmKeys).map(k => k.replace('_API_KEY', '')).join(', ');
  if (keyCount > 0) {
    info(`LLM: ${c.bold}${keyNames}${c.reset} ${c.dim}(encrypted in credential store)${c.reset}`);
  } else {
    warn(`LLM: none configured`);
  }

  if (config.qdrant.mode !== 'skip') {
    info(`Qdrant: ${c.bold}${config.qdrant.url}${c.reset} ${c.dim}(${config.qdrant.mode})${c.reset}`);
  } else {
    warn(`Qdrant: skipped (in-memory mode)`);
  }

  const vectorModel = config.vector.modelId ? findEmbeddingModel(config.vector.modelId) : undefined;
  if (!config.vector.enabled) {
    info(`Vector: ${c.bold}no embedding${c.reset} ${c.dim}(text and field search only${config.vector.modelId ? `; target ${config.vector.modelId} kept for a later activation` : ''})${c.reset}`);
  } else if (config.vector.endpoint) {
    info(`Vector: ${c.bold}${config.vector.modelId}${c.reset} ${c.dim}(${config.vector.dimension}d · custom endpoint)${c.reset}`);
  } else if (vectorModel && vectorModel.provider !== 'deterministic') {
    info(
      `Vector: ${c.bold}${vectorModel.id}${c.reset} ${c.dim}(${config.vector.dimension}d · ${tierLabel(vectorModel.tier)})${c.reset}`,
    );
  } else {
    warn(`Vector: deterministic (dev/test only)`);
  }

  info(
    config.machine.enabled
      ? `Machine: ${c.bold}${config.machine.variant.key}${c.reset} ${c.dim}(${config.machine.variant.derivativeImage}${config.machine.pullOnHost ? ', pull it on the host' : config.machine.skipPrefetch ? ', no prefetch' : ', prefetch running in background'})${c.reset}`
      : `Virtual desktop: ${c.bold}off${c.reset} ${c.dim}(machine-core not loaded — Admin → Config, disabledBuiltinPackages)${c.reset}`,
  );

  blank();
  console.log(`  ${c.cyan}${c.bold}Next steps:${c.reset}`);
  blank();

  if (config.deploymentMode === 'native') {
    if (config.qdrant.mode === 'docker') {
      // The native app needs its Qdrant: the compose file setup wrote runs it alone.
      console.log(`    ${c.bold}Start the vector store (Docker):${c.reset}`);
      console.log(`      docker compose up -d qdrant`);
    }
    console.log(`    ${c.bold}Build and start from the host folder:${c.reset}`);
    console.log(`      npm run build`);
    console.log(`      ${spell('start')}`);
  } else if (env.isClone) {
    console.log(`    ${c.bold}Development:${c.reset}`);
    console.log(`      pnpm build && pnpm dev:app`);
    blank();
    console.log(`    ${c.bold}Docker:${c.reset}`);
    console.log(`      cd neuralis && docker compose up -d`);
  } else {
    console.log(`    ${c.bold}Start:${c.reset}`);
    console.log(`      docker compose up -d`);
  }

  blank();
  console.log(`    Then open: ${c.cyan}${c.bold}${config.publicOrigin}${c.reset}`);
  if (!config.tunnelDomain) {
    const derived = singleHostOrigins(config.publicOrigin, config.ports);
    if (config.origins.mcp !== derived.mcp) console.log(`    Kept from .env: MCP_BASE_URL=${config.origins.mcp}`);
    if (config.origins.sandbox) console.log(`    Kept from .env: NEURALIS_MCP_SANDBOX_ORIGIN=${config.origins.sandbox}`);
    if (config.origins.companion) console.log(`    Kept from .env: NEURALIS_COMPANION_ORIGIN=${config.origins.companion}`);
    const tls = tlsPortOrigins(config.origins, config.ports);
    if (tls.length > 0) {
      warn(`The MCP server and the sandbox listen on plain http: your proxy must also serve ${tls.join(' and ')} with TLS,`);
      console.log(`    ${c.dim}or declare names of your own in .env (MCP_BASE_URL, NEURALIS_MCP_SANDBOX_ORIGIN) — the deployment guide's public-origin table lists every shape.${c.reset}`);
    }
    console.log(`    ${c.dim}From anywhere: ${spell('tunnel')} on DOMAIN (a Cloudflare named tunnel; app., mcp. and sandbox.DOMAIN — or setup --tunnel DOMAIN).${c.reset}`);
  }
  blank();
  if (config.machine.pullOnHost) {
    console.log(`  ${c.bold}The virtual desktop's image${c.reset} ${c.dim}(~3 GB; pull it on the host before the first desktop start):${c.reset}`);
    console.log(`      docker pull ${config.machine.variant.derivativeImage}`);
    blank();
  }
  if (!advanced) {
    console.log(`  ${c.cyan}${c.bold}Next, in the app${c.reset} ${c.dim}(signed in as the owner):${c.reset}`);
    console.log(`    Admin → Credentials         AI provider keys, Sign in with ChatGPT`);
    console.log(`    Admin → Vector              the embedding key, turn embedding on, rebuild`);
    console.log(`    Credentials → Custom endpoints   a local or self-hosted LLM server`);
    // In the image the folder is written for the host, whose `neuralis` command runs the image again.
    const everyQuestion = spellOn(layout, 'setup --advanced');
    console.log(`  ${c.dim}Every setup question instead: ${everyQuestion}${c.reset}`);
    blank();
  }
}

/**
 * The next step, offered: an npm folder and a clone run Docker from this folder. Never in the
 * image's one-shot container — it cannot start its own stack; the installer asks there.
 */
async function offerStart(configDir: string): Promise<void> {
  const answer = (await ask('Start Neuralis now?', 'y')).toLowerCase();
  if (answer.startsWith('n')) {
    step(`Start it later in ${configDir}: docker compose up -d`);
    return;
  }
  const code = await new Promise<number | null>((done) => {
    const child = spawn('docker', ['compose', 'up', '-d'], { cwd: configDir, stdio: 'inherit' });
    child.on('error', () => done(null));
    child.on('close', done);
  });
  if (code === 0) info('Neuralis is starting.');
  else warn(`docker compose up -d did not finish (${code === null ? 'docker did not start' : `exit ${code}`}) — run it in ${configDir} once the cause is fixed.`);
}

// ── Main ───────────────────────────────────────────────────────

/** The whole of stdin, its first line — a password never rides argv, env or a log. */
async function readSecretLine(input: NodeJS.ReadableStream): Promise<string> {
  let text = '';
  for await (const chunk of input) text += String(chunk);
  return text.split(/\r?\n/, 1)[0] ?? '';
}

/**
 * The platform-config seed of the virtual-desktop choice: off writes `disabledBuiltinPackages` (merged — an existing value always wins).
 * The choice names its package; whether a boot may leave it out is that package's own manifest declaration (`optional`).
 */
function desktopSeed(enabled: boolean): Record<string, unknown> {
  return enabled ? {} : { [DISABLED_BUILTINS_KEY]: ['@neuralis/machine-core'] };
}

/**
 * The desktop app's own host turns the host-access plane ON: its first run
 * pairs this computer as the owner's device, and with the plane off every
 * folder of it answers `devices_disabled`. The key is the kill-switch, not
 * the gate — pairing on the machine, a ceiling that grants no folder until
 * the owner names one, and the OS sandbox still decide — and merged: an existing `false` (an operator's choice) stays.
 * A Docker install's seed never carries it (the server as a device is its own
 * decision there).
 */
const NATIVE_HOST_PLANE_SEED: Readonly<Record<string, unknown>> = Object.freeze({ hostBrokerEnabled: true });

/** This host's loopback ports — the defaults or the next free ones, never a `reserved` one — and the Qdrant ports its mode listens on (`binary`: REST + gRPC, `docker`: the published REST port). */
async function nativePorts(qdrant: 'binary' | 'docker' | 'none', reserved: number[] = []): Promise<{ ports: PortTriple; qdrantPorts: { http: number; grpc: number } }> {
  const settled = await settleLoopbackPorts([
    { key: 'app', port: 3100, address: '127.0.0.1' },
    { key: 'mcp', port: 3101, address: '127.0.0.1' },
    { key: 'sandbox', port: 3102, address: '127.0.0.1' },
    ...(qdrant !== 'none' ? [{ key: 'qdrant', port: DEFAULT_QDRANT_PORT, address: '127.0.0.1' as const }] : []),
    ...(qdrant === 'binary' ? [{ key: 'qdrantGrpc', port: DEFAULT_QDRANT_GRPC_PORT, address: '127.0.0.1' as const }] : []),
  ], undefined, reserved);
  return {
    ports: { app: settled.get('app')!, mcp: settled.get('mcp')!, sandbox: settled.get('sandbox')! },
    qdrantPorts: { http: settled.get('qdrant') ?? DEFAULT_QDRANT_PORT, grpc: settled.get('qdrantGrpc') ?? DEFAULT_QDRANT_GRPC_PORT },
  };
}

/** The port the home's recorded Docker install publishes its Qdrant on: taken for this app's own binary even while that Qdrant is stopped. */
function recordedDockerQdrantPort(home: string): number[] {
  const recorded = recordedDockerQdrant(home);
  return recorded.ok && recorded.mode === 'docker' && recorded.qdrant.mode === 'external' ? [Number(new URL(recorded.qdrant.url).port)] : [];
}

/** The bundle's Qdrant binary (the kernel's `bundleLayout`: `qdrant.exe` on Windows), or null where the bundle carries none. */
function bundledQdrantOf(packageDir: string): string | null {
  const path = bundleLayout(dirname(packageDir)).qdrant;
  return existsSync(path) ? path : null;
}

/**
 * The bundle's binary on `<home>/qdrant-storage`, with a minted key. A Qdrant
 * version already recorded is never rewritten: on a home Docker set up it
 * describes Docker's store.
 */
async function binaryQdrant(home: string, binary: string, ports: { http: number; grpc: number }): Promise<NativeQdrant> {
  if (!existsSync(qdrantStatePath(home))) {
    await resolveInstallQdrantVersion(binaryInstallProbe({ storageDir: join(home, 'qdrant-storage'), binaryPath: binary, runningVersion: null }), home);
  }
  return { mode: 'binary', apiKey: randomBytes(32).toString('hex'), ports };
}

/** The compose project of a data home's own Qdrant: one per home, so two homes never share a volume. */
function desktopComposeProject(home: string): string {
  return `neuralis-desktop-${createHash('sha256').update(home).digest('hex').slice(0, 8)}`;
}

/** The choices of `setup --native` (`parseNativeFlags`). */
type NativeFlags = {
  qdrant: 'docker' | 'binary' | null; copyVectors: boolean; estimateCopy: boolean; refresh: boolean; desktop: boolean | null;
  /** `--ollama existing|docker|binary|none` — the local-model companion (a new home: default none; a set-up home: rewrites the choice). */
  ollama: OllamaMode | null;
  /** `--lan on|off` — every listener on all of this computer's addresses, or loopback again (a set-up home). */
  lan: boolean | null;
};

function parseNativeFlags(cliArgs: string[], flagValue: (flag: string) => string | null): NativeFlags {
  const qdrant = flagValue('--qdrant');
  if (cliArgs.includes('--qdrant') && qdrant !== 'docker' && qdrant !== 'binary') throw new CliExit(1, '--qdrant takes docker or binary');
  if (cliArgs.includes('--desktop') && cliArgs.includes('--no-desktop')) throw new CliExit(1, '--desktop and --no-desktop exclude each other');
  const lan = flagValue('--lan');
  if (cliArgs.includes('--lan') && lan !== 'on' && lan !== 'off') throw new CliExit(1, '--lan takes on or off');
  const flags: NativeFlags = {
    qdrant: qdrant as NativeFlags['qdrant'],
    copyVectors: cliArgs.includes('--copy-vectors'),
    estimateCopy: cliArgs.includes('--estimate-copy'),
    refresh: cliArgs.includes('--refresh-qdrant'),
    desktop: cliArgs.includes('--desktop') ? true : cliArgs.includes('--no-desktop') ? false : null,
    ollama: parseOllamaFlag(cliArgs, flagValue, OLLAMA_MODES),
    lan: cliArgs.includes('--lan') ? lan === 'on' : null,
  };
  if ((flags.copyVectors || flags.estimateCopy) && flags.qdrant !== 'binary') {
    throw new CliExit(1, '--copy-vectors and --estimate-copy go with --qdrant binary: the Docker vectors are copied only into this app\'s own Qdrant');
  }
  return flags;
}

/** What the copy of the Docker vectors needs from the home's recorded Docker install (docker Qdrant mode only). */
async function copySource(home: string): Promise<{ recorded: Extract<RecordedQdrant, { ok: true }>; docker: { url: string; apiKey: string }; input: TransferInput }> {
  const recorded = recordedDockerQdrant(home);
  if (!recorded.ok) throw new CliExit(1, `Nothing to copy: ${recorded.reason}`);
  if (recorded.mode !== 'docker' || !recorded.volume || recorded.qdrant.mode !== 'external' || !recorded.qdrant.apiKey) {
    throw new CliExit(1, `Nothing to copy: the install in ${recorded.install.dir} keeps no Qdrant volume (QDRANT_MODE=${recorded.mode})`);
  }
  const recordedVersion = (await readQdrantState(qdrantStatePath(home)))?.version ?? null;
  return {
    recorded,
    docker: { url: recorded.qdrant.url, apiKey: recorded.qdrant.apiKey },
    input: { home, installDir: recorded.install.dir, volume: recorded.volume, recordedVersion, bundleVersion: QDRANT_TARGET_VERSION },
  };
}

/** `--estimate-copy`: the size of the Docker vectors and the free space, as one JSON line (the desktop app shows it). Nothing is written. */
async function estimateCopy(home: string, ctx: CliContext): Promise<number> {
  const source = await copySource(home);
  try {
    const plan = await planTransfer({ exec: processExec, freeBytes: async (dir) => { const fs = await statfs(dir); return fs.bavail * fs.bsize; }, log: () => {} }, source.input);
    ctx.stdout(`${JSON.stringify({ bytes: plan.bytes, freeBytes: plan.free, volume: plan.volume })}\n`);
    return 0;
  } catch (err) {
    throw new CliExit(1, err instanceof Error ? err.message : String(err));
  }
}

/** The Docker vectors copied into this app's store before its `.env` names the binary (`--copy-vectors`). */
async function copyVectors(home: string, binary: string, qdrant: Extract<NativeQdrant, { mode: 'binary' }>): Promise<void> {
  const source = await copySource(home);
  const ports = processTransferPorts({ binary, apiKey: qdrant.apiKey, ports: qdrant.ports, docker: source.docker, log: (line) => step(line) });
  try {
    await runTransfer(ports, source.input);
  } catch (err) {
    throw new CliExit(1, err instanceof Error ? err.message : String(err));
  }
}

/** This host's `.env` (`<home>/app/config/.env`), its companions' compose file (a Qdrant and/or an Ollama in Docker), and the data home's record of the bundle. */
async function writeNativeConfig(home: string, packageDir: string, ports: PortTriple, qdrant: NativeQdrant, qdrantImage: string | null, ollama: OllamaMode = 'none'): Promise<void> {
  const configDir = nativeConfigDir(home);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const date = new Date().toISOString().split('T')[0]!;
  const project = qdrant.mode === 'docker' ? qdrant.project : desktopComposeProject(home);
  if (qdrant.mode === 'docker' || ollama === 'docker') {
    if (qdrant.mode === 'docker' && !qdrantImage) throw new Error('the desktop Qdrant\'s compose file needs the recorded Qdrant image');
    await writeDesktopCompanionCompose(configDir, {
      project,
      qdrant: qdrant.mode === 'docker' ? { image: qdrantImage!, port: qdrant.port } : null,
      ollama: ollama === 'docker' ? { port: OLLAMA_OWN_PORT } : null,
    }, { date, version: await readNeuralisVersion(packageDir) });
  }
  await replaceEnvFile(join(configDir, '.env'), `${nativeEnvLines({ date, ports, bindHost: '127.0.0.1', qdrant, ollama: { mode: ollama, port: OLLAMA_OWN_PORT, composeProject: project } }).join('\n')}\n`, 0o600);
  await recordInstall(home, packageDir);
}

/** The unasked embedding answer a home without a local model takes: the recommended model, off until its key. */
function unaskedEmbedding(): { modelId: string; dimension: number } | undefined {
  const recommended = recommendedEmbeddingModel();
  return recommended ? { modelId: recommended.id, dimension: recommended.defaultDimension } : undefined;
}

/**
 * `--lan on|off` on a home this app runs: every listener (the app, the MCP
 * server, the sandbox origin) on all of this computer's addresses — Qdrant and
 * Ollama stay on loopback, they have no login — or back on loopback. The
 * origins follow (this computer's network address, or loopback) unless a
 * tunnel names them; an MCP or sandbox origin the operator declared stays. Topology: the `.env` only, never a platform setting.
 */
async function switchNativeLan(home: string, on: boolean): Promise<number> {
  const envPath = join(nativeConfigDir(home), '.env');
  const text = readFileSync(envPath, 'utf-8');
  const current = parseEnvContentShared(text);
  const ports = carryOverEnv(current).ports;
  const address = on ? lanAddress() : '127.0.0.1';
  if (!address) throw new CliExit(1, 'this computer has no network address other than loopback: nothing on the network could reach it');
  const tunnel = tunnelDomainOf(current);
  const origins = tunnel ? tunnelOrigins(tunnel) : carriedOrigins(current, singleHostOrigins(`http://${address}:${ports.app}`, ports));
  const bind = replaceEnvKey(replaceOriginLines(text, origins, tunnel !== null), 'NEURALIS_BIND_HOST', on ? '0.0.0.0' : '127.0.0.1');
  await replaceEnvFile(envPath, bind, 0o600);
  info(on
    ? `Listening on this computer's network addresses from the next start: others on the network reach ${c.bold}${origins.app}${c.reset}. Qdrant and Ollama stay on loopback.`
    : `Back on loopback from the next start: ${c.bold}${origins.app}${c.reset}.`);
  if (!tunnel) info('The app\'s address changed: MCP and CLI clients sign in again, and paired devices pair again.');
  return 0;
}

/** This computer's first non-internal IPv4 address (the one a LAN origin names), or null. */
function lanAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const entry of addresses ?? []) if (entry.family === 'IPv4' && !entry.internal) return entry.address;
  }
  return null;
}

/** `--ollama <mode>` on a home this app runs: the choice rewritten (`.env`, the companions' file, the platform seed). */
async function switchNativeOllama(home: string, packageDir: string, mode: OllamaMode): Promise<number> {
  const configDir = nativeConfigDir(home);
  const envPath = join(configDir, '.env');
  const text = readFileSync(envPath, 'utf-8');
  const current = parseEnvContentShared(text);
  if (mode === 'docker' && !dockerAnswersHere()) throw new CliExit(1, 'Docker (with Compose) does not answer on this computer: choose binary, existing or none');
  const qdrantDocker = current.QDRANT_MODE?.trim() === 'docker';
  const project = current.NEURALIS_COMPOSE_PROJECT?.trim() || desktopComposeProject(home);
  if (qdrantDocker || mode === 'docker') {
    const state = qdrantDocker ? await readQdrantState(qdrantStatePath(home)) : null;
    if (qdrantDocker && !state) throw new CliExit(1, `${qdrantStatePath(home)} is missing: the Qdrant line of the compose file cannot be written`);
    await writeDesktopCompanionCompose(configDir, {
      project,
      qdrant: qdrantDocker ? { image: qdrantImageRef(state!.version), port: qdrantHostPort(current) } : null,
      ollama: mode === 'docker' ? { port: OLLAMA_OWN_PORT } : null,
    }, { date: new Date().toISOString().split('T')[0]!, version: await readNeuralisVersion(packageDir) });
  }
  const kept = text.split('\n').filter((line) => {
    const key = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
    return !(key && (OLLAMA_ENV_KEYS as readonly string[]).includes(key)) && !line.startsWith('# Local models (Ollama)') && !line.startsWith('# through the platform setting `ollamaUrl`');
  });
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  const extra = !qdrantDocker && mode === 'docker' && !current.NEURALIS_COMPOSE_PROJECT ? [`NEURALIS_COMPOSE_PROJECT=${project}`] : [];
  await replaceEnvFile(envPath, `${[...kept, '', ...ollamaEnvLines(mode, OLLAMA_OWN_PORT), ...extra].join('\n')}\n`, 0o600);
  const change = ollamaPlatformChange(mode, await readPlatformConfig(home), `http://127.0.0.1:${OLLAMA_DEFAULT_PORT}`, unaskedEmbedding());
  await writeMergedPlatformConfig(home, change.seed, change.replace);
  info(`Local models: ${c.bold}${mode}${c.reset}${mode === 'none' ? '' : ` — ${ollamaCostLine(mode)}`} Applies at the next start.`);
  return 0;
}

/** `tunnel on` exactly as the verb runs it (`setupTunnelArgs` validated it before setup wrote anything). */
async function runTunnelOn(args: string[], ctx: CliContext): Promise<number> {
  const { run: tunnel } = await import('./tunnel.mts');
  return tunnel(args, ctx);
}

/** Docker with Compose answers here (the companions' file needs it). */
function dockerAnswersHere(): boolean {
  const docker = detectDocker();
  return docker.available && docker.compose;
}

/** One line naming where this host's vectors live. */
function describeQdrant(qdrant: NativeQdrant): string {
  switch (qdrant.mode) {
    case 'docker': return `Qdrant in Docker on 127.0.0.1:${qdrant.port} (\`neuralis up\` starts it)`;
    case 'external': return qdrant.composeDir ? `the Docker install's Qdrant (${qdrant.url}, from ${qdrant.composeDir})` : `the Qdrant at ${qdrant.url}`;
    case 'binary': return `its own Qdrant on 127.0.0.1:${qdrant.ports.http}`;
    case 'skip': return 'vectors in memory';
  }
}

/** `--refresh-qdrant`: the Qdrant lines of this host's `.env` written again — from the recorded Docker install, or this app's own binary. */
async function refreshNativeQdrant(home: string, packageDir: string, flags: NativeFlags): Promise<number> {
  const envPath = join(nativeConfigDir(home), '.env');
  const text = readFileSync(envPath, 'utf-8');
  const current = parseEnvContentShared(text);
  if (current.QDRANT_MODE?.trim() === 'docker') {
    throw new CliExit(1, `${home} runs this app's own Qdrant in Docker (docker-compose.yml beside ${envPath}); there is no other install's Qdrant to read again`);
  }
  if (flags.qdrant === 'docker') throw new CliExit(1, '--refresh-qdrant reads the Docker install\'s Qdrant by default; --qdrant docker gives a NEW data home its own');
  let qdrant: NativeQdrant;
  if (flags.qdrant === 'binary') {
    const binary = bundledQdrantOf(packageDir);
    if (!binary) throw new CliExit(1, 'this app has no Qdrant binary for this platform');
    qdrant = current.QDRANT_MODE?.trim() === 'binary' && current.QDRANT_API_KEY?.trim()
      ? { mode: 'binary', apiKey: current.QDRANT_API_KEY.trim(), ports: qdrantBinaryPorts(current) }
      : await binaryQdrant(home, binary, (await nativePorts('binary', recordedDockerQdrantPort(home))).qdrantPorts);
    if (flags.copyVectors && qdrant.mode === 'binary') await copyVectors(home, binary, qdrant);
  } else {
    const recorded = recordedDockerQdrant(home);
    if (!recorded.ok) throw new CliExit(1, recorded.reason);
    qdrant = recorded.qdrant;
  }
  await replaceEnvFile(envPath, replaceNativeQdrantLines(text, nativeQdrantLines(qdrant)), 0o600);
  info(`Wrote the Qdrant lines of ${envPath}: ${describeQdrant(qdrant)}. Restart the app for it to take effect.`);
  return 0;
}

/**
 * The desktop app's setup, asking nothing (`--yes`); `.env` lands in
 * `<home>/app/config` (never the read-only bundle).
 *
 *   setup --native --yes --owner-email <e> [--project <name>] [--qdrant docker|binary] [--desktop|--no-desktop]
 *       a NEW data home, the password on stdin. Qdrant runs in Docker by default
 *       when Docker answers — a compose file of its own beside this `.env`, a
 *       named volume per home — else from the bundle's binary; the virtual
 *       desktop (machine-core) is on with Docker and off without (the
 *       `disabledBuiltinPackages` platform setting).
 *   setup --native --yes [--qdrant binary [--copy-vectors | --estimate-copy]]
 *       ADOPT a home another install (Docker) set up: this host's `.env` and the
 *       install record. Its vectors are that install's Qdrant (`recordedDockerQdrant`
 *       — the one thing read outside the home: the install the home records, its
 *       `.env`); `--qdrant binary` gives this app its own store instead, and
 *       `--copy-vectors` copies the Docker vectors into it (cold, counted).
 *   setup --native --yes --refresh-qdrant [--qdrant binary [--copy-vectors]]
 *       a home this app already runs: only the Qdrant lines of its `.env` again.
 *
 * Users, projects, credentials, settings and the session secret of an adopted
 * home are the home's already and are not touched. Refused by name: owner flags
 * on a set-up home, no owner flags on an empty one, a home whose session secret
 * is still in an older Docker install's `.env`, a home this app already runs
 * (`neuralis up` starts it), and every Qdrant the mode table cannot use.
 */
async function runNativeSetup(cliArgs: string[], ctx: CliContext): Promise<number> {
  const flagValue = (flag: string): string | null => {
    const idx = cliArgs.indexOf(flag);
    return idx >= 0 ? (cliArgs[idx + 1] ?? null) : null;
  };
  if (!cliArgs.includes('--yes')) throw new CliExit(1, '--native runs without questions: add --yes (a new data home also needs --owner-email <email> and the password on stdin)');
  if (installKindOf(ctx.packageDir) !== 'native') throw new CliExit(1, '--native sets up the desktop app\'s own host bundle, and this is not one');
  const flags = parseNativeFlags(cliArgs, flagValue);
  const tunnelArgs = setupTunnelArgs(cliArgs);
  const home = resolveNeuralisHome(ctx.env as NodeJS.ProcessEnv).home;
  const ownerFlags = cliArgs.includes('--owner-email') || cliArgs.includes('--project');
  const binary = bundledQdrantOf(ctx.packageDir);
  if (await detectExistingSetup(home)) {
    if (existsSync(join(nativeConfigDir(home), '.env'))) {
      if (flags.lan !== null) return switchNativeLan(home, flags.lan);
      if (flags.ollama !== null) return switchNativeOllama(home, ctx.packageDir, flags.ollama);
      if (flags.refresh) return refreshNativeQdrant(home, ctx.packageDir, flags);
      throw new CliExit(1, `${home} is already set up — start it with \`neuralis up\` (\`--refresh-qdrant\` reads the Docker install's Qdrant again; \`--lan on|off\` and \`--ollama <mode>\` change those choices)`);
    }
    if (flags.lan !== null) throw new CliExit(1, `${home} is not set up for this app yet: --lan changes a home this app runs`);
    if (flags.refresh) throw new CliExit(1, `${home} is not set up for this app yet — adopt it with \`neuralis setup --native --yes\``);
    if (ownerFlags) throw new CliExit(1, `${home} is already set up — adopt it with \`neuralis setup --native --yes\` (no owner flags)`);
    if (flags.desktop !== null) throw new CliExit(1, `--desktop and --no-desktop choose a NEW data home's packages; ${home} keeps its own (Admin → Config, disabledBuiltinPackages)`);
    if (flags.qdrant === 'docker') throw new CliExit(1, 'an adopted home uses its Docker install\'s Qdrant by default; --qdrant binary gives this app its own');
    if (readSessionSecretFile(join(home, 'app')) === null) throw new CliExit(1, `${home} has no session secret file yet: ${UPGRADE_DOCKER_FIRST}`);
    if (flags.estimateCopy) return estimateCopy(home, ctx);
    let qdrant: NativeQdrant;
    let ports: PortTriple;
    if (flags.qdrant === 'binary') {
      if (!binary) throw new CliExit(1, 'this app has no Qdrant binary for this platform: keep the Docker install\'s Qdrant (no --qdrant)');
      const settled = await nativePorts('binary', recordedDockerQdrantPort(home));
      ports = settled.ports;
      qdrant = await binaryQdrant(home, binary, settled.qdrantPorts);
      if (flags.copyVectors && qdrant.mode === 'binary') await copyVectors(home, binary, qdrant);
    } else {
      const recorded = recordedDockerQdrant(home);
      if (!recorded.ok) throw new CliExit(1, recorded.reason);
      qdrant = recorded.qdrant;
      ports = (await nativePorts('none')).ports;
    }
    await writeNativeConfig(home, ctx.packageDir, ports, qdrant, null);
    info(`Adopted ${c.bold}${home}${c.reset} for this app: app on http://127.0.0.1:${ports.app}, ${describeQdrant(qdrant)}. Users, projects and settings are unchanged.`);
    return 0;
  }
  if (flags.refresh || flags.copyVectors || flags.estimateCopy) throw new CliExit(1, `${home} is a new data home: --refresh-qdrant, --copy-vectors and --estimate-copy act on a home another install set up`);
  if (tunnelArgs && flags.lan !== null) throw new CliExit(1, '--lan changes a home this app already runs; set the home up first');
  const email = flagValue('--owner-email')?.trim().toLowerCase() ?? '';
  if (!email.includes('@')) throw new CliExit(1, '--owner-email <email> is required: this data home has no owner yet');
  const password = await readSecretLine(ctx.stdin);
  if (password.length < 8) throw new CliExit(1, 'The password (on stdin) must be at least 8 characters');
  const project = resolveSetupProjectId({ existingSetup: false, projects: [], answer: flagValue('--project')?.trim() || 'My Workspace' });
  if (!project.ok) throw new CliExit(1, project.reason);

  // Docker is asked only when a default depends on it.
  const docker = flags.qdrant === 'binary' && flags.desktop !== null && flags.ollama !== 'docker' ? null : detectDocker();
  const dockerAnswers = docker !== null && docker.available && docker.compose;
  const mode = flags.qdrant ?? (dockerAnswers ? 'docker' : 'binary');
  if (mode === 'docker' && !dockerAnswers) {
    throw new CliExit(1, 'Docker (with Compose) does not answer on this computer: start it, or keep the vectors in this app\'s own Qdrant (--qdrant binary)');
  }
  const desktop = flags.desktop ?? dockerAnswers;
  const ollama = flags.ollama ?? 'none';
  if (ollama === 'docker' && !dockerAnswers) throw new CliExit(1, 'Docker (with Compose) does not answer on this computer: --ollama binary downloads Ollama for this app instead');
  const settled = await nativePorts(mode === 'docker' ? 'docker' : binary ? 'binary' : 'none');
  const { ports } = settled;
  let qdrant: NativeQdrant;
  let qdrantImage: string | null = null;
  if (mode === 'docker') {
    const composeProject = desktopComposeProject(home);
    const version = await resolveInstallQdrantVersion(dockerInstallProbe({ composeProject, composeFilePath: join(nativeConfigDir(home), 'docker-compose.yml'), runningVersion: null }), home);
    qdrantImage = qdrantImageRef(version);
    qdrant = { mode: 'docker', apiKey: randomBytes(32).toString('hex'), port: settled.qdrantPorts.http, project: composeProject };
  } else {
    qdrant = binary ? await binaryQdrant(home, binary, settled.qdrantPorts) : { mode: 'skip' };
  }
  const vectors = qdrant.mode !== 'skip';
  const recommended = recommendedEmbeddingModel();
  const config: SetupConfig = {
    owner: { email, name: email.split('@')[0] || 'owner', passwordHash: await bcrypt.hash(password, 12) },
    ownerUserId: randomUUID(),
    llmKeys: {},
    qdrant: {
      url: vectors ? `http://127.0.0.1:${settled.qdrantPorts.http}` : '',
      mode: qdrant.mode === 'external' ? 'external' : qdrant.mode,
      apiKey: qdrant.mode === 'docker' || qdrant.mode === 'binary' ? qdrant.apiKey : null,
      port: settled.qdrantPorts.http,
      grpcPort: settled.qdrantPorts.grpc,
    },
    // The unasked answer of the wizard: the recommended model as the target, off until its key is added in the app.
    vector: vectors && recommended ? { enabled: false, modelId: recommended.id, dimension: recommended.defaultDimension } : { enabled: false },
    machine: { variant: DEFAULT_MACHINE_VARIANT, skipPrefetch: true, pullOnHost: false, enabled: desktop },
    neuralisHome: home,
    projectId: project.projectId,
    projectName: project.projectName,
    deploymentMode: 'native',
    codexLoopback: false,
    trustedProxies: '',
    buildNpmrc: null,
    imageTag: null,
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
    dockerGid: null,
    localLLMs: [],
    endpointKeys: {},
    publicOrigin: `http://127.0.0.1:${ports.app}`,
    tunnelDomain: null,
    tunnelRestore: null,
    origins: singleHostOrigins(`http://127.0.0.1:${ports.app}`, ports),
    ports,
    composeProject: '',
  };
  await createDirectorySkeleton(home, config.projectId);
  // The secret BEFORE the owner: a crash between the two must never read as a home an earlier release set up (`secret_moved`).
  await writeSessionSecretFile(join(home, 'app'), mintSessionSecret());
  const userId = await writeOwnerRecord(config);
  await stampFreshHomeDataFormats(home);
  await writeProjectRecord(config, userId);
  await writeSourceConfigsPreserving(home, config.projectId, userId);
  await generateKeyFiles(home);
  await writeMergedPlatformConfig(home, {
    ...(config.vector.modelId ? { embeddingModelId: config.vector.modelId } : {}),
    ...(config.vector.dimension !== undefined ? { embeddingDimension: config.vector.dimension } : {}),
    ...(config.vector.enabled ? {} : { embeddingEnabled: false }),
    ...desktopSeed(desktop),
    ...NATIVE_HOST_PLANE_SEED,
    ...(vectors ? ollamaPlatformChange(ollama, {}, `http://127.0.0.1:${OLLAMA_DEFAULT_PORT}`, unaskedEmbedding()).seed : {}),
  });
  await writeNativeConfig(home, ctx.packageDir, ports, qdrant, qdrantImage, ollama);
  info(`Set up ${c.bold}${home}${c.reset}: owner ${email}, project ${config.projectName}, app on ${config.publicOrigin}, ${describeQdrant(qdrant)}, virtual desktop ${desktop ? 'on' : 'off'}, local models ${ollama}.`);
  if (ollama !== 'none') info(`Local models: ${ollamaCostLine(ollama)} \`neuralis up\` fetches what is missing in the background; indexing waits for the model.`);
  if (tunnelArgs) return runTunnelOn(tunnelArgs, ctx);
  info(`To reach it from other devices: \`${spell('tunnel')} on DOMAIN\` (a Cloudflare tunnel; \`--tunnel DOMAIN\` does it during setup), or \`${spell('setup')} --native --yes --lan on\` (this network only).`);
  return 0;
}

export async function run(cliArgs: string[], ctx: CliContext): Promise<number> {
  if (cliArgs.includes('--help') || cliArgs.includes('-h')) {
    printUsage(ctx);
    return 0;
  }
  if (cliArgs.includes('--native')) return runNativeSetup(cliArgs, ctx);
  // The full question set; without it every question but the owner, the address and a busy
  // port takes its default answer, and the summary names where each one is changed in the app.
  const advanced = cliArgs.includes('--advanced');
  const flagValue = (flag: string): string | null => {
    const idx = cliArgs.indexOf(flag);
    return idx >= 0 ? (cliArgs[idx + 1] ?? null) : null;
  };
  const outputOverride = flagValue('--output');
  const ollamaFlag = parseOllamaFlag(cliArgs, flagValue, ['existing', 'docker', 'none']);
  const tunnelArgs = setupTunnelArgs(cliArgs);
  // `tunnel on` acts on the install folder's `.env`: a run writing elsewhere could not reach it.
  if (tunnelArgs && outputOverride) throw new CliExit(1, '--tunnel acts on this install folder: run it without --output, or `neuralis tunnel on DOMAIN` in the folder afterwards');

  // Host identity overrides for the generated compose (user/group and the
  // docker supplementary group). Detection reads the running process and the
  // socket, so the image run as the host user with the socket bound already
  // sees the host's; a wrong value produces a stack that cannot write its own
  // data directory.
  const numericFlag = (flag: string): number | null => {
    const raw = flagValue(flag);
    if (raw === null) return null;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) throw new CliExit(1, `${flag} expects a non-negative integer, got "${raw}"`);
    return parsed;
  };
  const uidOverride = numericFlag('--uid');
  const gidOverride = numericFlag('--gid');
  const dockerGidOverride = numericFlag('--docker-gid');

  // Fast path: regenerate docker-compose.yml from existing config, no wizard.
  if (cliArgs.includes('--compose-only')) {
    await runComposeOnly(ctx, outputOverride, { uid: uidOverride, gid: gidOverride, dockerGid: dockerGidOverride });
    return 0;
  }

  printBanner();
  initReadline();

  try {
    // 1. Auto-detect
    const env = await detectEnvironment(ctx.installDir);
    const layout = installLayout(ctx.installDir, ctx.packageDir);
    printDetection(env, layout);
    const image = await setupPreflight(ctx, env, await readNeuralisVersion(ctx.packageDir), false, outputOverride);
    // 1b. No Docker (a checkout; an npm folder and the image refused above): asked before any write.
    const noDocker = env.docker ? null : await askNoDocker();
    if (noDocker === 'install') {
      blank();
      step('Install Docker Engine with Compose v2: https://docs.docker.com/engine/install/');
      step('Your user must reach the daemon without sudo (`docker info` answers).');
      step(`Then re-run: ${spellOn(layout, 'setup')}`);
      step('Nothing was written.');
      return 0;
    }
    await preflightDataRoot(env, image);

    // 2. Check existing setup
    const proceed = await handleExistingSetup(env);
    if (!proceed) { rl.close(); return 0; }

    // 2b. Read back what a previous run recorded. Everything below defaults to
    // the existing value: a maintenance re-run must not silently re-decide the
    // origin, the ports, the session secret or the compose project name.
    const configDir = resolveConfigDir(env, outputOverride);
    const existingEnv = await readEnvFile(configDir);
    const carried = carryOverEnv(existingEnv);

    // 2b-2. Compose project name — preserved on an existing install, because it
    // prefixes the named volumes and every container name. Whatever this name
    // publishes is this install's own: never a busy port, never a foreign Qdrant.
    const composeFilePath = join(configDir, 'docker-compose.yml');
    const composeProject = resolveComposeProject({ existingName: carried.composeProject, composeFilePath, projects: await probeComposeProjects() });
    if (composeProject.reason === 'derived') {
      warn(`Another Compose project already answers to "neuralis" on this daemon.`);
      info(`Using project name ${c.bold}${composeProject.name}${c.reset} for this install.`);
    }
    const ports = portCheck(layout, env.docker);
    const qdrantAnswer = await answeringQdrant(env, carried, composeProject.name, ports);

    // 2c. The project gate runs BEFORE any credential is collected: on an
    // existing install the wizard maintains a project already on disk — named
    // by the owner, kept under its STORED id and owner — and never mints one.
    // Answering with a name no record carries used to write a whole orphan tree
    // (skeleton + source configs under a project record that was never created).
    let maintained: SetupProjectResolution | null = null;
    if (env.existingSetup) {
      const existingProjects = await listExistingProjects(env.neuralisHome);
      const live = existingProjects.filter((p) => !p.archivedAt);
      let answered = '';
      if (live.length > 0) {
        heading('Project');
        for (const p of live) info(`Existing project: ${c.bold}${p.name}${c.reset} ${c.dim}(id: ${p.id})${c.reset}`);
        answered = await ask('Project to maintain (name or id)', live[0]!.name);
      }
      maintained = resolveSetupProjectId({ existingSetup: true, projects: existingProjects, answer: answered });
      if (!maintained.ok) {
        blank();
        fail(maintained.reason);
        step('Setup maintains an existing project; it cannot create a second one.');
        step('Create additional projects from the app, or point NEURALIS_HOME at a fresh directory.');
        rl.close();
        return 1;
      }
    }

    const orphans = await findOrphanSourceConfigDirs(env.neuralisHome);
    if (orphans.length > 0) {
      blank();
      warn(`${orphans.length} source-config director${orphans.length > 1 ? 'ies' : 'y'} with no project record:`);
      for (const orphan of orphans) step(`${c.dim}app/config/sources/${orphan}${c.reset}`);
      step('Left untouched — remove by hand once you have confirmed they are unused.');
    }

    // 3. Owner account — a re-run keeps every user, so it asks nothing here.
    const owner = env.existingSetup && maintained?.ok && maintained.ownerUserId
      ? await readOwnerRecord(env.neuralisHome, maintained.ownerUserId)
      : await askOwner();

    // 3b. Deployment mode — determines how loopback URLs are stored. Must
    // run before any step that writes service URLs (chooseVectorConfig,
    // configureLocalLLMs). An npm install folder and the image write a folder
    // that runs the published image, so they are Docker only; native runs from
    // a source clone (or the host package itself). The early no-Docker answer already chose native.
    const deploymentMode = layout === 'folder' || insideImage(layout) ? 'docker' : noDocker && !advanced ? 'native' : await askDeploymentMode(env);

    // 4. LLM keys (excl. OpenAI) + OpenAI via API-key / ChatGPT OAuth / both.
    // Unasked: no key (the default answer of every key prompt) — Admin → Credentials holds them.
    const llmKeys = advanced ? await askLlmKeys() : {};
    const openaiAuth: OpenAIAuth = advanced ? await askOpenAIAuth() : {};
    if (openaiAuth.apiKey) llmKeys['OPENAI_API_KEY'] = openaiAuth.apiKey;

    // 5. Qdrant — the carried key rides in so the MODE decides mint/ask/none,
    // and the binary path can hand the resolved key to the spawn env BEFORE
    // the server starts (a keyless server under keyed clients is an outage).
    const qdrant = await ensureQdrant(env, carried, qdrantAnswer, async (port) => {
      const claim: PortClaim = { key: 'qdrant', port, address: '127.0.0.1' };
      return (await nextFreePorts([claim], [], { probe: ports.probe, published: await ports.published() })).get('qdrant')!;
    }, advanced, noDocker);

    // 6. Custom LLM endpoints — probe the standard ports, let the user add
    // any reachable one. Runs BEFORE chooseVectorConfig so the embedding
    // step can offer "use the same Ollama for embeddings?" without needing
    // a second copy of the URL.
    const localLlmChoice = await configureLocalLLMs(env, deploymentMode, advanced, ollamaFlag);
    const localLLMs = localLlmChoice.entries;

    // 6b. Vector (embeddings) — interactive, registry-driven.
    const vector = await chooseVectorConfig(env, llmKeys, qdrant.mode, deploymentMode, localLLMs, advanced, ollamaFlag);

    // 6c. Machine-core (virtual desktop) — bundled desktop + background image prefetch.
    const machine = await chooseMachineVariant(env, layout, advanced, cliArgs.includes('--no-desktop'));

    // 7. Project — already settled above on an existing install; a fresh one
    // mints its id from the name through the app's own derivation.
    if (!maintained?.ok) {
      heading('Project');
      const answered = advanced ? await ask('Project name', 'My Workspace') : 'My Workspace';
      maintained = resolveSetupProjectId({ existingSetup: false, projects: [], answer: answered });
    }
    if (!maintained.ok) throw new Error(maintained.reason);
    const { projectId, projectName } = maintained;
    info(`Project: ${c.bold}${projectName}${c.reset} ${c.dim}(id: ${projectId})${c.reset}`);

    // 7a. Host ports — every busy one named with its holder and a free one
    // offered, before anything is written (Docker: the compose file publishes
    // them). A native checkout's FIRST run takes the defaults or the next free
    // ones (`neuralis start` binds what .env names); a re-run keeps the recorded
    // ports, which its own running app may be holding.
    const settled = deploymentMode === 'docker'
      ? await settlePorts(portClaims({ ports: carried.ports, qdrantPort: qdrant.mode === 'docker' ? qdrant.port : null, codex: true }), ports, composeProject.name)
      : { ports: existingEnv.NEURALIS_APP_PORT ? carried.ports : (await nativePorts('none')).ports, qdrantPort: null, codexHolder: undefined };
    if (settled.qdrantPort !== null) Object.assign(qdrant, { port: settled.qdrantPort, url: `http://localhost:${settled.qdrantPort}` });

    // 7b. The public origin — the one value the wizard cannot detect. It is
    // what NEXTAUTH_URL and APP_URL become (the compose file reads them from .env),
    // and a stale localhost value breaks the login round-trip for every user
    // who reaches the deployment by any other name.
    heading('Public origin');
    step('The origin users will actually reach this deployment on.');
    step(`${c.dim}Leave as-is for a single-machine install; use the LAN IP or domain otherwise.${c.reset}`);
    // A tunnel this install runs (`neuralis tunnel on`) keeps its origins: a re-run never asks them away.
    const tunnelDomain = carried.tunnelDomain;
    let publicOrigin: string | null = tunnelDomain ? tunnelOrigins(tunnelDomain).app : null;
    if (tunnelDomain) step(`${c.dim}Kept: the tunnel on ${tunnelDomain} (\`neuralis tunnel off\` puts the origins back on this machine).${c.reset}`);
    while (publicOrigin === null) {
      const answered = await ask('Public origin', originDefault(carried.publicOrigin, carried.ports.app, settled.ports.app));
      publicOrigin = normalizePublicOrigin(answered);
      if (publicOrigin === null) fail('Not a usable origin — expected something like http://192.168.1.20:3100');
    }
    info(`Public origin: ${c.bold}${publicOrigin}${c.reset}`);

    // 7b-2. The Codex loopback opt-in — Docker only, and asked AFTER the origin
    // because a non-loopback origin makes the publish ineffective. The default
    // is the carried `.env` value, so a fresh install defaults to off.
    const codexQuestion = codexLoopbackQuestion({
      deploymentMode,
      carried: carried.codexLoopback,
      publicOrigin,
    });
    // A held callback port is named, and the default turns to "no": the stack would not start.
    const codexDefault = codexQuestion.ask && codexQuestion.defaultOn && settled.codexHolder === undefined;
    let codexLoopback = codexQuestion.ask ? codexDefault : codexQuestion.value;
    if (codexQuestion.ask && advanced) {
      heading('ChatGPT sign-in callback');
      step('Publish port 1455 on this machine\'s loopback so a browser ON this machine can finish a ChatGPT sign-in by itself.');
      step(`${c.dim}The price: Docker holds 127.0.0.1:1455 for as long as the stack runs — \`codex login\` (and this wizard's own ChatGPT sign-in on a later re-run) cannot use that port meanwhile, and the stack will not start while another program holds it.${c.reset}`);
      step(`${c.dim}Without it the sign-in still works: you paste the final callback URL into the Credentials tab.${c.reset}`);
      if (settled.codexHolder !== undefined) {
        warn(`127.0.0.1:1455 is in use${settled.codexHolder ? ` — held by ${settled.codexHolder}` : ''}: publishing it would keep the stack from starting.`);
      }
      if (!codexQuestion.effective) {
        warn(`${publicOrigin} is not a loopback origin — browsers reach this deployment by another name, so the publish has no effect for them.`);
      }
      const idx = await askChoice(
        'Publish the ChatGPT sign-in callback?',
        ['No — finish sign-ins by pasting the callback URL', 'Yes — publish 127.0.0.1:1455 while the stack runs'],
        codexDefault ? 1 : 0,
      );
      codexLoopback = idx === 1;
      info(`ChatGPT sign-in callback: ${c.bold}${codexLoopback ? 'published on 127.0.0.1:1455' : 'paste the callback URL'}${c.reset}`);
    }

    // 7b-3. Trusted reverse proxies — topology, never a tunable. The default is
    // the carried value; a fresh install trusts none (only the socket peer). A
    // loopback origin has no proxy in front of it: asked only for another origin.
    // A tunnel's connector dials loopback: no proxy address to declare (its header rule is the host's own).
    let trustedProxies: string | null = advanced || (!isLoopbackPublicOrigin(publicOrigin) && !tunnelDomain) ? null : normalizeTrustedProxies(carried.trustedProxies);
    if (trustedProxies === null) {
      heading('Reverse proxy');
      step('Only when a reverse proxy fronts the app: its address (or CIDR), so logins and webhooks are limited per real client.');
      step(`${c.dim}Leave empty otherwise — a forwarding header is then never believed. \`none\` clears a carried value.${c.reset}`);
    }
    while (trustedProxies === null) {
      trustedProxies = normalizeTrustedProxies(await ask('Trusted proxies', carried.trustedProxies));
      if (trustedProxies === null) fail('Not an address or CIDR list — expected something like 10.0.0.5 or 172.18.0.0/16');
    }
    info(`Trusted proxies: ${c.bold}${trustedProxies || 'none'}${c.reset}`);

    // 7d. The Qdrant image is the version this install's storage is on — decided
    // BEFORE anything below writes, so a refusal leaves the install untouched.
    const qdrantImage = qdrant.mode === 'docker'
      ? qdrantImageRef(await resolveInstallQdrantVersion(
        dockerInstallProbe({
          composeProject: composeProject.name,
          composeFilePath,
          runningVersion: qdrant.runningVersion,
        }),
        env.neuralisHome,
      ))
      : null;

    const config: SetupConfig = {
      owner,
      ownerUserId: randomUUID(),
      llmKeys,
      qdrant,
      vector,
      machine,
      localLLMs,
      endpointKeys: localLlmChoice.keys,
      neuralisHome: env.neuralisHome,
      projectId,
      projectName,
      publicOrigin,
      tunnelDomain,
      tunnelRestore: tunnelDomain ? carried.tunnelRestore : null,
      // A tunnel's three, else the answer's derivation with the MCP and sandbox origins the operator declared kept.
      origins: tunnelDomain ? tunnelOrigins(tunnelDomain) : carriedOrigins(existingEnv, singleHostOrigins(publicOrigin, settled.ports)),
      ports: settled.ports,
      composeProject: composeProject.name,
      deploymentMode,
      codexLoopback,
      trustedProxies,
      buildNpmrc: carried.buildNpmrc,
      // Carried, never re-derived: an update moves the tag and never the
      // scaffold's host version, so re-deriving would step the install back.
      imageTag: initialImageTag(carried.imageTag, await readNeuralisVersion(ctx.packageDir), env.isClone),
      codexBlob: openaiAuth.codexBlob,
      uid: uidOverride ?? env.uid,
      gid: gidOverride ?? env.gid,
      dockerGid: dockerGidOverride ?? env.dockerGid,
    };

    // 8. Create dirs
    heading('Creating data directories');
    await createDirectorySkeleton(env.neuralisHome, projectId);
    info(`Data directory: ${c.bold}${env.neuralisHome}${c.reset}`);
    // The session secret BEFORE the owner record: a crash between the two must never
    // read as a home an earlier release set up (the boot's `secret_moved`).
    await ensureSessionSecret(env.neuralisHome, carried.nextAuthSecret);

    let sourceConfigUserId = config.ownerUserId;

    // 9. Write records
    if (!env.existingSetup) {
      const userId = await writeOwnerRecord(config);
      await stampFreshHomeDataFormats(config.neuralisHome);
      info(`Owner account created: ${c.bold}${config.owner.email}${c.reset}`);
      await writeProjectRecord(config, userId);
      info(`Project created: ${c.bold}${config.projectName}${c.reset}`);
      sourceConfigUserId = userId;
    } else {
      step('Keeping existing users and projects');
      // The maintained record's own owner — `resolveSetupProjectId` refused a
      // record without one, so the seeded configs never carry a minted id.
      if (!maintained.ownerUserId) throw new Error(`Project "${projectId}" has no owner recorded.`);
      sourceConfigUserId = maintained.ownerUserId;
    }

    // Source configs are PRESERVED: an existing file carries admin edits to
    // permissions, uri-policy rows and sync excludes that a re-seed would
    // silently discard. Only a missing one is filled in.
    const sourceResult = await writeSourceConfigsPreserving(
      env.neuralisHome,
      config.projectId,
      sourceConfigUserId,
    );
    if (sourceResult.written.length > 0) {
      info(`Source configs seeded: ${sourceResult.written.join(', ')}`);
    }
    if (sourceResult.preserved.length > 0) {
      step(`Source configs kept unchanged: ${sourceResult.preserved.join(', ')}`);
    }

    if (sourceConfigUserId !== config.ownerUserId) {
      config.ownerUserId = sourceConfigUserId;
    }

    // 10. Generate credential key files (the session secret is written in step 8)
    heading('Security');
    const { masterKey, salt } = await generateKeyFiles(env.neuralisHome);
    info(`Credential master key: ${c.dim}generated (credential-master.key)${c.reset}`);
    info(`Installation salt: ${c.dim}generated (credential-salt.bin)${c.reset}`);

    // 11. Write credentials to encrypted store
    const credCount = await writeCredentials(config, masterKey, salt);
    if (credCount > 0) {
      info(`${credCount} credential${credCount > 1 ? 's' : ''} written to encrypted store`);
    }

    // 12. Merge platform.json (runtime config) — existing keys are the
    // operator's decisions and are never overwritten by a re-run.
    const platformSeed: Record<string, unknown> = {
      ...(config.vector.modelId ? { embeddingModelId: config.vector.modelId } : {}),
      ...(config.vector.dimension !== undefined ? { embeddingDimension: config.vector.dimension } : {}),
      // Only ever `false`: the declared default is on, and a merged re-run keeps an existing value.
      ...(config.vector.enabled ? {} : { embeddingEnabled: false }),
      machineDesktopVariant: config.machine.variant.key,
      machineImage: config.machine.variant.derivativeImage,
      ...desktopSeed(config.machine.enabled),
    };
    if (config.vector.ollamaUrl) {
      platformSeed.ollamaUrl = config.vector.ollamaUrl;
    } else if (env.ollama.running) {
      platformSeed.ollamaUrl = hostReachableUrl(env.ollama.url, config.deploymentMode);
    }
    if (config.localLLMs.length > 0) {
      platformSeed.localLLMs = config.localLLMs;
    }
    if (config.vector.endpoint) {
      platformSeed.embeddingEndpoints = [config.vector.endpoint];
    }
    const platformResult = await writeMergedPlatformConfig(env.neuralisHome, platformSeed);
    info(`Platform config: ${c.bold}${platformResult.filePath}${c.reset}`);
    if (platformResult.kept.length > 0) {
      step(`Kept ${platformResult.kept.length} existing setting${platformResult.kept.length > 1 ? 's' : ''}: ${platformResult.kept.join(', ')}`);
    }

    // 13. Generate minimal .env (infra topology only)
    await generateEnvFile(config, env, configDir);

    // 13b. Generate docker-compose.yml (machine-specific topology — same
    // artifact family as .env; see docs/architect/setup-and-update.md).
    await generateComposeFile(composeInputFromSetup(config, env, qdrantImage), configDir, {
      askOverwrite: true, version: await readNeuralisVersion(ctx.packageDir), installDir: ctx.installDir, packageDir: ctx.packageDir, dataHome: env.neuralisHome,
    });
    // 13c. The data home's record of this folder: `neuralis` finds it from anywhere.
    await recordInstall(env.neuralisHome, configDir);

    // 13d. `--tunnel DOMAIN`: the ONE `tunnel on` path, now that `.env` and the compose file exist.
    if (tunnelArgs) {
      const code = await runTunnelOn(tunnelArgs, ctx);
      if (code !== 0) return code;
    }

    // 14. Summary, then the start offered where this process can start the stack.
    printSummary(config, env, layout, advanced);
    if (layout === 'folder' || (layout === 'clone' && deploymentMode === 'docker')) await offerStart(configDir);

  } finally {
    rl.close();
  }
  return 0;
}
