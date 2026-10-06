/**
 * MCP Apps sandbox shell (CARD1 3B) — the isolated-origin proxy serves a shell
 * that speaks the RESERVED JSON-RPC handshake, pins the host by hostname, and
 * relays transparently on both legs. There are NO proprietary
 * `neuralis:mcp-app:*` control frames any more.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { GET } from '../route';

describe('mcp-sandbox route — reserved handshake + source/origin protocol', () => {
  let shellHtml: string;
  beforeAll(async () => {
    shellHtml = await (await GET()).text();
  });
  it('GET serves the shell HTML with no-store, noindex headers', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    const body = await res.text();
    expect(body).toMatch(/^<!DOCTYPE html>/);
    expect(body).toContain('<title>Neuralis MCP App</title>');
    expect(body).toMatch(/<\/html>$/);
  });

  it('the shell asks for the resource via the reserved proxy-ready notification', () => {
    expect(shellHtml).toContain('ui/notifications/sandbox-proxy-ready');
    // It is a JSON-RPC notification, sent to the parent, retried until answered.
    expect(shellHtml).toContain("jsonrpc: '2.0'");
    expect(shellHtml).toMatch(/window\.parent\.postMessage/);
  });

  it('the shell accepts the reserved resource-ready reply only from a same-hostname origin', () => {
    expect(shellHtml).toContain('ui/notifications/sandbox-resource-ready');
    expect(shellHtml).toContain('sameHostname');
    // The reply must carry the template HTML in params.html.
    expect(shellHtml).toContain('params.html');
  });

  it('relays transparently with source-identity checks on BOTH legs', () => {
    // Leg 1 — host → view (pinned parentOrigin).
    expect(shellHtml).toContain('e.source === window.parent');
    expect(shellHtml).toContain('e.origin !== parentOrigin');
    // Leg 2 — view → host (pinned inner contentWindow).
    expect(shellHtml).toContain('e.source === inner.contentWindow');
  });

  it('the inner document iframe is a throwaway same-origin sandbox, never the host origin', () => {
    expect(shellHtml).toContain("setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms')");
    // The inner document is written same-origin with THIS sandbox origin.
    expect(shellHtml).toContain('location.origin');
  });

  it('reports content size via the SPEC notification, not a proprietary frame', () => {
    expect(shellHtml).toContain('ui/notifications/size-changed');
    // The old proprietary neuralis:mcp-app:* control frames are GONE.
    expect(shellHtml).not.toContain('neuralis:mcp-app:init');
    expect(shellHtml).not.toContain('neuralis:mcp-app:ready');
    expect(shellHtml).not.toContain('neuralis:mcp-app:size');
  });
});
