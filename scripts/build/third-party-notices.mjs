#!/usr/bin/env node
/**
 * third-party-notices.mjs — the ONE writer of a shipped artifact's
 * `THIRD_PARTY_NOTICES.md`: every third-party component the artifact CONTAINS,
 * its licence, and the licence and NOTICE texts, deduplicated by hash.
 *
 *   node third-party-notices.mjs --title <artifact> --out <file> [--check]
 *        [--tree <node_modules>]… [--metafile <esbuild metafile>]…
 *        [--os apk <installed db>] [--binary <name>]… [--also <path>]…
 *   node third-party-notices.mjs --capture-apk-sources <installed db> --out <dir>
 *
 * Payload first, never a lockfile: `--tree` walks an installed node_modules,
 * `--metafile` reads the inputs an esbuild bundle really inlined (a bundled
 * devDependency is shipped code), `--os apk` reads an image's
 * `/lib/apk/db/installed`, and `--binary` adds a prebuilt upstream binary whose
 * licence texts are tracked under `third-party/upstream/`, pinned by version and
 * sha256 (`third-party/policy.json` → `binaries`).
 *
 * Fail closed: a component with no licence field, a licence id outside
 * `policy.allow`, a licence with no text (none in the package, no tracked SPDX
 * text, no `noText` row), a GPL-family component without the source offer, or a
 * tracked text whose sha256 drifted ends the run non-zero, naming the component.
 * Every exception is a `policy.json` row with its reason; an apk licence Alpine
 * labels `custom` passes only for a package `apkCustom` names. A binary row with
 * `versionOfApk` must match that apk package's version when both are read.
 * `--also` names the artifact's other notices files in the heading. `--check` re-collects
 * and compares with the file on disk: a component, a text or a NOTICE missing
 * from it, or any other byte difference, is red.
 *
 * `--capture-apk-sources` fetches, for every GPL-family origin of an apk
 * database, its APKBUILD at the recorded aports commit and every file its
 * sha512sums names (patches from aports, remote sources from Alpine's distfiles
 * cache), each verified against that hash, into `--out` (the ONE destination
 * parameter) with `SHA256SUMS` and `capture.json`. The APKBUILD is read, never run.
 *
 * First-party code is not third-party: `policy.firstParty` names it, and a
 * `private: true` package (a workspace or local folder package — the npm
 * registry never serves one) is the operator's own.
 */

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'third-party');

const LICENCE_FILE = /^(licen[cs]e|copying|copyright|unlicense)([._-].*)?$/i;
const NOTICE_FILE = /^notice([._-].*)?$/i;
const OPERATORS = new Set(['AND', 'OR', 'WITH', 'and', 'or', 'with']);
const GPL_FAMILY = /(^|[^A-Za-z])(A|L)?GPL-/;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** The tracked policy, with every tracked text read and its sha256 checked. */
export function loadPolicy(dir = DATA_DIR) {
  const policy = JSON.parse(readFileSync(join(dir, 'policy.json'), 'utf8'));
  // LF before the hash: a Windows checkout may hand the tracked texts over with CRLF.
  const read = (rel, want, what) => {
    const text = readFileSync(join(dir, rel), 'utf8').replace(/\r\n/g, '\n');
    if (sha256(text) !== want) throw new Error(`${what}: ${rel} does not match its pinned sha256 in policy.json`);
    return text;
  };
  policy.spdxTexts = Object.fromEntries(Object.entries(policy.spdx).map(([id, row]) => [id, read(row.file, row.sha256, `SPDX ${id}`)]));
  for (const [name, row] of Object.entries(policy.binaries)) {
    row.texts = row.files.map((f) => ({ label: f.label, text: read(f.file, f.sha256, `binary ${name}`), notice: NOTICE_FILE.test(basename(f.file)) }));
  }
  return policy;
}

/** The licence ids of an SPDX-like expression, after the policy's aliases (`Public Domain` → `Public-Domain`). */
export function licenceIds(expression, policy) {
  let expr = String(expression);
  for (const [from, to] of Object.entries(policy.aliases)) if (from.includes(' ')) expr = expr.split(from).join(to);
  return expr.split(/[\s()]+/).filter((t) => t && !OPERATORS.has(t)).map((t) => policy.aliases[t] ?? t);
}

