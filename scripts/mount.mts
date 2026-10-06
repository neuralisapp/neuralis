#!/usr/bin/env node
/**
 * neuralis mount — Manage filesystem mounts for Docker deployments.
 *
 * Commands:
 *   add <host-path> [--slug <name>] [--project <id>]    standard data source
 *   add <host-path> --neuralis [--with-docker]          /neuralis overlay
 *   add <host-path> --pkg <package-name>                package folder bound onto node_modules/<name>
 *   list [--project <id>]                               (every project without it)
 *   remove <slug> [--project <id>]                      (checks every project without it)
 *   remove --neuralis                                   remove /neuralis overlay
 *   remove --pkg <package-name>                         remove that package bind
 *
 * INFRASTRUCTURE-ONLY. This script registers the host↔container plumbing for a
 * path; it does NOT create source-config JSON. The user attaches the source
 * afterwards from the Files UI (Sources → Mount & Discover), choosing the scope
 * (project / user / agent). The hostRoot is then derived automatically from the
 * `NEURALIS_MOUNT_*` env pair (see LocalDiskConnector.deriveHostRootFromOsMounts).
 *
 * In Docker mode, this script:
 *   1. Adds/removes volume mounts in the gitignored, script-owned
 *      docker-compose.override.yml (Compose auto-merges it onto the
 *      setup-generated base; the base is mount-immutable — only
 *      `pnpm neuralis:setup` regenerates it). The file is deleted when the
 *      last machine-local mount is removed.
 *   2. Adds/removes NEURALIS_MOUNT_<slug>=/mounts/<slug> +
 *      NEURALIS_MOUNT_HOST_<SLUG>=<host> env vars so discoverRuntimeStack can
 *      list the mount in the agent's `<runtime_stack>` block (as a host-path
 *      label in the mount_table — not a callable URI scope), the Sources panel
 *      discovery can offer it as an attachable suggestion, and the connector
 *      can derive the host-pair root for os_uri translation.
 *
 * In non-Docker mode there is no infra step — the SourcesPanel UI can add a
 * local source directly against the host path.
 */

import { readFile, writeFile, access, readdir, unlink } from 'node:fs/promises';
import {
  insertVolumeLines,
  migrateLegacyPackageLinks,
  packageBindHostPath,
  packageBindLines,
  packageBindTarget,
  removePackageBind,
} from './mount/packageBind.mts';
import { listExistingProjects } from './setup/records.mts';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, resolve, join, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';

// ── ANSI Colors ───────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function resolveHome(): string {
  return process.env.HOME || process.env.USERPROFILE || '/root';
}

function resolveNeuralisHome(): string {
  return process.env.NEURALIS_HOME || join(resolveHome(), '.neuralis');
}

function sourceConfigDir(projectId: string): string {
  return join(resolveNeuralisHome(), 'app', 'config', 'sources', projectId);
}

function dockerComposePath(): string {
  return join(import.meta.dirname, '..', 'docker-compose.yml');
}

// ── docker-compose.override.yml (machine-local, script-owned) ──────
//
// All machine-local compose mutations live in a gitignored + dockerignored
// override file that Docker Compose auto-merges onto the setup-generated base
// (no `-f` flag anywhere in the repo). The base docker-compose.yml is
// mount-immutable (regenerated only by `pnpm neuralis:setup` — opposite
// lifecycle, see docs/architect/setup-and-update.md §2); this file is 100%
// owned by `pnpm neuralis:mount`. The
// marker strings below match the SAME regexes the mutation functions use, and
// the indentation matches the base (volumes/environment at 4 spaces, list
// items at 6) so the existing emit lines drop in unchanged.

function dockerComposeOverridePath(): string {
  return join(import.meta.dirname, '..', 'docker-compose.override.yml');
}

const OVERRIDE_TEMPLATE =
  `# ─────────────────────────────────────────────────────────────────────────\n` +
  `# GENERATED — docker-compose.override.yml — DO NOT HAND-EDIT, DO NOT COMMIT.\n` +
  `#\n` +
  `# Machine-local filesystem mounts written by \`pnpm neuralis:mount\`. This file\n` +
  `# is gitignored AND dockerignored; Docker Compose auto-merges it onto the\n` +
  `# setup-generated docker-compose.yml, which stays mount-immutable and clean.\n` +
  `# Delete this file to remove ALL machine-local mounts at once.\n` +
  `# ─────────────────────────────────────────────────────────────────────────\n` +
  `services:\n` +
  `  neuralis:\n` +
  `    volumes:\n` +
  `      # neuralis-mount-marker: \`pnpm neuralis:mount add\` inserts bind mounts below.\n` +
  `    environment:\n` +
  `      # neuralis-env-mount-marker: \`pnpm neuralis:mount add\` appends NEURALIS_MOUNT_* below.\n`;

/**
 * Read the override if present, otherwise return the empty skeleton template.
 * A pre-bind override (`NEURALIS_PKG_LINKS` + `NODE_PATH`) is migrated to package
 * binds on read and written back at once, so ANY mount command — `list`
 * included — upgrades it, with the change printed.
 */
async function loadOverride(): Promise<string> {
  let content: string;
  try {
    content = await readFile(dockerComposeOverridePath(), 'utf-8');
  } catch {
    return OVERRIDE_TEMPLATE;
  }
  const { content: migrated, migrated: names, dropped } = migrateLegacyPackageLinks(content);
  if (migrated !== content) {
    for (const name of names) {
      const hostPath = packageBindHostPath(migrated, name);
      if (hostPath) ensureMaskMountpoint(hostPath);
    }
    await persistOverride(migrated);
    const hostDeps = await hostDependencyNames();
    for (const name of names) {
      console.log(`${ok} Migrated the --pkg mount of ${name}: bound onto ${packageBindTarget(name)} (its own node_modules masked); NEURALIS_PKG_LINKS + NODE_PATH removed`);
      if (!hostDeps.has(name)) {
        console.log(`  ${c.dim}${name} is not a dependency of the host — the bind is inert until pnpm neuralis:pkg add ${name}${c.reset}`);
      }
    }
    for (const entry of dropped) console.log(`${warn} Dropped NEURALIS_PKG_LINKS entry "${entry}" — no bind supplies its host folder`);
    console.log(`  ${c.dim}Apply with: docker compose up -d neuralis${c.reset}`);
  }
  return migrated;
}

