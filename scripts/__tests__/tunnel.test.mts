/**
 * `neuralis tunnel` — every Cloudflare touch is a fake: the `cloudflared` argv
 * the verb runs, the API calls `--access` makes. Pinned: the three origins land
 * in the operator `.env` (never a platform setting) and `off` takes them back;
 * the connector's config routes each hostname to loopback; a refusal writes
 * nothing; the API token is read once and never written anywhere.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';

import { NATIVE_MARKER } from '@neuralis/package-system/paths';
import type { CliContext } from '../cli/registry.mts';
import { parseEnvContent } from '../setup/envFile.mts';
import { accessRule, run, setupTunnelArgs, tunnelConfigYaml, tunnelName, type RunResult, type TunnelDeps } from '../tunnel.mts';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const ID = '6ff42ae2-765d-4adf-8112-31c55c1551ef';

function world(): { ctx: CliContext; home: string; env: () => Record<string, string>; out: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'nrs-tunnel-'));
  roots.push(root);
  const packageDir = join(root, 'resources', 'host');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'neuralis', bin: { neuralis: 'bin/neuralis.mjs' } }));
  writeFileSync(join(packageDir, NATIVE_MARKER), '');
  const home = join(root, 'home');
  mkdirSync(join(home, 'app', 'config'), { recursive: true });
  writeFileSync(join(home, 'app', 'config', '.env'), [
    'NEXTAUTH_URL=http://127.0.0.1:3104', 'APP_URL=http://127.0.0.1:3104', 'MCP_BASE_URL=http://127.0.0.1:3105',
    'NEURALIS_APP_PORT=3104', 'MCP_HTTP_PORT=3105', 'NEURALIS_MCP_SANDBOX_PORT=3106', 'NEURALIS_BIND_HOST=127.0.0.1', 'QDRANT_API_KEY=keep-me', '',
  ].join('\n'));
  const out: string[] = [];
  const stdin = new PassThrough();
  stdin.end('cf-token-secret\n');
  const ctx = {
    packageDir, cwd: root, get installDir(): string { throw new Error('never read on the desktop host'); },
    stdout: (t: string) => { out.push(t); }, stderr: (t: string) => { out.push(t); }, env: { NEURALIS_HOME: home }, stdin,
  } as unknown as CliContext;
  return { ctx, home, out, env: () => parseEnvContent(readFileSync(join(home, 'app', 'config', '.env'), 'utf-8')) };
}

function fakes(home: string): { deps: TunnelDeps; calls: string[][]; api: Array<[string, string, unknown]> } {
  const calls: string[][] = [];
  const api: Array<[string, string, unknown]> = [];
  const dir = join(home, 'app', 'cloudflared', '.cloudflared');
  const deps: TunnelDeps = {
    prepare: async () => {},
    runner: () => async (args): Promise<RunResult> => {
      calls.push([...args]);
      if (args.includes('login')) writeFileSync(join(dir, 'cert.pem'), 'CERT');
      if (args.includes('list')) return { code: 0, stdout: '[]', stderr: '' };
      if (args.includes('create')) { writeFileSync(join(dir, `${ID}.json`), '{}'); return { code: 0, stdout: JSON.stringify({ id: ID }), stderr: '' }; }
      return { code: 0, stdout: '', stderr: '' };
    },
    api: async (_token, method, path, body) => {
      api.push([method, path, body]);
      if (path.startsWith('/zones')) return [{ account: { id: 'acc1' } }];
      if (path.endsWith('/access/apps') && method === 'GET') return [];
      return { id: `pol${api.length}` };
    },
    readSecret: async () => 'cf-token-secret',
    regenerateCompose: async () => { throw new Error('a desktop host has no compose file'); },
  };
  return { deps, calls, api };
}

describe('tunnel on / off on the desktop app\'s host', () => {
  it('on: signs in once, creates the tunnel, routes three hostnames, writes config.yml and the three origins into .env — nothing else', async () => {
    const w = world();
    const f = fakes(w.home);
    expect(await run(['on', 'Example.COM'], w.ctx, f.deps)).toBe(0);
    expect(f.calls.map((c) => c.find((a) => ['login', 'list', 'create', 'route'].includes(a)))).toEqual(['login', 'list', 'create', 'route', 'route', 'route']);
    expect(f.calls.filter((c) => c.includes('route')).map((c) => c.at(-1))).toEqual(['app.example.com', 'mcp.example.com', 'sandbox.example.com']);
    expect(f.calls.find((c) => c.includes('create'))).toContain(tunnelName(w.home));
    const env = w.env();
    expect(env).toMatchObject({
      NEXTAUTH_URL: 'https://app.example.com', APP_URL: 'https://app.example.com', MCP_BASE_URL: 'https://mcp.example.com',
      NEURALIS_MCP_SANDBOX_ORIGIN: 'https://sandbox.example.com', NEURALIS_TUNNEL: 'cloudflare', QDRANT_API_KEY: 'keep-me', NEURALIS_BIND_HOST: '127.0.0.1',
    });
    const yaml = readFileSync(join(w.home, 'app', 'cloudflared', 'config.yml'), 'utf-8');
    expect(yaml).toContain(`tunnel: ${ID}`);
    expect(yaml).toContain('service: http://127.0.0.1:3104');
    expect(yaml).toContain('service: http://127.0.0.1:3105');
    expect(yaml).toContain('service: http_status:404');
    expect(w.out.join('')).toContain('sign in again');
    expect(f.api).toEqual([]);
    // A second `on` reuses the sign-in (no login) — and `off` puts this machine's origins back.
    f.calls.length = 0;
    expect(await run(['off'], w.ctx, f.deps)).toBe(0);
    const off = w.env();
    expect(off).toMatchObject({ APP_URL: 'http://127.0.0.1:3104', MCP_BASE_URL: 'http://127.0.0.1:3105', QDRANT_API_KEY: 'keep-me' });
    expect(off).not.toHaveProperty('NEURALIS_TUNNEL');
    expect(off).not.toHaveProperty('NEURALIS_MCP_SANDBOX_ORIGIN');
    // This machine's own origins need no record: `on` wrote none.
    expect(env).not.toHaveProperty('NEURALIS_TUNNEL_RESTORE');
    expect(f.calls).toEqual([]);
  });

  it('a reverse-proxy origin set before `on` is recorded, survives a second `on`, and `off` writes it back', async () => {
    const w = world();
    const f = fakes(w.home);
    const path = join(w.home, 'app', 'config', '.env');
    writeFileSync(path, readFileSync(path, 'utf-8')
      .replace('NEXTAUTH_URL=http://127.0.0.1:3104', 'NEXTAUTH_URL=https://neuralis.corp')
      .replace('APP_URL=http://127.0.0.1:3104', 'APP_URL=https://neuralis.corp')
      .replace('MCP_BASE_URL=http://127.0.0.1:3105', 'MCP_BASE_URL=https://mcp.neuralis.corp\nNEURALIS_MCP_SANDBOX_ORIGIN=https://apps.neuralis.corp'));
    expect(await run(['on', 'example.com'], w.ctx, f.deps)).toBe(0);
    const record = 'app=https://neuralis.corp mcp=https://mcp.neuralis.corp sandbox=https://apps.neuralis.corp';
    expect(w.env()).toMatchObject({ APP_URL: 'https://app.example.com', NEURALIS_TUNNEL: 'cloudflare', NEURALIS_TUNNEL_RESTORE: record });
    // `on` again (another domain) keeps what the FIRST `on` replaced, never the tunnel's own origins.
    expect(await run(['on', 'example.org'], w.ctx, f.deps)).toBe(0);
    expect(w.env()).toMatchObject({ APP_URL: 'https://app.example.org', NEURALIS_TUNNEL_RESTORE: record });
    expect(await run(['off'], w.ctx, f.deps)).toBe(0);
    const off = w.env();
    expect(off).toMatchObject({ NEXTAUTH_URL: 'https://neuralis.corp', APP_URL: 'https://neuralis.corp', MCP_BASE_URL: 'https://mcp.neuralis.corp', NEURALIS_MCP_SANDBOX_ORIGIN: 'https://apps.neuralis.corp', QDRANT_API_KEY: 'keep-me' });
    expect(off).not.toHaveProperty('NEURALIS_TUNNEL');
    expect(off).not.toHaveProperty('NEURALIS_TUNNEL_RESTORE');
    expect(w.out.join('')).toContain('The origins the tunnel replaced are back: https://neuralis.corp');
  });

  it('a record that names no origins is refused by `off`, which then writes nothing', async () => {
    const w = world();
    const path = join(w.home, 'app', 'config', '.env');
    writeFileSync(path, ['NEURALIS_TUNNEL=cloudflare', 'APP_URL=https://app.example.com', 'MCP_BASE_URL=https://mcp.example.com', 'NEURALIS_TUNNEL_RESTORE=app=ftp://x mcp=https://m', ''].join('\n'));
    const before = readFileSync(path, 'utf-8');
    await expect(run(['off'], w.ctx, fakes(w.home).deps)).rejects.toThrow(/NEURALIS_TUNNEL_RESTORE/);
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  it('--access: Access on app.DOMAIN for browsers with /api bypassed; the token is used and written nowhere', async () => {
    const w = world();
    const f = fakes(w.home);
    expect(await run(['on', 'example.com', '--access', '@company.com'], w.ctx, f.deps)).toBe(0);
    const posts = f.api.filter(([m]) => m === 'POST');
    expect(posts.map(([, , b]) => (b as { domain?: string; decision?: string }).domain ?? (b as { decision?: string }).decision)).toEqual(['allow', 'app.example.com', 'bypass', 'app.example.com/api']);
    expect(posts[0]![2]).toMatchObject({ include: [{ email_domain: { domain: 'company.com' } }] });
    // mcp. and sandbox. are never behind Access: MCP clients cannot pass an Access login.
    expect(JSON.stringify(f.api)).not.toContain('mcp.example.com');
    const everything = [readFileSync(join(w.home, 'app', 'config', '.env'), 'utf-8'), ...readdirSync(join(w.home, 'app', 'cloudflared')).filter((n) => n.endsWith('.yml')).map((n) => readFileSync(join(w.home, 'app', 'cloudflared', n), 'utf-8'))].join('\n');
    expect(everything).not.toContain('cf-token-secret');
  });

  it('refusals write nothing: a URL instead of a domain, a quick tunnel shape, a bad --access, an extra word', async () => {
    const w = world();
    const f = fakes(w.home);
    const before = readFileSync(join(w.home, 'app', 'config', '.env'), 'utf-8');
    for (const argv of [['on', 'https://example.com'], ['on', 'localhost'], ['on', 'example.com', '--access', 'nobody'], ['on'], ['off', 'x'], ['sideways']]) {
      await expect(run(argv, w.ctx, f.deps)).rejects.toThrow();
    }
    expect(readFileSync(join(w.home, 'app', 'config', '.env'), 'utf-8')).toBe(before);
    expect(f.calls).toEqual([]);
    expect(existsSync(join(w.home, 'app', 'cloudflared', 'config.yml'))).toBe(false);
  });

  it('status names what is on; the access rule reads an email or @domain only', async () => {
    const w = world();
    expect(await run([], w.ctx, fakes(w.home).deps)).toBe(0);
    expect(w.out.join('')).toContain('off — reached on http://127.0.0.1:3104');
    expect(accessRule('a@b.co')).toEqual({ email: { email: 'a@b.co' } });
    expect(accessRule('@b.co')).toEqual({ email_domain: { domain: 'b.co' } });
    expect(accessRule('b.co')).toBeNull();
    expect(tunnelConfigYaml({ tunnelId: ID, credentialsFile: '/c.json', domain: 'x.io', ports: { app: 1, mcp: 2, sandbox: 3 }, appHost: '127.0.0.1' })).toContain('hostname: sandbox.x.io\n    service: http://127.0.0.1:1');
  });
});

describe('tunnel status — MCP never under Access', () => {
  function tunnelOnWorld(mcp: string): ReturnType<typeof world> {
    const w = world();
    writeFileSync(join(w.home, 'app', 'config', '.env'), ['NEURALIS_TUNNEL=cloudflare', 'APP_URL=https://app.example.com', `MCP_BASE_URL=${mcp}`, ''].join('\n'));
    mkdirSync(join(w.home, 'app', 'cloudflared'), { recursive: true });
    writeFileSync(join(w.home, 'app', 'cloudflared', 'config.yml'), 'tunnel: x\n');
    return w;
  }

  it('warns when the MCP address was set to the app address while the tunnel serves it; CONTROL: the tunnel\'s own mcp. name says nothing', async () => {
    const same = tunnelOnWorld('https://app.example.com');
    expect(await run([], same.ctx, fakes(same.home).deps)).toBe(0);
    expect(same.out.join('')).toMatch(/MCP_BASE_URL is the app address/);
    const own = tunnelOnWorld('https://mcp.example.com');
    expect(await run([], own.ctx, fakes(own.home).deps)).toBe(0);
    expect(own.out.join('')).toContain('on — https://app.example.com');
    expect(own.out.join('')).not.toMatch(/MCP_BASE_URL is the app address/);
  });
});

describe('setup --tunnel DOMAIN: the same `tunnel on`, validated before setup writes anything', () => {
  it('the flag becomes the `tunnel on` argv (with --access passed through); a bad domain or access is refused up front', () => {
    expect(setupTunnelArgs(['--native', '--yes', '--tunnel', 'Example.com'])).toEqual(['on', 'example.com']);
    expect(setupTunnelArgs(['--tunnel', 'example.com', '--access', '@company.com'])).toEqual(['on', 'example.com', '--access', '@company.com']);
    for (const argv of [['--tunnel'], ['--tunnel', 'https://example.com'], ['--tunnel', 'localhost'], ['--tunnel', 'example.com', '--access', 'nobody'], ['--access', 'a@b.co']]) {
      expect(() => setupTunnelArgs(argv)).toThrow();
    }
  });
  it('paired control: setup without the flag asks for no tunnel at all', () => {
    expect(setupTunnelArgs(['--native', '--yes', '--owner-email', 'o@e.co'])).toBeNull();
    expect(setupTunnelArgs([])).toBeNull();
  });
  it('the argv runs the ONE `tunnel on` path: same origins in .env, nothing else', async () => {
    const w = world();
    const f = fakes(w.home);
    expect(await run(setupTunnelArgs(['--tunnel', 'example.com'])!, w.ctx, f.deps)).toBe(0);
    expect(w.env()).toMatchObject({ APP_URL: 'https://app.example.com', NEURALIS_TUNNEL: 'cloudflare' });
  });
});
