/**
 * The companion loop hands every package the host's trusted-proxy predicate
 * (`isTrustedProxyAddress`) — the device link's loopback observation reads it,
 * so a call site that builds the ports cannot forget it.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../auth/requestClient', () => ({
  isTrustedProxyAddress: (address: string) => address === '127.0.0.1',
}));

const { collectAppOriginPaths, mountPackageCompanions } = await import('../mountPackageCompanions');
const { companionLoopbackOrigin, resolveCompanionOrigin } = await import('../mcpBaseUrl');

describe('mountPackageCompanions — the trusted-proxy port', () => {
  it('a WS companion receives `isTrustedProxy`, answering through the host predicate', () => {
    const seen: Array<{ isTrustedProxy?: (address: string) => boolean }> = [];
    const api = { mountCompanionWs: (_server: unknown, ports: { isTrustedProxy?: (a: string) => boolean }) => { seen.push(ports); return { label: 'x', close: () => {} }; } };
    mountPackageCompanions({
      loader: { listLoaded: () => [{ id: '@neuralis/agent-core' }], getPackageApi: () => api } as never,
      httpServer: {} as never,
      app: {},
      ports: { bodyParsers: [] } as never,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.isTrustedProxy?.('127.0.0.1')).toBe(true);
    expect(seen[0]!.isTrustedProxy?.('127.0.0.9')).toBe(false);
  });
});

describe('the app-origin path set', () => {
  const handle = (label: string, appOriginPaths?: string[], issuerPaths?: string[]) => ({
    label, close: () => {}, ...(appOriginPaths ? { appOriginPaths } : {}), ...(issuerPaths ? { issuerPaths } : {}),
  });
  // The default shape: the app and the MCP server on two ports of one host.
  const SPLIT = { mcpBaseUrl: 'http://localhost:3101', appOrigin: 'http://localhost:3100' };

  it('collects every mounted handle\'s declared paths, once each', () => {
    const paths = collectAppOriginPaths([
      handle('mcp', ['/oauth/authorize', '/oauth/agents']),
      handle('terminal', ['/ws/terminal/', '/ws/host-terminal/', '/oauth/agents']),
      handle('machine'),
    ], SPLIT);
    expect(paths.sort()).toEqual(['/oauth/agents', '/oauth/authorize', '/ws/host-terminal/', '/ws/terminal/']);
  });

  it('refuses the host\'s own trees and malformed paths, keeping the rest', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const paths = collectAppOriginPaths([handle('pkg', ['/api/packages/x', '/_next/static', '/', 'oauth/x', '/a/../b', '/a//b', '/a?b', '/a/%2e', '/ok/'])], SPLIT);
    expect(paths).toEqual(['/ok/']);
    expect(warn).toHaveBeenCalledTimes(8);
  });

  const BEARER = ['/mcp', '/oauth/token', '/.well-known/oauth-protected-resource/'];

  it('P3 — while the MCP origin differs from the app origin, no declared issuer path is forwarded', () => {
    for (const origins of [SPLIT, { mcpBaseUrl: 'https://mcp.example.com', appOrigin: 'https://app.example.com' }, { mcpBaseUrl: 'http://localhost:3100', appOrigin: 'https://localhost:3100' }]) {
      const paths = collectAppOriginPaths([handle('mcp', ['/oauth/authorize'], BEARER), handle('devices', undefined, ['/ws/device-link'])], origins);
      expect(paths, origins.mcpBaseUrl).toEqual(['/oauth/authorize']);
    }
  });

  it('one address (`MCP_BASE_URL` origin = `APP_URL` origin): the declared issuer paths join the forward', () => {
    const paths = collectAppOriginPaths(
      [handle('mcp', ['/oauth/authorize'], BEARER), handle('devices', undefined, ['/ws/device-link'])],
      { mcpBaseUrl: 'https://neuralis.example.com/', appOrigin: 'https://neuralis.example.com' },
    );
    expect(paths.sort()).toEqual(['/.well-known/oauth-protected-resource/', '/mcp', '/oauth/authorize', '/oauth/token', '/ws/device-link']);
  });

  it('an issuer path passes the same kernel rule; an unparseable origin forwards none of them', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    warn.mockClear();
    const same = { mcpBaseUrl: 'http://h:1', appOrigin: 'http://h:1' };
    expect(collectAppOriginPaths([handle('pkg', [], ['/api/x', '/mcp'])], same)).toEqual(['/mcp']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(collectAppOriginPaths([handle('pkg', [], ['/mcp'])], { mcpBaseUrl: 'not a url', appOrigin: 'not a url' })).toEqual([]);
    warn.mockRestore();
  });

  it('dials its own companion server on loopback for a wildcard bind, the bound address otherwise', () => {
    expect(companionLoopbackOrigin('0.0.0.0', 3101)).toBe('http://127.0.0.1:3101');
    expect(companionLoopbackOrigin('::', 3201)).toBe('http://[::1]:3201');
    expect(companionLoopbackOrigin('127.0.0.1', 3101)).toBe('http://127.0.0.1:3101');
    expect(companionLoopbackOrigin('fd00::5', 3101)).toBe('http://[fd00::5]:3101');
  });
});

describe('resolveCompanionOrigin — the companion server\'s own browser address', () => {
  const APP = 'http://localhost:3100';
  it('a declared NEURALIS_COMPANION_ORIGIN wins (its origin only)', () => {
    expect(resolveCompanionOrigin({ NEURALIS_COMPANION_ORIGIN: 'http://localhost:3201/x', MCP_BASE_URL: APP }, APP)).toBe('http://localhost:3201');
  });
  it('else MCP_BASE_URL\'s origin — the two-address shapes unchanged (port split, the tunnel\'s own name)', () => {
    expect(resolveCompanionOrigin({ MCP_BASE_URL: 'http://localhost:3101' }, APP)).toBe('http://localhost:3101');
    expect(resolveCompanionOrigin({ MCP_BASE_URL: 'https://mcp.example.com/' }, 'https://app.example.com')).toBe('https://mcp.example.com');
    expect(resolveCompanionOrigin({}, APP)).toBe('http://localhost:3101');
  });
  it('never the app origin: one hostname with nothing declared, or a declared app origin ⇒ null', () => {
    expect(resolveCompanionOrigin({ MCP_BASE_URL: 'http://localhost:3100/' }, APP)).toBeNull();
    expect(resolveCompanionOrigin({ MCP_BASE_URL: 'http://localhost:3100', NEURALIS_COMPANION_ORIGIN: 'http://localhost:3100' }, APP)).toBeNull();
  });
  it('a malformed declared value is ignored and falls to MCP_BASE_URL', () => {
    expect(resolveCompanionOrigin({ NEURALIS_COMPANION_ORIGIN: 'not a url', MCP_BASE_URL: 'http://localhost:3101' }, APP)).toBe('http://localhost:3101');
    expect(resolveCompanionOrigin({ NEURALIS_COMPANION_ORIGIN: 'ftp://x', MCP_BASE_URL: 'http://localhost:3101' }, APP)).toBe('http://localhost:3101');
  });
});
