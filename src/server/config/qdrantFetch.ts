/**
 * Authenticated Qdrant REST access for the HOST-side maintenance scripts.
 *
 * The canonical explanation of WHY `QDRANT_API_KEY` is boot-critical infra env
 * rather than a credential or a platform-config key lives in
 * `packages/admin/src/qdrantFetch.ts` — read it there, it is not restated here.
 *
 * This is a deliberate SECOND copy of six lines, not a missed reuse:
 *
 *  - `pnpm reset:vector` is the documented recovery for a dimension-lock
 *    mismatch, i.e. it runs precisely when the platform is boot-broken. Making
 *    the rescue line depend on `@neuralis/admin`'s build output would make it
 *    depend on the system it exists to repair.
 *  - `packages/admin/src/qdrantFetch.ts` is not in that package's `exports`
 *    map, so importing it would reach INSIDE the package and invert the
 *    host -> package dependency direction.
 *  - The single-copy rule in CLAUDE.md names the ACCESS PREDICATES
 *    (`SessionContext`, `hasFeature` / `meetsRequires` / `rolePriority` /
 *    `canAssignRole`). This is a transport header helper; it decides nothing.
 *
 * THE ONE INVARIANT THAT MAKES A COPY SAFE: never send this header to a
 * non-Qdrant host. `neuralis/scripts/setup/detect.mts` shares ONE `httpGet`
 * (`node:http`, no headers at all) between the Qdrant probe and the Ollama
 * probe, so an unconditional header there would hand the Qdrant key to a
 * different service — which is why that helper stays header-free. It only ever
 * calls `/healthz` and `/`, which Qdrant leaves unauthenticated on the version
 * this stack pins, so it needs no key.
 *
 * The value is read LIVE on every call; a module-level capture would freeze it
 * at import time.
 */

/**
 * The Qdrant auth header, or an empty object when no key is configured.
 *
 * Qdrant's REST auth header is **`api-key`** (lowercase, hyphenated) — NOT
 * `Authorization`. It is omitted ENTIRELY when the env var is unset or blank:
 * the default self-hosted deployment has no key at all, and an empty `api-key`
 * header can be rejected outright by some Qdrant builds.
 */
export function qdrantAuthHeaders(): Record<string, string> {
  const key = process.env.QDRANT_API_KEY?.trim();
  return key ? { 'api-key': key } : {};
}

/**
 * `fetch()` against a Qdrant REST endpoint, carrying the `api-key` header when
 * one is configured. Use this for EVERY Qdrant call reachable from host code —
 * including the destructive `DELETE /collections/<name>` in `reset:vector`.
 */
export function qdrantFetch(url: string, init?: RequestInit): Promise<Response> {
  const auth = qdrantAuthHeaders();
  const apiKey = auth['api-key'];
  if (!apiKey) return fetch(url, init);
  const headers = new Headers(init?.headers);
  headers.set('api-key', apiKey);
  return fetch(url, { ...init, headers });
}
