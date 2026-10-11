/**
 * How the operator spells a `neuralis` verb on THIS install — the one source of
 * every command a script prints (help, usage, a refusal's fix, a next step).
 *
 *   folder     an npm install folder (`package.json` depends on `neuralis`)  `npx neuralis <verb>`
 *   clone      a clone of the public host repository (`.git`, no workspace)   `npx neuralis <verb>` (npx runs the package's own bin)
 *   monorepo   the development checkout (a pnpm workspace around the code)    `pnpm neuralis:<verb>`
 *   container  inside the image (`/.dockerenv`)                               `node bin/neuralis.mjs <verb>`
 *   host-tree  the host package with none of the above (an unpacked tree)     `node bin/neuralis.mjs <verb>`
 *
 * Text written INTO a generated file (a compose header, an override comment, an
 * `.env` note) is read later, possibly from another channel, and says
 * `neuralis <verb>` instead, as a literal.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { detectChannel } from '../setup/discoverPackages.mts';
import { PACKAGE_DIR, resolveInstallDir, type CliContext } from './registry.mts';

export type InstallLayout = 'monorepo' | 'folder' | 'clone' | 'container' | 'host-tree';

/** The layout of `installDir`; `packageDir` is the code that is running. */
export function installLayout(installDir: string, packageDir: string, inContainer = existsSync('/.dockerenv')): InstallLayout {
  if (detectChannel(packageDir) === 'monorepo') return 'monorepo';
  let deps: Record<string, unknown> = {};
  try {
    deps = (JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf-8')) as { dependencies?: Record<string, unknown> }).dependencies ?? {};
  } catch {
    // No readable manifest: not a folder; the checks below decide.
  }
  if (typeof deps.neuralis === 'string') return 'folder';
  if (inContainer) return 'container';
  return existsSync(join(installDir, '.git')) ? 'clone' : 'host-tree';
}

/** `verb` is the verb and its arguments, e.g. `pkg remove <name>`. */
export function spellOn(layout: InstallLayout, verb: string): string {
  if (layout === 'folder' || layout === 'clone') return `npx neuralis ${verb}`;
  if (layout === 'monorepo') return `pnpm neuralis:${verb}`;
  return `node bin/neuralis.mjs ${verb}`;
}

let processLayout: InstallLayout | null = null;

/** This process's layout: the running code, the install folder above the working directory. Read once. */
function currentLayout(): InstallLayout {
  if (processLayout) return processLayout;
  let installDir = PACKAGE_DIR;
  try {
    installDir = resolveInstallDir(process.cwd());
  } catch {
    // Outside an install folder: the code's own tree decides.
  }
  processLayout = installLayout(installDir, PACKAGE_DIR);
  return processLayout;
}

/**
 * The verb as this install's operator types it. With a context, the context's
 * folders decide (a test hands its own); without one, this process's.
 */
export function spell(verb: string, at?: Pick<CliContext, 'installDir' | 'packageDir'>): string {
  if (!at) return spellOn(currentLayout(), verb);
  let installDir = at.packageDir;
  try {
    installDir = at.installDir;
  } catch {
    // Outside an install folder (the read refuses): the code's own tree decides.
  }
  return spellOn(installLayout(installDir, at.packageDir), verb);
}
