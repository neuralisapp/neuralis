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
  // A checkout before the container marker: a clone inside a devcontainer, CI
  // job or any image is still a clone; the image's own /neuralis has no `.git`.
  if (existsSync(join(installDir, '.git'))) return 'clone';
  return inContainer ? 'container' : 'host-tree';
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

/** A path as one shell word: single-quoted, an embedded quote closed and escaped. */
function shellWord(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * The documented Docker-only setup: the image writes an install folder the host
 * runs, as the host user, through the bound socket. Every line runs verbatim —
 * the tag is a shell variable on its own first line, so pinning a release is
 * editing that line. `imageSetupCommand('latest')` is the installation guide's
 * first-install block byte for byte (a test holds it against the setup-required
 * page and every documented copy); a refusal prints the image's own version
 * there. The `--compose-only` form is the first command of an image-only
 * folder's update: `folder` is the install folder when the caller knows it.
 */
export function imageSetupCommand(version: string, composeOnly = false, folder: string | null = null): string[] {
  const enter = folder ? `cd ${shellWord(folder)}` : 'cd ~/neuralis   # the folder that holds docker-compose.yml';
  return [
    composeOnly
      ? `NEURALIS_TAG=${version}   # the release in .env NEURALIS_IMAGE_TAG`
      : `NEURALIS_TAG=${version}   # or a release tag: https://hub.docker.com/r/neuralisapp/neuralis/tags`,
    composeOnly ? enter : 'mkdir -p ~/.neuralis ~/neuralis && cd ~/neuralis',
    `docker run ${composeOnly ? '' : '-it '}--rm --user "$(id -u):$(id -g)" \\`,
    '  -v /var/run/docker.sock:/var/run/docker.sock --group-add "$(stat -c %g /var/run/docker.sock)" \\',
    '  -v "$HOME/.neuralis:/.neuralis" -e NEURALIS_HOST_HOME="$HOME/.neuralis" \\',
    '  -v "$PWD:$PWD" \\',
    `  neuralisapp/neuralis:"$NEURALIS_TAG" node bin/neuralis.mjs setup${composeOnly ? ' --compose-only' : ''} --output "$PWD"`,
    ...(composeOnly ? [] : ['docker compose up -d']),
  ];
}
