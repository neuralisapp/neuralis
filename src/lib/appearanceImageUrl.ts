/**
 * The path of a stored user or project appearance picture. Content-addressed:
 * the hash IS the cache key, so the route answers it `immutable` and a new
 * picture is a new URL. The route (`app/api/appearance/[kind]/[id]/[hash]`)
 * gates it with the record's own read gate.
 *
 * Import-free on purpose: the workspace avatar and the `:3101` consent page's
 * server port both build the URL from this one place.
 */
export function appearanceImageUrl(kind: 'user' | 'project', ownerId: string, hash: string): string {
  return `/api/appearance/${kind}/${encodeURIComponent(ownerId)}/${encodeURIComponent(hash)}`;
}
