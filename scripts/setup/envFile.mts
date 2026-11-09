/**
 * `.env` authoring and read-back.
 *
 * Extracted from `setup.mts` (F3 INC-S1) so the read-back rules are testable.
 *
 * Two things the wizard used to get wrong on a re-run:
 *
 * 1. **It regenerated secrets.** The session secret was minted fresh every run
 *    and written behind a default-yes "overwrite .env?" prompt — a bare Enter
 *    logged every user out. The same for the MCP API key, which every
 *    configured MCP client authenticates with. Both are preserve-if-exists
 *    now; rotation needs an explicit answer to a prompt that states the
 *    consequence. (The pattern already existed one function away, in the
 *    credential key-file generator.) The session secret has since left `.env`
 *    for a key file in the data home (`src/server/config/sessionSecretFile.ts`):
 *    an older `.env`'s `NEXTAUTH_SECRET` is carried over only to fill that file,
 *    and no writer here emits the line again.
 * 2. **It hardcoded the origin and the ports.** Detection already parsed the
 *    existing `.env` into a map that nothing ever read. It is the source of
 *    the defaults now, so a re-run cannot silently move a deployment back to
 *    `localhost:3100`.
 */

import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { spell } from '../cli/spelling.mts';
import { ollamaEnvLines, type OllamaMode } from './ollamaVersion.mts';

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
  /**
   * `NEXTAUTH_SECRET` an older `.env` still carries — read only to fill the
   * data home's session secret file when it is absent (a new secret logs
   * everyone out); never written back into `.env`.
   */
  nextAuthSecret: string | null;
  /** Existing compose project name — renaming it orphans the named volumes. */
  composeProject: string | null;
  qdrantMode: string | null;
  /** `QDRANT_URL` as recorded — where a binary or external Qdrant answers. */
  qdrantUrl: string | null;
  /** `NEURALIS_QDRANT_PORT` — the REST port this install's own Qdrant answers on. */
  qdrantPort: number;
  /** `NEURALIS_QDRANT_GRPC_PORT` — a binary-mode Qdrant's gRPC listener. */
  qdrantGrpcPort: number;
  /**
   * Existing Qdrant API key — regenerating it locks the running Qdrant server
   * out from every client until the next container recreate. Session-secret
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
  /**
   * The tunnel domain (`neuralis tunnel on <domain>`), read back from the
   * origins it wrote; null without one. A re-run keeps the tunnel's origins.
   */
  tunnelDomain: string | null;
  /** `NEURALIS_TUNNEL_RESTORE` — the origins `tunnel on` replaced, carried verbatim while the tunnel is on. */
  tunnelRestore: string | null;
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

export const DEFAULT_QDRANT_PORT = 6333;
export const DEFAULT_QDRANT_GRPC_PORT = 6334;

/**
 * The host port this install's own Qdrant answers REST on: docker mode publishes
 * it on the loopback (its container side is always 6333), binary mode listens on
 * it directly.
 */
export function qdrantHostPort(envVars: Record<string, string | undefined>): number {
  return port(envVars.NEURALIS_QDRANT_PORT, DEFAULT_QDRANT_PORT);
}

/** The REST and gRPC ports a native (binary-mode) Qdrant listens on. */
export type QdrantPorts = { http: number; grpc: number };

/** A binary-mode install's two Qdrant ports, from `.env` (an install written before the lines: 6333/6334). */
export function qdrantBinaryPorts(envVars: Record<string, string | undefined>): QdrantPorts {
  return { http: qdrantHostPort(envVars), grpc: port(envVars.NEURALIS_QDRANT_GRPC_PORT, DEFAULT_QDRANT_GRPC_PORT) };
}

/**
 * Where the HOST reaches this install's Qdrant — the one answer for every
 * host-side tool. Docker mode publishes it on the loopback at
 * `NEURALIS_QDRANT_PORT`; binary and external mode record their URL.
 */
export function hostQdrantUrl(envVars: Record<string, string | undefined>): string {
  if (envVars.QDRANT_MODE?.trim() === 'docker') return `http://127.0.0.1:${qdrantHostPort(envVars)}`;
  return envVars.QDRANT_URL?.trim() || `http://localhost:${DEFAULT_QDRANT_PORT}`;
}

/**
 * The public-origin default once the app port is settled: a carried origin
 * that pointed at the OLD app port follows it to the new one; any other origin
 * (a domain, a proxy port) is the operator's and stays.
 */
