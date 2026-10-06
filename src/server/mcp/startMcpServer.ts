/**
 * The `:3101` companion HTTP server — starts inside the Next.js process via
 * instrumentation.
 *
 * The host owns the SERVER and nothing that runs on it: express, the CORS
 * stance, `/healthz`, the request-body parsers (built once with the configured
 * size limit), the path-agnostic safe error surface, `listen`, the companion
 * loop and shutdown. Every surface on it is a package COMPANION mounted by
 * `mountPackageCompanions` through PORTS ONLY — the external MCP endpoint and
 * its OAuth 2.1 authorization server included (OAuth JWT, agent API key,
 * community API key; no env fallback, no x-* header scope override — the
 * owning package enforces that inside its own closure).
 */
import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { getRuntime } from '../host/bootstrap';
import { resolveSessionUser } from './resolveSessionUser';
import { mountPackageCompanions, type CompanionMountHandle } from './mountPackageCompanions';
import { addShutdownStep } from '../host/shutdown';
import { writeAuditLog, type AuditAction } from '../store/AuditStore';
import { getProjectById, listProjectsForUser } from '../store/ProjectStore';
import { getPlatformConfigStore } from '../store/PlatformConfigStore';

const PORT = Number(process.env.MCP_HTTP_PORT || 3101);

/**
 * The `:3101` request-body parsers, built once with the configured size limit.
 *
 * They are handed to the mount functions that OWN body-reading routes (OAuth
 * and MCP), which attach them to exactly those routes — the host never lists
 * a route path itself. There is deliberately NO app-wide parser: a package
 * companion (an upload through the machine stream) must receive its request
 * body as the unread stream, and an app-wide parser consumes any JSON- or
 * form-typed body first. The form parser keeps Express's own default limit.
 */
export function buildMcpBodyParsers(bodyMaxKb: number): express.RequestHandler[] {
  return [express.json({ limit: `${bodyMaxKb}kb` }), express.urlencoded({ extended: false })];
}

/**
 * The response surfaces this server exposes. It is a BOUNDED label on purpose:
 * the error handler below runs on EVERY path, so a failure carries a
 * caller-controlled pathname into it, and attacker-controlled
 * bytes must never reach the log stream unbounded.
 */
export type McpErrorSurface = 'mcp' | 'oauth' | 'discovery' | 'other';

export function classifyErrorSurface(pathname: string): McpErrorSurface {
  if (pathname === '/mcp' || pathname.startsWith('/mcp/')) return 'mcp';
  if (pathname === '/oauth' || pathname.startsWith('/oauth/')) return 'oauth';
  if (pathname.startsWith('/.well-known/')) return 'discovery';
  return 'other';
}

export type SafeErrorResponse = {
  surface: McpErrorSurface;
  status: number;
  body: Record<string, unknown>;
};

function isClientErrorStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 499;
}

/**
 * A client error keeps its own status (the body parser answers 400 on malformed
 * JSON and 413 over the size cap) — collapsing those into 500 would tell the
 * caller the server broke when the request did. Anything else is 500.
 */
function readClientErrorStatus(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  if ('status' in err && isClientErrorStatus(err.status)) return err.status;
  if ('statusCode' in err && isClientErrorStatus(err.statusCode)) return err.statusCode;
  return null;
}

/**
 * The safe wire answer for an unhandled error, chosen from the PATH FAMILY and
 * the error's own status — never from the error's message. The envelope follows
 * the protocol the caller speaks (JSON-RPC on the MCP verbs, an OAuth error
 * object on the token/registration/discovery endpoints), the strings are fixed,
 * and no `err.message`, stack, header or filesystem path ever reaches it.
 */
export function buildSafeErrorResponse(pathname: string, err: unknown): SafeErrorResponse {
  const surface = classifyErrorSurface(pathname);
  const status = readClientErrorStatus(err) ?? 500;
  const isClientError = status < 500;

  if (surface === 'mcp') {
    return {
      surface,
      status,
      body: {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: isClientError ? -32600 : -32603,
          message: isClientError ? 'Invalid Request' : 'Internal server error',
        },
      },
    };
  }
  if (surface === 'oauth' || surface === 'discovery') {
    return { surface, status, body: { error: isClientError ? 'invalid_request' : 'server_error' } };
  }
  return { surface, status, body: { error: isClientError ? 'invalid_request' : 'internal_error' } };
}

let started = false;
let companionMounts: CompanionMountHandle[] = [];

