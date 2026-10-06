/**
 * Resolve WHICH project a host `/api/admin/**` or `/api/oauth/**` request acts
 * on. Transport only — it decides nothing about access; the caller then hands the
 * result to `requireAdmin` / `requireProjectFeature`, which are the gates.
 *
 * **The header is the transport.** Every admin-client call goes through
 * `packages/admin/app/admin/api/projects.ts` → `buildHeaders` → the
 * `X-Project-Id` HEADER; `brain-core`'s feature-catalog fetch sends the same.
 * Routes that read a query param or a body field instead were never receiving
 * one from the live UI, which is precisely how `requireAdmin()`'s deleted
 * "first project" fallback stayed invisible for so long (O-2).
 *
 * A body/query `projectId` is accepted only as an AGREEING override, so a route
 * that legitimately names its own target (`POST /api/admin/users` invites INTO a
 * project) keeps working while a mismatch can never be used to authorize against
 * one project and write to another:
 *
 * | header | supplied | result |
 * |---|---|---|
 * | absent | absent  | 400 `Missing projectId` |
 * | set    | absent  | the header |
 * | absent | set     | the supplied value |
 * | set    | equal   | that value |
 * | set    | different | **403** — never silently prefer one |
 */

export const PROJECT_ID_HEADER = 'x-project-id';

export type RequestProjectResolution =
  | { ok: true; projectId: string }
  | { ok: false; status: 400 | 403; error: string };

/**
 * @param request  the incoming request (read for `X-Project-Id`)
 * @param supplied a `projectId` the route parsed from its body or query, if any
 */
export function resolveRequestProjectId(
  request: Request,
  supplied?: string | null,
): RequestProjectResolution {
  const header = request.headers.get(PROJECT_ID_HEADER)?.trim() || null;
  const explicit = typeof supplied === 'string' ? supplied.trim() || null : null;

  if (header && explicit && header !== explicit) {
    return {
      ok: false,
      status: 403,
      error: 'Forbidden: projectId does not match the X-Project-Id header',
    };
  }
  const projectId = explicit ?? header;
  if (!projectId) {
    return {
      ok: false,
      status: 400,
      error: 'Missing projectId: send the X-Project-Id header',
    };
  }
  return { ok: true, projectId };
}
