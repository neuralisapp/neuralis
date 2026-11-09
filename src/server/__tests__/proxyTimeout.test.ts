/**
 * Next's proxy timeout is an IDLE timeout on every request the app address
 * forwards to the companion server (`proxy.ts`): a forwarded MCP SSE stream
 * lives exactly as long as its keep-alive frames arrive inside it. The frame
 * interval is agent-core's `mcpSseKeepaliveMs`, so the timeout must dominate
 * that key's DECLARED MAX four times over — derive-and-verify, as
 * `upgradeWatchdog.test.ts` does. Host runtime code never reads the key; only
 * this test does. `0` is not "off" in Next 16 (`0 || 30000`), so it must be a
 * positive number.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import nextConfig from '../../../next.config';

const AGENT_CORE_MANIFEST = join(__dirname, '..', '..', '..', '..', 'packages', 'agent-core', 'package.json');
const KEY = 'mcpSseKeepaliveMs';

describe('experimental.proxyTimeout dominates the MCP SSE keep-alive', () => {
  it('is a positive number of at least 4 × the declared max of mcpSseKeepaliveMs', () => {
    const manifest = JSON.parse(readFileSync(AGENT_CORE_MANIFEST, 'utf-8')) as {
      neuralis?: { configSettings?: Array<{ key?: unknown; max?: unknown; default?: unknown }> };
    };
    const entry = manifest.neuralis?.configSettings?.find((s) => s.key === KEY);
    if (!entry || typeof entry.max !== 'number') {
      throw new Error(`derive-and-verify FAILED: packages/agent-core/package.json declares no numeric max for "${KEY}" — re-derive experimental.proxyTimeout, never delete this guard.`);
    }
    const timeout = nextConfig.experimental?.proxyTimeout;
    expect(typeof timeout).toBe('number');
    expect(timeout as number).toBeGreaterThan(0);
    expect(timeout as number).toBeGreaterThanOrEqual(4 * entry.max);
  });
});
