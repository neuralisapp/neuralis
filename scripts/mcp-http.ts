/**
 * Community MCP HTTP server — standalone runner (alternative to in-process).
 *
 * Provides Streamable HTTP MCP endpoint for external clients
 * (Cursor, Claude Desktop, ChatGPT) serving ALL package tools.
 *
 * Auth: OAuth 2.1 (if keys exist) or API key fallback.
 */
import { startMcpServer } from '../src/server/mcp/startMcpServer';

startMcpServer().catch((err) => {
  console.error('[mcp-http] Failed to start:', err);
  process.exit(1);
});