function licenceOf(manifest) {
  if (typeof manifest.license === 'string') return manifest.license;
  if (manifest.license && typeof manifest.license.type === 'string') return manifest.license.type;
  if (Array.isArray(manifest.licenses)) return manifest.licenses.map((l) => (typeof l === 'string' ? l : l.type)).join(' OR ');
  return null;
}

function isFirstParty(manifest, policy) {
  if (manifest.private === true) return true;
  return policy.firstParty.some((p) => (p.endsWith('/*') ? manifest.name.startsWith(p.slice(0, -1)) : manifest.name === p));
}

function sourceOf(manifest) {
  const repo = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  return repo ?? (typeof manifest.homepage === 'string' ? manifest.homepage : null);
}

/** One npm package directory → a component, or null when it is first-party. */
function npmComponent(dir, policy) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (!manifest.name || !manifest.version || isFirstParty(manifest, policy)) return null;
  const texts = [];
  for (const name of readdirSync(dir).sort()) {
    if (!lstatSync(join(dir, name)).isFile()) continue;
    if (LICENCE_FILE.test(name)) texts.push({ label: name, text: readFileSync(join(dir, name), 'utf8') });
    else if (NOTICE_FILE.test(name)) texts.push({ label: name, text: readFileSync(join(dir, name), 'utf8'), notice: true });
  }
  const author = typeof manifest.author === 'string' ? manifest.author : manifest.author?.name;
  return { kind: 'npm', name: manifest.name, version: manifest.version, license: licenceOf(manifest), source: sourceOf(manifest), author: author ?? null, texts };
}

/** Every package of an installed node_modules tree (nested trees included; symlinks name a package already walked). */
export function collectTree(root, policy) {
  const out = [];
  const visit = (modules) => {
    for (const name of readdirSync(modules).sort()) {
      if (name.startsWith('.')) continue;
      const full = join(modules, name);
      if (!lstatSync(full).isDirectory()) continue;
      if (name.startsWith('@')) { visit(full); continue; }
      if (existsSync(join(full, 'package.json'))) {
        const c = npmComponent(full, policy);
        if (c) out.push(c);
      }
      if (existsSync(join(full, 'node_modules'))) visit(join(full, 'node_modules'));
    }
  };
  visit(root);
  return out;
}

/** The package root an esbuild input path sits in: up to the LAST `node_modules/<name>` (or `<@scope>/<name>`). */
export function packageRootOf(input) {
  const parts = input.split('/');
  const at = parts.lastIndexOf('node_modules');
  if (at < 0 || at + 1 >= parts.length) return null;
  const depth = parts[at + 1].startsWith('@') ? 3 : 2;
  return parts.slice(0, at + depth).join('/');
}

/**
 * Every package an esbuild bundle inlined. The metafile carries `base`: the
 * build's working directory relative to the metafile, which its input paths are relative to.
 */
export function collectMetafile(path, policy) {
  const meta = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof meta.base !== 'string' || !meta.inputs) throw new Error(`${path}: not a metafile with a "base" (the build's working directory)`);
  const base = resolve(dirname(path), meta.base);
  const roots = new Set();
  for (const input of Object.keys(meta.inputs)) {
    const root = packageRootOf(input.replace(/^[a-z-]+:/, ''));
    if (root) roots.add(resolve(base, root));
  }
  const out = [];
  for (const root of [...roots].sort()) {
    const c = npmComponent(root, policy);
    if (c) out.push(c);
  }
  return out;
}

/** `/lib/apk/db/installed` → its packages (P, V, L, o, c). */
export function parseApkDb(text) {
  return text.split(/\n\n+/).map((block) => {
    const row = {};
    for (const line of block.split('\n')) if (line[1] === ':' && 'PVLoc'.includes(line[0])) row[line[0]] = line.slice(2);
    return row;
  }).filter((row) => row.P);
}

export function collectApk(dbText, policy) {
  const byApk = new Map(Object.entries(policy.binaries).filter(([, b]) => b.apk).map(([name, b]) => [b.apk, { name, ...b }]));
  return parseApkDb(dbText).map((row) => {
    const pinned = byApk.get(row.P);
    if (pinned && pinned.license !== row.L) throw new Error(`apk ${row.P}: the installed licence "${row.L}" is not the pinned "${pinned.license}" (policy.json binaries.${pinned.name})`);
    // `custom` is Alpine's label for "the package's own terms": named per package, never as a class.
    const custom = licenceIds(row.L ?? '', policy).includes('custom') ? policy.apkCustom?.[row.P] : undefined;
    return {
      kind: 'apk', name: row.P, version: row.V, license: row.L || null,
      source: `Alpine aports, origin ${row.o}, commit ${row.c}`,
      texts: pinned ? pinned.texts.map((t) => ({ ...t, label: `${pinned.name} ${pinned.version}: ${t.label}` })) : [],
      textsFromSpdx: true,
      ...(custom ? { textFor: custom.spdx ? { custom: custom.spdx } : {}, noText: custom.spdx ? {} : { custom: custom.reason }, note: custom.spdx ? custom.reason : null } : {}),
    };
  });
}

