/**
 * Generic package-companion mount loop (native-nightjar H0).
 *
 * Every surface on the `:3101` companion HTTP server is a package's: the
 * external MCP endpoint with its OAuth 2.1 authorization server, the terminal
 * PTY socket, machine-core's KasmVNC stream and the host-broker proxy.
 *
 * This used to be three hardcoded `mountTerminalWs` / `mountMachine*` blocks
 * with the AUTH CLOSURES living in host code. They now live in their owning
 * packages, and this loop only injects PORTS.
 *
 * ## The rule this loop must never break
 *
 * The mounts do NOT share an auth policy:
 *   - agent-core (MCP + OAuth AS): OAuth JWT / agent API key / community API
 *     key, re-resolved through the ONE member resolver before any dispatch.
 *   - agent-core (terminal): session cookie → membership. No feature gate at
 *     the upgrade; write access is decided from `core.execute` inside the WS
 *     server (absent ⇒ read-only session, not a rejection).
 *   - machine-core: session cookie → membership → **`machine.read`** through
 *     `authorizeStreamAccess` (SF-MC1).
 *   - host broker (H2'): additionally `exec.host`.
 *
 * Lifting authentication into a shared wrapper here would silently drop the
 * strictest gate. The host therefore injects capabilities only; every package
 * returns its OWN fully-closed handle. One startup log line per mount is the
 * drift signal — keep it.
 *
 * Discovery is duck-typed off `getPackageApi()` (MAJOR 1a): this is NOT a
 * `PackageLifecycleHooks` contract change, so a package opts in simply by
 * exposing `mountCompanionWs` / `mountCompanionHttp` on its api.
 */

import type { Server as HttpServer } from 'node:http';

/** The handle a package returns for each mounted companion surface. */
export type CompanionMountHandle = {
  /** Short human label for the startup log line. */
  label: string;
  close: () => void;
  /** Live sessions this surface holds — summed into `/healthz`. */
  sessionCount?: () => number;
};

/**
 * Host-injected capabilities. No package-specific knowledge lives here.
 * `resolveSessionUser` answers `null` for a principal that is no longer active
 * and `getProjectById` for an archived project, so a companion's existing deny
 * branch covers both without a check of its own.
 */
export type CompanionMountPorts = {
  resolveSessionUser: (input: {
    headers: Record<string, string | string[] | undefined>;
  }) => Promise<{ userId: string; email?: string; name?: string; sessionEpoch?: number } | null>;
  getProjectById: (projectId: string) => Promise<CompanionProject | null>;
  /** The user's non-archived projects with their names — the OAuth consent picker. */
  listProjects: (userId: string) => Promise<Array<{ id: string; name: string }>>;
  /** The public `:3101` base URL (`MCP_BASE_URL`) — the OAuth issuer. A host env read. */
  mcpBaseUrl: string;
  /** Where the OAuth consent sends a browser without a session (`APP_URL` → `NEXTAUTH_URL`). */
  loginRedirectUrl: string;
  /** `OAUTH_ALLOWED_REDIRECT_HOSTS` — absent ⇒ the authorization server's own default. */
  allowedRedirectHosts?: string[];
  /**
   * The host-built request-body parsers (the `mcpHttpBodyMaxKb` limit). A
   * companion attaches them to ITS OWN body-reading routes only — never
   * app-wide, which would consume another companion's streamed upload.
   */
  bodyParsers: unknown[];
  onAuditEvent?: (event: {
    action: string;
    userId: string;
    target?: string;
    details?: Record<string, unknown>;
  }) => void;
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
};

/**
 * The subset of the host project record a companion auth closure needs.
 *
 * ⚠ **This type exists TWICE** — here and at
 * `packages/agent-core/src/terminal/mountTerminalCompanion.ts`. The loop
 * duck-types the mount, so the two declarations are independent and nothing
 * links them; `getProjectById` hands both the FULL `ProjectRecord`, which is
 * wider than either copy. Widening only one therefore compiles and works BY
 * ACCIDENT. Both move together — agent-core's
 * `__tests__/companionProjectContract.test.ts` fails when they drift.
 *
 * `roles[].agents` and `agentOwnership` are the two inputs `sessionCanUseAgent`
 * branches on (IDENT-007). Omitting them fails CLOSED, and only for the
 * strongest roles: every `agents:'*'` holder would be computed as having access
 * to no agent but the ones they personally created.
 */
export type CompanionProject = {
  members: Record<string, { role: string } | undefined>;
  roles: Record<
    string,
    { grantedFeatures?: string[]; priority?: number; agents?: '*' | 'own' | 'view' } | undefined
  >;
  agentOwnership?: Record<string, { createdBy: string; assignedTo: string[] }>;
};

/** The structural api shape this loop looks for on each loaded package. */
type CompanionCapableApi = {
  mountCompanionWs?: (httpServer: HttpServer, ports: CompanionMountPorts) => CompanionMountHandle;
  mountCompanionHttp?: (app: unknown, ports: CompanionMountPorts) => CompanionMountHandle;
};

export type CompanionLoaderLike = {
  listLoaded: () => Array<{ id: string }>;
  getPackageApi: <T>(id: string) => T | undefined;
};

/**
 * Mount every loaded package's companion surfaces.
 *
 * Returns the collected handles so `shutdown()` can close them all. A throwing
 * mount is logged and skipped — one package's companion must not prevent the
 * MCP server from serving.
 */
export function mountPackageCompanions(opts: {
  loader: CompanionLoaderLike;
  httpServer: HttpServer;
  app: unknown;
  ports: CompanionMountPorts;
}): CompanionMountHandle[] {
  const handles: CompanionMountHandle[] = [];

  for (const pkg of opts.loader.listLoaded()) {
    let api: CompanionCapableApi | undefined;
    try {
      api = opts.loader.getPackageApi<CompanionCapableApi>(pkg.id);
    } catch {
      continue;
    }
    if (!api) continue;

    if (typeof api.mountCompanionHttp === 'function') {
      try {
        const handle = api.mountCompanionHttp(opts.app, opts.ports);
        handles.push(handle);
        console.log(`[companion] ${pkg.id} mounted ${handle.label}`);
      } catch (err) {
        console.warn(`[companion] ${pkg.id} HTTP companion mount failed:`, err);
      }
    }

    if (typeof api.mountCompanionWs === 'function') {
      try {
        const handle = api.mountCompanionWs(opts.httpServer, opts.ports);
        handles.push(handle);
        console.log(`[companion] ${pkg.id} mounted ${handle.label}`);
      } catch (err) {
        console.warn(`[companion] ${pkg.id} WebSocket companion mount failed:`, err);
      }
    }
  }

  return handles;
}
