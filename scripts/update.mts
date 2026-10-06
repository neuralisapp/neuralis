#!/usr/bin/env node
/**
 * `pnpm neuralis:update` — move an installation to newer package versions.
 *
 * Commands:
 *   (no args)              show what would change; changes nothing
 *   --apply                actually install
 *   --version <x>          target version for every package (manual override)
 *   --manifest <url|file>  resolve versions from a published release manifest
 *   <package>              limit to one package (short slug or full name)
 *   --json                 machine-readable plan
 *
 * WHY THIS EXISTS: `npm update` cannot do the job. The host pins its
 * `@neuralis/*` dependencies exactly, so `npm update` is a no-op against them;
 * npm has no scope glob to widen it; and `npm install @neuralis/x@latest`
 * rewrites the exact pin into a caret range, quietly turning a tested release
 * line into "whatever resolves today".
 *
 * WHAT IT UPDATES: the `registryOnly` half of the builtin dependency partition
 * — packages installed from a registry, with no source on this machine. The
 * other half (a workspace link or a `file:` dev folder) belongs to
 * `neuralis:sync`; pulling a "new version" of a folder you are editing is not a
 * thing. Both halves come from ONE derivation, so neither can drift.
 *
 * CHANNELS: on the private monorepo the update path is a git pull, and running
 * an installer there would fight the workspace — so this refuses, by name,
 * rather than half-working.
 *
 * THE IMAGE TAG: the container runs the image `.env NEURALIS_IMAGE_TAG` names,
 * not this folder's node_modules. An all-package `--version <x> --apply` moves
 * that tag to `<x>` once npm install succeeded; a single-package or `--manifest`
 * run leaves it and says so — one package's version is not a release.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveNeuralisHome } from '@neuralis/package-system/paths';
import { resolveConfigDir } from './setup/detect.mts';
import { detectChannel, discoverBuiltinDeps, type RegistryOnlyPackage } from './setup/discoverPackages.mts';
import { imageTagAfterUpdate, upsertEnvValue } from './setup/envFile.mts';

const here = dirname(fileURLToPath(import.meta.url));
const neuralisDir = join(here, '..');

const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};
const ok = `${c.green}✓${c.reset}`;
const fail = `${c.red}✗${c.reset}`;
const warn = `${c.yellow}⚠${c.reset}`;
const dot = `${c.dim}·${c.reset}`;

type PlanRow = {
  name: string;
  current: string;
  target: string;
  /** No newer version resolved — nothing to do for this package. */
  unchanged: boolean;
};

function die(message: string, ...detail: string[]): never {
  console.error(`\n  ${fail} ${message}`);
  for (const line of detail) console.error(`    ${c.dim}${line}${c.reset}`);
  console.error('');
  process.exit(1);
}

function installedVersion(name: string): string {
  try {
    const manifest = JSON.parse(
      readFileSync(join(neuralisDir, 'node_modules', name, 'package.json'), 'utf-8'),
    ) as { version?: string };
    return manifest.version ?? '(unknown)';
  } catch {
    return '(not installed)';
  }
}

/**
 * A published release manifest names a TESTED combination of package versions.
 * Until one is published there is nothing to resolve against, and guessing —
 * asking the registry for each package's newest version independently — would
 * assemble a combination nobody has ever run. So this reports honestly instead.
 */
