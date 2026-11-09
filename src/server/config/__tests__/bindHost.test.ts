/**
 * The ONE bind address (`bindHost`): unset is the container's every-interface
 * default; the desktop app's `.env` says loopback; anything that is no IP is
 * refused, never widened. The `:3101` server listens on it — no literal left.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bindHost } from '../env';

describe('bindHost', () => {
  it('unset (the container) is 0.0.0.0; the native .env value is used as is', () => {
    expect(bindHost({})).toBe('0.0.0.0');
    expect(bindHost({ NEURALIS_BIND_HOST: '' })).toBe('0.0.0.0');
    expect(bindHost({ NEURALIS_BIND_HOST: '127.0.0.1' })).toBe('127.0.0.1');
    expect(bindHost({ NEURALIS_BIND_HOST: ' ::1 ' })).toBe('::1');
  });

  it('a value that is no IP address is refused, never turned into every interface', () => {
    expect(() => bindHost({ NEURALIS_BIND_HOST: 'localhost' })).toThrow(/is not an IP address; nothing was bound/);
    expect(() => bindHost({ NEURALIS_BIND_HOST: '0.0.0.0/0' })).toThrow(/not an IP address/);
  });

  it('the :3101 server listens on the bind address, with no hard-wired interface', () => {
    const source = readFileSync(join(__dirname, '..', '..', 'mcp', 'startMcpServer.ts'), 'utf-8');
    expect(source).toMatch(/const host = bindHost\(\);/);
    expect(source).toMatch(/server\.listen\(PORT, host,/);
    expect(source).not.toMatch(/listen\([^)]*'0\.0\.0\.0'/);
  });
});
