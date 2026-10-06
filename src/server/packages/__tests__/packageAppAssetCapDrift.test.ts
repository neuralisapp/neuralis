/**
 * Drift-guard for every value the shipped authoring preflight
 * (`check-package.sh`) must keep in lockstep with the platform: the 2 MiB
 * per-file asset floor, the session-free lane's per-scope 64-file / 8 MiB
 * budget, and the kernel's absolute-asset-url predicate.
 *
 * Each floor exists as TWO independent literals by necessity: the host route
 * constant (`packageAppAssetCsp.ts`) and the shipped authoring preflight's twin
 * (`check-package.sh`). The preflight
 * is a standalone shell/node script an author runs before the package ever
 * reaches a host, so it cannot import TypeScript — the duplicate hardcode is
 * unavoidable, but the DIVERGENCE is not.
 *
 * Derive-and-verify (CLAUDE.md principle 1): this test derives the preflight's
 * number by reading it back out of the shipped script and asserts equality with
 * the host constant. A one-sided edit fails loudly instead of silently letting
 * an author ship an entry the route will 404.
 *
 * The script is read through `node_modules/@neuralis/brain-core` — brain-core's
 * `files` whitelist ships `skills/`, so the path is identical in the workspace
 * (symlink) and in a real tarball install.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAbsoluteAssetUrl } from '@neuralis/package-system';
import {
  PACKAGE_APP_ASSET_MAX_BYTES,
  PACKAGE_APP_PUB_MAX_FILES,
  PACKAGE_APP_PUB_MAX_TOTAL_BYTES,
} from '../packageAppAssetCsp';

const HOST_ROOT = join(__dirname, '..', '..', '..', '..');
const PREFLIGHT_SCRIPT = join(
  HOST_ROOT,
  'node_modules',
  '@neuralis',
  'brain-core',
  'skills',
  'create-package',
  'scripts',
  'check-package.sh',
);

/**
 * A numeric constant read back VERBATIM out of the shipped preflight — never
 * recomputed here, or the guard would be comparing this file to itself.
 *
 * Exactly-one is asserted so a RENAME or removal fails loud too: a silently
 * absent declaration would make the guard vacuously pass, which is the precise
 * failure mode it exists to stop.
 */
function readPreflightNumber(name: string): number {
  const source = readFileSync(PREFLIGHT_SCRIPT, 'utf-8');
  const matches = [...source.matchAll(new RegExp(`^\\s*const\\s+${name}\\s*=\\s*(\\d+)\\s*;`, 'gm'))];
  expect(
    matches,
    `check-package.sh must declare exactly one \`const ${name} = <number>;\``,
  ).toHaveLength(1);
  return Number(matches[0][1]);
}

/**
 * Normalize a single-parameter predicate down to its comparable EXPRESSION —
 * the parameter identifier collapsed to a fixed name and whitespace squeezed —
 * so the kernel's `(url) => …` and the preflight's `(u) => …` are comparable
 * without either side's text being restated here.
 */
