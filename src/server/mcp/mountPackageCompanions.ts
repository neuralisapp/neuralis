/**
 * Generic package-companion mount loop (native-nightjar H0).
 *
 * Every surface on the `:3101` companion HTTP server is a package's: the
 * external MCP endpoint with its OAuth 2.1 authorization server, the terminal
 * PTY socket, machine-core's KasmVNC stream, the host-terminal proxy and the
 * device link a paired device dials.
 *
 * This used to be three hardcoded `mountTerminalWs` / `mountMachine*` blocks
 * with the AUTH CLOSURES living in host code. They now live in their owning
 * packages, and this loop only injects PORTS.
 *
 * ## The rule this loop must never break
 *
 * The mounts do NOT share an auth policy:
 *   - agent-core (MCP + OAuth AS): OAuth JWT / agent API key, re-resolved
 *     through the ONE member resolver before any dispatch.
 *   - agent-core (terminal): session cookie → membership. No feature gate at
 *     the upgrade; write access is decided from `core.execute` inside the WS
 *     server (absent ⇒ read-only session, not a rejection).
 *   - machine-core: its own single-session stream cookie (never the app
 *     session cookie) → membership → **`machine.read`** through
 *     `authorizeStreamAccess` (SF-MC1).
 *   - agent-core (host terminal): additionally the device gate — the device's
 *     owner with `device.own`, or `terminal.device` on a live-`sandboxed` device.
 *   - agent-core (device link): no session at all — the device's own secret,
 *     compared by hash; the link carries answers, never a call.
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
import { isValidAppOriginPath } from '@neuralis/package-system/contracts';
import { isTrustedProxyAddress } from '../auth/requestClient';

/** The handle a package returns for each mounted companion surface. */
export type CompanionMountHandle = {
  /** Short human label for the startup log line. */
  label: string;
  close: () => void;
  /** Live sessions this surface holds — summed into `/healthz`. */
  sessionCount?: () => number;
  /**
   * Paths a BROWSER reaches on the trusted app origin, where its session
   * cookie lives (exact, or a prefix ending in `/`). The host's request proxy
   * forwards exactly these to this server (`@neuralis/package-system/contracts`
   * `appOriginForward.ts`). ⛔ Never a bearer path or the device link — those
   * are `issuerPaths`.
   */
  appOriginPaths?: readonly string[];
  /**
   * The issuer's own paths (bearer endpoints, discovery, the device link),
   * forwarded from the app origin ONLY when `MCP_BASE_URL` and `APP_URL` are
   * one origin — the one-address install; otherwise clients reach them on the
   * issuer's own address. ⛔ A path here that trusts a loopback peer must
   * treat a forwarded request as remote (the marker and `x-forwarded-host`).
   */
  issuerPaths?: readonly string[];
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
  }) => Promise<{ userId: string; email?: string; name?: string; sessionEpoch?: number; mustChangePassword?: boolean; appearance?: { iconName?: string; color?: string; background?: 'filled' | 'transparent'; imageUrl?: string } } | null>;
  getProjectById: (projectId: string) => Promise<CompanionProject | null>;
  /** The user's non-archived projects with their names and appearance (picture as an ABSOLUTE app-origin URL) — the OAuth consent picker. */
  listProjects: (userId: string) => Promise<Array<{ id: string; name: string; appearance?: { iconName?: string; color?: string; background?: 'filled' | 'transparent'; imageUrl?: string } }>>;
  /** The public `:3101` base URL (`MCP_BASE_URL`) — the OAuth issuer. A host env read. */
  mcpBaseUrl: string;
  /**
   * This server's OWN browser origin — `NEURALIS_COMPANION_ORIGIN`, else
   * `MCP_BASE_URL`'s — for a companion document that must never run on the app
   * origin. `null` when it would equal the app origin (one hostname, nothing
   * declared): such a companion refuses rather than guess.
   */
  companionOrigin: string | null;
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
  /**
   * The host's declared trusted-proxy predicate (`NEURALIS_TRUSTED_PROXIES`)
   * over a socket peer address. The loop below always supplies it; with no
   * list declared it answers `false` for every address, so a same-machine
   * proxy that adds no forwarding header reads as this machine — declare it.
   */
  isTrustedProxy?: (address: string) => boolean;
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
 * `roles[].priority` feeds the agent USE gate (`resolveRequestedAgent` →
 * `AgentService.use`, the agent record's uri-policy read bit — IDENT-007);
 * `roles[].agents` and `agentOwnership` remain the MANAGE axis. Omitting them
 * fails CLOSED.
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
  // The loop supplies the host's trusted-proxy predicate itself, so no call
  // site can forget it (the device link's loopback observation needs it).
  const ports: CompanionMountPorts = { ...opts.ports, isTrustedProxy: opts.ports.isTrustedProxy ?? isTrustedProxyAddress };

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
        const handle = api.mountCompanionHttp(opts.app, ports);
        handles.push(handle);
        console.log(`[companion] ${pkg.id} mounted ${handle.label}`);
      } catch (err) {
        console.warn(`[companion] ${pkg.id} HTTP companion mount failed:`, err);
      }
    }

    if (typeof api.mountCompanionWs === 'function') {
      try {
        const handle = api.mountCompanionWs(opts.httpServer, ports);
        handles.push(handle);
        console.log(`[companion] ${pkg.id} mounted ${handle.label}`);
      } catch (err) {
        console.warn(`[companion] ${pkg.id} WebSocket companion mount failed:`, err);
      }
    }
  }

  return handles;
}

/**
 * The path set the app origin forwards: every mounted companion's
 * `appOriginPaths`, plus its `issuerPaths` when `MCP_BASE_URL` and the trusted
 * app origin are ONE origin (the same comparison as the authorization server's
 * loop guard, so the two agree by construction; an unparseable value forwards
 * no issuer path). A declaration the kernel rule refuses
 * (`isValidAppOriginPath`) is dropped with one warning and the rest still
 * forward — never the host's own trees, never a malformed path.
 */
export function collectAppOriginPaths(
  handles: readonly CompanionMountHandle[],
  origins: { mcpBaseUrl: string; appOrigin: string },
): string[] {
  const oneOrigin = ((): boolean => {
    try {
      return new URL(origins.mcpBaseUrl).origin === new URL(origins.appOrigin).origin;
    } catch {
      return false;
    }
  })();
  const paths = new Set<string>();
  for (const handle of handles) {
    for (const path of [...(handle.appOriginPaths ?? []), ...(oneOrigin ? handle.issuerPaths ?? [] : [])]) {
      if (isValidAppOriginPath(path)) paths.add(path);
      else console.warn(`[companion] ${handle.label}: app-origin path refused`, { path: path.slice(0, 64) });
    }
  }
  return [...paths];
}
