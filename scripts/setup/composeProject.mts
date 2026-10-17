/**
 * Docker Compose project-name resolution.
 *
 * The generated compose file hardcoded `name: neuralis`, so two installs on
 * one Docker daemon (a WSL production stack and a native test tree, say) merge
 * into the same Compose project — the second `up` adopts and recreates the
 * first one's containers. Grazed live on 2026-08-14; the build failed before
 * the `up`, so nothing was lost.
 *
 * The name is load-bearing beyond that collision: Compose derives the named
 * volumes (`<project>_qdrant-data`), the network and every container name from
 * it. So the rules are:
 *
 * - **Preserve wins, always.** On an existing install the recorded name is
 *   used verbatim. Renaming would orphan `qdrant-data` — every embedding —
 *   and break tooling that addresses containers by their derived names.
 * - **The default stays `neuralis`.** Deriving from the directory basename
 *   would produce `neuralis-neuralis` on a standard checkout, breaking the
 *   container-name default in the sync tooling and falsifying a published docs
 *   page, for no benefit on the overwhelmingly common single-install machine.
 * - **Derive only on a real collision**, detected by asking Docker which
 *   projects exist and whether one already answers to this name from a
 *   different directory.
 *
 * The chosen name is recorded in `.env` as `NEURALIS_COMPOSE_PROJECT`, which is
 * how `--compose-only` reads it back — the same channel `QDRANT_MODE` uses.
 */

import { createHash } from 'node:crypto';
import { basename, dirname } from 'node:path';

export const DEFAULT_COMPOSE_PROJECT = 'neuralis';

/** Compose project names: lowercase alphanumeric, dash and underscore. */
export function sanitizeComposeProject(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || DEFAULT_COMPOSE_PROJECT;
}

export type ComposeProjectRow = { name: string; configFiles: string };

/**
 * Resolve the project name for this install.
 *
 * On a real collision the name comes from the INSTALL folder (the one holding
 * the compose file — never the data home, which every image install shares):
 * its basename, prefixed `neuralis-` unless it already starts so; when another
 * folder's project answers to that too, a 6-hex hash of this folder's absolute
 * path is appended. Deterministic per folder and zero exec: two installs
 * written before either is started still get different names (a counter could
 * only see started stacks). Named residual: on a clean daemon every install is
 * `neuralis`, and two same-named folders both unstarted share `neuralis-<folder>`.
 *
 * @param existingName  what a previous run recorded (preserve wins)
 * @param composeFilePath  the compose file this run will write
 * @param projects  what Docker reports (`docker compose ls -a --format json`),
 *                  or null when the probe could not run
 */
export function resolveComposeProject(params: {
  existingName: string | null;
  composeFilePath: string;
  projects: ComposeProjectRow[] | null;
}): { name: string; reason: 'preserved' | 'default' | 'derived' | 'unprobed' } {
  if (params.existingName) {
    return { name: sanitizeComposeProject(params.existingName), reason: 'preserved' };
  }
  if (params.projects === null) {
    // No probe (no Docker, or it failed): take the default rather than invent
    // a name. A collision here is visible immediately on the next `up`.
    return { name: DEFAULT_COMPOSE_PROJECT, reason: 'unprobed' };
  }

  const elsewhere = (name: string) => params.projects!.some(
    (row) =>
      sanitizeComposeProject(row.name) === name &&
      !row.configFiles.split(',').some((file) => file.trim() === params.composeFilePath),
  );
  if (!elsewhere(DEFAULT_COMPOSE_PROJECT)) return { name: DEFAULT_COMPOSE_PROJECT, reason: 'default' };

  const folder = sanitizeComposeProject(basename(dirname(params.composeFilePath)));
  const base = folder.startsWith(DEFAULT_COMPOSE_PROJECT) ? folder : `${DEFAULT_COMPOSE_PROJECT}-${folder}`;
  if (!elsewhere(base)) return { name: base, reason: 'derived' };
  const folderHash = createHash('sha256').update(dirname(params.composeFilePath)).digest('hex').slice(0, 6);
  return { name: `${base}-${folderHash}`, reason: 'derived' };
}

/** Parse `docker compose ls -a --format json` output; null on anything unexpected. */
export function parseComposeLs(stdout: string): ComposeProjectRow[] | null {
  try {
    const parsed = JSON.parse(stdout) as Array<{ Name?: string; ConfigFiles?: string }>;
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter((row) => typeof row.Name === 'string')
      .map((row) => ({ name: row.Name as string, configFiles: row.ConfigFiles ?? '' }));
  } catch {
    return null;
  }
}