/** The host manifest's dependency names — a package bind only loads a package the host depends on. */
async function hostDependencyNames(): Promise<Set<string>> {
  const manifest = JSON.parse(await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf-8')) as {
    dependencies?: Record<string, string>;
  };
  return new Set(Object.keys(manifest.dependencies ?? {}));
}

/** Count real list entries (volume binds + env vars); comment lines excluded. */
function countOverrideEntries(content: string): number {
  return (content.match(/^\s+- \S/gm) ?? []).length;
}

/**
 * Persist the override. When no machine-local entries remain, DELETE the file
 * instead of leaving a comment-only skeleton — a `volumes:`/`environment:`
 * whose only child is a comment serialises to YAML `null`, which
 * `docker compose config` rejects.
 */
async function persistOverride(content: string): Promise<void> {
  const overridePath = dockerComposeOverridePath();
  if (countOverrideEntries(content) === 0) {
    try {
      await unlink(overridePath);
      console.log(`${ok} Removed docker-compose.override.yml (no machine-local mounts remain)`);
    } catch {
      /* ENOENT — nothing to remove */
    }
    return;
  }
  await writeFile(overridePath, content);
}

function isDockerMode(): boolean {
  return (
    process.env.NEURALIS_DOCKER === 'true' ||
    existsSync('/.dockerenv') ||
    existsSync(dockerComposePath())
  );
}

// ── Source Config (read-only) ─────────────────────────────────────
//
// This script no longer WRITES source-config JSON — sources are attached from
// the Files UI with a chosen scope. We still read existing configs (any scope)
// read-only so `list` can flag attached mounts and `remove` can warn about
// configs left pointing at a removed mount.

interface SourceConfig {
  source: string;
  connection?: {
    kind?: string;
    config?: {
      root?: string;
      hostRoot?: string;
    };
  };
}

/**
 * The projects a `list` / `remove` cross-references: the one `--project` names,
 * else EVERY project on disk — a Docker mount is instance-wide, so a source in
 * any project may point at it. There is no default project id.
 */
async function projectsToCheck(projectId: string | undefined): Promise<string[]> {
  if (projectId) return [projectId];
  return (await listExistingProjects(resolveNeuralisHome())).map((p) => p.id).sort();
}

async function listSourceConfigsIn(projectIds: string[]): Promise<Array<SourceConfig & { projectId: string }>> {
  const out: Array<SourceConfig & { projectId: string }> = [];
  for (const projectId of projectIds) {
    for (const cfg of await listSourceConfigs(projectId)) out.push({ ...cfg, projectId });
  }
  return out;
}

async function listSourceConfigs(projectId: string): Promise<SourceConfig[]> {
  const dir = sourceConfigDir(projectId);
  try {
    await access(dir);
  } catch {
    return [];
  }
  const entries = await readdir(dir);
  const configs: SourceConfig[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(dir, entry), 'utf-8');
      configs.push(JSON.parse(raw));
    } catch {
      // skip malformed
    }
  }
  return configs;
}

// ── Docker Compose Manipulation ───────────────────────────────────