export function binaryComponent(name, policy) {
  const b = policy.binaries[name];
  if (!b) throw new Error(`--binary ${name}: no row in policy.json binaries`);
  return { kind: 'binary', name: b.name, version: b.version, license: b.license, source: b.source, note: b.note ?? null, texts: b.texts };
}

/**
 * The licence texts a component ships with, completed from the tracked SPDX texts
 * where the component carries none; every failure is a sentence naming it.
 */
export function resolveTexts(component, policy) {
  const errors = [];
  const label = `${component.kind} ${component.name}@${component.version}`;
  if (!component.license) return { errors: [`${label}: no licence field`], texts: [] };
  const ids = licenceIds(component.license, policy);
  const noText = noTextOf(component, policy);
  const textFor = component.textFor ?? {};
  for (const id of ids) if (!policy.allow.includes(textFor[id] ?? id) && !(id in noText)) errors.push(`${label}: licence "${id}" is not in policy.json allow (and has no noText row)`);
  const texts = [...component.texts];
  const carriesLicence = texts.some((t) => !t.notice);
  if (!carriesLicence || component.textsFromSpdx) {
    for (const id of ids) {
      if (id in noText) continue;
      const spdx = policy.spdxTexts[textFor[id] ?? id];
      if (spdx) texts.push({ label: `${textFor[id] ? `${id} = ${textFor[id]}` : id} (SPDX reference text${component.author ? `; copyright holder per package.json: ${component.author}` : ''})`, text: spdx });
      else if (!carriesLicence) errors.push(`${label}: ships no licence file and policy.json has no SPDX text for "${id}"`);
    }
  }
  if (!texts.length && !ids.every((id) => id in noText)) errors.push(`${label}: no licence text`);
  if (GPL_FAMILY.test(component.license) && !(policy.sourceOffer && !/TODO/.test(policy.sourceOffer))) errors.push(`${label}: GPL-family licence and no source offer in policy.json`);
  return { errors, texts };
}

/** The policy's no-text reasons plus the component's own (an `apkCustom` row). */
function noTextOf(component, policy) {
  return { ...policy.noText, ...(component.noText ?? {}) };
}

/** A text as an indented block: no line of it can start a heading, so `^## ` counts the components. */
function indent(text) {
  return text.split('\n').map((line) => (line ? `    ${line}` : '')).join('\n');
}

const KIND_ORDER = { binary: 0, npm: 1, apk: 2 };

/** The notices file: one `## ` section per component, then each distinct text once. */
export function render(components, policy, title, also = []) {
  const errors = [];
  const seen = new Map();
  const unique = [];
  for (const c of components) {
    const key = `${c.kind}\0${c.name}\0${c.version}`;
    if (!seen.has(key)) { seen.set(key, true); unique.push(c); }
  }
  unique.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'));
  const textIds = new Map();
  const sections = [];
  let gpl = false;
  for (const c of unique) {
    const r = resolveTexts(c, policy);
    errors.push(...r.errors);
    if (GPL_FAMILY.test(c.license ?? '')) gpl = true;
    const refs = r.texts.map((t) => {
      const body = t.text.replace(/\r\n/g, '\n').trimEnd();
      const id = sha256(body).slice(0, 12);
      if (!textIds.has(id)) textIds.set(id, body);
      return `${t.label} → text ${id}`;
    });
    const reasons = noTextOf(c, policy);
    const noText = licenceIds(c.license ?? '', policy).filter((id) => id in reasons).map((id) => `${id}: ${reasons[id]}`);
    sections.push([
      `## ${c.name} ${c.version}`,
      '',
      `- Kind: ${c.kind}`,
      `- Licence: ${c.license}`,
      ...(c.source ? [`- Source: ${c.source}`] : []),
      ...(c.note ? [`- Note: ${c.note}`] : []),
      ...(GPL_FAMILY.test(c.license ?? '') ? ['- Source code: see the offer at the top of this file'] : []),
      ...refs.map((r) => `- ${r}`),
      ...noText.map((n) => `- ${n}`),
    ].join('\n'));
  }
  const head = [
    `# Third-party notices — ${title}`,
    '',
    `${title} contains the ${unique.length} third-party components listed below. Each section names a component, its licence as the component declares it, and the licence and notice texts it ships with; each distinct text is printed once, under "Texts", by the short hash the sections cite.`,
    ...(also.length ? ['', `The other third-party notices of the same artifact: ${also.join(', ')}.`] : []),
    ...(gpl ? ['', policy.sourceOffer] : []),
  ].join('\n');
  const texts = [...textIds].map(([id, body]) => `### text ${id}\n\n${indent(body)}`);
  return { errors, text: `${head}\n\n${sections.join('\n\n')}\n\n# Texts\n\n${texts.join('\n\n')}\n` };
}

