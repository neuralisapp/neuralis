/**
 * The `:3101` server's LAST layer before Express's own `finalhandler`.
 *
 * `classifyErrorSurface` and `buildSafeErrorResponse` are exported purely so
 * they can be tested; nothing else imports them. Both encode a security rule
 * rather than a formatting preference, and the rule is invariant 9: the error
 * handler sits on paths reachable with NO credential (`/oauth/token`,
 * `/oauth/register`, the discovery documents), and the handlers behind those
 * paths read the token store, so an `err.message` carrying `tokensPath` would
 * go straight to an unauthenticated client. Express's default handler
 * serializes `err.stack` into the body outside production, which is what the
 * whole layer exists to stop.
 *
 * The rows below pin four things:
 *   1. The surface is chosen from the PATH FAMILY, and a path that merely
 *      starts with the same letters is not the family.
 *   2. No `err.message`, stack, header, raw body or filesystem path reaches any
 *      response body — asserted as a CLASS over a deliberately leaky error, not
 *      against the one field somebody happened to think of.
 *   3. A 4xx keeps its own status; everything else becomes 500. This is the
 *      branch that stops a body-parser 400 (malformed JSON) or 413 (over the
 *      size cap) from telling the caller the server broke when the request did.
 *   4. The handler is wired AFTER every companion route it protects (the MCP
 *      and OAuth surfaces are companion mounts) and BEFORE `listen`.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildSafeErrorResponse,
  classifyErrorSurface,
  type McpErrorSurface,
} from '../startMcpServer';

// ---------------------------------------------------------------------------
// A deliberately leaky error — every field a real one carries
// ---------------------------------------------------------------------------

/**
 * The secrets no response body may ever contain. Each is a real leak that has
 * happened somewhere in this repo's history: an absolute store path in a
 * message (invariant 9), a stack naming the server's source tree, a bearer
 * header echoed back, and body-parser's own `err.body` — the RAW request bytes,
 * which it attaches to a parse failure and which the caller controls.
 */
const SECRETS = {
  path: '/home/operator/.neuralis/config/oauth/tokens.json',
  stackFrame: 'at FileOAuthRepository.readTokens (/app/packages/agent-core/mcp/oauth/x.ts:225:11)',
  header: 'Bearer eyJhbGciOiJSUzI1NiJ9.super-secret-token',
  rawBody: '{"jsonrpc":"2.0","method":"tools/call","params":{"secret":"hunter2"}}',
} as const;

type LeakyError = Error & {
  status?: number;
  statusCode?: number;
  body?: string;
  headers?: Record<string, string>;
  tokensPath?: string;
};

function leakyError(status?: number): LeakyError {
  const err = new Error(`ENOENT: no such file or directory, open '${SECRETS.path}'`) as LeakyError;
  err.stack = `Error: ${err.message}\n    ${SECRETS.stackFrame}`;
  err.body = SECRETS.rawBody;
  err.headers = { authorization: SECRETS.header };
  err.tokensPath = SECRETS.path;
  if (status !== undefined) {
    err.status = status;
    err.statusCode = status;
  }
  return err;
}

/** Every path family, so the leak scan below covers all four envelopes. */
const ALL_PATHS = [
  '/mcp',
  '/oauth/token',
  '/.well-known/oauth-authorization-server',
  '/healthz',
] as const;

// ---------------------------------------------------------------------------

describe('classifyErrorSurface', () => {
  it.each([
    ['/mcp', 'mcp'],
    ['/mcp/', 'mcp'],
    ['/mcp/anything', 'mcp'],
    ['/oauth', 'oauth'],
    ['/oauth/token', 'oauth'],
    ['/oauth/register', 'oauth'],
    ['/oauth/agents', 'oauth'],
    ['/.well-known/oauth-authorization-server', 'discovery'],
    ['/.well-known/oauth-protected-resource', 'discovery'],
    ['/healthz', 'other'],
    ['/', 'other'],
    ['', 'other'],
  ] as Array<[string, McpErrorSurface]>)('%s → %s', (pathname, surface) => {
    expect(classifyErrorSurface(pathname)).toBe(surface);
  });

  /**
   * A PREFIX is not a family. `startsWith('/mcp')` would classify `/mcpfoo` as
   * the MCP surface and answer a JSON-RPC envelope to a caller that never spoke
   * JSON-RPC; the same slip on `/oauth` would hand an OAuth error object to an
   * unrelated route. The separator is the boundary, and the exact path is the
   * only other member.
   */
  it.each(['/mcpfoo', '/mcp-admin', '/oauthx', '/oauth-callback', '/.well-knownx'])(
    '%s is NOT its look-alike family — a prefix is not a path segment',
    (pathname) => {
      expect(classifyErrorSurface(pathname)).toBe('other');
    },
  );
});