async function addDockerMount(hostPath: string, slug: string): Promise<void> {
  let content = await loadOverride();

  const volumeLine = `      - ${hostPath}:/mounts/${slug}`;
  // NEURALIS_MOUNT_<slug> = container path; NEURALIS_MOUNT_HOST_<SLUG> = host
  // path. Both are read by `discoverRuntimeStack` so the runtime knows how to
  // list the mount in the rendered `<runtime_stack>` block (decoratively as
  // `os://<slug>/`) and so the LocalDiskConnector can translate the container
  // path back to a host path for vector payloads. `os://` is a display
  // convention; the callable source URI is `<slug>://`.
  const slugUpper = slug.toUpperCase().replace(/-/g, '_');
  const envLine =
    `      - NEURALIS_MOUNT_${slug}=/mounts/${slug}\n` +
    `      - NEURALIS_MOUNT_HOST_${slugUpper}=${hostPath}`;

  // Check if already mounted
  if (content.includes(`:/mounts/${slug}`)) {
    console.log(`${warn} Volume mount for "${slug}" already exists in docker-compose.override.yml`);
    return;
  }

  // Add volume mount right after the marker comment in docker-compose.override.yml.
  // The default compose file ships with this marker line so we always have a
  // stable insertion point; existing user-added mounts stack below it.
  const volumesMarker = /^(\s*# neuralis-mount-marker:.*\n(?:\s*#.*\n)*)/m;
  const volumeMatch = content.match(volumesMarker);
  if (volumeMatch) {
    const block = volumeMatch[0];
    // Insert AFTER the marker block (just before the next non-comment line).
    content = content.replace(block, `${block}${volumeLine}\n`);
  } else {
    // Fallback: append to the first matching `/mounts/<x>` volume line.
    const mountLines = content.match(/^      - .+:\/mounts\/.+$/m);
    if (mountLines) {
      content = content.replace(mountLines[0], `${mountLines[0]}\n${volumeLine}`);
    } else {
      console.log(`${fail} Could not find volume mount section in docker-compose.override.yml`);
      console.log(`  Add manually: ${volumeLine}`);
      return;
    }
  }

  // Add env var right after the env-marker comment.
  const envMarker = /^(\s*# neuralis-env-mount-marker:.*\n(?:\s*#.*\n)*)/m;
  const envMatch = content.match(envMarker);
  if (envMatch) {
    content = content.replace(envMatch[0], `${envMatch[0]}${envLine}\n`);
  } else {
    // Fallback: append after the last existing NEURALIS_MOUNT_ env line.
    const lastMountEnv = content.match(/^      - NEURALIS_MOUNT_\w+=/gm);
    if (lastMountEnv) {
      const lastLine = lastMountEnv[lastMountEnv.length - 1];
      const lastLineIdx = content.lastIndexOf(lastLine);
      const lineEnd = content.indexOf('\n', lastLineIdx);
      content = content.slice(0, lineEnd) + '\n' + envLine + content.slice(lineEnd);
    } else {
      console.log(`${warn} Could not find NEURALIS_MOUNT env vars section.`);
      console.log(`  Add manually: ${envLine}`);
    }
  }

  await persistOverride(content);
  console.log(`${ok} Updated docker-compose.override.yml`);
}

async function removeDockerMount(slug: string): Promise<void> {
  let content = await loadOverride();

  // Remove volume line
  const volumePattern = new RegExp(`^\\s*- .+:/mounts/${slug}.*\\n`, 'm');
  content = content.replace(volumePattern, '');

  // Remove container-path env line (raw slug).
  const envPattern = new RegExp(`^\\s*- NEURALIS_MOUNT_${slug}=.*\\n`, 'm');
  content = content.replace(envPattern, '');

  // Remove paired host-path env line (UPPER_SNAKE_CASE). addDockerMount uses
  // `slug.toUpperCase().replace(/-/g, '_')` to derive the host-pair var name.
  const slugUpper = slug.toUpperCase().replace(/-/g, '_');
  const envHostPattern = new RegExp(`^\\s*- NEURALIS_MOUNT_HOST_${slugUpper}=.*\\n`, 'm');
  content = content.replace(envHostPattern, '');

  // Read-only marker, optional.
  const envRoPattern = new RegExp(`^\\s*- NEURALIS_MOUNT_RO_${slugUpper}=.*\\n`, 'm');
  content = content.replace(envRoPattern, '');

  await persistOverride(content);
  console.log(`${ok} Removed mount "${slug}" from docker-compose.override.yml`);
}

// ── /neuralis overlay mount ───────────────────────────────────────
//
// `--neuralis` exposes the host Neuralis tree inside the container so the
// LLM can read & edit live source (fs_read neuralis://src/...) and run host
// scripts (pnpm run build, pnpm neuralis:mount). The runner image bakes
// runtime artefacts into two image-managed directories under the WORKDIR:
//
//   /neuralis/_runtime/       server.js + .next/ + public/
//   /neuralis/node_modules/   @neuralis/* tarball-installed + third-party
//
// A whole-folder overlay binds the host's `Neuralis/neuralis/` directly
// onto `/neuralis/`, exposing every host file (Dockerfile, package.json,
// next.config.ts, tsconfig.json, .env, …). The image-built dirs above
// survive via two anonymous volumes (anon vols only mask directories,
// not files — which is why server.js lives inside `_runtime/` and not
// at the WORKDIR root).
//
// Why node_modules/ stays at /neuralis/node_modules/ (NOT under _runtime/):
// skills, tooling and docs hardcode `node_modules/@neuralis/<slug>/files/skills/...`
// paths — burying it would force a docs/tooling sweep. Path resolution
// still works because Node walks UP from server.js (`_runtime/server.js`):
// `_runtime/node_modules/` (absent) → `/neuralis/node_modules/` ✓.
//
// `--with-docker` flips NEURALIS_DOCKER_OVERLAY=1 so the runtime can flag
// the elevated capability. /var/run/docker.sock is already bind-mounted by
// the default compose file for machine-core; the env line is the
// auditable marker.

const NEURALIS_OVERLAY_MARKER = '# neuralis-overlay-marker:';

async function addNeuralisOverlay(hostPath: string, withDocker: boolean): Promise<void> {
  let content = await loadOverride();

  if (content.includes(NEURALIS_OVERLAY_MARKER)) {
    console.log(`${warn} /neuralis overlay already configured. Remove with:`);
    console.log(`  ${c.bold}pnpm neuralis:mount remove --neuralis${c.reset}`);
    return;
  }

  // Whole-folder overlay + two anonymous volumes:
  //   - host:/neuralis            full host tree exposed
  //   - /neuralis/_runtime        anon vol protects server.js + .next + public
  //   - /neuralis/node_modules    anon vol protects @neuralis/* tarballs
  const overlayVolumes =
    `      ${NEURALIS_OVERLAY_MARKER} live host source overlay (pnpm neuralis:mount add … --neuralis)\n` +
    `      - ${hostPath}:/neuralis\n` +
    `      - /neuralis/_runtime\n` +
    `      - /neuralis/node_modules\n`;
  const volumesMarker = /^(\s*# neuralis-mount-marker:.*\n(?:\s*#.*\n)*)/m;
  const volumeMatch = content.match(volumesMarker);
  if (volumeMatch) {
    content = content.replace(volumeMatch[0], `${volumeMatch[0]}${overlayVolumes}`);
  } else {
    console.log(`${fail} Could not find # neuralis-mount-marker in docker-compose.override.yml`);
    return;
  }

  // Env block — NEURALIS_MOUNT_neuralis exposes the mount in the runtime
  // stack's mount_table (as a host-path label, not a callable URI scope).
  // NEURALIS_MOUNT_HOST_NEURALIS gives the discovery panel the host path
  // so the "Neuralis Tree" suggestion can prefill correctly.
  // NEURALIS_DOCKER_OVERLAY (opt-in) is the audit marker for elevated
  // host-Docker capability.
  let envLines =
    `      ${NEURALIS_OVERLAY_MARKER} runtime-stack mount entry + Sources panel suggestion\n` +
    `      - NEURALIS_MOUNT_neuralis=/neuralis\n` +
    `      - NEURALIS_MOUNT_HOST_NEURALIS=${hostPath}\n`;
  if (withDocker) {
    envLines += `      - NEURALIS_DOCKER_OVERLAY=1\n`;
  }
  const envMarker = /^(\s*# neuralis-env-mount-marker:.*\n(?:\s*#.*\n)*)/m;
  const envMatch = content.match(envMarker);
  if (envMatch) {
    content = content.replace(envMatch[0], `${envMatch[0]}${envLines}`);
  } else {
    console.log(`${warn} Could not find # neuralis-env-mount-marker in docker-compose.override.yml`);
    console.log(`  Add manually:\n${envLines}`);
  }

  await persistOverride(content);
  console.log(`${ok} /neuralis overlay configured`);
  console.log('');
  console.log(`  Host source:  ${c.cyan}${hostPath}${c.reset}`);
  console.log(`  Container at: ${c.cyan}/neuralis${c.reset}`);
  if (withDocker) {
    console.log(`  ${warn} Docker overlay: ${c.bold}NEURALIS_DOCKER_OVERLAY=1${c.reset}`);
    console.log(`  ${c.dim}The LLM shell can drive the host Docker daemon (docker-cli + /var/run/docker.sock).${c.reset}`);
  }
  console.log('');
  console.log(`${c.cyan}Next steps:${c.reset}`);
  console.log(`  1. ${c.bold}docker compose up -d neuralis${c.reset}    restart the container`);
  console.log(`  2. Open the Sources panel → "Neuralis Tree" appears as a discoverable suggestion`);
  console.log(`     (needs drive.mount.privileged; configure permissions there before attaching)`);
}

async function removeNeuralisOverlay(): Promise<void> {
  let content = await loadOverride();

  if (!content.includes(NEURALIS_OVERLAY_MARKER)) {
    console.log(`${warn} No /neuralis overlay configured.`);
    return;
  }

  // Strip every line that touches the overlay: marker comments + whole-folder
  // bind line + the two anonymous-volume lines + env lines + opt-in
  // NEURALIS_DOCKER_OVERLAY.
  const patterns: RegExp[] = [
    new RegExp(`^\\s*${NEURALIS_OVERLAY_MARKER.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}.*\\n`, 'gm'),
    /^\s*- [^\s]+:\/neuralis\s*\n/gm,             // host:/neuralis (whole-folder)
    /^\s*- \/neuralis\/_runtime\s*\n/gm,           // anonymous volume #1
    /^\s*- \/neuralis\/node_modules\s*\n/gm,       // anonymous volume #2
    /^\s*- NEURALIS_MOUNT_neuralis=.*\n/gm,
    /^\s*- NEURALIS_MOUNT_HOST_NEURALIS=.*\n/gm,
    /^\s*- NEURALIS_DOCKER_OVERLAY=.*\n/gm,
  ];
  for (const p of patterns) content = content.replace(p, '');

  await persistOverride(content);
  console.log(`${ok} /neuralis overlay removed from docker-compose.override.yml`);
}

// ── Package folder dev mount ──
//
// `--pkg <name>` binds a host folder onto `/neuralis/node_modules/<name>` — the
// path the image installs that package at — and masks the folder's OWN
// `node_modules/` with an anonymous volume, so the running process finds the
// folder exactly as it found the installed copy: one discovery path, ONE
// kernel and ONE React by the normal parent walk (CJS and ESM alike). The
// mechanism and the migration of the older `NEURALIS_PKG_LINKS` form live in
// `scripts/mount/packageBind.mts`. Discovery still requires the package in the
// host deps: `pnpm neuralis:pkg add` is the separate, explicit trust act.
//
// It ALSO writes a `/mounts/<slug>` bind of the same folder with the
// `NEURALIS_MOUNT_<slug>` / `NEURALIS_MOUNT_HOST_<SLUG>` pair, exactly like a
// data mount: without the pair `LocalDiskConnector.deriveHostRootFromOsMounts`
// cannot translate a source rooted at the folder back to a host path, so anyone
// attaching a source there has to hand-type `hostRoot`, and a wrong one persists
// silently (a `config.hostRoot` wins over every derivation, nothing validates
// it). `--pkg` says "this folder IS that package", the pair says "this container
// path came from that host path", and a dev-mounted package wants both.

async function addUserPackageMount(hostPath: string, packageName: string): Promise<void> {
  let content = await loadOverride();

  const slug = slugify(packageName.replace(/^@/, '').replace(/\//g, '-'));
  if (content.includes(`:/mounts/${slug}`) || packageBindHostPath(content, packageName) !== null) {
    console.log(`${warn} A mount already exists for ${packageName} (/mounts/${slug} or ${packageBindTarget(packageName)}). Remove it first.`);
    return;
  }

  // The mask is an anonymous volume INSIDE the bind: Docker creates a missing
  // mountpoint as root in the operator's own folder, so create it here first.
  ensureMaskMountpoint(hostPath);
  // The data-plane bind first, then the package bind + its node_modules mask.
  const inserted = insertVolumeLines(content, [`      - ${hostPath}:/mounts/${slug}`, ...packageBindLines(hostPath, packageName)]);
  if (inserted === null) {
    console.log(`${fail} Could not find # neuralis-mount-marker in docker-compose.override.yml`);
    return;
  }
  content = inserted;

  // Host pair — same names and same derivation as addDockerMount, so `list`,
  // `remove` and discoverOsMounts all see one consistent mount table.
  const slugUpper = slug.toUpperCase().replace(/-/g, '_');
  if (!new RegExp(`^\\s*- NEURALIS_MOUNT_${slug}=`, 'm').test(content)) {
    const envPairLine =
      `      - NEURALIS_MOUNT_${slug}=/mounts/${slug}\n` +
      `      - NEURALIS_MOUNT_HOST_${slugUpper}=${hostPath}\n`;
    const pairMarker = /^(\s*# neuralis-env-mount-marker:.*\n(?:\s*#.*\n)*)/m;
    const pairMatch = content.match(pairMarker);
    if (pairMatch) {
      content = content.replace(pairMatch[0], `${pairMatch[0]}${envPairLine}`);
    } else {
      console.log(`${warn} Could not find # neuralis-env-mount-marker for the host pair.`);
      console.log(`  Add manually:\n${envPairLine}`);
    }
  }

  await persistOverride(content);
  console.log(`${ok} Package folder mount configured`);
  console.log('');
  console.log(`  Host path:    ${c.cyan}${hostPath}${c.reset}`);
  console.log(`  Package at:   ${c.cyan}${packageBindTarget(packageName)}${c.reset} ${c.dim}(its own node_modules masked — the image's kernel and React serve it)${c.reset}`);
  console.log(`  Source mount: ${c.cyan}/mounts/${slug}${c.reset} ${c.dim}+ NEURALIS_MOUNT_${slug} / NEURALIS_MOUNT_HOST_${slugUpper} — a source rooted here derives its hostRoot${c.reset}`);
  console.log('');
  if ((await hostDependencyNames()).has(packageName)) {
    console.log(`${ok} ${packageName} is a host dependency — the restart loads it from this folder.`);
  } else {
    console.log(`${warn} This is container plumbing only — the package is NOT discovered until it`);
    console.log(`  is registered in the host dependencies (the admin trust act):`);
    console.log(`  ${c.bold}pnpm neuralis:pkg add ${packageName} --path ${hostPath}${c.reset}`);
  }
  console.log('');
  console.log(`${c.cyan}Restart the container to apply:${c.reset}`);
  console.log(`  ${c.bold}docker compose up -d neuralis${c.reset}`);
}

async function removeUserPackageMount(packageName: string): Promise<void> {
  const content = await loadOverride();
  const next = removeUserPackageMountLines(content, packageName);
  if (next === content) {
    console.log(`${warn} No package mount for "${packageName}" in docker-compose.override.yml.`);
    return;
  }
  await persistOverride(next);
  console.log(`${ok} Removed the package mount of "${packageName}" from docker-compose.override.yml`);
  console.log(`  ${c.dim}If the package is registered in dependencies, also run:${c.reset} ${c.bold}pnpm neuralis:pkg remove ${packageName}${c.reset}`);
}

/** The operator-owned `node_modules/` the mask mounts over (never left for Docker to create as root). */
function ensureMaskMountpoint(hostPath: string): void {
  try {
    mkdirSync(join(hostPath, 'node_modules'), { recursive: true });
  } catch {
    console.log(`${warn} Could not create ${join(hostPath, 'node_modules')} — Docker will create it (as root) on the next start.`);
  }
}

/** The override text without `packageName`'s package bind, its `/mounts/<slug>` bind and host pair. */
function removeUserPackageMountLines(content: string, packageName: string): string {
  const slug = slugify(packageName.replace(/^@/, '').replace(/\//g, '-'));
  const slugUpper = slug.toUpperCase().replace(/-/g, '_');
  return removePackageBind(content, packageName)
    .replace(new RegExp(`^\\s*- .+:/mounts/${slug}\\s*\\n`, 'm'), '')
    .replace(new RegExp(`^\\s*- NEURALIS_MOUNT_${slug}=.*\\n`, 'm'), '')
    .replace(new RegExp(`^\\s*- NEURALIS_MOUNT_HOST_${slugUpper}=.*\\n`, 'm'), '');
}

// ── Interactive TUI Directory Browser ─────────────────────────────

type DirEntry = { name: string; hidden: boolean };

/**
 * Listing result. `error` is non-null when the directory could not be read —
 * surfaced to the user so a permission-denied / missing dir no longer looks
 * silently "empty" (which made the picker feel broken).
 */
type DirListing = { dirs: DirEntry[]; error: string | null };

async function listDirs(dirPath: string): Promise<DirListing> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .sort((a, b) => {
        // Non-hidden first, then alphabetical
        const aHidden = a.name.startsWith('.');
        const bHidden = b.name.startsWith('.');
        if (aHidden !== bHidden) return aHidden ? 1 : -1;
        return a.name.localeCompare(b.name);
      })
      .map((e) => ({ name: e.name, hidden: e.name.startsWith('.') }));
    return { dirs, error: null };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    const error =
      code === 'EACCES' || code === 'EPERM' ? 'permission denied'
      : code === 'ENOENT' ? 'directory not found'
      : code === 'ENOTDIR' ? 'not a directory'
      : err instanceof Error ? err.message
      : 'unreadable';
    return { dirs: [], error };
  }
}

/**
 * Interactive TUI directory browser.
 * Returns the selected absolute path, or null if the user cancelled.
 */
async function interactiveBrowse(startPath: string): Promise<string | null> {
  let currentPath = resolve(startPath);
  const initial = await listDirs(currentPath);
  let dirs = initial.dirs;
  let dirError = initial.error;
  let cursor = 0;
  let scrollOffset = 0;
  const maxVisible = 15;
  const hasMntC = existsSync('/mnt/c');

  const write = (s: string) => process.stdout.write(s);
  const clearScreen = () => write('\x1b[2J\x1b[H');
  const hideCursor = () => write('\x1b[?25l');
  const showCursor = () => write('\x1b[?25h');

  function render() {
    clearScreen();
    write(`${c.bold}📁 Select a directory to mount:${c.reset}\n\n`);
    write(`  ${c.cyan}${currentPath}${c.reset}\n`);
    write(`  ${c.dim}${'─'.repeat(Math.min(currentPath.length + 2, 50))}${c.reset}\n`);

    // Parent directory entry
    write(`  ${cursor === -1 ? `${c.cyan}>` : ' '} ${c.dim}↑ ..${c.reset}\n`);

    // Directory entries
    const visibleDirs = dirs.slice(scrollOffset, scrollOffset + maxVisible);
    for (let i = 0; i < visibleDirs.length; i++) {
      const idx = scrollOffset + i;
      const entry = visibleDirs[i];
      const selected = cursor === idx;
      const prefix = selected ? `${c.cyan}>` : ' ';
      const style = entry.hidden ? c.dim : '';
      const name = selected ? `${c.bold}${entry.name}${c.reset}` : `${style}${entry.name}${c.reset}`;
      write(`  ${prefix} 📁 ${name}\n`);
    }

    if (dirError) {
      // Make permission-denied / missing dirs visible instead of looking empty.
      write(`  ${c.yellow}⚠ ${dirError}${c.reset}\n`);
    } else if (dirs.length === 0) {
      write(`  ${c.dim}(empty — no subdirectories)${c.reset}\n`);
    }

    if (dirs.length > maxVisible) {
      write(`\n  ${c.dim}[${scrollOffset + 1}-${Math.min(scrollOffset + maxVisible, dirs.length)} of ${dirs.length}]${c.reset}\n`);
    }

    write(`\n  ${c.dim}[↑↓] Navigate  [Enter] Open  [Space] Select this  [Esc] Cancel${c.reset}\n`);
    // Quick jumps so the whole host is one keypress away from anywhere.
    write(
      `  ${c.dim}[h] Home  [r] Root /${hasMntC ? '  [c] /mnt/c (Windows)' : ''}${c.reset}\n`,
    );
  }

  /** Navigate to a path: reload its listing, reset cursor/scroll, re-render. */
  async function loadDir(path: string): Promise<void> {
    currentPath = resolve(path);
    const listing = await listDirs(currentPath);
    dirs = listing.dirs;
    dirError = listing.error;
    cursor = 0;
    scrollOffset = 0;
    render();
  }

  return new Promise<string | null>((resolvePromise) => {
    if (!process.stdin.isTTY) {
      resolvePromise(null);
      return;
    }

    hideCursor();
    process.stdin.setRawMode(true);
    process.stdin.resume();
    render();

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      showCursor();
      write('\n');
    };

    const onData = async (key: Buffer) => {
      const s = key.toString();
      const totalItems = dirs.length; // -1 index = parent

      if (s === '\x1b' || s === '\x03') {
        // Esc, Ctrl+C → cancel. (`q` is no longer a cancel key — it would
        // collide with typing, and the quick-jump keys below need plain letters.)
        cleanup();
        process.stdin.removeListener('data', onData);
        resolvePromise(null);
        return;
      }

      // Quick jumps — the whole host root is always one keypress away.
      if (s === 'h') { await loadDir(resolveHome()); return; }
      if (s === 'r') { await loadDir('/'); return; }
      if (s === 'c' && hasMntC) { await loadDir('/mnt/c'); return; }

      if (s === '\x1b[A') {
        // Up arrow
        if (cursor === -1) {
          // Already at top
        } else if (cursor === 0) {
          cursor = -1;
        } else {
          cursor--;
          if (cursor < scrollOffset) scrollOffset = cursor;
        }
        render();
        return;
      }

      if (s === '\x1b[B') {
        // Down arrow
        if (cursor < totalItems - 1) {
          cursor++;
          if (cursor >= scrollOffset + maxVisible) scrollOffset = cursor - maxVisible + 1;
        }
        render();
        return;
      }

      if (s === '\r') {
        // Enter → open directory (navigate into) or go to parent
        if (cursor === -1) {
          const parent = dirname(currentPath);
          if (parent !== currentPath) await loadDir(parent);
        } else if (cursor >= 0 && cursor < totalItems) {
          await loadDir(join(currentPath, dirs[cursor].name));
        }
        return;
      }

      if (s === ' ') {
        // Space → select current directory
        cleanup();
        process.stdin.removeListener('data', onData);
        resolvePromise(currentPath);
        return;
      }

      if (s === '\x7f' || s === '\b') {
        // Backspace → go to parent
        const parent = dirname(currentPath);
        if (parent !== currentPath) await loadDir(parent);
        return;
      }
    };

    process.stdin.on('data', onData);
  });
}

/**
 * Prompt for text input (single line).
 */
async function promptInput(prompt: string, defaultValue: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<string>((res) => {
    rl.question(`${prompt} ${c.dim}[${defaultValue}]${c.reset}: `, (answer) => {
      rl.close();
      res(answer.trim() || defaultValue);
    });
  });
}

/** Bare `add` mode picker. Returns the chosen mount kind, or null on cancel. */
async function promptMode(): Promise<'data' | 'neuralis' | 'pkg' | null> {
  console.log(`${c.bold}What do you want to mount?${c.reset}`);
  console.log(`  ${c.cyan}1${c.reset}) Data folder   ${c.dim}— a host directory as a \`<slug>://\` source${c.reset}`);
  console.log(`  ${c.cyan}2${c.reset}) Neuralis tree ${c.dim}— overlay the host neuralis/ onto /neuralis (live source)${c.reset}`);
  console.log(`  ${c.cyan}3${c.reset}) User package  ${c.dim}— a host folder bound onto node_modules/<name>${c.reset}`);
  const choice = await promptInput('Choose 1-3', '1');
  if (choice === '1') return 'data';
  if (choice === '2') return 'neuralis';
  if (choice === '3') return 'pkg';
  console.log(`${warn} Unknown choice "${choice}".`);
  return null;
}

// ── Commands ──────────────────────────────────────────────────────

async function cmdAdd(hostPath: string, slug: string): Promise<void> {
  const absPath = resolve(hostPath);

  // Verify path exists
  try {
    const st = statSync(absPath);
    if (!st.isDirectory()) {
      console.log(`${fail} "${absPath}" is not a directory.`);
      process.exit(1);
    }
  } catch {
    console.log(`${fail} Path "${absPath}" does not exist.`);
    process.exit(1);
  }

  const docker = isDockerMode();

  // INFRA-ONLY. We register the host↔container plumbing; we do NOT write a
  // source-config JSON. The user attaches the source from the Files UI with a
  // chosen scope; the connector derives its hostRoot from the env pair below.
  if (docker) {
    await addDockerMount(absPath, slug);
    console.log('');
    console.log(`  Host path:    ${c.dim}${absPath}${c.reset}`);
    console.log(`  Container at: ${c.cyan}/mounts/${slug}${c.reset}`);
    console.log('');
    console.log(`${c.cyan}Next steps:${c.reset}`);
    console.log(`  1. ${c.bold}docker compose up -d neuralis${c.reset}    restart to apply the mount`);
    console.log(`  2. Files UI → Sources → ${c.bold}Mount & Discover${c.reset} → attach "${slug}" as a`);
    console.log(`     source, choosing the scope (project / user / agent). The host path`);
    console.log(`     resolves automatically — no need to edit any config.`);
  } else {
    console.log('');
    console.log(`${ok} No infra step needed in native (non-Docker) mode.`);
    console.log(`  Add the source directly in the Files UI → Sources → ${c.bold}+ Source${c.reset},`);
    console.log(`  pointing it at ${c.dim}${absPath}${c.reset} with your chosen scope.`);
  }
}

/** Parse machine-local volume binds from the override (`host:/container`). */
function parseOverrideMounts(content: string): Array<{ hostPath: string; containerPath: string }> {
  const out: Array<{ hostPath: string; containerPath: string }> = [];
  const re = /^\s*- (.+):(\/mounts\/\S+|\/neuralis)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push({ hostPath: m[1], containerPath: m[2] });
  }
  return out;
}

async function cmdList(projectId: string | undefined): Promise<void> {
  if (!isDockerMode()) {
    console.log(`${c.dim}Native mode — no compose mounts. Manage sources in the Files UI.${c.reset}`);
    return;
  }

  // Through loadOverride, so `list` also migrates a pre-bind override.
  let overrideContent: string | null = null;
  try {
    await access(dockerComposeOverridePath());
    overrideContent = await loadOverride();
  } catch {
    overrideContent = null;
  }

  const mounts = overrideContent ? parseOverrideMounts(overrideContent) : [];
  if (mounts.length === 0) {
    console.log(`${c.dim}No machine-local mounts in docker-compose.override.yml.${c.reset}`);
    console.log(`${c.dim}Add one with: ${c.reset}${c.bold}pnpm neuralis:mount add <path> --slug <name>${c.reset}`);
    return;
  }

  // Cross-reference persisted source configs (read-only) so the user can see
  // which infra mounts are already attached as a source, and in which project.
  const configs = await listSourceConfigsIn(await projectsToCheck(projectId));
  const attachedIn = new Map<string, Set<string>>();
  for (const cfg of configs) {
    const root = (cfg.connection?.config?.root ?? '').trim();
    if (!root) continue;
    if (!attachedIn.has(root)) attachedIn.set(root, new Set());
    attachedIn.get(root)!.add(cfg.projectId);
  }

  console.log(`${c.bold}Machine-local mounts (docker-compose.override.yml):${c.reset}\n`);
  for (const mount of mounts) {
    const projects = [...(attachedIn.get(mount.containerPath) ?? [])].sort();
    const tag = projects.length > 0
      ? `${c.green}attached${c.reset} ${c.dim}in ${projects.join(', ')}${c.reset}`
      : `${c.dim}not attached — add via Files UI → Mount & Discover${c.reset}`;
    console.log(`  ${c.cyan}${mount.containerPath}${c.reset}  ${c.dim}← ${mount.hostPath}${c.reset}`);
    console.log(`    ${tag}`);
    console.log('');
  }
}

async function cmdRemove(slug: string, projectId: string | undefined): Promise<void> {
  if (!isDockerMode()) {
    console.log(`${c.dim}Native mode — no compose mount to remove. Delete the source in the Files UI.${c.reset}`);
    return;
  }

  // INFRA-ONLY: remove the override bind + env pair. We do NOT delete the
  // source-config JSON — that is the UI Delete dialog's job (it also offers
  // vector purge). A source still pointing at this removed mount becomes a
  // gracefully-errored source row (per-source isolation in list.ts), it does
  // not break the rest of the filesystem.
  const containerPath = `/mounts/${slug}`;
  const referencing = (await listSourceConfigsIn(await projectsToCheck(projectId))).filter((cfg) => {
    const root = (cfg.connection?.config?.root ?? '').trim();
    return root === containerPath || root.startsWith(`${containerPath}/`);
  });

  await removeDockerMount(slug);
  console.log('');
  console.log(`${c.cyan}Restart the container to apply:${c.reset}`);
  console.log(`  ${c.bold}docker compose up -d neuralis${c.reset}`);

  if (referencing.length > 0) {
    console.log('');
    console.log(`${warn} ${referencing.length} source config(s) still point at ${containerPath}:`);
    for (const cfg of referencing) {
      console.log(`    ${c.cyan}${cfg.source}://${c.reset} ${c.dim}(project ${cfg.projectId})${c.reset}`);
    }
    console.log(`  ${c.dim}They will show as errored until you delete them in the Files UI${c.reset}`);
    console.log(`  ${c.dim}Sources panel → Delete dialog (which also purges vector entries).${c.reset}`);
  }
}

// ── CLI Entry ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === '--help' || command === '-h') {
    console.log(`
${c.bold}neuralis mount${c.reset} — Manage filesystem mount infrastructure (Docker)

${c.dim}Infra-only: registers the host↔container plumbing. Attach the source itself
afterwards from the Files UI (Sources → Mount & Discover), choosing its scope.
All mutations go to the gitignored docker-compose.override.yml; the tracked
docker-compose.yml stays clean.${c.reset}

${c.bold}Usage:${c.reset}
  pnpm neuralis:mount add                                  interactive mode picker
  pnpm neuralis:mount add [<host-path>] [--slug <name>]    data folder mount
  pnpm neuralis:mount add <host-path> --neuralis [--with-docker]
  pnpm neuralis:mount add <host-path> --pkg <package-name>
  pnpm neuralis:mount list [--project <id>]
  pnpm neuralis:mount remove <slug> [--project <id>]
  pnpm neuralis:mount remove --neuralis
  pnpm neuralis:mount remove --pkg <package-name>

${c.bold}Options:${c.reset}
  --slug <name>     Mount slug for the standard data-source flow
                    (default: derived from folder name)
  --project <id>    Limit the list/remove source-config cross-reference to one
                    project (default: every project on this install)
  --neuralis        Overlay-mounts the host Neuralis folder onto /neuralis
                    (the flat WORKDIR root). Image-built node_modules/ and
                    .next/ survive via anonymous volumes. Surfaces in the
                    Sources panel as a "Neuralis Tree" suggestion (needs the
                    drive.mount.privileged feature to see and attach).
  --with-docker     (with --neuralis) Flips NEURALIS_DOCKER_OVERLAY=1 so
                    the runtime can flag the elevated capability. The
                    Docker socket is already bind-mounted by default for
                    machine-core.
  --pkg <name>      Bind a host package folder onto /neuralis/node_modules/<name>
                    (its own node_modules masked), so the runtime finds it
                    exactly like the installed copy; also /mounts/<slug> for
                    attaching it as a source.

${c.bold}Examples:${c.reset}
  pnpm neuralis:mount add /home/user/projects/Neuralis/neuralis --neuralis
  pnpm neuralis:mount add /home/user/projects/Neuralis/neuralis --neuralis --with-docker
  pnpm neuralis:mount add /home/user/my-package --pkg @acme/widgets
  pnpm neuralis:mount add /home/user/my-app --slug myapp
  pnpm neuralis:mount add /home/user/docs --slug docs
  pnpm neuralis:mount list
  pnpm neuralis:mount remove myapp
  pnpm neuralis:mount remove --neuralis
  pnpm neuralis:mount remove --pkg @acme/widgets
`);
    return;
  }

  const restArgs = args.slice(1);

  switch (command) {
    case 'add': {
      const { values, positionals } = parseArgs({
        args: restArgs,
        options: {
          slug: { type: 'string', short: 's' },
          project: { type: 'string', short: 'p' },
          neuralis: { type: 'boolean' },
          'with-docker': { type: 'boolean' },
          pkg: { type: 'string' },
        },
        allowPositionals: true,
      });

      if (values.neuralis && (values.pkg || values.slug)) {
        console.log(`${fail} --neuralis cannot be combined with --pkg or --slug.`);
        process.exit(1);
      }

      // Resolve the mount kind. Explicit flags win; a truly bare `add`
      // (no positional, no mode flag) opens the interactive mode picker.
      let mode: 'data' | 'neuralis' | 'pkg';
      if (values.neuralis) mode = 'neuralis';
      else if (values.pkg) mode = 'pkg';
      else if (positionals[0]) mode = 'data';
      else {
        const picked = await promptMode();
        if (!picked) process.exit(0);
        mode = picked;
      }

      if (mode === 'neuralis') {
        let hostPath = positionals[0];
        if (!hostPath) {
          // Default to this script's neuralis/ folder (the overlay target).
          const defaultGuess = resolve(join(import.meta.dirname, '..'));
          hostPath = await promptInput('Neuralis host path', defaultGuess);
        }
        const absPath = resolve(hostPath);
        try {
          if (!statSync(absPath).isDirectory()) {
            console.log(`${fail} "${absPath}" is not a directory.`);
            process.exit(1);
          }
        } catch {
          console.log(`${fail} Path "${absPath}" does not exist.`);
          process.exit(1);
        }
        await addNeuralisOverlay(absPath, !!values['with-docker']);
        break;
      }

      if (mode === 'pkg') {
        const packageName = values.pkg || (await promptInput('Package name (e.g. @acme/widgets)', ''));
        if (!packageName) {
          console.log(`${fail} A package name is required for a user-package mount.`);
          process.exit(1);
        }
        let hostPath = positionals[0];
        if (!hostPath) {
          const selected = await interactiveBrowse('/');
          if (!selected) {
            console.log(`${warn} Cancelled.`);
            process.exit(0);
          }
          hostPath = selected;
          console.log(`${ok} Selected: ${c.cyan}${hostPath}${c.reset}`);
        }
        const absPath = resolve(hostPath);
        try {
          if (!statSync(absPath).isDirectory()) {
            console.log(`${fail} "${absPath}" is not a directory.`);
            process.exit(1);
          }
        } catch {
          console.log(`${fail} Path "${absPath}" does not exist.`);
          process.exit(1);
        }
        await addUserPackageMount(absPath, packageName);
        break;
      }

      // Standard data-source mount.
      let hostPath = positionals[0];
      if (!hostPath) {
        const selected = await interactiveBrowse('/');
        if (!selected) {
          console.log(`${warn} Cancelled.`);
          process.exit(0);
        }
        hostPath = selected;
        console.log(`${ok} Selected: ${c.cyan}${hostPath}${c.reset}`);
      }

      const defaultSlug = slugify(basename(resolve(hostPath)));
      const slug = values.slug || (positionals[0] ? defaultSlug : await promptInput('Source key', defaultSlug));
      await cmdAdd(hostPath, slug);
      break;
    }

    case 'list':
    case 'ls': {
      const { values } = parseArgs({
        args: restArgs,
        options: { project: { type: 'string', short: 'p' } },
        allowPositionals: true,
      });
      await cmdList(values.project || undefined);
      break;
    }

    case 'remove':
    case 'rm': {
      const { values, positionals } = parseArgs({
        args: restArgs,
        options: {
          project: { type: 'string', short: 'p' },
          neuralis: { type: 'boolean' },
          pkg: { type: 'string' },
        },
        allowPositionals: true,
      });

      if (values.neuralis) {
        await removeNeuralisOverlay();
        break;
      }
      if (values.pkg) {
        await removeUserPackageMount(values.pkg);
        break;
      }

      const slug = positionals[0];
      if (!slug) {
        console.log(`${fail} Missing slug. Usage: pnpm neuralis:mount remove <slug>`);
        process.exit(1);
      }
      await cmdRemove(slug, values.project || undefined);
      break;
    }

    default:
      console.log(`${fail} Unknown command: "${command}". Use --help for usage.`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`${fail} ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
