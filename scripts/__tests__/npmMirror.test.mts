/**
 * The host manifest's npm-side mirror of the pnpm workspace floors.
 *
 * `pnpm-workspace.yaml` is the ONE source of the transitive-dependency
 * `overrides` and the install-script decisions (`allowBuilds`). pnpm ignores
 * both fields in a member manifest, and npm reads neither from the workspace
 * file — so an npm install folder (and a public clone, whose root IS this
 * manifest) would resolve without the advisory floors and, on npm 12, without
 * node-pty's build. `neuralis/package.json` therefore carries `overrides` and
 * `allowScripts`, hand-written; this test pins them to pnpm's own reading of the
 * workspace (`pnpm config get`, never a hand YAML parser).
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const host = JSON.parse(readFileSync(join(HOST, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
  overrides?: Record<string, unknown>;
  allowScripts?: Record<string, unknown>;
};

/** The workspace setting as pnpm parses it. */
function pnpmConfig(key: 'overrides' | 'allowBuilds'): Record<string, unknown> {
  const out = execFileSync('pnpm', ['config', 'get', key, '--json'], { cwd: HOST, encoding: 'utf8', shell: process.platform === 'win32' });
  return JSON.parse(out) as Record<string, unknown>;
}

/** pnpm's `parent>child` selector is npm's nested form `{ parent: { child: range } }`; every other key is verbatim. */
function npmOverrides(pnpm: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, range] of Object.entries(pnpm)) {
    const [parent, child, ...rest] = key.split('>');
    if (rest.length > 0) throw new Error(`a selector deeper than parent>child has no mirror rule: ${key}`);
    if (child === undefined) out[key] = range;
    else out[parent!] = { ...(out[parent!] as Record<string, unknown> | undefined), [child]: range };
  }
  return out;
}

/**
 * `@neuralis/agent-core` is the ONE named exception: its `preinstall` is the
 * read-only Linux build-tool probe for node-pty. pnpm runs it for the workspace
 * package itself, and the image's `pnpm deploy` copy says `false` because the
 * builder already ran it; in an npm folder nothing else runs that check, so the
 * npm side says `true`.
 */
const NPM_ONLY_APPROVAL = '@neuralis/agent-core';

function npmAllowScripts(allowBuilds: Record<string, unknown>): Record<string, unknown> {
  return { ...allowBuilds, [NPM_ONLY_APPROVAL]: true };
}

describe('the host manifest mirrors the pnpm workspace floors for npm', () => {
  const overrides = pnpmConfig('overrides');
  const allowBuilds = pnpmConfig('allowBuilds');

  it('pnpm answers both settings (a missing map would make every comparison below vacuous)', () => {
    expect(Object.keys(overrides).length).toBeGreaterThan(0);
    expect(Object.keys(allowBuilds)).toContain('node-pty');
  });

  it('overrides: every workspace key, npm\'s nested form for a parent>child selector, the same range', () => {
    expect(host.overrides).toEqual(npmOverrides(overrides));
  });

  it('allowScripts: the allowBuilds decisions by package NAME, never name@version', () => {
    expect(host.allowScripts).toEqual(npmAllowScripts(allowBuilds));
    for (const key of Object.keys(host.allowScripts ?? {})) expect(key, key).not.toMatch(/.@/);
  });

  it(`the one exception is ${NPM_ONLY_APPROVAL}: pnpm false (the builder ran it), npm true (nothing else runs the build-tool check)`, () => {
    expect(allowBuilds[NPM_ONLY_APPROVAL], 'pnpm-workspace.yaml allowBuilds').toBe(false);
    expect(host.allowScripts?.[NPM_ONLY_APPROVAL], 'neuralis/package.json allowScripts').toBe(true);
  });

  it('an override of a direct host dependency carries the dependency\'s exact spec (npm EOVERRIDE breaks every clone install otherwise)', () => {
    const shared = Object.keys(host.overrides ?? {}).filter((name) => name in host.dependencies);
    expect(shared.length).toBeGreaterThan(0);
    for (const name of shared) expect(host.overrides?.[name], name).toBe(host.dependencies[name]);
  });

  it('paired control: the host mirror with one key dropped, one range widened or the exception flipped no longer matches', () => {
    const [first] = Object.keys(host.overrides ?? {});
    const { [first!]: _dropped, ...withoutOne } = host.overrides ?? {};
    expect(withoutOne).not.toEqual(npmOverrides(overrides));
    expect({ ...host.overrides, 'fast-uri': '*' }).not.toEqual(npmOverrides(overrides));
    expect({ ...host.allowScripts, [NPM_ONLY_APPROVAL]: false }).not.toEqual(npmAllowScripts(allowBuilds));
  });
});
