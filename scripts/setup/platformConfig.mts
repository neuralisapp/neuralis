/**
 * platform.json seeding — MERGE-ONLY.
 *
 * The wizard used to write this file wholesale on every run. On an existing
 * install that silently deleted every key an admin had set through the UI
 * (measured on a real install: 23 keys on disk, 9 in the seed — 14 lost,
 * including the host-execution-plane switch) and downgraded three more to the
 * wizard's literals. A setup re-run is a MAINTENANCE action; an existing value
 * is the operator's decision and is never overwritten here.
 *
 * The seed is also deliberately SMALL. Tunables that packages declare
 * (`maxAgentSteps`, `defaultTemperature`, `maxProjects`) are NOT seeded: the
 * platform-config store already resolves file override → env fallback →
 * declared default, so writing the declared default into the file adds nothing
 * and freezes a value the package owns. Setup writes only what setup itself
 * decides — the embedding pair, the Ollama endpoint, the machine variant and
 * the local LLM list.
 *
 * Consequence worth stating out loud: the old seed pinned `maxAgentSteps: 40`,
 * below the declared default of 100, and that pin acted as a hard ceiling on
 * every agent. New installs now get 100. Existing installs keep whatever is on
 * disk, because merge-only.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type PlatformConfigMerge = {
  merged: Record<string, unknown>;
  /** Keys already on disk, left untouched. */
  kept: string[];
  /** Keys the seed contributed because the file did not have them. */
  added: string[];
};

/** Merge a seed into existing config: existing values win, always. */
export function mergePlatformConfig(
  existing: Record<string, unknown>,
  seed: Record<string, unknown>,
): PlatformConfigMerge {
  const merged: Record<string, unknown> = { ...existing };
  const kept: string[] = [];
  const added: string[] = [];

  for (const [key, value] of Object.entries(seed)) {
    if (Object.prototype.hasOwnProperty.call(existing, key)) {
      kept.push(key);
      continue;
    }
    merged[key] = value;
    added.push(key);
  }

  return { merged, kept: kept.sort(), added: added.sort() };
}

/**
 * Read an existing platform.json.
 *
 * A missing file is a first install. A CORRUPT one is different: proceeding
 * with `{}` means the seed replaces it, so a stray syntax error would cost the
 * operator every setting with nothing to recover from. The bad bytes are kept
 * beside it as `.corrupt.bak` first — the whole point of merge-only is that
 * this file is expensive to lose.
 */
export async function readPlatformConfig(neuralisHome: string): Promise<Record<string, unknown>> {
  const path = platformConfigPath(neuralisHome);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return {}; // first install
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to the backup below
  }
  try {
    await writeFile(`${path}.corrupt.bak`, raw, { encoding: 'utf-8', mode: 0o600 });
    console.warn(`[platform-config] ${path} is unreadable — kept a copy at ${path}.corrupt.bak`);
  } catch {
    console.warn(`[platform-config] ${path} is unreadable and could not be backed up`);
  }
  return {};
}

export function platformConfigPath(neuralisHome: string): string {
  return join(neuralisHome, 'app', 'config', 'platform.json');
}

/**
 * Write the merged config. Returns what was kept and what was added so the
 * wizard can tell the operator exactly what it did to their settings.
 */
export async function writeMergedPlatformConfig(
  neuralisHome: string,
  seed: Record<string, unknown>,
): Promise<PlatformConfigMerge & { filePath: string }> {
  const configDir = join(neuralisHome, 'app', 'config');
  await mkdir(configDir, { recursive: true, mode: 0o700 });

  const existing = await readPlatformConfig(neuralisHome);
  const result = mergePlatformConfig(existing, seed);
  const filePath = platformConfigPath(neuralisHome);
  await writeFile(filePath, JSON.stringify(result.merged, null, 2), { encoding: 'utf-8', mode: 0o600 });
  return { ...result, filePath };
}
