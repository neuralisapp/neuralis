/**
 * The Ollama companion — OPTIONAL, off by default: the pinned release, its
 * assets per OS and architecture, the one way `neuralis up` starts its own
 * binary, and the `.env` lines that say which Ollama this install uses.
 *
 * Four modes (`OLLAMA_MODE`, one writer — setup):
 *   existing  an Ollama the operator already runs; this install only points at it
 *   docker    a companion container — the Docker install's compose service, or
 *             the desktop app's own compose file beside its `.env` (`up` starts
 *             and stops it through the ONE companion starter)
 *   binary    the official release, downloaded on demand into the data home and
 *             supervised by `neuralis up` (the desktop app's host only)
 *   none      no Ollama (the default)
 *
 * Ollama has NO authentication, so every mode this install starts listens on
 * loopback only — a LAN switch or a tunnel never moves it. The client URL the
 * app uses is the platform setting `ollamaUrl`, seeded by setup; `.env` names
 * the mode and the port `up` binds, never a URL.
 *
 * Refresh the pin: `gh api repos/ollama/ollama/releases/latest` (each asset's
 * `digest` is its sha256), and the Docker Hub tag API for the image index
 * digest (`hub.docker.com/v2/repositories/ollama/ollama/tags/<version>`).
 */

import { join } from 'node:path';

export const OLLAMA_VERSION = '0.40.12';

/** The compose image, pinned by its multi-arch index digest (never `latest`). */
export const OLLAMA_IMAGE = `ollama/ollama:${OLLAMA_VERSION}@sha256:20d1bbfbabe1c97ba4b16301f08a20d8484bcf77047742a3cb71c613d8e12d0b`;

/** The port this install's OWN Ollama listens on — beside, never on, a user's own `11434`. */
export const OLLAMA_OWN_PORT = 11435;

/** The port an Ollama the operator already runs answers on (Ollama's default). */
export const OLLAMA_DEFAULT_PORT = 11434;

/**
 * The embedding model a chosen Ollama serves: the catalog id brain-core
 * resolves, and the tag pulled — pinned to the 0.6b weights (1024 dimensions;
 * `:latest` is the 8b model with another dimension).
 */
export const OLLAMA_EMBEDDING_MODEL_ID = 'ollama:qwen3-embedding';
export const OLLAMA_EMBEDDING_TAG = 'qwen3-embedding:0.6b';
export const OLLAMA_EMBEDDING_DIMENSION = 1024;

export type OllamaMode = 'existing' | 'docker' | 'binary' | 'none';
export const OLLAMA_MODES: readonly OllamaMode[] = ['existing', 'docker', 'binary', 'none'];

/** `--ollama <mode>` / `OLLAMA_MODE`: one of the four words, else null. */
export function parseOllamaMode(value: string | undefined | null): OllamaMode | null {
  const word = value?.trim().toLowerCase();
  return (OLLAMA_MODES as readonly string[]).includes(word ?? '') ? (word as OllamaMode) : null;
}

export type OllamaAsset = { url: string; filename: string; sha256: string; bytes: number; unpack: 'tar.zst' | 'tgz' | 'zip' };

/**
 * The release archive for this machine. Linux ships CPU + NVIDIA libraries in
 * one `.tar.zst` (≈1.5 GB; AMD needs upstream's separate ROCm add-on, not offered
 * here); macOS one `.tgz` for both architectures (Metal on Apple silicon);
 * Windows a `.zip`. Null where upstream publishes nothing.
 */
export function ollamaAsset(platform: NodeJS.Platform = process.platform, arch: string = process.arch): OllamaAsset | null {
  const base = `https://github.com/ollama/ollama/releases/download/v${OLLAMA_VERSION}`;
  const row = (filename: string, sha256: string, bytes: number, unpack: OllamaAsset['unpack']): OllamaAsset => ({ url: `${base}/${filename}`, filename, sha256, bytes, unpack });
  if (platform === 'linux' && arch === 'x64') return row('ollama-linux-amd64.tar.zst', 'f8adcb7e08d272283a4bd3abc18cf581afe37e64b2aee04fda4f407f215485ba', 1_525_425_005, 'tar.zst');
  if (platform === 'linux' && arch === 'arm64') return row('ollama-linux-arm64.tar.zst', 'eab411c311611fe0fcddf5ba73c68ea94a9571007b520d8708112348b87c0bd6', 1_582_120_565, 'tar.zst');
  if (platform === 'darwin') return row('ollama-darwin.tgz', '1d1b4c2cf40d2a239f9b08a77384830800a8542c744a55f47247f9baf85b55d2', 186_398_711, 'tgz');
  if (platform === 'win32' && arch === 'x64') return row('ollama-windows-amd64.zip', '21814944f3e50d3f07b6bb3af75baddb96f59e91353c332ac9c5063b3bfd1041', 1_601_458_136, 'zip');
  if (platform === 'win32' && arch === 'arm64') return row('ollama-windows-arm64.zip', 'e64ab13a21bde937abcec5c3d2b5bf8b1a152f325a018077a6767df07c7f7391', 215_776_808, 'zip');
  return null;
}

/** Where the downloaded release lives in the data home (one folder per version). */
export function ollamaInstallDir(home: string, version: string = OLLAMA_VERSION): string {
  return join(home, 'app', 'ollama', version);
}