function normalizePredicate(param: string, expression: string): string {
  return expression
    .replace(new RegExp(`\\b${param}\\b`, 'g'), 'URL')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The preflight's own `isAbsUrl` declaration, read back verbatim. */
function readPreflightAbsUrl(): string {
  const source = readFileSync(PREFLIGHT_SCRIPT, 'utf-8');
  const matches = [...source.matchAll(/^\s*const\s+isAbsUrl\s*=\s*\((\w+)\)\s*=>\s*(.+?);\s*$/gm)];
  expect(matches, 'check-package.sh must declare exactly one `const isAbsUrl = (u) => …;`').toHaveLength(1);
  return normalizePredicate(matches[0][1], matches[0][2]);
}

/** The KERNEL's own body, read off the shipped function (never restated here). */
function readKernelAbsUrl(): string {
  const source = isAbsoluteAssetUrl.toString();
  const match = /\((\w+)\)\s*(?:=>|\{\s*return)\s*([\s\S]+?);?\s*\}?\s*$/.exec(source);
  expect(match, 'isAbsoluteAssetUrl must stay a single-parameter one-expression predicate').not.toBeNull();
  return normalizePredicate(match![1], match![2].replace(/;\s*$/, ''));
}

describe('package app asset 2 MiB floor — host route ↔ shipped preflight', () => {
  it('the preflight ENTRY_MAX equals the host route cap', () => {
    expect(readPreflightNumber('ENTRY_MAX')).toBe(PACKAGE_APP_ASSET_MAX_BYTES);
  });

  it('the host cap is still the documented 2 MiB', () => {
    // Pins the shared NUMBER, so a change has to be a deliberate two-file edit
    // (host constant + preflight literal + this line) rather than a drift.
    expect(PACKAGE_APP_ASSET_MAX_BYTES).toBe(2 * 1024 * 1024);
  });

  it('the preflight message interpolates ENTRY_MAX rather than a second literal', () => {
    const source = readFileSync(PREFLIGHT_SCRIPT, 'utf-8');
    // The author-facing text must render the DECLARED cap. A hardcoded number
    // in the message would be a THIRD copy this guard cannot reach.
    expect(source).toContain('the package UI entry cap is ${ENTRY_MAX} bytes');
  });
});

describe('session-free lane per-scope budget — host route ↔ shipped preflight', () => {
  // These two are the SAME class as ENTRY_MAX but a step more dangerous: the
  // preflight counts the SHIPPED TREE while the host counts distinct paths
  // actually served, so a drift here does not merely mis-warn — it lets an
  // author ship a bundle whose later files 404 inside a live frame with no
  // error surfaced anywhere.
  it('the preflight PUB_MAX_FILES equals the host distinct-file budget', () => {
    expect(readPreflightNumber('PUB_MAX_FILES')).toBe(PACKAGE_APP_PUB_MAX_FILES);
  });

  it('the preflight PUB_MAX_TOTAL equals the host total-byte budget', () => {
    expect(readPreflightNumber('PUB_MAX_TOTAL')).toBe(PACKAGE_APP_PUB_MAX_TOTAL_BYTES);
  });

  it('the host budgets are still the documented 64 files / 8 MiB', () => {
    expect(PACKAGE_APP_PUB_MAX_FILES).toBe(64);
    expect(PACKAGE_APP_PUB_MAX_TOTAL_BYTES).toBe(8 * 1024 * 1024);
  });

  it('both preflight messages interpolate the constants rather than a literal', () => {
    const source = readFileSync(PREFLIGHT_SCRIPT, 'utf-8');
    expect(source).toContain('at most ${PUB_MAX_FILES} DISTINCT paths per scope');
    expect(source).toContain("per-scope total is ${PUB_MAX_TOTAL} bytes");
  });
});

describe('absolute-asset-url predicate — kernel ↔ shipped preflight', () => {
  it('the preflight `isAbsUrl` literal equals the kernel `isAbsoluteAssetUrl` body', () => {
    // The preflight runs standalone (shell + node, no TypeScript), so it cannot
    // import `surfaceLayout.isAbsoluteAssetUrl` — this is the FOURTH copy of the
    // predicate and the only one a package author's machine ever executes. Both
    // sides are read back from their own source; nothing is restated here, so a
    // one-sided edit fails loudly instead of letting the preflight classify an
    // entry url differently from the platform that will serve it.
    expect(readPreflightAbsUrl()).toBe(readKernelAbsUrl());
  });

  it('the preflight predicate CLASSIFIES exactly like the kernel one', () => {
    // Behavioural cross-check of the two extracted forms — belt to the literal
    // comparison's braces, and it survives a cosmetic reformat of either side.
    const preflight = new Function('URL', `return ${readPreflightAbsUrl()};`) as (u: string) => boolean;
    for (const url of [
      'https://example.test/a.html',
      'http://example.test/a.html',
      '//example.test/a.html',
      '/widget.html',
      '/api/packages/x/app/index.html',
      './app/surfaces/card/x.card/index.html',
      'app/surfaces/card/x.card/index.html',
      'HTTPS://EXAMPLE.TEST/a.html',
      '',
    ]) {
      expect(preflight(url), `classification drift for "${url}"`).toBe(isAbsoluteAssetUrl(url));
    }
  });
});
