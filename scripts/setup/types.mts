/**
 * Shared setup types.
 *
 * These lived inside `setup.mts` until the wizard's file-IO halves were
 * extracted into testable modules (F3 INC-S1). `setup.mts` has no exports and
 * calls `main()` at module load, so anything that needs a unit test has to
 * live outside it — which is why the record writers, the platform-config
 * merge, the `.env` builder and the compose emitter are their own modules now.
 */

import type { EmbeddingEndpointEntry } from '@neuralis/package-system/contracts';

export type VectorChoice = {
  modelId: string;
  dimension: number;
  /** Only when model uses the Ollama protocol. */
  ollamaUrl?: string;
  /** The model's own embedding credential (`embedding.<provider>` / `embedding.endpoint.<id>`). */
  credential?: { id: string; value: string };
  /** The custom `/v1/embeddings` endpoint, already parsed by the kernel's write-mode parser. */
  endpoint?: EmbeddingEndpointEntry;
};

export type MachineVariant = {
  /** Desktop variant identifier — e.g. `ubuntu-xfce`; custom images may use their own. */
  key: string;
  label: string;
  /** Machine-core derivative image name. */
  derivativeImage: string;
};

export type MachineChoice = {
  variant: MachineVariant;
  /** When true, image pulling is skipped (no Docker available / user opted out). */
  skipPrefetch: boolean;
};

/**
 * One custom-endpoint config row, as the FIRST-RUN wizard writes it.
 *
 * Deliberately a SUBSET of agent-core's `LocalLLMEntry`: this is a CLI that
 * runs before any package is built (it cannot import the owner) and before the
 * operator has an admin UI, so it asks only what a first run must decide. The
 * rest is editable in the Credentials tab afterwards, and every field it DOES
 * write must exist on the owner — pinned by
 * `neuralis/src/server/__tests__/localLlmEntryDrift.test.ts`.
 */
export type LocalLLMEntry = {
  id: string;
  label: string;
  baseUrl: string;
  kind: 'ollama-native' | 'openai-compat';
  enabled: boolean;
  /** `bearer` ⇒ the wizard also wrote `llm.endpoint.<id>` to the GLOBAL credential scope. */
  auth?: 'none' | 'bearer';
  /** `public` gets the SSRF floor; a loopback/LAN runtime stays `private`. */
  network?: 'private' | 'public';
};

export type CodexScopeModeSetup = 'full' | 'reduced';

export type CodexTokenBlobSetup = {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
  planType: string | undefined;
  isFedramp: boolean;
  lastRefresh: number;
};

export type SetupConfig = {
  owner: { email: string; name: string; passwordHash: string };
  ownerUserId: string;
  llmKeys: Record<string, string>;
  /**
   * `apiKey` is null only when there is nothing to authenticate: `skip` mode,
   * or an `external` server the operator left unauthenticated. For the
   * self-provisioned modes (`docker`/`binary`) it is always set — carried from
   * an existing .env or minted (never re-minted over a live value).
   */
  qdrant: { url: string; mode: 'docker' | 'binary' | 'external' | 'skip'; apiKey: string | null };
  vector: VectorChoice;
  machine: MachineChoice;
  neuralisHome: string;
  projectId: string;
  projectName: string;
  nextAuthSecret: string;
  mcpApiKey: string;
  /**
   * Where neuralis will actually run. `docker` means the app container is the
   * runtime — setup stores `host.docker.internal` in place of `127.0.0.1` so
   * the container can reach host-native services (Ollama, LM Studio, …).
   * `native` means `pnpm dev:app` or `pnpm start` from the host shell; URLs
   * are kept as-is.
   */
  deploymentMode: 'native' | 'docker';
  /**
   * Operator opt-in (`.env` `NEURALIS_CODEX_LOOPBACK=on`, default off): the
   * generated compose publishes the Codex OAuth loopback on the host's
   * `127.0.0.1:1455`. Docker then holds that host port for as long as the stack
   * runs, so the full setup ASKS it on the Docker shape, defaulting to the
   * carried `.env` value (`codexLoopbackQuestion`); native carries it unchanged.
   */
  codexLoopback: boolean;
  /** `NEURALIS_TRUSTED_PROXIES` — validated (`normalizeTrustedProxies`), '' = none. */
  trustedProxies: string;
  /** `NEURALIS_BUILD_NPMRC` — the private-registry `.npmrc` the image build mounts as a secret (null = none). */
  buildNpmrc: string | null;
  /** `NEURALIS_IMAGE_TAG` on the image channels (`initialImageTag`); null on the monorepo channel. */
  imageTag: string | null;
  uid: number;
  gid: number;
  /** Detected owning GID of /var/run/docker.sock, or null if not applicable. */
  dockerGid: number | null;
  /** User-confirmed custom LLM endpoints (written as platform.json:localLLMs). */
  localLLMs: LocalLLMEntry[];
  /**
   * Bearer keys for the `auth:'bearer'` endpoints above, keyed by endpoint id.
   * Written to the GLOBAL credential scope as `llm.endpoint.<id>` — the same
   * encrypted-file format as every other credential, never into `.env` and
   * never into `platform.json` (a compose/env value is readable with
   * `docker inspect`, and platform config is an admin-visible plaintext file).
   */
  endpointKeys: Record<string, string>;
  /**
   * The origin users will actually reach this deployment on — what
   * `NEXTAUTH_URL`, `APP_URL` and the compose `environment:` block all get.
   * Resolved once, from the existing value on a re-run.
   */
  publicOrigin: string;
  /** Ports, read back from an existing install when there is one. */
  ports: { app: number; mcp: number; sandbox: number };
  /**
   * Docker Compose project name. Preserved across re-runs: it prefixes the
   * named volumes, the network and every container name, so changing it on an
   * existing install orphans `qdrant-data` and breaks tooling that addresses
   * containers by their derived names.
   */
  composeProject: string;
  /**
   * Optional OpenAI Codex OAuth token blob (captured when the user chose
   * "Sign in with ChatGPT" in askOpenAIAuth). `undefined` means no OAuth.
   */
  codexBlob?: CodexTokenBlobSetup;
};
