#!/usr/bin/env node
/**
 * Pre-publish tarball audit: what would actually reach the public registry.
 *
 * `npm publish` is irreversible in the way that matters — the content is
 * public and immutable the moment it lands. This packs every shippable package
 * with `--dry-run` and reads the resulting FILE LIST plus the contents of the
 * text files in it, refusing on:
 *
 *   - missing declared UI entries, stylesheets or the kernel build record,
 *   - secret-shaped files (.env, keys, certs, credential stores),
 *   - private-tree paths (plans/, docs/architect/, the private ecom package),
 *   - internal plan codenames appearing in shipped prose (`--strict` only),
 *   - machine-absolute paths (the checkout, the home directory, every
 *     `--forbid-root`) and private identifiers (every `--forbid-text`),
 *   - anything under a path we never intend to ship.
 *
 * It is deliberately a SEPARATE gate from the per-package `files` whitelist
 * tests: those assert that what we meant to ship is present, this asserts that
 * nothing else is.
 *
 * `--tarballs <dir>` audits READY tarballs instead (the `pnpm pack` output the
 * release workflow publishes byte for byte): the same path and content checks
 * on the extracted files, plus the packed `package.json` — a `workspace:`,
 * `file:` or `link:` specifier left in it installs nowhere, and only a real
 * pack shows it (the dry-run list reads the workspace manifest). The directory
 * must hold exactly one tarball per publishable package.
 *
 *   node neuralis/scripts/build/audit-publish-tarballs.mjs [--strict] [--tarballs <dir>]
 *        [--forbid-root <abs path>[:<abs path>…]]… [--forbid-text <text>]…
 *
 * A runner knows only its own checkout and home, so a release passes the
 * developer machines' roots and the private repository's name explicitly.
 * The forbidden-path list and the content markers are exported: the
 * public-tree allowlist check applies the same ones to the released host tree.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { delimiter, dirname, extname, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const PACKAGES = [
  'packages/package-system',
  'packages/agent-core',
  'packages/brain-core',
  'packages/admin',
  'packages/machine-core',
  'neuralis',
  'create-neuralis',
];

/** Never in a tarball or the public host tree, whatever the whitelist says. */
export const FORBIDDEN_PATHS = [
  // `.env` and every real variant — but NOT `.env.example`, which is a
  // deliberately shipped template with no values in it.
  /(^|\/)\.env$/i,
  /(^|\/)\.env\.(?!example$)[\w.-]+$/i,
  /(^|\/)\.npmrc$/,
  /\.(pem|key|p12|pfx|crt|cer)$/i,
  // The credential STORE, not source directories that happen to be named
  // `credentials/` (agent-core and admin both ship such a module).
  /(^|\/)\.neuralis\/credentials\//i,
  /^credentials\//i,
  /(^|\/)\.neuralis\//,
  /(^|\/)plans\//,
  /(^|\/)docs\/architect\//,
  /(^|\/)\.claude\//,
  /(^|\/)docker-compose(\.[\w-]+)?\.ya?ml$/,
  /(^|\/)node_modules\//,
  /(^|\/)\.next\//,
  // The runtime data zone at the package ROOT — not a `data/` source module
  // (package-system ships `dist/src/data/`).
  /^data\//,
];

/** The forbidden-path reason for one packed or released path, or null. */
export function forbiddenPathReason(file) {
  if (FORBIDDEN_PATHS.some((pattern) => pattern.test(file))) return 'forbidden path';
  if (/(^|\/)ecom(\/|$)/i.test(file)) return 'private ecom content';
  return null;
}

/**
 * Internal increment codenames.
 *
 * These are checked under `--strict` only, and that is a deliberate scoping
 * decision rather than laziness. The names sit in source COMMENTS of the host,
 * which ships as full TypeScript source on two of the three channels (a
 * forkable host was always the intent), and in the packages' shipped files. They
 * leak internal vocabulary, not information: no roadmap, no unreleased
 * capability, no security gap. The public repository receives a history-free
 * snapshot of the host tree per release, so commit messages never reach it; the
 * comment sites are the whole exposure, and sweeping them is its own docs task
 * rather than a release gate.
 *
 * What the DEFAULT run refuses is the material set: secrets, private-tree
 * paths, the private commerce package's content, and absolute paths from the
 * build machine. Run with `--strict` to see the current codename inventory.
 */
const CODENAMES = [
  'wave1-closeout',
  'periodic-pelican',
  'tunable-tanager',
  'crystalline-lagoon',
  'omnivorous-magpie',
  'lean-forge-lynx',
  'steadfast-albatross',
  'glittery-candy',
  'brisk-kingfisher',
  'featherweight-flamingo',
  'native-nightjar',
  'warded-bailey',
  'effervescent-finding-fiddle',
];