export function originDefault(carried: string | null, oldAppPort: number, appPort: number): string {
  if (!carried) return `http://localhost:${appPort}`;
  try {
    const url = new URL(carried);
    const effective = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    if (effective !== oldAppPort || oldAppPort === appPort) return carried;
    url.port = String(appPort);
    return url.origin;
  } catch {
    return carried;
  }
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
    qdrantUrl: existing.QDRANT_URL?.trim() || null,
    qdrantPort: qdrantHostPort(existing),
    qdrantGrpcPort: qdrantBinaryPorts(existing).grpc,
    qdrantApiKey: existing.QDRANT_API_KEY?.trim() || null,
    codexLoopback: codexLoopbackOptIn(existing.NEURALIS_CODEX_LOOPBACK),
    trustedProxies: normalizeTrustedProxies(existing.NEURALIS_TRUSTED_PROXIES ?? '') ?? '',
    buildNpmrc: existing.NEURALIS_BUILD_NPMRC?.trim() || null,
    imageTag: existing.NEURALIS_IMAGE_TAG?.trim() || null,
    tunnelDomain: tunnelDomainOf(existing),
    tunnelRestore: existing[TUNNEL_RESTORE_KEY]?.trim() || null,
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
      `  Fix: re-run the full \`${spell('setup')}\` (it records the version this install ships),\n` +
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
 * put EVERY registry package on one release — a release manifest's
 * `neuralisapp/neuralis` image, or one explicit `--version` — because the image
 * of that release is what the container must run. `manifest` is null for a
 * `--version` run.
 */
export function imageTagAfterUpdate(input: { targetVersion: string | null; onePackage: boolean; manifest: { image: string | null } | null }): ImageTagMove {
  if (input.onePackage) return { move: false, reason: 'a single-package update is not a release — the container keeps its image' };
  if (input.manifest) {
    if (!input.manifest.image) return { move: false, reason: 'the release manifest names no neuralisapp/neuralis image — the container keeps its image' };
    return { move: true, tag: checkedImageTag(input.manifest.image, 'the release manifest') };
  }
  if (!input.targetVersion) return { move: false, reason: 'no --version was given' };
  return { move: true, tag: checkedImageTag(input.targetVersion, '--version') };
}

/** The `.env` block for the image tag (image channels only). */
export function imageTagLines(tag: string | null): string[] {
  if (!tag) return [];
  return [
    '# The neuralisapp/neuralis release this install runs. The compose file pins',
    '# exactly this tag; `neuralis update --version <x> --apply` moves it.',
    '# To roll back: write the previous tag here, then',
    '# `neuralis setup --compose-only && docker compose up -d -V`.',
    `NEURALIS_IMAGE_TAG=${tag}`,
  ];
}

/**
 * Set one `KEY=value` in an existing `.env`, in place: every other byte of the
 * file stays as it is (comments, order, the operator's own lines), every active
 * line of that key is rewritten, and a key the file lacks is appended. Writing
 * over the existing path keeps its mode and owner — the file carries the
 * Qdrant API key. A missing file is refused: this edits an install, never makes one.
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

/**
 * Replace `.env` whole through a temp file and a rename (the `installRecord.mts`
 * shape): a kill mid-write leaves the old file or the new one, never a 0-byte
 * `.env` that every `${QDRANT_API_KEY:?}` compose command then dies on. The
 * temp is created with `mode`; the result is owned by the writing user.
 */
export async function replaceEnvFile(path: string, text: string, mode: number): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text, { encoding: 'utf-8', mode });
  await rename(tmp, path);
}

/**
 * Take `key`'s lines out of `.env` (comments and every other line kept, byte
 * for byte, the file's mode kept); whether there was one. A missing `.env` is no line.
 */
export async function dropEnvKey(configDir: string, key: string): Promise<boolean> {
  if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`Refusing to drop ${JSON.stringify(key)} from .env.`);
  const path = envFilePath(configDir);
  let before: string;
  try {
    before = await readFile(path, 'utf-8');
  } catch {
    return false;
  }
  const match = new RegExp(`^\\s*${key}\\s*=`);
  const lines = before.split('\n');
  const kept = lines.filter((line) => !match.test(line));
  if (kept.length === lines.length) return false;
  await replaceEnvFile(path, kept.join('\n'), (await stat(path)).mode & 0o777);
  return true;
}

/**
 * The container's user, group and docker group — written for the Docker shape
 * only (the generated compose bakes them concretely, re-detected on every
 * regeneration); a natively run host reads none of them, so it gets no line.
 */