function resolveFromManifest(source: string, packages: RegistryOnlyPackage[]): PlanRow[] {
  let raw: string;
  try {
    raw = source.startsWith('http')
      ? die('remote release manifests are not published yet', `nothing serves ${source}`)
      : readFileSync(source, 'utf-8');
  } catch (err) {
    die(`could not read the release manifest at ${source}`, err instanceof Error ? err.message : String(err));
  }
  let parsed: { packages?: Record<string, string> };
  try {
    parsed = JSON.parse(raw) as { packages?: Record<string, string> };
  } catch (err) {
    die('release manifest is not valid JSON', err instanceof Error ? err.message : String(err));
  }
  const versions = parsed.packages ?? {};
  return packages.map((pkg) => {
    const target = versions[pkg.name];
    const current = installedVersion(pkg.name);
    if (!target) return { name: pkg.name, current, target: current, unchanged: true };
    return { name: pkg.name, current, target, unchanged: target === current };
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const positional = argv.filter((a) => !a.startsWith('--'));
  const value = (flag: string): string | null => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? (argv[idx + 1] ?? null) : null;
  };

  const apply = flags.has('--apply');
  const asJson = flags.has('--json');
  const targetVersion = value('--version');
  const manifestSource = value('--manifest');

  const channel = detectChannel(neuralisDir);
  if (channel === 'monorepo') {
    die(
      'this is the development checkout — there is nothing to update from a registry',
      'The packages here are the source. Update it with `git pull`, then `pnpm install`',
      'and `pnpm neuralis:rebuild`.',
    );
  }

  const { registryOnly, syncable, localSource } = discoverBuiltinDeps(neuralisDir);
  if (localSource.length > 0 && !asJson) {
    // Named, not silently absent: a local package is deliberate operator
    // state, and "why is my package not listed" deserves an answer.
    console.log('');
    for (const pkg of localSource) {
      console.log(`  ${dot} ${c.dim}skipping ${pkg.name} — local package (${pkg.spec}), installed by pnpm neuralis:rebuild${c.reset}`);
    }
  }
  if (registryOnly.length === 0) {
    die(
      'no registry-installed Neuralis packages found',
      syncable.length > 0
        ? `${syncable.length} package(s) resolve to local folders — those belong to \`pnpm neuralis:sync\`.`
        : 'The host declares no builtin-class dependencies.',
    );
  }

  let targets = registryOnly;
  if (positional.length > 0) {
    const wanted = positional[0];
    targets = registryOnly.filter((p) => p.name === wanted || p.name.split('/').pop() === wanted);
    if (targets.length === 0) {
      die(
        `"${wanted}" is not a registry-installed Neuralis package`,
        `Available: ${registryOnly.map((p) => p.name).join(', ')}`,
      );
    }
  }

  let plan: PlanRow[];
  if (manifestSource) {
    plan = resolveFromManifest(manifestSource, targets);
  } else if (targetVersion) {
    plan = targets.map((pkg) => {
      const current = installedVersion(pkg.name);
      return { name: pkg.name, current, target: targetVersion, unchanged: current === targetVersion };
    });
  } else {
    die(
      'no version source given',
      'A release manifest names a TESTED combination of package versions; resolving each',
      'package independently would assemble a combination nobody has run. Until one is',
      'published, name the version explicitly:',
      '',
      '  pnpm neuralis:update --version 0.2.0 --apply',
      '  pnpm neuralis:update --manifest ./release-line.json --apply',
    );
  }

  const changing = plan.filter((row) => !row.unchanged);

  if (asJson) {
    console.log(JSON.stringify({ channel, plan, apply }, null, 2));
    if (!apply) return;
  } else {
    console.log('');
    console.log(`  ${c.cyan}${c.bold}── neuralis:update ${'─'.repeat(35)}${c.reset}`);
    console.log(`  ${dot} channel        : ${c.bold}${channel}${c.reset}`);
    console.log(`  ${dot} packages       : ${c.bold}${plan.length}${c.reset} registry-installed`);
    console.log('');
    for (const row of plan) {
      const line = row.unchanged
        ? `${c.dim}${row.name} ${row.current} (unchanged)${c.reset}`
        : `${c.bold}${row.name}${c.reset} ${row.current} → ${c.bold}${row.target}${c.reset}`;
      console.log(`    ${row.unchanged ? dot : ok} ${line}`);
    }
    console.log('');
  }

  if (changing.length === 0) {
    console.log(`  ${ok} already up to date.\n`);
    return;
  }

  if (!apply) {
    console.log(`  ${warn} dry run — nothing installed. Re-run with ${c.bold}--apply${c.reset}.\n`);
    return;
  }

  // Decided BEFORE the install, so a --version Docker cannot tag fails with nothing installed.
  const tag = imageTagAfterUpdate({ targetVersion, onePackage: positional.length > 0, manifest: manifestSource !== null });

  // ONE install call: user dependencies stay untouched, and --save-exact keeps
  // the pins exact (a caret range here is how a tested release line silently
  // becomes "whatever resolves today").
  const specs = changing.map((row) => `${row.name}@${row.target}`);
  console.log(`  ${dot} installing     : ${c.bold}${specs.join(' ')}${c.reset}`);
  const result = spawnSync('npm', ['install', ...specs, '--save-exact'], {
    cwd: neuralisDir,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    die(`npm install failed (exit ${result.status})`, 'The installation is unchanged.');
  }

  console.log('');
  console.log(`  ${ok} installed.`);
  if (tag.move) {
    const configDir = resolveConfigDir({ isClone: false, projectRoot: neuralisDir, neuralisHome: resolveNeuralisHome().home }, null);
    try {
      const { previous } = await upsertEnvValue(configDir, 'NEURALIS_IMAGE_TAG', tag.tag);
      console.log(`  ${ok} image tag      : ${previous ?? '(none)'} → ${c.bold}${tag.tag}${c.reset} ${c.dim}(${configDir}/.env NEURALIS_IMAGE_TAG)${c.reset}`);
    } catch (err) {
      die(
        `the packages are installed, but the image tag in ${configDir}/.env could not be moved`,
        err instanceof Error ? err.message : String(err),
        `Set NEURALIS_IMAGE_TAG=${tag.tag} there yourself, then`,
        '`pnpm neuralis:setup --compose-only` and `docker compose up -d -V`.',
      );
    }
  } else {
    console.log(`  ${warn} image tag unchanged: ${tag.reason}`);
  }
  console.log(`  ${dot} next: ${c.bold}pnpm neuralis:setup --compose-only${c.reset} ${c.dim}(regenerate compose)${c.reset}`);
  console.log(`  ${dot}       ${c.bold}docker compose up -d -V${c.reset} ${c.dim}(-V is load-bearing: it renews the anonymous`);
  console.log(`  ${c.dim}        volumes that would otherwise mask the new image-built runtime)${c.reset}`);
  console.log('');
}

main().catch((err: unknown) => die('update failed', err instanceof Error ? err.message : String(err)));
