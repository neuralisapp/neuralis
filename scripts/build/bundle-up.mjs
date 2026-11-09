#!/usr/bin/env node
/**
 * bundle-up.mjs — the desktop app's resident supervisor (`neuralis up`, with
 * its `down` and `status`) precompiled into ONE ES module, which
 * `bin/neuralis.mjs` imports on the desktop bundle instead of registering tsx:
 * the process that holds the data home for as long as the app runs carries no
 * TypeScript compiler and no esbuild service child. `up.mts` stays the one source.
 *
 *   node scripts/build/bundle-up.mjs <host package dir> <tree out>
 *
 * The entry is the command registry itself (`scripts/cli/registry.mts`, the ONE
 * dispatch), written to `<out>/scripts/cli/up.mjs` — the registry's own depth,
 * so its `import.meta.url`-derived package folder and every relative specifier
 * left external name the same files the sources do. Bundled: the registry and
 * the closure of the `up` module. External: every package (resolved from the
 * tree's `node_modules` at run time), every `.mjs` helper (plain JS, and
 * `build-workspace.mjs` runs its own command line when `argv[1]` is the module
 * it sits in — inside a bundle that is this file), and the registry's other
 * verbs, which the bin never routes here. After the build every external `.mjs`
 * specifier must name a file of the tree.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Where the bundle lands, relative to the host tree (`bin/neuralis.mjs` names the same path). */
export const UP_BUNDLE = join('scripts', 'cli', 'up.mjs');

const UP_MODULE = '../up.mts';

/** Bundle the registry with `up` into `<out>/scripts/cli/up.mjs`; its size in bytes. */
export async function bundleUp(app, out) {
  const { build } = await import('esbuild');
  const outfile = join(out, UP_BUNDLE);
  mkdirSync(dirname(outfile), { recursive: true });
  const registry = join(app, 'scripts', 'cli', 'registry.mts');
  const result = await build({
    entryPoints: [registry],
    outfile,
    absWorkingDir: app,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    metafile: true,
    logLevel: 'warning',
    legalComments: 'none',
    plugins: [{
      name: 'up-only',
      setup(b) {
        b.onResolve({ filter: /\.mjs$/ }, (args) => ({ path: args.path, external: true }));
        b.onResolve({ filter: /\.mts$/ }, (args) => (
          args.kind === 'dynamic-import' && resolve(args.importer) === resolve(registry) && args.path !== UP_MODULE
            ? { path: args.path, external: true }
            : undefined
        ));
      },
    }],
  });
  const output = Object.entries(result.metafile.outputs)[0][1];
  if (!output.exports.includes('main')) throw new Error(`${UP_BUNDLE} exports no \`main\` — ${registry} is not the command registry`);
  const missing = output.imports
    .filter((i) => i.external && i.path.startsWith('.') && i.path.endsWith('.mjs'))
    .map((i) => i.path)
    .filter((path) => !existsSync(resolve(dirname(outfile), path)));
  if (missing.length > 0) throw new Error(`${UP_BUNDLE} imports ${missing.join(', ')}, which the tree does not carry`);
  return output.bytes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [app, out] = process.argv.slice(2);
  if (!app || !out) {
    console.error('Usage: node scripts/build/bundle-up.mjs <host package dir> <tree out>');
    process.exit(1);
  }
  try {
    const bytes = await bundleUp(resolve(app), resolve(out));
    console.log(`[up] ${UP_BUNDLE} ${bytes} B`);
  } catch (err) {
    console.error(`[up] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
