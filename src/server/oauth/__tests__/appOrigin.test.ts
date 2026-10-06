import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_APP_ORIGIN,
  declaredAppOrigin,
  isLoopbackAppOrigin,
  resolveTrustedAppOrigin,
} from '../appOrigin';

const saved = { APP_URL: process.env.APP_URL, NEXTAUTH_URL: process.env.NEXTAUTH_URL };
afterEach(() => {
  for (const k of ['APP_URL', 'NEXTAUTH_URL'] as const) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('resolveTrustedAppOrigin — the ONE origin every OAuth redirect is built from', () => {
  it('the declared origin wins over the request origin (the container binds 0.0.0.0)', () => {
    process.env.APP_URL = 'https://neuralis.example.com/';
    process.env.NEXTAUTH_URL = 'http://localhost:3100';
    expect(resolveTrustedAppOrigin('http://0.0.0.0:3100/api/oauth/whatsapp?action=start'))
      .toBe('https://neuralis.example.com');
  });
  it('NEXTAUTH_URL is the second source', () => {
    delete process.env.APP_URL;
    process.env.NEXTAUTH_URL = 'http://localhost:3100/';
    expect(resolveTrustedAppOrigin('http://0.0.0.0:3100/x')).toBe('http://localhost:3100');
  });
  it('without a declared origin only a loopback request origin is trusted; anything else falls to the dev default', () => {
    delete process.env.APP_URL;
    delete process.env.NEXTAUTH_URL;
    expect(resolveTrustedAppOrigin('http://127.0.0.1:3100/x')).toBe('http://127.0.0.1:3100');
    expect(resolveTrustedAppOrigin('http://0.0.0.0:3100/x')).toBe('http://localhost:3100');
    expect(resolveTrustedAppOrigin('https://evil.example/x')).toBe('http://localhost:3100');
  });

  it('answers WITHOUT a request — the shape the package port publishes', () => {
    delete process.env.APP_URL;
    delete process.env.NEXTAUTH_URL;
    expect(resolveTrustedAppOrigin()).toBe(DEFAULT_APP_ORIGIN);
    process.env.APP_URL = 'https://neuralis.example.com';
    expect(resolveTrustedAppOrigin()).toBe('https://neuralis.example.com');
  });

  it('an UNUSABLE declared value is ignored, not thrown on', () => {
    // An unparseable APP_URL used to make every callback answer 500. The arms
    // below it are loopback-only, so ignoring it cannot widen the origin.
    process.env.APP_URL = 'not a url';
    delete process.env.NEXTAUTH_URL;
    expect(declaredAppOrigin()).toBeNull();
    expect(resolveTrustedAppOrigin('http://0.0.0.0:3100/x')).toBe(DEFAULT_APP_ORIGIN);

    process.env.APP_URL = 'file:///etc/passwd';
    expect(declaredAppOrigin()).toBeNull();

    // PAIRED CONTROL: a usable one still wins.
    process.env.APP_URL = 'https://neuralis.example.com';
    expect(declaredAppOrigin()).toBe('https://neuralis.example.com');
  });
});

describe('isLoopbackAppOrigin — what decides the Codex completion MODE (D8)', () => {
  it('is true only for the loopback hostnames', () => {
    expect(isLoopbackAppOrigin('http://localhost:3100')).toBe(true);
    expect(isLoopbackAppOrigin('http://127.0.0.1:3100')).toBe(true);
    expect(isLoopbackAppOrigin('http://[::1]:3100')).toBe(true);
    expect(isLoopbackAppOrigin('https://neuralis.example.com')).toBe(false);
    // The container's own bind address is NOT loopback — a deployment reached
    // on it cannot catch a localhost callback.
    expect(isLoopbackAppOrigin('http://0.0.0.0:3100')).toBe(false);
    expect(isLoopbackAppOrigin('garbage')).toBe(false);
  });
});
