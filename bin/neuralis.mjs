#!/usr/bin/env node
// `neuralis <verb>` — the operator command line of a Neuralis install.
//
// Plain ESM with no TypeScript of its own: it registers tsx from wherever the
// module resolver finds it next to THIS file (hoisted into an install folder's
// `node_modules`, the monorepo's pnpm store, the image's deployed tree — never
// the working directory), then hands the arguments to the one registry.
//
// Node.js 26 or newer, refused by name below it (npm only WARNS on `engines`):
// the release's floor, the same in both packages' `engines`. It is a decision,
// not a measured break — the verbs tried run on Node 22 and 24 — and lowering it
// needs a suite run on the lower line as its proof.
//
// The ESM hook is taken from tsx's ESM build (`import.meta.resolve`): resolving
// it with `require.resolve` picks the CommonJS build. Both hooks are registered
// (the host package is not `type: module`, so its `.ts` sources load as
// CommonJS), and tsx is pointed at the host's own tsconfig for its compile
// options: it would otherwise look in the working directory, which in an
// install folder holds none.
//
// The host's `@/` import alias (tsconfig `paths`: `@/*` → `./src/*`) is resolved
// HERE, by one synchronous resolve hook that covers `require` and `import`
// alike, and only for an importer inside this package (never one of its own
// `node_modules`). tsx applies tsconfig `paths` to no file under `node_modules`,
// which is exactly where the host lives in an npm install folder
// (`<folder>/node_modules/neuralis`), so without the hook every verb that
// reaches `src/` fails with `Cannot find module '@/…'`. The alias becomes a
// RELATIVE specifier, so tsx still picks the `.ts` file or the `index.ts`.
import { existsSync } from 'node:fs';
import nodeModule from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NODE_MAJOR_FLOOR = 26;
const INSTALL_HELP = 'https://docs.neuralisapp.com/getting-started/installation#if-something-fails';
const REPORT_ISSUE = 'https://github.com/neuralisapp/neuralis/issues/new';
const major = Number(process.versions.node.split('.')[0]);
if (!(major >= NODE_MAJOR_FLOOR)) {
  console.error(`✗ Neuralis needs Node.js ${NODE_MAJOR_FLOOR} or newer (found ${process.versions.node}).`);
  console.error(`  Help: ${INSTALL_HELP} · report a failed install: ${REPORT_ISSUE}`);
  process.exit(1);
}

const require = nodeModule.createRequire(import.meta.url);
const hostRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const hostRootUrl = pathToFileURL(hostRoot + sep).href;
const hostSrc = join(hostRoot, 'src');

/** `@/x` from a file of this package → the relative specifier of `<host>/src/x`, else unchanged. */
function hostAliasSpecifier(specifier, parentURL) {
  if (!specifier.startsWith('@/') || !parentURL?.startsWith(hostRootUrl)) return specifier;
  if (parentURL.slice(hostRootUrl.length).includes('node_modules/')) return specifier;
  const rel = relative(dirname(fileURLToPath(parentURL)), join(hostSrc, specifier.slice(2))).split(sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

nodeModule.registerHooks({
  resolve: (specifier, context, nextResolve) => nextResolve(hostAliasSpecifier(specifier, context.parentURL), context),
});

const tsconfig = join(hostRoot, 'tsconfig.json');
if (!process.env.TSX_TSCONFIG_PATH && existsSync(tsconfig)) process.env.TSX_TSCONFIG_PATH = tsconfig;
let tsxEsm;
try {
  tsxEsm = import.meta.resolve('tsx/esm/api');
} catch {
  console.error(`✗ The Neuralis host's dependencies are not installed: run \`npm install\` in ${hostRoot} first.`);
  process.exit(1);
}
const { register } = await import(tsxEsm);
register();
require('tsx/cjs/api').register();
const { main } = await import('../scripts/cli/registry.mts');
process.exit(await main(process.argv.slice(2)));
