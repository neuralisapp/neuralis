#!/usr/bin/env node
/**
 * treeDigest.mjs — the ONE content digest of a package's shipped `dist/`.
 *
 * "Is the container running the code I just built?" is answered by comparing a
 * host-side digest against a container-side one, so the two must be the same
 * algorithm. They used to be two files kept in step by a comment that said
 * "must match exactly" — which is a wish, not a mechanism. This module is the
 * single implementation: `neuralis:sync` imports it for the host side and copies
 * this same file into the container to compute the other side.
 *
 * Computing the container side LIVE, rather than reading a value stamped at
 * image build, is also what makes the answer stay true: a stamped digest goes
 * stale the moment a sync swaps a package, and would report a freshly synced
 * package as still diverged.
 *
 * Paths are hashed alongside bytes — a bytes-only hash calls a rename identical.
 *
 * CLI:  node treeDigest.mjs <node_modules-root>   → JSON, every package that has
 *                                                   a `neuralis` manifest block
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Every file under `dir`, absolute and sorted — the digest must be stable. */
function walkSorted(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) stack.push(full);
      else out.push(full);
    }
  }
  return out.sort();
}

// Glob → RegExp. A doubled star spans directories, a single star does not.
// (Written as a line comment on purpose: the patterns this handles contain the
// sequence that would close a block comment early.)
function globToRegExp(pattern) {
  const escaped = pattern
    .split('')
    .map((ch) => ('\\^$+?.()|[]{}'.includes(ch) ? `\\${ch}` : ch))
    .join('')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .split('\u0000')
    .join('(?:.*/)?')
    .split('\u0001')
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * The files a package actually SHIPS, derived from its `files` whitelist.
 *
 * This used to be `dist/` alone, and that was wrong in the direction that
 * matters: `neuralis:sync` swaps the whole packed tarball, so a change to a
 * skill, a tool schema, a workflow template or a rule ships — while the digest
 * comparing host against container saw only compiled output and reported
 * "Nothing to sync". MEASURED before the fix: appending a line to a shipped
 * SKILL.md left the digest byte-identical. For a package author editing prose,
 * which is most of what a package IS, the tool silently did nothing.
 *
 * Both sides run this same function over their own tree — the host over the
 * source directory, the container over the installed one, which is that tarball
 * extracted — so they agree exactly when the content agrees.
 */
export function shippedFiles(pkgDir) {
  const manifest = readManifest(pkgDir);
  const declared = Array.isArray(manifest?.files) ? manifest.files : [];
  if (declared.length === 0) return null;

  const denies = declared.filter((f) => f.startsWith('!')).map((f) => globToRegExp(f.slice(1)));
  const collected = new Set();

  const add = (absolute) => {
    const rel = relative(pkgDir, absolute).split('\\').join('/');
    if (rel.startsWith('node_modules/') || rel.includes('/node_modules/')) return;
    if (denies.some((re) => re.test(rel))) return;
    collected.add(rel);
  };

  // npm ships these regardless of the whitelist.
  //
  // `package.json` is deliberately NOT among them. It cannot match across the
  // two sides by construction: an install writes a transformed copy of the
  // source manifest (the deploy rewrites workspace and local dependency specs),
  // so it was MEASURED as the single differing file out of 122 for machine-core.
  // Including it would report every package as permanently diverged, which is a
  // louder way of saying nothing. Version drift stays visible: the digest record
  // carries `version` beside the hash.
  for (const always of ['README.md', 'LICENSE']) {
    if (existsSync(join(pkgDir, always))) add(join(pkgDir, always));
  }

  for (const entry of declared) {
    if (entry.startsWith('!')) continue;
    const isGlob = /[*?]/.test(entry);
    // A glob entry is walked from its literal prefix directory and then FILTERED
    // by the pattern itself. Walking the prefix alone is not enough and was
    // measured wrong: `agents/**/*.md` would otherwise pull in every `.ts` file
    // under `agents/`, and the host counted 1952 shipped files against the
    // container's 1941 — permanent divergence for one package, from a filter the
    // surrounding comment claimed was applied and was not.
    const include = isGlob ? globToRegExp(entry) : null;
    const literal = entry.split(/[*?]/)[0].replace(/\/+$/, '');
    const target = join(pkgDir, literal);
    if (!existsSync(target)) continue;
    const accept = (absolute) => {
      if (include && !include.test(relative(pkgDir, absolute).split('\\').join('/'))) return;
      add(absolute);
    };
    if (statSync(target).isDirectory()) {
      for (const file of walkSorted(target)) accept(file);
    } else {
      accept(target);
    }
  }

  return [...collected].sort();
}

/**
 * Content-addressed digest of everything the package ships, or null when the
 * manifest declares no `files` whitelist (which `neuralis:sync` refuses anyway).
 *
 * Hashes PATHS as well as bytes — a bytes-only hash calls a rename identical.
 */
export function treeDigest(pkgDir) {
  const files = shippedFiles(pkgDir);
  if (files === null || files.length === 0) return null;
  return digestFiles(pkgDir, files).slice(0, 16);
}

/**
 * Full sha256 over EVERY file under `dir` (relative path + bytes, sorted) — the
 * same content addressing as {@link treeDigest}, for a directory that is not a
 * package (a Docker build context whose image is labelled with it).
 */
export function sha256Dir(dir) {
  return digestFiles(dir, walkSorted(dir).map((full) => relative(dir, full)));
}

/** The ONE hashing loop: path, NUL, bytes, NUL — a bytes-only hash calls a rename identical. */
function digestFiles(root, rels) {
  const hash = createHash('sha256');
  for (const rel of rels) {
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(join(root, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** Read a package manifest, or null when the directory is not a package. */
function readManifest(pkgDir) {
  const path = join(pkgDir, 'package.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Digest every BUILTIN-CLASS package under a node_modules root — that is, every
 * one whose own manifest carries a `neuralis` block, whatever its scope. Keying
 * on the manifest rather than on `@neuralis/*` is what lets an operator's own
 * first-party package take part; the scope is not the authorization boundary,
 * presence in the host's dependencies is.
 */
export function digestInstalledPackages(nodeModulesRoot) {
  const out = {};
  if (!existsSync(nodeModulesRoot)) return out;
  for (const entry of readdirSync(nodeModulesRoot).sort()) {
    if (entry === '.bin' || entry === '.package-lock.json') continue;
    const full = join(nodeModulesRoot, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const candidates = entry.startsWith('@')
      ? readdirSync(full).sort().map((scoped) => [`${entry}/${scoped}`, join(full, scoped)])
      : [[entry, full]];

    for (const [name, dir] of candidates) {
      const manifest = readManifest(dir);
      if (!manifest?.neuralis) continue;
      out[name] = { version: manifest.version ?? null, treeDigest: treeDigest(dir) };
    }
  }
  return out;
}

// CLI mode — this is how the container side is computed.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  if (!root) {
    console.error('usage: treeDigest.mjs <node_modules-root>');
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(digestInstalledPackages(root))}\n`);
}
