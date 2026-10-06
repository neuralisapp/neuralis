/**
 * MCP Apps sandbox shell (MCP1-C; CARD1 3B reserved handshake) — the
 * isolated-origin proxy page.
 *
 * Served ONLY on the sandbox origin (`NEURALIS_MCP_SANDBOX_PORT` — the host
 * proxy (`src/proxy.ts`) 404s every other path there). The shell:
 *
 *   1. On load, asks its embedding parent for the resource with the reserved
 *      JSON-RPC notification `ui/notifications/sandbox-proxy-ready` (retried
 *      until answered). It accepts the reply only when the sender origin's
 *      HOSTNAME equals its own (a foreign site embedding the shell can never
 *      seed HTML onto this origin) and pins that origin for the session.
 *   2. On the reserved `ui/notifications/sandbox-resource-ready` reply,
 *      `document.write`s the template HTML (CSP `<meta>` already injected
 *      server-side by the template route) into an inner iframe
 *      `allow-scripts allow-same-origin allow-forms` — same-origin with THIS
 *      throwaway sandbox origin, never with the main app origin. This is the
 *      ratified ext-apps web-host topology: real origin ⇒ Web Storage,
 *      `'self'` CSP resolution, and document.write-dependent apps all work.
 *   3. Relays JSON-RPC frames TRANSPARENTLY host↔view with source-identity
 *      checks on both legs. There are NO proprietary `neuralis:mcp-app:*`
 *      control frames: the handshake and content-size reports ride the standard
 *      JSON-RPC surface (`ui/notifications/size-changed`).
 *
 * Embedding enforcement is the message-level bootstrap hostname pin (a foreign
 * embedder gets an inert page); the `/mcp-sandbox` header rule in next.config.ts
 * neutralizes the global `X-Frame-Options: SAMEORIGIN` (which would refuse the
 * cross-PORT main-origin frame) with `frame-ancestors *`.
 */

const SHELL_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="dark light">
<title>Neuralis MCP App</title>
<style>:root{color-scheme:dark light}html,body{margin:0;padding:0;height:100%;background:transparent;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block;background:transparent;color-scheme:dark light}</style>
</head>
<body>
<script>
(function () {
  'use strict';
  var parentOrigin = null;
  var inner = null;
  var proxyReadyTimer = null;
  var proxyReadyAttempts = 0;

  function sameHostname(origin) {
    try { return new URL(origin).hostname === location.hostname; } catch (e) { return false; }
  }
  function isJsonRpc(d) {
    return d && typeof d === 'object' && !Array.isArray(d) && d.jsonrpc === '2.0';
  }

  // Reserved handshake: ask the host for the resource, retried until answered.
  function sendProxyReady() {
    proxyReadyAttempts += 1;
    if (proxyReadyAttempts > 25) { stopProxyReady(); return; } // ~5s cap, fail-inert
    // targetOrigin '*' — this frame does not yet know the host origin and the
    // notification carries no secret; the host verifies OUR source + origin.
    window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready' }, '*');
  }
  function stopProxyReady() {
    if (proxyReadyTimer !== null) { clearInterval(proxyReadyTimer); proxyReadyTimer = null; }
  }

  function boot(html) {
    inner = document.createElement('iframe');
    inner.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
    document.body.appendChild(inner);
    var doc = inner.contentDocument;
    doc.open();
    doc.write(html);
    doc.close();
    // Content-height reporting: the shell is same-origin with the inner view, so
    // it can MEASURE the app document and report its natural height as the SPEC
    // notification (ui/notifications/size-changed) — the host card sizes the
    // iframe 1:1 to the app, no inner scrollbar. An app that sends its own
    // size-changed converges the same way.
    var lastH = 0;
    function reportSize() {
      try {
        var de = doc.documentElement;
        var b = doc.body;
        var h = Math.max(
          b ? b.scrollHeight : 0,
          b ? b.offsetHeight : 0,
          de ? de.offsetHeight : 0
        );
        if (h > 0 && h !== lastH) {
          lastH = h;
          window.parent.postMessage(
            { jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: h } },
            parentOrigin
          );
        }
      } catch (err) { /* measuring is best-effort */ }
    }
    try {
      var ro = new ResizeObserver(function () { reportSize(); });
      if (doc.documentElement) ro.observe(doc.documentElement);
      if (doc.body) ro.observe(doc.body);
    } catch (err) { /* older engines: interval fallback below */ }
    setTimeout(reportSize, 50);
    setTimeout(reportSize, 300);
    setInterval(reportSize, 1500);
  }

  window.addEventListener('message', function (e) {
    // Leg 1 — messages from the embedding host page.
    if (e.source === window.parent && window.parent !== window) {
      var d = e.data;
      if (!parentOrigin) {
        // Bootstrap: hostname-pinned, once. Accept ONLY the reserved
        // resource-ready reply carrying the template HTML.
        if (!sameHostname(e.origin)) return;
        if (!isJsonRpc(d) || d.method !== 'ui/notifications/sandbox-resource-ready') return;
        var html = d.params && typeof d.params.html === 'string' ? d.params.html : null;
        if (html === null) return;
        parentOrigin = e.origin;
        stopProxyReady();
        boot(html);
        return;
      }
      // Post-bootstrap: relay host→view, pinned-origin only. A repeated
      // resource-ready is ignored (never re-inits the inner document).
      if (e.origin !== parentOrigin || !inner || !inner.contentWindow) return;
      if (isJsonRpc(d) && d.method === 'ui/notifications/sandbox-resource-ready') return;
      inner.contentWindow.postMessage(d, location.origin);
      return;
    }
    // Leg 2 — messages from the inner view: relay view→host transparently.
    if (parentOrigin && inner && e.source === inner.contentWindow) {
      window.parent.postMessage(e.data, parentOrigin);
    }
  });

  // Kick off the handshake once listeners are wired.
  proxyReadyTimer = setInterval(sendProxyReady, 200);
  sendProxyReady();
})();
</script>
</body>
</html>`;

export async function GET(): Promise<Response> {
  // CSP + X-Frame-Options for this path are OWNED by next.config.ts headers()
  // (`/mcp-sandbox` rule): config headers OVERRIDE same-key route headers, so a
  // header set here would be silently replaced by the global rule. The rule
  // ships `frame-ancestors *` (supersedes XFO) — the ENFORCEMENT against foreign
  // embedders is the shell's message-level bootstrap hostname pin above.
  return new Response(SHELL_HTML, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'x-robots-tag': 'noindex',
      'cache-control': 'no-store',
    },
  });
}
