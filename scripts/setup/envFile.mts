/**
 * `.env` authoring and read-back.
 *
 * Extracted from `setup.mts` (F3 INC-S1) so the read-back rules are testable.
 *
 * Two things the wizard used to get wrong on a re-run:
 *
 * 1. **It regenerated secrets.** `NEXTAUTH_SECRET` was minted fresh every run
 *    and written behind a default-yes "overwrite .env?" prompt — a bare Enter
 *    logged every user out. The same for the MCP API key, which every
 *    configured MCP client authenticates with. Both are preserve-if-exists
 *    now; rotation needs an explicit answer to a prompt that states the
 *    consequence. (The pattern already existed one function away, in the
 *    credential key-file generator.)
 * 2. **It hardcoded the origin and the ports.** Detection already parsed the
 *    existing `.env` into a map that nothing ever read. It is the source of
 *    the defaults now, so a re-run cannot silently move a deployment back to
 *    `localhost:3100`.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';

/**
 * Parse `KEY=value` lines, stripping surrounding quotes.
 *
 * Two parsers existed and disagreed — the detection one kept quotes, this one
 * strips them. A hand-quoted `.env` read by the wrong one yields values with
 * literal quote characters inside URLs, so this is the one the read-back uses.
 */
export function parseEnvContent(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["'](.*)["']$/, '$1');
    out[key] = value;
  }
  return out;
}

export function envFilePath(configDir: string): string {
  return join(configDir, '.env');
}

/** Read an existing `.env` into a map; a missing file is an empty map. */
export async function readEnvFile(configDir: string): Promise<Record<string, string>> {
  try {
    return parseEnvContent(await readFile(envFilePath(configDir), 'utf-8'));
  } catch {
    return {};
  }
}

export type PortTriple = { app: number; mcp: number; sandbox: number };

export type CarriedOverEnv = {
  /** The origin users reach the deployment on, if a previous run recorded one. */
  publicOrigin: string | null;
  ports: PortTriple;
  /** Existing session secret — regenerating it logs everyone out. */
  nextAuthSecret: string | null;
  /** Existing compose project name — renaming it orphans the named volumes. */
  composeProject: string | null;
  qdrantMode: string | null;
  /**
   * Existing Qdrant API key — regenerating it locks the running Qdrant server
   * out from every client until the next container recreate. NEXTAUTH_SECRET
   * family: preserve-if-exists, never re-mint over a live value.
   */
  qdrantApiKey: string | null;
  /** The Codex loopback publish opt-in — see {@link codexLoopbackOptIn}. */
  codexLoopback: boolean;
  /** `NEURALIS_TRUSTED_PROXIES` as the operator last wrote it ('' = none). */
  trustedProxies: string;
  /** `NEURALIS_BUILD_NPMRC` — a path the operator wrote by hand; carried, never asked. */
  buildNpmrc: string | null;
  /**
   * `NEURALIS_IMAGE_TAG` — the release an image-channel install runs. Install
   * state: re-deriving it from the scaffold's host version (which an update never
   * moves) would silently step the install back.
   */
  imageTag: string | null;
};

/**
 * The operator's trusted-proxy list, validated the way the host reads it
 * (`parseTrustedProxies` in `src/server/config/env.ts` — scripts cannot import
 * `src/` at runtime, so `setupIdempotence.test.mts` pins this port against it).
 * Addresses or CIDR blocks, comma- or space-separated; `''` and `none` mean no
 * proxy. `null` = not a list the host would accept — the host would trust NO
 * proxy, so the wizard refuses rather than write it.
 */
export function normalizeTrustedProxies(raw: string): string | null {
  const value = raw.trim();
  if (value === '' || value.toLowerCase() === 'none') return '';
  const entries = value.split(/[\s,]+/).filter(Boolean);
  for (const entry of entries) {
    const [rawAddress, rawPrefix, extra] = entry.split('/');
    let address = (rawAddress ?? '').toLowerCase();
    if (address.startsWith('::ffff:') && isIP(address.slice(7)) === 4) address = address.slice(7);
    const version = isIP(address);
    if (version === 0 || extra !== undefined) return null;
    if (rawPrefix !== undefined && (!/^\d+$/.test(rawPrefix) || Number(rawPrefix) > (version === 4 ? 32 : 128))) return null;
  }
  return entries.join(',');
}

/** The `.env` block for the trusted-proxy list (always written, so a re-run carries it). */
export function trustedProxiesLines(value: string): string[] {
  return [
    '# Reverse proxies (addresses / CIDR) whose X-Forwarded-For the login lockout',
    '# and the webhook cap believe. Empty = trust no forwarding header, only the',
    '# connecting socket. Set it to your proxy\'s address when one fronts the app.',
    `NEURALIS_TRUSTED_PROXIES=${value}`,
  ];
}

/** Only an explicit `on` publishes the Codex OAuth loopback (default off). */
export function codexLoopbackOptIn(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'on';
}