/** What a notices file on disk is missing against freshly collected components (named, not just "differs"). */
export function missingFrom(onDisk, components, policy) {
  const missing = [];
  for (const c of components) {
    if (!onDisk.includes(`\n## ${c.name} ${c.version}\n`)) { missing.push(`${c.kind} ${c.name}@${c.version}: no section`); continue; }
    for (const t of resolveTexts(c, policy).texts) {
      const id = sha256(t.text.replace(/\r\n/g, '\n').trimEnd()).slice(0, 12);
      if (!onDisk.includes(`### text ${id}\n`)) missing.push(`${c.kind} ${c.name}@${c.version}: ${t.notice ? 'NOTICE' : 'licence'} text ${t.label} (${id}) not carried`);
    }
  }
  return missing;
}

/** The component sections of a notices file (its texts are indented, so no text line counts). */
export function countComponents(text) {
  return (text.match(/^## /gm) ?? []).length;
}

/** The notices of every component the flags name, or the policy failures; the one entry point of every build hook. */
export function writeNotices(args) {
  const policy = loadPolicy();
  const { errors, text } = render(collect(args, policy), policy, args.title, args.also);
  if (errors.length) throw new Error(`${errors.length} third-party component(s) fail the licence policy (neuralis/scripts/build/third-party/policy.json):\n  ${errors.join('\n  ')}`);
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, text);
  return { components: countComponents(text), bytes: Buffer.byteLength(text) };
}

/** Collect every component the flags name. */
export function collect(args, policy) {
  const components = [];
  for (const dir of args.tree) components.push(...collectTree(dir, policy));
  for (const file of args.metafile) components.push(...collectMetafile(file, policy));
  if (args.apk) components.push(...collectApk(readFileSync(args.apk, 'utf8'), policy));
  for (const name of args.binary) {
    const b = binaryComponent(name, policy);
    const apk = args.apk && policy.binaries[name].versionOfApk ? components.find((c) => c.kind === 'apk' && c.name === policy.binaries[name].versionOfApk) : null;
    if (apk && !apk.version.startsWith(`${b.version}-`)) throw new Error(`--binary ${name}: policy.json pins ${b.version}, the image's apk ${apk.name} is ${apk.version}`);
    components.push(b);
  }
  return components;
}

// ── apk source capture ─────────────────────────────────────────────

/** Alpine's own aports mirror on GitHub: the same commits, served to a script (the GitLab front refuses non-browser clients). */
const APORTS = 'https://raw.githubusercontent.com/alpinelinux/aports';
const DISTFILES = 'https://distfiles.alpinelinux.org/distfiles';

async function fetchBytes(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * An APKBUILD's `sha512sums` block: every source file by name, with its hash. Read as
 * TEXT — the APKBUILD is never executed — since `abuild checksum` writes the literal
 * file names, the remote sources' included.
 */
export function apkbuildSha512sums(text) {
  const block = /^sha512sums="([^"]*)"/m.exec(text);
  if (!block) throw new Error('no sha512sums block');
  const sums = new Map();
  for (const line of block[1].split('\n')) {
    const m = /^\s*([a-f0-9]{128})\s+(\S+)\s*$/.exec(line);
    if (m) sums.set(m[2], m[1]);
    else if (line.trim()) throw new Error(`sha512sums line not read: ${line.trim()}`);
  }
  if (!sums.size) throw new Error('an empty sha512sums block');
  return sums;
}

