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

/**
 * The companion server's OWN browser address — where a companion document
 * that must never run on the app origin (the desktop stream) is opened:
 * `NEURALIS_COMPANION_ORIGIN` when it is a valid http(s) URL, else
 * `MCP_BASE_URL`'s origin. Never the app origin: when the chosen value equals
 * `appOrigin` (one hostname, nothing declared) the answer is `null` and the
 * companion that needs it says so. A malformed declared value is ignored.
 */
export function resolveCompanionOrigin(env: Readonly<Record<string, string | undefined>>, appOrigin: string): string | null {
  const originOf = (value: string | undefined): string | null => {
    try {
      const url = new URL(value?.trim() ?? '');
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
    } catch {
      return null;
    }
  };
  const chosen = originOf(env.NEURALIS_COMPANION_ORIGIN) ?? originOf(resolveMcpBaseUrl(env));
  return chosen !== null && chosen !== originOf(appOrigin) ? chosen : null;
}

/**
 * Where THIS process reaches its own companion server: the bound address, with
 * a wildcard bind (`0.0.0.0` / `::`) dialled on loopback. The app-origin
 * forward's target — never a public address.
 */
export function companionLoopbackOrigin(bindAddress: string, port: number): string {
  if (bindAddress === '0.0.0.0') return `http://127.0.0.1:${port}`;
  if (bindAddress === '::') return `http://[::1]:${port}`;
  return bindAddress.includes(':') ? `http://[${bindAddress}]:${port}` : `http://${bindAddress}:${port}`;
}
