#!/usr/bin/env node
/**
 * reconcile-runtime-externals.mjs — point Turbopack's external aliases at the
 * runner's REAL npm-installed packages.
 *
 * ## The defect this closes
 *
 * Every `serverExternalPackages` entry gets an alias directory emitted by
 * Turbopack under `.next/node_modules/<name>-<hash>`, and that alias is a
 * RELATIVE SYMLINK into whatever path the resolver saw AT BUILD TIME. The
 * builder is a pnpm workspace, so the link reads:
 *
 *     .next/node_modules/node-pty-c710df912a232c01
 *       -> ../../../node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty
 *
 * The runner has a completely different node_modules: `npm install` from the
 * packed tarballs, flat real directories, install scripts run. It has no pnpm
 * store — except for the fragment the Next.js FILE TRACER copied in beside it
 * (`node_modules-standalone`, merged with `cp -rn`). That fragment holds only
 * the files the tracer could reach by STATIC ANALYSIS.
 *
 * For a pure-JS package the fragment happens to be enough. For a package with a
 * native addon it is not: node-pty loads `build/Release/pty.node` through a
 * computed path, the tracer never sees it, so the traced copy ships `lib/` and
 * nothing else. The alias resolves — to the incomplete copy — and the terminal
 * dies at runtime with `Cannot find module './prebuilds/linux-x64//pty.node'`,
 * while a perfectly good compiled copy sits unused at
 * `/neuralis/node_modules/node-pty`.
 *
 * The same shape also produces DUPLICATE module instances: `ws` resolved to the
 * traced 8.21.0 inside the Next graph and to the npm-installed 8.21.1 for every
 * `@neuralis/*` package — two classes, `instanceof` across the boundary false.
 * That is the split-brain class this repo has been bitten by before.
 *
 * ## The fix
 *
 * Retarget every alias at `node_modules/<name>` — the npm-installed copy that
 * is complete by construction (npm ran the install scripts that compiled the
 * addon) and that every non-bundled package already resolves to. One copy of
 * each external in the image, reachable from both module graphs.
 *
 * Fails loud on: no aliases found (Turbopack changed its layout — the whole
 * step would silently become a no-op), a missing flat package, a major-version
 * disagreement, or a declared native artifact that is absent after retargeting.
 * A silent skip here reappears as a runtime crash in one narrow feature, which
 * is exactly how this bug reached a live image in the first place.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { join, relative, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Artifacts a package needs at runtime that the file tracer cannot see.
 * Checked AFTER retargeting, so the assertion proves the fix, not the intent.
 */
const REQUIRED_NATIVE_ARTIFACTS = {
  'node-pty': ['build/Release/pty.node'],
};

/** `express-af8ae79ffa893691` → `express`; `sdk-35c6…` → `sdk`. */
const ALIAS_RE = /^(.+)-[0-9a-f]{16}$/;

const root = resolvePath(process.argv[2] ?? '/neuralis');
const aliasRoot = join(root, '_runtime', '.next', 'node_modules');
const flatRoot = join(root, 'node_modules');

if (!existsSync(aliasRoot)) {
  console.error(`[externals] FATAL: ${aliasRoot} does not exist — the runner layout changed.`);
  process.exit(1);
}

/** Collect `<aliasRoot>/<alias>` and `<aliasRoot>/@scope/<alias>` symlinks. */
function collectAliases() {
  const out = [];
  for (const entry of readdirSync(aliasRoot, { withFileTypes: true })) {
    if (entry.name.startsWith('@')) {
      const scopeDir = join(aliasRoot, entry.name);
      for (const inner of readdirSync(scopeDir, { withFileTypes: true })) {
        if (inner.isSymbolicLink()) out.push({ dir: scopeDir, alias: inner.name, scope: entry.name });
      }
      continue;
    }
    if (entry.isSymbolicLink()) out.push({ dir: aliasRoot, alias: entry.name, scope: null });
  }
  return out;
}

function readVersion(pkgDir) {
  try {
    return JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8')).version ?? null;
  } catch {
    return null;
  }
}