describe('buildSafeErrorResponse — nothing from the error reaches the wire', () => {
  it.each(ALL_PATHS)('%s: no message, stack, header, raw body or filesystem path in the body', (pathname) => {
    const serialized = JSON.stringify(buildSafeErrorResponse(pathname, leakyError()).body);

    for (const [label, secret] of Object.entries(SECRETS)) {
      expect(serialized, `${pathname} leaked ${label}`).not.toContain(secret);
    }
    // The class, not only the four literals above: no absolute path shape and
    // no stack marker may survive, whatever the error carried.
    expect(serialized).not.toMatch(/\/(home|app|root|usr|var)\//);
    expect(serialized).not.toContain('    at ');
    expect(serialized).not.toContain('ENOENT');
    // Non-vacuity: the body is a real answer, not an empty object that would
    // pass every assertion above by carrying nothing at all.
    expect(serialized.length).toBeGreaterThan(10);
  });

  it('the same leak scan holds for a 4xx, where the caller DOES get to keep their status', () => {
    const serialized = JSON.stringify(buildSafeErrorResponse('/mcp', leakyError(400)).body);
    for (const secret of Object.values(SECRETS)) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('survives the shapes that are not Error objects at all', () => {
    for (const err of [null, undefined, 'boom', 42, { message: SECRETS.path }, []]) {
      const answer = buildSafeErrorResponse('/oauth/token', err);
      expect(answer.status).toBe(500);
      expect(JSON.stringify(answer.body)).not.toContain(SECRETS.path);
    }
  });
});

describe('buildSafeErrorResponse — the envelope follows the protocol the caller speaks', () => {
  it('an MCP path answers JSON-RPC, id null, with the fixed internal-error strings', () => {
    expect(buildSafeErrorResponse('/mcp', leakyError())).toEqual({
      surface: 'mcp',
      status: 500,
      body: {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32603, message: 'Internal server error' },
      },
    });
  });

  it('an MCP path answers the JSON-RPC INVALID REQUEST code when the request was at fault', () => {
    expect(buildSafeErrorResponse('/mcp', leakyError(400))).toEqual({
      surface: 'mcp',
      status: 400,
      body: {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' },
      },
    });
  });

  it.each(['/oauth/token', '/.well-known/oauth-authorization-server'])(
    '%s answers an OAuth error object, never a JSON-RPC envelope',
    (pathname) => {
      expect(buildSafeErrorResponse(pathname, leakyError()).body).toEqual({ error: 'server_error' });
      expect(buildSafeErrorResponse(pathname, leakyError(400)).body).toEqual({
        error: 'invalid_request',
      });
    },
  );

  it('an unclassified path answers the generic pair', () => {
    expect(buildSafeErrorResponse('/healthz', leakyError()).body).toEqual({ error: 'internal_error' });
    expect(buildSafeErrorResponse('/healthz', leakyError(404)).body).toEqual({
      error: 'invalid_request',
    });
  });
});

describe('buildSafeErrorResponse — the 4xx passthrough', () => {
  /**
   * THE BRANCH THIS DESCRIBE EXISTS FOR. `express.json()` throws a status-bearing
   * error for a malformed body (400) and for one over `mcpHttpBodyMaxKb` (413),
   * and that parser runs on EVERY path here. Collapsing those into 500 tells a
   * caller the server broke when their own request did — and, on the MCP
   * surface, replaces a retryable client error with one that reads as an
   * outage. The passthrough is what keeps the two apart.
   */
  it.each([400, 401, 403, 404, 405, 413, 415, 422, 429, 499])(
    'a %i keeps its own status on every surface',
    (status) => {
      for (const pathname of ALL_PATHS) {
        expect(buildSafeErrorResponse(pathname, leakyError(status)).status).toBe(status);
      }
    },
  );

  it('reads `statusCode` as well as `status` — body-parser sets both, other middleware sets one', () => {
    expect(buildSafeErrorResponse('/mcp', { status: 413 }).status).toBe(413);
    expect(buildSafeErrorResponse('/mcp', { statusCode: 413 }).status).toBe(413);
  });

  it.each([500, 502, 503, 399, 600, 0, -400, 4.5, NaN, Infinity, '400', true, null])(
    'a non-4xx status (%p) becomes 500 — only a genuine client error passes through',
    (status) => {
      expect(buildSafeErrorResponse('/mcp', { status }).status).toBe(500);
      expect(buildSafeErrorResponse('/mcp', { statusCode: status }).status).toBe(500);
    },
  );

  /**
   * The realistic pair, reproduced with the shape body-parser actually throws —
   * including `err.body`, the RAW caller-controlled bytes it attaches to a parse
   * failure. The status survives; the bytes do not.
   */
  it('a real body-parser 400 and 413 keep their status and leak neither message nor raw body', () => {
    const parseFailed = Object.assign(
      new SyntaxError(`Unexpected token } in JSON at position 17 while processing ${SECRETS.path}`),
      { status: 400, statusCode: 400, type: 'entity.parse.failed', body: SECRETS.rawBody },
    );
    const tooLarge = Object.assign(new Error('request entity too large'), {
      status: 413,
      statusCode: 413,
      type: 'entity.too.large',
      limit: 262144,
      length: 999999,
    });

    const parsed = buildSafeErrorResponse('/mcp', parseFailed);
    expect(parsed.status).toBe(400);
    expect(parsed.body).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid Request' },
    });
    expect(JSON.stringify(parsed.body)).not.toContain(SECRETS.rawBody);
    expect(JSON.stringify(parsed.body)).not.toContain('entity.parse.failed');

    expect(buildSafeErrorResponse('/mcp', tooLarge).status).toBe(413);
    expect(JSON.stringify(buildSafeErrorResponse('/mcp', tooLarge).body)).not.toContain('262144');
  });
});

// ---------------------------------------------------------------------------
// The wiring — a SOURCE pin: the handler sits after the companions it covers
// ---------------------------------------------------------------------------

describe('the safe error handler is wired after every companion route, before listen', () => {
  const source = readFileSync(join(__dirname, '..', 'startMcpServer.ts'), 'utf-8');

  it('registers after the companion loop and before listen', () => {
    const loop = source.indexOf('companionMounts = mountPackageCompanions(');
    const handler = source.indexOf('app.use((err: unknown');
    const listen = source.indexOf('server.listen(PORT');
    expect(loop).toBeGreaterThan(-1);
    expect(handler).toBeGreaterThan(loop);
    expect(listen).toBeGreaterThan(handler);
  });

  it("hands a companion's own path straight on — only MCP / OAuth / discovery / healthz answer here", () => {
    expect(source).toContain("if (surface === 'other' && req.path !== '/healthz') {\n      next(err);");
  });
});