export async function captureApkSources(dbText, out) {
  const rows = parseApkDb(dbText);
  const release = rows.find((row) => row.P === 'alpine-release');
  if (!release) throw new Error('the apk database has no alpine-release package: no Alpine branch to read the distfiles of');
  const distfiles = `${DISTFILES}/v${release.V.split('.').slice(0, 2).join('.')}`;
  const origins = new Map();
  for (const row of rows) if (GPL_FAMILY.test(row.L ?? '')) origins.set(row.o, { commit: row.c, version: row.V });
  mkdirSync(out, { recursive: true });
  const record = [];
  const sums = [];
  for (const [origin, { commit, version }] of [...origins].sort()) {
    let apkbuild = null;
    let repo = null;
    for (const r of ['main', 'community']) {
      try { apkbuild = (await fetchBytes(`${APORTS}/${commit}/${r}/${origin}/APKBUILD`)).toString('utf8'); repo = r; break; } catch { /* the other repository holds it */ }
    }
    if (!apkbuild) throw new Error(`${origin}: no APKBUILD at aports ${commit} in main or community`);
    const dir = join(out, `${origin}-${version}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'APKBUILD'), apkbuild);
    const files = [{ name: 'APKBUILD', bytes: Buffer.byteLength(apkbuild), sha256: sha256(apkbuild) }];
    for (const [name, want] of apkbuildSha512sums(apkbuild)) {
      // A patch or config file sits beside the APKBUILD at the commit; a remote source is in
      // Alpine's distfiles cache of the branch (every source its builders fetched).
      let bytes;
      try { bytes = await fetchBytes(`${APORTS}/${commit}/${repo}/${origin}/${name}`); } catch { bytes = await fetchBytes(`${distfiles}/${name}`); }
      if (createHash('sha512').update(bytes).digest('hex') !== want) throw new Error(`${origin}: ${name} does not match the APKBUILD sha512sums`);
      writeFileSync(join(dir, name), bytes);
      files.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    for (const f of files) sums.push(`${f.sha256}  ${basename(dir)}/${f.name}`);
    record.push({ origin, version, repo, commit, files });
  }
  const bytes = record.reduce((n, r) => n + r.files.reduce((m, f) => m + f.bytes, 0), 0);
  writeFileSync(join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  writeFileSync(join(out, 'capture.json'), `${JSON.stringify({ origins: record.length, bytes, packages: record }, null, 2)}\n`);
  return { origins: record.length, bytes };
}

// ── command line ───────────────────────────────────────────────────

export function parseArgs(argv) {
  const args = { tree: [], metafile: [], binary: [], also: [], apk: null, title: null, out: null, check: false, capture: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => { const v = argv[++i]; if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value`); return v; };
    if (flag === '--tree') args.tree.push(resolve(value()));
    else if (flag === '--metafile') args.metafile.push(resolve(value()));
    else if (flag === '--binary') args.binary.push(value());
    else if (flag === '--also') args.also.push(value());
    else if (flag === '--os') { if (value() !== 'apk') throw new Error('--os: only "apk" is read'); args.apk = resolve(value()); }
    else if (flag === '--title') args.title = value();
    else if (flag === '--out') args.out = resolve(value());
    else if (flag === '--check') args.check = true;
    else if (flag === '--capture-apk-sources') args.capture = resolve(value());
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!args.out) throw new Error('--out is required');
  if (!args.capture && !args.title) throw new Error('--title is required');
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.capture) {
    const r = await captureApkSources(readFileSync(args.capture, 'utf8'), args.out);
    console.log(`[notices] captured the sources of ${r.origins} GPL-family origins: ${r.bytes} bytes in ${args.out}`);
    return 0;
  }
  const where = args.out.split(sep).slice(-2).join('/');
  if (!args.check) {
    const r = writeNotices(args);
    console.log(`[notices] ${where}: ${r.components} components, ${r.bytes} bytes`);
    return 0;
  }
  const policy = loadPolicy();
  const components = collect(args, policy);
  const { errors, text } = render(components, policy, args.title, args.also);
  const onDisk = existsSync(args.out) ? readFileSync(args.out, 'utf8') : '';
  const missing = [...errors, ...missingFrom(onDisk, components, policy)];
  if (missing.length || onDisk !== text) {
    console.error(`[notices] ${where} is not the notices of the collected components:\n  ${missing.length ? missing.join('\n  ') : 'stale: same components, other bytes — regenerate it'}`);
    return 1;
  }
  console.log(`[notices] ${where}: ${countComponents(text)} components, current`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    console.error(`[notices] FATAL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
