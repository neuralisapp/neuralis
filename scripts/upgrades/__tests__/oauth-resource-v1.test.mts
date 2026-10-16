/**
 * `oauth-resource-v1`: every older refresh grant is bound to the MCP resource
 * the server computes; no row is dropped, a non-grant row is kept verbatim, a
 * non-store file blocks, the dry run writes nothing, a second apply is a no-op.
 * The runtime side (a stamped grant refreshes for a client that sends no
 * `resource`; an unstamped one never matches) is agent-core's
 * `mcp/oauth/__tests__/refreshTokenRotation.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import upgrade, { census, mcpResource } from '../oauth-resource-v1.mts';

let home: string;
let ctx: { home: string; appRoot: string; projectsRoot: string; log: (line: string) => void };
const tokensPath = () => join(ctx.appRoot, 'config', 'oauth', 'tokens.json');
const priorBase = process.env.MCP_BASE_URL;

const grant = (id: string, token: string, extra: Record<string, unknown> = {}) => ({
  id, tokenHash: createHash('sha256').update(token).digest('hex'), userId: 'u1', projectId: 'p1', agentId: 'a1',
  clientId: 'https://claude.ai/oauth/claude-code-client-metadata', scope: 'tools:read', sessionEpoch: 0, requestsCount: 3,
  status: 'active', expiresAt: new Date(Date.now() + 86_400_000).toISOString(), createdAt: '2026-01-01T00:00:00.000Z', ...extra,
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'nrs-oauth-resource-'));
  ctx = { home, appRoot: join(home, 'app'), projectsRoot: join(home, 'projects'), log: () => {} };
  mkdirSync(join(ctx.appRoot, 'config', 'oauth'), { recursive: true });
  process.env.MCP_BASE_URL = 'https://mcp.example.com';
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (priorBase === undefined) delete process.env.MCP_BASE_URL;
  else process.env.MCP_BASE_URL = priorBase;
});

describe('oauth-resource-v1', () => {
  it('the stamped resource is the server\'s own `${MCP_BASE_URL}/mcp`, the loopback default without one', () => {
    expect(mcpResource({ MCP_BASE_URL: 'https://mcp.example.com' })).toBe('https://mcp.example.com/mcp');
    expect(mcpResource({ MCP_HTTP_PORT: '4101' })).toBe('http://localhost:4101/mcp');
    expect(mcpResource({})).toBe('http://localhost:3101/mcp');
  });

  it('no store ⇒ nothing to do (a fresh or never-used install)', async () => {
    await expect(upgrade.dryRun(ctx)).resolves.toEqual({ files: [], summary: ['oauth grants: none stored'] });
    await upgrade.apply(ctx);
  });

  it('dry run names the change and writes nothing; apply stamps every grant, keeps every other byte, drops no row', async () => {
    const original = { tokens: [grant('g1', 't1'), grant('g2', 't2', { status: 'revoked', revokedAt: '2026-02-01T00:00:00.000Z' }), { id: 'junk' }] };
    writeFileSync(tokensPath(), JSON.stringify(original));
    const before = readFileSync(tokensPath(), 'utf8');
    const plan = await upgrade.dryRun(ctx);
    expect(plan.files).toEqual(['app/config/oauth/tokens.json']);
    expect(plan.summary[0]).toBe('oauth grants: 2 bound to https://mcp.example.com/mcp, 0 already bound');
    expect(plan.summary[1]).toMatch(/1 record\(s\) are not usable grants — kept unchanged/);
    expect(readFileSync(tokensPath(), 'utf8')).toBe(before);

    await upgrade.apply(ctx);
    const after = JSON.parse(readFileSync(tokensPath(), 'utf8')) as { tokens: Array<Record<string, unknown>> };
    expect(after.tokens).toHaveLength(3);
    expect(after.tokens[0]).toEqual({ ...original.tokens[0], resource: 'https://mcp.example.com/mcp' });
    expect(after.tokens[1]).toEqual({ ...original.tokens[1], resource: 'https://mcp.example.com/mcp' });
    expect(after.tokens[2]).toEqual({ id: 'junk' });
    // idempotent: the second run finds nothing older
    expect((await census(ctx)).next).toBeNull();
    const again = readFileSync(tokensPath(), 'utf8');
    await upgrade.apply(ctx);
    expect(readFileSync(tokensPath(), 'utf8')).toBe(again);
  });

  it('a file that is not a token store BLOCKS (never rewritten)', async () => {
    writeFileSync(tokensPath(), '{"tokens": 3}');
    const plan = await upgrade.dryRun(ctx);
    expect(plan.blockers?.lines[0]).toMatch(/not a token store/);
    await expect(upgrade.apply(ctx)).rejects.toThrow(/not a token store/);
    expect(readFileSync(tokensPath(), 'utf8')).toBe('{"tokens": 3}');
  });

  it('the stamped value is exactly the server\'s MCP resource — the one an omitted `resource` selects', async () => {
    writeFileSync(tokensPath(), JSON.stringify({ tokens: [grant('g1', 't1')] }));
    await upgrade.apply(ctx);
    const after = JSON.parse(readFileSync(tokensPath(), 'utf8')) as { tokens: Array<{ resource: string }> };
    // `buildOAuthConfig` resourceServer = `${issuer}/mcp`, issuer = MCP_BASE_URL (startMcpServer).
    expect(after.tokens[0]!.resource).toBe(`${process.env.MCP_BASE_URL}/mcp`);
  });

});
