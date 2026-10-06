/**
 * CredentialUsageStore — per-day credential-use counters (credential-use
 * limits v1, periodic-pelican phase 2 Increment D).
 *
 * One JSON file per UTC day under `{appRoot}/credentials/usage/` (the
 * `credentials/` root is never enumerated by `CredentialStore`, which maps
 * only the four scope subtrees — the sibling dir is collision-safe):
 *
 *   { [credentialId]: { total: number, byScope: { [scopeKey]: number } } }
 *
 * The DAY stays the file granularity even though rules carry day|week|month
 * windows — weekly/monthly usage is a read-side sum over the window's dates
 * via the kernel `windowDates` (the same math the USD spend limits use).
 * `scopeKey` (`projects/<id>` | `users/<id>` | `global`) is attribution
 * telemetry only in v1: the rule check sums a credential id across ALL scope
 * keys.
 *
 * Writes serialize through an in-memory per-file lock and persist through the
 * kernel's crash-durable replace (`durableReplaceFile`). Like every
 * counter here this is PER-PROCESS state on a per-day file: a multi-replica
 * deployment needs a shared store — same "later" note as the presence bus /
 * conversation locks.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { durableReplaceFile } from '@neuralis/package-system/data';

type DayCounters = Record<string, { total: number; byScope: Record<string, number> }>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class CredentialUsageStore {
  readonly #usageDir: string;
  /** Per-day-file write serialization (in-process). */
  readonly #fileLocks = new Map<string, Promise<void>>();

  constructor(appRoot: string) {
    this.#usageDir = join(appRoot, 'credentials', 'usage');
  }

  #fileFor(date: string): string {
    if (!DATE_RE.test(date)) throw new Error(`Invalid usage date: ${date}`);
    return join(this.#usageDir, `${date}.json`);
  }

  async #readDay(date: string): Promise<DayCounters> {
    try {
      const raw = await readFile(this.#fileFor(date), 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const out: DayCounters = {};
      for (const [id, row] of Object.entries(parsed as Record<string, unknown>)) {
        if (!row || typeof row !== 'object') continue;
        const total = (row as { total?: unknown }).total;
        const byScope = (row as { byScope?: unknown }).byScope;
        out[id] = {
          total: typeof total === 'number' && Number.isFinite(total) ? total : 0,
          byScope:
            byScope && typeof byScope === 'object' && !Array.isArray(byScope)
              ? Object.fromEntries(
                  Object.entries(byScope as Record<string, unknown>).filter(
                    ([, v]) => typeof v === 'number' && Number.isFinite(v),
                  ) as Array<[string, number]>,
                )
              : {},
        };
      }
      return out;
    } catch {
      // Missing or malformed file reads as zero usage — a counter must never
      // hard-break a resolve.
      return {};
    }
  }

  /** Record `calls` uses of `credentialId` on today's file. */
  async record(
    credentialId: string,
    opts: { scopeKey?: string; calls?: number; date?: string } = {},
  ): Promise<void> {
    const date = opts.date ?? new Date().toISOString().slice(0, 10);
    const calls = Math.max(1, Math.floor(opts.calls ?? 1));
    const scopeKey = opts.scopeKey ?? 'global';
    const file = this.#fileFor(date);

    const prev = this.#fileLocks.get(file) ?? Promise.resolve();
    const next = prev.then(async () => {
      const day = await this.#readDay(date);
      const row = day[credentialId] ?? { total: 0, byScope: {} };
      row.total += calls;
      row.byScope[scopeKey] = (row.byScope[scopeKey] ?? 0) + calls;
      day[credentialId] = row;
      await durableReplaceFile(file, JSON.stringify(day, null, 2));
    });
    // Keep the chain alive on failure so one bad write can't wedge the file.
    this.#fileLocks.set(file, next.catch(() => {}));
    return next;
  }

  /** Sum a credential id's uses across ALL scope keys over the given dates. */
  async getUseTotal(credentialId: string, dates: string[]): Promise<number> {
    let total = 0;
    for (const date of dates) {
      const day = await this.#readDay(date);
      total += day[credentialId]?.total ?? 0;
    }
    return total;
  }

  /** Per-scope attribution over the given dates (telemetry/admin display). */
  async getUseBreakdown(
    credentialId: string,
    dates: string[],
  ): Promise<{ total: number; byScope: Record<string, number> }> {
    const byScope: Record<string, number> = {};
    let total = 0;
    for (const date of dates) {
      const day = await this.#readDay(date);
      const row = day[credentialId];
      if (!row) continue;
      total += row.total;
      for (const [k, v] of Object.entries(row.byScope)) byScope[k] = (byScope[k] ?? 0) + v;
    }
    return { total, byScope };
  }

  /** All ids with any recorded use over the given dates (admin usage list). */
  async listUsedIds(dates: string[]): Promise<Record<string, number>> {
    const totals: Record<string, number> = {};
    for (const date of dates) {
      const day = await this.#readDay(date);
      for (const [id, row] of Object.entries(day)) totals[id] = (totals[id] ?? 0) + row.total;
    }
    return totals;
  }
}
