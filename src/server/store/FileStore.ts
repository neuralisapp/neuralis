// Re-export from canonical location in package-system
import type { FileStore, Logger } from '@neuralis/package-system/data';

export { FileStore } from '@neuralis/package-system/data';
export type { Logger } from '@neuralis/package-system/data';

/**
 * The boot integrity report for ONE host record store: every record `list`
 * would silently skip (torn or unreadable) is named by its path RELATIVE to the
 * data home, then one line states how many and how long the scan took. Operator
 * log only — never a member-facing string. Returns the number of damaged records.
 */
export async function reportStoreIntegrity(
  store: Pick<FileStore<{ id: string }>, 'verify'>,
  relativeDir: string,
  logger: Logger,
): Promise<number> {
  const started = performance.now();
  const issues = await store.verify();
  const ms = Math.round(performance.now() - started);
  for (const issue of issues) logger.error(`${relativeDir}/${issue.id}.json ${issue.kind}`);
  logger.info(`${relativeDir}: ${issues.length} damaged record(s), verified in ${ms} ms`);
  return issues.length;
}