/**
 * The hostnames the host's `isLoopbackAppOrigin` accepts. Scripts cannot import
 * from `src/` at runtime, so the setup test pins this copy against the host
 * predicate (derive-and-verify).
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Is this public origin one a browser on the Docker host itself reaches? */
export function isLoopbackPublicOrigin(origin: string): boolean {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export type CodexLoopbackQuestion =
  /** Not asked: the carried value rides through unchanged. */
  | { ask: false; value: boolean }
  /** Asked, defaulting to the carried value; `effective` is false when the origin is not loopback. */
  | { ask: true; defaultOn: boolean; effective: boolean };

/**
 * Whether the full setup asks the Codex loopback opt-in, and with what default.
 * Only the Docker shape asks — a native listener is on the host's own loopback
 * already and the switch has no effect there. The default is the carried `.env`
 * value, so a fresh install defaults to off and a re-run keeps the operator's
 * earlier answer. A non-loopback public origin is still asked (the choice stays
 * the operator's), but the opt-in only helps a browser on the Docker host itself,
 * so for that origin it has no effect.
 */
export function codexLoopbackQuestion(input: {
  deploymentMode: 'native' | 'docker';
  carried: boolean;
  publicOrigin: string;
}): CodexLoopbackQuestion {
  if (input.deploymentMode !== 'docker') return { ask: false, value: input.carried };
  return { ask: true, defaultOn: input.carried, effective: isLoopbackPublicOrigin(input.publicOrigin) };
}

const DEFAULT_PORTS: PortTriple = { app: 3100, mcp: 3101, sandbox: 3102 };

function port(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : fallback;
}

/** What a re-run must carry over from the existing `.env` rather than re-decide. */
export function carryOverEnv(existing: Record<string, string>): CarriedOverEnv {
  return {
    publicOrigin: existing.NEXTAUTH_URL?.trim() || existing.APP_URL?.trim() || null,
    ports: {
      app: port(existing.NEURALIS_APP_PORT, DEFAULT_PORTS.app),
      mcp: port(existing.MCP_HTTP_PORT, DEFAULT_PORTS.mcp),
      sandbox: port(existing.NEURALIS_MCP_SANDBOX_PORT, DEFAULT_PORTS.sandbox),
    },
    nextAuthSecret: existing.NEXTAUTH_SECRET?.trim() || null,
    composeProject: existing.NEURALIS_COMPOSE_PROJECT?.trim() || null,
    qdrantMode: existing.QDRANT_MODE?.trim() || null,
    qdrantApiKey: existing.QDRANT_API_KEY?.trim() || null,
    codexLoopback: codexLoopbackOptIn(existing.NEURALIS_CODEX_LOOPBACK),
    trustedProxies: normalizeTrustedProxies(existing.NEURALIS_TRUSTED_PROXIES ?? '') ?? '',
    buildNpmrc: existing.NEURALIS_BUILD_NPMRC?.trim() || null,
    imageTag: existing.NEURALIS_IMAGE_TAG?.trim() || null,
  };
}

/** Docker's tag grammar: one leading word character, then up to 127 of `[A-Za-z0-9_.-]`. */
const IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/**
 * The image tag a compose regeneration emits on the image channels (`null` on the
 * monorepo channel, which builds). Read back from `.env`, never re-decided and
 * never defaulted: a missing or malformed line is refused before anything is
 * written, naming the fix — the `QDRANT_API_KEY` refusal's shape.
 */
export function resolveImageTag(envVars: Record<string, string>, monorepo: boolean): string | null {
  if (monorepo) return null;
  const tag = envVars.NEURALIS_IMAGE_TAG?.trim() ?? '';
  if (!tag) {
    throw new Error(
      '.env has no NEURALIS_IMAGE_TAG, and this install runs the published image at an exact tag.\n' +
      '  Fix: re-run the full `pnpm neuralis:setup` (it records the version this install ships),\n' +
      '  or add a NEURALIS_IMAGE_TAG=<version> line to .env yourself — the release you run —\n' +
      '  then re-run --compose-only. Nothing was written.',
    );
  }
  return checkedImageTag(tag, '.env NEURALIS_IMAGE_TAG');
}

function checkedImageTag(tag: string, source: string): string {
  if (!IMAGE_TAG.test(tag)) throw new Error(`${source}=${tag} is not an image tag. Nothing was written.`);
  return tag;
}

/**
 * The tag a FULL setup records: the carried value when a previous run wrote one,
 * the version this host ships otherwise. Image channels only (`null` when building).
 */
export function initialImageTag(carried: string | null, hostVersion: string, monorepo: boolean): string | null {
  if (monorepo) return null;
  return carried ? checkedImageTag(carried, '.env NEURALIS_IMAGE_TAG') : checkedImageTag(hostVersion, 'the host package.json version');
}

export type ImageTagMove = { move: true; tag: string } | { move: false; reason: string };

/**
 * Whether an applied `neuralis:update` moves `NEURALIS_IMAGE_TAG`: only a run that
 * put EVERY registry package on one explicit `--version` — that version is a
 * release, and the image of that release is what the container must run.
 */
export function imageTagAfterUpdate(input: { targetVersion: string | null; onePackage: boolean; manifest: boolean }): ImageTagMove {
  if (input.manifest) return { move: false, reason: 'a release manifest names package versions, not an image tag — set NEURALIS_IMAGE_TAG in .env yourself' };
  if (input.onePackage) return { move: false, reason: 'a single-package update is not a release — the container keeps its image' };
  if (!input.targetVersion) return { move: false, reason: 'no --version was given' };
  return { move: true, tag: checkedImageTag(input.targetVersion, '--version') };
}

/** The `.env` block for the image tag (image channels only). */
export function imageTagLines(tag: string | null): string[] {
  if (!tag) return [];
  return [
    '# The neuralisapp/neuralis release this install runs. The compose file pins',
    '# exactly this tag; `pnpm neuralis:update --version <x> --apply` moves it.',
    '# To roll back: write the previous tag here, then',
    '# `pnpm neuralis:setup --compose-only && docker compose up -d -V`.',
    `NEURALIS_IMAGE_TAG=${tag}`,
  ];
}

/**
 * Set one `KEY=value` in an existing `.env`, in place: every other byte of the
 * file stays as it is (comments, order, the operator's own lines), every active
 * line of that key is rewritten, and a key the file lacks is appended. Writing
 * over the existing path keeps its mode and owner — the file carries the
 * session secret. A missing file is refused: this edits an install, never makes one.
 */
export async function upsertEnvValue(configDir: string, key: string, value: string): Promise<{ previous: string | null }> {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n]/.test(value)) throw new Error(`Refusing to write ${key}=${JSON.stringify(value)} into .env.`);
  const path = envFilePath(configDir);
  const before = await readFile(path, 'utf-8');
  let previous: string | null = null;
  const lines = before.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!new RegExp(`^${key}\\s*=`).test(trimmed)) continue;
    previous = parseEnvContent(trimmed)[key] ?? '';
    lines[i] = `${key}=${value}`;
  }
  let after = lines.join('\n');
  if (previous === null) after = `${after}${after === '' || after.endsWith('\n') ? '' : '\n'}${key}=${value}\n`;
  if (after.length === 0 || !after.includes(`${key}=${value}`)) throw new Error(`Refusing to write an .env without ${key}.`);
  await writeFile(path, after, 'utf-8');
  return { previous };
}