export function dockerIdentityLines(input: { deploymentMode: 'native' | 'docker'; uid: number; gid: number; dockerGid: number | null }): string[] {
  if (input.deploymentMode === 'native') return [];
  return [
    '',
    '# ── Docker (set automatically by docker-compose) ────',
    `LOCAL_UID=${input.uid}`,
    `LOCAL_GID=${input.gid}`,
    ...(input.dockerGid !== null
      ? [
        '# GID that owns /var/run/docker.sock on this host. docker-compose adds',
        '# this as a supplementary group to the neuralis container so the app',
        '# user can open the socket (machine-core spawns Webtop containers via it).',
        `DOCKER_GID=${input.dockerGid}`,
      ]
      : [
        '# /var/run/docker.sock not detected on this host — machine-core will',
        '# surface a clean "docker-missing" error. Set DOCKER_GID manually if',
        '# you plan to bind-mount the socket.',
        '# DOCKER_GID=',
      ]),
  ];
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

/**
 * Where the desktop app's host keeps its vectors (`setup --native`):
 *   docker    its own Qdrant container — `docker-compose.yml` beside this `.env`
 *             (`buildDesktopCompanionCompose`), project `NEURALIS_COMPOSE_PROJECT`
 *   external  a Qdrant someone else runs — the home's Docker install's, whose
 *             folder (`NEURALIS_QDRANT_COMPOSE_DIR`) `neuralis up` starts the
 *             vector store in; or a URL with no folder
 *   binary    the bundle's Qdrant binary on `<home>/qdrant-storage`
 *   skip      no Qdrant: vectors in memory
 */
export type NativeQdrant =
  | { mode: 'docker'; apiKey: string; port: number; project: string }
  | { mode: 'external'; url: string; apiKey: string | null; composeDir: string | null }
  | { mode: 'binary'; apiKey: string; ports: QdrantPorts }
  | { mode: 'skip' };

/** The `.env` keys `nativeQdrantLines` writes — the ones `setup --native --refresh-qdrant` replaces. */
export const NATIVE_QDRANT_KEYS = [
  'BRAIN_INFRA_MODE', 'QDRANT_MODE', 'QDRANT_URL', 'QDRANT_API_KEY', 'NEURALIS_QDRANT_PORT', 'NEURALIS_QDRANT_GRPC_PORT',
  'NEURALIS_COMPOSE_PROJECT', 'NEURALIS_QDRANT_COMPOSE_DIR',
] as const;

/** The Qdrant block of the native `.env`: what the host reads (`BRAIN_INFRA_MODE`, `QDRANT_URL`, the key) and what `neuralis up` starts. */
export function nativeQdrantLines(q: NativeQdrant): string[] {
  switch (q.mode) {
    case 'docker':
      return [
        '# Qdrant runs in Docker for this app: docker-compose.yml beside this file (`neuralis up` starts it).',
        'BRAIN_INFRA_MODE=local',
        'QDRANT_MODE=docker',
        `QDRANT_URL=http://127.0.0.1:${q.port}`,
        `QDRANT_API_KEY=${q.apiKey}`,
        `NEURALIS_QDRANT_PORT=${q.port}`,
        `NEURALIS_COMPOSE_PROJECT=${q.project}`,
      ];
    case 'external':
      return [
        q.composeDir
          ? `# Qdrant is the Docker install's in ${q.composeDir}: \`neuralis up\` starts its vector store there, never its app.`
          : '# Qdrant is a server someone else runs.',
        'BRAIN_INFRA_MODE=local',
        'QDRANT_MODE=external',
        `QDRANT_URL=${q.url}`,
        ...(q.apiKey ? [`QDRANT_API_KEY=${q.apiKey}`] : []),
        ...(q.composeDir ? [`NEURALIS_QDRANT_COMPOSE_DIR=${q.composeDir}`] : []),
      ];
    case 'binary':
      return [
        'BRAIN_INFRA_MODE=local',
        'QDRANT_MODE=binary',
        `QDRANT_URL=http://127.0.0.1:${q.ports.http}`,
        `QDRANT_API_KEY=${q.apiKey}`,
        `NEURALIS_QDRANT_PORT=${q.ports.http}`,
        `NEURALIS_QDRANT_GRPC_PORT=${q.ports.grpc}`,
      ];
    case 'skip':
      return ['BRAIN_INFRA_MODE=inmemory', 'QDRANT_MODE=skip'];
  }
}

/**
 * `text` (a native `.env`) with its Qdrant block replaced by `lines`: every
 * `NATIVE_QDRANT_KEYS` line and the block's own comment go, every other line —
 * ports, origins, proxies, an operator's own — stays as it is.
 */
export function replaceNativeQdrantLines(text: string, lines: string[]): string {
  const keys = new Set<string>(NATIVE_QDRANT_KEYS);
  const kept = text.split('\n').filter((line) => {
    if (/^# Qdrant (runs in Docker for this app|is the Docker install's|is a server someone else runs)/.test(line)) return false;
    const key = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
    return key === undefined || !keys.has(key);
  });
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  return `${[...kept, '', ...lines].join('\n')}\n`;
}

/**
 * The whole `.env` of the desktop app's native host (`setup --native`). Only
 * what that host reads: no image tag, container ids, Docker group or
 * desktop-container settings — none of them exists there. Every listener binds
 * `NEURALIS_BIND_HOST` (loopback); `neuralis up` hands the same value to the
 * app as `HOSTNAME`, and Qdrant stays on loopback in every mode.
 */
export function nativeEnvLines(input: {
  date: string;
  ports: PortTriple;
  bindHost: string;
  qdrant: NativeQdrant;
  ollama: { mode: OllamaMode; port: number; composeProject: string | null };
}): string[] {
  const origin = `http://${input.bindHost}:${input.ports.app}`;
  // The compose project of this home's own companions: the Qdrant block names it in docker mode, else an Ollama container does here.
  const project = input.qdrant.mode !== 'docker' && input.ollama.mode === 'docker' && input.ollama.composeProject
    ? [`NEURALIS_COMPOSE_PROJECT=${input.ollama.composeProject}`]
    : [];
  return [
    `# Generated by: neuralis setup --native (${input.date})`,
    '# The desktop app\'s host: `neuralis up` reads this file and authors each',
    '# child\'s environment from it. Runtime settings live in platform.json beside it;',
    '# the session secret is session-secret.key beside it, never a line here.',
    '',
    ...buildOriginLines(singleHostOrigins(origin, input.ports), input.ports),
    '# The one address the app, the MCP server and the sandbox origin listen on.',
    `NEURALIS_BIND_HOST=${input.bindHost}`,
    '',
    ...nativeQdrantLines(input.qdrant),
    ...ollamaEnvLines(input.ollama.mode, input.ollama.port),
    ...project,
    ...trustedProxiesLines(''),
  ];
}

/**
 * The three origins a deployment is reached on — the app, the MCP server (the
 * OAuth issuer and the device link) and the MCP-Apps sandbox. `sandbox: null`
 * is the port split: the app's hostname on the sandbox port. `companion` is the
 * MCP server's own browser address when `mcp` IS the app address (one
 * hostname) — the desktop stream opens there; `null` everywhere else (the
 * runtime takes `mcp`'s). They are
 * TOPOLOGY, written into this operator file only — never a `configSettings[]`
 * key (a platform setting is grantable to a project admin and global).
 */
export type PublicOrigins = { app: string; mcp: string; sandbox: string | null; companion: string | null };

/** One origin users reach, the MCP server on the same host's MCP port, the sandbox on its port (a single machine, a LAN, a proxy). */
export function singleHostOrigins(publicOrigin: string, ports: PortTriple): PublicOrigins {
  const mcp = new URL(publicOrigin);
  mcp.port = String(ports.mcp);
  return { app: publicOrigin, mcp: mcp.origin, sandbox: null, companion: null };
}

/**
 * The origins a re-run writes: `derived`, except an MCP or sandbox origin the
 * existing `.env` declares by hand — one its own public origin and ports do not
 * derive (`https://mcp.corp`). Those are the operator's: rewriting them would
 * retire every grant and pairing. A derived value follows the new answers.
 */
export function carriedOrigins(env: Record<string, string>, derived: PublicOrigins): PublicOrigins {
  const previous = carryOverEnv(env);
  const before = previous.publicOrigin ? normalizePublicOrigin(previous.publicOrigin) : null;
  const was = before ? singleHostOrigins(before, previous.ports) : null;
  const declared = (value: string | undefined, derivedBefore: string | null): string | null => {
    try {
      const url = new URL(value?.trim() ?? '');
      return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== derivedBefore ? url.origin : null;
    } catch {
      return null;
    }
  };
  // A one-address install (MCP_BASE_URL = the app origin) stays one address: its MCP origin moves with the app's,
  // and the MCP server keeps a browser address of its own — the app host on the MCP port, or the one declared.
  const oneAddress = before !== null && declared(env.MCP_BASE_URL, null) === new URL(before).origin;
  const app = new URL(derived.app).origin;
  const ownCompanion = declared(env.NEURALIS_COMPANION_ORIGIN, app);
  const companion = ownCompanion ?? (oneAddress && derived.mcp !== app ? derived.mcp : null);
  return {
    app: derived.app,
    mcp: oneAddress ? app : (was && declared(env.MCP_BASE_URL, was.mcp)) || derived.mcp,
    sandbox: declared(env.NEURALIS_MCP_SANDBOX_ORIGIN, null) ?? derived.sandbox,
    companion,
  };
}

/**
 * The origins on a PORT of an https app's own hostname — what its proxy must
 * also serve with TLS, because the MCP and sandbox listeners speak plain http.
 * None for http, for loopback, or once the operator declares names of their own.
 */
export function tlsPortOrigins(origins: PublicOrigins, ports: PortTriple): string[] {
  const app = new URL(origins.app);
  if (app.protocol !== 'https:' || isLoopbackPublicOrigin(origins.app)) return [];
  const onAppHost = (origin: string): boolean => {
    const url = new URL(origin);
    return url.hostname === app.hostname && url.origin !== app.origin;
  };
  const sandbox = origins.sandbox ?? `https://${app.hostname}:${ports.sandbox}`;
  return [origins.mcp, sandbox].filter(onAppHost);
}

/**
 * A tunnel's origins: one hostname each under `domain`, all on 443 — the edge
 * routes by hostname, so there is no port to split the sandbox off with, and
 * its own hostname gets none of the app's (host-only) cookies.
 */
export function tunnelOrigins(domain: string): PublicOrigins {
  return { app: `https://app.${domain}`, mcp: `https://mcp.${domain}`, sandbox: `https://sandbox.${domain}`, companion: null };
}

/** A zone name typed for `tunnel on`: lowercase DNS labels, two at least, no scheme, port or path; else null. */
export function normalizeTunnelDomain(raw: string): string | null {
  const value = raw.trim().toLowerCase().replace(/\.$/, '');
  if (value.length > 253 || !/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(value)) return null;
  return value;
}

/** The tunnel domain an `.env` carries: `NEURALIS_TUNNEL=cloudflare` and the app origin `https://app.<domain>`; else null. */
export function tunnelDomainOf(env: Readonly<Record<string, string | undefined>>): string | null {
  if (env.NEURALIS_TUNNEL?.trim() !== 'cloudflare') return null;
  try {
    const url = new URL(env.APP_URL?.trim() ?? '');
    return url.protocol === 'https:' && url.hostname.startsWith('app.') ? normalizeTunnelDomain(url.hostname.slice(4)) : null;
  } catch {
    return null;
  }
}

/**
 * The origins `tunnel on` replaced, when they were not this machine's own (a
 * reverse proxy, a LAN name): `tunnel off` writes them back. One line,
 * `app=<url> mcp=<url> [sandbox=<url>] [companion=<url>]`, kept while the
 * tunnel is on (a setup re-run carries it) and dropped by `off`.
 */
export const TUNNEL_RESTORE_KEY = 'NEURALIS_TUNNEL_RESTORE';

const RESTORE_PARTS = ['app', 'mcp', 'sandbox', 'companion'] as const;

/** The record's line value for `origins`. */
export function tunnelRestoreValue(origins: PublicOrigins): string {
  return RESTORE_PARTS.flatMap((part) => (origins[part] ? [`${part}=${origins[part]}`] : [])).join(' ');
}

/** The origins a record names, each an http(s) URL as written; null for a line that is not one (`tunnel off` refuses it). */
export function parseTunnelRestore(value: string): PublicOrigins | null {
  const parts = new Map<string, string>();
  for (const token of value.trim().split(/\s+/)) {
    const at = token.indexOf('=');
    const part = token.slice(0, at);
    if (at <= 0 || !(RESTORE_PARTS as readonly string[]).includes(part) || parts.has(part)) return null;
    try {
      const { protocol } = new URL(token.slice(at + 1));
      if (protocol !== 'http:' && protocol !== 'https:') return null;
    } catch {
      return null;
    }
    parts.set(part, token.slice(at + 1));
  }
  const app = parts.get('app');
  const mcp = parts.get('mcp');
  return app && mcp ? { app, mcp, sandbox: parts.get('sandbox') ?? null, companion: parts.get('companion') ?? null } : null;
}

/** `text` (an `.env`) with `key` set to `value` in place, appended when absent, every line of it dropped for null. */
export function replaceEnvKey(text: string, key: string, value: string | null): string {
  const match = new RegExp(`^\\s*${key}\\s*=`);
  const lines = text.split('\n');
  if (value === null) return lines.filter((line) => !match.test(line)).join('\n');
  const at = lines.findIndex((line) => match.test(line));
  if (at >= 0) lines[at] = `${key}=${value}`;
  else lines.splice(lines.length - (lines[lines.length - 1] === '' ? 1 : 0), 0, `${key}=${value}`);
  return lines.join('\n');
}

/** The `.env` keys the origin block owns beyond the ports — what `replaceOriginLines` rewrites or drops. */
export const ORIGIN_KEYS = ['NEXTAUTH_URL', 'APP_URL', 'MCP_BASE_URL', 'NEURALIS_MCP_SANDBOX_ORIGIN', 'NEURALIS_COMPANION_ORIGIN', 'NEURALIS_TUNNEL'] as const;

/** The origin block's key → value (absent ⇒ the key is dropped). */
export function originValues(origins: PublicOrigins, tunnel: boolean): Record<(typeof ORIGIN_KEYS)[number], string | null> {
  return {
    NEXTAUTH_URL: origins.app,
    APP_URL: origins.app,
    MCP_BASE_URL: origins.mcp,
    NEURALIS_MCP_SANDBOX_ORIGIN: origins.sandbox,
    NEURALIS_COMPANION_ORIGIN: origins.companion,
    NEURALIS_TUNNEL: tunnel ? 'cloudflare' : null,
  };
}

/**
 * `text` (an `.env`) with the origin keys set to `origins`: each present line
 * rewritten in place, a missing one appended, a key with no value dropped —
 * every other byte kept (ports, keys, the operator's own lines).
 */
export function replaceOriginLines(text: string, origins: PublicOrigins, tunnel: boolean): string {
  const values = originValues(origins, tunnel);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const line of text.split('\n')) {
    const key = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line)?.[1];
    if (key && key in values) {
      const value = values[key as keyof typeof values];
      if (value !== null && !seen.has(key)) kept.push(`${key}=${value}`);
      seen.add(key);
      continue;
    }
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop();
  for (const [key, value] of Object.entries(values)) if (value !== null && !seen.has(key)) kept.push(`${key}=${value}`);
  return `${kept.join('\n')}\n`;
}

/** The `URLs & Ports` block — the resolved origins, one resolved port triple, and the tunnel marker (with the origins it replaced) when one fronts the app. */
export function buildOriginLines(origins: PublicOrigins, ports: PortTriple, tunnel = false, tunnelRestore: string | null = null): string[] {
  const values = originValues(origins, tunnel);
  return [
    '# ── URLs & Ports ─────────────────────────────────────',
    '# These name the origins USERS ACTUALLY REACH. Authentication and OAuth',
    '# callbacks are resolved against them server-side, so a stale localhost',
    '# value on a remotely-reached deployment breaks the login round-trip.',
    '# Changing them retires every sign-in: MCP and CLI clients sign in again,',
    '# and paired devices pair again against the new MCP origin.',
    `NEXTAUTH_URL=${values.NEXTAUTH_URL}`,
    `APP_URL=${values.APP_URL}`,
    `MCP_BASE_URL=${values.MCP_BASE_URL}`,
    `NEURALIS_APP_PORT=${ports.app}`,
    `MCP_HTTP_PORT=${ports.mcp}`,
    `NEURALIS_MCP_SANDBOX_PORT=${ports.sandbox}`,
    ...(values.NEURALIS_MCP_SANDBOX_ORIGIN ? [`NEURALIS_MCP_SANDBOX_ORIGIN=${values.NEURALIS_MCP_SANDBOX_ORIGIN}`] : []),
    ...(values.NEURALIS_COMPANION_ORIGIN ? [`NEURALIS_COMPANION_ORIGIN=${values.NEURALIS_COMPANION_ORIGIN}`] : []),
    ...(values.NEURALIS_TUNNEL ? ['# A tunnel connector on this machine (`neuralis tunnel`): `off` puts the origins back.', `NEURALIS_TUNNEL=${values.NEURALIS_TUNNEL}`] : []),
    ...(values.NEURALIS_TUNNEL && tunnelRestore ? [`${TUNNEL_RESTORE_KEY}=${tunnelRestore}`] : []),
  ];
}