const aliases = collectAliases();
if (aliases.length === 0) {
  console.error(
    '[externals] FATAL: no alias symlinks under _runtime/.next/node_modules.\n' +
    '  Turbopack no longer emits per-external alias directories, or the build\n' +
    '  produced none. This step must not become a silent no-op — the terminal\n' +
    '  regression it guards against is invisible until a user opens a PTY.',
  );
  process.exit(1);
}

const failures = [];
let retargeted = 0;

for (const { dir, alias, scope } of aliases) {
  const match = ALIAS_RE.exec(alias);
  if (!match) {
    // Not a hashed external alias — leave whatever it is alone.
    console.log(`[externals] skip   ${scope ? `${scope}/` : ''}${alias} (not a hashed alias)`);
    continue;
  }
  const name = scope ? `${scope}/${match[1]}` : match[1];
  const linkPath = join(dir, alias);
  const oldTarget = resolvePath(dir, readlinkSync(linkPath));
  const flatDir = join(flatRoot, name);

  if (!existsSync(join(flatDir, 'package.json'))) {
    failures.push(
      `${name}: no npm-installed copy at node_modules/${name} ` +
      `(alias points at ${relative(root, oldTarget)})`,
    );
    continue;
  }

  const flatVersion = readVersion(flatDir);
  const tracedVersion = existsSync(oldTarget) ? readVersion(oldTarget) : null;
  if (tracedVersion && flatVersion && tracedVersion.split('.')[0] !== flatVersion.split('.')[0]) {
    failures.push(
      `${name}: major-version disagreement — build resolved ${tracedVersion}, ` +
      `runner installed ${flatVersion}. Retargeting would change behaviour.`,
    );
    continue;
  }

  rmSync(linkPath, { force: true });
  symlinkSync(relative(dir, flatDir), linkPath, 'dir');
  retargeted += 1;
  const drift = tracedVersion && tracedVersion !== flatVersion ? ` (build ${tracedVersion} → runner ${flatVersion})` : '';
  console.log(`[externals] retarget ${name} -> node_modules/${name}${drift}`);
}

for (const [name, artifacts] of Object.entries(REQUIRED_NATIVE_ARTIFACTS)) {
  const dir = join(flatRoot, name);
  for (const artifact of artifacts) {
    if (!existsSync(join(dir, artifact))) {
      failures.push(`${name}: required native artifact ${artifact} is missing from node_modules/${name}`);
    }
  }
}

// FIFTH condition: at least one `@neuralis/*` alias must exist.
//
// Turbopack emits an alias per package it actually EXTERNALIZED. Before the
// builder compiled against real directories it emitted ZERO for our scope while every
// other check here passed — because every other check is about aliases that DO
// exist, so an entirely un-externalized first-party scope was invisible.
//
// Not every package earns an alias: one reached only through its `app/**` UI
// (workspace source by design) is never externalized. One is the floor.
const neuralisAliases = aliases.filter((a) => a.scope === '@neuralis');
if (neuralisAliases.length === 0) {
  failures.push(
    'no @neuralis/* aliases emitted — Turbopack did not externalize any first-party ' +
      'package, so they are bundled into the server chunks again. The builder must see ' +
      'REAL @neuralis/* directories (the deploy tree), not pnpm workspace symlinks.',
  );
}
console.log(`[externals] ${neuralisAliases.length} @neuralis/* alias(es) externalized`);

if (failures.length > 0) {
  console.error('[externals] FATAL — runtime externals are not reconcilable:');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}


console.log(`[externals] ok — ${retargeted}/${aliases.length} alias(es) retargeted at node_modules/`);

// A native addon that resolves but cannot LOAD (ABI mismatch, missing .so) is
// still a broken terminal. The file existing is not the claim — binding is.
// Imported by ABSOLUTE entry path so the check is independent of where this
// script is invoked from.
for (const name of Object.keys(REQUIRED_NATIVE_ARTIFACTS)) {
  const pkgDir = join(flatRoot, name);
  const main = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8')).main ?? 'index.js';
  try {
    await import(pathToFileURL(resolvePath(pkgDir, main)).href);
  } catch (err) {
    console.error(`[externals] FATAL: ${name} resolved but failed to load: ${err?.message ?? err}`);
    process.exit(1);
  }
  console.log(`[externals] ok — ${name} native binding loads`);
}
