/**
 * The public `:3101` base URL — the OAuth issuer, and the prefix of the MCP
 * resource (`<base>/mcp`) every MCP grant is bound to. ONE derivation, read by
 * the server that listens there (`startMcpServer.ts`), by the package
 * catch-all's `WWW-Authenticate` challenge (it names the issuer's metadata
 * document) and by the offline `oauth-resource-v1` upgrade (it stamps the MCP
 * resource on older grants) — three copies of this line could disagree, and a
 * disagreement would make every MCP grant unmatchable.
 */

/** The port the MCP HTTP service listens on (`MCP_HTTP_PORT`, default 3101). */
export function mcpHttpPort(env: Readonly<Record<string, string | undefined>> = process.env): number {
  return Number(env.MCP_HTTP_PORT || 3101);
}

/** `MCP_BASE_URL`, else the loopback default on the listening port. */
export function resolveMcpBaseUrl(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.MCP_BASE_URL?.trim() || `http://localhost:${mcpHttpPort(env)}`;
}