/** Where its models live — outside the versioned folder, so an upgrade keeps them. */
export function ollamaModelsDir(home: string): string {
  return join(home, 'app', 'ollama', 'models');
}

/**
 * The executable inside an unpacked release: Linux's archive holds `bin/ollama`
 * (+ `lib/ollama`), macOS's and Windows' the executable at the top.
 */
export function ollamaExecutableCandidates(dir: string, platform: NodeJS.Platform = process.platform): string[] {
  const name = platform === 'win32' ? 'ollama.exe' : 'ollama';
  return [join(dir, 'bin', name), join(dir, name)];
}

/**
 * How `neuralis up` starts this install's own Ollama: `serve`, an AUTHORED
 * environment (the caller's `base` — `authoredBaseEnv` + `HOME` — never its own
 * login environment), loopback on `port`, its models in the data home, one
 * model loaded at a time, and the upstream unload-after-idle (5 min) said out
 * loud so a later upstream default never changes the memory this costs.
 */
export function ollamaBinarySpawn(home: string, port: number, base: Readonly<Record<string, string | undefined>>): { args: string[]; env: Record<string, string> } {
  const kept = Object.fromEntries(Object.entries(base).filter((entry): entry is [string, string] => Boolean(entry[1])));
  return {
    args: ['serve'],
    env: {
      ...kept,
      OLLAMA_HOST: `127.0.0.1:${port}`,
      OLLAMA_MODELS: ollamaModelsDir(home),
      OLLAMA_MAX_LOADED_MODELS: '1',
      OLLAMA_KEEP_ALIVE: '5m',
    },
  };
}

/**
 * The `.env` lines of the Ollama choice: the mode, and the loopback port this
 * install's own Ollama binds (docker and binary). `none` writes the mode alone,
 * so a re-run reads the operator's answer back instead of asking again.
 */
export function ollamaEnvLines(mode: OllamaMode, port: number = OLLAMA_OWN_PORT): string[] {
  return [
    '# Local models (Ollama): existing | docker | binary | none. The app reaches it',
    '# through the platform setting `ollamaUrl`; this install\'s own listens on loopback only.',
    `OLLAMA_MODE=${mode}`,
    ...(mode === 'docker' || mode === 'binary' ? [`NEURALIS_OLLAMA_PORT=${port}`] : []),
  ];
}

/** The `.env` keys `ollamaEnvLines` writes — what a re-run replaces. */
export const OLLAMA_ENV_KEYS = ['OLLAMA_MODE', 'NEURALIS_OLLAMA_PORT'] as const;

/** The client URL the platform setting `ollamaUrl` gets for a mode this install started (loopback, its own port). */
export function ownOllamaUrl(port: number = OLLAMA_OWN_PORT): string {
  return `http://127.0.0.1:${port}`;
}

/**
 * What the choice costs, said where it is offered: the program download only
 * when this install fetches the release (`binary`) — an existing Ollama and
 * the compose image cost no program download here — then the embedding model,
 * memory and CPU.
 */
export function ollamaCostLine(mode: OllamaMode, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  const asset = mode === 'binary' ? ollamaAsset(platform, arch) : undefined;
  const download = asset ? `≈${(asset.bytes / 1e9).toFixed(1)} GB download for the program, ` : '';
  return `${download}≈0.64 GB for the embedding model (${OLLAMA_EMBEDDING_TAG}), ≈1 GB of memory while it indexes (released after 5 idle minutes); CPU-heavy while a large folder is first indexed.`;
}

/** The embedding target a home without a local model takes: a model id and its dimension, off until its key. */
export type EmbeddingFallback = { modelId: string; dimension: number } | undefined;

/**
 * The platform-config change of an Ollama choice. `seed` fills the keys the
 * file lacks (an operator's own values win); `replace` re-points what an
 * earlier choice wrote — the client URL follows the mode, a target that is
 * OFF takes the local model, and `none` hands the local model an earlier
 * choice set back to the unasked answer (`fallback`, off until its key), so
 * no write waits on a model nothing will ever fetch. A target the operator
 * runs is never touched. On a fresh home (`current` empty) it is the seed
 * alone.
 */
export function ollamaPlatformChange(
  mode: OllamaMode,
  current: Readonly<Record<string, unknown>>,
  existingUrl: string,
  fallback: EmbeddingFallback,
  port: number = OLLAMA_OWN_PORT,
): { seed: Record<string, unknown>; replace: Record<string, unknown> } {
  if (mode === 'none') {
    if (current.embeddingModelId !== OLLAMA_EMBEDDING_MODEL_ID) return { seed: {}, replace: {} };
    const unasked = { ...(fallback ? { embeddingModelId: fallback.modelId, embeddingDimension: fallback.dimension } : {}), embeddingEnabled: false };
    return { seed: unasked, replace: unasked };
  }
  const local = { embeddingModelId: OLLAMA_EMBEDDING_MODEL_ID, embeddingDimension: OLLAMA_EMBEDDING_DIMENSION, embeddingEnabled: true };
  const ollamaUrl = mode === 'existing' ? existingUrl : ownOllamaUrl(port);
  return {
    seed: { ollamaUrl, ...local },
    replace: { ollamaUrl, ...(current.embeddingEnabled === false ? local : {}) },
  };
}