/** The `.env` block for the private-registry build secret (written only when set). */
export function buildNpmrcLines(value: string | null): string[] {
  if (!value) return [];
  return [
    '# The private-registry .npmrc the image build mounts as a BuildKit secret',
    '# (`@scope:registry=` + its token lines only — never a default `registry=`).',
    `NEURALIS_BUILD_NPMRC=${value}`,
  ];
}

/**
 * Mode-conditional Qdrant API key resolution.
 *
 * A key is MINTED only for the modes where setup controls the server and can
 * therefore hand it the same key (`docker` — compose interpolation; `binary` —
 * the spawn env). In `external` mode the server belongs to someone else, so a
 * minted key would be a value nobody configured: the wizard asks instead, and
 * the carry-over preserves whatever the operator typed. `skip` has no server.
 *
 * The carried key always wins (preserve-if-exists — re-minting over a live
 * value locks the running server out until the next recreate).
 */
export function resolveQdrantApiKey(
  mode: 'docker' | 'binary' | 'external' | 'skip',
  carried: string | null,
  mint: () => string,
): string | null {
  if (mode === 'skip') return null;
  if (mode === 'external') return carried;
  return carried ?? mint();
}

/**
 * Normalise a user-typed origin: scheme required, no trailing slash, no path.
 * Returns null when it cannot be read as an origin at all.
 */
export function normalizePublicOrigin(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  // Only a scheme-less value gets the http:// convenience prefix; a value that
  // names some OTHER scheme is a mistake worth reporting, not one to rewrite.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  if (hasScheme && !/^https?:\/\//i.test(value)) return null;
  const withScheme = hasScheme ? value : `http://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The `URLs & Ports` block — one resolved origin, one resolved port triple. */
export function buildOriginLines(publicOrigin: string, ports: PortTriple): string[] {
  const mcpOrigin = new URL(publicOrigin);
  mcpOrigin.port = String(ports.mcp);
  return [
    '# ── URLs & Ports ─────────────────────────────────────',
    '# These name the origin USERS ACTUALLY REACH. Authentication and OAuth',
    '# callbacks are resolved against them server-side, so a stale localhost',
    '# value on a remotely-reached deployment breaks the login round-trip.',
    `NEXTAUTH_URL=${publicOrigin}`,
    `APP_URL=${publicOrigin}`,
    `MCP_BASE_URL=${mcpOrigin.origin}`,
    `NEURALIS_APP_PORT=${ports.app}`,
    `MCP_HTTP_PORT=${ports.mcp}`,
    `NEURALIS_MCP_SANDBOX_PORT=${ports.sandbox}`,
  ];
}
