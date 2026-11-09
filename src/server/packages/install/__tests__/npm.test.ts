/**
 * The npm child's environment and flags, the private-scope reader's parity with
 * the image build's, and the peer links' repair of an npm-made copy.
 */

import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePrivateScopeRecord } from '../../../../../scripts/build/build-workspace.mjs';
import { npmEnv, npmFlags, parsePrivateScopes } from '../npm';
import { linkSharedPeers, sharedPeers, unlinkSharedPeers } from '../peerLinks';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('the npm child', () => {
  it('gets an AUTHORED environment: PATH (this Node first) and the proxy/CA settings — never a host secret', () => {
    const env = npmEnv({
      PATH: '/home/me/bin', HOME: '/home/me', NEXTAUTH_SECRET: 's', NPM_TOKEN: 't', NODE_AUTH_TOKEN: 'n', QDRANT_API_KEY: 'q',
      npm_config__authToken: 'x', NEURALIS_HOME: '/home/me/.neuralis', HTTPS_PROXY: 'http://proxy:3128', NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
    }, '/tmp/sandbox', 'linux', '/opt/res/node/bin/node');
    expect(env).toEqual({
      PATH: '/opt/res/node/bin:/usr/bin:/bin', HTTPS_PROXY: 'http://proxy:3128', NODE_EXTRA_CA_CERTS: '/etc/ca.pem', HOME: '/tmp/sandbox', npm_config_update_notifier: 'false',
    });
  });

  it('runs no package script, audits nothing, installs no peer, honours the release-age floor and reads no .npmrc of this machine', () => {
    const flags = npmFlags('https://registry.npmjs.org/', '/tmp/sb');
    for (const flag of ['--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps', '--min-release-age=1', '--registry=https://registry.npmjs.org/']) expect(flags).toContain(flag);
    expect(flags.find((f) => f.startsWith('--userconfig='))).toBe('--userconfig=/tmp/sb/user.npmrc');
    expect(flags.find((f) => f.startsWith('--globalconfig='))).toBe('--globalconfig=/tmp/sb/global.npmrc');
  });
});

describe('the private-scope record — read exactly as the image build reads it', () => {
  const texts = [
    '{"scopes":{}}',
    '{"scopes":{"@acme":{"origins":["https://npm.acme.test/"],"firstSeen":"2026-10-01T00:00:00Z"},"@b":{"origins":["https://b.test/"],"firstSeen":"x"}}}',
    '{"scopes":[]}',
    '{}',
    '{"scopes":{"acme":{"origins":["https://x/"],"firstSeen":"x"}}}',
    '{"scopes":{"@acme":{"origins":[],"firstSeen":"x"}}}',
    '{"scopes":{"@acme":{"origins":["https://x/"]}}}',
    'not json',
  ];
  it.each(texts)('%s', (text) => {
    let build: string[] | 'throws';
    try {
      build = [...(parsePrivateScopeRecord(text) as Map<string, unknown>).keys()].sort();
    } catch {
      build = 'throws';
    }
    let host: string[] | 'throws';
    try {
      host = parsePrivateScopes(text);
    } catch {
      host = 'throws';
    }
    expect(host).toEqual(build);
  });
});

describe('peer links', () => {
  it('replace an npm-made copy and a stale link with a link to the host copy; unlink removes links only', () => {
    const root = mkdtempSync(join(tmpdir(), 'nrs-peers-'));
    dirs.push(root);
    const hostCopy = join(root, 'host', 'kernel');
    mkdirSync(hostCopy, { recursive: true });
    const pkg = join(root, 'rec', 'node_modules', '@acme', 'x');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ peerDependencies: { kernel: '*', react: '*', absent: '*' } }));
    mkdirSync(join(root, 'rec', 'node_modules', 'kernel'), { recursive: true }); // an npm-made real copy
    symlinkSync(join(root, 'elsewhere'), join(root, 'rec', 'node_modules', 'react'), 'dir'); // a stale link
    const hostRoots: Record<string, string> = { kernel: hostCopy, react: hostCopy };
    const peers = sharedPeers(join(root, 'rec'), ['@acme/x'], (name) => {
      const found = hostRoots[name];
      if (!found) throw new Error('absent');
      return found;
    });
    expect([...peers.keys()].sort()).toEqual(['kernel', 'react']);
    const result = linkSharedPeers(join(root, 'rec'), peers, 'linux');
    expect(result.replaced.sort()).toEqual(['kernel', 'react']);
    for (const name of ['kernel', 'react']) {
      const path = join(root, 'rec', 'node_modules', name);
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      expect(resolve(join(root, 'rec', 'node_modules'), readlinkSync(path))).toBe(hostCopy);
    }
    expect(linkSharedPeers(join(root, 'rec'), peers, 'linux')).toEqual({ linked: [], replaced: [] });
    unlinkSharedPeers(join(root, 'rec'), ['kernel', 'react', '@acme/x']);
    expect(() => lstatSync(join(root, 'rec', 'node_modules', 'kernel'))).toThrow();
    expect(lstatSync(pkg).isDirectory()).toBe(true);
    expect(lstatSync(hostCopy).isDirectory()).toBe(true);
  });
});
