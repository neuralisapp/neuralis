/**
 * Security-header rule set (CARD1 3B header-override).
 *
 * These asserts prove the CONFIG SHAPE that makes the wire override
 * deterministic under Next's last-write-wins semantics: the global rule stays
 * first with unchanged values, the more-specific `/api/package-app/:path*` rule
 * comes AFTER it with the strict floor and the SAME key casing, and the
 * unrelated rule values are untouched. The FINAL proof of the wire behaviour is
 * the live wire-assert (an actual HTTP response on the running server) — that
 * cannot be unit-tested here.
 */
import { describe, expect, it } from 'vitest';
import { buildSecurityHeaders, type SecurityHeaderRule } from '../securityHeaders';
import {
  buildPackageAppAssetCsp,
  PACKAGE_APP_PUB_CSP,
} from '../../packages/packageAppAssetCsp';

function value(rule: SecurityHeaderRule, key: string): string | undefined {
  return rule.headers.find((h) => h.key === key)?.value;
}

describe('buildSecurityHeaders — package-app override ordering', () => {
  const rules = buildSecurityHeaders();
  const globalIdx = rules.findIndex((r) => r.source === '/:path*');
  const appIdx = rules.findIndex((r) => r.source === '/api/package-app/:path*');
  const pubIdx = rules.findIndex((r) => r.source === '/api/package-app/_pub/:path*');
  const pkgIdx = rules.findIndex((r) => r.source === '/api/packages/:path*');
  it('keeps the global /:path* rule FIRST with UNCHANGED permissive values', () => {
    expect(globalIdx).toBe(0);
    const g = rules[globalIdx];
    expect(value(g, 'Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(value(g, 'X-Content-Type-Options')).toBe('nosniff');
    expect(value(g, 'X-Frame-Options')).toBe('SAMEORIGIN');
    expect(value(g, 'Content-Security-Policy')).toContain("connect-src 'self' ws: wss: http: https:");
    expect(value(g, 'Content-Security-Policy')).toContain("script-src 'self' 'unsafe-eval' 'unsafe-inline'");
  });

  it('places the /api/package-app rule AFTER the global rule (last-write override)', () => {
    expect(appIdx).toBeGreaterThan(-1);
    expect(appIdx).toBeGreaterThan(globalIdx);
  });

  it('places the _pub rule AFTER the package-app rule (it must win LAST)', () => {
    // Ordering IS the mechanism: `resHeaders[key] = value` means the LAST rule
    // matching a path wins the exact key. Moved before the package-app rule, the
    // strict asset CSP would override `sandbox` and a navigated `_pub` document
    // would execute script again.
    expect(pubIdx).toBeGreaterThan(appIdx);
    expect(appIdx).toBeGreaterThan(globalIdx);
  });

  it('gives the _pub rule the CSP key ALONE, with the anti-navigation value', () => {
    const p = rules[pubIdx];
    // Exactly one key. `X-Content-Type-Options` / `Referrer-Policy` already
    // arrive from the earlier rules and survive; `Access-Control-Allow-Origin`
    // is deliberately absent so the ROUTE's own `ACAO: *` reaches the wire and
    // the lane's 404s stay opaque.
    expect(p.headers.map((h) => h.key)).toEqual(['Content-Security-Policy']);
    expect(value(p, 'Content-Security-Policy')).toBe('sandbox');
    expect(value(p, 'Content-Security-Policy')).toBe(PACKAGE_APP_PUB_CSP);
    expect(p.headers.some((h) => h.key === 'Access-Control-Allow-Origin')).toBe(false);
  });

  it('uses the SAME key casing character-for-character as the global rule', () => {
    // `resHeaders` is keyed by the raw string, so a casing difference degrades
    // the override into a duplicate/merged header instead.
    //
    // This walks EVERY rule, deliberately. It used to iterate a hand-listed
    // pair, which meant each rule added afterwards was silently uncovered by
    // the one assertion that protects the whole override mechanism.
    const globalKeys = new Set(rules[globalIdx].headers.map((h) => h.key));
    for (const rule of rules) {
      for (const { key } of rule.headers) {
        const twin = [...globalKeys].find((g) => g.toLowerCase() === key.toLowerCase());
        if (twin) expect(key, `${rule.source} → ${key}`).toBe(twin);
      }
    }
  });

  it('pins the strict wire floor on package-app with the SAME key casing', () => {
    const a = rules[appIdx];
    // Exact casing must match the global rule or the override degrades to a merge.
    expect(a.headers.map((h) => h.key)).toEqual([
      'X-Content-Type-Options',
      'Referrer-Policy',
      'Content-Security-Policy',
    ]);
    expect(value(a, 'Referrer-Policy')).toBe('no-referrer');
    expect(value(a, 'X-Content-Type-Options')).toBe('nosniff');
    // Byte-identical to the ONE builder — two spellings of one policy would drift.
    expect(value(a, 'Content-Security-Policy')).toBe(buildPackageAppAssetCsp());
    // `base-uri 'none'` would forbid the <base> ELEMENT outright, making the
    // server-injected bundle-mode base silently inert.
    expect(value(a, 'Content-Security-Policy')).toContain("base-uri 'self'");
    expect(value(a, 'Content-Security-Policy')).not.toContain("base-uri 'none'");
    // The strict CSP must NOT carry the permissive connect/eval escapes.
    expect(value(a, 'Content-Security-Policy')).toContain("default-src 'none'");
    expect(value(a, 'Content-Security-Policy')).toContain("connect-src 'self'");
    expect(value(a, 'Content-Security-Policy')).not.toContain('http: https:');
    expect(value(a, 'Content-Security-Policy')).not.toContain('unsafe-eval');
    // F-LIVE-1: script-src carries 'unsafe-inline' SYMMETRICALLY with style-src so
    // the opaque-sandbox card/widget's mandatory inline card-ready bootstrap runs;
    // the sandbox (opaque origin, no allow-same-origin) is the isolation boundary,
    // this CSP is defense-in-depth on the package's own content (spec-aligned).
    expect(value(a, 'Content-Security-Policy')).toContain("script-src 'self' 'unsafe-inline'");
    expect(value(a, 'Content-Security-Policy')).toContain("style-src 'self' 'unsafe-inline'");
  });

  it('carries the anti-navigation sandbox on the ENTRY lane — and NEVER allow-same-origin', () => {
    // Measured live: a `_scope` document opened as a NAVIGATION ran its inline
    // script on the MAIN origin. The two flags mirror the product's iframe
    // attribute exactly (`sandbox="allow-scripts allow-forms"`), so the effective
    // set inside the frame is the intersection of two identical sets — unchanged —
    // while a navigated or same-origin-embedded copy is forced opaque.
    const csp = value(rules[appIdx], 'Content-Security-Policy');
    expect(csp).toContain('sandbox allow-scripts allow-forms');
    // The one wrong turn that "makes the entry work again": it would hand every
    // package's UI the host origin (cookies, credentialed fetch, parent DOM).
    expect(csp).not.toContain('allow-same-origin');
    // The directive must not have displaced the base-uri permission — without it
    // the injected bundle `<base>` goes SILENTLY inert.
    expect(csp).toContain("base-uri 'self'");
  });

  it('gives the PACKAGE ROUTE lane the anti-navigation sandbox, AFTER the global rule', () => {
    // brain-core's `raw` route serves member-written bytes. Served as a
    // navigable document on the app origin, a member's SVG ran its script with
    // the READER's session. brain-core forces the active-document class to
    // `attachment` (the primary fix); this header is the second layer and also
    // covers any FUTURE package byte route whose author forgets one.
    expect(pkgIdx).toBeGreaterThan(globalIdx);
    const p = rules[pkgIdx];
    // The CSP key ALONE — nosniff / XFO / Referrer-Policy must keep arriving
    // from the global rule untouched.
    expect(p.headers.map((h) => h.key)).toEqual(['Content-Security-Policy']);
    expect(value(p, 'Content-Security-Policy')).toBe('sandbox');
  });

  it('no rule after the package-route floor restores a script-bearing CSP under /api/packages/ — the machine-core stream lane included, in BOTH package-id spellings', () => {
    // The catch-all stream lane serves container-authored bytes. On the app
    // origin a script-bearing policy would run them with the viewer's cookie,
    // so the lane keeps the package floor (`sandbox`: an opaque origin).
    const later = rules.slice(pkgIdx + 1).filter((r) => r.source.startsWith('/api/packages/'));
    expect(later.filter((r) => r.headers.some((h) => h.key === 'Content-Security-Policy'))).toEqual([]);
    for (const path of ['machine-core', '@neuralis/machine-core']) {
      const lane = `/api/packages/${path}/session/:key/stream/:path*`;
      expect(rules.some((r) => r.source === lane), lane).toBe(false);
    }
    expect(value(rules[pkgIdx], 'Content-Security-Policy')).toBe('sandbox');
  });

  it('keeps the package-route lane DISJOINT from the package-APP lane', () => {
    // `packages` ≠ `package-app`. If a future edit ever collapsed the two
    // sources, the strict asset CSP and the sandbox rule would start fighting
    // over the same key by array position.
    expect(rules[pkgIdx].source).not.toBe(rules[appIdx].source);
    expect(rules[pkgIdx].source.startsWith('/api/package-app')).toBe(false);
  });

  it('leaves the /mcp-sandbox and /machine rule VALUES unchanged', () => {
    const sandbox = rules.find((r) => r.source === '/mcp-sandbox')!;
    expect(value(sandbox, 'Content-Security-Policy')).toBe('frame-ancestors *');
    expect(value(sandbox, 'X-Frame-Options')).toBe('ALLOWALL');
    const machine = rules.find((r) => r.source === '/machine/:path*')!;
    expect(value(machine, 'Permissions-Policy')).toContain('fullscreen=(self)');
  });

  it('the /invite page (a token in its fragment) sends no Referer, cannot be framed or cached — AFTER the global rule', () => {
    const inviteIdx = rules.findIndex((r) => r.source === '/invite');
    expect(inviteIdx).toBeGreaterThan(globalIdx);
    const invite = rules[inviteIdx]!;
    expect(value(invite, 'Referrer-Policy')).toBe('no-referrer');
    expect(value(invite, 'X-Frame-Options')).toBe('DENY');
    expect(value(invite, 'Cache-Control')).toBe('no-store');
    // The global policy, plus the frame ban — never a second, drifting copy of it.
    expect(value(invite, 'Content-Security-Policy')).toBe(`${value(rules[globalIdx]!, 'Content-Security-Policy')}; frame-ancestors 'none'`);
  });
});
