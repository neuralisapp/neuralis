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
 *   --uid <n>        Host user id for the generated compose. Detection is
 *   --gid <n>        wrong inside a container — it sees its own user, not the
 *   --docker-gid <n> host's, and the docker socket's group is invisible
 *                    through the bind. Read them on the HOST with:
 *                      id -u ; id -g ; stat -c %g /var/run/docker.sock
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { mkdir, writeFile, access, stat, readFile } from 'node:fs/promises';
import { constants as fsConstants, existsSync, readFileSync } from 'node:fs';
import { randomBytes, randomUUID, createCipheriv, createHash, hkdf } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
// The app's own slug + project-id derivation (`src/lib/utils.ts`, dependency-free).
import { slugify } from '../src/lib/utils';
// Source config seeding is a drift-tested port of the canonical builder in
// `./setup/records.mts`.

import { detectEnvironment, resolveConfigDir, type DetectedEnv } from './setup/detect.mts';
import { writeMergedPlatformConfig } from './setup/platformConfig.mts';
import {
  createDirectorySkeleton,
  findOrphanSourceConfigDirs,
  listExistingProjects,
  resolveSetupProjectId,
  type SetupProjectResolution,
  writeOwnerRecord,
  writeProjectRecord,
  writeSourceConfigsPreserving,
} from './setup/records.mts';
import {
  buildOriginLines,
  carryOverEnv,
  codexLoopbackOptIn, codexLoopbackQuestion,
  normalizeTrustedProxies, trustedProxiesLines, buildNpmrcLines,
  imageTagLines, initialImageTag, resolveImageTag,
  normalizePublicOrigin,
  readEnvFile,
  resolveQdrantApiKey,
  parseEnvContent as parseEnvContentShared,
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
  buildComposeContent,
  hostReachableUrl,
  resolveBuildInputs,
  type BuildInputs,
  type ComposeEmitInput,
} from './setup/compose.mts';
import { listLocalSources } from './build/build-workspace.mjs';
import {
  assessQdrantGap,
  binaryInstallProbe,
  dockerInstallProbe,
  qdrantImageRef,
  qdrantStatePath,
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

async function askSensitive(prompt: string): Promise<string> {
  const label = `  ${c.white}${prompt}: ${c.reset}`;
  process.stdout.write(label);

  return new Promise((resolve) => {
    const chars: string[] = [];
    const wasRaw = stdin.isRaw;
    if (stdin.setRawMode) stdin.setRawMode(true);
    stdin.resume();

    const redraw = () => {
      // Clear line and redraw with masked value
      stdout.write(`\r\x1b[2K${label}${'*'.repeat(chars.length)}`);
    };

    const onData = (key: Buffer) => {
      const ch = key.toString();
      if (ch === '\r' || ch === '\n') {
        if (stdin.setRawMode) stdin.setRawMode(wasRaw ?? false);
        stdin.removeListener('data', onData);
        // Show (hidden) instead of the masked value
        stdout.write(`\r\x1b[2K${label}${c.dim}(hidden)${c.reset}\n`);
        resolve(chars.join(''));
      } else if (ch === '\x7f' || ch === '\b') {
        if (chars.length > 0) {
          chars.pop();
          redraw();
        }
      } else if (ch === '\x03') {
        // Ctrl+C
        process.exit(1);
      } else if (ch.charCodeAt(0) >= 32) {
        chars.push(ch);
        redraw();
      }
    };

    stdin.on('data', onData);
  });
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
  key: 'ubuntu-xfce', label: 'Ubuntu + XFCE', derivativeImage: 'neuralisapp/webtop-ubuntu-xfce:dev',
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

function printDetection(env: DetectedEnv) {
  heading('Detecting environment');

  const platformNames: Record<string, string> = {
    linux: 'Linux', macos: 'macOS', windows: 'Windows', wsl: 'Linux (WSL2)',
  };
  info(`Platform: ${c.bold}${platformNames[env.platform] ?? env.platform}${c.reset}`);

  if (env.docker) {
    info(`Docker: ${c.bold}available${c.reset} ${c.dim}(${env.dockerVersion})${c.reset}`);
  } else {
    step(`Docker: ${c.dim}not available${c.reset}`);
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
  info(`Mode: ${c.bold}${env.isClone ? 'git clone (development)' : 'npm install'}${c.reset}`);
}

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

async function tryAutoFixOwnership(root: string, platform: import('./setup/detect.mts').Platform): Promise<void> {
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
): Promise<void> {
  const details = await stat(target).catch(() => null);

  // Check root ownership first — offer auto-fix
  if (details && isRootOwned(details, platform)) {
    await tryAutoFixOwnership(root, platform);
    return; // Re-check not needed — chown -R covers everything
  }

  try {
    await access(target, fsConstants.W_OK);
  } catch {
    const owner = details ? `${details.uid}:${details.gid}` : 'unknown';
    throw new Error(
      `Data root is not writable: ${target} (owner ${owner}). ` +
      `Fix ownership first, then re-run setup:\n  ${ownershipFixCommand(root, platform)}`,
    );
  }
}

async function preflightDataRoot(env: DetectedEnv): Promise<void> {
  const root = env.neuralisHome;

  try {
    await access(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      await ensureWritableOrExplain(root, root, env.platform);
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
    await tryAutoFixOwnership(root, env.platform);
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
      await ensureWritableOrExplain(path, root, env.platform);
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
  if (!email || !email.includes('@')) {
    fail('A valid email is required.');
    process.exit(1);
  }

  let password = '';
  while (password.length < 8) {
    password = await askPassword('Password (min 8 chars, hidden)');
    if (password.length < 8) {
      warn('Password must be at least 8 characters.');
    }
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
  carriedKey: string | null,
): Promise<{ url: string; mode: 'docker' | 'binary' | 'external' | 'skip'; apiKey: string | null }> {
  heading('Vector Search (Qdrant)');

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

  // Already running → use it
  if (env.qdrant.running) {
    info(`Qdrant already running on ${c.bold}${env.qdrant.url}${c.reset}`);
    const apiKey = await askExternalQdrantKey(carriedKey);
    return { url: env.qdrant.url, mode: 'external', apiKey };
  }

  console.log(`  ${c.dim}Qdrant provides persistent memory and semantic search.${c.reset}`);
  console.log(`  ${c.dim}Without it: keyword search only, no persistent memory.${c.reset}`);
  blank();

  // Docker available → prefer compose-managed stack, no separate setup container
  if (env.docker) {
    const choice = await askChoice('How to run Qdrant?', [
      `Docker stack ${c.dim}(recommended, starts with the app stack)${c.reset}`,
      'Use an external Qdrant URL',
      'Skip for now (in-memory only)',
    ]);

    if (choice === 1) {
      const url = await ask('Qdrant URL', 'http://localhost:6333');
      step('Testing connection...');
      const healthy = await waitForQdrant(url, 3, 1000);
      if (healthy) {
        info(`Qdrant reachable at ${c.bold}${url}${c.reset}`);
      } else {
        warn('Could not reach Qdrant right now. Neuralis will try that URL at runtime.');
      }
      const apiKey = await askExternalQdrantKey(carriedKey);
      return { url, mode: 'external', apiKey };
    }

    if (choice === 2) {
      warn('Qdrant skipped. Using in-memory mode (data lost on restart).');
      return { url: '', mode: 'skip', apiKey: null };
    }

    info(`Qdrant will be managed by the ${c.bold}app stack${c.reset}, not by setup.`);
    if (env.isClone) {
      step('Start it later with: cd neuralis && docker compose up -d');
    } else {
      step('Start it later with: docker compose up -d');
    }
    const apiKey = resolveQdrantApiKey('docker', carriedKey, mintKey);
    reportKey(apiKey);
    return { url: 'http://localhost:6333', mode: 'docker', apiKey };
  }

  // No Docker → offer binary download or skip
  const choice = await askChoice('Qdrant is not running. Options:', [
    `Download Qdrant binary ${c.dim}(script handles everything)${c.reset}`,
    'Enter external Qdrant URL',
    'Skip (in-memory only, not recommended)',
  ]);

  if (choice === 0) {
    const binDir = join(env.neuralisHome, 'bin');
    const version = await resolveInstallQdrantVersion(
      binaryInstallProbe({
        storageDir: join(env.neuralisHome, 'qdrant-storage'),
        binaryPath: join(binDir, 'qdrant'),
        runningVersion: null,
      }),
      env.neuralisHome,
    );
    step(`Downloading Qdrant ${version}...`);
    const binaryPath = await downloadQdrantBinary(binDir, version);
    if (!binaryPath) {
      fail('Qdrant binary not available for this platform.');
      warn('Install Qdrant manually or use Docker.');
      return { url: '', mode: 'skip', apiKey: null };
    }
    info('Qdrant binary installed');

    // Resolved BEFORE the spawn: a keyless native server with keyed clients
    // is an outage, not a fallback — the spawn env carries the same key the
    // clients will send.
    const apiKey = resolveQdrantApiKey('binary', carriedKey, mintKey);
    reportKey(apiKey);

    step('Starting Qdrant...');
    const storageDir = join(env.neuralisHome, 'qdrant-storage');
    await startQdrantBinary(binDir, storageDir, apiKey ?? undefined);

    step('Waiting for Qdrant...');
    const healthy = await waitForQdrant('http://localhost:6333');
    if (healthy) {
      info(`Qdrant running on ${c.bold}http://localhost:6333${c.reset}`);
    } else {
      warn('Qdrant started but health check timed out.');
    }
    return { url: 'http://localhost:6333', mode: 'binary', apiKey };
  }

  if (choice === 1) {
    const url = await ask('Qdrant URL', 'http://localhost:6333');
    step('Testing connection...');
    const healthy = await waitForQdrant(url, 3, 1000);
    if (healthy) {
      info(`Qdrant reachable at ${c.bold}${url}${c.reset}`);
    } else {
      warn('Could not reach Qdrant. Verify the URL and try again.');
    }
    const apiKey = await askExternalQdrantKey(carriedKey);
    return { url, mode: 'external', apiKey };
  }

  warn('Qdrant skipped. Using in-memory mode (data lost on restart).');
  return { url: '', mode: 'skip', apiKey: null };
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
 * the embedding id, metered and capped apart from chat. Empty = skipped, and
 * embedding stays off until the key is set.
 */
async function askEmbeddingCredential(
  model: EmbeddingModelInfo,
  credentialId: string,
  llmKeys: Record<string, string>,
): Promise<{ id: string; value: string } | undefined> {
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
    warn(`No key entered — embedding stays off until ${c.bold}${credentialId}${c.reset} is set in Admin → Credentials.`);
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
  localLLMs: LocalLLMEntry[] = [],
): Promise<VectorChoice> {
  heading('Vector (embeddings)');

  if (qdrantMode === 'skip') {
    info(`Qdrant skipped — using deterministic (no real embeddings)`);
    const det = findEmbeddingModel('deterministic:sha256-384')!;
    return { modelId: det.id, dimension: det.defaultDimension };
  }

  const menu = buildMenu(env);
  const recommended = recommendedEmbeddingModel();
  console.log(`  ${c.dim}Pick an embedding provider. Recommended for a new install: ${recommended ? `${recommended.apiModelId} @${recommended.defaultDimension}` : 'a cloud model'}.${c.reset}`);
  console.log(`  ${c.dim}An existing install keeps the model it has; changing it later rebuilds the index from the Vector section.${c.reset}`);
  blank();

  const defaultProvider = Math.max(0, menu.findIndex((m) => recommended !== undefined && m.models.includes(recommended)));
  const chosen = await askChoice('Which provider?', menu.map((m) => m.label), defaultProvider);

  if (menu[chosen].custom) {
    return askEmbeddingEndpoint(deploymentMode);
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
      const ok = pullOllamaModel(model.apiModelId, env.ollama.url);
      if (ok) {
        info(`Pulled ${c.bold}${model.apiModelId}${c.reset}`);
      } else {
        warn(`Could not auto-pull ${model.apiModelId}. Run 'ollama pull ${model.apiModelId}' later.`);
      }
    }
  }

  const credential = model.credentialId ? await askEmbeddingCredential(model, model.credentialId, llmKeys) : undefined;

  blank();
  const dimension = await pickDimension(model);

  const choice: VectorChoice = { modelId: model.id, dimension };
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
  if (credential) choice.credential = credential;
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
    info(`Selected: ${c.bold}docker-compose Ollama${c.reset} → http://ollama:11434`);
    console.log(`  ${c.dim}The generated docker-compose.yml will include the ollama service — \`docker compose up -d\` starts it.${c.reset}`);
    console.log(`  ${c.dim}Pull a model afterwards: docker compose exec ollama ollama pull nomic-embed-text${c.reset}`);
    return { id: 'ollama', label: 'Ollama (compose)', baseUrl: 'http://ollama:11434', kind: 'ollama-native', enabled: true };
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
  const stored = hostReachableUrl(url, deploymentMode);
  return { id: 'ollama', label: 'Ollama', baseUrl: stored, kind: 'ollama-native', enabled: true };
}

async function configureLocalLLMs(
  env: DetectedEnv,
  deploymentMode: 'native' | 'docker',
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
  const ollamaEntry = await askOllamaDeployment(env, deploymentMode);
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
    const confirm = (await ask(`Detected ${c.bold}${probe.label}${c.reset} at ${probe.url} — add? (Y/n)`, 'y')).toLowerCase();
    if (confirm !== 'n') {
      const stored = hostReachableUrl(probe.url, deploymentMode);
      entries.push({ id: probe.id, label: probe.label, baseUrl: stored, kind: probe.kind, enabled: true });
      info(`Added ${c.bold}${probe.label}${c.reset} → ${stored}`);
    }
  }

  // Manual add loop — lets the user point at custom hosts/ports.
  while (true) {
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
  const key = (await ask('API key (stored encrypted, never echoed)', '')).trim();
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

async function chooseMachineVariant(env: DetectedEnv): Promise<MachineChoice> {
  heading('Machine (virtual desktop)');
  console.log(`  ${c.dim}The first beta bundles Ubuntu + XFCE with Neuralis control and authentication.${c.reset}`);
  console.log(`  ${c.dim}machine-core streams the Webtop desktop into the workspace over Selkies.${c.reset}`);
  console.log(`  ${c.dim}The image is ~3 GB uncompressed — first pull takes ~3 min on 100 Mbps.${c.reset}`);
  blank();

  if (!env.docker) {
    warn('Docker not available — machine widget will surface a "docker-missing" error at runtime.');
    return { variant: DEFAULT_MACHINE_VARIANT, skipPrefetch: true };
  }

  const variant = DEFAULT_MACHINE_VARIANT;
  info(`Bundled desktop: ${c.bold}${variant.label}${c.reset} ${c.dim}(${variant.derivativeImage})${c.reset}`);

  const prefetch = await ask('Pre-pull the Neuralis desktop image now (background)?', 'y');
  const skipPrefetch = prefetch.toLowerCase() === 'n';

  if (!skipPrefetch) {
    step(`Starting background pull of ${c.bold}${variant.derivativeImage}${c.reset}…`);
    try {
      await backgroundPullMachineImage(variant.derivativeImage);
      info('Background pull kicked off — the first desktop open may still wait for the download or need a retry.');
    } catch (err) {
      warn(`Background pull failed (continuing anyway): ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    step('Image prefetch skipped — first widget open will pull the image on demand.');
  }

  return { variant, skipPrefetch };
}

async function backgroundPullMachineImage(image: string): Promise<void> {
  // Spawn an independent `docker pull` process and detach so the setup CLI
  // exits without waiting. Errors become log output — we don't block setup
  // on a slow/failed pull.
  const { spawn } = await import('node:child_process');
  const logDir = join(process.env.HOME ?? '.', '.neuralis', 'app', 'logs');
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

/**
 * Whether an MCP API key already exists in the credential store.
 *
 * Every configured MCP client authenticates with that key, so a re-run must
 * not mint a new one — the clients would all break with nothing saying why.
 * Existence is enough: the file is left in place and never decrypted here.
 */
async function mcpApiKeyExists(neuralisHome: string): Promise<boolean> {
  try {
    await access(join(neuralisHome, 'app', 'credentials', 'global', 'mcp.communityApiKey.enc.json'));
    return true;
  } catch {
    return false;
  }
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

  // MCP community API key — preserve-if-exists. Rotating it silently breaks
  // every MCP client already configured against this deployment.
  if (config.mcpApiKey && !(await mcpApiKeyExists(config.neuralisHome))) {
    await writeCredentialFile(config.neuralisHome, masterKey, salt, 'mcp.communityApiKey', config.mcpApiKey);
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

  // Minimal .env — only infra topology, ports, paths, master secret
  const lines: string[] = [
    `# Generated by: neuralis setup (${new Date().toISOString().split('T')[0]})`,
    `# Do not commit this file to version control.`,
    '#',
    '# Three-tier configuration model:',
    '#   .env           — infrastructure topology (this file)',
    '#   platform.json  — runtime settings (~/.neuralis/app/config/platform.json)',
    '#   credentials/   — encrypted secrets (~/.neuralis/app/credentials/)',
    '',
    '# ── Master Secret (REQUIRED) ─────────────────────────',
    `NEXTAUTH_SECRET=${config.nextAuthSecret}`,
    '',
    ...buildOriginLines(config.publicOrigin, config.ports),
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
    const hostQdrantUrl = config.qdrant.url || 'http://localhost:6333';
    lines.push(`QDRANT_URL=${hostQdrantUrl}`);
  } else {
    lines.push('# QDRANT_URL=http://localhost:6333');
  }
  lines.push(
    '# How Qdrant is provisioned (docker | binary | external | skip). Read back',
    '# by `pnpm neuralis:setup --compose-only` so the compose regen emits the',
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
      '# add: QDRANT_API_KEY=<key>  (then `pnpm neuralis:setup --compose-only`',
      '# and `docker compose up -d`).',
      '# QDRANT_API_KEY=',
    );
  }
  if (config.qdrant.mode === 'docker') {
    lines.push(
      '# Qdrant web dashboard (static SPA at 127.0.0.1:6333/dashboard). Set to',
      "# 'off' to disable the static UI entirely, then regenerate + recreate:",
      '# `pnpm neuralis:setup --compose-only && docker compose up -d`.',
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
    '# `pnpm neuralis:setup --compose-only && docker compose up -d`.',
    `NEURALIS_CODEX_LOOPBACK=${config.codexLoopback ? 'on' : 'off'}`,
    ...trustedProxiesLines(config.trustedProxies),
    ...buildNpmrcLines(config.buildNpmrc),
  );

  if (env.ollama.running) {
    lines.push(`OLLAMA_URL=${env.ollama.url}`);
  } else {
    lines.push('# OLLAMA_URL=http://localhost:11434');
  }

  if (config.qdrant.mode === 'docker') {
    lines.push('# Docker note: Qdrant starts with the app stack.');
  }

  lines.push(
    '',
    '# ── Docker (set automatically by docker-compose) ────',
    `LOCAL_UID=${config.uid}`,
    `LOCAL_GID=${config.gid}`,
  );

  if (config.dockerGid !== null) {
    lines.push(
      '# GID that owns /var/run/docker.sock on this host. docker-compose adds',
      '# this as a supplementary group to the neuralis container so the app',
      '# user can open the socket (machine-core spawns Webtop containers via it).',
      `DOCKER_GID=${config.dockerGid}`,
    );
  } else {
    lines.push(
      '# /var/run/docker.sock not detected on this host — machine-core will',
      '# surface a clean "docker-missing" error. Set DOCKER_GID manually if',
      '# you plan to bind-mount the socket.',
      '# DOCKER_GID=',
    );
  }

  lines.push(
    '',
    '# ── Machine-core (per-user Webtop + Selkies + Playwright-over-CDP) ──',
    `NEURALIS_MACHINE_DESKTOP_VARIANT=${config.machine.variant.key}`,
    `NEURALIS_MACHINE_IMAGE=${config.machine.variant.derivativeImage}`,
    'NEURALIS_MACHINE_CONTAINER_SCOPE=user',
    'NEURALIS_MACHINE_IDLE_MINUTES=30',
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

/** The version this host folder ships — the compose stamp and a fresh install's image tag; never defaulted. */
async function readNeuralisVersion(): Promise<string> {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf-8')) as { version?: unknown };
  if (typeof pkg.version !== 'string' || !pkg.version.trim()) throw new Error(`${pkgPath} names no version.`);
  return pkg.version.trim();
}

async function generateComposeFile(
  input: ComposeEmitInput,
  configDir: string,
  opts: { askOverwrite: boolean },
): Promise<void> {
  const composePath = join(configDir, 'docker-compose.yml');
  const content = buildComposeContent(input, {
    date: new Date().toISOString().split('T')[0],
    version: await readNeuralisVersion(),
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
    await writeFile(composePath, content, 'utf-8');
    info(`docker-compose.yml written to ${c.bold}${composePath}${c.reset}`);
  } else {
    step('docker-compose.yml kept unchanged');
  }
}

function composeInputFromSetup(config: SetupConfig, env: DetectedEnv, qdrantImage: string | null): ComposeEmitInput {
  return {
    uid: config.uid,
    gid: config.gid,
    dockerGid: config.dockerGid,
    appPort: config.ports.app,
    mcpPort: config.ports.mcp,
    sandboxPort: config.ports.sandbox,
    nextAuthUrl: config.publicOrigin,
    composeProject: config.composeProject,
    brainInfraMode: config.qdrant.mode === 'skip' ? 'inmemory' : 'local',
    qdrantMode: config.qdrant.mode,
    qdrantUrl: config.qdrant.url,
    qdrantImage,
    // A full setup writes QDRANT_DASHBOARD=on into .env; the off-switch is an
    // operator .env edit picked up by the --compose-only read-back.
    qdrantDashboard: true,
    codexLoopbackPublish: config.codexLoopback,
    composeOllama: config.localLLMs.some((e) => e.baseUrl.startsWith('http://ollama:')),
    neuralisHome: config.neuralisHome,
    machine: {
      desktopVariant: config.machine.variant.key,
      image: config.machine.variant.derivativeImage,
      containerScope: 'user',
      idleMinutes: 30,
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
    // Emitted only when the operator has actually provisioned the broker —
    // `pnpm neuralis:host-broker init` writes the secret + ceiling and prints
    // the unit. Setup never turns the host plane on by itself.
    hostBroker: hostBrokerEmitInput(config.neuralisHome),
  };
}

/** The host folder this script belongs to — its package.json is the dependency set the build installs. */
const scriptHostDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The monorepo build's inputs (local package contexts, the exported build lock,
 * the `.npmrc` secret). The image channels never build, so a local package
 * registered there is named rather than silently left out of a pulled image.
 */
function buildInputsFor(env: DetectedEnv, npmrcPath: string | undefined): BuildInputs {
  if (!env.isClone) {
    const manifest = JSON.parse(readFileSync(join(scriptHostDir, 'package.json'), 'utf-8')) as unknown;
    for (const source of listLocalSources(manifest)) {
      warn(`${source.name} (${source.spec}) is a local package, and this channel pulls a prebuilt image — it is not in it.`);
    }
    return NO_BUILD_INPUTS;
  }
  return resolveBuildInputs({
    hostDir: scriptHostDir,
    repoRoot: join(scriptHostDir, '..'),
    neuralisHome: env.neuralisHome,
    npmrcPath,
  });
}

/**
 * Detect operator-provisioned host-broker artifacts.
 *
 * Presence of BOTH the secret file and a configured socket path is what makes
 * compose emit the binds. Nothing here creates them — `pnpm neuralis:host-broker
 * init` does, deliberately as a separate, explicit operator act.
 */
function hostBrokerEmitInput(neuralisHome: string): ComposeEmitInput['hostBroker'] {
  const dir = join(neuralisHome, 'host-broker');
  const socketPath = join(dir, 'host-broker.sock');
  const secretFile = join(dir, 'secret');
  return { enabled: existsSync(secretFile), socketPath, secretFile };
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

  return {
    // Read back, never re-decided: --compose-only must regenerate the SAME
    // project name, or the regenerated file points at different volumes.
    composeProject: envVars.NEURALIS_COMPOSE_PROJECT?.trim() || 'neuralis',
    // Detection is wrong inside a container — the flags win when given.
    uid: hostIdentity.uid ?? env.uid,
    gid: hostIdentity.gid ?? env.gid,
    dockerGid: hostIdentity.dockerGid ?? env.dockerGid,
    appPort: Number(envVars.NEURALIS_APP_PORT) || 3100,
    mcpPort: Number(envVars.MCP_HTTP_PORT) || 3101,
    sandboxPort: Number(envVars.NEURALIS_MCP_SANDBOX_PORT) || 3102,
    nextAuthUrl: envVars.NEXTAUTH_URL || 'http://localhost:3100',
    brainInfraMode,
    qdrantMode,
    qdrantUrl: envVars.QDRANT_URL ?? '',
    // Resolved by the caller from the recorded state (docker mode only).
    qdrantImage: null,
    // Anything but an explicit 'off' keeps the dashboard (default-on switch).
    qdrantDashboard: envVars.QDRANT_DASHBOARD?.trim().toLowerCase() !== 'off',
    codexLoopbackPublish: codexLoopbackOptIn(envVars.NEURALIS_CODEX_LOOPBACK),
    composeOllama,
    neuralisHome: env.neuralisHome,
    machine: {
      desktopVariant: machineEnv('NEURALIS_MACHINE_DESKTOP_VARIANT', 'ubuntu-xfce'),
      image: machineEnv('NEURALIS_MACHINE_IMAGE', 'neuralisapp/webtop-ubuntu-xfce:dev'),
      containerScope: machineEnv('NEURALIS_MACHINE_CONTAINER_SCOPE', 'user'),
      idleMinutes: Number(envVars.NEURALIS_MACHINE_IDLE_MINUTES) || 30,
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
    // Re-detected on every regeneration, so `--compose-only` picks up a broker
    // provisioned (or removed) since the last run.
    hostBroker: hostBrokerEmitInput(env.neuralisHome),
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

/** Host identity the wizard cannot detect from inside a container. */
type HostIdentityOverrides = { uid: number | null; gid: number | null; dockerGid: number | null };

async function runComposeOnly(
  outputOverride: string | null,
  hostIdentity: HostIdentityOverrides = { uid: null, gid: null, dockerGid: null },
): Promise<void> {
  const env = await detectEnvironment();
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
      '  Fix: re-run the full `pnpm neuralis:setup` (it mints and preserves the key),\n' +
      '  or add a QDRANT_API_KEY=<random> line to .env yourself, then re-run --compose-only.\n' +
      '  Nothing was written.',
    );
  }
  // The image tag is install state, read back like the project name: a missing
  // line is refused (writing nothing), never re-derived or defaulted.
  input.imageTag = resolveImageTag(envVars, input.monorepo);

  if (input.qdrantMode === 'docker') {
    input.qdrantImage = qdrantImageRef(await resolveInstallQdrantVersion(
      dockerInstallProbe({
        composeProject: input.composeProject,
        composeFilePath: join(configDir, 'docker-compose.yml'),
        runningVersion: env.qdrant.running ? env.qdrant.version : null,
      }),
      env.neuralisHome,
    ));
  }

  await generateComposeFile(input, configDir, { askOverwrite: false });
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

function printSummary(config: SetupConfig, env: DetectedEnv) {
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

  const vectorModel = findEmbeddingModel(config.vector.modelId);
  if (config.vector.endpoint) {
    info(`Vector: ${c.bold}${config.vector.modelId}${c.reset} ${c.dim}(${config.vector.dimension}d · custom endpoint)${c.reset}`);
  } else if (vectorModel && vectorModel.provider !== 'deterministic') {
    info(
      `Vector: ${c.bold}${vectorModel.id}${c.reset} ${c.dim}(${config.vector.dimension}d · ${tierLabel(vectorModel.tier)})${c.reset}`,
    );
  } else {
    warn(`Vector: deterministic (dev/test only)`);
  }

  info(
    `Machine: ${c.bold}${config.machine.variant.key}${c.reset} ${c.dim}(${config.machine.variant.derivativeImage}${config.machine.skipPrefetch ? ', no prefetch' : ', prefetch running in background'})${c.reset}`,
  );

  blank();
  console.log(`  ${c.cyan}${c.bold}Next steps:${c.reset}`);
  blank();

  if (config.deploymentMode === 'native') {
    console.log(`    ${c.bold}Build and start from the host folder:${c.reset}`);
    console.log(`      npm run build`);
    console.log(`      npm run start`);
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
  blank();
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  const cliArgs = process.argv.slice(2);
  const flagValue = (flag: string): string | null => {
    const idx = cliArgs.indexOf(flag);
    return idx >= 0 ? (cliArgs[idx + 1] ?? null) : null;
  };
  const outputOverride = flagValue('--output');

  // Host identity overrides for the one-shot container flow. Inside a
  // container the wizard CANNOT detect these: it runs as its own user, and the
  // host's /var/run/docker.sock GID is not visible through the bind. They are
  // baked into the generated compose (user/group and the docker supplementary
  // group), so a wrong value produces a stack that cannot write its own data
  // directory. The operator reads them on the host with:
  //   id -u ; id -g ; stat -c %g /var/run/docker.sock
  const numericFlag = (flag: string): number | null => {
    const raw = flagValue(flag);
    if (raw === null) return null;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      console.error(`\n  ✗ ${flag} expects a non-negative integer, got "${raw}"`);
      process.exit(1);
    }
    return parsed;
  };
  const uidOverride = numericFlag('--uid');
  const gidOverride = numericFlag('--gid');
  const dockerGidOverride = numericFlag('--docker-gid');

  // Fast path: regenerate docker-compose.yml from existing config, no wizard.
  if (cliArgs.includes('--compose-only')) {
    await runComposeOnly(outputOverride, { uid: uidOverride, gid: gidOverride, dockerGid: dockerGidOverride });
    return;
  }

  printBanner();
  initReadline();

  try {
    // 1. Auto-detect
    const env = await detectEnvironment();
    printDetection(env);
    await preflightDataRoot(env);

    // 2. Check existing setup
    const proceed = await handleExistingSetup(env);
    if (!proceed) { rl.close(); return; }

    // 2b. Read back what a previous run recorded. Everything below defaults to
    // the existing value: a maintenance re-run must not silently re-decide the
    // origin, the ports, the session secret or the compose project name.
    const configDir = resolveConfigDir(env, outputOverride);
    const carried = carryOverEnv(await readEnvFile(configDir));

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
        return;
      }
    }

    const orphans = await findOrphanSourceConfigDirs(env.neuralisHome);
    if (orphans.length > 0) {
      blank();
      warn(`${orphans.length} source-config director${orphans.length > 1 ? 'ies' : 'y'} with no project record:`);
      for (const orphan of orphans) step(`${c.dim}app/config/sources/${orphan}${c.reset}`);
      step('Left untouched — remove by hand once you have confirmed they are unused.');
    }

    // 3. Owner account
    const owner = await askOwner();

    // 3b. Deployment mode — determines how loopback URLs are stored. Must
    // run before any step that writes service URLs (chooseVectorConfig,
    // configureLocalLLMs).
    const deploymentMode = await askDeploymentMode(env);

    // 4. LLM keys (excl. OpenAI) + OpenAI via API-key / ChatGPT OAuth / both.
    const llmKeys = await askLlmKeys();
    const openaiAuth = await askOpenAIAuth();
    if (openaiAuth.apiKey) llmKeys['OPENAI_API_KEY'] = openaiAuth.apiKey;

    // 5. Qdrant — the carried key rides in so the MODE decides mint/ask/none,
    // and the binary path can hand the resolved key to the spawn env BEFORE
    // the server starts (a keyless server under keyed clients is an outage).
    const qdrant = await ensureQdrant(env, carried.qdrantApiKey);

    // 6. Custom LLM endpoints — probe the standard ports, let the user add
    // any reachable one. Runs BEFORE chooseVectorConfig so the embedding
    // step can offer "use the same Ollama for embeddings?" without needing
    // a second copy of the URL.
    const localLlmChoice = await configureLocalLLMs(env, deploymentMode);
    const localLLMs = localLlmChoice.entries;

    // 6b. Vector (embeddings) — interactive, registry-driven.
    const vector = await chooseVectorConfig(env, llmKeys, qdrant.mode, deploymentMode, localLLMs);

    // 6c. Machine-core (virtual desktop) — bundled desktop + background image prefetch.
    const machine = await chooseMachineVariant(env);

    // 7. Project — already settled above on an existing install; a fresh one
    // mints its id from the name through the app's own derivation.
    if (!maintained?.ok) {
      heading('Project');
      const answered = await ask('Project name', 'My Workspace');
      maintained = resolveSetupProjectId({ existingSetup: false, projects: [], answer: answered });
    }
    if (!maintained.ok) throw new Error(maintained.reason);
    const { projectId, projectName } = maintained;
    info(`Project: ${c.bold}${projectName}${c.reset} ${c.dim}(id: ${projectId})${c.reset}`);

    // 7b. The public origin — the one value the wizard cannot detect. It is
    // what NEXTAUTH_URL, APP_URL and the compose environment block all become,
    // and a stale localhost value breaks the login round-trip for every user
    // who reaches the deployment by any other name.
    heading('Public origin');
    step('The origin users will actually reach this deployment on.');
    step(`${c.dim}Leave as-is for a single-machine install; use the LAN IP or domain otherwise.${c.reset}`);
    const originDefault = carried.publicOrigin ?? `http://localhost:${carried.ports.app}`;
    let publicOrigin: string | null = null;
    while (publicOrigin === null) {
      const answered = await ask('Public origin', originDefault);
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
    let codexLoopback = codexQuestion.ask ? codexQuestion.defaultOn : codexQuestion.value;
    if (codexQuestion.ask) {
      heading('ChatGPT sign-in callback');
      step('Publish port 1455 on this machine\'s loopback so a browser ON this machine can finish a ChatGPT sign-in by itself.');
      step(`${c.dim}The price: Docker holds 127.0.0.1:1455 for as long as the stack runs — \`codex login\` (and this wizard's own ChatGPT sign-in on a later re-run) cannot use that port meanwhile, and the stack will not start while another program holds it.${c.reset}`);
      step(`${c.dim}Without it the sign-in still works: you paste the final callback URL into the Credentials tab.${c.reset}`);
      if (!codexQuestion.effective) {
        warn(`${publicOrigin} is not a loopback origin — browsers reach this deployment by another name, so the publish has no effect for them.`);
      }
      const idx = await askChoice(
        'Publish the ChatGPT sign-in callback?',
        ['No — finish sign-ins by pasting the callback URL', 'Yes — publish 127.0.0.1:1455 while the stack runs'],
        codexQuestion.defaultOn ? 1 : 0,
      );
      codexLoopback = idx === 1;
      info(`ChatGPT sign-in callback: ${c.bold}${codexLoopback ? 'published on 127.0.0.1:1455' : 'paste the callback URL'}${c.reset}`);
    }

    // 7b-3. Trusted reverse proxies — topology, never a tunable. The default is
    // the carried value; a fresh install trusts none (only the socket peer).
    heading('Reverse proxy');
    step('Only when a reverse proxy fronts the app: its address (or CIDR), so logins and webhooks are limited per real client.');
    step(`${c.dim}Leave empty otherwise — a forwarding header is then never believed. \`none\` clears a carried value.${c.reset}`);
    let trustedProxies: string | null = null;
    while (trustedProxies === null) {
      trustedProxies = normalizeTrustedProxies(await ask('Trusted proxies', carried.trustedProxies));
      if (trustedProxies === null) fail('Not an address or CIDR list — expected something like 10.0.0.5 or 172.18.0.0/16');
    }
    info(`Trusted proxies: ${c.bold}${trustedProxies || 'none'}${c.reset}`);

    // 7c. Compose project name — preserved on an existing install, because it
    // prefixes the named volumes and every container name.
    const composeFilePath = join(resolveConfigDir(env, outputOverride), 'docker-compose.yml');
    const composeProbe = await probeComposeProjects();
    const composeProject = resolveComposeProject({
      existingName: carried.composeProject,
      composeFilePath,
      installDir: env.neuralisHome,
      projects: composeProbe,
    });
    if (composeProject.reason === 'derived') {
      warn(`Another Compose project already answers to "neuralis" on this daemon.`);
      info(`Using project name ${c.bold}${composeProject.name}${c.reset} for this install.`);
    }

    // 7d. The Qdrant image is the version this install's storage is on — decided
    // BEFORE anything below writes, so a refusal leaves the install untouched.
    const qdrantImage = qdrant.mode === 'docker'
      ? qdrantImageRef(await resolveInstallQdrantVersion(
        dockerInstallProbe({
          composeProject: composeProject.name,
          composeFilePath,
          runningVersion: env.qdrant.running ? env.qdrant.version : null,
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
      // Preserve-if-exists: regenerating the session secret logs every user
      // out, and regenerating the MCP key breaks every configured MCP client.
      nextAuthSecret: carried.nextAuthSecret ?? randomBytes(32).toString('base64'),
      mcpApiKey: randomBytes(32).toString('hex'),
      publicOrigin,
      ports: carried.ports,
      composeProject: composeProject.name,
      deploymentMode,
      codexLoopback,
      trustedProxies,
      buildNpmrc: carried.buildNpmrc,
      // Carried, never re-derived: an update moves the tag and never the
      // scaffold's host version, so re-deriving would step the install back.
      imageTag: initialImageTag(carried.imageTag, await readNeuralisVersion(), env.isClone),
      codexBlob: openaiAuth.codexBlob,
      uid: uidOverride ?? env.uid,
      gid: gidOverride ?? env.gid,
      dockerGid: dockerGidOverride ?? env.dockerGid,
    };

    // 8. Create dirs
    heading('Creating data directories');
    await createDirectorySkeleton(env.neuralisHome, projectId);
    info(`Data directory: ${c.bold}${env.neuralisHome}${c.reset}`);

    let sourceConfigUserId = config.ownerUserId;

    // 9. Write records
    if (!env.existingSetup) {
      const userId = await writeOwnerRecord(config);
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

    if (carried.nextAuthSecret) {
      step('Session secret preserved — nobody gets logged out. (Delete .env to rotate it.)');
    }

    // 10. Generate credential key files
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
      embeddingModelId: config.vector.modelId,
      embeddingDimension: config.vector.dimension,
      machineDesktopVariant: config.machine.variant.key,
      machineImage: config.machine.variant.derivativeImage,
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
    await generateComposeFile(composeInputFromSetup(config, env, qdrantImage), configDir, { askOverwrite: true });

    // 14. Summary
    printSummary(config, env);

  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(`\n  ${c.red}${c.bold}Setup failed:${c.reset} ${err.message ?? err}`);
  process.exit(1);
});
