/**
 * The data home's install record (`<home>/app/config/installs.json`): which
 * folders setup wrote, so a `neuralis` command typed outside the folder finds
 * its install. The shape and the reader are the kernel's
 * (`@neuralis/package-system/paths` `readInstallRecords`, `locateInstall`); this
 * is the one writer. A row is a hint the reader verifies against the folder,
 * never a proof, and the image tag stays out of it (the folder's `.env` is the
 * one source).
 */

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { INSTALL_RECORDS_VERSION, installConfigDir, installKindOf, installRecordsPath, readInstallRecords, type InstallRecord } from '@neuralis/package-system/paths';
import { composeProjectOf } from '../host-broker/helper.mts';

/**
 * Upsert the row for the install in `installDir` (keyed by `dir`; every other
 * row — another install, a kind a newer release wrote — is kept as it is). Null
 * when the folder is no install the kernel recognizes; otherwise whether it
 * changed. A kind whose `.env` lives elsewhere (the desktop bundle's, in the
 * data home) records that folder as `configDir` and no compose project.
 */
export async function recordInstall(neuralisHome: string, installDir: string): Promise<'written' | 'unchanged' | null> {
  const kind = installKindOf(installDir);
  if (!kind) return null;
  const configDir = installConfigDir(kind, installDir, neuralisHome);
  const row: InstallRecord = configDir === installDir
    ? { kind, dir: installDir, composeProject: composeProjectOf(installDir) }
    : { kind, dir: installDir, configDir };
  const rows = readInstallRecords(neuralisHome);
  const at = rows.findIndex((r) => r.dir === installDir);
  if (at >= 0 && JSON.stringify(rows[at]) === JSON.stringify(row)) return 'unchanged';
  const next = at >= 0 ? rows.map((r, i) => (i === at ? row : r)) : [...rows, row];
  const path = installRecordsPath(neuralisHome);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ version: INSTALL_RECORDS_VERSION, installs: next }, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  await rename(tmp, path);
  return 'written';
}
