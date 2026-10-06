import { describe, expect, it } from 'vitest';
import { DEFAULT_CALLBACK_URL, resolveCallbackTarget } from '../callbackUrl';

const HOST = 'neuralis.example.lan';

describe('resolveCallbackTarget', () => {
  it('keeps a same-document relative path', () => {
    expect(resolveCallbackTarget('/workspace', HOST)).toEqual({ kind: 'relative', url: '/workspace' });
    expect(resolveCallbackTarget('/files?x=1#y', HOST)).toEqual({ kind: 'relative', url: '/files?x=1#y' });
  });

  it('admits an absolute URL on the SAME hostname, including another port', () => {
    // The MCP OAuth continuation: /auth?callbackUrl=http://<host>:3101/oauth/authorize
    expect(resolveCallbackTarget(`http://${HOST}:3101/oauth/authorize?client_id=x`, HOST)).toEqual({
      kind: 'absolute',
      url: `http://${HOST}:3101/oauth/authorize?client_id=x`,
    });
    expect(resolveCallbackTarget(`https://${HOST}/workspace`, HOST)).toEqual({
      kind: 'absolute',
      url: `https://${HOST}/workspace`,
    });
  });

  it('rejects the whole character class the URL parser rewrites or removes', () => {
    // Not "another instance of the backslash bug": the parser normalises `\`
    // to `/` AND strips tab/newline/carriage-return at ANY position, and the
    // query parameter arrives percent-decoded — so `%09` carries one. Each of
    // these resolves to https://evil.example/ when handed to `new URL`.
    for (const raw of [
      '/\\evil.example',
      '/\t/evil.example',
      '/\n/evil.example',
      '/\r/evil.example',
      '/\u0000/evil.example',
      '/work\u007fspace',
    ]) {
      expect(resolveCallbackTarget(raw, HOST), JSON.stringify(raw)).toEqual({
        kind: 'relative',
        url: DEFAULT_CALLBACK_URL,
      });
    }
  });

  it('rejects credentials and a protocol downgrade on an otherwise same-host URL', () => {
    expect(resolveCallbackTarget(`https://user:pass@${HOST}/workspace`, HOST)).toEqual({
      kind: 'relative',
      url: DEFAULT_CALLBACK_URL,
    });
    // The deliberate relaxation is cross-PORT, never cross-PROTOCOL. In jsdom
    // window.location is http:, so an https target is admitted here; the
    // downgrade arm is the one that matters and is asserted by the guard's
    // secure-page branch (see callbackUrl.ts).
    expect(resolveCallbackTarget(`http://${HOST}:3101/oauth/authorize`, HOST).kind).toBe('absolute');
  });

  it('rejects a foreign origin — including the localhost bounce this fix exists to stop', () => {
    for (const raw of [
      'http://evil.example/steal',
      'https://evil.example',
      'http://localhost:3100/workspace',
      '//evil.example/path',
      '/\\evil.example',
      '\\\\evil.example\\share',
      'javascript:alert(1)',
      'data:text/html,<script>',
      'file:///etc/passwd',
    ]) {
      expect(resolveCallbackTarget(raw, HOST), raw).toEqual({
        kind: 'relative',
        url: DEFAULT_CALLBACK_URL,
      });
    }
  });

  it('falls back to the default for empty, blank and missing input', () => {
    for (const raw of [null, undefined, '', '   ']) {
      expect(resolveCallbackTarget(raw, HOST)).toEqual({ kind: 'relative', url: DEFAULT_CALLBACK_URL });
    }
  });
});
