/**
 * Migrate legacy package catalog to project-level _packages/ model.
 *
 * Runs once at bootstrap before the ProjectPackageScanner.
 * Copies packages from .neuralis/app/packages/{installed,authored}/ into
 * the project's _packages/ directory, then renames catalog.json to
 * catalog.json.migrated.
 *
 * Idempotent: skips packages that already exist in _packages/.
 */

import * as fs from 'node:fs/promises';
import { basename, join } from 'node:path';
import { resolveProjectPackagesDir } from '../config/env';
import { hasPackageManifest } from './sourceDiscovery';

type Logger = {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
};

type CatalogEntry = {
  packageId: string;
  installRoot?: string;
  sourceRoot?: string;
};

type Catalog = {
  version: number;
  packages: CatalogEntry[];
};

async function pathExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function isDirectory(p: string): Promise<boolean> {
  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
}

export async function migrateLegacyPackages(
  projectRoot: string,
  appPackagesDir: string,
  logger: Logger,
): Promise<void> {
  const catalogPath = join(appPackagesDir, 'catalog.json');
  const installedDir = join(appPackagesDir, 'installed');
  const authoredDir = join(appPackagesDir, 'authored');

  const [hasCatalog, hasInstalled, hasAuthored] = await Promise.all([
    pathExists(catalogPath),
    pathExists(installedDir),
    pathExists(authoredDir),
  ]);

  if (!hasCatalog && !hasInstalled && !hasAuthored) return;

  const targetDir = resolveProjectPackagesDir(projectRoot);
  await fs.mkdir(targetDir, { recursive: true });

  let migrated = 0;
  const migratedSources = new Set<string>();

  // Migrate installed/ and authored/ in parallel
  const [installedCount, authoredCount] = await Promise.all([
    hasInstalled ? migrateDirectory(installedDir, targetDir, migratedSources, logger) : 0,
    hasAuthored ? migrateDirectory(authoredDir, targetDir, migratedSources, logger) : 0,
  ]);
  migrated += installedCount + authoredCount;

  // Migrate catalog.json entries
  if (hasCatalog) {
    try {
      const raw = await fs.readFile(catalogPath, 'utf-8');
      const catalog = JSON.parse(raw) as Catalog;

      for (const entry of catalog.packages ?? []) {
        const sourceDir = entry.installRoot ?? entry.sourceRoot;
        if (!sourceDir || !(await pathExists(sourceDir))) continue;

        const resolvedSource = join(sourceDir);
        if (migratedSources.has(resolvedSource)) continue;

        const slug = basename(sourceDir);
        const dest = join(targetDir, slug);
        if (await pathExists(dest)) continue;

        try {
          await fs.cp(sourceDir, dest, { recursive: true });
          migrated++;
          migratedSources.add(resolvedSource);
          logger.info('Migrated catalog package to _packages/', {
            packageId: entry.packageId,
            slug,
            from: sourceDir,
            to: dest,
          });
        } catch (err) {
          logger.warn('Failed to migrate catalog package', {
            packageId: entry.packageId,
            error: String(err),
          });
        }
      }

      await fs.rename(catalogPath, catalogPath + '.migrated');
      logger.info('Legacy catalog.json renamed to catalog.json.migrated');
    } catch (err) {
      logger.warn('Failed to read legacy catalog.json', { error: String(err) });
    }
  }

  if (migrated > 0) {
    logger.info('Legacy package migration complete', { migrated, targetDir });
  }
}

async function migrateDirectory(
  sourceDir: string,
  targetDir: string,
  migratedSources: Set<string>,
  logger: Logger,
): Promise<number> {
  let count = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(sourceDir);
  } catch {
    return 0;
  }

  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry);
    if (!(await isDirectory(sourcePath))) continue;
    if (!hasPackageManifest(sourcePath)) continue;

    const dest = join(targetDir, entry);
    if (await pathExists(dest)) continue;

    try {
      await fs.cp(sourcePath, dest, { recursive: true });
      count++;
      migratedSources.add(sourcePath);
      logger.info('Migrated package directory to _packages/', {
        from: sourcePath,
        to: dest,
      });
    } catch (err) {
      logger.warn('Failed to migrate package directory', {
        from: sourcePath,
        error: String(err),
      });
    }
  }

  return count;
}