const TEXT_EXT = new Set(['.md', '.mdx', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.txt', '.yaml', '.yml']);

const c = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', green: '\x1b[32m', red: '\x1b[31m', cyan: '\x1b[36m' };

/** A dependency specifier only a workspace or this machine can resolve. */
const NON_REGISTRY_SPEC = /^(workspace|file|link):/;
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

function packlist(dir) {
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    // The prepack guard refuses to pack while a machine-local dep exists; this
    // audit needs the real byte content on a dev machine.
    env: { ...process.env, NEURALIS_PACK_AUDIT: '1' },
  });
  return JSON.parse(out)[0].files.map((f) => f.path);
}

/** Every file under `root`, as `/`-separated paths relative to it. */
function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else out.push(relative(root, full).split('\\').join('/'));
    }
  }
  return out.sort();
}

/**
 * Machine roots a published file must never name: the checkout, the home
 * directory, and every extra root (a release names the developer machines'
 * roots, which a runner cannot know). A root counts only when it is absolute
 * and at least two segments deep — `/root` alone would match prose.
 */
export function machineRoots(extra = []) {
  const candidates = [REPO_ROOT, homedir(), ...extra];
  return [...new Set(candidates.map((root) => resolve(root).replace(/\/+$/, '')))].filter(
    (root) => root.startsWith('/') && root.split('/').filter(Boolean).length >= 2,
  );
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Content markers no published file may carry: each machine root (as a path
 * prefix) and each private text (case-insensitive — the private repository's
 * `owner/name`, for instance).
 */
export function privateMarkers({ roots, texts = [] }) {
  return [
    ...roots.map((root) => ({ what: `the machine-absolute path ${root}`, pattern: new RegExp(`${escapeRegExp(root)}(?![\\w.-])`) })),
    ...texts.filter(Boolean).map((text) => ({ what: `the private identifier "${text}"`, pattern: new RegExp(escapeRegExp(text), 'i') })),
  ];
}

/** Read the text files of a file list from `baseDir` (a package dir or an extracted tarball). */
function scanContents(label, baseDir, files, findings, opts) {
  for (const rel of files) {
    if (!TEXT_EXT.has(extname(rel))) continue;
    const abs = join(baseDir, rel);
    if (!existsSync(abs) || statSync(abs).size > 2 * 1024 * 1024) continue;
    const content = readFileSync(abs, 'utf8');
    if (opts.strict) {
      for (const codename of CODENAMES) {
        if (content.toLowerCase().includes(codename)) {
          findings.push(`${label}: ${rel}: internal codename "${codename}" in shipped content`);
        }
      }
    }
    for (const { what, pattern } of opts.markers) {
      if (!pattern.test(content)) continue;
      // A machine-local dep line is the usual cause of a path in the manifest and has its own fix.
      const hint = rel === 'package.json' && what.startsWith('the machine')
        ? ' — a machine-local (file:/link:) dependency; remove it before publishing'
        : '';
      findings.push(`${label}: ${rel}: contains ${what}${hint}`);
    }
  }
}

function pathFindings(label, files, findings) {
  for (const file of files) {
    const reason = forbiddenPathReason(file);
    if (reason) findings.push(`${label}: ${reason} in tarball — ${file}`);
  }
}

/** The npm-pack dry-run lists of the workspace trees (the default mode). */
function uiModuleFindings(label, manifest, files, findings) {
  const module = manifest.neuralis?.app?.module;
  if (!module) return;
  if (typeof module.entry !== 'string') {
    findings.push(`${label}: app.module has no entry`);
    return;
  }
  // Resolve the kernel's record name only on the packaging lane. The public
  // snapshot auditor imports this module without installing the workspace.
  const { UI_MODULE_RECORD_FILE } = createRequire(import.meta.url)('@neuralis/package-system/client/shared-modules');
  if (module.css !== undefined && typeof module.css !== 'string') {
    findings.push(`${label}: app.module css is not a path`);
    return;
  }
  const required = [module.entry, posix.join(posix.dirname(module.entry), UI_MODULE_RECORD_FILE), ...(module.css ? [module.css] : [])];
  for (const path of required) {
    if (!files.includes(path.replace(/^\.\//, ''))) findings.push(`${label}: missing declared UI artifact ${path}`);
  }
}

function auditWorkspaceTrees(findings, opts) {
  let total = 0;
  for (const rel of PACKAGES) {
    const dir = join(REPO_ROOT, rel);
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const before = findings.length;
    const files = packlist(dir);
    total += files.length;
    uiModuleFindings(rel, manifest, files, findings);
    pathFindings(rel, files, findings);
    scanContents(rel, dir, files, findings, opts);
    report(`${manifest.name}@${manifest.version}`, files.length, findings.length - before);
  }
  return total;
}

/** Ready `pnpm pack` tarballs: exactly one per publishable package. */
function auditTarballs(dir, findings, opts) {
  const expected = new Set(PACKAGES.map((rel) => JSON.parse(readFileSync(join(REPO_ROOT, rel, 'package.json'), 'utf8')).name));
  const tarballs = readdirSync(dir).filter((name) => name.endsWith('.tgz')).sort();
  const seen = new Set();
  let total = 0;
  for (const name of tarballs) {
    const scratch = mkdtempSync(join(tmpdir(), 'neuralis-tarball-audit-'));
    try {
      execFileSync('tar', ['-xzf', join(dir, name), '-C', scratch]);
      const root = join(scratch, 'package');
      if (!existsSync(join(root, 'package.json'))) {
        findings.push(`${name}: no package/package.json — not an npm tarball`);
        continue;
      }
      const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      const before = findings.length;
      if (!expected.has(manifest.name)) findings.push(`${name}: ${manifest.name} is not a publishable package of this repository`);
      if (seen.has(manifest.name)) findings.push(`${name}: a second tarball for ${manifest.name}`);
      seen.add(manifest.name);
      for (const field of DEPENDENCY_FIELDS) {
        for (const [dep, spec] of Object.entries(manifest[field] ?? {})) {
          if (typeof spec === 'string' && NON_REGISTRY_SPEC.test(spec)) {
            findings.push(`${name}: ${field}.${dep} is "${spec}" — the packed manifest must name a registry version`);
          }
        }
      }
      const files = walkFiles(root);
      total += files.length;
      uiModuleFindings(name, manifest, files, findings);
      pathFindings(name, files, findings);
      scanContents(name, root, files, findings, opts);
      report(`${manifest.name}@${manifest.version} (${name})`, files.length, findings.length - before);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  for (const pkg of expected) {
    if (!seen.has(pkg)) findings.push(`${pkg}: no tarball in ${dir}`);
  }
  return total;
}

function report(label, fileCount, newFindings) {
  const status = newFindings === 0 ? `${c.green}clean${c.reset}` : `${c.red}${newFindings} finding(s)${c.reset}`;
  console.log(`  ${label} — ${fileCount} files — ${status}`);
}

const USAGE = 'usage: audit-publish-tarballs.mjs [--strict] [--tarballs <existing dir>] [--forbid-root <abs path>[:<abs path>…]]… [--forbid-text <text>]…';

function usage() {
  console.error(USAGE);
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { strict: false, tarballDir: null, roots: [], texts: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--strict') { opts.strict = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) usage();
    if (flag === '--tarballs') opts.tarballDir = value;
    else if (flag === '--forbid-root') opts.roots.push(...value.split(delimiter).filter(Boolean));
    else if (flag === '--forbid-text') opts.texts.push(value);
    else usage();
    i += 1;
  }
  if (opts.tarballDir !== null && !existsSync(opts.tarballDir)) usage();
  return opts;
}

function main(argv) {
  const args = parseArgs(argv);
  const roots = machineRoots(args.roots);
  const opts = { strict: args.strict, markers: privateMarkers({ roots, texts: args.texts }) };
  const findings = [];
  const mode = args.tarballDir ? ` from ${args.tarballDir}` : '';
  console.log(`${c.bold}Auditing ${PACKAGES.length} publishable packages${mode}${c.reset}${args.strict ? c.dim + ' (strict: + internal codenames)' + c.reset : ''}`);
  console.log(`${c.dim}content markers: ${roots.length} machine root(s), ${args.texts.length} private text(s)${c.reset}\n`);
  const total = args.tarballDir ? auditTarballs(resolve(args.tarballDir), findings, opts) : auditWorkspaceTrees(findings, opts);

  console.log('');
  if (findings.length > 0) {
    console.error(`${c.red}${c.bold}✗ ${findings.length} finding(s) — these would be public and immutable:${c.reset}`);
    for (const finding of findings) console.error(`  ${finding}`);
    process.exit(1);
  }
  const checked = args.strict ? 'no secrets, private paths, machine paths, private identifiers or codenames' : 'no secrets, private paths, machine paths or private identifiers';
  console.log(`${c.green}${c.bold}✓ ${total} packed files across ${PACKAGES.length} packages — ${checked}${c.reset}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