export async function startMcpServer(): Promise<void> {
  if (started) return;
  started = true;

  const core = await getRuntime();
  await core.whenReady();
  const app = express();

  app.use(cors({ origin: false, credentials: false }));
  // `mcpHttpBodyMaxKb` platform key — boot-read (applies on restart): the
  // parsers are constructed once at server start. Store is registered by the
  // `getRuntime()` bootstrap above.
  const bodyMaxKb = ((): number => {
    try {
      return Number(getPlatformConfigStore().get('mcpHttpBodyMaxKb')) || 256;
    } catch {
      return 256;
    }
  })();
  const bodyParsers = buildMcpBodyParsers(bodyMaxKb);

  // Health endpoint — process liveness, plus the live MCP session count the
  // companion that owns those sessions reports.
  app.get('/healthz', (_req, res) => {
    res.json({
      status: 'ok',
      sessions: companionMounts.reduce((sum, handle) => sum + (handle.sessionCount?.() ?? 0), 0),
      uptime: Math.floor(process.uptime()),
    });
  });

  // The deployment's public facts the OAuth authorization server needs — read
  // HERE, from the host's own env, and handed over as port VALUES.
  const mcpBaseUrl = process.env.MCP_BASE_URL?.trim() || `http://localhost:${PORT}`;
  const loginRedirectUrl = process.env.APP_URL?.trim() || process.env.NEXTAUTH_URL?.trim() || 'http://localhost:3100';
  const allowedRedirectHosts = process.env.OAUTH_ALLOWED_REDIRECT_HOSTS?.split(',').map((h) => h.trim()).filter(Boolean);

  // The server exists before any companion mounts: a WebSocket companion
  // attaches its `upgrade` listener to it, and every companion route is in
  // place before the first byte is accepted.
  const server = createServer(app);
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 125_000;

  // Package companions on the SAME HTTP server — the MCP endpoint + OAuth AS,
  // the terminal PTY WebSocket, machine-core's stream HTTP+WS bridge and the
  // host-broker proxy. The loop injects PORTS only; each package owns its own
  // auth closure.
  companionMounts = mountPackageCompanions({
    loader: core.getLoader(),
    httpServer: server,
    app,
    ports: {
      resolveSessionUser: (input) => resolveSessionUser(input),
      // Archived ⇒ absent: every companion auth closure already denies a
      // missing project, so none of them needs an archive check of its own.
      getProjectById: async (projectId) => {
        const project = await getProjectById(projectId);
        return project && project.archivedAt == null ? project : null;
      },
      // The consent picker's list — the store excludes archived projects.
      listProjects: async (userId) => {
        const projects = await listProjectsForUser(userId);
        return projects.map((p) => ({ id: p.id, name: p.name }));
      },
      mcpBaseUrl,
      loginRedirectUrl,
      ...(allowedRedirectHosts ? { allowedRedirectHosts } : {}),
      bodyParsers,
      onAuditEvent: (event) => {
        void writeAuditLog({
          userId: event.userId,
          action: event.action as AuditAction,
          ...(event.target ? { target: event.target } : {}),
          ...(event.details ? { details: event.details } : {}),
        });
      },
      logger: { info: console.log, warn: console.warn, error: console.error },
    },
  });

  // PATH-AGNOSTIC error handler for the surfaces this server answers on — it
  // is the last layer before Express's own finalhandler, which serializes
  // `err.stack` into the response body outside production. The OAuth token /
  // registration / agent endpoints and the discovery documents are reachable
  // with no credential and their handlers read the token store, so a
  // store-path-bearing message would go straight to an unauthenticated client
  // (invariant 9). Every MCP / OAuth / discovery path and `/healthz` answers a
  // FIXED safe body and the real error is logged server-side only.
  //
  // Registered AFTER every route it protects (the companion loop above) and
  // BEFORE `listen`. Any other path is a fully-closed package companion with its
  // own policy whose path carries caller-supplied session keys that must never
  // reach this log line — it is handed straight on.
  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    const { surface, status, body } = buildSafeErrorResponse(req.path, err);
    if (surface === 'other' && req.path !== '/healthz') {
      next(err);
      return;
    }
    // Bounded context only — the surface LABEL, never the raw path, and never a
    // header or a query string (an OAuth path carries `code`/`state`).
    console.error('[mcp-http] Request failed', { surface, method: req.method, status }, err);
    if (res.headersSent) {
      // A partially written response (an open SSE stream) can carry no error
      // body — hand it back so Express destroys the socket instead of leaving
      // the request hanging.
      next(err);
      return;
    }
    res.status(status).json(body);
  });

  // --- Start server ---
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[mcp-http] Community MCP server listening on http://0.0.0.0:${PORT}/mcp`);
    console.log(`[mcp-http] Health: http://localhost:${PORT}/healthz`);
  });

  // This server is a shutdown REGISTRANT, not the shutdown owner — the
  // SIGTERM/SIGINT handlers are installed unconditionally by
  // `instrumentation.register()` before this function is even reached, so a
  // `MCP_HTTP_PORT=0` deployment (or a bootstrap that rejects above) still
  // drains. The stream drain itself runs in `server/host/shutdown.ts` FIRST,
  // ahead of every registered step: the SSE route generators must still be
  // pumping for an aborted turn to finalize + persist, so closing this HTTP
  // server before the drain would strand exactly the turn being saved.
  addShutdownStep('mcp-http', async () => {
    console.log('[mcp-http] Shutting down...');
    for (const handle of companionMounts) {
      try { handle.close(); } catch { /* a companion must not block shutdown */ }
    }
    companionMounts = [];
    server.close();
  });
}
